"""Đọc thẳng dữ liệu YouTube (InnerTube) bằng các hàm có sẵn của yt-dlp, dùng cookie tài khoản trong app.

yt-dlp lấy "đề xuất" qua /feed/recommended (YouTube đã bỏ) nên trang chủ rỗng; ở đây gọi browse FEwhat_to_watch như trang web,
và endpoint `next` của trang xem video (chi tiết + danh sách "video tiếp theo" thật của YouTube). Mọi mục video được đọc bằng
`_extract_lockup_view_model` / `_extract_video` của yt-dlp, nên YouTube đổi giao diện thì cập nhật yt-dlp là theo kịp.
"""
from __future__ import annotations

import contextlib
import json
import re
import time

import yt_dlp

from . import config, downloader

VIDEO_KEYS = ("videoRenderer", "compactVideoRenderer", "gridVideoRenderer", "playlistVideoRenderer", "videoWithContextRenderer")


@contextlib.contextmanager
def _tab(cookiefile=None):
    """IE YoutubeTab đã khởi tạo, dùng cookie tài khoản (bản sao) nếu đã đăng nhập. `cookiefile`: thử bản cookie khác."""
    cfg = config.load()
    log = downloader._Logger()
    opts = {**downloader._base_opts(cfg), "logger": log, "skip_download": True}
    with downloader._account(cfg, "https://www.youtube.com/", f"yi-{time.time_ns()}", cookiefile) as acc, \
            yt_dlp.YoutubeDL({**opts, **acc}) as ydl:
        ie = ydl.get_info_extractor("YoutubeTab")
        ie.initialize()
        yield ie, log


def logged_out(ie, log, data=None, ytcfg=None) -> bool:
    """Gửi cookie đăng nhập nhưng YouTube coi như CHƯA đăng nhập (cookie đã bị Google xoay vòng / hết hiệu lực)."""
    if not getattr(ie, "_passed_auth_cookies", False):
        return False
    if not ie._has_auth_cookies:                       # YouTube xóa LOGIN_INFO trong phản hồi
        return True
    if any("no longer valid" in w for w in log.warnings):
        return True
    ctx = ((data or {}).get("responseContext") or {}).get("mainAppWebResponseContext") or {}
    if ctx.get("loggedOut") is True:
        return True
    return (ytcfg or {}).get("LOGGED_IN") is False


def _walk(node, ie, out: list, conts: list, depth: int = 0) -> None:
    if depth > 60:
        return
    if isinstance(node, dict):
        for k, v in node.items():
            if not isinstance(v, (dict, list)):
                continue
            if k == "lockupViewModel" and isinstance(v, dict):
                if v.get("contentType") in ("LOCKUP_CONTENT_TYPE_PLAYLIST", "LOCKUP_CONTENT_TYPE_PODCAST"):
                    e = _list_lockup(v)          # danh sách kết hợp (Mix) / playlist: tự đọc để có video đầu tiên
                else:
                    try:
                        e = ie._extract_lockup_view_model(v)
                    except Exception:  # noqa: BLE001
                        e = None
                if e:
                    out.append(e)
                continue
            if k in ("radioRenderer", "compactRadioRenderer", "playlistRenderer", "compactPlaylistRenderer", "gridPlaylistRenderer") \
                    and isinstance(v, dict):
                if (e := _list_renderer(v)):
                    out.append(e)
                continue
            if k in VIDEO_KEYS and isinstance(v, dict) and v.get("videoId"):
                try:
                    out.append(ie._extract_video(v))
                except Exception:  # noqa: BLE001
                    pass
                continue
            if k == "continuationItemRenderer" and isinstance(v, dict):
                tok = ie._extract_continuation_ep_data(v.get("continuationEndpoint") or {}) \
                    or ie._extract_continuation_ep_data(((v.get("button") or {}).get("buttonRenderer") or {}).get("command") or {})
                if tok:
                    conts.append(tok)
                continue
            if k in ("richSectionRenderer", "reelShelfRenderer", "shortsLockupViewModel"):   # kệ Shorts/quảng bá: bỏ
                continue
            _walk(v, ie, out, conts, depth + 1)
    elif isinstance(node, list):
        for x in node:
            _walk(x, ie, out, conts, depth + 1)


class Stale(Exception):
    """Mọi bản cookie đăng nhập đều đã hết hiệu lực."""


def _texts(node, key: str = "content", depth: int = 0) -> list:
    out = []
    if depth > 12:
        return out
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key and isinstance(v, str):
                out.append(v)
            elif isinstance(v, (dict, list)):
                out += _texts(v, key, depth + 1)
    elif isinstance(node, list):
        for x in node:
            out += _texts(x, key, depth + 1)
    return out


