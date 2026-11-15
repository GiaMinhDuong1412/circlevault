"""Việt hóa game từ file (tab Dịch → Việt hóa game): Ren'Py, RPG Maker MV/MZ và Unity (Unity Localization – xem unitygame.py).

Quy trình: quét thư mục game → lấy mọi câu chữ (không trùng) → dịch theo thứ tự kịch bản → người dùng xem/sửa → áp dụng.

Ren'Py: KHÔNG sửa file của game. Chỉ thêm `game/zz_circlevault_vi.rpy` + `game/circlevault_vi.json`:
  - `config.say_menu_text_filter` thay câu thoại/lựa chọn (khóa = chuỗi đúng như trong kịch bản, trước khi thay [biến]),
  - `config.replace_text` thay chữ giao diện (nút, tên nhân vật…),
  - `config.font_replacement_map` đổi phông của game sang DejaVuSans (có dấu tiếng Việt) nếu người dùng bật.
  Đọc kịch bản từ .rpy, hoặc .rpyc (pickle – mở bằng bộ đọc an toàn, chỉ dựng đối tượng giả, không chạy mã), cả trong .rpa.
RPG Maker MV/MZ: sửa data/*.json (sao lưu bản gốc vào `<game>/CircleVault-ban-goc/` trước), tự xuống dòng câu thoại,
  thêm khung thoại khi dài quá 4 dòng; đổi phông (gamefont.css / System.json) sang phông Windows có dấu nếu bật.
Không làm game có mã hóa/chống chỉnh sửa (không vượt bảo vệ).
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import pickle
import re
import shutil
import threading
import time
import uuid
import zlib
from collections import Counter
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import config, fontcheck, langscan, translate, unitygame, unityload, unreal, xunity

router = APIRouter(prefix="/api/translate/games", dependencies=[Depends(translate._local_only)])
GAMES = config.DATA / "translate" / "games"
BACKUP_DIR = "CircleVault-ban-goc"
RENPY_PATCH = "zz_circlevault_vi.rpy"
RENPY_JSON = "circlevault_vi.json"
FONT_NAME = "circlevault-vi.ttf"
RENPY_FONT = "circlevault_vi_font.ttf"           # font người dùng chọn cho Ren'Py (thay DejaVuSans)
RENPY_FONT_B = "circlevault_vi_font_bold.ttf"
BATCH = 60
_lock = threading.Lock()


class GameError(RuntimeError):
    pass


# ================================================================== mã trong câu (giữ nguyên khi dịch)
CODES = {
    "renpy": re.compile(r"\{\{|\[\[|\{[^{}]*\}|\[[^\[\]]*\]|%\([^)]*\)[sdif]|%[sd]"),
    "rpg": re.compile(r"\\[A-Za-z]+\[[^\]]*\]|\\[A-Za-z]+<[^>]*>|\\[{}$.|!><^\\]|%\d"),
    # Unity: Smart String {0} {name} {value:N0}, thẻ rich text <color=#fff> </b> <sprite name=x>, %s
    "unity": re.compile(r"\{[^{}]*\}|<[^<>]+>|%[sd]"),
    # file chữ bất kỳ (JSON/CSV/XML/.ks…): {0} <b> %s %1$s [p] \n $var
    "generic": langscan.GENERIC_CODES,
}


def code_kind(engine: str) -> str:
    return engine if engine in ("renpy", "unity", "generic") else "rpg"


def kind_of(p: dict) -> str:
    return "generic" if p["engine"] == "files" or p.get("extra") else code_kind(p["engine"])


def protect(text: str, kind: str) -> tuple[str, list[str]]:
    codes: list[str] = []

    def sub(m):
        codes.append(m.group(0))
        return f"⟦{len(codes)}⟧"
    return CODES[kind].sub(sub, text), codes


def restore_codes(text: str, codes: list[str]) -> str | None:
    """Trả về None nếu bản dịch làm mất / thêm mã (khi đó giữ câu gốc để game không lỗi)."""
    found = re.findall(r"⟦(\d+)⟧", text)
    if sorted(int(x) for x in found) != list(range(1, len(codes) + 1)):
        return None
    return re.sub(r"⟦(\d+)⟧", lambda m: codes[int(m.group(1)) - 1], text)


# ================================================================== pickle an toàn (RPA, RPYC)
class _Stub:
    """Đối tượng giả cho lớp của Ren'Py: chỉ giữ dữ liệu, không chạy mã."""
    _cls = "?"

    def __init__(self, *a, **k):
        self._args = a

    def __setstate__(self, state):
        if isinstance(state, tuple) and len(state) == 2:
            d, slots = state
            if isinstance(d, dict):
                self.__dict__.update(d)
            if isinstance(slots, dict):
                self.__dict__.update(slots)
        elif isinstance(state, dict):
            self.__dict__.update(state)
        else:
            self._state = state

    def __repr__(self):
        return f"<{self._cls}>"


_stub_cache: dict[str, type] = {}


def _stub(module: str, name: str) -> type:
    key = module + "." + name
    if key not in _stub_cache:
        base: tuple = (_Stub,)
        if name == "PyExpr":                     # renpy.ast.PyExpr là str kèm tên file, số dòng
            cls = type(name, (str,), {"_cls": key, "__new__": lambda c, s="", *a, **k: str.__new__(c, s),
                                      "__setstate__": lambda self, st: None})
            _stub_cache[key] = cls
            return cls
        if "List" in name:
            base = (list,)
        elif "Dict" in name or name == "OrderedDict":
            base = (dict,)
        elif "Set" in name:
            base = (set,)
        cls = type(name, base, {"_cls": key})
        if base != (_Stub,):
            cls.__setstate__ = lambda self, st: self.__dict__.update(st) if isinstance(st, dict) else None
        _stub_cache[key] = cls
    return _stub_cache[key]


_SAFE_BUILTINS = {"set", "frozenset", "list", "dict", "tuple", "str", "bytes", "int", "float", "complex", "bool",
                  "object", "bytearray", "slice", "range"}


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module in ("builtins", "__builtin__") and name in _SAFE_BUILTINS:
            import builtins
            return getattr(builtins, name)
        if module == "collections" and name in ("OrderedDict", "defaultdict", "deque"):
            import collections
            return getattr(collections, name)
        if module.startswith(("renpy", "store", "_ast", "ast")) or module == "__main__":
            return _stub(module, name)
        if module in ("copy_reg", "copyreg") and name == "_reconstructor":
            return _reconstructor
        raise pickle.UnpicklingError(f"không cho phép {module}.{name}")


def _reconstructor(cls, base, state):
    if base is object or not isinstance(cls, type):
        return cls.__new__(cls) if isinstance(cls, type) else _Stub()
    obj = base.__new__(cls, state) if state is not None else base.__new__(cls)
    return obj


def safe_loads(data: bytes):
    return SafeUnpickler(io.BytesIO(data), encoding="utf-8", errors="surrogateescape").load()


# ================================================================== Ren'Py: đọc file
def _rpa_index(path: Path) -> dict[str, tuple[int, int, bytes]]:
    with open(path, "rb") as f:
        head = f.read(64).split(b"\n")[0].decode("latin-1")
        parts = head.split()
        if not parts or parts[0] not in ("RPA-3.0", "RPA-2.0", "RPA-3.2"):
            raise GameError(f"{path.name}: định dạng .rpa lạ ({parts[0] if parts else '?'})")
        offset = int(parts[1], 16)
        key = 0
        if parts[0] == "RPA-3.0":
            key = int(parts[2], 16)
        elif parts[0] == "RPA-3.2":
            key = int(parts[3], 16)
        f.seek(offset)
        index = safe_loads(zlib.decompress(f.read()))
    out = {}
    for name, entries in index.items():
        if isinstance(name, bytes):
            name = name.decode("utf-8", "replace")
        e = entries[0]
        off, length = e[0] ^ key, e[1] ^ key
        prefix = e[2] if len(e) > 2 else b""
        if isinstance(prefix, str):
            prefix = prefix.encode("latin-1")
        out[name] = (off, length, prefix)
    return out


def _rpa_read(path: Path, entry) -> bytes:
    off, length, prefix = entry
    with open(path, "rb") as f:
        f.seek(off)
        return prefix + f.read(length - len(prefix))


def renpy_sources(game: Path) -> list[tuple[str, str, bytes]]:
    """[(tên tương đối, 'rpy'|'rpyc', dữ liệu)] – file rời + trong .rpa; bỏ thư mục tl/ (bản dịch có sẵn)."""
    files: dict[str, tuple[str, bytes]] = {}

    def add(rel: str, data_fn):
        rel = rel.replace("\\", "/")
        low = rel.lower()
        if low.startswith(("tl/", "renpy/")) or "/tl/" in low or rel.endswith(RENPY_PATCH) or rel.endswith(RENPY_PATCH + "c"):
            return
        base, ext = os.path.splitext(rel)
        if ext not in (".rpy", ".rpyc"):
            return
        cur = files.get(base)
        if cur is None or (cur[0] == "rpy" and ext == ".rpyc"):   # ưu tiên .rpyc: đúng y như game đang chạy
            files[base] = (ext[1:], data_fn())

    for p in sorted(game.rglob("*.rpa")):
        try:
            idx = _rpa_index(p)
        except (GameError, OSError, zlib.error, pickle.UnpicklingError, ValueError, IndexError) as e:
            raise GameError(f"Không đọc được {p.name}: {e}")
        for name, entry in idx.items():
            if name.endswith((".rpy", ".rpyc")):
                add(name, lambda p=p, entry=entry: _rpa_read(p, entry))
    for p in sorted(game.rglob("*")):
        if p.suffix in (".rpy", ".rpyc") and p.is_file():
            add(str(p.relative_to(game)), p.read_bytes)
    return [(b + "." + k, k, d) for b, (k, d) in files.items()]


# ------------------------------------------------------------------ .rpy
def _dequote(m):
    c = m.group(1)
    if c == "{":
        return "{{"
    if c == "[":
        return "[["
    if c == "%":
        return "%%"
    if c == "n":
        return "\n"
    if c[0] == "u" and m.group(2):
        return chr(int(m.group(2), 16))
    return c


_ESC = re.compile(r"\\(u([0-9a-fA-F]{1,4})|.)", re.S)


def _lits(lit: str) -> list[str]:
    """Chuỗi trong .rpy → chuỗi Ren'Py thật sự dùng (giống renpy/lexer.py: string() và triple_string()).
    Chuỗi 3 dấu nháy ở câu thoại được tách thành nhiều câu theo dòng trống (chế độ monologue)."""
    raw = lit.startswith("r")
    if raw:
        lit = lit[1:]
    if lit[:3] in ('"""', "'''", "```"):
        body = lit[3:-3]
        if raw:
            return [body]
        body = re.sub(r" *\n *", "\n", body)
        out = []
        for part in body.split("\n\n"):
            part = part.strip()
            if part:
                out.append(_ESC.sub(_dequote, re.sub(r"[ \n]+", " ", part)))
        return out
    body = lit[1:-1]
    if raw:
        return [body]
    return [_ESC.sub(_dequote, re.sub(r"[ \n]+", " ", body))]


def _lit(lit: str) -> str:
    return " ".join(_lits(lit))


_STR = r'r?(?:"""(?:[^"\\]|\\.|"(?!""))*"""|\'\'\'(?:[^\'\\]|\\.|\'(?!\'\'))*\'\'\'|"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'|`(?:[^`\\\n]|\\.)*`)'
_STR_RE = re.compile(_STR, re.S)
_KEYWORDS = {"define", "default", "show", "scene", "hide", "play", "stop", "queue", "jump", "call", "return", "pause",
             "with", "window", "voice", "image", "if", "elif", "else", "while", "for", "python", "init", "label", "screen",
             "style", "transform", "translate", "old", "new", "nvl", "camera", "layeredimage", "menu", "pass", "renpy",
             "text", "textbutton", "add", "use", "key", "action", "font", "outlines", "imagebutton", "hotspot", "frame",
             "vbox", "hbox", "has", "at", "zorder", "modal", "tag", "on", "timer", "bar", "vbar", "viewport", "grid",
             "fixed", "side", "button", "input", "mousearea", "testcase", "rpy", "audio", "sound", "music", "help"}
_SAY = re.compile(r"^(?:(?P<who>" + _STR + r"|[A-Za-z_][\w.]*)(?:\s+(?:@\s*)?[\w-]+)*\s+)?(?P<what>" + _STR + r")"
                  r"(?:\s+(?:with\s+\S+|id\s+\S+|nointeract|\(.*\)))*\s*$", re.S)
_MENU_ITEM = re.compile(r"^(?P<what>" + _STR + r")\s*(?:\(.*\)\s*)?(?:if\s+.+)?:\s*$", re.S)


def _logical_lines(text: str):
    """(số dòng, thụt lề, nội dung) – nối các dòng khi chuỗi/ngoặc chưa đóng."""
    i, n, line_no = 0, len(text), 1
    buf, start, depth, indent_of = [], 1, 0, None
    while i < n:
        c = text[i]
        if c in "\"'`":
            m = _STR_RE.match(text, i)
            if m:
                buf.append(m.group(0))
                line_no += m.group(0).count("\n")
                i = m.end()
                continue
        if c == "#" and depth == 0:
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth = max(0, depth - 1)
        if c == "\n":
            line_no += 1
            if depth == 0:
                raw = "".join(buf)
                if raw.strip():
                    yield start, len(raw) - len(raw.lstrip(" \t")), raw.strip()
                buf, start = [], line_no
                i += 1
                continue
        buf.append(c)
        i += 1
    raw = "".join(buf)
    if raw.strip():
        yield start, len(raw) - len(raw.lstrip(" \t")), raw.strip()


