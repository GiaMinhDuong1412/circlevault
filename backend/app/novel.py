"""Dịch truyện chữ (tab Dịch → Truyện chữ): tiểu thuyết, light novel, web novel.

Nguồn: file .txt / .epub / .html / .md, hoặc dán văn bản. Tách chương (EPUB theo spine; TXT theo dòng "Chapter 12",
"Chương 12", "第12章", "제12장"…, không có thì cắt mỗi ~6.000 ký tự), tách đoạn. Dịch nền từng chương theo lô đoạn liên tiếp
(Claude đọc cả lô để giữ mạch truyện và xưng hô; Google dịch từng đoạn). Sửa tay được giữ khi dịch tiếp.
Xuất: EPUB (đọc bằng app đọc sách / Google Play Sách) hoặc TXT vào `<ổ truyện>/Truyen dich/<tên> [VI].epub|.txt`.
Lưu ở DATA/translate/novels/<id>/novel.json.
"""
from __future__ import annotations

import hashlib
import html
import io
import json
import os
import posixpath
import re
import shutil
import threading
import time
import uuid
import zipfile
from html.parser import HTMLParser
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import config, langscan, translate

router = APIRouter(prefix="/api/translate/novels", dependencies=[Depends(translate._local_only)])
NOVELS = config.DATA / "translate" / "novels"
MAX_FILE = 200 * 1024 * 1024
BATCH_CHARS = 7000
BATCH_PARAS = 45
_lock = threading.Lock()

CHAPTER = re.compile(r"(?im)^[ \t　]*(?:(?:chapter|chương|chuong|chap|episode|ep|part|quyển|hồi|tập|volume|vol)\.?[ \t]*[\dIVXLCivxlc一二三四五六七八九十百千零]+"
                     r"[^\n]{0,80}|第[\d一二三四五六七八九十百千零〇两]+[章話话回节節卷][^\n]{0,60}|제?\s*\d+\s*[장화][^\n]{0,60}|prologue[^\n]{0,60}|"
                     r"epilogue[^\n]{0,60}|序章[^\n]{0,40}|終章[^\n]{0,40}|mở đầu[^\n]{0,40})[ \t]*$")


# ================================================================== đọc nguồn
def _paras(text: str) -> list[str]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    blank = sum(1 for x in lines if not x.strip())
    if blank >= len(lines) * 0.25:                        # đoạn cách nhau bằng dòng trống
        raw = re.split(r"\n\s*\n", text)
        out = [re.sub(r"[ \t]*\n[ \t]*", " ", p).strip() for p in raw]
    else:                                                 # mỗi dòng một đoạn (kiểu web novel)
        out = [x.strip() for x in lines]
    return [p for p in out if p and re.search(r"\w", p)]


def split_text(text: str, name: str) -> list[dict]:
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    heads = [m for m in CHAPTER.finditer(text)]
    chapters = []
    if len(heads) >= 2:
        if text[:heads[0].start()].strip():
            pre = _paras(text[:heads[0].start()])
            if pre:
                chapters.append({"title": "Mở đầu", "paras": pre})
        for i, m in enumerate(heads):
            body = text[m.end():heads[i + 1].start() if i + 1 < len(heads) else len(text)]
            ps = _paras(body)
            chapters.append({"title": m.group(0).strip(), "paras": ps})
    else:
        ps = _paras(text)
        cur, size, n = [], 0, 1
        for p in ps:
            cur.append(p)
            size += len(p)
            if size > 6000:
                chapters.append({"title": f"Phần {n}", "paras": cur})
                cur, size, n = [], 0, n + 1
        if cur:
            chapters.append({"title": f"Phần {n}" if chapters else name, "paras": cur})
    return [c for c in chapters if c["paras"] or c["title"]]


