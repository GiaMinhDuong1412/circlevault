# -*- coding: utf-8 -*-
"""Kiểm tra nhanh trước khi commit / merge (GitHub Actions cũng chạy):

    python tools/kiem_tra.py

- cú pháp Python backend (py_compile)
- cú pháp JS frontend + desktop (node --check, nếu máy có node)
- index.html chỉ trỏ tới file có thật trong frontend/
- desktop/package.json hợp lệ, có icon
Chỉ thư viện chuẩn.
"""
import json
import py_compile
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
loi = []


def kiem_python():
    for p in sorted((ROOT / "backend").rglob("*.py")) + sorted((ROOT / "tools").glob("*.py")):
        try:
            py_compile.compile(str(p), doraise=True, cfile=str(p) + ".kt")
        except py_compile.PyCompileError as e:
            loi.append(f"Python: {e.msg}")
        finally:
            Path(str(p) + ".kt").unlink(missing_ok=True)


def kiem_js():
    node = shutil.which("node")
    files = sorted((ROOT / "frontend" / "js").glob("*.js")) + sorted((ROOT / "desktop" / "src").glob("*.js")) + sorted((ROOT / "backend" / "extension").glob("*.js"))
    if not node:
        print("(bỏ qua kiểm tra JS: không có node)")
        return
    for f in files:
        r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True)
        if r.returncode:
            loi.append(f"JS {f.relative_to(ROOT)}: {r.stderr.strip().splitlines()[-1] if r.stderr else 'lỗi'}")


def kiem_html():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    for ref in re.findall(r'(?:src|href)="/static/([^"]+)"', html):
        if not (ROOT / "frontend" / ref).exists():
            loi.append(f"index.html trỏ tới /static/{ref} nhưng không có frontend/{ref}")
    party = (ROOT / "frontend" / "party.html").read_text(encoding="utf-8")   # trang phòng xem chung: /p/ = frontend/
    for ref in re.findall(r'(?:src|href)="/p/([^"]+)"', party):
        if not (ROOT / "frontend" / ref).exists():
            loi.append(f"party.html trỏ tới /p/{ref} nhưng không có frontend/{ref}")
    for page in ("browser.html", "screen.html", "region.html", "mini.html", "splash.html"):     # cửa sổ riêng của app desktop
        shell = (ROOT / "desktop" / "src" / page).read_text(encoding="utf-8")
        for ref in re.findall(r'src="([\w.-]+\.js)"', shell):
            if not (ROOT / "desktop" / "src" / ref).exists():
                loi.append(f"desktop/src/{page} trỏ tới {ref} nhưng không có file")
    ids = re.findall(r'id="([^"]+)"', html)
    trung = {i for i in ids if ids.count(i) > 1}
    if trung:
        loi.append("index.html có id trùng: " + ", ".join(sorted(trung)))


def kiem_desktop():
    try:
        pkg = json.loads((ROOT / "desktop" / "package.json").read_text(encoding="utf-8"))
        pub = pkg["build"]["publish"][0]
        if pub["repo"] != "circlevault-releases":
            loi.append("package.json: publish.repo phải là circlevault-releases")
    except (OSError, ValueError, KeyError) as e:
        loi.append(f"desktop/package.json: {e}")
    if not (ROOT / "desktop" / "build" / "icon.ico").exists():
        loi.append("Thiếu desktop/build/icon.ico")


def main():
    kiem_python()
    kiem_js()
    kiem_html()
    kiem_desktop()
    if loi:
        print("KIỂM TRA LỖI:")
        for x in loi:
            print(" -", x)
        return 1
    print("Kiểm tra: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
