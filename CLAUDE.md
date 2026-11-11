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
    Tải MP3 khi đang mở playlist: tác vụ có `music_playlist` (hoặc `music_playlist_name` → `playlist_by_name`, so sánh casefold);
    `downloader` ghi id bài (match_filter + dòng log "has already been recorded" cho bài bỏ qua) → `music.link_downloaded`.
  - `party.py`: phòng xem chung. `router` /api/party (chỉ app chính dùng) + `party_app` chạy cổng app+1 (chỉ có /r/<mã>,
    /r/<mã>/ws, /r/<mã>/media, tĩnh /p = frontend). Bạn bè/đường hầm chỉ chạm party_app, không thấy API chính.
    Đồng bộ: máy chủ giữ {playing,pos,rate,at}, client tự tính theo đồng hồ máy chủ (ping/pong).
  - `tunnel.py`: cloudflared quick tunnel → party_app (tải cloudflared vào DATA/bin lần đầu).
  - Tác vụ có cột `headers` (JSON Referer/Origin/User-Agent/Cookie) cho link phim bắt từ trình duyệt → `http_headers` yt-dlp.
  - Tài khoản YouTube: app desktop ghi `DATA/youtube-cookies.txt`; `downloader._account` dùng bản sao cho link YouTube.
    Google hay chặn đăng nhập trong cửa sổ nhúng → hộp "Đăng nhập YouTube" (`CV.ytLogin`, watch.js): lấy cookie từ trình duyệt
    của người dùng (`POST /api/youtube/import`, yt-dlp đọc) hoặc file cookies.txt (`/api/youtube/import-file`), rồi
    `cvDesktop.youtubeImport` nạp vào partition `persist:youtube`. Không giả danh trình duyệt để lách kiểm tra của Google.
    Cách chính: tiện ích Chrome/Edge `backend/extension/` (MV3, cài "Load unpacked" từ `DATA/tien-ich-trinh-duyet`, do
    `POST /api/youtube/extension` chép ra) đọc cookie youtube/google của trình duyệt, dò cổng 8686–8705 qua `/api/youtube/hello`,
    gửi `import-file?source=extension` (bắt buộc header `X-CircleVault: 1` chống trang lạ gửi), gửi lại khi cookie *SID đổi
    và mỗi 30 phút. `browser.js`: file mới hơn lần đồng bộ (`fileSeen`) thì nạp vào cửa sổ YouTube trước, không ghi đè.
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
  - `ytmusic.py`: nhạc YouTube online trong tab Nghe Nhạc, router `/api/music/yt/*` (chỉ 127.0.0.1 vì dùng cookie tài khoản):
    playlist của tôi (feed/playlists, + LL/WL; nhớ ở `DATA/yt-playlists.json` kèm link đã mở), `list?src=` mở playlist/link,
    đánh dấu bài đã có trên máy theo `[id]` trong tên file; nghe trực tiếp = `prepare` (yt-dlp lấy link bestaudio) + `stream`
    (chuyển tiếp googlevideo theo Range, mỗi lần 4 MB, link hết hạn thì lấy lại). Nguồn online chung (`ONLINE_HOSTS`: YouTube,
    SoundCloud, Bandcamp): bài có `ou` (link), `GET /search?q=&site=yt|sc`, `POST /prepare?u=` + `GET /stream?u=`; chỉ có HLS thì
    tải tạm vào `DATA/cache/nghe-online` (tối đa 600 MB) rồi phát file; bỏ định dạng mã hóa (`NO_DRM`) – Spotify/Apple Music có DRM, không làm.
  - `edit.py`: router `/api/edit/*` – cắt đoạn (`POST /{item|track}/{id}/cut` {start,end,accurate}) và chuyển MP4 (`/mp4`) bằng ffmpeg
    trong thread, tiến độ `GET /jobs/{id}`. Luôn ghi FILE MỚI cạnh file gốc (không ghi đè/xóa gốc) rồi thêm vào thư viện/Nghe Nhạc.
    Cắt nhanh = `-c copy` (lệch theo keyframe), chính xác = H.264/AAC. Giao diện: `openCutter` trong app.js (hộp #player).
  - `phone.py`: "Mang theo điện thoại" – trang `/dt` (frontend/dt.html, js/dt.js, css/dt.css) cho điện thoại cùng Wi-Fi (cần chế độ
    `host` 0.0.0.0; tab Lưu Trữ có QR `/api/phone/qr.svg` (segno) + nút bật & khởi động lại). Điện thoại tải nhạc/phim như FILE THƯỜNG
    (trình duyệt Android không cho trang chọn ổ lưu, http trong mạng nhà không chạy offline được – người dùng đã chọn cách này):
    chọn bộ nhớ máy/thẻ nhớ trong cài đặt Tải xuống của Chrome, phát bằng app của điện thoại/VLC, xóa bằng app Files.
    Playlist = gói .zip không nén ghi thẳng ra luồng (thư mục `<tên>/` + .m3u8, Content-Length tính bằng lượt chạy thử, zip64 khi >4 GB)
    hoặc tải từng bài `?n=` + `.m3u8`. API chỉ đọc.
  - `devices.py`: ghép thiết bị cho chế độ Wi-Fi – middleware `Guard` (máy tính 127.0.0.1 luôn qua; thiết bị khác cần cookie `cv_dev`,
    lưu băm SHA-256 ở `DATA/devices.json`; quyền `phone` = chỉ /dt + /api/phone/*, `full` = như máy tính). Mã ghép 8 ký tự, 10 phút,
    dùng một lần, sai 20 lần/10 phút thì khóa. Tab Lưu Trữ: danh sách thiết bị (đổi quyền, đổi tên, thu hồi) + nút Thêm thiết bị (QR). Thử tên file tiếng Việt bằng Playwright trên Linux cần `LANG=C.UTF-8`.
  - Video tải về luôn ra .mp4 (`FFmpegVideoRemuxer`, cấu hình `video_format`: mp4 | original).
  - `ytdlp_update.py`: tải wheel yt-dlp (+ yt-dlp-ejs đúng phiên bản) từ PyPI vào `DATA/pylib`; `app/__init__.py` ưu tiên thư mục này.
- `frontend/` – JS thuần, không build. Theme màu: `THEMES` trong app.js + khối `:root[data-theme=…]` trong app.css (localStorage `cv-theme`, không có = theo Windows). `js/app.js` định nghĩa `window.CV` (api, esc, toast, fmt…, `views`) dùng chung cho
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
  `mini.js`: trình phát mini – thu nhỏ cửa sổ chính khi có bài → khung `mini.html` luôn trên cùng (đĩa xoay, tua, nút);
  music.js gửi trạng thái qua `cvDesktop.musicState`, nhận lệnh qua `onMusicCmd` (cửa sổ chính `backgroundThrottling: false`).
  `splash.html`: màn hình chờ khi mở app (đợi backend) và khi bấm "Khởi động lại để cập nhật" (`beforeInstall` → splash,
  ẩn cửa sổ, `quitAndInstall(false, true)` = bộ cài hiện tiến trình rồi tự mở lại app).
  `--smoke` cho CI (kiểm cả bộ nhận diện chữ qua /api/translate/warmup). Cập nhật: `updater.js` đọc repo public `GiaMinhDuong1412/circlevault-releases`.
- `android/` – app Android "CircleVault" (Kotlin + Jetpack Compose, `vn.circlevault.app`, minSdk 26). Ghép bằng quét QR
  (play-services-code-scanner) hoặc nhập địa chỉ + mã → `POST /api/phone/pair` với header `X-CircleVault-App: 1` (nhận `token`
  trong JSON) → mọi request gửi `Cookie: cv_dev=…`. Chỉ dùng `/api/phone/*` (playlists, tracks, videos, file, cover).
  `Core.kt`: Prefs, Api (OkHttp), Store (thư viện offline `filesDir/thu-vien.json`; file lưu ở thư mục riêng của app trên
  bộ nhớ máy/thẻ nhớ = `getExternalFilesDirs`, không cần quyền, gỡ app thì mất). `Downloads.kt`: hàng đợi + `DownloadService`
  (foreground dataSync, tải tiếp bằng Range từ `.part`). `Playback.kt`: Media3 `PlaybackService` (MediaSessionService, đường dẫn
  file đi qua `requestMetadata.mediaUri`) + `PlayerConn`. Giao diện `ui/` cùng bảng màu neo-brutalist. Phim: ExoPlayer riêng.
  Build: `gradle -p android assembleRelease -PvName=… -PvCode=…` (Gradle 8.14, AGP 8.7.3, JDK 17+, cần Android SDK 35).
  Ký: biến `CV_KEYSTORE`/`CV_KEYSTORE_PASS`; CI lấy từ secret `ANDROID_KEYSTORE_B64`/`ANDROID_KEYSTORE_PASS` (KHÔNG đổi khóa).
  Đợt 2: 4 tab dưới (Thư viện/Online/Máy tính/Cài đặt), theme như PC (`THEMES`, `ThemeState`, Prefs.theme). `Eq.kt`: Equalizer
  trên audioSessionId của ExoPlayer, lưu dB theo 5 dải chuẩn, EQ riêng từng bài (Prefs.eqTracks theo mediaId) hoặc mặc định.
  `Editor.kt`: cắt/ghép bằng Media3 Transformer → .m4a mới trong `cat-ghep/` (id âm, không sửa file gốc). `Updater.kt`: đọc
  release mới nhất của repo public (GitHub API), WorkManager 12 giờ, mỗi bản chỉ báo 1 lần (Prefs.updNotified/updLater), tải APK
  vào cache → FileProvider → trình cài (REQUEST_INSTALL_PACKAGES). `YouTube.kt`: phát `cvyt://<id>` – PlaybackService dùng
  ResolvingDataSource: máy tính kết nối được thì `/api/phone/yt/stream` (cookie YouTube trên PC), không thì NewPipeExtractor
  (jitpack, tự lấy luồng âm thanh; UA visionOS). Lưu bài YouTube về máy (`DJob.online`) → hàng chờ `Prefs.syncQueue` →
  `POST /api/phone/saved` → PC hiện khung "Điện thoại vừa lưu…" ở tab Nghe Nhạc (`GET /api/phone/saved`, tải/ bỏ qua, chỉ máy này).
  Spotify: không làm (DRM, người dùng đã chọn bỏ).
  Phát hành: job `android` trong release.yml đính `CircleVault-Android.apk` vào Release 2 repo; link cố định
  `…/circlevault-releases/releases/latest/download/CircleVault-Android.apk`.
- `tools/dong_goi_app.py` chuẩn bị `desktop/res/`; `tools/kiem_tra.py` kiểm tra cú pháp + liên kết file.

## Quy trình
- Trước khi commit: `python tools/kiem_tra.py`.
- **Merge vào `main` = phát hành** bản mới (`.github/workflows/release.yml`, cần secret `RELEASES_TOKEN_CIRCLEVAULT`). Làm việc trên nhánh
  khác, nhánh/PR chạy `kiem-tra.yml` (build thử + `--smoke`).
- Thêm thư viện Python: ghi vào `backend/requirements.txt` (phải có wheel cho Windows x64 / Python 3.12).

## Quy tắc
- Không thêm tính năng vượt DRM. Chỉ phục vụ lưu trữ cá nhân.
- Backend chỉ nghe `127.0.0.1` trừ khi người dùng bật chế độ mạng LAN trong tab Lưu Trữ. Khi đó chỉ THIẾT BỊ ĐÃ GHÉP (quét QR mã
  dùng một lần) mới vào được (`devices.Guard`); API mới chỉ dành cho máy tính thì thêm `Depends(devices.local_only)`.
- Không xóa file của người dùng nếu họ không bấm "Xóa cả file" (có bước xác nhận 2 lần).
