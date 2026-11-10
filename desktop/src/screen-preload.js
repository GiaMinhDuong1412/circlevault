'use strict';
// Cầu nối khung dịch màn hình (screen.html) và cửa sổ chọn vùng (region.html) ↔ app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sshell', {
  send: (a, extra) => ipcRenderer.send('sshell', { a, ...(extra || {}) }),
  state: () => ipcRenderer.invoke('sshell-state'),
  onState: (cb) => ipcRenderer.on('sstate', (_e, s) => cb(s)),
  onStatus: (cb) => ipcRenderer.on('sstatus', (_e, s) => cb(s)),
  onResult: (cb) => ipcRenderer.on('sresult', (_e, r) => cb(r)),
  onShot: (cb) => ipcRenderer.on('sshot', (_e, s) => cb(s)),
});
