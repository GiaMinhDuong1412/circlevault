/* CircleVault – trang "Mang theo điện thoại" (/dt). Điện thoại tải nhạc/phim về bộ nhớ của nó như file thường. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const FAT32 = 4 * 1024 ** 3 - 1;

function fmtBytes(n) {
  if (!n) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
function fmtDur(s) {
  s = Math.round(s || 0); if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast box ${kind}`; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000);
}
async function get(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { locked(d.detail); throw new Error(d.detail || 'Thiết bị chưa được phép.'); }
  if (!r.ok) throw new Error(d.detail || `Lỗi ${r.status}`);
  return d;
}

/* ---- ghép thiết bị: chỉ thiết bị đã quét mã QR trên máy tính mới mở được */
function locked(msg) {
  $('#dtMain').hidden = true; $('#dtLocked').hidden = false;
  $('#pairBox').hidden = true; $('#lockBox').hidden = false;
  if (msg) $('#lockMsg').textContent = msg;
}
function guessName() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|SM-T|SM-X/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'Máy tính bảng';
  if (/iPhone/i.test(ua)) return 'iPhone';
  const m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/);
  return m && !/^K$/.test(m[1]) ? `Điện thoại ${m[1].trim()}`.slice(0, 40) : 'Điện thoại';
}
async function gate() {
  const code = new URLSearchParams(location.search).get('pair');
  if (code) {
    $('#dtLocked').hidden = false; $('#pairBox').hidden = false; $('#lockBox').hidden = true;
    $('#pairName').value = guessName();
    return new Promise(resolve => {
      $('#pairForm').addEventListener('submit', async e => {
        e.preventDefault();
        const btn = e.submitter || $('#pairForm button'); btn.disabled = true;
        try {
          const r = await fetch('/api/phone/pair', {method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({code, name: $('#pairName').value})});
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.detail || `Lỗi ${r.status}`);
          history.replaceState(null, '', '/dt');
          toast(`Đã kết nối "${d.device.name}". Lần sau mở lại địa chỉ này là vào thẳng.`);
          resolve(d.device);
        } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
      });
    });
  }
  let me;
  try { me = await get('/api/phone/me'); } catch (e) { $('#dtLocked').hidden = false; $('#lockBox').hidden = false; $('#lockMsg').textContent = offlineMsg(e); return null; }
  if (!me.paired) { locked(); return null; }
  return me;
}

/* ---- nhớ những gì đã tải (chỉ để nhắc, điện thoại không cho trang biết file còn hay đã xóa) */
const GOT_KEY = 'cv-dt-got';
let got = {};
try { got = JSON.parse(localStorage.getItem(GOT_KEY) || '{}'); } catch (e) { got = {}; }
function mark(key) {
  got[key] = Date.now();
  try { localStorage.setItem(GOT_KEY, JSON.stringify(got)); } catch (e) { /* bỏ qua */ }
}
const gotTag = key => got[key] ? `<span class="dt-got">✓ đã tải ${new Date(got[key]).toLocaleDateString('vi-VN', {day: '2-digit', month: '2-digit'})}</span>` : '';