def parse_rpy(text: str, fname: str, out: list[dict]):
    stack: list[tuple[int, str]] = []          # (thụt lề, loại khối)
    label = os.path.splitext(os.path.basename(fname))[0]
    for _ln, ind, line in _logical_lines(text.replace("\r\n", "\n").lstrip("\ufeff")):
        while stack and ind <= stack[-1][0]:
            stack.pop()
        block = stack[-1][1] if stack else ""
        in_py = any(b == "python" for _, b in stack)
        first = re.match(r"[\w$]+", line)
        word = first.group(0) if first else ""
        if line.endswith(":"):
            if word == "label":
                m = re.match(r"label\s+([\w.]+)", line)
                if m:
                    label = m.group(1)
                stack.append((ind, "label"))
            elif word == "menu":
                stack.append((ind, "menu"))
            elif word == "screen":
                stack.append((ind, "screen"))
            elif re.match(r"(init\s+(-?\d+\s+)?)?python\b", line) or line.startswith("python") or word == "translate":
                stack.append((ind, "python" if word != "translate" else "translate"))
            elif word in ("image", "transform", "show", "scene", "camera", "style", "layeredimage", "define", "default",
                          "init", "translate") and not re.match(r"init\s+(-?\d+\s+)?python", line):
                stack.append((ind, "skip"))
            elif block == "menu":
                m = _MENU_ITEM.match(line)
                if m:
                    out.append({"t": _lit(m.group("what")), "kind": "menu", "ctx": label})
                stack.append((ind, "choice"))
            else:
                stack.append((ind, block if block in ("screen", "python", "translate") else "block"))
            if word != "menu" and not (block == "menu"):
                pass
            continue
        if any(b in ("translate", "skip") for _, b in stack):
            _scan_code(line, label, out)
            continue
        _scan_code(line, label, out)                 # _("…") và Character("…") ở mọi nơi
        if in_py:
            continue
        if any(b == "screen" for _, b in stack) or word == "screen":
            m = re.match(r"(?:text|textbutton|label|tooltip)\s+(" + _STR + ")", line)
            if m:
                out.append({"t": _lit(m.group(1)), "kind": "ui", "ctx": "Giao diện"})
            continue
        if word in _KEYWORDS or line.startswith(("$", "@")):
            continue
        m = _SAY.match(line)
        if m:
            who = m.group("who") or ""
            if who[:1] in "\"'`":
                who = _lit(who)
                out.append({"t": who, "kind": "ui", "ctx": "Tên nhân vật"})
            for t in _lits(m.group("what")):
                out.append({"t": t, "kind": "say", "ctx": label, "who": who})


# ------------------------------------------------------------------ .rpyc
def _rpyc_root(data: bytes):
    if data.startswith(b"RENPY RPC2"):
        pos = 10
        chunks = {}
        while True:
            slot, start, length = (int.from_bytes(data[pos + k:pos + k + 4], "little") for k in (0, 4, 8))
            if slot == 0:
                break
            chunks[slot] = data[start:start + length]
            pos += 12
        raw = zlib.decompress(chunks[1])
    else:
        raw = zlib.decompress(data)            # bản rất cũ
    return safe_loads(raw)


def _scan_code(v: str, label: str, out: list[dict]):
    """Chuỗi mã python/screen trong .rpyc: lấy _("…") và Character("…")."""
    if "_(" in v:
        for m in re.finditer(r"\b__?\(\s*(" + _STR + r")\s*\)", v):
            out.append({"t": _lit(m.group(1)), "kind": "ui", "ctx": label})
    if "Character(" in v:
        for m in re.finditer(r"\bCharacter\(\s*(" + _STR + r")", v):
            out.append({"t": _lit(m.group(1)), "kind": "ui", "ctx": "Tên nhân vật"})


def _walk(node, label: str, out: list[dict], seen: set, names: dict | None = None):
    names = {} if names is None else names
    if isinstance(node, str):
        _scan_code(node, label, out)
        return
    if id(node) in seen:
        return
    seen.add(id(node))
    if isinstance(node, dict):
        for v in node.values():
            _walk(v, label, out, seen, names)
        return
    if isinstance(node, (list, tuple, set)):
        for x in node:
            _walk(x, label, out, seen, names)
        return
    if not isinstance(node, _Stub):
        return
    cls = node._cls
    d = node.__dict__
    if cls.endswith(".Define") and isinstance(d.get("varname"), str) and isinstance(d.get("code"), _Stub):
        st = getattr(d["code"], "_state", None)
        src = st[1] if isinstance(st, tuple) and len(st) > 1 and isinstance(st[1], str) else d["code"].__dict__.get("source")
        if isinstance(src, str):
            m = re.match(r"\s*Character\(\s*(?:_\(\s*)?(" + _STR + ")", src)
            if m:
                names[d["varname"]] = _lit(m.group(1))
    if cls.endswith(".Label") and isinstance(d.get("name"), str):
        label = d["name"]
    if cls.endswith((".Translate", ".TranslateBlock", ".TranslateString", ".TranslateEarlyBlock", ".TranslatePython")):
        return                                  # bản dịch có sẵn của game
    if cls.endswith((".Say", ".TranslateSay")) and isinstance(d.get("what"), str):
        who = d.get("who") if isinstance(d.get("who"), str) else ""
        out.append({"t": str(d["what"]), "kind": "say", "ctx": label, "who": str(who or "")})
    if cls.endswith(".Menu") and isinstance(d.get("items"), list):
        for it in d["items"]:
            if isinstance(it, (list, tuple)) and it and isinstance(it[0], str) and len(it) > 2 and it[2] is not None:
                out.append({"t": str(it[0]), "kind": "menu", "ctx": label})
            if isinstance(it, (list, tuple)) and len(it) > 2:
                _walk(it[2], label, out, seen, names)
    if cls.endswith("SLDisplayable") and d.get("name") in ("text", "textbutton", "label") and d.get("positional"):
        first = str(d["positional"][0]).strip()
        if _STR_RE.fullmatch(first):
            out.append({"t": _lit(first), "kind": "ui", "ctx": "Giao diện"})
    for k, v in d.items():
        if k in ("what", "items", "name", "location", "filename"):
            continue
        _walk(v, label, out, seen, names)


def parse_rpyc(data: bytes, fname: str, out: list[dict], names: dict | None = None):
    root = _rpyc_root(data)
    stmts = root[1] if isinstance(root, tuple) and len(root) == 2 else root
    _walk(stmts, os.path.splitext(os.path.basename(fname))[0], out, set(), names if names is not None else {})


_CHAR_DEF = re.compile(r"(?:define\s+)?([A-Za-z_]\w*)\s*=\s*Character\(\s*(?:_\(\s*)?(" + _STR + ")")


def scan_renpy(game: Path) -> tuple[list[dict], dict]:
    out: list[dict] = []
    names: dict[str, str] = {}
    fonts: set[str] = set()
    errors = []
    srcs = renpy_sources(game)
    if not srcs:
        raise GameError("Không thấy kịch bản Ren'Py (.rpy/.rpyc/.rpa) trong thư mục game.")
    for name, kind, data in srcs:
        try:
            if kind == "rpy":
                text = data.decode("utf-8", "replace")
                parse_rpy(text, name, out)
                for m in _CHAR_DEF.finditer(text):
                    names[m.group(1)] = _lit(m.group(2))
            else:
                parse_rpyc(data, name, out, names)
                text = data.decode("latin-1")
            fonts.update(f for f in re.findall(r"[\"']([^\"'\n]{1,120}\.(?:ttf|otf|ttc))[\"']", text, re.I) if "DejaVu" not in f)
        except Exception as e:
            errors.append(f"{name}: {e}")
    for p in game.rglob("*"):
        if p.suffix.lower() in (".ttf", ".otf", ".ttc") and "DejaVu" not in p.name:
            fonts.add(str(p.relative_to(game)).replace("\\", "/"))
    if not out and errors:
        raise GameError("Không đọc được kịch bản: " + "; ".join(errors[:3]))
    for it in out:
        if it.get("who") in names:
            it["who"] = names[it["who"]]
    return out, {"fonts": sorted(fonts), "errors": errors[:20]}


def apply_renpy(game: Path, items: list[dict], opts: dict) -> dict:
    say, ui = {}, {}
    for it in items:
        vi = it.get("final")
        if not vi or vi == it["t"]:
            continue
        (say if it["kind"] in ("say", "menu") else ui)[it["t"]] = vi
    data = {"say": say, "ui": ui, "fonts": opts.get("fonts", []) if opts.get("font", True) else []}
    if data["fonts"] and opts.get("font_pick"):
        try:
            (game / RENPY_FONT).write_bytes(fontcheck.font_source(opts["font_pick"], 400))
            (game / RENPY_FONT_B).write_bytes(fontcheck.font_source(opts["font_pick"], 700))
            data["font_file"], data["font_file_bold"] = RENPY_FONT, RENPY_FONT_B
        except fontcheck.FontError:
            pass                                   # không lấy được font đã chọn: dùng DejaVuSans như cũ
    (game / RENPY_JSON).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (game / RENPY_PATCH).write_text(RENPY_SCRIPT, encoding="utf-8")
    old = game / (RENPY_PATCH + "c")
    if old.exists():
        old.unlink()                               # file biên dịch cũ của chính CircleVault
    return {"say": len(say), "ui": len(ui)}


RENPY_SCRIPT = '''# Viet hoa boi CircleVault. Xoa file nay va circlevault_vi.json (hoac bam "Khoi phuc ban goc" trong app) de ve ban goc.
init 999 python:
    import json as _cv_json
    _cv_data = _cv_json.loads(renpy.file("circlevault_vi.json").read().decode("utf-8"))
    _cv_say = _cv_data.get("say", {})
    _cv_ui = _cv_data.get("ui", {})
    _cv_prev_filter = config.say_menu_text_filter

    def _cv_filter(s):
        if _cv_prev_filter is not None:
            s = _cv_prev_filter(s)
        return _cv_say.get(s, s)

    config.say_menu_text_filter = _cv_filter

    if hasattr(config, "replace_text"):
        _cv_prev_replace = config.replace_text

        def _cv_replace(s):
            if _cv_prev_replace is not None:
                s = _cv_prev_replace(s)
            return _cv_ui.get(s, s)

        config.replace_text = _cv_replace

    _cv_fr = _cv_data.get("font_file") or "DejaVuSans.ttf"
    _cv_frb = _cv_data.get("font_file_bold") or "DejaVuSans-Bold.ttf"
    for _cv_f in _cv_data.get("fonts", []):
        for _cv_b in (False, True):
            for _cv_i in (False, True):
                config.font_replacement_map[(_cv_f, _cv_b, _cv_i)] = (_cv_frb if _cv_b else _cv_fr, False, _cv_i)
'''


def restore_renpy(game: Path):
    for n in (RENPY_PATCH, RENPY_PATCH + "c", RENPY_JSON, RENPY_FONT, RENPY_FONT_B):
        p = game / n
        if p.exists():
            p.unlink()


# ================================================================== RPG Maker MV/MZ
DB_FIELDS = {
    "Actors.json": ["name", "nickname", "profile"], "Classes.json": ["name"],
    "Skills.json": ["name", "description", "message1", "message2"], "Items.json": ["name", "description"],
    "Weapons.json": ["name", "description"], "Armors.json": ["name", "description"], "Enemies.json": ["name"],
    "States.json": ["name", "message1", "message2", "message3", "message4"],
}


def rpg_dirs(root: Path) -> tuple[str, Path, Path] | None:
    """(engine, thư mục gốc web, thư mục data)."""
    for web in (root / "www", root):
        data = web / "data"
        if (data / "System.json").exists():
            if (web / "js" / "rmmz_core.js").exists():
                return "rpgmz", web, data
            return "rpgmv", web, data
    return None


def _cmd_lists(fname: str, obj):
    """(nhãn, danh sách lệnh) trong Map/CommonEvents/Troops."""
    if fname.startswith("Map") and isinstance(obj, dict):
        for ev in obj.get("events") or []:
            if ev:
                for pi, page in enumerate(ev.get("pages") or []):
                    yield f"{fname} · {ev.get('name') or 'Sự kiện'} {ev.get('id')}", page.get("list") or []
    elif fname == "CommonEvents.json":
        for ev in obj or []:
            if ev:
                yield f"Sự kiện chung · {ev.get('name')}", ev.get("list") or []
    elif fname == "Troops.json":
        for tr in obj or []:
            if tr:
                for page in tr.get("pages") or []:
                    yield f"Trận · {tr.get('name')}", page.get("list") or []


