"""Tab "Học": IELTS, tiếng Nhật, tiếng Trung, tiếng Hàn.

Dữ liệu = bộ thẻ (deck) thuộc một môn (`subject`) và một mục (`section`, vd. vocab / kanji / grammar / kana), mỗi thẻ có
mặt trước (`front`), cách đọc (`reading`: kana / pinyin / romaja / phiên âm IPA), nghĩa tiếng Việt (`meaning`), câu ví dụ
(`example`, `example_vi`) và `extra` (JSON tự do: loại từ, Hán Việt, ghi chú, âm thanh…).
Ôn tập lặp lại ngắt quãng (SRS kiểu Anki/SM-2) theo từng thẻ, nhật ký học từng ngày (chuỗi ngày học, số thẻ đã ôn).
Bảng chữ Hiragana/Katakana và Hangul có sẵn; các dữ liệu khác nhập bằng file JSON/CSV (`POST /api/learn/import`).

Định dạng nhập (JSON):
  {"decks": [{"subject": "ja", "section": "vocab", "name": "JLPT N5 – Bài 1", "level": "N5", "descr": "…",
              "cards": [{"front": "食べる", "reading": "たべる", "meaning": "ăn", "example": "ご飯を食べる。",
                         "example_vi": "Ăn cơm.", "extra": {"pos": "động từ", "hanviet": "THỰC"}}]}]}
  hoặc CSV/TSV có hàng tiêu đề: front,reading,meaning,example,example_vi[,tags…] (cột khác vào extra).
"""
from __future__ import annotations

import csv
import io
import json
import random
import threading
import time
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import config, db, devices

router = APIRouter(prefix="/api/learn", dependencies=[Depends(devices.local_only)])
SETTINGS = config.DATA / "learn.json"
_lock = threading.Lock()
_ready = False

SUBJECTS = {
    "ielts": {"name": "IELTS", "lang": "en-GB", "sections": [
        ["vocab", "Từ vựng"], ["listening", "Listening"], ["reading", "Reading"], ["writing", "Writing"], ["speaking", "Speaking"]]},
    "ja": {"name": "Tiếng Nhật", "lang": "ja-JP", "sections": [
        ["kana", "Bảng chữ cái"], ["vocab", "Từ vựng"], ["kanji", "Kanji"], ["grammar", "Ngữ pháp"]]},
    "zh": {"name": "Tiếng Trung", "lang": "zh-CN", "sections": [
        ["pinyin", "Pinyin"], ["vocab", "Từ vựng"], ["hanzi", "Hán tự"], ["grammar", "Ngữ pháp"]]},
    "ko": {"name": "Tiếng Hàn", "lang": "ko-KR", "sections": [
        ["hangul", "Bảng chữ Hangul"], ["vocab", "Từ vựng"], ["grammar", "Ngữ pháp"]]},
}
DEFAULTS = {"new_per_day": 15, "review_limit": 200, "auto_speak": True}
SCHEMA = """
CREATE TABLE IF NOT EXISTS learn_decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, section TEXT NOT NULL, name TEXT NOT NULL,
  level TEXT, descr TEXT, builtin TEXT, created REAL NOT NULL, ord INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS learn_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deck_id INTEGER NOT NULL, front TEXT NOT NULL, reading TEXT, meaning TEXT,
  example TEXT, example_vi TEXT, extra TEXT, ord INTEGER NOT NULL DEFAULT 0,
  due REAL, ivl REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5, reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', last REAL
);
CREATE TABLE IF NOT EXISTS learn_log (
  day TEXT NOT NULL, subject TEXT NOT NULL, reviews INTEGER NOT NULL DEFAULT 0, news INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, subject)
);
CREATE INDEX IF NOT EXISTS idx_learn_cards_deck ON learn_cards(deck_id);
CREATE INDEX IF NOT EXISTS idx_learn_cards_due ON learn_cards(due);
"""


