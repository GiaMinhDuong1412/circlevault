/* CircleVault – giao diện (JS thuần, không cần build) */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const KINDS = {
  youtube: {label: 'YouTube', color: 'var(--red)'},
  film:    {label: 'Phim / video web', color: 'var(--violet)'},
  other:   {label: 'Trang khác', color: 'var(--cyan)'},
  comic:   {label: 'Truyện tranh', color: 'var(--green)'},
  novel:   {label: 'Truyện chữ', color: 'var(--yellow)'},
};
const QUALITY = [
  ['best', 'Tốt nhất'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['audio', 'Chỉ âm thanh MP3'],
];
const STATUS = {
  queued: 'Chờ', running: 'Đang tải', processing: 'Đang xử lý', paused: 'Tạm dừng',
  done: 'Xong', error: 'Lỗi', canceled: 'Đã hủy',
};
const STAGE = {Merger: 'Ghép hình + tiếng', FFmpegExtractAudio: 'Chuyển sang MP3', FFmpegEmbedSubtitle: 'Nhúng phụ đề',
  EmbedThumbnail: 'Nhúng ảnh bìa', FFmpegMetadata: 'Ghi thông tin'};

/* ------------------------------------------------------------ helpers */
async function api(path, opts = {}) {
  const init = {method: opts.method || 'GET', headers: {}};
  if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    throw new Error(typeof d === 'string' ? d : (r.status === 422 ? 'Dữ liệu gửi lên không hợp lệ.' : `Lỗi máy chủ (${r.status}).`));
  }
  return data;
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('vi-VN', {maximumFractionDigits: n < 10 && i > 0 ? 1 : 0})} ${u[i]}`;
}
function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(x).padStart(2, '0');
}
function fmtEta(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.round(s)} giây`;
  if (s < 3600) return `${Math.round(s / 60)} phút`;
  return `${(s / 3600).toFixed(1)} giờ`;
}
const fmtNum = n => (n || 0).toLocaleString('vi-VN');
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast box ${kind}`; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}
function hashCode(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
const PALS = [['#1b2a3a','#3c5a78','#c7d6e4'],['#ff6b6b','#ffd166','#2b2d42'],['#3a0ca3','#7209b7','#f72585'],['#06d6a0','#118ab2','#073b4c'],
  ['#f4a261','#e76f51','#264653'],['#778da9','#1b263b','#e0e1dd'],['#ffbe0b','#fb5607','#3a86ff'],['#2d6a4f','#95d5b2','#081c15']];
function gradient(seed) {
  const i = hashCode(seed), p = PALS[i % PALS.length], a = i % 360;
  return `radial-gradient(circle at ${20 + i % 60}% ${25 + (i >> 3) % 50}%, ${p[2]} 0 14%, transparent 15%),` +
         `repeating-linear-gradient(${a}deg, transparent 0 14px, rgba(255,255,255,.08) 14px 16px), linear-gradient(${a}deg, ${p[0]}, ${p[1]})`;
}
/* Ảnh bìa: dùng thumbnail thật nếu có, nếu lỗi thì hiện nền màu sinh từ tiêu đề */
function cover(url, seed, extra = '', cls = '') {
  const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return `<div class="cover ${cls}" style="background:${gradient(seed)}">${img}${extra}</div>`;
}
const kindBadge = k => `<span class="badge" style="background:${(KINDS[k] || KINDS.other).color}">${esc((KINDS[k] || KINDS.other).label)}</span>`;
const isAudio = p => /\.(mp3|m4a|opus|aac|ogg|wav|flac)$/i.test(p || '');

/* ------------------------------------------------------------ state */
const S = {status: null, config: null, tasks: [], recent: [], featuredIdx: 0, libKind: '', libQuery: '', analysis: null,
  quality: null, view: 'home'};

/* Dùng chung cho js/eq.js, js/music.js (nạp sau file này) */
window.CV = {api, esc, toast, fmtBytes, fmtDur, gradient, cover, S, views: {}, refreshStatus: () => loadStatus()};

/* ------------------------------------------------------------ sidebar + stats */
async function loadStatus() {
  try { S.status = await api('/api/status'); } catch (e) { return; }
  const st = S.status, c = st.counts || {};
  $('#sideSources').innerHTML = ['youtube', 'film', 'other', 'comic', 'novel'].map(k =>
    `<li><a href="#library" data-kind="${k}"><span class="dot" style="background:${KINDS[k].color}"></span>${KINDS[k].label}<span class="n">${fmtNum(c[k])}</span></a></li>`).join('');
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  $('#sideTotal').textContent = fmtNum(total);
  $('#sideActive').textContent = st.active;
  $('#qCount').textContent = st.active ? `(${st.active})` : '';
  $('#sideDisks').innerHTML = st.disks.map(diskBar).join('');
  renderStats();
}
function diskBar(d) {
  if (!d.online) return `<div class="disk"><div class="disk-row"><span>${esc(d.label)}</span><span class="no">không thấy ổ</span></div><div class="bar"><i class="w0" style="width:0"></i></div></div>`;
  const u = d.usage, col = d.full ? 'var(--red)' : u.percent > 75 ? 'var(--yellow)' : 'var(--green)';
  return `<div class="disk"><div class="disk-row"><span>${esc(d.label)}</span><span>${fmtBytes(u.used)} / ${fmtBytes(u.total)}</span></div>
    <div class="bar"><i style="width:${u.percent}%;background:${col}"></i></div></div>`;
}
function renderStats() {
  const st = S.status; if (!st) return;
  const c = st.counts || {};
  const videos = (c.youtube || 0) + (c.film || 0) + (c.other || 0);
  const totalDisk = st.disks.filter(d => d.online).reduce((a, d) => a + d.usage.total, 0);
  const usedDisk = st.disks.filter(d => d.online).reduce((a, d) => a + d.usage.used, 0);
  $('#stats').innerHTML = `
    <div>
      <h3><b>Kho cá nhân</b> · Video, Phim, Truyện</h3>
      <p>Mọi thứ nằm trên ổ cứng của bạn. App ghi nhớ những gì đã tải nên dán lại link playlist hay kênh chỉ tải phần mới.</p>
    </div>
    <div class="nums">
      <div class="num"><b>${fmtNum(videos)}</b>Video &amp; phim</div>
      <div class="num"><b>${fmtBytes(st.library_bytes)}</b>trong thư viện</div>
      <div class="num"><b>${fmtBytes(usedDisk)}</b>đã dùng / ${fmtBytes(totalDisk)}</div>
    </div>`;
}

/* ------------------------------------------------------------ home: analyze */
async function analyze(playlist) {
  const url = $('#urlInput').value.trim();
  if (!url) { $('#urlInput').focus(); return; }
  const box = $('#analysis');
  box.innerHTML = `<div class="box loading"><span class="spin"></span>Đang đọc link… (playlist dài có thể mất vài chục giây)</div>`;
  $('#analyzeBtn').disabled = true;
  try {
    const r = await api('/api/analyze', {method: 'POST', body: {url, playlist}});
    S.analysis = {...r, url};
    if (!S.quality) S.quality = S.config?.default_quality || '1080';
    renderAnalysis();
  } catch (e) {
    box.innerHTML = `<div class="box notice err"><b>Không đọc được link này</b><span>${esc(e.message)}</span>
      <span class="hint">Nếu là YouTube: thử cập nhật yt-dlp ở trang Lưu Trữ, hoặc bật cookie trình duyệt cho video giới hạn tuổi.</span></div>`;
  } finally { $('#analyzeBtn').disabled = false; }
}
function renderAnalysis() {
  const a = S.analysis, box = $('#analysis');
  if (!a) { box.innerHTML = ''; return; }
  if (!a.detect.supported) {
    box.innerHTML = `<div class="box notice warn"><b>${esc(a.detect.label)}: chưa hỗ trợ</b><span>${esc(a.detect.note)}</span></div>`;
    return;
  }
  const i = a.info, maxH = i.heights.length ? i.heights[0] : null;
  const tooHigh = q => maxH && /^\d+$/.test(q) && +q > maxH;
  if (tooHigh(S.quality)) S.quality = 'best';   // video không có độ phân giải đó → lấy cao nhất hiện có
  const chips = QUALITY.map(([q, l]) => {
    const disabled = tooHigh(q);
    return `<button type="button" class="chip ${S.quality === q ? 'on' : ''}" data-q="${q}" ${disabled ? 'disabled' : ''}>${l}</button>`;
  }).join('');
  const disk = a.disk ? `${esc(a.disk.label)} · còn ${fmtBytes(a.disk.usage?.free)}` : '<span class="no">Không có ổ nào còn chỗ</span>';
  const meta = [i.uploader, i.is_playlist ? `${fmtNum(i.count)} video` : fmtDur(i.duration), i.extractor, maxH ? `tối đa ${maxH}p` : '']
    .filter(Boolean).map(esc).join(' · ');
  const have = i.have_count ? `<div class="notice box warn" style="box-shadow:none;border-width:2px;border-left-width:8px">
      <b>Đã có ${fmtNum(i.have_count)}${i.is_playlist ? '/' + fmtNum(i.count) : ''} trong kho</b>
      <span class="hint">Những mục này sẽ được bỏ qua.</span>
      <label class="check"><input type="checkbox" id="force"> Tải lại cả mục đã có</label></div>` : '';
  const listToggle = a.detect.has_list ? `<label class="check"><input type="checkbox" id="plToggle" ${a.playlist ? 'checked' : ''}> Tải cả danh sách phát</label>` : '';
  const entries = i.entries.length ? `<details><summary class="hint" style="cursor:pointer">Xem danh sách (${fmtNum(i.count)})</summary>
      <div class="entries">${i.entries.map((e, n) => `<div><span>${n + 1}</span><span>${esc(e.title)}</span>${e.have ? '<span class="have">ĐÃ CÓ</span>' : ''}</div>`).join('')}
      ${i.count > i.entries.length ? `<div><span></span><span class="hint">… và ${fmtNum(i.count - i.entries.length)} video khác</span></div>` : ''}</div></details>` : '';
  box.innerHTML = `<div class="an box">
    ${cover(i.thumbnail, i.title, `<div class="tl">${kindBadge(a.detect.kind)}${i.is_playlist ? '<span class="badge" style="background:var(--yellow)">Playlist</span>' : ''}</div>`)}
    <div class="body">
      <div><h3>${esc(i.title)}</h3><div class="meta">${meta}</div></div>
      ${listToggle}
      <div class="opt-row"><b>Chất lượng</b>${chips}</div>
      <div class="hint">Lưu vào: <b>${disk}</b></div>
      ${have}${entries}
      ${i.warnings?.length ? `<div class="hint">Cảnh báo: ${esc(i.warnings.join(' | '))}</div>` : ''}
      <div class="btn-row"><button class="btn green" type="button" id="dlBtn" ${a.disk ? '' : 'disabled'}>TẢI NGAY</button>
        <button class="btn plain" type="button" id="anClose">Bỏ qua</button></div>
    </div></div>`;
  $$('[data-q]', box).forEach(b => b.addEventListener('click', () => { S.quality = b.dataset.q; renderAnalysis(); }));
  $('#plToggle')?.addEventListener('change', e => analyze(e.target.checked));
  $('#anClose').addEventListener('click', () => { S.analysis = null; renderAnalysis(); });
  $('#dlBtn').addEventListener('click', startDownload);
}
async function startDownload() {
  const a = S.analysis; if (!a) return;
  $('#dlBtn').disabled = true;
  try {
    await api('/api/tasks', {method: 'POST', body: {
      url: a.url, quality: S.quality, playlist: !!a.playlist, force: !!$('#force')?.checked,
      title: a.info.title, thumbnail: a.info.thumbnail}});
    toast(`Đã thêm vào hàng đợi: ${a.info.title}`);
    S.analysis = null; $('#urlInput').value = ''; renderAnalysis();
    location.hash = '#queue';
  } catch (e) { toast(e.message, 'err'); $('#dlBtn').disabled = false; }
}

/* ------------------------------------------------------------ home: featured */
async function loadRecent() {
  try { S.recent = (await api('/api/library?limit=7')).items; } catch (e) { S.recent = []; }
  renderFeatured();
}
function renderFeatured() {
  const box = $('#featured');
  if (!S.recent.length) {
    box.innerHTML = `<div class="box empty"><h3>Kho đang trống</h3><p>Dán link YouTube hoặc link video ở ô phía trên, bấm Phân tích rồi Tải ngay. Video tải xong sẽ hiện ở đây.</p></div>`;
    return;
  }
  const it = S.recent[Math.min(S.featuredIdx, S.recent.length - 1)];
  box.innerHTML = `<div class="feature box">
    ${cover(it.thumbnail, it.title, `<div class="tl">${kindBadge(it.kind)}${it.height ? `<span class="badge" style="background:var(--surface)">${it.height}p</span>` : ''}<span class="badge" style="background:var(--green)">Đã lưu</span></div><div class="big">${esc(it.title)}</div>`)}
    <div class="f-info">
      <div><h3>${esc(it.title)}</h3><div class="status">${it.exists ? 'Đã lưu vào ' + esc(diskLabel(it.disk_id)) : 'File không còn trên ổ'}</div></div>
      <dl class="f-meta">
        ${it.uploader ? `<dt>Kênh</dt><dd>${esc(it.uploader)}</dd>` : ''}
        <dt>Dung lượng</dt><dd>${fmtBytes(it.filesize)}${it.duration ? ' · ' + fmtDur(it.duration) : ''}</dd>
        <dt>Đường dẫn</dt><dd>${esc(it.filepath)}</dd>
      </dl>
      <div class="thumbs">${S.recent.slice(0, 6).map((r, n) =>
        `<button type="button" class="thumb cover ${r.id === it.id ? 'sel' : ''}" data-i="${n}" aria-label="${esc(r.title)}" style="background:${gradient(r.title)}">${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="cap">${esc(r.title)}</span>`}</button>`).join('')}</div>
      <div class="btn-row"><button class="btn yellow" type="button" id="fPlay">XEM NGAY</button><a class="btn green" href="#library">XEM THÊM</a></div>
    </div></div>`;
  $$('.thumb', box).forEach(b => b.addEventListener('click', () => { S.featuredIdx = +b.dataset.i; renderFeatured(); }));
  $('.feature > .cover', box).addEventListener('click', () => openPlayer(it));
  $('#fPlay').addEventListener('click', () => openPlayer(it));
}
const diskLabel = id => (S.status?.disks.find(d => d.id === id)?.label) || id || '';

