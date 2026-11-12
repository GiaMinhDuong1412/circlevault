"""Tab Học (phần 2): lộ trình chuẩn, nghĩa tiếng Việt tự dịch, bài tập thực hành, kiểm tra định kỳ, kế hoạch "Hôm nay học gì".

Lộ trình chuẩn = danh sách từ theo cấp của kỳ thi (backend/app/lotrinh/<môn>.json.gz, dựng bằng tools/lap_lo_trinh.py):
  IELTS → khung CEFR A1–C2 (CEFR-J + Octanove), tiếng Nhật → JLPT N5–N1, tiếng Trung → HSK 3.0 cấp 1–9, tiếng Hàn → TOPIK I.
Chọn một cấp = tạo bộ thẻ `path:<môn>:<cấp>` (thẻ xếp theo tần suất: từ hay gặp học trước) và đặt số từ mới mỗi ngày.
Nghĩa tiếng Việt: thẻ chưa có thì dịch lúc học (bộ dịch của tab Dịch: Google từng từ, hoặc Claude viết nghĩa + câu ví dụ).

Bài tập (practice) và kiểm tra (week = kiểm tra tuần, level = kiểm tra cuối cấp) tạo câu hỏi từ thẻ đã học:
  mean (từ → nghĩa), rev (nghĩa → từ), listen (nghe → chọn từ), read (chữ → cách đọc), tf (đúng/sai), cloze (điền vào câu ví dụ),
  spell (gõ lại từ), match (ghép 4 cặp). Kết quả lưu ở learn_tests; từ làm sai được đưa về ôn ngay hôm nay.
"""
from __future__ import annotations

import gzip
import json
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel

from . import db, learn, translate

router = learn.router
PATHS = Path(__file__).resolve().parent / "lotrinh"
SRC_LANG = {"ielts": "en", "ja": "ja", "zh": "zh", "ko": "ko"}
GOOGLE_LANG = {"ielts": "en", "ja": "ja", "zh": "zh-CN", "ko": "ko"}
LANG_VI = {"ielts": "tiếng Anh", "ja": "tiếng Nhật", "zh": "tiếng Trung", "ko": "tiếng Hàn"}
PASS = 80                      # % đạt của bài kiểm tra
WEEK_EVERY = 7                 # kiểm tra tuần: 7 ngày một lần
_cache: dict[str, dict] = {}
_gloss_off_until = 0.0         # bộ dịch lỗi (mất mạng…) thì tạm không dịch 5 phút để không làm chậm lượt học
_jobs: dict[int, dict] = {}    # deck id → tiến độ "dịch nghĩa cả bộ"
_jlock = threading.Lock()
_pool_ex = ThreadPoolExecutor(2)


# ================================================================== lộ trình chuẩn
def path_data(subject: str) -> dict:
    learn._subject(subject)
    if subject not in _cache:
        f = PATHS / f"{subject}.json.gz"
        if not f.is_file():
            raise HTTPException(404, "Chưa có dữ liệu lộ trình cho môn này.")
        _cache[subject] = json.loads(gzip.decompress(f.read_bytes()))
    return _cache[subject]


def _path_key(subject: str, level: str) -> str:
    return f"path:{subject}:{level}"


def _passed(subject: str, level: str) -> dict | None:
    return db.one("SELECT pct, at FROM learn_tests WHERE subject=? AND kind='level' AND level=? AND passed=1 ORDER BY pct DESC LIMIT 1",
                  (subject, level))


@router.get("/paths/{subject}")
def get_path(subject: str):
    learn.ensure()
    d = path_data(subject)
    conf = (learn.settings().get("paths") or {}).get(subject) or {}
    decks = {r["builtin"]: r for r in db.query("SELECT id, builtin FROM learn_decks WHERE builtin LIKE ?", (f"path:{subject}:%",))}
    levels = []
    for lv in d["levels"]:
        deck = decks.get(_path_key(subject, lv["id"]))
        st = learn._stats(subject, deck["id"]) if deck else None
        p = _passed(subject, lv["id"])
        levels.append({"id": lv["id"], "name": lv["name"], "target": lv.get("target"), "count": len(lv["words"]),
                       "deck_id": deck["id"] if deck else None, "seen": st["total"] - st["new"] if st else 0,
                       "learned": st["learned"] if st else 0, "passed": bool(p), "best": p["pct"] if p else None})
    return {"subject": subject, "name": d["name"], "short": d["short"], "about": d["about"], "credit": d["credit"],
            "levels": levels, "active": conf.get("level"), "per_day": int(conf.get("per_day") or learn.settings()["new_per_day"])}


