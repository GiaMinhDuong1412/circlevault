"""Chạy backend:  python -m app [--port 8686] [--host 127.0.0.1] [--no-browser]

App desktop (desktop/src/main.js) gọi lệnh này bằng Python nhúng, kèm --port và --no-browser.
"""
import argparse
import threading
import webbrowser

import uvicorn

from . import config


def main() -> None:
    ap = argparse.ArgumentParser(description="CircleVault backend")
    ap.add_argument("--port", type=int)
    ap.add_argument("--host")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    cfg = config.load()
    host = a.host or cfg["host"]
    port = a.port or cfg["port"]
    url = f"http://127.0.0.1:{port}"
    print(f"\n  CircleVault {config.VERSION} đang chạy tại {url}", flush=True)
    if host == "0.0.0.0":
        print("  Đã mở cho các thiết bị cùng mạng Wi-Fi (dùng IP máy tính này).", flush=True)
    print("  Nhấn Ctrl+C để tắt.\n", flush=True)
    if not a.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
