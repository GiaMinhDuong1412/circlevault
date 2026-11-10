'use strict';
/**
 * Trình duyệt trong app CircleVault.
 *
 * Hai chế độ, mỗi chế độ một cửa sổ và một bộ cookie riêng (partition):
 *  - 'youtube' (persist:youtube): xem YouTube bằng tài khoản người dùng (Premium = không quảng cáo).
 *    Sau khi đăng nhập, cookie YouTube/Google được ghi ra <DATA>/youtube-cookies.txt (định dạng Netscape) để
 *    backend (yt-dlp) tải video bằng chính tài khoản đó. Mật khẩu chỉ nhập trên trang Google, app không đọc.
 *  - 'web' (persist:web): duyệt trang phim bất kỳ, chặn quảng cáo/cửa sổ bật lên, tự bắt link luồng phim
 *    (.m3u8 / .mpd / .mp4…) kèm Referer/Origin/User-Agent/Cookie để backend tải được.
 *
 * Cửa sổ = thanh công cụ (browser.html, có preload riêng) + một WebContentsView chứa trang web (không preload, sandbox).
 */
const { BrowserWindow, WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BAR_H = 56;
const PANEL_W = 360;
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
const HOME = { youtube: 'https://www.youtube.com/', web: 'https://www.google.com/' };
const MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv)(\?|#|$)/i;
const SEGMENT = /\.(ts|m4s|aac|vtt|srt|jpe?g|png|gif|webp|svg|js|css|woff2?)(\?|#|$)/i;
const LOGIN_COOKIES = ['SAPISID', '__Secure-3PAPISID', 'LOGIN_INFO'];

let ctx = null;              // {dataDir, port, icon, log, notifyMain}
const wins = {};             // mode -> {win, view, mode, streams, adblock}
let sniffing = false;
let lastLogin = null;
let exportTimer = 0;

function setup(options) {
  ctx = options;
  for (const p of ['persist:youtube', 'persist:web']) session.fromPartition(p).setUserAgent(CHROME_UA);
  const yt = session.fromPartition('persist:youtube');
  yt.cookies.on('changed', () => { clearTimeout(exportTimer); exportTimer = setTimeout(exportYoutubeCookies, 1500); });
  exportYoutubeCookies();
  ipcMain.on('bshell', onShellMessage);
}

// ---------------------------------------------------------------- cookie YouTube → yt-dlp
async function exportYoutubeCookies() {
  const file = path.join(ctx.dataDir, 'youtube-cookies.txt');
  try {
    const all = (await session.fromPartition('persist:youtube').cookies.get({}))
      .filter((c) => /(^|\.)(youtube\.com|google\.com)$/.test(c.domain.replace(/^\./, '')));
    const logged = all.some((c) => LOGIN_COOKIES.includes(c.name) && /youtube\.com$/.test(c.domain));
    if (logged) {
      const lines = ['# Netscape HTTP Cookie File', '# CircleVault: cookie đăng nhập YouTube trong app, dùng cho yt-dlp', ''];
      for (const c of all) {
        const dom = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
        lines.push([dom, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
          Math.floor(c.expirationDate || 0), c.name, c.value].join('\t'));
      }
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    if (lastLogin !== logged) {
      if (lastLogin !== null) ctx.log('YouTube', logged ? 'đã đăng nhập' : 'đã đăng xuất');
      lastLogin = logged;
      ctx.notifyMain('youtube-login', logged);
      if (wins.youtube) pushState(wins.youtube);
    }
  } catch (e) { ctx.log('Lỗi ghi cookie YouTube:', e.message); }
}

async function youtubeLogout() {
  const ses = session.fromPartition('persist:youtube');
  await ses.clearStorageData();
  await ses.clearCache();
  try { fs.unlinkSync(path.join(ctx.dataDir, 'youtube-cookies.txt')); } catch { /* chưa có */ }
  lastLogin = false;
  ctx.notifyMain('youtube-login', false);
  if (wins.youtube) wins.youtube.view.webContents.loadURL(HOME.youtube);
  return true;
}

// ---------------------------------------------------------------- bắt link phim (chế độ web)
function header(h, name) {
  if (!h) return '';
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  const v = k ? h[k] : '';
  return Array.isArray(v) ? v[0] : (v || '');
}

function startSniffer(ses) {
  if (sniffing) return;
  sniffing = true;
  const pending = new Map();
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  ses.webRequest.onBeforeSendHeaders(filter, (d, cb) => {
    if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame' && d.resourceType !== 'image' && d.resourceType !== 'stylesheet' && d.resourceType !== 'script') {
      pending.set(d.id, { headers: d.requestHeaders, wc: d.webContentsId });
      if (pending.size > 800) pending.delete(pending.keys().next().value);
    }
    cb({ requestHeaders: d.requestHeaders });
  });
  ses.webRequest.onResponseStarted(filter, (d) => {
    const req = pending.get(d.id);
    pending.delete(d.id);
    if (!req) return;
    const ct = header(d.responseHeaders, 'content-type').toLowerCase();
    let pathname = '';
    try { pathname = new URL(d.url).pathname; } catch { return; }
    let type = null;
    if (/mpegurl/.test(ct) || /\.m3u8$/i.test(pathname)) type = 'HLS';
    else if (/dash\+xml/.test(ct) || /\.mpd$/i.test(pathname)) type = 'DASH';
    else if (/^video\/(?!mp2t)/.test(ct) || (MEDIA_EXT.test(pathname) && !/^(text|application\/(json|javascript))/.test(ct))) type = (pathname.match(/\.(\w+)$/) || [, 'video'])[1].toUpperCase();
    if (!type || (SEGMENT.test(pathname) && type !== 'HLS')) return;
    const w = Object.values(wins).find((x) => x.mode === 'web' && x.view.webContents.id === req.wc)
      || Object.values(wins).find((x) => x.mode === 'web');
    if (!w) return;
    const range = header(d.responseHeaders, 'content-range').match(/\/(\d+)$/);
    const size = range ? +range[1] : +header(d.responseHeaders, 'content-length') || 0;
    if (type !== 'HLS' && type !== 'DASH' && size && size < 300 * 1024) return;   // quảng cáo ngắn, ảnh động
    const key = d.url.split('#')[0];
    if (w.streams.some((s) => s.url === key)) return;
    const pageUrl = w.view.webContents.getURL();
    w.streams.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url: key, type, size,
      host: (() => { try { return new URL(key).host; } catch { return ''; } })(),
      name: decodeURIComponent(pathname.split('/').pop() || '').slice(0, 80),
      referer: header(req.headers, 'referer') || pageUrl,
      origin: header(req.headers, 'origin'),
      ua: header(req.headers, 'user-agent') || CHROME_UA,
      page: pageUrl, title: w.view.webContents.getTitle(), at: Date.now(),
    });
    w.streams = w.streams.slice(0, 40);
    pushState(w);
  });
  const done = (d) => pending.delete(d.id);
  ses.webRequest.onErrorOccurred(filter, done);
  ses.webRequest.onCompleted(filter, done);
}

