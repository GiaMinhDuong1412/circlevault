/* CircleVault – tab "Dịch": dịch truyện tranh (CBZ/ảnh) và chữ trong game sang tiếng Việt. */
(() => {
'use strict';
const {api, esc, toast} = window.CV;
const $ = (s, r = document) => r.querySelector(s);
const desk = window.cvDesktop;
const T = {sub: 'comic', settings: null, book: null, view: 'vi', poll: null, edit: null};
try { T.sub = localStorage.getItem('cv-tr-sub') || 'comic'; } catch (e) { /* bỏ qua */ }

const SUBS = [['comic', 'Dịch truyện'], ['game', 'Dịch game'], ['quick', 'Dịch nhanh'], ['settings', 'Cài đặt bộ dịch']];

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
  box.innerHTML = `
    <div class="tr-head row-between">
      <div class="tr-subs" role="tablist">${SUBS.map(([k, n]) => `<button type="button" class="chip${T.sub === k ? ' on' : ''}" data-sub="${k}" role="tab" aria-selected="${T.sub === k}">${n}</button>`).join('')}</div>
      <span class="hint">Bộ dịch: <b>${esc(engineName(s))}</b>${s && s.engine === 'claude' && !s.has_key ? ' · <span class="tr-warn">chưa có API key</span>' : ''}</span>
    </div>
    <div id="trSub" class="main"></div>`;
  box.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => {
    T.sub = b.dataset.sub; T.book = null;
    try { localStorage.setItem('cv-tr-sub', T.sub); } catch (e) { /* bỏ qua */ }
    render();
  }));
  if (!s) { $('#trSub').innerHTML = '<div class="notice box err"><b>Không tải được cài đặt dịch.</b><span>Thử khởi động lại app.</span></div>'; return; }
  ({comic: T.book ? renderReader : renderBooks, game: renderGame, quick: renderQuick, settings: renderSettings})[T.sub]();
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
        <details class="tr-help"><summary>Cách lấy API key và chi phí</summary>
          <ol class="steps">
            <li>Vào <b>console.anthropic.com</b>, đăng ký bằng email.</li>
            <li>Mục <b>Billing</b>: nạp tiền bằng thẻ Visa/Mastercard (tối thiểu 5 USD).</li>
            <li>Mục <b>API Keys</b> → <b>Create Key</b> → copy khóa bắt đầu bằng <code>sk-ant-</code> rồi dán vào ô trên.</li>
          </ol>
          <p class="hint">Ước tính cho một chương 25 trang có gửi ảnh: Opus 5.5 khoảng 0,5–1 USD, Sonnet 5.5 khoảng một nửa, Haiku 5.5 chỉ vài cent. Câu đã dịch được nhớ lại, mở lại hay xuất lại không tốn thêm. Không chia sẻ API key cho người khác.</p>
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

window.CV.views.translate = render;
window.CV.translate = {render};
})();
