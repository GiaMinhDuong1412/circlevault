"""Nhật ký của app (tab Cài đặt → Nhật ký): LỖI của mọi chức năng + việc CHẠY LÂU để cải tiến.

Ghi vào DATA/logs/{loi,cham}.jsonl (mỗi dòng một JSON, quá 2 MB thì đổi sang .1.jsonl – giữ 1 bản cũ). Nguồn:
  * middleware ASGI `Timing`: mọi /api/… – thời gian tới khi trả đầu phản hồi, lỗi 5xx / ngoại lệ (kèm traceback), lỗi 400/422
    (thông báo người dùng thấy); bỏ các đường dẫn phát luồng / hỏi tiến độ liên tục (`QUIET`).
  * `track(tên)`: bao việc chạy nền (áp dụng bản dịch, tìm chữ, kiểm tra font, dịch, tải…) – ghi thời gian + lỗi.
  * logging ERROR của mọi module, ngoại lệ không bắt trong luồng (`threading.excepthook`).
  * trang web: lỗi JS (window.onerror / unhandledrejection) gửi `POST /api/logs/client`.
Chỉ máy này xem được (`devices.local_only`); KHÔNG ghi query string (có thể chứa link/cookie).
"""
from __future__ import annotations

import json
import logging
import re
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from . import config, devices

DIR = config.DATA / "logs"
FILES = {"error": "loi", "slow": "cham"}
MAX_BYTES = 2 * 1024 * 1024
SLOW_API = 3.0            # giây – yêu cầu API chậm hơn mức này là "chạy lâu"
SLOW_JOB = 20.0           # giây – việc chạy nền
_lock = threading.Lock()

# đường dẫn không đo (phát nhạc/video, ảnh, hỏi tiến độ mỗi 1–2 giây, nhật ký chính nó)
QUIET = re.compile(r"^/api/(logs|progress)|/stream|/s/|/media|/file|/cover|/thumb|/qr\.svg|/_blob/|/av/|/x$|"
                   r"/apply$|/scan/|/uiscan$|/find$|/fonts$|/review$|/parts/", re.I)


def _norm(path: str) -> str:
    """/api/translate/games/abc123def456/apply → /api/translate/games/{id}/apply (gom thống kê theo chức năng)."""
    out = []
    for seg in path.split("/"):
        if re.fullmatch(r"[0-9a-f]{8,}|\d+|[0-9a-f-]{32,36}|[A-Za-z0-9_-]{20,}", seg):
            seg = "{id}"
        out.append(seg)
    return "/".join(out)