/* ------------------------------------------------------------ queue */
async function loadTasks() {
  try { S.tasks = await api('/api/tasks'); } catch (e) { return; }
  if (S.view === 'queue') renderQueue();
}
function taskActions(t) {
  const b = (act, label, cls = 'plain') => `<button class="btn sm ${cls}" type="button" data-act="${act}" data-id="${t.id}">${label}</button>`;
  switch (t.status) {
    case 'running': case 'processing': case 'queued': return b('pause', 'Tạm dừng') + b('cancel', 'Hủy');
    case 'paused': return b('resume', 'Tiếp tục', 'cyan') + b('cancel', 'Hủy');
    case 'error': return b('retry', 'Thử lại', 'yellow') + b('delete', 'Xóa');
    default: return b('delete', 'Xóa');
  }
}
function renderQueue() {
  const L = $('#qList');
  if (!S.tasks.length) {
    L.innerHTML = `<div class="box empty"><h3>Hàng đợi trống</h3><p>Chưa có tác vụ nào. Vào Trang Chủ, dán link và bấm Tải ngay.</p><a class="btn yellow" href="#home">Về Trang Chủ</a></div>`;
    return;
  }
  L.innerHTML = S.tasks.map(t => {
    const pct = t.status === 'done' ? 100 : (t.progress || 0);
    const parts = [];
    if (t.status === 'running') {
      if (t.speed) parts.push(`${fmtBytes(t.speed)}/s`);
      if (t.eta != null) parts.push(`còn ${fmtEta(t.eta)}`);
    }
    if (t.status === 'processing' && t.stage) parts.push(STAGE[t.stage] || t.stage);
    if (t.item_count > 1) parts.push(`video ${t.item_index || 0}/${t.item_count}`);
    if (t.status === 'done') {
      parts.push(t.done_count ? `${fmtNum(t.done_count)} file mới` : '');
      if (t.skipped_count) parts.push(`${fmtNum(t.skipped_count)} đã có, bỏ qua`);
    }
    parts.push(QUALITY.find(q => q[0] === t.quality)?.[1] || t.quality);
    if (t.disk_id) parts.push(diskLabel(t.disk_id));
    const title = t.title || t.current_title || t.url;
    const cur = t.current_title && t.current_title !== title && ['running', 'processing'].includes(t.status) ? `<div class="sub">Đang tải: ${esc(t.current_title)}</div>` : '';
    const barCol = {error: 'var(--red)', done: 'var(--green)', processing: 'var(--violet)', paused: 'var(--muted)'}[t.status] || 'var(--cyan)';
    return `<div class="q box">
      ${cover(t.thumbnail, title)}
      <div style="min-width:0"><h5>${esc(title)}</h5>${cur}
        <div class="sub">${esc(parts.filter(Boolean).join(' · '))}</div>
        ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
        <div class="prog"><div class="bar"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:${barCol}"></i></div><span class="pct">${pct.toFixed(pct < 100 ? 1 : 0)}%</span></div>
      </div>
      <div class="act"><span class="badge st-${t.status}">${STATUS[t.status] || t.status}</span><div class="btn-row">${taskActions(t)}</div></div>
    </div>`;
  }).join('');
}
$('#qList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const {act, id} = b.dataset; b.disabled = true;
  try {
    if (act === 'delete') await api(`/api/tasks/${id}`, {method: 'DELETE'});
    else await api(`/api/tasks/${id}/${act}`, {method: 'POST'});
  } catch (err) { toast(err.message, 'err'); }
  await loadTasks(); loadStatus();
});
$('#clearDone').addEventListener('click', async () => { await api('/api/tasks', {method: 'DELETE'}); loadTasks(); });

