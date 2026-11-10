#!/usr/bin/env bash
# Chạy backend CircleVault từ mã nguồn (macOS / Linux). Giao diện lấy từ ../frontend.
set -e
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
exec .venv/bin/python -m app "$@"
