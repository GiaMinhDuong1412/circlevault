"""Thanh "Tiến trình": gom mọi việc đang chạy nền (tải về, dịch game/truyện, lọc câu, kiểm tra font, cắt video) vào một danh sách gọn.

Chỉ đọc trạng thái có sẵn trong bộ nhớ / dự án ĐANG chạy (không mở mọi file dự án mỗi lần hỏi). Trang hỏi 2–6 giây/lần.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends

from . import devices, edit, gametr, novel, translate
from .manager import manager

router = APIRouter(prefix="/api/progress", dependencies=[Depends(devices.local_only)])
ACTIVE = ("running", "processing", "queued", "paused")


def _pct(done: float, total: float) -> float | None:
    return round(done / total * 100, 1) if total else None


def _fmt_eta(s) -> str:
    try:
        s = int(s)
    except (TypeError, ValueError):
        return ""
    return f"còn {s // 3600} giờ {s % 3600 // 60} phút" if s >= 3600 else f"còn {s // 60} phút {s % 60} giây" if s >= 60 else f"còn {s} giây"


def _downloads() -> list[dict]:
    out = []
    now = time.time()
    for t in manager.tasks():
        if t.get("status") in ("done", "error") and now - float(t.get("updated_at") or 0) < 900:
            out.append({"key": f"dl:{t['id']}", "kind": "dl", "label": "Tải về", "title": t.get("title") or t["url"], "pct": 100,
                        "status": t["status"], "sub": (t.get("error") or "")[:120], "open": {"hash": "#queue"},
                        "at": float(t.get("updated_at") or now)})
            continue
        if t.get("status") not in ACTIVE:
            continue
        sub = []
        if t.get("item_count") and t["item_count"] > 1:
            sub.append(f"bài {t.get('item_index') or 0}/{t['item_count']}")
        if t.get("speed"):
            sp = float(t["speed"])
            sub.append(f"{sp / 1048576:.1f} MB/s" if sp >= 1048576 else f"{sp / 1024:.0f} KB/s")
        if t.get("eta"):
            sub.append(_fmt_eta(t["eta"]))
        out.append({"key": f"dl:{t['id']}", "kind": "dl", "label": "Tải về", "title": t.get("current_title") or t.get("title") or t["url"],
                    "pct": t.get("progress") or 0, "status": t["status"],
                    "sub": " · ".join(sub) or {"queued": "đang chờ", "paused": "tạm dừng", "processing": "đang xử lý"}.get(t["status"], ""),
                    "open": {"hash": "#queue"}})
    return out


def _worker_ids(w) -> list[tuple[str, str]]:
    ids = [(w.current, "running")] if w.current else []
    return ids + [(x, "queued") for x in list(w.queue) if x != w.current]


def _games() -> list[dict]:
    out = []
    seen = set()
    for pid, st in _worker_ids(gametr.WORKER):
        try:
            p = gametr._load(pid)
        except Exception:       # dự án đã xóa
            continue
        s = gametr._summary(p)
        seen.add(pid)
        out.append({"key": f"game:{pid}", "kind": "game", "label": "Việt hóa game", "title": s["name"], "pct": _pct(s["done"], s["total"]),
                    "status": st, "sub": f"{s['done']:,}/{s['total']:,} câu".replace(",", ".") + (" · đang chờ lượt" if st == "queued" else "")
                    + (f" · {s['note'][:60]}" if s.get("note") else ""), "open": {"tr": "game", "id": pid}})
    for pid, job in list(gametr._apply_jobs.items()):
        if job.get("state") == "running":
            out.append({"key": f"apply:{pid}", "kind": "game", "label": "Áp dụng vào game", "title": job.get("name") or "",
                        "pct": round(job["done"] / job["total"] * 100, 1) if job.get("total") else None, "status": "running",
                        "sub": job.get("text") or "", "open": {"tr": "game", "id": pid}})
    for pid, job in list(gametr._font_jobs.items()):
        if job.get("state") == "running" and time.time() - job.get("started", 0) < 1800:
            out.append({"key": f"font:{pid}", "kind": "font", "label": "Kiểm tra font", "title": job.get("text") or "", "pct": None,
                        "status": "running", "sub": "", "open": {"tr": "game", "id": pid}})
    for pid, job in list(gametr._ui_jobs.items()):
        if job.get("state") == "running":
            out.append({"key": f"uiscan:{pid}", "kind": "review", "label": "Tìm chữ nút / menu", "title": job.get("name") or "",
                        "pct": _pct(job.get("done", 0), job.get("total", 0)), "status": "running",
                        "sub": job.get("text") or "", "open": {"tr": "game", "id": pid}})
    for pid in list(gametr.REVIEWING):
        try:
            p = gametr._load(pid)
        except Exception:       # dự án đã xóa
            gametr.REVIEWING.discard(pid)
            continue
        rv = p.get("review") or {}
        if rv.get("state") != "running":
            gametr.REVIEWING.discard(pid)
            continue
        out.append({"key": f"review:{pid}", "kind": "review", "label": "Lọc câu cần dịch", "title": p["name"],
                    "pct": _pct(rv.get("done", 0), rv.get("total", 0)), "status": "running",
                    "sub": f"Claude đã xem {rv.get('done', 0)}/{rv.get('total', 0)} câu", "open": {"tr": "game", "id": pid}})
    return out


def _books() -> list[dict]:
    out = []
    for bid, st in _worker_ids(translate.WORKER):
        try:
            s = translate._summary(translate._load(bid))
        except Exception:       # truyện đã xóa
            continue
        out.append({"key": f"book:{bid}", "kind": "book", "label": "Dịch truyện tranh", "title": s["name"], "pct": _pct(s["done"], s["pages"]),
                    "status": st, "sub": f"{s['done']}/{s['pages']} trang" + (" · đang chờ lượt" if st == "queued" else ""),
                    "open": {"tr": "book", "id": bid}})
    return out


def _novels() -> list[dict]:
    out = []
    for nid, st in _worker_ids(novel.WORKER):
        try:
            s = novel._summary(novel._load(nid))
        except Exception:       # truyện đã xóa
            continue
        out.append({"key": f"novel:{nid}", "kind": "novel", "label": "Dịch truyện chữ", "title": s["name"], "pct": _pct(s["done"], s["paras"]),
                    "status": st, "sub": f"{s['chapters_done']}/{s['chapters']} chương" + (" · đang chờ lượt" if st == "queued" else ""),
                    "open": {"tr": "novel", "id": nid}})
    return out


def _edits() -> list[dict]:
    out = []
    for jid, j in list(edit._jobs.items()):
        if j.get("status") in ("queued", "running"):
            out.append({"key": f"edit:{jid}", "kind": "edit", "label": "Cắt / chuyển video", "title": j.get("label") or "",
                        "pct": float(j.get("progress") or 0),
                        "status": j["status"], "sub": "", "open": {"hash": "#library"}})
    return out


@router.get("")
def progress():
    items: list[dict] = []
    for fn in (_downloads, _games, _books, _novels, _edits):
        try:
            items += fn()
        except Exception:       # một nguồn lỗi không làm hỏng cả danh sách
            continue
    return {"items": items, "at": time.time()}