def _messages(lst: list):
    """Gom lệnh: ('msg'|'scroll', i_header, [i dòng], người nói) / ('choice', i) / ('text1', i, chỉ số tham số)."""
    i, n = 0, len(lst)
    while i < n:
        c = lst[i]
        code = c.get("code")
        if code in (101, 105):
            j = i + 1
            lines = []
            want = 401 if code == 101 else 405
            while j < n and lst[j].get("code") == want:
                lines.append(j)
                j += 1
            who = ""
            if code == 101 and len(c.get("parameters") or []) > 4 and isinstance(c["parameters"][4], str):
                who = c["parameters"][4]
            yield ("msg" if code == 101 else "scroll", i, lines, who)
            i = j
            continue
        if code == 102:
            yield ("choices", i, None, "")
        elif code == 402:
            yield ("when", i, None, "")
        elif code in (320, 324, 325):
            yield ("text1", i, None, "")
        i += 1


def _rpg_files(data: Path):
    names = sorted(p.name for p in data.glob("*.json"))
    for n in names:
        if n in DB_FIELDS or n in ("System.json", "CommonEvents.json", "Troops.json") or re.fullmatch(r"Map\d+\.json", n):
            yield n


def _load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except ValueError:
        raise GameError(f"{p.name} không phải JSON thường (game có thể đã mã hóa dữ liệu) – không Việt hóa được.")


def scan_rpg(root: Path) -> tuple[list[dict], dict]:
    found = rpg_dirs(root)
    if not found:
        raise GameError("Không thấy data/System.json.")
    engine, web, data = found
    out: list[dict] = []

    def add(t, kind, ctx, who=""):
        if isinstance(t, str) and t.strip():
            out.append({"t": t, "kind": kind, "ctx": ctx, "who": who})

    for fn in _rpg_files(data):
        obj = _load_json(data / fn)
        if fn in DB_FIELDS:
            for row in obj or []:
                if row:
                    for f in DB_FIELDS[fn]:
                        add(row.get(f), "db", f"{fn[:-5]} · {f}")
        elif fn == "System.json":
            add(obj.get("gameTitle"), "db", "Tên game")
            add(obj.get("currencyUnit"), "db", "Đơn vị tiền")
            for k in ("elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes"):
                for t in obj.get(k) or []:
                    add(t, "db", f"Hệ thống · {k}")
            terms = obj.get("terms") or {}
            for k in ("basic", "commands", "params"):
                for t in terms.get(k) or []:
                    add(t, "db", f"Thuật ngữ · {k}")
            for k, t in (terms.get("messages") or {}).items():
                add(t, "db", f"Thông báo · {k}")
        else:
            if fn.startswith("Map"):
                add(obj.get("displayName"), "db", f"{fn} · tên bản đồ")
            for ctx, lst in _cmd_lists(fn, obj):
                for kind, i, lines, who in _messages(lst):
                    if kind in ("msg", "scroll"):
                        if who:
                            add(who, "name", "Tên người nói")
                        add("\n".join(lst[j]["parameters"][0] for j in lines if lst[j].get("parameters")), "msg", ctx, who)
                    elif kind == "choices":
                        for t in (lst[i].get("parameters") or [[]])[0] or []:
                            add(t, "menu", ctx)
                    elif kind == "text1":
                        p = lst[i].get("parameters") or []
                        if len(p) > 1:
                            add(p[1], "db", ctx)
    return out, {"engine": engine, "web": str(web.relative_to(root)) if web != root else ""}


def _width(s: str) -> int:
    return len(CODES["rpg"].sub(lambda m: "" if not m.group(0).startswith(("\\N[", "\\P[", "\\V[")) else "xxxxxx", s))


def wrap_rpg(text: str, width: int) -> list[str]:
    lines = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split(" "):
            t = (cur + " " + word) if cur else word
            if _width(t) <= width or not cur:
                cur = t
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def _backup(root: Path, p: Path):
    rel = p.relative_to(root)
    b = root / BACKUP_DIR / rel
    if not b.exists():
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, b)


