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
  body.innerHTML = title + (d.note ? `<p class="hint yt-note">${esc(d.note)}</p>` : '')
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
        <label class="yt-q" id="ywQ" hidden>Chất lượng <select id="ywQs" aria-label="Chất lượng video"></select></label>
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
let avTimer = 0;
function stopPlayer() {
  clearInterval(avTimer);
  document.querySelectorAll('#ywPlayer video, #ywPlayer audio').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) { /* bỏ qua */ } });
}
function embedHtml(v, origin) {
  return `<iframe src="https://www.youtube.com/embed/${esc(v)}?autoplay=1&rel=0&playsinline=1&origin=${origin}" title="Trình phát YouTube"
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
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
  if (p.mode === 'single') {
    host.innerHTML = `<video controls autoplay playsinline src="${esc(p.src)}"></video>`;
    return;
  }
  host.innerHTML = `<video id="ywV" controls autoplay playsinline></video><audio id="ywA" preload="auto"></audio>`;
  const vid = $('#ywV'), aud = $('#ywA');
  let saved = 1;
  try { saved = +localStorage.getItem('cv-yt-vol') || 1; } catch (e) { /* bỏ qua */ }
  vid.volume = aud.volume = Math.min(1, Math.max(0, saved));
  aud.src = p.audio;
  let pick = p.default;
  try { const h = +localStorage.getItem('cv-yt-q'); const m = h && p.qualities.find(x => x.h <= h); if (m) pick = m.f; } catch (e) { /* bỏ qua */ }
  vid.src = p.base + pick;
  const q = $('#ywQ'), qs = $('#ywQs');
  q.hidden = false;
  qs.innerHTML = p.qualities.map(x => `<option value="${esc(x.f)}" ${x.f === pick ? 'selected' : ''}>${x.h}p${x.fps > 30 ? x.fps : ''}</option>`).join('');
  qs.onchange = () => {
    const t = vid.currentTime, playing = !vid.paused;
    try { localStorage.setItem('cv-yt-q', String(p.qualities.find(x => x.f === qs.value)?.h || '')); } catch (e) { /* bỏ qua */ }
    vid.src = p.base + qs.value;
    vid.addEventListener('loadedmetadata', () => { vid.currentTime = t; aud.currentTime = t; if (playing) vid.play().catch(() => {}); }, {once: true});
  };
  const near = () => { if (Math.abs(aud.currentTime - vid.currentTime) > 0.3) aud.currentTime = vid.currentTime; };
  vid.addEventListener('play', () => { near(); aud.play().catch(() => {}); });
  vid.addEventListener('playing', () => { near(); if (aud.paused) aud.play().catch(() => {}); });
  vid.addEventListener('pause', () => { if (!vid._wait) aud.pause(); });
  vid.addEventListener('waiting', () => aud.pause());
  vid.addEventListener('seeking', () => { aud.currentTime = vid.currentTime; });
  vid.addEventListener('ratechange', () => { aud.playbackRate = vid.playbackRate; });
  vid.addEventListener('volumechange', () => {
    aud.volume = vid.volume; aud.muted = vid.muted;
    try { localStorage.setItem('cv-yt-vol', String(vid.volume)); } catch (e) { /* bỏ qua */ }
  });
  vid.addEventListener('ended', () => aud.pause());
  aud.addEventListener('waiting', () => { if (!vid.paused) { vid._wait = true; vid.pause(); } });   // tiếng chưa kịp tải: đợi cùng
  aud.addEventListener('canplay', () => { if (vid._wait) { vid._wait = false; vid.play().catch(() => {}); } });
  const fail = what => () => {
    if (my !== Y.seq) return;
    note.hidden = false;
    note.innerHTML = `Không phát được ${what} của video này. <button class="btn sm plain" type="button" data-yembed>Dùng trình phát YouTube</button>`;
  };
  vid.addEventListener('error', fail('hình'));
  aud.addEventListener('error', fail('tiếng'));
  clearInterval(avTimer);
  avTimer = setInterval(() => { if (!vid.isConnected) return clearInterval(avTimer); if (!vid.paused && !vid.seeking) near(); }, 1000);
  vid.play().catch(() => {});
}

function go(page, push = true) {
  stopPlayer();
  if (push) Y.stack.push(Y.page);
  if (Y.stack.length > 30) Y.stack.shift();
  Y.page = page;
  render();
  window.scrollTo({top: 0});
}
function back() { stopPlayer(); Y.page = Y.stack.pop() || {t: 'feed', kind: 'home'}; render(); }
window.addEventListener('hashchange', () => { if (location.hash !== '#youtube') document.querySelectorAll('#ywPlayer video, #ywPlayer audio').forEach(m => m.pause()); });

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
  if (e.target.closest('[data-yrefresh]')) { Y.page.refresh = true; return render(); }
  if (e.target.closest('[data-yembed]')) { stopPlayer(); $('#ywPlayer').innerHTML = embedHtml(Y.page.v, encodeURIComponent(location.origin)); $('#ywNote').hidden = true; $('#ywQ').hidden = true; return; }
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