/* ------------------------------------------------------------ library */
async function loadLibrary() {
  const g = $('#libGrid');
  const kinds = [['', 'Tất cả'], ['youtube', 'YouTube'], ['film', 'Phim'], ['other', 'Trang khác']];
  $('#filters').innerHTML = kinds.map(([k, l]) => `<button class="chip ${S.libKind === k ? 'on' : ''}" data-k="${k}" type="button">${l}</button>`).join('');
  $('#libTitle').textContent = S.libQuery ? `Kết quả cho “${S.libQuery}”` : 'Thư viện';
  let data;
  try { data = await api(`/api/library?limit=300&kind=${encodeURIComponent(S.libKind)}&q=${encodeURIComponent(S.libQuery)}`); }
  catch (e) { g.innerHTML = `<div class="box notice err">${esc(e.message)}</div>`; return; }
  if (!data.items.length) {
    g.innerHTML = `<div class="box empty" style="grid-column:1/-1"><h3>Không có mục nào</h3><p>${S.libQuery || S.libKind ? 'Thử bỏ bộ lọc hoặc đổi từ khóa.' : 'Thư viện trống. Tải video đầu tiên ở Trang Chủ.'}</p></div>`;
    return;
  }
  S.libItems = data.items;
  g.innerHTML = data.items.map((it, n) => `<button type="button" class="card box" data-n="${n}">
      ${cover(it.thumbnail, it.title, `<div class="tl">${kindBadge(it.kind)}${it.exists ? '' : '<span class="badge" style="background:var(--red)">Mất file</span>'}</div>`)}
      <div class="bd"><b>${esc(it.title)}</b><span>${[it.duration ? fmtDur(it.duration) : '', it.height ? it.height + 'p' : '', fmtBytes(it.filesize), diskLabel(it.disk_id)].filter(Boolean).map(esc).join(' · ')}</span></div>
    </button>`).join('');
}
$('#filters').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; S.libKind = b.dataset.k; loadLibrary(); });
$('#libGrid').addEventListener('click', e => { const c = e.target.closest('[data-n]'); if (c) openPlayer(S.libItems[+c.dataset.n]); });

