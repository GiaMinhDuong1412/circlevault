"""Hàng đợi: lấy tác vụ 'queued', chọn ổ, giới hạn số luồng mỗi ổ, chạy yt-dlp trong thread."""
from __future__ import annotations

import asyncio
import logging

from . import config, db, downloader, storage

log = logging.getLogger("circlevault")


class Manager:
    def __init__(self) -> None:
        self.live: dict[int, dict] = {}       # tiến độ thời gian thực, không ghi DB liên tục
        self.stop: dict[int, str] = {}        # task_id -> "pause" | "cancel"
        self.running: dict[int, str] = {}     # task_id -> disk_id
        self._wake = asyncio.Event()

    def recover(self) -> None:
        """Mở lại app: các tác vụ đang dở được đưa về hàng đợi (yt-dlp tải tiếp từ file .part)."""
        db.execute("UPDATE tasks SET status='queued' WHERE status IN ('running','processing')")

    def wake(self) -> None:
        self._wake.set()

    async def loop(self) -> None:
        self.recover()
        while True:
            try:
                await self.tick()
            except Exception:  # không để vòng lặp chết
                log.exception("Lỗi hàng đợi")
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    async def tick(self) -> None:
        cfg = config.load()
        for t in db.query("SELECT * FROM tasks WHERE status='queued' ORDER BY id"):
            disk = storage.find_disk(cfg, t["disk_id"]) if t["disk_id"] else None
            if disk is None:
                disk = storage.pick_disk(cfg, t["kind"])
            if disk is None:
                db.update_task(t["id"], status="error",
                               error="Không tìm thấy ổ lưu nào còn chỗ. Kiểm tra tab Cài đặt.")
                continue
            busy = sum(1 for d in self.running.values() if d == disk["id"])
            if busy >= cfg["max_concurrent_per_disk"]:
                continue
            self.running[t["id"]] = disk["id"]
            db.update_task(t["id"], status="running", disk_id=disk["id"], error=None)
            asyncio.create_task(self._run(t, disk, cfg))

    async def _run(self, task: dict, disk: dict, cfg: dict) -> None:
        tid = task["id"]
        live = self.live.setdefault(tid, {})
        live.update(status="running", progress=task["progress"] or 0)
        try:
            result = await asyncio.to_thread(downloader.run_task, task, disk, cfg, live,
                                             lambda: self.stop.get(tid))
        except Exception as e:
            result = {"status": "error", "error": downloader.clean(str(e))[:500]}
        finally:
            self.running.pop(tid, None)
            self.stop.pop(tid, None)
            self.live.pop(tid, None)
        if result.get("status") == "error":
            from . import applog
            applog.error("Tải về", result.get("error") or "lỗi không rõ", kind="job", task=tid, url=(task.get("url") or "")[:200])
        keep = {k: v for k, v in result.items() if k not in ("speed", "eta")}
        if result.get("status") == "paused":
            keep["progress"] = live.get("progress", 0)
        db.update_task(tid, **keep)
        self.wake()

    # ---- điều khiển
    def pause(self, tid: int) -> None:
        if tid in self.running:
            self.stop[tid] = "pause"
        else:
            db.execute("UPDATE tasks SET status='paused' WHERE id=? AND status='queued'", (tid,))

    def cancel(self, tid: int) -> None:
        if tid in self.running:
            self.stop[tid] = "cancel"
        else:
            db.execute("UPDATE tasks SET status='canceled' WHERE id=? AND status IN ('queued','paused')", (tid,))

    def resume(self, tid: int) -> None:
        db.execute("UPDATE tasks SET status='queued', error=NULL WHERE id=? AND status IN "
                   "('paused','error','canceled')", (tid,))
        self.wake()

    def tasks(self) -> list[dict]:
        rows = db.query("SELECT * FROM tasks ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'processing' THEN 0 "
                        "WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 WHEN 'error' THEN 3 ELSE 4 END, id DESC LIMIT 300")
        for r in rows:
            live = self.live.get(r["id"])
            if live:
                r.update({k: v for k, v in live.items() if v is not None or k in ("speed", "eta")})
        return rows


manager = Manager()