async function enableAdblock(w) {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cache = path.join(ctx.userData, 'adblock-engine.bin');
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
    blocker.enableBlockingInSession(w.view.webContents.session);
    w.adblock = true;
    pushState(w);
  } catch (e) {
    ctx.log('Không bật được chặn quảng cáo:', e.message);
  }
}

// ---------------------------------------------------------------- gửi tác vụ cho backend
function postTask(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: ctx.port(), path: '/api/tasks', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 15000 }, (res) => {
      let txt = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { txt += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(txt); } catch { /* bỏ qua */ }
        res.statusCode < 300 ? resolve(j) : reject(new Error(typeof j.detail === 'string' ? j.detail : 'Lỗi ' + res.statusCode));
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('Backend không trả lời')));
    r.end(data);
  });
}

function youtubeVideoUrl(u) {
  try {
    const x = new URL(u);
    if (!/(^|\.)youtube\.com$/.test(x.hostname)) return null;
    if (x.pathname === '/watch' && x.searchParams.get('v')) return `https://www.youtube.com/watch?v=${x.searchParams.get('v')}`;
    const m = x.pathname.match(/^\/(shorts|live)\/([\w-]{11})/);
    if (m) return `https://www.youtube.com/watch?v=${m[2]}`;
    if (x.pathname === '/playlist' && x.searchParams.get('list')) return u;
  } catch { /* bỏ qua */ }
  return null;
}

