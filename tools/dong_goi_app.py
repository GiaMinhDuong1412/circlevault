# -*- coding: utf-8 -*-
"""Chuẩn bị tài nguyên cho app CircleVault (desktop/, Electron) trước khi electron-builder đóng gói.
GitHub Actions gọi khi merge vào main (và khi kiểm tra nhánh); chạy tay được.

    python tools/dong_goi_app.py [--ra desktop/res] [--khong-python] [--khong-cong-cu]

Tạo trong thư mục --ra:
  app/backend/   mã backend (app/*.py, requirements.txt)
  app/frontend/  giao diện (index.html, css/, js/)
  python/        Python nhúng 3.12 (python.org, bản embed amd64) + thư viện ở python/Lib/site-packages
  bin/           ffmpeg.exe, ffprobe.exe (bản build của yt-dlp) và deno.exe – app thêm thư mục này vào PATH của backend
Chỉ thư viện chuẩn. Thư viện Python cài bằng pip của máy chạy script, nhắm Windows x64 + Python 3.12 nên chạy được cả trên Linux.
"""
import argparse
import io
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_VER = "3.12.10"
PY_URL = f"https://www.python.org/ftp/python/{PY_VER}/python-{PY_VER}-embed-amd64.zip"
FFMPEG_URL = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
DENO_URL = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"


def tai(url: str) -> bytes:
    print("Tải:", url, flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "circlevault-build"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def chep_ma(app: Path) -> int:
    shutil.rmtree(app, ignore_errors=True)
    n = 0
    for p in sorted((ROOT / "backend" / "app").glob("*.py")):
        f = app / "backend" / "app" / p.name
        f.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, f)
        n += 1
    shutil.copy2(ROOT / "backend" / "requirements.txt", app / "backend" / "requirements.txt")
    for p in sorted((ROOT / "frontend").rglob("*")):
        if p.is_file():
            f = app / "frontend" / p.relative_to(ROOT / "frontend")
            f.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, f)
            n += 1
    return n


def chuan_bi_python(py: Path) -> None:
    shutil.rmtree(py, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(tai(PY_URL))) as z:
        z.extractall(py)
    if not (py / "pythonw.exe").exists():
        raise SystemExit("Gói Python nhúng thiếu pythonw.exe")
    site = py / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check",
           "--target", str(site), "--platform", "win_amd64", "--python-version", "3.12",
           "--implementation", "cp", "--only-binary=:all:", "-r", str(ROOT / "backend" / "requirements.txt")]
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    # Python nhúng chỉ tìm module theo file ._pth: thêm site-packages và mã backend (..\app\backend)
    pth = next(py.glob("python3*._pth"))
    zip_name = next(py.glob("python3*.zip")).name
    pth.write_text(f"{zip_name}\n.\nLib\\site-packages\n..\\app\\backend\n", encoding="utf-8")
    print("Python nhúng:", py, "| ._pth:", pth.name, flush=True)


def chuan_bi_cong_cu(bin_dir: Path) -> None:
    shutil.rmtree(bin_dir, ignore_errors=True)
    bin_dir.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(tai(FFMPEG_URL))) as z:
        for name in z.namelist():
            if name.endswith(("/bin/ffmpeg.exe", "/bin/ffprobe.exe")):
                (bin_dir / Path(name).name).write_bytes(z.read(name))
    with zipfile.ZipFile(io.BytesIO(tai(DENO_URL))) as z:
        (bin_dir / "deno.exe").write_bytes(z.read("deno.exe"))
    thieu = [f for f in ("ffmpeg.exe", "ffprobe.exe", "deno.exe") if not (bin_dir / f).exists()]
    if thieu:
        raise SystemExit("Thiếu công cụ: " + ", ".join(thieu))
    print("Công cụ:", ", ".join(f"{p.name} {p.stat().st_size // 2**20} MB" for p in sorted(bin_dir.iterdir())), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Chuẩn bị tài nguyên app CircleVault")
    ap.add_argument("--ra", default=str(ROOT / "desktop" / "res"))
    ap.add_argument("--khong-python", action="store_true", help="không tải Python nhúng + thư viện")
    ap.add_argument("--khong-cong-cu", action="store_true", help="không tải ffmpeg / Deno")
    a = ap.parse_args()
    ra = Path(a.ra)
    print("Mã:", ra / "app", f"({chep_ma(ra / 'app')} file)", flush=True)
    if not a.khong_python:
        chuan_bi_python(ra / "python")
    else:
        (ra / "python").mkdir(parents=True, exist_ok=True)
    if not a.khong_cong_cu:
        chuan_bi_cong_cu(ra / "bin")
    else:
        (ra / "bin").mkdir(parents=True, exist_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