/* ------------------------------------------------------------ player */
function openPlayer(it) {
  const dlg = $('#player');
  $('#plTitle').textContent = it.title;
  const src = `/api/library/${it.id}/file`;
  $('#plMedia').innerHTML = !it.exists ? `<div class="notice box err">File không còn ở ${esc(it.filepath)}. Có thể đã bị xóa hoặc ổ chưa cắm.</div>`
    : isAudio(it.filepath) ? `<audio controls autoplay src="${src}"></audio>`
    : `<video controls autoplay playsinline src="${src}"></video>`;
  $('#plMeta').innerHTML = `
    ${it.uploader ? `<dt>Kênh</dt><dd>${esc(it.uploader)}</dd>` : ''}
    <dt>File</dt><dd>${esc(it.filepath)}</dd>
    <dt>Dung lượng</dt><dd>${fmtBytes(it.filesize)}${it.height ? ' · ' + it.height + 'p' : ''}${it.duration ? ' · ' + fmtDur(it.duration) : ''}</dd>
    ${it.source_url ? `<dt>Nguồn</dt><dd><a href="${esc(it.source_url)}" target="_blank" rel="noopener">${esc(it.source_url)}</a></dd>` : ''}`;
  $('#plActions').innerHTML = `
    ${it.exists ? `<button class="btn yellow" type="button" data-pa="open">Mở thư mục</button><a class="btn plain" href="${src}" download>Lưu bản sao</a>` : ''}
    <button class="btn plain" type="button" data-pa="remove">Xóa khỏi thư viện</button>
    ${it.exists ? `<button class="btn red" type="button" data-pa="delete">Xóa cả file</button>` : ''}`;
  $('#plActions').onclick = async e => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    const act = b.dataset.pa;
    try {
      if (act === 'open') { await api(`/api/library/${it.id}/open`, {method: 'POST'}); return; }
      if (act === 'delete' && b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa để xóa vĩnh viễn'; return; }
      await api(`/api/library/${it.id}?delete_file=${act === 'delete'}`, {method: 'DELETE'});
      toast(act === 'delete' ? 'Đã xóa file khỏi ổ.' : 'Đã xóa khỏi thư viện (file vẫn còn trên ổ).');
      dlg.close(); refreshView(); loadStatus();
    } catch (err) { toast(err.message, 'err'); }
  };
  dlg.showModal();
}
$('#plClose').addEventListener('click', () => $('#player').close());
$('#player').addEventListener('close', () => { $('#plMedia').innerHTML = ''; });
$('#player').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ------------------------------------------------------------ storage / settings */
async function loadStorage() {
  try { S.config = await api('/api/config'); } catch (e) { toast(e.message, 'err'); return; }
  await loadStatus();
  renderConfig(); renderTools();
}
function renderConfig() {
  const c = S.config, st = S.status;
  const diskOpts = sel => c.disks.map(d => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  const disks = c.disks.map((d, n) => {
    const s = st?.disks.find(x => x.id === d.id);
    return `<div class="box pcard" data-disk="${n}">
      <div class="row-between"><h3>${esc(d.label)}</h3>${c.disks.length > 1 ? `<button class="btn sm plain" type="button" data-rm="${n}">Bỏ ổ này</button>` : ''}</div>
      ${s ? diskBar(s) : ''}
      ${s?.online ? `<p class="hint mono">Còn trống ${fmtBytes(s.usage.free)}${s.full ? ' · ĐÃ QUÁ NGƯỠNG' : ''}</p>` : '<p class="no">Không tìm thấy ổ hoặc thư mục cha.</p>'}
      <div class="field-row">
        <label class="field">Mã<input type="text" id="disk-id-${n}" name="id" value="${esc(d.id)}" maxlength="8"></label>
        <label class="field">Tên hiển thị<input type="text" id="disk-label-${n}" name="label" value="${esc(d.label)}" maxlength="40"></label>
      </div>
      <label class="field">Thư mục lưu<input type="text" id="disk-root-${n}" name="root" value="${esc(d.root)}" placeholder="E:\\CircleVault"><small>App tự tạo thư mục nếu chưa có.</small></label>
    </div>`;
  }).join('');
  const rules = ['youtube', 'film', 'other'].map(k => {
    const order = c.rules[k] || [];
    return `<tr><td>${KINDS[k].label}</td><td><select id="rule-${k}" data-rule="${k}">${diskOpts(order[0])}</select></td>
      <td class="hint">Khi ổ này quá ${c.max_full_percent}% sẽ tự chuyển sang ổ còn lại.</td></tr>`;
  }).join('');
  const qOpts = QUALITY.map(([q, l]) => `<option value="${q}" ${c.default_quality === q ? 'selected' : ''}>${l}</option>`).join('');
  const browsers = ['', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium'];
  const bOpts = browsers.map(b => `<option value="${b}" ${c.cookies_from_browser === b ? 'selected' : ''}>${b ? b[0].toUpperCase() + b.slice(1) : 'Không dùng'}</option>`).join('');
  $('#cfgForm').innerHTML = `
    <div class="cols2">${disks}</div>
    <div><button class="btn plain" type="button" id="addDisk">+ Thêm ổ</button></div>
    <div class="tablebox box"><table class="rules"><thead><tr><th>Loại</th><th>Ổ ưu tiên</th><th>Ghi chú</th></tr></thead><tbody>${rules}</tbody></table></div>
    <div class="box pcard">
      <h3>Tùy chọn tải</h3>
      <div class="cols3">
        <label class="field">Chất lượng mặc định<select id="defQuality">${qOpts}</select></label>
        <label class="field">Ngưỡng đầy ổ (%)<input type="number" id="maxFull" min="50" max="99" value="${c.max_full_percent}"></label>
        <label class="field">Số luồng tải mỗi ổ<input type="number" id="maxConc" min="1" max="8" value="${c.max_concurrent_per_disk}"><small>HDD nên để 2–3.</small></label>
        <label class="field">Ngôn ngữ phụ đề<input type="text" id="subLangs" value="${esc(c.subtitle_langs.join(', '))}"><small>Mã ngôn ngữ, cách nhau dấu phẩy.</small></label>
        <label class="field">Cookie từ trình duyệt<select id="cookies">${bOpts}</select><small>Cho video giới hạn tuổi / thành viên. Đóng trình duyệt trước khi tải.</small></label>
        <label class="field">Mạng<select id="host"><option value="127.0.0.1" ${c.host === '127.0.0.1' ? 'selected' : ''}>Chỉ máy này</option><option value="0.0.0.0" ${c.host === '0.0.0.0' ? 'selected' : ''}>Cho điện thoại cùng Wi-Fi</option></select><small>Cần mở lại app để áp dụng.</small></label>
      </div>
      <label class="check"><input type="checkbox" id="embedSubs" ${c.embed_subs ? 'checked' : ''}> Tải và nhúng phụ đề vào video</label>
    </div>
    <div class="btn-row"><button class="btn green" type="submit">LƯU CÀI ĐẶT</button></div>`;
  $('#addDisk').addEventListener('click', () => {
    collectConfig();
    const used = new Set(S.config.disks.map(d => d.id));
    const id = 'FGHIJKLMNOP'.split('').find(x => !used.has(x)) || String(Date.now() % 1000);
    S.config.disks.push({id, label: `Ổ ${id}:`, root: ''}); renderConfig();
  });
  $$('[data-rm]').forEach(b => b.addEventListener('click', () => { collectConfig(); S.config.disks.splice(+b.dataset.rm, 1); renderConfig(); }));
}
function collectConfig() {
  const c = S.config;
  c.disks = $$('[data-disk]').map(el => ({id: $('[name=id]', el).value.trim(), label: $('[name=label]', el).value.trim(), root: $('[name=root]', el).value.trim()}));
  const ids = c.disks.map(d => d.id);
  $$('[data-rule]').forEach(s => {
    const first = ids.includes(s.value) ? s.value : ids[0];
    const order = [first, ...ids.filter(i => i !== first)];
    c.rules[s.dataset.rule] = order;
  });
  // truyện ưu tiên ổ khác với video nếu có từ 2 ổ
  const vid = c.rules.youtube[0];
  const comicOrder = ids.length > 1 ? [ids.find(i => i !== vid), vid] : ids;
  c.rules.comic = comicOrder; c.rules.novel = comicOrder;
  if ($('#defQuality')) {
    c.default_quality = $('#defQuality').value;
    c.max_full_percent = +$('#maxFull').value;
    c.max_concurrent_per_disk = +$('#maxConc').value;
    c.subtitle_langs = $('#subLangs').value.split(',').map(s => s.trim()).filter(Boolean);
    c.cookies_from_browser = $('#cookies').value;
    c.host = $('#host').value;
    c.embed_subs = $('#embedSubs').checked;
  }
  return c;
}
$('#cfgForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    S.config = await api('/api/config', {method: 'PUT', body: collectConfig()});
    toast('Đã lưu cài đặt.'); loadStorage();
  } catch (err) { toast(err.message, 'err'); }
});
function renderTools() {
  const t = S.status?.tools || {};
  const app = S.status?.app || {};
  $('#tools').innerHTML = `
    <div class="box pcard"><h3>CircleVault <span class="mono">${esc(app.version || 'dev')}</span></h3>
      <p class="hint">${window.cvDesktop ? 'App tự kiểm tra bản mới mỗi 4 giờ.' : 'Đang chạy từ mã nguồn (không tự cập nhật).'} Dữ liệu: <code>${esc(app.data || '')}</code></p>
      ${window.cvDesktop ? '<div><button class="btn cyan" type="button" id="chkUpd">Kiểm tra cập nhật</button></div>' : ''}</div>
    <div class="box pcard"><h3>yt-dlp <span class="mono">${esc(t.yt_dlp || '?')}</span></h3>
      <p class="hint">YouTube thay đổi thường xuyên. Khi tải bị lỗi, hãy cập nhật trước tiên.</p>
      <div><button class="btn yellow" type="button" id="updYt">Cập nhật yt-dlp</button></div></div>
    <div class="box pcard"><h3>ffmpeg: ${t.ffmpeg ? '<span class="ok">có</span>' : '<span class="no">chưa cài</span>'}</h3>
      <p class="hint">${t.ffmpeg ? 'Dùng để ghép hình + tiếng, tạo MP3, nhúng phụ đề.' : 'Không có ffmpeg thì chỉ tải được tối đa 720p.' + (window.cvDesktop ? ' Bản app đã kèm sẵn ffmpeg; hãy cài lại app.' : ' Cài bằng lệnh: <code>winget install Gyan.FFmpeg</code> rồi mở lại.')}</p></div>
    <div class="box pcard"><h3>Deno: ${t.deno ? '<span class="ok">có</span>' : '<span class="no">chưa cài</span>'}</h3>
      <p class="hint">${t.deno ? 'yt-dlp dùng Deno để giải mã link YouTube.' : 'YouTube cần Deno để lấy đủ định dạng.' + (window.cvDesktop ? ' Bản app đã kèm sẵn Deno; hãy cài lại app.' : ' Cài bằng: <code>winget install DenoLand.Deno</code> rồi mở lại.')}</p></div>`;
  $('#chkUpd')?.addEventListener('click', () => { window.cvDesktop.updateAct(); toast('Đang kiểm tra bản mới…'); });
  $('#updYt').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Đang cập nhật…';
    try {
      const r = await api('/api/tools/update-ytdlp', {method: 'POST'});
      toast(r.message);
      if (r.need_restart && window.cvDesktop?.restartServer) {
        b.textContent = 'Đang khởi động lại…';
        await window.cvDesktop.restartServer();   // app tắt/mở lại phần tải (backend) rồi nạp lại trang
        return;
      }
    } catch (err) { toast(err.message, 'err'); }
    b.disabled = false; b.textContent = 'Cập nhật yt-dlp';
  });
}

