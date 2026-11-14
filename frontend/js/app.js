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
    const err = new Error(typeof d === 'string' ? d : (r.status === 422 ? 'Dữ liệu gửi lên không hợp lệ.' : `Lỗi máy chủ (${r.status}).`));
    err.status = r.status;
    throw err;
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
  if (!S.notesChecked) { S.notesChecked = true; setTimeout(() => showWhatsNew(false), 1200); }
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
      <span class="hint">Nếu là YouTube: thử cập nhật yt-dlp ở tab Cài đặt, hoặc bật cookie trình duyệt cho video giới hạn tuổi.</span></div>`;
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
  const canMp4 = it.exists && !isAudio(it.filepath) && !/\.mp4$/i.test(it.filepath);
  $('#plActions').innerHTML = `
    ${it.exists ? `<button class="btn green" type="button" data-pa="cut">✂ Cắt đoạn</button>` : ''}
    ${canMp4 ? `<button class="btn cyan" type="button" data-pa="mp4">Chuyển sang MP4</button>` : ''}
    ${it.exists ? `<button class="btn yellow" type="button" data-pa="open">Mở thư mục</button><a class="btn plain" href="${src}" download>Lưu bản sao</a>` : ''}
    <button class="btn plain" type="button" data-pa="remove">Xóa khỏi thư viện</button>
    ${it.exists ? `<button class="btn red" type="button" data-pa="delete">Xóa cả file</button>` : ''}`;
  $('#plActions').onclick = async e => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    const act = b.dataset.pa;
    try {
      if (act === 'open') { await api(`/api/library/${it.id}/open`, {method: 'POST'}); return; }
      if (act === 'cut') return openCutter({kind: 'item', id: it.id, title: it.title, src, audio: isAudio(it.filepath), duration: it.duration});
      if (act === 'mp4') {
        const j = await api(`/api/edit/item/${it.id}/mp4`, {method: 'POST'});
        b.disabled = true;
        return watchJob(j, b, 'Đã chuyển sang MP4 (file gốc vẫn còn).');
      }
      if (act === 'delete' && b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa để xóa vĩnh viễn'; return; }
      await api(`/api/library/${it.id}?delete_file=${act === 'delete'}`, {method: 'DELETE'});
      toast(act === 'delete' ? 'Đã xóa file khỏi ổ.' : 'Đã xóa khỏi thư viện (file vẫn còn trên ổ).');
      dlg.close(); refreshView(); loadStatus();
    } catch (err) { toast(err.message, 'err'); }
  };
  dlg.showModal();
}
/* ------------------------------------------------------------ cắt video / nhạc (ffmpeg, backend edit.py) */
function parseTime(v) {
  v = String(v || '').trim().replace(',', '.');
  if (!v) return NaN;
  const parts = v.split(':').map(Number);
  if (parts.some(n => isNaN(n) || n < 0)) return NaN;
  return parts.reduce((a, n) => a * 60 + n, 0);
}
function fmtTime(t) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = (t % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function watchJob(job, btn, doneMsg, onDone) {
  const tick = async () => {
    let j; try { j = await api(`/api/edit/jobs/${job.id}`); } catch (e) { toast(e.message, 'err'); return; }
    if (btn) btn.textContent = j.status === 'done' ? 'Xong' : `Đang xử lý ${Math.round(j.progress || 0)}%`;
    if (onDone && onDone.progress) onDone.progress(j);
    if (j.status === 'done') {
      toast(`${doneMsg} ${j.output ? '→ ' + j.output.split(/[\\/]/).pop() : ''}`);
      if (onDone && onDone.done) onDone.done(j);
      refreshView(); window.CV.music && window.CV.music.reload();
      return;
    }
    if (j.status === 'error') { toast(j.error || 'Lỗi', 'err'); if (btn) { btn.disabled = false; btn.textContent = 'Thử lại'; } if (onDone && onDone.fail) onDone.fail(j); return; }
    setTimeout(tick, 700);
  };
  tick();
}
/** Mở công cụ cắt trong hộp #player. o = {kind: 'item'|'track', id, title, src, audio, duration} */
function openCutter(o) {
  const dlg = $('#player');
  $('#plTitle').textContent = '✂ Cắt: ' + o.title;
  $('#plMedia').innerHTML = o.audio ? `<audio controls src="${o.src}" id="cutMedia"></audio>` : `<video controls playsinline src="${o.src}" id="cutMedia"></video>`;
  $('#plMeta').innerHTML = '';
  $('#plActions').innerHTML = `<div class="cutter">
    <div class="cut-track" id="cutTrack" title="Bấm để tua"><div class="cut-sel" id="cutSel"></div><div class="cut-head" id="cutHead"></div></div>
    <div class="cut-row">
      <label class="field">Điểm đầu<input type="text" id="cutA" value="0:00.0" inputmode="decimal"></label>
      <button class="btn sm plain" type="button" data-cut="a" title="Phím [">⇤ Lấy vị trí đang xem</button>
      <label class="field">Điểm cuối<input type="text" id="cutB" value="" inputmode="decimal"></label>
      <button class="btn sm plain" type="button" data-cut="b" title="Phím ]">Lấy vị trí đang xem ⇥</button>
    </div>
    <p class="hint" id="cutInfo"></p>
    <label class="check"><input type="checkbox" id="cutAcc"> Cắt chính xác từng khung hình${o.audio ? '' : ' (mã hóa lại sang MP4, chậm hơn)'}</label>
    <p class="hint">${o.audio ? 'Nhạc cắt nhanh vẫn đúng tới phần trăm giây.' : 'Cắt nhanh: giữ nguyên chất lượng, xong trong vài giây, nhưng điểm đầu có thể lệch 1–2 giây (video chỉ cắt được ở khung hình khóa).'} Bản cắt lưu thành file mới cạnh file gốc; file gốc giữ nguyên.</p>
    <div class="btn-row">
      <button class="btn plain" type="button" data-cut="preview">▶ Xem thử đoạn</button>
      <button class="btn green" type="button" data-cut="go">CẮT &amp; LƯU BẢN MỚI</button>
      <button class="btn plain" type="button" data-cut="back">Quay lại</button>
    </div>
    <div class="cut-prog" id="cutProg" hidden><div class="bar"><i id="cutBar" style="width:0"></i></div><span class="mono" id="cutPct">0%</span><button class="btn sm red" type="button" data-cut="cancel">Hủy</button></div>
  </div>`;
  const m = $('#cutMedia');
  let a = 0, b = 0, dur = o.duration || 0, previewEnd = null, job = null;
  const clamp = () => { a = Math.max(0, Math.min(a, dur || a)); b = Math.max(0, Math.min(b || dur, dur || b)); };
  const paint = () => {
    clamp();
    $('#cutA').value = fmtTime(a); $('#cutB').value = fmtTime(b);
    const ok = b - a >= 0.5;
    $('#cutInfo').innerHTML = dur ? `Đoạn đã chọn: <b>${fmtTime(a)} → ${fmtTime(b)}</b> · dài <b>${fmtTime(Math.max(0, b - a))}</b> / cả bài ${fmtTime(dur)}${ok ? '' : ' · <span class="no">điểm cuối phải sau điểm đầu</span>'}` : 'Đang đọc độ dài…';
    $('#cutSel').style.left = dur ? (a / dur * 100) + '%' : '0'; $('#cutSel').style.width = dur ? (Math.max(0, b - a) / dur * 100) + '%' : '0';
    $('[data-cut="go"]').disabled = !ok || !!job;
  };
  m.addEventListener('loadedmetadata', () => { if (isFinite(m.duration)) { dur = m.duration; if (!b) b = dur; paint(); } });
  m.addEventListener('timeupdate', () => {
    if (dur) $('#cutHead').style.left = (m.currentTime / dur * 100) + '%';
    if (previewEnd != null && m.currentTime >= previewEnd) { m.pause(); previewEnd = null; }
  });
  $('#cutTrack').addEventListener('click', e => {
    if (!dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    m.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  });
  $('#cutA').addEventListener('change', e => { const t = parseTime(e.target.value); if (!isNaN(t)) a = t; paint(); });
  $('#cutB').addEventListener('change', e => { const t = parseTime(e.target.value); if (!isNaN(t)) b = t; paint(); });
  const keys = e => {
    if (!dlg.open || e.target.closest('input')) return;
    if (e.key === '[') { a = m.currentTime; paint(); } else if (e.key === ']') { b = m.currentTime; paint(); }
  };
  document.addEventListener('keydown', keys);
  dlg.addEventListener('close', () => { document.removeEventListener('keydown', keys); }, {once: true});
  $('#plActions').onclick = async e => {
    const btn = e.target.closest('[data-cut]'); if (!btn) return;
    const act = btn.dataset.cut;
    if (act === 'a') { a = m.currentTime; return paint(); }
    if (act === 'b') { b = m.currentTime; return paint(); }
    if (act === 'preview') { m.currentTime = a; previewEnd = b; m.play().catch(() => {}); return; }
    if (act === 'back') { dlg.close(); return; }
    if (act === 'cancel' && job) { api(`/api/edit/jobs/${job.id}/cancel`, {method: 'POST'}).catch(() => {}); return; }
    if (act === 'go') {
      m.pause();
      try {
        job = await api(`/api/edit/${o.kind}/${o.id}/cut`, {method: 'POST', body: {start: a, end: b, accurate: $('#cutAcc').checked}});
      } catch (err) { return toast(err.message, 'err'); }
      $('#cutProg').hidden = false; paint();
      watchJob(job, null, 'Đã lưu bản cắt.', {
        progress: j => { $('#cutBar').style.width = (j.progress || 0) + '%'; $('#cutPct').textContent = Math.round(j.progress || 0) + '%'; },
        done: () => { job = null; $('#cutProg').hidden = true; paint(); },
        fail: () => { job = null; $('#cutProg').hidden = true; paint(); },
      });
    }
  };
  paint();
  if (!dlg.open) dlg.showModal();
}
window.CV.openCutter = openCutter;
$('#plClose').addEventListener('click', () => $('#player').close());
$('#player').addEventListener('close', () => { $('#plMedia').innerHTML = ''; });
$('#player').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ------------------------------------------------------------ storage / settings */
async function loadStorage() {
  try { S.config = await api('/api/config'); } catch (e) { toast(e.message, 'err'); return; }
  await Promise.all([loadStatus(), loadDrives()]);
  renderConfig(); renderTools();
}
async function loadDrives() {
  try { S.drives = await api('/api/drives'); } catch (e) { S.drives = []; }
}
const DRIVE_TYPE = {fixed: 'Ổ trong máy', removable: 'Ổ rời / USB', network: 'Ổ mạng', ram: 'Ổ RAM'};
function drivesBox() {
  const c = S.config, st = S.status;
  const used = new Set(c.disks.map(d => (d.root || '').slice(0, 3).toUpperCase()));
  const allOff = st && st.disks.length && st.disks.every(d => !d.online);
  const rows = (S.drives || []).map(d => {
    const inUse = used.has(d.root.slice(0, 3).toUpperCase()) || d.used;
    const pct = d.total ? Math.round((1 - d.free / d.total) * 100) : 0;
    return `<div class="drive">
      <div class="drive-name"><b>${esc(d.letter.length === 1 ? d.letter + ':' : d.root)}</b> ${esc(d.name || '')}
        <span class="hint">${DRIVE_TYPE[d.type] || ''}${d.system ? ' · ổ Windows' : ''}</span></div>
      <div class="bar"><i style="width:${pct}%;background:${pct > 90 ? 'var(--red)' : pct > 75 ? 'var(--yellow)' : 'var(--green)'}"></i></div>
      <span class="hint mono">Trống ${fmtBytes(d.free)} / ${fmtBytes(d.total)}</span>
      ${inUse ? '<span class="badge on-use">Đang dùng</span>' : `<button class="btn sm green" type="button" data-usedrive="${esc(d.letter)}">Dùng ổ này</button>`}
    </div>`;
  }).join('');
  return `<div class="box pcard drives">
    <div class="row-between"><h3>Ổ trên máy này</h3><button class="btn sm plain" type="button" id="rescanDrives">Tìm lại ổ</button></div>
    ${allOff ? '<p class="no">Không thấy ổ nào trong cài đặt bên dưới trên máy này (có thể bạn vừa chuyển máy hoặc ổ rời chưa cắm). Bấm "Dùng ổ này" ở một ổ bên dưới.</p>' : ''}
    ${rows || '<p class="hint">Không dò được ổ nào. Gõ thư mục lưu ở ô bên dưới.</p>'}
    <p class="hint">Vừa cắm ổ rời / USB thì bấm "Tìm lại ổ". Ổ Windows (C:) chỉ nên dùng khi máy không có ổ nào khác.</p>
  </div>`;
}
async function saveConfig(msg, collect = true) {   // collect=false: S.config đã cập nhật sẵn (vừa thêm ổ)
  try { S.config = await api('/api/config', {method: 'PUT', body: collect ? collectConfig() : S.config}); toast(msg || 'Đã lưu cài đặt.'); loadStorage(); }
  catch (err) { toast(err.message, 'err'); }
}
function renderConfig() {
  const c = S.config, st = S.status;
  const diskOpts = sel => c.disks.map(d => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  const disks = c.disks.map((d, n) => {
    const s = st?.disks.find(x => x.id === d.id);
    return `<div class="box pcard" data-disk="${n}">
      <div class="row-between"><h3>${esc(d.label)}</h3>${c.disks.length > 1 ? `<button class="btn sm plain" type="button" data-rm="${n}">Bỏ ổ này</button>` : ''}</div>
      ${s ? diskBar(s) : ''}
      ${!d.root ? '<p class="no">Chưa có thư mục lưu: bấm "Chọn thư mục…" hoặc gõ vào ô bên dưới.</p>'
        : s?.online ? `<p class="hint mono">Còn trống ${fmtBytes(s.usage.free)}${s.full ? ' · ĐÃ QUÁ NGƯỠNG' : ''}</p>`
        : s ? '<p class="no">Không thấy ổ này trên máy (ổ rời chưa cắm hoặc ký tự ổ đã đổi). Chọn ổ khác ở "Ổ trên máy này" rồi bỏ ổ này.</p>'
        : '<p class="hint">Chưa lưu: bấm LƯU CÀI ĐẶT.</p>'}
      <div class="field-row">
        <label class="field">Mã<input type="text" id="disk-id-${n}" name="id" value="${esc(d.id)}" maxlength="8"></label>
        <label class="field">Tên hiển thị<input type="text" id="disk-label-${n}" name="label" value="${esc(d.label)}" maxlength="40"></label>
      </div>
      <label class="field">Thư mục lưu<input type="text" id="disk-root-${n}" name="root" value="${esc(d.root)}" placeholder="E:\\CircleVault"><small>App tự tạo thư mục nếu chưa có.</small></label>
      ${window.cvDesktop?.pickFolder ? `<div><button class="btn sm cyan" type="button" data-pick="${n}">Chọn thư mục…</button></div>` : ''}
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
    ${drivesBox()}
    <div class="cols2">${disks}</div>
    <div><button class="btn plain" type="button" id="addDisk">+ Thêm thư mục khác</button></div>
    <div class="tablebox box"><table class="rules"><thead><tr><th>Loại</th><th>Ổ ưu tiên</th><th>Ghi chú</th></tr></thead><tbody>${rules}</tbody></table></div>
    <div class="box pcard">
      <h3>Tùy chọn tải</h3>
      <div class="cols3">
        <label class="field">Chất lượng mặc định<select id="defQuality">${qOpts}</select></label>
        <label class="field">Định dạng video<select id="vidFmt"><option value="mp4" ${c.video_format !== 'original' ? 'selected' : ''}>MP4 (mở được ở mọi nơi)</option><option value="original" ${c.video_format === 'original' ? 'selected' : ''}>Giữ nguyên (WebM, MKV…)</option></select><small>MP4: chỉ đổi vỏ file, không giảm chất lượng.</small></label>
        <label class="field">Ngưỡng đầy ổ (%)<input type="number" id="maxFull" min="50" max="99" value="${c.max_full_percent}"></label>
        <label class="field">Số luồng tải mỗi ổ<input type="number" id="maxConc" min="1" max="8" value="${c.max_concurrent_per_disk}"><small>HDD nên để 2–3.</small></label>
        <label class="field">Ngôn ngữ phụ đề<input type="text" id="subLangs" value="${esc(c.subtitle_langs.join(', '))}"><small>Mã ngôn ngữ, cách nhau dấu phẩy.</small></label>
        <label class="field">Cookie từ trình duyệt<select id="cookies">${bOpts}</select><small>Cho video giới hạn tuổi / thành viên. Đóng trình duyệt trước khi tải.</small></label>
        <label class="field">Mạng<select id="host"><option value="127.0.0.1" ${c.host === '127.0.0.1' ? 'selected' : ''}>Chỉ máy này</option><option value="0.0.0.0" ${c.host === '0.0.0.0' ? 'selected' : ''}>Cho điện thoại cùng Wi-Fi</option></select><small>Cần mở lại app để áp dụng.</small></label>
      </div>
      <label class="check"><input type="checkbox" id="embedSubs" ${c.embed_subs ? 'checked' : ''}> Tải và nhúng phụ đề vào video</label>
    </div>
    <div class="btn-row"><button class="btn green" type="submit">LƯU CÀI ĐẶT</button></div>`;
  const freeId = pref => {
    const used = new Set(S.config.disks.map(d => d.id));
    return [pref, ...'DEFGHIJKLMNOPQRSTUVWXYZ'].find(x => x && !used.has(x)) || String(Date.now() % 1000);
  };
  const letterOf = r => (/^[A-Za-z]:/.test(r) ? r[0].toUpperCase() : '');
  $('#addDisk').addEventListener('click', async () => {
    collectConfig();
    let root = '';
    if (window.cvDesktop?.pickFolder) { root = await window.cvDesktop.pickFolder('Chọn thư mục để lưu video / truyện'); if (!root) return; }
    const id = freeId(letterOf(root));
    S.config.disks.push({id, label: letterOf(root) ? `Ổ ${letterOf(root)}:` : `Ổ ${id}`, root});
    if (root) return saveConfig(`Đã thêm ${root}.`, false);
    renderConfig();
    $(`#disk-root-${S.config.disks.length - 1}`)?.focus();
  });
  $$('[data-usedrive]').forEach(b => b.addEventListener('click', () => {
    const d = S.drives.find(x => x.letter === b.dataset.usedrive); if (!d) return;
    collectConfig();
    const one = d.letter.length === 1;
    S.config.disks.push({id: freeId(one ? d.letter : ''), label: (one ? `Ổ ${d.letter}:` : 'Ổ') + (d.name ? ' ' + d.name : ''), root: d.suggest});
    saveConfig(`Đã thêm ổ ${one ? d.letter + ':' : d.root}. Video sẽ lưu vào ${d.suggest}`, false);
  }));
  $('#rescanDrives').addEventListener('click', async () => {
    collectConfig(); await Promise.all([loadDrives(), loadStatus()]); renderConfig(); toast(`Tìm thấy ${S.drives.length} ổ.`);
  });
  $$('[data-pick]').forEach(b => b.addEventListener('click', async () => {
    const f = await window.cvDesktop.pickFolder('Chọn thư mục lưu'); if (!f) return;
    $(`#disk-root-${b.dataset.pick}`).value = f;
  }));
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
    c.video_format = $('#vidFmt').value;
    c.max_full_percent = +$('#maxFull').value;
    c.max_concurrent_per_disk = +$('#maxConc').value;
    c.subtitle_langs = $('#subLangs').value.split(',').map(s => s.trim()).filter(Boolean);
    c.cookies_from_browser = $('#cookies').value;
    c.host = $('#host').value;
    c.embed_subs = $('#embedSubs').checked;
  }
  return c;
}
$('#cfgForm').addEventListener('submit', e => { e.preventDefault(); saveConfig(); });
function renderTools() {
  const t = S.status?.tools || {};
  const app = S.status?.app || {};
  $('#tools').innerHTML = `
    <div class="box pcard"><h3>CircleVault <span class="mono">${esc(app.version || 'dev')}</span></h3>
      <p class="hint">${window.cvDesktop ? 'App tự kiểm tra bản mới mỗi 4 giờ.' : 'Đang chạy từ mã nguồn (không tự cập nhật).'} Dữ liệu: <code>${esc(app.data || '')}</code></p>
      <div class="btn-row">${window.cvDesktop ? '<button class="btn cyan" type="button" id="chkUpd">Kiểm tra cập nhật</button>' : ''}
        <button class="btn plain" type="button" id="seeNotes">📜 Có gì mới</button></div></div>
    <div class="box pcard"><h3>yt-dlp <span class="mono">${esc(t.yt_dlp || '?')}</span></h3>
      <p class="hint">YouTube thay đổi thường xuyên. Khi tải bị lỗi, hãy cập nhật trước tiên.</p>
      <div><button class="btn yellow" type="button" id="updYt">Cập nhật yt-dlp</button></div></div>
    <div class="box pcard"><h3>ffmpeg: ${t.ffmpeg ? '<span class="ok">có</span>' : '<span class="no">chưa cài</span>'}</h3>
      <p class="hint">${t.ffmpeg ? 'Dùng để ghép hình + tiếng, tạo MP3, nhúng phụ đề.' : 'Không có ffmpeg thì chỉ tải được tối đa 720p.' + (window.cvDesktop ? ' Bản app đã kèm sẵn ffmpeg; hãy cài lại app.' : ' Cài bằng lệnh: <code>winget install Gyan.FFmpeg</code> rồi mở lại.')}</p></div>
    <div class="box pcard"><h3>Deno: ${t.deno ? '<span class="ok">có</span>' : '<span class="no">chưa cài</span>'}</h3>
      <p class="hint">${t.deno ? 'yt-dlp dùng Deno để giải mã link YouTube.' : 'YouTube cần Deno để lấy đủ định dạng.' + (window.cvDesktop ? ' Bản app đã kèm sẵn Deno; hãy cài lại app.' : ' Cài bằng: <code>winget install DenoLand.Deno</code> rồi mở lại.')}</p></div>`;
  renderPhone();
  renderDrive();
  $('#chkUpd')?.addEventListener('click', () => { window.cvDesktop.updateAct(); toast('Đang kiểm tra bản mới…'); });
  $('#seeNotes').addEventListener('click', () => showWhatsNew(true));
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

/* Mang theo điện thoại: chỉ thiết bị đã GHÉP (quét mã QR dùng một lần) mới mở được CircleVault qua Wi-Fi */
const SCOPE_TXT = {phone: 'Chỉ tải nhạc, phim về', full: 'Toàn quyền như máy tính'};
let pairTimer = 0;
const ago = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 2 ? 'vừa xong' : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.round(m / 60)} giờ trước` : `${Math.round(m / 1440)} ngày trước`; };
async function renderPhone() {
  let box = $('#phoneBox');
  if (!box) { box = document.createElement('div'); box.id = 'phoneBox'; box.className = 'box pcard phone-box'; $('#tools').prepend(box); }
  let i;
  try { i = await api('/api/phone/info'); } catch (e) { box.remove(); return; }
  const restart = window.cvDesktop?.restartServer;
  if (!(i.lan && i.url)) {
    box.innerHTML = `<h3>Mang theo điện thoại</h3>
      <p class="hint">Tải nhạc, phim từ máy tính sang điện thoại để tối tắt máy tính rồi vẫn nghe, xem trên điện thoại.</p>
      ${i.pending ? '<p>Đã bật chế độ cho điện thoại. Cần khởi động lại để áp dụng.</p>'
        : '<p>Cần bật chế độ <b>Cho điện thoại cùng Wi-Fi</b>. Chỉ thiết bị bạn quét mã QR ghép mới mở được, người khác dùng chung Wi-Fi không vào được.</p>'}
      <div><button class="btn green" type="button" id="phoneOn">${i.pending ? 'Khởi động lại để áp dụng' : (restart ? 'Bật &amp; khởi động lại' : 'Bật chế độ điện thoại')}</button></div>`;
    $('#phoneOn').addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try {
        if (!i.pending) S.config = await api('/api/config', {method: 'PUT', body: {...S.config, host: '0.0.0.0'}});
        if (restart) { b.textContent = 'Đang khởi động lại…'; await window.cvDesktop.restartServer(); return; }
        toast('Đã bật. Tắt rồi chạy lại backend (python -m app) để áp dụng.');
        renderConfig(); renderTools();
      } catch (err) { toast(err.message, 'err'); b.disabled = false; }
    });
    return;
  }
  const devs = i.devices || [];
  box.innerHTML = `<h3>Mang theo điện thoại</h3>
    <p class="hint">Chỉ thiết bị bạn ghép bằng mã QR mới mở được CircleVault qua Wi-Fi. Mỗi thiết bị có quyền riêng và thu hồi được bất cứ lúc nào.</p>
    <div class="phone-devs">${devs.length ? devs.map(d => `<div class="phone-dev" data-dev="${esc(d.id)}">
        <div class="phone-dev-name"><b>${esc(d.name)}</b><span class="hint">${d.app ? 'App Android · ' : ''}Ghép ${new Date(d.created_at * 1000).toLocaleDateString('vi-VN')} · dùng lần cuối ${ago(d.last_seen)}</span></div>
        <select data-scope aria-label="Quyền của ${esc(d.name)}">${Object.entries(SCOPE_TXT).map(([k, v]) => `<option value="${k}" ${d.scope === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button class="btn sm plain" type="button" data-rename>Đổi tên</button>
        <button class="btn sm red" type="button" data-revoke>Thu hồi</button>
      </div>`).join('') : '<p class="hint">Chưa có thiết bị nào.</p>'}</div>
    <div class="phone-pair" id="phonePair" hidden></div>
    <div class="btn-row"><button class="btn green" type="button" id="pairBtn">+ Thêm thiết bị</button></div>
    <p class="hint"><b>App Android:</b> mở trên điện thoại link <code class="phone-url">github.com/GiaMinhDuong1412/circlevault-releases/releases/latest/download/CircleVault-Android.apk</code> để tải file APK và cài (lần đầu cho phép "cài ứng dụng không rõ nguồn gốc").</p>
    <p class="hint">Thiết bị đã ghép mở lại bằng địa chỉ <code class="phone-url">${esc(i.url)}</code> (nên lưu ra màn hình chính). Nếu địa chỉ IP của máy tính đổi, hãy ghép lại.</p>`;
  $('#pairBtn').addEventListener('click', () => showPair(devs.length));
  box.querySelectorAll('[data-dev]').forEach(row => {
    const id = row.dataset.dev, name = row.querySelector('b').textContent;
    row.querySelector('[data-scope]').addEventListener('change', async e => {
      try { await api(`/api/phone/devices/${id}`, {method: 'PUT', body: {scope: e.target.value}}); toast(`${name}: ${SCOPE_TXT[e.target.value]}.`); }
      catch (err) { toast(err.message, 'err'); renderPhone(); }
    });
    row.querySelector('[data-rename]').addEventListener('click', () => {
      const nm = row.querySelector('.phone-dev-name');
      nm.innerHTML = `<form class="inline-edit"><input type="text" maxlength="40" value="${esc(name)}" aria-label="Tên mới"><button class="btn sm green" type="submit">Lưu</button></form>`;
      const f = nm.querySelector('form'); f.querySelector('input').select();
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const n = f.querySelector('input').value.trim(); if (!n) return;
        try { await api(`/api/phone/devices/${id}`, {method: 'PUT', body: {name: n}}); } catch (err) { toast(err.message, 'err'); }
        renderPhone();
      });
    });
    row.querySelector('[data-revoke]').addEventListener('click', async () => {
      if (!confirm(`Thu hồi "${name}"? Thiết bị này sẽ không mở được CircleVault nữa (muốn dùng lại phải quét mã ghép mới).`)) return;
      try { await api(`/api/phone/devices/${id}`, {method: 'DELETE'}); toast(`Đã thu hồi ${name}.`); renderPhone(); } catch (err) { toast(err.message, 'err'); }
    });
  });
}
async function showPair(before) {
  const el = $('#phonePair'); if (!el) return;
  let c;
  try { c = await api('/api/phone/pair-code', {method: 'POST'}); } catch (e) { toast(e.message, 'err'); return; }
  const end = Date.now() + c.expires_in * 1000;
  el.hidden = false; $('#pairBtn').hidden = true;
  el.innerHTML = `<img class="phone-qr" src="/api/phone/qr.svg?code=${encodeURIComponent(c.code)}" alt="Mã QR ghép thiết bị">
    <div class="phone-txt">
      <p><b>Dùng điện thoại cần thêm</b> (cùng Wi-Fi) quét mã này: bằng <b>app CircleVault</b> (nút "Quét mã QR") hoặc bằng Camera nếu chưa cài app.</p>
      <p class="hint">Hoặc mở <code class="phone-url">${esc(c.url)}</code></p>
      <p class="hint">Mã ghép <b class="mono">${esc(c.code)}</b> chỉ dùng được một lần, còn <b id="pairLeft"></b>. Thiết bị mới chỉ được tải nhạc, phim về; muốn cho toàn quyền thì đổi ở danh sách trên.</p>
      <p class="hint">Lần đầu, Windows có thể hỏi cho phép CircleVault dùng mạng: chọn <b>Cho phép</b> (mạng riêng).</p>
      <div><button class="btn sm plain" type="button" id="pairCancel">Đóng mã</button></div>
    </div>`;
  const stop = () => { clearInterval(pairTimer); pairTimer = 0; };
  $('#pairCancel').addEventListener('click', () => { stop(); renderPhone(); });
  stop();
  let n = 0;
  pairTimer = setInterval(async () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    const lb = $('#pairLeft');
    if (!lb || S.view !== 'storage') return stop();
    lb.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!left) { stop(); toast('Mã ghép đã hết hạn.'); return renderPhone(); }
    if (++n % 3) return;                        // 3 giây xem có thiết bị mới chưa
    try {
      const list = await api('/api/phone/devices');
      if (list.length > before) { stop(); toast(`Đã thêm thiết bị "${list[list.length - 1].name}".`); renderPhone(); }
    } catch (e) { /* bỏ qua */ }
  }, 1000);
  $('#pairLeft').textContent = `${Math.floor(c.expires_in / 60)}:00`;
}

