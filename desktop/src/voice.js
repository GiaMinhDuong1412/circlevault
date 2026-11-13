'use strict';
/**
 * Phòng thoại khi chơi game (tab Phòng Thoại = iframe trang /v/<mã> trong cửa sổ chính):
 * - Phím tắt toàn cục Ctrl+Shift+M (mic) / Ctrl+Shift+D (nghe): CHỈ đăng ký khi đang ở trong kênh thoại, rời kênh là trả lại.
 * - Nhấn để nói toàn cục: uiohook-napi (móc phím mức thấp như Discord/OBS) – chỉ chạy khi đang trong kênh + chế độ Nhấn để nói,
 *   chỉ so phím đã chọn, không ghi lại phím nào. Không có thư viện (lỗi nạp) thì Nhấn để nói chỉ chạy khi cửa sổ app đang mở.
 * - Khung nổi (overlay): cửa sổ nhỏ trong suốt, luôn trên cùng, chuột bấm xuyên qua – hiện ai đang nói khi app không được chọn
 *   (đang ở trong game để chế độ cửa sổ/không viền). Không chèn gì vào game (tránh anti-cheat).
 */
const { BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');

const W = 260;
let ctx = null;            // {icon, log}
let main = null;
let ov = null;
let st = { voice: null };
let keysOn = false;
let U = null;              // uiohook-napi (false = không dùng được)
let hookOn = false;
let pttCode = null;
let pttDown = false;

function setup(options) {
  ctx = options;
  ipcMain.on('voice-state', (e, s) => {
    if (!main || main.isDestroyed() || e.sender !== main.webContents) return;
    st = clean(s);
    update();
  });
}

function clean(s) {
  s = s && typeof s === 'object' ? s : {};
  const str = (v, n) => String(v ?? '').slice(0, n);
  return {
    voice: s.voice ? str(s.voice, 60) : null, mute: !!s.mute, deaf: !!s.deaf, mode: s.mode === 'ptt' ? 'ptt' : 'vad',
    pttKey: str(s.pttKey, 30), overlay: s.overlay !== false, corner: ['tl', 'tr', 'bl', 'br'].includes(s.corner) ? s.corner : 'tl',
    people: Array.isArray(s.people) ? s.people.slice(0, 12).map((p) => ({
      name: str(p.name, 32), color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '', talk: !!p.talk, mute: !!p.mute, deaf: !!p.deaf,
      av: /^(data:image\/|http:\/\/127\.0\.0\.1:\d+\/v\/)/.test(p.av || '') ? str(p.av, 300000) : '',
    })) : [],
  };
}

function attach(win) {
  main = win;
  for (const ev of ['blur', 'focus', 'minimize', 'restore', 'show', 'hide']) win.on(ev, () => setTimeout(update, 50));
  win.on('closed', () => { main = null; st = { voice: null }; update(); if (ov && !ov.isDestroyed()) ov.destroy(); });
}

function send(cmd) { if (main && !main.isDestroyed()) main.webContents.send('voice-cmd', cmd); }

function update() {
  const active = !!st.voice;
  if (active && !keysOn) {
    try {
      globalShortcut.register('CommandOrControl+Shift+M', () => send('mute'));
      globalShortcut.register('CommandOrControl+Shift+D', () => send('deaf'));
      keysOn = true;
    } catch (e) { ctx.log('Không đăng ký được phím tắt phòng thoại:', e.message); }
  } else if (!active && keysOn) {
    globalShortcut.unregister('CommandOrControl+Shift+M');
    globalShortcut.unregister('CommandOrControl+Shift+D');
    keysOn = false;
  }
  setPtt(active && st.mode === 'ptt' ? st.pttKey : null);
  const away = !!main && !main.isDestroyed() && (main.isMinimized() || !main.isFocused() || !main.isVisible());
  if (active && st.overlay && away) showOv(); else hideOv();
  if (ov && !ov.isDestroyed()) ov.webContents.send('vstate', st);
}

// ---------------------------------------------------------------- nhấn để nói toàn cục
function lib() {
  if (U === null) {
    try { U = require('uiohook-napi'); } catch (e) { U = false; ctx.log('Nhấn để nói toàn cục không dùng được:', e.message); }
  }
  return U;
}

const NAMES = {
  ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight', AltLeft: 'Alt', AltRight: 'AltRight',
  MetaLeft: 'Meta', MetaRight: 'MetaRight', NumpadMultiply: 'NumpadMultiply', NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract',
  NumpadDecimal: 'NumpadDecimal', NumpadDivide: 'NumpadDivide', NumpadEnter: 'NumpadEnter',
};
function keycode(code) {
  const K = U.UiohookKey;
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return K[m[1]];
  if ((m = /^Digit(\d)$/.exec(code))) return K[m[1]];
  return K[NAMES[code] || code];
}
function isMine(e, mouse) {
  if (!pttCode) return false;
  const m = /^Mouse(\d)$/.exec(pttCode);
  if (mouse) return !!m && Number(e.button) === Number(m[1]);
  return !m && e.keycode === keycode(pttCode);
}
function press(down) {
  if (down === pttDown) return;
  pttDown = down;
  send(down ? 'ptt-down' : 'ptt-up');
}
function setPtt(code) {
  if (code === pttCode) return;
  pttCode = code || null;
  if (pttDown && !pttCode) press(false);
  const L = lib();
  if (!L) return;
  try {
    if (pttCode && !hookOn) {
      if (!L.__cvBound) {
        L.uIOhook.on('keydown', (e) => { if (isMine(e)) press(true); });
        L.uIOhook.on('keyup', (e) => { if (isMine(e)) press(false); });
        L.uIOhook.on('mousedown', (e) => { if (isMine(e, true)) press(true); });
        L.uIOhook.on('mouseup', (e) => { if (isMine(e, true)) press(false); });
        L.__cvBound = true;
      }
      L.uIOhook.start();
      hookOn = true;
    } else if (!pttCode && hookOn) {
      L.uIOhook.stop();
      hookOn = false;
    }
  } catch (e) { ctx.log('Lỗi Nhấn để nói toàn cục:', e.message); U = false; }
}

// ---------------------------------------------------------------- khung nổi
function place() {
  const wa = (main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()).workArea;
  const h = 40 + Math.max(1, st.people.length) * 38;
  const x = st.corner.endsWith('r') ? wa.x + wa.width - W - 12 : wa.x + 12;
  const y = st.corner.startsWith('b') ? wa.y + wa.height - h - 12 : wa.y + 12;
  return { x, y, width: W, height: h };
}
function showOv() {
  if (ov && !ov.isDestroyed()) {
    ov.setBounds(place());
    if (!ov.isVisible()) ov.showInactive();
    return;
  }
  ov = new BrowserWindow({
    ...place(), frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false, fullscreenable: false, icon: ctx.icon, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'voice-overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ov.setAlwaysOnTop(true, 'screen-saver');
  ov.setIgnoreMouseEvents(true);
  ov.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ov.loadFile(path.join(__dirname, 'voice-overlay.html'));
  ov.once('ready-to-show', () => { if (ov && !ov.isDestroyed()) { ov.webContents.send('vstate', st); ov.showInactive(); } });
  ov.on('closed', () => { ov = null; });
}
function hideOv() { if (ov && !ov.isDestroyed() && ov.isVisible()) ov.hide(); }

function stop() {
  st = { voice: null };
  try { globalShortcut.unregister('CommandOrControl+Shift+M'); globalShortcut.unregister('CommandOrControl+Shift+D'); } catch { /* bỏ qua */ }
  if (hookOn && U) { try { U.uIOhook.stop(); } catch { /* bỏ qua */ } hookOn = false; }
}

module.exports = { setup, attach, stop };
