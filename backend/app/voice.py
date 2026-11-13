"""Phòng thoại kiểu Discord: một "máy chủ" trên máy người dùng gồm kênh chữ (#) và kênh thoại (🔊).

- Trang `/v/<mã>` + WebSocket `/v/<mã>/ws` chạy trên `party.party_app` (cổng app+1, cùng đường hầm Cloudflare với Xem Chung),
  bạn bè không chạm API chính.
- Tiếng nói đi THẲNG giữa các máy bằng WebRTC (mã hóa DTLS-SRTP); máy chủ chỉ chuyển tin "bắt tay" (offer/answer/ICE)
  giữa hai người CÙNG kênh thoại. Mỗi kênh thoại tối đa `VOICE_MAX` người (mạng lưới ngang hàng).
- Lọc giọng (lọc ồn AI, khử vọng, ngưỡng mic…) làm ở máy từng người (frontend/js/voice.js), không qua máy chủ.
- Dữ liệu: `DATA/voice/server.json` (tên, kênh, mã mời, khóa chủ phòng, danh sách chặn, TURN) + `DATA/voice/msgs/<kênh>.jsonl`.
- Khóa API TURN của Cloudflare (nếu có) chỉ nằm trên máy chủ; người vào phòng chỉ nhận thông tin TURN tạm (24 giờ).
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import secrets
import threading
import time
from collections import deque

import requests
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel

from . import config, devices, party, tunnel

DIR = config.DATA / "voice"
STORE = DIR / "server.json"
MSGS = DIR / "msgs"
VOICE_MAX = 10           # mạng lưới ngang hàng: quá ~10 người thì mỗi máy phải gửi quá nhiều luồng
MEMBERS_MAX = 40
HISTORY = 150            # tin nhắn gửi kèm khi vào phòng (mỗi kênh)
STUN = [{"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]}]
_lock = threading.Lock()


# ------------------------------------------------------------------ dữ liệu máy chủ
def _default() -> dict:
    return {
        "code": secrets.token_urlsafe(9), "host_key": secrets.token_urlsafe(18), "name": "Phòng của tôi", "open": True,
        "channels": [
            {"id": "t-chung", "name": "chung", "kind": "text"},
            {"id": "t-game", "name": "rủ-chơi-game", "kind": "text"},
            {"id": "v-game", "name": "Chơi game", "kind": "voice"},
            {"id": "v-tan-gau", "name": "Tán gẫu", "kind": "voice"},
        ],
        "bans": [], "turn": {"mode": "none"},
    }


_data: dict = {}


def load() -> dict:
    """Dữ liệu máy chủ (giữ trong bộ nhớ; sửa xong gọi save)."""
    with _lock:
        if not _data:
            try:
                _data.update(json.loads(STORE.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                _data.update(_default())
                _save(_data)
        return _data


def _save(d: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STORE)


def save(d: dict) -> None:
    with _lock:
        _save(d)


def _clean(s, n: int) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


def _chan_name(s, kind: str) -> str:
    s = _clean(s, 40)
    if kind == "text":
        s = re.sub(r"[\s#]+", "-", s.lower()).strip("-")
    return s


# ------------------------------------------------------------------ tin nhắn kênh chữ
_hist: dict[str, deque] = {}


def _history(cid: str) -> deque:
    if cid not in _hist:
        q: deque = deque(maxlen=HISTORY)
        f = MSGS / f"{cid}.jsonl"
        with contextlib.suppress(OSError):
            for line in f.read_text(encoding="utf-8").splitlines()[-HISTORY:]:
                with contextlib.suppress(ValueError):
                    q.append(json.loads(line))
        _hist[cid] = q
    return _hist[cid]


def _append(cid: str, m: dict) -> None:
    _history(cid).append(m)
    MSGS.mkdir(parents=True, exist_ok=True)
    f = MSGS / f"{cid}.jsonl"
    with f.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    if f.stat().st_size > 2_000_000:          # gọn lại: giữ 1000 tin gần nhất
        lines = f.read_text(encoding="utf-8").splitlines()[-1000:]
        f.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _rewrite(cid: str) -> None:
    MSGS.mkdir(parents=True, exist_ok=True)
    (MSGS / f"{cid}.jsonl").write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in _history(cid)), encoding="utf-8")


# ------------------------------------------------------------------ TURN (khi hai máy không nối thẳng được, vd mạng 4G)
_turn_cache: dict = {}


def ice_servers(d: dict) -> list:
    t = d.get("turn") or {}
    mode = t.get("mode")
    if mode == "static" and t.get("urls"):
        urls = [u.strip() for u in re.split(r"[\s,]+", t["urls"]) if re.match(r"^turns?:", u.strip())]
        if urls:
            return STUN + [{"urls": urls, "username": t.get("username") or "", "credential": t.get("credential") or ""}]
    if mode == "cloudflare" and t.get("key_id") and t.get("api_token"):
        hit = _turn_cache.get(t["key_id"])
        if hit and time.time() - hit[0] < 12 * 3600:
            return hit[1]
        try:
            r = requests.post(f"https://rtc.live.cloudflare.com/v1/turn/keys/{t['key_id']}/credentials/generate-ice-servers",
                              headers={"Authorization": f"Bearer {t['api_token']}"}, json={"ttl": 86400}, timeout=8)
            r.raise_for_status()
            ice = r.json().get("iceServers")
            ice = ice if isinstance(ice, list) else [ice]
            out = [s for s in ice if isinstance(s, dict)]
            _turn_cache[t["key_id"]] = (time.time(), out)
            return out
        except (requests.RequestException, ValueError) as e:
            _turn_cache["error"] = str(e)[:200]
    return STUN


# ------------------------------------------------------------------ người đang trong phòng
class Hub:
    def __init__(self) -> None:
        self.clients: dict[WebSocket, dict] = {}
        self.avatars: dict[str, tuple[str, bytes]] = {}     # id phiên → (mime, ảnh)
        self.msg_times: dict[str, deque] = {}

    def public(self, me: dict) -> dict:
        return {k: me[k] for k in ("id", "uid", "name", "host", "voice", "mute", "deaf", "smute", "av", "color", "status", "frame")}

    def members(self) -> list:
        return [self.public(m) for m in self.clients.values()]

    def by_id(self, sid: str):
        return next(((ws, m) for ws, m in self.clients.items() if m["id"] == sid), (None, None))

    async def send(self, ws: WebSocket, msg: dict) -> None:
        with contextlib.suppress(Exception):
            await ws.send_json(msg)

    async def send_all(self, msg: dict) -> None:
        await asyncio.gather(*(self.send(ws, msg) for ws in list(self.clients)), return_exceptions=True)

    async def roster(self, **extra) -> None:
        await self.send_all({"t": "members", "list": self.members(), **extra})

    async def kick_all(self, code: int = 4401) -> None:
        for ws in list(self.clients):
            with contextlib.suppress(Exception):
                await ws.close(code=code)
        self.clients.clear()


HUB = Hub()


def active() -> bool:
    return bool(HUB.clients)


def links(d: dict) -> dict:
    port = party.PARTY["port"]
    if not port:
        return {}
    base = f"http://127.0.0.1:{port}/v/{d['code']}"
    out = {"host": f"{base}?host={d['host_key']}", "local": base}
    ip = party.lan_ip() if party.PARTY["host"] == "0.0.0.0" else None
    if ip:
        out["lan"] = f"http://{ip}:{port}/v/{d['code']}"
    if tunnel.state["status"] == "ready" and tunnel.state["url"]:
        out["internet"] = f"{tunnel.state['url']}/v/{d['code']}"
    return out


def status() -> dict:
    d = load()
    t = d.get("turn") or {}
    return {
        "name": d["name"], "open": d["open"], "channels": d["channels"], "links": links(d), "tunnel": tunnel.state,
        "online": [{"name": m["name"], "voice": m["voice"]} for m in HUB.clients.values()],
        "turn": {"mode": t.get("mode", "none"), "key_id": t.get("key_id", ""), "urls": t.get("urls", ""),
                 "username": t.get("username", ""), "has_secret": bool(t.get("api_token") or t.get("credential")),
                 "error": _turn_cache.get("error")},
        "voice_max": VOICE_MAX,
    }


# ------------------------------------------------------------------ API trong app (chỉ máy này)
router = APIRouter(prefix="/api/voice", dependencies=[Depends(devices.local_only)])


@router.get("")
def get_status():
    return status()


class ServerIn(BaseModel):
    name: str | None = None
    open: bool | None = None


@router.put("")
async def set_server(body: ServerIn):
    d = load()
    if body.name is not None and _clean(body.name, 60):
        d["name"] = _clean(body.name, 60)
    if body.open is not None:
        d["open"] = body.open
    save(d)
    await HUB.send_all({"t": "server", "server": {"name": d["name"], "channels": d["channels"]}})
    if not d["open"]:            # đóng phòng: mời mọi người (trừ chủ phòng) ra
        for ws, m in list(HUB.clients.items()):
            if not m["host"]:
                with contextlib.suppress(Exception):
                    await ws.close(code=4403)
    return status()


@router.post("/new-link")
async def new_link():
    """Đổi mã mời (link cũ hết dùng được, mọi người đang trong phòng bị mời ra)."""
    d = load()
    d["code"] = secrets.token_urlsafe(9)
    save(d)
    await HUB.kick_all(4410)
    return status()


class TurnIn(BaseModel):
    mode: str = "none"                # none | cloudflare | static
    key_id: str | None = None
    api_token: str | None = None      # để trống = giữ khóa cũ
    urls: str | None = None
    username: str | None = None
    credential: str | None = None


@router.put("/turn")
def set_turn(body: TurnIn):
    d = load()
    old = d.get("turn") or {}
    if body.mode not in ("none", "cloudflare", "static"):
        raise HTTPException(400, "Kiểu TURN không hợp lệ.")
    t = {"mode": body.mode}
    if body.mode == "cloudflare":
        t["key_id"] = _clean(body.key_id, 100)
        t["api_token"] = (body.api_token or "").strip()[:300] or old.get("api_token", "")
        if not t["key_id"] or not t["api_token"]:
            raise HTTPException(400, "Cần TURN Key ID và API Token của Cloudflare.")
    elif body.mode == "static":
        t["urls"] = _clean(body.urls, 500)
        t["username"] = _clean(body.username, 200)
        t["credential"] = (body.credential or "").strip()[:300] or old.get("credential", "")
    d["turn"] = t
    save(d)
    _turn_cache.clear()
    if body.mode == "cloudflare":
        ice_servers(d)
        if _turn_cache.get("error"):
            raise HTTPException(400, "Cloudflare từ chối khóa TURN: " + _turn_cache["error"])
    return status()


@router.post("/tunnel")
def start_tunnel():
    tunnel.start(party.PARTY["port"])
    return status()


@router.delete("/tunnel")
def stop_tunnel():
    if not party.ROOM:          # phòng Xem Chung còn mở thì giữ đường hầm cho nó
        tunnel.stop()
    return status()


# ------------------------------------------------------------------ trang + WebSocket cho người vào phòng
app = party.party_app


def _ok_code(code: str) -> dict | None:
    d = load()
    return d if secrets.compare_digest(code, d["code"]) else None


@app.get("/v/{code}")
def voice_page(code: str):
    if not _ok_code(code):
        return HTMLResponse("<meta charset=utf-8><title>CircleVault</title><body style='font:18px system-ui;padding:40px'>"
                            "<h2>Link phòng thoại không còn dùng được</h2><p>Hỏi người mời để lấy link mới.</p>", status_code=404)
    return FileResponse(config.WEB / "voice.html", headers={"Cache-Control": "no-store"})


@app.get("/v/{code}/av/{sid}")
def voice_avatar(code: str, sid: str):
    if not _ok_code(code) or sid not in HUB.avatars:
        raise HTTPException(404)
    mime, data = HUB.avatars[sid]
    return Response(data, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})


AV_RE = re.compile(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$")
FRAMES = {"", "nhip", "lua", "bang", "sao", "cau-vong", "la", "pixel", "neon", "vuong-mien"}


def _apply_profile(me: dict, msg: dict) -> None:
    me["name"] = _clean(msg.get("name"), 32) or me.get("name") or "Khách"
    me["status"] = _clean(msg.get("status"), 80)
    me["frame"] = msg.get("frame") if msg.get("frame") in FRAMES else ""
    color = str(msg.get("color") or "")
    me["color"] = color if re.match(r"^#[0-9a-fA-F]{6}$", color) else ""
    av = msg.get("avatar")
    if isinstance(av, str) and len(av) < 400_000 and (m := AV_RE.match(av)):
        with contextlib.suppress(ValueError):
            HUB.avatars[me["id"]] = (f"image/{m.group(1)}", base64.b64decode(m.group(2)))
            me["av"] = (me.get("av") or 0) + 1
    elif av == "":
        HUB.avatars.pop(me["id"], None)
        me["av"] = 0


def _rate_ok(me: dict) -> bool:
    q = HUB.msg_times.setdefault(me["id"], deque(maxlen=8))
    now = time.time()
    if len(q) == 8 and now - q[0] < 10:       # tối đa 8 tin / 10 giây
        return False
    q.append(now)
    return True


@app.websocket("/v/{code}/ws")
async def voice_ws(ws: WebSocket, code: str):
    if not _ok_code(code):
        await ws.close(code=4404)
        return
    await ws.accept()
    me: dict | None = None
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            t = msg.get("t")
            if t == "ping":
                await ws.send_json({"t": "pong", "c": msg.get("c")})
                continue
            d = load()
            if t == "hello" and me is None:
                host = bool(msg.get("host_key")) and secrets.compare_digest(str(msg["host_key"]), d["host_key"])
                uid = re.sub(r"[^\w-]", "", str(msg.get("uid") or ""))[:40] or secrets.token_hex(8)
                if not host and (not d["open"] or uid in d.get("bans", [])):
                    await ws.close(code=4403)
                    return
                if not host and len(HUB.clients) >= MEMBERS_MAX:
                    await ws.close(code=4429)
                    return
                me = {"id": secrets.token_hex(5), "uid": uid, "host": host, "voice": None, "mute": False, "deaf": False,
                      "smute": False, "av": 0, "name": "Khách", "color": "", "status": "", "frame": ""}
                _apply_profile(me, msg)
                HUB.clients[ws] = me
                await ws.send_json({
                    "t": "welcome", "you": HUB.public(me), "members": HUB.members(), "ice": ice_servers(d),
                    "server": {"name": d["name"], "channels": d["channels"]}, "voice_max": VOICE_MAX,
                    "history": {c["id"]: list(_history(c["id"]))[-HISTORY:] for c in d["channels"] if c["kind"] == "text"},
                })
                await HUB.roster(joined=me["name"])
                continue
            if me is None or ws not in HUB.clients:
                continue
            if t == "profile":
                _apply_profile(me, msg)
                await HUB.roster()
            elif t == "join":
                ch = next((c for c in d["channels"] if c["id"] == msg.get("cid") and c["kind"] == "voice"), None)
                if not ch:
                    continue
                inside = [m for m in HUB.clients.values() if m["voice"] == ch["id"] and m is not me]
                if len(inside) >= VOICE_MAX:
                    await ws.send_json({"t": "notice", "text": f"Kênh {ch['name']} đã đủ {VOICE_MAX} người."})
                    continue
                me["voice"] = ch["id"]
                await ws.send_json({"t": "joined", "cid": ch["id"], "peers": [m["id"] for m in inside]})
                await HUB.roster()
            elif t == "leave":
                if me["voice"]:
                    me["voice"] = None
                    await HUB.roster()
            elif t == "sig":                     # chuyển offer/answer/ICE giữa hai người cùng kênh thoại
                ows, other = HUB.by_id(str(msg.get("to") or ""))
                if other and me["voice"] and other["voice"] == me["voice"]:
                    await HUB.send(ows, {"t": "sig", "from": me["id"], "data": msg.get("data")})
            elif t == "state":
                me["mute"], me["deaf"] = bool(msg.get("mute")), bool(msg.get("deaf"))
                await HUB.roster()
            elif t == "speak":                   # viền sáng khi đang nói (cả danh sách kênh bên trái)
                if me["voice"]:
                    on = bool(msg.get("on"))
                    await asyncio.gather(*(HUB.send(w, {"t": "speak", "id": me["id"], "on": on})
                                           for w, m in list(HUB.clients.items()) if m is not me), return_exceptions=True)
            elif t == "chat":
                ch = next((c for c in d["channels"] if c["id"] == msg.get("cid") and c["kind"] == "text"), None)
                text = str(msg.get("text") or "").strip()[:2000]
                if not ch or not text:
                    continue
                if not _rate_ok(me):
                    await ws.send_json({"t": "notice", "text": "Bạn gửi nhanh quá, đợi chút nhé."})
                    continue
                m = {"mid": secrets.token_hex(6), "uid": me["uid"], "sid": me["id"], "name": me["name"], "color": me["color"],
                     "host": me["host"], "text": text, "at": time.time()}
                _append(ch["id"], m)
                await HUB.send_all({"t": "chat", "cid": ch["id"], "msg": m})
            elif t == "del":
                cid, mid = str(msg.get("cid") or ""), str(msg.get("mid") or "")
                h = _history(cid) if any(c["id"] == cid for c in d["channels"]) else None
                m = next((x for x in h if x.get("mid") == mid), None) if h is not None else None
                if m and (me["host"] or m.get("uid") == me["uid"]):
                    h.remove(m)
                    _rewrite(cid)
                    await HUB.send_all({"t": "deleted", "cid": cid, "mid": mid})
            elif me["host"]:
                await _host_action(t, msg, d)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if me is not None and ws in HUB.clients:
            HUB.clients.pop(ws, None)
            HUB.avatars.pop(me["id"], None)
            HUB.msg_times.pop(me["id"], None)
            await HUB.roster(left=me["name"])


async def _host_action(t: str, msg: dict, d: dict) -> None:
    """Chủ phòng: quản lý kênh, tắt mic / mời ra / chặn người khác."""
    if t == "mod":
        ows, other = HUB.by_id(str(msg.get("id") or ""))
        if not other or other["host"]:
            return
        a = msg.get("a")
        if a == "smute":
            other["smute"] = not other["smute"]
            await HUB.roster()
        elif a == "move-out":
            other["voice"] = None
            await HUB.send(ows, {"t": "kicked-voice"})
            await HUB.roster()
        elif a in ("kick", "ban"):
            if a == "ban" and other["uid"] not in d["bans"]:
                d["bans"] = (d.get("bans") or [])[-200:] + [other["uid"]]
                save(d)
            with contextlib.suppress(Exception):
                await ows.close(code=4403 if a == "ban" else 4401)
    elif t == "chan":
        a = msg.get("a")
        chans = d["channels"]
        if a == "add":
            kind = "voice" if msg.get("kind") == "voice" else "text"
            name = _chan_name(msg.get("name"), kind)
            if not name or len(chans) >= 30:
                return
            chans.append({"id": ("v-" if kind == "voice" else "t-") + secrets.token_hex(3), "name": name, "kind": kind})
        elif a == "rename":
            ch = next((c for c in chans if c["id"] == msg.get("cid")), None)
            name = _chan_name(msg.get("name"), ch["kind"]) if ch else ""
            if not name:
                return
            ch["name"] = name
        elif a == "del":
            ch = next((c for c in chans if c["id"] == msg.get("cid")), None)
            if not ch or sum(1 for c in chans if c["kind"] == ch["kind"]) <= 1:
                return                                   # giữ ít nhất 1 kênh mỗi loại
            chans.remove(ch)
            for ws, m in HUB.clients.items():
                if m["voice"] == ch["id"]:
                    m["voice"] = None
                    await HUB.send(ws, {"t": "kicked-voice"})
        elif a == "move":
            ids = [str(x) for x in (msg.get("order") or [])]
            if sorted(ids) == sorted(c["id"] for c in chans):
                chans.sort(key=lambda c: ids.index(c["id"]))
        else:
            return
        save(d)
        await HUB.send_all({"t": "server", "server": {"name": d["name"], "channels": chans}})
        await HUB.roster()
    elif t == "unban-all":
        d["bans"] = []
        save(d)