/* ------------------------------------------------------------ routing */
function refreshView() {
  if (S.view === 'home') loadRecent();
  if (S.view === 'queue') loadTasks();
  if (S.view === 'library') loadLibrary();
  if (S.view === 'storage') loadStorage();
  if (S.view === 'music' && window.CV.views.music) window.CV.views.music();
}
function route() {
  const v = (location.hash || '#home').slice(1);
  S.view = ['home', 'queue', 'library', 'music', 'storage'].includes(v) ? v : 'home';
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === S.view));
  document.body.classList.toggle('view-music', S.view === 'music');
  $$('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== S.view);
  refreshView();
}
window.addEventListener('hashchange', route);
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-kind]'); if (!a) return;
  S.libKind = a.dataset.kind; S.libQuery = ''; $('#searchInput').value = '';
  if (S.view === 'library') loadLibrary();
});
$('#searchForm').addEventListener('submit', e => {
  e.preventDefault(); S.libQuery = $('#searchInput').value.trim(); S.libKind = '';
  if (location.hash === '#library') loadLibrary(); else location.hash = '#library';
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#searchInput').focus(); }
});

/* ------------------------------------------------------------ home events */
$('#pasteForm').addEventListener('submit', e => { e.preventDefault(); S.quality = null; analyze(null); });
$('#urlInput').addEventListener('paste', () => setTimeout(() => { S.quality = null; analyze(null); }, 50));
$('#pasteBtn').addEventListener('click', async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return toast('Bộ nhớ tạm đang trống.', 'err');
    $('#urlInput').value = t; S.quality = null; analyze(null);
  } catch (e) { toast('Trình duyệt không cho đọc bộ nhớ tạm. Hãy bấm vào ô rồi nhấn Ctrl+V.', 'err'); $('#urlInput').focus(); }
});
$('#themeBtn').addEventListener('click', () => {
  const r = document.documentElement;
  const cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  r.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('cv-theme', r.dataset.theme); } catch (e) {}
});

