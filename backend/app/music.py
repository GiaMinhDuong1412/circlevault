"""Nghe nhạc: quét thư mục nhạc + nhạc đã tải, đọc tag/ảnh bìa, playlist, lưu cài đặt EQ."""
from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import re
import threading
import time
from pathlib import Path

import mutagen
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import config, db

AUDIO_EXT = {".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".oga", ".wav", ".webm"}
SETTINGS_PATH = config.DATA / "music.json"

router = APIRouter(prefix="/api/music")
_scan_lock = threading.Lock()
scan_state = {"running": False, "done": 0, "total": 0, "added": 0, "removed": 0, "finished_at": None, "error": None}

_YT_NAME = re.compile(r"^(\d{3} - )?(\d{4}-\d{2}-\d{2} )?(.*?)( \[[\w-]{6,}\])?$")


# ------------------------------------------------------------------ tag
def _clean_stem(path: str) -> str:
    """'007 - 2026-01-05 Tên bài [abc123]' → 'Tên bài'."""
    m = _YT_NAME.match(Path(path).stem)
    return (m.group(3) if m else Path(path).stem).strip() or Path(path).stem


def cover_of(path: str) -> tuple[bytes, str] | None:
    try:
        f = mutagen.File(path)
    except Exception:
        return None
    if f is None:
        return None
    tags = f.tags
    try:
        if tags is not None and hasattr(tags, "getall"):                 # MP3 (ID3)
            apic = tags.getall("APIC")
            if apic:
                return apic[0].data, apic[0].mime or "image/jpeg"
        if tags is not None and "covr" in tags:                          # M4A
            c = tags["covr"][0]
            return bytes(c), "image/png" if getattr(c, "imageformat", 13) == 14 else "image/jpeg"
        if getattr(f, "pictures", None):                                  # FLAC
            p = f.pictures[0]
            return p.data, p.mime or "image/jpeg"
        if tags is not None and "metadata_block_picture" in tags:        # Ogg / Opus
            from mutagen.flac import Picture
            p = Picture(base64.b64decode(tags["metadata_block_picture"][0]))
            return p.data, p.mime or "image/jpeg"
    except Exception:
        return None
    return None


def read_tags(path: str) -> dict:
    out = {"title": None, "artist": None, "album": None, "duration": None}
    try:
        f = mutagen.File(path, easy=True)
        if f is not None:
            out["duration"] = getattr(f.info, "length", None)
            tags = f.tags or {}

            def first(k):
                try:
                    v = tags.get(k)
                except Exception:
                    return None
                return str(v[0]).strip() if v else None

            out.update(title=first("title"), artist=first("artist") or first("albumartist"), album=first("album"))
    except Exception:
        pass
    out["title"] = out["title"] or _clean_stem(path)
    out["has_cover"] = int(cover_of(path) is not None)
    return out


def upsert(path: str, source: str) -> int | None:
    path = os.path.abspath(path)
    try:
        st = os.stat(path)
    except OSError:
        return None
    old = db.one("SELECT id, mtime FROM tracks WHERE path=?", (path,))
    if old and abs((old["mtime"] or 0) - st.st_mtime) < 1:
        return old["id"]
    t = read_tags(path)
    if old:
        db.execute("UPDATE tracks SET title=?, artist=?, album=?, duration=?, size=?, mtime=?, has_cover=? WHERE id=?",
                   (t["title"], t["artist"], t["album"], t["duration"], st.st_size, st.st_mtime, t["has_cover"], old["id"]))
        return old["id"]
    return db.execute(
        "INSERT INTO tracks (path, title, artist, album, duration, size, mtime, has_cover, source, added_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (path, t["title"], t["artist"], t["album"], t["duration"], st.st_size, st.st_mtime, t["has_cover"], source, time.time()))


def is_audio(path: str) -> bool:
    return Path(path).suffix.lower() in AUDIO_EXT


# ------------------------------------------------------------------ quét
def scan() -> dict:
    if not _scan_lock.acquire(blocking=False):
        return scan_state
    try:
        scan_state.update(running=True, done=0, total=0, added=0, removed=0, error=None)
        cfg = config.load()
        files: list[tuple[str, str]] = []
        for folder in cfg.get("music_folders", []):
            for root, _dirs, names in os.walk(folder):
                files += [(os.path.join(root, n), "folder") for n in names if is_audio(n)]
        files += [(r["filepath"], "library") for r in db.query("SELECT filepath FROM items") if is_audio(r["filepath"])]
        scan_state["total"] = len(files)
        before = db.one("SELECT COUNT(*) n FROM tracks")["n"]
        for path, source in files:
            upsert(path, source)
            scan_state["done"] += 1
        removed = 0
        for r in db.query("SELECT id, path FROM tracks"):
            if not os.path.exists(r["path"]):
                db.execute("DELETE FROM tracks WHERE id=?", (r["id"],))
                removed += 1
        after = db.one("SELECT COUNT(*) n FROM tracks")["n"]
        scan_state.update(added=max(0, after - before + removed), removed=removed)
    except Exception as e:
        scan_state["error"] = str(e)[:300]
    finally:
        scan_state.update(running=False, finished_at=time.time())
        _scan_lock.release()
    return scan_state


# ------------------------------------------------------------------ API
@router.get("/tracks")
def tracks(q: str = "", playlist: int | None = None, sort: str = "recent"):
    if playlist:
        pl = db.one("SELECT * FROM playlists WHERE id=?", (playlist,))
        if not pl:
            raise HTTPException(404, "Không tìm thấy playlist.")
        ids = json.loads(pl["track_ids"] or "[]")
        if not ids:
            return []
        rows = {r["id"]: r for r in db.query(
            f"SELECT * FROM tracks WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))}
        return [rows[i] for i in ids if i in rows]
    order = {"recent": "added_at DESC", "title": "title COLLATE NOCASE", "artist": "artist COLLATE NOCASE, title",
             "plays": "play_count DESC, last_played DESC"}.get(sort, "added_at DESC")
    where, args = "", ()
    if q:
        where = "WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?"
        args = (f"%{q}%",) * 3
    return db.query(f"SELECT * FROM tracks {where} ORDER BY {order} LIMIT 10000", args)


@router.post("/scan")
async def start_scan():
    if not scan_state["running"]:
        asyncio.get_running_loop().run_in_executor(None, scan)
        await asyncio.sleep(0.05)
    return scan_state


@router.get("/scan")
def get_scan():
    return scan_state


def _track(tid: int) -> dict:
    t = db.one("SELECT * FROM tracks WHERE id=?", (tid,))
    if not t:
        raise HTTPException(404, "Không tìm thấy bài hát.")
    return t


@router.get("/{tid}/file")
def track_file(tid: int):
    t = _track(tid)
    if not os.path.exists(t["path"]):
        raise HTTPException(404, "File nhạc không còn trên ổ.")
    mime = mimetypes.guess_type(t["path"])[0] or "audio/mpeg"
    return FileResponse(t["path"], media_type=mime)


@router.get("/{tid}/cover")
def track_cover(tid: int):
    c = cover_of(_track(tid)["path"])
    if not c:
        raise HTTPException(404, "Bài này không có ảnh bìa.")
    return Response(content=c[0], media_type=c[1], headers={"Cache-Control": "max-age=86400"})


@router.post("/{tid}/played")
def track_played(tid: int):
    db.execute("UPDATE tracks SET play_count = play_count + 1, last_played=? WHERE id=?", (time.time(), tid))
    return {"ok": True}


# ---- playlist
class PlaylistIn(BaseModel):
    name: str


class TrackIds(BaseModel):
    track_ids: list[int]


@router.get("/playlists")
def playlists():
    rows = db.query("SELECT * FROM playlists ORDER BY name COLLATE NOCASE")
    for r in rows:
        r["count"] = len(json.loads(r.pop("track_ids") or "[]"))
    return rows


@router.post("/playlists")
def create_playlist(body: PlaylistIn):
    name = body.name.strip()[:80]
    if not name:
        raise HTTPException(400, "Cần đặt tên playlist.")
    now = time.time()
    pid = db.execute("INSERT INTO playlists (name, track_ids, created_at, updated_at) VALUES (?, '[]', ?, ?)",
                     (name, now, now))
    return {"id": pid, "name": name, "count": 0}


@router.put("/playlists/{pid}")
def rename_playlist(pid: int, body: PlaylistIn):
    db.execute("UPDATE playlists SET name=?, updated_at=? WHERE id=?", (body.name.strip()[:80], time.time(), pid))
    return {"ok": True}


@router.delete("/playlists/{pid}")
def delete_playlist(pid: int):
    db.execute("DELETE FROM playlists WHERE id=?", (pid,))
    return {"ok": True}


def _set_ids(pid: int, fn) -> dict:
    pl = db.one("SELECT * FROM playlists WHERE id=?", (pid,))
    if not pl:
        raise HTTPException(404, "Không tìm thấy playlist.")
    ids = fn(json.loads(pl["track_ids"] or "[]"))
    db.execute("UPDATE playlists SET track_ids=?, updated_at=? WHERE id=?", (json.dumps(ids), time.time(), pid))
    return {"ok": True, "count": len(ids)}


@router.post("/playlists/{pid}/tracks")
def add_to_playlist(pid: int, body: TrackIds):
    return _set_ids(pid, lambda ids: ids + [i for i in body.track_ids if i not in ids])


@router.delete("/playlists/{pid}/tracks/{tid}")
def remove_from_playlist(pid: int, tid: int):
    return _set_ids(pid, lambda ids: [i for i in ids if i != tid])


# ---- cài đặt (EQ, preset riêng, âm lượng…) – lưu ở backend để không mất khi cổng app thay đổi
@router.get("/settings")
def get_settings():
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


@router.put("/settings")
def put_settings(body: dict):
    raw = json.dumps(body, ensure_ascii=False)
    if len(raw) > 256 * 1024:
        raise HTTPException(400, "Cài đặt quá lớn.")
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(raw, encoding="utf-8")
    tmp.replace(SETTINGS_PATH)
    return {"ok": True}