class _Blocks(HTMLParser):
    """Lấy các khối chữ (p, h1–h6, li, blockquote, div lá) theo thứ tự trong trang XHTML."""
    BLOCK = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "div", "dd", "dt", "td", "pre", "figcaption"}
    SKIP = {"script", "style", "head", "title", "rt", "rp"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[tuple[str, str]] = []
        self.buf: list[str] = []
        self.tag = "p"
        self.skip = 0

    def flush(self):
        t = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        if t:
            self.out.append((self.tag, t))
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.flush()
            self.tag = tag
        elif tag == "br":
            self.buf.append(" ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.flush()
            self.tag = "p"

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)


def _html_chapter(doc: str, fallback: str) -> dict | None:
    p = _Blocks()
    try:
        p.feed(doc)
        p.close()
    except Exception:       # HTML hỏng: lấy chữ thô
        return {"title": fallback, "paras": _paras(re.sub(r"<[^>]+>", "\n", doc))}
    p.flush()
    blocks = p.out
    if not blocks:
        return None
    title = next((t for tag, t in blocks[:4] if tag in ("h1", "h2", "h3")), "")
    paras = [t for tag, t in blocks if not (title and t == title and tag in ("h1", "h2", "h3"))]
    return {"title": title or fallback, "paras": paras}


def read_epub(data: bytes) -> tuple[str, list[dict]]:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "File EPUB bị hỏng.")
    if any(n.startswith("META-INF/encryption.xml") for n in z.namelist()):
        enc = z.read("META-INF/encryption.xml").decode("utf-8", "replace")
        if "font" not in enc.lower() or "xhtml" in enc.lower():
            raise HTTPException(400, "EPUB này có DRM (mã hóa) – app không mở được. Chỉ dùng EPUB không khóa.")
    try:
        cont = z.read("META-INF/container.xml").decode("utf-8", "replace")
        opf_path = re.search(r'full-path="([^"]+)"', cont).group(1)
        opf = z.read(opf_path).decode("utf-8", "replace")
    except (KeyError, AttributeError):
        raise HTTPException(400, "EPUB thiếu mục lục (content.opf).")
    base = posixpath.dirname(opf_path)
    title = html.unescape(re.sub(r"<[^>]+>", "", (re.search(r"<dc:title[^>]*>(.*?)</dc:title>", opf, re.S) or [None, ""])[1])).strip()
    manifest = {}
    for m in re.finditer(r"<item\b([^>]*)/?>", opf):
        a = dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
        if a.get("id") and a.get("href"):
            manifest[a["id"]] = (posixpath.normpath(posixpath.join(base, html.unescape(a["href"]))), a.get("media-type", ""))
    spine = re.findall(r'<itemref\b[^>]*idref="([^"]+)"', opf)
    chapters = []
    for n, rid in enumerate(spine, 1):
        href, mt = manifest.get(rid, (None, ""))
        if not href or "html" not in mt and not href.endswith((".xhtml", ".html", ".htm")):
            continue
        try:
            doc = z.read(href).decode("utf-8", "replace")
        except KeyError:
            continue
        ch = _html_chapter(doc, f"Chương {n}")
        if ch and ch["paras"]:
            chapters.append(ch)
    return title, chapters


def build(name: str, raw: bytes, filename: str) -> dict:
    ext = Path(filename).suffix.lower()
    if ext == ".epub":
        title, chapters = read_epub(raw)
        name = name or title
    else:
        text, _enc = langscan.decode(raw)
        if ext in (".html", ".htm", ".xhtml"):
            ch = _html_chapter(text, name or Path(filename).stem)
            chapters = [ch] if ch else []
        else:
            if ext == ".md":
                text = re.sub(r"(?m)^#{1,6}\s*", "", text)
            chapters = split_text(text, name or Path(filename).stem)
    chapters = [{"title": c["title"][:200], "title_vi": None, "paras": [{"t": t[:20000], "vi": None} for t in c["paras"]]}
                for c in chapters if c["paras"]]
    if not chapters:
        raise HTTPException(400, "Không thấy chữ nào trong file này.")
    sample = [p["t"] for c in chapters[:3] for p in c["paras"][:40]]
    lang = langscan.lang_of_texts(sample)
    nid = uuid.uuid4().hex[:12]
    nv = {"id": nid, "name": (name or Path(filename).stem or "Truyện chữ").strip()[:150], "src": filename, "created": time.time(),
          "lang": lang if lang in ("en", "ja", "zh", "ko") else "auto", "status": "idle", "brief": "", "glossary": "",
          "chapters": chapters}
    _save(nv)
    return nv


