"""YouTube bằng giao diện CircleVault (tab YouTube): dữ liệu lấy bằng yt-dlp (danh sách phẳng, nhanh), video phát bằng trình phát
nhúng chính thức của YouTube trong trang của app. Đăng nhập YouTube trong app (DATA/youtube-cookies.txt) → có Đề xuất cho bạn,
Kênh đăng ký, Xem sau, Đã thích, Lịch sử. Chỉ dùng trên chính máy tính (cookie tài khoản).

  GET /api/yt/feed?kind=home|subs|later|liked|history
  GET /api/yt/search?q=
  GET /api/yt/channel?c=<id kênh | @handle | link>
  GET /api/yt/video?v=<id>          → chi tiết + video liên quan (cùng kênh + cùng chủ đề)
"""
from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException

from . import config, devices, downloader
from .ytmusic import _ydl_info, VID

router = APIRouter(prefix="/api/yt", dependencies=[Depends(devices.local_only)])
_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()
TTL = 600

FEEDS = {
    "home": ("https://www.youtube.com/", "Đề xuất cho bạn"),
    "subs": ("https://www.youtube.com/feed/subscriptions", "Kênh đăng ký"),
    "later": ("https://www.youtube.com/playlist?list=WL", "Xem sau"),
    "liked": ("https://www.youtube.com/playlist?list=LL", "Video đã thích"),
    "history": ("https://www.youtube.com/feed/history", "Đã xem"),
}
TOPICS = ["Âm nhạc", "Trò chơi", "Tin tức", "Thể thao", "Phim", "Hài", "Nấu ăn", "Học tập", "Công nghệ", "Du lịch"]


def _cached(key: str, fn, ttl: int = TTL):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (time.time(), val)
        if len(_cache) > 200:
            for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:50]:
                _cache.pop(k, None)
    return val


def _flat(info: dict, depth: int = 0) -> list[dict]:
    out = []
    for e in info.get("entries") or []:
        if not e:
            continue
        if e.get("_type") == "playlist" and e.get("entries") is not None and depth < 2:
            out += _flat(e, depth + 1)
        else:
            out.append(e)
    return out


def _v(e: dict) -> dict | None:
    """Một mục video phẳng của yt-dlp → thẻ video cho giao diện."""
    vid = str(e.get("id") or "")
    if not VID.match(vid) or e.get("title") in ("[Private video]", "[Deleted video]"):
        return None
    url = str(e.get("url") or e.get("webpage_url") or "")
    return {
        "id": vid, "title": e.get("title") or vid,
        "channel": e.get("channel") or e.get("uploader") or "",
        "channel_id": e.get("channel_id") or e.get("uploader_id") or "",
        "duration": e.get("duration"), "views": e.get("view_count"),
        "live": e.get("live_status") == "is_live", "short": "/shorts/" in url,
        "thumb": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
    }


def _list(url: str, n: int = 48, warn: list | None = None) -> tuple[dict, list[dict]]:
    info = _ydl_info(url, extract_flat=True, playlistend=n, _warn=warn)
    seen, out = set(), []
    for e in _flat(info):
        v = _v(e)
        if v and v["id"] not in seen:
            seen.add(v["id"])
            out.append(v)
    return info, out


@router.get("/feed")
def feed(kind: str = "home", refresh: bool = False):
    if kind not in FEEDS:
        raise HTTPException(400, "Mục không hợp lệ.")
    logged = downloader.youtube_logged_in()
    if not logged:
        return {"kind": kind, "title": FEEDS[kind][1], "logged_in": False, "items": [], "topics": TOPICS}
    url, title = FEEDS[kind]
    if refresh:
        for k in [k for k in _cache if k.startswith(("feed:", "home:"))]:
            _cache.pop(k, None)
    if kind == "home":
        return {"kind": kind, "title": title, "logged_in": True, "topics": TOPICS, **_cached("home:all", _home, 300)}
    items = _cached("feed:" + kind, lambda: _list(url, 60)[1], 300 if kind == "subs" else TTL)
    return {"kind": kind, "title": title, "logged_in": True, "items": items, "topics": TOPICS}


def _try_list(url: str, n: int, warn: list | None = None) -> list[dict]:
    try:
        return _list(url, n, warn)[1]
    except HTTPException as e:
        if warn is not None:
            warn.append(str(e.detail))
        return []


