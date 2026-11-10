"""SQLite: bảng tasks (hàng đợi) và items (thư viện đã tải)."""
from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any

from . import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  quality TEXT NOT NULL,
  playlist INTEGER NOT NULL DEFAULT 0,
  force INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  thumbnail TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  item_index INTEGER,
  item_count INTEGER,
  current_title TEXT,
  done_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  disk_id TEXT,
  error TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT,
  extractor TEXT,
  video_id TEXT,
  uploader TEXT,
  duration REAL,
  height INTEGER,
  filepath TEXT NOT NULL,
  filesize INTEGER,
  thumbnail TEXT,
  disk_id TEXT,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  title TEXT, artist TEXT, album TEXT,
  duration REAL, size INTEGER, mtime REAL,
  has_cover INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  added_at REAL NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played REAL
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  track_ids TEXT NOT NULL DEFAULT '[]',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
"""


def conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            config.DATA.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, isolation_level=None)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.executescript(SCHEMA)
        return _conn


def query(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql: str, args: tuple = ()) -> int:
    with _lock:
        cur = conn().execute(sql, args)
        return cur.lastrowid


def update_task(task_id: int, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = time.time()
    cols = ", ".join(f"{k} = ?" for k in fields)
    execute(f"UPDATE tasks SET {cols} WHERE id = ?", (*fields.values(), task_id))


def create_task(url: str, kind: str, quality: str, playlist: bool, force: bool,
                title: str | None, thumbnail: str | None) -> int:
    now = time.time()
    return execute(
        "INSERT INTO tasks (url, kind, quality, playlist, force, title, thumbnail, status, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
        (url, kind, quality, int(playlist), int(force), title, thumbnail, now, now),
    )


def add_item(**f: Any) -> int:
    f.setdefault("created_at", time.time())
    cols = ", ".join(f)
    marks = ", ".join("?" for _ in f)
    return execute(f"INSERT INTO items ({cols}) VALUES ({marks})", tuple(f.values()))
