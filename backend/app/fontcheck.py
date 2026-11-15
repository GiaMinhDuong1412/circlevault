"""Font chữ của game có dấu tiếng Việt không – tìm font trong game, gợi ý font có tiếng Việt cùng kiểu, thay font (có sao lưu).

- Tìm: file font để rời (.ttf .otf .ttc .woff .woff2 – Ren'Py, RPG Maker, Godot/HTML5…), font Unity (đối tượng Font có
  m_FontData = file TTF/OTF bên trong .assets/.bundle), font TextMeshPro (chữ vẽ sẵn thành ảnh – chỉ báo, không đổi được),
  font Unreal (.ufont trong .pak).
- Kiểm tra: bảng cmap (fontTools) có đủ 134 chữ cái tiếng Việt (ă â đ ê ô ơ ư + 5 dấu thanh) không.
- Gợi ý: font đã cài trong Windows có đủ tiếng Việt + danh sách font miễn phí (Google Fonts, giấy phép OFL) tải khi chọn, xếp theo
  cùng kiểu với font gốc (có chân / không chân / chữ đều / pixel / viết tay / gothic) và độ đậm. Font biến thiên được "đóng băng"
  về độ đậm cần dùng (fontTools.varLib.instancer) cho game cũ đọc được.
- Thay: file rời → ghi đè (bản gốc ở CircleVault-ban-goc/); Unity → thay m_FontData của đối tượng Font; Unreal → file mod
  ~mods/zz_CircleVault_VIFont_P.pak chứa .ufont mới. Font mới mang lại tên họ font của font gốc để game tìm theo tên vẫn thấy.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import threading
import urllib.request
from pathlib import Path

from . import config, unityload

BACKUP_DIR = "CircleVault-ban-goc"
PATCH_BACKUP = "CircleVault-truoc-VH"
FONT_EXT = {".ttf", ".otf", ".ttc", ".woff", ".woff2", ".ufont"}
FONT_MOD = "zz_CircleVault_VIFont_P.pak"
MAX_FONT = 40 * 1024 * 1024
MAX_ASSET = 1536 * 1024 * 1024
SKIP_DIRS = {BACKUP_DIR.lower(), PATCH_BACKUP.lower(), ".git", "__pycache__", "node_modules", "monobleedingedge", "renpy",
             "_commonredist", "redist", "directx", "vcredist", "swiftshader"}
VI = sorted(set("ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư") | {chr(c) for c in range(0x1EA0, 0x1EFA)})
FONTS = config.DATA / "fonts"                 # font tải về / người dùng thêm
CACHE = config.DATA / "cache" / "font-windows.json"
GF = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
CATS = {"sans": "Không chân", "serif": "Có chân", "mono": "Chữ đều (mono)", "pixel": "Pixel", "script": "Viết tay",
        "gothic": "Gothic / trung cổ", "display": "Trang trí"}

# Font miễn phí (OFL) đã kiểm tra đủ chữ tiếng Việt. file: tên trong thư mục ofl/<dir>/ của google/fonts.
CATALOG = [
    {"key": "bevietnampro", "name": "Be Vietnam Pro", "cat": "sans", "file": "BeVietnamPro-Regular.ttf", "bold": "BeVietnamPro-Bold.ttf"},
    {"key": "roboto", "name": "Roboto", "cat": "sans", "file": "Roboto[wdth,wght].ttf"},
    {"key": "notosans", "name": "Noto Sans", "cat": "sans", "file": "NotoSans[wdth,wght].ttf"},
    {"key": "montserrat", "name": "Montserrat", "cat": "sans", "file": "Montserrat[wght].ttf"},
    {"key": "nunito", "name": "Nunito (tròn)", "cat": "sans", "file": "Nunito[wght].ttf"},
    {"key": "oswald", "name": "Oswald (hẹp)", "cat": "sans", "file": "Oswald[wght].ttf"},
    {"key": "baloo2", "name": "Baloo 2 (tròn, vui)", "cat": "display", "file": "Baloo2[wght].ttf"},
    {"key": "bangers", "name": "Bangers (truyện tranh)", "cat": "display", "file": "Bangers-Regular.ttf"},
    {"key": "notoserif", "name": "Noto Serif", "cat": "serif", "file": "NotoSerif[wdth,wght].ttf"},
    {"key": "lora", "name": "Lora", "cat": "serif", "file": "Lora[wght].ttf"},
    {"key": "merriweather", "name": "Merriweather", "cat": "serif", "file": "Merriweather[opsz,wdth,wght].ttf"},
    {"key": "ebgaramond", "name": "EB Garamond (cổ điển)", "cat": "serif", "file": "EBGaramond[wght].ttf"},
    {"key": "cormorantgaramond", "name": "Cormorant Garamond (thanh, cổ điển)", "cat": "serif", "file": "CormorantGaramond[wght].ttf"},
    {"key": "playfairdisplay", "name": "Playfair Display", "cat": "serif", "file": "PlayfairDisplay[wght].ttf"},
    {"key": "alegreya", "name": "Alegreya (sách, kỳ ảo)", "cat": "serif", "file": "Alegreya[wght].ttf"},
    {"key": "grenzegotisch", "name": "Grenze Gotisch (gothic)", "cat": "gothic", "file": "GrenzeGotisch[wght].ttf"},
    {"key": "robotomono", "name": "Roboto Mono", "cat": "mono", "file": "RobotoMono[wght].ttf"},
    {"key": "jetbrainsmono", "name": "JetBrains Mono", "cat": "mono", "file": "JetBrainsMono[wght].ttf"},
    {"key": "vt323", "name": "VT323 (pixel)", "cat": "pixel", "file": "VT323-Regular.ttf"},
    {"key": "dancingscript", "name": "Dancing Script", "cat": "script", "file": "DancingScript[wght].ttf"},
    {"key": "patrickhand", "name": "Patrick Hand (viết tay)", "cat": "script", "file": "PatrickHand-Regular.ttf"},
    {"key": "pacifico", "name": "Pacifico", "cat": "script", "file": "Pacifico-Regular.ttf"},
]
NEAR = {"sans": ["sans", "display", "serif", "mono"], "serif": ["serif", "gothic", "sans"], "mono": ["mono", "pixel", "sans"],
        "pixel": ["pixel", "mono", "sans"], "script": ["script", "display", "serif"], "gothic": ["gothic", "serif", "display"],
        "display": ["display", "sans", "serif"]}

_lock = threading.Lock()


class FontError(RuntimeError):
    pass


def _tt():
    try:
        from fontTools.ttLib import TTFont
    except ImportError as e:
        raise FontError("Thiếu thư viện fonttools. Chạy: pip install -r requirements.txt") from e
    return TTFont


# ================================================================== đọc font
def _name(tt, ids=(16, 1)) -> str:
    try:
        for i in ids:
            v = tt["name"].getDebugName(i)
            if v:
                return v
    except Exception:       # bảng name hỏng
        pass
    return ""


def _cat(tt, name: str) -> str:
    low = name.lower()
    if re.search(r"pixel|8.?bit|16.?bit|\bbit|retro|px\b|arcade|vt323|press ?start|silkscreen|dotgothic|\bdot\b", low):
        return "pixel"
    if re.search(r"gotisch|gothic(?!\s*a1)|fraktur|blackletter|medieval|old ?english|textura|uncial|cinzel|trajan", low) \
            and not re.search(r"ms gothic|yu gothic|nanum|mplus|gothic ?a1|\bsans\b", low):
        return "gothic"
    try:
        if tt["post"].isFixedPitch or tt["OS/2"].panose.bProportion == 9:
            return "mono"
    except Exception:       # thiếu bảng
        pass
    if re.search(r"mono|code|console|courier|terminal", low):
        return "mono"
    try:
        os2 = tt["OS/2"]
        fam = os2.sFamilyClass >> 8
        pan = os2.panose
        if fam == 10 or pan.bFamilyType == 3:
            return "script"
        if fam == 9 or pan.bFamilyType == 4:
            return "display"
        if fam == 8 or (pan.bFamilyType == 2 and pan.bSerifStyle in (11, 12, 13)):
            return "sans"
        if 1 <= fam <= 7 or (pan.bFamilyType == 2 and 2 <= pan.bSerifStyle <= 10):
            return "serif"
    except Exception:       # thiếu bảng OS/2
        pass
    if re.search(r"script|hand|brush|marker|comic|pacifico|dancing|cursive", low):
        return "script"
    if re.search(r"serif(?!.*sans)|times|garamond|georgia|roman|book|baskerville|caslon|minion|palatino|cambria|lora|merriweather", low) \
            and "sans" not in low:
        return "serif"
    return "sans"


def info(data: bytes) -> dict | None:
    """Tên, kiểu, độ đậm và số chữ tiếng Việt còn thiếu của một file font (TTF/OTF/TTC/WOFF/WOFF2). None nếu không đọc được."""
    TTFont = _tt()
    try:
        tt = TTFont(io.BytesIO(data), fontNumber=0, lazy=True)
        cmap = tt.getBestCmap() or {}
    except Exception:       # không phải font / font hỏng
        return None
    name = _name(tt) or "?"
    latin = all(ord(c) in cmap for c in "aeoAEO")
    missing = [c for c in VI if ord(c) not in cmap]
    try:
        weight = int(tt["OS/2"].usWeightClass)
        italic = bool(tt["OS/2"].fsSelection & 1)
    except Exception:       # thiếu bảng OS/2
        weight, italic = 400, False
    return {"family": name, "style": _name(tt, (17, 2)) or "Regular", "cat": _cat(tt, name), "weight": weight, "italic": italic,
            "latin": latin, "missing": len(missing), "missing_sample": "".join(missing[:14]), "total": len(VI),
            "have": "".join(c for c in VI if ord(c) in cmap),
            "variable": "fvar" in tt, "flavor": getattr(tt, "flavor", None)}


# ================================================================== font trong game
def _walk_fonts(root: Path):
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d.lower() not in SKIP_DIRS and not d.startswith(".")]
        for f in fn:
            p = Path(dp) / f
            if p.suffix.lower() in FONT_EXT:
                yield p


def _orig(root: Path, rel: str) -> Path:
    b = root / BACKUP_DIR / rel
    return b if b.is_file() else root / rel


def _entry(fid: str, kind: str, label: str, inf: dict | None, **kw) -> dict | None:
    if not inf:
        return None
    if not inf["latin"]:
        return None                               # font biểu tượng / chỉ có chữ Nhật, Trung… – không dùng cho chữ Latin
    ok = inf["missing"] == 0
    return {"id": fid, "kind": kind, "label": label, **inf, "ok": ok, "can_replace": True, **kw}


def scan_game(root: Path, aes: bytes | None = None, job: dict | None = None) -> dict:
    """Mọi font của game + tình trạng tiếng Việt."""
    root = Path(root)
    if not root.is_dir():
        raise FontError(f"Không thấy thư mục game: {root}")
    out: list[dict] = []
    notes: list[str] = []
    for p in _walk_fonts(root):
        rel = str(p.relative_to(root)).replace("\\", "/")
        try:
            if p.stat().st_size > MAX_FONT:
                continue
            e = _entry("f:" + rel, "file", rel, info(_orig(root, rel).read_bytes()))
        except OSError:
            continue
        if e:
            out.append(e)
    if job is not None:
        job["text"] = "Đang xem font trong dữ liệu Unity…"
    out += _scan_unity(root, notes)
    if job is not None:
        job["text"] = "Đang xem font trong file .pak (Unreal)…"
    out += _scan_unreal(root, aes, notes)
    seen, uniq = set(), []
    for e in out:
        if e["id"] not in seen:
            seen.add(e["id"])
            uniq.append(e)
    return {"fonts": uniq, "notes": notes}


def _unity_files(root: Path) -> list[Path]:
    out = []
    for d in [x for x in root.iterdir() if x.is_dir() and x.name.endswith("_Data")]:
        for p in d.rglob("*"):
            n = p.name.lower()
            if any(part.lower() in SKIP_DIRS for part in p.relative_to(root).parts):
                continue
            if p.is_file() and (p.suffix.lower() in (".assets", ".bundle") or n in ("resources.assets", "globalgamemanagers")
                                or re.fullmatch(r"level\d+|sharedassets\d+\.assets", n)):
                try:
                    if p.stat().st_size <= MAX_ASSET:
                        out.append(p)
                except OSError:
                    pass
    return out


def _unitypy():
    try:
        import UnityPy  # noqa: N813
    except ImportError:
        return None
    return UnityPy


def _font_bytes(tree: dict) -> bytes:
    d = tree.get("m_FontData")
    if isinstance(d, (bytes, bytearray)):
        return bytes(d)
    if isinstance(d, list):
        return bytes((x + 256) % 256 for x in d)
    return b""


def _scan_unity(root: Path, notes: list[str]) -> list[dict]:
    UnityPy = _unitypy()
    files = _unity_files(root) if any(x.is_dir() and x.name.endswith("_Data") for x in root.iterdir()) else []
    if not files or not UnityPy:
        return []
    out = []
    tmp_n = 0
    for p in files:
        rel = str(p.relative_to(root)).replace("\\", "/")
        cnt = [0]
        try:
            with unityload.open_env(_orig(root, rel)) as env:     # tự đóng file: không giữ file game mở
                _scan_objs(list(env.objects), rel, out, cnt)
        except Exception:       # file không phải của Unity / mã hóa
            continue
        tmp_n += cnt[0]
    if tmp_n:
        notes.append(f"Game dùng {tmp_n} font TextMeshPro (chữ vẽ sẵn thành ảnh): app chỉ kiểm tra, chưa thêm dấu được. "
                     "Nếu chữ Việt hiện ô vuông ở những chỗ đó, dùng 'Unity · dịch khi chơi' hoặc gói Việt hóa có sẵn.")
    return out


def _scan_objs(objs, rel: str, out: list, tmp_count: list):
    for o in objs:
        try:
            tname = o.type.name
            if tname == "Font":
                tree = o.read_typetree()
                data = _font_bytes(tree)
                name = tree.get("m_Name") or "Font"
                if len(data) < 100:
                    continue                  # font bitmap / font hệ thống không kèm dữ liệu
                e = _entry(f"u:{rel}:{o.path_id}", "unity", f"{name} ({rel})", info(data), rel=rel, path_id=int(o.path_id))
                if e:
                    out.append(e)
            elif tname == "MonoBehaviour" and 2048 < o.byte_size < 32 * 1024 * 1024:
                name = o.peek_name() or ""
                if re.search(r"(?i)settings", name):
                    continue
                e = _tmp_entry(o, name, rel)              # font TMP nhận bằng bảng chữ thô, không dựa vào tên
                if e:
                    tmp_count[0] += 1
                    out.append(e)
        except Exception:       # đối tượng không đọc được: bỏ qua
            continue


_TMP_REC16 = re.compile(rb"(?:\x01\x00\x00\x00..\x00\x00..\x00\x00\x00\x00\x80\x3f){24,}", re.S)   # TMP_Character: type=1, unicode, glyph, scale=1
_TMP_REC12 = re.compile(rb"(?:..\x00\x00..\x00\x00\x00\x00\x80\x3f){24,}", re.S)                  # bản TMP cũ không có type


def tmp_chars_raw(raw: bytes) -> set[int]:
    """Bảng chữ của font TextMeshPro đọc thẳng từ dữ liệu thô (game IL2CPP không có typetree): dãy bản ghi
    (unicode, chỉ số glyph, tỉ lệ 1.0) liền nhau trong m_CharacterTable."""
    import struct
    best: set[int] = set()
    for rx, size, off in ((_TMP_REC16, 16, 4), (_TMP_REC12, 12, 0)):
        for m in rx.finditer(raw):
            chunk = m.group(0)
            vals = {struct.unpack_from("<I", chunk, i + off)[0] for i in range(0, len(chunk) - size + 1, size)}
            if len(vals) > len(best) and sum(1 for v in vals if 0x20 <= v < 0x7f) >= 20:
                best = vals
        if best:
            break
    return best


def _tmp_entry(o, name: str, rel: str) -> dict | None:
    chars: set[int] = set()
    try:
        tree = o.read_typetree()
        for it in tree.get("m_CharacterTable") or []:
            chars.add(int(it.get("m_Unicode", 0)))
        for it in tree.get("m_glyphInfoList") or []:
            chars.add(int(it.get("id", 0)))
    except Exception:       # MonoBehaviour không có typetree (IL2CPP): đọc thô
        pass
    if not chars:
        try:
            chars = tmp_chars_raw(o.get_raw_data())
        except Exception:       # không đọc được
            chars = set()
    if not chars or not all(ord(c) in chars for c in "aeo"):
        return None                               # không phải font (TMP Settings, bảng màu…)
    miss = [c for c in VI if ord(c) not in chars]
    return {"id": f"t:{rel}:{o.path_id}", "kind": "tmp", "label": f"{name or 'Font TextMeshPro'} ({rel})", "family": name or "TextMeshPro",
            "style": "TextMeshPro", "cat": "sans", "weight": 400, "italic": False, "latin": True, "total": len(VI), "variable": False,
            "flavor": None, "can_replace": False, "rel": rel, "path_id": int(o.path_id),
            "missing": len(miss), "missing_sample": "".join(miss[:14]), "ok": not miss, "have": "".join(c for c in VI if ord(c) in chars),
            "note": "" if not miss else "Font TextMeshPro: chữ đã vẽ sẵn thành ảnh nên app chưa thêm dấu được – chọn cách hiển thị ở mục "
                                        "“Khi font thiếu dấu” bên dưới."}


def _scan_unreal(root: Path, aes: bytes | None, notes: list[str]) -> list[dict]:
    from . import unreal
    out = []
    try:
        gds = unreal.game_dirs(root)
    except OSError:
        return []
    for gd in gds:
        for p in sorted((gd / "Content" / "Paks").rglob("*.pak")):
            if p.name in (unreal.MOD_NAME, FONT_MOD):
                continue
            try:
                pak = unreal.Pak(p, aes)
            except Exception:       # pak mã hóa / phiên bản lạ
                continue
            for name in pak.entries:
                if not re.search(r"(?i)\.(ufont|ttf|otf)$", name) or "/Engine/" in "/" + pak.full_path(name):
                    continue
                try:
                    data = pak.read(name)
                except Exception as e:      # nén Oodle…
                    notes.append(f"Không đọc được {name}: {e}")
                    continue
                rel = str(p.relative_to(root)).replace("\\", "/")
                e = _entry(f"ue:{rel}:{name}", "unreal", Path(name).name + f" ({p.name})", info(data), pak=rel, name=name,
                           full=pak.full_path(name), version=pak.vname)
                if e:
                    out.append(e)
    return out


# ================================================================== font gợi ý
def _font_dirs() -> list[Path]:
    win = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    loc = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts" if os.environ.get("LOCALAPPDATA") else None
    dirs = [d for d in (win, loc) if d and d.is_dir()]
    if not dirs:            # máy thử Linux
        dirs = [d for d in (Path("/usr/share/fonts"),) if d.is_dir()]
    return dirs


def system_fonts() -> list[dict]:
    """Font đã cài có đủ tiếng Việt (nhớ kết quả theo kích thước + giờ sửa file)."""
    with _lock:
        cache = {}
        try:
            cache = config.read_json(CACHE)
        except (OSError, ValueError):
            pass
        out, new = [], {}
        for d in _font_dirs():
            for p in d.rglob("*"):
                if p.suffix.lower() not in (".ttf", ".otf", ".ttc"):
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                if st.st_size > 30 * 1024 * 1024:
                    continue
                k = f"{p}|{st.st_size}|{int(st.st_mtime)}"
                inf = cache.get(k)
                if inf is None:
                    try:
                        inf = info(p.read_bytes()) or {}
                    except OSError:
                        inf = {}
                    inf = {x: inf.get(x) for x in ("family", "style", "cat", "weight", "italic", "missing", "latin")} if inf else {}
                new[k] = inf
                if inf and inf.get("latin") and inf.get("missing") == 0 and not inf.get("italic"):
                    out.append({"id": "sys:" + str(p), "name": inf["family"], "style": inf.get("style") or "", "cat": inf["cat"],
                                "weight": inf.get("weight") or 400, "src": "Đã cài trong Windows", "path": str(p)})
        if new != cache:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            config.write_file(CACHE, __import__("json").dumps(new, ensure_ascii=False))
    fams: dict[str, dict] = {}
    for f in out:                       # mỗi họ font giữ bản thường (400) + bản đậm gần 700
        key = f["name"].lower()
        cur = fams.get(key)
        if not cur or abs(f["weight"] - 400) < abs(cur["weight"] - 400):
            fams[key] = {**f, "bold_path": cur.get("bold_path") if cur else None}
        if 600 <= f["weight"] <= 800:
            fams[key]["bold_path"] = f["path"]
    return sorted(fams.values(), key=lambda x: x["name"].lower())


def user_fonts() -> list[dict]:
    d = FONTS / "cua-toi"
    out = []
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if p.suffix.lower() in (".ttf", ".otf"):
                try:
                    inf = info(p.read_bytes())
                except OSError:
                    continue
                if inf:
                    out.append({"id": "user:" + p.name, "name": inf["family"], "style": inf["style"], "cat": inf["cat"],
                                "weight": inf["weight"], "src": "Bạn thêm", "missing": inf["missing"]})
    return out


def candidates(cat: str = "sans") -> list[dict]:
    """Font có tiếng Việt, cùng kiểu đứng trước."""
    order = NEAR.get(cat, NEAR["sans"])
    rank = {c: i for i, c in enumerate(order)}
    items = [{"id": "dl:" + c["key"], "name": c["name"], "cat": c["cat"], "weight": 400, "src": "Miễn phí (Google Fonts) – tải khi chọn",
              "have": (FONTS / "tai-ve" / c["file"]).is_file()} for c in CATALOG]
    try:
        items += [{k: v for k, v in f.items() if k not in ("path", "bold_path")} for f in system_fonts()]
    except FontError:
        pass
    items += [u for u in user_fonts() if u.get("missing") == 0]
    seen, uniq = set(), []
    for it in items:                    # cùng một họ font (tải về + đã cài): giữ một
        k = re.sub(r"\s*\(.*\)$", "", it["name"]).lower()
        if k in seen:
            continue
        seen.add(k)
        it["cat_name"] = CATS.get(it["cat"], it["cat"])
        uniq.append(it)
    items = uniq
    common = re.compile(r"(?i)^(arial|tahoma|segoe ui|times new roman|verdana|calibri|cambria|georgia|consolas|courier new|"
                        r"be vietnam pro|roboto|noto sans|noto serif|lora|vt323|grenze gotisch.*|ebgaramond|eb garamond.*)$")
    items.sort(key=lambda x: (rank.get(x["cat"], 9), 0 if x["id"].startswith("dl:") else 1 if common.match(x["name"]) else 2,
                              x["name"].lower()))
    return items


def _download(c: dict, fname: str) -> Path:
    dst = FONTS / "tai-ve" / fname
    if dst.is_file() and dst.stat().st_size > 1000:
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    url = GF + c["key"] + "/" + urllib.request.quote(fname)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CircleVault"})
        data = urllib.request.urlopen(req, timeout=60).read()
    except Exception as e:      # mất mạng / GitHub chặn
        raise FontError(f"Không tải được font {c['name']}: {e}") from e
    if info(data) is None:
        raise FontError(f"File font {c['name']} tải về bị hỏng.")
    config.write_file(dst, data)
    return dst


def font_source(cid: str, weight: int = 400) -> bytes:
    """Dữ liệu font (TTF/OTF) của font được chọn, đã đóng băng font biến thiên về độ đậm cần dùng."""
    bold = weight >= 600
    if cid.startswith("dl:"):
        c = next((x for x in CATALOG if x["key"] == cid[3:]), None)
        if not c:
            raise FontError("Không có font này trong danh sách.")
        data = _download(c, c["bold"] if bold and c.get("bold") else c["file"]).read_bytes()
    elif cid.startswith("sys:"):
        p = Path(cid[4:])
        if not any(str(p).lower().startswith(str(d).lower()) for d in _font_dirs()) or not p.is_file():
            raise FontError("Không thấy font này trong máy.")
        if bold:
            f = next((x for x in system_fonts() if x["path"] == str(p)), None)
            if f and f.get("bold_path"):
                p = Path(f["bold_path"])
        data = p.read_bytes()
    elif cid.startswith("user:"):
        p = FONTS / "cua-toi" / Path(cid[5:]).name
        if not p.is_file():
            raise FontError("Không thấy font bạn đã thêm.")
        data = p.read_bytes()
    else:
        raise FontError("Font không hợp lệ.")
    return _static(data, weight)


def _static(data: bytes, weight: int) -> bytes:
    TTFont = _tt()
    tt = TTFont(io.BytesIO(data), fontNumber=0)
    if "fvar" in tt:
        from fontTools.varLib import instancer
        loc = {a.axisTag: a.defaultValue for a in tt["fvar"].axes}
        if "wght" in loc:
            ax = next(a for a in tt["fvar"].axes if a.axisTag == "wght")
            loc["wght"] = max(ax.minValue, min(ax.maxValue, 700 if weight >= 600 else 400))
        tt = instancer.instantiateVariableFont(tt, loc)
    tt.flavor = None
    buf = io.BytesIO()
    tt.save(buf)
    return buf.getvalue()


def add_user_font(name: str, data: bytes) -> dict:
    inf = info(data)
    if not inf:
        raise FontError("File này không phải font (.ttf/.otf) đọc được.")
    if inf["missing"]:
        raise FontError(f"Font {inf['family']} thiếu {inf['missing']} chữ tiếng Việt ({inf['missing_sample']}…), không dùng được.")
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", Path(name).stem)[:60] or "font"
    ext = ".otf" if data[:4] == b"OTTO" else ".ttf"
    d = FONTS / "cua-toi"
    d.mkdir(parents=True, exist_ok=True)
    data = _static(data, inf["weight"]) if inf.get("variable") or inf.get("flavor") else data
    config.write_file(d / (safe + ext), data)
    return {"id": "user:" + safe + ext, "name": inf["family"]}


# ================================================================== tạo font thay thế
def build(new: bytes, orig: bytes | None, flavor: str | None) -> bytes:
    """Font mới mang tên họ font gốc (game tìm font theo tên vẫn thấy), cùng dạng nén (woff/woff2) với file gốc."""
    TTFont = _tt()
    tt = TTFont(io.BytesIO(new), fontNumber=0)
    if orig:
        try:
            o = TTFont(io.BytesIO(orig), fontNumber=0, lazy=True)
            nt, ont = tt["name"], o["name"]
            for nid in (1, 2, 4, 6, 16, 17):
                v = ont.getDebugName(nid)
                if v:
                    if nid == 6:
                        v = re.sub(r"[^\x21-\x7e]", "", v.replace(" ", ""))[:63] or "CircleVaultVI"
                    nt.setName(v, nid, 3, 1, 0x409)
                    nt.setName(v, nid, 1, 0, 0)
                elif nid in (16, 17):
                    nt.removeNames(nameID=nid)
        except Exception:       # font gốc không đọc được tên: giữ tên font mới
            pass
    tt.flavor = flavor if flavor in ("woff", "woff2") else None
    buf = io.BytesIO()
    tt.save(buf)
    return buf.getvalue()


def _flavor_of(data: bytes, rel: str) -> str | None:
    if data[:4] == b"wOFF":
        return "woff"
    if data[:4] == b"wOF2":
        return "woff2"
    ext = Path(rel).suffix.lower()
    return {".woff": "woff", ".woff2": "woff2"}.get(ext)


def _backup(root: Path, rel: str):
    p = root / rel
    b = root / BACKUP_DIR / rel
    if not b.exists() and p.exists():
        b.parent.mkdir(parents=True, exist_ok=True)
        src = p
        vh = root / PATCH_BACKUP
        if vh.is_dir():
            for d in sorted(vh.iterdir()):
                if (d / rel).is_file():
                    src = d / rel
                    break
        shutil.copy2(src, b)


def apply(root: Path, cid: str, targets: list[dict], aes: bytes | None = None, prog=None) -> dict:
    """Thay các font được chọn bằng font cid. targets = mục trong scan_game (đã lọc theo id người chọn)."""
    prog = prog or (lambda *a: None)
    root = Path(root)
    done, errors, files = 0, [], set()
    cache: dict[int, bytes] = {}

    def src(weight: int) -> bytes:
        w = 700 if weight >= 600 else 400
        if w not in cache:
            cache[w] = font_source(cid, w)
        return cache[w]

    unity: dict[str, list[dict]] = {}
    ue: dict[str, dict] = {}
    for t in targets:
        try:
            if t["kind"] == "file":
                rel = t["label"]
                orig = _orig(root, rel).read_bytes()
                if Path(rel).suffix.lower() == ".ttc":
                    errors.append(f"{rel}: font gộp .ttc – app chưa thay được")
                    continue
                data = build(src(t.get("weight") or 400), orig, _flavor_of(orig, rel))
                _backup(root, rel)
                config.write_file(root / rel, data)
                files.add(rel)
                done += 1
            elif t["kind"] == "unity":
                unity.setdefault(t["rel"], []).append(t)
            elif t["kind"] == "unreal":
                ue.setdefault(t["pak"], {"version": t["version"], "items": []})["items"].append(t)
        except (OSError, FontError) as e:
            errors.append(f"{t['label']}: {e}")
    for rel, ts in unity.items():
        prog(f"Đang đổi font trong {rel}", None, None)
        try:
            done += _apply_unity(root, rel, ts, src)
            files.add(rel)
        except Exception as e:      # UnityPy lỗi: báo, không làm hỏng file (chỉ ghi khi lưu xong)
            errors.append(f"{rel}: {type(e).__name__}: {e}")
    if ue:
        try:
            n, out = _apply_unreal(root, ue, src, aes)
            done += n
            files.update(out)
        except Exception as e:      # đọc/ghi pak lỗi
            errors.append(f"Unreal: {e}")
    return {"fonts": done, "files": sorted(files), "errors": errors[:10]}


def _apply_unity(root: Path, rel: str, ts: list[dict], src) -> int:
    UnityPy = _unitypy()
    if not UnityPy:
        raise FontError("Thiếu thư viện UnityPy.")
    p = root / rel
    _backup(root, rel)
    origs = {}
    want = {t["path_id"]: t for t in ts}
    with unityload.open_env(_orig(root, rel)) as orig_env:
        for o in orig_env.objects:
            if o.path_id in want and o.type.name == "Font":
                origs[o.path_id] = _font_bytes(o.read_typetree())
    n = 0
    # đọc BẢN CHÉP TẠM của file hiện tại (có thể đã ghi bản dịch) – không giữ chính file game mở, rồi mới ghi đè
    with unityload.open_env(p, detach=True) as env:
        for o in env.objects:
            t = want.get(o.path_id)
            if not t or o.type.name != "Font":
                continue
            tree = o.read_typetree()
            old = origs.get(o.path_id) or _font_bytes(tree)
            data = build(src(t.get("weight") or 400), old, None)
            tree["m_FontData"] = list(data) if isinstance(tree.get("m_FontData"), list) else data
            o.save_typetree(tree)
            n += 1
        out, bundle = _env_bytes(env) if n else (b"", False)
    if n:
        _write_unity(root, p, out, bundle)
    return n


def _env_bytes(env) -> tuple[bytes, bool]:
    f = next(iter(env.files.values()))
    bundle = type(f).__name__ == "BundleFile"
    return (f.save(packer="lz4") if bundle else f.save()), bundle


def _write_unity(root: Path, p: Path, data: bytes, bundle: bool):
    config.write_file(p, data)
    if bundle:                                    # bundle của Addressables: tắt kiểm tra CRC trong catalog
        from . import unitygame
        cat = unitygame.catalog_of(root)
        if cat and cat.suffix == ".json" and cat.exists():
            rel = str(cat.relative_to(root)).replace("\\", "/")
            _backup(root, rel)
            text, _n = unitygame.zero_crc(cat.read_text(encoding="utf-8"), [p.name])
            config.write_file(cat, text)


def _apply_unreal(root: Path, ue: dict, src, aes: bytes | None) -> tuple[int, list[str]]:
    from . import unreal
    n, outs = 0, []
    by_dir: dict[str, dict] = {}
    for pak_rel, g in ue.items():
        pak = unreal.Pak(root / pak_rel, aes)
        gd = Path(pak_rel).parts[0] if "/Content/Paks" in "/" + pak_rel and not pak_rel.startswith("Content/") else ""
        m = by_dir.setdefault(gd, {"version": g["version"], "files": {}})
        for t in g["items"]:
            orig = pak.read(t["name"])
            full = t["full"]
            common = "../../../"
            name = full[len(common):] if full.startswith(common) else full.lstrip("/")
            m["files"][name] = build(src(t.get("weight") or 400), orig, None)
            n += 1
    for gd, m in by_dir.items():
        out = (root / gd if gd else root) / "Content" / "Paks" / "~mods" / FONT_MOD
        out.parent.mkdir(parents=True, exist_ok=True)
        config.write_file(out, unreal.write_pak(m["files"], "../../../", m["version"]))
        outs.append(str(out.relative_to(root)).replace("\\", "/"))
    return n, outs


def restore(root: Path, fix: dict) -> int:
    """Trả font gốc: file rời chép lại từ bản sao lưu, Unity đặt lại m_FontData gốc, Unreal xóa file mod font."""
    root = Path(root)
    n = 0
    for t in fix.get("targets") or []:
        try:
            if t["kind"] == "file":
                b = root / BACKUP_DIR / t["label"]
                if b.is_file():
                    shutil.copy2(b, root / t["label"])
                    n += 1
        except OSError:
            continue
    unity: dict[str, list[dict]] = {}
    for t in fix.get("targets") or []:
        if t["kind"] == "unity":
            unity.setdefault(t["rel"], []).append(t)
    UnityPy = _unitypy()
    for rel, ts in unity.items():
        b = root / BACKUP_DIR / rel
        if not (b.is_file() and UnityPy):
            continue
        try:
            want = {t["path_id"] for t in ts}
            with unityload.open_env(b) as benv:
                origs = {o.path_id: o.read_typetree() for o in benv.objects if o.path_id in want and o.type.name == "Font"}
            hit = 0
            with unityload.open_env(root / rel, detach=True) as env:
                for o in env.objects:
                    if o.path_id in origs and o.type.name == "Font":
                        tree = o.read_typetree()
                        tree["m_FontData"] = origs[o.path_id].get("m_FontData")
                        o.save_typetree(tree)
                        hit += 1
                out, bundle = _env_bytes(env) if hit else (b"", False)
            if hit:
                _write_unity(root, root / rel, out, bundle)
                n += hit
        except Exception:       # không đọc được: để nguyên
            continue
    for f in fix.get("files") or []:
        if f.endswith(FONT_MOD) and (root / f).is_file():
            (root / f).unlink()
            n += 1
    return n


def preview_bytes(root: Path, f: dict, aes: bytes | None = None) -> bytes:
    """Dữ liệu font GỐC của game (để trang vẽ chữ mẫu so sánh)."""
    root = Path(root)
    if f["kind"] == "file":
        return _orig(root, f["label"]).read_bytes()
    if f["kind"] == "unity":
        with unityload.open_env(_orig(root, f["rel"])) as env:
            for o in env.objects:
                if o.path_id == f["path_id"]:
                    return _font_bytes(o.read_typetree())
    if f["kind"] == "unreal":
        from . import unreal
        return unreal.Pak(root / f["pak"], aes).read(f["name"])
    raise FontError("Không có dữ liệu font.")


# ================================================================== chữ Việt khi font của game thiếu dấu
VI_MODES = {"full": "Đầy đủ dấu", "safe": "Giữ dấu font có", "nodau": "Không dấu", "en": "Giữ tiếng Anh"}
LATIN1_VI = {c for c in VI if ord(c) < 256}           # à á â ã è é ê ì í ò ó ô õ ù ú ý… (font Latin thường có)


def _strip(c: str) -> str:
    import unicodedata
    if c in "đĐ":
        return "d" if c == "đ" else "D"
    return "".join(x for x in unicodedata.normalize("NFD", c) if not unicodedata.combining(x))


def fit_char(c: str, have: set[str]) -> str:
    """Chữ Việt mà font không có → chữ gần nhất font CÓ: giữ dáng nguyên âm (â ê ô) trước, rồi dấu thanh, cuối cùng chữ không dấu."""
    import unicodedata
    if c in have or c not in VI_SET:
        return c
    if c in "đĐ":
        return "Ð" if c == "Đ" and "Ð" in have else _strip(c)
    d = unicodedata.normalize("NFD", c)
    base, marks = d[0], d[1:]
    shape = "".join(m for m in marks if m in "̛̂̆")
    tone = "".join(m for m in marks if m in "̣̀́̃̉")
    for cand in (base + shape, base + tone):
        x = unicodedata.normalize("NFC", cand)
        if len(x) == 1 and x in have:
            return x
    return base


VI_SET = set(VI) | {"đ", "Đ"}


def fit_text(s: str, mode: str, have: set[str] | None = None) -> str:
    if not s or mode in ("full", "en", None):
        return s
    if mode == "nodau":
        return "".join(_strip(c) if c in VI_SET else c for c in s)
    h = have if have is not None else LATIN1_VI
    return "".join(fit_char(c, h) if c in VI_SET else c for c in s)
