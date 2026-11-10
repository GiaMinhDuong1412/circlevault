"""Chọn ổ lưu theo loại nội dung và dung lượng trống."""
from __future__ import annotations

import shutil
from pathlib import Path


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
