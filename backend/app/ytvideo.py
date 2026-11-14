"""YouTube bằng giao diện CircleVault (tab YouTube): dữ liệu lấy bằng yt-dlp (danh sách phẳng, nhanh), video phát bằng trình phát
nhúng chính thức của YouTube trong trang của app. Đăng nhập YouTube trong app (DATA/youtube-cookies.txt) → có Đề xuất cho bạn,
Kênh đăng ký, Xem sau, Đã thích, Lịch sử. Chỉ dùng trên chính máy tính (cookie tài khoản).

  GET /api/yt/feed?kind=home|subs|later|liked|history
  GET /api/yt/search?q=
  GET /api/yt/channel?c=<id kênh | @handle | link>
  GET /api/yt/video?v=<id>          → chi tiết + video liên quan (cùng kênh + cùng chủ đề)
"""
from __future__ import annotations

import json
import random
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import config, devices, downloader, ytinner
from .ytmusic import _ydl_info, _get, VID

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
        res = _cached("home:all", lambda: _home(refresh), 300)
        if not res.get("items"):              # lỗi / trang chủ rỗng: chỉ nhớ 45 giây để lần sau thử lại
            with _lock:
                if "home:all" in _cache:
                    _cache["home:all"] = (time.time() - 300 + 45, res)
        return {"kind": kind, "title": title, "logged_in": True, "topics": TOPICS, **res}
    items = _cached("feed:" + kind, lambda: _list(url, 60)[1], 300 if kind == "subs" else TTL)
    return {"kind": kind, "title": title, "logged_in": True, "items": items, "topics": TOPICS}


def _try_list(url: str, n: int, warn: list | None = None) -> list[dict]:
    try:
        return _list(url, n, warn)[1]
    except HTTPException as e:
        if warn is not None:
            warn.append(str(e.detail))
        return []


HIST = config.DATA / "yt-xem-gan-day.json"     # video đã mở trong tab YouTube (để gợi ý khi YouTube không trả trang chủ)


def _remember(d: dict) -> None:
    try:
        rows = json.loads(HIST.read_text(encoding="utf-8")) if HIST.exists() else []
    except (OSError, ValueError):
        rows = []
    rows = [r for r in rows if isinstance(r, dict) and r.get("id") != d["id"]]
    rows.insert(0, {"id": d["id"], "title": d.get("title") or "", "channel": d.get("channel") or "", "at": int(time.time())})
    try:
        tmp = HIST.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows[:40], ensure_ascii=False), encoding="utf-8")
        tmp.replace(HIST)
    except OSError:
        pass


def _local_sections() -> list[dict]:
    """Gợi ý không cần đăng nhập: "video tiếp theo" của YouTube cho mấy video mở gần đây trong app; chưa mở video nào thì theo chủ đề."""
    try:
        rows = json.loads(HIST.read_text(encoding="utf-8")) if HIST.exists() else []
    except (OSError, ValueError):
        rows = []
    rows = [r for r in rows if isinstance(r, dict) and VID.match(str(r.get("id") or ""))][:3]
    with ThreadPoolExecutor(3) as ex:
        nexts = list(ex.map(lambda r: _cached("n:" + r["id"], lambda: _next(r["id"]), 1800), rows))
    seen = {r["id"] for r in rows}
    out = []
    for r, n in zip(rows, nexts):
        items = [x for x in ((n or {}).get("related") or []) if x["id"] not in seen]
        seen.update(x["id"] for x in items)
        if items:
            out.append({"title": f"Vì bạn đã xem “{(r.get('title') or 'video')[:60]}”", "items": items[:24]})
    if not out:
        for t in TOPICS[:2]:
            items = _cached("q:" + t.lower(), lambda t=t: _try_list(f"ytsearch24:{t}", 24))
            if items:
                out.append({"title": f"Chủ đề: {t}", "items": items})
    return out


_SHOWN: deque = deque(maxlen=400)       # video/danh sách đã hiện ở trang chủ (Làm mới thì đưa cái mới lên trước)