# ================================================================== lưu
def _dir(nid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", nid or "") or not (NOVELS / nid / "novel.json").exists():
        raise HTTPException(404, "Không có truyện này.")
    return NOVELS / nid


def _load(nid: str) -> dict:
    return config.read_json(_dir(nid) / "novel.json")


def _save(nv: dict):
    d = NOVELS / nv["id"]
    d.mkdir(parents=True, exist_ok=True)
    config.write_file(d / "novel.json", json.dumps(nv, ensure_ascii=False))


def _summary(nv: dict) -> dict:
    paras = [p for c in nv["chapters"] for p in c["paras"]]
    done_ch = sum(1 for c in nv["chapters"] if all(p.get("vi") is not None for p in c["paras"]))
    return {"id": nv["id"], "name": nv["name"], "src": nv.get("src"), "created": nv["created"], "lang": nv.get("lang"),
            "chapters": len(nv["chapters"]), "chapters_done": done_ch, "paras": len(paras),
            "done": sum(1 for p in paras if p.get("vi") is not None), "chars": sum(len(p["t"]) for p in paras),
            "status": nv.get("status", "idle"), "error": nv.get("error"), "export": nv.get("export"),
            "running": WORKER.current == nv["id"], "brief": nv.get("brief", ""), "glossary": nv.get("glossary", ""),
            "range": nv.get("range")}


# ================================================================== API
@router.get("")
def list_novels():
    out = []
    if NOVELS.exists():
        for d in NOVELS.iterdir():
            try:
                out.append(_summary(config.read_json(d / "novel.json")))
            except (OSError, ValueError, KeyError):
                continue
    out.sort(key=lambda x: -x["created"])
    return {"novels": out}


@router.post("")
async def upload(request: Request, filename: str = "truyen.txt", name: str = ""):
    data = await request.body()
    if not data:
        raise HTTPException(400, "File rỗng.")
    if len(data) > MAX_FILE:
        raise HTTPException(400, "File quá lớn (trên 200 MB).")
    if Path(filename).suffix.lower() not in (".txt", ".epub", ".html", ".htm", ".xhtml", ".md"):
        raise HTTPException(400, "Chọn file .txt, .epub, .html hoặc .md.")
    return _summary(build(name, data, filename))


class TextIn(BaseModel):
    name: str = ""
    text: str


@router.post("/text")
def from_text(body: TextIn):
    if not body.text.strip():
        raise HTTPException(400, "Chưa có chữ.")
    return _summary(build(body.name or "Truyện dán", body.text.encode("utf-8"), "dan-van-ban.txt"))


class PathIn(BaseModel):
    path: str
    name: str = ""


@router.post("/from-path")
def from_path(body: PathIn):
    p = Path(body.path.strip().strip('"'))
    if not p.is_file():
        raise HTTPException(404, "Không thấy file này.")
    if p.stat().st_size > MAX_FILE:
        raise HTTPException(400, "File quá lớn (trên 200 MB).")
    return _summary(build(body.name, p.read_bytes(), p.name))


@router.get("/{nid}")
def get_novel(nid: str):
    nv = _load(nid)
    chs = [{"n": i, "title": c["title"], "title_vi": c.get("title_vi"), "paras": len(c["paras"]),
            "done": sum(1 for p in c["paras"] if p.get("vi") is not None)} for i, c in enumerate(nv["chapters"])]
    return {**_summary(nv), "list": chs}


@router.get("/{nid}/chapters/{n}")
def get_chapter(nid: str, n: int):
    nv = _load(nid)
    if not 0 <= n < len(nv["chapters"]):
        raise HTTPException(404, "Không có chương này.")
    c = nv["chapters"][n]
    return {"n": n, "title": c["title"], "title_vi": c.get("title_vi"), "total": len(nv["chapters"]),
            "paras": [{"i": i, **p} for i, p in enumerate(c["paras"])]}


class EditIn(BaseModel):
    i: int                 # -1 = tên chương
    vi: str


@router.put("/{nid}/chapters/{n}")
def edit_chapter(nid: str, n: int, body: list[EditIn]):
    with _lock:
        nv = _load(nid)
        if not 0 <= n < len(nv["chapters"]):
            raise HTTPException(404, "Không có chương này.")
        c = nv["chapters"][n]
        for e in body:
            if e.i == -1:
                c["title_vi"] = e.vi[:300]
            elif 0 <= e.i < len(c["paras"]):
                c["paras"][e.i].update(vi=e.vi[:40000], edited=True)
        _save(nv)
    return {"ok": True}


class OptsIn(BaseModel):
    name: str | None = None
    brief: str | None = None
    glossary: str | None = None


@router.patch("/{nid}")
def set_opts(nid: str, body: OptsIn):
    with _lock:
        nv = _load(nid)
        if body.name is not None and body.name.strip():
            nv["name"] = body.name.strip()[:150]
        if body.brief is not None:
            nv["brief"] = body.brief[:6000]
        if body.glossary is not None:
            nv["glossary"] = body.glossary[:8000]
        _save(nv)
    return _summary(nv)


class RunIn(BaseModel):
    start: int = 0           # chương bắt đầu
    end: int | None = None   # chương cuối (gồm cả chương này); None = hết truyện
    redo: bool = False       # dịch lại các chương này (giữ đoạn đã sửa tay)


@router.post("/{nid}/run")
def run(nid: str, body: RunIn):
    with _lock:
        nv = _load(nid)
        last = len(nv["chapters"]) - 1
        a = max(0, min(body.start, last))
        b = last if body.end is None else max(a, min(body.end, last))
        if body.redo:
            for c in nv["chapters"][a:b + 1]:
                c["title_vi"] = None
                for p in c["paras"]:
                    if not p.get("edited"):
                        p["vi"] = None
        nv["range"] = [a, b]
        nv["status"] = "queued"
        nv.pop("error", None)
        _save(nv)
    WORKER.add(nid)
    return _summary(nv)


@router.post("/{nid}/stop")
def stop(nid: str):
    WORKER.stop(nid)
    with _lock:
        nv = _load(nid)
        nv["status"] = "idle"
        _save(nv)
    return _summary(nv)


@router.delete("/{nid}")
def delete(nid: str):
    d = _dir(nid)
    WORKER.stop(nid)
    shutil.rmtree(d, ignore_errors=True)        # chỉ xóa bản làm việc; file đã xuất ra ổ vẫn giữ
    return {"ok": True}


# ================================================================== xuất
def _text_of(p: dict) -> str:
    return p["vi"] if p.get("vi") else p["t"]


def _xhtml(title: str, paras: list[str]) -> str:
    body = "\n".join(f"<p>{html.escape(t)}</p>" for t in paras)
    return ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops" lang="vi" xml:lang="vi">\n<head><meta charset="utf-8"/>'
            f'<title>{html.escape(title)}</title><link rel="stylesheet" href="style.css"/></head>\n<body>\n'
            f'<h2>{html.escape(title)}</h2>\n{body}\n</body>\n</html>\n')