class PathIn(BaseModel):
    per_day: int | None = None


@router.post("/paths/{subject}/{level}")
def choose_level(subject: str, level: str, body: PathIn):
    """Học cấp này: tạo bộ thẻ (lần đầu) và đặt làm lộ trình đang học của môn."""
    learn.ensure()
    d = path_data(subject)
    lv = next((x for x in d["levels"] if x["id"] == level), None)
    if not lv:
        raise HTTPException(404, "Không có cấp này.")
    key = _path_key(subject, level)
    deck = db.one("SELECT id FROM learn_decks WHERE builtin=?", (key,))
    if not deck:
        idx = [x["id"] for x in d["levels"]].index(level)
        did = db.execute("INSERT INTO learn_decks(subject, section, name, level, descr, builtin, created, ord) VALUES (?,?,?,?,?,?,?,?)",
                         (subject, "vocab", f"{d['short'].split(' ')[0]} {lv['name']}" if not lv["name"].startswith(d["short"].split(" ")[0]) else lv["name"],
                          level, f"Lộ trình chuẩn: {len(lv['words'])} từ{' · ' + lv['target'] if lv.get('target') else ''}. Từ hay gặp học trước.",
                          key, time.time(), 100 + idx))
        rows = []
        for i, (front, reading, en, vi, note) in enumerate(lv["words"]):
            extra = {"loại từ" if subject == "ielts" else "ghi chú": note} if note else {}
            rows.append((did, front, reading or None, vi or None, en or None, json.dumps(extra, ensure_ascii=False) if extra else None, i))
        c = db.conn()
        with db._lock:
            c.execute("BEGIN")
            c.executemany("INSERT INTO learn_cards(deck_id, front, reading, meaning, en, extra, ord) VALUES (?,?,?,?,?,?,?)", rows)
            c.execute("COMMIT")
        deck = {"id": did}
    s = learn.settings()
    paths = dict(s.get("paths") or {})
    cur = dict(paths.get(subject) or {})
    cur["level"] = level
    if body.per_day is not None:
        cur["per_day"] = max(1, min(100, body.per_day))
    cur.setdefault("per_day", 10)
    paths[subject] = cur
    s["paths"] = paths
    learn.save_settings(s)
    return {"deck_id": deck["id"], **get_path(subject)}


@router.put("/paths/{subject}")
def set_per_day(subject: str, body: PathIn):
    s = learn.settings()
    paths = dict(s.get("paths") or {})
    cur = dict(paths.get(subject) or {})
    if body.per_day is not None:
        cur["per_day"] = max(1, min(100, body.per_day))
    paths[subject] = cur
    s["paths"] = paths
    learn.save_settings(s)
    return get_path(subject)


# ================================================================== nghĩa tiếng Việt
GLOSS_SYSTEM = """Bạn là giáo viên {lang} cho người Việt, đang soạn thẻ từ vựng.
Với mỗi từ: viết nghĩa tiếng Việt ngắn gọn kiểu từ điển (tối đa khoảng 8 chữ; nhiều nghĩa thì cách nhau bằng dấu ;), \
một câu ví dụ ngắn, tự nhiên, ở đúng trình độ của từ, bằng {lang} và có chứa đúng từ đó (giữ nguyên dạng viết), rồi dịch câu sang tiếng Việt.
Trả về đúng số thứ tự "i" của từng từ."""
GLOSS_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["i", "meaning", "example", "example_vi"],
    "properties": {"i": {"type": "integer"}, "meaning": {"type": "string"}, "example": {"type": "string"}, "example_vi": {"type": "string"}}}}}}


def _gloss_google(subject: str, cards: list[dict]) -> dict[int, dict]:
    src = GOOGLE_LANG[subject]

    def one(c):
        return c["id"], {"meaning": translate._google_one(c["front"], src).strip()}

    with ThreadPoolExecutor(4) as ex:
        return dict(ex.map(one, cards))


