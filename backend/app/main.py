"""API FastAPI + phục vụ giao diện web."""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

import json

from . import config, db, detect, devices, discover, downloader, edit, gametr, gdrive, learn, music, novel, party, phone, storage, translate, unitygame, websites, ytdlp_update, ytmusic, ytvideo
from .manager import manager

WEB = config.WEB


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.conn()
    loop_task = asyncio.create_task(manager.loop())
    cfg = config.load()
    main_port = int(os.environ.get("CIRCLEVAULT_PORT") or cfg["port"])
    party_task = party.start_background(main_port, "0.0.0.0" if cfg["host"] == "0.0.0.0" else "127.0.0.1")
    yield
    loop_task.cancel()
    if party.PARTY.get("server"):
        party.PARTY["server"].should_exit = True
    party.tunnel.stop()
    party_task.cancel()


app = FastAPI(title="CircleVault", lifespan=lifespan)
app.add_middleware(devices.Guard)   # qua Wi-Fi: chỉ thiết bị đã ghép bằng mã QR
app.include_router(ytmusic.router)
app.include_router(ytmusic.acct)
app.include_router(discover.router)
app.include_router(music.router)
app.include_router(edit.router)
app.include_router(phone.router)
app.include_router(gdrive.router)
app.include_router(party.router)
app.include_router(websites.router)
app.include_router(ytvideo.router)
app.include_router(translate.router)
app.include_router(gametr.router)
app.include_router(unitygame.router)
app.include_router(novel.router)
app.include_router(learn.router)


# ------------------------------------------------------------------ status / config
@app.get("/api/status")
def status():
    cfg = config.load()
    counts = {r["kind"]: r["n"] for r in db.query("SELECT kind, COUNT(*) n FROM items GROUP BY kind")}
    size = db.one("SELECT COALESCE(SUM(filesize),0) s FROM items")["s"]
    return {
        "disks": storage.disks_status(cfg),
        "counts": counts,
        "library_bytes": size,
        "active": db.one("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','running','processing')")["n"],
        "app": {"version": config.VERSION, "desktop": config.IS_APP, "data": str(config.DATA)},
        "tools": {
            "yt_dlp": yt_dlp.version.__version__,
            "ffmpeg": downloader.HAS_FFMPEG,
            "deno": shutil.which("deno") is not None,
        },
    }


@app.get("/api/drives")
def drives():
    """Các ổ đang có trên máy, kèm thư mục lưu đề xuất (để thêm ổ bằng 1 nút)."""
    used = {Path(d["root"]).anchor.upper() for d in config.load()["disks"]}
    out = []
    for d in storage.list_drives():
        d["suggest"] = storage.suggest_root(d)
        d["used"] = Path(d["suggest"]).anchor.upper() in used or d["root"].upper() in used
        out.append(d)
    return out


@app.get("/api/config")
def get_config():
    return config.load()


@app.put("/api/config")
def put_config(body: dict):
    try:
        cfg = config.validate(body)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    config.save(cfg)
    manager.wake()
    return cfg


# ------------------------------------------------------------------ analyze / tasks
class AnalyzeIn(BaseModel):
    url: str
    playlist: bool | None = None


@app.post("/api/analyze")
async def analyze(body: AnalyzeIn):
    kind = detect.classify(body.url)
    if not kind["ok"]:
        raise HTTPException(400, kind["error"])
    if not kind["supported"]:
        return {"detect": kind, "info": None}
    playlist = body.playlist if body.playlist is not None else (kind["has_list"] and not kind["has_video"])
    cfg = config.load()
    try:
        info = await asyncio.wait_for(asyncio.to_thread(downloader.analyze, body.url, cfg, playlist), 90)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Trang phản hồi quá lâu. Thử lại sau.")
    except Exception as e:
        raise HTTPException(422, downloader.clean(str(e))[:400])
    disk = storage.pick_disk(cfg, kind["kind"])
    return {"detect": kind, "playlist": playlist, "info": info, "disk": disk}


class TaskIn(BaseModel):
    url: str
    quality: str | None = None
    playlist: bool = False
    force: bool = False
    title: str | None = None
    thumbnail: str | None = None
    kind: str | None = None                    # trình duyệt bắt link gửi "film"
    headers: dict[str, str] | None = None      # Referer/Origin/User-Agent/Cookie của trang phim
    music_playlist: int | None = None          # tải MP3 xong thêm vào playlist này (playlist đang mở ở Nghe Nhạc)
    music_playlist_name: str | None = None     # hoặc: tìm/tạo playlist theo tên (tải cả playlist online)


ALLOWED_HEADERS = {"referer": "Referer", "origin": "Origin", "user-agent": "User-Agent", "cookie": "Cookie"}