def _thumb(node) -> str:
    srcs = _find_list(node, "sources") or _find_list(node, "thumbnails") or []
    srcs = [x for x in srcs if isinstance(x, dict) and x.get("url")]
    if not srcs:
        return ""
    best = max(srcs, key=lambda x: (x.get("width") or 0))
    u = best["url"]
    return ("https:" + u) if u.startswith("//") else u


def _find_list(node, key: str, depth: int = 0):
    if depth > 25:
        return None
    if isinstance(node, dict):
        if isinstance(node.get(key), list):
            return node[key]
        for v in node.values():
            if isinstance(v, (dict, list)) and (r := _find_list(v, key, depth + 1)) is not None:
                return r
    elif isinstance(node, list):
        for x in node:
            if (r := _find_list(x, key, depth + 1)) is not None:
                return r
    return None


def _list_lockup(v: dict) -> dict | None:
    """lockupViewModel kiểu playlist: {_type: list, list, first, title, sub, thumb, badge, mix}."""
    lid = v.get("contentId") or ""
    if not re.match(r"^[\w-]{10,64}$", lid):
        return None
    meta = ((v.get("metadata") or {}).get("lockupMetadataViewModel") or {})
    title = ((meta.get("title") or {}).get("content")) or ""
    rows = _texts((meta.get("metadata") or {}))
    we = _find(v.get("rendererContext"), "watchEndpoint") or _find(v, "watchEndpoint") or {}
    img = v.get("contentImage") or {}
    badges = _texts(_find(img, "overlays") or img, "text")
    return {"_type": "list", "list": lid, "first": we.get("videoId") or "", "title": title,
            "sub": " · ".join(dict.fromkeys(r for r in rows if r and r != "•"))[:160],
            "thumb": _thumb(img.get("collectionThumbnailViewModel") or img), "badge": (badges[0] if badges else ""),
            "mix": lid.startswith("RD")}


def _list_renderer(v: dict) -> dict | None:
    """radioRenderer / playlistRenderer (giao diện cũ)."""
    gt = yt_dlp.extractor.youtube._base.YoutubeBaseInfoExtractor._get_text
    lid = v.get("playlistId") or ""
    if not lid:
        return None
    we = _find(v.get("navigationEndpoint"), "watchEndpoint") or {}
    first = we.get("videoId") or ((v.get("videos") or [{}])[0].get("childVideoRenderer") or {}).get("videoId") or ""
    return {"_type": "list", "list": lid, "first": first, "title": gt(v, "title") or "",
            "sub": gt(v, "longBylineText") or gt(v, "shortBylineText") or "", "thumb": _thumb(v.get("thumbnail") or v),
            "badge": gt(v, "videoCountShortText") or gt(v, "videoCountText") or "", "mix": lid.startswith("RD")}


def home(max_pages: int = 3, limit: int = 80) -> tuple[list[dict], str]:
    """Trang chủ (đề xuất) như youtube.com. Trả (danh sách mục yt-dlp, ghi chú chẩn đoán).
    Thử lần lượt các bản cookie (file chính, bản của trình duyệt, bản của cửa sổ app); bản nào còn đăng nhập thì dùng và
    chép đè file chính. Không bản nào còn hiệu lực → Stale."""
    cands = downloader.youtube_cookie_candidates() or [None]
    for path in cands:
        res = _home_with(path, max_pages, limit)
        if res is None:                       # cookie này YouTube coi như chưa đăng nhập → thử bản khác
            continue
        if path is not None and path != cands[0]:
            downloader.promote_cookies(path)
            _cfg_cache.clear()
        return res
    raise Stale("Đăng nhập YouTube trong app đã hết hiệu lực (Google tự làm mới phiên đăng nhập).")


def _home_with(cookiefile, max_pages: int, limit: int = 80):
    with _tab(cookiefile) as (ie, log):
        data, ytcfg = ie._extract_data("https://www.youtube.com/feed/recommended", "FEwhat_to_watch", fatal=True)
        if cookiefile is not None and logged_out(ie, log, data, ytcfg):
            return None
        out, conts = [], []
        _walk(data, ie, out, conts)
        headers = ie.generate_api_headers(ytcfg=ytcfg)
        pages = 1
        while conts and pages < max_pages and len(out) < limit:
            q = conts.pop(0)
            resp = ie._extract_response(item_id="FEwhat_to_watch", query=q, ep="browse", ytcfg=ytcfg, headers=headers,
                                        fatal=False, note="Trang chủ (thêm)")
            if not resp:
                break
            _walk(resp, ie, out, conts)
            pages += 1
        note = ""
        if not out:
            raw = json.dumps(data, ensure_ascii=False)[:400000]
            kinds = sorted(set(re.findall(r'"(\w+(?:Renderer|ViewModel))"', raw)))[:25]
            alerts = re.findall(r'"text":\s*"([^"]{8,200})"', json.dumps(data.get("alerts") or [], ensure_ascii=False))
            note = ("YouTube báo: " + alerts[0]) if alerts else ("Không thấy video trong trang chủ (có: " + ", ".join(kinds[:12]) + ")")
        return out, note