def _home() -> dict:
    """Trang chủ YouTube (đề xuất). YouTube trả trang chủ RỖNG khi tài khoản tắt Lịch sử xem (hoặc cookie không còn hiệu lực)
    → tự ghép đề xuất: video mới từ kênh đăng ký + video giống những video đã xem / đã thích gần đây."""
    warn: list[str] = []
    items = _try_list(FEEDS["home"][0], 60, warn)
    if items:
        return {"items": items}
    with ThreadPoolExecutor(3) as ex:
        f_subs = ex.submit(_try_list, FEEDS["subs"][0], 24)
        f_hist = ex.submit(_try_list, FEEDS["history"][0], 6)
        f_like = ex.submit(_try_list, FEEDS["liked"][0], 6)
        subs, hist, liked = f_subs.result(), f_hist.result(), f_like.result()
    seen: set[str] = set()

    def similar(src: list[dict], k: int = 3) -> list[dict]:
        qs = []
        for v in src[:k]:
            words = re.sub(r"[\[\](){}|•·\-–—_/\\\"'“”#@!?.,:;]+", " ", v["title"]).split()
            if words:
                qs.append(" ".join(words[:5]))
        with ThreadPoolExecutor(3) as ex2:
            res = list(ex2.map(lambda q: _cached("q:" + q.lower(), lambda: _try_list(f"ytsearch12:{q}", 12)), qs))
        out = []
        for i in range(12):
            for r in res:
                if i < len(r) and r[i]["id"] not in seen:
                    seen.add(r[i]["id"])
                    out.append(r[i])
        return out[:24]
    seen.update(v["id"] for v in hist + liked)
    sections = []
    if subs:
        seen.update(v["id"] for v in subs)
        sections.append({"title": "Mới từ kênh bạn đăng ký", "items": subs})
    if hist:
        sections.append({"title": "Giống video bạn đã xem", "items": similar(hist)})
    if liked:
        sections.append({"title": "Giống video bạn đã thích", "items": similar(liked)})
    sections = [x for x in sections if x["items"]]
    why = next((w for w in warn if re.search(r"cookie|sign in|log in|logged", w, re.I)), "")
    note = ("YouTube không trả về trang chủ đề xuất" + (f" ({why[:160]})" if why else
            " – thường do tài khoản đang TẮT Lịch sử xem (YouTube khi đó để trống trang chủ)") +
            ". CircleVault tự ghép đề xuất từ kênh đăng ký và video bạn đã xem/thích.")
    return {"items": [], "sections": sections, "note": note}


@router.get("/search")
def search(q: str):
    q = re.sub(r"\s+", " ", q or "").strip()[:200]
    if not q:
        raise HTTPException(400, "Gõ từ khóa để tìm.")
    items = _cached("q:" + q.lower(), lambda: _list(f"ytsearch40:{q}", 40)[1])
    return {"title": f"Kết quả cho “{q}”", "items": items}


def _channel_url(c: str) -> str:
    c = (c or "").strip()
    if re.match(r"https?://(www\.|m\.)?youtube\.com/", c):
        base = re.sub(r"/(videos|featured|streams|shorts|playlists)/?$", "", c.split("?")[0].rstrip("/"))
        return base + "/videos"
    if re.match(r"^UC[\w-]{22}$", c):
        return f"https://www.youtube.com/channel/{c}/videos"
    if re.match(r"^@[\w.-]{2,60}$", c):
        return f"https://www.youtube.com/{c}/videos"
    raise HTTPException(400, "Kênh không hợp lệ.")


@router.get("/channel")
def channel(c: str):
    url = _channel_url(c)

    def load():
        info, items = _list(url, 48)
        name = re.sub(r"\s*-\s*Videos$", "", info.get("channel") or info.get("uploader") or info.get("title") or "Kênh")
        return {"title": name, "channel_id": info.get("channel_id") or "", "url": url.rsplit("/videos", 1)[0],
                "subs": info.get("channel_follower_count"), "items": items}
    return _cached("ch:" + url, load)


def _details(vid: str) -> dict:
    info = _ydl_info(f"https://www.youtube.com/watch?v={vid}", _process=False)
    d = info.get("upload_date") or ""
    return {"id": vid, "title": info.get("title") or vid, "channel": info.get("channel") or info.get("uploader") or "",
            "channel_id": info.get("channel_id") or "", "views": info.get("view_count"), "likes": info.get("like_count"),
            "date": f"{d[6:8]}/{d[4:6]}/{d[:4]}" if len(d) == 8 else "", "duration": info.get("duration"),
            "description": (info.get("description") or "")[:5000], "subs": info.get("channel_follower_count"),
            "live": info.get("live_status") == "is_live", "playable_in_embed": info.get("playable_in_embed", True),
            "tags": (info.get("tags") or [])[:8]}


@router.get("/video")
def video(v: str):
    if not VID.match(v or ""):
        raise HTTPException(400, "Mã video không hợp lệ.")
    det = _cached("v:" + v, lambda: _details(v), 3600)
    words = re.sub(r"[\[\](){}|•·\-–—_/\\\"'“”#@!?.,:;]+", " ", det["title"]).split()
    q = " ".join(words[:6]) or det["channel"]

    def same_channel():
        if not det["channel_id"]:
            return []
        try:
            return _cached("ch12:" + det["channel_id"],
                           lambda: _list(f"https://www.youtube.com/channel/{det['channel_id']}/videos", 12)[1])
        except HTTPException:
            return []

    def same_topic():
        try:
            return _cached("q:" + q.lower(), lambda: _list(f"ytsearch20:{q}", 20)[1])
        except HTTPException:
            return []
    with ThreadPoolExecutor(2) as ex:
        a, b = ex.submit(same_topic), ex.submit(same_channel)
        topic, chan = a.result(), b.result()
    seen = {v}
    related = []
    for item in [x for pair in zip(topic, chan) for x in pair] + topic[len(chan):] + chan[len(topic):]:
        if item["id"] not in seen:
            seen.add(item["id"])
            related.append(item)
    return {**det, "related": related[:30]}


@router.get("/status")
def status():
    return {"logged_in": downloader.youtube_logged_in(), "use_account": config.load().get("use_youtube_account", True)}
