"""Tự dò file chứa chữ trong thư mục game (tab Dịch → Việt hóa game).

Người dùng chỉ đưa thư mục game. App chạy nền (có tiến độ cho thanh chờ) và:
1. Nhận loại game: Ren'Py, RPG Maker MV/MZ, Unity Localization (đã có bộ đọc riêng trong gametr/unitygame) – và nêu tên
   các engine chưa đọc được (Unreal .pak, Godot .pck, GameMaker data.win, Kirikiri .xp3, Wolf RPG, RPG Maker VX/XP).
2. Lục mọi file chữ: .json .csv .tsv .xml .po .ini .cfg .properties .lang .strings .yaml .txt .ks (TyranoScript/Kirikiri)…
   chấm điểm xem file nào là file ngôn ngữ (đường dẫn kiểu loc/lang/text, tên en/english…, tỉ lệ chuỗi giống câu chữ),
   đoán ngôn ngữ (chữ viết + từ thường gặp), và lấy câu cần dịch.
3. Game Unity: đọc thêm TextAsset (JSON/CSV/XML… nhúng trong .assets / .bundle) bằng UnityPy.

Áp dụng = ghi tiếng Việt thay đúng chỗ chuỗi gốc (giữ nguyên định dạng file), bản gốc sao lưu ở `<game>/CircleVault-ban-goc/`
và luôn đọc lại từ bản sao lưu khi áp dụng lại. Không mở file mã hóa / nén riêng của game (không vượt bảo vệ).
"""
from __future__ import annotations

import codecs
import csv
import html
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
from collections import Counter
from pathlib import Path

BACKUP_DIR = "CircleVault-ban-goc"
PATCH_BACKUP = "CircleVault-truoc-VH"
TEXT_EXT = {".json", ".csv", ".tsv", ".xml", ".po", ".ini", ".cfg", ".properties", ".lang", ".strings", ".yaml", ".yml",
            ".txt", ".ks", ".loc", ".tab", ".resx"}
MAX_TEXT = 60 * 1024 * 1024
MAX_ASSET = 1536 * 1024 * 1024
SKIP_DIRS = {BACKUP_DIR.lower(), PATCH_BACKUP.lower(), "monobleedingedge", "managed", "il2cpp_data", "plugins", "mono",
             "__pycache__", ".git", "node_modules", "swiftshader", "d3d12", "renpy", "lib", "_commonredist", "redist",
             "directx", "vcredist", "steamworks", "crashreport", "unitycrashhandler", "fonts", "audio", "movies", "img",
             "bgm", "se", "se_voice", "voice", "sound", "sounds", "music", "video", "videos", "shaders"}
SKIP_FILES = re.compile(r"(?i)^(package|manifest|catalog|settings|unitysubsystemsmanifest|scriptingassemblies|"
                        r"runtimeinitializeonloads|boot|appinfo|steam_appid|readme|license|licence|eula|changelog|"
                        r"third[-_ ]?party.*|credits?_?libs?|version|config\.vdf|[\w.]*\.deps|[\w.]*\.runtimeconfig|"
                        r"settings_?catalog|link|unins\d*)\.[a-z]+$")
LOC_DIR = re.compile(r"(?i)^(loc|locale|locales|locali[sz]ation|lang|langs|language|languages|i18n|l10n|text|texts|strings|"
                     r"dialog|dialogs|dialogue|dialogues|translation|translations|messages|scenario|scenarios|script|scripts|"
                     r"story|stories|subtitles?|talk|event|events|quest|quests|tl|data)$")
LANG_TOKEN = re.compile(r"(?i)(?:^|[_\-. ()\[\]])(en|eng|english|en[-_]us|en[-_]gb|ja|jp|jpn|japanese|zh|cn|chs|cht|zh[-_]cn|"
                        r"zh[-_]tw|chinese|schinese|tchinese|ko|kr|kor|korean|fr|french|de|german|es|spanish|pt|pt[-_]br|"
                        r"portuguese|it|italian|ru|russian|pl|polish|tr|turkish|vi|vn|vietnamese)(?:$|[_\-. ()\[\]])")
LANG_NAMES = {"en": "Tiếng Anh", "ja": "Tiếng Nhật", "zh": "Tiếng Trung", "ko": "Tiếng Hàn", "fr": "Tiếng Pháp",
              "de": "Tiếng Đức", "es": "Tiếng Tây Ban Nha", "pt": "Tiếng Bồ Đào Nha", "it": "Tiếng Ý", "ru": "Tiếng Nga",
              "pl": "Tiếng Ba Lan", "tr": "Tiếng Thổ Nhĩ Kỳ", "vi": "Tiếng Việt", "latin": "Chữ Latin"}
_TOKEN_LANG = {"en": "en", "eng": "en", "english": "en", "en-us": "en", "en_us": "en", "en-gb": "en", "en_gb": "en",
               "ja": "ja", "jp": "ja", "jpn": "ja", "japanese": "ja", "zh": "zh", "cn": "zh", "chs": "zh", "cht": "zh",
               "zh-cn": "zh", "zh_cn": "zh", "zh-tw": "zh", "zh_tw": "zh", "chinese": "zh", "schinese": "zh", "tchinese": "zh",
               "ko": "ko", "kr": "ko", "kor": "ko", "korean": "ko", "fr": "fr", "french": "fr", "de": "de", "german": "de",
               "es": "es", "spanish": "es", "pt": "pt", "pt-br": "pt", "pt_br": "pt", "portuguese": "pt", "it": "it",
               "italian": "it", "ru": "ru", "russian": "ru", "pl": "pl", "polish": "pl", "tr": "tr", "turkish": "tr",
               "vi": "vi", "vn": "vi", "vietnamese": "vi"}
