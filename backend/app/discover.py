"""Khám phá nhạc (tab Nghe Nhạc) – gợi ý kiểu YouTube Music / Spotify, dữ liệu từ YouTube Music (thư viện ytmusicapi):

- "Gợi ý cho bạn": lấy vài bài bạn nghe nhiều / mới tải (tên file có [id YouTube]) làm hạt giống → radio của từng bài
  (danh sách "bài tiếp theo" của YouTube Music) → trộn xen kẽ, bỏ bài đã có trên máy.
- "Mix dành cho bạn": mỗi hạt giống một radio riêng (mở như playlist).
- Trang chủ YouTube Music (khi đã đăng nhập YouTube trong app: dùng cookie tài khoản → gợi ý theo lịch sử nghe của bạn).
- Bảng xếp hạng theo quốc gia (mặc định Việt Nam), ca sĩ thịnh hành, gợi ý từ khóa khi gõ tìm.
- Radio của một bài bất kỳ (nút "≈ Bài tương tự", và tự phát bài tương tự khi hết danh sách).

Chỉ đọc dữ liệu công khai/tài khoản của chính người dùng; nghe qua luồng có sẵn của ytmusic.py (không DRM).
"""
from __future__ import annotations

import json
import re
import threading
import time

from fastapi import APIRouter, Depends, HTTPException

from . import config, db, downloader, ytmusic

router = APIRouter(prefix="/api/music/discover", dependencies=[Depends(ytmusic._local_only)])
CACHE = config.DATA / "cache" / "kham-pha.json"
HOME_TTL = 3 * 3600
RADIO_TTL = 6 * 3600
_lock = threading.Lock()
_yt: dict = {}
_radio: dict[str, dict] = {}
ID_RE = re.compile(r"\[([\w-]{11})\]\.\w+$")
MOODS = ["Nhạc trẻ hot", "Nhạc chill", "Lofi học bài", "Ballad buồn", "Rap Việt", "Bolero", "US-UK hits", "K-Pop", "Nhạc Hoa",
         "EDM", "Acoustic", "Nhạc tập gym", "Nhạc ngủ ngon", "Nhạc không lời"]


def _client(auth: bool = True):
    """YTMusic dùng cookie YouTube của app nếu đã đăng nhập (gợi ý theo tài khoản), không thì ẩn danh."""
    try:
        from ytmusicapi import YTMusic
    except ImportError as e:
        raise HTTPException(500, "Thiếu thư viện ytmusicapi. Cập nhật app hoặc chạy pip install -r requirements.txt.") from e
    key = "auth" if auth and downloader.youtube_logged_in() else "anon"
    try:
        mtime = config.YT_COOKIES.stat().st_mtime if key == "auth" else 0
    except OSError:
        key, mtime = "anon", 0
    hit = _yt.get(key)
    if hit and hit[0] == mtime:
        return hit[1]
    yt = None
    if key == "auth":
        try:
            from ytmusicapi.helpers import initialize_headers
            jar = {}
            for line in config.YT_COOKIES.read_text(encoding="utf-8", errors="ignore").splitlines():
                p = line.split("\t")
                if len(p) >= 7 and ("youtube.com" in p[0]) and not line.startswith("# "):
                    jar[p[5]] = p[6]
            if "__Secure-3PAPISID" in jar or "SAPISID" in jar:
                jar.setdefault("__Secure-3PAPISID", jar.get("SAPISID", ""))
                h = dict(initialize_headers())
                h.update({"cookie": "; ".join(f"{k}={v}" for k, v in jar.items()), "x-goog-authuser": "0",
                          "authorization": "SAPISIDHASH 0_0", "origin": "https://music.youtube.com"})
                yt = YTMusic(auth=h, location=_country())
        except Exception:
            yt = None
    if yt is None:
        yt = YTMusic(location=_country())
        key = "anon"
    _yt[key] = (mtime, yt)
    return yt


def _country() -> str:
    c = str(config.load().get("music_country") or "VN").upper()
    return c if re.fullmatch(r"[A-Z]{2}", c) else "VN"


def _try(fn, *a, **kw):
    """Gọi YouTube Music, lỗi mạng/trả rỗng thoáng qua thì thử lại 2 lần."""
    for i in range(3):
        try:
            return fn(*a, **kw)
        except Exception:
            if i == 2:
                raise
            time.sleep(0.6 * (i + 1))


def _call(fn, *a, **kw):
    try:
        return _try(fn, *a, **kw)
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e).lower()
        if "connect" in msg or "timed out" in msg or "resolve" in msg:
            raise HTTPException(502, "Không kết nối được YouTube Music. Kiểm tra mạng rồi thử lại.") from e
        raise HTTPException(502, f"YouTube Music trả lỗi: {str(e)[:200]}") from e