# ================================================================== bảng chữ có sẵn
_KANA_ROWS = [
    ("a i u e o", "あいうえお", "アイウエオ"), ("ka ki ku ke ko", "かきくけこ", "カキクケコ"),
    ("sa shi su se so", "さしすせそ", "サシスセソ"), ("ta chi tsu te to", "たちつてと", "タチツテト"),
    ("na ni nu ne no", "なにぬねの", "ナニヌネノ"), ("ha hi fu he ho", "はひふへほ", "ハヒフヘホ"),
    ("ma mi mu me mo", "まみむめも", "マミムメモ"), ("ya yu yo", "やゆよ", "ヤユヨ"),
    ("ra ri ru re ro", "らりるれろ", "ラリルレロ"), ("wa wo n", "わをん", "ワヲン"),
]
_DAKU_ROWS = [
    ("ga gi gu ge go", "がぎぐげご", "ガギグゲゴ"), ("za ji zu ze zo", "ざじずぜぞ", "ザジズゼゾ"),
    ("da ji zu de do", "だぢづでど", "ダヂヅデド"), ("ba bi bu be bo", "ばびぶべぼ", "バビブベボ"),
    ("pa pi pu pe po", "ぱぴぷぺぽ", "パピプペポ"),
]
_YOON = [("ky", "き", "キ"), ("sh", "し", "シ"), ("ch", "ち", "チ"), ("ny", "に", "ニ"), ("hy", "ひ", "ヒ"), ("my", "み", "ミ"),
         ("ry", "り", "リ"), ("gy", "ぎ", "ギ"), ("j", "じ", "ジ"), ("by", "び", "ビ"), ("py", "ぴ", "ピ")]


def _kana(script: int) -> list[dict]:
    """script 1 = hiragana, 2 = katakana."""
    out = []
    for group, rows in (("Âm cơ bản", _KANA_ROWS), ("Âm đục (dakuten)", _DAKU_ROWS)):
        for row in rows:
            for rom, ch in zip(row[0].split(), row[script]):
                out.append({"front": ch, "reading": rom, "meaning": f"đọc là “{rom}”", "extra": {"group": group, "row": row[0].split()[0]}})
    small = ("ゃゅょ", "ャュョ")[script - 1]
    for pre, h, k in _YOON:
        base = (h, k)[script - 1]
        for v, sm in zip("auo", small):
            rom = pre + v
            out.append({"front": base + sm, "reading": rom, "meaning": f"đọc là “{rom}”", "extra": {"group": "Âm ghép (yōon)", "row": pre}})
    return out