STOP = {
    "en": "the you and to is of a i it in what that this be for are not my your have with on can we do me he she was will",
    "fr": "le la les de et vous est je pas une un des que qui dans pour il elle ce sur mon au avec",
    "de": "der die und ist nicht ich das sie es ein zu den mit du wir auf für ist sich auch",
    "es": "el la de que y es no los por un una en se lo las con para mi su al",
    "pt": "o a de que e não um uma os em para com do da você eu se",
    "it": "il la di che e non un una per è sono mi ti con del lo gli",
}
STOP = {k: set(v.split()) for k, v in STOP.items()}
SKIP_KEYS = re.compile(r"(?i)^(id|ids|key|keys|guid|uuid|type|types|icon|image|images|img|sprite|sprites|sound|sounds|se|bgm|"
                       r"voice|file|files|filename|path|paths|anim|animation|tag|tags|class|event_?id|font|fonts|color|colour|"
                       r"scene|prefab|code|url|uri|link|asset|assets|texture|material|shader|layer|sfx|music|portrait|face|"
                       r"avatar|model|script|function|method|callback|condition|flag|flags|variable|var|switch|trigger|speaker|"
                       r"speaker_?id|character|character_?id|char|chara|actor|actor_?id|who|emotion|expression|pose|"
                       r"\$type|\$id|\$ref|version|hash|crc|format|lang|language|locale|culture|font_?name|style|align)$")
GENERIC_CODES = re.compile(r"\{[^{}\n]*\}|<[^<>\n]+>|%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?[sdifxXc@]|%\d+|\[[^\[\]\n]{1,40}\]"
                           r"|\\[nrt]|\$\{?\w+\}?")

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


# ================================================================== nhận chữ
def script_lang(s: str) -> str | None:
    if re.search(r"[぀-ヿ]", s):
        return "ja"
    if re.search(r"[가-힯ᄀ-ᇿ]", s):
        return "ko"
    if re.search(r"[㐀-鿿]", s):
        return "zh"
    if re.search(r"[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]", s, re.I):
        return "vi"
    if re.search(r"[Ѐ-ӿ]", s):
        return "ru"
    if re.search(r"[A-Za-z]", s):
        return "latin"
    return None


_MEDIA = re.compile(r"(?i)\.(png|jpe?g|webp|gif|bmp|tga|psd|ogg|wav|mp3|m4a|flac|opus|mp4|webm|avi|prefab|asset|unity|mat|"
                    r"anim|controller|json|txt|csv|xml|dll|exe|bundle|ttf|otf|fnt|shader|lua|js|rpy|ks|tjs)$")


def textlike(s: str, loose: bool = False) -> bool:
    """Chuỗi có phải câu chữ hiển thị cho người chơi (không phải mã, đường dẫn, tên biến…)."""
    t = s.strip()
    if len(t) < 2 or len(t) > 6000:
        return False
    lang = script_lang(t)
    if not lang or lang in ("vi", "ru"):
        return False
    if re.match(r"(?i)^(https?|file|res|asset)://", t) or _MEDIA.search(t):
        return False
    if lang in ("ja", "ko", "zh"):
        return not re.fullmatch(r"[\w.\-/\\:]+", t, re.A)
    if re.fullmatch(r"#?[0-9a-fA-F]{6,8}|[\d\s.,:;%+\-*/=()]+|true|false|null|none|nan", t, re.I):
        return False
    if re.fullmatch(r"[A-Za-z_][\w.]*\(.*\)|[\w\-]+(?:[/\\][\w\-.]+)+|[a-z]+(?:_[a-z0-9]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+", t):
        return False
    if re.search(r"\s", t):
        words = re.findall(r"[A-Za-z]{2,}", t)
        return bool(words) and not re.fullmatch(r"[\w.\-]+\s*[=:]\s*[\w.\-]+", t)
    # một từ: chỉ nhận trong file ngôn ngữ ("Start", "Options", "HP")
    if re.search(r"[_/\\]|\d", t) or re.search(r"[a-z][A-Z]", t):
        return False
    return loose and bool(re.fullmatch(r"[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’\-]*[!?.:…]*", t))


def guess_latin(texts: list[str]) -> str:
    cnt = Counter()
    for t in texts[:400]:
        for w in re.findall(r"[a-zàâçéèêëîïôûùüÿñæœäöüßãõíóúì]+", t.lower()):
            for k, st in STOP.items():
                if w in st:
                    cnt[k] += 1
    if not cnt:
        return "en"
    best, n = cnt.most_common(1)[0]
    return best if n >= 3 else "en"


def lang_of_texts(texts: list[str]) -> str:
    c = Counter(script_lang(t) for t in texts[:500])
    c.pop(None, None)
    if not c:
        return "latin"
    lang = c.most_common(1)[0][0]
    return guess_latin(texts) if lang == "latin" else lang


