'use strict';
// Cầu nối trang CircleVault (http://127.0.0.1:<cổng>) ↔ app: cập nhật, chọn thư mục, khởi động lại backend,
// mở cửa sổ YouTube / trình duyệt bắt link phim, mở phòng xem chung, mở khung dịch màn hình.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cvDesktop', {
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  getUpdate: () => ipcRenderer.invoke('update-get'),
  updateAct: () => ipcRenderer.send('update-act'),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  openBrowser: (mode, url) => ipcRenderer.send('open-browser', mode, url),   // 'youtube' | 'web'
  openParty: (url) => ipcRenderer.send('open-party', url),
  youtubeLogout: () => ipcRenderer.invoke('youtube-logout'),
  onYoutubeLogin: (cb) => ipcRenderer.on('youtube-login', (_e, v) => cb(v)),
  openScreenTranslate: () => ipcRenderer.send('open-screen-translate'),   // khung dịch màn hình game
  quit: () => ipcRenderer.send('quit'),
});
