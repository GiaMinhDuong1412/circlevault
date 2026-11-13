'use strict';
// Cầu nối trang CircleVault (http://127.0.0.1:<cổng>) ↔ app: cập nhật, chọn thư mục, khởi động lại backend,
// mở YouTube / trình duyệt bắt link phim / phòng xem chung (nhúng trong cửa sổ chính), mở khung dịch màn hình,
// trình phát mini (gửi trạng thái nhạc, nhận lệnh điều khiển).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cvDesktop', {
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  getUpdate: () => ipcRenderer.invoke('update-get'),
  updateAct: () => ipcRenderer.send('update-act'),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  pickFile: (title, exts) => ipcRenderer.invoke('pick-file', title, exts),   // exts: ['zip']
  restartServer: () => ipcRenderer.invoke('restart-server'),
  relaunch: () => ipcRenderer.send('app-relaunch'),   // tắt hẳn rồi mở lại app (đổi kiểu giao diện)
  openBrowser: (mode, url) => ipcRenderer.send('open-browser', mode, url),   // 'youtube' | 'web'
  openParty: (url) => ipcRenderer.send('open-party', url),
  partyCapture: (url, opts) => ipcRenderer.send('party-capture', url, opts),   // mở trang phim, bấm phát → tự tạo phòng xem chung
  // trình duyệt / phòng xem chung nằm ngay trong cửa sổ chính, đè lên vùng .dock-area của trang
  dockRect: (mode, rect) => ipcRenderer.send('dock-rect', mode, rect),   // rect null = ẩn
  dockClose: (mode) => ipcRenderer.send('dock-close', mode),
  dockState: () => ipcRenderer.invoke('dock-state'),
  onDock: (cb) => ['dock-open', 'dock-closed', 'dock-state', 'party-go', 'sites-changed'].forEach((ch) => ipcRenderer.on(ch, (_e, v) => cb(ch, v))),
  youtubeLogout: () => ipcRenderer.invoke('youtube-logout'),
  youtubeImport: () => ipcRenderer.invoke('youtube-import'),   // nạp cookie lấy từ trình duyệt của người dùng vào cửa sổ YouTube
  onYoutubeLogin: (cb) => ipcRenderer.on('youtube-login', (_e, v) => cb(v)),
  openScreenTranslate: () => ipcRenderer.send('open-screen-translate'),   // khung dịch màn hình game
  musicState: (st) => ipcRenderer.send('music-state', st),               // trình phát mini khi thu nhỏ app
  onMusicCmd: (cb) => ipcRenderer.on('music-cmd', (_e, m) => cb(m)),
  // phòng thoại: trạng thái (khung nổi khi chơi game, phím tắt toàn cục) ↔ lệnh từ phím tắt toàn cục
  voiceState: (st) => ipcRenderer.send('voice-state', st),
  onVoiceCmd: (cb) => ipcRenderer.on('voice-cmd', (_e, c) => cb(c)),
  quit: () => ipcRenderer.send('quit'),
});
