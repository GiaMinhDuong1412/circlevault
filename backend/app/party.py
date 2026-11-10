"""Xem chung với bạn bè.

Hai phần tách biệt:
- `router` (/api/party/…) nằm trong app chính, chỉ dùng trên máy chủ phòng: tạo/đổi/đóng phòng, mở đường hầm Internet.
- `party_app`: máy chủ riêng (cổng app + 1) chỉ có trang phòng /r/<mã>, luồng WebSocket đồng bộ và file phim đang chiếu.
  Bạn bè (và đường hầm Cloudflare) chỉ chạm tới máy chủ này, không thấy được thư viện, cài đặt hay API tải của app.

Đồng bộ: máy chủ giữ trạng thái {playing, pos, rate, at}. Mỗi người tự tính vị trí đúng = pos + (now - at) * rate
(theo đồng hồ máy chủ, ước lượng bằng ping/pong) và tua lại khi lệch.
"""
from __future__ import annotations

import asyncio
import contextlib
import mimetypes
import os
import re
import secrets
import socket
import time
from collections import deque

import uvicorn
from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, tunnel

YT_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")
EMOJI = {"❤️", "😂", "😮", "😢", "👏", "🔥"}


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

    def public(self) -> dict:
        return {"title": self.title, "source": self.source, "control": self.control, "state": self.state,
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


def _source(body: "RoomIn") -> dict:
    if body.youtube_url:
        m = YT_ID.search(body.youtube_url)
        if not m:
            raise HTTPException(400, "Link YouTube chưa đúng. Dán link một video, ví dụ youtube.com/watch?v=…")
        return {"type": "youtube", "video_id": m.group(1), "title": body.title or "Video YouTube"}
    if body.item_id:
        it = db.one("SELECT * FROM items WHERE id=?", (body.item_id,))
        if not it or not os.path.exists(it["filepath"]):
            raise HTTPException(404, "Không tìm thấy file phim này trên ổ.")
        mime = mimetypes.guess_type(it["filepath"])[0] or "video/mp4"
        return {"type": "file", "item_id": it["id"], "title": it["title"], "mime": mime,
                "audio": mime.startswith("audio/")}
    raise HTTPException(400, "Chọn một phim trong thư viện hoặc dán link YouTube.")


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
    control: str = "everyone"


@router.get("")
def get_party():
    return status()


@router.post("")
async def set_room(body: RoomIn):
    global ROOM
    src = _source(body)
    control = body.control if body.control in ("everyone", "host") else "everyone"
    title = (body.title or src["title"]).strip()[:120]
    if ROOM is None:
        ROOM = Room(title, src, control)
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
    tunnel.stop()
    return status()


# ------------------------------------------------------------------ máy chủ phòng cho bạn bè
party_app = FastAPI(title="CircleVault - Xem chung", docs_url=None, redoc_url=None, openapi_url=None)
party_app.mount("/p", StaticFiles(directory=config.WEB), name="p")


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


@party_app.get("/r/{token}/media")
def party_media(token: str):
    room = _room(token)
    if room.source.get("type") != "file":
        raise HTTPException(404, "Phòng đang chiếu video YouTube.")
    it = db.one("SELECT filepath FROM items WHERE id=?", (room.source["item_id"],))
    if not it or not os.path.exists(it["filepath"]):
        raise HTTPException(404, "File phim không còn trên máy chủ phòng.")
    return FileResponse(it["filepath"], media_type=room.source.get("mime"))


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
