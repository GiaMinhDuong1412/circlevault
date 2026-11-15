"""Đọc / ghi cấu hình CircleVault (data/config.json)."""
from __future__ import annotations

import copy
import json
import os
import threading
import time
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
# Bản riêng từng nguồn (file chính bị ghi qua lại; Google xoay vòng cookie nên một trong hai có thể đã hết hiệu lực):
YT_COOKIES_BROWSER = DATA / "youtube-cookies-trinh-duyet.txt"   # tiện ích Chrome/Edge, hộp Đăng nhập YouTube
YT_COOKIES_APP = DATA / "youtube-cookies-app.txt"               # cửa sổ YouTube trong app (browser.js)

KINDS = ("youtube", "film", "comic", "novel", "other")
QUALITIES = ("best", "2160", "1440", "1080", "720", "480", "audio")

_lock = threading.Lock()


def write_file(path: Path, data: str | bytes) -> None:
    """Ghi file kiểu "ghi tạm rồi thay" an toàn trên Windows.

    Windows không cho thay (os.replace) file đang có người khác mở – luồng khác đang đọc, phần mềm diệt virus,
    Windows Search… → WinError 5 "Access is denied". Thử lại vài giây; vẫn không được thì ghi thẳng vào file.
    Mỗi luồng một file tạm riêng để hai luồng ghi cùng lúc không giẫm lên nhau."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    raw = data.encode("utf-8") if isinstance(data, str) else data
    tmp.write_bytes(raw)
    try:
        for i in range(30):                     # ~6 giây
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if i == 0:
                    try:                        # file game có thuộc tính "chỉ đọc" (bộ cài/ bản repack hay đặt) – bỏ đi
                        if path.exists() and not os.access(path, os.W_OK):
                            os.chmod(path, 0o666)
                            continue
                    except OSError:
                        pass
                    import gc
                    gc.collect()                # đóng file mà chính app còn giữ (đối tượng chờ dọn)
                time.sleep(min(0.05 * (i + 1), 0.3))
        path.write_bytes(raw)                   # vẫn bị giữ: ghi đè nội dung (Python mở file cho phép người khác ghi)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def read_json(path: Path):
    """Đọc JSON, thử lại khi file đang bị giữ/đang được ghi dở (Windows)."""
    for i in range(20):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (PermissionError, ValueError):
            if i == 19:
                raise
            time.sleep(0.1)


def _default_disks() -> list[dict]:
    """Windows: dùng tối đa 2 ổ không phải ổ hệ thống (D:, E:, F:…); máy chỉ có ổ C: thì lưu vào Videos.
    Nơi khác: 2 thư mục trong DATA (chạy thử)."""
    if os.name == "nt":
        from . import storage
        try:
            drives = [d for d in storage.list_drives() if d["type"] in ("fixed", "removable")]
        except Exception:  # noqa: BLE001 – không dò được ổ thì dùng mặc định bên dưới
            drives = []
        picked = [d for d in drives if not d["system"] and d["type"] == "fixed"][:2] \
            or [d for d in drives if not d["system"]][:2] or [d for d in drives if d["system"]][:1]
        if picked:
            return [{"id": d["letter"], "label": f"Ổ {d['letter']}:" + (f" {d['name']}" if d["name"] else ""),
                     "root": storage.suggest_root(d)} for d in picked]
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
        "video_format": "mp4",        # "mp4": video luôn đổi sang .mp4; "original": giữ định dạng gốc (webm/mkv…)
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
    roots: set[str] = set()
    clean_disks = []
    for d in disks:
        did = str(d.get("id", "")).strip()[:8]
        root = str(d.get("root", "")).strip().strip('"')
        name = str(d.get("label") or did or "?")
        if not did:
            raise ValueError(f"{name} – thiếu mã ổ.")
        if not root:
            raise ValueError(f"{name} – chưa có thư mục lưu. Bấm \"Chọn thư mục…\" hoặc bỏ ổ này.")
        if os.name == "nt" and len(root) == 2 and root[1] == ":":
            root += "\\CircleVault"                     # chỉ gõ "F:" → F:\CircleVault
        if not Path(root).is_absolute():
            raise ValueError(f"{name} – thư mục lưu phải là đường dẫn đầy đủ, ví dụ F:\\CircleVault.")
        key = os.path.normcase(os.path.normpath(root))
        if key in roots:
            raise ValueError(f"Thư mục {root} bị khai báo 2 lần. Bỏ bớt một ổ.")
        roots.add(key)
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
    if new.get("video_format") in ("mp4", "original"):
        cfg["video_format"] = new["video_format"]
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
        write_file(CONFIG_PATH, json.dumps(cfg, ensure_ascii=False, indent=2))