def write(kind: str, rec: dict) -> None:
    """Ghi một dòng nhật ký – không bao giờ làm hỏng chức năng đang chạy."""
    try:
        rec = {"at": time.time(), **rec}
        line = json.dumps(rec, ensure_ascii=False, default=str)[:20000] + "\n"
        with _lock:
            DIR.mkdir(parents=True, exist_ok=True)
            p = DIR / f"{FILES[kind]}.jsonl"
            if p.exists() and p.stat().st_size > MAX_BYTES:
                old = DIR / f"{FILES[kind]}.1.jsonl"
                if old.exists():
                    old.unlink()
                p.rename(old)
            with open(p, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:       # ổ đầy / không quyền: bỏ qua
        pass


def error(name: str, msg: str, tb: str = "", **kw) -> None:
    write("error", {"name": name, "msg": str(msg)[:2000], "tb": tb[-8000:], **kw})


def slow(name: str, sec: float, **kw) -> None:
    write("slow", {"name": name, "sec": round(sec, 2), **kw})


@contextmanager
def track(name: str, limit: float = SLOW_JOB, **kw):
    """with applog.track("Áp dụng vào game", game=…): ghi lỗi (rồi ném tiếp) và thời gian nếu lâu."""
    t = time.time()
    try:
        yield
    except Exception as e:
        error(name, f"{type(e).__name__}: {e}", traceback.format_exc(), kind="job", sec=round(time.time() - t, 2), **kw)
        raise
    finally:
        d = time.time() - t
        if d >= limit:
            slow(name, d, kind="job", **kw)


def wrap(name: str, fn, *args, job: dict | None = None, limit: float = SLOW_JOB, **meta):
    """Hàm cho threading.Thread: đo thời gian; lỗi = ngoại lệ HOẶC job kết thúc với state/status "error"."""
    def run():
        t = time.time()
        try:
            fn(*args)
        except Exception as e:
            error(name, f"{type(e).__name__}: {e}", traceback.format_exc(), kind="job", **meta)
            raise
        finally:
            d = time.time() - t
            if job is not None and "error" in (job.get("state"), job.get("status")):
                msg = job.get("error") or job.get("text") or "lỗi không rõ"
                error(name, msg if isinstance(msg, str) else json.dumps(msg, ensure_ascii=False), kind="job", sec=round(d, 2), **meta)
            if d >= limit:
                slow(name, d, kind="job", **meta)
    return run


def _read(kind: str, limit: int = 500) -> list[dict]:
    rows: list[dict] = []
    for name in (f"{FILES[kind]}.1.jsonl", f"{FILES[kind]}.jsonl"):
        p = DIR / name
        if not p.exists():
            continue
        try:
            for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            continue
    return rows[-limit:] if limit else rows


# ------------------------------------------------------------------ middleware ASGI (không bọc luồng phản hồi)
class Timing:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not scope.get("path", "").startswith("/api/") or QUIET.search(scope["path"]):
            return await self.app(scope, receive, send)
        t = time.time()
        info = {"status": 0, "t": 0.0, "body": b""}

        async def _send(msg):
            if msg["type"] == "http.response.start":
                info["status"] = msg.get("status", 0)
                info["t"] = time.time() - t
            elif msg["type"] == "http.response.body" and 400 <= info["status"] < 500 and len(info["body"]) < 4000:
                info["body"] += msg.get("body", b"")[:4000]
            await send(msg)
        name = f'{scope.get("method", "")} {_norm(scope["path"])}'
        try:
            await self.app(scope, receive, _send)
        except Exception as e:
            error(name, f"{type(e).__name__}: {e}", traceback.format_exc(), kind="api", path=scope["path"])
            raise
        st, d = info["status"], info["t"] or (time.time() - t)
        if st >= 500:
            error(name, f"Lỗi máy chủ {st}", kind="api", status=st, path=scope["path"])
        elif st in (400, 422, 424):
            detail = ""
            try:
                detail = json.loads(info["body"] or b"{}").get("detail") or ""
            except Exception:       # không phải JSON
                detail = info["body"][:300].decode("utf-8", "replace")
            if isinstance(detail, list):              # lỗi 422 của FastAPI: "body.path: Field required"
                detail = "Dữ liệu gửi lên không hợp lệ: " + "; ".join(
                    f'{".".join(str(x) for x in (d.get("loc") or [])[1:])}: {d.get("msg", "")}' for d in detail if isinstance(d, dict))[:400]
            error(name, detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)[:500],
                  kind="api", status=st, path=scope["path"], level="warn")
        if d >= SLOW_API:
            slow(name, d, kind="api", status=st)


# ------------------------------------------------------------------ bắt lỗi chung
class _Handler(logging.Handler):
    def emit(self, record):
        if record.name.startswith(("uvicorn.access",)):
            return
        tb = ""
        if record.exc_info:
            tb = "".join(traceback.format_exception(*record.exc_info))
        error(record.name, record.getMessage(), tb, kind="log")


