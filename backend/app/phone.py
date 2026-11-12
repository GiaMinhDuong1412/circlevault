"""Mang theo điện thoại: trước khi tắt máy tính, điện thoại (cùng Wi-Fi) tải nhạc/phim về bộ nhớ của nó như FILE THƯỜNG.

Vì sao là file thường: trình duyệt trên điện thoại không cho trang web chọn ổ lưu (thẻ nhớ / bộ nhớ máy), và trang mở bằng
http trong mạng nhà không chạy offline được khi máy tính đã tắt. File tải về thì nằm ở nơi người dùng chọn trong cài đặt
Tải xuống của Chrome, nghe/xem bằng app của điện thoại (VLC, Thư viện…), xóa bằng app Quản lý file.

- Trang `/dt` (frontend/dt.html + js/dt.js), API `/api/phone/*` – chỉ ĐỌC (danh sách, tải file), không sửa/xóa gì trên máy tính.
- Playlist tải thành 1 gói .zip (không nén, ghi thẳng ra luồng) gồm thư mục `<tên playlist>/` + file danh sách phát .m3u8,
  có Content-Length (tính trước bằng một lượt chạy thử với dữ liệu 0) để Chrome hiện % tiến độ.
"""
from __future__ import annotations

import io
import json
import mimetypes
import os
import platform
import re
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import config, db, devices, music, party

router = APIRouter(prefix="/api/phone")
VIDEO_EXT = {".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".flv"}
VIDEO_KINDS = ("youtube", "film", "other")
CHUNK = 1 << 20
_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def safe_name(s: str, limit: int = 110) -> str:
    """Tên file dùng được trên thẻ nhớ (FAT32/exFAT) và mọi điện thoại."""
    s = _BAD.sub(" ", s or "").strip()
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:limit].rstrip(" .") or "khong-ten"


def _size(path: str, fallback=None) -> int | None:
    try:
        return os.path.getsize(path)
    except OSError:
        return fallback


def running() -> dict:
    host = os.environ.get("CIRCLEVAULT_HOST") or config.load()["host"]
    port = int(os.environ.get("CIRCLEVAULT_PORT") or config.load()["port"])
    return {"host": host, "port": port}


# ------------------------------------------------------------------ thông tin cho tab Lưu Trữ
@router.get("/info", dependencies=[Depends(devices.local_only)])
def info():
    r = running()
    lan = r["host"] == "0.0.0.0"
    ip = party.lan_ip() if lan else None
    return {"lan": lan, "pending": config.load()["host"] != r["host"], "ip": ip, "port": r["port"],
            "url": f"http://{ip}:{r['port']}/dt" if ip else None, "devices": devices.list_devices()}


# ------------------------------------------------------------------ ghép thiết bị (chỉ thiết bị đã ghép mới mở được qua Wi-Fi)
class PairIn(BaseModel):
    code: str
    name: str = ""


class DeviceIn(BaseModel):
    name: str | None = None
    scope: str | None = None


@router.get("/me")
def me(request: Request):
    if request.client is None or devices.is_local(request.client.host):
        return {"paired": True, "local": True, "name": "Máy tính này", "scope": "full"}
    d = request.scope.get("state", {}).get("device")
    return {"paired": bool(d), "local": False, "name": d and d["name"], "scope": d and d["scope"],
            "server": platform.node() or "Máy tính", "version": config.VERSION}


@router.post("/pair")
def pair(body: PairIn, request: Request):
    app = request.headers.get("x-circlevault-app") == "1"          # app Android: nhận mã trong JSON, tự gửi lại bằng cookie
    d, token = devices.pair(body.code, body.name, request.headers.get("user-agent", ""), app=app)
    out = {"ok": True, "device": d, "server": platform.node() or "Máy tính"}
    if app:
        out["token"] = token
    return JSONResponse(out, headers={"Set-Cookie": devices.cookie_header(token)})


@router.post("/pair-code", dependencies=[Depends(devices.local_only)])
def pair_code():
    i = info()
    if not i["url"]:
        raise HTTPException(400, "Chưa bật chế độ cho điện thoại cùng Wi-Fi.")
    c = devices.new_code()
    return {**c, "url": f"{i['url']}?pair={c['code']}"}


@router.get("/devices", dependencies=[Depends(devices.local_only)])
def list_devices():
    return devices.list_devices()


@router.put("/devices/{did}", dependencies=[Depends(devices.local_only)])
def edit_device(did: str, body: DeviceIn):
    return devices.update(did, body.name, body.scope)


