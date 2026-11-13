"""Xem chung với bạn bè.

Hai phần tách biệt:
- `router` (/api/party/…) nằm trong app chính, chỉ dùng trên máy chủ phòng: tạo/đổi/đóng phòng, mở đường hầm Internet.
- `party_app`: máy chủ riêng (cổng app + 1) chỉ có trang phòng /r/<mã>, luồng WebSocket đồng bộ và file phim đang chiếu.
  Bạn bè (và đường hầm Cloudflare) chỉ chạm tới máy chủ này, không thấy được thư viện, cài đặt hay API tải của app.

Nguồn phim: phim trong thư viện, file bất kỳ trên máy, video YouTube (mỗi người xem thẳng từ YouTube), link trang phim
(yt-dlp lấy link luồng – hơn 1.800 trang) hoặc luồng bắt được trong trình duyệt của app (.m3u8/.mp4 kèm Referer/Cookie).
Luồng từ trang khác đi qua máy chủ phòng (/r/<mã>/media, /r/<mã>/x): máy chủ gửi kèm header cần thiết, viết lại danh
sách HLS để mọi đoạn cũng đi qua đây; chỉ chuyển tiếp địa chỉ do chính máy chủ ký (HMAC) – không thành proxy mở.
Bạn bè chỉ nhận tên phim và loại nguồn, không thấy link gốc, cookie hay đường dẫn file.

Đồng bộ: máy chủ giữ trạng thái {playing, pos, rate, at}. Mỗi người tự tính vị trí đúng = pos + (now - at) * rate
(theo đồng hồ máy chủ, ước lượng bằng ping/pong) và tua lại khi lệch.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import mimetypes
import os
import re
import secrets
import socket
import time
from collections import deque
from pathlib import Path
from urllib.parse import urljoin, urlparse

import uvicorn
from fastapi import APIRouter, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, tunnel

YT_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")
EMOJI = {"❤️", "😂", "😮", "😢", "👏", "🔥"}
PUBLIC_KEYS = {"type", "title", "mime", "audio", "video_id", "hls", "item_id", "site", "origin"}
HEADER_KEYS = {"referer": "Referer", "origin": "Origin", "user-agent": "User-Agent", "cookie": "Cookie"}
VIDEO_EXT = {".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav"}


class Room:
    def __init__(self, title: str, source: dict, control: str):
        self.token = secrets.token_urlsafe(8)
        self.host_key = secrets.token_urlsafe(12)
        self.title = title
        self.source = source
        self.control = control                     # "everyone" | "host"
        self.state = {"playing": False, "pos": 0.0, "rate": 1.0, "at": time.time()}
        self.members: dict[WebSocket, dict] = {}
        self.chat: deque = deque(maxlen=100)
        self.created = time.time()
        self.secret = secrets.token_bytes(16)       # ký địa chỉ luồng được phép chuyển tiếp

    def public(self) -> dict:
        src = {k: v for k, v in self.source.items() if k in PUBLIC_KEYS}
        return {"title": self.title, "source": src, "control": self.control, "state": self.state,
                "members": [m for m in self.members.values()], "chat": list(self.chat)}

    async def send_all(self, msg: dict) -> None:
        dead = []
        for ws in list(self.members):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.members.pop(ws, None)


ROOM: Room | None = None
PARTY = {"port": None, "host": "127.0.0.1", "server": None}


def _headers(h: dict | None) -> dict:
    out = {}
    for k, v in (h or {}).items():
        name = HEADER_KEYS.get(str(k).lower())
        if name and isinstance(v, str) and v and "\n" not in v and "\r" not in v:
            out[name] = v[:8000]
    return out


def _site(url: str) -> str:
    return (urlparse(url).hostname or "").removeprefix("www.")


def _media_file(path: Path, title: str) -> dict:
    mime = mimetypes.guess_type(str(path))[0] or "video/mp4"
    return {"type": "file", "path": str(path), "title": title, "mime": mime, "audio": mime.startswith("audio/")}


def resolve_link(url: str) -> dict:
    """Link trang phim (Vimeo, Dailymotion, Facebook…) → luồng phát được trong trình duyệt (mp4 có tiếng, hoặc HLS)."""
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True, "socket_timeout": 20}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:      # yt-dlp báo lỗi đủ kiểu
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")
        found = None
        try:
            found = _scan_page(url)      # trang phim tự làm (yt-dlp không biết): tìm .m3u8 trong trang / khung phát nhúng
        except Exception:  # noqa: BLE001
            found = None
        if found:
            return found
        if re.search(r"DRM|drm", msg):
            raise HTTPException(400, f"Không lấy được phim từ link này: {msg[:300]}")
        # 424: trang cần chạy trong trình duyệt mới ra luồng phim → app mở trang, người dùng bấm phát, app tự tạo phòng
        raise HTTPException(424, "Trang này không đọc thẳng được link phim (phải chạy trong trình duyệt). "
                                 "Mở trang trong app, bấm phát phim là app tự tạo phòng.")
    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries") or [] if e]
        if not entries:
            raise HTTPException(400, "Link là danh sách phát trống.")
        info = entries[0]
    if str(info.get("extractor_key", "")).lower().startswith("youtube") and info.get("id"):
        return {"type": "youtube", "video_id": info["id"], "title": info.get("title") or "Video YouTube"}
    fmts = info.get("formats") or [info]

    def playable(f):
        proto = f.get("protocol") or ""
        if not f.get("url") or proto.startswith(("http_dash", "dash", "f4m", "rtmp", "rtsp", "ism")):
            return False
        v, a = f.get("vcodec"), f.get("acodec")
        if v is None and a is None:                     # trang không ghi codec: coi là có cả hình lẫn tiếng
            return f.get("ext") in ("mp4", "webm", "m4v", "mov") or "m3u8" in proto
        return v not in (None, "none") and a not in (None, "none")

    def score(f):
        h = f.get("height") or 0
        prog = (f.get("protocol") or "") in ("https", "http")
        hls = "m3u8" in (f.get("protocol") or "")
        return (h <= 1080, prog or hls, prog, h, f.get("tbr") or 0)
    ok = [f for f in fmts if playable(f)]
    if not ok:
        raise HTTPException(400, "Trang này chỉ có hình và tiếng tách riêng (hoặc có DRM), trình duyệt không phát chung được. "
                                 "Tải phim về trước rồi chọn trong thư viện.")
    f = max(ok, key=score)
    hls = "m3u8" in (f.get("protocol") or "") or ".m3u8" in f["url"].split("?")[0]
    return {"type": "stream", "url": f["url"], "hls": hls, "headers": _headers(f.get("http_headers")),
            "title": (info.get("title") or "Phim")[:120], "site": _site(info.get("webpage_url") or url), "origin": "link",
            "mime": "application/vnd.apple.mpegurl" if hls else f"video/{f.get('ext') or 'mp4'}"}


M3U8_RE = re.compile(r"""https?://[^\s"'<>()]+?\.m3u8(?:\?[^\s"'<>()]*)?""", re.I)
IFRAME_RE = re.compile(r"""<iframe[^>]+?src\s*=\s*["']([^"']+)["']""", re.I)


