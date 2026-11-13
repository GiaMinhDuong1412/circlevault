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
 * Không mở cửa sổ riêng: thanh công cụ (browser.html, có preload riêng – WebContentsView) + trang web (WebContentsView,
 * không preload, sandbox) gắn thẳng vào cửa sổ chính, nằm đè lên vùng .dock-area của trang CircleVault. Trang báo vị trí
 * vùng đó qua `dock-rect` (null = ẩn: đổi tab, mở hộp thoại…). Chế độ 'party' = trang phòng xem chung, không có thanh công cụ.
 */
const { WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
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

let ctx = null;              // {dataDir, port, icon, log, notifyMain, mainWin}
const wins = {};             // mode -> {win (cửa sổ chính), bar, shell, view, mode, streams, adblock, rect, full}
let sniffing = false;
let lastLogin = null;
let exportTimer = 0;
let importing = false;
let fileSeen = 0;            // thời điểm sửa file cookie mà cửa sổ YouTube đã đồng bộ (tự ghi hoặc đã nạp)

const cookieFile = () => path.join(ctx.dataDir, 'youtube-cookies.txt');
const appCookieFile = () => path.join(ctx.dataDir, 'youtube-cookies-app.txt');            // bản riêng của cửa sổ YouTube trong app
const browserCookieFile = () => path.join(ctx.dataDir, 'youtube-cookies-trinh-duyet.txt'); // backend ghi khi tiện ích Chrome gửi
// Tiện ích trình duyệt vừa gửi (≤ 3 giờ): file chính là của trình duyệt – cửa sổ app chỉ ghi bản riêng, không ghi đè qua lại
// (Google xoay vòng cookie ở từng nơi, ghi đè qua lại làm file chính lúc thì hết hiệu lực → YouTube coi như chưa đăng nhập).
const browserOwned = () => { try { return Date.now() - fs.statSync(browserCookieFile()).mtimeMs < 3 * 3600e3; } catch { return false; } };
const fileTime = () => { try { return fs.statSync(cookieFile()).mtimeMs; } catch { return 0; } };
// File mới hơn lần đồng bộ gần nhất = tiện ích trình duyệt / hộp Đăng nhập YouTube vừa gửi đăng nhập mới.
const fileNewer = () => fileTime() > fileSeen + 1;

function setup(options) {
  ctx = options;
  for (const p of ['persist:youtube', 'persist:web']) session.fromPartition(p).setUserAgent(CHROME_UA);
  const yt = session.fromPartition('persist:youtube');
  yt.cookies.on('changed', () => { if (importing) return; clearTimeout(exportTimer); exportTimer = setTimeout(exportYoutubeCookies, 1500); });
  exportYoutubeCookies({ write: false });   // chỉ xem trạng thái: không ghi đè file bằng đăng nhập cũ trong cửa sổ YouTube
  ipcMain.on('bshell', onShellMessage);
  ipcMain.on('dock-rect', (e, mode, rect) => { const w = wins[mode]; if (w && e.sender === w.win.webContents) { w.rect = sanitize(rect); layout(w); } });
  ipcMain.on('dock-close', (e, mode) => { const w = wins[mode]; if (w && e.sender === w.win.webContents) closeDock(w); });
  ipcMain.handle('dock-state', () => Object.fromEntries(Object.values(wins).map((w) => [w.mode, { url: w.view.webContents.getURL(), title: w.view.webContents.getTitle() }])));
}

function sanitize(r) {
  if (!r || typeof r !== 'object') return null;
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const out = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  return out.width > 40 && out.height > 40 ? out : null;
}

// ---------------------------------------------------------------- cookie YouTube → yt-dlp
async function exportYoutubeCookies({ write = true } = {}) {
  const file = cookieFile();
  if (write && !importing && fileNewer()) {   // có đăng nhập mới hơn từ trình duyệt: nạp vào trước (chỉ khi cửa sổ YouTube chưa đăng nhập)
    const r = await importYoutubeCookies();
    if (!r.same) return r;
  }
  try {
    const all = (await session.fromPartition('persist:youtube').cookies.get({}))
      .filter((c) => /(^|\.)(youtube\.com|google\.com)$/.test(c.domain.replace(/^\./, '')));
    const logged = all.some((c) => LOGIN_COOKIES.includes(c.name) && /youtube\.com$/.test(c.domain));
    if (logged) mirrorToMain(all);
    if (logged && write) {
      const lines = ['# Netscape HTTP Cookie File', '# CircleVault: cookie đăng nhập YouTube trong app, dùng cho yt-dlp', ''];
      for (const c of all) {
        const dom = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
        lines.push([dom, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
          Math.floor(c.expirationDate || 0), c.name, c.value].join('\t'));
      }
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      const body = lines.join('\n') + '\n';
      const put = (f) => { fs.writeFileSync(f + '.tmp', body, { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };
      put(appCookieFile());
      if (lastLogin !== true || !browserOwned()) { put(file); fileSeen = fileTime(); }   // vừa đăng nhập trong app thì luôn ghi
    } else if (!logged && write && lastLogin === true && fs.existsSync(file)) {   // vừa đăng xuất trong cửa sổ YouTube (file có thể lấy từ trình duyệt khác)
      fs.unlinkSync(file);
      try { fs.unlinkSync(appCookieFile()); } catch { /* chưa có */ }
    }
    if (lastLogin !== logged) {
      if (lastLogin !== null) ctx.log('YouTube', logged ? 'đã đăng nhập' : 'đã đăng xuất');
      lastLogin = logged;
      ctx.notifyMain('youtube-login', logged);
      if (wins.youtube) pushState(wins.youtube);
    }
  } catch (e) { ctx.log('Lỗi ghi cookie YouTube:', e.message); }
}

/** Nạp file cookie (backend lấy từ trình duyệt của người dùng / file cookies.txt) vào cửa sổ YouTube của app.
 *  Tiện ích trình duyệt gửi lại đăng nhập mỗi 30 phút: nếu cửa sổ YouTube đang đăng nhập ĐÚNG tài khoản đó (cùng cookie SID)
 *  thì không nạp đè và KHÔNG tải lại trang (trước đây trang tự nhảy về trang chủ khi đang xem). */
async function importYoutubeCookies({ force = false } = {}) {
  const file = cookieFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, count: 0 }; }
  fileSeen = fileTime();
  // Tự động (không phải người dùng bấm đăng nhập): cửa sổ YouTube đang đăng nhập thì KHÔNG nạp đè – nạp cookie khi trang đang mở
  // làm YouTube tự tải lại (đang nghe nhạc bị ngắt). File do tiện ích Chrome gửi / yt-dlp ghi lại khi nghe online đều rơi vào đây.
  if (!force && lastLogin === true) return { ok: true, count: 0, same: true };
  const ses = session.fromPartition('persist:youtube');
  const rows = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { line = line.slice(10); httpOnly = true; }
    if (!line || line.startsWith('#')) continue;
    const [domain, sub, cpath, secure, expires, name, ...rest] = line.split('\t');
    if (!name || !domain) continue;
    rows.push({ domain, sub, cpath, secure, expires, name, value: rest.join('\t'), httpOnly });
  }
  const isYt = (d) => /(^|\.)youtube\.com$/.test(String(d || '').replace(/^\./, ''));
  const fileSid = (rows.find((r) => r.name === 'SID' && isYt(r.domain)) || {}).value || '';
  let curSid = '';
  try { curSid = ((await ses.cookies.get({ name: 'SID' })).find((c) => isYt(c.domain)) || {}).value || ''; } catch { /* bỏ qua */ }
  const wasLogged = lastLogin === true && !!curSid;
  if (wasLogged && fileSid && fileSid === curSid) {
    return { ok: true, count: 0, same: true };          // cùng tài khoản, đang đăng nhập: giữ nguyên, không tải lại trang
  }
  importing = true;
  let n = 0;
  try {
    for (const r of rows) {
      const host = r.domain.replace(/^\./, '');
      const c = { url: `https://${host}${r.cpath || '/'}`, name: r.name, value: r.value, path: r.cpath || '/', secure: r.secure === 'TRUE',
        httpOnly: r.httpOnly || /^(__Secure-|SID$|HSID$|SSID$|LOGIN_INFO$)/.test(r.name), sameSite: r.name.startsWith('__Secure-3P') ? 'no_restriction' : 'unspecified' };
      if (r.name.startsWith('__Host-')) c.path = '/';
      else if (r.sub === 'TRUE' || r.domain.startsWith('.')) c.domain = '.' + host;
      if (Number(r.expires) > 0) c.expirationDate = Number(r.expires);
      try { await ses.cookies.set(c); n++; } catch (e) { ctx.log('Không nạp được cookie', r.name, e.message); }
    }
    await ses.cookies.flushStore();
  } finally { importing = false; }
  ctx.log('Nạp cookie YouTube từ trình duyệt khác:', n, wasLogged ? '(đổi tài khoản)' : '');
  lastLogin = null;
  await exportYoutubeCookies();
  if (wins.youtube) {
    const wc = wins.youtube.view.webContents;
    if (wasLogged) wc.reload();                          // đổi sang tài khoản khác: tải lại đúng trang đang xem
    else wc.loadURL(HOME.youtube);                       // vừa đăng nhập: về trang chủ YouTube
  }
  return { ok: true, count: n };
}