@router.delete("/devices/{did}", dependencies=[Depends(devices.local_only)])
def delete_device(did: str):
    devices.remove(did)
    return {"ok": True}


@router.get("/qr.svg", dependencies=[Depends(devices.local_only)])
def qr(code: str):
    base = info()["url"]
    if not base:
        raise HTTPException(404, "Chưa bật chế độ cho điện thoại cùng Wi-Fi.")
    url = f"{base}?pair={code.strip().upper()[:12]}"
    try:
        import segno
    except ImportError:
        raise HTTPException(404, "Thiếu thư viện tạo mã QR.")
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=6, border=2, dark="#121212", light="#ffffff")
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------------ danh sách
def _track_out(t: dict) -> dict:
    return {"id": t["id"], "title": t["title"] or Path(t["path"]).stem, "artist": t["artist"], "duration": t["duration"],
            "size": _size(t["path"], t["size"]), "ext": Path(t["path"]).suffix.lower(), "exists": os.path.exists(t["path"])}


def _pl_tracks(pid: int) -> tuple[dict, list[dict]]:
    pl = db.one("SELECT * FROM playlists WHERE id=?", (pid,))
    if not pl:
        raise HTTPException(404, "Không thấy playlist này.")
    return pl, [t for t in music.tracks(playlist=pid) if os.path.exists(t["path"])]


@router.get("/playlists")
def playlists():
    out = []
    for pl in db.query("SELECT * FROM playlists ORDER BY name COLLATE NOCASE"):
        ids = json.loads(pl["track_ids"] or "[]")
        rows = db.query(f"SELECT id, path, size FROM tracks WHERE id IN ({','.join('?' * len(ids))})", tuple(ids)) if ids else []
        by = {r["id"]: r for r in rows if r["path"] and os.path.exists(r["path"])}
        have = [i for i in ids if i in by]        # đúng thứ tự playlist, chỉ bài còn file – điện thoại so với bài đã tải để biết bài mới
        out.append({"id": pl["id"], "name": pl["name"], "count": len(have),
                    "size": sum(by[i]["size"] or 0 for i in have), "ids": have})
    return out


@router.get("/playlists/{pid}")
def playlist(pid: int):
    pl, rows = _pl_tracks(pid)
    return {"id": pl["id"], "name": pl["name"], "tracks": [_track_out(t) for t in rows]}


@router.get("/tracks")
def tracks(q: str = "", limit: int = 60):
    rows = music.tracks(q=q.strip(), sort="recent")[:min(limit, 300)]
    return [_track_out(t) for t in rows]


@router.get("/videos")
def videos(q: str = "", limit: int = 60, offset: int = 0):
    where, args = [f"kind IN ({','.join('?' * len(VIDEO_KINDS))})"], list(VIDEO_KINDS)
    if q.strip():
        where.append("(title LIKE ? OR uploader LIKE ?)")
        args += [f"%{q.strip()}%"] * 2
    rows = db.query(f"SELECT * FROM items WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ? OFFSET ?",
                    (*args, min(limit, 200), offset))
    out = []
    for it in rows:
        ext = Path(it["filepath"]).suffix.lower()
        if ext not in VIDEO_EXT or not os.path.exists(it["filepath"]):
            continue
        thumb = it["thumbnail"] if str(it["thumbnail"] or "").startswith(("http://", "https://")) else None
        out.append({"id": it["id"], "title": it["title"], "kind": it["kind"], "uploader": it["uploader"],
                    "duration": it["duration"], "height": it["height"], "ext": ext, "thumb": thumb,
                    "size": _size(it["filepath"], it["filesize"])})
    return out


# ------------------------------------------------------------------ tải file
def _track_name(t: dict, n: int | None) -> str:
    base = t["title"] or Path(t["path"]).stem
    if t.get("artist") and t["artist"].casefold() not in base.casefold():
        base = f"{t['artist']} - {base}"
    return (f"{n:02d} - " if n else "") + safe_name(base) + Path(t["path"]).suffix.lower()


@router.api_route("/track/{tid}/file", methods=["GET", "HEAD"])
def track_file(tid: int, n: int | None = None):
    t = music._track(tid)
    if not os.path.exists(t["path"]):
        raise HTTPException(404, "File nhạc không còn trên ổ.")
    return FileResponse(t["path"], media_type=mimetypes.guess_type(t["path"])[0] or "audio/mpeg",
                        filename=_track_name(t, n))


