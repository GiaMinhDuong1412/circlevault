"""Dịch truyện tranh và chữ trong game (tab "Dịch").

Bộ dịch:
- `google`: Google Dịch bản web miễn phí (không cần khóa, chất lượng vừa phải, dịch từng câu riêng lẻ).
- `claude`: Claude AI (cần API key của người dùng): dịch theo ngữ cảnh cả trang, xưng hô tự nhiên, có thể gửi kèm ảnh trang
  để AI nhìn nhân vật/tình huống và sửa lỗi nhận diện chữ.
Kết quả dịch được nhớ trong bảng `translations` (không dịch lại câu đã dịch, không tốn thêm tiền).

Truyện: DATA/translate/books/<id>/{book.json, pages/0001.jpg…}. Chạy nền từng trang: nhận diện chữ → dịch → lưu.
Xuất: vẽ bản dịch đè lên ảnh (Pillow) → <ổ truyện>/Truyen dich/<tên> [VI].cbz.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import config, db, ocr, storage

def _local_only(request: Request):
    """Cả tab Dịch chỉ dùng trên chính máy này (chế độ mạng LAN không có mật khẩu – không để máy khác dùng API key)."""
    if request.client and request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Tab Dịch chỉ dùng được khi mở app trên chính máy tính.")


router = APIRouter(prefix="/api/translate", dependencies=[Depends(_local_only)])
SETTINGS_PATH = config.DATA / "translate.json"
BOOKS = config.DATA / "translate" / "books"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
MAX_UNZIP = 3 * 1024**3
MODELS = {"claude-opus-5-5": "Claude Opus 5.5 – dịch hay nhất (mặc định)",
          "claude-sonnet-5-5": "Claude Sonnet 5.5 – nhanh, rẻ hơn",
          "claude-haiku-5-5": "Claude Haiku 5.5 – rẻ nhất, hợp dịch game liên tục"}
LANGS = {"en": "tiếng Anh", "ja": "tiếng Nhật", "ko": "tiếng Hàn", "zh-CN": "tiếng Trung", "auto": "tự nhận"}
DEFAULTS = {"engine": "google", "claude_key": "", "claude_model": "claude-opus-5-5", "send_image": True,
            "source": "en", "glossary": "", "style": "", "font": "auto"}
_lock = threading.Lock()


# ------------------------------------------------------------------ cài đặt
def settings() -> dict:
    try:
        s = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    return {**DEFAULTS, **{k: v for k, v in s.items() if k in DEFAULTS}}


def _public(s: dict) -> dict:
    key = s.get("claude_key") or ""
    out = {k: v for k, v in s.items() if k != "claude_key"}
    out.update(has_key=bool(key), key_tail=key[-4:] if len(key) > 8 else "", models=MODELS, langs=LANGS,
               ocr_ready=ocr._engine is not None)
    return out


class SettingsIn(BaseModel):
    engine: str | None = None
    claude_key: str | None = None      # None = giữ nguyên; "" = xóa
    claude_model: str | None = None
    send_image: bool | None = None
    source: str | None = None
    glossary: str | None = None
    style: str | None = None
    font: str | None = None


@router.get("/settings")
def get_settings():
    return _public(settings())


@router.put("/settings")
def put_settings(body: SettingsIn):
    s = settings()
    for k, v in body.model_dump(exclude_none=True).items():
        s[k] = v.strip() if isinstance(v, str) and k in ("claude_key", "claude_model", "engine", "source") else v
    if s["engine"] not in ("google", "claude"):
        raise HTTPException(400, "Bộ dịch không hợp lệ.")
    if s["claude_model"] not in MODELS:
        s["claude_model"] = DEFAULTS["claude_model"]
    if s["source"] not in LANGS:
        s["source"] = "en"
    s["glossary"] = (s.get("glossary") or "")[:20000]
    s["style"] = (s.get("style") or "")[:2000]
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, SETTINGS_PATH)
    return _public(s)


def glossary(s: dict) -> list[tuple[str, str]]:
    out = []
    for line in (s.get("glossary") or "").splitlines():
        if "=" in line:
            a, b = line.split("=", 1)
            if a.strip():
                out.append((a.strip(), b.strip()))
    return out


# ------------------------------------------------------------------ bộ nhớ dịch
def _cache_key(s: dict, text: str) -> str:
    sig = s["engine"] + "|" + (s["claude_model"] if s["engine"] == "claude" else "") + "|" + s["source"] + "|" \
        + s.get("glossary", "") + "|" + (s.get("style", "") if s["engine"] == "claude" else "") \
        + ("|" + s["_sig"] if s.get("_sig") and s["engine"] == "claude" else "")
    return hashlib.sha1((sig + "\0" + text).encode("utf-8")).hexdigest()


def _cache_get(keys: list[str]) -> dict[str, str]:
    if not keys:
        return {}
    marks = ",".join("?" * len(keys))
    return {r["key"]: r["out"] for r in db.query(f"SELECT key, out FROM translations WHERE key IN ({marks})", keys)}


def _cache_put(pairs: dict[str, str]):
    now = time.time()
    for k, v in pairs.items():
        db.execute("INSERT OR REPLACE INTO translations(key, out, at) VALUES (?,?,?)", (k, v, now))


class TranslateError(RuntimeError):
    pass


# ------------------------------------------------------------------ Google (miễn phí)
def _sentence_case(t: str) -> str:
    """Chữ in hoa toàn bộ kiểu truyện tranh → chữ thường đầu câu viết hoa (Google dịch chuẩn hơn)."""
    letters = [c for c in t if c.isalpha()]
    if not letters or sum(c.isupper() for c in letters) / len(letters) < 0.8:
        return t
    t = t.lower()
    t = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), t)
    return re.sub(r"\bi\b", "I", t)


def _google_one(text: str, source: str) -> str:
    q = urllib.parse.urlencode({"client": "gtx", "sl": source, "tl": "vi", "dt": "t", "q": text})
    req = urllib.request.Request("https://translate.googleapis.com/translate_a/single?" + q,
                                 headers={"User-Agent": "Mozilla/5.0"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            return "".join(seg[0] for seg in data[0] or [] if seg and seg[0])
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                time.sleep(2 + attempt * 3)
                continue
            break
        except (OSError, ValueError) as e:
            last = e
            time.sleep(1)
    if isinstance(last, urllib.error.HTTPError) and last.code == 429:
        raise TranslateError("Google Dịch tạm chặn vì dịch quá nhiều. Đợi vài phút hoặc chuyển sang Claude AI.")
    raise TranslateError(f"Không gọi được Google Dịch: {last}")


def _google(texts: list[str], s: dict) -> list[str]:
    """Google Dịch: câu một dòng được gộp nhiều câu vào một lượt gọi (mỗi câu một dòng) để ít bị chặn vì gọi quá nhiều."""
    terms = glossary(s)

    def prep(t: str) -> str:
        src = _sentence_case(t)
        for a, b in terms:                                     # tên riêng: thay trước khi dịch
            src = re.sub(r"\b" + re.escape(a) + r"\b", b, src, flags=re.I)
        return src

    srcs = [prep(t) for t in texts]
    groups, cur, size = [], [], 0
    for i, t in enumerate(srcs):
        n = len(urllib.parse.quote(t)) + 3
        if "\n" in t or "\r" in t or n > 1800:
            groups.append([i])
            continue
        if cur and (size + n > 4500 or len(cur) >= 40):
            groups.append(cur)
            cur, size = [], 0
        cur.append(i)
        size += n
    if cur:
        groups.append(cur)

    def run(g: list[int]) -> dict[int, str]:
        if len(g) == 1:
            return {g[0]: _google_one(srcs[g[0]], s["source"])}
        res = _google_one("\n".join(srcs[i] for i in g), s["source"]).split("\n")
        if len(res) == len(g):
            return dict(zip(g, (r.strip() for r in res)))
        return {i: _google_one(srcs[i], s["source"]) for i in g}      # Google gộp/tách dòng: dịch lại từng câu

    out: dict[int, str] = {}
    with ThreadPoolExecutor(3) as ex:
        for r in ex.map(run, groups):
            out.update(r)
    return [out.get(i, "") for i in range(len(texts))]


# ------------------------------------------------------------------ Claude
SYSTEM = """Bạn là dịch giả truyện tranh và game chuyên nghiệp, dịch từ {src} sang tiếng Việt cho người đọc Việt Nam.

