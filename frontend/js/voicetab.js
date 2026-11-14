/* CircleVault – tab Phòng Thoại (máy chủ phòng): link mời, mở qua Internet, TURN, tên phòng + trang phòng (iframe /v/<mã>).
 * Iframe được giữ nguyên khi đổi tab nên vẫn nói chuyện được khi xem tab khác / thu nhỏ app / đang chơi game.
 * Cầu nối: iframe → postMessage {cvVoiceState} → cvDesktop.voiceState (khung nổi, phím tắt toàn cục);
 *          cvDesktop.onVoiceCmd (phím tắt toàn cục) → postMessage {cvVoice: lệnh} → iframe. */
(() => {
'use strict';
const {api, esc, toast} = window.CV;
const $ = (s, r = document) => r.querySelector(s);
const desk = window.cvDesktop;
const V = {st: null, frame: null, src: '', state: null, timer: 0, infoOpen: null};

function copyBtn(text, label = 'Sao chép') {
  return `<button class="btn sm cyan" type="button" data-copy="${esc(text)}">${label}</button>`;
}

async function load() {
  try { V.st = await api('/api/voice'); } catch (e) { $('#vcInfo').innerHTML = `<p class="no">${esc(e.message)}</p>`; return; }
  info(); frame();
}

function info() {
  const s = V.st, L = s.links || {}, tn = s.tunnel || {};
  const inVoice = s.online.filter(m => m.voice).length;
  const tunnelHtml = {
    off: `<p class="hint">Bạn bè ở xa cần link Internet (đường hầm Cloudflare miễn phí, link đổi mỗi lần mở).</p>
      <div><button class="btn yellow" type="button" id="vcTunOn">MỞ CHO BẠN BÈ QUA INTERNET</button></div>`,
    downloading: '<p class="loading"><span class="spin"></span>Lần đầu: đang tải công cụ đường hầm (khoảng 40 MB)…</p>',
    starting: '<p class="loading"><span class="spin"></span>Đang mở đường hầm, chờ khoảng 10 giây…</p>',
    ready: L.internet ? `<div class="linkbox"><code>${esc(L.internet)}</code>${copyBtn(L.internet, 'Sao chép link mời')}</div>
      <div class="btn-row"><button class="btn sm plain" type="button" id="vcTunOff">Tắt link Internet</button></div>` : '',
    error: `<p class="no">${esc(tn.error || 'Không mở được đường hầm.')}</p><div><button class="btn yellow" type="button" id="vcTunOn">Thử lại</button></div>`,
  }[tn.status] || '';
  const t = s.turn || {};
  const wasOpen = V.infoOpen ?? false;
  $('#vcInfo').innerHTML = `
  <details class="box pcard vc-info" ${wasOpen ? 'open' : ''}>
    <summary><b>${esc(s.name)}</b> <span class="badge" style="background:${s.open ? 'var(--green)' : 'var(--red)'}">${s.open ? 'Đang mở' : 'Đã đóng'}</span>
      <span class="hint">${s.online.length} người trong phòng${inVoice ? ` · ${inVoice} đang nói chuyện` : ''} · Mời bạn bè & cài đặt phòng</span></summary>
    <div class="cols2" style="margin-top:12px">
      <div><h3>Link cho bạn bè ở xa</h3>${tunnelHtml}</div>
      <div><h3>Link cho người cùng Wi-Fi</h3>
        ${L.lan ? `<div class="linkbox"><code>${esc(L.lan)}</code>${copyBtn(L.lan)}</div>`
          : '<p class="hint">Đang tắt. Bật ở tab Cài đặt → Mạng → "Cho điện thoại cùng Wi-Fi", rồi mở lại app.</p>'}
        <p class="hint">Bạn bè mở link bằng Chrome/Edge/Firefox (không cần cài gì) hoặc app CircleVault trên điện thoại (Online → Xem chung → dán link).</p></div>
    </div>
    <form class="vc-row" id="vcName"><label class="field">Tên phòng<input type="text" maxlength="60" value="${esc(s.name)}"></label><button class="btn sm yellow" type="submit">Lưu tên</button></form>
    <div class="btn-row">
      <button class="btn sm ${s.open ? 'red' : 'green'}" type="button" id="vcOpen">${s.open ? 'Đóng phòng (mời mọi người ra)' : 'Mở lại phòng'}</button>
      <button class="btn sm plain" type="button" id="vcNewLink" title="Link cũ hết dùng được">Đổi link mời</button>
    </div>
    <details class="vc-turn"><summary><b>Máy chuyển tiếp TURN</b> <span class="hint">– ${t.mode === 'none' ? 'chưa dùng' : 'đang dùng ' + (t.mode === 'cloudflare' ? 'Cloudflare' : 'máy riêng')}</span></summary>
      <p class="hint">Khoảng 10–20% mạng (nhất là 4G, mạng công ty) không nối thẳng được với nhau → người đó vào kênh nhưng không nghe được.
        Khi đó cần máy chuyển tiếp TURN. Cloudflare có gói miễn phí: dash.cloudflare.com → Realtime → TURN Server → tạo khóa, rồi dán Key ID + API Token vào đây.
        Khóa chỉ lưu trên máy này; bạn bè chỉ nhận mật khẩu tạm 24 giờ.</p>
      <form id="vcTurn" class="vc-turn-f">
        <div class="btn-row">${[['none', 'Không dùng'], ['cloudflare', 'Cloudflare'], ['static', 'Máy TURN riêng']].map(([k, n]) =>
          `<label class="chip ${t.mode === k ? 'on' : ''}"><input type="radio" name="mode" value="${k}" ${t.mode === k ? 'checked' : ''} hidden>${n}</label>`).join('')}</div>
        <div data-m="cloudflare" ${t.mode === 'cloudflare' ? '' : 'hidden'} class="vc-grid">
          <label class="field">TURN Key ID<input name="key_id" value="${esc(t.key_id || '')}" autocomplete="off"></label>
          <label class="field">API Token<input name="api_token" type="password" placeholder="${t.has_secret && t.mode === 'cloudflare' ? '(đã lưu – để trống nếu không đổi)' : ''}" autocomplete="off"></label></div>
        <div data-m="static" ${t.mode === 'static' ? '' : 'hidden'} class="vc-grid">
          <label class="field">Địa chỉ (turn:… / turns:…)<input name="urls" value="${esc(t.urls || '')}" placeholder="turn:may-cua-ban.vn:3478"></label>
          <label class="field">Tên đăng nhập<input name="username" value="${esc(t.username || '')}" autocomplete="off"></label>
          <label class="field">Mật khẩu<input name="credential" type="password" placeholder="${t.has_secret && t.mode === 'static' ? '(đã lưu)' : ''}" autocomplete="off"></label></div>
        ${t.error && t.mode === 'cloudflare' ? `<p class="no">Lần gần nhất Cloudflare báo lỗi: ${esc(t.error)}</p>` : ''}
        <div><button class="btn sm yellow" type="submit">Lưu TURN</button></div>
      </form>
    </details>
  </details>`;
  const det = $('#vcInfo > details');
  det.addEventListener('toggle', () => { V.infoOpen = det.open; });
  $('#vcTunOn')?.addEventListener('click', async () => { try { V.st = await api('/api/voice/tunnel', {method: 'POST'}); info(); poll(); } catch (e) { toast(e.message, 'err'); } });
  $('#vcTunOff')?.addEventListener('click', async () => { V.st = await api('/api/voice/tunnel', {method: 'DELETE'}); info(); });
  $('#vcName').addEventListener('submit', async e => {
    e.preventDefault();
    try { V.st = await api('/api/voice', {method: 'PUT', body: {name: $('input', e.target).value}}); info(); toast('Đã đổi tên phòng.'); } catch (err) { toast(err.message, 'err'); }
  });
  $('#vcOpen').addEventListener('click', async () => {
    if (s.open && !confirm('Đóng phòng? Mọi người (trừ bạn) sẽ bị mời ra và không vào được cho tới khi mở lại.')) return;
    V.st = await api('/api/voice', {method: 'PUT', body: {open: !s.open}}); info();
  });
  $('#vcNewLink').addEventListener('click', async () => {
    if (!confirm('Đổi link mời? Link cũ không dùng được nữa, mọi người đang trong phòng sẽ phải vào lại bằng link mới.')) return;
    V.st = await api('/api/voice/new-link', {method: 'POST'}); V.src = ''; info(); frame();
  });
  const tf = $('#vcTurn');
  tf.addEventListener('change', e => {
    if (e.target.name !== 'mode') return;
    tf.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.contains(e.target)));
    tf.querySelectorAll('[data-m]').forEach(d => { d.hidden = d.dataset.m !== e.target.value; });
  });
  tf.addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(tf));
    try { V.st = await api('/api/voice/turn', {method: 'PUT', body}); toast('Đã lưu TURN. Ai đang trong kênh thì rời rồi vào lại để dùng.'); info(); }
    catch (err) { toast(err.message, 'err'); }
  });
}