def _pl(e: dict) -> dict | None:
    """Danh sách kết hợp (Mix) / playlist ở trang chủ → thẻ danh sách."""
    if e.get("_type") != "list" or not e.get("list") or not e.get("title"):
        return None
    first = e.get("first") or ""
    if not VID.match(first):
        m = re.match(r"^RD([\w-]{11})$", e["list"])     # Mix của một video: RD + mã video
        first = m.group(1) if m else ""
    return {"kind": "list", "id": "L:" + e["list"], "list": e["list"], "first": first, "title": e["title"],
            "sub": e.get("sub") or "", "badge": e.get("badge") or "", "mix": bool(e.get("mix")),
            "thumb": e.get("thumb") or (f"https://i.ytimg.com/vi/{first}/hqdefault.jpg" if first else "")}


def _fresh(items: list[dict], refresh: bool) -> list[dict]:
    """Làm mới: mục chưa hiện lần nào lên trước (giữ thứ tự YouTube), mục đã xem qua xuống sau và đảo thứ tự."""
    if refresh and _SHOWN:
        shown = set(_SHOWN)
        new = [x for x in items if x["id"] not in shown]
        old = [x for x in items if x["id"] in shown]
        random.shuffle(old)
        items = new + old
    _SHOWN.extend(x["id"] for x in items[:60])
    return items


def _home(refresh: bool = False) -> dict:
    """Trang chủ YouTube (đề xuất). YouTube trả trang chủ RỖNG khi tài khoản tắt Lịch sử xem (hoặc cookie không còn hiệu lực)
    → tự ghép đề xuất: video mới từ kênh đăng ký + video giống những video đã xem / đã thích gần đây."""
    warn: list[str] = []
    items: list[dict] = []
    inner_note = ""
    try:                                     # như trang chủ youtube.com (browse FEwhat_to_watch)
        raw, inner_note = ytinner.home(6 if refresh else 3, 160 if refresh else 80)
    except ytinner.Stale as e:               # cookie hết hiệu lực: các mục cần đăng nhập đều rỗng → đề xuất từ video đã mở trong app
        return {"items": [], "stale": True, "sections": _local_sections(),
                "note": f"{e} Mở Chrome/Edge (có tiện ích CircleVault) cho tiện ích gửi lại đăng nhập, hoặc bấm Đăng nhập YouTube lại. "
                        "Trong lúc chờ, CircleVault gợi ý từ những video bạn mở gần đây."}
    except Exception as e:  # noqa: BLE001
        raw = []
        inner_note = downloader.clean(str(e))[:200]
    seen0: set[str] = set()
    for e in raw:
        v = _pl(e) if e.get("_type") == "list" else _v(e)
        if v and v["id"] not in seen0 and not v.get("short"):
            seen0.add(v["id"])
            items.append(v)
    if items:
        return {"items": _fresh(items, refresh)[:90]}
    if inner_note:
        warn.append(inner_note)
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
    sections = [x for x in sections if x["items"]] or _local_sections()
    why = next((w for w in warn if re.search(r"cookie|sign in|log in|logged|YouTube báo", w, re.I)), "")
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


def _next(v: str, plist: str = "") -> dict | None:
    """Chi tiết + 'video tiếp theo' thật của YouTube (endpoint next). None nếu không đọc được."""
    try:
        n = ytinner.watch_next(v, plist)
    except Exception:  # noqa: BLE001
        return None
    if not n or not n.get("title"):
        return None
    seen, related = {v}, []
    for e in n["related"]:
        x = _v(e)
        if x and x["id"] not in seen:
            seen.add(x["id"])
            related.append(x)
    return {"id": v, "title": n["title"], "channel": n["channel"], "channel_id": n["channel_id"], "views": n["views"],
            "views_text": n["views_text"], "likes": n["likes"], "date": n["date"], "subs_text": n["subs_text"],
            "description": n["description"][:5000], "playable_in_embed": True, "related": related[:40],
            "queue": _queue_out(n.get("queue"))}