async function downloadCurrent(w, quality) {
  const url = youtubeVideoUrl(w.view.webContents.getURL());
  if (!url) return toastShell(w, 'Mở một video YouTube rồi bấm Tải.', 'err');
  await exportYoutubeCookies();
  const title = w.view.webContents.getTitle().replace(/\s*-\s*YouTube$/, '');
  try {
    await postTask({ url, quality, playlist: url.includes('/playlist'), title });
    toastShell(w, `Đã thêm vào hàng đợi: ${title}`);
  } catch (e) { toastShell(w, e.message, 'err'); }
}

async function downloadStream(w, id, title) {
  const s = w.streams.find((x) => x.id === id);
  if (!s) return;
  const cookies = await w.view.webContents.session.cookies.get({ url: s.url }).catch(() => []);
  const headers = { Referer: s.referer, 'User-Agent': s.ua };
  if (s.origin) headers.Origin = s.origin;
  if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    await postTask({ url: s.url, kind: 'film', title: (title || s.title || s.name).slice(0, 200), headers });
    toastShell(w, 'Đã thêm phim vào hàng đợi. Xem tiến độ ở tab Hàng Đợi.');
  } catch (e) { toastShell(w, e.message, 'err'); }
}

// ---------------------------------------------------------------- cửa sổ
function pushState(w) {
  if (!w.win || w.win.isDestroyed()) return;
  const wc = w.view.webContents;
  w.win.webContents.send('bstate', {
    mode: w.mode, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(), canFwd: wc.navigationHistory.canGoForward(),
    loggedIn: !!lastLogin, isVideo: !!youtubeVideoUrl(wc.getURL()),
    streams: w.streams, adblock: w.adblock, panel: w.panel,
  });
}
function toastShell(w, text, kind = 'ok') { if (w.win && !w.win.isDestroyed()) w.win.webContents.send('btoast', { text, kind }); }

function layout(w) {
  const [width, height] = w.win.getContentSize();
  w.view.setBounds({ x: 0, y: BAR_H, width: Math.max(200, width - (w.panel ? PANEL_W : 0)), height: Math.max(100, height - BAR_H) });
}

