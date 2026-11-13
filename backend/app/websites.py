"""Trang web xem phim đã lưu (bấm nhanh để mở trong trình duyệt của app / tạo phòng xem chung). DATA/web-sites.json."""
from __future__ import annotations

import json
import re
import time
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import config, devices

router = APIRouter(prefix="/api/web-sites", dependencies=[Depends(devices.local_only)])
PATH = config.DATA / "web-sites.json"


class SiteIn(BaseModel):
    url: str
    name: str | None = None


def _load() -> list[dict]:
    try:
        rows = json.loads(PATH.read_text(encoding="utf-8"))
        return [r for r in rows if isinstance(r, dict) and r.get("url")]
    except (OSError, ValueError):
        return []


def _save(rows: list[dict]) -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(rows[:60], ensure_ascii=False, indent=1), encoding="utf-8")


def _norm(url: str) -> str:
    u = url.strip()
    if not re.match(r"https?://", u, re.I):
        u = "https://" + u
    p = urlparse(u)
    if not p.hostname or "." not in p.hostname:
        raise HTTPException(400, "Địa chỉ trang chưa đúng, ví dụ: https://ten-trang.com")
    return u


@router.get("")
def list_sites():
    return _load()


@router.post("")
def add_site(body: SiteIn):
    url = _norm(body.url)
    host = (urlparse(url).hostname or "").removeprefix("www.")
    rows = [r for r in _load() if (urlparse(r["url"]).hostname or "").removeprefix("www.") != host]
    name = re.sub(r"\s+", " ", body.name or "").strip()[:60] or host
    rows.insert(0, {"url": url, "name": name, "host": host, "at": time.time()})
    _save(rows)
    return rows


@router.delete("")
def del_site(url: str):
    rows = [r for r in _load() if r["url"] != url]
    _save(rows)
    return rows
