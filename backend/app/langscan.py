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

from . import config, unityload

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
    # chỉ chữ riêng của tiếng Việt (â ê ô à é… cũng có trong tiếng Pháp/Bồ Đào Nha)
    if re.search(r"[ăđơưĩũĂĐƠƯĨŨ\u1ea0-\u1ef9]", s):
        return "vi"
    if re.search(r"[Ѐ-ӿ]", s):
        return "ru"
    if re.search(r"[A-Za-z]", s):
        return "latin"
    return None


# Chữ giao diện cơ bản của game (menu, cài đặt, nút): chữ một từ thường bị coi là tên/mã nên bỏ qua – các chữ này luôn nhận.
UI_WORDS = {w.lower() for w in """
New Game|Start|Start Game|Continue|Load|Load Game|Save|Save Game|Options|Settings|Setting|Quit|Exit|Quit Game|Quit to Desktop|Quit to Menu|
Quit to Title|Main Menu|Title Screen|Resume|Pause|Paused|Back|Return|Cancel|Confirm|Accept|Apply|OK|Yes|No|Close|Done|Next|Previous|Prev|
Skip|Retry|Restart|Reset|Default|Defaults|Reset to Default|Reset to Defaults|Restore Defaults|Credits|Extras|Gallery|Bestiary|Achievements|
Statistics|Stats|Language|Languages|Audio|Sound|Sounds|Music|Volume|Master|Master Volume|Music Volume|SFX|SFX Volume|Sound Effects|Voice|
Voices|Voice Volume|Ambience|Mute|Video|Display|Graphics|Resolution|Fullscreen|Full Screen|Windowed|Borderless|Window Mode|Screen Mode|
VSync|Vertical Sync|Quality|Low|Medium|High|Ultra|Very High|Very Low|Custom|Brightness|Contrast|Gamma|Frame Rate|Framerate|FPS Limit|
Anti-Aliasing|Antialiasing|Shadows|Textures|Effects|Post Processing|Bloom|Motion Blur|Screen Shake|Camera Shake|Vibration|Rumble|
Controls|Control|Controller|Gamepad|Keyboard|Mouse|Keyboard & Mouse|Key Bindings|Keybindings|Bindings|Remap|Rebind|Invert|Invert Y|
Sensitivity|Accessibility|Subtitles|Subtitle|Captions|Text Size|Text Speed|Font Size|Colorblind|Colorblind Mode|Gameplay|General|
Interface|HUD|Difficulty|Easy|Normal|Hard|Very Hard|Nightmare|Casual|Story|Story Mode|On|Off|Enabled|Disabled|Enable|Disable|
Inventory|Journal|Equipment|Equip|Unequip|Items|Item|Skills|
Abilities|Upgrades|Shop|Buy|Sell|Price|Gold|Level|Health|Mana|Hearts|Lives|Score|Time|Loading|Loading...|Saving|Saving...|Saved|
Game Over|Victory|Defeat|You Died|Press Any Key|Press any button|Selected|Equipped|Locked|Unlocked|New|Empty|Slot|
Save Slot|Delete|Overwrite|Are you sure?|Profile|Account|Help|Tutorial|Tips|Hint|Info|Information|Version|Feedback|Exit Game
""".replace("\n", "").split("|") if w.strip()}
UI_PLACEHOLDER = re.compile(r"(?i)^(new text|text|text \(tmp\)|sample text|button|label|placeholder|enter text\.*|lorem ipsum.*|"
                            r"title|header|description|name|value|x|-)$")


def ui_word(s: str) -> bool:
    t = re.sub(r"<[^<>]{1,40}>", "", s).strip().rstrip(":.!").strip()
    return 0 < len(t) <= 40 and t.lower() in UI_WORDS


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


