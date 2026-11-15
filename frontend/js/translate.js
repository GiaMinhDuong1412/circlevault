/* CircleVault – tab "Dịch": dịch truyện tranh (CBZ/ảnh) và chữ trong game sang tiếng Việt. */
(() => {
'use strict';
const {api, esc, toast} = window.CV;
const $ = (s, r = document) => r.querySelector(s);
const desk = window.cvDesktop;
const T = {sub: 'comic', settings: null, book: null, novel: null, view: 'vi', poll: null, edit: null, gp: null,
  gq: {filter: 'all', q: '', offset: 0}, scan: null};
try { T.sub = localStorage.getItem('cv-tr-sub') || 'comic'; } catch (e) { /* bỏ qua */ }

/* Menu bên trái của tab Dịch, chia nhóm cho dễ tìm: [mã, tên, mô tả ngắn, màu, ký hiệu] */
const NAV = [
  ['Truyện', [
    ['comic', 'Truyện tranh', 'CBZ / ảnh – chữ dịch đè lên khung thoại', 'var(--pink)', 'TT'],
    ['novel', 'Truyện chữ', 'TXT / EPUB / dán văn bản', 'var(--cyan)', 'TC']]],
  ['Game', [
    ['vh', 'Việt hóa game', 'Chỉ cần thư mục game, app tự tìm file chữ', 'var(--green)', 'VH'],
    ['vp', 'Gói Việt hóa có sẵn', 'Cài / gỡ gói .zip của nhóm dịch', 'var(--violet)', 'GÓI'],
    ['game', 'Dịch màn hình game', 'Khung dịch nổi khi đang chơi', 'var(--yellow)', 'MH']]],
  ['Khác', [
    ['quick', 'Dịch nhanh', 'Dán đoạn chữ bất kỳ', 'var(--surface-2)', 'DN'],
    ['settings', 'Cài đặt bộ dịch', 'Google / Claude, thuật ngữ', 'var(--surface-2)', '⚙']]],
];
const SUB_INFO = Object.fromEntries(NAV.flatMap(g => g[1].map(x => [x[0], x])));
if (!SUB_INFO[T.sub]) T.sub = 'comic';

async function upload(path, file) {
  const r = await fetch(path, {method: 'POST', body: file, headers: {'content-type': 'application/octet-stream'}});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Lỗi máy chủ (${r.status}).`);
  return data;
}

function engineName(s) {
  if (!s) return '';
  return s.engine === 'claude' ? (s.models[s.claude_model] || s.claude_model).split(' – ')[0] : 'Google Dịch (miễn phí)';
}

async function render() {
  clearInterval(T.poll); T.poll = null;
  try { T.settings = await api('/api/translate/settings'); } catch (e) { T.settings = null; }
  const box = $('#trBox');
  const s = T.settings;
  const cur = SUB_INFO[T.sub];
  box.innerHTML = `
    <div class="tr-layout">
      <nav class="tr-nav box" aria-label="Các mục của tab Dịch">${NAV.map(([g, list]) => `
        <div class="tr-nav-g"><span class="tr-nav-h">${g}</span>${list.map(([k, n, d, c, ic]) => `
          <button type="button" class="tr-nav-i${T.sub === k ? ' on' : ''}" data-sub="${k}" aria-current="${T.sub === k ? 'page' : 'false'}">
            <span class="tr-ic" style="background:${c}" aria-hidden="true">${ic}</span>
            <span class="tr-nav-t"><b>${n}</b><small>${d}</small></span>
          </button>`).join('')}</div>`).join('')}
        <div class="tr-nav-eng hint">Bộ dịch: <b>${esc(engineName(s))}</b>${s && s.engine === 'claude' && !s.has_key ? '<br><span class="tr-warn">chưa có API key</span>' : ''}</div>
      </nav>
      <div class="tr-main main">
        <div class="tr-title"><span class="tr-ic big" style="background:${cur[3]}" aria-hidden="true">${cur[4]}</span>
          <div><h2>${cur[1]}</h2><p class="hint">${cur[2]}</p></div></div>
        <div id="trSub" class="main"></div>
      </div>
    </div>`;
  box.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => {
    if (T.scan && T.scan.timer) clearInterval(T.scan.timer);
    T.sub = b.dataset.sub; T.book = null; T.gp = null; T.novel = null; T.scan = null;
    try { localStorage.setItem('cv-tr-sub', T.sub); } catch (e) { /* bỏ qua */ }
    render();
  }));
  if (!s) { $('#trSub').innerHTML = '<div class="notice box err"><b>Không tải được cài đặt dịch.</b><span>Thử khởi động lại app.</span></div>'; return; }
  ({comic: T.book ? renderReader : renderBooks, novel: T.novel ? renderNovel : renderNovels, game: renderGame,
    vh: T.gp ? renderProject : renderGames, vp: renderPatches, quick: renderQuick, settings: renderSettings}[T.sub] || renderBooks)();
}

/* ================================================================ DỊCH TRUYỆN – danh sách */
async function renderBooks() {
  const el = $('#trSub');
  el.innerHTML = `
    <div class="box pcard tr-drop" id="trDrop">
      <h3>Thêm truyện cần dịch</h3>
      <p>Kéo thả file <b>.cbz / .zip</b> (một chương) hoặc nhiều <b>ảnh trang truyện</b> vào đây. App tự tìm khung thoại, dịch sang tiếng Việt và đặt chữ dịch đè lên đúng chỗ.</p>
      <div class="btn-row">
        <label class="btn green">CHỌN FILE CBZ / ZIP<input type="file" id="trZip" accept=".cbz,.zip" multiple hidden></label>
        <label class="btn yellow">CHỌN ẢNH<input type="file" id="trImgs" accept="image/*" multiple hidden></label>
      </div>
      <form class="paste-row" id="trPathForm">
        <input type="text" id="trPath" placeholder="Hoặc dán đường dẫn truyện trên ổ, ví dụ D:\\CircleVault\\Truyen\\One Piece\\Chuong 001.cbz" aria-label="Đường dẫn truyện trên ổ">
        <button class="btn plain" type="submit">MỞ</button>
      </form>
      <p class="hint" id="trUpMsg">Hợp với truyện tiếng Anh tải từ MangaDex, ảnh chụp manga/manhwa/webtoon. Chữ viết tay, chữ nghiêng nhiều hoặc chữ dọc tiếng Nhật đọc kém hơn.</p>
    </div>
    <div class="sec-title">Truyện đã thêm</div>
    <div id="trBooks" class="main"><div class="loading"><span class="spin"></span>Đang tải…</div></div>`;

  const drop = $('#trDrop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
  $('#trZip').addEventListener('change', e => addFiles([...e.target.files]));
  $('#trImgs').addEventListener('change', e => addFiles([...e.target.files]));
  $('#trPathForm').addEventListener('submit', async e => {
    e.preventDefault();
    const path = $('#trPath').value.trim();
    if (!path) return;
    try { const b = await api('/api/translate/books/from-path', {method: 'POST', body: {path}}); await startBook(b.id); }
    catch (err) { toast(err.message, 'err'); }
  });
  await loadBooks();
  T.poll = setInterval(() => { if (!document.hidden && $('#trBooks')) loadBooks(); else clearInterval(T.poll); }, 2500);
}

async function addFiles(files) {
  if (!files.length) return;
  const msg = $('#trUpMsg');
  const zips = files.filter(f => /\.(cbz|zip)$/i.test(f.name));
  const imgs = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
  try {
    for (const f of zips) {
      msg.textContent = `Đang đọc ${f.name}…`;
      const b = await upload(`/api/translate/books?filename=${encodeURIComponent(f.name)}`, f);
      await startBook(b.id, false);
    }
    if (imgs.length) {
      imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
      msg.textContent = `Đang thêm ${imgs.length} ảnh…`;
      const name = imgs.length === 1 ? imgs[0].name.replace(/\.[^.]+$/, '') : `Ảnh ${new Date().toLocaleString('vi-VN')}`;
      const b = await upload(`/api/translate/books?filename=${encodeURIComponent(imgs[0].name)}&name=${encodeURIComponent(name)}`, imgs[0]);
      for (const [i, f] of imgs.slice(1).entries()) {
        msg.textContent = `Đang thêm ảnh ${i + 2}/${imgs.length}…`;
        await upload(`/api/translate/books/${b.id}/pages?filename=${encodeURIComponent(f.name)}`, f);
      }
      await startBook(b.id, false);
    }
    msg.textContent = 'Đã thêm, đang dịch ở nền. Bấm Mở để xem từng trang.';
    toast('Đã thêm truyện, đang dịch.');
    loadBooks();
  } catch (err) { msg.textContent = err.message; toast(err.message, 'err'); }
}

async function startBook(id, open = true) {
  await api(`/api/translate/books/${id}/run`, {method: 'POST', body: {}});
  if (open) openBook(id); else loadBooks();
}

async function loadBooks() {
  const el = $('#trBooks');
  if (!el) return;
  let d;
  try { d = await api('/api/translate/books'); } catch (e) { el.innerHTML = `<div class="notice box err">${esc(e.message)}</div>`; return; }
  if (!d.books.length) {
    el.innerHTML = '<div class="box empty"><h3>Chưa có truyện nào</h3><p>Thêm một file CBZ hoặc vài ảnh trang truyện ở khung phía trên để bắt đầu.</p></div>';
    return;
  }
  el.innerHTML = d.books.map(b => {
    const pct = b.pages ? Math.round(b.done / b.pages * 100) : 0;
    const st = b.running ? `Đang dịch ${b.done}/${b.pages} trang` : b.status === 'queued' ? 'Đang chờ' :
      b.status === 'error' ? 'Lỗi' : b.done === b.pages ? `Đã dịch đủ ${b.pages} trang` : `Đã dịch ${b.done}/${b.pages} trang`;
    return `<div class="box tr-book" data-id="${b.id}">
      <div class="tr-book-main">
        <b class="tr-name">${esc(b.name)}</b>
        <div class="prog"><div class="bar"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:${b.status === 'error' ? 'var(--red)' : 'var(--green)'}"></i></div><span class="hint">${st}${b.errors ? ` · ${b.errors} trang lỗi` : ''}</span></div>
        ${b.error ? `<span class="tr-err">${esc(b.error)}</span>` : ''}
        ${b.export ? `<span class="hint mono tr-path">${esc(b.export)}</span>` : ''}
      </div>
      <div class="btn-row">
        <button class="btn sm yellow" type="button" data-act="open">Mở</button>
        ${b.running || b.status === 'queued' ? '<button class="btn sm plain" type="button" data-act="stop">Dừng</button>'
          : b.done < b.pages ? '<button class="btn sm green" type="button" data-act="run">Dịch tiếp</button>' : ''}
        <button class="btn sm cyan" type="button" data-act="export" ${b.done ? '' : 'disabled'}>Xuất CBZ</button>
        <button class="btn sm plain" type="button" data-act="del" aria-label="Xóa ${esc(b.name)}">Xóa</button>
      </div></div>`;
  }).join('');
  el.querySelectorAll('.tr-book').forEach(row => row.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = row.dataset.id;
    try {
      if (btn.dataset.act === 'open') return openBook(id);
      if (btn.dataset.act === 'run') await api(`/api/translate/books/${id}/run`, {method: 'POST', body: {}});
      if (btn.dataset.act === 'stop') await api(`/api/translate/books/${id}/stop`, {method: 'POST'});
      if (btn.dataset.act === 'export') await doExport(id, btn);
      if (btn.dataset.act === 'del') {
        if (!confirm('Xóa truyện này khỏi danh sách dịch? (File CBZ đã xuất ra ổ vẫn giữ nguyên.)')) return;
        await api(`/api/translate/books/${id}`, {method: 'DELETE'});
      }
      loadBooks();
    } catch (err) { toast(err.message, 'err'); }
  }));
}

async function doExport(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Đang xuất…'; }
  try {
    const r = await api(`/api/translate/books/${id}/export`, {method: 'POST'});
    toast(`Đã lưu ${r.translated}/${r.pages} trang dịch vào ${r.path}`);
    return r;
  } finally { if (btn) { btn.disabled = false; btn.textContent = 'Xuất CBZ'; } }
}

/* ================================================================ DỊCH TRUYỆN – đọc & sửa */
function openBook(id) { T.book = {id}; render(); }

async function renderReader() {
  const el = $('#trSub');
  el.innerHTML = '<div class="loading"><span class="spin"></span>Đang mở truyện…</div>';
  let b;
  try { b = await api(`/api/translate/books/${T.book.id}`); } catch (e) { T.book = null; toast(e.message, 'err'); return render(); }
  T.book = b;
  el.innerHTML = `
    <div class="box tr-bar">
      <button class="btn sm plain" type="button" id="trBack">← Danh sách</button>
      <b class="tr-name" title="Bấm để đổi tên" id="trTitle">${esc(b.name)}</b>
      <span class="hint" id="trProg"></span>
      <div class="tr-seg" role="group" aria-label="Hiển thị">
        <button type="button" class="chip${T.view === 'vi' ? ' on' : ''}" data-v="vi">Bản dịch</button>
        <button type="button" class="chip${T.view === 'src' ? ' on' : ''}" data-v="src">Bản gốc</button>
      </div>
      <button class="btn sm green" type="button" id="trRun">Dịch tiếp</button>
      <button class="btn sm cyan" type="button" id="trExport">Xuất CBZ</button>
      ${desk ? '<button class="btn sm plain" type="button" id="trOpenDir" hidden>Mở thư mục</button>' : ''}
    </div>
    <p class="hint">Bấm vào một khung chữ để sửa bản dịch, ẩn khung hoặc đổi cỡ chữ. Sửa tay được giữ lại khi dịch tiếp.</p>
    <div class="tr-pages" id="trPages">${b.pages_data.map((p, i) => `
      <figure class="tr-page box" data-n="${i}">
        <div class="tr-imgwrap"><img loading="lazy" src="/api/translate/books/${b.id}/pages/${i}/img" alt="Trang ${i + 1}"><div class="tr-layer"></div></div>
        <figcaption><span>Trang ${i + 1}</span><span class="tr-pst"></span><button class="btn sm plain" type="button" data-redo="${i}">Dịch lại trang</button></figcaption>
      </figure>`).join('')}</div>`;
  $('#trBack').addEventListener('click', () => { T.book = null; render(); });
  $('#trTitle').addEventListener('click', async () => {
    const name = prompt('Tên truyện (dùng làm tên file khi xuất):', T.book.name);
    if (!name) return;
    try { await api(`/api/translate/books/${T.book.id}`, {method: 'PATCH', body: {name}}); T.book.name = name; $('#trTitle').textContent = name; }
    catch (err) { toast(err.message, 'err'); }
  });
  el.querySelectorAll('[data-v]').forEach(c => c.addEventListener('click', () => {
    T.view = c.dataset.v;
    el.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('on', x === c));
    $('#trPages').classList.toggle('src', T.view === 'src');
  }));
  $('#trPages').classList.toggle('src', T.view === 'src');
  $('#trRun').addEventListener('click', async () => {
    const b = T.book, working = b.running || b.status === 'queued';
    try { await api(`/api/translate/books/${b.id}/${working ? 'stop' : 'run'}`, {method: 'POST', body: {}}); refreshReader(); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#trExport').addEventListener('click', async e => {
    try { await doExport(T.book.id, e.target); refreshReader(); } catch (err) { toast(err.message, 'err'); }
  });
  if ($('#trOpenDir')) $('#trOpenDir').addEventListener('click', () => api(`/api/translate/books/${T.book.id}/open`, {method: 'POST'}).catch(err => toast(err.message, 'err')));
  el.querySelectorAll('[data-redo]').forEach(btn => btn.addEventListener('click', async () => {
    const n = +btn.dataset.redo;
    const edited = (T.book.pages_data[n].blocks || []).some(x => x.edited);
    if (edited && !confirm('Trang này có chữ bạn đã sửa tay. Dịch lại sẽ thay bằng bản dịch máy mới. Tiếp tục?')) return;
    try { await api(`/api/translate/books/${T.book.id}/run`, {method: 'POST', body: {pages: [n], redo: true}}); refreshReader(); }
    catch (err) { toast(err.message, 'err'); }
  }));
  el.querySelectorAll('.tr-page').forEach(fig => {
    const img = $('img', fig);
    const draw = () => drawPage(fig);
    if (img.complete) draw(); else img.addEventListener('load', draw);
  });
  T.ro = T.ro || new ResizeObserver(entries => entries.forEach(en => { const f = en.target.closest('.tr-page'); if (f) drawPage(f); }));
  T.ro.disconnect();
  el.querySelectorAll('.tr-imgwrap').forEach(w => T.ro.observe(w));
  paintStatus();
  T.poll = setInterval(() => { if ($('#trPages') && T.book) refreshReader(); else clearInterval(T.poll); }, 2500);
}

function paintStatus() {
  const b = T.book;
  const working = b.running || b.status === 'queued';
  $('#trProg').textContent = `${b.done}/${b.pages} trang đã dịch` + (working ? ' · đang dịch…' : '') + (b.error ? ` · ${b.error}` : '');
  $('#trRun').textContent = working ? 'Dừng' : 'Dịch tiếp';
  $('#trRun').hidden = !working && b.done === b.pages;
  if ($('#trOpenDir')) $('#trOpenDir').hidden = !b.export;
  document.querySelectorAll('.tr-page').forEach(fig => {
    const p = b.pages_data[+fig.dataset.n];
    const st = $('.tr-pst', fig);
    st.textContent = p.status === 'done' ? `${(p.blocks || []).length} khung chữ` : p.status === 'error' ? (p.error || 'Lỗi') : 'Đang chờ dịch…';
    st.className = 'tr-pst ' + p.status;
  });
}

async function refreshReader() {
  if (T.edit || !T.book) return;            // đang sửa: không vẽ lại kẻo mất chữ đang gõ
  let b;
  try { b = await api(`/api/translate/books/${T.book.id}`); } catch (e) { return; }
  if (!$('#trPages') || !T.book || b.id !== T.book.id) return;
  const old = T.book.pages_data;
  T.book = b;
  document.querySelectorAll('.tr-page').forEach(fig => {
    const n = +fig.dataset.n;
    if (JSON.stringify(old[n]) !== JSON.stringify(b.pages_data[n])) drawPage(fig);
  });
  paintStatus();
}

function drawPage(fig) {
  if (!T.book || !T.book.pages_data) return;
  const n = +fig.dataset.n;
  const p = T.book.pages_data[n];
  const img = $('img', fig);
  const layer = $('.tr-layer', fig);
  if (!p || !img.naturalWidth) return;
  const W = p.w || img.naturalWidth, H = p.h || img.naturalHeight;
  const k = img.clientWidth / W;
  layer.innerHTML = (p.blocks || []).map((b, i) => {
    const [x, y, w, h] = b.area;
    const vi = (b.vi || '').trim();
    return `<div class="tr-blk${b.hide ? ' hide' : ''}${vi ? '' : ' empty'}" data-i="${i}" role="button" tabindex="0"
      title="${esc(b.text)}" style="left:${x / W * 100}%;top:${y / H * 100}%;width:${w / W * 100}%;height:${h / H * 100}%;
      --bg:${b.bg || '#fff'};--fg:${b.fg || '#111'};--fs:${Math.max(8, b.lh * 0.95 * (b.scale || 1) * k)}px">${esc(vi || b.text)}</div>`;
  }).join('');
  layer.querySelectorAll('.tr-blk').forEach(d => {
    fit(d);
    d.addEventListener('click', () => editBlock(fig, +d.dataset.i, d));
    d.addEventListener('keydown', e => { if (e.key === 'Enter') editBlock(fig, +d.dataset.i, d); });
  });
}