def lang_token(rel: str) -> str | None:
    for part in reversed(re.split(r"[\\/]", rel)):
        m = LANG_TOKEN.search(Path(part).stem if "." in part else part)
        if m:
            return _TOKEN_LANG.get(m.group(1).lower())
    return None


def is_loc_path(rel: str) -> bool:
    parts = re.split(r"[\\/]", rel)
    return any(LOC_DIR.match(p) for p in parts[:-1]) or bool(LANG_TOKEN.search(Path(parts[-1]).stem)) \
        or bool(re.search(r"(?i)(string|locali[sz]|lang|text|dialog|message|script|scenario|story|talk|quest|subtitle)",
                          Path(parts[-1]).stem))


# ================================================================== đọc / ghi chuỗi trong file (giữ nguyên định dạng)
def decode(raw: bytes) -> tuple[str, str]:
    if raw.startswith(codecs.BOM_UTF8):
        return raw[3:].decode("utf-8", "replace"), "utf-8-sig"
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return raw.decode("utf-16"), "utf-16"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass
    for enc in ("cp932", "gbk", "cp949"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1"), "latin-1"


def encode(text: str, enc: str) -> bytes:
    if enc in ("utf-8", "utf-8-sig", "utf-16"):
        return text.encode(enc)
    return text.encode("utf-8-sig")        # Shift-JIS/GBK… không chứa được tiếng Việt: ghi UTF-8 có BOM


def _json_entries(text: str, loose: bool):
    tok = re.compile(r'"(?:[^"\\\n]|\\.)*"')
    last_key = ""
    for m in tok.finditer(text):
        j = m.end()
        while j < len(text) and text[j] in " \t\r\n":
            j += 1
        try:
            val = json.loads(m.group(0))
        except ValueError:
            continue
        if j < len(text) and text[j] == ":":
            last_key = val
            continue
        if last_key and SKIP_KEYS.match(str(last_key)) and " " not in val:
            continue
        if textlike(val, loose):
            yield m.start(), m.end(), val, str(last_key)[:60], lambda v: json.dumps(v, ensure_ascii=False)


def _xml_entries(text: str, loose: bool):
    dead = [(m.start(), m.end()) for m in re.finditer(r"<!--.*?-->|<\?.*?\?>|<script\b.*?</script>", text, re.S)]

    def alive(i):
        return not any(a <= i < b for a, b in dead)
    for m in re.finditer(r"<!\[CDATA\[(.*?)\]\]>", text, re.S):
        v = m.group(1)
        if alive(m.start()) and textlike(v, loose):
            yield m.start(1), m.end(1), v, "", lambda x: x.replace("]]>", "]] >")
    tag = ""
    for m in re.finditer(r"<([A-Za-z_][\w:.\-]*)([^<>]*)>|(?<=>)([^<>]+)(?=<)", text):
        if m.group(1):
            tag = m.group(1)
            attrs = m.group(2) or ""
            key = re.search(r'\b(?:name|id|key)\s*=\s*"([^"]*)"', attrs)
            tag = f"{tag}·{key.group(1)}" if key else tag
            for a in re.finditer(r'\b(text|value|label|title|desc|description|caption|tooltip|message|content|string|'
                                 r'display|displayname|hint|subtitle)\s*=\s*"([^"]*)"', attrs, re.I):
                v = html.unescape(a.group(2))
                if alive(m.start()) and textlike(v, loose):
                    s = m.start(2) + a.start(2)
                    yield s, s + len(a.group(2)), v, tag, lambda x: html.escape(x, quote=True)
            continue
        raw = m.group(3)
        if "CDATA" in raw or not raw.strip() or not alive(m.start()):
            continue
        v = html.unescape(raw.strip())
        if textlike(v, loose):
            lead = len(raw) - len(raw.lstrip())
            s = m.start(3) + lead
            yield s, s + len(raw.strip()), v, tag, lambda x: html.escape(x, quote=False)


def _po_entries(text: str, loose: bool):
    """msgid/msgstr: nếu msgstr đã có chữ (file của một ngôn ngữ) thì dịch msgstr, không thì dịch msgid → ghi vào msgstr."""
    lines = list(re.finditer(r"[^\n]*\n?", text))
    blocks = []      # (field, start, end, value)
    cur = None
    for m in lines:
        s = m.group(0).strip()
        f = re.match(r'(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")\s*$', s)
        if f:
            cur = [f.group(1), m.start(), m.end(), _po_str(f.group(2))]
            blocks.append(cur)
        elif s.startswith('"') and cur:
            cur[2] = m.end()
            cur[3] += _po_str(s)
        else:
            cur = None
    pairs = []
    for i, b in enumerate(blocks):
        if b[0] == "msgid":
            st = next((x for x in blocks[i + 1:i + 3] if x[0].startswith("msgstr")), None)
            ctx = blocks[i - 1][3] if i and blocks[i - 1][0] == "msgctxt" else ""
            if st and b[3]:
                pairs.append((b, st, ctx))
    use_str = sum(1 for _b, st, _c in pairs if textlike(st[3], True)) > len(pairs) / 2
    for b, st, ctx in pairs:
        src = st[3] if use_str else b[3]
        if textlike(src, True):
            nl = "\n" if text[st[1]:st[2]].endswith("\n") else ""
            yield st[1], st[2], src, ctx or b[3][:40], (lambda v, f=st[0], nl=nl: f'{f} {_po_q(v)}{nl}')


def _po_str(q: str) -> str:
    try:
        return json.loads(q)
    except ValueError:
        return q.strip('"')


def _po_q(v: str) -> str:
    return json.dumps(v, ensure_ascii=False)


def _kv_entries(text: str, loose: bool, props: bool = False):
    for m in re.finditer(r"(?m)^[ \t]*([^\s=:#;\[!/][^=:\n]*?)[ \t]*[=:][ \t]*(.*?)[ \t]*\r?$", text):
        key, val = m.group(1), m.group(2)
        if not val:
            continue
        s, e = m.start(2), m.end(2)
        q = ""
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            q, val, s, e = val[0], val[1:-1], s + 1, e - 1
        v = val
        if props:
            v = re.sub(r"\\u([0-9a-fA-F]{4})", lambda x: chr(int(x.group(1), 16)), v)
        if SKIP_KEYS.match(key.strip()) and " " not in v:
            continue
        if textlike(v, loose):
            enc = (lambda x: x.replace("\\", "\\\\").replace(q, "\\" + q).replace("\n", "\\n")) if q else (lambda x: x.replace("\n", "\\n"))
            yield s, e, v, key.strip()[:60], enc


def _strings_entries(text: str, loose: bool):
    for m in re.finditer(r'(?m)^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;', text):
        v = _po_str('"' + m.group(2) + '"')
        if textlike(v, True):
            yield m.start(2), m.end(2), v, m.group(1)[:60], lambda x: json.dumps(x, ensure_ascii=False)[1:-1]


def _yaml_entries(text: str, loose: bool):
    for m in re.finditer(r"""(?m)^([ \t]*(?:-[ \t]+)?)([\w\-. ]+):[ \t]+(?!["']?[|>&*!{\[])("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#\n][^\n]*?)[ \t]*(?:#[^\n]*)?\r?$""", text):
        raw = m.group(3)
        if raw.startswith('"'):
            v = _po_str(raw)
        elif raw.startswith("'"):
            v = raw[1:-1].replace("''", "'")
        else:
            v = raw
        if SKIP_KEYS.match(m.group(2).strip()) and " " not in v:
            continue
        if textlike(v, loose):
            yield m.start(3), m.end(3), v, m.group(2).strip()[:60], lambda x: json.dumps(x, ensure_ascii=False)


def _ks_entries(text: str, loose: bool):
    """TyranoScript / KAG (.ks): dòng chữ là dòng không bắt đầu bằng ; * @ #, bỏ qua [iscript]…[endscript]."""
    skip = False
    who = ""
    for m in re.finditer(r"[^\r\n]+", text):
        line = m.group(0)
        s = line.strip()
        low = s.lower()
        if re.match(r"\[(iscript|html|macro)\b", low):
            skip = True
        if re.match(r"\[(endscript|endhtml|endmacro)\]", low):
            skip = False
            continue
        if skip or not s or s[0] in ";*@":
            continue
        if s.startswith("#"):
            who = s[1:].split(":")[0].strip()
            continue
        bare = re.sub(r"\[[^\]]*\]", "", s).strip()
        if bare and textlike(bare, True):
            lead = len(line) - len(line.lstrip())
            yield m.start() + lead, m.start() + lead + len(s), s, who, lambda x: x.replace("\n", "[r]")


def _lines_entries(text: str, loose: bool):
    for m in re.finditer(r"[^\r\n]+", text):
        s = m.group(0)
        if s.strip() and not s.lstrip().startswith(("#", "//", ";")) and textlike(s.strip(), True):
            lead = len(s) - len(s.lstrip())
            yield m.start() + lead, m.start() + lead + len(s.strip()), s.strip(), "", lambda x: x.replace("\n", " ")


# ---------------------------------------------------------------- CSV / TSV: chọn cột ngôn ngữ gốc
def _sniff_delim(text: str, ext: str) -> str:
    if ext in (".tsv", ".tab"):
        return "\t"
    head = text[:5000]
    best = max([",", "\t", ";", "|"], key=lambda d: head.count(d))
    return best if head.count(best) else ","


def csv_table(text: str, ext: str) -> tuple[list[list[str]], str]:
    d = _sniff_delim(text, ext)
    rows = list(csv.reader(io.StringIO(text, newline=""), delimiter=d))
    return rows, d


def csv_pick(rows: list[list[str]], prefer: str = "en") -> tuple[int, int, str, dict]:
    """(cột gốc, hàng bắt đầu, ngôn ngữ, {mã: cột}) – cột có tiêu đề ngôn ngữ thì chọn theo tiêu đề, không thì cột nhiều chữ nhất."""
    if not rows:
        return -1, 0, "", {}
    head = rows[0]
    cols: dict[str, int] = {}
    for i, h in enumerate(head):
        k = h.strip().lower().replace(" ", "")
        m = re.fullmatch(r"(?:text_?|lang_?|value_?)?([a-z]{2,10}(?:[-_][a-z]{2,4})?)(?:\(.*\))?", k)
        if m and m.group(1) in _TOKEN_LANG:
            cols.setdefault(_TOKEN_LANG[m.group(1)], i)
        elif re.search(r"(english|japanese|chinese|korean|french|german|spanish)", k):
            cols.setdefault(_TOKEN_LANG[re.search(r"(english|japanese|chinese|korean|french|german|spanish)", k).group(1)], i)
    if cols:
        for want in (prefer, "en", "ja", "zh", "ko"):
            if want in cols:
                return cols[want], 1, want, cols
        k = next(iter(cols))
        return cols[k], 1, k, cols
    width = max(len(r) for r in rows[:200])
    best, score = -1, 0
    for c in range(width):
        vals = [r[c] for r in rows[1:400] if c < len(r)]
        n = sum(1 for v in vals if textlike(v, True)) + sum(2 for v in vals if textlike(v) and " " in v.strip())
        if n > score:
            best, score = c, n
    start = 0 if best >= 0 and len(rows) and textlike(rows[0][best] if best < len(rows[0]) else "", False) else 1
    return best, start, "", {}


def csv_write(rows: list[list[str]], delim: str, text_sample: str) -> str:
    out = io.StringIO()
    allq = bool(re.match(r'^"[^"]*"' + re.escape(delim) + '"', text_sample))
    nl = "\r\n" if "\r\n" in text_sample[:20000] else "\n"
    w = csv.writer(out, delimiter=delim, quoting=csv.QUOTE_ALL if allq else csv.QUOTE_MINIMAL, lineterminator=nl)
    w.writerows(rows)
    return out.getvalue()


PARSERS = {".json": _json_entries, ".xml": _xml_entries, ".resx": _xml_entries, ".po": _po_entries,
           ".ini": _kv_entries, ".cfg": _kv_entries, ".lang": _kv_entries, ".loc": _kv_entries,
           ".properties": lambda t, l: _kv_entries(t, l, True), ".strings": _strings_entries, ".yaml": _yaml_entries,
           ".yml": _yaml_entries, ".ks": _ks_entries}


def sniff_fmt(text: str, ext: str) -> str:
    """Định dạng của nội dung (dùng cho TextAsset Unity không có đuôi file, hoặc .txt)."""
    t = text.lstrip("﻿ \t\r\n")[:4000]
    if ext in (".csv", ".tsv", ".tab"):
        return ext
    if ext in PARSERS and ext not in (".loc", ".lang"):
        return ext
    if t[:1] in "{[":
        try:
            json.loads(text.lstrip("﻿"))
            return ".json"
        except ValueError:
            pass
    if t.startswith("<"):
        return ".xml"
    if re.search(r'(?m)^msgid\s+"', t):
        return ".po"
    lines = [x for x in t.splitlines() if x.strip()][:60]
    if lines:
        if sum(1 for x in lines if re.match(r"\s*[^\s=:#;]+[^=:]*?\s*[=:]\s*\S", x)) >= len(lines) * 0.6:
            return ".ini"
        d = max([",", "\t", ";", "|"], key=lambda c: sum(x.count(c) for x in lines))
        counts = [x.count(d) for x in lines]
        if counts and min(counts) >= 1 and max(counts) - min(counts) <= 2:
            return ".csv"
        if re.search(r"(?m)^\[(p|r|l|cm|chara_\w+)\]|^\*\w+", t):
            return ".ks"
    return ".txt"


def entries(text: str, fmt: str, loose: bool, prefer: str = "en", col: int | None = None):
    """Danh sách (start, end, text, ctx, encoder) – hoặc với CSV: ('csv', rows, delim, col, start)."""
    if fmt in (".csv", ".tsv", ".tab"):
        rows, d = csv_table(text, fmt)
        c, start, lang, cols = csv_pick(rows, prefer)
        if col is not None:
            c = col
        if c < 0:
            return {"csv": True, "rows": rows, "delim": d, "col": c, "start": start, "items": [], "cols": cols, "lang": lang}
        items = []
        for r_i in range(start, len(rows)):
            r = rows[r_i]
            if c < len(r) and textlike(r[c], True):
                items.append((r_i, r[c], r[0] if c != 0 and r else ""))
        return {"csv": True, "rows": rows, "delim": d, "col": c, "start": start, "items": items, "cols": cols, "lang": lang}
    fn = PARSERS.get(fmt) or (_lines_entries if loose else None)
    if not fn:
        return []
    out, last = [], -1
    for e in fn(text, loose):
        if e[0] >= last:               # không chồng lấn
            out.append(e)
            last = e[1]
    return out


def replace(text: str, ents, tr: dict[str, str], fmt: str) -> tuple[str, int]:
    if isinstance(ents, dict):
        rows, n = ents["rows"], 0
        for r_i, src, _ in ents["items"]:
            v = tr.get(src)
            if v:
                rows[r_i][ents["col"]] = v
                n += 1
        return (csv_write(rows, ents["delim"], text) if n else text), n
    parts, pos, n = [], 0, 0
    for s, e, src, _ctx, enc in ents:
        v = tr.get(src)
        if not v:
            continue
        parts.append(text[pos:s])
        parts.append(enc(v))
        pos = e
        n += 1
    parts.append(text[pos:])
    return "".join(parts), n


def texts_of(ents) -> list[tuple[str, str]]:
    if isinstance(ents, dict):
        return [(src, ctx) for _r, src, ctx in ents["items"]]
    return [(e[2], e[3]) for e in ents]


# ================================================================== quét thư mục game
def _engine_markers(root: Path, names: set[str], exts: Counter, dirs: set[str]) -> list[str]:
    hints = []
    if exts[".pak"] or exts[".utoc"]:
        hints.append("Unreal Engine: chữ nằm trong file .pak (thường đóng gói/mã hóa) – app không mở được. Dùng Dịch màn hình game.")
    if exts[".pck"]:
        hints.append("Godot: chữ nằm trong file .pck – app chưa mở được. Dùng Dịch màn hình game.")
    if "data.win" in names:
        hints.append("GameMaker: chữ nằm trong data.win – app chưa mở được. Dùng Dịch màn hình game.")
    if exts[".xp3"]:
        hints.append("Kirikiri: kịch bản nằm trong file .xp3. Nếu nhóm dịch/công cụ đã giải nén ra file .ks thì chọn thư mục đó.")
    if exts[".wolf"]:
        hints.append("Wolf RPG Editor: dữ liệu .wolf được mã hóa – app không mở. Dùng Dịch màn hình game.")
    if exts[".rgss3a"] or exts[".rgss2a"] or exts[".rgssad"] or exts[".rvdata2"]:
        hints.append("RPG Maker VX/VX Ace/XP: dữ liệu Ruby (.rvdata2/.rgss3a) – app chưa đọc được. Dùng Dịch màn hình game.")
    if "app.asar" in names or "package.nw" in names:
        hints.append("Game HTML5 đóng gói (app.asar / package.nw): app chưa mở gói này.")
    return hints


def game_root(path: Path) -> Path:
    if path.is_file():
        path = path.parent
    if path.name.lower() in ("game", "www") or path.name.endswith("_Data"):
        if any(path.parent.glob("*.exe")) or any(path.parent.glob("*.sh")) or any(path.parent.glob("*.app")):
            return path.parent
    return path


def new_job(path: str, prefer: str, specials) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "path": path, "phase": "start", "text": "Đang bắt đầu…", "done": 0, "total": 0, "current": "",
           "found": 0, "strings": 0, "state": "running", "started": time.time(), "result": None, "error": None, "_items": {}}
    with _jobs_lock:
        for k in [k for k, j in _jobs.items() if time.time() - j["started"] > 6 * 3600]:
            _jobs.pop(k, None)
        _jobs[jid] = job
    threading.Thread(target=_run_job, args=(job, prefer, specials), daemon=True, name="langscan").start()
    return jid