_HANGUL = [
    ("ㄱ", "g/k", "Phụ âm", "giống “c/k” (đầu từ), “g” giữa từ"), ("ㄴ", "n", "Phụ âm", "“n”"), ("ㄷ", "d/t", "Phụ âm", "giống “t/đ”"),
    ("ㄹ", "r/l", "Phụ âm", "giữa “r” và “l”"), ("ㅁ", "m", "Phụ âm", "“m”"), ("ㅂ", "b/p", "Phụ âm", "giống “b/p”"),
    ("ㅅ", "s", "Phụ âm", "“s/x”"), ("ㅇ", "– / ng", "Phụ âm", "câm ở đầu âm tiết, “ng” ở cuối"), ("ㅈ", "j", "Phụ âm", "giống “ch”"),
    ("ㅊ", "ch", "Phụ âm", "“ch” bật hơi"), ("ㅋ", "k", "Phụ âm", "“kh” bật hơi"), ("ㅌ", "t", "Phụ âm", "“th” bật hơi"),
    ("ㅍ", "p", "Phụ âm", "“ph” bật hơi (môi)"), ("ㅎ", "h", "Phụ âm", "“h”"),
    ("ㄲ", "kk", "Phụ âm căng", "“k” căng, không bật hơi"), ("ㄸ", "tt", "Phụ âm căng", "“t” căng"), ("ㅃ", "pp", "Phụ âm căng", "“p” căng"),
    ("ㅆ", "ss", "Phụ âm căng", "“s” căng"), ("ㅉ", "jj", "Phụ âm căng", "“ch” căng"),
    ("ㅏ", "a", "Nguyên âm", "“a”"), ("ㅑ", "ya", "Nguyên âm", "“ya”"), ("ㅓ", "eo", "Nguyên âm", "“ơ” (miệng mở)"),
    ("ㅕ", "yeo", "Nguyên âm", "“yơ”"), ("ㅗ", "o", "Nguyên âm", "“ô”"), ("ㅛ", "yo", "Nguyên âm", "“yô”"), ("ㅜ", "u", "Nguyên âm", "“u”"),
    ("ㅠ", "yu", "Nguyên âm", "“yu”"), ("ㅡ", "eu", "Nguyên âm", "“ư”"), ("ㅣ", "i", "Nguyên âm", "“i”"),
    ("ㅐ", "ae", "Nguyên âm ghép", "“e” (mở)"), ("ㅒ", "yae", "Nguyên âm ghép", "“ye”"), ("ㅔ", "e", "Nguyên âm ghép", "“ê”"),
    ("ㅖ", "ye", "Nguyên âm ghép", "“yê”"), ("ㅘ", "wa", "Nguyên âm ghép", "“oa”"), ("ㅙ", "wae", "Nguyên âm ghép", "“oe”"),
    ("ㅚ", "oe", "Nguyên âm ghép", "“uê”"), ("ㅝ", "wo", "Nguyên âm ghép", "“uơ”"), ("ㅞ", "we", "Nguyên âm ghép", "“uê”"),
    ("ㅟ", "wi", "Nguyên âm ghép", "“uy”"), ("ㅢ", "ui", "Nguyên âm ghép", "“ưi”"),
]
_TONES = [("mā", "1", "Thanh 1 – ngang, cao đều", "妈 mā – mẹ"), ("má", "2", "Thanh 2 – đi lên (giống dấu sắc)", "麻 má – cây gai"),
          ("mǎ", "3", "Thanh 3 – xuống rồi lên (giống dấu hỏi)", "马 mǎ – con ngựa"),
          ("mà", "4", "Thanh 4 – rơi mạnh (giống dấu huyền nặng)", "骂 mà – mắng"), ("ma", "0", "Thanh nhẹ – ngắn, nhẹ", "吗 ma – trợ từ hỏi")]
_INITIALS = "b p m f d t n l g k h j q x zh ch sh r z c s y w".split()
_FINALS = "a o e i u ü ai ei ao ou an en ang eng ong er ia ie iao iu ian in iang ing iong ua uo uai ui uan un uang ueng üe üan ün".split()


def _builtin() -> list[dict]:
    hangul = [{"front": c, "reading": r, "meaning": m, "extra": {"group": g}} for c, r, g, m in _HANGUL]
    tones = [{"front": f, "reading": f"thanh {n}", "meaning": m, "example": ex, "extra": {"group": "Thanh điệu"}} for f, n, m, ex in _TONES]
    tones += [{"front": x, "reading": x, "meaning": "thanh mẫu (phụ âm đầu)", "extra": {"group": "Thanh mẫu"}} for x in _INITIALS]
    tones += [{"front": x, "reading": x, "meaning": "vận mẫu (vần)", "extra": {"group": "Vận mẫu"}} for x in _FINALS]
    return [
        {"key": "ja-hira", "subject": "ja", "section": "kana", "name": "Hiragana", "level": "Nhập môn",
         "descr": "46 chữ cơ bản + âm đục + âm ghép. Học trước tiên.", "cards": _kana(1)},
        {"key": "ja-kata", "subject": "ja", "section": "kana", "name": "Katakana", "level": "Nhập môn",
         "descr": "Dùng cho từ mượn nước ngoài, tên riêng.", "cards": _kana(2)},
        {"key": "ko-hangul", "subject": "ko", "section": "hangul", "name": "Hangul – nguyên âm & phụ âm", "level": "Nhập môn",
         "descr": "Phụ âm, phụ âm căng, nguyên âm đơn và ghép.", "cards": hangul},
        {"key": "zh-pinyin", "subject": "zh", "section": "pinyin", "name": "Pinyin – thanh điệu, thanh mẫu, vận mẫu", "level": "Nhập môn",
         "descr": "4 thanh + thanh nhẹ, 23 thanh mẫu, các vận mẫu chính.", "cards": tones},
    ]