@router.get("/track/{tid}/cover")
def track_cover(tid: int):
    c = music.cover_of(music._track(tid)["path"])
    if not c:
        raise HTTPException(404, "Bài này không có ảnh bìa.")
    return Response(content=c[0], media_type=c[1], headers={"Cache-Control": "max-age=86400"})


@router.api_route("/video/{iid}/file", methods=["GET", "HEAD"])
def video_file(iid: int):
    it = db.one("SELECT * FROM items WHERE id=?", (iid,))
    if not it or not os.path.exists(it["filepath"]):
        raise HTTPException(404, "File không còn trên ổ.")
    p = Path(it["filepath"])
    return FileResponse(p, media_type=mimetypes.guess_type(p.name)[0] or "video/mp4",
                        filename=safe_name(it["title"] or p.stem) + p.suffix.lower())


def _m3u8(rows: list[dict]) -> bytes:
    lines = ["#EXTM3U"]
    for n, t in enumerate(rows, 1):
        title = t["title"] or Path(t["path"]).stem
        lines.append(f"#EXTINF:{int(t['duration'] or -1)},{(t['artist'] + ' - ') if t.get('artist') else ''}{title}")
        lines.append(_track_name(t, n))
    return ("\n".join(lines) + "\n").encode("utf-8")


@router.api_route("/playlists/{pid}/m3u8", methods=["GET", "HEAD"])
def playlist_m3u8(pid: int):
    pl, rows = _pl_tracks(pid)
    return Response(_m3u8(rows), media_type="audio/x-mpegurl",
                    headers={"Content-Disposition": _disposition(safe_name(pl["name"]) + ".m3u8")})


def _disposition(name: str) -> str:
    from urllib.parse import quote
    ascii_name = name.encode("ascii", "ignore").decode() or "circlevault"
    return f'attachment; filename="{ascii_name}"; filename*=utf-8\'\'{quote(name)}'


# ---- gói .zip ghi thẳng ra luồng
class _Sink:
    """Đích ghi không tua được (zipfile tự dùng data descriptor). Chỉ gom byte để trả dần ra luồng."""

    def __init__(self, keep: bool = True):
        self.keep = keep            # False: chỉ đếm byte (lượt chạy thử để biết Content-Length)
        self.buf: list[bytes] = []
        self.total = 0
        self.pending = 0

    def write(self, b) -> int:
        n = len(b)
        if self.keep:
            self.buf.append(bytes(b))
            self.pending += n
        self.total += n
        return n

    def flush(self):
        pass

    def take(self) -> bytes:
        out = b"".join(self.buf)
        self.buf.clear()
        self.pending = 0
        return out


def _zip_plan(pl: dict, rows: list[dict]) -> list[tuple]:
    folder = safe_name(pl["name"], 80)
    plan = []
    for n, t in enumerate(rows, 1):
        st = os.stat(t["path"])
        plan.append((f"{folder}/{_track_name(t, n)}", t["path"], st.st_size, st.st_mtime))
    plan.append((f"{folder}/{folder}.m3u8", _m3u8(rows), None, time.time()))
    return plan


def _zip_iter(plan: list[tuple], sink: _Sink):
    real = sink.keep
    zero = bytes(CHUNK)
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for name, src, size, mtime in plan:
            zi = zipfile.ZipInfo(name, time.localtime(max(mtime, 315532800))[:6])
            zi.compress_type = zipfile.ZIP_STORED
            if size is None:                       # file .m3u8 (bytes sẵn)
                zi.file_size = len(src)
                with zf.open(zi, "w") as w:
                    w.write(src)
                continue
            zi.file_size = size
            with zf.open(zi, "w") as w:
                left = size
                f = open(src, "rb") if real else None
                try:
                    while left > 0:
                        chunk = f.read(min(CHUNK, left)) if f else zero[:min(CHUNK, left)]
                        if not chunk:              # file ngắn đi giữa chừng: bù 0 để đúng độ dài đã báo
                            chunk = zero[:min(CHUNK, left)]
                        w.write(chunk)
                        left -= len(chunk)
                        if real and sink.pending >= CHUNK:
                            yield sink.take()
                finally:
                    if f:
                        f.close()
            if real:
                yield sink.take()
    yield sink.take()