def get_job(jid: str) -> dict | None:
    return _jobs.get(jid)


def public_job(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def cancel(jid: str):
    j = _jobs.get(jid)
    if j:
        j["cancel"] = True


def _run_job(job: dict, prefer: str, specials):
    try:
        job["result"] = scan_folder(Path(job["path"]), job, prefer, specials)
        job["state"] = "done"
        job["phase"] = "done"
    except Exception as e:      # lỗi gì cũng báo lên thanh tiến độ
        job["state"] = "error"
        job["error"] = str(e) if isinstance(e, (OSError, ValueError, RuntimeError)) else f"{type(e).__name__}: {e}"


def scan_folder(path: Path, job: dict, prefer: str = "en", specials=None) -> dict:
    """specials(root, job) → danh sách nguồn đặc biệt (Ren'Py / RPG Maker / Unity Localization) do gametr cung cấp."""
    if not path.exists():
        raise ValueError("Không thấy thư mục này.")
    root = game_root(path)
    job.update(phase="list", text="Đang liệt kê file trong thư mục game…")
    files: list[tuple[Path, int]] = []
    names: set[str] = set()
    dirs: set[str] = set()
    exts: Counter = Counter()
    for dp, dn, fn in os.walk(root):
        if job.get("cancel"):
            raise ValueError("Đã dừng tìm.")
        dn[:] = [d for d in dn if d.lower() not in SKIP_DIRS and not d.startswith(".")]
        dirs.update(d.lower() for d in dn)
        for f in fn:
            p = Path(dp) / f
            ext = p.suffix.lower()
            names.add(f.lower())
            exts[ext] += 1
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if (ext in TEXT_EXT and size <= MAX_TEXT) or (ext in (".assets", ".bundle") and size <= MAX_ASSET) \
                    or (f.lower() in ("resources.assets", "globalgamemanagers", "level0") and size <= MAX_ASSET):
                files.append((p, size))
        job["current"] = str(Path(dp).relative_to(root)) if Path(dp) != root else ""
        job["total"] = len(files)
    hints = _engine_markers(root, names, exts, dirs)
    sources: list[dict] = []
    covered: set[str] = set()
    if specials:
        job.update(phase="engine", text="Đang nhận loại game…")
        for s in specials(root, job) or []:
            items = s.pop("_items", [])
            covered.update(s.pop("_covers", []))
            job.setdefault("_infos", {})[s["id"]] = s.pop("_info", {})
            job["_items"][s["id"]] = items
            sources.append(s)
            job["found"] += 1
            job["strings"] += s["count"]
    unity = any(d.name.endswith("_Data") for d in root.iterdir() if d.is_dir())
    job.update(phase="files", text="Đang lục file chữ…", done=0, total=len(files))
    total_bytes = sum(sz for _, sz in files) or 1
    seen_bytes = 0
    n = 0
    for p, size in files:
        if job.get("cancel"):
            raise ValueError("Đã dừng tìm.")
        rel = str(p.relative_to(root)).replace("\\", "/")
        job["current"] = rel
        job["done"] += 1
        seen_bytes += size
        job["bytes"] = round(seen_bytes / total_bytes, 4)
        if rel in covered or any(rel.startswith(c.rstrip("/") + "/") for c in covered if c.endswith("/")):
            continue
        if SKIP_FILES.match(p.name):
            continue
        ext = p.suffix.lower()
        try:
            if ext in TEXT_EXT:
                src = _scan_text(root, p, rel, prefer)
                if src:
                    n += 1
                    src["id"] = f"f{n}"
                    job["_items"][src["id"]] = src.pop("_items")
                    sources.append(src)
                    job["found"] += 1
                    job["strings"] += src["count"]
            elif unity:
                for src in _scan_unity_asset(root, p, rel, prefer, job):
                    n += 1
                    src["id"] = f"u{n}"
                    job["_items"][src["id"]] = src.pop("_items")
                    sources.append(src)
                    job["found"] += 1
                    job["strings"] += src["count"]
        except (OSError, ValueError, UnicodeError, csv.Error, MemoryError):
            continue
    _choose(sources, prefer)
    langs = Counter()
    for s in sources:
        if s.get("on"):
            langs[s.get("lang")] += s["count"]
    name = root.name
    job.update(phase="done", text="Xong", current="")
    return {"root": str(root), "name": name, "sources": sources, "hints": hints if not any(s.get("on") for s in sources) else hints[:1],
            "lang": langs.most_common(1)[0][0] if langs else prefer, "files": len(files)}


def _choose(sources: list[dict], prefer: str):
    """Bật sẵn file của ngôn ngữ gốc (ưu tiên ngôn ngữ trong cài đặt, rồi tiếng Anh) và chỉ file đáng tin là file ngôn ngữ."""
    if any(s["kind"] in ("renpy", "rpg", "unity-loc") for s in sources):
        for s in sources:
            s["on"] = s["kind"] in ("renpy", "rpg", "unity-loc")
            if not s["on"] and not s.get("why"):
                s["why"] = "Thêm nếu chữ này chưa có trong phần kịch bản chính"
        return
    have = Counter(s["lang"] for s in sources if s.get("loc"))
    want = prefer if have.get(prefer) else ("en" if have.get("en") else (have.most_common(1)[0][0] if have else prefer))
    for s in sources:
        good = s.get("loc") and s["lang"] == want and s["count"] >= 2
        s["on"] = bool(good)
        if not s.get("why"):
            if s["lang"] != want:
                s["why"] = f"Bản {LANG_NAMES.get(s['lang'], s['lang'])} – chỉ dịch một ngôn ngữ gốc"
            elif not s.get("loc"):
                s["why"] = "File dữ liệu, không chắc là chữ hiển thị – chỉ chọn nếu bạn chắc"


def _scan_text(root: Path, p: Path, rel: str, prefer: str) -> dict | None:
    raw = _src(root, p).read_bytes()
    text, enc = decode(raw)
    ext = p.suffix.lower()
    fmt = sniff_fmt(text, ext) if ext in (".txt", ".loc", ".lang") else ext
    loc = is_loc_path(rel)
    ents = entries(text, fmt, loc, prefer)
    pairs = texts_of(ents)
    if len(pairs) < (2 if loc else 4):
        return None
    sentences = sum(1 for t, _ in pairs if " " in t.strip() or script_lang(t) in ("ja", "zh", "ko"))
    if not loc and sentences < max(4, len(pairs) * 0.3):
        return None
    tok = lang_token(rel)
    lang = (ents.get("lang") if isinstance(ents, dict) and ents.get("lang") else None) or tok or lang_of_texts([t for t, _ in pairs])
    if lang == "latin":
        lang = guess_latin([t for t, _ in pairs])
    if tok and tok != "latin" and script_lang(pairs[0][0]) in ("ja", "zh", "ko") and tok not in ("ja", "zh", "ko"):
        lang = lang_of_texts([t for t, _ in pairs])
    src = {"kind": "file", "rel": rel, "fmt": fmt, "enc": enc, "count": len(pairs), "lang": lang, "loc": loc, "loose": loc,
           "label": rel, "sample": [t[:120] for t, _ in pairs[:3]], "size": p.stat().st_size,
           "_items": [{"t": t, "kind": "ui", "ctx": (ctx or Path(rel).name)[:80]} for t, ctx in pairs]}
    if isinstance(ents, dict):
        src["col"] = ents["col"]
        if ents.get("cols"):
            src["cols"] = ents["cols"]
    if enc in ("cp932", "gbk", "cp949"):
        src["why"] = f"File mã {enc.upper()}: app sẽ ghi lại bằng UTF-8, game cũ có thể không đọc được"
    return src


# ---------------------------------------------------------------- Unity TextAsset
def _unitypy():
    try:
        import UnityPy  # noqa: N813
    except ImportError:
        return None
    return UnityPy


def _scan_unity_asset(root: Path, p: Path, rel: str, prefer: str, job: dict) -> list[dict]:
    UnityPy = _unitypy()
    if not UnityPy or re.search(r"(?i)string[-_ ]?tables?", p.name):
        return []
    try:
        env = UnityPy.load(str(_src(root, p)))
    except Exception:       # file hỏng / mã hóa / không phải file Unity
        return []
    out = []
    try:
        objs = [o for o in env.objects if o.type.name == "TextAsset"]
    except Exception:
        return []
    for o in objs:
        if job.get("cancel"):
            break
        try:
            d = o.read()
            script = d.m_Script
            name = d.m_Name
        except Exception:
            continue
        if not isinstance(script, str) or len(script) < 20 or len(script) > MAX_TEXT or "\x00" in script[:2000]:
            continue
        if any("\udc80" <= ch <= "\udcff" for ch in script[:4000]):     # dữ liệu nhị phân
            continue
        fmt = sniff_fmt(script, Path(name).suffix.lower())
        loc = is_loc_path(name) or fmt in (".csv", ".po", ".ks")
        ents = entries(script, fmt, loc, prefer)
        pairs = texts_of(ents)
        sentences = sum(1 for t, _ in pairs if " " in t.strip() or script_lang(t) in ("ja", "zh", "ko"))
        if len(pairs) < 3 or sentences < max(2, len(pairs) * 0.3):
            continue
        tok = lang_token(name)
        lang = (ents.get("lang") if isinstance(ents, dict) and ents.get("lang") else None) or tok or lang_of_texts([t for t, _ in pairs])
        src = {"kind": "textasset", "rel": rel, "path_id": int(o.path_id), "asset": name, "fmt": fmt, "count": len(pairs),
               "lang": lang, "loc": loc or sentences > len(pairs) * 0.6, "loose": loc, "label": f"{rel} → {name}",
               "sample": [t[:120] for t, _ in pairs[:3]], "size": len(script),
               "_items": [{"t": t, "kind": "ui", "ctx": (ctx or name)[:80]} for t, ctx in pairs]}
        if isinstance(ents, dict):
            src["col"] = ents["col"]
        out.append(src)
    return out


# ================================================================== áp dụng / khôi phục
def _src(root: Path, p: Path) -> Path:
    rel = p.relative_to(root)
    b = root / BACKUP_DIR / rel
    if b.exists():
        return b
    vh = root / PATCH_BACKUP
    if vh.is_dir():
        for d in sorted(vh.iterdir()):
            if (d / rel).is_file():
                return d / rel
    return p


def _backup(root: Path, p: Path):
    b = root / BACKUP_DIR / p.relative_to(root)
    if not b.exists():
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_src(root, p), b)