function fit(d) {
  let fs = parseFloat(getComputedStyle(d).getPropertyValue('--fs')) || 14;
  d.style.fontSize = fs + 'px';
  let guard = 40;
  while ((d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1) && fs > 7 && guard--) {
    fs -= 0.5;
    d.style.fontSize = fs + 'px';
  }
}

function editBlock(fig, i, el) {
  closeEdit();
  const n = +fig.dataset.n;
  const b = T.book.pages_data[n].blocks[i];
  const pop = document.createElement('div');
  pop.className = 'box tr-pop';
  pop.innerHTML = `
    <div class="hint">Chữ gốc</div><div class="tr-src">${esc(b.text)}</div>
    <label class="field">Bản dịch<textarea rows="3" id="trEditTxt">${esc(b.vi || '')}</textarea></label>
    <div class="btn-row">
      <button class="btn sm green" type="button" data-e="save">Lưu</button>
      <button class="btn sm plain" type="button" data-e="minus" aria-label="Chữ nhỏ hơn">A−</button>
      <button class="btn sm plain" type="button" data-e="plus" aria-label="Chữ to hơn">A+</button>
      <button class="btn sm plain" type="button" data-e="hide">${b.hide ? 'Hiện khung' : 'Ẩn khung'}</button>
      <button class="btn sm plain" type="button" data-e="close">Đóng</button>
    </div>`;
  fig.querySelector('.tr-imgwrap').appendChild(pop);
  const top = el.offsetTop + el.offsetHeight + 8;
  pop.style.top = Math.min(top, fig.querySelector('.tr-imgwrap').clientHeight - 10) + 'px';
  pop.style.left = Math.max(0, Math.min(el.offsetLeft, fig.clientWidth - 330)) + 'px';
  T.edit = {pop, n, i};
  const ta = $('#trEditTxt', pop);
  ta.focus();
  const save = async (patch) => {
    Object.assign(b, patch);
    try {
      await api(`/api/translate/books/${T.book.id}/pages/${n}`, {method: 'PUT', body: {blocks: T.book.pages_data[n].blocks.map((x, j) => j === i ? {vi: x.vi, hide: !!x.hide, scale: x.scale || 1} : {})}});
    } catch (err) { toast(err.message, 'err'); }
    drawPage(fig);
  };
  pop.addEventListener('click', async e => {
    const a = e.target.closest('[data-e]');
    if (!a) return;
    const act = a.dataset.e;
    if (act === 'close') return closeEdit();
    if (act === 'save') { await save({vi: ta.value, edited: true}); return closeEdit(); }
    if (act === 'hide') { await save({hide: !b.hide}); return closeEdit(); }
    const sc = Math.max(0.5, Math.min(2, (b.scale || 1) + (act === 'plus' ? 0.1 : -0.1)));
    await save({scale: Math.round(sc * 10) / 10});
    T.edit = {pop, n, i};
    fig.querySelector('.tr-imgwrap').appendChild(pop);
  });
  ta.addEventListener('keydown', e => { if (e.key === 'Escape') closeEdit(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) pop.querySelector('[data-e=save]').click(); });
}
function closeEdit() { if (T.edit) { T.edit.pop.remove(); T.edit = null; } }

/* ================================================================ TRUYỆN CHỮ */
async function renderNovels() {
  const el = $('#trSub');
  el.innerHTML = `
    <div class="cols2">
      <div class="box pcard tr-drop" id="nvDrop">
        <h3>Thêm truyện chữ</h3>
        <p>Kéo thả file <b>.txt</b>, <b>.epub</b> (không khóa DRM), <b>.html</b> hoặc <b>.md</b>. App tự chia chương (“Chapter 1”, “第1章”, “제1장”…), dịch nền từng chương và giữ mạch truyện, xưng hô.</p>
        <div class="btn-row"><label class="btn green">CHỌN FILE<input type="file" id="nvFile" accept=".txt,.epub,.html,.htm,.md" multiple hidden></label></div>
        <form class="paste-row" id="nvPathForm">
          <input type="text" id="nvPath" placeholder="Hoặc dán đường dẫn file trên ổ, ví dụ D:\\Truyen\\ten-truyen.epub" aria-label="Đường dẫn truyện trên ổ">
          <button class="btn plain" type="submit">MỞ</button>
        </form>
        <p class="hint" id="nvMsg">Xuất ra EPUB (đọc bằng app đọc sách trên điện thoại) hoặc TXT.</p>
      </div>
      <form class="box pcard" id="nvPaste">
        <h3>Dán văn bản</h3>
        <input type="text" id="nvName" placeholder="Tên truyện" aria-label="Tên truyện">
        <textarea id="nvText" rows="7" placeholder="Dán một hay nhiều chương (web novel, light novel…). Mỗi đoạn một dòng hoặc cách nhau dòng trống."></textarea>
        <div class="btn-row"><button class="btn yellow" type="submit">THÊM VÀ DỊCH</button></div>
      </form>
    </div>
    <div class="sec-title">Truyện chữ đã thêm</div>
    <div id="nvList" class="main"><div class="loading"><span class="spin"></span>Đang tải…</div></div>`;
  const drop = $('#nvDrop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); addNovels([...e.dataTransfer.files]); });
  $('#nvFile').addEventListener('change', e => addNovels([...e.target.files]));
  $('#nvPathForm').addEventListener('submit', async e => {
    e.preventDefault();
    const path = $('#nvPath').value.trim();
    if (!path) return;
    try { const n = await api('/api/translate/novels/from-path', {method: 'POST', body: {path}}); await novelAdded(n); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#nvPaste').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#nvText').value;
    if (!text.trim()) return;
    try { const n = await api('/api/translate/novels/text', {method: 'POST', body: {name: $('#nvName').value.trim(), text}}); await novelAdded(n); }
    catch (err) { toast(err.message, 'err'); }
  });
  await loadNovels();
  T.poll = setInterval(() => { if (!document.hidden && $('#nvList')) loadNovels(); else if (!$('#nvList')) clearInterval(T.poll); }, 3000);
}

async function addNovels(files) {
  const msg = $('#nvMsg');
  for (const f of files) {
    msg.textContent = `Đang đọc ${f.name}…`;
    try { const n = await upload(`/api/translate/novels?filename=${encodeURIComponent(f.name)}`, f); await novelAdded(n, files.length > 1); }
    catch (err) { msg.textContent = err.message; toast(err.message, 'err'); return; }
  }
  msg.textContent = 'Đã thêm.';
}

async function novelAdded(n, many) {
  toast(`Đã thêm “${n.name}”: ${n.chapters} chương, ${n.paras.toLocaleString('vi-VN')} đoạn.`);
  if (!many) { T.novel = n.id; render(); } else loadNovels();
}

async function loadNovels() {
  const el = $('#nvList');
  if (!el) return;
  let d;
  try { d = await api('/api/translate/novels'); } catch (e) { el.innerHTML = `<div class="notice box err">${esc(e.message)}</div>`; return; }
  if (!d.novels.length) { el.innerHTML = '<div class="box empty"><h3>Chưa có truyện chữ nào</h3><p>Thêm file hoặc dán văn bản ở trên.</p></div>'; return; }
  const key = JSON.stringify(d.novels);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = d.novels.map(n => {
    const pct = n.paras ? Math.round(n.done / n.paras * 100) : 0;
    const working = n.running || n.status === 'queued';
    return `<div class="box tr-book" data-nid="${n.id}">
      <div class="tr-book-main">
        <span><b class="tr-name">${esc(n.name)}</b> <span class="badge" style="background:var(--cyan)">${LANG_VI[n.lang] || 'Tự nhận'}</span></span>
        <div class="prog"><div class="bar"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:${n.status === 'error' ? 'var(--red)' : 'var(--green)'}"></i></div>
          <span class="hint">${working ? 'Đang dịch · ' : ''}${n.chapters_done}/${n.chapters} chương · ${pct}% (${n.chars.toLocaleString('vi-VN')} ký tự)</span></div>
        ${n.error ? `<span class="tr-err">${esc(n.error)}</span>` : ''}
        ${n.export ? `<span class="hint mono tr-path">${esc(n.export)}</span>` : ''}
      </div>
      <div class="btn-row">
        <button class="btn sm yellow" type="button" data-na="open">Mở</button>
        ${working ? '<button class="btn sm plain" type="button" data-na="stop">Dừng</button>' : n.done < n.paras ? '<button class="btn sm green" type="button" data-na="run">Dịch tiếp</button>' : ''}
        <button class="btn sm cyan" type="button" data-na="epub" ${n.done ? '' : 'disabled'}>Xuất EPUB</button>
        <button class="btn sm plain" type="button" data-na="del" aria-label="Xóa ${esc(n.name)}">Xóa</button>
      </div></div>`;
  }).join('');
  el.querySelectorAll('[data-nid]').forEach(row => row.addEventListener('click', e => novelAct(e, row.dataset.nid)));
}

async function novelAct(e, id) {
  const b = e.target.closest('[data-na]');
  if (!b) return;
  const a = b.dataset.na;
  try {
    if (a === 'open') { T.novel = id; return render(); }
    if (a === 'run') await novelRun(id, {start: 0});
    if (a === 'stop') await api(`/api/translate/novels/${id}/stop`, {method: 'POST'});
    if (a === 'epub' || a === 'txt') {
      b.disabled = true;
      const r = await api(`/api/translate/novels/${id}/export?fmt=${a}`, {method: 'POST'});
      toast(`Đã lưu ${r.path}${r.done < r.paras ? ` (đoạn chưa dịch giữ nguyên bản gốc)` : ''}`);
      b.disabled = false;
    }
    if (a === 'del') {
      if (!confirm('Xóa truyện này khỏi danh sách dịch? (File EPUB/TXT đã xuất ra ổ vẫn giữ nguyên.)')) return;
      await api(`/api/translate/novels/${id}`, {method: 'DELETE'});
      if (T.novel === id) { T.novel = null; return render(); }
    }
  } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  if ($('#nvList')) { $('#nvList').dataset.key = ''; loadNovels(); } else if (T.novel) refreshNovel();
}

async function novelRun(id, body) {
  const s = T.settings;
  const n = await api(`/api/translate/novels/${id}`);
  const left = n.chars - (n.done / Math.max(1, n.paras)) * n.chars;
  if (s.engine === 'claude' && left > 150000) {
    const pr = {'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5]}[s.claude_model] || [2, 10];
    const usdv = (left / 3.5 * pr[0] + left * 0.6 * 1.5 * pr[1]) / 1e6 + left / 6000 * 1500 * pr[0] / 1e6;   // gửi + nhận (kể cả suy nghĩ) + hướng dẫn mỗi lô
    if (!confirm(`Còn khoảng ${Math.round(left).toLocaleString('vi-VN')} ký tự chưa dịch. Ước tính với ${engineName(s)}: ${usd(usdv)}. Dịch tiếp?`)) return;
  }
  await api(`/api/translate/novels/${id}/run`, {method: 'POST', body});
}

/* ---------------------------------------------------------------- đọc & sửa truyện chữ */
async function renderNovel() {
  const el = $('#trSub');
  el.innerHTML = '<div class="loading"><span class="spin"></span>Đang mở truyện…</div>';
  let n;
  try { n = await api(`/api/translate/novels/${T.novel}`); } catch (e) { T.novel = null; toast(e.message, 'err'); return render(); }
  T.nv = {ch: Math.min(T.nv && T.nv.id === n.id ? T.nv.ch : 0, n.list.length - 1), id: n.id, state: n};
  el.innerHTML = `
    <div class="box tr-bar">
      <button class="btn sm plain" type="button" id="nvBack">← Danh sách</button>
      <b class="tr-name" id="nvTitle" title="Bấm để đổi tên">${esc(n.name)}</b>
      <span class="hint" id="nvStat"></span>
      <span class="tr-seg">
        <button class="btn sm green" type="button" id="nvRun"></button>
        <button class="btn sm cyan" type="button" data-na="epub">Xuất EPUB</button>
        <button class="btn sm plain" type="button" data-na="txt">Xuất TXT</button>
      </span>
    </div>
    <details class="box pcard tr-help" ${n.brief ? '' : ''}><summary>Bối cảnh truyện &amp; thuật ngữ (gửi kèm cho Claude)</summary>
      <div class="cols2">
        <label class="field">Bối cảnh<textarea id="nvBrief" rows="5" placeholder="Ví dụ: Tiên hiệp, nhân vật chính Lâm Phong xưng “ta”, gọi sư phụ là “sư tôn”…">${esc(n.brief || '')}</textarea></label>
        <label class="field">Thuật ngữ<textarea id="nvGloss" rows="5" placeholder="Mỗi dòng: chữ gốc = chữ dịch&#10;Qi = Linh khí">${esc(n.glossary || '')}</textarea></label>
      </div>
    </details>
    <div class="nv-layout">
      <nav class="box nv-toc" aria-label="Mục lục" id="nvToc"></nav>
      <div class="main" id="nvBody"></div>
    </div>`;
  $('#nvBack').addEventListener('click', () => { T.novel = null; render(); });
  $('#nvTitle').addEventListener('click', async () => {
    const name = prompt('Tên truyện (dùng làm tên file khi xuất):', n.name);
    if (!name) return;
    try { await api(`/api/translate/novels/${n.id}`, {method: 'PATCH', body: {name}}); $('#nvTitle').textContent = name; } catch (err) { toast(err.message, 'err'); }
  });
  ['nvBrief', 'nvGloss'].forEach(id => $('#' + id).addEventListener('change', e => api(`/api/translate/novels/${n.id}`, {method: 'PATCH',
    body: id === 'nvBrief' ? {brief: e.target.value} : {glossary: e.target.value}}).then(() => toast('Đã lưu.')).catch(err => toast(err.message, 'err'))));
  el.querySelector('.tr-bar').addEventListener('click', e => { if (e.target.closest('[data-na]')) novelAct(e, n.id); });
  $('#nvRun').addEventListener('click', async () => {
    const st = T.nv.state;
    try {
      if (st.running || st.status === 'queued') await api(`/api/translate/novels/${n.id}/stop`, {method: 'POST'});
      else await novelRun(n.id, {start: T.nv.ch});
    } catch (err) { toast(err.message, 'err'); }
    refreshNovel();
  });
  paintNovel(n);
  await loadChapter();
  T.poll = setInterval(() => { if ($('#nvBody') && T.novel) refreshNovel(); else clearInterval(T.poll); }, 3000);
}

function paintNovel(n) {
  T.nv.state = n;
  const working = n.running || n.status === 'queued';
  $('#nvStat').textContent = `${n.chapters_done}/${n.chapters} chương · ${n.done.toLocaleString('vi-VN')}/${n.paras.toLocaleString('vi-VN')} đoạn` + (working ? ' · đang dịch…' : '') + (n.error ? ' · ' + n.error : '');
  $('#nvRun').textContent = working ? 'Dừng dịch' : n.done < n.paras ? 'Dịch từ chương này' : 'Đã dịch xong';
  $('#nvRun').disabled = !working && n.done >= n.paras;
  $('#nvToc').innerHTML = n.list.map(c => `<button type="button" class="nv-ch${c.n === T.nv.ch ? ' on' : ''}${c.done === c.paras ? ' ok' : c.done ? ' half' : ''}" data-ch="${c.n}">
    <span class="nv-dot" aria-hidden="true"></span><span>${esc(c.title_vi || c.title)}</span></button>`).join('');
  $('#nvToc').querySelectorAll('[data-ch]').forEach(b => b.addEventListener('click', () => { T.nv.ch = +b.dataset.ch; paintNovel(T.nv.state); loadChapter(); }));
}

async function refreshNovel() {
  if (!T.novel || !$('#nvBody')) return;
  try {
    const n = await api(`/api/translate/novels/${T.novel}`);
    const before = T.nv.state.list[T.nv.ch];
    paintNovel(n);
    const now = n.list[T.nv.ch];
    const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#nvBody');
    if (!editing && before && now && (before.done !== now.done || before.title_vi !== now.title_vi)) loadChapter();
  } catch (e) { /* bỏ qua */ }
}

async function loadChapter() {
  const el = $('#nvBody');
  if (!el) return;
  let c;
  try { c = await api(`/api/translate/novels/${T.novel}/chapters/${T.nv.ch}`); } catch (e) { el.innerHTML = `<div class="notice box err">${esc(e.message)}</div>`; return; }
  const rows = c.paras.map(p => `<div class="nv-p${p.vi == null ? ' todo' : ''}">
      <div class="nv-src">${esc(p.t)}</div>
      <textarea data-i="${p.i}" rows="${Math.min(12, Math.max(2, Math.ceil((p.vi || p.t).length / 70)))}" aria-label="Bản dịch đoạn ${p.i + 1}" placeholder="Chưa dịch">${esc(p.vi || '')}</textarea>
    </div>`).join('');
  el.innerHTML = `<div class="box pcard nv-chap">
      <div class="row-between"><input type="text" class="nv-tt" data-i="-1" value="${esc(c.title_vi || '')}" placeholder="${esc(c.title)}" aria-label="Tên chương tiếng Việt">
        <span class="hint">Chương ${c.n + 1}/${c.total} · ${esc(c.title)}</span></div>
      <p class="hint">Cột trái là bản gốc, cột phải là bản dịch: sửa trực tiếp, rời ô là tự lưu. Đoạn đã sửa tay được giữ khi dịch lại.</p>
      <div class="nv-paras">${rows}</div>
      <div class="row-between">
        <button class="btn sm plain" type="button" data-step="-1" ${c.n === 0 ? 'disabled' : ''}>← Chương trước</button>
        <button class="btn sm plain" type="button" id="nvRedo">Dịch lại chương này</button>
        <button class="btn sm plain" type="button" data-step="1" ${c.n + 1 >= c.total ? 'disabled' : ''}>Chương sau →</button>
      </div></div>`;
  el.querySelectorAll('textarea, .nv-tt').forEach(ta => {
    ta.dataset.orig = ta.value;
    ta.addEventListener('blur', async () => {
      if (ta.value === ta.dataset.orig) return;
      try { await api(`/api/translate/novels/${T.novel}/chapters/${c.n}`, {method: 'PUT', body: [{i: +ta.dataset.i, vi: ta.value}]}); ta.dataset.orig = ta.value; }
      catch (err) { toast(err.message, 'err'); }
    });
  });
  el.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    T.nv.ch = Math.max(0, Math.min(c.total - 1, c.n + (+b.dataset.step))); paintNovel(T.nv.state); loadChapter(); $('#nvBody').scrollIntoView({block: 'start'});
  }));
  $('#nvRedo').addEventListener('click', async () => {
    if (!confirm('Dịch lại chương này? (Đoạn bạn đã sửa tay được giữ nguyên.)')) return;
    try { await api(`/api/translate/novels/${T.novel}/run`, {method: 'POST', body: {start: c.n, end: c.n, redo: true}}); toast('Đang dịch lại chương.'); refreshNovel(); }
    catch (err) { toast(err.message, 'err'); }
  });
}

