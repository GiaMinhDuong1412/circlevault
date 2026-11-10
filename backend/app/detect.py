"""Nhận diện link thuộc loại nào: YouTube, phim, truyện..."""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

LABELS = {
    "youtube": "YouTube",
    "film": "Phim / video web",
    "comic": "Truyện tranh",
    "novel": "Truyện chữ",
    "other": "Trang khác",
}

_COMIC = re.compile(r"truyen|manga|manhwa|manhua|comic|chap|chuong|doujin", re.I)
_NOVEL = re.compile(r"truyenchu|truyen-chu|tieuthuyet|novel|wattpad", re.I)
_FILM = re.compile(r"phim|movie|film|motchill|anime|xem|tv", re.I)


def classify(url: str) -> dict:
    try:
        u = urlparse(url.strip())
    except ValueError:
        return {"ok": False, "error": "Link không hợp lệ."}
    if u.scheme not in ("http", "https") or not u.netloc:
        return {"ok": False, "error": "Link cần bắt đầu bằng http:// hoặc https://"}

    host = u.netloc.lower().removeprefix("www.").removeprefix("m.")
    hay = host + u.path
    qs = parse_qs(u.query)
    has_list = "list" in qs
    has_video = "v" in qs or host == "youtu.be" or "/shorts/" in u.path

    if host.endswith("youtube.com") or host == "youtu.be" or host.endswith("youtube-nocookie.com"):
        kind = "youtube"
    elif u.path.lower().endswith((".m3u8", ".mpd", ".mp4", ".mkv", ".webm")):
        kind = "film"
    elif _NOVEL.search(hay):
        kind = "novel"
    elif _COMIC.search(hay):
        kind = "comic"
    elif _FILM.search(hay):
        kind = "film"
    else:
        kind = "other"

    supported = kind not in ("comic", "novel")
    note = {
        "comic": "Tải truyện full bộ thuộc giai đoạn 2 (gallery-dl + plugin web truyện Việt).",
        "novel": "Tải truyện chữ (EPUB) thuộc giai đoạn 2.",
    }.get(kind, "")
    return {
        "ok": True, "kind": kind, "label": LABELS[kind], "supported": supported, "note": note,
        "has_list": has_list, "has_video": has_video,
    }