def install() -> None:
    h = _Handler(level=logging.ERROR)
    logging.getLogger().addHandler(h)
    old = threading.excepthook

    def hook(args):
        if args.exc_type is not SystemExit:
            error(f"luồng {getattr(args.thread, 'name', '?')}", f"{args.exc_type.__name__}: {args.exc_value}",
                  "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)), kind="thread")
        old(args)
    threading.excepthook = hook


# ------------------------------------------------------------------ API
router = APIRouter(prefix="/api/logs", dependencies=[Depends(devices.local_only)])


def _desktop_log(n: int = 200) -> list[str]:
    """Nhật ký của app Electron (%APPDATA%\\CircleVault\\nhat-ky.txt, cạnh thư mục dữ liệu)."""
    p = config.DATA.parent / "nhat-ky.txt"
    if not p.is_file():
        return []
    try:
        with open(p, "rb") as f:
            f.seek(max(0, p.stat().st_size - 200_000))
            lines = f.read().decode("utf-8", "replace").splitlines()
        return lines[-n:]
    except OSError:
        return []


def _summary(rows: list[dict]) -> list[dict]:
    g: dict[str, dict] = {}
    for r in rows:
        x = g.setdefault(r.get("name", "?"), {"name": r.get("name", "?"), "kind": r.get("kind"), "n": 0, "sum": 0.0, "max": 0.0, "last": 0})
        x["n"] += 1
        x["sum"] += r.get("sec", 0)
        x["max"] = max(x["max"], r.get("sec", 0))
        x["last"] = max(x["last"], r.get("at", 0))
    out = [{**x, "avg": round(x["sum"] / x["n"], 2), "sum": round(x["sum"], 1)} for x in g.values()]
    return sorted(out, key=lambda x: -x["sum"])


@router.get("")
def logs(limit: int = 300):
    err = _read("error", 0)
    sl = _read("slow", 0)
    since = time.time() - 86400
    return {"errors": list(reversed(err[-limit:])), "slow": list(reversed(sl[-limit:])), "slow_sum": _summary(sl),
            "counts": {"errors": len(err), "errors_24h": sum(1 for r in err if r.get("at", 0) >= since and r.get("level") != "warn"),
                       "slow": len(sl)},
            "limits": {"api": SLOW_API, "job": SLOW_JOB}, "desktop": _desktop_log(), "version": config.VERSION}


@router.delete("")
def clear():
    with _lock:
        for k in FILES.values():
            for n in (f"{k}.jsonl", f"{k}.1.jsonl"):
                p = DIR / n
                if p.exists():
                    p.unlink()
    return {"ok": True}


class ClientErr(BaseModel):
    msg: str
    src: str = ""
    stack: str = ""
    view: str = ""


@router.post("/client")
def client(body: ClientErr, request: Request):
    error(f"trang: {body.view or '?'}", body.msg[:1000], (body.stack or body.src)[:6000], kind="page")
    return {"ok": True}


@router.get("/export", response_class=PlainTextResponse)
def export():
    """Một file chữ gọn để gửi cho Claude / người sửa app."""
    def ts(x):
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(x.get("at", 0)))
    lines = [f"CircleVault {config.VERSION} – nhật ký xuất lúc {time.strftime('%Y-%m-%d %H:%M:%S')}", "", "=== CHẠY LÂU (gộp theo chức năng) ==="]
    for s in _summary(_read("slow", 0))[:60]:
        lines.append(f"- {s['name']}: {s['n']} lần, trung bình {s['avg']} s, lâu nhất {round(s['max'], 1)} s, tổng {s['sum']} s")
    lines += ["", "=== LỖI (mới nhất trước) ==="]
    for r in reversed(_read("error", 400)):
        lines.append(f"[{ts(r)}] {r.get('name')} ({r.get('kind')}{' ' + str(r['status']) if r.get('status') else ''}): {r.get('msg')}")
        if r.get("tb"):
            lines += ["    " + x for x in r["tb"].strip().splitlines()[-25:]]
    d = _desktop_log(120)
    if d:
        lines += ["", "=== NHẬT KÝ APP (nhat-ky.txt, cuối) ==="] + d
    return PlainTextResponse("\n".join(lines), headers={"Content-Disposition": 'attachment; filename="circlevault-nhat-ky.txt"'})
