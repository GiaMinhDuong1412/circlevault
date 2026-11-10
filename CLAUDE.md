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
  - `party.py`: phòng xem chung. `router` /api/party (chỉ app chính dùng) + `party_app` chạy cổng app+1 (chỉ có /r/<mã>,
    /r/<mã>/ws, /r/<mã>/media, tĩnh /p = frontend). Bạn bè/đường hầm chỉ chạm party_app, không thấy API chính.
    Đồng bộ: máy chủ giữ {playing,pos,rate,at}, client tự tính theo đồng hồ máy chủ (ping/pong).
  - `tunnel.py`: cloudflared quick tunnel → party_app (tải cloudflared vào DATA/bin lần đầu).
  - Tác vụ có cột `headers` (JSON Referer/Origin/User-Agent/Cookie) cho link phim bắt từ trình duyệt → `http_headers` yt-dlp.
  - Tài khoản YouTube: app desktop ghi `DATA/youtube-cookies.txt`; `downloader._account` dùng bản sao cho link YouTube.
  - `translate.py` + `ocr.py`: tab Dịch, router `/api/translate/*` (chỉ nhận từ 127.0.0.1 vì có API key). `ocr.py` = RapidOCR
    (onnxruntime, offline) đọc chữ, cắt ảnh webtoon dài thành đoạn, gom dòng thành khung thoại, lấy màu nền. Bộ dịch: `google`
    (web miễn phí, từng câu) hoặc `claude` (SDK anthropic, API key người dùng trong `DATA/translate.json`, dịch cả trang một lần,
    structured output JSON, gửi kèm ảnh tùy chọn, `fallbacks="default"`). Bảng `translations` nhớ câu đã dịch.
    Truyện: `DATA/translate/books/<id>/{book.json,pages/}`, `Worker` dịch nền từng trang; xuất CBZ (Pillow vẽ chữ) vào
    `<ổ truyện>/Truyen dich/<tên> [VI].cbz`. Sửa tay (`edited`) được giữ khi dịch tiếp.
  - `gametr.py`: Việt hóa game từ file, router `/api/translate/games/*`, dự án ở `DATA/translate/games/<id>/project.json`
    (câu không trùng, dịch theo lô 60 câu, mã game được thay bằng ⟦n⟧ khi dịch rồi trả lại; mất mã → `bad`, giữ câu gốc).
    Ren'Py: đọc .rpy (khớp renpy/lexer.py: gộp khoảng trắng, `\{`→`{{`, chuỗi 3 nháy tách theo dòng trống), .rpyc và .rpa
    bằng `SafeUnpickler` (chỉ dựng đối tượng giả, không chạy mã). Áp dụng = chỉ THÊM `game/zz_circlevault_vi.rpy` +
    `circlevault_vi.json` (say_menu_text_filter, replace_text, font_replacement_map). RPG Maker MV/MZ: sửa data/*.json, luôn đọc
    từ bản sao lưu `<game>/CircleVault-ban-goc/` (áp dụng lại không dịch chồng), tự xuống dòng, >4 dòng tách khung thoại.
  - `ytdlp_update.py`: tải wheel yt-dlp (+ yt-dlp-ejs đúng phiên bản) từ PyPI vào `DATA/pylib`; `app/__init__.py` ưu tiên thư mục này.
- `frontend/` – JS thuần, không build. `js/app.js` định nghĩa `window.CV` (api, esc, toast, fmt…, `views`) dùng chung cho
  `js/eq.js` (Engine Web Audio + giao diện EQ 10 dải, preset `PRESETS`) và `js/music.js` (thư viện nhạc, thanh phát nhạc).
  `js/watch.js`: tab Xem Online + Xem Chung. `party.html` + `js/party.js`: trang phòng (không dùng app.js).
  `js/translate.js`: tab Dịch (truyện/game/dịch nhanh/cài đặt).
  Định tuyến bằng hash: `#home #queue #library #music #online #party #translate #storage`.
- `desktop/` – Electron theo mẫu repo `aq-autotest` (`desktop/`): `main.js` chạy `pythonw -m app` bằng Python nhúng
  (`resources/python`, ._pth có `..\app\backend`), mã ở `resources/app/{backend,frontend}`, ffmpeg + Deno ở `resources/bin`
  (thêm vào PATH backend). Cầu nối trang ↔ app: `window.cvDesktop` (onUpdate/getUpdate/updateAct/pickFolder/restartServer).
  `browser.js`: cửa sổ trình duyệt = thanh công cụ (`browser.html`) + WebContentsView trang web; partition `persist:youtube`
  (UA Chrome, xuất cookie Netscape khi đăng nhập) và `persist:web` (chặn quảng cáo @ghostery/adblocker-electron, bắt luồng qua
  webRequest.onBeforeSendHeaders + onResponseStarted – không dùng onBeforeRequest/onHeadersReceived vì adblocker đã giữ).
  `screen.js`: khung dịch màn hình game (screen.html luôn trên cùng, `setContentProtection` để không tự chụp mình; region.html
  chọn vùng; desktopCapturer chụp → POST /api/translate/image?mode=game; tự động = so ảnh thu nhỏ; phím Ctrl+Alt+T/R/A/H).
  `--smoke` cho CI (kiểm cả bộ nhận diện chữ qua /api/translate/warmup). Cập nhật: `updater.js` đọc repo public `GiaMinhDuong1412/circlevault-releases`.
- `tools/dong_goi_app.py` chuẩn bị `desktop/res/`; `tools/kiem_tra.py` kiểm tra cú pháp + liên kết file.

## Quy trình
- Trước khi commit: `python tools/kiem_tra.py`.
- **Merge vào `main` = phát hành** bản mới (`.github/workflows/release.yml`, cần secret `RELEASES_TOKEN_CIRCLEVAULT`). Làm việc trên nhánh
  khác, nhánh/PR chạy `kiem-tra.yml` (build thử + `--smoke`).
- Thêm thư viện Python: ghi vào `backend/requirements.txt` (phải có wheel cho Windows x64 / Python 3.12).

## Quy tắc
- Không thêm tính năng vượt DRM. Chỉ phục vụ lưu trữ cá nhân.
- Backend chỉ nghe `127.0.0.1` trừ khi người dùng bật chế độ mạng LAN trong tab Lưu Trữ (không có mật khẩu).
- Không xóa file của người dùng nếu họ không bấm "Xóa cả file" (có bước xác nhận 2 lần).
