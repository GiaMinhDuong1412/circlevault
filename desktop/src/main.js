'use strict';
/**
 * CircleVault – app Windows (Electron). Làm theo mẫu AQ Auto Test:
 *   - chạy backend (backend/, FastAPI) bằng Python nhúng ở resources/python, mã ở resources/app/{backend,frontend}
 *   - ffmpeg + Deno đóng gói sẵn ở resources/bin (thêm vào PATH của backend) → người dùng không phải cài gì thêm
 *   - mở giao diện (frontend/) trong cửa sổ riêng; đóng cửa sổ = thoát app (backend tắt theo, có hỏi nếu đang tải)
 *   - tự cập nhật: updater.js đọc repo public circlevault-releases
 * Dữ liệu (cài đặt, thư viện, lịch sử tải…) ở %APPDATA%\CircleVault\data, nhật ký ở %APPDATA%\CircleVault\nhat-ky.txt.
 *
 * Chạy thử từ mã nguồn: cd desktop && npm install && npm start  (dùng python3/python trên máy, cần pip install -r backend/requirements.txt)
 * Kiểm tra bản build: CircleVault.exe --smoke  (mở backend + giao diện, kiểm tra có ffmpeg/Deno rồi thoát; mã 0 = đạt)
 */
const { app, BrowserWindow, ipcMain, shell, Notification, Menu, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { createUpdater } = require('./updater');
const browser = require('./browser');
const screenTr = require('./screen');
const miniPlayer = require('./mini');

const APP_ID = 'vn.circlevault.app';
const APP_NAME = 'CircleVault';
const SMOKE = process.argv.includes('--smoke');
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'circlevault-smoke-')));

const RES = process.resourcesPath;
const CODE = app.isPackaged ? path.join(RES, 'app') : path.resolve(__dirname, '..', '..');
const BACKEND = path.join(CODE, 'backend');
const FRONTEND = path.join(CODE, 'frontend');
const BIN = app.isPackaged ? path.join(RES, 'bin') : '';
const PYTHON = app.isPackaged && process.platform === 'win32' ? path.join(RES, 'python', 'pythonw.exe')
  : (process.env.CV_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const HOME = app.getPath('userData');
const DATA = path.join(HOME, 'data');
const LOG = path.join(HOME, 'nhat-ky.txt');
const CFG_FILE = path.join(HOME, 'app.json');
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

let cfg = { port: 8686, bounds: null, maximized: false };
let win = null;
let server = null;
let port = 0;
let quitting = false;
let updater = null;
let splash = null;

/**
 * Màn hình chờ (splash.html): hiện ngay khi mở app (backend Python cần vài giây mới chạy) và khi bấm
 * "Khởi động lại để cập nhật" – để người dùng biết app đang làm việc, không phải đã tắt.
 */
function showSplash(query) {
  closeSplash();
  splash = new BrowserWindow({
    width: 480, height: 290, frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    show: false, center: true, title: APP_NAME, icon: ICON, backgroundColor: '#00000000', alwaysOnTop: query.mode === 'install',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.setMenu(null);
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { ver: app.getVersion(), ...query } });
  splash.once('ready-to-show', () => { if (splash) splash.show(); });
  splash.on('closed', () => { splash = null; });
  return new Promise((r) => { splash.webContents.once('did-finish-load', () => setTimeout(r, 150)); setTimeout(r, 1500); });
}
function closeSplash() { if (splash && !splash.isDestroyed()) splash.destroy(); splash = null; }

function log(...a) {
  try { fs.appendFileSync(LOG, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + a.join(' ') + '\n'); } catch { /* bỏ qua */ }
}
function loadCfg() { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { /* lần đầu */ } }
function saveCfg() { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 1)); } catch { /* bỏ qua */ } }

// ---------------- backend Python ----------------
function portFree(p) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p, '127.0.0.1');
  });
}

async function choosePort() {
  const base = Number(cfg.port) || 8686;
  for (let p = base; p < base + 20; p++) if (await portFree(p)) return p;
  throw new Error('Không có cổng trống từ ' + base + ' tới ' + (base + 19));
}

function startServer() {
  const out = fs.openSync(LOG, 'a');
  const env = {
    ...process.env,
    CIRCLEVAULT_APP: '1', CIRCLEVAULT_DATA: DATA, CIRCLEVAULT_WEB: FRONTEND, CIRCLEVAULT_VERSION: app.getVersion(),
    PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    PATH: BIN ? BIN + path.delimiter + (process.env.PATH || '') : process.env.PATH,
  };
  const args = ['-m', 'app', '--port', String(port), '--no-browser'];
  log('Chạy backend', PYTHON, 'cổng', port, 'bản', app.getVersion());
  server = spawn(PYTHON, args, { cwd: BACKEND, env, windowsHide: true, stdio: ['ignore', out, out] });
  server.on('exit', (code) => {
    log('Backend dừng, mã', code);
    server = null;
    if (!quitting) {
      quitting = true;
      if (!SMOKE) dialog.showErrorBox(APP_NAME, 'Phần tải của CircleVault dừng bất ngờ (mã ' + code + ').\nXem nhật ký: ' + LOG);
      app.exit(1);
    }
  });
  server.on('error', (e) => log('Không chạy được Python:', e.message));
}

