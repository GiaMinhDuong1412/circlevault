'use strict';
(() => {
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = { font: 20, showSrc: false, auto: false, busy: false, region: null };

function apply() {
  document.documentElement.style.setProperty('--fs', S.font + 'px');
  $('#bAuto').classList.toggle('on', S.auto);
  $('#bAuto').setAttribute('aria-pressed', S.auto);
  $('#bAuto').textContent = S.auto ? 'Tự động: BẬT' : 'Tự động';
  $('#bSrc').classList.toggle('on', S.showSrc);
  $('#bSrc').setAttribute('aria-pressed', S.showSrc);
  $('#bGo').disabled = S.busy;
  $('#bGo').textContent = S.busy ? 'Đang dịch…' : 'Dịch';
  document.querySelectorAll('.src').forEach((e) => { e.hidden = !S.showSrc; });
}

window.sshell.onState((s) => { S = { ...S, ...s }; apply(); });
window.sshell.onStatus((s) => { const el = $('#st'); el.textContent = s.text || ''; el.className = 'st ' + (s.kind || ''); });
window.sshell.onResult((r) => {
  $('#out').innerHTML = r.blocks.map((b) => `<div class="line"><div class="vi">${esc(b.vi || b.text)}</div><div class="src" ${S.showSrc ? '' : 'hidden'}>${esc(b.text)}</div></div>`).join('');
  $('#out').scrollTop = 0;
});
window.sshell.state().then((s) => { S = { ...S, ...s }; apply(); });

$('#bSel').addEventListener('click', () => window.sshell.send('select'));
$('#bGo').addEventListener('click', () => window.sshell.send('translate'));
$('#bAuto').addEventListener('click', () => window.sshell.send('auto'));
$('#bSrc').addEventListener('click', () => window.sshell.send('src', { v: !S.showSrc }));
$('#bMinus').addEventListener('click', () => window.sshell.send('font', { v: S.font - 2 }));
$('#bPlus').addEventListener('click', () => window.sshell.send('font', { v: S.font + 2 }));
$('#bClose').addEventListener('click', () => window.sshell.send('close'));
})();