LANG_KEY = re.compile(r"(?i)^(" + "|".join(sorted((re.escape(k) for k in _TOKEN_LANG), key=len, reverse=True))
                      + r"|en-?us|text_?en|text_?fr|text_?de|text_?es|text_?ja|text_?zh|text_?ko|text_?ru|text_?pt|text_?it)$")


def _key_lang(key: str) -> str | None:
    k = str(key).strip().rsplit("/", 1)[-1]
    if not LANG_KEY.match(k):
        return None
    k = re.sub(r"(?i)^text_?", "", k).lower()
    return _TOKEN_LANG.get(k) or _TOKEN_LANG.get(k.replace("-", "_")) or ("en" if k.startswith("en") else None)


def one_language(ents: list, prefer: str = "en") -> list:
    """File chứa nhiều ngôn ngữ theo khóa ({"en": "...", "fr": "...", "de": "..."}): chỉ giữ chữ của ngôn ngữ gốc."""
    langs = Counter(_key_lang(e[3]) for e in ents)
    langs.pop(None, None)
    if len(langs) < 2:
        return ents
    want = prefer if prefer in langs else ("en" if "en" in langs else langs.most_common(1)[0][0])
    return [e for e in ents if _key_lang(e[3]) in (None, want)]


_DEBUG = re.compile(r"(?i)^\W*(todo|fixme|debug|test(ing)?|placeholder|lorem ipsum|missing|tbd|wip|xxx+|dummy|sample text|"
                    r"not translated|untranslated|no text|text here|insert text)\b")
_CODEY = re.compile(r"(==|!=|&&|\|\||=>|::|\)\s*;\s*$|^\s*(if|for|while|return|var|let|const|function|def|class|import|select|"
                    r"insert|update|delete)\b[^.!?]*[(={;]|\w+\s*\([^()]*\)\s*;)", re.I)
_DATEFMT = re.compile(r"[yMdHhmsftzK:/\-.,\s]+")


def suspect(t: str, ctx: str = "") -> str | None:
    """Lý do chuỗi có vẻ KHÔNG phải chữ hiển thị (mã, đường dẫn, chữ thử…) – app tự bỏ qua, người dùng bật lại được."""
    s = t.strip()
    if _DEBUG.match(s):
        return "chữ thử/ghi chú (debug, TODO…)"
    if _CODEY.search(s):
        return "giống mã lệnh"
    if re.search(r"[\w\-]+[/\\][\w\-.]+[/\\]", s) or re.search(r"(?i)\.(png|jpe?g|ogg|wav|mp3|prefab|asset|json|csv|ttf|otf|"
                                                                   r"unity|mat|anim|bundle|dll)\b", s):
        return "đường dẫn / tên file"
    if _DATEFMT.fullmatch(s) and re.search(r"yy|MM|dd|HH|hh|mm|ss", s):
        return "định dạng ngày giờ"
    if " " not in s and re.fullmatch(r"[\w.:\-]+", s, re.A):
        if re.fullmatch(r"(?i)[a-z]{1,6}\d*(?:[._:\-][a-z0-9]+)+", s) or (re.search(r"\d", s) and re.search(r"[A-Za-z]", s) and len(s) > 3):
            return "mã nội bộ"
        if re.search(r"[a-z][A-Z]", s):
            return "tên nội bộ"
    return None


def _json_entries(text: str, loose: bool):
    tok = re.compile(r'"(?:[^"\\\n]|\\.)*"')
    last_key = parent = ""
    for m in tok.finditer(text):
        j = m.end()
        while j < len(text) and text[j] in " \t\r\n":
            j += 1
        try:
            val = json.loads(m.group(0))
        except ValueError:
            continue
        if j < len(text) and text[j] == ":":
            if not _key_lang(val):
                parent = val
            last_key = val
            continue
        if last_key and SKIP_KEYS.match(str(last_key)) and " " not in val:
            continue
        if textlike(val, loose):
            ctx = f"{parent}/{last_key}" if parent and parent != last_key and _key_lang(last_key) else str(last_key)
            yield m.start(), m.end(), val, ctx[:60], lambda v: json.dumps(v, ensure_ascii=False)


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
    return one_language(out, prefer) if fmt in (".json", ".yaml", ".yml", ".xml", ".resx") else out


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
        hints.append("Unreal Engine: không tìm thấy bảng chữ .locres đọc được trong file .pak (pak mã hóa thì nhập khóa AES, "
                     "nén Oodle thì app chưa mở được). Dùng Dịch màn hình game.")
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