def _queue_out(q: dict | None) -> dict | None:
    if not q:
        return None
    items = []
    for e in q["items"]:
        x = _v(e)
        if x:
            items.append(x)
    return {"title": q["title"], "owner": q["owner"], "index": q["index"], "mix": q["mix"], "items": items} if items else None


@router.get("/video")
def video(v: str, list: str = ""):  # noqa: A002 – tên tham số giống YouTube
    if not VID.match(v or ""):
        raise HTTPException(400, "Mã video không hợp lệ.")
    plist = list if re.match(r"^[\w-]{10,64}$", list or "") else ""
    nx = _cached(f"n:{v}:{plist}", lambda: _next(v, plist), 1800 if not plist else 600)
    if nx and nx.get("title"):
        _remember(nx)
    if nx and nx["related"]:
        return nx
    try:
        det = _cached("v:" + v, lambda: _details(v), 3600)
    except HTTPException:
        if nx:
            return nx
        raise
    if not nx:
        _remember(det)
    if nx:
        det = {**det, **{k: nx[k] for k in ("title", "channel", "channel_id", "views", "likes", "date", "description") if nx.get(k)}}
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


@router.get("/list")
def plist(l: str):  # noqa: E741
    """Video trong một playlist (khi thẻ danh sách không kèm sẵn video đầu tiên)."""
    if not re.match(r"^[\w-]{10,64}$", l or ""):
        raise HTTPException(400, "Danh sách không hợp lệ.")
    return {"items": _cached("pl:" + l, lambda: _list(f"https://www.youtube.com/playlist?list={l}", 50)[1])}


@router.get("/status")
def status():
    return {"logged_in": downloader.youtube_logged_in(), "use_account": config.load().get("use_youtube_account", True)}


# ------------------------------------------------------------------ trình phát của app (không dùng trình phát nhúng)
# YouTube tách hình và tiếng ở chất lượng cao: trang dùng <video> (chỉ hình) + <audio> (chỉ tiếng) chạy khớp nhau;
# luồng đi qua /api/yt/s/<id>/<định dạng> (chuyển tiếp Range từng đoạn 8 MB, link hết hạn thì lấy lại).
_play: dict[str, dict] = {}
_play_lock = threading.Lock()
PCHUNK = 8 * 1024 * 1024


def _vcodec_rank(f: dict) -> int:
    c = (f.get("vcodec") or "").lower()
    return 3 if c.startswith("avc1") else 2 if c.startswith(("vp09", "vp9")) else 1 if c.startswith("av01") else 0


def _resolve_play(vid: str, force: bool = False) -> dict:
    with _play_lock:
        hit = _play.get(vid)
        if hit and not force and hit["exp"] > time.time():
            return hit
    info = _ydl_info(f"https://www.youtube.com/watch?v={vid}")
    fmts = [f for f in info.get("formats") or [] if f.get("url") and f.get("protocol") in ("https", "http")
            and not f.get("has_drm")]
    none = (None, "none")
    vo = [f for f in fmts if f.get("vcodec") not in none and f.get("acodec") in none and (f.get("height") or 0) > 0]
    ao = [f for f in fmts if f.get("acodec") not in none and f.get("vcodec") in none]
    av = [f for f in fmts if f.get("acodec") not in none and f.get("vcodec") not in none]
    by_h: dict[int, dict] = {}
    for f in vo:
        h = int(f["height"])
        if h not in by_h or (_vcodec_rank(f), f.get("tbr") or 0) > (_vcodec_rank(by_h[h]), by_h[h].get("tbr") or 0):
            by_h[h] = f
    audio = max(ao, key=lambda f: (f.get("ext") == "m4a", f.get("abr") or f.get("tbr") or 0)) if ao else None
    prog = max(av, key=lambda f: f.get("height") or 0) if av else None

    def mime(f, kind):
        ext = f.get("ext") or ("mp4" if kind == "video" else "m4a")
        return f"{kind}/{'mp4' if ext in ('mp4', 'm4a') else 'webm' if ext == 'webm' else ext}"
    table = {}
    for f in by_h.values():
        table[f["format_id"]] = {"url": f["url"], "headers": f.get("http_headers") or {}, "mime": mime(f, "video")}
    if audio:
        table[audio["format_id"]] = {"url": audio["url"], "headers": audio.get("http_headers") or {}, "mime": mime(audio, "audio")}
    if prog:
        table[prog["format_id"]] = {"url": prog["url"], "headers": prog.get("http_headers") or {}, "mime": mime(prog, "video")}
    q = [{"h": h, "f": by_h[h]["format_id"], "codec": (by_h[h].get("vcodec") or "").split(".")[0], "fps": by_h[h].get("fps")}
         for h in sorted(by_h, reverse=True)]
    entry = {"exp": time.time() + 4 * 3600, "table": table, "qualities": q, "audio": audio and audio["format_id"],
             "prog": prog and prog["format_id"], "live": info.get("is_live") or info.get("live_status") == "is_live",
             "duration": info.get("duration"), "title": info.get("title")}
    with _play_lock:
        _play[vid] = entry
        if len(_play) > 60:
            for k in sorted(_play, key=lambda k: _play[k]["exp"])[:20]:
                _play.pop(k, None)
    return entry


