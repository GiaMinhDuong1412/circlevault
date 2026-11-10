'use strict';
(() => {
const sel = document.getElementById('sel');
const dim = document.getElementById('dim');
let start = null;
let old = null;

function show(r) {
  sel.classList.add('on');
  dim.style.display = 'none';
  Object.assign(sel.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
}
function rectOf(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

window.sshell.onShot((s) => {
  document.getElementById('shot').src = s.url;
  old = s.old;
  if (old) show(old);
});
window.addEventListener('mousedown', (e) => {
  if (e.button === 2) return window.sshell.send('region-cancel');
  start = { x: e.clientX, y: e.clientY };
  show({ ...start, width: 0, height: 0 });
});
window.addEventListener('mousemove', (e) => { if (start) show(rectOf(start, { x: e.clientX, y: e.clientY })); });
window.addEventListener('mouseup', (e) => {
  if (!start || e.button !== 0) return;
  const r = rectOf(start, { x: e.clientX, y: e.clientY });
  start = null;
  if (r.width < 8 || r.height < 8) { sel.classList.remove('on'); dim.style.display = ''; return; }
  window.sshell.send('region-done', { rect: r });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.sshell.send('region-cancel');
  if (e.key === 'Enter' && old) window.sshell.send('region-done', { rect: old });
});
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.sshell.send('region-cancel'); });
})();