Quy tắc:
- Dịch tự nhiên như bản dịch truyện/game tiếng Việt tốt, không dịch word-by-word. Câu ngắn gọn để vừa khung thoại.
- Chọn xưng hô (tôi/tớ/cậu, anh/em, mày/tao, ta/ngươi, con/bố mẹ…) theo quan hệ và tính cách nhân vật, giữ nhất quán trong cùng trang.
- Giữ nguyên tên người, tên địa danh, chiêu thức trừ khi có trong bảng thuật ngữ.
- Từ tượng thanh (SFX) dịch ngắn gọn (ví dụ "BOOM" → "BÙM") hoặc giữ nguyên nếu là ký hiệu.
- Chữ được nhận diện tự động nên có thể sai chính tả, thiếu chữ hay dính chữ: tự sửa theo ngữ cảnh{img_rule}.
- Mục nào là ký tự rác không có nghĩa, chữ ký nhóm dịch hoặc watermark thì trả về chuỗi rỗng.
- Mã dạng ⟦số⟧ là mã của game (màu chữ, tên biến, biểu tượng): giữ đủ và đúng từng mã, đặt vào vị trí hợp lý trong câu dịch, không dịch, không thêm mã mới.
- Giữ số lần xuống dòng tương tự bản gốc nếu bản gốc có xuống dòng.
- Trả về đúng mọi id được gửi, mỗi id một bản dịch, không thêm chú thích.{terms}{style}"""

SYSTEM_GAME = """Bạn là dịch giả game chuyên nghiệp, Việt hóa game từ {src} sang tiếng Việt cho người chơi Việt Nam.