/* ================================================================ DỊCH GAME */

function renderGame() {
  const el = $('#trSub');
  el.innerHTML = `
    ${desk && desk.openScreenTranslate ? '' : `<div class="notice box warn"><b>Khung dịch màn hình chỉ có trong app CircleVault trên Windows</b>
      <span>Trên trình duyệt bạn vẫn thử được bằng ảnh chụp màn hình ở khung bên phải.</span></div>`}
    <div class="cols2">
      <div class="box pcard">
        <h3>Dịch chữ trong game đang chơi</h3>
        <p>Một khung nhỏ luôn nằm trên game. Bạn khoanh vùng chữ (khung hội thoại, nhiệm vụ, menu…), app đọc chữ ở vùng đó và hiện bản dịch tiếng Việt ngay trong khung.</p>
        <ol class="steps">
          <li>Mở game, để chế độ <b>Cửa sổ</b> hoặc <b>Toàn màn hình không viền</b> (Borderless). Chế độ toàn màn hình độc quyền sẽ che mất khung dịch.</li>
          <li>Bấm <span class="ui-k g">MỞ KHUNG DỊCH</span> → <span class="ui-k">Chọn vùng</span> → kéo chuột khoanh vùng có chữ.</li>
          <li>Bấm <span class="ui-k">Dịch</span> mỗi khi có câu mới, hoặc bật <span class="ui-k">Tự động</span> để app tự dịch khi chữ thay đổi.</li>
          <li>Kéo khung dịch tới chỗ không che game (thường là ngay dưới khung hội thoại).</li>
        </ol>
        <div class="btn-row"><button class="btn green" type="button" id="trScreen" ${desk && desk.openScreenTranslate ? '' : 'disabled'}>MỞ KHUNG DỊCH</button></div>
        <div class="tr-keys">
          <div><span class="ui-k">Ctrl</span> + <span class="ui-k">Alt</span> + <span class="ui-k">T</span> dịch vùng đã chọn</div>
          <div><span class="ui-k">Ctrl</span> + <span class="ui-k">Alt</span> + <span class="ui-k">R</span> chọn lại vùng</div>
          <div><span class="ui-k">Ctrl</span> + <span class="ui-k">Alt</span> + <span class="ui-k">A</span> bật/tắt tự động</div>
          <div><span class="ui-k">Ctrl</span> + <span class="ui-k">Alt</span> + <span class="ui-k">H</span> ẩn/hiện khung dịch</div>
        </div>
        <p class="hint">Chơi game liên tục nên dùng <b>Google Dịch</b> (miễn phí) hoặc <b>Claude Haiku 5.5</b> (rẻ, nhanh). Khung dịch không bị chụp vào ảnh nên không tự dịch lại chính nó.</p>
      </div>
      <div class="box pcard">
        <h3>Thử với ảnh chụp màn hình</h3>
        <p>Chọn một ảnh chụp game (hoặc dán bằng <span class="ui-k">Ctrl</span>+<span class="ui-k">V</span> sau khi bấm <span class="ui-k">PrtSc</span>) để xem app đọc và dịch thế nào.</p>
        <div class="btn-row"><label class="btn yellow">CHỌN ẢNH<input type="file" id="trShot" accept="image/*" hidden></label></div>
        <div id="trShotOut"></div>
      </div>
    </div>
    <div class="box pcard">
      <h3>Game có sẵn bản Việt hóa?</h3>
      <p class="hint">Nhiều game lớn đã có bản Việt hóa do cộng đồng làm, dịch sát và đầy đủ hơn dịch máy. Tìm "tên game + Việt hóa" trước. Dịch màn hình hợp nhất với game không có bản Việt: visual novel, RPG nhiều chữ, game di động chạy giả lập.</p>
    </div>`;
  if ($('#trScreen') && desk && desk.openScreenTranslate) $('#trScreen').addEventListener('click', () => desk.openScreenTranslate());
  const run = async file => {
    const out = $('#trShotOut');
    out.innerHTML = '<div class="loading"><span class="spin"></span>Đang đọc chữ và dịch… (lần đầu mất thêm vài giây để nạp bộ nhận diện)</div>';
    try {
      const r = await upload('/api/translate/image?mode=game', file);
      out.innerHTML = r.blocks.length ? `<div class="tr-shot">${r.blocks.map(b => `<div class="tr-line"><span class="hint">${esc(b.text)}</span><b>${esc(b.vi || '')}</b></div>`).join('')}</div>`
        : '<p class="hint">Không thấy chữ nào trong ảnh.</p>';
    } catch (err) { out.innerHTML = `<div class="notice box err">${esc(err.message)}</div>`; }
  };
  $('#trShot').addEventListener('change', e => { if (e.target.files[0]) run(e.target.files[0]); });
  T.paste = T.paste || (e => {
    if (T.sub !== 'game' || !$('#trShotOut')) return;
    const f = [...(e.clipboardData && e.clipboardData.files || [])].find(x => /^image\//.test(x.type));
    if (f) { e.preventDefault(); run(f); }
  });
  document.removeEventListener('paste', T.paste);
  document.addEventListener('paste', T.paste);
}

/* ================================================================ DỊCH NHANH */
function renderQuick() {
  const el = $('#trSub');
  el.innerHTML = `
    <div class="cols2">
      <div class="box pcard">
        <h3>Văn bản gốc</h3>
        <textarea id="trIn" rows="12" placeholder="Dán đoạn hội thoại, nhiệm vụ trong game, mô tả vật phẩm… (cách đoạn bằng một dòng trống)"></textarea>
        <div class="btn-row"><button class="btn green" type="button" id="trGo">DỊCH</button></div>
      </div>
      <div class="box pcard">
        <h3>Tiếng Việt</h3>
        <div id="trOut" class="tr-out" aria-live="polite"><span class="hint">Bản dịch hiện ở đây.</span></div>
        <div class="btn-row"><button class="btn sm plain" type="button" id="trCopy">Sao chép</button></div>
      </div>
    </div>`;
  $('#trGo').addEventListener('click', async e => {
    const text = $('#trIn').value;
    if (!text.trim()) return;
    e.target.disabled = true; e.target.textContent = 'Đang dịch…';
    try { const r = await api('/api/translate/text', {method: 'POST', body: {text}}); $('#trOut').textContent = r.text; }
    catch (err) { $('#trOut').innerHTML = `<span class="tr-err">${esc(err.message)}</span>`; }
    finally { e.target.disabled = false; e.target.textContent = 'DỊCH'; }
  });
  $('#trIn').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#trGo').click(); });
  $('#trCopy').addEventListener('click', () => navigator.clipboard.writeText($('#trOut').textContent).then(() => toast('Đã sao chép.')));
}

/* ================================================================ CÀI ĐẶT */
function renderSettings() {
  const s = T.settings;
  const el = $('#trSub');
  el.innerHTML = `
    <form id="trSet" class="main">
      <div class="cols2">
        <label class="box pcard tr-engine${s.engine === 'google' ? ' on' : ''}">
          <span class="row-between"><h3>Google Dịch</h3><input type="radio" name="engine" value="google" ${s.engine === 'google' ? 'checked' : ''}></span>
          <span class="badge" style="background:var(--green)">Miễn phí</span>
          <span>Không cần đăng ký. Dịch từng câu riêng lẻ nên xưng hô hay bị cứng ("tôi/bạn"), câu đôi khi sai nghĩa. Dịch quá nhiều một lúc có thể bị Google chặn tạm thời.</span>
        </label>
        <label class="box pcard tr-engine${s.engine === 'claude' ? ' on' : ''}">
          <span class="row-between"><h3>Claude AI</h3><input type="radio" name="engine" value="claude" ${s.engine === 'claude' ? 'checked' : ''}></span>
          <span class="badge" style="background:var(--yellow)">Cần API key · trả theo lượt dùng</span>
          <span>Dịch cả trang một lúc theo ngữ cảnh: xưng hô tự nhiên, giữ giọng nhân vật, tự sửa chữ nhận diện sai. Gửi kèm ảnh trang để AI nhìn ai đang nói.</span>
        </label>
      </div>

      <div class="box pcard" id="trClaude" ${s.engine === 'claude' ? '' : 'hidden'}>
        <h3>Cài đặt Claude AI</h3>
        <label class="field">API key
          <input type="password" id="trKey" autocomplete="off" placeholder="${s.has_key ? `Đã lưu khóa …${esc(s.key_tail)} – để trống nếu không đổi` : 'sk-ant-…'}">
          <small>Lưu trên máy bạn (thư mục dữ liệu CircleVault), chỉ gửi tới máy chủ của Anthropic khi dịch.</small>
        </label>
        ${s.has_key ? '<div><button class="btn sm plain" type="button" id="trDelKey">Xóa khóa đã lưu</button></div>' : ''}
        <label class="field">Mô hình
          <select id="trModel">${Object.entries(s.models).map(([k, v]) => `<option value="${k}" ${k === s.claude_model ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </label>
        <label class="check"><input type="checkbox" id="trImg" ${s.send_image ? 'checked' : ''}> Gửi kèm ảnh trang cho AI (dịch sát hơn, tốn thêm khoảng gấp đôi)</label>
        ${s.usage && s.usage.total ? `<p class="hint">App đã dùng Claude hết khoảng: hôm nay <b>${usd(s.usage.today)}</b> · tháng này <b>${usd(s.usage.month)}</b> (tính theo số token Claude báo về sau mỗi lượt; số dư chính xác xem ở Claude Console → Thanh toán).</p>` : ''}
        <details class="tr-help"><summary>Cách lấy API key và chi phí</summary>
          <ol class="steps">
            <li>Vào <b>console.anthropic.com</b>, đăng ký bằng email.</li>
            <li>Mục <b>Billing</b>: nạp tiền bằng thẻ Visa/Mastercard (tối thiểu 5 USD).</li>
            <li>Mục <b>API Keys</b> → <b>Create Key</b> → copy khóa bắt đầu bằng <code>sk-ant-</code> rồi dán vào ô trên.</li>
          </ol>
          <p class="hint">Ước tính cho một chương 25 trang có gửi ảnh: Opus 5.5 khoảng 0,5–1 USD, Sonnet 5.5 khoảng một nửa, Haiku 5.5 chỉ vài cent. Câu đã dịch được nhớ lại, mở lại hay xuất lại không tốn thêm. Tiền tính theo token: mỗi lượt gửi kèm hướng dẫn, bối cảnh, thuật ngữ; câu tiếng Việt tốn nhiều token hơn tiếng Anh; phần Claude "suy nghĩ" cũng tính tiền – nên con số thật thường cao hơn ước tính thô theo số chữ. Không chia sẻ API key cho người khác.</p>
        </details>
      </div>

      <div class="box pcard">
        <h3>Ngôn ngữ, thuật ngữ, cách dịch</h3>
        <label class="field">Ngôn ngữ gốc
          <select id="trSrc">${Object.entries(s.langs).map(([k, v]) => `<option value="${k}" ${k === s.source ? 'selected' : ''}>${esc(v[0].toUpperCase() + v.slice(1))}</option>`).join('')}</select>
          <small>Bộ nhận diện chữ đọc tốt chữ Latin (tiếng Anh) và chữ Trung; tiếng Nhật/Hàn đọc kém hơn.</small>
        </label>
        <label class="field">Bảng tên riêng, thuật ngữ
          <textarea id="trGloss" rows="5" placeholder="Mỗi dòng: chữ gốc = chữ dịch&#10;Straw Hat = Mũ Rơm&#10;Devil Fruit = Trái Ác Quỷ">${esc(s.glossary)}</textarea>
          <small>App luôn dùng đúng các cách dịch này.</small>
        </label>
        <label class="field">Yêu cầu thêm cho AI (chỉ Claude)
          <textarea id="trStyle" rows="2" placeholder="Ví dụ: truyện kiếm hiệp, xưng ta – ngươi; giữ nguyên tiếng lóng tiếng Anh">${esc(s.style)}</textarea>
        </label>
        <label class="field">Phông chữ khi xuất CBZ
          <select id="trFont">${[['auto', 'Tự chọn (Comic Sans → Arial)'], ['comic', 'Comic Sans MS – giống chữ truyện'], ['arial', 'Arial'], ['tahoma', 'Tahoma']]
            .map(([k, v]) => `<option value="${k}" ${k === s.font ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
      </div>
      <div class="save-row"><button class="btn green" type="submit">LƯU CÀI ĐẶT</button></div>
    </form>`;
  const form = $('#trSet');
  form.querySelectorAll('[name=engine]').forEach(r => r.addEventListener('change', () => {
    form.querySelectorAll('.tr-engine').forEach(c => c.classList.toggle('on', $('input', c).checked));
    $('#trClaude').hidden = form.querySelector('[name=engine]:checked').value !== 'claude';
  }));
  if ($('#trDelKey')) $('#trDelKey').addEventListener('click', async () => {
    if (!confirm('Xóa API key đã lưu?')) return;
    try { await api('/api/translate/settings', {method: 'PUT', body: {claude_key: ''}}); toast('Đã xóa khóa.'); render(); } catch (err) { toast(err.message, 'err'); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {engine: form.querySelector('[name=engine]:checked').value, claude_model: $('#trModel').value, send_image: $('#trImg').checked,
      source: $('#trSrc').value, glossary: $('#trGloss').value, style: $('#trStyle').value, font: $('#trFont').value};
    const key = $('#trKey').value.trim();
    if (key) body.claude_key = key;
    if (body.engine === 'claude' && !key && !s.has_key) { toast('Nhập API key của Claude trước (hoặc chọn Google Dịch).', 'err'); return; }
    try { await api('/api/translate/settings', {method: 'PUT', body}); toast('Đã lưu cài đặt dịch.'); render(); } catch (err) { toast(err.message, 'err'); }
  });
}


/* ================================================================ VIỆT HÓA GAME (từ file) */
const KIND = {say: 'Thoại', menu: 'Lựa chọn', ui: 'Giao diện', msg: 'Thoại', db: 'Dữ liệu', name: 'Tên'};
const usd = (v) => v < 0.01 ? 'dưới 0,01 USD' : `~${v.toLocaleString('vi-VN', {maximumFractionDigits: 2})} USD`;

async function renderGames() {
  const el = $('#trSub');
  el.innerHTML = `
    <div class="box pcard vh-start">
      <ol class="vh-steps" aria-label="Các bước">
        <li class="on"><b>1</b>Chọn game</li><li><b>2</b>App tìm file chữ</li><li><b>3</b>Dịch &amp; sửa</li><li><b>4</b>Áp dụng vào game</li>
      </ol>
      <label class="field" id="vhSteamRow" hidden>Game Steam trên máy này<select id="vhSteam"><option value="">— Chọn game —</option></select></label>
      <form class="paste-row" id="vhForm">
        <input type="text" id="vhPath" placeholder="Thư mục game, ví dụ D:\\SteamLibrary\\steamapps\\common\\TenGame" aria-label="Thư mục game">
        ${desk && desk.pickFolder ? '<button class="btn plain" type="button" id="vhPick">Chọn thư mục…</button>' : ''}
        <button class="btn green" type="submit">TÌM FILE CHỮ</button>
      </form>
      <p class="hint" id="vhMsg">Chỉ cần thư mục chứa file .exe của game. App tự lục toàn bộ thư mục, nhận loại game và tìm file chứa ngôn ngữ.</p>
      <details class="tr-help"><summary>App đọc được những gì?</summary>
        <ul class="tick">
          <li><b>Ren'Py</b>: kịch bản .rpy / .rpyc / .rpa. App chỉ thêm 2 file <code>zz_circlevault_vi.rpy</code>, <code>circlevault_vi.json</code>, không sửa file của game.</li>
          <li><b>RPG Maker MV/MZ</b>: <code>data/*.json</code>. Tự xuống dòng, đổi phông có dấu.</li>
          <li><b>Unity</b>: bảng chữ Unity Localization, và file chữ (JSON/CSV/XML…) để rời hoặc nhúng trong <code>.assets</code> / <code>.bundle</code> (TextAsset).</li>
          <li><b>File chữ của mọi game</b>: .json .csv .tsv .xml .po .ini .cfg .properties .lang .strings .yaml .txt, kịch bản TyranoScript/KAG .ks. App chấm điểm từng file, chọn sẵn file ngôn ngữ gốc (ưu tiên tiếng Anh), bỏ file dữ liệu khó đoán.</li>
          <li>Mọi file bị sửa đều được sao lưu vào <code>CircleVault-ban-goc</code> trong thư mục game. Bấm <b>Khôi phục bản gốc</b> là về như cũ.</li>
          <li>Chưa đọc được: game Unreal (.pak), Godot (.pck), GameMaker (data.win), Kirikiri .xp3, Wolf RPG, RPG Maker VX/XP, game mã hóa dữ liệu. Dùng <b>Dịch màn hình game</b>, hoặc gói của nhóm dịch.</li>
          <li>Tắt game trước khi Áp dụng. Game nằm trong <code>Program Files</code> thì chép ra ổ khác trước. Steam cập nhật game thì bấm Áp dụng lại.</li>
        </ul>
      </details>
    </div>
    <div id="vhScan"></div>
    <div class="sec-title">Game đang Việt hóa</div>
    <div id="vhList" class="main"><div class="loading"><span class="spin"></span>Đang tải…</div></div>`;
  steamSelect(['#vhPath']);
  if ($('#vhPick')) $('#vhPick').addEventListener('click', async () => {
    const f = await desk.pickFolder('Chọn thư mục game');
    if (f) { $('#vhPath').value = f; $('#vhForm').requestSubmit(); }
  });
  $('#vhForm').addEventListener('submit', e => {
    e.preventDefault();
    const path = $('#vhPath').value.trim();
    if (path) startScan(path);
  });
  if (T.scan && T.scan.path) { $('#vhPath').value = T.scan.path; paintScan(T.scan.last); if (T.scan.state === 'running') pollScan(); }
  await loadGames();
  T.poll = setInterval(() => { if (!document.hidden && $('#vhList')) loadGames(); else if (!$('#vhList')) clearInterval(T.poll); }, 3000);
}

function steamSelect(targets) {
  api('/api/translate/vh/steam').then(d => {
    if (!d.games.length || !$('#vhSteam')) return;
    const tag = {unity: ' · Unity', rpg: ' · RPG Maker', renpy: " · Ren'Py"};
    $('#vhSteam').innerHTML += d.games.map(g => `<option value="${esc(g.path)}">${esc(g.name)}${tag[g.kind] || ''}</option>`).join('');
    $('#vhSteamRow').hidden = false;
    $('#vhSteam').addEventListener('change', e => {
      if (!e.target.value) return;
      targets.forEach(t => { if ($(t)) $(t).value = e.target.value; });
      if ($('#vhForm')) $('#vhForm').requestSubmit();
    });
  }).catch(() => {});
}

/* ---------------------------------------------------------------- tìm file chữ (chạy nền, có thanh tiến độ) */
async function startScan(path, aes) {
  if (T.scan && T.scan.timer) clearInterval(T.scan.timer);
  if (T.scan && T.scan.job && T.scan.state === 'running') api(`/api/translate/games/scan/${T.scan.job}/cancel`, {method: 'POST'}).catch(() => {});
  T.scan = {path, aes: aes || null, job: null, state: 'running', last: {phase: 'start', text: 'Đang bắt đầu…', done: 0, total: 0, found: 0, strings: 0}};
  paintScan(T.scan.last);
  try {
    const r = await api('/api/translate/games/scan', {method: 'POST', body: {path, aes: aes || null}});
    T.scan.job = r.job;
    pollScan();
  } catch (err) { T.scan.state = 'error'; paintScan({state: 'error', error: err.message}); }
}

function pollScan() {
  clearInterval(T.scan.timer);
  const tick = async () => {
    if (!T.scan || !T.scan.job) return;
    if (!$('#vhScan')) { clearInterval(T.scan.timer); return; }
    try {
      const j = await api(`/api/translate/games/scan/${T.scan.job}`);
      T.scan.last = j; T.scan.state = j.state;
      paintScan(j);
      if (j.state !== 'running') clearInterval(T.scan.timer);
    } catch (err) { clearInterval(T.scan.timer); T.scan.state = 'error'; paintScan({state: 'error', error: err.message}); }
  };
  T.scan.timer = setInterval(tick, 300);
  tick();
}

const PHASES = [['list', 'Liệt kê file'], ['engine', 'Nhận loại game'], ['files', 'Lục file chữ'], ['done', 'Xong']];
function paintScan(j) {
  const el = $('#vhScan');
  if (!el || !j) return;
  if (j.state === 'error') {
    el.innerHTML = `<div class="notice box err"><b>Không tìm được</b><span>${esc(j.error || 'Lỗi không rõ.')}</span></div>`;
    return;
  }
  if (j.state === 'done' && j.result) return paintFound(j.result);
  const pi = Math.max(0, PHASES.findIndex(p => p[0] === j.phase));
  const pct = j.phase === 'files' && j.total ? Math.min(99, Math.round((j.bytes != null ? j.bytes : j.done / j.total) * 100)) : null;
  const old = el.querySelector('.scan-box');
  const html = `
      <ol class="scan-phases">${PHASES.slice(0, 3).map(([k, n], i) => `<li class="${i < pi ? 'ok' : i === pi ? 'on' : ''}">${i < pi ? '✓' : i + 1}. ${n}</li>`).join('')}</ol>
      <div class="scan-row">
        <div class="scan-glass" aria-hidden="true"><span class="scan-doc"></span><span class="scan-doc"></span><span class="scan-doc"></span><i></i></div>
        <div class="scan-meter">
          <div class="scan-bar${pct == null ? ' indet' : ''}" role="progressbar" aria-label="Tiến độ tìm file chữ" ${pct == null ? '' : `aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"`}>
            <i style="width:${pct == null ? 100 : pct}%"></i><b>${pct == null ? '' : pct + '%'}</b>
          </div>
          <div class="scan-now mono" title="${esc(j.current || '')}">${esc(j.text || '')}${j.current ? ' ' + esc(j.current) : ''}</div>
        </div>
      </div>
      <div class="scan-stats">
        <span><b>${(j.done || 0).toLocaleString('vi-VN')}</b>${j.total ? '/' + j.total.toLocaleString('vi-VN') : ''} file đã xem</span>
        <span class="g"><b>${(j.found || 0).toLocaleString('vi-VN')}</b> nguồn chữ</span>
        <span class="y"><b>${(j.strings || 0).toLocaleString('vi-VN')}</b> câu</span>
        <button class="btn sm plain" type="button" id="scanStop">Dừng</button>
      </div>`;
  if (old) { old.innerHTML = html; } else { el.innerHTML = `<div class="box pcard scan-box" aria-live="polite">${html}</div>`; }
  $('#scanStop').addEventListener('click', () => {
    if (T.scan && T.scan.job) api(`/api/translate/games/scan/${T.scan.job}/cancel`, {method: 'POST'}).catch(() => {});
  });
}

const SRC_KIND = {renpy: "Kịch bản Ren'Py", rpg: 'RPG Maker', 'unity-loc': 'Unity Localization', file: 'File chữ', textasset: 'Unity TextAsset',
  mono: 'Unity MonoBehaviour', locres: 'Unreal .locres'};
/* Thêm cho kết quả tìm: khóa AES (Unreal) và cách "dịch khi chơi" bằng XUnity.AutoTranslator (Unity). */
function extraCards(r, none) {
  let h = '';
  if (r.unreal && (r.need_key || none)) h += `<div class="box pcard vh-extra">
      <h3>Game Unreal Engine${r.need_key ? ' – file .pak bị mã hóa' : ''}</h3>
      <p class="hint">${r.need_key ? 'Bảng chữ nằm trong file .pak đã mã hóa AES. Nhập khóa AES của game (cộng đồng mod thường chia sẻ trên diễn đàn, dạng 0x + 64 ký tự) rồi tìm lại.'
        : 'App đọc bảng chữ .locres trong file .pak (UE4/UE5). Pak mã hóa thì cần khóa AES; pak nén Oodle hiện chưa mở được.'}</p>
      <div class="paste-row"><input type="text" id="ueKey" class="mono" placeholder="0x0123…ABCD (khóa AES 64 ký tự hex)" aria-label="Khóa AES" value="${esc(T.scan && T.scan.aes || '')}">
        <button class="btn yellow" type="button" id="ueRescan">TÌM LẠI VỚI KHÓA</button></div>
    </div>`;
  if (r.unity) h += `<div class="box pcard vh-extra">
      <h3>${none ? 'Không thấy chữ trong file? ' : 'Còn câu chưa dịch khi chơi? '}Dịch khi chơi bằng XUnity.AutoTranslator</h3>
      <p class="hint">Cách cộng đồng hay dùng nhất cho game Unity: app cài <b>BepInEx</b> + <b>XUnity.AutoTranslator</b> (mã nguồn mở, tải từ GitHub) vào thư mục game.
        Khi chơi, câu nào hiện trên màn hình cũng được gửi về CircleVault: dịch ngay (Google) và lưu vào dự án để bạn sửa hoặc gửi Claude chat dịch lại cho hay;
        bấm Áp dụng là game dùng bản dịch mới. Gỡ sạch được bất cứ lúc nào. Không dùng cho game online có chống gian lận.</p>
      <div class="btn-row"><button class="btn green" type="button" id="xuSetup">CÀI XUNITY &amp; TẠO DỰ ÁN “DỊCH KHI CHƠI”</button></div>
    </div>`;
  return h;
}
function bindExtra(el) {
  $('#ueRescan', el)?.addEventListener('click', () => { const k = $('#ueKey').value.trim(); if (!k) return toast('Nhập khóa AES trước.', 'err'); startScan(T.scan.path, k); });
  $('#xuSetup', el)?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Đang tải BepInEx + XUnity từ GitHub…';
    try {
      const g = await api('/api/translate/games/xunity-setup', {method: 'POST', body: {path: T.scan.path, lang: (T.scan.last && T.scan.last.result && T.scan.last.result.lang) || 'en'}});
      toast(`Đã cài XUnity.AutoTranslator (${g.installed} file). Mở game và chơi – câu mới tự hiện trong dự án.`);
      T.scan = null; T.gp = g.id; T.gq = {filter: 'all', q: '', offset: 0}; render();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'CÀI XUNITY & TẠO DỰ ÁN “DỊCH KHI CHƠI”'; }
  });
}
const LANG_VI = {en: 'Tiếng Anh', ja: 'Tiếng Nhật', zh: 'Tiếng Trung', ko: 'Tiếng Hàn', fr: 'Tiếng Pháp', de: 'Tiếng Đức', es: 'Tiếng TBN',
  pt: 'Tiếng BĐN', it: 'Tiếng Ý', ru: 'Tiếng Nga', pl: 'Tiếng Ba Lan', tr: 'Tiếng Thổ', latin: 'Chữ Latin'};
function paintFound(r) {
  const el = $('#vhScan');
  const src = r.sources || [];
  if (!src.length) {
    el.innerHTML = `<div class="box pcard"><h3>Không tìm thấy file chữ nào</h3>
      ${(r.hints || []).map(h => `<p>${esc(h)}</p>`).join('') || '<p>Game có thể lưu chữ trong file đóng gói hoặc mã hóa.</p>'}
      ${(r.warn || []).map(h => `<p class="hint">${esc(h)}</p>`).join('')}
      <div class="btn-row"><button class="btn sm yellow" type="button" data-go="vp">Có gói Việt hóa? Cài gói</button>
        <button class="btn sm plain" type="button" data-go="game">Dùng Dịch màn hình game</button></div></div>${extraCards(r, true)}`;
    el.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => goSub(b.dataset.go)));
    bindExtra(el);
    return;
  }
  const rows = src.map((s, i) => `<label class="vp-row src-row${s.on ? '' : ' off'}">
      <input type="checkbox" data-src="${esc(s.id)}" ${s.on ? 'checked' : ''}>
      <span class="src-main"><span class="mono">${esc(s.label || s.rel || '')}</span>
        <span class="src-sample">${(s.sample || []).map(t => `“${esc(t)}”`).join(' · ')}</span>
        ${s.why ? `<span class="hint">${esc(s.why)}</span>` : ''}</span>
      <span class="badge" style="background:${s.kind === 'file' ? 'var(--cyan)' : s.kind === 'textasset' || s.kind === 'mono' ? 'var(--pink)' : 'var(--violet)'}">${SRC_KIND[s.kind] || s.kind}</span>
      <span class="badge" style="background:${s.on ? 'var(--green)' : 'var(--surface-2)'};${s.on ? '' : 'color:var(--text)'}">${LANG_VI[s.lang] || esc(s.lang || '?')}</span>
      <span class="hint src-n">${s.count.toLocaleString('vi-VN')} câu</span></label>`).join('');
  el.innerHTML = `<div class="box pcard scan-done">
    <div class="row-between"><h3>Tìm thấy ${src.length} nguồn chữ trong “${esc(r.name)}”</h3>
      <span class="hint">Đã xem ${(r.files || 0).toLocaleString('vi-VN')} file</span></div>
    ${(r.hints || []).map(h => `<p class="hint">${esc(h)}</p>`).join('')}
    <p class="hint">App đã chọn sẵn file ngôn ngữ gốc. Bản dịch tiếng Việt sẽ ghi thay chỗ ngôn ngữ đó (game không có tiếng Việt), nên trong game hãy chọn ngôn ngữ này.</p>
    <div class="vp-list">${rows}</div>
    <div class="btn-row"><button class="btn green" type="button" id="scanMake">TẠO DỰ ÁN DỊCH</button>
      <button class="btn plain" type="button" id="scanAgain">Tìm lại</button><span class="hint" id="scanSum"></span></div>
    ${(r.warn || []).length ? `<details class="hint"><summary>${r.warn.length} cảnh báo khi đọc</summary>${r.warn.map(h => `<div>${esc(h)}</div>`).join('')}</details>` : ''}</div>${extraCards(r, false)}`;
  bindExtra(el);
  const sum = () => {
    const on = [...el.querySelectorAll('[data-src]')].filter(x => x.checked);
    const n = on.reduce((a, x) => a + (src.find(s => s.id === x.dataset.src) || {count: 0}).count, 0);
    $('#scanSum').textContent = `${on.length} nguồn · khoảng ${n.toLocaleString('vi-VN')} câu (câu trùng chỉ dịch một lần)`;
    el.querySelectorAll('.src-row').forEach(row => row.classList.toggle('off', !$('input', row).checked));
  };
  el.querySelectorAll('[data-src]').forEach(x => x.addEventListener('change', sum));
  sum();
  $('#scanAgain').addEventListener('click', () => startScan(T.scan.path));
  $('#scanMake').addEventListener('click', async e => {
    const pick = [...el.querySelectorAll('[data-src]')].filter(x => x.checked).map(x => x.dataset.src);
    if (!pick.length) return toast('Chọn ít nhất một nguồn chữ.', 'err');
    e.currentTarget.disabled = true;
    try {
      const g = await api('/api/translate/games', {method: 'POST', body: {path: T.scan.path, job: T.scan.job, pick}});
      toast(`Đã tạo dự án: ${g.total.toLocaleString('vi-VN')} câu cần dịch.`);
      T.scan = null; T.gp = g.id; T.gq = {filter: 'all', q: '', offset: 0};
      render();
    } catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
  });
}

function goSub(k) {
  T.sub = k; T.book = null; T.gp = null; T.novel = null;
  try { localStorage.setItem('cv-tr-sub', k); } catch (e) { /* bỏ qua */ }
  render();
}

/* ---------------------------------------------------------------- trang Gói Việt hóa có sẵn */
function renderPatches() {
  const el = $('#trSub');
  el.innerHTML = `
    <div class="box pcard" id="vpBox">
      <p>Có bản Việt hóa của nhóm dịch (file .zip kiểu "chép đè vào thư mục game")? App tự tìm đúng chỗ đặt file, sao lưu file gốc, gỡ được bất cứ lúc nào, và báo khi Steam cập nhật game làm mất Việt hóa.</p>
      <label class="field" id="vhSteamRow" hidden>Game Steam trên máy này<select id="vhSteam"><option value="">— Chọn game —</option></select></label>
      <div class="paste-row">
        <input type="text" id="vpGame" placeholder="Thư mục game (chứa file .exe)" aria-label="Thư mục game">
        ${desk && desk.pickFolder ? '<button class="btn plain" type="button" id="vpPickGame">Chọn thư mục…</button>' : ''}
      </div>
      <div class="paste-row">
        <input type="text" id="vpSrc" placeholder="File .zip Việt hóa, hoặc thư mục đã giải nén" aria-label="Gói Việt hóa">
        ${desk && desk.pickFile ? '<button class="btn plain" type="button" id="vpPickZip">Chọn file .zip…</button>' : ''}
        ${desk && desk.pickFolder ? '<button class="btn plain" type="button" id="vpPickDir">Thư mục…</button>' : ''}
        <button class="btn yellow" type="button" id="vpPreview">XEM TRƯỚC</button>
      </div>
      <p class="hint" id="vpMsg">File .rar / .7z: giải nén ra một thư mục rồi chọn thư mục đó.</p>
      <div id="vpPlan"></div>
    </div>
    <div class="sec-title">Gói đã cài</div>
    <div id="vpList" class="main"><div class="box empty"><p>Chưa cài gói nào.</p></div></div>`;
  steamSelect(['#vpGame']);
  $('#vpPickGame')?.addEventListener('click', async () => { const f = await desk.pickFolder('Chọn thư mục game'); if (f) $('#vpGame').value = f; });
  bindPatch();
  T.poll = setInterval(() => { if (!document.hidden && $('#vpList')) loadPatches(); else if (!$('#vpList')) clearInterval(T.poll); }, 4000);
}

/* ---------------------------------------------------------------- gói Việt hóa có sẵn */
function bindPatch() {
  const msg = (t, err) => { $('#vpMsg').innerHTML = err ? `<span class="tr-err">${esc(t)}</span>` : esc(t); };
  $('#vpPickZip')?.addEventListener('click', async () => { const f = await desk.pickFile('Chọn file Việt hóa (.zip)', ['zip']); if (f) $('#vpSrc').value = f; });
  $('#vpPickDir')?.addEventListener('click', async () => { const f = await desk.pickFolder('Chọn thư mục Việt hóa đã giải nén'); if (f) $('#vpSrc').value = f; });
  $('#vpPreview').addEventListener('click', async e => {
    const body = {source: $('#vpSrc').value.trim(), game: $('#vpGame').value.trim()};
    if (!body.game) return msg('Chọn thư mục game trước (ô ở trên, hoặc chọn game Steam).', true);
    if (!body.source) return msg('Chọn file .zip Việt hóa.', true);
    const b = e.currentTarget; b.disabled = true; msg('Đang đọc gói…');
    try {
      const pl = await api('/api/translate/vh/preview', {method: 'POST', body});
      $('#vpGame').value = pl.game;
      msg(`${pl.write} file sẽ được chép vào game (${pl.overwrite} file đè lên file gốc, app sao lưu trước). Bỏ chọn file nào không muốn cài.`);
      const rows = pl.files.map((f, i) => `<label class="vp-row${f.on ? '' : ' off'}"><input type="checkbox" data-vp="${i}" ${f.on ? 'checked' : ''}>
        <span class="mono">${esc(f.dst)}</span><span class="badge" style="background:${f.exists ? 'var(--yellow)' : 'var(--cyan)'}">${f.exists ? 'Đè file gốc' : 'Thêm mới'}</span>
        <span class="hint">${fmtSize(f.size)}${f.why ? ' · ' + esc(f.why) : ''}</span></label>`).join('');
      $('#vpPlan').innerHTML = `<div class="vp-list">${rows}</div>
        <div class="btn-row"><button class="btn green" type="button" id="vpInstall">CÀI VÀO GAME</button><span class="hint">Tắt game trước khi cài.</span></div>`;
      $('#vpInstall').addEventListener('click', async ev => {
        const files = [...document.querySelectorAll('[data-vp]')].filter(x => x.checked).map(x => pl.files[+x.dataset.vp].dst);
        if (!files.length) return msg('Chưa chọn file nào.', true);
        ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Đang chép…';
        try {
          await api('/api/translate/vh/install', {method: 'POST', body: {...body, game: pl.game, files}});
          toast('Đã cài gói Việt hóa. Mở game để chơi.'); $('#vpPlan').innerHTML = ''; msg('Đã cài xong.'); loadPatches();
        } catch (err) { msg(err.message, true); ev.currentTarget.disabled = false; ev.currentTarget.textContent = 'CÀI VÀO GAME'; }
      });
    } catch (err) { msg(err.message, true); $('#vpPlan').innerHTML = ''; }
    finally { b.disabled = false; }
  });
  loadPatches();
}
function fmtSize(n) { return n > 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' GB' : n > 2 ** 20 ? (n / 2 ** 20).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
async function loadPatches() {
  const el = $('#vpList');
  if (!el) return;
  let d; try { d = await api('/api/translate/vh'); } catch (e) { return; }
  const key = JSON.stringify(d.patches);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (!d.patches.length) { el.innerHTML = '<div class="box empty"><p>Chưa cài gói nào.</p></div>'; return; }
  el.innerHTML = d.patches.map(p => {
    const st = {ok: ['var(--green)', 'Đang dùng'], overwritten: ['var(--red)', 'Steam đã ghi đè – cần cài lại'], nogame: ['var(--surface-2)', 'Không thấy thư mục game']}[p.state];
    return `<div class="box tr-book" data-pid="${p.id}">
      <div class="tr-book-main">
        <span><b class="tr-name">${esc(p.game_name)}</b> <span class="badge" style="background:var(--violet)">Gói Việt hóa</span>
          <span class="badge" style="background:${st[0]};${p.state === 'nogame' ? 'color:var(--text)' : ''}">${st[1]}</span></span>
        <span class="hint">${esc(p.name)} · ${p.files} file${p.state === 'overwritten' ? ` · ${p.changed + p.missing} file bị thay` : ''}</span>
        <span class="hint mono tr-path">${esc(p.game)}</span>
      </div>
      <div class="btn-row">
        ${p.state === 'overwritten' ? `<button class="btn sm green" type="button" data-pa="re" ${p.source_ok ? '' : 'disabled title="Không còn file gói ở chỗ cũ"'}>Cài lại</button>` : ''}
        <button class="btn sm plain" type="button" data-pa="un">Gỡ Việt hóa</button>
      </div></div>`;
  }).join('');
  el.querySelectorAll('[data-pid]').forEach(row => row.addEventListener('click', async e => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    const id = row.dataset.pid;
    if (b.dataset.pa === 'un' && b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa để gỡ (trả file gốc)'; return; }
    b.disabled = true;
    try {
      if (b.dataset.pa === 're') { await api(`/api/translate/vh/${id}/reinstall`, {method: 'POST'}); toast('Đã cài lại Việt hóa.'); }
      else { const r = await api(`/api/translate/vh/${id}/uninstall`, {method: 'POST'}); toast(`Đã gỡ Việt hóa, trả lại ${r.files} file gốc.`); }
    } catch (err) { toast(err.message, 'err'); }
    el.dataset.key = ''; loadPatches();
  }));
}

async function loadGames() {
  const el = $('#vhList');
  if (!el) return;
  let d;
  try { d = await api('/api/translate/games'); } catch (e) { el.innerHTML = `<div class="notice box err">${esc(e.message)}</div>`; return; }
  if (!d.games.length) { el.innerHTML = '<div class="box empty"><h3>Chưa có game nào</h3><p>Nhập thư mục game ở khung trên rồi bấm Tìm file chữ.</p></div>'; return; }
  el.innerHTML = d.games.map(g => gameRow(g)).join('');
  el.querySelectorAll('[data-gid]').forEach(row => row.addEventListener('click', e => gameAct(e, row.dataset.gid)));
}

function gameRow(g) {
  const pct = g.total ? Math.round(g.done / g.total * 100) : 0;
  const working = g.running || g.status === 'queued';
  const st = working ? `Đang dịch ${g.done.toLocaleString('vi-VN')}/${g.total.toLocaleString('vi-VN')} câu` : `Đã dịch ${g.done.toLocaleString('vi-VN')}/${g.total.toLocaleString('vi-VN')} câu`;
  return `<div class="box tr-book" data-gid="${g.id}">
    <div class="tr-book-main">
      <span><b class="tr-name">${esc(g.name)}</b> <span class="badge" style="background:var(--violet)">${esc(g.engine_name)}</span>
        ${g.applied ? '<span class="badge" style="background:var(--green)">Đã áp dụng</span>' : ''}</span>
      <div class="prog"><div class="bar"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:${g.status === 'error' ? 'var(--red)' : 'var(--green)'}"></i></div>
        <span class="hint">${st}${g.bad ? ` · ${g.bad} câu cần xem lại` : ''}</span></div>
      ${g.error ? `<span class="tr-err">${esc(g.error)}</span>` : ''}
      <span class="hint mono tr-path">${esc(g.path)}</span>
    </div>
    <div class="btn-row">
      <button class="btn sm yellow" type="button" data-a="open">Mở</button>
      ${working ? '<button class="btn sm plain" type="button" data-a="stop">Dừng</button>' : g.done < g.total ? '<button class="btn sm green" type="button" data-a="run">Dịch</button>' : ''}
      <button class="btn sm cyan" type="button" data-a="apply" ${g.done && !working ? '' : 'disabled'}>Áp dụng vào game</button>
      ${g.applied ? '<button class="btn sm plain" type="button" data-a="restore">Khôi phục bản gốc</button>' : ''}
      <button class="btn sm plain" type="button" data-a="del" aria-label="Xóa dự án ${esc(g.name)}">Xóa</button>
    </div></div>`;
}

// Game trong Program Files (Steam…): máy chủ trả 423 → hỏi người dùng → cấp quyền ghi (Windows hiện hộp UAC) → làm lại.
async function withGrant(pid, fn) {
  try { return await fn(); }
  catch (err) {
    if (err.status !== 423) throw err;
    if (!confirm(err.message + '\n\nCho phép ngay? Windows sẽ hỏi quyền quản trị – bấm Có (Yes).')) throw new Error('Chưa ghi vào game: thư mục game cần quyền quản trị.');
    toast('Đang chờ bạn bấm Có trên hộp hỏi quyền của Windows…');
    await api(`/api/translate/games/${pid}/grant`, {method: 'POST'});
    toast('Đã cho phép ghi vào thư mục game.');
    return await fn();
  }
}

async function gameAct(e, id) {
  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const a = btn.dataset.a;
  try {
    if (a === 'open') { T.gp = id; T.gq = {filter: 'all', q: '', offset: 0}; return render(); }
    if (a === 'run') {
      const s = T.settings;
      const g = await api(`/api/translate/games/${id}?limit=1`);
      if (s.engine === 'claude' && g.total - g.done > 2000) {
        const cost = (g.estimate_left || g.estimate)[s.claude_model];
        if (!confirm(`Game có ${(g.total - g.done).toLocaleString('vi-VN')} câu chưa dịch. Ước tính chi phí với ${engineName(s)}: ${usd(cost)}. Bắt đầu dịch?`)) return;
      }
      await api(`/api/translate/games/${id}/run`, {method: 'POST'});
    }
    if (a === 'stop') await api(`/api/translate/games/${id}/stop`, {method: 'POST'});
    if (a === 'apply') {
      if (T.applying && T.applying[id]) return;              // đang ghi: không chạy lần nữa
      if (!confirm('Tắt game trước khi áp dụng. Áp dụng bản dịch vào game ngay?')) return;
      const fs = FN.st && FN.pid === id ? FN.st : null;
      const stuck = fs && fs.scan && (fs.scan.fonts || []).some(f => !f.ok && !f.can_replace);
      if (stuck && fs.vi_mode === 'full' && confirm('Font của game không có đủ chữ Việt có dấu – để “Đầy đủ dấu” thì game sẽ hiện chữ lỗi kiểu “Qufc vffng”.\n\n'
          + 'OK = đổi sang “Giữ dấu font có” (khuyên dùng) rồi áp dụng.\nHủy = vẫn áp dụng “Đầy đủ dấu”.')) {
        try { await api(`/api/translate/games/${id}`, {method: 'PATCH', body: {vi_mode: 'safe'}}); fs.vi_mode = 'safe'; fs.vi_auto = false; } catch (err) { /* vẫn áp dụng */ }
      }
      btn.disabled = true; btn.textContent = 'Đang ghi…';
      await withGrant(id, () => api(`/api/translate/games/${id}/apply`, {method: 'POST'}));
      return watchApply(id);
    }
    if (a === 'restore') {
      if (!confirm('Đưa game về bản tiếng Anh gốc?')) return;
      await withGrant(id, () => api(`/api/translate/games/${id}/restore`, {method: 'POST'}));
      toast('Đã khôi phục bản gốc.');
    }
    if (a === 'del') {
      if (!confirm('Xóa dự án dịch này khỏi app? (Game và bản đã áp dụng vẫn giữ nguyên; muốn bỏ Việt hóa thì bấm Khôi phục bản gốc trước.)')) return;
      await api(`/api/translate/games/${id}`, {method: 'DELETE'});
      if (T.gp === id) T.gp = null;
    }
  } catch (err) { toast(err.message, 'err'); }
  if (T.gp) refreshProject(); else loadGames();
}

/* áp dụng chạy nền: hỏi tiến độ tới khi xong, vẽ thanh tiến độ ở đầu dự án */
async function watchApply(id) {
  T.applying = T.applying || {};
  T.applying[id] = {state: 'running', text: 'Đang chuẩn bị…'};
  if (T.gstate && T.gp === id) paintHead(T.gstate);
  for (;;) {
    await new Promise(r => setTimeout(r, 700));
    let j;
    try { j = (await api(`/api/translate/games/${id}/apply`)).job; } catch (e) { continue; }
    if (!j) break;
    T.applying[id] = j;
    if (T.gstate && T.gp === id) paintHead(T.gstate);
    if (j.state === 'running') continue;
    delete T.applying[id];
    if (j.state === 'error') { toast(j.error || 'Áp dụng lỗi.', 'err'); break; }
    const r = j.result || {};
    if (r.errors && r.errors.length) toast(r.errors.slice(0, 2).join(' · '), 'err');
    toast(r.mode === 'en' ? 'Đã trả game về tiếng Anh (bản dịch vẫn giữ trong app).'
      : r.engine === 'renpy' ? `Đã Việt hóa: ${r.say} câu thoại, ${r.ui} chữ giao diện. Mở game để chơi.`
      : `Đã Việt hóa ${r.texts || 0} câu trong ${r.files || 0} file${r.fonts ? `, đổi ${r.fonts} font` : ''}. Mở game để chơi.`);
    if (r.engine === 'unity' && !r.texts && r.mode !== 'en') toast('Không câu nào được thay – dịch xong trước rồi Áp dụng.', 'err');
    break;
  }
  if (T.gp === id) { refreshProject(); loadFonts(false); }
}

/* ---------------------------------------------------------------- Việt hóa game: dịch bằng Claude chat (không cần API key) */
const PACK_SIZES = [['small', 'Nhỏ', 'dán thẳng vào ô chat'], ['medium', 'Vừa', 'khuyên dùng'], ['large', 'Lớn', 'gửi dạng file, ít lượt hơn']];
let packCopied = {};
try { packCopied = JSON.parse(localStorage.getItem('cv-vh-copied') || '{}'); } catch (e) { packCopied = {}; }
async function paintClaude(state) {
  const el = $('#vhClaude');
  if (!el) return;
  let st = state;
  if (!st) { try { st = await api(`/api/translate/games/${T.gp}/claude`); } catch (e) { return; } }
  const pk = st.pack, g = T.gstate || {};
  const todo = g.total ? g.total - g.done + (g.bad || 0) : 0;
  const size = (pk && pk.size) || 'medium';
  const copied = packCopied[T.gp] || {};
  const allDone = pk && pk.parts.length && pk.parts.every(x => x.done >= x.count);
  el.innerHTML = `
    <div class="row-between"><h3>Dịch bằng Claude chat <span class="badge" style="background:var(--green)">Không cần API key</span></h3>
      <a class="btn sm plain" href="https://claude.ai/new" target="_blank" rel="noopener">Mở Claude ↗</a></div>
    <p class="hint">App gom chữ của game thành từng phần kèm bối cảnh và thuật ngữ ở trên. Bạn gửi từng phần cho Claude (claude.ai hoặc app Claude),
      dán câu trả lời vào đây – app tự đưa bản dịch vào đúng câu, đúng file. Xong thì bấm <b>Áp dụng vào game</b>.</p>
    <ol class="vh-cl">
      <li><b>Tạo gói</b>
        <div class="btn-row vh-packrow">
          <span class="hint">Cỡ mỗi phần:</span><div class="tr-seg" role="group" aria-label="Cỡ mỗi phần">${PACK_SIZES.map(([k, n, h]) => `<button type="button" class="chip${size === k ? ' on' : ''}" data-ps="${k}" title="${h}">${n}</button>`).join('')}</div>
          <button class="btn sm yellow" type="button" id="vhPack">${pk ? 'Tạo lại gói (câu chưa dịch)' : 'TẠO GÓI CHO CLAUDE'}</button>
          ${pk && window.cvDesktop ? '<button class="btn sm plain" type="button" id="vhPackDir">Mở thư mục gói</button>' : ''}
        </div>
        <span class="hint">${pk ? `${pk.parts.length} phần · ${pk.count.toLocaleString('vi-VN')} câu · thư mục <code>${esc(pk.dir)}</code>` : `${todo.toLocaleString('vi-VN')} câu chưa dịch. Cỡ “Vừa” ≈ 30.000 ký tự mỗi phần.`}</span></li>
      <li><b>Gửi từng phần cho Claude</b><span class="hint">Bấm <b>Chép</b> rồi dán vào ô chat của Claude (hoặc kéo file <code>phan-xx.txt</code> vào) và gửi, không cần gõ thêm gì. Sau 3–4 phần nên mở cuộc trò chuyện mới.</span>
        ${pk ? `<div class="vh-parts">${pk.parts.map(x => {
          const pct = x.count ? Math.round(x.done / x.count * 100) : 0;
          const ok = x.done >= x.count;
          return `<div class="vh-part${ok ? ' ok' : ''}" data-no="${x.no}">
            <b>Phần ${x.no}</b><small>${x.count} câu · ${(x.chars / 1000).toFixed(1)}k ký tự</small>
            <div class="bar" aria-hidden="true"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:var(--green)"></i></div>
            <small>${ok ? '✓ Đã nhập đủ' : x.done ? `Đã nhập ${x.done}/${x.count}` : copied[x.no] ? 'Đã chép – chờ câu trả lời' : 'Chưa gửi'}${x.bad ? ` · ${x.bad} mất mã` : ''}</small>
            <span class="btn-row"><button class="btn sm ${ok ? 'plain' : 'cyan'}" type="button" data-pc="${x.no}">📋 Chép</button>
              <a class="btn sm plain" href="/api/translate/games/${T.gp}/claude/parts/${x.no}?dl=1" download="phan-${String(x.no).padStart(2, '0')}.txt" aria-label="Tải file phần ${x.no}">⬇</a></span></div>`;
        }).join('')}</div>` : '<p class="hint">Tạo gói ở bước 1 trước.</p>'}</li>
      <li><b>Dán câu trả lời của Claude</b><span class="hint">Bấm Copy ở khối JSON Claude trả về rồi dán vào đây – dán là tự nhập. Nhiều phần, nhiều lần đều được.</span>
        <div class="vh-drop" id="vhDrop">
          <textarea id="vhImport" rows="4" placeholder='Dán câu trả lời của Claude, dạng {"12": "Bắt đầu", "13": "Tùy chọn"} – hoặc kéo file .json/.txt Claude tạo vào đây'></textarea>
          <div class="btn-row"><button class="btn sm green" type="button" id="vhImportGo">NHẬP BẢN DỊCH</button>
            <label class="btn sm plain">Chọn file trả lời…<input type="file" id="vhImportFile" accept=".json,.txt,.md" multiple hidden></label>
            ${pk ? '<button class="btn sm plain" type="button" id="vhImportDir" title="Đọc mọi file trong thư mục tra-loi của gói">Nhập từ thư mục tra-loi</button>' : ''}</div>
        </div></li>
    </ol>
    ${allDone ? '<div class="notice box ok"><b>Đã đủ bản dịch cho mọi phần.</b><span>Bấm “Áp dụng vào game” ở trên để ghi vào game.</span></div>' : ''}`;
  el.querySelectorAll('[data-ps]').forEach(b => b.addEventListener('click', () => { el.querySelectorAll('[data-ps]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#vhPack').addEventListener('click', async e => {
    const b = e.currentTarget, sz = (el.querySelector('[data-ps].on') || {}).dataset?.ps || 'medium';
    b.disabled = true; b.textContent = 'Đang tạo…';
    try { const r = await api(`/api/translate/games/${T.gp}/claude/pack`, {method: 'POST', body: {size: sz, only: 'todo'}}); packCopied[T.gp] = {}; saveCopied(); toast(`Đã chia thành ${r.pack.parts.length} phần.`); paintClaude(r); }
    catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'TẠO GÓI CHO CLAUDE'; }
  });
  $('#vhPackDir')?.addEventListener('click', () => api(`/api/translate/games/${T.gp}/claude/open`, {method: 'POST'}).catch(err => toast(err.message, 'err')));
  el.querySelectorAll('[data-pc]').forEach(b => b.addEventListener('click', async () => {
    const no = +b.dataset.pc;
    try {
      const r = await fetch(`/api/translate/games/${T.gp}/claude/parts/${no}`);
      if (!r.ok) throw new Error('Không lấy được phần này.');
      const text = await r.text();
      await copyText(text);
      (packCopied[T.gp] = packCopied[T.gp] || {})[no] = Date.now(); saveCopied();
      toast(`Đã chép phần ${no} (${text.length.toLocaleString('vi-VN')} ký tự). Dán vào ô chat của Claude rồi gửi.`);
      b.textContent = '✓ Đã chép';
      const s = b.closest('.vh-part').querySelectorAll('small')[1];
      if (s && !s.textContent.startsWith('✓') && !s.textContent.startsWith('Đã nhập')) s.textContent = 'Đã chép – chờ câu trả lời';
    } catch (err) { toast(err.message, 'err'); }
  }));
  const doImport = async (text, label) => {
    if (!text.trim()) return;
    try {
      const r = await api(`/api/translate/games/${T.gp}/import`, {method: 'POST', body: {text}});
      toast(`${label || 'Đã nhập'} ${r.imported} câu${r.bad ? `, ${r.bad} câu mất mã (lọc “Cần xem lại” để sửa)` : ''}${r.unknown ? `, bỏ ${r.unknown} số không có trong game` : ''}.`);
      $('#vhImport').value = '';
      paintClaude(r); refreshProject(); loadRows();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#vhImportGo').addEventListener('click', () => doImport($('#vhImport').value));
  $('#vhImport').addEventListener('paste', () => setTimeout(() => { const v = $('#vhImport').value; if (/"\d+"\s*:/.test(v) && v.length > 20) doImport(v, 'Đã tự nhập'); }, 50));
  const readFiles = async files => { const texts = await Promise.all([...files].map(f => f.text())); doImport(texts.join('\n'), `Đã nhập ${files.length} file:`); };
  $('#vhImportFile').addEventListener('change', e => { if (e.target.files.length) readFiles(e.target.files); e.target.value = ''; });
  const drop = $('#vhDrop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files); });
  $('#vhImportDir')?.addEventListener('click', async () => {
    try { const r = await api(`/api/translate/games/${T.gp}/claude/import-folder`, {method: 'POST'}); toast(`Đọc ${r.files} file: nhập ${r.imported} câu${r.bad ? `, ${r.bad} mất mã` : ''}.`); paintClaude(r); refreshProject(); loadRows(); }
    catch (err) { toast(err.message, 'err'); }
  });
}
function saveCopied() { try { localStorage.setItem('cv-vh-copied', JSON.stringify(packCopied)); } catch (e) { /* bỏ qua */ } }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch (e) { /* thử cách cũ */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  if (!ok) throw new Error('Không chép được vào bộ nhớ tạm. Bấm ⬇ để tải file rồi kéo vào Claude.');
}

async function renderProject() {
  FN.st = null; FN.pick = null;
  const el = $('#trSub');
  el.innerHTML = '<div class="loading"><span class="spin"></span>Đang mở…</div>';
  let g;
  try { g = await api(`/api/translate/games/${T.gp}?limit=1`); } catch (e) { T.gp = null; toast(e.message, 'err'); return render(); }
  const unity = g.engine === 'unity', files = g.engine === 'files', xu = g.engine === 'xunity', ue = g.engine === 'unreal';
  const rpg = !['renpy', 'unity', 'files', 'xunity', 'unreal'].includes(g.engine);
  el.innerHTML = `
    <div class="box tr-bar">
      <button class="btn sm plain" type="button" id="vhBack">← Danh sách game</button>
      <b class="tr-name">${esc(g.name)}</b>
      <span class="badge" style="background:var(--violet)">${esc(g.engine_name)}</span>
      <span class="hint" id="vhStat"></span>
    </div>
    <div id="vhHead"></div>
    <div class="box pcard vh-brief">
      <div class="row-between"><h3>Bối cảnh game cho Claude</h3>
        <div class="btn-row"><button class="btn sm yellow" type="button" id="vhAuto">Để Claude tìm hiểu game</button></div></div>
      <p class="hint">Claude dịch theo đúng thứ tự trong game và đọc kèm bối cảnh này mỗi lượt: thể loại, giọng văn, nhân vật, cách xưng hô. Bấm nút vàng để Claude đọc mẫu chữ của game rồi tự viết (vài cent), sau đó sửa lại nếu cần.</p>
      <div class="cols2">
        <label class="field">Bối cảnh
          <textarea id="vhBrief" rows="7" placeholder="Ví dụ:&#10;- Game quản lý nhà hàng vũ trụ, giọng hài hước.&#10;- Mira (nữ, phục vụ) gọi người chơi là &quot;sếp&quot;, xưng &quot;em&quot;.&#10;- Chữ giao diện dịch ngắn gọn.">${esc(g.brief || '')}</textarea></label>
        <label class="field">Thuật ngữ riêng của game
          <textarea id="vhGloss" rows="7" placeholder="Mỗi dòng: chữ gốc = chữ dịch&#10;Space Credits = Tín dụng vũ trụ&#10;Mira = Mira">${esc(g.glossary || '')}</textarea></label>
      </div>
    </div>
    <div class="box pcard vh-claude" id="vhClaude"></div>
    ${xu ? `<div class="box pcard vh-xu"><div class="row-between"><h3>Dịch khi chơi (XUnity.AutoTranslator)</h3>
        <span class="badge" style="background:${g.xunity && g.xunity.installed ? 'var(--green)' : 'var(--red)'}">${g.xunity && g.xunity.installed ? 'Đã cài vào game' : 'Chưa cài'}</span></div>
      <ol class="steps"><li>Giữ CircleVault đang mở, rồi mở game và chơi bình thường (lần đầu BepInEx mất vài giây để khởi động).</li>
        <li>Câu nào hiện trên màn hình sẽ được dịch ngay bằng Google và hiện ở danh sách bên dưới${g.seen_at ? ` (câu mới nhất lúc ${new Date(g.seen_at * 1000).toLocaleTimeString('vi')})` : ''}.</li>
        <li>Muốn dịch hay hơn: dùng <b>Dịch bằng Claude chat</b> ở dưới hoặc sửa tay, rồi bấm <b>Áp dụng vào game</b> – game dùng bản mới ngay lần mở sau.</li></ol>
      <p class="hint">${g.xunity && g.xunity.il2cpp ? 'Game IL2CPP (BepInEx 6).' : 'Game Mono (BepInEx 5).'} Phím trong game: Alt+0 mở bảng của XUnity, Alt+T bật/tắt bản dịch.</p>
      <div class="btn-row"><button class="btn sm green" type="button" id="xuInstall">${g.xunity && g.xunity.installed ? 'Cài lại / cập nhật' : 'Cài vào game'}</button>
        <button class="btn sm plain" type="button" id="xuRemove">Gỡ BepInEx + XUnity khỏi game</button></div></div>` : ''}
    ${ue ? `<div class="box pcard"><h3>Khi áp dụng</h3><p class="hint">App tạo file mod <code>Content/Paks/~mods/zz_CircleVault_VI_P.pak</code> chứa bảng chữ đã dịch (không sửa file .pak gốc). Trong game chọn ngôn ngữ gốc (thường là English). Chữ hiện ô vuông là phông của game thiếu dấu tiếng Việt. Game kiểm tra chữ ký pak (có file .sig) có thể không nhận mod. Khôi phục bản gốc = xóa file mod.</p></div>` : ''}
    ${unity ? `<div class="box pcard"><h3>Khi áp dụng</h3><p class="hint">Tiếng Việt được ghi thay chỗ tiếng Anh trong bảng chữ của game (chọn English trong cài đặt ngôn ngữ của game). Chữ hiện ô vuông nghĩa là phông của game thiếu dấu tiếng Việt. Steam cập nhật game thì bấm Áp dụng lại.</p></div>` : ''}
    ${files ? `<div class="box pcard"><h3>Khi áp dụng</h3><p class="hint">Tiếng Việt được ghi thay chỗ chữ gốc trong ${g.sources.length} file (${esc(g.sources.slice(0, 3).map(x => x.label).join(', '))}${g.sources.length > 3 ? '…' : ''}), bản gốc sao lưu trong <code>CircleVault-ban-goc</code>. Trong game chọn ngôn ngữ gốc (thường là English). Chữ hiện ô vuông là do phông của game thiếu dấu tiếng Việt.</p></div>` : ''}
    <div class="box pcard" ${unity || files || xu || ue ? 'hidden' : ''}>
      <div class="row-between"><h3>Tùy chọn khi áp dụng</h3></div>
      <label class="check"><input type="checkbox" id="vhFont" ${g.opts.font !== false ? 'checked' : ''}> Đổi phông chữ của game sang phông có dấu tiếng Việt</label>
      <p class="hint">${rpg ? 'Phông gốc của RPG Maker thường không có dấu tiếng Việt (hiện ô vuông). App chép phông Arial của Windows vào game.' : 'Nhiều game Ren\'Py dùng phông riêng không có dấu tiếng Việt. App đổi sang phông DejaVuSans có sẵn trong Ren\'Py.'}</p>
      ${rpg ? `<div class="vh-widths">
        <label class="field">Số ký tự mỗi dòng<input type="number" id="vhW" min="20" max="120" value="${g.opts.width || 50}"></label>
        <label class="field">Khi có ảnh mặt nhân vật<input type="number" id="vhWF" min="20" max="120" value="${g.opts.width_face || 40}"></label>
        <small class="hint">Chữ tràn khung thoại thì giảm số này rồi Áp dụng lại. Câu dài hơn 4 dòng tự tách sang khung thoại mới.</small></div>` : ''}
    </div>
    <div class="box pcard vh-font" id="vhFontBox"></div>
    <div class="box pcard vh-review" id="vhReview"></div>
    <div class="box pcard vh-find" id="vhFind"></div>
    <div class="box pcard">
      <div class="vh-tools">
        <div class="tr-seg" role="group" aria-label="Lọc">${[['all', 'Tất cả'], ['todo', 'Chưa dịch'], ['bad', 'Cần xem lại'], ['edited', 'Đã sửa tay'], ['skip', 'Không dịch']]
          .map(([k, n]) => `<button type="button" class="chip${T.gq.filter === k ? ' on' : ''}" data-f="${k}">${n}</button>`).join('')}</div>
        <input type="search" id="vhQ" placeholder="Tìm câu…" value="${esc(T.gq.q)}" aria-label="Tìm câu">
      </div>
      <p class="hint">Sửa trực tiếp ở cột Tiếng Việt, rời ô là tự lưu. Giữ nguyên các mã như <code>[name]</code>, <code>{b}</code>, <code>\\C[2]</code>, <code>%1</code>. "Cần xem lại" là câu máy dịch làm mất mã: app tạm giữ câu gốc cho đến khi bạn sửa. Nút <b>⊘</b> = không dịch câu đó (mã, tên file… lẫn vào); câu "Không dịch" giữ nguyên chữ gốc khi áp dụng.</p>
      <div id="vhRows"></div>
      <div class="row-between" id="vhPager"></div>
    </div>`;
  $('#vhBack').addEventListener('click', () => { T.gp = null; render(); });
  ['vhBrief', 'vhGloss'].forEach(id => $('#' + id).addEventListener('change', e => api(`/api/translate/games/${T.gp}`, {method: 'PATCH',
    body: id === 'vhBrief' ? {brief: e.target.value} : {glossary: e.target.value}}).then(() => toast('Đã lưu. Câu dịch sau sẽ theo bối cảnh mới.')).catch(err => toast(err.message, 'err'))));
  $('#vhAuto').addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Claude đang đọc game…';
    try {
      const r = await api(`/api/translate/games/${T.gp}/brief`, {method: 'POST'});
      $('#vhBrief').value = r.brief; $('#vhGloss').value = r.glossary;
      toast('Claude đã viết bối cảnh game. Xem lại rồi bấm Dịch.');
    } catch (err) { toast(err.message, 'err'); }
    finally { b.disabled = false; b.textContent = 'Để Claude tìm hiểu game'; }
  });
  $('#xuInstall')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Đang tải từ GitHub…';
    try { const r = await api('/api/translate/games/xunity-setup', {method: 'POST', body: {path: g.path, lang: g.lang}}); toast(`Đã cài (${r.installed} file mới).`); renderProject(); }
    catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'Cài vào game'; }
  });
  $('#xuRemove')?.addEventListener('click', async e => {
    const b = e.currentTarget;
    if (b.dataset.ok !== '1') { b.dataset.ok = '1'; b.textContent = 'Bấm lần nữa để gỡ (tắt game trước)'; return; }
    try { const r = await api(`/api/translate/games/${T.gp}/xunity/uninstall`, {method: 'POST'}); toast(`Đã gỡ ${r.files} file khỏi game.`); renderProject(); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#vhFont').addEventListener('change', e => api(`/api/translate/games/${T.gp}`, {method: 'PATCH', body: {font: e.target.checked}}).catch(err => toast(err.message, 'err')));
  if (rpg) ['vhW', 'vhWF'].forEach(id => $('#' + id).addEventListener('change', e => api(`/api/translate/games/${T.gp}`, {method: 'PATCH',
    body: id === 'vhW' ? {width: +e.target.value} : {width_face: +e.target.value}}).catch(err => toast(err.message, 'err'))));
  el.querySelectorAll('[data-f]').forEach(c => c.addEventListener('click', () => { T.gq.filter = c.dataset.f; T.gq.offset = 0;
    el.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === c)); loadRows(); }));
  let qt = 0;
  $('#vhQ').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { T.gq.q = e.target.value; T.gq.offset = 0; loadRows(); }, 300); });
  paintHead(g);
  paintClaude();
  loadFonts(true);
  paintFind();
  api(`/api/translate/games/${g.id}/apply`).then(r => { if (r.job && r.job.state === 'running' && !(T.applying && T.applying[g.id])) watchApply(g.id); }).catch(() => {});
  await loadRows();
  T.poll = setInterval(() => { if ($('#vhRows') && T.gp) refreshProject(); else clearInterval(T.poll); }, 3000);
}

function paintHead(g) {
  const working = g.running || g.status === 'queued';
  $('#vhStat').textContent = `${g.done.toLocaleString('vi-VN')}/${g.total.toLocaleString('vi-VN')} câu đã dịch` + (working ? ' · đang dịch…' : '');
  const s = T.settings;
  $('#vhHead').innerHTML = `${g.error ? `<div class="notice box err"><b>Dịch bị dừng</b><span>${esc(g.error)}${/Google/.test(g.error) ? ' Hoặc dùng <b>Dịch bằng Claude chat</b> bên dưới (không cần API key).' : ''}</span></div>` : ''}
    ${g.note ? `<div class="notice box"><b>Đang chờ</b><span>${esc(g.note)}</span></div>` : ''}
    <div class="box tr-book" data-gid="${g.id}">
      <div class="tr-book-main">
        <span class="hint">${g.total.toLocaleString('vi-VN')} câu · ${g.chars.toLocaleString('vi-VN')} ký tự. Ước tính nếu dịch bằng Claude: Opus 5.5 ${usd(g.estimate['claude-opus-5-5'])}, Sonnet 5.5 ${usd(g.estimate['claude-sonnet-5-5'])}, Haiku 5.5 ${usd(g.estimate['claude-haiku-5-5'])}. Bộ dịch đang chọn: <b>${esc(engineName(s))}</b>.</span>
        ${g.spent && g.spent.usd ? `<span class="hint">Đã tốn thực tế cho game này: <b>${usd(g.spent.usd)}</b> (${g.spent.calls} lượt gọi Claude, ${Math.round((g.spent.in || 0) / 1000).toLocaleString('vi-VN')}K token gửi, ${Math.round((g.spent.out || 0) / 1000).toLocaleString('vi-VN')}K token nhận – tính cả bối cảnh, lọc câu, phần Claude suy nghĩ). Số dư chính xác xem ở Claude Console.</span>` : ''}
        ${g.warnings && g.warnings.length ? `<span class="hint">Bỏ qua ${g.warnings.length} file không đọc được: ${esc(g.warnings.slice(0, 2).join('; '))}</span>` : ''}
      </div>
      <div class="btn-row">
        ${working ? '<button class="btn sm plain" type="button" data-a="stop">Dừng</button>' : g.done < g.total ? '<button class="btn sm green" type="button" data-a="run">Dịch</button>' : ''}
        ${T.applying && T.applying[g.id] ? `<button class="btn sm cyan" type="button" disabled>Đang áp dụng…</button>`
          : `<button class="btn sm cyan" type="button" data-a="apply" ${g.done && !working ? '' : 'disabled'}>Áp dụng vào game</button>`}
        ${g.applied ? '<button class="btn sm plain" type="button" data-a="restore">Khôi phục bản gốc</button>' : ''}
      </div></div>`;
  const aj = T.applying && T.applying[g.id];
  if (aj) $('#vhHead').insertAdjacentHTML('beforeend', `<div class="box pcard vh-applying"><b>Đang áp dụng bản dịch vào game…</b>
      <div class="vh-prog" role="progressbar" ${aj.total ? `aria-valuenow="${Math.round(aj.done / aj.total * 100)}"` : ''} aria-valuemin="0" aria-valuemax="100"><i style="width:${aj.total ? Math.max(4, Math.round(aj.done / aj.total * 100)) : 100}%"></i></div>
      <span class="hint">${esc(aj.text || '')}${aj.total ? ` · ${aj.done}/${aj.total}` : ''} – file dữ liệu Unity lớn có thể mất vài chục giây, không cần bấm lại.</span></div>`);
  $('#vhHead [data-gid]').addEventListener('click', e => gameAct(e, g.id));
  paintReview(g);
  T.gstate = g;
}

function paintReview(g) {
  const el = $('#vhReview');
  if (!el) return;
  const rv = g.review || {}, run = rv.state === 'running';
  const script = ['renpy', 'rpgmv', 'rpgmz'].includes(g.engine);
  const pct = run && rv.total ? Math.round(rv.done / rv.total * 100) : 0;
  el.innerHTML = `<div class="row-between"><h3>Nội dung cần dịch</h3>
      <button class="btn sm yellow" type="button" id="vhReviewBtn" ${run ? 'disabled' : ''}>${run ? 'Đang lọc…' : 'Lọc câu không cần dịch'}</button></div>
    <p class="hint">Dịch <b>${g.total.toLocaleString('vi-VN')}</b> câu${g.skipped ? ` · bỏ qua <b>${g.skipped.toLocaleString('vi-VN')}</b> câu (mã, tên file, chữ thử… không hiện trong game – xem ở mục <b>Không dịch</b>)` : ''}.
      ${script ? 'Kịch bản game đã được đọc theo đúng cấu trúc, thường không cần lọc.' : 'File dữ liệu game hay lẫn mã nội bộ: dịch nhầm có thể làm game lỗi. Bấm nút vàng để app tự dò, rồi Claude Haiku xem từng câu (chỉ vài cent, cần API key); câu nào nhầm thì bấm ↺ để dịch lại.'}</p>
    ${run ? `<div class="vh-prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      <p class="hint">Claude đang xem ${(rv.done || 0).toLocaleString('vi-VN')}/${(rv.total || 0).toLocaleString('vi-VN')} câu · đã tìm ${rv.found || 0} câu không cần dịch</p>` : ''}
    ${rv.state === 'done' ? `<p class="hint">Lần lọc gần nhất: app tự dò ${rv.auto || 0} câu${rv.nokey ? ' (chưa có API key nên Claude chưa xem)' : `, Claude tìm thêm ${rv.found || 0} câu`}.</p>` : ''}
    ${rv.state === 'error' ? `<p class="hint err">Lọc bị dừng: ${esc(rv.error || '')}</p>` : ''}`;
  $('#vhReviewBtn').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    try { const r = await api(`/api/translate/games/${T.gp}/review`, {method: 'POST'}); paintHead({...T.gstate, ...r, estimate: T.gstate.estimate}); }
    catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
  });
}

async function refreshProject() {
  if (!T.gp || !$('#vhHead')) return;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#vhRows')) return;   // đang sửa
  try {
    const g = await api(`/api/translate/games/${T.gp}?limit=1`);
    const rs = x => (x.review || {}).state + ':' + x.skipped;
    const changed = !T.gstate || g.done !== T.gstate.done || g.status !== T.gstate.status || g.applied !== T.gstate.applied || rs(g) !== rs(T.gstate);
    paintHead(g);
    if (changed) loadRows();
  } catch (e) { /* bỏ qua */ }
}

async function loadRows() {
  const el = $('#vhRows');
  if (!el) return;
  const {filter, q, offset} = T.gq;
  let d;
  try { d = await api(`/api/translate/games/${T.gp}?offset=${offset}&limit=100&filter=${filter}&q=${encodeURIComponent(q)}`); }
  catch (e) { el.innerHTML = `<div class="notice box err">${esc(e.message)}</div>`; return; }
  el.innerHTML = d.rows.length ? `<div class="vh-table" role="table">
    <div class="vh-tr vh-th" role="row"><span role="columnheader">Gốc</span><span role="columnheader">Tiếng Việt</span></div>
    ${d.rows.map(r => `<div class="vh-tr${r.bad ? ' bad' : ''}${r.skip ? ' skip' : ''}" role="row">
      <div class="vh-src" role="cell"><span class="vh-meta">${KIND[r.kind] || r.kind}${r.who ? ' · ' + esc(r.who) : ''}${r.ctx ? ' · ' + esc(r.ctx) : ''}${r.skip ? ' · <b>Không dịch</b>' + (r.why ? ': ' + esc(r.why) : '') : ''}</span>${esc(r.t)}
        <button class="vh-skip" type="button" data-skip="${r.i}" data-on="${r.skip ? 1 : 0}" title="${r.skip ? 'Đưa lại vào danh sách dịch' : 'Không dịch câu này (mã, tên file… không hiện trong game)'}">${r.skip ? '↺ Dịch' : '⊘'}</button></div>
      <div role="cell"><textarea rows="${Math.min(6, Math.max(2, Math.ceil((r.vi || r.t).length / 60)))}" data-i="${r.i}" aria-label="Bản dịch" placeholder="Chưa dịch">${esc(r.vi || '')}</textarea></div>
    </div>`).join('')}</div>` : '<p class="hint">Không có câu nào.</p>';
  el.querySelectorAll('textarea').forEach(ta => {
    ta.dataset.orig = ta.value;
    ta.addEventListener('blur', async () => {
      if (ta.value === ta.dataset.orig) return;
      try { await api(`/api/translate/games/${T.gp}/items`, {method: 'PUT', body: [{i: +ta.dataset.i, vi: ta.value}]}); ta.dataset.orig = ta.value; ta.closest('.vh-tr').classList.remove('bad'); }
      catch (err) { toast(err.message, 'err'); }
    });
  });
  el.querySelectorAll('[data-skip]').forEach(b => b.addEventListener('click', async () => {
    try {
      const g = await api(`/api/translate/games/${T.gp}/skip`, {method: 'PUT', body: [{i: +b.dataset.skip, skip: b.dataset.on !== '1'}]});
      paintHead({...T.gstate, ...g, estimate: T.gstate.estimate}); loadRows();
    } catch (err) { toast(err.message, 'err'); }
  }));
  const pages = Math.ceil(d.matched / 100), cur = Math.floor(offset / 100) + 1;
  $('#vhPager').innerHTML = pages > 1 ? `<span class="hint">${d.matched.toLocaleString('vi-VN')} câu · trang ${cur}/${pages}</span>
    <div class="btn-row"><button class="btn sm plain" type="button" data-p="-1" ${cur === 1 ? 'disabled' : ''}>← Trước</button>
    <button class="btn sm plain" type="button" data-p="1" ${cur === pages ? 'disabled' : ''}>Sau →</button></div>` : `<span class="hint">${d.matched.toLocaleString('vi-VN')} câu</span>`;
  $('#vhPager').querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { T.gq.offset = Math.max(0, offset + (+b.dataset.p) * 100); loadRows(); $('#vhRows').scrollIntoView({block: 'start'}); }));
}

// ---------------------------------------------------------------- tìm chữ chưa dịch (New Game, Start…) trong file game
async function paintFind(job) {
  const el = $('#vhFind'); if (!el) return;
  const pid = T.gp;
  if (job === undefined) { try { job = await api(`/api/translate/games/${pid}/find`); } catch (e) { job = {}; } }
  if (pid !== T.gp || !$('#vhFind')) return;
  const run = job.state === 'running';
  const pct = job.total ? Math.round(job.done / job.total * 100) : 0;
  el.innerHTML = `<div class="row-between"><h3>Tìm chữ chưa dịch</h3></div>
    <p class="hint">Trong game còn chữ tiếng Anh (vd “New Game”, “Start”)? Gõ đúng chữ đó – app tìm trong dự án và trong mọi file dữ liệu của game, rồi thêm cả nhóm chữ chứa nó vào để dịch.</p>
    <form class="vh-find-f" id="vfForm"><input type="search" id="vfQ" placeholder="Ví dụ: New Game" value="${esc(job.q || '')}" aria-label="Chữ cần tìm">
      <button class="btn sm yellow" type="submit" ${run ? 'disabled' : ''}>${run ? 'Đang tìm…' : 'Tìm trong game'}</button></form>
    ${run ? `<div class="vh-prog"><i style="width:${Math.max(4, pct)}%"></i></div><p class="hint">${esc(job.text || '')} · ${job.done}/${job.total} file</p>` : ''}
    ${job.state === 'error' ? `<p class="hint err">${esc(job.text || '')}</p>` : ''}
    ${(job.known || []).length ? `<div class="vf-known"><b>Đã có trong dự án:</b>${job.known.map(k => `<div class="vf-row"><span>“${esc(k.t)}”</span>
        <span class="hint">${k.skip ? 'đang <b>không dịch</b>' + (k.why ? ' (' + esc(k.why) + ')' : '') : k.vi ? 'đã dịch: “' + esc(k.vi) + '”' : 'chưa dịch'}</span>
        ${k.skip ? `<button class="btn sm green" type="button" data-vfun="${k.i}">↺ Dịch câu này</button>` : ''}</div>`).join('')}
      <p class="hint">Câu đã dịch mà game vẫn hiện tiếng Anh: bấm <b>Áp dụng vào game</b> lại, hoặc chữ đó còn nằm ở chỗ khác – xem kết quả bên dưới.</p></div>` : ''}
    ${job.state === 'done' ? (job.hits.length ? `<div class="vf-hits"><b>Tìm thấy trong file game:</b>${job.hits.map((h, i) => `<div class="vf-row">
        <span><code>${esc(h.rel)}</code>${h.kind !== 'file' ? ` → ${esc(h.label)}` : ''}</span>
        <span class="hint">${h.match ? '“' + esc(h.match) + '”' : ''}${h.strings != null ? ` · ${h.strings} câu chữ` : ''}${h.sample && h.sample.length ? ' · vd: ' + esc(h.sample.slice(0, 3).join(' / ')) : ''}</span>
        ${h.in ? '<span class="badge" style="background:var(--green)">Đã trong dự án</span>'
          : `<button class="btn sm green" type="button" data-vfadd="${i}">＋ Thêm vào dịch</button>`}</div>`).join('')}</div>`
      : `<p class="hint">Không thấy “${esc(job.q)}” trong file dữ liệu game. Chữ đó có thể là hình ảnh, hoặc nằm trong file app chưa đọc được – dùng <b>Dịch màn hình game</b> cho phần này.</p>`) : ''}`;
  if (run && !T.fpoll) { T.fpoll = true; pollFind(pid).finally(() => { T.fpoll = false; }); }
  $('#vfForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#vfQ').value.trim(); if (q.length < 2) return;
    try { paintFind(await api(`/api/translate/games/${pid}/find`, {method: 'POST', body: {q}})); } catch (err) { toast(err.message, 'err'); }
  });
  el.querySelectorAll('[data-vfun]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/translate/games/${pid}/skip`, {method: 'PUT', body: [{i: +b.dataset.vfun, skip: false}]}); toast('Đã đưa vào danh sách dịch. Bấm Dịch rồi Áp dụng vào game.'); refreshProject(); paintFind(); }
    catch (err) { toast(err.message, 'err'); }
  }));
  el.querySelectorAll('[data-vfadd]').forEach(b => b.addEventListener('click', async () => {
    const h = job.hits[+b.dataset.vfadd];
    b.disabled = true; b.textContent = 'Đang thêm…';
    try {
      const r = await api(`/api/translate/games/${pid}/find/add`, {method: 'POST', body: {rel: h.rel, path_id: h.path_id ?? null, kind: h.kind}});
      h.in = true; toast(`Đã thêm ${r.added} câu mới (${r.found} câu trong nhóm). Bấm Dịch rồi Áp dụng vào game.`);
      paintFind(job); refreshProject(); loadRows();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = '＋ Thêm vào dịch'; }
  }));
}
async function pollFind(pid) {
  for (;;) {
    await new Promise(r => setTimeout(r, 800));
    if (T.gp !== pid || !$('#vhFind')) return;
    let j; try { j = await api(`/api/translate/games/${pid}/find`); } catch (e) { continue; }
    paintFind(j);
    if (j.state !== 'running') return;
  }
}

