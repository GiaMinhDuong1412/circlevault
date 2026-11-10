"""Cập nhật yt-dlp không cần pip: tải wheel từ PyPI, giải nén vào <DATA>/pylib (app/__init__.py ưu tiên thư mục này).

Dùng được cả trong app desktop (Python nhúng không có pip) lẫn khi chạy từ mã nguồn.
"""
from __future__ import annotations

import io
import json
import re
import shutil
import urllib.request
import zipfile

import yt_dlp

from . import config

PYLIB = config.DATA / "pylib"


def _json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "CircleVault"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _wheel_url(meta: dict) -> str:
    for u in meta["urls"]:
        if u["packagetype"] == "bdist_wheel" and u["filename"].endswith("-py3-none-any.whl"):
            return u["url"]
    raise RuntimeError("PyPI không có bản wheel phù hợp.")


def _extract(url: str, dest) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "CircleVault"})
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(dest)


def update() -> dict:
    meta = _json("https://pypi.org/pypi/yt-dlp/json")
    latest = meta["info"]["version"]
    current = yt_dlp.version.__version__
    if latest == current:
        return {"updated": False, "version": current, "message": f"yt-dlp {current} đã là bản mới nhất."}

    staging = PYLIB.with_name("pylib-new")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    _extract(_wheel_url(meta), staging)
    # yt-dlp-ejs (giải mã YouTube) đi kèm đúng phiên bản yt-dlp yêu cầu
    for req in meta["info"].get("requires_dist") or []:
        m = re.match(r"yt-dlp-ejs\s*==\s*([\w.]+)", req)
        if m:
            _extract(_wheel_url(_json(f"https://pypi.org/pypi/yt-dlp-ejs/{m.group(1)}/json")), staging)
            break
    shutil.rmtree(PYLIB, ignore_errors=True)
    staging.rename(PYLIB)
    return {"updated": True, "version": latest, "need_restart": True,
            "message": f"Đã tải yt-dlp {latest} (đang dùng {current}). Khởi động lại để dùng bản mới."}
