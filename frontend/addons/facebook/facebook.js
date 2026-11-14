/* ADDON – Facebook bên cạnh YouTube (tab Mạng xã hội).
 * Gỡ: xóa thư mục frontend/addons/facebook/, dòng <script> của nó trong index.html và desktop/src/addons/facebook.js.
 * Không sửa mã của tab YouTube: tự chèn nút "Facebook" vào thanh YouTube và một khung cố định bên phải trang.
 * Trang facebook.com thật hiện trong khung (Electron WebContentsView đè lên .fbx-body), app chỉ báo vị trí + lệnh điều hướng. */
(() => {
'use strict';
if (!window.CV) return;
const desk = window.cvDesktop;
const CAN = !!(desk && desk.addon);
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } };
const FB = 'https://www.facebook.com';
const NAV = [
  ['home', 'Trang chủ', FB + '/', /^\/(\?.*)?$/,
    '<path d="M12 3 2 11h3v9h6v-6h2v6h6v-9h3z"/>'],
  ['watch', 'Video', FB + '/watch', /^\/watch/,
    '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="m10 9 5 3-5 3z" style="fill:var(--fbx-bg2)"/>'],
  ['reel', 'Reels', FB + '/reel/', /^\/reels?\//,
    '<rect x="4" y="2" width="16" height="20" rx="4"/><path d="m10 9 5 3-5 3z" style="fill:var(--fbx-bg2)"/>'],
  ['groups', 'Nhóm', FB + '/groups/feed/', /^\/groups/,
    '<circle cx="8" cy="9" r="3.2"/><circle cx="16" cy="9" r="3.2"/><path d="M2 19c0-3 2.7-5 6-5s6 2 6 5zM12 19c.2-1.6 0-3-1-4 1-.6 2.9-1 5-1 3.3 0 6 2 6 5z"/>'],
  ['msg', 'Tin nhắn', FB + '/messages/', /^\/messages/,
    '<path d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.4 3.7 7.1V22l3.4-1.9c.9.3 1.9.4 2.9.4 5.5 0 10-4.1 10-9.2S17.5 2 12 2zm1 12.4-2.6-2.7-5 2.7 5.5-5.8 2.6 2.7 4.9-2.7z"/>'],
  ['noti', 'Thông báo', FB + '/notifications', /^\/notifications/,
    '<path d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.8V3.5a1.5 1.5 0 0 0-3 0v.7A7 7 0 0 0 5 11v5l-2 2v1h18v-1z"/>'],
];
const IC = {
  mute: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  vol: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  reload: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>',
};

const F = {on: load('cv-fbx-on', '0') === '1', w: +load('cv-fbx-w', '440') || 440, st: {}, sent: '', menu: false};

