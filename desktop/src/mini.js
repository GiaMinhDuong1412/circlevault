'use strict';
/**
 * Trình phát mini: thu nhỏ cửa sổ chính khi đang có bài nhạc → hiện khung nhỏ luôn nằm trên cùng (đĩa nhạc xoay + tên bài
 * + thanh tua + nút điều khiển). Nhạc vẫn phát trong cửa sổ chính (music.js); khung mini chỉ gửi lệnh qua app.
 * Mở lại cửa sổ chính thì khung mini tự ẩn. Bấm × trên khung mini = ẩn tới lần thu nhỏ sau.
 */
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const W = 400;
const H = 140;

let ctx = null;          // {userData, icon, log}
let main = null;         // cửa sổ chính
let mini = null;
let state = { has: false, mini: true };
let pos = null;

const posFile = () => path.join(ctx.userData, 'trinh-phat-mini.json');

function setup(options) {
  ctx = options;
  try { pos = JSON.parse(fs.readFileSync(posFile(), 'utf8')); } catch { /* lần đầu */ }
  ipcMain.on('music-state', (_e, s) => {
    state = s && typeof s === 'object' ? s : { has: false };
    if (mini && !mini.isDestroyed()) {
      if (!state.has || state.mini === false) hide();
      else mini.webContents.send('mstate', state);
    }
  });
  ipcMain.handle('mini-state', () => state);
  ipcMain.on('mini', (_e, m) => onMessage(m || {}));
}

function attach(win) {
  main = win;
  win.on('minimize', () => { if (state.has && state.mini !== false) show(); });
  for (const ev of ['restore', 'show', 'focus', 'maximize']) win.on(ev, () => { if (!win.isMinimized()) hide(); });
  win.on('closed', () => { main = null; if (mini && !mini.isDestroyed()) mini.destroy(); });
}

function cmd(a, v) { if (main && !main.isDestroyed()) main.webContents.send('music-cmd', { a, v }); }

function onMessage(m) {
  switch (m.a) {
    case 'open':
      if (main && !main.isDestroyed()) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); }
      return hide();
    case 'close': return hide();
    case 'toggle': case 'prev': case 'next': case 'seek': case 'shuffle': case 'repeat': case 'vol': case 'mute':
      return cmd(m.a, m.v);
    default:
  }
}

function where() {
  const wa = screen.getPrimaryDisplay().workArea;
  if (pos && screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return pos.x >= b.x - 20 && pos.y >= b.y - 20 && pos.x + W <= b.x + b.width + 20 && pos.y + H <= b.y + b.height + 20;
  })) return pos;
  return { x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16 };
}

function show() {
  if (mini && !mini.isDestroyed()) { mini.webContents.send('mstate', state); mini.showInactive(); return; }
  const p = where();
  mini = new BrowserWindow({
    x: p.x, y: p.y, width: W, height: H, frame: false, transparent: true, resizable: false, maximizable: false,
    minimizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    title: 'Đang phát · CircleVault', icon: ctx.icon, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'mini-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mini.setAlwaysOnTop(true, 'floating');
  mini.setMenu(null);
  mini.loadFile(path.join(__dirname, 'mini.html'));
  mini.once('ready-to-show', () => { if (mini) { mini.webContents.send('mstate', state); mini.showInactive(); } });
  mini.on('moved', () => {
    if (!mini || mini.isDestroyed()) return;
    const b = mini.getBounds();
    pos = { x: b.x, y: b.y };
    try { fs.writeFileSync(posFile(), JSON.stringify(pos)); } catch { /* bỏ qua */ }
  });
  mini.on('closed', () => { mini = null; });
}

function hide() { if (mini && !mini.isDestroyed()) mini.hide(); }

module.exports = { setup, attach, show, hide, _state: () => ({ open: !!(mini && !mini.isDestroyed() && mini.isVisible()), state }) };
