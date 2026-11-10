'use strict';
const st = document.getElementById('st');
const go = document.getElementById('go');

async function show() {
  const { status } = await chrome.storage.local.get('status');
  if (!status) { st.textContent = 'Chưa gửi lần nào. Bấm Gửi ngay.'; st.className = ''; return; }
  const t = new Date(status.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  st.textContent = `${status.text} (${t})`;
  st.className = status.ok ? 'ok' : 'err';
}

go.addEventListener('click', async () => {
  go.disabled = true; go.textContent = 'Đang gửi…';
  await chrome.runtime.sendMessage('sync');
  await show();
  go.disabled = false; go.textContent = 'Gửi ngay';
});
show();
