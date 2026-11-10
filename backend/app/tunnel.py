"""Đường hầm Internet cho phòng xem chung: Cloudflare Quick Tunnel (cloudflared), không cần tài khoản.

`cloudflared tunnel --url http://127.0.0.1:<cổng phòng>` cho một địa chỉ https://<ngẫu nhiên>.trycloudflare.com.
Chỉ trỏ vào máy chủ phòng xem chung (party.party_app), không bao giờ trỏ vào API chính của app.
cloudflared được tải lần đầu khi cần, lưu ở <DATA>/bin.
"""
from __future__ import annotations

import atexit
import platform
import re
import shutil
import subprocess
import sys
import threading
import urllib.request

from . import config

BIN_DIR = config.DATA / "bin"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/"

state = {"status": "off", "url": None, "error": None}   # off | downloading | starting | ready | error
_proc: subprocess.Popen | None = None
_lock = threading.Lock()


def _asset() -> str | None:
    machine = platform.machine().lower()
    if sys.platform == "win32":
        return "cloudflared-windows-amd64.exe"
    if sys.platform.startswith("linux"):
        return "cloudflared-linux-arm64" if machine in ("aarch64", "arm64") else "cloudflared-linux-amd64"
    return None


def binary() -> str:
    found = shutil.which("cloudflared")
    if found:
        return found
    name = "cloudflared.exe" if sys.platform == "win32" else "cloudflared"
    path = BIN_DIR / name
    if path.exists():
        return str(path)
    asset = _asset()
    if not asset:
        raise RuntimeError("Chưa hỗ trợ mở phòng qua Internet trên hệ điều hành này.")
    state.update(status="downloading", error=None)
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tai")
    req = urllib.request.Request(RELEASE + asset, headers={"User-Agent": "CircleVault"})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.replace(path)
    if sys.platform != "win32":
        path.chmod(0o755)
    return str(path)


def _run(port: int) -> None:
    global _proc
    try:
        exe = binary()
        state.update(status="starting", url=None, error=None)
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        _proc = subprocess.Popen(
            [exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", creationflags=flags)
        last = []
        for line in _proc.stdout:
            last = (last + [line.strip()])[-6:]
            m = URL_RE.search(line)
            if m and state["status"] != "ready":
                state.update(status="ready", url=m.group(0))
        code = _proc.wait()
        if state["status"] != "off":
            hint = next((x for x in reversed(last) if "ERR" in x or "error" in x.lower()), "")
            state.update(status="error", url=None,
                         error=f"Đường hầm dừng (mã {code}). {hint[-200:]}".strip())
    except Exception as e:
        state.update(status="error", url=None, error=f"Không mở được đường hầm: {e}"[:300])
    finally:
        _proc = None


def start(port: int) -> dict:
    with _lock:
        if _proc is not None and state["status"] in ("starting", "ready"):
            return state
        state.update(status="starting", url=None, error=None)
        threading.Thread(target=_run, args=(port,), daemon=True).start()
    return state


def stop() -> dict:
    with _lock:
        state.update(status="off", url=None, error=None)
        p = _proc
        if p is not None:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
    return state


def cleanup_at_exit() -> None:
    if _proc is not None:
        try:
            _proc.kill()
        except OSError:
            pass


atexit.register(cleanup_at_exit)