def _gloss_claude(subject: str, cards: list[dict], s: dict) -> dict[int, dict]:
    items = [{"i": i, "word": c["front"], "reading": c.get("reading") or "", "english": c.get("en") or "", "level": c.get("level") or ""}
             for i, c in enumerate(cards)]
    res = translate.claude_json(s, GLOSS_SYSTEM.format(lang=LANG_VI[subject]),
                                [{"type": "text", "text": json.dumps(items, ensure_ascii=False)}], GLOSS_SCHEMA, effort="low")
    out = {}
    for it in res.get("items", []):
        if isinstance(it.get("i"), int) and 0 <= it["i"] < len(cards) and it.get("meaning"):
            c = cards[it["i"]]
            ex = it.get("example") or ""
            out[c["id"]] = {"meaning": it["meaning"].strip(), **({"example": ex.strip(), "example_vi": (it.get("example_vi") or "").strip()}
                                                                    if ex and c["front"] in ex and not c.get("example") else {})}
    return out


def _gloss(subject: str, cards: list[dict]) -> dict[int, dict]:
    s = translate.settings()
    if s.get("engine") == "claude":
        out = {}
        for i in range(0, len(cards), 40):
            out.update(_gloss_claude(subject, cards[i:i + 40], s))
        return out
    return _gloss_google(subject, cards)


def _store(res: dict[int, dict], cards: list[dict]) -> None:
    for c in cards:
        r = res.get(c["id"])
        if not r or not r.get("meaning"):
            continue
        c.update(r)
        db.execute("UPDATE learn_cards SET meaning=?, example=COALESCE(example, ?), example_vi=COALESCE(example_vi, ?) WHERE id=?",
                   (r["meaning"][:500], r.get("example"), r.get("example_vi"), c["id"]))


def gloss_cards(subject: str, cards: list[dict]) -> None:
    """Dịch nghĩa tiếng Việt cho thẻ sắp học còn thiếu (lỗi thì bỏ qua, thẻ tạm hiện nghĩa tiếng Anh)."""
    global _gloss_off_until
    todo = [c for c in cards if not c.get("meaning")]
    if not todo or time.time() < _gloss_off_until:
        return
    fut = _pool_ex.submit(lambda: _store(_gloss(subject, todo), todo))
    try:
        fut.result(timeout=8)          # chậm quá thì học trước bằng nghĩa tiếng Anh, bản dịch vẫn được lưu khi xong
    except Exception:          # mạng / hết hạn mức / chưa có key / quá lâu
        _gloss_off_until = time.time() + 300


