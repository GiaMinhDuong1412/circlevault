'use strict';
/**
 * ADDON – Facebook bên cạnh (gỡ: xóa file này + thư mục frontend/addons/facebook/ + dòng <script> của nó trong index.html).
 * Trang facebook.com thật chạy trong một WebContentsView riêng (bộ cookie riêng `persist:facebook`, không lẫn YouTube/Google),
 * đặt đè lên khung `.fbx-body` mà trang CircleVault báo vị trí. App KHÔNG đọc/ghi dữ liệu Facebook, chỉ hiển thị trang.
 * Mặc định tắt tiếng (video Facebook tự phát không lẫn với YouTube).
 */
const { WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const NAME = 'facebook';
const PARTITION = 'persist:facebook';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
const OK_HOST = /(^|\.)(facebook\.com|fb\.com|messenger\.com|fbcdn\.net|fb\.watch)$/;

let ctx = null;
let main = null;
let view = null;
let rect = null;
let muted = true;
let zoom = 0.9;
let dark = null;          // trang Facebook đang ở chế độ tối? (để thanh của khung đổi màu theo khi dùng giao diện Facebook gốc)
let skinCss = '';         // CSS "giao diện app": ẩn thanh trên của Facebook + tô màu/font theo theme CircleVault
let skinKey = null;

function setup(options) {
  ctx = options;
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA);
  // chỉ cho phép những quyền cần cho xem/nhắn tin; thông báo đẩy, vị trí… từ chối
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'media'].includes(perm)));
  // đăng nhập nhận từ Chrome (tiện ích CircleVault → backend ghi DATA/cookies/facebook.txt): tự nạp vào phiên Facebook của app
  const f = cookieFile();
  importCookies().catch(() => {});
  fs.watchFile(f, { interval: 4000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) importCookies().catch((e) => ctx.log('Facebook: lỗi nạp đăng nhập', e.message)); });
  ipcMain.on('addon', (e, name, m) => {
    if (name !== NAME || !main || main.isDestroyed() || e.sender !== main.webContents || !m || typeof m !== 'object') return;
    onMessage(m);
  });
}

function attach(win) {
  main = win;
  win.on('resize', layout);
  win.webContents.on('zoom-changed', () => setTimeout(layout, 50));
  win.webContents.on('did-start-navigation', (_e, _u, inPage, mainFrame) => { if (mainFrame && !inPage) { rect = null; layout(); } });
  win.on('closed', () => { main = null; view = null; });
}

function okUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && OK_HOST.test(x.hostname); } catch { return false; }
}

const cookieFile = () => path.join(ctx.dataDir, 'cookies', 'facebook.txt');
let loggedIn = false;
async function checkLogin() {
  try { loggedIn = (await session.fromPartition(PARTITION).cookies.get({ name: 'c_user' })).some((c) => /facebook\.com$/.test(c.domain)); }
  catch { loggedIn = false; }
  return loggedIn;
}
/** Nạp cookie từ file (Netscape). Đang đăng nhập ĐÚNG tài khoản đó thì thôi (không tải lại trang); khác/chưa đăng nhập thì nạp + tải lại. */
async function importCookies() {
  let text = '';
  try { text = fs.readFileSync(cookieFile(), 'utf8'); } catch { return; }
  const rows = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { line = line.slice(10); httpOnly = true; }
    if (!line || line.startsWith('#')) continue;
    const [domain, sub, cpath, secure, expires, name, ...rest] = line.split('\t');
    if (!name || !domain || !/(^|\.)(facebook\.com|messenger\.com)$/.test(domain.replace(/^\./, ''))) continue;
    rows.push({ domain, sub, cpath, secure, expires, name, value: rest.join('\t'), httpOnly });
  }
  const fileUser = (rows.find((r) => r.name === 'c_user') || {}).value;
  if (!fileUser) return;
  const ses = session.fromPartition(PARTITION);
  let cur = '';
  try { cur = ((await ses.cookies.get({ name: 'c_user' })).find((c) => /facebook\.com$/.test(c.domain)) || {}).value || ''; } catch { /* bỏ qua */ }
  if (cur === fileUser) { loggedIn = true; push(); return; }
  for (const r of rows) {
    const host = r.domain.replace(/^\./, '');
    const c = { url: `https://${host}${r.cpath || '/'}`, name: r.name, value: r.value, path: r.cpath || '/', secure: r.secure === 'TRUE',
      httpOnly: r.httpOnly || ['xs', 'fr', 'datr', 'sb'].includes(r.name), sameSite: 'no_restriction' };
    if (r.name.startsWith('__Host-')) c.path = '/';
    else if (r.sub === 'TRUE' || r.domain.startsWith('.')) c.domain = '.' + host;
    if (Number(r.expires) > 0) c.expirationDate = Number(r.expires);
    try { await ses.cookies.set(c); } catch (e) { ctx.log('Facebook: không nạp được cookie', r.name, e.message); }
  }
  await ses.cookies.flushStore();
  loggedIn = true;
  ctx.log('Facebook: đã nhận đăng nhập từ trình duyệt');
  if (view) view.webContents.loadURL('https://www.facebook.com/');
  push();
}

