'use strict';
/*
 * Tiện ích CircleVault cho Chrome / Edge.
 * Google chặn đăng nhập trong cửa sổ nhúng của app, còn Chrome/Edge mới mã hóa cookie nên app không đọc file được.
 * Tiện ích này đọc cookie youtube.com / google.com của chính trình duyệt (người dùng tự đăng nhập như bình thường) và
 * gửi sang app CircleVault đang chạy trên CÙNG MÁY (http://127.0.0.1, cổng 8686–8705). Không gửi đi đâu khác.
 * Gửi lại khi cookie YouTube đổi (Google làm mới phiên định kỳ) và mỗi 30 phút, để app không bị đăng xuất.
 */
const PORTS = Array.from({ length: 20 }, (_, i) => 8686 + i);
const LOGIN = ['SAPISID', '__Secure-3PAPISID', 'LOGIN_INFO'];

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/youtube/hello`, { signal: AbortSignal.timeout(900) });
    const j = await r.json();
    return j && j.app === 'CircleVault';
  } catch (e) { return false; }
}

async function findPort() {
  const { port } = await chrome.storage.local.get('port');
  if (port && await ping(port)) return port;
  for (const p of PORTS) if (p !== port && await ping(p)) { await chrome.storage.local.set({ port: p }); return p; }
  return null;
}

function line(c) {
  const dom = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
  return [(c.httpOnly ? '#HttpOnly_' : '') + dom, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
    Math.floor(c.expirationDate || 0), c.name, c.value].join('\t');
}

async function setStatus(ok, text) {
  await chrome.storage.local.set({ status: { ok, text, at: Date.now() } });
  chrome.action.setBadgeText({ text: ok ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5a5f' });
}

async function post(port, path, text) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'X-CircleVault': '1' }, body: text,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : 'CircleVault báo lỗi ' + r.status);
}
const netscape = (list, tag) => ['# Netscape HTTP Cookie File', '# CircleVault: gửi từ tiện ích trình duyệt (' + tag + ')', '', ...list.map(line), ''].join('\n');

// Gửi từng trang độc lập: YouTube (cookie youtube + google) và Facebook (facebook + messenger). Trang chưa đăng nhập thì bỏ qua.
async function sync() {
  const yt = await chrome.cookies.getAll({ domain: 'youtube.com' });
  const fb = await chrome.cookies.getAll({ domain: 'facebook.com' });
  const ytIn = yt.some((c) => LOGIN.includes(c.name)), fbIn = fb.some((c) => c.name === 'c_user');
  if (!ytIn && !fbIn) return setStatus(false, 'Trình duyệt này chưa đăng nhập YouTube hay Facebook.');
  const port = await findPort();
  if (!port) return setStatus(false, 'Không thấy app CircleVault. Mở app trên máy này rồi bấm Gửi ngay.');
  const done = [], errs = [];
  if (ytIn) {
    try { await post(port, '/api/youtube/import-file?source=extension', netscape([...yt, ...await chrome.cookies.getAll({ domain: 'google.com' })], 'YouTube')); done.push('YouTube'); }
    catch (e) { errs.push('YouTube: ' + e.message); }
  }
  if (fbIn) {
    try { await post(port, '/api/youtube/site-cookies?site=facebook', netscape([...fb, ...await chrome.cookies.getAll({ domain: 'messenger.com' })], 'Facebook')); done.push('Facebook'); }
    catch (e) { errs.push('Facebook: ' + e.message); }
  }
  if (errs.length && !done.length) return setStatus(false, 'Không gửi được cho CircleVault – ' + errs.join(' · '));
  return setStatus(!errs.length, 'Đã gửi đăng nhập ' + done.join(' + ') + ' cho CircleVault.' + (errs.length ? ' Lỗi: ' + errs.join(' · ') : ''));
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('periodic', { periodInMinutes: 30 }); sync(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('periodic', { periodInMinutes: 30 }); sync(); });
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if ((/(^|\.)(youtube|google)\.com$/.test(cookie.domain.replace(/^\./, '')) && /SID|LOGIN_INFO/.test(cookie.name))
    || (/(^|\.)facebook\.com$/.test(cookie.domain.replace(/^\./, '')) && /^(c_user|xs)$/.test(cookie.name))) chrome.alarms.create('soon', { delayInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener(() => sync());
chrome.runtime.onMessage.addListener((m, _s, reply) => { if (m === 'sync') { sync().then(() => reply(true)); return true; } return false; });
