/* Thanh "Tiến trình": việc đang chạy nền (tải về, Việt hóa game, dịch truyện, lọc câu, kiểm tra font, cắt video).
   Màn hình rộng: cột bên phải, ở khoảng trống cạnh app. Màn hẹp / đang mở khung Facebook: nút nổi góc dưới bên trái (không đè thông báo), bấm để xem.
   Dữ liệu: GET /api/progress (2 giây/lần khi có việc, 6 giây khi rảnh, 15 giây khi app bị ẩn). */
(() => {
'use strict';
const CV = window.CV || {};
const esc = CV.esc || (s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])));
const P = {items: [], recent: [], prev: new Map(), open: false, timer: 0, mode: ''};
const KEEP = 15 * 60 * 1000;
const ICON = {dl: '⬇', game: 'VH', font: 'Aa', review: '⊘', book: 'TT', novel: 'TC', edit: '✂'};
const COLOR = {dl: 'var(--cyan)', game: 'var(--green)', font: 'var(--violet)', review: 'var(--yellow)', book: 'var(--pink)',
  novel: 'var(--cyan)', edit: 'var(--yellow)'};
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } };

const box = document.createElement('aside');
box.id = 'cvProg';
box.className = 'cvp';
box.setAttribute('aria-label', 'Tiến trình đang chạy');
box.hidden = true;
document.body.appendChild(box);

function item(x, done) {
  const pct = x.pct == null ? null : Math.max(0, Math.min(100, x.pct));
  const err = x.status === 'error';
  return `<button type="button" class="cvp-item${done ? ' done' : ''}${err ? ' err' : ''}${x.status === 'paused' ? ' paused' : ''}" data-key="${esc(x.key)}">
    <span class="cvp-ic" style="background:${err ? 'var(--red)' : COLOR[x.kind] || 'var(--surface-2)'}" aria-hidden="true">${err ? '!' : done ? '✓' : ICON[x.kind] || '•'}</span>
    <span class="cvp-body">
      <span class="cvp-lab">${esc(x.label)}${err ? ' · lỗi' : done ? ' · xong' : pct != null ? ` · ${Math.round(pct)}%` : ''}</span>
      <span class="cvp-title">${esc(x.title)}</span>
      ${done ? '' : `<span class="cvp-bar${pct == null || x.status === 'queued' ? ' wait' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100"
        ${pct != null ? `aria-valuenow="${Math.round(pct)}"` : ''}><i style="width:${pct == null || x.status === 'queued' ? 100 : pct}%"></i></span>`}
      ${x.sub && (!done || err) ? `<span class="cvp-sub">${esc(x.sub)}</span>` : ''}
    </span></button>`;
}

function layout() {
  const shell = document.querySelector('.shell');
  const r = shell ? shell.getBoundingClientRect() : {right: innerWidth};
  const free = innerWidth - r.right;
  const fb = document.body.classList.contains('fbx-on');
  const bar = [...document.querySelectorAll('.pbar')].find(b => b.offsetParent !== null);
  const bottom = (bar ? bar.offsetHeight : 0) + 16;
  const dock = free >= 250 && !fb && lsGet('cv-prog-min') !== '1';
  P.mode = dock ? 'dock' : 'pill';
  box.classList.toggle('dock', dock);
  box.classList.toggle('pill', !dock);
  if (dock) {
    const w = Math.min(330, free - 28);
    Object.assign(box.style, {left: `${Math.round(r.right + 4)}px`, width: `${Math.round(w)}px`, right: '', bottom: '',
      maxHeight: `calc(100vh - ${18 + bottom}px)`});
  } else {
    Object.assign(box.style, {left: 'max(16px,env(safe-area-inset-left,0px))', width: '', right: '', bottom: `${bottom}px`,
      maxHeight: `calc(100vh - ${bottom + 30}px)`});
  }
}

function paint() {
  const sc = box.querySelector('.cvp-list')?.scrollTop || 0;
  const fk = box.contains(document.activeElement) ? document.activeElement.dataset.key || [...document.activeElement.attributes].map(a => a.name).find(n => n.startsWith('data-')) : null;
  draw();
  const l = box.querySelector('.cvp-list');
  if (l) l.scrollTop = sc;
  if (fk) (box.querySelector(`[data-key="${CSS.escape(fk)}"]`) || box.querySelector(`[${fk}]`))?.focus();
}

