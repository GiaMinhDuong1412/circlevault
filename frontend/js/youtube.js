/* CircleVault – tab "YouTube": YouTube bằng giao diện của app. Danh sách lấy qua /api/yt/* (yt-dlp), video phát bằng trình phát
 * nhúng chính thức của YouTube (iframe) nằm trong khung của app. Nút Tải video / MP3 / Xem chung / Mở bằng trình duyệt YouTube. */
(() => {
'use strict';
const {api, esc, toast, fmtDur} = window.CV;
const $ = (s, r = document) => r.querySelector(s);
const desk = window.cvDesktop;
const Y = {page: {t: 'feed', kind: 'home'}, stack: [], data: null, seq: 0, status: null, sugTimer: 0};
const FEEDS = [['home', 'Trang chủ'], ['subs', 'Kênh đăng ký'], ['later', 'Xem sau'], ['liked', 'Đã thích'], ['history', 'Đã xem']];

const num = n => n == null ? '' : n >= 1e9 ? (n / 1e9).toFixed(1).replace('.0', '') + ' tỷ' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' tr'
  : n >= 1e3 ? Math.round(n / 1e3) + ' N' : String(n);
const views = n => n == null ? '' : num(n) + ' lượt xem';

function card(v, small) {
  return `<a class="yv${small ? ' sm' : ''}" href="#youtube" data-yv="${esc(v.id)}" data-yt-title="${esc(v.title)}">
    <span class="yv-th"><img src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      ${v.live ? '<i class="yv-d live">TRỰC TIẾP</i>' : v.duration ? `<i class="yv-d">${fmtDur(v.duration)}</i>` : v.short ? '<i class="yv-d">Shorts</i>' : ''}</span>
    <span class="yv-bd"><b>${esc(v.title)}</b>
      <span class="yv-ch" ${v.channel_id ? `data-ych="${esc(v.channel_id)}"` : ''}>${esc(v.channel)}</span>
      <span class="yv-mt">${esc(views(v.views))}</span></span></a>`;
}

function head() {
  const p = Y.page, st = Y.status || {};
  return `<div class="yt-top box">
    <form class="yt-search" id="ytQ" autocomplete="off"><input type="search" id="ytQin" placeholder="Tìm trên YouTube" value="${p.t === 'search' ? esc(p.q) : ''}" aria-label="Tìm trên YouTube">
      <button class="btn yellow" type="submit" aria-label="Tìm">Tìm</button><div class="yt-sug" id="ytSug" hidden></div></form>
    <div class="yt-chips">${FEEDS.map(([k, n]) => `<button class="chip${p.t === 'feed' && p.kind === k ? ' on' : ''}" type="button" data-yfeed="${k}">${n}</button>`).join('')}</div>
    <span class="sp"></span>
    ${st.logged_in ? '<span class="badge" style="background:var(--green)">Đã đăng nhập</span>' : '<button class="btn sm red" type="button" id="ytIn">Đăng nhập YouTube</button>'}
    ${desk ? '<button class="btn sm plain" type="button" id="ytBrowser" title="Mở trình duyệt YouTube đầy đủ trong app">Trình duyệt YouTube</button>' : ''}
  </div>`;
}

async function render() {
  const box = $('#ytBox'); if (!box) return;
  if (!Y.status) { try { Y.status = await api('/api/yt/status'); } catch (e) { Y.status = {}; } }
  const p = Y.page, my = ++Y.seq;
  if (p.t === 'watch') return renderWatch(my);
  box.innerHTML = head() + `<div class="yt-body"><div class="empty"><span class="spin"></span> Đang tải…</div></div>`;
  bindHead();
  let d;
  try {
    d = p.t === 'search' ? await api('/api/yt/search?q=' + encodeURIComponent(p.q))
      : p.t === 'channel' ? await api('/api/yt/channel?c=' + encodeURIComponent(p.c))
      : await api(`/api/yt/feed?kind=${p.kind}${p.refresh ? '&refresh=1' : ''}`);
  } catch (e) {
    if (my !== Y.seq) return;
    $('.yt-body', box).innerHTML = `<div class="empty"><h3>Không tải được</h3><p>${esc(e.message)}</p><button class="btn plain" type="button" data-yretry>Thử lại</button></div>`;
    return;
  }
  if (my !== Y.seq) return;
  p.refresh = false;
  const body = $('.yt-body', box);
  if (p.t === 'feed' && !d.logged_in) {
    body.innerHTML = `<div class="box pcard yt-hello"><h3>YouTube bằng giao diện CircleVault</h3>
      <p>Đăng nhập YouTube để có <b>Đề xuất cho bạn</b>, Kênh đăng ký, Xem sau, Video đã thích như trên YouTube. Có YouTube Premium thì xem không quảng cáo.</p>
      <div class="btn-row"><button class="btn red" type="button" id="ytIn2">Đăng nhập YouTube</button></div>
      <p class="hint">Chưa đăng nhập vẫn tìm và xem được. Chọn chủ đề:</p>
      <div class="yt-chips">${d.topics.map(t => `<button class="chip" type="button" data-yq="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`;
    $('#ytIn2').onclick = () => window.CV.ytLogin && window.CV.ytLogin();
    return;
  }
  const title = p.t === 'channel'
    ? `<div class="yt-chhead"><span class="yt-ava">${esc((d.title || '?').slice(0, 1))}</span><div><h3>${esc(d.title)}</h3><span class="hint">${d.subs ? num(d.subs) + ' người đăng ký' : ''}</span></div>
       <span class="sp"></span><button class="btn sm plain" type="button" data-yback>← Quay lại</button></div>`
    : `<div class="yt-h"><h3>${esc(d.title)}</h3>${p.t === 'feed' ? '<button class="btn sm plain" type="button" data-yrefresh>⟳ Làm mới</button>' : ''}</div>`;
  const secs = (d.sections || []).filter(x => x.items.length);
  const note = d.stale
    ? `<div class="box pcard yt-stale"><b>⚠ YouTube đang coi như bạn chưa đăng nhập</b><p class="hint">${esc(d.note)}</p>
       <div class="btn-row"><button class="btn sm red" type="button" data-ylogin>Đăng nhập YouTube lại</button>
       <button class="btn sm plain" type="button" data-yrefresh>⟳ Thử lại</button></div></div>`
    : d.note ? `<p class="hint yt-note">${esc(d.note)}</p>` : '';
  body.innerHTML = title + note
    + (d.items.length ? `<div class="yt-grid">${d.items.map(v => card(v)).join('')}</div>`
      : secs.length ? secs.map(x => `<h4 class="yt-sec">${esc(x.title)}</h4><div class="yt-grid">${x.items.map(v => card(v)).join('')}</div>`).join('')
      : `<div class="empty"><h3>Chưa có video nào</h3>${p.t === 'feed' ? '<p>Thử bấm Làm mới, hoặc tìm video ở ô phía trên. Nếu vẫn trống: Đăng nhập YouTube lại (đăng nhập có thể đã hết hạn).</p>' : ''}</div>`);
}

async function renderWatch(my) {
  const box = $('#ytBox'), v = Y.page.v, pre = Y.page.pre || {};
  const origin = encodeURIComponent(location.origin);
  box.innerHTML = head() + `<div class="yt-watch">
    <div class="yt-main">
      <div class="yt-player box" id="ywPlayer"><div class="yt-load"><span class="spin"></span> Đang mở video…</div></div>
      <div class="yt-pnote hint" id="ywNote" hidden></div>
      <h2 class="yt-title" id="ywTitle">${esc(pre.title || '')}</h2>
      <div class="yt-meta" id="ywMeta"><span class="hint">Đang tải thông tin…</span></div>
      <div class="btn-row yt-acts">
        <button class="btn green" type="button" data-ya="video">⬇ Tải video</button>
        <button class="btn yellow" type="button" data-ya="audio">♪ Tải MP3</button>
        <button class="btn cyan" type="button" data-ya="party">Xem chung</button>
        ${desk ? '<button class="btn plain" type="button" data-ya="browser" title="Video không phát được ở đây (bị chặn nhúng) thì mở bằng trình duyệt YouTube">Mở bằng trình duyệt YouTube</button>' : ''}
        <button class="btn plain" type="button" data-yback>← Quay lại</button>
      </div>
      <details class="box pcard yt-desc" id="ywDesc" hidden><summary>Mô tả</summary><div class="yt-desc-t"></div></details>
    </div>
    <aside class="yt-side"><h4>Video liên quan</h4><div id="ywRel"><div class="empty"><span class="spin"></span></div></div></aside>
  </div>`;
  bindHead();
  window.dispatchEvent(new Event('cv-video-play'));   // tạm dừng nhạc đang phát ở tab Nghe Nhạc
  setupPlayer(v, origin, my);
  let d;
  try { d = await api('/api/yt/video?v=' + encodeURIComponent(v)); }
  catch (e) { if (my === Y.seq) { $('#ywMeta').innerHTML = `<span class="hint">${esc(e.message)}</span>`; $('#ywRel').innerHTML = ''; } return; }
  if (my !== Y.seq) return;
  Y.data = d;
  $('#ywTitle').textContent = d.title;
  $('#ywMeta').innerHTML = `<a href="#youtube" class="yt-chlink" data-ych="${esc(d.channel_id)}"><span class="yt-ava sm">${esc((d.channel || '?').slice(0, 1))}</span><b>${esc(d.channel)}</b></a>
    ${d.subs ? `<span class="hint">${num(d.subs)} người đăng ký</span>` : d.subs_text ? `<span class="hint">${esc(d.subs_text)}</span>` : ''}<span class="sp"></span>
    <span>${esc(d.views != null ? views(d.views) : d.views_text || '')}</span>${d.likes ? `<span>👍 ${num(d.likes)}</span>` : ''}${d.date ? `<span>${esc(d.date)}</span>` : ''}`;
  if (d.description) { $('#ywDesc').hidden = false; $('.yt-desc-t').textContent = d.description; }
  $('#ywRel').innerHTML = d.related.map(x => card(x, true)).join('') || '<p class="hint">Không có.</p>';
}

/* ---- trình phát của app: YouTube tách hình/tiếng ở chất lượng cao → <video> (hình) + <audio> (tiếng) chạy khớp nhau */
let avTimer = 0, hideTimer = 0, ytAudio = null, ytEngine = null;
const SVG = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/><text x="12" y="16.5" font-size="7" text-anchor="middle" fill="currentColor" font-weight="800">10</text></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" fill="currentColor"/><text x="12" y="16.5" font-size="7" text-anchor="middle" fill="currentColor" font-weight="800">10</text></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/></svg>',
};
const tfmt = t => (isFinite(t) && t > 0) ? fmtDur(Math.floor(t)) : '0:00';
function stopPlayer() {
  clearInterval(avTimer); clearTimeout(hideTimer);
  document.querySelectorAll('#ywPlayer video').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) { /* bỏ qua */ } });
  if (ytAudio) { ytAudio.pause(); ytAudio.removeAttribute('src'); ytAudio.load(); }
  if (document.fullscreenElement && document.fullscreenElement.id === 'ywPlayer') document.exitFullscreen().catch(() => {});
}
function embedHtml(v, origin) {
  return `<iframe src="https://www.youtube.com/embed/${esc(v)}?autoplay=1&rel=0&playsinline=1&origin=${origin}" title="Trình phát YouTube"
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}
/* tiếng YouTube đi qua bộ EQ dùng chung cài đặt với Nghe Nhạc (một <audio> cố định → một Engine) */
function ytAudioEl() {
  if (!ytAudio) {
    ytAudio = new Audio();
    ytAudio.preload = 'auto';
    if (window.CV.eq) ytEngine = new window.CV.eq.Engine(ytAudio);
    applyEq();
  }
  return ytAudio;
}
function eqObj() { return window.CV.music && window.CV.music.eq ? window.CV.music.eq() : null; }
function applyEq() { const e = eqObj(); if (ytEngine && e) ytEngine.apply(e.state); paintEq(); }
window.addEventListener('cv-eq', applyEq);
function paintEq() {
  const b = $('#ytcEq'), e = eqObj(); if (!b) return;
  b.classList.toggle('on', !!(e && e.state.enabled));
}
function eqPop() {
  const e = eqObj(), pop = $('#ytcEqPop'); if (!pop) return;
  if (!e) { pop.innerHTML = '<p class="hint">Bộ chỉnh âm chưa sẵn sàng.</p>'; return; }
  const P = window.CV.eq.PRESETS, st = e.state;
  pop.innerHTML = `<div class="ytc-eqh"><b>Bộ chỉnh âm</b><label class="switch"><input type="checkbox" id="ytcEqOn" ${st.enabled ? 'checked' : ''}><span>Bật</span></label></div>
    <div class="ytc-eqp">${Object.entries(P).map(([k, p]) => `<button type="button" class="chip ${st.preset === k ? 'on' : ''}" data-yeq="${k}">${esc(p.name)}</button>`).join('')}
      ${Object.keys(st.custom || {}).map(n => `<button type="button" class="chip ${st.preset === 'u:' + n ? 'on' : ''}" data-yeq="u:${esc(n)}">★ ${esc(n)}</button>`).join('')}</div>
    <a href="#music" class="hint" data-yeqmore>Chỉnh chi tiết 10 dải ở tab Nghe Nhạc →</a>`;
}

async function setupPlayer(v, origin, my) {
  stopPlayer();
  let p;
  try { p = await api('/api/yt/play?v=' + encodeURIComponent(v)); } catch (e) { p = {mode: 'embed', why: e.message}; }
  if (my !== Y.seq) return;
  const host = $('#ywPlayer'), note = $('#ywNote');
  if (p.mode === 'embed') {
    host.innerHTML = embedHtml(v, origin);
    note.hidden = false;
    note.innerHTML = `${esc(p.why || '')} Trình phát YouTube báo lỗi thì bấm <b>Mở bằng trình duyệt YouTube</b>.`;
    return;
  }
  const split = p.mode === 'split';
  host.innerHTML = `<video id="ywV" playsinline preload="auto"></video>
    <div class="ytc" id="ytc">
      <div class="ytc-seekw"><div class="ytc-buf" id="ytcBuf"></div><input type="range" class="ytc-seek" id="ytcSeek" min="0" max="1000" step="1" value="0" aria-label="Tua"></div>
      <div class="ytc-row">
        <button type="button" class="ytc-b main" id="ytcPlay" aria-label="Phát / tạm dừng (Space)">${SVG.play}</button>
        <button type="button" class="ytc-b" id="ytcBack" aria-label="Lùi 10 giây (←)">${SVG.back}</button>
        <button type="button" class="ytc-b" id="ytcFwd" aria-label="Tới 10 giây (→)">${SVG.fwd}</button>
        <span class="ytc-t" id="ytcT">0:00 / 0:00</span>
        <span class="sp"></span>
        <button type="button" class="ytc-b" id="ytcMute" aria-label="Tắt tiếng (M)">${SVG.vol}</button>
        <input type="range" class="ytc-vol" id="ytcVol" min="0" max="1" step="0.01" aria-label="Âm lượng (↑ ↓)">
        ${split ? '<span class="ytc-eqw"><button type="button" class="ytc-b txt" id="ytcEq" aria-label="Bộ chỉnh âm">EQ</button><div class="ytc-pop" id="ytcEqPop" hidden></div></span>' : ''}
        <select class="ytc-sel" id="ytcRate" aria-label="Tốc độ">${[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => `<option value="${r}" ${r === 1 ? 'selected' : ''}>${r}×</option>`).join('')}</select>
        ${split ? '<select class="ytc-sel" id="ytwQs" aria-label="Chất lượng"></select>' : ''}
        ${document.pictureInPictureEnabled ? `<button type="button" class="ytc-b" id="ytcPip" aria-label="Cửa sổ nổi">${SVG.pip}</button>` : ''}
        <button type="button" class="ytc-b" id="ytcFull" aria-label="Toàn màn hình (F)">${SVG.full}</button>
      </div>
    </div>`;
  const vid = $('#ywV');
  const aud = split ? ytAudioEl() : vid;          // phần tử phát tiếng (âm lượng, EQ)
  let saved = 1;
  try { saved = localStorage.getItem('cv-yt-vol'); saved = saved == null ? 1 : +saved; } catch (e) { saved = 1; }
  aud.volume = Math.min(1, Math.max(0, saved));
  if (split) {
    vid.muted = true;
    aud.src = p.audio;
    let pick = p.default;
    try { const h = +localStorage.getItem('cv-yt-q'); const m = h && p.qualities.find(x => x.h <= h); if (m) pick = m.f; } catch (e) { /* bỏ qua */ }
    vid.src = p.base + pick;
    const qs = $('#ytwQs');
    qs.innerHTML = p.qualities.map(x => `<option value="${esc(x.f)}" ${x.f === pick ? 'selected' : ''}>${x.h}p${x.fps > 30 ? x.fps : ''}</option>`).join('');
    qs.onchange = () => {
      const t = vid.currentTime, playing = !vid.paused;
      try { localStorage.setItem('cv-yt-q', String(p.qualities.find(x => x.f === qs.value)?.h || '')); } catch (e) { /* bỏ qua */ }
      vid.src = p.base + qs.value;
      vid.addEventListener('loadedmetadata', () => { vid.currentTime = t; aud.currentTime = t; if (playing) vid.play().catch(() => {}); }, {once: true});
    };
    const near = () => { if (Math.abs(aud.currentTime - vid.currentTime) > 0.3) aud.currentTime = vid.currentTime; };
    vid.addEventListener('play', () => { near(); ytEngine && ytEngine.resume(); aud.play().catch(() => {}); });
    vid.addEventListener('playing', () => { near(); if (aud.paused) aud.play().catch(() => {}); });
    vid.addEventListener('pause', () => { if (!vid._wait) aud.pause(); });
    vid.addEventListener('waiting', () => aud.pause());
    vid.addEventListener('seeking', () => { aud.currentTime = vid.currentTime; });
    vid.addEventListener('ratechange', () => { aud.playbackRate = vid.playbackRate; });
    vid.addEventListener('ended', () => aud.pause());
    aud.onwaiting = () => { if (!vid.paused) { vid._wait = true; vid.pause(); } };   // tiếng chưa kịp tải: đợi cùng
    aud.oncanplay = () => { if (vid._wait) { vid._wait = false; vid.play().catch(() => {}); } };
    aud.onerror = () => fail('tiếng');
    clearInterval(avTimer);
    avTimer = setInterval(() => { if (!vid.isConnected) return clearInterval(avTimer); if (!vid.paused && !vid.seeking) near(); }, 1000);
  } else vid.src = p.src;
  function fail(what) {
    if (my !== Y.seq) return;
    note.hidden = false;
    note.innerHTML = `Không phát được ${what} của video này. <button class="btn sm plain" type="button" data-yembed>Dùng trình phát YouTube</button>`;
  }
  vid.addEventListener('error', () => fail('hình'));

  /* ---- thanh điều khiển */
  const seek = $('#ytcSeek'), vol = $('#ytcVol'), playB = $('#ytcPlay'), muteB = $('#ytcMute'), ctl = $('#ytc');
  let dragging = false;
  const paintVol = () => {
    vol.value = aud.muted ? 0 : aud.volume;
    vol.style.setProperty('--p', (aud.muted ? 0 : aud.volume) * 100 + '%');
    muteB.innerHTML = aud.muted || aud.volume === 0 ? SVG.mute : SVG.vol;
  };
  const paint = () => {
    const d = vid.duration || p.duration || 0;
    if (!dragging) { seek.value = d ? Math.round(vid.currentTime / d * 1000) : 0; seek.style.setProperty('--p', (d ? vid.currentTime / d * 100 : 0) + '%'); }
    $('#ytcT').textContent = `${tfmt(vid.currentTime)} / ${tfmt(d)}`;
    try { const b = vid.buffered; if (b.length && d) $('#ytcBuf').style.width = (b.end(b.length - 1) / d * 100) + '%'; } catch (e) { /* bỏ qua */ }
    playB.innerHTML = vid.paused ? SVG.play : SVG.pause;
    host.classList.toggle('paused', vid.paused);
  };
  ['timeupdate', 'play', 'pause', 'loadedmetadata', 'progress', 'durationchange'].forEach(ev => vid.addEventListener(ev, paint));
  const toggle = () => { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); };
  const jump = s => { vid.currentTime = Math.max(0, Math.min((vid.duration || 0) - 0.5, vid.currentTime + s)); paint(); };
  const setVol = x => { aud.muted = false; aud.volume = Math.min(1, Math.max(0, x)); try { localStorage.setItem('cv-yt-vol', String(aud.volume)); } catch (e) { /* bỏ qua */ } paintVol(); };
  playB.onclick = toggle;
  vid.addEventListener('click', toggle);
  vid.addEventListener('dblclick', () => $('#ytcFull').click());
  $('#ytcBack').onclick = () => jump(-10);
  $('#ytcFwd').onclick = () => jump(10);
  seek.addEventListener('input', () => { dragging = true; const d = vid.duration || 0; seek.style.setProperty('--p', seek.value / 10 + '%'); $('#ytcT').textContent = `${tfmt(seek.value / 1000 * d)} / ${tfmt(d)}`; });
  seek.addEventListener('change', () => { dragging = false; const d = vid.duration || 0; if (d) vid.currentTime = seek.value / 1000 * d; });
  vol.addEventListener('input', () => setVol(+vol.value));
  muteB.onclick = () => { aud.muted = !aud.muted; paintVol(); };
  $('#ytcRate').onchange = e => { vid.playbackRate = +e.target.value; };
  $('#ytcFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else host.requestFullscreen().catch(() => {}); };
  $('#ytcPip')?.addEventListener('click', () => { (document.pictureInPictureElement ? document.exitPictureInPicture() : vid.requestPictureInPicture()).catch(() => {}); });
  if (split) {
    $('#ytcEq').onclick = e => { e.stopPropagation(); const pop = $('#ytcEqPop'); pop.hidden = !pop.hidden; if (!pop.hidden) eqPop(); };
    $('#ytcEqPop').addEventListener('click', e => {
      e.stopPropagation();
      const k = e.target.closest('[data-yeq]'); const eq = eqObj();
      if (k && eq) { eq.setPreset(k.dataset.yeq); eqPop(); return; }
      if (e.target.closest('[data-yeqmore]')) { $('#ytcEqPop').hidden = true; vid.pause(); setTimeout(() => document.getElementById('eqPanel')?.scrollIntoView({behavior: 'smooth'}), 120); }
    });
    $('#ytcEqPop').addEventListener('change', e => { if (e.target.id === 'ytcEqOn') { const eq = eqObj(); if (eq && eq.state.enabled !== e.target.checked) eq.toggle(); } });
    paintEq();
  }
  const wake = () => { host.classList.add('ui'); clearTimeout(hideTimer); hideTimer = setTimeout(() => host.classList.remove('ui'), 2600); };
  host.addEventListener('mousemove', wake);
  host.addEventListener('mouseleave', () => host.classList.remove('ui'));
  ctl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  host._keys = e => {
    if (e.target.closest('input[type=text], input[type=search], textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); } else if (k === 'arrowleft') { e.preventDefault(); jump(-5); } else if (k === 'arrowright') { e.preventDefault(); jump(5); }
    else if (k === 'arrowup') { e.preventDefault(); setVol(aud.volume + 0.05); } else if (k === 'arrowdown') { e.preventDefault(); setVol(aud.volume - 0.05); }
    else if (k === 'm') { aud.muted = !aud.muted; paintVol(); } else if (k === 'f') $('#ytcFull').click();
    else return;
    wake();
  };
  paintVol(); paint();
  vid.play().catch(() => {});
}
document.addEventListener('keydown', e => {
  const h = document.getElementById('ywPlayer');
  if (h && h._keys && window.CV.S.view === 'youtube' && h.isConnected && !document.querySelector('dialog[open]')) h._keys(e);
});
document.addEventListener('click', e => { const pop = document.getElementById('ytcEqPop'); if (pop && !pop.hidden && !e.target.closest('.ytc-eqw')) pop.hidden = true; });

function go(page, push = true) {
  stopPlayer();
  if (push) Y.stack.push(Y.page);
  if (Y.stack.length > 30) Y.stack.shift();
  Y.page = page;
  render();
  window.scrollTo({top: 0});
}
function back() { stopPlayer(); Y.page = Y.stack.pop() || {t: 'feed', kind: 'home'}; render(); }
window.addEventListener('hashchange', () => { if (location.hash !== '#youtube') { document.querySelectorAll('#ywPlayer video').forEach(m => m.pause()); if (ytAudio) ytAudio.pause(); } });

function bindHead() {
  const f = $('#ytQ'); if (!f || f.dataset.b) return;
  f.dataset.b = '1';
  f.addEventListener('submit', e => { e.preventDefault(); const q = $('#ytQin').value.trim(); $('#ytSug').hidden = true; if (q) go({t: 'search', q}); });
  $('#ytQin').addEventListener('input', () => {
    clearTimeout(Y.sugTimer);
    const q = $('#ytQin').value.trim();
    if (q.length < 2) { $('#ytSug').hidden = true; return; }
    Y.sugTimer = setTimeout(async () => {
      let r = [];
      try { r = await api('/api/music/discover/suggest?q=' + encodeURIComponent(q)); if (!Array.isArray(r)) r = []; } catch (e) { /* bỏ qua */ }
      const s = $('#ytSug'); if (!s) return;
      s.innerHTML = r.slice(0, 8).map(x => `<button type="button" data-yq="${esc(x.text || x)}">${esc(x.text || x)}</button>`).join('');
      s.hidden = !r.length;
    }, 250);
  });
  $('#ytIn')?.addEventListener('click', () => window.CV.ytLogin && window.CV.ytLogin());
  $('#ytBrowser')?.addEventListener('click', () => openBrowser(Y.page.t === 'watch' ? `https://www.youtube.com/watch?v=${Y.page.v}` : ''));
}
function openBrowser(url) {
  if (!desk) return;
  if (desk.dockRect) location.hash = '#online';
  desk.openBrowser('youtube', url || undefined);
}