@router.post("/decks/{did}/gloss")
def gloss_deck(did: int):
    """Dịch sẵn nghĩa cho cả bộ (chạy nền)."""
    learn.ensure()
    d = db.one("SELECT * FROM learn_decks WHERE id=?", (did,))
    if not d:
        raise HTTPException(404, "Không có bộ thẻ này.")
    with _jlock:
        if (_jobs.get(did) or {}).get("running"):
            return _jobs[did]
        todo = db.one("SELECT COUNT(*) AS n FROM learn_cards WHERE deck_id=? AND meaning IS NULL", (did,))["n"]
        _jobs[did] = job = {"running": True, "done": 0, "total": todo, "error": None, "stop": False}

    def run():
        try:
            while not job["stop"]:
                rows = db.query("SELECT * FROM learn_cards WHERE deck_id=? AND meaning IS NULL ORDER BY ord, id LIMIT 40", (did,))
                if not rows:
                    break
                res = _gloss(d["subject"], rows)
                if not res:
                    raise translate.TranslateError("Bộ dịch không trả về nghĩa nào.")
                _store(res, rows)
                job["done"] += len(res)
        except Exception as e:
            job["error"] = str(e)[:300]
        job["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return job


@router.get("/decks/{did}/gloss")
def gloss_status(did: int):
    left = db.one("SELECT COUNT(*) AS n FROM learn_cards WHERE deck_id=? AND meaning IS NULL", (did,))["n"]
    return {**(_jobs.get(did) or {"running": False, "done": 0, "total": 0, "error": None}), "left": left}


@router.post("/decks/{did}/gloss/stop")
def gloss_stop(did: int):
    if did in _jobs:
        _jobs[did]["stop"] = True
    return gloss_status(did)


# ================================================================== bài tập + kiểm tra
KINDS = {"practice": "Bài tập", "week": "Kiểm tra tuần", "level": "Kiểm tra cuối cấp"}
SIZE = {"practice": 12, "week": 20, "level": 40}
TIME = {"practice": 0, "week": 12 * 60, "level": 25 * 60}


def _ans(c: dict) -> str:
    return (c.get("meaning") or c.get("en") or "").strip()


def _pick_cards(subject: str, kind: str, deck: int | None, n: int) -> list[dict]:
    base = ("SELECT c.*, d.name AS deck_name, d.level FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id "
            "WHERE d.subject=? AND COALESCE(c.meaning, c.en) IS NOT NULL AND d.section NOT IN ('kana','hangul','pinyin')")
    args: list = [subject]
    if deck:
        base += " AND c.deck_id=?"
        args.append(deck)
    if kind == "level":
        return db.query(base + " ORDER BY c.state='new', RANDOM() LIMIT ?", (*args, n))
    if kind == "week":
        week = db.query(base + " AND c.reps > 0 AND c.last >= ? ORDER BY RANDOM() LIMIT ?", (*args, time.time() - 7 * 86400, int(n * 0.7)))
        ids = [c["id"] for c in week] or [0]
        old = db.query(base + f" AND c.reps > 0 AND c.id NOT IN ({','.join('?' * len(ids))}) ORDER BY RANDOM() LIMIT ?", (*args, *ids, n - len(week)))
        return week + old
    # bài tập: ưu tiên từ đang học / hay quên, rồi từ đã thuộc
    got = db.query(base + " AND c.reps > 0 ORDER BY c.state='learning' DESC, c.lapses DESC, c.ease, RANDOM() LIMIT ?", (*args, n * 2))
    random.shuffle(got)
    return got[:n]


def _pool(subject: str, deck: int | None) -> list[dict]:
    sql = ("SELECT c.id, c.front, c.reading, COALESCE(c.meaning, c.en) AS ans FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id "
           "WHERE d.subject=? AND COALESCE(c.meaning, c.en) IS NOT NULL AND d.section NOT IN ('kana','hangul','pinyin')")
    args: list = [subject]
    if deck:
        sql += " AND c.deck_id=?"
        args.append(deck)
    return db.query(sql + " ORDER BY c.state='new', RANDOM() LIMIT 400", tuple(args))


def _options(right: str, others: list[str], k: int = 4) -> tuple[list[str], int]:
    seen, opts = {right.casefold()}, [right]
    for o in others:
        if o and o.casefold() not in seen:
            seen.add(o.casefold())
            opts.append(o)
        if len(opts) >= k:
            break
    random.shuffle(opts)
    return opts, opts.index(right)


def _question(c: dict, typ: str, pool: list[dict]) -> dict | None:
    ans = _ans(c)
    others = [p for p in pool if p["id"] != c["id"]]
    random.shuffle(others)
    q = {"type": typ, "card_ids": [c["id"]], "say": c["front"]}
    if typ == "mean":
        q["prompt"], q["sub"] = c["front"], "Nghĩa của từ này là gì?"
        q["options"], q["answer"] = _options(ans, [p["ans"] for p in others])
    elif typ == "rev":
        q["prompt"], q["sub"], q["say"] = ans, "Từ nào có nghĩa này?", None
        q["options"], q["answer"] = _options(c["front"], [p["front"] for p in others])
        q["reveal"] = c["front"]
    elif typ == "listen":
        q["prompt"], q["sub"] = "🔊", "Nghe rồi chọn từ đúng"
        q["options"], q["answer"] = _options(c["front"], [p["front"] for p in others])
    elif typ == "read":
        if not c.get("reading") or c["reading"] == c["front"]:
            return None
        q["prompt"], q["sub"] = c["front"], "Đọc từ này thế nào?"
        q["options"], q["answer"] = _options(c["reading"], [p["reading"] for p in others if p.get("reading")])
    elif typ == "tf":
        right = random.random() < 0.5 or not others
        shown = ans if right else others[0]["ans"]
        if not right and shown.casefold() == ans.casefold():
            right = True
        q["prompt"], q["sub"], q["shown"], q["answer"] = c["front"], "Nghĩa này đúng hay sai?", shown, right
        q["truth"] = ans
    elif typ == "cloze":
        ex = c.get("example") or ""
        if not ex or c["front"] not in ex:
            return None
        q["prompt"], q["sub"], q["say"] = ex.replace(c["front"], "＿＿", 1), (c.get("example_vi") or "Chọn từ điền vào chỗ trống"), ex
        q["options"], q["answer"] = _options(c["front"], [p["front"] for p in others])
    elif typ == "spell":
        q["prompt"], q["sub"] = ans, "Gõ lại từ (bấm 🔊 để nghe)"
        q["answer"] = c["front"]
        q["alt"] = [c["reading"]] if c.get("reading") else []
    else:
        return None
    if typ in ("mean", "rev", "listen", "read", "cloze") and len(q["options"]) < 3:
        return None
    q["front"], q["reading"], q["meaning"] = c["front"], c.get("reading"), ans
    return q


def _match(cards: list[dict]) -> dict:
    pairs = [{"id": c["id"], "front": c["front"], "meaning": _ans(c)} for c in cards]
    right = [p["meaning"] for p in pairs]
    random.shuffle(right)
    return {"type": "match", "card_ids": [p["id"] for p in pairs], "sub": "Ghép từ với nghĩa đúng", "pairs": pairs, "right": right}


@router.get("/quiz")
def make_quiz(subject: str, kind: str = "practice", deck: int | None = None, n: int = 0):
    learn.ensure()
    learn._subject(subject)
    if kind not in KINDS:
        raise HTTPException(400, "Loại bài không đúng.")
    level = None
    if kind == "level":
        d = db.one("SELECT * FROM learn_decks WHERE id=?", (deck,)) if deck else None
        if not d:
            raise HTTPException(400, "Chọn cấp cần kiểm tra.")
        level = d["level"]
    n = max(4, min(n or SIZE[kind], 60))
    cards = _pick_cards(subject, kind, deck, n)
    if len(cards) < 4:
        raise HTTPException(400, "Cần học ít nhất 4 từ (có nghĩa) trước khi làm bài. Bấm HỌC NGAY để học từ mới.")
    pool = _pool(subject, deck if kind == "level" else None)
    types = ["mean", "rev", "listen", "tf", "mean", "rev"]
    if subject in ("ja", "zh"):
        types += ["read", "read"]
    if kind == "practice":
        types += ["spell", "cloze", "cloze"]
    else:
        types += ["cloze"]
    qs: list[dict] = []
    rest = list(cards)
    if kind == "practice" and len(rest) >= 8:          # một câu ghép cặp ở đầu bài
        qs.append(_match(rest[:4]))
        rest = rest[4:]
    for c in rest:
        for typ in random.sample(types, len(types)):
            q = _question(c, typ, pool)
            if q:
                qs.append(q)
                break
    for i, q in enumerate(qs):
        q["n"] = i
    return {"subject": subject, "kind": kind, "title": KINDS[kind], "deck_id": deck, "level": level, "questions": qs,
            "time_limit": TIME[kind], "pass": PASS, "lang": learn.SUBJECTS[subject]["lang"]}


class ResultIn(BaseModel):
    subject: str
    kind: str
    deck_id: int | None = None
    level: str | None = None
    total: int
    correct: int
    seconds: float = 0
    wrong: list[int] = []
    detail: list[dict] = []


@router.post("/quiz/result")
def quiz_result(body: ResultIn):
    learn.ensure()
    learn._subject(body.subject)
    if body.kind not in KINDS or body.total <= 0:
        raise HTTPException(400, "Kết quả không hợp lệ.")
    correct = max(0, min(body.correct, body.total))
    pct = round(correct / body.total * 100)
    passed = body.kind != "practice" and pct >= PASS
    day = learn._today()
    tid = db.execute("INSERT INTO learn_tests(subject, kind, deck_id, level, day, total, correct, pct, passed, seconds, at, detail) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (body.subject, body.kind, body.deck_id, body.level, day, body.total, correct, pct, int(passed),
                      int(min(max(body.seconds, 0), 7200)), time.time(), json.dumps(body.detail[:80], ensure_ascii=False)))
    now = time.time()
    for cid in set(body.wrong[:100]):          # từ làm sai: ôn lại ngay hôm nay
        db.execute("UPDATE learn_cards SET due=?, ease=MAX(1.3, ease-0.15), lapses=lapses+(state='review'), "
                   "state=CASE WHEN state='review' THEN 'learning' ELSE state END, step=CASE WHEN state='review' THEN 1 ELSE step END "
                   "WHERE id=? AND state!='new'", (now, cid))
    db.execute("INSERT INTO learn_log(day, subject) VALUES (?, ?) ON CONFLICT(day, subject) DO NOTHING", (day, body.subject))
    db.execute("UPDATE learn_log SET reviews=reviews+?, correct=correct+?, seconds=seconds+? WHERE day=? AND subject=?",
               (body.total, correct, int(min(max(body.seconds, 0), 7200)), day, body.subject))
    nxt = None
    if body.kind == "level" and passed and body.level:
        try:
            ids = [x["id"] for x in path_data(body.subject)["levels"]]
            if body.level in ids and ids.index(body.level) + 1 < len(ids):
                nxt = ids[ids.index(body.level) + 1]
        except HTTPException:
            pass
    return {"id": tid, "pct": pct, "passed": passed, "pass": PASS, "next_level": nxt}


