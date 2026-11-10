"""Nhạc online từ YouTube cho tab Nghe Nhạc: playlist của tài khoản đã đăng nhập trong app, mở playlist bằng link,
nghe trực tiếp không cần tải (backend lấy link luồng âm thanh bằng yt-dlp rồi chuyển tiếp, hỗ trợ tua), bài nào đã tải
về máy thì phát file trên máy.

Chỉ nhận yêu cầu từ chính máy này: các lệnh ở đây dùng cookie tài khoản YouTube của người dùng.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlparse

import requests
import yt_dlp
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from . import config, db, downloader

CHUNK = 4 * 1024 * 1024          # mỗi lần hỏi googlevideo 4 MB (yêu cầu quá lớn dễ bị bóp tốc độ)
LIST_TTL = 10 * 60               # nhớ danh sách bài của playlist 10 phút
CACHE_PATH = config.DATA / "yt-playlists.json"
VID = re.compile(r"^[\w-]{11}$")
LIST = re.compile(r"^[\w-]{2,80}$")
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
def _ydl_info(url: str, **extra) -> dict:
    cfg = config.load()
    log = downloader._Logger()
    opts = {**downloader._base_opts(cfg), "logger": log, "skip_download": True,
            "extractor_args": {"youtubetab": {"skip": ["authcheck"]}}, **extra}
    with downloader._account(cfg, url, f"yt-{time.time_ns()}") as acc, yt_dlp.YoutubeDL({**opts, **acc}) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
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
        m = re.search(r"\[([\w-]{11})\]\.\w+$", r["path"] or "")
        if m:
            out.setdefault(m.group(1), r["id"])
    return out


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
    u = urlparse(s if "://" in s else "https://" + s)
    host = (u.hostname or "").lower()
    if not (host.endswith("youtube.com") or host == "youtu.be"):
        raise HTTPException(400, "Cần link YouTube hoặc YouTube Music (bài hát hoặc playlist).")
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
        info = _ydl_info(url, extract_flat="in_playlist", playlistend=3000, noplaylist=key.startswith("v:"))
        items = _flatten(info) if info.get("_type") == "playlist" else [info]
        entries = []
        for e in items:
            vid = str(e.get("id") or "")
            if not VID.match(vid):
                continue
            title = e.get("title") or vid
            if title in ("[Private video]", "[Deleted video]"):
                continue
            entries.append({"yt": vid, "title": title, "artist": e.get("channel") or e.get("uploader") or "",
                            "duration": e.get("duration"), "thumb": _thumb(e)})
        title = {"LL": "Video đã thích", "WL": "Xem sau"}.get(key) or info.get("title") or key
        data = {"key": key, "title": title, "owner": info.get("channel") or info.get("uploader"),
                "url": url, "entries": entries}
        _lists[key] = {"at": time.time(), "data": data}
    local = _local_map()
    out = {**data, "entries": [{**e, "local": local.get(e["yt"])} for e in data["entries"]]}
    out["local_count"] = sum(1 for e in out["entries"] if e["local"])
    if save and not key.startswith("v:"):
        c = _read_cache()
        saved = [s for s in c.get("saved", []) if s["id"] != key]
        c["saved"] = [{"id": key, "title": data["title"]}] + saved[:29]
        _write_cache(c)
    return out


@router.delete("/saved/{key}")
def forget(key: str):
    c = _read_cache()
    c["saved"] = [s for s in c.get("saved", []) if s["id"] != key]
    _write_cache(c)
    return {"saved": c["saved"]}


# ------------------------------------------------------------------ nghe trực tiếp
def _resolve(vid: str, force: bool = False) -> dict:
    with _lock:
        s = _streams.get(vid)
        if s and not force and s["exp"] > time.time():
            return s
    info = _ydl_info(f"https://www.youtube.com/watch?v={vid}", noplaylist=True,
                     format="bestaudio[ext=m4a][protocol^=http]/bestaudio[protocol^=http]/best[protocol^=http]")
    if not info.get("url") or not str(info.get("protocol", "https")).startswith("http"):
        raise HTTPException(502, "Bài này không có luồng âm thanh nghe trực tiếp được. Thử tải về máy.")
    exp = parse_qs(urlparse(info["url"]).query).get("expire", [None])[0]
    exp = int(exp) - 120 if exp and exp.isdigit() else time.time() + 3 * 3600
    s = {"url": info["url"], "headers": {k: v for k, v in (info.get("http_headers") or {}).items() if k.lower() != "range"},
         "exp": min(exp, time.time() + 5 * 3600), "title": info.get("title"), "artist": info.get("channel") or info.get("uploader"),
         "duration": info.get("duration"), "ext": info.get("ext")}
    with _lock:
        _streams[vid] = s
        for k in [k for k, v in _streams.items() if v["exp"] < time.time()]:
            _streams.pop(k, None)
    return s


@router.post("/{vid}/prepare")
def prepare(vid: str):
    if not VID.match(vid):
        raise HTTPException(400, "Mã video không hợp lệ.")
    s = _resolve(vid)
    return {"ok": True, "title": s["title"], "artist": s["artist"], "duration": s["duration"]}


def _get(s: dict, start: int, end: int | None):
    return requests.get(s["url"], headers={**s["headers"], "Range": f"bytes={start}-{'' if end is None else end}"},
                        stream=True, timeout=30)


_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


@router.get("/{vid}/stream")
def stream(vid: str, request: Request):
    if not VID.match(vid):
        raise HTTPException(400, "Mã video không hợp lệ.")
    m = _RANGE.match(request.headers.get("range", "") or "")
    start = int(m.group(1)) if m and m.group(1) else 0
    want_end = int(m.group(2)) if m and m.group(2) else None
    s = _resolve(vid)
    r = _get(s, start, start + CHUNK - 1 if want_end is None else min(want_end, start + CHUNK - 1))
    if r.status_code in (403, 410):                         # link hết hạn → lấy lại
        r.close()
        s = _resolve(vid, force=True)
        r = _get(s, start, start + CHUNK - 1 if want_end is None else min(want_end, start + CHUNK - 1))
    if r.status_code == 416:
        r.close()
        raise HTTPException(416, "Vượt quá cuối bài.")
    if r.status_code not in (200, 206):
        r.close()
        raise HTTPException(502, f"YouTube từ chối phát bài này (mã {r.status_code}).")
    cr = re.search(r"/(\d+)", r.headers.get("content-range", ""))
    total = int(cr.group(1)) if cr else int(r.headers.get("content-length") or 0) + (start if r.status_code == 206 else 0)
    if r.status_code == 200:                                 # máy chủ bỏ qua Range: trả cả file từ đầu
        start = 0
    end = total - 1 if want_end is None or want_end >= total else want_end
    mime = r.headers.get("content-type") or ("audio/mp4" if s.get("ext") == "m4a" else "audio/webm")

    def gen(r=r):
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
                r = _get(s, pos, min(end, pos + CHUNK - 1))
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