async function act(a) {
  const v = Y.page.v, d = Y.data && Y.data.id === v ? Y.data : {title: (Y.page.pre || {}).title};
  const url = `https://www.youtube.com/watch?v=${v}`;
  try {
    if (a === 'video' || a === 'audio') {
      await api('/api/tasks', {method: 'POST', body: {url, quality: a === 'audio' ? 'audio' : '1080', playlist: false, title: d.title || undefined}});
      toast(a === 'audio' ? 'Đã thêm MP3 vào hàng đợi. Tải xong có ở Nghe Nhạc.' : 'Đã thêm video vào hàng đợi tải.');
      window.CV.refreshStatus && window.CV.refreshStatus();
    } else if (a === 'party') {
      await api('/api/party', {method: 'POST', body: {youtube_url: url, title: (d.title || 'Video YouTube').slice(0, 120)}});
      toast('Đã mở phòng xem chung với video này.');
      location.hash = '#party';
    } else if (a === 'browser') openBrowser(url);
  } catch (e) { toast(e.message, 'err'); }
}

document.addEventListener('click', e => {
  if (!e.target.closest('#ytBox')) return;
  const ch = e.target.closest('[data-ych]');
  if (ch && ch.dataset.ych) { e.preventDefault(); return go({t: 'channel', c: ch.dataset.ych}); }
  const v = e.target.closest('[data-yv]');
  if (v) { e.preventDefault(); return go({t: 'watch', v: v.dataset.yv, pre: {title: v.dataset.ytTitle}}); }
  const f = e.target.closest('[data-yfeed]');
  if (f) return go({t: 'feed', kind: f.dataset.yfeed});
  const q = e.target.closest('[data-yq]');
  if (q) { $('#ytSug') && ($('#ytSug').hidden = true); return go({t: 'search', q: q.dataset.yq}); }
  if (e.target.closest('[data-yback]')) return back();
  if (e.target.closest('[data-yretry]')) return render();
  if (e.target.closest('[data-ylogin]')) return window.CV.ytLogin && window.CV.ytLogin();
  if (e.target.closest('[data-yrefresh]')) { Y.page.refresh = true; return render(); }
  if (e.target.closest('[data-yembed]')) { stopPlayer(); $('#ywPlayer').innerHTML = embedHtml(Y.page.v, encodeURIComponent(location.origin)); $('#ywNote').hidden = true; return; }
  const a = e.target.closest('[data-ya]');
  if (a) return act(a.dataset.ya);
  if (!e.target.closest('.yt-search')) { const s = $('#ytSug'); if (s) s.hidden = true; }
});
window.addEventListener('cv-youtube', () => { Y.status = null; if (window.CV.S.view === 'youtube') render(); });
if (desk && desk.onYoutubeLogin) desk.onYoutubeLogin(() => { Y.status = null; if (window.CV.S.view === 'youtube') render(); });

let shown = false;
window.CV.views.youtube = () => { if (!shown || !$('#ytBox').childElementCount) { shown = true; render(); } };
window.CV.youtube = {open: (v, title) => { location.hash = '#youtube'; go({t: 'watch', v, pre: {title}}); }};
})();
