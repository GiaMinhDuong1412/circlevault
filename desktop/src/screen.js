'use strict';
/**
 * Khung dịch màn hình cho game (tab Dịch → Dịch game).
 *
 * - Khung dịch (screen.html): cửa sổ nhỏ luôn nằm trên cùng, hiện bản dịch. setContentProtection(true) để khung này
 *   KHÔNG bị chụp vào ảnh màn hình (Windows 10 2004+), nên đặt đè lên vùng chữ cũng không tự dịch lại chính nó.
 * - Chọn vùng (region.html): phủ ảnh chụp màn hình lên cả màn hình, người dùng kéo chuột khoanh vùng chữ.
 * - Dịch: desktopCapturer chụp màn hình → cắt vùng → PNG → backend POST /api/translate/image?mode=game.
 * - Tự động: chụp mỗi 1,2 giây, so ảnh thu nhỏ; chữ đổi rồi đứng yên thì mới dịch (không dịch lúc chữ đang chạy).
 * Phím tắt (chỉ khi khung dịch đang mở): Ctrl+Alt+T dịch, Ctrl+Alt+R chọn vùng, Ctrl+Alt+A tự động, Ctrl+Alt+H ẩn/hiện.
 */
const { BrowserWindow, desktopCapturer, screen, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const AUTO_MS = 1200;
const KEYS = { 'CommandOrControl+Alt+T': 'translate', 'CommandOrControl+Alt+R': 'select', 'CommandOrControl+Alt+A': 'auto', 'CommandOrControl+Alt+H': 'toggle' };

let ctx = null;            // {userData, port, icon, log}
let panel = null;          // khung dịch
let picker = null;         // cửa sổ chọn vùng
let st = { region: null, bounds: null, font: 20, showSrc: false };
let auto = false;
let timer = null;
let busy = false;
let lastThumb = null;      // ảnh thu nhỏ lần chụp trước (so thay đổi)
let pendingThumb = null;   // chữ vừa đổi, chờ đứng yên
let lastText = '';

const stateFile = () => path.join(ctx.userData, 'dich-man-hinh.json');

function setup(options) {
  ctx = options;
  try { st = { ...st, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { /* lần đầu */ }
  ipcMain.on('sshell', (_e, m) => onMessage(m || {}));
  ipcMain.handle('sshell-state', () => publicState());
}

function save() {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ region: st.region, bounds: st.bounds, font: st.font, showSrc: st.showSrc })); } catch { /* bỏ qua */ }
}

function publicState() {
  return { region: st.region, font: st.font, showSrc: st.showSrc, auto, busy };
}

function send(ch, v) { if (panel && !panel.isDestroyed()) panel.webContents.send(ch, v); }
function status(text, kind) { send('sstatus', { text, kind: kind || '' }); }

// ---------------------------------------------------------------- khung dịch
function open() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = st.bounds && screen.getDisplayMatching(st.bounds) ? st.bounds
    : { width: 620, height: 210, x: wa.x + Math.round((wa.width - 620) / 2), y: wa.y + wa.height - 240 };
  panel = new BrowserWindow({
    ...b, minWidth: 340, minHeight: 120, frame: false, alwaysOnTop: true, skipTaskbar: false, resizable: true,
    title: 'Dịch màn hình · CircleVault', icon: ctx.icon, backgroundColor: '#1d1f25', show: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'screen-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.setContentProtection(true);
  panel.setMenu(null);
  panel.loadFile(path.join(__dirname, 'screen.html'));
  panel.once('ready-to-show', () => { panel.showInactive(); send('sstate', publicState()); if (!st.region) status('Bấm "Chọn vùng" rồi kéo chuột khoanh vùng có chữ trong game.'); });
  const keep = () => { if (panel && !panel.isDestroyed()) { st.bounds = panel.getBounds(); save(); } };
  panel.on('moved', keep);
  panel.on('resized', keep);
  panel.on('closed', () => { panel = null; setAuto(false); unregisterKeys(); });
  registerKeys();
}

function registerKeys() {
  for (const [acc, act] of Object.entries(KEYS)) {
    try { globalShortcut.register(acc, () => onMessage({ a: act })); } catch (e) { ctx.log('Không đăng ký được phím tắt', acc, e.message); }
  }
}
function unregisterKeys() { for (const acc of Object.keys(KEYS)) { try { globalShortcut.unregister(acc); } catch { /* bỏ qua */ } } }

function onMessage(m) {
  switch (m.a) {
    case 'translate': return translateNow(true);
    case 'select': return selectRegion();
    case 'auto': return setAuto(!auto);
    case 'toggle': if (panel) { if (panel.isVisible()) panel.hide(); else panel.showInactive(); } return;
    case 'font': st.font = Math.max(12, Math.min(48, Number(m.v) || 20)); save(); return send('sstate', publicState());
    case 'src': st.showSrc = !!m.v; save(); return send('sstate', publicState());
    case 'close': if (panel) panel.close(); return;
    case 'min': if (panel) panel.minimize(); return;
    case 'region-done': return regionDone(m.rect);
    case 'region-cancel': if (picker) picker.close(); return;
    default:
  }
}

// ---------------------------------------------------------------- chụp màn hình
async function grab(display) {
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || (sources.length === 1 ? sources[0] : null);
  if (!src) throw new Error('Không chụp được màn hình này.');
  return src.thumbnail;
}

async function captureRegion() {
  const r = st.region;
  const display = screen.getAllDisplays().find((d) => d.id === r.displayId) || screen.getDisplayMatching(r);
  const img = await grab(display);
  const k = img.getSize().width / display.bounds.width;
  const rect = {
    x: Math.max(0, Math.round((r.x - display.bounds.x) * k)), y: Math.max(0, Math.round((r.y - display.bounds.y) * k)),
    width: Math.round(r.width * k), height: Math.round(r.height * k),
  };
  const sz = img.getSize();
  rect.width = Math.max(1, Math.min(rect.width, sz.width - rect.x));
  rect.height = Math.max(1, Math.min(rect.height, sz.height - rect.y));
  return img.crop(rect);
}

function thumbDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / (a.length / 4 * 3);
}