def ensure():
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        c = db.conn()
        c.executescript(SCHEMA)
        have = {r["builtin"] for r in db.query("SELECT builtin FROM learn_decks WHERE builtin IS NOT NULL")}
        for i, d in enumerate(_builtin()):
            if d["key"] in have:
                continue
            did = db.execute("INSERT INTO learn_decks(subject, section, name, level, descr, builtin, created, ord) VALUES (?,?,?,?,?,?,?,?)",
                             (d["subject"], d["section"], d["name"], d["level"], d["descr"], d["key"], time.time(), i))
            _insert_cards(did, d["cards"])
        _ready = True


def _insert_cards(did: int, cards: list[dict]) -> int:
    base = (db.one("SELECT COALESCE(MAX(ord), -1) AS m FROM learn_cards WHERE deck_id=?", (did,)) or {"m": -1})["m"] + 1
    n = 0
    for i, c in enumerate(cards):
        front = str(c.get("front") or "").strip()
        if not front:
            continue
        extra = c.get("extra") if isinstance(c.get("extra"), dict) else {}
        db.execute("INSERT INTO learn_cards(deck_id, front, reading, meaning, example, example_vi, extra, ord) VALUES (?,?,?,?,?,?,?,?)",
                   (did, front[:500], _s(c.get("reading")), _s(c.get("meaning"), 4000), _s(c.get("example"), 4000),
                    _s(c.get("example_vi"), 4000), json.dumps(extra, ensure_ascii=False) if extra else None, base + i))
        n += 1
    return n


def _s(v, n=1000):
    v = "" if v is None else str(v).strip()
    return v[:n] or None