/** Chép cookie YouTube/Google sang phiên của cửa sổ chính: trình phát nhúng ở tab YouTube (giao diện CircleVault) nhận ra tài khoản
 *  → Premium không quảng cáo, lịch sử xem, video giới hạn tuổi. Chỉ chép khi giá trị đổi để không làm phiền trang đang phát. */
let mirrored = '';
async function mirrorToMain(all) {
  const sig = all.filter((c) => LOGIN_COOKIES.includes(c.name)).map((c) => c.name + '=' + c.value).sort().join(';');
  if (sig === mirrored) return;
  mirrored = sig;
  const ses = session.defaultSession;
  for (const c of all) {
    const host = c.domain.replace(/^\./, '');
    const d = { url: `https://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure,
      httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'unspecified' };
    if (!c.hostOnly && !c.name.startsWith('__Host-')) d.domain = '.' + host;
    if (c.expirationDate) d.expirationDate = c.expirationDate;
    try { await ses.cookies.set(d); } catch { /* cookie không hợp lệ cho phiên này: bỏ qua */ }
  }
}
async function clearMainYoutube() {
  mirrored = '';
  const ses = session.defaultSession;
  for (const c of await ses.cookies.get({})) {
    if (!/(^|\.)(youtube\.com|google\.com)$/.test(c.domain.replace(/^\./, ''))) continue;
    try { await ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path || '/'}`, c.name); } catch { /* bỏ qua */ }
  }
}