def _scan_page(url: str, referer: str | None = None, depth: int = 0) -> dict | None:
    """Trang phim không có trong yt-dlp: đọc HTML tìm link .m3u8 (kể cả trong JSON/JS), hoặc khung phát nhúng (iframe) rồi
    thử yt-dlp / tìm tiếp trong khung đó. Chỉ nhận link mà máy chủ phim trả về đúng playlist HLS."""
    import yt_dlp
    from yt_dlp.networking import Request
    hdr = {"Referer": referer} if referer else {}
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "socket_timeout": 15}) as ydl:
        html = ydl.urlopen(Request(url, headers=hdr)).read(3_000_000).decode("utf-8", "replace")
        text = html.replace("\\/", "/").replace("\\u0026", "&").replace("&amp;", "&")
        title = re.sub(r"\s+", " ", (re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I) or [None, ""])[1]).strip()

        def stream(m3u8: str, page: str) -> dict | None:
            try:
                body = ydl.urlopen(Request(m3u8, headers={"Referer": page})).read(4096)
            except Exception:  # noqa: BLE001
                return None
            if not body.lstrip().startswith(b"#EXTM3U"):
                return None
            origin = "{0.scheme}://{0.netloc}".format(urlparse(page))
            return {"type": "stream", "url": m3u8, "hls": True, "headers": {"Referer": page, "Origin": origin},
                    "title": (title or "Phim")[:120], "site": _site(url), "origin": "link", "mime": "application/vnd.apple.mpegurl"}

        for m in dict.fromkeys(M3U8_RE.findall(text)):
            if found := stream(m, url):
                return found
        if depth >= 1:
            return None
        frames = [urljoin(url, f) for f in IFRAME_RE.findall(html)]
        frames = [f for f in dict.fromkeys(frames) if f.startswith("http") and not re.search(r"facebook|google|youtube\.com/embed|ads?[./]", f)][:3]
    for f in frames:
        try:
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, "socket_timeout": 15,
                                   "http_headers": {"Referer": url}}) as y2:
                info = y2.extract_info(f, download=False)
            fmts = [x for x in (info.get("formats") or [info]) if x.get("url") and ("m3u8" in (x.get("protocol") or "")
                                                                                  or x.get("ext") in ("mp4", "webm"))]
            if fmts:
                x = max(fmts, key=lambda x: (x.get("height") or 0) <= 1080 and (x.get("height") or 0))
                hls = "m3u8" in (x.get("protocol") or "")
                return {"type": "stream", "url": x["url"], "hls": hls, "headers": _headers(x.get("http_headers")) or {"Referer": f},
                        "title": (title or info.get("title") or "Phim")[:120], "site": _site(url), "origin": "link",
                        "mime": "application/vnd.apple.mpegurl" if hls else f"video/{x.get('ext') or 'mp4'}"}
        except Exception:  # noqa: BLE001
            pass
        try:
            if found := _scan_page(f, url, depth + 1):
                return found
        except Exception:  # noqa: BLE001
            pass
    return None