function push() {
  if (!main || main.isDestroyed() || !view) return;
  const wc = view.webContents;
  main.webContents.send('addon', NAME, {
    t: 'state', url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), muted, loggedIn,
    back: wc.navigationHistory.canGoBack(), fwd: wc.navigationHistory.canGoForward(), zoom, dark, skin: !!skinCss,
  });
}

/** Facebook đang bật chế độ tối? (lớp __fb-dark-mode trên <html>; chỉ đọc lớp giao diện, không đọc dữ liệu) */
function checkDark() {
  if (!view) return;
  view.webContents.executeJavaScript("document.documentElement.classList.contains('__fb-dark-mode')", false)
    .then((d) => { if (d !== dark) { dark = !!d; push(); } }).catch(() => {});
}

/* ---- giao diện app: chỉ là CSS chèn thêm (như tiện ích Stylus), Facebook đổi tên lớp thì phần nào không khớp sẽ tự về như cũ */
const SKIN_KEYS = ['bg', 'surface', 'surface2', 'ink', 'text', 'muted', 'accent', 'accentFill', 'hover', 'font', 'bw', 'radius', 'shadow'];
const SAFE = /^[\w\s#(),.%"'+/-]{1,240}$/;   // không có ; { } : * \ nên không thoát được khỏi giá trị CSS
function buildSkin(v) {
  if (!v || typeof v !== 'object') return '';
  const c = {};
  for (const k of SKIN_KEYS) {
    const x = String(v[k] ?? '').trim();
    if (!x || !SAFE.test(x) || /url|expression|image/i.test(x)) return '';
    c[k] = x;
  }
  const vars = {
    'web-wash': c.bg, 'surface-background': c.surface, 'card-background': c.surface, 'popover-background': c.surface,
    'comment-background': c.surface2, 'secondary-button-background': c.surface2, 'input-background': c.surface2,
    'secondary-button-background-floating': c.surface2, 'hover-overlay': c.hover, 'press-overlay': c.hover,
    'primary-text': c.text, 'secondary-text': c.muted, 'placeholder-text': c.muted, 'primary-icon': c.text, 'secondary-icon': c.muted,
    'divider': c.hover, 'accent': c.accent, 'primary-button-background': c.accent, 'blue-link': c.accent,
    'primary-deemphasized-button-background': c.accentFill, 'primary-deemphasized-button-text': c.accent,
    'card-corner-radius': c.radius,
  };
  const decl = Object.entries(vars).map(([k, x]) => `--${k}:${x}!important`).join(';');
  return [
    // thanh trên của Facebook trùng với thanh của khung CircleVault → ẩn, nội dung lên sát mép trên
    ':root{--header-height:0px!important}',
    'div[role="banner"]{display:none!important}',
    `:root,.__fb-light-mode,.__fb-dark-mode{${decl}}`,
    `html,body{background:${c.bg}!important}`,
    `body,input,textarea,button,select,[contenteditable]{font-family:${c.font}!important}`,
    // bài viết trên bảng feed: viền + bóng như thẻ của app
    `div[role="article"][aria-posinset]{border:${c.bw} solid ${c.ink}!important;border-radius:${c.radius}!important;box-shadow:${c.shadow}!important;overflow:hidden}`,
  ].join('\n');
}
async function applySkin() {
  if (!view) return;
  const wc = view.webContents;
  if (skinKey) { const k = skinKey; skinKey = null; try { await wc.removeInsertedCSS(k); } catch { /* trang đã đổi */ } }
  if (skinCss) { try { skinKey = await wc.insertCSS(skinCss, { cssOrigin: 'author' }); } catch { /* bỏ qua */ } }
}

function ensure(url) {
  if (view) return view;
  view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false,
    preload: path.join(__dirname, 'facebook-preload.js') } });
  view.setBackgroundColor('#f0f2f5');
  main.contentView.addChildView(view);
  const wc = view.webContents;
  wc.setAudioMuted(muted);
  wc.setZoomFactor(zoom);
  ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'].forEach((ev) => wc.on(ev, push));
  wc.on('did-stop-loading', () => { checkLogin().then(push); checkDark(); });
  wc.on('did-navigate-in-page', checkDark);
  wc.on('dom-ready', () => { skinKey = null; applySkin(); });   // trang mới = CSS chèn cũ đã mất
  wc.on('did-finish-load', () => wc.setZoomFactor(zoom));
  wc.setWindowOpenHandler(({ url: u }) => {
    if (okUrl(u)) wc.loadURL(u); else if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, u) => { if (!okUrl(u) && /^https?:/i.test(u)) { e.preventDefault(); shell.openExternal(u); } });
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) items.push({ label: 'Sao chép liên kết', click: () => clipboard.writeText(p.linkURL) });
    if (p.selectionText) items.push({ label: 'Sao chép', role: 'copy' });
    if (p.isEditable) items.push({ label: 'Dán', role: 'paste' });
    items.push({ label: 'Mở trang này bằng trình duyệt ngoài', click: () => shell.openExternal(wc.getURL()) });
    Menu.buildFromTemplate(items).popup({ window: main });
  });
  wc.on('render-process-gone', () => { try { wc.reload(); } catch { /* bỏ qua */ } });
  wc.loadURL(okUrl(url) ? url : 'https://www.facebook.com/');
  return view;
}