async function youtubeLogout() {
  const ses = session.fromPartition('persist:youtube');
  await ses.clearStorageData();
  await ses.clearCache();
  await clearMainYoutube().catch(() => {});
  for (const f of [cookieFile(), appCookieFile(), browserCookieFile()]) { try { fs.unlinkSync(f); } catch { /* chưa có */ } }
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
    if (w.autoParty && type !== 'DASH') scheduleAutoParty(w);
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
function postTask(body) { return postJson('/api/tasks', body); }

function postJson(apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: ctx.port(), path: apiPath, method: 'POST',
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
  const headers = await streamHeaders(w, s);
  try {
    await postTask({ url: s.url, kind: 'film', title: (title || s.title || s.name).slice(0, 200), headers });
    toastShell(w, 'Đã thêm phim vào hàng đợi. Xem tiến độ ở tab Hàng Đợi.');
  } catch (e) { toastShell(w, e.message, 'err'); }
}

// ---------------------------------------------------------------- xem chung từ trình duyệt
async function streamHeaders(w, s) {
  const cookies = await w.view.webContents.session.cookies.get({ url: s.url }).catch(() => []);
  const headers = { Referer: s.referer, 'User-Agent': s.ua };
  if (s.origin) headers.Origin = s.origin;
  if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return headers;
}

async function partyStream(w, id, title, control) {
  const s = w.streams.find((x) => x.id === id);
  if (!s) return;
  try {
    await postJson('/api/party', { stream: { url: s.url, kind: s.type, headers: await streamHeaders(w, s), page: s.page },
      title: (title || s.title || s.name || 'Phim').slice(0, 120), ...(control ? { control } : {}) });
    toastShell(w, 'Đã mở phòng xem chung với phim này.');
    ctx.notifyMain('party-go', true);
  } catch (e) { toastShell(w, e.message, 'err'); }
}

/** Xem chung bằng link trang phim mà backend không đọc thẳng được: mở trang trong app, người dùng bấm phát,
 *  bắt được luồng phim thì đợi vài giây (gom luồng master/các chất lượng) rồi tự tạo phòng. */
function partyCapture(url, opts = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  openBrowser('web', url);
  const w = wins.web;
  if (!w) return;
  w.streams = [];
  w.autoParty = { title: String(opts.title || '').slice(0, 120), control: opts.control === 'host' ? 'host' : 'everyone', at: Date.now() };
  pushState(w);
  setTimeout(() => toastShell(w, 'Bấm phát phim (chọn tập/server nếu có). Bắt được luồng phim là app tự tạo phòng xem chung.'), 1500);
}

function scheduleAutoParty(w) {
  clearTimeout(w.apTimer);
  w.apTimer = setTimeout(() => {
    const ap = w.autoParty;
    if (!ap) return;
    if (Date.now() - ap.at > 20 * 60 * 1000) { w.autoParty = null; pushState(w); return; }
    const fresh = w.streams.filter((x) => x.at >= ap.at && x.type !== 'DASH');
    const hls = fresh.filter((x) => x.type === 'HLS');
    // HLS: luồng bắt được ĐẦU TIÊN thường là playlist tổng (master); không có thì lấy file video lớn nhất
    const pick = hls.length ? hls[hls.length - 1] : fresh.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    if (!pick) return;
    w.autoParty = null;
    pushState(w);
    partyStream(w, pick.id, ap.title || '', ap.control);
  }, 3500);
}

/** Lưu trang web xem phim (gốc tên miền) vào danh sách "Trang phim đã lưu". */
async function saveSite(w) {
  const wc = w.view.webContents;
  let u;
  try { u = new URL(wc.getURL()); } catch { return toastShell(w, 'Mở một trang web trước đã.', 'err'); }
  if (!/^https?:$/.test(u.protocol)) return toastShell(w, 'Mở một trang web trước đã.', 'err');
  const host = u.hostname.replace(/^www\./, '');
  const name = (wc.getTitle() || '').split(/\s+[-|–—]\s+/).pop().trim().slice(0, 60) || host;
  try {
    await postJson('/api/web-sites', { url: `${u.protocol}//${u.host}/`, name: name.length > 3 && name.length < 40 ? name : host });
    toastShell(w, `Đã lưu "${host}". Lần sau bấm nhanh ở tab Xem Online / Xem Chung.`);
    ctx.notifyMain('sites-changed', true);
  } catch (e) { toastShell(w, e.message, 'err'); }
}

async function partyYoutube(w) {
  const url = youtubeVideoUrl(w.view.webContents.getURL());
  if (!url || url.includes('/playlist')) return toastShell(w, 'Mở một video YouTube rồi bấm Xem chung.', 'err');
  try {
    await postJson('/api/party', { youtube_url: url, title: w.view.webContents.getTitle().replace(/\s*-\s*YouTube$/, '').slice(0, 120) });
    w.view.webContents.executeJavaScript("document.querySelector('video')?.pause()").catch(() => {});
    toastShell(w, 'Đã mở phòng xem chung với video này.');
    ctx.notifyMain('party-go', true);
  } catch (e) { toastShell(w, e.message, 'err'); }
}

// ---------------------------------------------------------------- vùng trình duyệt trong cửa sổ chính
function pushState(w) {
  if (!w.win || w.win.isDestroyed()) return;
  const wc = w.view.webContents;
  if (w.mode === 'party' || !w.shell || w.shell.isDestroyed()) {
    ctx.notifyMain('dock-state', { mode: w.mode, url: wc.getURL(), title: wc.getTitle() });
    return;
  }
  w.shell.send('bstate', {
    mode: w.mode, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(), canFwd: wc.navigationHistory.canGoForward(),
    loggedIn: !!lastLogin, isVideo: !!youtubeVideoUrl(wc.getURL()),
    streams: w.streams, adblock: w.adblock, panel: w.panel, autoParty: !!w.autoParty,
  });
}
function toastShell(w, text, kind = 'ok') { if (w.shell && !w.shell.isDestroyed()) w.shell.send('btoast', { text, kind }); }

function layout(w) {
  if (!w.win || w.win.isDestroyed()) return;
  if (w.full) {
    const [width, height] = w.win.getContentSize();
    w.view.setBounds({ x: 0, y: 0, width, height });
    w.view.setVisible(true);
    return;
  }
  const z = w.win.webContents.getZoomFactor();
  const r = w.rect && { x: Math.round(w.rect.x * z), y: Math.round(w.rect.y * z), width: Math.round(w.rect.width * z), height: Math.round(w.rect.height * z) };
  if (w.bar) w.bar.setVisible(!!r);
  w.view.setVisible(!!r);
  if (!r) return;
  if (!w.bar) { w.view.setBounds(r); return; }
  const bh = Math.round(BAR_H * z), pw = w.panel ? Math.round(PANEL_W * z) : 0;
  if (Math.abs(w.bar.webContents.getZoomFactor() - z) > 0.01) w.bar.webContents.setZoomFactor(z);
  w.bar.setBounds(r);
  w.view.setBounds({ x: r.x, y: r.y + bh, width: Math.max(100, r.width - pw), height: Math.max(60, r.height - bh) });
}

function closeDock(w) {
  if (wins[w.mode] === w) delete wins[w.mode];
  for (const v of [w.view, w.bar]) {
    if (!v) continue;
    try { w.win.contentView.removeChildView(v); } catch { /* cửa sổ đã đóng */ }
    try { v.webContents.close(); } catch { /* đã đóng */ }
  }
  if (w.full && !w.win.isDestroyed()) w.win.setFullScreen(false);
  if (w.mode === 'youtube') exportYoutubeCookies();
  ctx.notifyMain('dock-closed', w.mode);
}

/** Trang CircleVault vừa tải lại: ẩn hết (trang mới sẽ tự báo vị trí khi người dùng mở lại tab). */
function hideAll() { for (const w of Object.values(wins)) { w.rect = null; w.full = false; layout(w); } }

function normalizeUrl(input, mode) {
  const v = String(input || '').trim();
  if (!v) return HOME[mode];
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return 'https://' + v;
  return mode === 'youtube' ? `https://www.youtube.com/results?search_query=${encodeURIComponent(v)}`
    : `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function openBrowser(mode, url) {
  mode = mode === 'youtube' ? 'youtube' : mode === 'party' ? 'party' : 'web';
  if (mode === 'youtube' && fileNewer()) {   // đăng nhập mới từ tiện ích trình duyệt: nạp vào cửa sổ YouTube trước
    importYoutubeCookies().catch((e) => ctx.log('Lỗi nạp cookie YouTube:', e.message)).finally(() => openBrowser(mode, url));
    return;
  }
  const host = ctx.mainWin();
  if (!host || host.isDestroyed()) return;
  ctx.notifyMain('dock-open', mode);          // trang chuyển sang tab có vùng #dockArea và báo vị trí
  const existing = wins[mode];
  if (existing && existing.win === host) {
    if (url) existing.view.webContents.loadURL(mode === 'party' ? url : normalizeUrl(url, mode));
    return;
  }
  const win = host;
  // phòng xem chung dùng chung cookie với YouTube: chủ phòng có Premium thì video YouTube trong phòng cũng không quảng cáo
  const ses = session.fromPartition(mode === 'web' ? 'persist:web' : 'persist:youtube');
  const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  view.setBackgroundColor('#ffffff');
  let bar = null;
  if (mode !== 'party') {
    bar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'browser-preload.js'), contextIsolation: true, nodeIntegration: false } });
    bar.setBackgroundColor('#00000000');
    bar.webContents.loadFile(path.join(__dirname, 'browser.html'), { query: { mode } });
    win.contentView.addChildView(bar);
  }
  const w = { win, bar, shell: bar && bar.webContents, view, mode, streams: [], adblock: false, panel: mode === 'web', rect: null, full: false };
  wins[mode] = w;
  win.contentView.addChildView(view);
  layout(w);
  if (!win.__cvDock) {          // gắn một lần cho cửa sổ chính
    win.__cvDock = true;
    win.on('resize', () => Object.values(wins).forEach(layout));
    win.webContents.on('did-start-navigation', (_e, _u, inPage, mainFrame) => { if (mainFrame && !inPage) hideAll(); });
    win.webContents.on('zoom-changed', () => setTimeout(() => Object.values(wins).forEach(layout), 50));
  }

  const wc = view.webContents;
  ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']
    .forEach((ev) => wc.on(ev, () => pushState(w)));
  wc.on('did-navigate', (_e, u) => {
    if (mode === 'web') { w.streams = w.streams.filter((s) => s.page === u); pushState(w); }
    if (mode === 'youtube') ctx.log('YouTube nạp cả trang:', u.slice(0, 120));   // để dò nếu còn tự tải lại (YouTube chuyển bài bình thường không nạp cả trang)
  });
  wc.setWindowOpenHandler(({ url: u }) => {
    if (mode === 'party') { if (/^https?:/i.test(u)) shell.openExternal(u); return { action: 'deny' }; }
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
  wc.on('enter-html-full-screen', () => {
    w.full = true;
    win.contentView.addChildView(view);       // lên trên cùng
    win.setFullScreen(true);
    layout(w); setTimeout(() => layout(w), 120);
  });
  wc.on('leave-html-full-screen', () => { w.full = false; win.setFullScreen(false); setTimeout(() => layout(w), 120); });
  wc.on('render-process-gone', () => toastShell(w, 'Trang bị lỗi, bấm Tải lại.', 'err'));

  if (mode === 'web') { startSniffer(ses); enableAdblock(w); }
  wc.loadURL(mode === 'party' ? url : normalizeUrl(url, mode));
}

function onShellMessage(e, m) {
  const w = Object.values(wins).find((x) => x.shell === e.sender);
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
    case 'party': partyStream(w, m.id, m.title); break;
    case 'saveSite': saveSite(w); break;
    case 'cancelAuto': w.autoParty = null; clearTimeout(w.apTimer); pushState(w); break;
    case 'partyYt': partyYoutube(w); break;
  }
}

function openParty(url) { openBrowser('party', url); }

module.exports = { setup, openBrowser, openParty, partyCapture, hideAll, youtubeLogout, importYoutubeCookies, exportYoutubeCookies, _windows: () => wins };
