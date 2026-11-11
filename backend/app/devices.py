"""Thiết bị được phép mở CircleVault qua Wi-Fi (chế độ host 0.0.0.0).

- Máy tính (127.0.0.1 / ::1) luôn được phép. Thiết bị khác phải được GHÉP: trên máy tính bấm "Thêm thiết bị" → QR chứa
  mã ghép dùng một lần (10 phút) → điện thoại mở /dt?pair=<mã>, đặt tên → nhận cookie `cv_dev` (mã bí mật dài, chỉ lưu
  bản băm SHA-256 ở DATA/devices.json). Thu hồi ở tab Lưu Trữ thì thiết bị mất quyền ngay.
- Quyền mỗi thiết bị: `phone` = chỉ trang Mang theo (/dt + /api/phone/*, chỉ đọc/tải về); `full` = như trên máy tính
  (trừ các API chỉ-máy-này như Dịch, YouTube, quản lý thiết bị).
- `Guard` là middleware ASGI bọc toàn bộ app chính (cả websocket). Phòng xem chung chạy app riêng (cổng+1), không qua đây.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
from http.cookies import SimpleCookie

from fastapi import HTTPException, Request

from . import config

PATH = config.DATA / "devices.json"
COOKIE = "cv_dev"
PAIR_TTL = 600
LOCAL = ("127.0.0.1", "::1", "localhost")
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"      # bỏ chữ dễ nhầm (0/O, 1/I/L)
SCOPES = ("phone", "full")
OPEN_PATHS = ("/dt", "/api/phone/pair", "/api/phone/me", "/favicon.ico")
PHONE_PREFIXES = ("/dt", "/static/", "/api/phone/")

_lock = threading.Lock()
_devices: list[dict] | None = None
_codes: dict[str, float] = {}                     # mã ghép → hạn dùng
_fails: list[float] = []                          # lần ghép sai gần đây (chống dò mã)


def is_local(host: str | None) -> bool:
    return host in LOCAL


def local_only(request: Request):
    """Dependency: API chỉ dùng trên chính máy tính."""
    if request.client and not is_local(request.client.host):
        raise HTTPException(403, "Chỉ làm được trên chính máy tính.")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _load() -> list[dict]:
    global _devices
    if _devices is None:
        try:
            _devices = json.loads(PATH.read_text(encoding="utf-8")).get("devices", [])
        except (OSError, ValueError):
            _devices = []
    return _devices


def _save() -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps({"devices": _devices}, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(PATH)


def public(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "token_hash"}


def list_devices() -> list[dict]:
    with _lock:
        return [public(d) for d in _load()]


def find(token: str | None) -> dict | None:
    if not token:
        return None
    h = _hash(token)
    with _lock:
        for d in _load():
            if secrets.compare_digest(d["token_hash"], h):
                if time.time() - d.get("last_seen", 0) > 60:     # ghi lại "lần cuối dùng", tối đa mỗi phút một lần
                    d["last_seen"] = time.time()
                    _save()
                return d
    return None


def new_code() -> dict:
    now = time.time()
    with _lock:
        for c in [c for c, exp in _codes.items() if exp < now]:
            _codes.pop(c, None)
        code = "".join(secrets.choice(ALPHABET) for _ in range(8))
        _codes[code] = now + PAIR_TTL
    return {"code": code, "expires_in": PAIR_TTL}


def pair(code: str, name: str, ua: str, app: bool = False) -> tuple[dict, str]:
    now = time.time()
    code = (code or "").strip().upper()
    with _lock:
        _fails[:] = [t for t in _fails if t > now - 600]
        if len(_fails) >= 20:
            raise HTTPException(429, "Nhập sai mã quá nhiều lần. Đợi 10 phút rồi tạo mã mới trên máy tính.")
        exp = _codes.pop(code, None)
        if not exp or exp < now:
            _fails.append(now)
            raise HTTPException(403, "Mã ghép sai hoặc đã hết hạn. Trên máy tính bấm \"Thêm thiết bị\" để lấy mã mới.")
        token = secrets.token_urlsafe(32)
        d = {"id": secrets.token_hex(6), "name": (name or "").strip()[:40] or "Thiết bị", "scope": "phone",
             "ua": (ua or "")[:200], "app": app, "created_at": now, "last_seen": now, "token_hash": _hash(token)}
        _load().append(d)
        _save()
    return public(d), token


def update(did: str, name: str | None = None, scope: str | None = None) -> dict:
    with _lock:
        for d in _load():
            if d["id"] == did:
                if name is not None and name.strip():
                    d["name"] = name.strip()[:40]
                if scope is not None:
                    if scope not in SCOPES:
                        raise HTTPException(400, "Quyền không hợp lệ.")
                    d["scope"] = scope
                _save()
                return public(d)
    raise HTTPException(404, "Không thấy thiết bị này.")


def remove(did: str) -> None:
    with _lock:
        devs = _load()
        devs[:] = [d for d in devs if d["id"] != did]
        _save()


def cookie_header(token: str) -> str:
    # 10 năm; HttpOnly để mã trong trang không đọc được; Lax để mở từ app Camera / màn hình chính vẫn gửi cookie
    return f"{COOKIE}={token}; Max-Age=315360000; Path=/; HttpOnly; SameSite=Lax"


def _token_from(scope) -> str | None:
    for k, v in scope.get("headers") or []:
        if k == b"cookie":
            c = SimpleCookie()
            try:
                c.load(v.decode("latin-1"))
            except Exception:  # noqa: BLE001 – cookie hỏng thì coi như không có
                return None
            m = c.get(COOKIE)
            return m.value if m else None
    return None


def allowed(path: str, dev: dict | None) -> bool:
    if path in OPEN_PATHS:
        return True
    if path.startswith("/static/"):          # mã giao diện, không có dữ liệu
        return True
    if not dev:
        return False
    if dev.get("scope") == "full":
        return True
    return path.startswith(PHONE_PREFIXES)


class Guard:
    """Middleware ASGI: thiết bị ngoài máy tính phải là thiết bị đã ghép (và đúng quyền)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        client = scope.get("client")
        if client is None or is_local(client[0]):
            return await self.app(scope, receive, send)
        dev = find(_token_from(scope))
        scope.setdefault("state", {})["device"] = dev
        path = scope.get("path") or "/"
        if allowed(path, dev):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 4403})
        if path == "/" and scope.get("method") in ("GET", "HEAD"):       # mở trang chính từ điện thoại → trang Mang theo
            return await _send(send, 302, b"", [(b"location", b"/dt")])
        msg = ("Thiết bị này chưa được phép. Trên máy tính: tab Lưu Trữ → Mang theo điện thoại → Thêm thiết bị, rồi quét mã."
               if not dev else "Thiết bị này chỉ được dùng trang Mang theo điện thoại. Đổi quyền ở tab Lưu Trữ trên máy tính.")
        body = json.dumps({"detail": msg}, ensure_ascii=False).encode()
        return await _send(send, 401 if not dev else 403, body, [(b"content-type", b"application/json; charset=utf-8")])


async def _send(send, status: int, body: bytes, headers: list) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [*headers, (b"content-length", str(len(body)).encode()), (b"cache-control", b"no-store")]})
    await send({"type": "http.response.body", "body": body})