/* Google Drive: nhiều tài khoản, chọn tài khoản + thư mục lưu nhạc, xem tiến độ tải lên */
let driveTimer = 0;
async function renderDrive() {
  let box = $('#driveBox');
  if (!box) {
    box = document.createElement('div'); box.id = 'driveBox'; box.className = 'box pcard phone-box drive-box';
    const after = $('#phoneBox'); after ? after.after(box) : $('#tools').prepend(box);
  }
  let g;
  try { g = await api('/api/gdrive'); } catch (e) { box.remove(); return; }
  const jobs = g.jobs.filter(j => j.status === 'running' || j.status === 'queued' || (Date.now() / 1000 - (j.finished_at || 0) < 600));
  if (!g.configured) {
    box.innerHTML = `<h3>Google Drive</h3>
      <p class="hint">Lưu nhạc lên Google Drive của bạn để nghe, tải về trên điện thoại kể cả khi máy tính tắt. Bước đầu: nhập OAuth client loại <b>Desktop app</b> đã tạo trong Google Cloud.</p>
      <label class="btn yellow file-btn" for="gdJson">Chọn file JSON đã tải (client_secret_….json)</label>
      <input type="file" id="gdJson" accept=".json,application/json" hidden>
      <details><summary class="hint">Hoặc dán Client ID và Client secret</summary>
        <form id="gdForm" class="cols2" style="margin-top:8px">
          <label class="field">Client ID<input type="text" id="gdId" autocomplete="off" placeholder="…apps.googleusercontent.com"></label>
          <label class="field">Client secret<input type="password" id="gdSecret" autocomplete="off" placeholder="GOCSPX-…"></label>
          <div><button class="btn green" type="submit">Lưu</button></div>
        </form></details>`;
    const save = async body => { try { await api('/api/gdrive/client', {method: 'PUT', body}); toast('Đã lưu. Giờ thêm tài khoản Google.'); renderDrive(); } catch (err) { toast(err.message, 'err'); } };
    $('#gdJson').addEventListener('change', async e => { const f = e.target.files[0]; if (f) save({json_text: await f.text()}); });
    $('#gdForm').addEventListener('submit', e => { e.preventDefault(); save({client_id: $('#gdId').value, client_secret: $('#gdSecret').value}); });
    return;
  }
  box.innerHTML = `<h3>Google Drive</h3>
    <p class="hint">Nhạc lưu vào tài khoản đang chọn (●). Mỗi playlist là một thư mục con. App chỉ thấy file do CircleVault tạo, không đọc file khác trong Drive của bạn.</p>
    <div class="phone-devs">${g.accounts.length ? g.accounts.map(a => `<div class="phone-dev" data-acc="${esc(a.email)}">
        <label class="check gd-pick"><input type="radio" name="gdActive" ${a.email === g.active ? 'checked' : ''}> <span class="phone-dev-name"><b>${esc(a.email)}</b>
          <span class="hint">Thư mục: <b>${esc(a.folder_name || '—')}</b> · đã lưu ${a.uploaded} bài</span></span></label>
        <button class="btn sm plain" type="button" data-folder>Đổi thư mục</button>
        <button class="btn sm red" type="button" data-unlink>Ngắt</button>
        <div class="gd-folder" hidden></div>
      </div>`).join('') : '<p class="hint">Chưa có tài khoản nào.</p>'}</div>
    <div class="btn-row"><button class="btn green" type="button" id="gdAdd">+ Thêm tài khoản Google</button>
      <button class="btn sm plain" type="button" id="gdReset">Đổi OAuth client</button></div>
    <div id="gdJobs">${jobs.map(j => `<div class="gd-job"><b>${esc(j.label)}</b> → ${esc(j.email)} / ${esc(j.folder || '')}
      <span class="hint">${j.status === 'done' ? `xong: ${j.uploaded} bài mới, ${j.skipped} bài đã có${j.errors.length ? `, ${j.errors.length} lỗi` : ''}`
        : j.status === 'error' ? `lỗi: ${esc(j.error)}` : `${j.done}/${j.total} bài${j.current ? ' · ' + esc(j.current) : ''}`}</span>
      ${j.status === 'running' ? `<div class="bar"><i style="width:${j.bytes_total ? Math.min(100, j.bytes_done / j.bytes_total * 100) : j.done / j.total * 100}%"></i></div>` : ''}</div>`).join('')}</div>`;
  $$('[data-acc]', box).forEach(row => {
    const email = row.dataset.acc;
    row.querySelector('input[type=radio]').addEventListener('change', async () => {
      try { await api('/api/gdrive/active', {method: 'POST', body: {email}}); toast(`Từ giờ lưu vào ${email}.`); } catch (err) { toast(err.message, 'err'); }
      renderDrive();
    });
    row.querySelector('[data-unlink]').addEventListener('click', async e => {
      const b = e.currentTarget;
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Bấm lần nữa để ngắt'; return; }
      try { await api(`/api/gdrive/accounts/${encodeURIComponent(email)}`, {method: 'DELETE'}); toast(`Đã ngắt ${email}. Nhạc trên Drive vẫn còn.`); } catch (err) { toast(err.message, 'err'); }
      renderDrive();
    });
    row.querySelector('[data-folder]').addEventListener('click', async () => {
      const el = row.querySelector('.gd-folder'); el.hidden = false; el.innerHTML = '<p class="hint">Đang đọc thư mục…</p>';
      let list = [];
      try { list = await api(`/api/gdrive/folders?email=${encodeURIComponent(email)}`); } catch (err) { el.innerHTML = `<p class="no">${esc(err.message)}</p>`; return; }
      const top = list.filter(f => !list.some(p => (f.parents || []).includes(p.id)));
      el.innerHTML = `<form class="inline-edit"><select aria-label="Thư mục có sẵn"><option value="">— Thư mục CircleVault đã tạo —</option>${top.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select>
        <input type="text" maxlength="100" placeholder="hoặc tên thư mục mới" aria-label="Tên thư mục mới"><button class="btn sm green" type="submit">Dùng thư mục này</button></form>`;
      el.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault();
        const id = el.querySelector('select').value, name = el.querySelector('input').value.trim();
        if (!id && !name) return toast('Chọn một thư mục hoặc gõ tên mới.', 'err');
        try { await api('/api/gdrive/folder', {method: 'POST', body: {email, id: name ? '' : id, name}}); toast('Đã đổi thư mục lưu.'); } catch (err) { toast(err.message, 'err'); }
        renderDrive();
      });
    });
  });
  $('#gdAdd').addEventListener('click', async () => {
    let r; try { r = await api('/api/gdrive/auth/start', {method: 'POST'}); } catch (err) { return toast(err.message, 'err'); }
    window.open(r.url, '_blank');
    toast('Đăng nhập Google trong trình duyệt vừa mở. Xong thì quay lại đây.');
    const before = g.accounts.length; let n = 0;
    clearInterval(driveTimer);
    driveTimer = setInterval(async () => {
      if (++n > 90 || S.view !== 'storage') return clearInterval(driveTimer);
      try { const x = await api('/api/gdrive'); if (x.accounts.length > before) { clearInterval(driveTimer); toast('Đã thêm tài khoản Google Drive.'); renderDrive(); } } catch (e) { /* bỏ qua */ }
    }, 2000);
  });
  $('#gdReset').addEventListener('click', () => { box.innerHTML = ''; renderDriveSetup(box); });
  if (jobs.some(j => j.status === 'running' || j.status === 'queued')) setTimeout(() => S.view === 'storage' && renderDrive(), 2000);
}
function renderDriveSetup(box) {
  box.innerHTML = `<h3>Đổi OAuth client</h3><p class="hint">Chọn file JSON mới (client loại Desktop app). Tài khoản đã thêm vẫn giữ.</p>
    <label class="btn yellow file-btn" for="gdJson2">Chọn file JSON</label><input type="file" id="gdJson2" accept=".json" hidden>
    <div><button class="btn sm plain" type="button" id="gdBack">Thôi</button></div>`;
  $('#gdJson2').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await api('/api/gdrive/client', {method: 'PUT', body: {json_text: await f.text()}}); toast('Đã đổi OAuth client.'); } catch (err) { toast(err.message, 'err'); }
    renderDrive();
  });
  $('#gdBack').addEventListener('click', renderDrive);
}
window.CV.drive = {upload: async (body, label) => {
  try {
    const j = await api('/api/gdrive/upload', {method: 'POST', body});
    toast(`Đang lưu ${j.total} bài${label ? ` của "${label}"` : ''} lên Google Drive (${j.email} / ${j.folder}). Xem tiến độ ở tab Cài đặt.`);
  } catch (err) { toast(err.message, 'err'); }
}};

