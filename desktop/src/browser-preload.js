'use strict';
// Cầu nối thanh công cụ của cửa sổ trình duyệt (browser.html) ↔ app. Trang web bên dưới KHÔNG có preload này.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bshell', {
  send: (a, extra) => ipcRenderer.send('bshell', { a, ...(extra || {}) }),
  onState: (cb) => ipcRenderer.on('bstate', (_e, s) => cb(s)),
  onToast: (cb) => ipcRenderer.on('btoast', (_e, t) => cb(t)),
});