function stopServer() {
  if (!server) return;
  const pid = server.pid;
  server.removeAllListeners('exit');
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else server.kill();
  } catch { /* đã tắt */ }
  server = null;
}

function getJson(p, timeout = 2000) {
  return new Promise((res, rej) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout }, (x) => {
      let body = '';
      x.setEncoding('utf8');
      x.on('data', (c) => { body += c; });
      x.on('end', () => { try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    });
    r.on('error', rej);
    r.on('timeout', () => r.destroy(new Error('timeout')));
  });
}

function waitServer(ms) {
  const end = Date.now() + ms;
  return new Promise((res, rej) => {
    const tick = () => {
      if (!server) return rej(new Error('Backend không khởi động được – xem ' + LOG));
      getJson('/api/status').then(res, () => (Date.now() > end ? rej(new Error('Backend không trả lời sau ' + ms / 1000 + ' giây')) : setTimeout(tick, 300)));
    };
    tick();
  });
}

async function restartServer() {
  log('Khởi động lại backend');
  stopServer();
  startServer();
  await waitServer(60000);
  if (win) win.webContents.reload();
  return true;
}

// ---------------- cửa sổ ----------------
const isLocal = (u) => { try { const x = new URL(u); return (x.hostname === 'localhost' || x.hostname === '127.0.0.1') && Number(x.port) === port; } catch { return false; } };
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let f = path.join(dir, name);
  for (let i = 1; fs.existsSync(f); i++) f = path.join(dir, `${base} (${i})${ext}`);
  return f;
}

function createWindow() {
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1400, height: b.height || 900, x: b.x, y: b.y, minWidth: 900, minHeight: 600,
    title: APP_NAME, icon: ICON, show: false, autoHideMenuBar: true, backgroundColor: '#fbf9f4',
    // backgroundThrottling: false – thu nhỏ cửa sổ vẫn phát nhạc, chuyển bài và trả lời trình phát mini ngay
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  if (cfg.maximized) win.maximize();
  miniPlayer.attach(win);
  win.on('page-title-updated', (e, title) => { e.preventDefault(); win.setTitle(title.includes('CircleVault') ? title : APP_NAME); });
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); closeSplash(); });
  const keep = () => { if (!win.isMaximized() && !win.isMinimized()) cfg.bounds = win.getBounds(); cfg.maximized = win.isMaximized(); };
  win.on('resize', keep);
  win.on('move', keep);
  let confirmed = false;
  win.on('close', (e) => {
    keep(); saveCfg();
    if (confirmed || quitting || SMOKE) return;
    e.preventDefault();
    getJson('/api/status', 1500).catch(() => ({ active: 0 })).then((st) => {
      if (st.active > 0) {
        const r = dialog.showMessageBoxSync(win, {
          type: 'question', buttons: ['Thoát', 'Ở lại'], defaultId: 1, cancelId: 1, title: APP_NAME,
          message: `Đang tải ${st.active} mục.`,
          detail: 'Thoát bây giờ thì việc tải tạm dừng. Lần mở app sau sẽ tải tiếp từ chỗ dừng.',
        });
        if (r !== 0) return;
      }
      confirmed = true;
      win.close();
    });
  });
  win.on('closed', () => { win = null; app.quit(); });

  // liên kết ra ngoài (YouTube, GitHub…) mở bằng trình duyệt; trang của app mở trong app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true } };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isLocal(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key.toLowerCase();
    if ((k === 'f5' || k === 'r') && (i.control || k === 'f5') && i.shift) { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
    else if (k === 'f5' || (i.control && k === 'r')) { win.webContents.reload(); e.preventDefault(); }
    else if (k === 'f12' || (i.control && i.shift && k === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (i.control && (k === '=' || k === '+')) { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (i.control && k === '-') { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (i.control && k === '0') { win.webContents.setZoomLevel(0); e.preventDefault(); }
  });
  // Bản mới: xóa bộ nhớ đệm giao diện cũ, nếu không trình duyệt trong app có thể dùng lại app.js/index.html của bản trước
  // (bản 2026.11.3 bị vậy nên không thấy tab Dịch).
  const fresh = cfg.uiVersion !== app.getVersion()
    ? session.defaultSession.clearCache().catch(() => {}).then(() => { cfg.uiVersion = app.getVersion(); saveCfg(); })
    : Promise.resolve();
  fresh.then(() => win.loadURL(`http://127.0.0.1:${port}/`));
}

function setupDownloads() {
  // "Lưu bản sao" trong Thư viện: lưu thẳng vào thư mục Tải về như trình duyệt
  session.defaultSession.on('will-download', (_e, item) => {
    const f = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(f);
    item.once('done', (_e2, st) => log('Tải về', st, f));
  });
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON });
    n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch { /* bỏ qua */ }
}

