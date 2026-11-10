"""Đọc / ghi cấu hình CircleVault (data/config.json)."""
from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # thư mục backend/
DATA = Path(os.environ.get("CIRCLEVAULT_DATA") or ROOT / "data")
WEB = Path(os.environ.get("CIRCLEVAULT_WEB") or ROOT.parent / "frontend")
VERSION = os.environ.get("CIRCLEVAULT_VERSION") or "dev"
IS_APP = bool(os.environ.get("CIRCLEVAULT_APP"))       # chạy bên trong app desktop (Electron)
CONFIG_PATH = DATA / "config.json"
ARCHIVE_PATH = DATA / "archive.txt"   # ID các video đã tải, để không tải trùng
DB_PATH = DATA / "circlevault.db"
YT_COOKIES = DATA / "youtube-cookies.txt"  # app desktop ghi sau khi đăng nhập YouTube trong cửa sổ YouTube

KINDS = ("youtube", "film", "comic", "novel", "other")
QUALITIES = ("best", "2160", "1440", "1080", "720", "480", "audio")

_lock = threading.Lock()


def _default_disks() -> list[dict]:
    """Trên Windows dùng ổ D: và E: nếu có; nơi khác dùng 2 thư mục trong dự án."""
    if os.name == "nt":
        disks = []
        for letter in ("D", "E"):
            if Path(f"{letter}:\\").exists():
                disks.append({"id": letter, "label": f"Ổ {letter}:", "root": f"{letter}:\\CircleVault"})
        if disks:
            return disks
    return [
        {"id": "A", "label": "Ổ 1", "root": str(DATA / "downloads" / "disk1")},
        {"id": "B", "label": "Ổ 2", "root": str(DATA / "downloads" / "disk2")},
    ]


def _default_rules(disks: list[dict]) -> dict:
    ids = [d["id"] for d in disks]
    first_last = ids[:1] + ids[-1:] if len(ids) > 1 else ids
    last_first = list(reversed(first_last))
    # Video/phim ưu tiên ổ cuối (thường là ổ lớn hơn), truyện ưu tiên ổ đầu.
    return {"youtube": last_first, "film": last_first, "other": last_first,
            "comic": first_last, "novel": first_last}


def defaults() -> dict:
    disks = _default_disks()
    return {
        "host": "127.0.0.1",          # đổi thành "0.0.0.0" để mở từ điện thoại cùng Wi-Fi
        "port": 8686,
        "disks": disks,
        "rules": _default_rules(disks),
        "max_full_percent": 90,       # ổ dùng quá mức này thì chuyển sang ổ khác
        "max_concurrent_per_disk": 2,
        "default_quality": "1080",
        "subtitle_langs": ["vi", "en"],
        "embed_subs": True,
        "cookies_from_browser": "",   # vd "chrome" / "edge" / "firefox" cho video giới hạn tuổi
        "music_folders": [],          # thư mục nhạc có sẵn trên máy, quét vào trang Nghe Nhạc
        "use_youtube_account": True,  # đã đăng nhập YouTube trong app thì tải bằng tài khoản đó (Premium, giới hạn tuổi…)
    }


def load() -> dict:
    with _lock:
        cfg = defaults()
        if CONFIG_PATH.exists():
            try:
                saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                cfg.update({k: v for k, v in saved.items() if k in cfg})
            except (OSError, json.JSONDecodeError):
                pass
        else:
            DATA.mkdir(parents=True, exist_ok=True)
            CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return copy.deepcopy(cfg)


def validate(new: dict) -> dict:
    cfg = load()
    disks = new.get("disks", cfg["disks"])
    if not isinstance(disks, list) or not disks:
        raise ValueError("Cần ít nhất 1 ổ lưu trữ.")
    seen = set()
    clean_disks = []
    for d in disks:
        did = str(d.get("id", "")).strip()[:8]
        root = str(d.get("root", "")).strip()
        if not did or not root:
            raise ValueError("Mỗi ổ cần có mã và đường dẫn thư mục.")
        if did in seen:
            raise ValueError(f"Mã ổ '{did}' bị trùng.")
        seen.add(did)
        clean_disks.append({"id": did, "label": str(d.get("label") or did)[:40], "root": root})
    cfg["disks"] = clean_disks

    rules = new.get("rules", cfg["rules"])
    cfg["rules"] = {k: [i for i in rules.get(k, []) if i in seen] or [clean_disks[0]["id"]] for k in KINDS}

    for key, lo, hi in (("max_full_percent", 50, 99), ("max_concurrent_per_disk", 1, 8), ("port", 1024, 65535)):
        if key in new:
            cfg[key] = max(lo, min(hi, int(new[key])))
    if new.get("default_quality") in QUALITIES:
        cfg["default_quality"] = new["default_quality"]
    if "subtitle_langs" in new:
        langs = new["subtitle_langs"]
        if isinstance(langs, str):
            langs = langs.split(",")
        cfg["subtitle_langs"] = [s.strip() for s in langs if s.strip()][:6]
    if "use_youtube_account" in new:
        cfg["use_youtube_account"] = bool(new["use_youtube_account"])
    if "embed_subs" in new:
        cfg["embed_subs"] = bool(new["embed_subs"])
    if "cookies_from_browser" in new:
        cfg["cookies_from_browser"] = str(new["cookies_from_browser"] or "").strip().lower()
    if "music_folders" in new:
        folders = new["music_folders"]
        if isinstance(folders, str):
            folders = folders.splitlines()
        cfg["music_folders"] = [str(f).strip() for f in folders if str(f).strip()][:20]
    if new.get("host") in ("127.0.0.1", "0.0.0.0"):
        cfg["host"] = new["host"]
    return cfg


def save(cfg: dict) -> None:
    with _lock:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CONFIG_PATH)