def new_job(path: str, prefer: str, specials, aes: str | None = None) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "path": path, "phase": "start", "text": "Đang bắt đầu…", "done": 0, "total": 0, "current": "",
           "found": 0, "strings": 0, "state": "running", "started": time.time(), "result": None, "error": None, "_items": {},
           "_aes": aes}
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
                    or ((f.lower() in ("resources.assets", "globalgamemanagers") or re.fullmatch(r"level\d+", f.lower()))
                        and size <= MAX_ASSET):
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
    if any(s["kind"] == "locres" for s in sources):
        hints = [h for h in hints if not h.startswith("Unreal")]
    langs = Counter()
    for s in sources:
        if s.get("on"):
            langs[s.get("lang")] += s["count"]
    name = root.name
    job.update(phase="done", text="Xong", current="")
    return {"root": str(root), "name": name, "sources": sources, "hints": hints if not any(s.get("on") for s in sources) else hints[:1],
            "lang": langs.most_common(1)[0][0] if langs else prefer, "files": len(files), "unity": unity,
            "warn": [w for w in job.get("_warn", []) if isinstance(w, str)][:6], "need_key": bool(job.get("need_key")),
            "unreal": any(s["kind"] == "locres" for s in sources) or bool(_ue_root(root))}


def _choose(sources: list[dict], prefer: str):
    """Bật sẵn file của ngôn ngữ gốc (ưu tiên ngôn ngữ trong cài đặt, rồi tiếng Anh) và chỉ file đáng tin là file ngôn ngữ."""
    if any(s["kind"] in ("renpy", "rpg", "unity-loc", "locres") for s in sources):
        for s in sources:
            s["on"] = s["kind"] in ("renpy", "rpg", "unity-loc", "locres")
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
        with unityload.open_env(_src(root, p)) as env:      # tự đóng file: không giữ file game mở (Windows sẽ không cho ghi đè)
            return _scan_unity_env(env, rel, prefer, job, root)
    except Exception:       # file hỏng / mã hóa / không phải file Unity
        return []


def _scan_unity_env(env, rel: str, prefer: str, job: dict, root: Path | None = None) -> list[dict]:
    out = []
    try:
        objs = [o for o in env.objects if o.type.name == "TextAsset"]
        monos = [o for o in env.objects if o.type.name == "MonoBehaviour" and 40 < o.byte_size < MB_MAX]
    except Exception:
        return []
    ui_ids, ui_texts = [], []
    for o in monos:
        if job.get("cancel"):
            break
        try:
            raw = o.get_raw_data()
            strs = mb_strings(raw)
        except Exception:
            continue
        if not strs:
            continue
        cls = script_class(o, raw, root, job) if root is not None else ""
        if cls in UI_TEXT_CLASSES:              # ô chữ trên nút / menu (TextMeshPro, UI.Text) đặt sẵn trong màn chơi
            got = [x for _, _, x in strs if ui_text_ok(x, prefer)]
            if got:
                ui_ids.append(int(o.path_id))
                ui_texts += got
            continue
        if len(strs) < 4:
            continue
        sentences = mb_pick(strs, prefer, False)
        if sum(1 for x in sentences if not ui_word(x)) < 3 or NOT_TEXT_CLASS.search(cls):   # cần ≥3 câu thật, không phải bảng phím
            continue
        af = getattr(o, "assets_file", None)
        label = _mb_label(af, o, raw)
        rich = len(sentences) >= 20 or bool(MB_HINT.search(label))
        texts = list(dict.fromkeys(mb_pick(strs, prefer, rich)))
        lang = lang_of_texts(texts)
        out.append({"kind": "mono", "rel": rel, "path_id": int(o.path_id), "asset": label, "fmt": "mono", "count": len(texts),
                    "lang": prefer if lang == "latin" else lang, "loc": rich, "loose": rich, "label": f"{rel} → {label}",
                    "sample": [t[:120] for t in texts[:3]], "size": len(raw),
                    "_items": [{"t": t, "kind": "ui" if len(t) < 30 and " " not in t.strip() else "say", "ctx": label[:80]} for t in texts]})
    if ui_ids:
        texts = list(dict.fromkeys(ui_texts))
        out.append({"kind": "mono", "rel": rel, "path_id": ui_ids[0], "path_ids": ui_ids, "asset": "Chữ trên nút / menu", "fmt": "mono",
                    "count": len(texts), "lang": prefer, "loc": True, "loose": True, "ui": True,
                    "label": f"{rel} → chữ trên nút / menu ({len(ui_ids)} ô chữ)", "sample": [t[:120] for t in texts[:3]], "size": 0,
                    "_items": [{"t": t, "kind": "ui", "ctx": "nút / menu giao diện"} for t in texts]})
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