def make_epub(nv: dict) -> bytes:
    uid = "urn:uuid:" + str(uuid.UUID(hashlib.md5(nv["id"].encode()).hexdigest()))
    title = nv["name"] + " [VI]"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?>\n<container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>', compress_type=zipfile.ZIP_DEFLATED)
        items, spine, nav = [], [], []
        for i, c in enumerate(nv["chapters"], 1):
            t = c.get("title_vi") or c["title"]
            fn = f"c{i:04d}.xhtml"
            z.writestr(f"OEBPS/{fn}", _xhtml(t, [_text_of(p) for p in c["paras"]]), compress_type=zipfile.ZIP_DEFLATED)
            items.append(f'<item id="c{i}" href="{fn}" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="c{i}"/>')
            nav.append(f'<li><a href="{fn}">{html.escape(t)}</a></li>')
        z.writestr("OEBPS/style.css", "body{font-family:serif;line-height:1.6;margin:0 4%}p{text-indent:1.4em;margin:.5em 0}"
                   "h2{text-align:center;margin:1.5em 0 1em}", compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" '
                   'xmlns:epub="http://www.idpf.org/2007/ops" lang="vi"><head><meta charset="utf-8"/><title>Mục lục</title></head>'
                   f'<body><nav epub:type="toc"><h1>Mục lục</h1><ol>{"".join(nav)}</ol></nav></body></html>',
                   compress_type=zipfile.ZIP_DEFLATED)
        opf = ('<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
               'unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
               f'<dc:identifier id="bid">{uid}</dc:identifier><dc:title>{html.escape(title)}</dc:title><dc:language>vi</dc:language>'
               f'<meta property="dcterms:modified">{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}</meta></metadata>'
               '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
               '<item id="css" href="style.css" media-type="text/css"/>' + "".join(items) + "</manifest>"
               '<spine>' + "".join(spine) + "</spine></package>")
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def make_txt(nv: dict) -> bytes:
    out = []
    for c in nv["chapters"]:
        out.append(c.get("title_vi") or c["title"])
        out.append("")
        out += [_text_of(p) + "\n" for p in c["paras"]]
        out.append("")
    return ("﻿" + "\n".join(out)).encode("utf-8")