def _week_due(subject: str) -> dict:
    last = db.one("SELECT at FROM learn_tests WHERE subject=? AND kind='week' ORDER BY at DESC LIMIT 1", (subject,))
    seen = db.one("SELECT COUNT(*) AS n FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id WHERE d.subject=? AND c.reps>0 "
                  "AND d.section NOT IN ('kana','hangul','pinyin')", (subject,))["n"]
    days = None if not last else (time.time() - last["at"]) / 86400
    return {"due": seen >= 20 and (days is None or days >= WEEK_EVERY), "days_since": None if days is None else int(days),
            "next_in": None if days is None or days >= WEEK_EVERY else WEEK_EVERY - int(days), "seen": seen}


def _level_ready(subject: str) -> list[dict]:
    """Cấp của lộ trình đã học ≥ 80% từ mà chưa qua kiểm tra cuối cấp."""
    out = []
    for d in db.query("SELECT id, level, name FROM learn_decks WHERE subject=? AND builtin LIKE 'path:%'", (subject,)):
        st = learn._stats(subject, d["id"])
        seen = st["total"] - st["new"]
        if st["total"] and seen / st["total"] >= 0.8 and not _passed(subject, d["level"]):
            out.append({"deck_id": d["id"], "level": d["level"], "name": d["name"]})
    return out