# ---------------------------------------------------------------- Unity MonoBehaviour (I2 Localization, hội thoại, ScriptableObject…)
# Không cần typetree: chuỗi Unity lưu dạng int32 độ dài + UTF-8 + đệm 0 cho tròn 4 byte. Dò mọi vị trí chia hết cho 4 có dạng đó
# (đệm phải là 0, chữ phải là câu), rồi ghi lại cả đối tượng với chuỗi mới (đổi độ dài + đệm lại) – các trường khác giữ nguyên.
_MB_CAND = re.compile(rb"(?=[\x02-\xff][\x00-\x4e]\x00\x00[\x09\x0a\x20-\x7e\xc2-\xf4])", re.S)
MB_MAX = 40 * 1024 * 1024
MB_HINT = re.compile(r"(?i)(i2|languag|locali[sz]|translat|dialog|dialogue|conversation|quest|story|text|string|subtitle|"
                     r"message|tutorial|item|lore|journal|book|codex|mail|chat|talk|scenario|script|naninovel|yarn|ink|fungus|lang)")


def mb_strings(raw: bytes, base: int = 0) -> list[tuple[int, int, str]]:
    """(vị trí, số byte, chuỗi) của các chuỗi Unity hợp lệ trong dữ liệu thô của một đối tượng."""
    out, end_prev, n = [], -1, len(raw)
    for m in _MB_CAND.finditer(raw):
        i = m.start()
        if (i - base) % 4 or i < end_prev:
            continue
        ln = int.from_bytes(raw[i:i + 4], "little")
        j = i + 4 + ln
        pad = (-(4 + ln)) % 4
        if j + pad > n or raw[j:j + pad].strip(b"\x00"):
            continue
        try:
            s = raw[i + 4:j].decode("utf-8")
        except UnicodeDecodeError:
            continue
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f�]", s):
            continue
        out.append((i, ln, s))
        end_prev = j + pad
    return out


def mb_pick(strs: list[tuple[int, int, str]], prefer: str, loose: bool) -> list[str]:
    """Chuỗi là câu chữ hiển thị, đúng ngôn ngữ gốc (bỏ tên trường, khóa, đường dẫn, ngôn ngữ khác)."""
    keep = []
    for _, _, s in strs:
        if not textlike(s, loose):       # chữ một từ (Settings, Back…) chỉ nhận ở bảng chữ lớn; nút/menu lấy từ ô chữ TextMeshPro
            continue
        sl = script_lang(s)
        if prefer in ("ja", "zh", "ko"):
            if sl != prefer:
                continue
        elif sl != "latin" or (prefer == "en" and not _maybe_en(s)) or (len(s) > 25 and guess_latin([s]) not in ("en", prefer)):
            continue
        keep.append(s)
    return keep