@router.api_route("/playlists/{pid}/zip", methods=["GET", "HEAD"])
def playlist_zip(pid: int, request: Request):
    pl, rows = _pl_tracks(pid)
    if not rows:
        raise HTTPException(404, "Playlist này chưa có bài nào trên máy.")
    plan = _zip_plan(pl, rows)
    dry = _Sink(keep=False)
    for _ in _zip_iter(plan, dry):
        pass
    headers = {"Content-Length": str(dry.total),
               "Content-Disposition": _disposition(f"CircleVault - {safe_name(pl['name'], 80)}.zip")}
    if request.method == "HEAD":         # app tải xuống hỏi trước kích thước
        return Response(media_type="application/zip", headers=headers)
    return StreamingResponse(_zip_iter(plan, _Sink()), media_type="application/zip", headers=headers)


# ------------------------------------------------------------------ YouTube online cho app (qua tài khoản YouTube trên máy tính)
@router.get("/yt/playlists")
def yt_playlists(refresh: bool = False):
    from . import ytmusic
    return ytmusic.my_playlists(refresh)


@router.get("/yt/list")
def yt_list(src: str, refresh: bool = False):
    from . import ytmusic
    return ytmusic.open_list(src, refresh)


@router.get("/yt/search")
def yt_search(q: str):
    from . import ytmusic
    return ytmusic.search(q, "yt")


@router.get("/yt/stream")
def yt_stream(u: str, request: Request):
    from . import ytmusic
    return ytmusic.stream_url(u, request)


# ------------------------------------------------------------------ bài điện thoại lưu từ YouTube → máy tính hỏi rồi tải
SAVED_PATH = config.DATA / "phone-saved.json"
_VID = re.compile(r"^[\w-]{11}$")


class SavedIn(BaseModel):
    items: list[dict]


class SavedPick(BaseModel):
    ids: list[str]


def _saved() -> list[dict]:
    try:
        return json.loads(SAVED_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _save_saved(rows: list[dict]) -> None:
    SAVED_PATH.write_text(json.dumps(rows[-500:], ensure_ascii=False), encoding="utf-8")


@router.post("/saved")
def phone_saved(body: SavedIn, request: Request):
    """App báo các bài vừa lưu về điện thoại (YouTube). Máy tính giữ danh sách chờ để hỏi người dùng có tải về ổ HDD không."""
    d = request.scope.get("state", {}).get("device") or {}
    rows = _saved()
    have = {r["yt"] for r in rows}
    added = 0
    for it in body.items[:300]:
        yt = str(it.get("yt") or "")
        if not _VID.match(yt) or yt in have:
            continue
        rows.append({"yt": yt, "title": str(it.get("title") or yt)[:200], "artist": str(it.get("artist") or "")[:120] or None,
                     "playlist": str(it.get("playlist") or "")[:80] or None, "device": d.get("name") or "Điện thoại",
                     "at": time.time()})
        have.add(yt)
        added += 1
    _save_saved(rows)
    return {"ok": True, "added": added}


@router.get("/saved", dependencies=[Depends(devices.local_only)])
def saved_list():
    from . import ytmusic
    local = ytmusic._local_map()
    rows = [r for r in _saved() if r["yt"] not in local]
    if len(rows) != len(_saved()):
        _save_saved(rows)              # bài đã có trên máy tính thì thôi không hỏi nữa
    return rows


@router.post("/saved/download", dependencies=[Depends(devices.local_only)])
def saved_download(body: SavedPick):
    from . import main
    rows = _saved()
    pick = [r for r in rows if r["yt"] in set(body.ids)]
    n = 0
    for r in pick:
        main.add_task(main.TaskIn(url=f"https://www.youtube.com/watch?v={r['yt']}", quality="audio", title=r["title"],
                                  music_playlist_name=r.get("playlist") or "Từ điện thoại"))
        n += 1
    _save_saved([r for r in rows if r["yt"] not in set(body.ids)])
    return {"ok": True, "queued": n}


@router.post("/saved/dismiss", dependencies=[Depends(devices.local_only)])
def saved_dismiss(body: SavedPick):
    _save_saved([r for r in _saved() if r["yt"] not in set(body.ids)])
    return {"ok": True}


# ------------------------------------------------------------------ xem chung: app điện thoại thấy phòng đang mở trên máy tính
@router.get("/party")
def party_room():
    st = party.status()
    r = st.get("room")
    if not r:
        return {"room": None}
    links = r.get("links", {})
    return {"room": {"title": r.get("title"), "type": (r.get("source") or {}).get("type"),
                     "members": len(r.get("members") or [])},
            "links": {k: links[k] for k in ("lan", "internet") if links.get(k)}}