function draw() {
  layout();
  const now = Date.now();
  P.recent = P.recent.filter(x => now - x.at < KEEP);
  const n = P.items.length;
  const active = P.items.filter(x => x.pct != null && x.status === 'running');
  const avg = active.length ? Math.round(active.reduce((a, x) => a + x.pct, 0) / active.length) : null;
  const list = `<div class="cvp-list">${P.items.map(x => item(x, false)).join('')}${P.recent.map(x => item(x, true)).join('')}
      ${!n && !P.recent.length ? '<p class="cvp-empty">Không có việc nào đang chạy. Tải về, Việt hóa game, dịch truyện, cắt video… sẽ hiện ở đây kèm phần trăm.</p>' : ''}</div>`;
  if (P.mode === 'dock') {
    box.hidden = false;
    box.innerHTML = `<div class="cvp-head"><b>Tiến trình</b>${n ? `<span class="cvp-n">${n}</span>` : ''}
        ${P.recent.length ? '<button type="button" class="cvp-x" data-clear title="Xóa các mục đã xong">Dọn</button>' : ''}
        <button type="button" class="cvp-x" data-min title="Thu nhỏ thành nút ở góc dưới" aria-label="Thu nhỏ">–</button></div>${list}`;
  } else {
    box.hidden = !n && !P.recent.length;
    box.innerHTML = `${P.open ? `<div class="cvp-pop"><div class="cvp-head"><b>Tiến trình</b>${n ? `<span class="cvp-n">${n}</span>` : ''}
        ${P.recent.length ? '<button type="button" class="cvp-x" data-clear title="Xóa các mục đã xong">Dọn</button>' : ''}
        ${lsGet('cv-prog-min') === '1' ? '<button type="button" class="cvp-x" data-pin title="Hiện thành cột bên phải khi màn hình đủ rộng">Ghim bên phải</button>' : ''}</div>${list}</div>` : ''}
      <button type="button" class="cvp-pill-btn" data-toggle aria-expanded="${P.open}">
        <span class="cvp-spin${n ? '' : ' off'}" aria-hidden="true"></span>${n ? `${n} việc đang chạy${avg != null ? ` · ${avg}%` : ''}` : `${P.recent.length} việc vừa xong`}</button>`;
  }
}

box.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-toggle')) { P.open = !P.open; return paint(); }
  if (t.hasAttribute('data-min')) { lsSet('cv-prog-min', '1'); P.open = false; return paint(); }
  if (t.hasAttribute('data-pin')) { lsSet('cv-prog-min', '0'); P.open = false; return paint(); }
  if (t.hasAttribute('data-clear')) { P.recent = []; return paint(); }
  const key = t.dataset.key;
  const x = P.items.find(i => i.key === key) || P.recent.find(i => i.key === key);
  if (!x || !x.open) return;
  P.open = false;
  if (x.open.tr && CV.translate && CV.translate.open) CV.translate.open(x.open.tr, x.open.id);
  else if (x.open.hash) location.hash = x.open.hash;
  paint();
});
document.addEventListener('click', e => { if (P.open && e.target.isConnected && !box.contains(e.target)) { P.open = false; paint(); } });

async function tick() {
  clearTimeout(P.timer);
  let d = null;
  try { const r = await fetch('/api/progress'); if (r.ok) d = await r.json(); } catch (e) { /* máy chủ đang khởi động lại */ }
  if (d) {
    const fin = d.items.filter(x => x.status === 'done' || x.status === 'error');
    const act = d.items.filter(x => !fin.includes(x));
    const cur = new Map(act.map(x => [x.key, x]));
    for (const [k, x] of P.prev) {               // việc biến mất khỏi danh sách = đã xong (tải về thì máy chủ báo rõ xong/lỗi)
      if (cur.has(k) || x.kind === 'font') continue;
      const f = fin.find(y => y.key === k);
      if (x.kind === 'dl' && !f) continue;       // tác vụ tải bị hủy/xóa
      if (CV.toast && x.kind !== 'review') CV.toast(f && f.status === 'error' ? `Lỗi: ${x.label} – ${x.title}` : `Xong: ${x.label} – ${x.title}`, f && f.status === 'error' ? 'err' : undefined);
      if (x.kind !== 'dl') P.recent = [{...x, status: 'done', at: Date.now()}, ...P.recent.filter(r => r.key !== k)];
    }
    P.recent = [...P.recent.filter(r => r.kind !== 'dl' && !cur.has(r.key)), ...fin.map(x => ({...x, at: x.at * 1000}))]
      .sort((a, b) => b.at - a.at).slice(0, 6);
    P.prev = cur;
    P.items = act;
    paint();
  }
  P.timer = setTimeout(tick, document.hidden ? 15000 : P.items.length ? 2000 : 6000);
}

let rz = 0;
addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(paint); });
new MutationObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(paint); })
  .observe(document.body, {attributes: true, attributeFilter: ['class']});
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
tick();
})();