@router.get("/tests")
def tests(subject: str, limit: int = 30):
    learn.ensure()
    learn._subject(subject)
    rows = db.query("SELECT id, kind, level, day, total, correct, pct, passed, seconds, at FROM learn_tests WHERE subject=? "
                    "ORDER BY at DESC LIMIT ?", (subject, max(1, min(limit, 200))))
    return {"items": rows, "week": _week_due(subject), "levels": _level_ready(subject), "pass": PASS}


@router.get("/tests/{tid}")
def test_detail(tid: int):
    r = db.one("SELECT * FROM learn_tests WHERE id=?", (tid,))
    if not r:
        raise HTTPException(404, "Không có bài này.")
    r["detail"] = json.loads(r["detail"] or "[]")
    return r


# ================================================================== hôm nay học gì
def _suggest() -> list[dict]:
    items = []
    tested = {(r["subject"], r["kind"]) for r in db.query("SELECT DISTINCT subject, kind FROM learn_tests WHERE day=?", (learn._today(),))}
    conf = learn.settings().get("paths") or {}
    for sid, info in learn.SUBJECTS.items():
        st = learn._stats(sid)
        if not st["total"]:
            continue
        if st["due"]:
            items.append({"key": f"review:{sid}", "kind": "review", "subject": sid, "n": st["due"],
                          "title": f"Ôn {st['due']} thẻ đến hạn", "desc": info["name"]})
        lv = (conf.get(sid) or {}).get("level")
        if st["new"] and (lv or st["total"] > st["new"]):       # chỉ gợi ý môn đang học (đã chọn lộ trình hoặc đã học thẻ)
            n = int((conf.get(sid) or {}).get("per_day") or learn.settings()["new_per_day"])
            items.append({"key": f"new:{sid}", "kind": "new", "subject": sid, "n": n,
                          "title": f"Học {n} từ mới", "desc": info["name"] + (f" · lộ trình {lv}" if lv else "")})
        seen = db.one("SELECT COUNT(*) AS n FROM learn_cards c JOIN learn_decks d ON d.id=c.deck_id WHERE d.subject=? AND c.reps>0 "
                      "AND d.section NOT IN ('kana','hangul','pinyin') AND COALESCE(c.meaning, c.en) IS NOT NULL", (sid,))["n"]
        if seen >= 4:
            items.append({"key": f"practice:{sid}", "kind": "practice", "subject": sid, "n": SIZE["practice"],
                          "title": "Làm bài tập 12 câu", "desc": info["name"], "done_test": (sid, "practice") in tested})
        if _week_due(sid)["due"]:
            items.append({"key": f"week:{sid}", "kind": "week", "subject": sid, "n": SIZE["week"],
                          "title": "Kiểm tra tuần (20 câu)", "desc": info["name"] + " · đã đến hạn", "done_test": (sid, "week") in tested})
        for lr in _level_ready(sid):
            items.append({"key": f"level:{sid}:{lr['deck_id']}", "kind": "level", "subject": sid, "deck_id": lr["deck_id"], "n": SIZE["level"],
                          "title": f"Kiểm tra cuối cấp {lr['level']}", "desc": info["name"] + " · đã học 80% cấp này"})
    return items