// ---------------------------------------------------------------- chọn vùng
async function selectRegion() {
  if (picker && !picker.isDestroyed()) { picker.focus(); return; }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let shot;
  try { shot = (await grab(display)).toDataURL(); } catch (e) { status(e.message, 'err'); return; }
  picker = new BrowserWindow({
    ...display.bounds, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, fullscreenable: false,
    enableLargerThanScreen: true, show: false, backgroundColor: '#000000', hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'screen-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  picker.setAlwaysOnTop(true, 'screen-saver');
  picker.setBounds(display.bounds);
  picker.loadFile(path.join(__dirname, 'region.html'));
  picker.webContents.once('did-finish-load', () => {
    picker.webContents.send('sshot', { url: shot, old: st.region && st.region.displayId === display.id ? {
      x: st.region.x - display.bounds.x, y: st.region.y - display.bounds.y, width: st.region.width, height: st.region.height } : null });
    picker.show();
    picker.focus();
  });
  picker.__display = display;
  picker.on('closed', () => { picker = null; });
}

function regionDone(rect) {
  if (!picker) return;
  const d = picker.__display;
  picker.close();
  if (!rect || rect.width < 8 || rect.height < 8) return;
  st.region = { displayId: d.id, x: Math.round(d.bounds.x + rect.x), y: Math.round(d.bounds.y + rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  save();
  lastThumb = null; pendingThumb = null; lastText = '';
  send('sstate', publicState());
  translateNow(true);
}

// ---------------------------------------------------------------- dịch
function post(png) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port(), path: '/api/translate/image?mode=game', method: 'POST',
      headers: { 'content-type': 'image/png', 'content-length': png.length }, timeout: 120000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* bỏ qua */ }
        if (res.statusCode >= 400) reject(new Error(typeof data.detail === 'string' ? data.detail : `Lỗi máy chủ (${res.statusCode})`));
        else resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Dịch quá lâu, thử lại.')));
    req.on('error', reject);
    req.end(png);
  });
}

async function translateNow(manual, img) {
  if (!st.region) { status('Chưa chọn vùng chữ. Bấm "Chọn vùng" (Ctrl+Alt+R).', 'warn'); if (manual) selectRegion(); return; }
  if (busy) return;
  busy = true;
  send('sstate', publicState());
  if (manual) status('Đang đọc chữ…');
  try {
    img = img || await captureRegion();
    const res = await post(img.toPNG());
    const text = (res.text || '').trim();
    if (!text) { if (manual) status('Không thấy chữ trong vùng đã chọn.', 'warn'); return; }
    if (!manual && text === lastText) return;
    lastText = text;
    send('sresult', { blocks: (res.blocks || []).map((b) => ({ text: b.text, vi: b.vi || '' })), at: Date.now() });
    status(auto ? 'Tự động: đang theo dõi vùng chữ' : '');
  } catch (e) {
    status(e.message, 'err');
    if (auto && /API key|hết tiền|tạm chặn/.test(e.message)) setAuto(false);
  } finally {
    busy = false;
    send('sstate', publicState());
  }
}

function setAuto(on) {
  auto = !!on && !!st.region;
  clearInterval(timer); timer = null;
  lastThumb = null; pendingThumb = null;
  if (auto) {
    timer = setInterval(tick, AUTO_MS);
    status('Tự động: dịch mỗi khi chữ trong vùng thay đổi');
    tick();
  } else if (panel) status(on && !st.region ? 'Chọn vùng chữ trước khi bật tự động.' : 'Đã tắt tự động.', on && !st.region ? 'warn' : '');
  send('sstate', publicState());
}

async function tick() {
  if (busy || !st.region) return;
  let img;
  try { img = await captureRegion(); } catch (e) { return; }
  const thumb = img.resize({ width: 64, quality: 'good' }).toBitmap();
  if (thumbDiff(thumb, lastThumb) < 3) { pendingThumb = null; return; }            // không đổi
  if (pendingThumb && thumbDiff(thumb, pendingThumb) < 3) {                         // đổi xong và đã đứng yên
    lastThumb = thumb; pendingThumb = null;
    await translateNow(false, img);
  } else pendingThumb = thumb;                                                        // đang đổi (chữ đang chạy)
}

module.exports = { setup, open, _state: () => ({ ...publicState(), open: !!panel }) };