/* ------------------------------------------------------------ cập nhật app (chỉ có trong app desktop) */
function renderUpdate(u) {
  const box = $('#updBox');
  if (!u) { box.hidden = true; return; }
  const btn = (label, cls = 'green') => `<button class="btn sm ${cls}" type="button" id="updAct">${label}</button>`;
  let html = '';
  switch (u.status) {
    case 'available': html = `<span>Có bản mới <b>${esc(u.version)}</b></span>` + btn(u.portable ? 'Tải bản mới' : 'Cập nhật'); break;
    case 'downloading': html = `<span>Đang tải bản mới… <b>${u.percent || 0}%</b></span>`; break;
    case 'downloaded': html = `<span>Bản <b>${esc(u.version)}</b> đã sẵn sàng</span>` + btn('Khởi động lại để cập nhật', 'yellow'); break;
    case 'checking': html = '<span>Đang kiểm tra bản mới…</span>'; break;
    case 'latest': html = `<span>Đang dùng bản mới nhất (${esc(u.current)})</span>`; setTimeout(() => { $('#updBox').hidden = true; }, 5000); break;
    case 'error': html = `<span class="no">${esc(u.error || 'Lỗi cập nhật')}</span>` + btn('Thử lại', 'plain'); break;
    case 'unsupported': html = `<span>${esc(u.error || '')}</span>`; break;
    default: box.hidden = true; return;
  }
  box.innerHTML = html; box.hidden = false;
  $('#updAct')?.addEventListener('click', () => window.cvDesktop.updateAct());
}
if (window.cvDesktop) {
  window.cvDesktop.onUpdate(renderUpdate);
  window.cvDesktop.getUpdate().then(renderUpdate).catch(() => {});
}

/* ------------------------------------------------------------ polling */
let lastActive = 0;
async function poll() {
  await loadStatus();
  const active = S.status?.active || 0;
  if (S.view === 'queue' || active) await loadTasks();
  if (lastActive && active < lastActive) {                                  // vừa có video/bài hát tải xong
    if (S.view === 'home') loadRecent();
    if (window.CV.music) window.CV.music.reload();
  }
  lastActive = active;
  setTimeout(poll, active || S.view === 'queue' ? 1000 : 4000);
}

(async () => {
  try { S.config = await api('/api/config'); } catch (e) {}
  route();
  poll();
})();
})();
