# CircleVault

App Windows cá nhân để tải video YouTube / phim / nhạc về ổ cứng và nghe nhạc có bộ chỉnh âm (EQ).
Giao diện theo phong cách CircleLifeTeam. Cài một lần, app tự báo và tự cài bản mới (giống AQ Auto Test).

## Cài cho người dùng

Hướng dẫn từng bước có ảnh cho người mới: https://claude.ai/artifact/JkiAeGUDjzY7RP3P97e2h7

1. Vào **https://github.com/GiaMinhDuong1412/circlevault-releases/releases/latest**
2. Tải `CircleVault-Setup-<phiên bản>.exe`, bấm đúp để cài (không cần quyền admin).
3. Mở **CircleVault** từ màn hình Desktop. Đã kèm sẵn ffmpeg và Deno, không phải cài thêm gì.

Khi có bản mới, góc trên app hiện **"Có bản mới … – Cập nhật"**: bấm Cập nhật, chờ tải xong rồi bấm **Khởi động lại**.
Bản `Portable` chạy ngay không cần cài nhưng không tự cập nhật.

Dữ liệu của app (cài đặt, thư viện, lịch sử tải, EQ) nằm ở `%APPDATA%\CircleVault\data`; gỡ app không xóa dữ liệu này.
Video/nhạc tải về nằm ở thư mục ổ đĩa bạn chọn trong tab **Lưu Trữ** (mặc định `D:\CircleVault`, `E:\CircleVault`).

## Tính năng

| Tab | Làm được gì |
| --- | --- |
| Trang Chủ | Dán link → Phân tích → chọn chất lượng (4K…480p, MP3) → Tải ngay. YouTube video/playlist/kênh/shorts, link `.m3u8`, hơn 1.000 trang video. |
| Hàng Đợi | Tốc độ, thời gian còn lại, tạm dừng / tải tiếp từ chỗ dừng, hủy, thử lại. Tắt app giữa chừng thì lần sau tải tiếp. |
| Thư Viện | Tìm, lọc, xem video ngay trong app, mở thư mục chứa file. |
| Nghe Nhạc | Thư viện nhạc (nhạc tải từ YouTube + thư mục nhạc có sẵn trên máy), playlist, trộn bài, lặp, phím media trên bàn phím. **EQ 10 dải** với 14 preset (Tăng Bass, Giọng hát rõ, Bolero, EDM, Loa laptop…), lưu preset riêng, đường cong + phổ âm thanh trực tiếp, tự hạ preamp và chống rè. |
| Xem Online | Cửa sổ YouTube trong app, đăng nhập tài khoản (Premium = không quảng cáo), nút "Tải video này"; tải bằng tài khoản đó (video giới hạn tuổi, hội viên). Trình duyệt bắt link cho trang phim khác: chặn quảng cáo/popup, tự bắt luồng `.m3u8`/`.mpd`/`.mp4` kèm Referer/Cookie để tải. |
| Xem Chung | Tạo phòng xem chung (phim trong thư viện hoặc video YouTube), bạn bè mở link bằng trình duyệt, không cần cài. Đồng bộ phát/dừng/tua, chat, thả cảm xúc. Link Internet qua Cloudflare Quick Tunnel (không cần tài khoản). |
| Lưu Trữ | Chọn thư mục cho từng ổ, ổ ưu tiên cho từng loại, ngưỡng đầy, số luồng, cookie trình duyệt, cập nhật yt-dlp. |

## Cấu trúc mã nguồn

```
backend/            Python (FastAPI) – tải, hàng đợi, thư viện, nhạc
  app/main.py         API + phục vụ giao diện
  app/manager.py      hàng đợi, giới hạn luồng mỗi ổ, tạm dừng / tiếp tục
  app/downloader.py   gọi yt-dlp: phân tích link, tải, ghi vào thư viện
  app/music.py        thư viện nhạc, playlist, ảnh bìa, cài đặt EQ (API /api/music/…)
  app/party.py        phòng xem chung: API /api/party + máy chủ riêng cho bạn bè (cổng app + 1)
  app/tunnel.py       đường hầm Internet cho phòng (cloudflared, tải lần đầu khi cần)
  app/ytdlp_update.py cập nhật yt-dlp từ PyPI (không cần pip)
  app/storage.py      đo dung lượng, chọn ổ theo quy tắc
  app/detect.py       nhận diện loại link
  app/config.py, db.py
  requirements.txt, run.bat, run.sh
frontend/           Giao diện web (JS thuần, không cần build)
  index.html
  css/app.css
  js/app.js           trang chủ, hàng đợi, thư viện, lưu trữ, cập nhật app
  js/eq.js            bộ chỉnh âm 10 dải (Web Audio API)
  js/music.js         trang nghe nhạc + thanh phát nhạc
  js/watch.js         tab Xem Online + tab Xem Chung
  party.html, js/party.js, css/party.css   trang phòng xem chung (bạn bè mở)
desktop/            Vỏ app Windows (Electron) – chạy backend bằng Python nhúng, tự cập nhật
  src/main.js, src/updater.js, src/preload.js
  src/browser.js      cửa sổ YouTube (đăng nhập, xuất cookie cho yt-dlp) + trình duyệt bắt link phim (chặn quảng cáo)
  src/browser.html, browser-ui.js, browser-preload.js   thanh công cụ của cửa sổ trình duyệt
  build/icon.ico, build/installer.nsh
tools/
  dong_goi_app.py     chuẩn bị Python nhúng + thư viện + ffmpeg + Deno cho bộ cài
  kiem_tra.py         kiểm tra cú pháp trước khi merge
.github/workflows/
  release.yml         merge vào main = build + phát hành bản mới
  kiem-tra.yml        nhánh khác / PR: kiểm tra + build thử
```

## Chạy từ mã nguồn (để phát triển)

Cần Python 3.11+, ffmpeg và Deno trên máy.

- Chỉ backend + giao diện trên trình duyệt: bấm đúp `backend/run.bat` → http://127.0.0.1:8686
- Cả vỏ app Electron: `cd desktop`, `npm install`, `npm start` (dùng Python của máy, cần `pip install -r backend/requirements.txt`)
- Kiểm tra trước khi commit: `python tools/kiem_tra.py`

## Phát hành bản mới

Merge (push) vào nhánh `main` là GitHub Actions tự:
kiểm tra → tải Python nhúng, thư viện, ffmpeg, Deno → build `Setup.exe` + `Portable.exe` → chạy thử `--smoke`
→ tạo Release `v<năm>.<tháng>.<số lần chạy>` ở repo này và ở repo public `circlevault-releases`.
App trên máy người dùng đọc repo public nên không cần token.

**Cấu hình một lần:** repo này cần secret `RELEASES_TOKEN_CIRCLEVAULT`: một token GitHub (fine-grained) có quyền
**Contents: Read and write** trên repo `circlevault-releases`. Có thể dùng chung token của `aq-autotest` nếu thêm repo này vào token đó.

## Lưu ý

Chỉ dùng để lưu trữ cá nhân. Tải video YouTube trái với điều khoản dịch vụ của YouTube; không chia sẻ lại nội dung có bản quyền.
App không vượt DRM (Netflix và các dịch vụ trả phí).
