"""Chọn ổ lưu theo loại nội dung và dung lượng trống."""
from __future__ import annotations

import os
import shutil
import string
from pathlib import Path

DRIVE_TYPES = {2: "removable", 3: "fixed", 4: "network", 6: "ram"}


def usage(root: str) -> dict | None:
    """Dung lượng của ổ chứa thư mục root (thư mục chưa tồn tại thì đo thư mục cha gần nhất)."""
    p = Path(root)
    while not p.exists():
        if p.parent == p:
            return None
        p = p.parent
    try:
        u = shutil.disk_usage(p)
    except OSError:
        return None
    return {"total": u.total, "used": u.used, "free": u.free,
            "percent": round(u.used / u.total * 100, 1) if u.total else 0}


def disks_status(cfg: dict) -> list[dict]:
    out = []
    for d in cfg["disks"]:
        u = usage(d["root"])
        out.append({**d, "usage": u, "online": u is not None,
                    "full": bool(u and u["percent"] >= cfg["max_full_percent"])})
    return out


def pick_disk(cfg: dict, kind: str) -> dict | None:
    """Ổ đầu tiên trong quy tắc còn dưới ngưỡng đầy; nếu tất cả đều đầy thì lấy ổ trống nhiều nhất."""
    status = {d["id"]: d for d in disks_status(cfg)}
    order = cfg["rules"].get(kind) or [d["id"] for d in cfg["disks"]]
    for did in order:
        d = status.get(did)
        if d and d["online"] and not d["full"]:
            return d
    online = [d for d in status.values() if d["online"] and d["usage"]["free"] > 2 * 1024**3]
    return max(online, key=lambda d: d["usage"]["free"]) if online else None


def find_disk(cfg: dict, disk_id: str | None) -> dict | None:
    for d in disks_status(cfg):
        if d["id"] == disk_id and d["online"]:
            return d
    return None


def _win_drive(letter: str) -> dict | None:
    import ctypes
    root = f"{letter}:\\"
    k32 = ctypes.windll.kernel32
    dtype = k32.GetDriveTypeW(root)
    if dtype not in DRIVE_TYPES:            # 0/1 = không có, 5 = ổ đĩa CD/DVD
        return None
    old = k32.SetErrorMode(1)                # không hiện hộp "chưa cắm đĩa" của Windows
    try:
        try:
            u = shutil.disk_usage(root)
        except OSError:
            return None                      # đầu đọc thẻ trống, ổ mạng mất kết nối…
        buf = ctypes.create_unicode_buffer(261)
        name = buf.value if k32.GetVolumeInformationW(root, buf, 261, None, None, None, None, 0) else ""
    finally:
        k32.SetErrorMode(old)
    return {"letter": letter, "root": root, "name": name, "type": DRIVE_TYPES[dtype], "total": u.total, "free": u.free,
            "system": letter.upper() == (os.environ.get("SystemDrive", "C:")[:1] or "C").upper()}


def list_drives() -> list[dict]:
    """Các ổ đang có trên máy (Windows: mọi ký tự ổ; nơi khác: thư mục gốc + thư mục nhà, để chạy thử)."""
    if os.name == "nt":
        return [d for d in (_win_drive(c) for c in string.ascii_uppercase) if d]
    out = []
    for i, root in enumerate(dict.fromkeys(["/", str(Path.home())])):
        try:
            u = shutil.disk_usage(root)
        except OSError:
            continue
        out.append({"letter": "/" if root == "/" else "~", "root": root, "name": "Ổ gốc" if root == "/" else "Thư mục nhà",
                    "type": "fixed", "total": u.total, "free": u.free, "system": i == 0})
    return out


def suggest_root(drive: dict) -> str:
    """Thư mục lưu đề xuất trên một ổ. Ổ hệ thống (C:) thì để trong Videos của người dùng."""
    if drive["system"]:
        return str(Path.home() / "Videos" / "CircleVault")
    if os.name == "nt":
        return f"{drive['letter']}:\\CircleVault"
    return str(Path(drive["root"]) / "CircleVault")