function layout() {
  if (!view || !main || main.isDestroyed()) return;
  if (!rect) { view.setVisible(false); return; }
  const z = main.webContents.getZoomFactor();
  view.setBounds({ x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) });
  view.setVisible(true);
}

function sanitize(r) {
  if (!r || typeof r !== 'object') return null;
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const out = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  return out.width > 120 && out.height > 120 ? out : null;
}

function onMessage(m) {
  switch (m.t) {
    case 'rect':
      rect = sanitize(m.rect);
      if (rect) ensure(m.url);
      layout();
      break;
    case 'go':
      if (okUrl(m.url)) { ensure(m.url); view.webContents.loadURL(m.url); }
      break;
    case 'back': if (view && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); break;
    case 'fwd': if (view && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); break;
    case 'reload': if (view) view.webContents.reload(); break;
    case 'mute': muted = !!m.on; if (view) view.webContents.setAudioMuted(muted); push(); break;
    case 'zoom':
      zoom = Math.min(1.3, Math.max(0.6, Number(m.zoom) || 0.9));
      if (view) view.webContents.setZoomFactor(zoom);
      push();
      break;
    case 'external': if (view) shell.openExternal(view.webContents.getURL()); break;
    case 'close':                       // tắt hẳn (giải phóng bộ nhớ); đăng nhập vẫn được giữ trong persist:facebook
      rect = null;
      if (view) { try { main.contentView.removeChildView(view); view.webContents.close(); } catch { /* bỏ qua */ } view = null; }
      break;
    case 'logout':
      try { fs.unlinkSync(cookieFile()); } catch { /* chưa có */ }   // đăng nhập nhận từ Chrome: bỏ luôn để không tự nạp lại
      loggedIn = false;
      session.fromPartition(PARTITION).clearStorageData().then(() => { if (view) view.webContents.loadURL('https://www.facebook.com/'); });
      break;
    case 'skin': {
      const css = m.on ? buildSkin(m.vars) : '';
      if (css !== skinCss) { skinCss = css; applySkin().then(push); }
      break;
    }
    case 'state': push(); break;
    default:
  }
}

module.exports = { setup, attach, buildSkin };