Quy tắc:
- Các câu được gửi theo đúng thứ tự trong file game. Đọc cả lô để hiểu tình huống, ai đang nói với ai, rồi mới dịch.
- Dịch đúng ngữ cảnh game: thể loại, bối cảnh, giọng nhân vật, cách xưng hô trong "Bối cảnh game" (nếu có) và giữ nhất quán.
- "who" là nhân vật đang nói; "ctx" là tên khóa / bảng / file chứa câu (gợi ý chữ đó là nút menu, tên vật phẩm, mô tả kỹ năng, thoại…).
- Chữ giao diện (nút, menu, cài đặt) dịch ngắn gọn như game Việt: "Start" → "Bắt đầu", "Options" → "Tùy chọn", "Load" → "Tải game".
- Tên riêng nhân vật, địa danh, chiêu thức: giữ nguyên trừ khi bảng thuật ngữ có cách dịch hoặc tên có nghĩa nên Việt hóa.
- Mã dạng ⟦số⟧ là mã của game (biến, màu chữ, thẻ, xuống dòng): giữ đủ và đúng từng mã, đặt vào vị trí hợp lý, không dịch, không thêm.
- Giữ số dòng tương tự bản gốc nếu có xuống dòng. Không thêm chú thích, không bỏ câu.
- Câu là ký hiệu, mã, tên file hoặc không cần dịch thì trả lại nguyên văn.
- Trả về đúng mọi id được gửi, mỗi id một bản dịch.{terms}{style}"""

SYSTEM_NOVEL = """Bạn là dịch giả văn học chuyên nghiệp, dịch truyện chữ (tiểu thuyết, light novel, web novel) từ {src} sang tiếng Việt.

