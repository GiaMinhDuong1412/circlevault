'use strict';
// Cầu nối trình phát mini (mini.html) ↔ app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mshell', {
  send: (a, v) => ipcRenderer.send('mini', { a, v }),
  state: () => ipcRenderer.invoke('mini-state'),
  onState: (cb) => ipcRenderer.on('mstate', (_e, s) => cb(s)),
});
