"""Mở file Unity bằng UnityPy mà KHÔNG giữ file game bị khóa.

UnityPy giữ file đang đọc mở suốt đời đối tượng Environment (và Environment hay nằm trong vòng tham chiếu nên không tự đóng ngay).
Trên Windows, file đang mở thì không thay được bằng os.replace → "[WinError 5] Access is denied" khi áp dụng bản dịch / đổi font.
Luôn dùng `open_env` (tự đóng khi xong) và khi cần sửa một file thì đọc từ BẢN KHÁC (bản sao lưu, hoặc bản chép tạm), không đọc
chính file sắp ghi đè."""
from __future__ import annotations

import contextlib
import os
import shutil
import uuid
from pathlib import Path

from . import config


@contextlib.contextmanager
def open_env(path, detach: bool = False):
    """UnityPy.load trên file do APP tự mở rồi tự đóng khi xong (UnityPy tự mở thì giữ file tới khi bộ dọn rác chạy).
    detach=True: đọc từ bản chép tạm (để còn ghi đè chính file `path` trong lúc đang đọc)."""
    import UnityPy  # noqa: N813
    src = Path(path)
    tmp = None
    if detach:
        d = config.DATA / "cache" / "unity-tam"
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"{uuid.uuid4().hex[:8]}-{src.name}"
        shutil.copyfile(src, tmp)
        src = tmp
    fh = open(src, "rb")  # noqa: SIM115 – đóng ở finally
    try:
        yield UnityPy.load(fh)
    finally:
        fh.close()
        if tmp is not None:
            with contextlib.suppress(OSError):
                os.remove(tmp)