// ---------------- khởi động ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(init);
}
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => stopServer());
app.on('window-all-closed', () => app.quit());

async function init() {
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);
  fs.mkdirSync(DATA, { recursive: true });
  try { if (fs.statSync(LOG).size > 4 * 1024 * 1024) fs.writeFileSync(LOG, ''); } catch { /* chưa có */ }
  loadCfg();
  if (!SMOKE) {
    const updated = cfg.uiVersion && cfg.uiVersion !== app.getVersion();
    showSplash(updated ? { msg: `Đã cập nhật lên bản ${app.getVersion()}`, sub: 'Đang mở lại CircleVault…' } : { msg: 'Đang khởi động…' });
  }
  try {
    port = await choosePort();
    startServer();
    await waitServer(60000);
  } catch (e) {
    log('Lỗi khởi động:', e.message);
    if (SMOKE) { console.error('SMOKE FAIL', e.message); app.exit(1); return; }
    closeSplash();
    dialog.showErrorBox(APP_NAME, 'Không khởi động được CircleVault.\n' + e.message + '\n\nNhật ký: ' + LOG);
    app.exit(1);
    return;
  }
  setupDownloads();
  ipcMain.handle('update-get', () => (updater ? updater.getState() : null));
  ipcMain.on('update-act', () => { if (updater) updater.act(); });
  ipcMain.on('quit', () => app.quit());
  ipcMain.handle('pick-folder', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title: typeof title === 'string' ? title.slice(0, 80) : 'Chọn thư mục nhạc', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('restart-server', () => restartServer().catch((e) => { log('Lỗi khởi động lại:', e.message); return false; }));
  browser.setup({ dataDir: DATA, userData: HOME, port: () => port, icon: ICON, log, notifyMain: send });
  ipcMain.on('open-browser', (_e, mode, url) => browser.openBrowser(mode, url));
  ipcMain.on('open-party', (_e, url) => { if (isLocal(url) || /^http:\/\/127\.0\.0\.1:\d+\/r\//.test(url)) browser.openParty(url); });
  ipcMain.handle('youtube-logout', () => browser.youtubeLogout());
  ipcMain.handle('youtube-import', () => browser.importYoutubeCookies());
  screenTr.setup({ userData: HOME, port: () => port, icon: ICON, log });
  ipcMain.on('open-screen-translate', () => screenTr.open());
  miniPlayer.setup({ userData: HOME, icon: ICON, log });
  createWindow();
  if (SMOKE) return smoke();
  updater = createUpdater({
    send, notify,
    beforeInstall: async (version) => {
      quitting = true;
      await showSplash({ mode: 'install', msg: `Đang cài bản mới${version ? ' ' + version : ''}…`,
        sub: 'App sẽ tự mở lại sau vài giây. Đừng tắt máy.' });
      if (win && !win.isDestroyed()) win.hide();
      stopServer();
    },
  });
  setTimeout(() => updater.check(false), 8 * 1000);
  setInterval(() => updater.check(false), UPDATE_CHECK_MS);
}

/** --smoke: giao diện nạp được, có window.cvDesktop, đủ tab; bản đóng gói phải có ffmpeg + Deno. */
function smoke() {
  const fail = (m) => { console.error('SMOKE FAIL', m); log('SMOKE FAIL', m); quitting = true; stopServer(); app.exit(1); };
  const timer = setTimeout(() => fail('quá 90 giây'), 90000);
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc) => fail('không nạp được trang: ' + code + ' ' + desc));
  wc.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await wc.executeJavaScript(`({desk: !!(window.cvDesktop && window.cvDesktop.openBrowser), cv: !!(window.CV && window.CV.eq && window.CV.music && window.CV.views.party && window.CV.views.translate && window.cvDesktop.openScreenTranslate && window.cvDesktop.musicState && window.CV.views.music),
        tabs: document.querySelectorAll('.tab').length, audio: typeof AudioContext === 'function'})`);
      const st = await getJson('/api/status');
      const party = await getJson('/api/party');
      if (!r.desk || !r.cv || r.tabs < 8 || !r.audio) return fail('giao diện thiếu thành phần: ' + JSON.stringify(r));
      if (!party.port) return fail('máy chủ phòng xem chung không chạy');
      const ocrOk = await wc.executeJavaScript(`fetch('/api/translate/warmup', {method: 'POST'}).then(async (x) => x.ok || (await x.text()))`);
      if (ocrOk !== true) return fail('bộ nhận diện chữ (tab Dịch) không chạy: ' + ocrOk);
      if (app.isPackaged && (!st.tools.ffmpeg || !st.tools.deno)) return fail('thiếu công cụ: ' + JSON.stringify(st.tools));
      clearTimeout(timer);
      const ok = JSON.stringify({ ...r, tools: st.tools, version: st.app.version, party: party.port, ocr: true });
      console.log('SMOKE OK', ok);
      log('SMOKE OK', ok);
      quitting = true;
      stopServer();
      app.exit(0);
    } catch (e) { fail(e.message); }
  });
}