async def _source(body: "RoomIn") -> dict:
    if body.youtube_url:
        m = YT_ID.search(body.youtube_url)
        if not m:
            raise HTTPException(400, "Link YouTube chưa đúng. Dán link một video, ví dụ youtube.com/watch?v=…")
        return {"type": "youtube", "video_id": m.group(1), "title": body.title or "Video YouTube"}
    if body.item_id:
        it = db.one("SELECT * FROM items WHERE id=?", (body.item_id,))
        if not it or not os.path.exists(it["filepath"]):
            raise HTTPException(404, "Không tìm thấy file phim này trên ổ.")
        return {**_media_file(Path(it["filepath"]), it["title"]), "item_id": it["id"]}
    if body.path:
        p = Path(body.path.strip().strip('"'))
        if not p.is_file():
            raise HTTPException(404, "Không thấy file này trên máy.")
        if p.suffix.lower() not in VIDEO_EXT:
            raise HTTPException(400, "Chọn file phim hoặc nhạc (mp4, mkv, webm, mov, mp3…).")
        return {**_media_file(p, p.stem), "origin": "path"}
    if body.link:
        url = body.link.strip()
        if not re.match(r"https?://", url):
            raise HTTPException(400, "Dán link trang phim bắt đầu bằng http:// hoặc https://")
        m = YT_ID.search(url)
        if m and re.search(r"(youtube\.com|youtu\.be)/", url):
            return {"type": "youtube", "video_id": m.group(1), "title": body.title or "Video YouTube"}
        src = await asyncio.to_thread(resolve_link, url)
        if body.title:
            src["title"] = body.title
        return src
    if body.stream:
        url = str(body.stream.get("url") or "")
        kind = str(body.stream.get("kind") or "").upper()
        if not re.match(r"https?://", url):
            raise HTTPException(400, "Luồng phim không hợp lệ.")
        if kind == "DASH" or url.split("?")[0].lower().endswith(".mpd"):
            raise HTTPException(400, "Luồng DASH (.mpd) chưa xem chung được. Chọn luồng HLS (.m3u8) hoặc MP4 trong danh sách.")
        hls = kind == "HLS" or ".m3u8" in url.split("?")[0].lower()
        page = str(body.stream.get("page") or url)
        return {"type": "stream", "url": url, "hls": hls, "headers": _headers(body.stream.get("headers")), "origin": "browser",
                "title": body.title or "Phim", "site": _site(page),
                "mime": "application/vnd.apple.mpegurl" if hls else "video/mp4"}
    raise HTTPException(400, "Chọn phim trong thư viện, file trên máy, link YouTube hoặc link trang phim.")


def lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def status() -> dict:
    out = {"room": None, "tunnel": tunnel.state, "port": PARTY["port"], "lan": PARTY["host"] == "0.0.0.0"}
    if ROOM:
        base = f"http://127.0.0.1:{PARTY['port']}/r/{ROOM.token}"
        links = {"host": f"{base}?host={ROOM.host_key}", "local": base}
        ip = lan_ip() if out["lan"] else None
        if ip:
            links["lan"] = f"http://{ip}:{PARTY['port']}/r/{ROOM.token}"
        if tunnel.state["status"] == "ready" and tunnel.state["url"]:
            links["internet"] = f"{tunnel.state['url']}/r/{ROOM.token}"
        out["room"] = {**ROOM.public(), "links": links, "chat": []}
    return out


# ------------------------------------------------------------------ API trong app chính (máy chủ phòng)
router = APIRouter(prefix="/api/party")


class RoomIn(BaseModel):
    title: str | None = None
    youtube_url: str | None = None
    item_id: int | None = None
    path: str | None = None          # file bất kỳ trên máy
    link: str | None = None          # link trang phim (yt-dlp)
    stream: dict | None = None       # luồng bắt được trong trình duyệt của app {url, kind, headers, page}
    control: str = "everyone"


@router.get("")
def get_party():
    return status()


@router.post("")
async def set_room(body: RoomIn):
    global ROOM
    keep = ROOM is not None and not any([body.youtube_url, body.item_id, body.path, body.link, body.stream])
    src = ROOM.source if keep else await _source(body)
    control = body.control if body.control in ("everyone", "host") else "everyone"
    title = (body.title or src["title"]).strip()[:120]
    if ROOM is None:
        ROOM = Room(title, src, control)
    elif keep:   # chỉ đổi tên phòng / quyền điều khiển
        ROOM.title, ROOM.control = title, control
        await ROOM.send_all({"t": "source", "room": ROOM.public(), "server": time.time()})
    else:   # đổi phim trong phòng đang mở: giữ người xem, phát lại từ đầu
        ROOM.title, ROOM.source, ROOM.control = title, src, control
        ROOM.state = {"playing": False, "pos": 0.0, "rate": 1.0, "at": time.time()}
        await ROOM.send_all({"t": "source", "room": ROOM.public(), "server": time.time()})
    return status()


@router.delete("")
async def close_room():
    global ROOM
    if ROOM:
        room, ROOM = ROOM, None
        await room.send_all({"t": "closed"})
        for ws in list(room.members):
            with contextlib.suppress(Exception):
                await ws.close()
    from . import voice                      # phòng thoại còn người thì giữ đường hầm
    if not voice.active():
        tunnel.stop()
    return status()


@router.post("/tunnel")
def start_tunnel():
    if not ROOM:
        raise HTTPException(400, "Tạo phòng trước rồi mới mở cho Internet.")
    tunnel.start(PARTY["port"])
    return status()


@router.delete("/tunnel")
def stop_tunnel():
    from . import voice
    if not voice.active():                   # phòng thoại còn người thì giữ đường hầm
        tunnel.stop()
    return status()


