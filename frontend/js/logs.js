/* CircleVault – Cài đặt → Nhật ký: lỗi của mọi chức năng + việc chạy lâu (để cải tiến). Backend: app/applog.py */
(() => {
'use strict';
const CV = window.CV;
if (!CV) return;
const {api, esc, toast} = CV;
const L = {tab: 'error', data: null, open: new Set(), showWarn: true};

/* ---------- gửi lỗi của trang về nhật ký (mỗi lỗi giống nhau tối đa 1 lần / 30 giây) */
const sent = new Map();
function report(msg, src, stack) {
  msg = String(msg || '').slice(0, 900);
  if (!msg || /ResizeObserver loop|Script error\.?$/.test(msg)) return;
  const k = msg + '|' + (src || '');
  if (Date.now() - (sent.get(k) || 0) < 30000) return;
  sent.set(k, Date.now());
  fetch('/api/logs/client', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({msg, src: String(src || '').slice(0, 300), stack: String(stack || '').slice(0, 5000),
      view: (location.hash || '#home').slice(1)})}).catch(() => {});
}
window.addEventListener('error', e => report(e.message, `${e.filename || ''}:${e.lineno || ''}:${e.colno || ''}`, e.error && e.error.stack));
window.addEventListener('unhandledrejection', e => {
  const r = e.reason || {};
  if (r.status && r.status < 500) return;       // lỗi API 4xx đã được máy chủ ghi
  report(r.message || String(r), '', r.stack);
});

/* ---------- giao diện */
const when = t => {
  const d = new Date((t || 0) * 1000), now = new Date();
  const hm = d.toLocaleTimeString('vi-VN', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString('vi-VN')} ${hm}`;
};
const secs = s => s >= 3600 ? `${(s / 3600).toFixed(1)} giờ` : s >= 60 ? `${Math.floor(s / 60)} phút ${Math.round(s % 60)} s` : `${(+s).toFixed(1)} s`;
const KIND = {api: 'Yêu cầu', job: 'Việc chạy nền', log: 'Hệ thống', thread: 'Luồng', page: 'Trang'};

async function load() {
  if (!document.getElementById('logBox')) return;
  try { L.data = await api('/api/logs'); } catch (e) { L.data = null; }
  paint();
}

function paint() {
  const el = document.getElementById('logBox'), d = L.data;
  if (!el) return;
  if (!d) { el.innerHTML = '<div class="box pcard"><p class="hint">Không đọc được nhật ký.</p></div>'; return; }
  const errs = d.errors.filter(r => L.showWarn || r.level !== 'warn');
  const nWarn = d.errors.filter(r => r.level === 'warn').length;
  el.innerHTML = `<div class="box pcard logs">
    <div class="row-between"><h3>Nhật ký</h3>
      <div class="btn-row">
        <button class="btn sm plain" type="button" data-lg="reload">Làm mới</button>
        <a class="btn sm plain" href="/api/logs/export" download="circlevault-nhat-ky.txt" title="Một file chữ gọn – gửi cho Claude để sửa / cải tiến">⬇ Xuất file</a>
        <button class="btn sm plain" type="button" data-lg="copy">Chép</button>
        <button class="btn sm plain" type="button" data-lg="clear">Xóa nhật ký</button>
      </div></div>
    <p class="hint">App tự ghi <b>mọi lỗi</b> khi chạy bất kỳ chức năng nào và những việc <b>chạy lâu</b> (yêu cầu ≥ ${d.limits.api} giây, việc chạy nền ≥ ${d.limits.job} giây).
      Gặp lỗi hay thấy chậm: bấm <b>Xuất file</b> rồi gửi file cho Claude để sửa. Nhật ký chỉ nằm trên máy này.</p>
    <div class="lg-tabs">
      <button type="button" class="chip${L.tab === 'error' ? ' on' : ''}" data-lgtab="error">Lỗi <b>${d.counts.errors}</b>${d.counts.errors_24h ? ` <span class="lg-new">${d.counts.errors_24h} trong 24 giờ</span>` : ''}</button>
      <button type="button" class="chip${L.tab === 'slow' ? ' on' : ''}" data-lgtab="slow">Chạy lâu <b>${d.counts.slow}</b></button>
      ${d.desktop && d.desktop.length ? `<button type="button" class="chip${L.tab === 'app' ? ' on' : ''}" data-lgtab="app">Nhật ký app</button>` : ''}
    </div>
    ${L.tab === 'error' ? errList(errs, nWarn) : L.tab === 'slow' ? slowList(d) : `<pre class="lg-pre">${esc(d.desktop.join('\n'))}</pre>`}
  </div>`;
}

function errList(rows, nWarn) {
  const warnToggle = nWarn ? `<label class="hint lg-warn"><input type="checkbox" data-lg="warn" ${L.showWarn ? 'checked' : ''}> Hiện cả thông báo lỗi người dùng (${nWarn}) – vd "Chọn ít nhất một font"</label>` : '';
  if (!rows.length) return warnToggle + '<p class="hint">Chưa có lỗi nào. 👍</p>';
  return warnToggle + `<div class="lg-list">${rows.slice(0, 200).map((r, i) => {
    const id = `${r.at}-${i}`, open = L.open.has(id);
    return `<div class="lg-row${r.level === 'warn' ? ' warn' : ''}">
      <button type="button" class="lg-head" data-lgopen="${esc(id)}">
        <span class="lg-time mono">${esc(when(r.at))}</span>
        <span class="badge lg-kind">${esc(KIND[r.kind] || r.kind || '')}${r.status ? ' ' + r.status : ''}</span>
        <b class="lg-name">${esc(r.name || '')}</b>
        <span class="lg-msg">${esc(r.msg || '')}</span>
      </button>
      ${open ? `<div class="lg-body">
        ${r.path ? `<p class="hint mono">${esc(r.path)}</p>` : ''}
        ${r.game ? `<p class="hint">Game: ${esc(r.game)}</p>` : ''}${r.url ? `<p class="hint mono">${esc(r.url)}</p>` : ''}
        ${r.sec ? `<p class="hint">Chạy ${esc(secs(r.sec))} rồi lỗi.</p>` : ''}
        ${r.tb ? `<pre class="lg-pre">${esc(r.tb)}</pre>` : '<p class="hint">Không có chi tiết thêm.</p>'}
      </div>` : ''}
    </div>`; }).join('')}</div>`;
}

function slowList(d) {
  if (!d.slow_sum.length) return '<p class="hint">Chưa có việc nào chạy lâu.</p>';
  const max = Math.max(...d.slow_sum.map(s => s.sum)) || 1;
  return `<p class="hint">Gộp theo chức năng, xếp theo <b>tổng thời gian</b> – chức năng đứng đầu là chỗ đáng cải tiến nhất.</p>
    <div class="lg-table">
      <div class="lg-tr lg-th"><span>Chức năng</span><span>Số lần</span><span>Trung bình</span><span>Lâu nhất</span><span>Lần cuối</span></div>
      ${d.slow_sum.map(s => `<div class="lg-tr">
        <span><b>${esc(s.name)}</b> <span class="hint">${esc(KIND[s.kind] || '')}</span><i class="lg-bar" style="width:${Math.max(3, Math.round(s.sum / max * 100))}%"></i></span>
        <span class="mono">${s.n}</span><span class="mono">${esc(secs(s.avg))}</span><span class="mono">${esc(secs(s.max))}</span>
        <span class="mono">${esc(when(s.last))}</span></div>`).join('')}
    </div>
    <details class="lg-recent"><summary>Từng lần gần đây (${d.slow.length})</summary>
      <div class="lg-list">${d.slow.slice(0, 150).map(r => `<div class="lg-row"><div class="lg-head static">
        <span class="lg-time mono">${esc(when(r.at))}</span><span class="badge lg-kind">${esc(secs(r.sec))}</span>
        <b class="lg-name">${esc(r.name)}</b><span class="lg-msg">${r.game ? esc(r.game) : r.chars ? esc(r.chars.toLocaleString('vi-VN') + ' ký tự') : ''}</span></div></div>`).join('')}</div>
    </details>`;
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-lgtab],[data-lg],[data-lgopen]');
  if (!t || !t.closest('#logBox')) return;
  if (t.dataset.lgtab) { L.tab = t.dataset.lgtab; return paint(); }
  if (t.dataset.lgopen) { const id = t.dataset.lgopen; L.open.has(id) ? L.open.delete(id) : L.open.add(id); return paint(); }
  const a = t.dataset.lg;
  if (a === 'reload') return load();
  if (a === 'warn') { L.showWarn = t.checked; return paint(); }
  if (a === 'clear') {
    if (!confirm('Xóa toàn bộ nhật ký lỗi và chạy lâu?')) return;
    try { await api('/api/logs', {method: 'DELETE'}); toast('Đã xóa nhật ký.'); load(); } catch (err) { toast(err.message, 'err'); }
  }
  if (a === 'copy') {
    try {
      const txt = await (await fetch('/api/logs/export')).text();
      await navigator.clipboard.writeText(txt);
      toast('Đã chép nhật ký – dán vào chat với Claude.');
    } catch (err) { toast('Không chép được, dùng nút Xuất file.', 'err'); }
  }
});

CV.logs = {load, report};
})();