/* ---- khung (chỉ dựng một lần, nằm ngoài mã tab YouTube) */
const css = document.createElement('link');
css.rel = 'stylesheet'; css.href = '/static/addons/facebook/facebook.css';
document.head.appendChild(css);
const box = document.createElement('aside');
box.className = 'fbx'; box.id = 'fbx'; box.hidden = true;
box.setAttribute('aria-label', 'Facebook');
box.innerHTML = `
  <div class="fbx-grip" title="Kéo để đổi độ rộng"></div>
  <header class="fbx-top">
    <span class="fbx-logo" aria-hidden="true">f</span>
    <form class="fbx-search" id="fbxQ"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <input type="search" id="fbxQin" placeholder="Tìm kiếm trên Facebook" aria-label="Tìm kiếm trên Facebook"></form>
    <button class="fbx-ic" type="button" data-fb="mute" id="fbxMute" title="Bật / tắt tiếng Facebook">${IC.mute}</button>
    <span class="fbx-mw"><button class="fbx-ic" type="button" data-fb="more" title="Thêm">${IC.more}</button>
      <div class="fbx-menu" id="fbxMenu" hidden>
        <button type="button" data-fb="reload">Tải lại trang</button>
        <button type="button" data-fb="zoom-">Chữ nhỏ hơn</button>
        <button type="button" data-fb="zoom+">Chữ to hơn</button>
        <button type="button" data-fb="external">Mở bằng trình duyệt ngoài</button>
        <button type="button" data-fb="logout">Đăng xuất Facebook khỏi app</button>
        <button type="button" data-fb="off">Tắt hẳn (giải phóng bộ nhớ)</button>
      </div></span>
    <button class="fbx-ic" type="button" data-fb="hide" title="Ẩn Facebook">${IC.close}</button>
  </header>
  <nav class="fbx-nav">${NAV.map(([k, n]) => `<button type="button" data-fbnav="${k}" title="${n}"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">${NAV.find(x => x[0] === k)[4]}</svg></button>`).join('')}</nav>
  <div class="fbx-login" id="fbxLogin" hidden>
    <b>Đăng nhập nhanh, không cần mật khẩu</b>
    <span>Đăng nhập Facebook trên Chrome/Edge có tiện ích CircleVault → bấm biểu tượng CircleVault → <b>Gửi ngay</b>. App tự nhận như với YouTube.</span>
    <button type="button" data-fb="ext">Cài / cập nhật tiện ích</button>
  </div>
  <div class="fbx-sub"><button class="fbx-sb" type="button" data-fb="back" id="fbxBack" title="Quay lại">${IC.back}</button>
    <button class="fbx-sb" type="button" data-fb="fwd" id="fbxFwd" title="Tiến tới">${IC.fwd}</button>
    <button class="fbx-sb" type="button" data-fb="reload" title="Tải lại">${IC.reload}</button><span class="fbx-title" id="fbxTitle">Facebook</span></div>
  <div class="fbx-body" id="fbxBody">${CAN ? '<div class="fbx-wait"><span class="fbx-spin"></span>Đang mở Facebook…</div>'
    : `<div class="fbx-wait"><b>Facebook chỉ mở được trong app CircleVault trên máy tính.</b><a href="${FB}" target="_blank" rel="noopener">Mở facebook.com ở tab mới</a></div>`}</div>`;
document.body.appendChild(box);
const toggle = document.createElement('button');
toggle.type = 'button'; toggle.className = 'fbx-toggle'; toggle.title = 'Lướt Facebook bên cạnh khi xem YouTube';
toggle.innerHTML = '<span class="fbx-logo sm" aria-hidden="true">f</span>Facebook';

function cmd(m) { if (CAN) desk.addon('facebook', m); }
function visible() { return F.on && window.CV.S.view === 'youtube'; }
function paint() {
  const vis = visible();
  box.hidden = !vis;
  document.body.classList.toggle('fbx-on', vis);
  document.documentElement.style.setProperty('--fbx-w', F.w + 'px');
  toggle.classList.toggle('on', F.on);
  const st = F.st, path = (() => { try { return new URL(st.url || FB).pathname + (new URL(st.url || FB).search || ''); } catch (e) { return '/'; } })();
  box.querySelectorAll('[data-fbnav]').forEach(b => { const n = NAV.find(x => x[0] === b.dataset.fbnav); b.classList.toggle('on', n[3].test(path)); });
  $('#fbxMute').innerHTML = st.muted === false ? IC.vol : IC.mute;
  $('#fbxMute').classList.toggle('on', st.muted === false);
  $('#fbxLogin').hidden = !(CAN && st.loggedIn === false);
  $('#fbxBack').disabled = !st.back; $('#fbxFwd').disabled = !st.fwd;
  $('#fbxTitle').textContent = st.loading ? 'Đang tải…' : (st.title || 'Facebook').replace(/\s*\|\s*Facebook$/, '');
  const dark = (() => { const c = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); const m = c.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    return m ? (parseInt(m[1], 16) * 0.3 + parseInt(m[2], 16) * 0.59 + parseInt(m[3], 16) * 0.11) < 110 : false; })();
  box.classList.toggle('dark', dark);
  sync();
}
/* báo vị trí khung cho app (đè trang Facebook thật lên .fbx-body); ẩn khi có hộp thoại / menu / toàn màn hình */
function sync() {
  if (!CAN) return;
  const body = $('#fbxBody');
  const blocked = document.querySelector('dialog[open]') || document.fullscreenElement || !$('#themePop')?.hidden || F.menu;
  let r = null;
  if (visible() && !blocked) {
    const b = body.getBoundingClientRect();
    if (b.width > 120 && b.height > 120) r = {x: b.left, y: b.top, width: b.width, height: b.height};
  }
  const key = JSON.stringify(r);
  if (key === F.sent) return;
  F.sent = key;
  cmd({t: 'rect', rect: r, url: load('cv-fbx-url', FB + '/')});
}
setInterval(sync, 200);
window.addEventListener('resize', sync);

function setOn(on) {
  F.on = on; save('cv-fbx-on', on ? '1' : '0');
  paint();
}
toggle.addEventListener('click', () => setOn(!F.on));
/* chèn nút vào thanh YouTube mỗi lần tab YouTube vẽ lại (không sửa youtube.js) */
const yt = document.getElementById('ytBox');
function placeToggle() {
  const top = yt && yt.querySelector('.yt-top');
  if (top && !top.contains(toggle)) top.insertBefore(toggle, top.querySelector('#ytBrowser') || top.querySelector('.yt-tabs'));
}
if (yt) new MutationObserver(placeToggle).observe(yt, {childList: true});
placeToggle();
window.addEventListener('hashchange', () => setTimeout(paint, 0));
window.addEventListener('cv-theme', paint);

box.addEventListener('click', e => {
  const n = e.target.closest('[data-fbnav]');
  if (n) { const it = NAV.find(x => x[0] === n.dataset.fbnav); cmd({t: 'go', url: it[2]}); return; }
  const b = e.target.closest('[data-fb]'); if (!b) return;
  const a = b.dataset.fb;
  if (a === 'more') { F.menu = !F.menu; $('#fbxMenu').hidden = !F.menu; sync(); return; }
  F.menu = false; $('#fbxMenu').hidden = true;
  if (a === 'hide') return setOn(false);
  if (a === 'ext') {
    window.CV.api('/api/youtube/extension', {method: 'POST'}).then(r => window.CV.toast(
      `Đã mở thư mục tiện ích (${r.path}). Chrome/Edge: mở chrome://extensions → bật Chế độ nhà phát triển → "Tải tiện ích đã giải nén" chọn thư mục đó. ` +
      'Đã cài từ trước: bấm nút Tải lại (↻) của CircleVault để có quyền Facebook.')).catch(e => window.CV.toast(e.message, 'err'));
    return;
  }
  if (a === 'mute') return cmd({t: 'mute', on: F.st.muted === false});
  if (a === 'zoom+' || a === 'zoom-') return cmd({t: 'zoom', zoom: (F.st.zoom || 0.9) + (a === 'zoom+' ? 0.1 : -0.1)});
  if (a === 'off') { cmd({t: 'close'}); F.sent = ''; setOn(false); window.CV.toast('Đã tắt Facebook. Bấm nút Facebook ở tab Mạng xã hội để mở lại (vẫn giữ đăng nhập).'); return; }
  if (a === 'logout') { if (confirm('Đăng xuất Facebook khỏi app CircleVault?')) cmd({t: 'logout'}); return; }
  cmd({t: a});
});
document.addEventListener('click', e => { if (F.menu && !e.target.closest('.fbx-mw')) { F.menu = false; $('#fbxMenu').hidden = true; } });
$('#fbxQ').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#fbxQin').value.trim();
  if (q) cmd({t: 'go', url: FB + '/search/top/?q=' + encodeURIComponent(q)});
});
/* kéo mép trái để đổi độ rộng */
box.querySelector('.fbx-grip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const g = e.currentTarget; g.setPointerCapture(e.pointerId);
  document.body.classList.add('fbx-drag');
  const move = ev => { F.w = Math.round(Math.min(Math.max(340, window.innerWidth - ev.clientX - 12), Math.min(900, window.innerWidth * 0.6))); paint(); };
  const up = () => { g.removeEventListener('pointermove', move); document.body.classList.remove('fbx-drag'); save('cv-fbx-w', String(F.w)); };
  g.addEventListener('pointermove', move); g.addEventListener('pointerup', up, {once: true});
});
if (CAN && desk.onAddon) desk.onAddon((name, m) => {
  if (name !== 'facebook' || !m || m.t !== 'state') return;
  F.st = m;
  if (m.url && /^https:\/\/([\w-]+\.)?facebook\.com\//.test(m.url)) save('cv-fbx-url', m.url);
  paint();
});
paint();
})();