function poll() {
  clearTimeout(V.timer);
  if (location.hash !== '#voice') return;
  const tn = V.st && V.st.tunnel && V.st.tunnel.status;
  V.timer = setTimeout(async () => {
    try { const s = await api('/api/voice'); const changed = JSON.stringify(s) !== JSON.stringify(V.st); V.st = s; if (changed && !$('#vcInfo').contains(document.activeElement)) info(); } catch (e) { /* bỏ qua */ }
    poll();
  }, tn === 'starting' || tn === 'downloading' ? 1500 : 6000);
}

function themeQ() {
  const r = document.documentElement;
  return `&embed=1&theme=${encodeURIComponent(r.dataset.theme || '')}&style=${encodeURIComponent(r.dataset.style || 'brutal')}&font=${encodeURIComponent(r.dataset.font || '')}`;
}
function frame() {
  const L = V.st && V.st.links;
  if (!L || !L.host) { $('#vcFrame').innerHTML = '<div class="empty"><span class="spin"></span> Đang chờ máy chủ phòng…</div>'; return; }
  const src = L.host + themeQ();
  if (V.frame && V.src.split('&embed')[0] === L.host) return;      // đã mở: giữ nguyên (không ngắt cuộc gọi)
  V.src = src;
  $('#vcFrame').innerHTML = `<iframe id="vcIframe" title="Phòng thoại" src="${esc(src)}" allow="microphone; autoplay; clipboard-write; display-capture"></iframe>`;
  V.frame = $('#vcIframe');
}