def _progress(it: dict) -> dict:
    sid, kind = it["subject"], it["kind"]
    day = learn._today()
    log = db.one("SELECT * FROM learn_log WHERE day=? AND subject=?", (day, sid)) or {}
    if kind == "review":
        left = learn._stats(sid)["due"]
        return {"done": left == 0, "left": left}
    if kind == "new":
        got = int(log.get("news") or 0)
        return {"done": got >= int(it.get("n") or 0), "got": got}
    t = db.one("SELECT pct FROM learn_tests WHERE day=? AND subject=? AND kind=? ORDER BY at DESC LIMIT 1", (day, sid, kind))
    return {"done": bool(t), "pct": t["pct"] if t else None}


@router.get("/today")
def today():
    learn.ensure()
    day = learn._today()
    row = db.one("SELECT items FROM learn_plan WHERE day=?", (day,))
    sug = _suggest()
    plan = None
    if row:
        plan = [{**it, **_progress(it)} for it in json.loads(row["items"])]
    s = learn.settings()
    studied = (db.one("SELECT SUM(reviews) AS n FROM learn_log WHERE day=?", (day,)) or {}).get("n") or 0
    return {"day": day, "plan": plan, "suggest": [{**it, **_progress(it)} for it in sug], "remind": s["remind"],
            "remind_at": s["remind_at"], "studied": int(studied),
            "left": sum(1 for it in (plan or []) if not it["done"]) if plan is not None else None}


class PlanItem(BaseModel):
    key: str
    kind: str
    subject: str
    n: int = 0
    deck_id: int | None = None
    title: str = ""
    desc: str = ""


class PlanIn(BaseModel):
    items: list[PlanItem]


@router.put("/today")
def save_today(body: PlanIn):
    learn.ensure()
    items = []
    for it in body.items[:30]:
        if it.subject not in learn.SUBJECTS or it.kind not in ("review", "new", "practice", "week", "level"):
            continue
        d = it.model_dump()
        d["n"] = max(0, min(200, d["n"]))
        if d["kind"] == "new":
            d["title"] = f"Học {d['n']} từ mới"
        items.append(d)
    db.execute("INSERT INTO learn_plan(day, items, at) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET items=excluded.items, at=excluded.at",
               (learn._today(), json.dumps(items, ensure_ascii=False), time.time()))
    return today()


@router.delete("/today")
def clear_today():
    db.execute("DELETE FROM learn_plan WHERE day=?", (learn._today(),))
    return today()
