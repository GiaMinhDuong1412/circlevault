"""Nhạc online cho tab Nghe Nhạc (YouTube, SoundCloud, Bandcamp – nguồn công khai, nghe như trên trang gốc): playlist của tài khoản đã đăng nhập trong app, mở playlist bằng link,
nghe trực tiếp không cần tải (backend lấy link luồng âm thanh bằng yt-dlp rồi chuyển tiếp, hỗ trợ tua), bài nào đã tải
về máy thì phát file trên máy.

Chỉ nhận yêu cầu từ chính máy này: các lệnh ở đây dùng cookie tài khoản YouTube của người dùng.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from urllib.parse import parse_qs, urlparse

import requests
import yt_dlp
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import config, db, downloader

_log = logging.getLogger(__name__)

CHUNK = 4 * 1024 * 1024          # mỗi lần hỏi googlevideo 4 MB (yêu cầu quá lớn dễ bị bóp tốc độ)
LIST_TTL = 10 * 60               # nhớ danh sách bài của playlist 10 phút
CACHE_PATH = config.DATA / "yt-playlists.json"
VID = re.compile(r"^[\w-]{11}$")
LIST = re.compile(r"^[\w-]{2,80}$")
# Nguồn nghe online được phép (yt-dlp đọc được, phát công khai). Spotify/Apple Music… dùng DRM nên không có ở đây.
ONLINE_HOSTS = re.compile(r"(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com)$")
SITES = {"yt": ("ytsearch", "YouTube"), "sc": ("scsearch", "SoundCloud")}
STREAM_CACHE = config.DATA / "cache" / "nghe-online"
STREAM_CACHE_MAX = 600 * 1024 * 1024     # bài phải tải tạm (SoundCloud HLS…) giữ tối đa 600 MB, cũ thì xóa
BUILTIN = [{"id": "LL", "title": "Video đã thích", "builtin": True},
           {"id": "WL", "title": "Xem sau", "builtin": True}]


def _local_only(request: Request):
    if request.client and request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Nhạc YouTube online chỉ dùng được khi mở app trên chính máy tính.")


router = APIRouter(prefix="/api/music/yt", dependencies=[Depends(_local_only)])
_lists: dict[str, dict] = {}      # id → {at, data}
_streams: dict[str, dict] = {}    # video id → {url, headers, exp}
_lock = threading.Lock()


# ------------------------------------------------------------------ yt-dlp
def _ydl_info(url: str, _process: bool = True, _warn: list | None = None, **extra) -> dict:
    cfg = config.load()
    log = downloader._Logger()
    if _warn is not None:
        log.warnings = _warn          # người gọi đọc cảnh báo của yt-dlp (vd. cookie hết hạn)
    opts = {**downloader._base_opts(cfg), "logger": log, "skip_download": True,
            "extractor_args": {"youtubetab": {"skip": ["authcheck"]}}, **extra}
    with downloader._account(cfg, url, f"yt-{time.time_ns()}") as acc, yt_dlp.YoutubeDL({**opts, **acc}) as ydl:
        try:
            info = ydl.extract_info(url, download=False, process=_process)
        except yt_dlp.utils.DownloadError as e:
            raise HTTPException(502, _nice(log.errors[-1] if log.errors else downloader.clean(str(e)))) from e
        info = ydl.sanitize_info(info) if info else None
    if not info:
        raise HTTPException(502, _nice(log.errors[-1] if log.errors else "YouTube không trả về dữ liệu."))
    return info


def _nice(msg: str) -> str:
    m = msg.lower()
    if "unable to connect" in m or "timed out" in m or "connection" in m or "getaddrinfo" in m:
        return "Không kết nối được YouTube. Kiểm tra mạng rồi thử lại."
    if "sign in" in m or "login" in m or "cookies" in m:
        return "YouTube yêu cầu đăng nhập. Bấm Đăng nhập YouTube rồi thử lại."
    if "private" in m:
        return "Playlist/video này để riêng tư. Đăng nhập đúng tài khoản sở hữu rồi thử lại."
    if "does not exist" in m or "unavailable" in m:
        return "Không tìm thấy playlist/video (đã xóa, riêng tư hoặc link sai)."
    return msg[:300]


def _thumb(e: dict) -> str | None:
    if e.get("thumbnail"):
        return e["thumbnail"]
    th = [t for t in (e.get("thumbnails") or []) if t.get("url")]
    if not th:
        return f"https://i.ytimg.com/vi/{e['id']}/mqdefault.jpg" if VID.match(str(e.get("id") or "")) else None
    best = min(th, key=lambda t: abs((t.get("width") or 320) - 320))
    return best["url"]


def _local_map() -> dict[str, int]:
    """Bài đã tải về máy: tên file có [id YouTube] → id bài trong thư viện nhạc."""
    out = {}
    for r in db.query("SELECT id, path FROM tracks"):
        m = re.search(r"\[([\w-]{3,40})\]\.\w+$", r["path"] or "")
        if m:
            out.setdefault(m.group(1), r["id"])
    return out


def _site(e: dict) -> str:
    k = (e.get("ie_key") or e.get("extractor_key") or e.get("extractor") or "").lower()
    if k.startswith("youtube") or VID.match(str(e.get("id") or "")) and "soundcloud" not in k and "bandcamp" not in k:
        return "YouTube"
    return "SoundCloud" if "soundcloud" in k else "Bandcamp" if "bandcamp" in k else (k.title() or "Online")


def _entry(e: dict) -> dict | None:
    """Một bài trong danh sách online → {ou: link nghe, yt?: id YouTube, id, title, artist, duration, thumb, site}."""
    eid = str(e.get("id") or "")
    title = e.get("title") or ""
    if title in ("[Private video]", "[Deleted video]"):
        return None
    site = _site(e)
    if site == "YouTube":
        if not VID.match(eid):
            return None
        return {"yt": eid, "id": eid, "ou": f"https://www.youtube.com/watch?v={eid}", "site": site, "title": title or eid,
                "artist": e.get("channel") or e.get("uploader") or "", "duration": e.get("duration"), "thumb": _thumb(e)}
    url = e.get("webpage_url") or e.get("original_url") or e.get("url") or ""
    if not url.startswith("http") or not ONLINE_HOSTS.search((urlparse(url).hostname or "").lower()):
        return None
    return {"id": eid, "ou": url, "site": site, "title": title or url.rsplit("/", 1)[-1].replace("-", " "),
            "artist": e.get("uploader") or e.get("artist") or e.get("channel") or "", "duration": e.get("duration"),
            "thumb": _thumb(e) if (e.get("thumbnail") or e.get("thumbnails")) else None}


def _flatten(info: dict, depth: int = 0) -> list[dict]:
    out = []
    for e in info.get("entries") or []:
        if not e:
            continue
        if e.get("_type") == "playlist" and depth < 2:
            out += _flatten(e, depth + 1)
        else:
            out.append(e)
    return out


# ------------------------------------------------------------------ trạng thái + playlist của tôi
def _read_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_cache(c: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
    tmp.replace(CACHE_PATH)


def fetch_my_playlists() -> list[dict]:
    """Trang "Playlist" của tài khoản (feed/playlists); không đọc được thì thử trang "Bạn" (feed/library)."""
    found: dict[str, dict] = {}
    last_err = None
    for url in ("https://www.youtube.com/feed/playlists", "https://www.youtube.com/feed/library"):
        try:
            info = _ydl_info(url, extract_flat=True, playlistend=500)
        except HTTPException as e:
            last_err = e
            continue
        for e in _flatten(info):
            pid = e.get("id") if e.get("ie_key") == "YoutubeTab" or "list=" in str(e.get("url") or "") else None
            if not pid and "list=" in str(e.get("url") or ""):
                pid = parse_qs(urlparse(e["url"]).query).get("list", [None])[0]
            if not pid or not LIST.match(pid) or pid in found or pid in ("LL", "WL"):
                continue
            found[pid] = {"id": pid, "title": e.get("title") or pid, "thumb": _thumb(e) if e.get("thumbnails") else None,
                          "owner": e.get("channel") or e.get("uploader")}
        if found:
            break
    if not found and last_err:
        raise last_err
    return list(found.values())


@router.get("/status")
def status():
    c = _read_cache()
    return {"logged_in": downloader.youtube_logged_in(), "at": c.get("at"), "saved": c.get("saved", [])}


@router.get("/playlists")
def my_playlists(refresh: bool = False):
    c = _read_cache()
    logged = downloader.youtube_logged_in()
    if logged and (refresh or not c.get("items") or c.get("at", 0) < time.time() - 6 * 3600):
        try:
            c.update(items=fetch_my_playlists(), at=time.time(), error=None)
        except HTTPException as e:
            if refresh or not c.get("items"):
                c["error"] = e.detail
        _write_cache(c)
    return {"logged_in": logged, "items": (BUILTIN + c.get("items", [])) if logged else [],
            "saved": c.get("saved", []), "at": c.get("at"), "error": c.get("error") if logged else None}


def _norm(url_or_id: str) -> tuple[str, str]:
    """Link (youtube.com / music.youtube.com / youtu.be) hoặc id playlist → (khóa, link cho yt-dlp)."""
    s = (url_or_id or "").strip()
    if s.startswith("v:") and VID.match(s[2:]):
        return s, f"https://www.youtube.com/watch?v={s[2:]}"
    if LIST.match(s) and not s.startswith("http"):
        return s, f"https://www.youtube.com/playlist?list={s}"
    if s.startswith("u:"):
        s = s[2:]
    u = urlparse(s if "://" in s else "https://" + s)
    host = (u.hostname or "").lower()
    if host.endswith(("soundcloud.com", "bandcamp.com")):
        url = f"https://{host}{u.path.rstrip('/')}" + (f"?{u.query}" if "secret_token" in u.query else "")
        return "u:" + url, url
    if not (host.endswith("youtube.com") or host == "youtu.be"):
        raise HTTPException(400, "Cần link YouTube, YouTube Music, SoundCloud hoặc Bandcamp (bài hát hoặc playlist).")
    q = parse_qs(u.query)
    lid = (q.get("list") or [None])[0]
    if lid and LIST.match(lid):
        if lid.startswith("RD"):          # danh sách kết hợp (Mix) chỉ mở được qua link xem video
            v = (q.get("v") or [""])[0]
            return lid, f"https://www.youtube.com/watch?v={v}&list={lid}" if VID.match(v) else s
        return lid, f"https://www.youtube.com/playlist?list={lid}"
    vid = (q.get("v") or [None])[0] or (u.path.strip("/") if host == "youtu.be" else None)
    if vid and VID.match(vid):
        return "v:" + vid, f"https://www.youtube.com/watch?v={vid}"
    raise HTTPException(400, "Link này không có bài hát hay playlist nào.")


@router.get("/list")
def open_list(src: str, refresh: bool = False, save: bool = False):
    key, url = _norm(src)
    hit = _lists.get(key)
    if hit and not refresh and hit["at"] > time.time() - LIST_TTL:
        data = hit["data"]
    else:
        if key.startswith("u:"):      # SoundCloud / Bandcamp: danh sách dạng phẳng không có tên bài → đọc đủ (tối đa 200 bài)
            info = _ydl_info(url, playlistend=200, ignoreerrors=True, format="bestaudio/best")
        else:
            info = _ydl_info(url, extract_flat="in_playlist", playlistend=3000, noplaylist=key.startswith("v:"))
        items = _flatten(info) if info.get("_type") == "playlist" else [info]
        entries = [x for x in (_entry(e) for e in items) if x]
        title = {"LL": "Video đã thích", "WL": "Xem sau"}.get(key) or info.get("title") or key
        data = {"key": key, "title": title, "owner": info.get("channel") or info.get("uploader"),
                "url": url, "entries": entries}
        _lists[key] = {"at": time.time(), "data": data}
    local = _local_map()
    out = {**data, "entries": [{**e, "local": local.get(e.get("id") or e.get("yt"))} for e in data["entries"]]}
    out["local_count"] = sum(1 for e in out["entries"] if e["local"])
    if save and not key.startswith("v:"):
        c = _read_cache()
        saved = [s for s in c.get("saved", []) if s["id"] != key]
        c["saved"] = [{"id": key, "title": data["title"]}] + saved[:29]
        _write_cache(c)
    return out


@router.get("/search")
def search(q: str, site: str = "yt"):
    q = (q or "").strip()[:200]
    if not q:
        raise HTTPException(400, "Gõ tên bài hát hoặc ca sĩ.")
    prefix, name = SITES.get(site, SITES["yt"])
    info = _ydl_info(f"{prefix}30:{q}", extract_flat=True)
    entries = [x for x in (_entry(e) for e in _flatten(info)) if x]
    local = _local_map()
    entries = [{**e, "local": local.get(e.get("id"))} for e in entries]
    return {"key": "@search", "title": f"Tìm “{q}” trên {name}", "owner": None, "url": None, "search": True,
            "entries": entries, "local_count": sum(1 for e in entries if e["local"])}


@router.delete("/saved/{key}")
def forget(key: str):
    c = _read_cache()
    c["saved"] = [s for s in c.get("saved", []) if s["id"] != key]
    _write_cache(c)
    return {"saved": c["saved"]}


# ------------------------------------------------------------------ nghe trực tiếp
# Luồng HTTP (YouTube, phần lớn SoundCloud/Bandcamp): chuyển tiếp theo Range, mỗi lần 4 MB.
# Chỉ có HLS (một số bài SoundCloud): tải tạm bài đó vào DATA/cache/nghe-online rồi phát file (vẫn tua được).
# Bài mã hóa (HLS-AES, DRM) thì không nghe: không vượt bảo vệ bản quyền.
NO_DRM = "[format_id!*=aes][format_id!*=ctr][format_id!*=cbc]"
FMT_HTTP = (f"bestaudio[ext=m4a][protocol^=http]{NO_DRM}/bestaudio[protocol^=http]{NO_DRM}/best[protocol^=http]{NO_DRM}")
FMT_ANY = f"bestaudio{NO_DRM}/best{NO_DRM}"


def _check_url(u: str) -> str:
    u = (u or "").strip()
    host = (urlparse(u).hostname or "").lower()
    if not u.startswith("https://") or not ONLINE_HOSTS.search(host):
        raise HTTPException(400, "Chỉ nghe online được từ YouTube, SoundCloud, Bandcamp.")
    return u


def _key(u: str) -> str:
    m = re.search(r"(?:v=|youtu\.be/)([\w-]{11})", u)
    if m and "youtu" in u:
        return "yt-" + m.group(1)
    import hashlib
    return "u-" + hashlib.sha1(u.encode()).hexdigest()[:20]


def _trim_cache() -> None:
    try:
        files = sorted((f for f in STREAM_CACHE.iterdir() if f.is_file()), key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return
    total = 0
    for f in files:
        total += f.stat().st_size
        if total > STREAM_CACHE_MAX:
            f.unlink(missing_ok=True)


def _cache_file(u: str, key: str) -> dict:
    for f in STREAM_CACHE.glob(key + ".*"):
        if f.suffix not in (".part", ".ytdl", ".tmp"):
            f.touch()
            return {"file": str(f)}
    STREAM_CACHE.mkdir(parents=True, exist_ok=True)
    cfg = config.load()
    log = downloader._Logger()
    opts = {**downloader._base_opts(cfg), "logger": log, "format": FMT_ANY, "noplaylist": True,
            "outtmpl": str(STREAM_CACHE / (key + ".%(ext)s")), "overwrites": True, "noprogress": True}
    with downloader._account(cfg, u, f"nghe-{time.time_ns()}") as acc, yt_dlp.YoutubeDL({**opts, **acc}) as ydl:
        try:
            info = ydl.extract_info(u, download=True)
        except yt_dlp.utils.DownloadError as e:
            raise HTTPException(502, _nice(log.errors[-1] if log.errors else downloader.clean(str(e)))) from e
    path = (info.get("requested_downloads") or [{}])[0].get("filepath") or ""
    if not path:
        hits = [f for f in STREAM_CACHE.glob(key + ".*") if f.suffix not in (".part", ".ytdl")]
        path = str(hits[0]) if hits else ""
    if not path:
        raise HTTPException(502, "Không mở được bài này.")
    _trim_cache()
    return {"file": path, "title": info.get("title"), "artist": info.get("uploader") or info.get("channel"),
            "duration": info.get("duration"), "preview": "preview" in str(info.get("format_id") or "")}


def info_meta(info: dict) -> dict:
    return {k: v for k, v in {"title": info.get("title"), "artist": info.get("channel") or info.get("uploader"),
                              "duration": info.get("duration")}.items() if v}


def _probe(s: dict) -> int:
    try:
        r = _get(s, 0, 1, timeout=12)
        r.close()
        return r.status_code
    except requests.RequestException:
        return 0


def _resolve(u: str, force: bool = False, no_direct: bool = False) -> dict:
    key = _key(u)
    with _lock:
        s = _streams.get(key)
        if s and not force and s["exp"] > time.time():
            return s
    if no_direct:                                      # luồng trực tiếp đã hỏng giữa chừng → tải tạm
        with _lock:
            old = _streams.get(key) or {}
        s = {**{k: old[k] for k in ("title", "artist", "duration") if old.get(k)}, **_cache_file(u, key),
             "exp": time.time() + 12 * 3600}
        with _lock:
            _streams[key] = s
        return s
    try:
        info = _ydl_info(u, noplaylist=True, format=FMT_HTTP)
        direct = bool(info.get("url")) and str(info.get("protocol", "https")).startswith("http")
    except HTTPException as e:
        if "format" not in str(e.detail).lower():
            raise
        info, direct = {}, False
    s = None
    if direct:
        exp = parse_qs(urlparse(info["url"]).query).get("expire", [None])[0]
        exp = int(exp) - 120 if exp and exp.isdigit() else time.time() + 3 * 3600
        s = {"url": info["url"], "headers": {k: v for k, v in (info.get("http_headers") or {}).items() if k.lower() != "range"},
             "exp": min(exp, time.time() + 5 * 3600), "title": info.get("title"),
             "artist": info.get("channel") or info.get("uploader"), "duration": info.get("duration"), "ext": info.get("ext"),
             "preview": "preview" in str(info.get("format_id") or "")}
        # Link lấy được chưa chắc phát được (YouTube đổi cách bảo vệ luồng, link gắn với ứng dụng khách…) →
        # hỏi thử vài byte; bị từ chối thì để yt-dlp tự tải tạm cả bài như với SoundCloud HLS.
        code = _probe(s)
        if code not in (200, 206):
            _log.warning("Link nghe online bị từ chối (mã %s), tải tạm cả bài: %s", code, u)
            s = None
    if s is None:
        try:
            s = {**info_meta(info), **_cache_file(u, key), "exp": time.time() + 12 * 3600}
        except HTTPException as e:
            if "format" in str(e.detail).lower():
                raise HTTPException(502, "Bài này được mã hóa bảo vệ bản quyền hoặc không có luồng âm thanh, không nghe được.") from e
            raise
    with _lock:
        _streams[key] = s
        for k in [k for k, v in _streams.items() if v["exp"] < time.time()]:
            _streams.pop(k, None)
    return s


def _prepare(u: str) -> dict:
    s = _resolve(_check_url(u))
    return {"ok": True, "title": s.get("title"), "artist": s.get("artist"), "duration": s.get("duration"),
            "preview": s.get("preview", False)}


@router.post("/prepare")
def prepare_url(u: str):
    return _prepare(u)


@router.get("/stream")
def stream_url(u: str, request: Request):
    return _stream(_check_url(u), request)


@router.post("/{vid}/prepare")
def prepare(vid: str):
    if not VID.match(vid):
        raise HTTPException(400, "Mã video không hợp lệ.")
    return _prepare(f"https://www.youtube.com/watch?v={vid}")


@router.get("/{vid}/stream")
def stream(vid: str, request: Request):
    if not VID.match(vid):
        raise HTTPException(400, "Mã video không hợp lệ.")
    return _stream(f"https://www.youtube.com/watch?v={vid}", request)


def _get(s: dict, start: int, end: int | None, timeout: int = 30):
    return requests.get(s["url"], headers={**s["headers"], "Range": f"bytes={start}-{'' if end is None else end}"},
                        stream=True, timeout=timeout)


_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def _stream(u: str, request: Request):
    from fastapi.responses import FileResponse
    s = _resolve(u)
    if s.get("file"):
        import mimetypes
        if not os.path.exists(s["file"]):
            s = _resolve(u, force=True)
        mime = {".opus": "audio/ogg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".webm": "audio/webm",
                ".mp4": "audio/mp4", ".aac": "audio/aac"}.get(
            os.path.splitext(s["file"])[1].lower()) or mimetypes.guess_type(s["file"])[0] or "audio/mpeg"
        return FileResponse(s["file"], media_type=mime, headers={"Cache-Control": "no-store"})
    m = _RANGE.match(request.headers.get("range", "") or "")
    start = int(m.group(1)) if m and m.group(1) else 0
    want_end = int(m.group(2)) if m and m.group(2) else None
    r = _get(s, start, start + CHUNK - 1 if want_end is None else min(want_end, start + CHUNK - 1))
    if r.status_code in (403, 410):                         # link hết hạn → lấy lại
        r.close()
        s = _resolve(u, force=True)
        if s.get("file"):
            return _stream(u, request)
        r = _get(s, start, start + CHUNK - 1 if want_end is None else min(want_end, start + CHUNK - 1))
        if r.status_code in (403, 410):                     # link mới vẫn bị từ chối → tải tạm cả bài rồi phát file
            r.close()
            _resolve(u, no_direct=True)
            return _stream(u, request)
    if r.status_code == 416:
        r.close()
        raise HTTPException(416, "Vượt quá cuối bài.")
    if r.status_code not in (200, 206):
        r.close()
        raise HTTPException(502, f"Trang nguồn từ chối phát bài này (mã {r.status_code}).")
    cr = re.search(r"/(\d+)", r.headers.get("content-range", ""))
    total = int(cr.group(1)) if cr else int(r.headers.get("content-length") or 0) + (start if r.status_code == 206 else 0)
    if r.status_code == 200:                                 # máy chủ bỏ qua Range: trả cả file từ đầu
        start = 0
    end = total - 1 if want_end is None or want_end >= total else want_end
    mime = r.headers.get("content-type") or ("audio/mp4" if s.get("ext") == "m4a" else "audio/webm")
    if mime.startswith("video/"):
        mime = "audio/" + mime.split("/", 1)[1]

    def gen(r=r, src=s):
        pos = start
        try:
            while True:
                for chunk in r.iter_content(64 * 1024):
                    if pos > end:
                        break
                    chunk = chunk[: end - pos + 1]
                    pos += len(chunk)
                    yield chunk
                r.close()
                if pos > end or not total:
                    return
                r = _get(src, pos, min(end, pos + CHUNK - 1))
                if r.status_code in (403, 410):              # link hết hạn giữa bài → lấy link mới, phát tiếp
                    r.close()
                    try:
                        s2 = _resolve(u, force=True)
                    except HTTPException:
                        return
                    if s2.get("file"):
                        return
                    src = s2
                    r = _get(src, pos, min(end, pos + CHUNK - 1))
                if r.status_code not in (200, 206):
                    return
        finally:
            r.close()

    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1), "Cache-Control": "no-store"}
    if m:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(gen(), status_code=206 if m else 200, media_type=mime, headers=headers)


# ------------------------------------------------------------------ lấy đăng nhập YouTube từ trình duyệt khác
# Google hay chặn đăng nhập trong trình duyệt nhúng ("This browser or app may not be secure"). Cách thay thế: người dùng
# đã đăng nhập YouTube trong Firefox/Chrome/Edge… thì lấy cookie YouTube/Google từ trình duyệt đó (yt-dlp đọc), hoặc nhập
# file cookies.txt xuất bằng tiện ích trình duyệt. Chỉ giữ cookie của youtube.com / google.com, ghi vào DATA/youtube-cookies.txt.
acct = APIRouter(prefix="/api/youtube", dependencies=[Depends(_local_only)])
BROWSERS = ("firefox", "chrome", "edge", "brave", "opera", "vivaldi", "chromium")
_KEEP = re.compile(r"(^|\.)(youtube\.com|google\.com)$")
_LOGIN = {"SAPISID", "__Secure-3PAPISID", "LOGIN_INFO"}


def _account_key(text: str) -> str:
    """Giá trị SAPISID / LOGIN_INFO: đổi khi đổi tài khoản (để biết có cần lấy lại danh sách playlist không)."""
    keys = [ln.split("\t")[6] for ln in text.splitlines()
            if ln.count("\t") >= 6 and ln.split("\t")[5] in ("SAPISID", "LOGIN_INFO")]
    return "|".join(sorted(keys))


def _save_jar(jar, source: str) -> dict:
    from yt_dlp.cookies import YoutubeDLCookieJar
    try:
        before = _account_key(config.YT_COOKIES.read_text(encoding="utf-8", errors="ignore"))
    except OSError:
        before = ""
    out = YoutubeDLCookieJar()
    n = 0
    for c in jar:
        if _KEEP.search(c.domain.lstrip(".")):
            out.set_cookie(c)
            n += 1
    if not any(c.name in _LOGIN and c.domain.lstrip(".").endswith("youtube.com") for c in out):
        raise HTTPException(400, f"Không thấy tài khoản YouTube đã đăng nhập trong {source}.")
    tmp = config.YT_COOKIES.with_suffix(".tmp")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    out.save(str(tmp))
    tmp.replace(config.YT_COOKIES)
    try:                                          # bản riêng của trình duyệt (cửa sổ app có thể ghi đè file chính)
        shutil.copyfile(config.YT_COOKIES, config.YT_COOKIES_BROWSER)
    except OSError:
        pass
    changed = _account_key(config.YT_COOKIES.read_text(encoding="utf-8", errors="ignore")) != before
    if changed:                                   # tài khoản khác → lấy lại playlist
        try:
            c = _read_cache()
            c.pop("items", None)
            c["at"] = 0
            _write_cache(c)
        except OSError:
            pass
    return {"ok": True, "count": n, "logged_in": downloader.youtube_logged_in(), "account_changed": changed}


@acct.post("/import")
def import_browser(body: dict):
    browser = str(body.get("browser") or "").lower()
    if browser not in BROWSERS:
        raise HTTPException(400, "Chọn trình duyệt.")
    from yt_dlp.cookies import extract_cookies_from_browser
    log = downloader._Logger()
    try:
        jar = extract_cookies_from_browser(browser, logger=log)
    except Exception as e:  # noqa: BLE001 – lỗi của yt-dlp rất đa dạng (không thấy hồ sơ, file bị khóa…)
        msg = downloader.clean(str(e))
        low = msg.lower()
        if "could not find" in low or "not found" in low:
            raise HTTPException(400, f"Không thấy {browser.title()} trên máy này.") from e
        if "copy" in low or "lock" in low or "permission" in low:
            raise HTTPException(400, f"{browser.title()} đang mở nên khóa file cookie. Tắt hẳn {browser.title()} rồi bấm lại.") from e
        raise HTTPException(400, f"Không đọc được cookie của {browser.title()}: {msg[:200]}") from e
    try:
        return _save_jar(jar, browser.title())
    except HTTPException as e:
        if browser != "firefox":
            e.detail += (f" Nếu bạn chắc chắn đã đăng nhập YouTube trên {browser.title()}: bản {browser.title()} mới mã hóa cookie"
                         " nên app không đọc được – dùng Firefox, hoặc cách nhập file cookies.txt.")
        else:
            e.detail += " Mở youtube.com trong Firefox, đăng nhập, rồi bấm lại."
        raise


@acct.get("/hello")
def hello():
    """Tiện ích trình duyệt dùng để tìm cổng của app."""
    return {"app": "CircleVault", "version": config.VERSION}


EXT_SRC = config.Path(__file__).resolve().parent.parent / "extension"
EXT_DIR = config.DATA / "tien-ich-trinh-duyet"


@acct.post("/extension")
def extension_folder(open_folder: bool = True):
    """Chép tiện ích ra thư mục cố định trong DATA (cập nhật app không đổi đường dẫn) rồi mở thư mục đó."""
    import shutil
    if not EXT_SRC.is_dir():
        raise HTTPException(500, "Bản cài thiếu thư mục tiện ích. Cài lại app.")
    EXT_DIR.mkdir(parents=True, exist_ok=True)
    for f in EXT_SRC.iterdir():
        if f.is_file():
            shutil.copy2(f, EXT_DIR / f.name)
    if open_folder and os.name == "nt":
        os.startfile(str(EXT_DIR))  # noqa: S606 – mở File Explorer cho người dùng
    return {"path": str(EXT_DIR)}


@acct.post("/import-file")
async def import_file(request: Request):
    import http.cookiejar
    import io
    from yt_dlp.cookies import YoutubeDLCookieJar
    # Bắt buộc header riêng: trang web lạ không gửi được header này tới 127.0.0.1 (trình duyệt chặn vì CORS),
    # nên không thể âm thầm thay tài khoản YouTube của app.
    if request.headers.get("x-circlevault") != "1":
        raise HTTPException(403, "Thiếu header X-CircleVault.")
    raw = (await request.body())[: 4 * 1024 * 1024].decode("utf-8", "replace")
    if not re.match(r"#( Netscape)? HTTP Cookie File", raw.lstrip("\ufeff")):
        raw = "# Netscape HTTP Cookie File\n" + raw.lstrip("\ufeff")
    jar = YoutubeDLCookieJar()
    try:
        jar.load(io.StringIO(raw))
    except (http.cookiejar.LoadError, ValueError) as e:
        raise HTTPException(400, "File không đúng định dạng cookies.txt (Netscape).") from e
    src = "trình duyệt (tiện ích CircleVault)" if request.query_params.get("source") == "extension" else "file cookies.txt"
    return _save_jar(jar, src)
