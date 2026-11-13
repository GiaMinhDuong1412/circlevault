'use strict';
// Khung nổi phòng thoại: chỉ nhận trạng thái (ai đang nói), không gửi gì về app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cvOverlay', {
  onState: (cb) => ipcRenderer.on('vstate', (_e, s) => cb(s)),
});
