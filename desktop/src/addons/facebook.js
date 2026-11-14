'use strict';
/**
 * ADDON – Facebook bên cạnh (gỡ: xóa file này + thư mục frontend/addons/facebook/ + dòng <script> của nó trong index.html).
 * Trang facebook.com thật chạy trong một WebContentsView riêng (bộ cookie riêng `persist:facebook`, không lẫn YouTube/Google),
 * đặt đè lên khung `.fbx-body` mà trang CircleVault báo vị trí. App KHÔNG đọc/ghi dữ liệu Facebook, chỉ hiển thị trang.
 * Mặc định tắt tiếng (video Facebook tự phát không lẫn với YouTube).
 */
const { WebContentsView, session, ipcMain, shell, Menu, clipboard } = require('electron');

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

function setup(options) {
  ctx = options;
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA);
  // chỉ cho phép những quyền cần cho xem/nhắn tin; thông báo đẩy, vị trí… từ chối
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'media'].includes(perm)));
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

function push() {
  if (!main || main.isDestroyed() || !view) return;
  const wc = view.webContents;
  main.webContents.send('addon', NAME, {
    t: 'state', url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), muted,
    back: wc.navigationHistory.canGoBack(), fwd: wc.navigationHistory.canGoForward(), zoom,
  });
}

function ensure(url) {
  if (view) return view;
  view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  view.setBackgroundColor('#f0f2f5');
  main.contentView.addChildView(view);
  const wc = view.webContents;
  wc.setAudioMuted(muted);
  wc.setZoomFactor(zoom);
  ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'].forEach((ev) => wc.on(ev, push));
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
      session.fromPartition(PARTITION).clearStorageData().then(() => { if (view) view.webContents.loadURL('https://www.facebook.com/'); });
      break;
    case 'state': push(); break;
    default:
  }
}

module.exports = { setup, attach };