def _thumb(ths) -> str | None:
    ths = [t for t in (ths or []) if t.get("url")]
    if not ths:
        return None
    best = min(ths, key=lambda t: abs((t.get("width") or 226) - 226))
    return best["url"]


def _secs(s) -> int | None:
    if isinstance(s, (int, float)):
        return int(s)
    if isinstance(s, str) and re.fullmatch(r"\d+(:\d+){1,2}", s):
        n = 0
        for p in s.split(":"):
            n = n * 60 + int(p)
        return n
    return None


def _song(t: dict) -> dict | None:
    vid = t.get("videoId")
    if not vid or not ytmusic.VID.match(vid):
        return None
    artists = ", ".join(a.get("name", "") for a in (t.get("artists") or []) if a.get("name"))
    return {"yt": vid, "id": vid, "ou": f"https://www.youtube.com/watch?v={vid}", "site": "YouTube",
            "title": t.get("title") or vid, "artist": artists, "duration": _secs(t.get("duration_seconds") or t.get("duration") or t.get("length")),
            "thumb": _thumb(t.get("thumbnail") or t.get("thumbnails")) or f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"}


def _mark(entries: list[dict]) -> list[dict]:
    local = ytmusic._local_map()
    return [{**e, "local": local.get(e["id"])} for e in entries]


def radio_tracks(vid: str, limit: int = 50) -> list[dict]:
    hit = _radio.get(vid)
    if hit and hit["at"] > time.time() - RADIO_TTL:
        return hit["items"]
    w = _call(_client().get_watch_playlist, vid, radio=True, limit=limit)
    items = [x for x in (_song(t) for t in w.get("tracks") or []) if x]
    _radio[vid] = {"at": time.time(), "items": items}
    return items


@router.get("/radio")
def radio(v: str, title: str = ""):
    if not ytmusic.VID.match(v or ""):
        raise HTTPException(400, "Bài này không có mã YouTube để tìm bài tương tự.")
    items = radio_tracks(v)
    first = next((e for e in items if e["id"] == v), None)
    name = title or (first["title"] if first else v)
    entries = _mark(items)
    return {"key": "@radio:" + v, "title": f"Radio: {name}", "owner": "Bài tương tự trên YouTube Music", "url": f"https://www.youtube.com/watch?v={v}&list=RD{v}",
            "radio": True, "search": True, "entries": entries, "local_count": sum(1 for e in entries if e["local"])}


@router.get("/suggest")
def suggest(q: str):
    q = (q or "").strip()[:100]
    if len(q) < 2:
        return []
    try:
        out = _try(_client(auth=False).get_search_suggestions, q)
    except Exception:
        return []
    return [s for s in out if isinstance(s, str)][:8]


def _seeds(n: int = 4) -> list[dict]:
    """Bài trên máy có id YouTube: nghe nhiều nhất + nghe gần đây + mới tải."""
    rows = db.query("SELECT id, path, title, artist FROM tracks ORDER BY play_count DESC, last_played DESC LIMIT 40")
    rows += db.query("SELECT id, path, title, artist FROM tracks ORDER BY last_played DESC LIMIT 20")
    rows += db.query("SELECT id, path, title, artist FROM tracks ORDER BY added_at DESC LIMIT 20")
    out, seen, artists = [], set(), set()
    for r in rows:
        m = ID_RE.search(r["path"] or "")
        if not m or m.group(1) in seen:
            continue
        a = (r["artist"] or "").casefold()
        if a and a in artists and len(rows) > n * 2:          # mỗi ca sĩ một hạt giống cho đa dạng
            continue
        seen.add(m.group(1))
        artists.add(a)
        out.append({"yt": m.group(1), "title": r["title"] or "", "artist": r["artist"] or ""})
        if len(out) >= n:
            break
    return out


def _home_sections(yt) -> list[dict]:
    out = []
    try:
        home = _try(yt.get_home, limit=6)
    except Exception:
        return out
    for sec in home or []:
        songs, lists = [], []
        for it in sec.get("contents") or []:
            if not it:
                continue
            if it.get("videoId"):
                s = _song(it)
                if s:
                    songs.append(s)
            elif it.get("playlistId"):
                lists.append({"id": it["playlistId"], "title": it.get("title") or "", "sub": it.get("description") or
                              ", ".join(a.get("name", "") for a in (it.get("artists") or []) if isinstance(a, dict)),
                              "thumb": _thumb(it.get("thumbnails"))})
        if songs:
            out.append({"kind": "songs", "title": sec.get("title") or "", "items": songs[:20]})
        elif lists:
            out.append({"kind": "lists", "title": sec.get("title") or "", "items": lists[:12]})
    return out


def _build() -> dict:
    yt = _client()
    seeds = _seeds()
    sections: list[dict] = []
    # gợi ý cho bạn: trộn radio của các hạt giống
    radios = []
    for s in seeds:
        try:
            radios.append([e for e in radio_tracks(s["yt"]) if e["id"] != s["yt"]])
        except HTTPException:
            pass
    local = ytmusic._local_map()
    picks, seen = [], set(local)
    for i in range(50):
        for r in radios:
            if i < len(r) and r[i]["id"] not in seen:
                seen.add(r[i]["id"])
                picks.append(r[i])
    if picks:
        sections.append({"kind": "songs", "id": "picks", "title": "Gợi ý cho bạn", "sub": "Dựa trên bài bạn hay nghe", "items": picks[:40]})
    if seeds:
        sections.append({"kind": "mixes", "id": "mixes", "title": "Mix dành cho bạn", "sub": "Radio từ bài bạn thích",
                         "items": [{**s, "thumb": f"https://i.ytimg.com/vi/{s['yt']}/mqdefault.jpg"} for s in seeds]})
    logged = downloader.youtube_logged_in()
    if logged:
        sections += _home_sections(yt)
    # bảng xếp hạng
    country = _country()
    try:
        ch = _try(_client(auth=False).get_charts, country)
        lists = [{"id": p.get("playlistId"), "title": p.get("title") or "", "thumb": _thumb(p.get("thumbnails")), "sub": "Bảng xếp hạng"}
                 for p in (ch.get("videos") or []) + (ch.get("daily") or []) + (ch.get("weekly") or []) if p.get("playlistId")]
        if lists:
            sections.append({"kind": "lists", "id": "charts", "title": "Bảng xếp hạng", "sub": f"YouTube Music · {country}", "items": lists[:12]})
        artists = [{"name": a.get("title") or "", "browse": a.get("browseId"), "thumb": _thumb(a.get("thumbnails")),
                    "trend": a.get("trend"), "sub": a.get("subscribers")} for a in (ch.get("artists") or [])[:20] if a.get("title")]
        if artists:
            sections.append({"kind": "artists", "id": "artists", "title": "Ca sĩ đang nổi", "sub": f"{country} · tuần này", "items": artists})
    except Exception:
        pass
    if not seeds and not logged:              # chưa có gì để dựa vào: lấy trang chủ ẩn danh
        sections += _home_sections(_client(auth=False))
    sections.append({"kind": "moods", "id": "moods", "title": "Theo tâm trạng & thể loại", "items": MOODS})
    return {"at": time.time(), "country": country, "logged_in": logged, "seeds": seeds, "sections": sections}


@router.get("/home")
def home(refresh: bool = False):
    with _lock:
        data = None
        try:
            data = json.loads(CACHE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        if refresh or not data or data.get("at", 0) < time.time() - HOME_TTL:
            fresh = _build()
            if any(s["kind"] != "moods" for s in fresh["sections"]):        # lấy được gì đó thì mới nhớ lại
                data = fresh
                CACHE.parent.mkdir(parents=True, exist_ok=True)
                CACHE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            elif not data or refresh:
                data = {**fresh, "error": "Không lấy được gợi ý từ YouTube Music (mất mạng hoặc YouTube chặn tạm). Thử lại sau."}
    local = ytmusic._local_map()
    for s in data["sections"]:
        if s["kind"] == "songs":
            s["items"] = [{**e, "local": local.get(e["id"])} for e in s["items"]]
    return data


@router.get("/artist")
def artist(b: str, name: str = ""):
    """Bài nổi bật của ca sĩ (mở như playlist)."""
    if not re.fullmatch(r"[\w-]{5,60}", b or ""):
        raise HTTPException(400, "Mã ca sĩ không đúng.")
    a = _call(_client(auth=False).get_artist, b)
    songs, videos = (a.get("songs") or {}), (a.get("videos") or {})
    items = [x for x in (_song(t) for t in (songs.get("results") or []) + (videos.get("results") or [])) if x]
    items = list({e["id"]: e for e in items}.values())
    pl = songs.get("browseId") or videos.get("browseId")
    if pl and pl.startswith("VL"):
        pl = pl[2:]
    entries = _mark(items)
    return {"key": "@artist:" + b, "title": a.get("name") or name, "owner": "Ca sĩ · YouTube Music", "search": True,
            "url": f"https://www.youtube.com/playlist?list={pl}" if pl and re.fullmatch(r"[\w-]{10,80}", pl) else None,
            "playlist": pl, "entries": entries, "local_count": sum(1 for e in entries if e["local"])}
