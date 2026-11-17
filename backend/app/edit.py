"""Sửa nhanh video / nhạc trong thư viện bằng ffmpeg (đã kèm sẵn trong app): cắt đoạn, chuyển sang MP4.

- Luôn ghi ra FILE MỚI cạnh file gốc (không bao giờ ghi đè hay xóa file gốc), rồi thêm file mới vào thư viện.
- Cắt nhanh = sao chép luồng (-c copy): không giảm chất lượng, vài giây là xong, nhưng video chỉ cắt được ở khung hình
  khóa (keyframe) nên điểm đầu có thể lệch 1–2 giây. Cắt chính xác = mã hóa lại (H.264/AAC): đúng từng khung hình, chậm hơn.
- Việc chạy nền trong thread, trang hỏi tiến độ qua GET /api/edit/jobs/{id}.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db, music

router = APIRouter(prefix="/api/edit")
_jobs: dict[str, dict] = {}
AUDIO_CODEC = {".mp3": ["-c:a", "libmp3lame", "-q:a", "0"], ".m4a": ["-c:a", "aac", "-b:a", "256k"],
               ".opus": ["-c:a", "libopus", "-b:a", "160k"], ".ogg": ["-c:a", "libvorbis", "-q:a", "6"],
               ".flac": ["-c:a", "flac"], ".wav": ["-c:a", "pcm_s16le"]}


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise HTTPException(400, "Không có ffmpeg. Bản app đã kèm sẵn ffmpeg – hãy cài lại app.")
    return exe


def _hms(t: float) -> str:
    t = max(0, int(round(t)))
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return f"{h}h{m:02d}m{s:02d}" if h else f"{m:02d}m{s:02d}"


def _unique(p: Path) -> Path:
    if not p.exists():
        return p
    for i in range(2, 1000):
        q = p.with_name(f"{p.stem} ({i}){p.suffix}")
        if not q.exists():
            return q
    raise HTTPException(500, "Không đặt được tên file mới.")


def _duration(path: str) -> float | None:
    probe = shutil.which("ffprobe")
    if not probe:
        return None
    try:
        out = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
                             capture_output=True, text=True, timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip()
        return float(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _run(job: dict, args: list[str], total: float, out: Path, on_done) -> None:
    """Chạy ffmpeg, đọc tiến độ từ -progress, xong thì gọi on_done(out). Lỗi thì xóa file dở (file mới, không phải file gốc)."""
    job["status"] = "running"
    try:
        p = subprocess.Popen([_ffmpeg(), "-hide_banner", "-nostdin", "-y", *args, "-progress", "pipe:1", "-nostats", str(out)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        job["_proc"] = p
        err_tail: list[str] = []
        t = threading.Thread(target=lambda: err_tail.extend(p.stderr.read().splitlines()[-6:]), daemon=True)
        t.start()
        for line in p.stdout:
            m = re.match(r"out_time_(?:us|ms)=(\d+)", line.strip())
            if m and total:
                job["progress"] = round(min(99.0, int(m.group(1)) / 1e6 / total * 100), 1)
        p.wait()
        t.join(5)
        if job.get("canceled"):
            raise RuntimeError("Đã hủy.")
        if p.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            msg = next((ln for ln in reversed(err_tail) if ln.strip()), "ffmpeg báo lỗi")
            raise RuntimeError(msg[:300])
        job.update(on_done(out) or {})
        job.update(status="done", progress=100, output=str(out))
    except Exception as e:  # noqa: BLE001 – báo lỗi lên trang
        if out.exists():
            out.unlink(missing_ok=True)       # chỉ xóa file kết quả dở dang
        job.update(status="error", error=str(e) or "Lỗi không rõ")
    finally:
        job.pop("_proc", None)
        job["finished_at"] = time.time()


def _start(args, total, out, on_done, label) -> dict:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "queued", "progress": 0, "label": label, "error": None, "output": None, "started_at": time.time()}
    _jobs[jid] = job
    for k in [k for k, v in _jobs.items() if v.get("finished_at") and v["finished_at"] < time.time() - 3600]:
        _jobs.pop(k, None)
    from . import applog
    threading.Thread(target=applog.wrap("Cắt / chuyển video (ffmpeg)", _run, job, args, total, out, on_done, job=job, limit=120),
                     daemon=True).start()
    return {k: v for k, v in job.items() if not k.startswith("_")}


def _source(kind: str, sid: int) -> dict:
    if kind == "item":
        it = db.one("SELECT * FROM items WHERE id=?", (sid,))
        if not it:
            raise HTTPException(404, "Không thấy mục này trong thư viện.")
        path = it["filepath"]
    else:
        it = db.one("SELECT * FROM tracks WHERE id=?", (sid,))
        if not it:
            raise HTTPException(404, "Không thấy bài hát này.")
        path = it["path"]
    if not os.path.exists(path):
        raise HTTPException(404, "File không còn trên ổ.")
    return {**it, "_path": path}


def _register(kind: str, src: dict, out: Path, title: str, duration: float | None) -> dict:
    """Thêm file mới vào thư viện (và trang Nghe Nhạc nếu là âm thanh)."""
    res = {}
    if kind == "item":
        res["item_id"] = db.add_item(
            task_id=src.get("task_id"), kind=src["kind"], title=title, source_url=src.get("source_url"),
            extractor=src.get("extractor"), video_id=None, uploader=src.get("uploader"), duration=duration,
            height=src.get("height"), filepath=str(out.resolve()), filesize=out.stat().st_size,
            thumbnail=src.get("thumbnail"), disk_id=src.get("disk_id"))
    if music.is_audio(str(out)):
        tid = music.upsert(str(out), src.get("source") or "library" if kind == "track" else "library")
        if tid and title:
            db.execute("UPDATE tracks SET title=? WHERE id=?", (title, tid))
        res["track_id"] = tid
    return res


class CutIn(BaseModel):
    start: float
    end: float
    accurate: bool = False


@router.post("/{kind}/{sid}/cut")
def cut(kind: str, sid: int, body: CutIn):
    if kind not in ("item", "track"):
        raise HTTPException(404, "Không có loại này.")
    src = _source(kind, sid)
    path = src["_path"]
    total = _duration(path) or src.get("duration") or 0
    start, end = max(0.0, body.start), body.end
    if total:
        end = min(end, total)
    if end - start < 0.5:
        raise HTTPException(400, "Đoạn cắt quá ngắn: điểm cuối phải sau điểm đầu ít nhất nửa giây.")
    p = Path(path)
    audio = music.is_audio(path)
    out = _unique(p.with_name(f"{p.stem} (cắt {_hms(start)}-{_hms(end)}){p.suffix if audio or body.accurate is False else '.mp4'}"))
    dur = end - start
    maps = ["-map", "0:a?"] if audio else ["-map", "0:V?", "-map", "0:a?", "-map", "0:s?"]
    if audio:
        codec = ["-c", "copy"] if not body.accurate else AUDIO_CODEC.get(p.suffix.lower(), ["-c:a", "aac", "-b:a", "256k"])
    elif body.accurate:
        codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                 "-c:s", "mov_text", "-movflags", "+faststart"]
    else:
        codec = ["-c", "copy", "-avoid_negative_ts", "make_zero"]
    args = ["-ss", f"{start:.3f}", "-i", path, "-t", f"{dur:.3f}", *maps, *codec, "-map_metadata", "0"]
    base_title = src.get("title") or p.stem
    title = f"{base_title} (cắt {_hms(start)}–{_hms(end)})"
    return _start(args, dur, out, lambda o: _register(kind, src, o, title, _duration(str(o)) or dur), f"Cắt {p.name}")


@router.post("/{kind}/{sid}/mp4")
def to_mp4(kind: str, sid: int):
    if kind not in ("item", "track"):
        raise HTTPException(404, "Không có loại này.")
    src = _source(kind, sid)
    path = src["_path"]
    p = Path(path)
    if music.is_audio(path):
        raise HTTPException(400, "Đây là file âm thanh, không cần chuyển MP4.")
    if p.suffix.lower() == ".mp4":
        raise HTTPException(400, "File đã là MP4.")
    out = _unique(p.with_suffix(".mp4"))
    total = _duration(path) or src.get("duration") or 0
    # đổi vỏ file (giữ nguyên chất lượng); phụ đề chuyển sang dạng MP4 hỗ trợ
    args = ["-i", path, "-map", "0:V?", "-map", "0:a?", "-map", "0:s?", "-c", "copy", "-c:s", "mov_text", "-movflags", "+faststart"]
    title = src.get("title") or p.stem
    return _start(args, total, out, lambda o: _register(kind, src, o, title, _duration(str(o))), f"Chuyển {p.name} sang MP4")


@router.get("/jobs/{jid}")
def job(jid: str):
    j = _jobs.get(jid)
    if not j:
        raise HTTPException(404, "Không thấy việc này (app vừa khởi động lại?).")
    return {k: v for k, v in j.items() if not k.startswith("_")}


@router.post("/jobs/{jid}/cancel")
def cancel(jid: str):
    j = _jobs.get(jid)
    if j and j.get("_proc"):
        j["canceled"] = True
        j["_proc"].kill()
    return {"ok": True}