_ACCENT = re.compile(r"[àâçéèêëîïôûùüÿñæœäößãõíóúìåøąęłńśźżčřšžőű¿¡]", re.I)


def _maybe_en(s: str) -> bool:
    """Câu có thể là tiếng Anh: không dấu của Pháp/Đức/Tây Ban Nha…, từ thông dụng tiếng Anh không ít hơn ngôn ngữ khác."""
    if _ACCENT.search(s):
        return False
    words = re.findall(r"[a-z']+", s.lower())
    en = sum(w in STOP["en"] for w in words)
    other = max(sum(w in st for w in words) for k, st in STOP.items() if k != "en")
    return en >= other or other < 1


def _mb_ok(src: dict):
    """Chuỗi nào trong MonoBehaviour được thay. Bản dịch là của cả dự án, nên một từ như "Options", "Back" có thể trùng
    tên khóa / tên cảnh / tên đối tượng mà mã game tra cứu – thay vào là game đứng. Chỉ thay chuỗi trông như chữ hiển thị;
    chữ một từ chỉ thay trong ô chữ giao diện (TextMeshPro / UI.Text), bảng chữ lớn (loose) hoặc nguồn người dùng tự thêm."""
    loose = bool(src.get("loose"))
    words = bool(src.get("ui") or src.get("user") or loose)

    def ok(s: str) -> bool:
        if not s.strip() or suspect(s):
            return False
        if not re.search(r"\s", s.strip()):
            return words and (ui_word(s) or textlike(s, True))
        return textlike(s, loose) or textlike(s, True) and words
    return ok


def mb_rewrite(raw: bytes, tr: dict[str, str], base: int = 0, ok=None) -> tuple[bytes, int]:
    out, pos, n = bytearray(), 0, 0
    for i, ln, s in mb_strings(raw, base):
        v = tr.get(s)
        if not v:
            continue
        if ok is not None and (i - base == 28 or not ok(s)):     # 28 = m_Name của MonoBehaviour: tên đối tượng, không phải chữ
            continue
        b = v.encode("utf-8")
        out += raw[pos:i] + len(b).to_bytes(4, "little") + b + b"\x00" * ((-(4 + len(b))) % 4)
        pos = i + 4 + ln + (-(4 + ln)) % 4
        n += 1
    out += raw[pos:]
    return bytes(out), n


def _mb_label(env_file, o, raw: bytes) -> str:
    name = ""
    try:
        name = o.peek_name() or ""
    except Exception:
        name = ""
    if not name and len(raw) > 32:
        ln = int.from_bytes(raw[28:32], "little")
        if 0 < ln < 200:
            name = raw[32:32 + ln].decode("utf-8", "replace")
    cls = ""
    try:                                       # m_Script → MonoScript.m_ClassName (cùng file)
        fid = int.from_bytes(raw[16:20], "little")
        pid = int.from_bytes(raw[20:28], "little", signed=True)
        if fid == 0 and env_file is not None:
            ms = env_file.objects.get(pid)
            if ms is not None and ms.type.name == "MonoScript":
                d = ms.read()
                cls = ".".join(x for x in (getattr(d, "m_Namespace", ""), getattr(d, "m_ClassName", "")) if x)
    except Exception:
        cls = ""
    return " · ".join(x for x in (name, cls) if x) or f"MonoBehaviour #{o.path_id}"


NOT_TEXT_CLASS = re.compile(r"(?i)InputSystem|InputAction|Rewired|PlayerInput|Animator|Timeline|Shader|Material|AudioMixer")
UI_TEXT_CLASSES = {"TMPro.TextMeshProUGUI", "TMPro.TextMeshPro", "UnityEngine.UI.Text", "TMPro.TMP_Text", "UnityEngine.UI.Legacy.Text"}