/* ------------------------------------------------------------ routing */
function refreshView() {
  if (S.view === 'home') loadRecent();
  if (S.view === 'queue') loadTasks();
  if (S.view === 'library') loadLibrary();
  if (S.view === 'storage') loadStorage();
  if (window.CV.views[S.view]) window.CV.views[S.view]();
}
function route() {
  const v = (location.hash || '#home').slice(1);
  S.view = ['home', 'queue', 'library', 'music', 'youtube', 'online', 'party', 'voice', 'translate', 'learn', 'storage'].includes(v) ? v : 'home';
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === S.view));
  document.body.classList.toggle('view-music', S.view === 'music');
  document.body.classList.toggle('view-wide', S.view === 'translate' || S.view === 'learn' || S.view === 'youtube' || S.view === 'voice');
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
/* ------------------------------------------------------------ theme màu (lưu ở localStorage 'cv-theme'; bảng màu trong app.css) */
const THEMES = [
  ['light', 'Sáng', ['#fbf9f4', '#19bde8', '#fcc419', '#3be08c', '#f7a8ec']],
  ['dark', 'Tối', ['#131418', '#19bde8', '#fcc419', '#3be08c', '#f7a8ec']],
  ['hong', 'Kẹo hồng', ['#fff5fa', '#ff9acb', '#ffe27a', '#8ff0c4', '#cdb0ff']],
  ['bien', 'Biển', ['#f1f7fc', '#5cb8ff', '#8ae9fb', '#62e3bb', '#a9bfff']],
  ['hoang-hon', 'Hoàng hôn', ['#fff4ea', '#ff8a5c', '#ffd25e', '#b9e68f', '#f79bbd']],
  ['ca-phe', 'Cà phê sữa', ['#f5ede3', '#d2ab82', '#f2cb7d', '#b0cf86', '#e8b7a3']],
  ['rung', 'Rừng đêm', ['#0f1a14', '#7fd893', '#e8d26e', '#55d98f', '#c6e67f']],
  ['neon', 'Neon đêm', ['#0d0b1a', '#22e4ff', '#f7f56b', '#3dff8e', '#ff5ad9']],
];
function setTheme(t) {
  const r = document.documentElement;
  if (t) r.dataset.theme = t; else delete r.dataset.theme;
  try { if (t) localStorage.setItem('cv-theme', t); else localStorage.removeItem('cv-theme'); } catch (e) { /* bỏ qua */ }
}
/* kiểu giao diện (hình khối) – chỉ áp dụng khi mở lại app: chọn → lưu 'cv-style-next' → đầu trang (index.html) đổi khi phiên mới */
const STYLES = [
  ['brutal', 'Neo-brutalist', 'Viền đậm, bóng cứng (mặc định)'],
  ['tron', 'Brutal bo tròn', 'Viền đậm, góc bo tròn'],
  ['mem', 'Mềm mại', 'Viền mảnh, bóng mờ, bo tròn'],
  ['phang', 'Tối giản', 'Phẳng, không bóng'],
  ['kinh', 'Kính mờ', 'Trong suốt, nền chuyển màu'],
];
/* font chữ: đổi ngay, không cần khởi động lại (CSS --f-body theo data-font) */
const FONTS = [
  ['', 'Mặc định', 'Be Vietnam Pro', '"Be Vietnam Pro","Segoe UI",sans-serif'],
  ['tahoma', 'Tahoma', 'Gọn, dễ đọc', 'Tahoma,Verdana,sans-serif'],
  ['consolas', 'Consolas', 'Chữ đều (lập trình)', 'Consolas,"Courier New",monospace'],
  ['times', 'Times New Roman', 'Có chân, kiểu sách', '"Times New Roman",Times,serif'],
];
function setFont(f) {
  const r = document.documentElement;
  if (f) r.dataset.font = f; else delete r.dataset.font;
  try { if (f) localStorage.setItem('cv-font', f); else localStorage.removeItem('cv-font'); } catch (e) { /* bỏ qua */ }
  window.dispatchEvent(new CustomEvent('cv-font', {detail: f}));
}
const styleNow = () => document.documentElement.dataset.style || 'brutal';
const styleNext = () => { try { return localStorage.getItem('cv-style-next'); } catch (e) { return null; } };
function pickStyle(id) {
  try {
    if (id === styleNow()) localStorage.removeItem('cv-style-next'); else localStorage.setItem('cv-style-next', id);
  } catch (e) { return toast('Không lưu được lựa chọn.', 'err'); }
  renderThemePop();
  if (id === styleNow()) return;
  const name = (STYLES.find(x => x[0] === id) || [, id])[1];
  let dlg = $('#styleDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'styleDlg'; dlg.className = 'box'; document.body.appendChild(dlg); }
  const desk = window.cvDesktop;
  dlg.innerHTML = `<div class="dlg-head"><h3>Đổi kiểu giao diện</h3></div>
    <p>Kiểu <b>${esc(name)}</b> sẽ được dùng sau khi <b>khởi động lại CircleVault</b>. ${desk ? '' : 'Đóng tab này rồi mở lại CircleVault.'}</p>
    <p class="hint">Đang tải dở trong Hàng Đợi sẽ tự tải tiếp sau khi mở lại.</p>
    <div class="btn-row">${desk && desk.relaunch ? '<button class="btn green" type="button" data-sr="now">Khởi động lại ngay</button>' : ''}
      <button class="btn plain" type="button" data-sr="later">Để lần sau mở app</button>
      <button class="btn plain" type="button" data-sr="undo">Thôi, giữ kiểu cũ</button></div>`;
  dlg.onclick = e => {
    const b = e.target.closest('[data-sr]'); if (!b) return;
    if (b.dataset.sr === 'now') { b.disabled = true; b.textContent = 'Đang khởi động lại…'; desk.relaunch(); return; }
    if (b.dataset.sr === 'undo') { try { localStorage.removeItem('cv-style-next'); } catch (err) { /* bỏ qua */ } renderThemePop(); }
    dlg.close();
  };
  dlg.showModal();
}
function renderThemePop() {
  const cur = document.documentElement.dataset.theme || '';
  const sn = styleNow(), nx = styleNext();
  $('#themePop').innerHTML = `<h4>Kiểu giao diện</h4>
    <div class="style-opts">${STYLES.map(([id, name, sub]) => `<button type="button" class="style-opt ${(nx || sn) === id ? 'on' : ''}" data-style-id="${id}" title="${esc(sub)}">
      <span class="pv"></span><span>${name}</span>${nx === id && nx !== sn ? '<span class="pend">Áp dụng khi mở lại app</span>' : sn === id && !nx ? '<span class="hint">đang dùng</span>' : ''}</button>`).join('')}</div>
    <h4 style="margin-top:12px">Font chữ</h4>
    <div class="font-opts">${FONTS.map(([id, name, sub, ff]) => `<button type="button" class="font-opt ${(document.documentElement.dataset.font || '') === id ? 'on' : ''}" data-font-id="${id}">
      <b style="font-family:${esc(ff)}">${name}</b><small>${sub}</small></button>`).join('')}</div>
    <h4 style="margin-top:12px">Theme màu</h4>
    ${THEMES.map(([id, name, sw]) => `<button type="button" class="theme-opt ${cur === id ? 'on' : ''}" data-theme-id="${id}" role="menuitemradio" aria-checked="${cur === id}">
      <span>${name}</span><span class="sw">${sw.map(c => `<i style="background:${c}"></i>`).join('')}</span></button>`).join('')}
    <button type="button" class="theme-opt sys ${cur ? '' : 'on'}" data-theme-id="" role="menuitemradio" aria-checked="${!cur}"><span>Theo Windows (sáng / tối)</span><span class="hint">${cur ? '' : 'đang dùng'}</span></button>`;
}
$('#themeBtn').addEventListener('click', e => {
  e.stopPropagation();
  const pop = $('#themePop'), open = pop.hidden;
  if (open) renderThemePop();
  pop.hidden = !open;
  $('#themeBtn').setAttribute('aria-expanded', String(open));
});
$('#themePop').addEventListener('click', e => {
  const st = e.target.closest('[data-style-id]');
  if (st) return pickStyle(st.dataset.styleId);
  const fo = e.target.closest('[data-font-id]');
  if (fo) { setFont(fo.dataset.fontId); renderThemePop(); return; }
  const b = e.target.closest('[data-theme-id]'); if (!b) return;
  setTheme(b.dataset.themeId); renderThemePop();
  window.dispatchEvent(new Event('cv-theme'));   // đồ thị EQ vẽ lại theo màu mới
});
document.addEventListener('click', e => { if (!e.target.closest('.theme-wrap')) { $('#themePop').hidden = true; $('#themeBtn').setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#themePop').hidden) { $('#themePop').hidden = true; $('#themeBtn').focus(); } });

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
    case 'installing': html = `<span>Đang cài bản <b>${esc(u.version)}</b>…</span>`; break;
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

if (!window.cvDesktop && matchMedia('(pointer: coarse)').matches && innerWidth < 820) {   // mở trang chính từ điện thoại
  const bar = document.createElement('a');
  bar.href = '/dt'; bar.className = 'phone-banner';
  bar.innerHTML = '<b>Đang dùng điện thoại?</b> Mở trang <u>Mang theo điện thoại</u> để tải nhạc, phim về máy →';
  document.body.prepend(bar);
}
(async () => {
  try { S.config = await api('/api/config'); } catch (e) {}
  route();
  poll();
})();
/* ------------------------------------------------------------ "Có gì mới" – cuộn giấy sau mỗi bản cập nhật
   Ghi chú ở frontend/thay-doi/thay-doi.json (mục mới nhất ở đầu). Hiện các mục chưa xem (localStorage 'cv-notes-seen'). */
async function showWhatsNew(all) {
  let data;
  try { data = await (await fetch('/static/thay-doi/thay-doi.json', {cache: 'no-store'})).json(); } catch (e) { return; }
  const list = (data.entries || []).filter(x => x && x.id);
  if (!list.length) return;
  let seen = null;
  try { seen = localStorage.getItem('cv-notes-seen'); } catch (e) { /* bỏ qua */ }
  let show;
  if (all) show = list.slice(0, 6);
  else {
    const i = seen ? list.findIndex(x => x.id === seen) : 1;    // lần đầu: chỉ mục mới nhất
    show = list.slice(0, i < 0 ? 3 : i);
  }
  if (!show.length) return;
  let dlg = $('#notesDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'notesDlg'; dlg.className = 'scroll-dlg'; document.body.appendChild(dlg); }
  const ver = S.status?.app?.version;
  dlg.innerHTML = `<div class="scroll">
    <div class="scroll-roll top" aria-hidden="true"><i></i></div>
    <div class="scroll-paper">
      <div class="scroll-in">
        <p class="scroll-kicker">CircleVault${ver && ver !== 'dev' ? ' · bản ' + esc(ver) : ''}</p>
        <h2>Có gì mới</h2>
        ${show.map(x => `<section><h3>${esc(x.title || '')}</h3>${x.date ? `<span class="scroll-date">${esc(x.date)}</span>` : ''}
          <ul>${(x.items || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>`).join('<hr>')}
        <div class="scroll-act"><button class="btn green" type="button" data-notes-ok>Đã hiểu</button></div>
      </div>
    </div>
    <div class="scroll-roll bottom" aria-hidden="true"><i></i></div>
  </div>`;
  const done = () => { try { localStorage.setItem('cv-notes-seen', list[0].id); } catch (e) { /* bỏ qua */ } dlg.close(); };
  dlg.querySelector('[data-notes-ok]').onclick = done;
  dlg.onclick = e => { if (e.target === dlg) done(); };
  dlg.oncancel = () => { try { localStorage.setItem('cv-notes-seen', list[0].id); } catch (e) { /* bỏ qua */ } };
  dlg.showModal();
}
window.CV.whatsNew = () => showWhatsNew(true);

})();
