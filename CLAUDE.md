# CircleVault – hướng dẫn cho Claude Code

App cá nhân tải video/phim/nhạc về 2 ổ HDD của người dùng + nghe nhạc có EQ. Người dùng nói tiếng Việt – trả lời tiếng Việt,
ngắn gọn, giao diện và thông báo đều bằng tiếng Việt. Phong cách UI: neo-brutalist kiểu CircleLifeTeam (viền đen dày, bóng cứng,
thanh cyan, tab vàng, nút xanh lá) – giữ nguyên khi thêm màn hình mới, dùng token màu trong `:root` của `frontend/css/app.css`.

## Cấu trúc
- `backend/` – FastAPI. Chạy: `cd backend && python -m app [--port] [--no-browser]`. Biến môi trường: `CIRCLEVAULT_DATA`
  (dữ liệu: config.json, circlevault.db, archive.txt, music.json, pylib/), `CIRCLEVAULT_WEB` (thư mục frontend),
  `CIRCLEVAULT_VERSION`, `CIRCLEVAULT_APP=1` khi chạy trong app.
  - Hàng đợi `manager.py`: tác vụ `queued` → chọn ổ (`storage.pick_disk`) → yt-dlp chạy trong thread; tạm dừng = raise
    `DownloadCancelled` trong progress hook, tải tiếp nhờ file `.part`.
  - `downloader.py`: mẫu tên file `TEMPLATES` (an toàn Windows), `_RecordItem` (postprocessor after_move) ghi bảng `items`,
    file âm thanh đồng thời vào bảng `tracks` (trang Nghe Nhạc).
  - `music.py`: router `/api/music/*` – tracks, scan thư mục (`music_folders` trong config), cover (mutagen), playlist, settings EQ.
  - `ytdlp_update.py`: tải wheel yt-dlp (+ yt-dlp-ejs đúng phiên bản) từ PyPI vào `DATA/pylib`; `app/__init__.py` ưu tiên thư mục này.
- `frontend/` – JS thuần, không build. `js/app.js` định nghĩa `window.CV` (api, esc, toast, fmt…, `views`) dùng chung cho
  `js/eq.js` (Engine Web Audio + giao diện EQ 10 dải, preset `PRESETS`) và `js/music.js` (thư viện nhạc, thanh phát nhạc).
  Định tuyến bằng hash: `#home #queue #library #music #storage`.
- `desktop/` – Electron theo mẫu repo `aq-autotest` (`desktop/`): `main.js` chạy `pythonw -m app` bằng Python nhúng
  (`resources/python`, ._pth có `..\app\backend`), mã ở `resources/app/{backend,frontend}`, ffmpeg + Deno ở `resources/bin`
  (thêm vào PATH backend). Cầu nối trang ↔ app: `window.cvDesktop` (onUpdate/getUpdate/updateAct/pickFolder/restartServer).
  `--smoke` cho CI. Cập nhật: `updater.js` đọc repo public `GiaMinhDuong1412/circlevault-releases`.
- `tools/dong_goi_app.py` chuẩn bị `desktop/res/`; `tools/kiem_tra.py` kiểm tra cú pháp + liên kết file.

## Quy trình
- Trước khi commit: `python tools/kiem_tra.py`.
- **Merge vào `main` = phát hành** bản mới (`.github/workflows/release.yml`, cần secret `RELEASES_TOKEN`). Làm việc trên nhánh
  khác, nhánh/PR chạy `kiem-tra.yml` (build thử + `--smoke`).
- Thêm thư viện Python: ghi vào `backend/requirements.txt` (phải có wheel cho Windows x64 / Python 3.12).

## Quy tắc
- Không thêm tính năng vượt DRM. Chỉ phục vụ lưu trữ cá nhân.
- Backend chỉ nghe `127.0.0.1` trừ khi người dùng bật chế độ mạng LAN trong tab Lưu Trữ (không có mật khẩu).
- Không xóa file của người dùng nếu họ không bấm "Xóa cả file" (có bước xác nhận 2 lần).