def _script_names(env) -> dict[int, str]:
    return {pid: c for (_f, pid), c in _script_names_by_file(env).items()}


def _script_names_by_file(env) -> dict[tuple[str, int], str]:
    out = {}
    objs = env.objects
    for o in (objs.values() if isinstance(objs, dict) else objs):    # Environment: list, SerializedFile: dict
        if o.type.name != "MonoScript":
            continue
        try:
            d = o.read()
            af = getattr(o, "assets_file", None)
            out[(str(getattr(af, "name", "") or "").lower(), int(o.path_id))] = \
                ".".join(x for x in (getattr(d, "m_Namespace", ""), getattr(d, "m_ClassName", "")) if x)
        except Exception:       # đối tượng hỏng
            continue
    return out


def _load_scripts(root: Path, name: str, cache: dict):
    """MonoScript của file ngoài: globalgamemanagers(.assets) trong <Game>_Data, hoặc bundle Addressables (CAB-…) –
    Addressables để MonoScript trong bundle riêng *monoscripts*.bundle."""
    cache[name] = {}
    datas = [x for x in root.iterdir() if x.is_dir() and x.name.endswith("_Data")]
    for d in datas:
        f = d / name
        if f.is_file():
            try:
                with unityload.open_env(_src(root, f)) as env:
                    cache[name] = _script_names(env)
            except Exception:       # không đọc được
                pass
            return
    if name.startswith("cab-") and not cache.get("_cab_done"):
        cache["_cab_done"] = True
        for d in datas:
            for f in sorted((d / "StreamingAssets").rglob("*.bundle")) if (d / "StreamingAssets").is_dir() else []:
                if "monoscript" not in f.name.lower():
                    continue
                try:
                    with unityload.open_env(_src(root, f)) as env:
                        for (fname, pid), c in _script_names_by_file(env).items():
                            cache.setdefault(fname, {})[pid] = c
                except Exception:       # không đọc được
                    continue


def script_class(o, raw: bytes, root: Path | None, job: dict) -> str:
    """Tên lớp C# của MonoBehaviour (vd TMPro.TextMeshProUGUI) theo m_Script – MonoScript nằm cùng file, trong
    globalgamemanagers.assets (game đã build, kể cả IL2CPP) hoặc bundle monoscripts (Addressables). Nhớ trong job["_scripts"]."""
    if len(raw) < 28:
        return ""
    fid = int.from_bytes(raw[16:20], "little")
    pid = int.from_bytes(raw[20:28], "little", signed=True)
    af = getattr(o, "assets_file", None)
    cache = job.setdefault("_scripts", {})
    try:
        if fid == 0:
            key = f"self:{getattr(af, 'name', '')}:{id(af)}"
            if key not in cache:
                cache[key] = _script_names(af) if af is not None else {}
            return cache[key].get(pid, "")
        ext = af.externals[fid - 1]
        name = re.split(r"[\\/:]", getattr(ext, "path", "") or "")[-1].lower()
    except Exception:       # không có thông tin file ngoài
        return ""
    if name and name not in cache and root is not None:
        _load_scripts(root, name, cache)
    return (cache.get(name) or {}).get(pid, "")


def ui_text_ok(s: str, prefer: str) -> bool:
    """Chữ trong ô chữ giao diện: bỏ chữ giữ chỗ (New Text…), số, mã; đúng ngôn ngữ gốc."""
    t = s.strip()
    if not t or UI_PLACEHOLDER.match(t) or not textlike(t, True) or suspect(t):
        return False
    sl = script_lang(t)
    if prefer in ("ja", "zh", "ko"):
        return sl == prefer
    return sl == "latin" and (prefer != "en" or _maybe_en(t) or ui_word(t))