def _write(p: Path, data: bytes):
    tmp = p.with_name(p.name + ".cvtmp")
    tmp.write_bytes(data)
    os.replace(tmp, p)


def apply(root: Path, items: list[dict], sources: list[dict], prefer: str = "en") -> dict:
    tr = {it["t"]: it["final"] for it in items if it.get("final") and it["final"] != it["t"]}
    texts = files = 0
    errors = []
    by_asset: dict[str, list[dict]] = {}
    for s in sources:
        if s["kind"] == "textasset":
            by_asset.setdefault(s["rel"], []).append(s)
            continue
        if s["kind"] != "file":
            continue
        p = root / s["rel"]
        if not p.exists():
            errors.append(f"Không thấy {s['rel']}")
            continue
        text, enc = decode(_src(root, p).read_bytes())
        ents = entries(text, s["fmt"], bool(s.get("loose")), prefer, s.get("col"))
        new, n = replace(text, ents, tr, s["fmt"])
        if not n:
            continue
        _backup(root, p)
        _write(p, encode(new, enc))
        texts += n
        files += 1
    if by_asset:
        UnityPy = _unitypy()
        if not UnityPy:
            raise RuntimeError("Thiếu thư viện UnityPy để ghi file Unity.")
        for rel, lst in by_asset.items():
            p = root / rel
            if not p.exists():
                errors.append(f"Không thấy {rel}")
                continue
            env = UnityPy.load(str(_src(root, p)))
            want = {s["path_id"]: s for s in lst}
            hit = 0
            for o in env.objects:
                if o.path_id not in want or o.type.name != "TextAsset":
                    continue
                s = want[o.path_id]
                d = o.read()
                ents = entries(d.m_Script, s["fmt"], bool(s.get("loose")), prefer, s.get("col"))
                new, n = replace(d.m_Script, ents, tr, s["fmt"])
                if n:
                    d.m_Script = new
                    d.save()
                    hit += n
            if not hit:
                continue
            f = next(iter(env.files.values()))
            data = f.save(packer="lz4") if p.suffix.lower() == ".bundle" else f.save()
            _backup(root, p)
            _write(p, data)
            texts += hit
            files += 1
    return {"texts": texts, "files": files, "errors": errors}


def restore(root: Path, sources: list[dict]) -> int:
    n = 0
    for rel in {s["rel"] for s in sources if s.get("rel")}:
        b = root / BACKUP_DIR / rel
        if b.is_file():
            shutil.copy2(b, root / rel)
            n += 1
    return n