# ================================================================== cài đặt + ngày học
def settings() -> dict:
    try:
        s = json.loads(SETTINGS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    return {**DEFAULTS, **{k: v for k, v in s.items() if k in DEFAULTS}}


def _today() -> str:
    return (datetime.now() - timedelta(hours=4)).date().isoformat()      # ngày học tính từ 4 giờ sáng


def _end_of_day() -> float:
    d = datetime.now() - timedelta(hours=4)
    return datetime(d.year, d.month, d.day, 4).timestamp() + 86400


def _streak() -> int:
    days = {r["day"] for r in db.query("SELECT day FROM learn_log WHERE reviews > 0")}
    d = date.fromisoformat(_today())
    if d.isoformat() not in days:
        d -= timedelta(days=1)
    n = 0
    while d.isoformat() in days:
        n += 1
        d -= timedelta(days=1)
    return n


def _subject(subject: str) -> dict:
    if subject not in SUBJECTS:
        raise HTTPException(404, "Không có môn này.")
    return SUBJECTS[subject]


def _stats(subject: str, deck: int | None = None) -> dict:
    where, args = ("d.subject=?", [subject]) if deck is None else ("c.deck_id=?", [deck])
    row = db.one(f"""SELECT COUNT(*) AS total, SUM(c.state='new') AS new, SUM(c.state='review') AS learned,
                     SUM(c.state!='new' AND c.due <= ?) AS due, SUM(c.state='review' AND c.ivl >= 21) AS mature
                     FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id WHERE {where}""", (_end_of_day(), *args))
    return {k: int(row[k] or 0) for k in ("total", "new", "learned", "due", "mature")}


def _new_left(subject: str) -> int:
    log = db.one("SELECT news FROM learn_log WHERE day=? AND subject=?", (_today(), subject))
    return max(0, int(settings()["new_per_day"]) - int(log["news"] if log else 0))


# ================================================================== API
@router.get("")
def overview():
    ensure()
    today = _today()
    out = []
    for k, v in SUBJECTS.items():
        log = db.one("SELECT * FROM learn_log WHERE day=? AND subject=?", (today, k)) or {}
        out.append({"id": k, "name": v["name"], "lang": v["lang"], **_stats(k), "new_left": _new_left(k),
                    "today": {x: int(log.get(x) or 0) for x in ("reviews", "news", "correct", "seconds")},
                    "decks": (db.one("SELECT COUNT(*) AS n FROM learn_decks WHERE subject=?", (k,)) or {"n": 0})["n"]})
    week = []
    d0 = date.fromisoformat(today)
    rows = {r["day"]: r for r in db.query("SELECT day, SUM(reviews) AS reviews, SUM(seconds) AS seconds FROM learn_log "
                                           "WHERE day >= ? GROUP BY day", ((d0 - timedelta(days=83)).isoformat(),))}
    for i in range(83, -1, -1):
        d = (d0 - timedelta(days=i)).isoformat()
        week.append({"day": d, "reviews": int((rows.get(d) or {}).get("reviews") or 0)})
    return {"subjects": out, "streak": _streak(), "days": week, "settings": settings()}


@router.get("/subject/{subject}")
def subject_view(subject: str):
    ensure()
    info = _subject(subject)
    decks = db.query("SELECT * FROM learn_decks WHERE subject=? ORDER BY ord, id", (subject,))
    for d in decks:
        d.update(_stats(subject, d["id"]))
    return {"id": subject, **info, "stats": _stats(subject), "new_left": _new_left(subject), "decks": decks,
            "settings": settings()}


class DeckIn(BaseModel):
    subject: str
    section: str
    name: str
    level: str | None = None
    descr: str | None = None


@router.post("/decks")
def create_deck(body: DeckIn):
    ensure()
    _subject(body.subject)
    if not body.name.strip():
        raise HTTPException(400, "Đặt tên bộ thẻ.")
    did = db.execute("INSERT INTO learn_decks(subject, section, name, level, descr, created, ord) VALUES (?,?,?,?,?,?,?)",
                     (body.subject, body.section[:40], body.name.strip()[:150], _s(body.level, 40), _s(body.descr, 1000), time.time(), 1000))
    return db.one("SELECT * FROM learn_decks WHERE id=?", (did,))


class DeckPatch(BaseModel):
    name: str | None = None
    level: str | None = None
    descr: str | None = None
    section: str | None = None


@router.patch("/decks/{did}")
def patch_deck(did: int, body: DeckPatch):
    ensure()
    if not db.one("SELECT id FROM learn_decks WHERE id=?", (did,)):
        raise HTTPException(404, "Không có bộ thẻ này.")
    for k, v in body.model_dump(exclude_none=True).items():
        db.execute(f"UPDATE learn_decks SET {k}=? WHERE id=?", (v.strip()[:150], did))
    return db.one("SELECT * FROM learn_decks WHERE id=?", (did,))


@router.delete("/decks/{did}")
def delete_deck(did: int):
    ensure()
    db.execute("DELETE FROM learn_cards WHERE deck_id=?", (did,))
    db.execute("DELETE FROM learn_decks WHERE id=?", (did,))
    return {"ok": True}


@router.post("/decks/{did}/reset")
def reset_deck(did: int):
    """Học lại từ đầu: đưa mọi thẻ của bộ về trạng thái mới."""
    ensure()
    db.execute("UPDATE learn_cards SET state='new', due=NULL, ivl=0, ease=2.5, reps=0, lapses=0, step=0, last=NULL WHERE deck_id=?", (did,))
    return {"ok": True}


def _card(r: dict) -> dict:
    r = dict(r)
    try:
        r["extra"] = json.loads(r["extra"]) if r.get("extra") else {}
    except ValueError:
        r["extra"] = {}
    return r


@router.get("/decks/{did}")
def deck_cards(did: int, q: str = "", offset: int = 0, limit: int = 200):
    ensure()
    d = db.one("SELECT * FROM learn_decks WHERE id=?", (did,))
    if not d:
        raise HTTPException(404, "Không có bộ thẻ này.")
    args: list = [did]
    where = "deck_id=?"
    if q.strip():
        where += " AND (front LIKE ? OR reading LIKE ? OR meaning LIKE ?)"
        args += [f"%{q.strip()}%"] * 3
    total = db.one(f"SELECT COUNT(*) AS n FROM learn_cards WHERE {where}", tuple(args))["n"]
    rows = db.query(f"SELECT * FROM learn_cards WHERE {where} ORDER BY ord, id LIMIT ? OFFSET ?", (*args, max(1, min(limit, 1000)), max(0, offset)))
    return {**d, **_stats(d["subject"], did), "matched": total, "cards": [_card(r) for r in rows]}


class CardIn(BaseModel):
    front: str
    reading: str | None = None
    meaning: str | None = None
    example: str | None = None
    example_vi: str | None = None
    extra: dict | None = None


@router.post("/decks/{did}/cards")
def add_cards(did: int, body: list[CardIn]):
    ensure()
    if not db.one("SELECT id FROM learn_decks WHERE id=?", (did,)):
        raise HTTPException(404, "Không có bộ thẻ này.")
    return {"added": _insert_cards(did, [c.model_dump() for c in body])}


@router.put("/cards/{cid}")
def edit_card(cid: int, body: CardIn):
    ensure()
    if not body.front.strip():
        raise HTTPException(400, "Mặt trước không được trống.")
    db.execute("UPDATE learn_cards SET front=?, reading=?, meaning=?, example=?, example_vi=?, extra=? WHERE id=?",
               (body.front.strip()[:500], _s(body.reading), _s(body.meaning, 4000), _s(body.example, 4000), _s(body.example_vi, 4000),
                json.dumps(body.extra, ensure_ascii=False) if body.extra else None, cid))
    return _card(db.one("SELECT * FROM learn_cards WHERE id=?", (cid,)))


@router.delete("/cards/{cid}")
def delete_card(cid: int):
    ensure()
    db.execute("DELETE FROM learn_cards WHERE id=?", (cid,))
    return {"ok": True}


# ---------------------------------------------------------------- nhập / xuất
FIELDS = ("front", "reading", "meaning", "example", "example_vi")
ALIASES = {"word": "front", "term": "front", "từ": "front", "tu": "front", "kanji": "front", "hanzi": "front", "vocab": "front",
           "kana": "reading", "pinyin": "reading", "romaja": "reading", "ipa": "reading", "phonetic": "reading", "đọc": "reading",
           "cách đọc": "reading", "nghĩa": "meaning", "nghia": "meaning", "vi": "meaning", "vietnamese": "meaning",
           "definition": "meaning", "ví dụ": "example", "vi du": "example", "sentence": "example", "dịch ví dụ": "example_vi"}


def parse_import(text: str) -> list[dict]:
    t = text.lstrip("﻿").strip()
    if t[:1] in "{[":
        try:
            obj = json.loads(t)
        except ValueError as e:
            raise HTTPException(400, f"File JSON lỗi: {e}")
        if isinstance(obj, dict) and isinstance(obj.get("decks"), list):
            return obj["decks"]
        if isinstance(obj, dict) and isinstance(obj.get("cards"), list):
            return [obj]
        if isinstance(obj, list):
            return [{"cards": obj}]
        raise HTTPException(400, 'JSON cần có "decks": [...] hoặc "cards": [...].')
    delim = "\t" if t.count("\t") > t.count(",") else ","
    rows = list(csv.reader(io.StringIO(t), delimiter=delim))
    if not rows:
        raise HTTPException(400, "File trống.")
    head = [h.strip().lower() for h in rows[0]]
    names = [ALIASES.get(h, h) for h in head]
    if "front" not in names:                      # không có tiêu đề: cột 1 mặt trước, 2 cách đọc, 3 nghĩa…
        names, data = list(FIELDS), rows
    else:
        data = rows[1:]
    cards = []
    for r in data:
        c: dict = {"extra": {}}
        for k, v in zip(names, r):
            if k in FIELDS:
                c[k] = v
            elif k and v:
                c["extra"][k] = v
        cards.append(c)
    return [{"cards": cards}]


@router.post("/import")
async def import_decks(request: Request, subject: str, section: str = "vocab", name: str = "", level: str = ""):
    ensure()
    _subject(subject)
    raw = await request.body()
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(400, "File quá lớn.")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("latin-1")
    decks = parse_import(text)
    made = []
    for d in decks:
        subj = d.get("subject") if d.get("subject") in SUBJECTS else subject
        did = db.execute("INSERT INTO learn_decks(subject, section, name, level, descr, created, ord) VALUES (?,?,?,?,?,?,?)",
                         (subj, str(d.get("section") or section)[:40], str(d.get("name") or name or "Bộ thẻ nhập")[:150],
                          _s(d.get("level") or level, 40), _s(d.get("descr"), 1000), time.time(), 1000))
        n = _insert_cards(did, d.get("cards") or [])
        made.append({"id": did, "name": d.get("name") or name or "Bộ thẻ nhập", "cards": n})
    return {"decks": made, "cards": sum(x["cards"] for x in made)}


@router.get("/decks/{did}/export")
def export_deck(did: int):
    ensure()
    d = db.one("SELECT * FROM learn_decks WHERE id=?", (did,))
    if not d:
        raise HTTPException(404, "Không có bộ thẻ này.")
    cards = [{k: c[k] for k in (*FIELDS, "extra") if c.get(k)} for c in map(_card, db.query("SELECT * FROM learn_cards WHERE deck_id=? ORDER BY ord, id", (did,)))]
    return {"decks": [{"subject": d["subject"], "section": d["section"], "name": d["name"], "level": d["level"], "descr": d["descr"], "cards": cards}]}


# ---------------------------------------------------------------- học / ôn
@router.get("/study")
def study(subject: str, deck: int | None = None, mode: str = "mix", limit: int = 20):
    """Lượt học: thẻ đến hạn ôn trước, rồi thẻ mới (theo giới hạn mỗi ngày). mode = mix | review | new | all (xem thử, không giới hạn)."""
    ensure()
    _subject(subject)
    limit = max(1, min(limit, 200))
    where, args = ("d.subject=?", [subject]) if deck is None else ("c.deck_id=?", [deck])
    cards: list[dict] = []
    if mode in ("mix", "review"):
        cards += db.query(f"SELECT c.*, d.name AS deck_name FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id "
                          f"WHERE {where} AND c.state!='new' AND c.due <= ? ORDER BY c.due LIMIT ?", (*args, _end_of_day(), limit))
    if mode in ("mix", "new"):
        room = min(limit - len(cards), _new_left(subject))
        if room > 0:
            cards += db.query(f"SELECT c.*, d.name AS deck_name FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id "
                              f"WHERE {where} AND c.state='new' ORDER BY d.ord, d.id, c.ord, c.id LIMIT ?", (*args, room))
    if mode == "all":
        cards = db.query(f"SELECT c.*, d.name AS deck_name FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id "
                         f"WHERE {where} ORDER BY RANDOM() LIMIT ?", (*args, limit))
    out = [_card(c) for c in cards]
    # đáp án nhiễu cho trắc nghiệm: nghĩa của thẻ khác cùng bộ
    pools: dict[int, list[str]] = {}
    for c in out:
        if c["deck_id"] not in pools:
            pools[c["deck_id"]] = [r["meaning"] for r in db.query(
                "SELECT DISTINCT meaning FROM learn_cards WHERE deck_id=? AND meaning IS NOT NULL ORDER BY RANDOM() LIMIT 60", (c["deck_id"],))]
        others = [m for m in pools[c["deck_id"]] if m and m != c.get("meaning")]
        random.shuffle(others)
        c["choices"] = others[:3]
        c["next"] = {g: _label(_schedule(c, g)[0] - time.time()) for g in range(4)}
    return {"cards": out, "new_left": _new_left(subject), "lang": SUBJECTS[subject]["lang"]}


def _label(sec: float) -> str:
    if sec < 3600:
        return f"{max(1, round(sec / 60))} phút"
    if sec < 72000:
        return f"{round(sec / 3600)} giờ"
    d = sec / 86400
    return f"{round(d)} ngày" if d < 30 else f"{round(d / 30, 1):g} tháng"


def _schedule(c: dict, grade: int) -> tuple[float, dict]:
    """Lịch ôn kiểu Anki. grade: 0 = Quên, 1 = Khó, 2 = Nhớ, 3 = Dễ. Trả (hạn ôn, các cột cần cập nhật)."""
    now = time.time()
    ease, ivl, step, state = float(c.get("ease") or 2.5), float(c.get("ivl") or 0), int(c.get("step") or 0), c.get("state") or "new"
    lapses = int(c.get("lapses") or 0)
    if state in ("new", "learning"):
        if grade == 0:
            due, step, state = now + 60, 0, "learning"
        elif grade == 1:
            due, state = now + 6 * 60, "learning"
        elif grade == 2:
            if step >= 1:
                ivl, state = 1, "review"
                due = now + 86400
            else:
                due, step, state = now + 10 * 60, step + 1, "learning"
        else:
            ivl, state = 4, "review"
            due = now + 4 * 86400
    else:
        if grade == 0:
            lapses += 1
            ease = max(1.3, ease - 0.2)
            ivl = max(1, ivl * 0.3)
            due, step, state = now + 10 * 60, 1, "learning"
        else:
            if grade == 1:
                ivl, ease = max(ivl + 1, ivl * 1.2), max(1.3, ease - 0.15)
            elif grade == 2:
                ivl = max(ivl + 1, ivl * ease)
            else:
                ivl, ease = max(ivl + 2, ivl * ease * 1.3), ease + 0.15
            ivl = min(ivl, 3650)
            due = now + ivl * 86400 * random.uniform(0.95, 1.05)
    return due, {"ease": round(ease, 3), "ivl": round(ivl, 3), "step": step, "state": state, "lapses": lapses, "due": due}


class ReviewIn(BaseModel):
    card_id: int
    grade: int
    seconds: float = 0


@router.post("/review")
def review(body: ReviewIn):
    ensure()
    c = db.one("SELECT c.*, d.subject FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id WHERE c.id=?", (body.card_id,))
    if not c:
        raise HTTPException(404, "Không có thẻ này.")
    g = max(0, min(3, body.grade))
    was_new = c["state"] == "new"
    due, upd = _schedule(c, g)
    upd.update(reps=int(c["reps"]) + 1, last=time.time())
    db.execute("UPDATE learn_cards SET " + ", ".join(f"{k}=?" for k in upd) + " WHERE id=?", (*upd.values(), c["id"]))
    day = _today()
    db.execute("INSERT INTO learn_log(day, subject) VALUES (?, ?) ON CONFLICT(day, subject) DO NOTHING", (day, c["subject"]))
    db.execute("UPDATE learn_log SET reviews=reviews+1, news=news+?, correct=correct+?, seconds=seconds+? WHERE day=? AND subject=?",
               (1 if was_new else 0, 1 if g >= 2 else 0, int(min(max(body.seconds, 0), 600)), day, c["subject"]))
    return {"due": due, "state": upd["state"], "again": upd["state"] == "learning" and due - time.time() < 3600}


class SettingsIn(BaseModel):
    new_per_day: int | None = None
    review_limit: int | None = None
    auto_speak: bool | None = None


@router.put("/settings")
def put_settings(body: SettingsIn):
    s = settings()
    for k, v in body.model_dump(exclude_none=True).items():
        s[k] = max(0, min(500, v)) if isinstance(v, int) and not isinstance(v, bool) else v
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
    return s
