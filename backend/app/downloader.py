"""Bọc yt-dlp: phân tích link và tải một tác vụ."""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import yt_dlp
from yt_dlp.postprocessor import PostProcessor
from yt_dlp.utils import DownloadCancelled

from . import config, db, music

ANSI = re.compile(r"\x1b\[[0-9;]*m")
HAS_FFMPEG = shutil.which("ffmpeg") is not None

# Thư mục con + mẫu tên file theo loại nội dung (tên file an toàn cho Windows).
TEMPLATES = {
    "youtube": "YouTube/%(playlist_title,uploader,channel|Khac)s/"
               "%(playlist_index&{:03d} - |)s%(upload_date>%Y-%m-%d)s %(title).150B [%(id)s].%(ext)s",
    "film": "Phim/%(playlist_title,series|Phim le)s/%(title).150B [%(id)s].%(ext)s",
    "other": "Khac/%(extractor_key)s/%(title).150B [%(id)s].%(ext)s",
}


def clean(msg: str) -> str:
    msg = ANSI.sub("", str(msg)).strip()
    msg = re.split(r";? *please report this issue", msg, maxsplit=1, flags=re.I)[0]
    return msg.removeprefix("ERROR: ").removeprefix("WARNING: ").strip()


class _Logger:
    """Thu thập lỗi/cảnh báo để hiện trên giao diện thay vì in ra console."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.skipped = 0
        self.archived_ids: list[str] = []

    def debug(self, msg: str) -> None:
        if "has already been recorded in the archive" in msg:
            self.skipped += 1
            # "[download] <id>: <tên> has already been recorded…" (bài bỏ qua vì đã tải): lấy id để vẫn thêm vào playlist
            m = re.search(r"(?:^|\] )([\w-]{3,40}): .*has already been recorded", ANSI.sub("", msg))
            if m:
                self.archived_ids.append(m.group(1))

    def info(self, msg: str) -> None:
        self.debug(msg)

    def warning(self, msg: str) -> None:
        self.warnings.append(clean(msg))

    def error(self, msg: str) -> None:
        self.errors.append(clean(msg))


def read_archive() -> set[str]:
    try:
        return set(config.ARCHIVE_PATH.read_text(encoding="utf-8").split("\n"))
    except OSError:
        return set()


def _base_opts(cfg: dict) -> dict:
    opts = {"quiet": True, "no_warnings": False, "noprogress": True, "windowsfilenames": True,
            "socket_timeout": 30, "retries": 10, "fragment_retries": 10}
    if cfg.get("cookies_from_browser"):
        opts["cookiesfrombrowser"] = (cfg["cookies_from_browser"],)
    return opts


def youtube_logged_in() -> bool:
    try:
        text = config.YT_COOKIES.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return any(k in text for k in ("\tSAPISID\t", "\t__Secure-3PAPISID\t", "\tLOGIN_INFO\t"))


def youtube_cookie_candidates() -> list:
    """Các file cookie YouTube có đăng nhập: file chính trước, rồi bản riêng của trình duyệt / cửa sổ app (mới nhất trước).
    Bỏ bản trùng nội dung."""
    out, seen = [], set()
    rest = sorted((p for p in (config.YT_COOKIES_BROWSER, config.YT_COOKIES_APP) if p.exists()),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for p in [config.YT_COOKIES, *rest]:
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if not any(k in text for k in ("\tSAPISID\t", "\t__Secure-3PAPISID\t", "\tLOGIN_INFO\t")):
            continue
        key = hash(text)
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def promote_cookies(path) -> None:
    """Bản cookie `path` còn hiệu lực còn file chính thì không: chép đè file chính (mọi chức năng YouTube dùng file chính)."""
    if path == config.YT_COOKIES:
        return
    tmp = config.YT_COOKIES.with_suffix(".promote")
    shutil.copyfile(path, tmp)
    tmp.replace(config.YT_COOKIES)


@contextlib.contextmanager
def _account(cfg: dict, url: str, tag: str, cookiefile=None):
    """Link YouTube + đã đăng nhập trong app → dùng bản sao file cookie (yt-dlp ghi đè cookie khi xong việc,
    dùng bản sao để không đụng file app đang ghi). Không thì dùng cookie trình duyệt nếu người dùng chọn.
    `cookiefile`: thử một bản cookie khác (youtube_cookie_candidates)."""
    is_yt = re.search(r"(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$", urlparse(url).netloc.split(":")[0].lower())
    if is_yt and cfg.get("use_youtube_account", True) and (cookiefile or youtube_logged_in()):
        tmp = config.DATA / "tmp" / f"cookies-{tag}.txt"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cookiefile or config.YT_COOKIES, tmp)
        try:
            yield {"cookiefile": str(tmp), "cookiesfrombrowser": None}
        finally:
            tmp.unlink(missing_ok=True)
    else:
        yield {}


# ---------------------------------------------------------------- analyze
def analyze(url: str, cfg: dict, playlist: bool) -> dict:
    log = _Logger()
    opts = {**_base_opts(cfg), "logger": log, "skip_download": True,
            "extract_flat": "in_playlist", "noplaylist": not playlist}
    with _account(cfg, url, f"an-{time.time_ns()}") as acc, yt_dlp.YoutubeDL({**opts, **acc}) as ydl:
        info = ydl.extract_info(url, download=False)
        info = ydl.sanitize_info(info) if info else None
    if not info:
        raise RuntimeError(log.errors[-1] if log.errors else "Không đọc được link này.")

    archive = read_archive()
    is_pl = info.get("_type") == "playlist"
    entries = [e for e in (info.get("entries") or []) if e] if is_pl else []

    def thumb(i: dict) -> str | None:
        if i.get("thumbnail"):
            return i["thumbnail"]
        th = i.get("thumbnails") or []
        return th[-1].get("url") if th else None

    def arch_id(i: dict) -> str:
        key = (i.get("ie_key") or i.get("extractor_key") or "").lower()
        return f"{key} {i.get('id')}"

    heights = sorted({f["height"] for f in info.get("formats") or [] if f.get("height")}, reverse=True)
    return {
        "title": info.get("title") or url,
        "uploader": info.get("uploader") or info.get("channel"),
        "thumbnail": thumb(info) or next((thumb(e) for e in entries if thumb(e)), None),
        "duration": info.get("duration"),
        "extractor": info.get("extractor_key"),
        "is_playlist": is_pl,
        "count": len(entries) if is_pl else 1,
        "entries": [{"title": e.get("title") or e.get("url"), "duration": e.get("duration"),
                     "have": arch_id(e) in archive} for e in entries[:60]],
        "have_count": sum(arch_id(e) in archive for e in entries) if is_pl else int(arch_id(info) in archive),
        "heights": heights,
        "warnings": log.warnings[-3:],
    }


# ---------------------------------------------------------------- download
def _format_opts(quality: str) -> dict:
    if quality == "audio":
        if not HAS_FFMPEG:
            return {"format": "ba[ext=m4a]/ba/b"}
        return {"format": "ba/b", "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}]}
    sort = ["res", "ext:mp4:m4a"] if quality == "best" else [f"res:{quality}", "ext:mp4:m4a"]
    if not HAS_FFMPEG:  # không có ffmpeg thì chỉ lấy file có sẵn cả hình lẫn tiếng
        return {"format": "b", "format_sort": sort}
    return {"format": "bv*+ba/b", "format_sort": sort, "merge_output_format": "mp4"}


class _RecordItem(PostProcessor):
    """Chạy sau khi file đã nằm đúng chỗ: ghi vào thư viện."""

    def __init__(self, task: dict, disk: dict, on_done: Callable[[], None]):
        super().__init__()
        self.task, self.disk, self.on_done = task, disk, on_done

    def run(self, info):
        path = info.get("filepath")
        if path and os.path.exists(path):
            db.execute("DELETE FROM items WHERE filepath = ?", (os.path.abspath(path),))
            db.add_item(
                task_id=self.task["id"], kind=self.task["kind"],
                title=info.get("title") or Path(path).stem, source_url=info.get("webpage_url"),
                extractor=info.get("extractor_key"), video_id=info.get("id"),
                uploader=info.get("uploader") or info.get("channel"), duration=info.get("duration"),
                height=info.get("height"), filepath=os.path.abspath(path),
                filesize=os.path.getsize(path), thumbnail=info.get("thumbnail"), disk_id=self.disk["id"],
            )
            if music.is_audio(path):          # nhạc tải về hiện ngay ở trang Nghe Nhạc
                music.upsert(path, "library")
            self.on_done()
        return [], info


def run_task(task: dict, disk: dict, cfg: dict, live: dict, should_stop: Callable[[], str | None]) -> dict:
    """Tải một tác vụ (chạy trong thread). Trả về {status, error, ...} để cập nhật DB."""
    log = _Logger()
    tid = task["id"]
    state = {"last_write": 0.0, "done": 0}

    def push(**kw):
        live.update(kw)
        now = time.time()
        if now - state["last_write"] > 1.5:
            state["last_write"] = now
            db.update_task(tid, **{k: v for k, v in live.items()
                                   if k in ("progress", "item_index", "item_count", "current_title", "status")})

    def progress_hook(d):
        reason = should_stop()
        if reason:
            raise DownloadCancelled(reason)
        info = d.get("info_dict") or {}
        idx = info.get("playlist_autonumber") or 1
        count = info.get("n_entries") or info.get("playlist_count") or 1
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                frac = d.get("downloaded_bytes", 0) / total
            elif d.get("fragment_count"):
                frac = (d.get("fragment_index") or 0) / d["fragment_count"]
            else:
                frac = 0
            push(status="running", progress=round(min(1, ((idx - 1) + min(frac, 1)) / count) * 100, 1),
                 speed=d.get("speed"), eta=d.get("eta"), downloaded=d.get("downloaded_bytes"), total=total,
                 item_index=idx, item_count=count, current_title=info.get("title"))
        elif d["status"] == "finished":
            push(speed=None, eta=None)

    def pp_hook(d):
        if d["status"] == "started" and d.get("postprocessor") in (
                "Merger", "FFmpegExtractAudio", "FFmpegEmbedSubtitle", "EmbedThumbnail", "FFmpegMetadata",
                "FFmpegVideoRemuxer"):
            push(status="processing", stage=d["postprocessor"])

    def item_done():
        state["done"] += 1
        live["done_count"] = state["done"]

    root = disk["root"]
    Path(root).mkdir(parents=True, exist_ok=True)
    tmpl = TEMPLATES.get(task["kind"], TEMPLATES["other"])
    if task["quality"] == "audio" and task["kind"] == "youtube":
        tmpl = tmpl.replace("YouTube/", "YouTube Audio/", 1)

    opts = {
        **_base_opts(cfg), **_format_opts(task["quality"]),
        "logger": log, "paths": {"home": root, "temp": os.path.join(root, ".tmp")},
        "outtmpl": tmpl, "noplaylist": not task["playlist"], "ignoreerrors": True,
        "progress_hooks": [progress_hook], "postprocessor_hooks": [pp_hook],
        "continuedl": True, "concurrent_fragment_downloads": 4,
    }
    if not task["force"]:
        opts["download_archive"] = str(config.ARCHIVE_PATH)
    seen_ids: list[str] = []
    if task.get("music_playlist"):
        # match_filter chạy TRƯỚC bước kiểm tra "đã tải rồi" → biết cả bài được bỏ qua, để vẫn thêm được vào playlist
        def _seen(info, *, incomplete=False):
            if not incomplete and info.get("id") and info.get("_type", "video") == "video":
                seen_ids.append(str(info["id"]))
            return None
        opts["match_filter"] = _seen
    if task.get("headers"):        # link phim bắt từ trình duyệt trong app: cần đúng Referer/Origin/User-Agent
        try:
            opts["http_headers"] = {k: v for k, v in json.loads(task["headers"]).items() if isinstance(v, str)}
        except ValueError:
            pass

    pps = list(opts.pop("postprocessors", []))
    if HAS_FFMPEG and task["quality"] != "audio" and cfg.get("video_format", "mp4") == "mp4":
        # luôn ra .mp4 (webm/mkv/flv/ts → mp4, chỉ đổi vỏ file, giữ nguyên chất lượng), trước khi nhúng phụ đề/ảnh bìa
        pps.insert(0, {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"})
    if HAS_FFMPEG:
        if cfg.get("embed_subs") and task["quality"] != "audio" and cfg.get("subtitle_langs"):
            opts.update(writesubtitles=True, subtitleslangs=cfg["subtitle_langs"])
            pps.append({"key": "FFmpegEmbedSubtitle", "already_have_subtitle": False})
        pps.append({"key": "FFmpegMetadata", "add_chapters": True, "add_metadata": True})
        opts["writethumbnail"] = True
        pps.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})
    opts["postprocessors"] = pps

    stopped = None
    try:
        with _account(cfg, task["url"], f"t{tid}") as acc, yt_dlp.YoutubeDL({**opts, **acc}) as ydl:
            ydl.add_post_processor(_RecordItem(task, disk, item_done), when="after_move")
            ydl.download([task["url"]])
    except DownloadCancelled as e:
        stopped = str(e) or "canceled"
    except Exception as e:  # lỗi không lường trước: báo lên giao diện
        log.error(str(e))

    if task.get("music_playlist") and (seen_ids or log.archived_ids) and not stopped:
        try:
            result_added = music.link_downloaded(task["music_playlist"], seen_ids + log.archived_ids)
            live["playlist_added"] = result_added
        except Exception as e:  # noqa: BLE001 – không làm hỏng tác vụ tải
            log.warning(f"Không thêm được vào playlist: {e}")

    result = {"done_count": state["done"], "skipped_count": log.skipped,
              "error_count": len(log.errors), "speed": None, "eta": None}
    if stopped:
        result["status"] = "paused" if stopped == "pause" else "canceled"
    elif state["done"] == 0 and log.errors:
        result.update(status="error", error=log.errors[-1][:500])
    else:
        result.update(status="done", progress=100,
                      error=(f"{len(log.errors)} mục lỗi. Lỗi cuối: {log.errors[-1][:300]}" if log.errors else None))
    return result