// ---------------------------------------------------------------- font tiếng Việt của game
const FN = {st: null, cands: null, cat: null, faces: {}, pick: null, timer: 0};
const FN_SAMPLE = 'Rồng thức giấc giữa đêm trăng máu. Hãy cầm lấy roi và đi đi! Ắ Ặ Ơ Ư Đ ữ ỹ';
const fnSample = () => { try { return localStorage.getItem('cv-fn-sample') || FN_SAMPLE; } catch (e) { return FN_SAMPLE; } };
const fnUrl = (q) => `/api/translate/games/fontlib/file?${q}`;

function fnFace(key, url) {
  if (FN.faces[key]) return FN.faces[key];
  const fam = 'cvf' + Object.keys(FN.faces).length;
  FN.faces[key] = fam;
  try { const f = new FontFace(fam, `url("${url}")`); f.load().then(x => document.fonts.add(x)).catch(() => {}); document.fonts.add(f); } catch (e) { /* bỏ qua */ }
  return fam;
}

const VI_L1 = new Set('ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúý');
function viChar(c) { return /[đĐ]/.test(c) || (/[a-zA-Z]/.test(c.normalize('NFD')[0]) && c.normalize('NFD').length > 1); }
/* giống fontcheck.fit_text: xem trước chữ sẽ hiện trong game theo từng cách */
function fitText(s, mode, have) {
  if (mode === 'nodau') return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  if (mode !== 'safe') return s;
  const H = have ? new Set(have) : VI_L1;
  return [...s].map(c => {
    if (H.has(c) || !viChar(c)) return c;
    if (c === 'đ') return 'd';
    if (c === 'Đ') return H.has('Ð') ? 'Ð' : 'D';
    const d = c.normalize('NFD'), b = d[0], m = d.slice(1);
    const shape = [...m].filter(x => '\u0302\u0306\u031b'.includes(x)).join(''), tone = [...m].filter(x => '\u0300\u0301\u0303\u0309\u0323'.includes(x)).join('');
    for (const cand of [b + shape, b + tone]) { const x = cand.normalize('NFC'); if ([...x].length === 1 && H.has(x)) return x; }
    return b;
  }).join('');
}
/* chế độ nào đang nằm trong game (lần Áp dụng gần nhất) – khác chế độ đang chọn thì nhắc bấm Áp dụng */
function fnNow(st, cur) {
  const n = st.vi_modes || {}, a = st.applied_mode;
  if (!a) return `<p class="fn-now">Chưa áp dụng vào game. Chọn xong bấm <button class="btn sm green" type="button" data-fn-go>Áp dụng vào game</button></p>`;
  if (a === cur) return `<p class="fn-now ok">✓ Trong game đang là <b>${esc(n[a] || a)}</b>.</p>`;
  return `<p class="fn-now warn">Trong game vẫn đang là <b>${esc(n[a] || a)}</b> – bạn mới chọn <b>${esc(n[cur] || cur)}</b> nhưng chưa ghi vào game.
    <button class="btn sm green" type="button" data-fn-go>Áp dụng vào game ngay</button></p>`;
}
function fnModes(st, fonts, sample) {
  const bad = fonts.filter(f => !f.ok), stuck = bad.filter(f => !f.can_replace);
  const cur = st.vi_mode || 'full';
  const desc = {
    full: 'Đúng tiếng Việt. Cần font của game có dấu (hoặc đã đổi font ở trên) – không thì chữ thiếu dấu hiện sai/ô vuông.',
    safe: 'Chữ font không có thì thay bằng chữ gần nhất font có (giữ â ê ô á à…). Đọc được, thiếu một số dấu.',
    nodau: 'Tiếng Việt không dấu – mọi font đều hiện được, gọn gàng.',
    en: 'Không ghi bản dịch: game trở về tiếng Anh. Bản dịch vẫn giữ trong app để dùng lại.',
  };
  return `<div class="fn-modes"><h4>Khi font của game thiếu dấu</h4>
    ${stuck.length ? `<p class="hint"><b>Gợi ý:</b> game dùng font chữ vẽ sẵn (TextMeshPro) thiếu ${esc(stuck[0].missing_sample || '')}… – app chưa thêm dấu được vào loại font này. Chọn <b>Giữ dấu font có</b> hoặc <b>Không dấu</b> để không bị lỗi chữ như “Qufc vffng”, hoặc <b>Giữ tiếng Anh</b>.</p>` : ''}
    <div class="fn-mode-list">${Object.entries(st.vi_modes || {}).map(([k, n]) => `<label class="fn-mode${k === cur ? ' on' : ''}">
      <input type="radio" name="fnMode" value="${k}" ${k === cur ? 'checked' : ''}><b>${esc(n)}${k === 'safe' && stuck.length ? ' (gợi ý)' : ''}${k === cur && st.vi_auto ? ' · app tự chọn' : ''}</b>
      <span class="hint">${esc(desc[k])}</span>
      ${k !== 'en' ? `<span class="fn-mode-ex">${esc(fitText(sample, k, st.have))}</span>` : ''}</label>`).join('')}</div>
    ${fnNow(st, cur)}
    <p class="hint">Áp dụng khi bấm <b>Áp dụng vào game</b>. Bản dịch trong app không đổi – <b>không cần dịch lại</b>, đổi cách khác rồi áp dụng lại lúc nào cũng được.</p></div>`;
}