Quy tắc:
- Các đoạn được gửi liên tiếp trong cùng một chương: đọc hết để hiểu mạch truyện rồi dịch, giữ văn phong truyện tiếng Việt tự nhiên, trôi chảy.
- Chọn xưng hô theo thể loại và quan hệ nhân vật (tiên hiệp/kiếm hiệp: ta – ngươi, huynh – đệ…; hiện đại: tôi – cậu, anh – em…) và giữ nhất quán.
- Giữ nguyên tên riêng trừ khi bảng thuật ngữ có cách dịch; tên Hán Việt (truyện Trung) thì phiên âm Hán Việt.
- Không tóm tắt, không bỏ ý, không thêm chú thích của người dịch. Mỗi đoạn dịch thành một đoạn.
- Mã dạng ⟦số⟧ giữ nguyên.
- Trả về đúng mọi id được gửi, mỗi id một bản dịch.{terms}{style}"""

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["items"],
          "properties": {"items": {"type": "array", "items": {
              "type": "object", "additionalProperties": False, "required": ["id", "vi"],
              "properties": {"id": {"type": "integer"}, "vi": {"type": "string"}}}}}}


def _claude(texts: list[str], s: dict, image: bytes | None, kind: str, context: str,
            who: list[str] | None = None, notes: list[str] | None = None) -> list[str]:
    terms = glossary(s)
    system = {"gamefile": SYSTEM_GAME, "novel": SYSTEM_NOVEL}.get(kind, SYSTEM).format(
        src=LANGS.get(s["source"], "tiếng nước ngoài") if s["source"] != "auto" else "ngôn ngữ gốc",
        img_rule=" và theo ảnh được gửi kèm (nhìn nhân vật đang nói để chọn xưng hô)" if image else "",
        terms=("\n\nBảng thuật ngữ (bắt buộc dùng):\n" + "\n".join(f"- {a} → {b}" for a, b in terms)) if terms else "",
        style=("\n\nYêu cầu thêm của người đọc: " + s["style"].strip()) if s.get("style", "").strip() else "")
    items = [{"id": i, "text": t, **({"who": who[i]} if who and who[i] else {}), **({"ctx": notes[i]} if notes and notes[i] else {})}
             for i, t in enumerate(texts)]
    content: list[dict] = []
    if image:
        import base64
        content.append({"type": "image", "source": {"type": "base64", "media_type": _mime(image),
                                                     "data": base64.standard_b64encode(image).decode("ascii")}})
    where = {"comic": "các khung thoại trên một trang truyện tranh, theo thứ tự đọc",
             "gamefile": "câu thoại và chữ giao diện lấy từ file game, theo thứ tự trong kịch bản",
             "novel": "các đoạn văn tiếp theo của chương truyện"
             }.get(kind, "chữ trên màn hình game")
    content.append({"type": "text", "text": (f"{context}\n" if context else "") + f"Dịch {where}:\n"
                    + json.dumps(items, ensure_ascii=False)})
    data = claude_json(s, system, content, SCHEMA, "low" if kind == "game" else "medium")
    try:
        got = {int(it["id"]): it["vi"] for it in data["items"]}
    except (ValueError, KeyError, TypeError):
        raise TranslateError("Claude trả kết quả không đúng định dạng. Thử dịch lại.")
    return [got.get(i, "") for i in range(len(texts))]


def claude_json(s: dict, system: str, content: list[dict], schema: dict, effort: str = "medium",
                max_tokens: int = 16000) -> dict:
    """Gọi Claude với structured output (JSON theo schema), đổi lỗi API thành TranslateError dễ hiểu."""
    try:
        import anthropic
    except ImportError as e:
        raise TranslateError("Thiếu thư viện anthropic. Chạy: pip install -r requirements.txt") from e
    key = s.get("claude_key") or None
    if not key and not os.environ.get("ANTHROPIC_API_KEY"):
        raise TranslateError("Chưa nhập API key của Claude. Vào phần Cài đặt bộ dịch để nhập, hoặc chuyển sang Google Dịch.")
    client = anthropic.Anthropic(api_key=key, max_retries=3, timeout=300)
    try:
        resp = client.beta.messages.create(
            model=s["claude_model"], max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": content}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    except anthropic.AuthenticationError:
        raise TranslateError("API key của Claude không đúng hoặc đã bị thu hồi.")
    except anthropic.PermissionDeniedError:
        raise TranslateError("API key không có quyền dùng mô hình này.")
    except anthropic.RateLimitError:
        raise TranslateError("Claude đang giới hạn số lượt (hết hạn mức hoặc gọi quá nhanh). Thử lại sau ít phút.")
    except anthropic.BadRequestError as e:
        msg = str(getattr(e, "message", e))
        if "credit" in msg.lower() or "billing" in msg.lower():
            raise TranslateError("Tài khoản Claude API hết tiền. Nạp thêm ở console.anthropic.com → Billing.")
        raise TranslateError(f"Claude từ chối yêu cầu: {msg[:300]}")
    except anthropic.APIStatusError as e:
        raise TranslateError(f"Lỗi máy chủ Claude ({e.status_code}). Thử lại sau.")
    except anthropic.APIConnectionError:
        raise TranslateError("Không kết nối được tới Claude. Kiểm tra mạng.")
    if resp.stop_reason == "refusal":
        raise TranslateError("Claude không dịch phần này (nội dung bị chặn). Thử Google Dịch cho phần này.")
    if resp.stop_reason == "max_tokens":
        raise TranslateError("Quá nhiều chữ trong một lần, bản dịch bị cắt. Thử dịch lại.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError:
        raise TranslateError("Claude trả kết quả không đúng định dạng. Thử dịch lại.")

def _mime(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"GIF":
        return "image/gif"
    return "image/jpeg"


def _small_jpeg(im) -> bytes:
    """Ảnh gửi cho AI: cạnh dài ≤ 1568 px (đủ nhìn, tiết kiệm token); ảnh webtoon dài thì giữ chiều rộng ≤ 800."""
    im = im.copy()
    w, h = im.size
    scale = min(1.0, 1568 / max(w, h)) if h < 3 * w else min(1.0, 800 / w, 7900 / h)
    if scale < 1:
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return buf.getvalue()


def translate_texts(texts: list[str], s: dict | None = None, image: bytes | None = None,
                    kind: str = "comic", context: str = "", who: list[str] | None = None,
                    notes: list[str] | None = None) -> list[str]:
    s = s or settings()
    keys = [_cache_key(s, t) for t in texts]
    have = _cache_get(list(set(keys)))
    todo = list(dict.fromkeys(t for t, k in zip(texts, keys) if k not in have and t.strip()))
    if todo:
        if s["engine"] == "claude":
            speaker = {t: w for t, w in zip(texts, who or []) if w}
            note = {t: n for t, n in zip(texts, notes or []) if n}
            res = []
            for i in range(0, len(todo), 80):
                part = todo[i:i + 80]
                res += _claude(part, s, image if s.get("send_image") else None, kind, context,
                               [speaker.get(t, "") for t in part] if who else None,
                               [note.get(t, "") for t in part] if notes else None)
        else:
            res = _google(todo, s)
        new = {_cache_key(s, t): v.strip() for t, v in zip(todo, res)}
        _cache_put(new)
        have.update(new)
    return [have.get(k, "") if t.strip() else "" for t, k in zip(texts, keys)]


# ------------------------------------------------------------------ API: dịch nhanh / dịch ảnh
class TextIn(BaseModel):
    text: str


@router.post("/text")
def api_text(body: TextIn):
    paras = [p for p in re.split(r"\n\s*\n", body.text.strip()[:20000]) if p.strip()]
    if not paras:
        raise HTTPException(400, "Chưa có chữ để dịch.")
    try:
        out = translate_texts([re.sub(r"\s*\n\s*", " ", p) for p in paras], kind="game")
    except TranslateError as e:
        raise HTTPException(502, str(e))
    return {"text": "\n\n".join(out)}


@router.post("/image")
async def api_image(request: Request, mode: str = "game", translate: bool = True):
    """Ảnh (PNG/JPEG trong body) → chữ nhận diện được + bản dịch. App desktop dùng cho khung dịch màn hình game."""
    data = await request.body()
    if not data or len(data) > 40 * 1024**2:
        raise HTTPException(400, "Ảnh rỗng hoặc quá lớn.")
    import asyncio
    try:
        res = await asyncio.to_thread(_image_job, data, mode, translate)
    except ocr.OcrMissing as e:
        raise HTTPException(500, str(e))
    except TranslateError as e:
        raise HTTPException(502, str(e))
    except Exception as e:  # ảnh hỏng
        raise HTTPException(400, f"Không đọc được ảnh: {e}")
    return res


def _image_job(data: bytes, mode: str, do_translate: bool) -> dict:
    res = ocr.analyze(data, mode)
    texts = [b["text"] for b in res["blocks"]]
    res["text"] = "\n".join(texts)
    if do_translate and texts:
        s = settings()
        img = _small_jpeg(ocr.open_image(data)) if s["engine"] == "claude" and s.get("send_image") else None
        vi = translate_texts(texts, s, img, kind=mode)
        for b, v in zip(res["blocks"], vi):
            b["vi"] = v
        res["vi"] = "\n".join(v for v in vi if v)
    return res


# ------------------------------------------------------------------ truyện
def _natural(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def _book_dir(bid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", bid or ""):
        raise HTTPException(404, "Không có bộ truyện này.")
    d = BOOKS / bid
    if not (d / "book.json").exists():
        raise HTTPException(404, "Không có bộ truyện này.")
    return d


def _load(bid: str) -> dict:
    return json.loads((_book_dir(bid) / "book.json").read_text(encoding="utf-8"))


def _save(book: dict):
    d = BOOKS / book["id"]
    tmp = d / "book.tmp"
    tmp.write_text(json.dumps(book, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, d / "book.json")


def _summary(b: dict) -> dict:
    pages = b["pages"]
    return {"id": b["id"], "name": b["name"], "created": b["created"], "pages": len(pages),
            "done": sum(p["status"] == "done" for p in pages), "errors": sum(p["status"] == "error" for p in pages),
            "status": b.get("status", "idle"), "error": b.get("error"), "export": b.get("export"),
            "running": WORKER.current == b["id"]}


def _new_book(name: str, files: list[tuple[str, bytes]]) -> dict:
    files = sorted(((n, d) for n, d in files if Path(n).suffix.lower() in IMG_EXT), key=lambda x: _natural(x[0]))
    if not files:
        raise HTTPException(400, "Không tìm thấy ảnh nào (hỗ trợ CBZ/ZIP hoặc ảnh JPG, PNG, WEBP).")
    bid = uuid.uuid4().hex[:12]
    d = BOOKS / bid / "pages"
    d.mkdir(parents=True, exist_ok=True)
    pages = []
    for i, (n, data) in enumerate(files, 1):
        fn = f"{i:04d}{Path(n).suffix.lower().replace('.jpeg', '.jpg')}"
        (d / fn).write_bytes(data)
        pages.append({"file": fn, "src": Path(n).name, "status": "pending", "blocks": []})
    book = {"id": bid, "name": (name or "Truyện mới").strip()[:120], "created": time.time(), "pages": pages, "status": "idle"}
    _save(book)
    return book


def _read_archive(blob: bytes | Path) -> list[tuple[str, bytes]]:
    try:
        z = zipfile.ZipFile(io.BytesIO(blob) if isinstance(blob, bytes) else blob)
    except zipfile.BadZipFile:
        raise HTTPException(400, "File CBZ/ZIP bị hỏng hoặc không phải file nén ZIP (CBR/RAR chưa hỗ trợ).")
    total, out = 0, []
    for info in z.infolist():
        if info.is_dir() or Path(info.filename).suffix.lower() not in IMG_EXT or "__MACOSX" in info.filename:
            continue
        total += info.file_size
        if total > MAX_UNZIP:
            raise HTTPException(400, "File nén quá lớn (trên 3 GB ảnh).")
        out.append((info.filename, z.read(info)))
    return out


@router.get("/books")
def list_books():
    out = []
    if BOOKS.exists():
        for d in BOOKS.iterdir():
            try:
                out.append(_summary(json.loads((d / "book.json").read_text(encoding="utf-8"))))
            except (OSError, ValueError):
                continue
    out.sort(key=lambda b: -b["created"])
    return {"books": out, "queue": list(WORKER.queue), "current": WORKER.current}


@router.post("/books")
async def upload_book(request: Request, name: str = "", filename: str = ""):
    """Body = file CBZ/ZIP hoặc một ảnh. Tải thêm ảnh vào bộ có sẵn: /books/<id>/pages?filename=…"""
    data = await request.body()
    if not data:
        raise HTTPException(400, "File rỗng.")
    ext = Path(filename).suffix.lower()
    files = _read_archive(data) if ext in (".cbz", ".zip") or data[:2] == b"PK" else [(filename or "1.jpg", data)]
    with _lock:
        book = _new_book(name or Path(filename).stem, files)
    return _summary(book)


@router.post("/books/{bid}/pages")
async def add_page(bid: str, request: Request, filename: str = ""):
    data = await request.body()
    if Path(filename).suffix.lower() not in IMG_EXT or not data:
        raise HTTPException(400, "Chỉ nhận ảnh JPG, PNG, WEBP.")
    with _lock:
        book = _load(bid)
        fn = f"{len(book['pages']) + 1:04d}{Path(filename).suffix.lower().replace('.jpeg', '.jpg')}"
        (BOOKS / bid / "pages" / fn).write_bytes(data)
        book["pages"].append({"file": fn, "src": Path(filename).name, "status": "pending", "blocks": []})
        _save(book)
    return _summary(book)


class PathIn(BaseModel):
    path: str
    name: str = ""


@router.post("/books/from-path")
def book_from_path(body: PathIn):
    """Dịch truyện đã có trên ổ: thư mục ảnh hoặc file .cbz/.zip."""
    p = Path(body.path.strip().strip('"'))
    if p.is_dir():
        files = [(f.name, f.read_bytes()) for f in p.iterdir() if f.is_file() and f.suffix.lower() in IMG_EXT]
    elif p.is_file() and p.suffix.lower() in (".cbz", ".zip"):
        files = _read_archive(p)
    else:
        raise HTTPException(400, "Không thấy thư mục ảnh hoặc file .cbz/.zip ở đường dẫn này.")
    with _lock:
        book = _new_book(body.name or p.stem, files)
    return _summary(book)


@router.get("/books/{bid}")
def get_book(bid: str):
    b = _load(bid)
    return {**_summary(b), "pages_data": b["pages"]}


@router.get("/books/{bid}/pages/{n}/img")
def page_img(bid: str, n: int):
    b = _load(bid)
    if not 0 <= n < len(b["pages"]):
        raise HTTPException(404, "Không có trang này.")
    return FileResponse(BOOKS / bid / "pages" / b["pages"][n]["file"], headers={"Cache-Control": "max-age=86400"})


class BlocksIn(BaseModel):
    blocks: list[dict]


@router.put("/books/{bid}/pages/{n}")
def save_page(bid: str, n: int, body: BlocksIn):
    """Lưu bản dịch sửa tay (chỉ đổi chữ dịch / ẩn khung, không đổi vị trí do máy nhận diện)."""
    with _lock:
        b = _load(bid)
        if not 0 <= n < len(b["pages"]):
            raise HTTPException(404, "Không có trang này.")
        old = b["pages"][n]["blocks"]
        for i, nb in enumerate(body.blocks[:len(old)]):
            if isinstance(nb.get("vi"), str):
                old[i]["vi"] = nb["vi"][:2000]
                old[i]["edited"] = True
            if "hide" in nb:
                old[i]["hide"] = bool(nb["hide"])
            if isinstance(nb.get("scale"), (int, float)):
                old[i]["scale"] = max(0.5, min(2.0, float(nb["scale"])))
        _save(b)
    return {"ok": True}


class RunIn(BaseModel):
    pages: list[int] | None = None    # None = các trang chưa dịch; danh sách = dịch lại các trang này
    redo: bool = False


@router.post("/books/{bid}/run")
def run_book(bid: str, body: RunIn):
    with _lock:
        b = _load(bid)
        targets = body.pages if body.pages is not None else range(len(b["pages"]))
        for i in targets:
            if 0 <= i < len(b["pages"]):
                p = b["pages"][i]
                if body.redo or body.pages is not None or p["status"] != "done":
                    p["status"] = "pending"
                    p.pop("error", None)
                    if body.redo or body.pages is not None:
                        p["redo"] = True
        b["status"] = "queued"
        b.pop("error", None)
        _save(b)
    WORKER.add(bid)
    return _summary(b)


@router.post("/books/{bid}/stop")
def stop_book(bid: str):
    WORKER.stop(bid)
    with _lock:
        b = _load(bid)
        b["status"] = "idle"
        _save(b)
    return _summary(b)


class RenameIn(BaseModel):
    name: str


@router.patch("/books/{bid}")
def rename_book(bid: str, body: RenameIn):
    with _lock:
        b = _load(bid)
        b["name"] = body.name.strip()[:120] or b["name"]
        _save(b)
    return _summary(b)


@router.delete("/books/{bid}")
def delete_book(bid: str):
    d = _book_dir(bid)
    WORKER.stop(bid)
    shutil.rmtree(d, ignore_errors=True)   # chỉ xóa bản làm việc trong dữ liệu app; file .cbz đã xuất vẫn giữ
    return {"ok": True}


# ------------------------------------------------------------------ chạy nền
class Worker:
    def __init__(self):
        self.queue: list[str] = []
        self.current: str | None = None
        self._stop: set[str] = set()
        self._cv = threading.Condition()
        self._thread: threading.Thread | None = None

    def add(self, bid: str):
        with self._cv:
            self._stop.discard(bid)
            if bid not in self.queue and bid != self.current:
                self.queue.append(bid)
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True, name="translate")
                self._thread.start()
            self._cv.notify()

    def stop(self, bid: str):
        with self._cv:
            self._stop.add(bid)
            if bid in self.queue:
                self.queue.remove(bid)

    def _run(self):
        while True:
            with self._cv:
                if not self.queue:
                    self.current = None
                    return
                bid = self.queue.pop(0)
                self.current = bid
            try:
                self._book(bid)
            except Exception as e:          # bộ đã bị xóa…
                _set_status(bid, "error", str(e))
            finally:
                self.current = None

    def _book(self, bid: str):
        _set_status(bid, "running")
        s = settings()
        n = len(_load(bid)["pages"])
        for i in range(n):
            if bid in self._stop:
                return
            b = _load(bid)
            if i >= len(b["pages"]) or b["pages"][i]["status"] != "pending":
                continue
            page = b["pages"][i]
            try:
                blocks = translate_page(bid, page, s, f"Truyện: {b['name']}, trang {i + 1}/{len(b['pages'])}.")
                err = None
            except TranslateError as e:
                blocks, err = None, str(e)
            except ocr.OcrMissing as e:
                _set_status(bid, "error", str(e))
                return
            except Exception as e:
                blocks, err = None, f"Lỗi trang: {e}"
            with _lock:
                b = _load(bid)
                p = b["pages"][i]
                if blocks is not None:
                    p.update(status="done", blocks=blocks, w=page.get("w"), h=page.get("h"))
                    p.pop("error", None)
                else:
                    p.update(status="error", error=err)
                p.pop("redo", None)
                _save(b)
            if err and ("API key" in err or "hết tiền" in err or "tạm chặn" in err):
                _set_status(bid, "error", err)       # lỗi chung: dừng cả bộ, không thử từng trang
                return
        _set_status(bid, "idle")


def _set_status(bid: str, status: str, error: str | None = None):
    with _lock:
        try:
            b = _load(bid)
        except HTTPException:
            return
        b["status"] = status
        if error:
            b["error"] = error
        else:
            b.pop("error", None)
        _save(b)


def translate_page(bid: str, page: dict, s: dict, context: str) -> list[dict]:
    data = (BOOKS / bid / "pages" / page["file"]).read_bytes()
    res = ocr.analyze(data, "comic")
    blocks = res["blocks"]
    page["w"], page["h"] = res["w"], res["h"]
    if blocks:
        img = _small_jpeg(ocr.open_image(data)) if s["engine"] == "claude" and s.get("send_image") else None
        vi = translate_texts([b["text"] for b in blocks], s, img, "comic", context)
        old = {b["text"]: b for b in page.get("blocks") or [] if b.get("edited")}
        for b, v in zip(blocks, vi):
            keep = old.get(b["text"])
            b["vi"] = keep["vi"] if keep and not page.get("redo") else v
            if keep and not page.get("redo"):
                b["edited"] = True
    return blocks


WORKER = Worker()


# ------------------------------------------------------------------ xuất CBZ tiếng Việt
FONTS = {
    "auto": ["comicbd.ttf", "arialbd.ttf", "segoeuib.ttf", "tahomabd.ttf", "DejaVuSans-Bold.ttf"],
    "comic": ["comicbd.ttf", "comic.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"],
    "arial": ["arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"],
    "tahoma": ["tahomabd.ttf", "tahoma.ttf", "DejaVuSans-Bold.ttf"],
}
FONT_DIRS = [Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts", Path("/usr/share/fonts/truetype/dejavu"),
             Path("/usr/share/fonts/TTF"), Path("/Library/Fonts"), Path("/System/Library/Fonts/Supplemental")]


def _font_path(name: str) -> str | None:
    for f in FONTS.get(name, FONTS["auto"]):
        for d in FONT_DIRS:
            if (d / f).exists():
                return str(d / f)
    return None


def _wrap(draw, text: str, font, width: float) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        t = (cur + " " + word).strip()
        if draw.textlength(t, font=font) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def render_page(img_path: Path, page: dict, font_name: str):
    from PIL import Image, ImageDraw, ImageFont
    im = ocr.open_image(img_path.read_bytes())
    draw = ImageDraw.Draw(im)
    fpath = _font_path(font_name)
    for b in page.get("blocks") or []:
        vi = (b.get("vi") or "").strip()
        if b.get("hide") or not vi:
            continue
        x, y, w, h = b["area"]
        bg, fg = b.get("bg", "#ffffff"), b.get("fg", "#111111")
        for lx, ly, lw, lh in b["lines"]:                  # xóa chữ gốc
            draw.rectangle((lx - 3, ly - 3, lx + lw + 3, ly + lh + 3), fill=bg)
        draw.rounded_rectangle((x, y, x + w, y + h), radius=min(w, h) * 0.25, fill=bg)
        size = max(10, int(b.get("lh", 20) * 0.95 * float(b.get("scale", 1))))
        while True:
            font = ImageFont.truetype(fpath, size) if fpath else ImageFont.load_default(size)
            lines = _wrap(draw, vi, font, w * 0.94)
            lh = size * 1.18
            if (len(lines) * lh <= h * 0.98 and all(draw.textlength(l, font=font) <= w for l in lines)) or size <= 9:
                break
            size -= 1
        top = y + (h - len(lines) * lh) / 2
        for i, line in enumerate(lines):
            tw = draw.textlength(line, font=font)
            draw.text((x + (w - tw) / 2, top + i * lh), line, font=font, fill=fg)
    return im


def _safe(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", name).strip(" .") or "Truyen"
    return re.sub(r"\s+", " ", name)[:100]


def _export_dir() -> Path:
    cfg = config.load()
    disk = storage.pick_disk(cfg, "comic")
    return Path(disk["root"]) / "Truyen dich" if disk else config.DATA / "translate" / "exports"


@router.post("/books/{bid}/export")
def export_book(bid: str):
    b = _load(bid)
    done = [p for p in b["pages"] if p["status"] == "done"]
    if not done:
        raise HTTPException(400, "Chưa có trang nào dịch xong.")
    s = settings()
    out_dir = _export_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{_safe(b['name'])} [VI].cbz"
    tmp = out.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        z.writestr("ComicInfo.xml", _comicinfo(b))
        for i, p in enumerate(b["pages"], 1):
            src = BOOKS / bid / "pages" / p["file"]
            if p["status"] == "done" and any((x.get("vi") or "").strip() and not x.get("hide") for x in p["blocks"]):
                im = render_page(src, p, s.get("font", "auto"))
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=90)
                z.writestr(f"{i:04d}.jpg", buf.getvalue())
            else:
                z.writestr(f"{i:04d}{src.suffix}", src.read_bytes())
    os.replace(tmp, out)
    with _lock:
        b = _load(bid)
        b["export"] = str(out)
        _save(b)
    return {"path": str(out), "pages": len(b["pages"]), "translated": len(done)}


def _comicinfo(b: dict) -> str:
    from xml.sax.saxutils import escape
    return ('<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>'
            f"<Title>{escape(b['name'])}</Title><LanguageISO>vi</LanguageISO><PageCount>{len(b['pages'])}</PageCount>"
            "<Notes>Bản dịch máy bằng CircleVault, chỉ để đọc cá nhân.</Notes></ComicInfo>")


@router.get("/books/{bid}/export.cbz")
def download_export(bid: str):
    b = _load(bid)
    p = Path(b.get("export") or "")
    if not b.get("export") or not p.exists():
        raise HTTPException(404, "Chưa xuất file, bấm Xuất CBZ trước.")
    return FileResponse(p, filename=p.name, media_type="application/vnd.comicbook+zip")


@router.get("/books/{bid}/pages/{n}/render")
def page_render(bid: str, n: int):
    b = _load(bid)
    if not 0 <= n < len(b["pages"]):
        raise HTTPException(404, "Không có trang này.")
    im = render_page(BOOKS / bid / "pages" / b["pages"][n]["file"], b["pages"][n], settings().get("font", "auto"))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return Response(buf.getvalue(), media_type="image/jpeg")


@router.post("/books/{bid}/open")
def open_export(bid: str):
    b = _load(bid)
    p = Path(b.get("export") or "")
    if not b.get("export") or not p.exists():
        raise HTTPException(404, "Chưa xuất file.")
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", str(p)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(p)])
    else:
        subprocess.Popen(["xdg-open", str(p.parent)])
    return {"ok": True}


@router.post("/warmup")
def warmup():
    """Nạp sẵn mô hình nhận diện chữ (lần đầu mất vài giây)."""
    try:
        ocr._get()
    except ocr.OcrMissing as e:
        raise HTTPException(500, str(e))
    return {"ok": True}
