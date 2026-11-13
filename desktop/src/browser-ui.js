'use strict';
/* Thanh công cụ cửa sổ trình duyệt trong app (YouTube / xem phim & bắt link). */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const size = (n) => (!n ? '' : n > 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' GB' : n > 2 ** 20 ? Math.round(n / 2 ** 20) + ' MB' : Math.round(n / 1024) + ' KB');
  const mode = new URLSearchParams(location.search).get('mode') || 'web';
  const send = window.bshell.send;
  let st = null, editing = false, titleTouched = false;

  $(mode === 'youtube' ? '#ytTools' : '#webTools').classList.remove('hide');

  window.bshell.onState((s) => {
    st = s;
    if (!editing) $('#addr').value = s.url.startsWith('about:') ? '' : s.url;
    $('#back').disabled = !s.canBack; $('#fwd').disabled = !s.canFwd;
    $('#load').classList.toggle('on', s.loading);
    if (mode === 'youtube') {
      $('#dlVideo').disabled = !s.isVideo; $('#dlAudio').disabled = !s.isVideo; $('#partyYt').disabled = !s.isVideo;
      $('#loginChip').textContent = s.loggedIn ? 'Đã đăng nhập' : 'Chưa đăng nhập';
      $('#loginChip').classList.toggle('ok', s.loggedIn);
      $('#loginBtn').textContent = s.loggedIn ? 'Đăng xuất' : 'Đăng nhập';
    } else {
      $('#count').textContent = s.streams.length;
      $('#autoChip').classList.toggle('hide', !s.autoParty);
      $('#panel').hidden = !s.panel;
      $('#adb').textContent = s.adblock ? 'Chặn quảng cáo: đang bật' : 'Chặn quảng cáo: đang khởi động…';
      if (!titleTouched) $('#title').value = (s.title || '').replace(/\s*[-|–]\s*[^-|–]{0,40}$/, '').slice(0, 200);
      renderList(s.streams);
    }
  });

  function renderList(list) {
    if (!list.length) {
      $('#list').innerHTML = `<div class="empty"><b>Chưa bắt được luồng phim nào.</b>
        <span>1. Mở trang phim, bấm nút phát.</span><span>2. Nếu trang có nhiều server, thử đổi server.</span>
        <span>3. Phim có DRM (Netflix, Disney+, FPT Play…) sẽ không hiện ở đây.</span></div>`;
      return;
    }
    $('#list').innerHTML = list.map((s, i) => `<div class="st">
      <div class="top"><span class="t ${esc(s.type)}">${esc(s.type)}</span><span class="h" title="${esc(s.host)}">${esc(s.host)}</span>${s.size && s.type !== 'HLS' && s.type !== 'DASH' ? `<span class="h" style="flex:none">${size(s.size)}</span>` : ''}</div>
      <div class="n">${esc(s.name || s.url.slice(0, 80))}${i === list.length - 1 && list.length > 1 && s.type === 'HLS' ? ' · bắt được đầu tiên' : ''}</div>
      <div class="row"><button class="btn g" data-dl="${esc(s.id)}">Tải</button><button class="btn c" data-party="${esc(s.id)}">Xem chung</button><button class="btn" data-copy="${esc(s.url)}">Sao chép link</button></div>
    </div>`).join('');
  }

  $('#list').addEventListener('click', (e) => {
    const d = e.target.closest('[data-dl]');
    if (d) { send('dlStream', { id: d.dataset.dl, title: $('#title').value.trim() }); d.disabled = true; d.textContent = 'Đã gửi'; return; }
    const pt = e.target.closest('[data-party]');
    if (pt) { send('party', { id: pt.dataset.party, title: $('#title').value.trim() }); return; }
    const c = e.target.closest('[data-copy]');
    if (c) send('copy', { text: c.dataset.copy });
  });
  $('#title').addEventListener('input', () => { titleTouched = true; });
  $('#addr').addEventListener('focus', () => { editing = true; $('#addr').select(); });
  $('#addr').addEventListener('blur', () => { editing = false; if (st) $('#addr').value = st.url; });
  $('#addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { send('go', { url: $('#addr').value }); $('#addr').blur(); titleTouched = false; }
    if (e.key === 'Escape') $('#addr').blur();
  });
  $('#back').onclick = () => send('back');
  $('#fwd').onclick = () => send('fwd');
  $('#reload').onclick = () => send('reload');
  $('#home').onclick = () => send('home');
  $('#dlVideo').onclick = () => send('dl', { quality: '1080' });
  $('#dlAudio').onclick = () => send('dl', { quality: 'audio' });
  $('#partyYt').onclick = () => send('partyYt');
  $('#loginBtn').onclick = () => send(st && st.loggedIn ? 'logout' : 'login');
  $('#panelBtn').onclick = () => send('panel');
  $('#clear').onclick = () => send('clear');
  $('#saveSite').onclick = () => send('saveSite');
  $('#autoChip').onclick = () => send('cancelAuto');

  let tt = 0;
  window.bshell.onToast(({ text, kind }) => {
    document.querySelectorAll('.toast').forEach((x) => x.remove());
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = text;
    document.body.appendChild(t);
    clearTimeout(tt); tt = setTimeout(() => t.remove(), 3500);
  });
  send('ready');
})();