async function loadFonts(autoscan) {
  const pid = T.gp;
  if (!$('#vhFontBox')) return;
  let st;
  try { st = await api(`/api/translate/games/${pid}/fonts`); } catch (e) { return; }
  if (pid !== T.gp) return;
  if (!st.scan && !st.job && autoscan) {
    try { st = await api(`/api/translate/games/${pid}/fonts/scan`, {method: 'POST'}); } catch (e) { /* bỏ qua */ }
  }
  FN.st = st; FN.pid = pid;
  clearTimeout(FN.timer);
  if (st.job && st.job.state === 'running') FN.timer = setTimeout(() => loadFonts(false), 1500);
  if (st.scan && (!FN.cands || FN.cat !== st.cat)) {
    FN.cat = st.cat;
    try { FN.cands = (await api(`/api/translate/games/fontlib/candidates?cat=${st.cat}`)).fonts; } catch (e) { FN.cands = []; }
  }
  paintFonts();
}

function paintFonts() {
  const el = $('#vhFontBox'), st = FN.st;
  if (!el || !st) return;
  const run = st.job && st.job.state === 'running';
  const fonts = (st.scan && st.scan.fonts) || [];
  const bad = fonts.filter(f => !f.ok), replace = st.mode === 'replace';
  const fixed = {}; ((st.fix && st.fix.targets) || []).forEach(t => { fixed[t.id] = t.cid; });
  const cname = (id) => { const c = (FN.cands || []).find(x => x.id === id); return c ? c.name : id.replace(/^(dl|sys|user):/, '').split(/[\\/]/).pop(); };
  const sample = fnSample();
  if (!FN.pick) FN.pick = st.pick || (FN.cands && FN.cands[0] && FN.cands[0].id) || 'dl:bevietnampro';
  const groups = {};
  (FN.cands || []).forEach(c => { (groups[c.cat_name] = groups[c.cat_name] || []).push(c); });
  el.innerHTML = `<div class="row-between"><h3>Font chữ tiếng Việt</h3>
      <button class="btn sm plain" type="button" id="fnScan" ${run ? 'disabled' : ''}>${run ? 'Đang kiểm tra…' : 'Kiểm tra lại'}</button></div>
    ${run ? `<p class="hint"><span class="spin"></span> ${esc(st.job.text || 'Đang tìm font…')}</p>` : ''}
    ${st.job && st.job.state === 'error' ? `<p class="hint err">Không kiểm tra được: ${esc(st.job.text)}</p>` : ''}
    ${st.scan ? `<p class="hint">${fonts.length ? `Game có <b>${fonts.length}</b> font chữ Latin: ${fonts.length - bad.length} đủ dấu tiếng Việt, <b>${bad.length}</b> thiếu dấu${bad.length ? ' – chữ Việt sẽ hiện ô vuông hoặc mất dấu' : ''}.`
        : 'Không thấy file font nào trong thư mục game (game dùng font hệ thống hoặc font nằm trong gói app chưa mở được).'}
        ${st.mode === 'pick' ? (st.engine === 'renpy' ? ' Ren\'Py: font chọn bên dưới thay cho các font của game khi bấm Áp dụng vào game.' : ' RPG Maker: font chọn bên dưới được chép vào game khi bấm Áp dụng vào game.') : ''}</p>` : ''}
    ${fonts.length ? `<div class="fn-list">${fonts.map(f => {
      const fam = f.kind === 'tmp' ? '' : fnFace('g:' + f.id, fnUrl(`pid=${T.gp}&fid=${encodeURIComponent(f.id)}`));
      const can = replace && f.can_replace;
      return `<label class="fn-row${f.ok ? ' ok' : ''}">
        ${can ? `<input type="checkbox" data-fn="${esc(f.id)}" ${!f.ok || fixed[f.id] ? 'checked' : ''}>` : '<span class="fn-dot"></span>'}
        <span class="fn-info"><b>${esc(f.family)}</b> <span class="hint">${esc(f.label)}${f.kind === 'unity' ? ' · Unity' : f.kind === 'unreal' ? ' · Unreal' : f.kind === 'tmp' ? ' · TextMeshPro' : ''}</span>
          <span class="fn-prev" ${fam ? `style="font-family:'${fam}',monospace"` : ''}>${esc(sample)}</span></span>
        <span class="badge" style="background:${f.ok ? 'var(--green)' : 'var(--red)'}">${f.ok ? 'Đủ tiếng Việt' : f.missing < 0 ? 'Chưa rõ' : 'Thiếu ' + f.missing + ' chữ'}</span>
        ${fixed[f.id] ? `<span class="badge" style="background:var(--cyan)">Đã đổi → ${esc(cname(fixed[f.id]))}</span>` : ''}
        ${f.note ? `<span class="hint fn-note">${esc(f.note)}</span>` : !f.ok && f.missing_sample ? `<span class="hint fn-note">Thiếu: ${esc(f.missing_sample)}…</span>` : ''}
      </label>`; }).join('')}</div>` : ''}
    ${(st.scan && st.scan.notes || []).map(n => `<p class="hint">${esc(n)}</p>`).join('')}
    ${st.scan ? fnModes(st, fonts, sample) : ''}
    ${st.scan && (fonts.length || st.mode === 'pick') ? `<div class="fn-pick">
      <label class="field">Font thay thế có tiếng Việt (gợi ý cùng kiểu “${esc((st.cats || {})[st.cat] || st.cat)}” đứng đầu)
        <select id="fnPick">${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(c =>
          `<option value="${esc(c.id)}" ${c.id === FN.pick ? 'selected' : ''}>${esc(c.name)} — ${esc(c.src)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <div class="fn-preview" id="fnPrev" style="font-family:'${fnFace('c:' + FN.pick, fnUrl('cid=' + encodeURIComponent(FN.pick)))}',sans-serif">${esc(sample)}</div>
      <label class="field">Chữ mẫu<input id="fnSampleIn" value="${esc(sample)}" maxlength="140"></label>
      <div class="btn-row">
        <button class="btn sm green" type="button" id="fnApply">${replace ? 'Đổi font đã chọn' : 'Dùng font này khi áp dụng'}</button>
        <label class="btn sm plain fn-up">＋ Font của bạn (.ttf/.otf)<input type="file" id="fnUp" accept=".ttf,.otf" hidden></label>
        ${(st.fix && st.fix.targets && st.fix.targets.length) || st.pick ? '<button class="btn sm plain" type="button" id="fnRestore">Trả font gốc</button>' : ''}
      </div>
      <p class="hint">${replace ? 'Font mới mang tên của font gốc nên game vẫn nhận; bản gốc sao lưu trong <code>CircleVault-ban-goc</code>. Khung chữ có thể rộng/hẹp hơn một chút – chữ tràn khung thì thử font hẹp hơn (Oswald, Roboto). Font Unity được thay ngay trong file dữ liệu (thử nghiệm); tắt game trước khi đổi.' : 'Font miễn phí được tải từ Google Fonts khi chọn.'}</p>
    </div>` : ''}`;
  $('#fnScan').addEventListener('click', async () => {
    try { FN.st = await api(`/api/translate/games/${T.gp}/fonts/scan`, {method: 'POST'}); paintFonts(); loadFonts(false); } catch (e) { toast(e.message, 'err'); }
  });
  $('#fnPick')?.addEventListener('change', e => { FN.pick = e.target.value; paintFonts(); });
  el.querySelectorAll('[name=fnMode]').forEach(r => r.addEventListener('change', async () => {
    try { await api(`/api/translate/games/${T.gp}`, {method: 'PATCH', body: {vi_mode: r.value}}); FN.st.vi_mode = r.value; paintFonts();
      toast(r.value === 'en' ? 'Bấm “Áp dụng vào game” để trả game về tiếng Anh.' : 'Đã chọn. Bấm “Áp dụng vào game” để ghi lại.'); }
    catch (err) { toast(err.message, 'err'); }
  }));
  el.querySelectorAll('[data-fn-go]').forEach(b => b.addEventListener('click', () => {
    const go = $('#vhHead [data-a="apply"]');
    if (go) go.click(); else toast('Kéo lên đầu dự án và bấm “Áp dụng vào game”.');
  }));
  $('#fnSampleIn')?.addEventListener('change', e => { try { localStorage.setItem('cv-fn-sample', e.target.value.trim() || FN_SAMPLE); } catch (err) { /* bỏ qua */ } paintFonts(); });
  $('#fnApply')?.addEventListener('click', async e => {
    const b = e.currentTarget, ids = [...el.querySelectorAll('[data-fn]')].filter(x => x.checked).map(x => x.dataset.fn);
    if (replace && !ids.length) return toast('Tích chọn font của game cần đổi.', 'err');
    b.disabled = true; b.textContent = 'Đang đổi font…';
    try {
      const r = await withGrant(T.gp, () => api(`/api/translate/games/${T.gp}/fonts/apply`, {method: 'POST', body: {cid: FN.pick, ids}}));
      FN.st = r; paintFonts();
      toast(r.msg || `Đã đổi ${r.result.fonts} font.${r.result.errors.length ? ' Lỗi: ' + r.result.errors[0] : ' Mở game để xem chữ tiếng Việt.'}`);
    } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = replace ? 'Đổi font đã chọn' : 'Dùng font này khi áp dụng'; }
  });
  $('#fnRestore')?.addEventListener('click', async () => {
    try { FN.st = await withGrant(T.gp, () => api(`/api/translate/games/${T.gp}/fonts/restore`, {method: 'POST'})); paintFonts(); toast('Đã trả font gốc của game.'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#fnUp')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await fetch(`/api/translate/games/fontlib/upload?name=${encodeURIComponent(f.name)}`, {method: 'POST', body: f});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || 'Không thêm được font.');
      FN.pick = d.id; FN.cands = null; FN.cat = null; toast(`Đã thêm font ${d.name}.`); loadFonts(false);
    } catch (err) { toast(err.message, 'err'); }
  });
}

window.CV.views.translate = render;
window.CV.translate = {render, open(kind, id) {   // thanh Tiến trình mở thẳng dự án đang chạy
  T.book = null; T.gp = null; T.novel = null; T.scan = null;
  if (kind === 'game') { T.sub = 'vh'; T.gp = id; T.gq = {filter: 'all', q: '', offset: 0}; }
  else if (kind === 'novel') { T.sub = 'novel'; T.novel = id; }
  else if (kind === 'book') { T.sub = 'comic'; T.book = {id}; }
  if (location.hash !== '#translate') location.hash = '#translate'; else render();
}};
})();