def _win_font() -> Path | None:
    for d in (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts", Path("/usr/share/fonts/truetype/dejavu")):
        for f in ("arial.ttf", "segoeui.ttf", "tahoma.ttf", "DejaVuSans.ttf"):
            if (d / f).exists():
                return d / f
    return None


def apply_rpg(root: Path, items: list[dict], opts: dict) -> dict:
    engine, web, data = rpg_dirs(root)
    tr = {it["t"]: it["final"] for it in items if it.get("final") and it["final"] != it["t"]}
    width = int(opts.get("width") or 50)
    width_face = int(opts.get("width_face") or 40)
    changed = 0

    def t(s):
        return tr.get(s, s) if isinstance(s, str) else s

    for fn in _rpg_files(data):
        p = data / fn
        # luôn đọc từ bản gốc (đã sao lưu) để áp dụng lại nhiều lần không bị dịch chồng
        src = root / BACKUP_DIR / p.relative_to(root)
        obj = _load_json(src if src.exists() else p)
        orig = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        if fn in DB_FIELDS:
            for row in obj or []:
                if row:
                    for f in DB_FIELDS[fn]:
                        if f in row:
                            row[f] = t(row[f])
        elif fn == "System.json":
            for k in ("gameTitle", "currencyUnit"):
                if k in obj:
                    obj[k] = t(obj[k])
            for k in ("elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes"):
                if isinstance(obj.get(k), list):
                    obj[k] = [t(x) for x in obj[k]]
            terms = obj.get("terms") or {}
            for k in ("basic", "commands", "params"):
                if isinstance(terms.get(k), list):
                    terms[k] = [t(x) for x in terms[k]]
            if isinstance(terms.get("messages"), dict):
                terms["messages"] = {k: t(v) for k, v in terms["messages"].items()}
            if engine == "rpgmz" and opts.get("font", True) and (_win_font() or opts.get("font_pick")):
                adv = obj.setdefault("advanced", {})
                adv["mainFontFilename"] = FONT_NAME
        else:
            if fn.startswith("Map") and "displayName" in obj:
                obj["displayName"] = t(obj["displayName"])
            for _ctx, lst in _cmd_lists(fn, obj):
                _apply_list(lst, t, width, width_face)
        new = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        if new != orig or src.exists():
            if not src.exists():
                _backup(root, p)
            p.write_text(new, encoding="utf-8")
            changed += 1
    if opts.get("font", True):
        f = _win_font()
        picked = None
        if opts.get("font_pick"):
            try:
                picked = fontcheck.font_source(opts["font_pick"], 400)
            except fontcheck.FontError:
                picked = None
        if f or picked:
            fonts = web / "fonts"
            fonts.mkdir(exist_ok=True)
            if picked:
                (fonts / FONT_NAME).write_bytes(picked)
            else:
                shutil.copy2(f, fonts / FONT_NAME)
            css = fonts / "gamefont.css"
            if engine == "rpgmv" and css.exists():
                _backup(root, css)
                orig_css = (root / BACKUP_DIR / css.relative_to(root)).read_text(encoding="utf-8")
                css.write_text(re.sub(r'url\(["\']?[^)"\']+["\']?\)', f'url("{FONT_NAME}")', orig_css, count=1), encoding="utf-8")
    return {"files": changed, "texts": len(tr)}


def _apply_list(lst: list, t, width: int, width_face: int):
    new: list = []
    i, n = 0, len(lst)
    while i < n:
        c = lst[i]
        code = c.get("code")
        if code in (101, 105):
            want = 401 if code == 101 else 405
            j = i + 1
            while j < n and lst[j].get("code") == want:
                j += 1
            body = lst[i + 1:j]
            text = "\n".join(x["parameters"][0] for x in body if x.get("parameters"))
            vi = t(text)
            head = copy.deepcopy(c)
            if code == 101 and len(head.get("parameters") or []) > 4 and isinstance(head["parameters"][4], str):
                head["parameters"][4] = t(head["parameters"][4])
            if vi == text or not body:
                new.append(head)
                new.extend(body)
            else:
                face = code == 101 and bool((c.get("parameters") or [""])[0])
                lines = wrap_rpg(re.sub(r"\s*\n\s*", " ", vi), width_face if face else width) if code == 101 else vi.split("\n")
                indent = body[0].get("indent", c.get("indent", 0))
                per = 4 if code == 101 else len(lines)
                for k in range(0, len(lines), per):
                    new.append(head if k == 0 else copy.deepcopy(head))
                    new.extend({"code": want, "indent": indent, "parameters": [ln]} for ln in lines[k:k + per])
            i = j
            continue
        c = copy.deepcopy(c)
        p = c.get("parameters") or []
        if code == 102 and p and isinstance(p[0], list):
            p[0] = [t(x) for x in p[0]]
        elif code == 402 and len(p) > 1:
            p[1] = t(p[1])
        elif code in (320, 324, 325) and len(p) > 1:
            p[1] = t(p[1])
        new.append(c)
        i += 1
    lst[:] = new


def restore_rpg(root: Path) -> int:
    b = root / BACKUP_DIR
    n = 0
    if b.exists():
        for f in b.rglob("*"):
            if f.is_file():
                dst = root / f.relative_to(b)
                shutil.copy2(f, dst)
                n += 1
    found = rpg_dirs(root)
    if found:
        extra = found[1] / "fonts" / FONT_NAME
        if extra.exists():
            extra.unlink()
    return n


# ================================================================== dự án
def detect(path: Path) -> tuple[str, Path]:
    """(engine, thư mục gốc dùng để áp dụng)."""
    if not path.is_dir():
        raise GameError("Không thấy thư mục này.")
    if rpg_dirs(path):
        return rpg_dirs(path)[0], path
    for cand in (path / "game", path):
        if cand.is_dir() and (any(cand.glob("*.rpy*")) or any(cand.glob("*.rpa")) or any(cand.glob("**/*.rpyc"))):
            if cand.name == "game" or (cand / "script.rpyc").exists() or any(cand.glob("*.rpa")) or any(cand.glob("*.rpy")):
                return "renpy", cand
    uroot = unitygame.unity_root(path)
    if uroot:
        if unitygame.string_bundles(uroot):
            return "unity", uroot
        raise GameError("Game Unity này không lưu chữ bằng Unity Localization nên app chưa Việt hóa từ file được. "
                        "Có gói Việt hóa của nhóm dịch thì dùng mục 'Cài gói Việt hóa có sẵn' bên dưới; không thì dùng Dịch màn hình game.")
    if any(path.glob("**/*.pak")):
        raise GameError("Đây có vẻ là game Unreal – app chưa hỗ trợ. Dùng 'Dịch game' (dịch màn hình).")
    raise GameError("Không nhận ra game. App hỗ trợ Ren'Py (có thư mục game/ với .rpy/.rpyc/.rpa) "
                    "và RPG Maker MV/MZ (có data/System.json hoặc www/data/System.json).")


ENGINE_NAMES = {"renpy": "Ren'Py", "rpgmv": "RPG Maker MV", "rpgmz": "RPG Maker MZ", "unity": "Unity", "files": "File chữ",
                "xunity": "Unity · dịch khi chơi", "unreal": "Unreal Engine"}


def _proj_dir(pid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", pid or "") or not (GAMES / pid / "project.json").exists():
        raise HTTPException(404, "Không có dự án này.")
    return GAMES / pid


def _load(pid: str) -> dict:
    return config.read_json(_proj_dir(pid) / "project.json")


def _save(p: dict):
    d = GAMES / p["id"]
    d.mkdir(parents=True, exist_ok=True)
    config.write_file(d / "project.json", json.dumps(p, ensure_ascii=False))


def _summary(p: dict) -> dict:
    allitems = p["items"]
    items = [it for it in allitems if not it.get("skip")]
    done = sum(1 for it in items if it.get("vi") is not None)
    return {"id": p["id"], "name": p["name"], "path": p["path"], "engine": p["engine"],
            "engine_name": ENGINE_NAMES.get(p["engine"], p["engine"]), "total": len(items), "done": done,
            "bad": sum(1 for it in items if it.get("bad")), "edited": sum(1 for it in items if it.get("edited")),
            "chars": sum(len(it["t"]) for it in items), "status": p.get("status", "idle"), "error": p.get("error"), "note": p.get("note"),
            "applied": p.get("applied"), "opts": p.get("opts", {}), "created": p["created"],
            "running": WORKER.current == p["id"], "warnings": p.get("warnings", []), "brief": p.get("brief", ""),
            "glossary": p.get("glossary", ""), "lang": p.get("lang") or "en", "skipped": len(allitems) - len(items),
            "review": p.get("review"),
            "sources": [{"label": x.get("label") or x.get("rel"), "count": x.get("count", 0)} for x in p.get("extra") or []],
            "xunity": ({**(p.get("xunity") or {}), "installed": bool((xunity.detect(Path(p["root"])) or {}).get("xunity"))}
                       if p["engine"] == "xunity" else None), "seen_at": p.get("seen_at")}


def estimate(chars: int, n: int = 0, ctx_chars: int = 0) -> dict:
    """Ước tính chi phí Claude (USD), đã đối chiếu với hóa đơn thật: mỗi lô 60 câu gửi kèm hướng dẫn + bối cảnh + thuật ngữ;
    câu tiếng Việt nhiều token (dấu) + vỏ JSON; phần "suy nghĩ" của Claude tính như chữ trả về."""
    n = n or max(1, chars // 48)
    batches = max(1, -(-n // BATCH))
    tin = chars / 3.5 + n * 15 + batches * (1300 + ctx_chars / 3)
    tout = (chars * 0.6 + n * 10) * 1.5
    price = {"claude-opus-5-5": (4, 20), "claude-sonnet-5-5": (2, 10), "claude-haiku-5-5": (0.1, 0.5)}
    return {m: round(tin / 1e6 * a + tout / 1e6 * b, 2) for m, (a, b) in price.items()}


def _est(p: dict, left: bool = False) -> dict:
    todo = [it for it in p["items"] if not it.get("skip") and (not left or it.get("vi") is None)]
    if not todo:
        return {m: 0 for m in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5")}
    return estimate(sum(len(it["t"]) for it in todo), len(todo), len(p.get("brief") or "") + len(p.get("glossary") or ""))


def _specials(root: Path, job: dict) -> list[dict]:
    """Nguồn chữ của engine đã có bộ đọc riêng (kịch bản Ren'Py, data RPG Maker, bảng chữ Unity Localization)."""
    out: list[dict] = []

    def add(sid, kind, label, engine, eroot, raw, info, covers):
        texts = [it["t"] for it in raw if it["t"].strip()]
        if not texts:
            return
        out.append({"id": sid, "kind": kind, "engine": engine, "label": label, "rel": str(eroot.relative_to(root)) if eroot != root else "",
                    "count": len(texts), "lang": langscan.lang_of_texts(texts), "loc": True, "sample": [t[:120] for t in texts[:3]],
                    "_items": raw, "_info": info, "_covers": covers})
    try:
        if rpg_dirs(root):
            job["text"] = "Đang đọc dữ liệu RPG Maker…"
            raw, info = scan_rpg(root)
            eng, _web, data = rpg_dirs(root)
            add("rpg", "rpg", f"Dữ liệu {ENGINE_NAMES[eng]} ({data.relative_to(root)})", eng, root, raw, info,
                [str(data.relative_to(root)).replace("\\", "/") + "/"])
            return out
    except GameError as e:
        job.setdefault("_warn", []).append(str(e))
    for cand in (root / "game", root):
        if cand.is_dir() and (any(cand.glob("*.rpy")) or any(cand.glob("*.rpa")) or (cand / "script.rpyc").exists()
                              or (cand.name == "game" and any(cand.glob("**/*.rpyc")))):
            job["text"] = "Đang đọc kịch bản Ren'Py…"
            try:
                raw, info = scan_renpy(cand)
                add("renpy", "renpy", f"Kịch bản Ren'Py ({cand.relative_to(root) if cand != root else '.'})", "renpy", cand, raw, info,
                    [str(cand.relative_to(root)).replace("\\", "/") + "/"] if cand != root else [])
            except GameError as e:
                job.setdefault("_warn", []).append(str(e))
            return out
    if unreal.game_dirs(root):
        job["text"] = "Đang mở file .pak của Unreal Engine…"
        try:
            key = unreal.parse_key(job.get("_aes"))
            found, warns = unreal.find_locres(root, key)
        except unreal.UEError as e:
            found, warns = [], [str(e)]
        for w in warns:
            if "AES" in w:
                job["need_key"] = True
        culture = unreal.pick_culture(found, _prefer())
        srcs = [f for f in found if f["culture"] == culture]
        by_path: dict[str, dict] = {}
        for f in srcs:                      # cùng một file trong nhiều pak: pak vá (_P, số lớn) được game ưu tiên
            k = f.get("full") or f.get("rel")
            prev = by_path.get(k)
            if not prev or (f.get("pak", "").endswith("_P.pak"), f.get("pak", "")) > (prev.get("pak", "").endswith("_P.pak"), prev.get("pak", "")):
                by_path[k] = f
        raw: list[dict] = []
        for f in by_path.values():
            try:
                for t, ctx in unreal.texts_of(unreal.read_locres(root, f, key)):
                    raw.append({"t": t, "kind": "say" if len(t) > 40 or " " in t.strip() and len(t.split()) > 6 else "ui", "ctx": ctx[:80]})
            except (unreal.UEError, OSError, ValueError, KeyError) as e:
                warns.append(f"{f.get('full') or f.get('rel')}: {e}")
        if warns:
            job.setdefault("_warn", []).extend(warns[:6])
        if raw:
            add("unreal", "locres", f"Bảng chữ Unreal Engine ({culture}, {len(by_path)} file .locres)", "unreal", root, raw,
                {"unreal": {"sources": list(by_path.values()), "culture": culture, "aes": job.get("_aes")}}, [])
            return out
    uroot = unitygame.unity_root(root)
    if uroot == root and unitygame.string_bundles(root):
        job["text"] = "Đang đọc bảng chữ Unity Localization…"
        try:
            raw, info = unitygame.scan(root)
            u = info["unity"]
            add("unity", "unity-loc", f"Bảng chữ Unity Localization ({u.get('locale') or '?'})", "unity", root, raw, info,
                [b.replace("\\", "/") for b in u["bundles"]] + ([u["catalog"].replace("\\", "/")] if u.get("catalog") else []))
        except unitygame.GameError as e:
            job.setdefault("_warn", []).append(str(e))
    return out


class ScanStart(BaseModel):
    path: str
    aes: str | None = None


@router.post("/scan")
def scan_start(body: ScanStart):
    path = Path(body.path.strip().strip('"'))
    if not path.exists():
        raise HTTPException(400, "Không thấy thư mục này.")
    if body.aes:
        try:
            unreal.parse_key(body.aes)
        except unreal.UEError as e:
            raise HTTPException(400, str(e))
    return {"job": langscan.new_job(str(path), _prefer(), _specials, aes=(body.aes or "").strip() or None)}


@router.get("/scan/{jid}")
def scan_state(jid: str):
    j = langscan.get_job(jid)
    if not j:
        raise HTTPException(404, "Lượt tìm đã hết hạn, bấm Tìm lại.")
    out = langscan.public_job(j)
    if j.get("_warn") and out.get("result"):
        out["result"] = {**out["result"], "hints": j["_warn"] + out["result"]["hints"]}
    return out


@router.post("/scan/{jid}/cancel")
def scan_cancel(jid: str):
    langscan.cancel(jid)
    return {"ok": True}


def _prefer() -> str:
    src = translate.settings().get("source") or "en"
    return {"zh-CN": "zh", "auto": "en"}.get(src, src)


class ScanIn(BaseModel):
    path: str
    job: str | None = None
    pick: list[str] | None = None


TR_LANG = {"en": "en", "ja": "ja", "ko": "ko", "zh": "zh-CN"}


@router.post("")
def create(body: ScanIn):
    path = Path(body.path.strip().strip('"'))
    job = langscan.get_job(body.job) if body.job else None
    if not job or job.get("state") != "done":
        job = {"_items": {}, "found": 0, "strings": 0, "done": 0, "total": 0}
        try:
            job["result"] = langscan.scan_folder(path, job, _prefer(), _specials)
        except ValueError as e:
            raise HTTPException(400, str(e))
    res = job["result"]
    picked = set(body.pick) if body.pick is not None else {s["id"] for s in res["sources"] if s.get("on")}
    chosen = [s for s in res["sources"] if s["id"] in picked]
    if not chosen:
        hints = (job.get("_warn") or []) + res.get("hints", [])
        raise HTTPException(400, (hints[0] if hints else "Không tìm thấy file chữ nào trong thư mục này.")
                            + " Có gói Việt hóa của nhóm dịch thì dùng 'Cài gói Việt hóa có sẵn'; không thì dùng Dịch màn hình game.")
    groot = Path(res["root"])
    special = next((s for s in chosen if s["kind"] in ("renpy", "rpg", "unity-loc", "locres")), None)
    extra = [{k: v for k, v in s.items() if k not in ("sample",)} for s in chosen if s["kind"] in ("file", "textasset", "mono")]
    info = (job.get("_infos") or {}).get(special["id"], {}) if special else {}
    seen: set[str] = set()
    items = []
    letters = re.compile(r"[A-Za-z぀-ヿ㐀-鿿가-힯]")
    for s in ([special] if special else []) + [x for x in chosen if x is not special]:
        engine = special["engine"] if special else "files"
        for it in job["_items"].get(s["id"], []):
            t = it["t"]
            if not t.strip() or not letters.search(t):
                continue
            key = ("u:" if it["kind"] in ("ui", "db", "name") and engine == "renpy" else "") + t
            if key in seen:
                continue
            seen.add(key)
            row = {"t": t, "kind": it["kind"], "ctx": it.get("ctx", ""), "who": it.get("who", ""), "vi": None}
            why = langscan.suspect(t, it.get("ctx", "")) if engine in ("files", "unity", "unreal") or s["kind"] in ("file", "textasset", "mono") else None
            if why:
                row.update(skip=True, skip_by="auto", why=why)
            items.append(row)
    if not items:
        raise HTTPException(400, "Không tìm thấy câu chữ nào để dịch trong các file đã chọn.")
    langs = Counter()
    for s in chosen:
        langs[s.get("lang")] += s["count"]
    lang = langs.most_common(1)[0][0] or "en"
    pid = uuid.uuid4().hex[:12]
    eroot = groot / special["rel"] if special and special.get("rel") else groot
    p = {"id": pid, "name": res.get("name") or groot.name or "Game", "path": str(groot), "root": str(eroot),
         "engine": special["engine"] if special else "files", "created": time.time(), "items": items, "status": "idle",
         "opts": {"font": bool(special) and special["engine"] != "unity", "width": 50, "width_face": 40, "fonts": info.get("fonts", [])},
         "warnings": info.get("errors", []), "extra": extra, "lang": lang, "groot": str(groot)}
    if special and special["engine"] == "unity":
        p["unity"] = info["unity"]
    if special and special["engine"] == "unreal":
        p["unreal"] = info["unreal"]
    _save(p)
    return {**_summary(p), "estimate": _est(p)}


@router.get("")
def list_projects():
    out = []
    if GAMES.exists():
        for d in GAMES.iterdir():
            try:
                out.append(_summary(config.read_json(d / "project.json")))
            except (OSError, ValueError, KeyError):
                continue
    out.sort(key=lambda x: -x["created"])
    return {"games": out}


@router.get("/{pid}")
def get_project(pid: str, offset: int = 0, limit: int = 100, q: str = "", filter: str = "all"):
    p = _load(pid)
    rows = []
    ql = q.lower().strip()
    for i, it in enumerate(p["items"]):
        if filter == "skip" and not it.get("skip"):
            continue
        if filter != "skip" and filter != "all" and it.get("skip"):
            continue
        if filter == "todo" and it.get("vi") is not None:
            continue
        if filter == "bad" and not it.get("bad"):
            continue
        if filter == "edited" and not it.get("edited"):
            continue
        if ql and ql not in it["t"].lower() and ql not in (it.get("vi") or "").lower():
            continue
        rows.append({"i": i, **it})
    s = _summary(p)
    return {**s, "estimate": _est(p), "estimate_left": _est(p, True), "spent": translate.usage(f"game:{pid}"), "matched": len(rows), "rows": rows[offset:offset + max(1, min(limit, 500))]}


class EditIn(BaseModel):
    i: int
    vi: str


@router.put("/{pid}/items")
def edit_items(pid: str, body: list[EditIn]):
    with _lock:
        p = _load(pid)
        for e in body:
            if 0 <= e.i < len(p["items"]):
                it = p["items"][e.i]
                it["vi"] = e.vi[:5000]
                it["edited"] = True
                it.pop("bad", None)
        _save(p)
    return {"ok": True}


class SkipIn(BaseModel):
    i: int
    skip: bool


@router.put("/{pid}/skip")
def set_skip(pid: str, body: list[SkipIn]):
    """Người dùng chọn câu không cần dịch (mã, tên file…) hoặc đưa câu đã bỏ qua trở lại danh sách dịch."""
    with _lock:
        p = _load(pid)
        for e in body:
            if 0 <= e.i < len(p["items"]):
                it = p["items"][e.i]
                if e.skip:
                    it.update(skip=True, skip_by="user", why="Bạn chọn không dịch")
                else:
                    it.pop("skip", None)
                    it.pop("why", None)
                    it["skip_by"] = "user"          # nhớ quyết định của người dùng, lần lọc sau không đổi
        _save(p)
    return _summary(p)


REVIEW_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["skip"],
                 "properties": {"skip": {"type": "array", "items": {
                     "type": "object", "additionalProperties": False, "required": ["i", "why"],
                     "properties": {"i": {"type": "integer"}, "why": {"type": "string"}}}}}}
REVIEW_SYSTEM = """Bạn kiểm tra danh sách chuỗi mà công cụ Việt hóa lấy ra từ file dữ liệu của một game. Có chuỗi là chữ người chơi
đọc trên màn hình, có chuỗi là dữ liệu nội bộ lẫn vào. Dịch nhầm dữ liệu nội bộ sẽ làm game lỗi.
Liệt kê trong "skip" các chuỗi KHÔNG phải chữ hiển thị cho người chơi, ví dụ: mã/ID/khóa nội bộ, tên biến, tên hàm, lệnh/mã nguồn,
tên file/đường dẫn, tên animation/âm thanh/prefab/scene, tên lớp, chuỗi định dạng ngày giờ/số, chữ debug/test/placeholder
("TODO", "test", "Lorem ipsum"), ghi chú cho lập trình viên, tên công cụ/thư viện.
KHÔNG đưa vào "skip": câu thoại, tên nhân vật/vật phẩm/kỹ năng/địa danh, nút và mục menu, mô tả, hướng dẫn, thông báo – kể cả chữ
rất ngắn như "Start", "HP", "Yes". Phân vân thì KHÔNG đưa vào (giữ lại để dịch).
Mỗi dòng đầu vào: số thứ tự, [ngữ cảnh = tên trường/khóa/file], chuỗi. "why" ghi lý do ngắn bằng tiếng Việt (vd "mã nội bộ", "tên file")."""
REVIEW_MODEL = "claude-haiku-5-5"      # việc phân loại dễ: luôn dùng Haiku cho rẻ
REVIEWING: set[str] = set()             # dự án đang được Claude lọc (thanh Tiến trình đọc)


@router.post("/{pid}/review")
def review(pid: str):
    """Đánh dấu câu không phải chữ hiển thị: luật của app (ngay) + nhờ Claude Haiku (chạy nền, tiến độ ở p["review"])."""
    s = translate.settings()
    has_key = bool(s.get("claude_key") or os.environ.get("ANTHROPIC_API_KEY"))
    with _lock:
        p = _load(pid)
        rv = p.get("review") or {}
        if rv.get("state") == "running" and time.time() - rv.get("at", 0) < 300:
            return _summary(p)
        auto = 0
        if p["engine"] not in ("renpy", "rpgmv", "rpgmz"):
            for it in p["items"]:
                if it.get("skip_by") in ("user", "claude", "claude-ok") or it.get("skip"):
                    continue
                why = langscan.suspect(it["t"], it.get("ctx", ""))
                if why:
                    it.update(skip=True, skip_by="auto", why=why)
                    auto += 1
        todo = [i for i, it in enumerate(p["items"]) if it.get("skip_by") not in ("user", "claude-ok")]
        p["review"] = ({"state": "running", "done": 0, "total": len(todo), "found": 0, "auto": auto, "at": time.time()} if has_key
                       else {"state": "done", "found": 0, "auto": auto, "nokey": True, "at": time.time()})
        _save(p)
    if has_key:
        REVIEWING.add(pid)
        threading.Thread(target=_review_run, args=(pid, todo, s), daemon=True, name="gametr-review").start()
    return _summary(p)


def _review_run(pid: str, todo: list[int], s: dict):
    translate.USAGE_TAG.set(f"game:{pid}")
    s = {**s, "claude_model": REVIEW_MODEL}
    found = 0
    try:
        p = _load(pid)
        head = f"Game: {p['name']} ({ENGINE_NAMES.get(p['engine'], p['engine'])})."
        batch: list[int] = []
        size = 0
        batches = []
        for i in todo:
            n = min(len(p["items"][i]["t"]), 200) + 40
            if batch and (size + n > 24000 or len(batch) >= 400):
                batches.append(batch)
                batch, size = [], 0
            batch.append(i)
            size += n
        if batch:
            batches.append(batch)
        done = 0
        for b in batches:
            lines = []
            for i in b:
                it = p["items"][i]
                t = it["t"].replace("\n", " ")
                lines.append(f"{i}\t[{(it.get('ctx') or it['kind'])[:50]}]\t{t[:200]}")
            data = translate.claude_json(s, REVIEW_SYSTEM, [{"type": "text", "text": head + "\n\n" + "\n".join(lines)}],
                                         REVIEW_SCHEMA, "low", 8000)
            bad = {int(x["i"]): str(x.get("why") or "không hiện trong game")[:80] for x in data.get("skip", [])
                   if isinstance(x, dict) and str(x.get("i", "")).lstrip("-").isdigit()}
            with _lock:
                p = _load(pid)
                for i in b:
                    it = p["items"][i]
                    if it.get("skip_by") == "user":
                        continue
                    if i in bad:
                        if not it.get("skip"):
                            found += 1
                        it.update(skip=True, skip_by="claude", why="Claude: " + bad[i])
                    else:
                        if it.get("skip"):
                            it.pop("skip", None)
                            it.pop("why", None)
                        it["skip_by"] = "claude-ok"
                done += len(b)
                p["review"] = {**(p.get("review") or {}), "done": done, "found": found, "at": time.time()}
                _save(p)
        state = {"state": "done", "found": found}
    except translate.TranslateError as e:
        state = {"state": "error", "error": str(e)}
    except Exception as e:      # báo lên giao diện, không làm chết luồng
        state = {"state": "error", "error": f"{type(e).__name__}: {e}"}
    REVIEWING.discard(pid)
    with _lock:
        try:
            p = _load(pid)
        except HTTPException:
            return
        p["review"] = {**(p.get("review") or {}), **state, "at": time.time()}
        _save(p)


class OptsIn(BaseModel):
    font: bool | None = None
    width: int | None = None
    width_face: int | None = None
    name: str | None = None
    brief: str | None = None          # bối cảnh game (thể loại, nhân vật, xưng hô…) gửi kèm mỗi lô cho Claude
    glossary: str | None = None       # thuật ngữ riêng của game: "gốc = dịch" mỗi dòng
    vi_mode: str | None = None        # font game thiếu dấu: full | safe | nodau | en


@router.patch("/{pid}")
def set_opts(pid: str, body: OptsIn):
    with _lock:
        p = _load(pid)
        for k, v in body.model_dump(exclude_none=True).items():
            if k in ("brief", "glossary"):
                p[k] = v[:8000]
            elif k == "vi_mode":
                if v in fontcheck.VI_MODES:
                    p["opts"]["vi_mode"] = v
            elif k == "name":
                p["name"] = v.strip()[:120] or p["name"]
            else:
                p["opts"][k] = max(20, min(120, v)) if k.startswith("width") else v
        _save(p)
    return _summary(p)


BRIEF_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["brief", "terms"],
                "properties": {"brief": {"type": "string"},
                               "terms": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                    "required": ["src", "vi"],
                                                                    "properties": {"src": {"type": "string"}, "vi": {"type": "string"}}}}}}
BRIEF_SYSTEM = """Bạn là trưởng nhóm Việt hóa game. Trước khi cả nhóm dịch, bạn đọc mẫu chữ trong file game và viết "Bối cảnh game"
ngắn gọn bằng tiếng Việt để các lượt dịch sau dịch đúng ngữ cảnh. Bối cảnh gồm (mỗi mục 1–3 dòng, gạch đầu dòng):
- Thể loại và không khí (hài, kinh dị, kiếm hiệp, quản lý nhà hàng…), giọng văn nên dùng.
- Bối cảnh/thế giới.
- Nhân vật chính và tính cách, quan hệ; cách xưng hô nên dùng giữa họ (vd: Mira gọi người chơi là "anh", tự xưng "em").
- Cách dịch chữ giao diện (ngắn gọn, thống nhất), những chữ nên giữ tiếng Anh (tên riêng, tên chiêu…).
Kèm danh sách thuật ngữ quan trọng lặp lại nhiều (tên vật phẩm, kỹ năng, địa danh, chức danh) với cách dịch đề xuất; tên người giữ nguyên
thì không cần đưa vào. Tối đa 40 thuật ngữ. Không bịa thông tin không có trong mẫu – thiếu thì ghi ngắn "chưa rõ"."""


def _sample(p: dict, limit: int = 18000) -> str:
    """Mẫu chữ đại diện: tên nhân vật hay nói, đầu kịch bản, rải đều phần còn lại."""
    items = p["items"]
    who = Counter(it.get("who") for it in items if it.get("who"))
    lines, size = [], 0
    step = max(1, len(items) // 400)
    order = list(range(min(150, len(items)))) + list(range(150, len(items), step))
    for i in order:
        it = items[i]
        t = it["t"].replace("\n", " ")[:300]
        line = f"[{it.get('ctx') or it['kind']}]{' ' + it['who'] + ':' if it.get('who') else ''} {t}"
        size += len(line)
        if size > limit:
            break
        lines.append(line)
    head = f"Tên game: {p['name']} ({ENGINE_NAMES.get(p['engine'], p['engine'])}), {len(items)} câu."
    if who:
        head += "\nNhân vật nói nhiều nhất: " + ", ".join(f"{w} ({n})" for w, n in who.most_common(15))
    return head + "\n\nMẫu chữ (theo thứ tự trong game, [ngữ cảnh]):\n" + "\n".join(lines)


@router.post("/{pid}/brief")
def auto_brief(pid: str):
    """Claude đọc mẫu chữ của game rồi viết bối cảnh + thuật ngữ (người dùng sửa lại được)."""
    p = _load(pid)
    s = translate.settings()
    if not (s.get("claude_key") or os.environ.get("ANTHROPIC_API_KEY")):
        raise HTTPException(400, "Cần API key của Claude (Cài đặt bộ dịch). Không có thì tự ghi bối cảnh vào ô bên dưới.")
    tok = translate.USAGE_TAG.set(f"game:{pid}")
    try:
        data = translate.claude_json(s, BRIEF_SYSTEM, [{"type": "text", "text": _sample(p)}], BRIEF_SCHEMA, "medium", 6000)
    except translate.TranslateError as e:
        raise HTTPException(502, str(e))
    finally:
        translate.USAGE_TAG.reset(tok)
    terms = [f"{t['src'].strip()} = {t['vi'].strip()}" for t in data.get("terms", []) if t.get("src", "").strip()][:60]
    with _lock:
        p = _load(pid)
        p["brief"] = (data.get("brief") or "").strip()[:8000]
        have = {ln.split("=", 1)[0].strip().lower() for ln in (p.get("glossary") or "").splitlines() if "=" in ln}
        add = [t for t in terms if t.split("=", 1)[0].strip().lower() not in have]
        p["glossary"] = "\n".join(x for x in [(p.get("glossary") or "").strip(), *add] if x)[:8000]
        _save(p)
    return {"brief": p["brief"], "glossary": p["glossary"]}


EXPORT_HELP = """Hướng dẫn cho Claude: đây là chữ trong game "{name}" cần Việt hóa. Dịch từng câu sang tiếng Việt đúng ngữ cảnh game
(xem Bối cảnh game và Thuật ngữ), giữ nguyên mọi mã như {{0}} <b> [p] %s \\n \\C[2] [name]. Trả lời bằng JSON dạng
{{"<số>": "<bản dịch>", ...}} với đúng các số bên dưới (dịch một phần cũng được, lần sau gửi tiếp phần còn lại).
"""


@router.get("/{pid}/export")
def export_for_claude(pid: str, only: str = "todo", limit: int = 400, offset: int = 0):
    """File để nhờ Claude (chat trên claude.ai / app Claude) dịch, không cần API key. Nhập lại bằng /import."""
    p = _load(pid)
    rows = [(i, it) for i, it in enumerate(p["items"]) if not it.get("skip") and (only == "all" or it.get("vi") is None or (only == "bad" and it.get("bad")))]
    rows = rows[offset:offset + max(1, min(limit, 2000))]
    lines = [EXPORT_HELP.format(name=p["name"])]
    if p.get("brief"):
        lines.append("Bối cảnh game:\n" + p["brief"])
    if p.get("glossary"):
        lines.append("Thuật ngữ (bắt buộc dùng):\n" + p["glossary"])
    data = {str(i): (f"[{it['who']}] " if it.get("who") else "") + it["t"] for i, it in rows}
    lines.append(f"Câu cần dịch ({len(rows)} câu, mỗi câu kèm số; [Tên] ở đầu là người nói – không dịch phần đó):\n"
                 + json.dumps(data, ensure_ascii=False, indent=1))
    body = "\n\n".join(lines)
    from fastapi.responses import Response
    fname = re.sub(r"[^\w\-]+", "_", p["name"])[:40] or "game"
    return Response(body, media_type="text/plain; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="viet-hoa-{fname}-{offset + 1}.txt"'})


class ImportIn(BaseModel):
    text: str


@router.post("/{pid}/import")
def import_translation(pid: str, body: ImportIn):
    """Nhận bản dịch Claude trả lời (JSON {"số": "dịch"}, có thể nhiều khối / bị ngắt giữa chừng, hoặc mỗi dòng "số: dịch")."""
    got = parse_reply(body.text.strip())
    if not got:
        raise HTTPException(400, "Không đọc được bản dịch. Dán nguyên câu trả lời của Claude (khối JSON dạng {\"12\": \"…\"}).")
    kind = None
    n = bad = 0
    with _lock:
        p = _load(pid)
        kind = kind_of(p)
        for i, vi in got.items():
            if 0 <= i < len(p["items"]) and vi.strip():
                it = p["items"][i]
                if it.get("who") and vi.startswith(f"[{it['who']}]"):
                    vi = vi[len(it["who"]) + 2:].lstrip()
                _, codes = protect(it["t"], kind)
                it["vi"] = vi
                it["edited"] = False
                if codes and any(c not in vi for c in codes):
                    it["bad"] = True
                    bad += 1
                else:
                    it.pop("bad", None)
                n += 1
        _save(p)
        st = _pack_state(p)
    return {"ok": True, "imported": n, "bad": bad, "unknown": sum(1 for i in got if not 0 <= i < len(p["items"])), **st}


# ------------------------------------------------------------------ dịch bằng Claude chat (không cần API key)
CLAUDE_PART_HELP = """Bạn là dịch giả Việt hóa game chuyên nghiệp. Đây là PHẦN {no}/{total} chữ trong game "{name}" ({engine}).
Hãy dịch MỌI câu bên dưới sang tiếng Việt tự nhiên, đúng ngữ cảnh game.

Quy tắc:
- Giữ NGUYÊN mọi mã điều khiển/biến: {{0}} {{name}} <b>…</b> [p] [name] %s %d \\n \\C[2] ⟦0⟧ … (không dịch, không xóa, không thêm).
- Tên riêng, thuật ngữ: theo bảng Thuật ngữ bên dưới (nếu có), dùng thống nhất.
- "who" là người nói, "ctx" là vị trí trong game – chỉ để hiểu ngữ cảnh, KHÔNG dịch hai trường đó.
- Chữ giao diện (nút, menu) dịch ngắn gọn; lời thoại giữ giọng nhân vật và cách xưng hô.

Trả lời: CHỈ một khối ```json chứa object {{"<n>": "<bản dịch>"}} với ĐỦ {count} câu (n từ {first} đến {last}).
Nếu bạn tạo được file, hãy tạo file "tra-loi-phan-{no:02d}.json" với đúng nội dung đó. Nếu câu trả lời bị ngắt giữa chừng,
mình sẽ nhắn "tiếp tục" – khi đó trả tiếp các câu còn thiếu trong một khối ```json mới.
"""
PART_SIZES = {"small": 12000, "medium": 30000, "large": 70000}


def _pack_dir(p: dict) -> Path:
    base = Path.home() / "Downloads"
    if not base.is_dir():
        base = config.DATA
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", p["name"]).strip()[:60] or p["id"]
    return base / "CircleVault - Claude dich" / safe


def _part_text(p: dict, no: int) -> str:
    pack = p.get("pack") or {}
    parts = pack.get("parts") or []
    if not 1 <= no <= len(parts):
        raise HTTPException(404, "Không có phần này.")
    ids = [i for i in parts[no - 1] if 0 <= i < len(p["items"])]
    head = CLAUDE_PART_HELP.format(no=no, total=len(parts), name=p["name"], engine=ENGINE_NAMES.get(p["engine"], p["engine"]),
                                   count=len(ids), first=ids[0] if ids else 0, last=ids[-1] if ids else 0)
    out = [head]
    if (p.get("brief") or "").strip():
        out.append("Bối cảnh game:\n" + p["brief"].strip())
    gl = "\n".join(x for x in [(p.get("glossary") or "").strip(), (translate.settings().get("glossary") or "").strip()] if x)
    if gl:
        out.append("Thuật ngữ (bắt buộc dùng):\n" + gl)
    rows = []
    for i in ids:
        it = p["items"][i]
        row = {"n": i}
        if it.get("who"):
            row["who"] = it["who"]
        if it.get("ctx"):
            row["ctx"] = str(it["ctx"])[:60]
        row["t"] = it["t"]
        rows.append(json.dumps(row, ensure_ascii=False))
    out.append(f"Câu cần dịch ({len(ids)} câu, mỗi dòng một câu):\n" + "\n".join(rows))
    return "\n\n".join(out) + "\n"


def _pack_state(p: dict) -> dict:
    pack = p.get("pack")
    if not pack:
        return {"pack": None}
    parts = []
    for no, ids in enumerate(pack["parts"], 1):
        its = [p["items"][i] for i in ids if 0 <= i < len(p["items"])]
        chars = sum(len(it["t"]) for it in its)
        parts.append({"no": no, "count": len(its), "chars": chars, "done": sum(1 for it in its if it.get("vi") is not None),
                      "bad": sum(1 for it in its if it.get("bad")), "first": ids[0] if ids else None, "last": ids[-1] if ids else None})
    return {"pack": {"dir": pack.get("dir"), "size": pack.get("size"), "only": pack.get("only"), "at": pack.get("at"), "parts": parts,
                     "count": sum(x["count"] for x in parts), "done": sum(x["done"] for x in parts)}}


class PackIn(BaseModel):
    size: str = "medium"
    only: str = "todo"


@router.post("/{pid}/claude/pack")
def make_pack(pid: str, body: PackIn):
    """Chia câu cần dịch thành nhiều phần vừa một lượt chat với Claude, ghi ra thư mục Tải về."""
    limit = PART_SIZES.get(body.size, PART_SIZES["medium"])
    with _lock:
        p = _load(pid)
        want = {"all": lambda it: True, "bad": lambda it: bool(it.get("bad"))}.get(
            body.only, lambda it: it.get("vi") is None or bool(it.get("bad")))
        ids = [i for i, it in enumerate(p["items"]) if want(it) and not it.get("skip")]
        if not ids:
            raise HTTPException(400, "Không còn câu nào cần dịch.")
        parts, cur, size = [], [], 0
        for i in ids:
            n = len(p["items"][i]["t"]) + 40
            if cur and (size + n > limit or len(cur) >= 900):
                parts.append(cur)
                cur, size = [], 0
            cur.append(i)
            size += n
        if cur:
            parts.append(cur)
        d = _pack_dir(p)
        p["pack"] = {"parts": parts, "size": body.size, "only": body.only, "at": time.time(), "dir": str(d)}
        _save(p)
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / "tra-loi").mkdir(exist_ok=True)
        for f in d.glob("phan-*.txt"):
            f.unlink()
        for no in range(1, len(parts) + 1):
            (d / f"phan-{no:02d}.txt").write_text(_part_text(p, no), encoding="utf-8")
        (d / "00-HUONG-DAN.txt").write_text(PACK_README.format(name=p["name"], total=len(parts)), encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"Không ghi được thư mục gói: {e}")
    return _pack_state(p)


PACK_README = """Việt hóa "{name}" bằng Claude (không cần API key) – {total} phần.

1. Mở claude.ai (hoặc app Claude), tạo cuộc trò chuyện mới.
2. Kéo file phan-01.txt vào ô chat (hoặc mở file, chép hết nội dung rồi dán) và gửi. Không cần gõ thêm gì.
3. Claude trả về một khối JSON. Bấm "Copy" ở khối đó rồi dán vào ô "Dán câu trả lời của Claude" trong CircleVault → Nhập.
   (Hoặc lưu file Claude tạo vào thư mục tra-loi/ bên cạnh rồi bấm "Nhập từ thư mục" trong app.)
4. Làm tiếp phan-02.txt, phan-03.txt… Nên mở cuộc trò chuyện mới sau 3–4 phần cho Claude không bị quá dài.
5. Khi đủ các phần, bấm "Áp dụng vào game" trong CircleVault – app tự ghi bản dịch vào đúng file của game.

Câu trả lời bị ngắt giữa chừng: cứ nhập phần đã có, rồi nhắn Claude "tiếp tục" và nhập tiếp.
"""


@router.get("/{pid}/claude")
def pack_state(pid: str):
    return _pack_state(_load(pid))


@router.get("/{pid}/claude/parts/{no}")
def pack_part(pid: str, no: int, dl: bool = False):
    from fastapi.responses import Response
    text = _part_text(_load(pid), no)
    headers = {"Content-Disposition": f'attachment; filename="phan-{no:02d}.txt"'} if dl else {}
    return Response(text, media_type="text/plain; charset=utf-8", headers=headers)


@router.post("/{pid}/claude/open")
def pack_open(pid: str):
    d = Path((_load(pid).get("pack") or {}).get("dir") or "")
    if not d.is_dir():
        raise HTTPException(404, "Chưa tạo gói cho Claude.")
    if hasattr(os, "startfile"):
        os.startfile(str(d))  # noqa: S606 – mở File Explorer cho người dùng
    return {"dir": str(d)}


@router.post("/{pid}/claude/import-folder")
def pack_import_folder(pid: str):
    d = Path((_load(pid).get("pack") or {}).get("dir") or "")
    files = sorted([*(d / "tra-loi").glob("*.*"), *d.glob("tra-loi*.*")]) if d.is_dir() else []
    files = [f for f in files if f.suffix.lower() in (".json", ".txt", ".md") and f.stat().st_size < 20 * 1024 * 1024]
    if not files:
        raise HTTPException(400, "Thư mục tra-loi chưa có file nào. Lưu file Claude trả về vào đó rồi bấm lại.")
    text = "\n".join(f.read_text(encoding="utf-8", errors="replace") for f in files)
    r = import_translation(pid, ImportIn(text=text))
    return {**r, "files": len(files)}


_PAIR = re.compile(r'"(\d{1,7})"\s*:\s*"((?:[^"\\]|\\.)*)"', re.S)
_JSONL = re.compile(r'\{\s*"n"\s*:\s*(\d{1,7})\s*,\s*"(?:vi|t|text)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}')


def parse_reply(text: str) -> dict[int, str]:
    """Đọc câu trả lời của Claude: khối JSON {"số": "dịch"} (kể cả bị ngắt giữa chừng), JSONL, hoặc dòng "số: dịch"."""
    got: dict[int, str] = {}
    for rx in (_PAIR, _JSONL):
        for m in rx.finditer(text):
            try:
                got[int(m.group(1))] = json.loads('"' + m.group(2) + '"')
            except ValueError:
                got[int(m.group(1))] = m.group(2).replace("\\n", "\n").replace('\\"', '"')
    if not got:
        for ln in text.splitlines():
            mm = re.match(r'^\s*"?(\d+)"?\s*[:\t|=]\s*"?(.*?)"?,?\s*$', ln)
            if mm and mm.group(2):
                got[int(mm.group(1))] = mm.group(2).replace("\\n", "\n")
    return got


class XunityIn(BaseModel):
    path: str
    lang: str = "en"


@router.post("/xunity-setup")
def xunity_setup(body: XunityIn):
    """Cài BepInEx + XUnity.AutoTranslator vào game Unity và tạo dự án "dịch khi chơi"."""
    root = langscan.game_root(Path(body.path.strip().strip('"')))
    if not root.is_dir():
        raise HTTPException(400, "Không thấy thư mục game.")
    lang = body.lang if body.lang in TR_LANG else "en"
    pid = next((d.name for d in GAMES.glob("*") if (d / "project.json").is_file()
                and (lambda q: q.get("engine") == "xunity" and Path(q["root"]) == root)(config.read_json(d / "project.json"))),
               None) if GAMES.exists() else None
    if not pid:
        pid = uuid.uuid4().hex[:12]
        p = {"id": pid, "name": root.name, "path": str(root), "root": str(root), "engine": "xunity", "created": time.time(), "items": [],
             "status": "idle", "opts": {}, "warnings": [], "extra": [], "lang": lang, "groot": str(root)}
        _save(p)
    try:
        st = xunity.install(root, pid, lang)
    except PermissionError as e:
        raise perm_error(root, err=e)
    with _lock:
        p = _load(pid)
        p["xunity"] = {k: st[k] for k in ("il2cpp", "arch", "at")}
        p["applied"] = p.get("applied") or time.time()
        _save(p)
    return {**_summary(p), "installed": len(st.get("added", []))}


@router.get("/{pid}/xunity")
def xunity_translate(pid: str, text: str = ""):
    return xunity.serve(pid, text)


@router.post("/{pid}/xunity/uninstall")
def xunity_uninstall(pid: str):
    p = _load(pid)
    try:
        n = xunity.uninstall(Path(p["root"]))
    except PermissionError:
        raise HTTPException(400, "Không xóa được file trong thư mục game. Tắt game rồi thử lại.")
    with _lock:
        p = _load(pid)
        p["applied"] = None
        p.pop("xunity", None)
        _save(p)
    return {"ok": True, "files": n}


@router.post("/{pid}/run")
def run(pid: str):
    with _lock:
        p = _load(pid)
        p["status"] = "queued"
        p.pop("error", None)
        _save(p)
    WORKER.add(pid)
    return _summary(p)


@router.post("/{pid}/stop")
def stop(pid: str):
    WORKER.stop(pid)
    with _lock:
        p = _load(pid)
        p["status"] = "idle"
        _save(p)
    return _summary(p)


def _final(p: dict) -> list[dict]:
    kind = kind_of(p)
    out = []
    for it in p["items"]:
        vi = None if it.get("skip") else it.get("vi")
        if vi and not it.get("edited"):
            _, codes = protect(it["t"], kind)
            if codes and any(c not in vi for c in codes):
                vi = None                         # mất mã → giữ câu gốc
        out.append({**it, "final": vi})
    return out


_apply_jobs: dict[str, dict] = {}


def _font_have(p: dict) -> set[str] | None:
    """Chữ Việt mà MỌI font thiếu dấu của game đều có (để chế độ "Giữ dấu font có" chỉ dùng chữ hiển thị được)."""
    fonts = [f for f in (p.get("fontscan") or {}).get("fonts", []) if not f.get("ok")]
    if not fonts:
        return None
    have = None
    for f in fonts:
        if f.get("missing", -1) < 0 or "have" not in f:
            return None
        h = set(f["have"])
        have = h if have is None else have & h
    return have


@router.post("/{pid}/apply")
def apply(pid: str):
    """Ghi bản dịch vào game – chạy nền (file Unity lớn mất vài chục giây), trang hỏi GET /apply để vẽ tiến độ."""
    p = _load(pid)
    if WORKER.current == pid:
        raise HTTPException(409, "Đang dịch, bấm Dừng hoặc đợi dịch xong rồi áp dụng.")
    root = Path(p["root"])
    if not root.exists():
        raise HTTPException(400, f"Không thấy thư mục game: {root}")
    groot = Path(p.get("groot") or root)
    if groot.is_dir() and not can_write(groot):
        raise perm_error(groot)
    job = _apply_jobs.get(pid)
    if job and job.get("state") == "running":
        return {"job": job}
    job = {"state": "running", "text": "Đang chuẩn bị…", "done": 0, "total": 0, "started": time.time(), "name": p["name"]}
    _apply_jobs[pid] = job
    threading.Thread(target=_apply_run, args=(pid, job), daemon=True, name="gametr-apply").start()
    return {"job": job}


@router.get("/{pid}/apply")
def apply_state(pid: str):
    return {"job": _apply_jobs.get(pid)}


def _apply_run(pid: str, job: dict):
    def prog(text, done=None, total=None):
        job["text"] = text
        if total:
            job["done"], job["total"] = done or 0, total
    try:
        res = _apply_do(pid, prog)
        job.update(state="done", text="Xong", result=res, done=job.get("total", 0), finished=time.time())
    except HTTPException as e:
        job.update(state="error", error=e.detail, status=e.status_code, finished=time.time())
    except Exception as e:      # báo lên trang
        job.update(state="error", error=f"{type(e).__name__}: {e}", status=500, finished=time.time())


def _apply_do(pid: str, prog) -> dict:
    p = _load(pid)
    root = Path(p["root"])
    mode = p["opts"].get("vi_mode") or "full"
    if mode == "en":                                # người dùng chọn chơi tiếng Anh: gỡ bản dịch, giữ dự án
        prog("Đang trả game về tiếng Anh…")
        n = _restore_do(p)
        with _lock:
            q = _load(pid)
            q["applied"] = None
            _save(q)
        return {"engine": p["engine"], "restored": n, "mode": "en"}
    try:
        final = _final(p)
        if mode in ("safe", "nodau"):               # font của game thiếu dấu: đổi chữ cho hiển thị được
            have = _font_have(p)
            for it in final:
                if it.get("final"):
                    it["final"] = fontcheck.fit_text(it["final"], mode, have)
        res = {}
        prog("Đang ghi bản dịch…")
        if p["engine"] == "renpy":
            res = apply_renpy(root, final, p["opts"])
        elif p["engine"] == "unity":
            res = unitygame.apply(root, final, p.get("unity") or {}, prog)
        elif p["engine"] == "xunity":
            xunity.write_config(root, p["id"], p.get("lang") or "en")
            res = xunity.apply(root, final)
        elif p["engine"] == "unreal":
            u = p.get("unreal") or {}
            res = unreal.apply(root, final, u.get("sources") or [], unreal.parse_key(u.get("aes")))
        elif p["engine"] not in ("files", "unreal"):
            res = apply_rpg(root, final, p["opts"])
        if p.get("extra"):
            ex = langscan.apply(Path(p.get("groot") or p["path"]), final, p["extra"], p.get("lang") or "en", prog)
            res["texts"] = res.get("texts", 0) + ex["texts"]
            res["files"] = res.get("files", 0) + ex["files"]
            if ex["errors"]:
                res["errors"] = ex["errors"]
        fix = p.get("fontfix")
        if fix and fix.get("targets"):              # ghi bản dịch xong mới thay font (file .assets có cả chữ lẫn font)
            groups: dict[str, list] = {}
            for t in fix["targets"]:
                groups.setdefault(t.get("cid") or fix.get("cid") or "", []).append(t)
            for cid, ts in groups.items():
                fr = fontcheck.apply(_font_root(p), cid, ts, _aes(p), prog)
                res["fonts"] = res.get("fonts", 0) + fr["fonts"]
                if fr["errors"]:
                    res["errors"] = (res.get("errors") or []) + fr["errors"]
    except (GameError, unitygame.GameError, unreal.UEError, fontcheck.FontError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    except PermissionError as e:
        raise perm_error(Path(p.get("groot") or root), err=e)
    with _lock:
        p = _load(pid)
        p["applied"] = time.time()
        _save(p)
    return {**res, "engine": p["engine"], "mode": mode}


@router.post("/{pid}/restore")
def restore(pid: str):
    p = _load(pid)
    root = Path(p["root"])
    try:
        n = _restore_do(p)
    except PermissionError as e:
        raise perm_error(Path(p.get("groot") or root), err=e)
    with _lock:
        p = _load(pid)
        p["applied"] = None
        _save(p)
    return {"ok": True, "files": n}


def _restore_do(p: dict) -> int:
    root = Path(p["root"])
    n = 0
    if p.get("extra"):
        n += langscan.restore(Path(p.get("groot") or p["path"]), p["extra"])
    if p.get("fontfix"):
        n += fontcheck.restore(_font_root(p), p["fontfix"])
    if p["engine"] == "xunity":
        n += xunity.restore(root)
    elif p["engine"] == "unreal":
        n += unreal.restore(root, (p.get("unreal") or {}).get("sources") or [])
    elif p["engine"] not in ("files", "unreal"):
        n += restore_renpy(root) if p["engine"] == "renpy" else unitygame.restore(root) if p["engine"] == "unity" else restore_rpg(root)
    return n


# ================================================================== quyền ghi thư mục game
def can_write(d: Path) -> bool:
    """Thử tạo một file nhỏ: game trong Program Files (Steam) thì tài khoản thường không ghi được."""
    t = Path(d) / f".circlevault-thu-ghi-{os.getpid()}.tmp"
    try:
        t.write_bytes(b"x")
        t.unlink()
        return True
    except OSError:
        return False


def perm_error(root: Path, what: str = "ghi vào", err: Exception | None = None) -> HTTPException:
    """PermissionError khi ghi vào game: thư mục cần quyền quản trị (423, trang hỏi cấp quyền) hay file đang bị giữ (400)."""
    root = Path(root)
    if root.is_dir() and not can_write(root):
        return HTTPException(423, f"Thư mục game cần quyền quản trị mới {what} được ({root}). "
                                  "Bấm Cho phép để Windows hỏi quyền một lần cho thư mục game này.")
    name = Path(getattr(err, "filename", "") or "").name
    return HTTPException(400, f"Windows không cho thay file{(' ' + name) if name else ''} trong thư mục game: file đang được chương trình "
                              "khác mở (game, trình chỉnh sửa, phần mềm diệt virus đang quét…). Đóng chương trình đó rồi thử lại.")


def grant_write(root: Path) -> None:
    """Cho tài khoản Windows hiện tại quyền sửa thư mục game (icacls chạy bằng quyền quản trị – Windows hiện hộp UAC).
    Chỉ thêm quyền cho đúng thư mục game này; file con kế thừa. Không đổi chủ sở hữu, không bỏ quyền của ai."""
    import subprocess
    if os.name != "nt":
        raise HTTPException(400, "Chỉ cần trên Windows.")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    out = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, creationflags=flags, timeout=20).stdout
    m = re.search(r"(S-1-[\d-]+)", out or "")
    if not m:
        raise HTTPException(400, "Không đọc được tài khoản Windows hiện tại.")
    target = str(Path(root).resolve())
    args = f'"{target}" /grant *{m.group(1)}:(OI)(CI)M /C /Q'.replace("'", "''")
    ps = (f"try {{ $p = Start-Process -FilePath icacls.exe -ArgumentList '{args}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; "
          f"exit $p.ExitCode }} catch {{ exit 1223 }}")
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True,
                       creationflags=flags, timeout=600)
    if r.returncode == 1223:
        raise HTTPException(400, "Bạn đã bấm Không ở hộp hỏi quyền của Windows nên app chưa ghi được vào game.")
    if not can_write(Path(root)):
        raise HTTPException(400, "Đã chạy cấp quyền nhưng vẫn chưa ghi được vào thư mục game. Thử chép game ra ổ khác (D:\\Games…) "
                                 "rồi mở lại dự án từ đó.")


@router.post("/{pid}/grant")
def grant(pid: str):
    p = _load(pid)
    roots = {Path(p.get("groot") or p["path"]), Path(p["root"])}
    for r in sorted(roots, key=lambda x: len(str(x))):
        if r.is_dir() and not can_write(r):
            grant_write(r)
    return {"ok": True}


# ================================================================== tìm chữ chưa dịch trong file game
_find_jobs: dict[str, dict] = {}
FIND_TYPES = ("MonoBehaviour", "TextAsset")


class FindIn(BaseModel):
    q: str


def _unity_files(root: Path) -> list[Path]:
    out = []
    for d in [x for x in root.iterdir() if x.is_dir() and x.name.endswith("_Data")]:
        for f in d.rglob("*"):
            n = f.name.lower()
            if any(part.lower() in (langscan.BACKUP_DIR.lower(), langscan.PATCH_BACKUP.lower()) for part in f.relative_to(root).parts):
                continue
            if f.is_file() and (f.suffix.lower() in (".assets", ".bundle") or n in ("resources.assets", "globalgamemanagers")
                                or re.fullmatch(r"level\d+", n)):
                out.append(f)
    return sorted(out, key=lambda f: f.stat().st_size)


@router.post("/{pid}/find")
def find_text(pid: str, body: FindIn):
    """Tìm một chữ trong game (vd "New Game") – chạy nền: câu đã có trong dự án, file chữ và đối tượng Unity chứa nó."""
    q = body.q.strip()
    if len(q) < 2:
        raise HTTPException(400, "Gõ ít nhất 2 ký tự.")
    p = _load(pid)
    ql = q.lower()
    known = [{"i": i, "t": it["t"][:160], "skip": bool(it.get("skip")), "why": it.get("why"), "vi": it.get("vi")}
             for i, it in enumerate(p["items"]) if ql in it["t"].lower()][:20]
    job = {"state": "running", "q": q, "text": "Đang tìm…", "done": 0, "total": 0, "known": known, "hits": [], "started": time.time()}
    _find_jobs[pid] = job
    threading.Thread(target=_find_run, args=(p, job), daemon=True, name="gametr-find").start()
    return job


@router.get("/{pid}/find")
def find_state(pid: str):
    return _find_jobs.get(pid) or {}


def _find_run(p: dict, job: dict):
    root = Path(p.get("groot") or p["path"])
    needle = job["q"].lower().encode("utf-8")
    have = {(x.get("rel"), x.get("path_id")) for x in p.get("extra") or []}
    try:
        texts = [f for f in root.rglob("*") if f.is_file() and f.suffix.lower() in langscan.TEXT_EXT and f.stat().st_size <= langscan.MAX_TEXT
                 and not any(part.lower() in (langscan.BACKUP_DIR.lower(), langscan.PATCH_BACKUP.lower()) for part in f.relative_to(root).parts)]
        unity = _unity_files(root) if any(x.is_dir() and x.name.endswith("_Data") for x in root.iterdir()) else []
        job["total"] = len(texts) + len(unity)
        for f in texts:
            rel = str(f.relative_to(root)).replace("\\", "/")
            job["text"], job["done"] = f"Đang tìm trong {rel}", job["done"] + 1
            try:
                if needle in langscan._src(root, f).read_bytes().lower():
                    job["hits"].append({"rel": rel, "kind": "file", "label": rel, "in": any(h[0] == rel for h in have), "strings": None})
            except OSError:
                continue
        for f in unity:
            if job.get("cancel") or len(job["hits"]) >= 40:
                break
            rel = str(f.relative_to(root)).replace("\\", "/")
            job["text"], job["done"] = f"Đang tìm trong {rel}", job["done"] + 1
            try:
                with unityload.open_env(langscan._src(root, f)) as env:
                    for o in env.objects:
                        if o.type.name not in FIND_TYPES or o.byte_size > 64 * 1024 * 1024:
                            continue
                        raw = o.get_raw_data()
                        if needle not in raw.lower():
                            continue
                        strs = [x[2] for x in langscan.mb_strings(raw)]
                        texts_ok = [x for x in strs if langscan.textlike(x, True) and not langscan.suspect(x)]
                        match = next((x for x in strs if job["q"].lower() in x.lower()), "")
                        af = getattr(o, "assets_file", None)
                        job["hits"].append({"rel": rel, "path_id": int(o.path_id), "kind": "mono" if o.type.name == "MonoBehaviour" else "textasset",
                                            "label": langscan._mb_label(af, o, raw) if o.type.name == "MonoBehaviour" else (o.peek_name() or "TextAsset"),
                                            "strings": len(texts_ok), "match": match[:160], "sample": [x[:80] for x in texts_ok[:4]],
                                            "in": (rel, int(o.path_id)) in have})
                        if len(job["hits"]) >= 40:
                            break
            except Exception:       # file không đọc được: bỏ qua
                continue
        job.update(state="done", text="Xong")
    except Exception as e:      # báo lên trang
        job.update(state="error", text=f"{type(e).__name__}: {e}")


class FindAddIn(BaseModel):
    rel: str
    path_id: int | None = None
    kind: str = "mono"


@router.post("/{pid}/find/add")
def find_add(pid: str, body: FindAddIn):
    """Thêm chữ của một đối tượng Unity / file tìm được vào dự án (thành nguồn "extra", áp dụng như file chữ khác)."""
    p = _load(pid)
    root = Path(p.get("groot") or p["path"])
    f = (root / body.rel).resolve()
    if root.resolve() not in f.parents or not f.is_file():
        raise HTTPException(400, "Không thấy file này trong thư mục game.")
    lang = p.get("lang") or "en"
    new: list[tuple[str, str]] = []
    if body.kind == "file":
        src = langscan._scan_text(root, f, body.rel, lang) or {}
        if not src:
            raise HTTPException(400, "Không đọc được câu chữ nào trong file này.")
        src.update(id=f"x{int(time.time())}", on=True, loose=True)
        new = [(it["t"], it.get("ctx") or Path(body.rel).name) for it in src.pop("_items")]
        source = {k: v for k, v in src.items() if k != "sample"}
    else:
        if body.path_id is None:
            raise HTTPException(400, "Thiếu mã đối tượng.")
        with unityload.open_env(langscan._src(root, f)) as env:
            o = next((x for x in env.objects if x.path_id == body.path_id), None)
            if o is None:
                raise HTTPException(404, "Không thấy đối tượng này trong file.")
            raw = o.get_raw_data()
            label = langscan._mb_label(getattr(o, "assets_file", None), o, raw) if o.type.name == "MonoBehaviour" else (o.peek_name() or "TextAsset")
            if o.type.name == "TextAsset":
                d = o.read()
                fmt = langscan.sniff_fmt(d.m_Script, Path(label).suffix.lower())
                ents = langscan.entries(d.m_Script, fmt, True, lang)
                new = [(t, c or label) for t, c in langscan.texts_of(ents)]
                source = {"kind": "textasset", "rel": body.rel, "path_id": body.path_id, "asset": label, "fmt": fmt, "loose": True,
                          "count": len(new), "lang": lang, "label": f"{body.rel} → {label}", **({"col": ents["col"]} if isinstance(ents, dict) else {})}
            else:
                strs = [x[2] for x in langscan.mb_strings(raw)]
                new = [(t, label[:80]) for t in dict.fromkeys(x for x in strs if langscan.textlike(x, True) and not langscan.suspect(x))]
                source = {"kind": "mono", "rel": body.rel, "path_id": body.path_id, "asset": label, "fmt": "mono", "loose": True,
                          "count": len(new), "lang": lang, "label": f"{body.rel} → {label}"}
    if not new:
        raise HTTPException(400, "Đối tượng này không có câu chữ nào dịch được.")
    with _lock:
        p = _load(pid)
        p.setdefault("extra", [])
        if not any(x.get("rel") == source.get("rel") and x.get("path_id") == source.get("path_id") for x in p["extra"]):
            p["extra"].append(source)
        seen = {it["t"] for it in p["items"]}
        added = 0
        for t, ctx in new:
            if t in seen or not t.strip():
                continue
            seen.add(t)
            p["items"].append({"t": t, "kind": "ui", "ctx": ctx, "who": "", "vi": None})
            added += 1
        _save(p)
    return {**_summary(p), "added": added, "found": len(new)}


# ================================================================== font tiếng Việt của game
_font_jobs: dict[str, dict] = {}


def _font_root(p: dict) -> Path:
    return Path(p.get("groot") or p["path"])


def _aes(p: dict) -> bytes | None:
    try:
        return unreal.parse_key((p.get("unreal") or {}).get("aes"))
    except Exception:       # khóa sai: đọc pak không mã hóa
        return None


def _font_state(p: dict) -> dict:
    job = _font_jobs.get(p["id"]) or {}
    scan = p.get("fontscan") or None
    main = None
    if scan:
        bad = [f for f in scan["fonts"] if not f["ok"]]
        pool = bad or scan["fonts"]
        if pool:
            main = max(set(f["cat"] for f in pool), key=lambda c: sum(1 for f in pool if f["cat"] == c))
    script = p["engine"] in ("renpy", "rpgmv", "rpgmz")
    return {"scan": scan, "job": {k: v for k, v in job.items() if not k.startswith("_")} or None, "cat": main or "sans",
            "pick": p["opts"].get("font_pick"), "fix": p.get("fontfix"), "mode": "pick" if script else "replace",
            "vi_mode": p["opts"].get("vi_mode") or "full", "vi_modes": fontcheck.VI_MODES,
            "have": "".join(sorted(_font_have(p) or [])) or None,
            "engine": p["engine"], "cats": fontcheck.CATS}


@router.get("/{pid}/fonts")
def fonts_state(pid: str):
    return _font_state(_load(pid))


@router.post("/{pid}/fonts/scan")
def fonts_scan(pid: str):
    p = _load(pid)
    job = _font_jobs.get(pid)
    if job and job.get("state") == "running":
        return _font_state(p)
    job = {"state": "running", "text": "Đang tìm font trong thư mục game…", "started": time.time()}
    _font_jobs[pid] = job

    def run():
        try:
            res = fontcheck.scan_game(_font_root(p), _aes(p), job)
            with _lock:
                q = _load(pid)
                q["fontscan"] = {**res, "at": time.time()}
                _save(q)
            job.update(state="done", text="Xong")
        except Exception as e:      # báo lên giao diện
            job.update(state="error", text=str(e) if isinstance(e, (OSError, fontcheck.FontError)) else f"{type(e).__name__}: {e}")
    threading.Thread(target=run, daemon=True, name="fontscan").start()
    return _font_state(p)


class FontApplyIn(BaseModel):
    cid: str
    ids: list[str] = []


@router.post("/{pid}/fonts/apply")
def fonts_apply(pid: str, body: FontApplyIn):
    p = _load(pid)
    if p["engine"] in ("renpy", "rpgmv", "rpgmz"):
        try:
            fontcheck.font_source(body.cid, 400)          # tải sẵn / kiểm tra font dùng được
        except fontcheck.FontError as e:
            raise HTTPException(400, str(e))
        with _lock:
            p = _load(pid)
            p["opts"]["font_pick"] = body.cid
            p["opts"]["font"] = True
            _save(p)
        return {**_font_state(p), "msg": "Đã chọn font. Bấm “Áp dụng vào game” để ghi vào game."}
    scan = p.get("fontscan") or {}
    targets = [f for f in scan.get("fonts", []) if f["id"] in set(body.ids) and f.get("can_replace")]
    if not targets:
        raise HTTPException(400, "Chọn ít nhất một font của game để đổi.")
    if WORKER.current == pid:
        raise HTTPException(409, "Đang dịch, bấm Dừng rồi đổi font (tránh ghi file cùng lúc).")
    try:
        old = p.get("fontfix") or {}
        again = [t for t in old.get("targets") or [] if t["id"] in {x["id"] for x in targets}]
        if again:
            fontcheck.restore(_font_root(p), {"targets": again, "files": []})   # font đã đổi trước đó: trả gốc rồi đổi lại
        res = fontcheck.apply(_font_root(p), body.cid, targets, _aes(p))
    except fontcheck.FontError as e:
        raise HTTPException(400, str(e))
    except PermissionError as e:
        raise perm_error(_font_root(p), err=e)
    if not res["fonts"]:
        raise HTTPException(400, "Không đổi được font nào. " + "; ".join(res["errors"][:3]))
    with _lock:
        p = _load(pid)
        old = p.get("fontfix") or {}
        keep = [t for t in old.get("targets") or [] if t["id"] not in {x["id"] for x in targets}]
        p["fontfix"] = {"targets": keep + [{**t, "cid": body.cid} for t in targets],
                        "files": sorted(set(old.get("files") or []) | set(res["files"])), "at": time.time()}
        _save(p)
    return {**_font_state(p), "result": res}


@router.post("/{pid}/fonts/restore")
def fonts_restore(pid: str):
    p = _load(pid)
    n = 0
    try:
        if p.get("fontfix"):
            n = fontcheck.restore(_font_root(p), p["fontfix"])
    except PermissionError as e:
        raise perm_error(_font_root(p), err=e)
    with _lock:
        p = _load(pid)
        p["fontfix"] = None
        p["opts"].pop("font_pick", None)
        _save(p)
    return {**_font_state(p), "restored": n}


@router.get("/fontlib/candidates")
def font_candidates(cat: str = "sans"):
    try:
        return {"fonts": fontcheck.candidates(cat), "cats": fontcheck.CATS}
    except fontcheck.FontError as e:
        raise HTTPException(400, str(e))


@router.get("/fontlib/file")
def font_file(cid: str = "", pid: str = "", fid: str = ""):
    """Dữ liệu font để trang xem trước chữ mẫu (font gợi ý, hoặc font đang có trong game)."""
    from fastapi.responses import Response
    try:
        if cid:
            data = fontcheck.font_source(cid, 400)
        else:
            p = _load(pid)
            f = next((x for x in (p.get("fontscan") or {}).get("fonts", []) if x["id"] == fid), None)
            if not f or f["kind"] == "tmp":
                raise HTTPException(404, "Không có font này.")
            data = fontcheck.preview_bytes(_font_root(p), f, _aes(p))
    except fontcheck.FontError as e:
        raise HTTPException(400, str(e))
    except OSError:
        raise HTTPException(404, "Không đọc được font.")
    return Response(data, media_type="font/ttf", headers={"Cache-Control": "max-age=600"})


@router.post("/fontlib/upload")
async def font_upload(request: Request, name: str = "font.ttf"):
    data = await request.body()
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "File font quá lớn (tối đa 30 MB).")
    try:
        return fontcheck.add_user_font(name, data)
    except fontcheck.FontError as e:
        raise HTTPException(400, str(e))


@router.delete("/{pid}")
def delete(pid: str):
    d = _proj_dir(pid)
    WORKER.stop(pid)
    shutil.rmtree(d, ignore_errors=True)       # chỉ xóa dự án trong dữ liệu app; game và bản sao lưu giữ nguyên
    return {"ok": True}


# ================================================================== dịch nền
class Worker:
    def __init__(self):
        self.queue: list[str] = []
        self.current: str | None = None
        self._stop: set[str] = set()
        self._cv = threading.Condition()
        self._thread = None

    def add(self, pid):
        with self._cv:
            self._stop.discard(pid)
            if pid not in self.queue and pid != self.current:
                self.queue.append(pid)
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True, name="gametr")
                self._thread.start()

    def stop(self, pid):
        with self._cv:
            self._stop.add(pid)
            if pid in self.queue:
                self.queue.remove(pid)

    def _run(self):
        while True:
            with self._cv:
                if not self.queue:
                    self.current = None
                    return
                pid = self.queue.pop(0)
                self.current = pid
            try:
                self._project(pid)
            except Exception as e:
                _status(pid, "error", f"Lỗi: {e}")
            finally:
                self.current = None

    def _project(self, pid):
        translate.USAGE_TAG.set(f"game:{pid}")
        _status(pid, "running")
        s = translate.settings()
        p = _load(pid)
        if p.get("lang"):
            s = {**s, "source": TR_LANG.get(p["lang"], "auto")}
        kind = kind_of(p)
        todo = [i for i, it in enumerate(p["items"]) if it.get("vi") is None and not it.get("skip")]
        for k in range(0, len(todo), BATCH):
            if pid in self._stop:
                return
            idx = todo[k:k + BATCH]
            src = [p["items"][i] for i in idx]
            prot = [protect(it["t"], kind) for it in src]
            ctx, s2 = _context(p, s)
            res = None
            for attempt in range(12):
                try:
                    res = translate.translate_texts([x[0] for x in prot], s2, kind="gamefile", context=ctx,
                                                    who=[it.get("who") or "" for it in src],
                                                    notes=[(it.get("ctx") or "")[:60] for it in src])
                    break
                except translate.TranslateError as e:
                    if "tạm chặn" not in str(e) or attempt == 11:
                        _status(pid, "error", str(e))
                        return
                    wait = min(600, 90 * (attempt + 1))       # Google chặn tạm: đợi rồi tự dịch tiếp
                    _status(pid, "running", note=f"Google Dịch tạm chặn vì dịch nhiều. Tự dịch tiếp lúc "
                                            f"{time.strftime('%H:%M', time.localtime(time.time() + wait))} (lần {attempt + 1}/11). "
                                            "Không muốn đợi: dùng “Dịch bằng Claude chat” bên dưới.")
                    for _ in range(wait):
                        if pid in self._stop:
                            return
                        time.sleep(1)
            if res is None:
                return
            if attempt:
                _status(pid, "running")
            with _lock:
                p = _load(pid)
                for i, (txt, codes), vi in zip(idx, prot, res):
                    it = p["items"][i]
                    if it.get("edited"):
                        continue
                    back = restore_codes(vi, codes) if vi else None
                    if vi and back is None:
                        it["vi"], it["bad"] = vi, True       # mã bị đổi: giữ bản dịch để người dùng sửa
                    else:
                        it["vi"] = back if back is not None else ""
                        it.pop("bad", None)
                _save(p)
        _status(pid, "idle")


def _context(p: dict, s: dict) -> tuple[str, dict]:
    """Ngữ cảnh gửi kèm mỗi lô: tên game, engine, bối cảnh game, thuật ngữ riêng (gộp với thuật ngữ chung)."""
    ctx = f"Game: {p['name']} ({ENGINE_NAMES.get(p['engine'], p['engine'])})."
    if (p.get("brief") or "").strip():
        ctx += "\nBối cảnh game (bám sát khi dịch):\n" + p["brief"].strip()
    gl = "\n".join(x for x in [(p.get("glossary") or "").strip(), (s.get("glossary") or "").strip()] if x)
    sig = hashlib.sha1(((p.get("brief") or "") + "\0" + (p.get("glossary") or "")).encode()).hexdigest()[:12] \
        if (p.get("brief") or p.get("glossary")) else ""
    return ctx, {**s, "glossary": gl, "_sig": sig}


def _status(pid, status, error=None, note=None):
    with _lock:
        try:
            p = _load(pid)
        except HTTPException:
            return
        p["status"] = status
        if error:
            p["error"] = error
        else:
            p.pop("error", None)
        if note:
            p["note"] = note
        else:
            p.pop("note", None)
        _save(p)


WORKER = Worker()