// iframe → app
window.addEventListener('message', e => {
  if (!V.frame || e.source !== V.frame.contentWindow || !e.data || !e.data.cvVoiceState) return;
  const s = e.data.cvVoiceState;
  if (s.invite) { V.infoOpen = true; location.hash = '#voice'; info(); $('#vcInfo').scrollIntoView({block: 'nearest'}); return; }
  V.state = s;
  if (desk && desk.voiceState) desk.voiceState(s);
  const tab = document.querySelector('.tab[data-view="voice"]');
  if (tab) {
    tab.classList.toggle('vc-live', !!s.voice);
    let b = tab.querySelector('.vc-dot');
    const n = s.unread || 0;
    if (n && location.hash !== '#voice') { if (!b) { b = document.createElement('span'); b.className = 'vc-dot'; tab.appendChild(b); } b.textContent = n > 9 ? '9+' : n; }
    else if (b) b.remove();
  }
});
// phím tắt toàn cục (app) → iframe
if (desk && desk.onVoiceCmd) desk.onVoiceCmd(c => { if (V.frame) V.frame.contentWindow.postMessage({cvVoice: c}, '*'); });

window.CV.views.voice = () => { load().then(poll); const b = document.querySelector('.tab[data-view="voice"] .vc-dot'); if (b) b.remove(); };
// mở sẵn phòng khi app chạy (để vào lại kênh nhanh) – chỉ khi người dùng đã từng mở tab này
try { if (localStorage.getItem('cv-voice-used')) setTimeout(() => { if (!V.frame) api('/api/voice').then(s => { V.st = s; frame(); }).catch(() => {}); }, 4000); } catch (e) { /* bỏ qua */ }
window.addEventListener('hashchange', () => { if (location.hash === '#voice') { try { localStorage.setItem('cv-voice-used', '1'); } catch (e) { /* bỏ qua */ } } });
})();