# ------------------------------------------------------------------ máy chủ phòng cho bạn bè
party_app = FastAPI(title="CircleVault - Xem chung", docs_url=None, redoc_url=None, openapi_url=None)
class NoCacheStatic(StaticFiles):
    """Giao diện luôn hỏi lại máy chủ (304 nếu không đổi) – cập nhật app xong là thấy giao diện mới ngay."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


party_app.mount("/p", NoCacheStatic(directory=config.WEB), name="p")


def _room(token: str) -> Room:
    if not ROOM or not secrets.compare_digest(token, ROOM.token):
        raise HTTPException(404, "Phòng không tồn tại hoặc đã đóng.")
    return ROOM


@party_app.get("/r/{token}")
def party_page(token: str):
    if not ROOM or not secrets.compare_digest(token, ROOM.token):
        return HTMLResponse("<meta charset=utf-8><title>CircleVault</title><body style='font:18px system-ui;padding:40px'>"
                            "<h2>Phòng xem chung đã đóng</h2><p>Hỏi người mời để lấy link phòng mới.</p>", status_code=404)
    return FileResponse(config.WEB / "party.html", headers={"Cache-Control": "no-store"})


def _sign(room: Room, url: str) -> str:
    return hmac.new(room.secret, url.encode(), hashlib.sha256).hexdigest()[:24]


def _wrap(room: Room, url: str) -> str:
    """Địa chỉ tương đối (so với /r/<mã>/media hoặc /r/<mã>/x) để trình duyệt bạn bè lấy qua máy chủ phòng."""
    u = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
    return f"x?u={u}&s={_sign(room, url)}"


def rewrite_m3u8(room: Room, text: str, base: str) -> str:
    out = []
    for line in text.splitlines():
        t = line.strip()
        if not t:
            out.append(line)
        elif t.startswith("#"):
            out.append(re.sub(r'URI="([^"]+)"', lambda m: f'URI="{_wrap(room, urljoin(base, m.group(1)))}"', line))
        else:
            out.append(_wrap(room, urljoin(base, t)))
    return "\n".join(out) + "\n"


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"


def _upstream(room: Room, url: str, request: Request):
    import requests
    h = dict(room.source.get("headers") or {})
    h.setdefault("User-Agent", UA)
    rng = request.headers.get("range")
    if rng and re.fullmatch(r"bytes=\d*-\d*", rng):
        h["Range"] = rng
    try:
        r = requests.get(url, headers=h, stream=True, timeout=(10, 30), allow_redirects=True)
    except requests.RequestException as e:
        raise HTTPException(502, f"Trang phim không trả lời: {type(e).__name__}")
    if r.status_code >= 400:
        r.close()
        raise HTTPException(502, f"Trang phim từ chối ({r.status_code}). Link có thể đã hết hạn – chủ phòng mở lại phim.")
    return r


def _relay(room: Room, url: str, request: Request):
    r = _upstream(room, url, request)
    ct = (r.headers.get("content-type") or "").lower()
    playlist = "mpegurl" in ct or urlparse(r.url).path.lower().endswith(".m3u8") or (room.source.get("hls") and url == room.source.get("url"))
    if playlist:
        body = r.raw.read(8 * 1024 * 1024, decode_content=True)
        r.close()
        text = body.decode("utf-8", "replace").lstrip("﻿")
        if text.startswith("#EXTM3U"):
            return Response(rewrite_m3u8(room, text, r.url), media_type="application/vnd.apple.mpegurl",
                            headers={"Cache-Control": "no-store"})
        return Response(body, media_type=ct or "application/octet-stream")
    headers = {k: r.headers[k] for k in ("Content-Length", "Content-Range", "Accept-Ranges", "Content-Type") if k in r.headers}
    if "Content-Encoding" in r.headers:          # requests đã giải nén: độ dài không còn đúng
        headers.pop("Content-Length", None)
    headers.setdefault("Accept-Ranges", "bytes")

    def gen():
        try:
            yield from r.iter_content(256 * 1024)
        finally:
            r.close()
    return StreamingResponse(gen(), status_code=r.status_code, headers=headers)


@party_app.get("/r/{token}/media")
def party_media(token: str, request: Request):
    room = _room(token)
    src = room.source
    if src.get("type") == "stream":
        return _relay(room, src["url"], request)
    if src.get("type") != "file":
        raise HTTPException(404, "Phòng đang chiếu video YouTube.")
    path = src.get("path")
    if src.get("item_id"):
        it = db.one("SELECT filepath FROM items WHERE id=?", (src["item_id"],))
        path = it["filepath"] if it else None
    if not path or not os.path.exists(path):
        raise HTTPException(404, "File phim không còn trên máy chủ phòng.")
    return FileResponse(path, media_type=src.get("mime"))


@party_app.get("/r/{token}/x")
def party_relay(token: str, u: str, s: str, request: Request):
    room = _room(token)
    if room.source.get("type") != "stream":
        raise HTTPException(404, "Không có luồng này.")
    try:
        url = base64.urlsafe_b64decode(u + "=" * (-len(u) % 4)).decode()
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "Địa chỉ hỏng.")
    if not secrets.compare_digest(s, _sign(room, url)) or not re.match(r"https?://", url):
        raise HTTPException(403, "Không được phép.")
    return _relay(room, url, request)


@party_app.websocket("/r/{token}/ws")
async def party_ws(ws: WebSocket, token: str):
    if not ROOM or not secrets.compare_digest(token, ROOM.token):
        await ws.close(code=4404)
        return
    room = ROOM
    await ws.accept()
    me = None
    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("t")
            if t == "ping":
                await ws.send_json({"t": "pong", "c": msg.get("c"), "s": time.time()})
                continue
            if t == "hello" and me is None:
                name = re.sub(r"\s+", " ", str(msg.get("name") or "")).strip()[:30] or "Khách"
                host = bool(msg.get("host_key")) and secrets.compare_digest(str(msg["host_key"]), room.host_key)
                me = {"id": secrets.token_hex(4), "name": name, "host": host}
                room.members[ws] = me
                await ws.send_json({"t": "welcome", "you": me, "room": room.public(), "server": time.time()})
                await room.send_all({"t": "members", "list": list(room.members.values()), "joined": name})
                continue
            if me is None or room is not ROOM:
                continue
            if t == "ctl":
                if room.control == "host" and not me["host"]:
                    await ws.send_json({"t": "notice", "text": "Chỉ chủ phòng được điều khiển phim."})
                    continue
                a = msg.get("a")
                st = dict(room.state)
                now = time.time()
                cur = st["pos"] + ((now - st["at"]) * st["rate"] if st["playing"] else 0)
                pos = float(msg["pos"]) if isinstance(msg.get("pos"), (int, float)) else cur
                if a == "play":
                    st.update(playing=True, pos=pos)
                elif a == "pause":
                    st.update(playing=False, pos=pos)
                elif a == "seek":
                    st.update(pos=max(0.0, pos))
                elif a == "rate" and isinstance(msg.get("rate"), (int, float)) and 0.25 <= msg["rate"] <= 2:
                    st.update(pos=cur, rate=float(msg["rate"]))
                else:
                    continue
                st["at"] = now
                room.state = st
                await room.send_all({"t": "state", "state": st, "by": me["name"], "a": a, "server": now})
            elif t == "chat":
                text = str(msg.get("text") or "").strip()[:500]
                if text:
                    m = {"name": me["name"], "text": text, "at": time.time(), "host": me["host"]}
                    room.chat.append(m)
                    await room.send_all({"t": "chat", "msg": m})
            elif t == "react" and msg.get("e") in EMOJI:
                await room.send_all({"t": "react", "e": msg["e"], "name": me["name"]})
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if me is not None and ws in room.members:
            room.members.pop(ws, None)
            await room.send_all({"t": "members", "list": list(room.members.values()), "left": me["name"]})


# ------------------------------------------------------------------ chạy máy chủ phòng song song với app
class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self):     # app chính đã lo tín hiệu tắt; máy chủ phụ không giành
        yield


async def serve(main_port: int, host: str) -> None:
    for port in range(main_port + 1, main_port + 20):
        try:
            with socket.socket() as s:
                s.bind((host, port))
        except OSError:
            continue
        PARTY.update(port=port, host=host)
        server = _Server(uvicorn.Config(party_app, host=host, port=port, log_level="warning", ws="auto"))
        PARTY["server"] = server
        await server.serve()
        return


def start_background(main_port: int, host: str) -> asyncio.Task:
    return asyncio.create_task(serve(main_port, host))
