'use strict';
// Cầu nối trang CircleVault (http://127.0.0.1:<cổng>) ↔ app: cập nhật, chọn thư mục, khởi động lại backend.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cvDesktop', {
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  getUpdate: () => ipcRenderer.invoke('update-get'),
  updateAct: () => ipcRenderer.send('update-act'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  quit: () => ipcRenderer.send('quit'),
});