@router.get("/play")
def play(v: str):
    if not VID.match(v or ""):
        raise HTTPException(400, "Mã video không hợp lệ.")
    e = _resolve_play(v)
    if e["live"]:
        return {"mode": "embed", "why": "Video đang phát trực tiếp: xem bằng trình phát YouTube."}
    if e["qualities"] and e["audio"]:
        return {"mode": "split", "qualities": e["qualities"], "audio": f"/api/yt/s/{v}/{e['audio']}",
                "default": next((x["f"] for x in e["qualities"] if x["h"] <= 1080), e["qualities"][-1]["f"]),
                "base": f"/api/yt/s/{v}/", "duration": e["duration"]}
    if e["prog"]:
        return {"mode": "single", "src": f"/api/yt/s/{v}/{e['prog']}", "duration": e["duration"]}
    return {"mode": "embed", "why": "Không lấy được luồng phát của video này."}


_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


@router.get("/s/{vid}/{fid}")
def stream(vid: str, fid: str, request: Request):
    if not VID.match(vid) or not re.match(r"^[\w-]{1,40}$", fid):
        raise HTTPException(400, "Sai định dạng.")
    e = _resolve_play(vid)
    src = e["table"].get(fid)
    if not src:
        raise HTTPException(404, "Không có định dạng này.")
    m = _RANGE.match(request.headers.get("range", "") or "")
    start = int(m.group(1)) if m and m.group(1) else 0
    want_end = int(m.group(2)) if m and m.group(2) else None
    stop = start + PCHUNK - 1 if want_end is None else min(want_end, start + PCHUNK - 1)
    r = _get(src, start, stop)
    if r.status_code in (403, 410):                       # link hết hạn → lấy lại
        r.close()
        src = _resolve_play(vid, force=True)["table"].get(fid)
        if not src:
            raise HTTPException(410, "Định dạng không còn, bấm phát lại.")
        r = _get(src, start, stop)
    if r.status_code == 416:
        r.close()
        raise HTTPException(416, "Vượt quá cuối video.")
    if r.status_code not in (200, 206):
        r.close()
        raise HTTPException(502, f"YouTube từ chối luồng (mã {r.status_code}).")
    cr = re.search(r"/(\d+)", r.headers.get("content-range", ""))
    total = int(cr.group(1)) if cr else int(r.headers.get("content-length") or 0) + (start if r.status_code == 206 else 0)
    if r.status_code == 200:
        start = 0
    end = min(stop, total - 1) if total else stop
    if want_end is None and total and r.status_code == 200:
        end = total - 1

    def gen(r=r):
        sent = 0
        try:
            for chunk in r.iter_content(64 * 1024):
                if sent > end - start:
                    break
                chunk = chunk[: end - start + 1 - sent]
                sent += len(chunk)
                yield chunk
        finally:
            r.close()
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1), "Cache-Control": "no-store",
               "Content-Range": f"bytes {start}-{end}/{total or '*'}"}
    return StreamingResponse(gen(), status_code=206, media_type=src["mime"], headers=headers)