/* ---- tải về: thẻ <a download> cùng nguồn → tên file lấy theo máy chủ gửi */
function download(url) {
  const a = document.createElement('a');
  a.href = url; a.download = ''; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
async function downloadMany(urls, label) {
  toast(`Bắt đầu tải ${urls.length} file của ${label}. Nếu Chrome hỏi "tải nhiều tệp", chọn Cho phép.`);
  for (let i = 0; i < urls.length; i++) {
    download(urls[i]);
    await new Promise(r => setTimeout(r, 1300));       // giãn ra để trình duyệt không gộp/chặn
  }
  toast(`Đã gửi đủ ${urls.length} lượt tải. Xem tiến độ ở thanh thông báo của điện thoại.`);
}

/* ---- tab */
function setTab(tab) {
  $$('.dt-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#tabMusic').hidden = tab !== 'music';
  $('#tabVideo').hidden = tab !== 'video';
  try { localStorage.setItem('cv-dt-tab', tab); } catch (e) { /* bỏ qua */ }
  if (tab === 'video' && !V.loaded) loadVideos(true);
}
$$('.dt-tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ---- nhạc: playlist */
const P = {list: [], open: {}};
async function loadPlaylists() {
  try { P.list = await get('/api/phone/playlists'); }
  catch (e) { $('#plList').innerHTML = `<p class="no">${esc(offlineMsg(e))}</p>`; return; }
  renderPlaylists();
}
function renderPlaylists() {
  if (!P.list.length) {
    $('#plList').innerHTML = '<p class="hint">Chưa có playlist nào. Tạo playlist ở tab Nghe Nhạc trên máy tính, hoặc tìm bài lẻ bên dưới.</p>';
    return;
  }
  $('#plList').innerHTML = P.list.map(p => {
    const big = p.size > FAT32;
    const key = 'pl:' + p.id;
    return `<article class="box dt-card" data-pl="${p.id}">
      <div class="dt-row"><span class="dt-ic big">♪</span><div class="dt-meta"><b>${esc(p.name)}</b>
        <span class="hint">${p.count} bài · ${fmtBytes(p.size)}</span>${gotTag(key)}</div></div>
      ${p.count ? `<div class="dt-acts">
        <a class="btn green" href="/api/phone/playlists/${p.id}/zip" download data-mark="${key}">⬇ Tải gói .zip</a>
        <button type="button" class="btn plain" data-open="${p.id}" aria-expanded="${!!P.open[p.id]}">${P.open[p.id] ? '▾' : '▸'} Từng bài</button>
      </div>
      ${big ? '<p class="warn">Gói lớn hơn 4 GB: thẻ nhớ FAT32 không chứa được. Hãy lưu vào bộ nhớ trong, hoặc bấm "Từng bài".</p>' : ''}
      <div class="dt-sub" id="plBody${p.id}" ${P.open[p.id] ? '' : 'hidden'}></div>` : '<p class="hint">Playlist trống.</p>'}
    </article>`;
  }).join('');
  for (const id of Object.keys(P.open)) if (P.open[id]) loadPlaylistBody(+id);
}
async function loadPlaylistBody(pid) {
  const box = $('#plBody' + pid); if (!box) return;
  box.innerHTML = '<p class="hint">Đang tải…</p>';
  let d;
  try { d = await get(`/api/phone/playlists/${pid}`); } catch (e) { box.innerHTML = `<p class="no">${esc(e.message)}</p>`; return; }
  P.open[pid] = d;
  box.innerHTML = `<div class="dt-acts"><button type="button" class="btn cyan sm" data-all="${pid}">⬇ Tải cả ${d.tracks.length} bài (từng file)</button>
      <a class="btn plain sm" href="/api/phone/playlists/${pid}/m3u8" download>⬇ Danh sách phát .m3u8</a></div>
    <ol class="dt-tracks">${d.tracks.map((t, i) => trackRow(t, i + 1)).join('')}</ol>`;
}
function trackRow(t, n) {
  const key = 'tr:' + t.id;
  return `<li class="dt-track"><div class="dt-meta"><b>${esc(t.title)}</b><span class="hint">${esc(t.artist || '')}${t.artist ? ' · ' : ''}${fmtDur(t.duration)} · ${fmtBytes(t.size)}</span>${gotTag(key)}</div>
    <a class="btn sm yellow" href="/api/phone/track/${t.id}/file${n ? '?n=' + n : ''}" download data-mark="${key}" aria-label="Tải ${esc(t.title)}">⬇</a></li>`;
}
$('#plList').addEventListener('click', e => {
  const op = e.target.closest('[data-open]');
  if (op) {
    const id = +op.dataset.open;
    if (P.open[id]) { delete P.open[id]; renderPlaylists(); }
    else { P.open[id] = true; renderPlaylists(); }
    return;
  }
  const all = e.target.closest('[data-all]');
  if (all) {
    const d = P.open[+all.dataset.all]; if (!d || !d.tracks) return;
    mark('pl:' + d.id);
    const urls = d.tracks.map((t, i) => { mark('tr:' + t.id); return `/api/phone/track/${t.id}/file?n=${i + 1}`; });
    downloadMany([...urls, `/api/phone/playlists/${d.id}/m3u8`], `"${d.name}"`);
    return;
  }
});

/* ---- nhạc: bài lẻ */
let tTimer = 0;
async function loadTracks() {
  const q = $('#qTrack').value.trim();
  try {
    const rows = await get(`/api/phone/tracks?limit=${q ? 80 : 20}&q=${encodeURIComponent(q)}`);
    $('#trList').innerHTML = rows.length
      ? `${q ? '' : '<p class="hint">Bài mới thêm gần đây:</p>'}<ol class="box dt-tracks solo">${rows.map(t => trackRow(t, 0)).join('')}</ol>`
      : `<p class="hint">${q ? 'Không thấy bài nào khớp.' : 'Chưa có bài hát nào.'}</p>`;
  } catch (e) { $('#trList').innerHTML = `<p class="no">${esc(offlineMsg(e))}</p>`; }
}
$('#qTrack').addEventListener('input', () => { clearTimeout(tTimer); tTimer = setTimeout(loadTracks, 300); });

/* ---- phim & video */
const V = {rows: [], loaded: false, more: false};
let vTimer = 0;
async function loadVideos(reset) {
  const q = $('#qVideo').value.trim();
  const off = reset ? 0 : V.offset;
  let rows;
  try { rows = await get(`/api/phone/videos?limit=40&offset=${off}&q=${encodeURIComponent(q)}`); }
  catch (e) { $('#vdList').innerHTML = `<p class="no">${esc(offlineMsg(e))}</p>`; return; }
  V.loaded = true;
  V.rows = reset ? rows : V.rows.concat(rows);
  V.offset = off + 40;
  $('#vdMore').hidden = rows.length < 30;
  $('#vdList').innerHTML = V.rows.length ? V.rows.map(v => {
    const key = 'vd:' + v.id;
    return `<article class="box dt-card">
      <div class="dt-row">${v.thumb ? `<img class="dt-thumb" src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'dt-ic big',textContent:'▶'}))">` : '<span class="dt-ic big">▶</span>'}
        <div class="dt-meta"><b>${esc(v.title)}</b><span class="hint">${[fmtDur(v.duration), v.height ? v.height + 'p' : '', fmtBytes(v.size), v.ext.slice(1).toUpperCase()].filter(Boolean).join(' · ')}</span>${gotTag(key)}</div></div>
      <div class="dt-acts"><a class="btn green" href="/api/phone/video/${v.id}/file" download data-mark="${key}">⬇ Tải về (${fmtBytes(v.size)})</a></div>
      ${v.size > FAT32 ? '<p class="warn">File lớn hơn 4 GB: thẻ nhớ FAT32 không chứa được. Hãy lưu vào bộ nhớ trong.</p>' : ''}
    </article>`;
  }).join('') : `<p class="hint">${q ? 'Không thấy video nào khớp.' : 'Chưa có phim hay video nào trong thư viện.'}</p>`;
}
$('#qVideo').addEventListener('input', () => { clearTimeout(vTimer); vTimer = setTimeout(() => loadVideos(true), 300); });
$('#vdMore').addEventListener('click', () => loadVideos(false));

/* ---- đánh dấu "đã tải" khi bấm nút tải */
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-mark]');
  if (!a) return;
  mark(a.dataset.mark);
  toast('Đang tải về điện thoại… Xem tiến độ ở thanh thông báo. Tải xong mới nên tắt máy tính.');
  setTimeout(() => {
    const span = a.closest('.dt-card, .dt-track')?.querySelector('.dt-meta');
    if (span && !span.querySelector('.dt-got')) span.insertAdjacentHTML('beforeend', gotTag(a.dataset.mark));
  }, 50);
});

function offlineMsg(e) {
  return e instanceof TypeError
    ? 'Không kết nối được máy tính. Máy tính phải đang bật, mở CircleVault, và điện thoại dùng cùng Wi-Fi.'
    : e.message;
}

gate().then(dev => {
  if (!dev) return;
  $('#dtLocked').hidden = true; $('#dtMain').hidden = false;
  $('#devName').textContent = dev.name || '';
  let tab = 'music';
  try { tab = localStorage.getItem('cv-dt-tab') || 'music'; } catch (e) { /* bỏ qua */ }
  setTab(tab === 'video' ? 'video' : 'music');
  loadPlaylists();
  loadTracks();
});
})();
