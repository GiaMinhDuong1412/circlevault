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
  - `unitygame.py`: game Unity. (1) Việt hóa từ file cho game dùng Unity Localization: UnityPy đọc bảng chữ (MonoBehaviour có
    `m_TableData` + `m_LocaleId`) trong `<Game>_Data/StreamingAssets/aa/**/*string-tables*.bundle` của ngôn ngữ gốc (ưu tiên en),
    ghi tiếng Việt thay chỗ đó (lz4), rồi `zero_crc` đặt `m_Crc` = 0 trong `catalog.json` (JSON UTF-16 trong m_ExtraDataString,
    bù dấu cách để giữ nguyên độ dài/vị trí). Sao lưu `CircleVault-ban-goc/`, áp dụng lại đọc từ bản sao lưu. catalog.bin chưa sửa được.
    gametr.py gọi qua engine `unity` (mã giữ nguyên: `{…}`, `<…>`, `%s`). (2) Cài gói Việt hóa có sẵn (`/api/translate/vh/*`):
    .zip hoặc thư mục, tự dò số cấp thư mục cần bỏ cho khớp game, file ngoài thư mục game (công cụ của nhóm dịch) mặc định bỏ chọn,
    sao lưu `CircleVault-truoc-VH/<mã>/`, nhớ kích thước + mtime để báo "Steam đã ghi đè" → Cài lại; Gỡ trả file gốc.
    (3) `GET /api/translate/vh/steam`: game Steam đã cài (registry + libraryfolders.vdf + appmanifest). Gói VH mẫu của người dùng là
    hàng đã mua – KHÔNG đưa nội dung vào repo.
  - `langscan.py`: Việt hóa game chỉ cần thư mục game – quét nền có tiến độ (`POST /api/translate/games/scan` → `GET …/scan/<job>`:
    phase list/engine/files, done/total/bytes, found, strings; frontend vẽ thanh tiến độ sọc chạy + kính lúp). Nhận Ren'Py / RPG Maker /
    Unity Localization qua `gametr._specials`, rồi lục file chữ (.json .csv .tsv .xml .po .ini .cfg .properties .lang .strings .yaml .txt
    .ks…) và TextAsset trong .assets/.bundle (UnityPy). Mỗi định dạng trả (start, end, chữ, ngữ cảnh, hàm mã hóa) để ghi đè ĐÚNG CHỖ, giữ
    nguyên định dạng; CSV chọn cột theo tiêu đề ngôn ngữ (ghi tiếng Việt thay cột gốc). Chấm điểm file ngôn ngữ (thư mục loc/lang/text…,
    tên en/english…), đoán ngôn ngữ (chữ viết + từ thường gặp), bật sẵn file ngôn ngữ gốc. Dự án engine `files` hoặc kèm `extra`
    (mã giữ nguyên kiểu `generic`); sao lưu `CircleVault-ban-goc/`, đọc lại từ bản sao lưu. Engine chưa đọc được → `hints`.
    Ngữ cảnh cho Claude (`gametr._context`): `brief` (bối cảnh game – `POST /games/<id>/brief` để Claude tự đọc mẫu chữ rồi viết +
    thuật ngữ), `glossary` riêng game, `who`/`ctx` từng câu, `_sig` trong khóa bộ nhớ dịch. Không có API key: `GET /games/<id>/export`
    (file nhờ Claude chat dịch) → `POST /games/<id>/import` (JSON {"số": "dịch"}).
    Dịch bằng Claude chat (không API key): `POST /games/<id>/claude/pack {size: small|medium|large}` chia câu chưa dịch thành phần
    (~12k/30k/70k ký tự, `p["pack"]`), ghi `phan-xx.txt` + `00-HUONG-DAN.txt` vào `~/Downloads/CircleVault - Claude dich/<game>/`;
    `GET …/claude/parts/<n>` (nút Chép), `POST /import` đọc câu trả lời bằng `parse_reply` (cặp "số": "dịch", kể cả JSON bị ngắt),
    `…/claude/import-folder` đọc thư mục `tra-loi/`. Google: `translate._google` gộp nhiều câu một dòng vào một lượt gọi; bị chặn tạm
    thì Worker tự đợi rồi dịch tiếp (`p["note"]`).
    Unity MonoBehaviour (I2 Localization, hội thoại…): `langscan.mb_strings` dò chuỗi Unity (int32 độ dài + UTF-8 + đệm 0, vị trí chia
    hết 4) trong dữ liệu thô, `mb_pick` lọc câu đúng ngôn ngữ gốc, `mb_rewrite` ghi lại cả đối tượng (`set_raw_data`) – nguồn kind `mono`.
  - `xunity.py`: Unity "dịch khi chơi" – `POST /games/xunity-setup` tải BepInEx (5 cho Mono, 6 IL2CPP) + XUnity.AutoTranslator từ
    GitHub vào game (nhớ file đã thêm trong `DATA/translate/xunity/` để gỡ), AutoTranslatorConfig.ini: Endpoint=CustomTranslate,
    Url=`/api/translate/games/<id>/xunity` (GET from/to/text → câu đã có hoặc dịch Google, câu mới lưu vào dự án engine `xunity`).
    Áp dụng = `BepInEx/Translation/vi/Text/zz_CircleVault.txt` (định dạng XUnity, thoát \n \= \\ //) + sửa `_AutoGeneratedTranslations.txt`.
  - `unreal.py`: Unreal Engine – đọc .pak v1–v11 (theo repak; zlib/gzip/lz4, AES khi người dùng nhập khóa – `ScanStart.aes`;
    Oodle chưa), lấy `Content/Localization/<Target>/<culture>/*.locres` (locres v0–v3 theo UnrealLocres), dịch, áp dụng = mod
    `Content/Paks/~mods/zz_CircleVault_VI_P.pak` (cùng phiên bản pak gốc, không nén; giống hệt UnrealPak v5–v9), giữ khóa + mã băm.
    Không sửa pak gốc; Khôi phục = xóa file mod. Thử bằng file mẫu trong repo repak (tests/packs) và UnrealLocres (LocresLibTests/Data).
  - `novel.py`: truyện chữ (.txt/.epub không DRM/.html/.md/dán văn bản), tách chương, dịch nền theo lô đoạn (`kind="novel"`,
    SYSTEM_NOVEL), sửa từng đoạn, xuất EPUB3/TXT vào `<ổ truyện>/Truyen dich/`. DATA/translate/novels/<id>/novel.json.
  - `learn.py`: tab Học (`/api/learn/*`, chỉ máy này): môn ielts/ja/zh/ko → mục (`SUBJECTS`) → bộ thẻ (bảng `learn_decks`,
    `learn_cards` có cột SRS kiểu Anki, `learn_log` theo ngày học từ 4 giờ sáng). Bảng Hiragana/Katakana/Hangul/Pinyin có sẵn
    (`_builtin`). Dữ liệu khác nhập bằng `POST /api/learn/import` (JSON {"decks":[{subject,section,name,level,cards:[{front,reading,
    meaning,example,example_vi,extra}]}]} hoặc CSV/TSV) – định dạng ở docstring đầu file. Giao diện `frontend/js/learn.js`
    (thẻ ghi nhớ / trắc nghiệm / gõ đáp án, phím Space 1–4 Esc, đọc phát âm bằng speechSynthesis).
  - `learnplan.py` (thêm route vào `learn.router`): **Lộ trình chuẩn** = `backend/app/lotrinh/<môn>.json.gz` (dựng bằng
    `tools/lap_lo_trinh.py <nguồn>`: CEFR A1–C2 từ CEFR-J/Octanove cho IELTS, JLPT N5–N1, HSK 3.0 cấp 1–9, TOPIK I soạn sẵn; xếp theo
    tần suất wordfreq), chọn cấp → bộ thẻ `builtin = path:<môn>:<cấp>`, `settings.paths[môn] = {level, per_day}`. Nghĩa tiếng Việt
    thiếu thì dịch lúc học (`gloss_cards`, tối đa 8 giây; Google từng từ hoặc Claude viết nghĩa + câu ví dụ), cột `en` = nghĩa tiếng Anh
    gốc hiện tạm. Bài tập/kiểm tra: `GET /quiz?kind=practice|week|level` (mean/rev/listen/read/tf/cloze/spell/match), kết quả
    `POST /quiz/result` → bảng `learn_tests`, từ sai đưa về ôn ngay; kiểm tra tuần 7 ngày/lần, cuối cấp khi đã học 80% cấp, đạt 80%.
    "Hôm nay học gì": `GET/PUT/DELETE /today` (bảng `learn_plan`, số từ mới trong kế hoạch ghi đè `per_day`). Nhắc học: learn.js hỏi
    `/today` mỗi phút → huy hiệu trên tab Học + Notification lúc `remind_at` (một lần mỗi ngày).
  - `party.py`: phòng xem chung. `router` /api/party (chỉ app chính dùng) + `party_app` chạy cổng app+1 (chỉ có /r/<mã>,
    /r/<mã>/ws, /r/<mã>/media, tĩnh /p = frontend). Bạn bè/đường hầm chỉ chạm party_app, không thấy API chính.
    Đồng bộ: máy chủ giữ {playing,pos,rate,at}, client tự tính theo đồng hồ máy chủ (ping/pong).
    Nguồn: thư viện (`item_id`), file trên máy (`path`), YouTube, link trang phim (`link` → yt-dlp `resolve_link` chọn định dạng
    có cả hình + tiếng, mp4 hoặc HLS; yt-dlp không đọc được thì `_scan_page` tìm .m3u8 trong HTML/iframe (kiểm tra #EXTM3U);
    vẫn không có → HTTP 424 → trang gọi `cvDesktop.partyCapture` = mở trang trong trình duyệt app, `autoParty`: bắt được luồng
    thì đợi 3,5 giây rồi tự tạo phòng (HLS bắt được đầu tiên, không thì video lớn nhất)), luồng bắt được trong trình duyệt app (`stream` {url, kind, headers}). Luồng đi qua
    `/r/<mã>/media` + `/r/<mã>/x?u=&s=` (HMAC theo `Room.secret`, viết lại .m3u8, chuyển Range); `Room.public()` chỉ gửi
    `PUBLIC_KEYS` (không lộ link gốc/cookie/đường dẫn). Trang phòng dùng `frontend/vendor/hls.min.js` (hls.js 1.5.20) cho HLS.
  - `websites.py`: "Trang phim đã lưu" (`/api/web-sites`, chỉ máy này, `DATA/web-sites.json`, trùng tên miền thì thay): nút ☆ Lưu
    trang trên thanh công cụ trình duyệt (`saveSite` lưu gốc tên miền), ô ☆ Lưu ở Xem Online; chip bấm nhanh ở Xem Online (mở trang)
    và Xem Chung → Link trang phim (mở trang + tự tạo phòng).
  - `voice.py`: **Phòng Thoại** (chức năng như Discord, giao diện riêng). Một máy chủ (`DATA/voice/server.json`: tên, `code` mời, `host_key`, kênh `text`/`voice`,
    `bans` theo uid, `turn`) + tin nhắn `DATA/voice/msgs/<kênh>.jsonl` (gửi 150 tin gần nhất khi vào). Trang `/v/<code>` + WS `/v/<code>/ws`
    gắn vào `party.party_app` (cùng cổng/đường hầm với Xem Chung; `tunnel.stop` chỉ khi cả hai không dùng). WS: hello/profile/join/leave/
    sig (chỉ chuyển giữa 2 người CÙNG kênh thoại)/state/speak/chat/del + lệnh chủ phòng (mod smute|move-out|kick|ban, chan add|rename|del|move).
    Ảnh đại diện giữ trong bộ nhớ, phục vụ `/v/<code>/av/<id>`. API app `/api/voice` (local_only): trạng thái + link, PUT tên/mở-đóng,
    `/new-link`, `/turn` (Cloudflare: khóa API chỉ ở máy này, bạn bè nhận ICE tạm 24 giờ; hoặc TURN tĩnh), `/tunnel`. `VOICE_MAX`=10/kênh (mesh).
    Giao diện `frontend/voice.html` + `js/voice.js` + `css/voice.css` (kiểu "phòng khách", KHÔNG giống Discord – người dùng yêu cầu: phòng nói = thẻ màu
    `.lg-card` trong `#chList`, sân khấu `#voiceView` khi đang nói, chat bong bóng `.lg-msg` + chủ đề = tab `#chatTabs`, thanh nổi `.lg-hud`,
    online = cụm ảnh `#memBtn` → ngăn `#people`; màn hẹp chuyển `data-gopane` rooms/chat): WebRTC perfect negotiation, LỌC GIỌNG ở máy từng người
    (high-pass 90 Hz → RNNoise/GTCRN/Speex qua `vendor/ns` = @sapphi-red/web-noise-suppressor 0.4.1 → gain → analyser → cổng mic theo
    ngưỡng tự động/tay hoặc Nhấn để nói → MediaStreamDestination; track gửi đi không đổi khi đổi bộ lọc/micro), nghe ≤100% qua <audio>
    (giữ khử vọng), >100% qua Web Audio; âm lượng/tắt tiếng riêng theo uid (localStorage). Hồ sơ trong phòng: tên, trạng thái, ảnh (160px),
    màu, khung (`FRAMES` – CSS tự vẽ `.fr-*`). Tab **Phòng Thoại** (`js/voicetab.js`, `#voice`): link mời/đường hầm/TURN + iframe `?embed=1`
    giữ nguyên khi đổi tab; iframe ↔ trang cha postMessage (`cvVoiceState` / `cvVoice`). Electron `desktop/src/voice.js`: phím tắt toàn
    cục Ctrl+Shift+M/D chỉ khi đang trong kênh, Nhấn để nói toàn cục bằng `uiohook-napi` (asarUnpack; chỉ bật khi trong kênh + chế độ PTT),
    khung nổi `voice-overlay.html` (trong suốt, bấm xuyên qua, hiện khi app không được chọn). Android: `ui/Party.kt` nhận link `/v/`,
    `onPermissionRequest` → xin RECORD_AUDIO; `/api/phone/party` trả thêm `voice` (link phòng thoại của máy tính).
  - `tunnel.py`: cloudflared quick tunnel → party_app (tải cloudflared vào DATA/bin lần đầu).
  - Tác vụ có cột `headers` (JSON Referer/Origin/User-Agent/Cookie) cho link phim bắt từ trình duyệt → `http_headers` yt-dlp.
  - Tài khoản YouTube: app desktop ghi `DATA/youtube-cookies.txt`; `downloader._account` dùng bản sao cho link YouTube.
    Bản riêng từng nguồn: `youtube-cookies-trinh-duyet.txt` (`_save_jar`: tiện ích/hộp Đăng nhập) và `youtube-cookies-app.txt` (browser.js);
    tiện ích vừa gửi (≤ 3 giờ) thì cửa sổ app chỉ ghi bản riêng, không ghi đè file chính (Google xoay vòng cookie từng nơi). `ytinner.home` thử
    lần lượt `downloader.youtube_cookie_candidates()`, bản nào YouTube coi là chưa đăng nhập (`logged_out`: mất LOGIN_INFO, `loggedOut`,
    `LOGGED_IN` false) thì bỏ, bản dùng được thì `promote_cookies` chép đè file chính; hết bản → `ytinner.Stale` → `_home` trả `stale` +
    `_local_sections` ("video tiếp theo" của video mở gần đây trong tab YouTube, `DATA/yt-xem-gan-day.json`).
    Google hay chặn đăng nhập trong cửa sổ nhúng → hộp "Đăng nhập YouTube" (`CV.ytLogin`, watch.js): lấy cookie từ trình duyệt
    của người dùng (`POST /api/youtube/import`, yt-dlp đọc) hoặc file cookies.txt (`/api/youtube/import-file`), rồi
    `cvDesktop.youtubeImport` nạp vào partition `persist:youtube`. Không giả danh trình duyệt để lách kiểm tra của Google.
    Cách chính: tiện ích Chrome/Edge `backend/extension/` (MV3, cài "Load unpacked" từ `DATA/tien-ich-trinh-duyet`, do
    `POST /api/youtube/extension` chép ra) đọc cookie youtube/google của trình duyệt, dò cổng 8686–8705 qua `/api/youtube/hello`,
    gửi `import-file?source=extension` (bắt buộc header `X-CircleVault: 1` chống trang lạ gửi), gửi lại khi cookie *SID đổi
    và mỗi 30 phút. `browser.js`: file mới hơn lần đồng bộ (`fileSeen`) thì nạp vào cửa sổ YouTube trước, không ghi đè – nhưng cửa sổ YouTube ĐANG đăng nhập thì
    bỏ qua hẳn (nạp cookie khi trang đang mở làm YouTube tự tải lại, ngắt nhạc) – chỉ hộp Đăng nhập YouTube (`youtube-import`, `force`)
    mới nạp đè; khi đó cùng `SID` thì thôi, khác tài khoản thì tải lại đúng trang. Nhật ký ghi "YouTube nạp cả trang" mỗi lần nạp cả trang.
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
    tải tạm vào `DATA/cache/nghe-online` (tối đa 600 MB) rồi phát file; nút "＋ Playlist" (`#pbAdd`) trên thanh phát: bài online
    → `pickPlaylist({ou})` tạo tác vụ MP3 có `music_playlist` (tải xong tự vào playlist); bỏ định dạng mã hóa (`NO_DRM`) – Spotify/Apple Music có DRM, không làm.
  - `ytvideo.py`: tab **YouTube** (giao diện CircleVault, `frontend/js/youtube.js`, `/api/yt/*`, chỉ máy này): dữ liệu bằng yt-dlp phẳng
    (`ytmusic._ydl_info`, cookie qua `downloader._account` nên dùng URL youtube.com: `/` = đề xuất, `/feed/subscriptions`, `list=WL/LL`,
    `/feed/history`; `ytsearch40:`; kênh `/channel/<id>/videos`), nhớ 5–10 phút trong bộ nhớ; `video?v=` = chi tiết (`_process=False`)
    + liên quan (tìm theo tiêu đề + video cùng kênh). Trang chủ rỗng (tài khoản tắt Lịch sử xem / cookie hết hạn) → `_home` ghép `sections`: mới từ kênh đăng ký + giống video đã xem/đã thích, kèm `note` (cảnh báo yt-dlp qua `_warn`). `ytinner.py`: gọi thẳng InnerTube bằng hàm của yt-dlp (IE YoutubeTab + cookie tài khoản): trang chủ = `_extract_data(/feed/recommended, FEwhat_to_watch)` + 2 lượt continuation (yt-dlp tự lấy /feed/recommended thì rỗng), trang xem = endpoint `next` (chi tiết + "video tiếp theo" thật); mục video đọc bằng `_extract_lockup_view_model`/`_extract_video` (`_walk`). Phát video bằng **trình phát của app**: `GET /api/yt/play` chọn định dạng (hình riêng theo độ phân giải, ưu tiên avc1; tiếng m4a) → `<video>` + `<audio>` chạy khớp nhau (youtube.js `setupPlayer`), luồng qua `/api/yt/s/<id>/<format>` (Range 8 MB, hết hạn thì lấy lại); thanh điều khiển riêng `.ytc` (không dùng controls gốc: phát, tua ±10 s, âm lượng, tốc độ, chất lượng, PiP, toàn màn hình `#ywPlayer`, phím Space/←→/↑↓/M/F); tiếng = một `<audio>` cố định + `CV.eq.Engine` riêng, áp cùng cài đặt EQ với Nghe Nhạc (`CV.music.eq()`, sự kiện `cv-eq`, `setPreset`); trực tiếp/không có luồng → iframe `youtube.com/embed` (lỗi thì "Mở bằng trình duyệt YouTube"). Trước đây iframe trong khung
    của app; nút Tải video/MP3 (`/api/tasks`), Xem chung, Mở bằng trình duyệt YouTube (bị chặn nhúng). `browser.js` `mirrorToMain`
    chép cookie YouTube/Google sang `session.defaultSession` để trình phát nhúng nhận tài khoản (Premium không quảng cáo).
    Mở video thì phát sự kiện `cv-video-play` → music.js tạm dừng nhạc.
    Tab tên **Mạng xã hội** (hash vẫn `#youtube`), trang ghi "YouTube" (người dùng bỏ tên CVTube; đang chờ chọn bản vẽ giao diện mới – artifact
    "Mạng xã hội – YouTube (bản xem trước)": A thanh bên trái / B kệ ngang / C trang xem + Facebook). Hiện tại: thanh `.yt-top` + tab `.yt-tab`,
    thẻ Nổi bật `.yt-grid.hero`, huy hiệu kênh `.yv-av`. **Phát nền**: rời tab không dừng video; thanh `#ytBar` (`.pbar.ytbar`, `body.yt-bar` ẩn
    thanh nhạc) điều khiển `#ywV`/`ytAudio`; ✕ = `stopPlayer` + `barOff`; music.js phát → sự kiện `cv-music-play` → video dừng.
    Danh sách kết hợp: `ytinner._list_lockup`/`_list_renderer` (lockup playlist/radioRenderer → `_type: list`, video đầu từ watchEndpoint),
    `ytvideo._pl` → thẻ `kind: list` (`.yl`, chồng lớp); mở = `/video?v=<đầu>&list=` → `watch_next(v, plist)` trả `queue` (playlistPanelRenderer)
    → khung `#ywQueue`; `/list?l=` lấy video đầu khi thiếu. Tự phát (`cv-yt-auto`): hết video → bài sau trong queue / video Tiếp theo.
    Làm mới (`refresh=1`): `ytinner.home(6, 160)` + `_fresh` (mục chưa hiện trong `_SHOWN` lên trước, mục cũ đảo).
  - `discover.py`: Khám phá nhạc (`/api/music/discover/*`, chỉ máy này, thư viện ytmusicapi): `home` (Gợi ý cho bạn = trộn radio của
    bài trên máy hay nghe/mới tải có [id], Mix, trang chủ YouTube Music khi đã đăng nhập – cookie `YT_COOKIES` → header SAPISIDHASH,
    bảng xếp hạng + ca sĩ theo `config.music_country` (mặc định VN), chip tâm trạng = tìm kiếm), `radio?v=` (bài tương tự; nút ≈ và tự
    phát khi hết danh sách – `settings.autoplay`), `suggest?q=` (gợi ý từ khóa), `artist?b=`. Nhớ 3 giờ ở `DATA/cache/kham-pha.json`.
  - `edit.py`: router `/api/edit/*` – cắt đoạn (`POST /{item|track}/{id}/cut` {start,end,accurate}) và chuyển MP4 (`/mp4`) bằng ffmpeg
    trong thread, tiến độ `GET /jobs/{id}`. Luôn ghi FILE MỚI cạnh file gốc (không ghi đè/xóa gốc) rồi thêm vào thư viện/Nghe Nhạc.
    Cắt nhanh = `-c copy` (lệch theo keyframe), chính xác = H.264/AAC. Giao diện: `openCutter` trong app.js (hộp #player).
  - `phone.py`: "Mang theo điện thoại" – trang `/dt` (frontend/dt.html, js/dt.js, css/dt.css) cho điện thoại cùng Wi-Fi (cần chế độ
    `host` 0.0.0.0; tab Lưu Trữ có QR `/api/phone/qr.svg` (segno) + nút bật & khởi động lại). Điện thoại tải nhạc/phim như FILE THƯỜNG
    (trình duyệt Android không cho trang chọn ổ lưu, http trong mạng nhà không chạy offline được – người dùng đã chọn cách này):
    chọn bộ nhớ máy/thẻ nhớ trong cài đặt Tải xuống của Chrome, phát bằng app của điện thoại/VLC, xóa bằng app Files.
    Playlist = gói .zip không nén ghi thẳng ra luồng (thư mục `<tên>/` + .m3u8, Content-Length tính bằng lượt chạy thử, zip64 khi >4 GB)
    hoặc tải từng bài `?n=` + `.m3u8`. API chỉ đọc. `GET /api/phone/playlists` trả kèm `ids` (bài còn file, đúng thứ tự) để app
    Android so với bài đã tải: nút "Cập nhật +N" / "Cập nhật tất cả" (`MainVM.plSync`, `downloadPlaylist` lấy lại danh sách,
    giữ bài id âm của điện thoại, không xóa file). Nút "＋ Playlist" trên màn hình đang phát + menu bài (`MainVM.adding`,
    `PlaylistPicker`): bài có trên điện thoại thêm ngay, bài online lưu về (`YouTube.saveJob` kèm playlist) – playlist tạo trên điện
    thoại có id âm (`playlistIdFor("pl:"+tên)`); báo máy tính kèm tên playlist → khung "Điện thoại vừa lưu…" (music.js hỏi lại 30 giây/lần).
  - `devices.py`: ghép thiết bị cho chế độ Wi-Fi – middleware `Guard` (máy tính 127.0.0.1 luôn qua; thiết bị khác cần cookie `cv_dev`,
    lưu băm SHA-256 ở `DATA/devices.json`; quyền `phone` = chỉ /dt + /api/phone/*, `full` = như máy tính). Mã ghép 8 ký tự, 10 phút,
    dùng một lần, sai 20 lần/10 phút thì khóa. Tab Lưu Trữ: danh sách thiết bị (đổi quyền, đổi tên, thu hồi) + nút Thêm thiết bị (QR). Thử tên file tiếng Việt bằng Playwright trên Linux cần `LANG=C.UTF-8`.
  - `gdrive.py`: Google Drive trên PC, router `/api/gdrive/*` (chỉ máy này). OAuth client "Desktop app" người dùng tự tạo (nhập file JSON
    ở tab Lưu Trữ), đăng nhập loopback `/api/gdrive/auth/callback` (PKCE), nhiều tài khoản + tài khoản đang chọn + thư mục gốc
    (đổi được; drive.file chỉ thấy thư mục app tạo), DATA/gdrive.json giữ refresh token. Tải lên resumable 8 MB/phần, playlist = thư mục
    con, nhớ file đã tải (`uploaded`) để không trùng. Nút "☁ Lưu lên Drive" ở Nghe Nhạc. Hướng dẫn tạo client: artifact "Kết nối Google Drive".
  - Video tải về luôn ra .mp4 (`FFmpegVideoRemuxer`, cấu hình `video_format`: mp4 | original).
  - `ytdlp_update.py`: tải wheel yt-dlp (+ yt-dlp-ejs đúng phiên bản) từ PyPI vào `DATA/pylib`; `app/__init__.py` ưu tiên thư mục này.
- `frontend/` – JS thuần, không build. **Kiểu giao diện** (`STYLES` trong app.js: brutal/tron/mem/phang/kinh, chọn trong hộp theme):
  CSS dùng `--rk` (nhân bo góc: mọi `border-radius` viết `calc(Npx*var(--rk,1))`), `--hs` (thay mọi bóng cứng `var(--hs,Npx Npx 0 var(--ink))`),
  `--ink`, `--bw`; khối `:root[data-style=…]` cuối app.css. Đổi kiểu bắt khởi động lại: lưu `cv-style-next`, script đầu index.html chỉ
  áp dụng ở phiên mới (`sessionStorage` cv-started), nút "Khởi động lại ngay" = `cvDesktop.relaunch` (app.relaunch, bản portable dùng
  `PORTABLE_EXECUTABLE_FILE`). CSS mới: viết bo góc/bóng theo cùng mẫu để kiểu nào cũng đúng. **Font chữ** (`FONTS`/`setFont` trong app.js,
  hộp theme): `data-font` = tahoma|consolas|times đổi `--f-body` (khối `:root[data-font=…]` trong app.css), localStorage `cv-font`, áp dụng NGAY
  (script đầu index.html/party.html/dt.html; iframe phòng thoại nhận `&font=`) – CSS mới luôn dùng `var(--f-body)`/`var(--f-mono)`, không ghi tên font cứng. Thanh cuộn theo theme: `::-webkit-scrollbar` trong app.css (KHÔNG đặt `scrollbar-color`/
  `scrollbar-width` chung – Chromium mới có hai thuộc tính đó thì bỏ qua ::-webkit-scrollbar). Khám phá vẽ lại thì giữ `scrollLeft` từng `.dc-shelf`. Theme màu: `THEMES` trong app.js + khối `:root[data-theme=…]` trong app.css (localStorage `cv-theme`, không có = theo Windows). `js/app.js` định nghĩa `window.CV` (api, esc, toast, fmt…, `views`) dùng chung cho
  `js/eq.js` (Engine Web Audio + giao diện EQ 10 dải, preset `PRESETS`) và `js/music.js` (thư viện nhạc, thanh phát nhạc).
  `js/watch.js`: tab Xem Online + Xem Chung. `party.html` + `js/party.js`: trang phòng (không dùng app.js).
  `js/translate.js`: tab Dịch – menu nhóm bên trái (`NAV`): Truyện tranh, Truyện chữ / Việt hóa game, Gói Việt hóa có sẵn, Dịch màn hình
  game / Dịch nhanh, Cài đặt. `js/learn.js`: tab Học.
  Định tuyến bằng hash: `#home #queue #library #music #youtube #online #party #voice #translate #learn #storage` (tab `#youtube` tên "Mạng xã hội", `#storage` tên "Cài đặt").
- `desktop/` – Electron theo mẫu repo `aq-autotest` (`desktop/`): `main.js` chạy `pythonw -m app` bằng Python nhúng
  (`resources/python`, ._pth có `..\app\backend`), mã ở `resources/app/{backend,frontend}`, ffmpeg + Deno ở `resources/bin`
  (thêm vào PATH backend). Cầu nối trang ↔ app: `window.cvDesktop` (onUpdate/getUpdate/updateAct/pickFolder/restartServer).
  `browser.js`: trình duyệt NẰM TRONG cửa sổ chính (người dùng không muốn cửa sổ bật riêng): thanh công cụ (`browser.html`,
  WebContentsView) + WebContentsView trang web gắn vào `win.contentView`, đè lên `.dock-area` của tab Xem Online / Xem Chung;
  trang báo vị trí qua `cvDesktop.dockRect(mode, rect|null)` mỗi 200 ms (null khi đổi tab/mở `<dialog>`), chế độ `party` = trang
  phòng không có thanh công cụ; nút "Xem chung" (video YouTube / luồng bắt được) → `POST /api/party` → trang chuyển #party; partition `persist:youtube`
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
  Đợt 3: tab Online chia YouTube / Google Drive / Xem chung. `Drive.kt`: Google Identity AuthorizationClient (quyền drive.file,
  client Android theo gói + SHA-1 khóa ký), nhiều tài khoản (Prefs.gdAccounts/gdActive), chọn thư mục gốc; phát `cvgd://<id>?a=<email>`
  (ResolvingDataSource gắn Bearer), tải về (`DJob.drive`, OTrack.gd), đưa bài lên (resumable). `ui/Party.kt`: `GET /api/phone/party`
  → phòng đang mở trên PC; vào phòng bằng link/QR → WebView trang phòng (toàn màn hình qua onShowCustomView).
  **TẠM DỪNG APK (11/2026, người dùng yêu cầu tới tháng sau)**: job `android` ở release.yml + kiem-tra.yml có `if: false`; không sửa
  `android/` trong thời gian này. Bật lại = xóa dòng `if: false`.
  Phát hành: job `android` trong release.yml đính `CircleVault-Android.apk` vào Release 2 repo; link cố định
  `…/circlevault-releases/releases/latest/download/CircleVault-Android.apk`.
- **Có gì mới**: `frontend/thay-doi/thay-doi.json` (`entries`, mục MỚI NHẤT ở đầu, `id` không trùng) – MỖI LẦN PHÁT HÀNH thêm một mục. PC: `showWhatsNew` (app.js) hiện cuộn giấy `dialog.scroll-dlg` với mục chưa xem (`cv-notes-seen`), nút "📜 Có gì mới" ở Lưu Trữ. APK: file đóng gói vào assets (`sourceSets…assets.srcDirs`), `ui/WhatsNew.kt` (`ScrollNotes`, Prefs.notesSeen), nút ở Cài đặt. release.yml lấy mục đầu làm ghi chú Release. APK có **Kiểu giao diện** (`UiStyle` trong Theme.kt đọc Prefs.uiStyle MỘT LẦN, `brutal()` đổi bo góc/viền/bóng theo kiểu; đổi kiểu → `restartApp`).
- **Addon (thành phần gỡ được)**: `desktop/src/addons/<tên>.js` (`setup(ctx)`, `attach(win)`, tự nạp bởi `addons/index.js`; kênh chung
  `cvDesktop.addon(tên, tin)` / `onAddon`) + `frontend/addons/<tên>/` (tự chèn giao diện, không sửa mã tab khác) + 1 dòng `<script>` trong
  index.html. **Facebook (THỬ NGHIỆM, nhánh `thu-nghiem-facebook`, CHƯA vào main – chờ người dùng test)**: nút "Facebook" chèn vào thanh
  CVTube → khung cố định bên phải (`.fbx`, giao diện kiểu Facebook, kéo mép đổi rộng, `body.fbx-on` chừa chỗ), trang facebook.com thật trong
  WebContentsView `persist:facebook` đè lên `.fbx-body` (vị trí báo mỗi 200 ms; ẩn khi có dialog/hộp theme/menu/toàn màn hình), mặc định tắt
  tiếng, chỉ mở link facebook.com/messenger.com, link khác ra trình duyệt ngoài. App không đọc dữ liệu Facebook. Cách gỡ: `frontend/addons/facebook/GO-BO.txt`.
- `tools/dong_goi_app.py` chuẩn bị `desktop/res/`; `tools/kiem_tra.py` kiểm tra cú pháp + liên kết file + đường dẫn `/api/…` bị đổi thành địa chỉ ngoài (`kiem_url_la`).

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