@app.post("/api/tasks")
def add_task(body: TaskIn):
    kind = detect.classify(body.url)
    if not kind["ok"]:
        raise HTTPException(400, kind["error"])
    if not kind["supported"]:
        raise HTTPException(400, kind["note"])
    cfg = config.load()
    quality = body.quality if body.quality in config.QUALITIES else cfg["default_quality"]
    k = body.kind if body.kind in ("film", "youtube", "other") else kind["kind"]
    headers = {ALLOWED_HEADERS[h.lower()]: v[:4000] for h, v in (body.headers or {}).items() if h.lower() in ALLOWED_HEADERS}
    mpl = None
    if quality == "audio":
        if body.music_playlist and db.one("SELECT id FROM playlists WHERE id=?", (body.music_playlist,)):
            mpl = body.music_playlist
        elif (body.music_playlist_name or "").strip():
            mpl = music.playlist_by_name(body.music_playlist_name)
    tid = db.create_task(body.url.strip(), k, quality, body.playlist, body.force,
                         (body.title or "").strip()[:200] or None, body.thumbnail,
                         json.dumps(headers) if headers else None, mpl)
    manager.wake()
    return db.one("SELECT * FROM tasks WHERE id=?", (tid,))


@app.get("/api/tasks")
def list_tasks():
    return manager.tasks()


@app.post("/api/tasks/{tid}/{action}")
def task_action(tid: int, action: str):
    if not db.one("SELECT id FROM tasks WHERE id=?", (tid,)):
        raise HTTPException(404, "Không tìm thấy tác vụ.")
    if action == "pause":
        manager.pause(tid)
    elif action == "cancel":
        manager.cancel(tid)
    elif action in ("resume", "retry"):
        manager.resume(tid)
    else:
        raise HTTPException(400, "Thao tác không hợp lệ.")
    return {"ok": True}


@app.delete("/api/tasks/{tid}")
def delete_task(tid: int):
    if tid in manager.running:
        raise HTTPException(409, "Tác vụ đang chạy. Hãy dừng trước khi xóa.")
    db.execute("DELETE FROM tasks WHERE id=?", (tid,))
    return {"ok": True}


@app.delete("/api/tasks")
def clear_finished():
    db.execute("DELETE FROM tasks WHERE status IN ('done','canceled')")
    return {"ok": True}


# ------------------------------------------------------------------ tài khoản YouTube (đăng nhập trong cửa sổ YouTube của app)
@app.get("/api/youtube")
def youtube_status():
    cfg = config.load()
    logged = downloader.youtube_logged_in()
    updated = config.YT_COOKIES.stat().st_mtime if logged else None
    return {"logged_in": logged, "updated_at": updated, "use_account": cfg.get("use_youtube_account", True)}


@app.delete("/api/youtube")
def youtube_logout():
    for f in (config.YT_COOKIES, config.YT_COOKIES_BROWSER, config.YT_COOKIES_APP):
        f.unlink(missing_ok=True)
    return youtube_status()


# ------------------------------------------------------------------ library
@app.get("/api/library")
def library(q: str = "", kind: str = "", limit: int = 120, offset: int = 0):
    where, args = [], []
    if q:
        where.append("(title LIKE ? OR uploader LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    if kind:
        where.append("kind = ?")
        args.append(kind)
    sql = "SELECT * FROM items" + (" WHERE " + " AND ".join(where) if where else "")
    total = db.one(sql.replace("SELECT *", "SELECT COUNT(*) n", 1), tuple(args))["n"]
    rows = db.query(sql + " ORDER BY id DESC LIMIT ? OFFSET ?", (*args, min(limit, 500), offset))
    for r in rows:
        r["exists"] = os.path.exists(r["filepath"])
    return {"total": total, "items": rows}


def _item(iid: int) -> dict:
    it = db.one("SELECT * FROM items WHERE id=?", (iid,))
    if not it:
        raise HTTPException(404, "Không tìm thấy mục này.")
    return it


@app.get("/api/library/{iid}/file")
def library_file(iid: int):
    it = _item(iid)
    if not os.path.exists(it["filepath"]):
        raise HTTPException(404, "File không còn trên ổ (có thể đã bị xóa hoặc di chuyển).")
    return FileResponse(it["filepath"])


@app.post("/api/library/{iid}/open")
def library_open(iid: int, request: Request):
    """Mở thư mục chứa file trong Explorer/Finder (chỉ khi gọi từ chính máy này)."""
    if request.client and request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Chỉ mở được thư mục khi dùng app trên chính máy tính.")
    path = Path(_item(iid)["filepath"])
    if not path.exists():
        raise HTTPException(404, "File không còn trên ổ.")
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", str(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])
    return {"ok": True}


@app.delete("/api/library/{iid}")
def library_delete(iid: int, delete_file: bool = False):
    it = _item(iid)
    if delete_file and os.path.exists(it["filepath"]):
        os.remove(it["filepath"])
    db.execute("DELETE FROM items WHERE id=?", (iid,))
    return {"ok": True}


# ------------------------------------------------------------------ tools
@app.post("/api/tools/update-ytdlp")
async def update_ytdlp():
    try:
        return await asyncio.to_thread(ytdlp_update.update)
    except Exception as e:
        raise HTTPException(502, f"Không cập nhật được yt-dlp: {downloader.clean(str(e))[:300]}")


# ------------------------------------------------------------------ giao diện
app.mount("/static", party.NoCacheStatic(directory=WEB), name="static")


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/dt")
def phone_page():
    """Trang "Mang theo điện thoại" (mở từ điện thoại cùng Wi-Fi)."""
    return FileResponse(WEB / "dt.html", headers={"Cache-Control": "no-cache"})