function normalizeUrl(input, mode) {
  const v = String(input || '').trim();
  if (!v) return HOME[mode];
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return 'https://' + v;
  return mode === 'youtube' ? `https://www.youtube.com/results?search_query=${encodeURIComponent(v)}`
    : `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function openBrowser(mode, url) {
  mode = mode === 'youtube' ? 'youtube' : 'web';
  const existing = wins[mode];
  if (existing && !existing.win.isDestroyed()) {
    if (url) existing.view.webContents.loadURL(normalizeUrl(url, mode));
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 760, minHeight: 500, icon: ctx.icon, autoHideMenuBar: true, show: false,
    title: mode === 'youtube' ? 'YouTube · CircleVault' : 'Xem phim & bắt link · CircleVault', backgroundColor: '#fbf9f4',
    webPreferences: { preload: path.join(__dirname, 'browser-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenu(null);
  const ses = session.fromPartition(mode === 'youtube' ? 'persist:youtube' : 'persist:web');
  const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const w = { win, view, mode, streams: [], adblock: false, panel: mode === 'web' };
  wins[mode] = w;
  win.contentView.addChildView(view);
  win.loadFile(path.join(__dirname, 'browser.html'), { query: { mode } });
  win.once('ready-to-show', () => win.show());
  win.on('resize', () => layout(w));
  win.on('closed', () => { if (wins[mode] === w) delete wins[mode]; if (mode === 'youtube') exportYoutubeCookies(); });
  layout(w);

  const wc = view.webContents;
  ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']
    .forEach((ev) => wc.on(ev, () => pushState(w)));
  wc.on('did-navigate', (_e, u) => {
    if (mode === 'web') { w.streams = w.streams.filter((s) => s.page === u); pushState(w); }
  });
  wc.setWindowOpenHandler(({ url: u }) => {
    let host = '';
    try { host = new URL(u).hostname; } catch { return { action: 'deny' }; }
    if (mode === 'youtube') {
      if (/(^|\.)(youtube\.com|google\.com|youtu\.be|gstatic\.com)$/.test(host)) wc.loadURL(u);
      else shell.openExternal(u);
    } else {
      let cur = '';
      try { cur = new URL(wc.getURL()).hostname; } catch { /* trang trống */ }
      if (host === cur) wc.loadURL(u);       // cùng trang: mở tại chỗ; khác trang: thường là quảng cáo → chặn
    }
    return { action: 'deny' };
  });
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (mode === 'youtube') {
      const target = youtubeVideoUrl(p.linkURL || '') || youtubeVideoUrl(wc.getURL());
      if (target) {
        items.push({ label: 'Tải video này (CircleVault)', click: () => postTask({ url: target, title: p.linkText || undefined }).then(() => toastShell(w, 'Đã thêm vào hàng đợi.'), (e) => toastShell(w, e.message, 'err')) });
        items.push({ label: 'Tải MP3', click: () => postTask({ url: target, quality: 'audio' }).then(() => toastShell(w, 'Đã thêm MP3 vào hàng đợi.'), (e) => toastShell(w, e.message, 'err')) });
        items.push({ type: 'separator' });
      }
    }
    if (p.linkURL) items.push({ label: 'Sao chép địa chỉ liên kết', click: () => clipboard.writeText(p.linkURL) });
    if (p.selectionText) items.push({ label: 'Sao chép', role: 'copy' });
    if (p.isEditable) items.push({ label: 'Dán', role: 'paste' });
    items.push({ label: 'Mở trang này bằng trình duyệt ngoài', click: () => shell.openExternal(wc.getURL()) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key.toLowerCase();
    if (k === 'f5') { wc.reload(); e.preventDefault(); }
    else if (i.alt && k === 'arrowleft') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); e.preventDefault(); }
    else if (i.alt && k === 'arrowright') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); e.preventDefault(); }
    else if (k === 'f11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  wc.on('enter-html-full-screen', () => { w.view.setBounds({ x: 0, y: 0, ...(() => { const [a, b] = win.getContentSize(); return { width: a, height: b }; })() }); win.setFullScreen(true); });
  wc.on('leave-html-full-screen', () => { win.setFullScreen(false); setTimeout(() => layout(w), 50); });

  if (mode === 'web') { startSniffer(ses); enableAdblock(w); }
  wc.loadURL(normalizeUrl(url, mode));
}

function onShellMessage(e, m) {
  const w = Object.values(wins).find((x) => x.win.webContents === e.sender);
  if (!w || !m) return;
  const wc = w.view.webContents;
  switch (m.a) {
    case 'ready': pushState(w); break;
    case 'go': wc.loadURL(normalizeUrl(m.url, w.mode)); break;
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'fwd': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': wc.reload(); break;
    case 'home': wc.loadURL(HOME[w.mode]); break;
    case 'login': wc.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'); break;
    case 'logout': youtubeLogout(); break;
    case 'dl': downloadCurrent(w, m.quality); break;
    case 'dlStream': downloadStream(w, m.id, m.title); break;
    case 'copy': clipboard.writeText(String(m.text || '')); toastShell(w, 'Đã sao chép link.'); break;
    case 'clear': w.streams = []; pushState(w); break;
    case 'panel': w.panel = !w.panel; layout(w); pushState(w); break;
    case 'external': shell.openExternal(wc.getURL()); break;
  }
}

function openParty(url) {
  const win = new BrowserWindow({
    width: 1360, height: 860, icon: ctx.icon, autoHideMenuBar: true, title: 'Xem chung · CircleVault', backgroundColor: '#fbf9f4',
    // dùng chung cookie với cửa sổ YouTube: chủ phòng có Premium thì video YouTube trong phòng cũng không quảng cáo
    webPreferences: { partition: 'persist:youtube', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.loadURL(url);
}

module.exports = { setup, openBrowser, openParty, youtubeLogout, exportYoutubeCookies, _windows: () => wins };