@router.post("/{nid}/export")
def export(nid: str, fmt: str = "epub"):
    nv = _load(nid)
    if fmt not in ("epub", "txt"):
        raise HTTPException(400, "Chỉ xuất EPUB hoặc TXT.")
    data = make_epub(nv) if fmt == "epub" else make_txt(nv)
    d = translate._export_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{translate._safe(nv['name'])} [VI].{fmt}"
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    with _lock:
        nv = _load(nid)
        nv["export"] = str(path)
        _save(nv)
    s = _summary(nv)
    return {"path": str(path), "done": s["done"], "paras": s["paras"]}


@router.get("/{nid}/download")
def download(nid: str, fmt: str = "epub"):
    nv = _load(nid)
    p = _dir(nid) / f"tai-ve.{fmt}"
    p.write_bytes(make_epub(nv) if fmt == "epub" else make_txt(nv))
    return FileResponse(p, filename=f"{translate._safe(nv['name'])} [VI].{fmt}",
                        media_type="application/epub+zip" if fmt == "epub" else "text/plain")


# ================================================================== dịch nền
def _split_long(t: str, limit: int = 1800) -> list[str]:
    if len(t) <= limit:
        return [t]
    parts, cur = [], ""
    for s in re.split(r"(?<=[.!?。！？…])\s*", t):
        if len(cur) + len(s) > limit and cur:
            parts.append(cur)
            cur = ""
        cur += (" " if cur and not re.match(r"[　-鿿]", s[:1]) else "") + s
    if cur:
        parts.append(cur)
    return parts