def _ue_root(root: Path) -> Path | None:
    """Thư mục <Tên game>/Content/Paks của game Unreal Engine (nếu có)."""
    for d in [root, *[x for x in root.iterdir() if x.is_dir()]]:
        if (d / "Content" / "Paks").is_dir():
            return d
    return None


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
    config.write_file(p, data)            # thử lại / bỏ thuộc tính chỉ đọc / ghi thẳng khi Windows không cho thay file


def apply(root: Path, items: list[dict], sources: list[dict], prefer: str = "en", prog=None) -> dict:
    """prog(chữ, đã xong, tổng): báo tiến độ cho trang (áp dụng file Unity lớn mất vài chục giây)."""
    prog = prog or (lambda *a: None)
    tr = {it["t"]: it["final"] for it in items if it.get("final") and it["final"] != it["t"]}
    texts = files = 0
    errors = []
    by_asset: dict[str, list[dict]] = {}
    for s in sources:
        if s["kind"] in ("textasset", "mono"):
            by_asset.setdefault(s["rel"], []).append(s)
            continue
        if s["kind"] != "file":
            continue
        prog(f"Đang ghi {s['rel']}", None, None)
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
        for k, (rel, lst) in enumerate(by_asset.items()):
            prog(f"Đang ghi {rel} (file Unity {k + 1}/{len(by_asset)})", k, len(by_asset))
            p = root / rel
            if not p.exists():
                errors.append(f"Không thấy {rel}")
                continue
            _backup(root, p)                  # đọc từ bản sao lưu, không đọc chính file sắp ghi đè
            with unityload.open_env(_src(root, p)) as env:
                data, hit = _apply_env(env, lst, tr, prefer, p)
            if not hit:
                continue
            if p.suffix.lower() == ".bundle":
                from . import unitygame
                if not unitygame.crc_off(root, p):      # Addressables từ chối bundle sai CRC → game đứng lúc tải
                    errors.append(f"{rel}: không tắt được kiểm tra CRC của game nên giữ bản gốc (để game không bị đứng).")
                    continue
            _write(p, data)
            texts += hit
            files += 1
    return {"texts": texts, "files": files, "errors": errors}


def _apply_env(env, lst: list[dict], tr: dict, prefer: str, p: Path) -> tuple[bytes, int]:
    want = {}
    for s in lst:
        for pid in s.get("path_ids") or [s["path_id"]]:
            want[pid] = s
    hit = 0
    for o in env.objects:
        if o.path_id not in want:
            continue
        s = want[o.path_id]
        if s["kind"] == "mono" and o.type.name == "MonoBehaviour":
            raw, n = mb_rewrite(o.get_raw_data(), tr, ok=_mb_ok(s))
            if n:
                o.set_raw_data(raw)
                hit += n
            continue
        if o.type.name != "TextAsset":
            continue
        d = o.read()
        ents = entries(d.m_Script, s["fmt"], bool(s.get("loose")), prefer, s.get("col"))
        new, n = replace(d.m_Script, ents, tr, s["fmt"])
        if n:
            d.m_Script = new
            d.save()
            hit += n
    if not hit:
        return b"", 0
    f = next(iter(env.files.values()))
    return (f.save(packer="lz4") if p.suffix.lower() == ".bundle" else f.save()), hit


def restore(root: Path, sources: list[dict]) -> int:
    n = 0
    rels = {s["rel"] for s in sources if s.get("rel")}
    if any(r.lower().endswith(".bundle") for r in rels) and (root / BACKUP_DIR).is_dir():   # catalog đã tắt CRC cho bundle
        rels |= {str(b.relative_to(root / BACKUP_DIR)) for b in (root / BACKUP_DIR).rglob("catalog.*")
                 if b.parent.name == "aa" and b.suffix in (".json", ".bin")}
    for rel in rels:
        b = root / BACKUP_DIR / rel
        if b.is_file():
            shutil.copy2(b, root / rel)
            n += 1
    return n