def watch_next(vid: str, plist: str = "") -> dict:
    """Chi tiết video + 'Video tiếp theo' từ endpoint next (như cột phải của trang xem YouTube).
    Có `plist` (Mix / playlist): kèm `queue` = danh sách phát như khung bên phải của YouTube."""
    q = {"videoId": vid, **({"playlistId": plist} if plist else {})}
    with _tab() as (ie, log):
        ytcfg = _ytcfg(ie)
        headers = ie.generate_api_headers(ytcfg=ytcfg)
        data = ie._extract_response(item_id=vid, query=q, ep="next", ytcfg=ytcfg, headers=headers,
                                    note="Trang xem video")
    if not data:
        return {}
    res = (((data.get("contents") or {}).get("twoColumnWatchNextResults") or {}))
    prim = _find(res.get("results"), "videoPrimaryInfoRenderer") or {}
    sec = _find(res.get("results"), "videoSecondaryInfoRenderer") or {}
    gt = yt_dlp.extractor.youtube._base.YoutubeBaseInfoExtractor._get_text
    owner = ((sec.get("owner") or {}).get("videoOwnerRenderer") or {})
    ch_run = ((owner.get("title") or {}).get("runs") or [{}])[0]
    raw = json.dumps(prim, ensure_ascii=False)
    likes = re.search(r'"likeCountIfIndifferentNumber":\s*"(\d+)"', raw) or re.search(r'"likeCount":\s*"?(\d+)', raw)
    views_txt = gt(prim, ("viewCount", "videoViewCountRenderer", "viewCount")) or ""
    with _tab() as (ie, _log):
        out, conts = [], []
        _walk(res.get("secondaryResults"), ie, out, conts)
        queue = _queue(res.get("playlist"), ie) if plist else None
    return {"queue": queue,
        "title": gt(prim, "title") or "", "views": yt_dlp.utils.parse_count(views_txt) if views_txt else None,
        "views_text": views_txt, "date": gt(prim, "dateText") or "",
        "likes": int(likes.group(1)) if likes else None,
        "channel": ch_run.get("text") or gt(owner, "title") or "",
        "channel_id": (((ch_run.get("navigationEndpoint") or {}).get("browseEndpoint") or {}).get("browseId")) or "",
        "subs_text": gt(owner, "subscriberCountText") or "",
        "description": ((sec.get("attributedDescription") or {}).get("content")) or gt(sec, "description") or "",
        "related": out,
    }


def _queue(node, ie) -> dict | None:
    """Khung danh sách phát (playlistPanelRenderer) → {title, owner, index, items}."""
    pl = ((node or {}).get("playlist")) or {}
    if not pl:
        return None
    gt = yt_dlp.extractor.youtube._base.YoutubeBaseInfoExtractor._get_text
    items = []
    for c in pl.get("contents") or []:
        r = (c or {}).get("playlistPanelVideoRenderer")
        if not r or not r.get("videoId"):
            continue
        try:
            e = ie._extract_video(r)
        except Exception:  # noqa: BLE001
            e = {"id": r["videoId"], "title": gt(r, "title")}
        e["channel"] = e.get("channel") or gt(r, "shortBylineText") or gt(r, "longBylineText") or ""
        items.append(e)
    return {"title": gt(pl, "title") or pl.get("title") or "Danh sách phát", "owner": gt(pl, "ownerName") or "",
            "index": pl.get("currentIndex") or 0, "items": items, "mix": bool(pl.get("isInfinite"))}


_cfg_cache: dict = {}


def _ytcfg(ie) -> dict:
    try:                                       # đổi file cookie (đăng nhập mới) thì lấy lại ytcfg
        key = f"web:{config.YT_COOKIES.stat().st_mtime}"
    except OSError:
        key = "web:-"
    hit = _cfg_cache.get(key)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    ytcfg = ie._download_ytcfg("web", "home") or {}
    _cfg_cache.clear()
    _cfg_cache[key] = (time.time(), ytcfg)
    return ytcfg


def _find(node, key: str, depth: int = 0):
    if depth > 40:
        return None
    if isinstance(node, dict):
        if isinstance(node.get(key), dict):
            return node[key]
        for v in node.values():
            if isinstance(v, (dict, list)) and (r := _find(v, key, depth + 1)) is not None:
                return r
    elif isinstance(node, list):
        for x in node:
            if (r := _find(x, key, depth + 1)) is not None:
                return r
    return None