class Worker:
    def __init__(self):
        self.queue: list[str] = []
        self.current: str | None = None
        self._stop: set[str] = set()
        self._cv = threading.Condition()
        self._thread = None

    def add(self, nid):
        with self._cv:
            self._stop.discard(nid)
            if nid not in self.queue and nid != self.current:
                self.queue.append(nid)
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True, name="novel")
                self._thread.start()

    def stop(self, nid):
        with self._cv:
            self._stop.add(nid)
            if nid in self.queue:
                self.queue.remove(nid)

    def _run(self):
        while True:
            with self._cv:
                if not self.queue:
                    self.current = None
                    return
                nid = self.queue.pop(0)
                self.current = nid
            try:
                self._novel(nid)
            except HTTPException:
                pass                                    # truyện đã bị xóa
            except Exception as e:
                _status(nid, "error", f"Lỗi: {e}")
            finally:
                self.current = None

    def _novel(self, nid):
        _status(nid, "running")
        nv = _load(nid)
        a, b = nv.get("range") or [0, len(nv["chapters"]) - 1]
        for n in range(a, b + 1):
            if nid in self._stop:
                return
            try:
                self._chapter(nid, n)
            except translate.TranslateError as e:
                _status(nid, "error", str(e))
                return
        _status(nid, "idle")

    def _chapter(self, nid, n):
        base = translate.settings()
        nv = _load(nid)
        s = {**base, "source": {"zh": "zh-CN"}.get(nv.get("lang"), nv.get("lang") or base["source"]),
             "glossary": "\n".join(x for x in [(nv.get("glossary") or "").strip(), (base.get("glossary") or "").strip()] if x),
             "_sig": hashlib.sha1(((nv.get("brief") or "") + "\0" + (nv.get("glossary") or "")).encode()).hexdigest()[:12]}
        c = nv["chapters"][n]
        ctx = f"Truyện: {nv['name']}. Chương {n + 1}/{len(nv['chapters'])}: {c['title']}."
        if (nv.get("brief") or "").strip():
            ctx += "\nBối cảnh truyện (bám sát khi dịch):\n" + nv["brief"].strip()
        if c.get("title_vi") is None:
            tv = translate.translate_texts([c["title"]], s, kind="novel", context=ctx)[0]
            self._put(nid, n, {-1: tv})
        todo = [i for i, p in enumerate(c["paras"]) if p.get("vi") is None]
        k = 0
        while k < len(todo):
            if nid in self._stop:
                return
            batch, size = [], 0
            while k < len(todo) and len(batch) < BATCH_PARAS and (size < BATCH_CHARS or not batch):
                batch.append(todo[k])
                size += len(c["paras"][todo[k]]["t"])
                k += 1
            pieces, owner = [], []
            for i in batch:
                for part in _split_long(c["paras"][i]["t"]) if base["engine"] == "google" else [c["paras"][i]["t"]]:
                    pieces.append(part)
                    owner.append(i)
            prev = c["paras"][batch[0] - 1].get("vi") if batch[0] > 0 else None
            res = translate.translate_texts(pieces, s, kind="novel",
                                            context=ctx + (f"\nĐoạn ngay trước (đã dịch): {prev[:400]}" if prev else ""))
            out: dict[int, list[str]] = {}
            for i, v in zip(owner, res):
                out.setdefault(i, []).append(v)
            self._put(nid, n, {i: " ".join(x for x in vs if x) for i, vs in out.items()})

    def _put(self, nid, n, vals: dict[int, str]):
        with _lock:
            nv = _load(nid)
            c = nv["chapters"][n]
            for i, v in vals.items():
                if i == -1:
                    c["title_vi"] = v or c["title"]
                elif not c["paras"][i].get("edited"):
                    c["paras"][i]["vi"] = v
            _save(nv)


def _status(nid, status, error=None):
    with _lock:
        try:
            nv = _load(nid)
        except HTTPException:
            return
        nv["status"] = status
        if error:
            nv["error"] = error
        else:
            nv.pop("error", None)
        _save(nv)


WORKER = Worker()
