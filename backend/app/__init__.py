"""CircleVault backend.

Nếu đã bấm "Cập nhật yt-dlp" trong app, bản yt-dlp mới nằm ở <DATA>/pylib và được ưu tiên hơn bản đóng gói sẵn.
Phải chèn vào sys.path trước khi bất kỳ module nào import yt_dlp.
"""
import os
import sys
from pathlib import Path

_data = Path(os.environ.get("CIRCLEVAULT_DATA") or Path(__file__).resolve().parent.parent / "data")
_pylib = _data / "pylib"
if (_pylib / "yt_dlp").is_dir() and str(_pylib) not in sys.path:
    sys.path.insert(0, str(_pylib))
