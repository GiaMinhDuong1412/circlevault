/* CircleVault – tab "Xem Online" (YouTube bằng tài khoản của bạn, phim từ trang khác) và tab "Xem Chung" (tạo phòng). */
(() => {
'use strict';
const {api, esc, toast} = window.CV;
const $ = (s, r = document) => r.querySelector(s);
const desk = window.cvDesktop;

/* ================================================================ XEM ONLINE */
async function renderOnline() {
  let yt = {logged_in: false, use_account: true};
  try { yt = await api('/api/youtube'); } catch (e) { /* bỏ qua */ }
  const appOnly = desk ? '' : `<div class="notice box warn"><b>Chỉ có trong app CircleVault trên Windows</b>
    <span>Bạn đang mở CircleVault bằng trình duyệt nên không mở được cửa sổ YouTube và trình duyệt bắt link. Cài app từ trang Releases để dùng phần này.</span></div>`;
  $('#onlineBox').innerHTML = `${appOnly}
  <div class="cols2">
    <div class="box pcard yt-card">
      <div class="row-between"><h3>YouTube bằng tài khoản của bạn</h3>
        <span class="badge" style="background:${yt.logged_in ? 'var(--green)' : 'var(--surface-2)'};${yt.logged_in ? '' : 'color:var(--text)'}">${yt.logged_in ? 'Đã đăng nhập' : 'Chưa đăng nhập'}</span></div>
      <p>Xem YouTube ngay trong app. Có <b>YouTube Premium</b> thì xem không quảng cáo như trên Chrome. Đang xem video nào, bấm <span class="ui-k g">Tải video này</span> trên thanh công cụ là xong.</p>
      <ul class="tick">
        <li>Đăng nhập một lần, app nhớ cho lần sau.</li>
        <li>Tải bằng tài khoản: tải được video giới hạn tuổi, video dành cho hội viên kênh, chất lượng 1080p Premium nếu có.</li>
        <li>Mật khẩu chỉ nhập trên trang của Google; CircleVault không đọc và không lưu mật khẩu.</li>
      </ul>
      <div class="btn-row">
        <button class="btn green" type="button" data-open="youtube" ${desk ? '' : 'disabled'}>MỞ YOUTUBE</button>
        ${yt.logged_in ? '<button class="btn plain" type="button" id="ytLogout" ' + (desk ? '' : 'disabled') + '>Đăng xuất</button>'
          : '<button class="btn yellow" type="button" data-open="youtube-login" ' + (desk ? '' : 'disabled') + '>Đăng nhập YouTube</button>'}
      </div>
      <label class="check"><input type="checkbox" id="useYt" ${yt.use_account ? 'checked' : ''}> Dùng tài khoản này khi tải video YouTube</label>
    </div>

    <div class="box pcard">
      <h3>Phim từ trang khác</h3>
      <p>Mở trang xem phim bằng trình duyệt trong app. Khi phim bắt đầu phát, app tự <b>bắt link luồng phim</b> (.m3u8, .mp4) kèm thông tin cần thiết; bạn chỉ việc bấm <span class="ui-k g">Tải</span>.</p>
      <form class="paste-row" id="webForm">
        <input type="text" id="webUrl" placeholder="Địa chỉ trang phim, ví dụ vimeo.com/… hoặc tên phim để tìm" aria-label="Địa chỉ trang phim" ${desk ? '' : 'disabled'}>
        <button class="btn yellow" type="submit" ${desk ? '' : 'disabled'}>MỞ</button>
      </form>
      <ol class="steps">
        <li>Mở trang, bấm phát phim như bình thường.</li>
        <li>Nút <b>Luồng phim bắt được</b> trên thanh công cụ hiện số luồng tìm thấy.</li>
        <li>Chọn luồng lớn nhất (thường là <code>master.m3u8</code> hoặc file .mp4) → <b>Tải</b>. Phim vào Hàng Đợi như video YouTube.</li>
      </ol>
      <p class="hint">Trình duyệt này tự chặn quảng cáo và cửa sổ bật lên. Phim có DRM (Netflix, Disney+, FPT Play, VieON…) không phát và không tải được.</p>
    </div>
  </div>

  <div class="box pcard">
    <h3>Dán link trực tiếp ở Trang Chủ</h3>
    <p>Với các trang dưới đây không cần mở trình duyệt: copy link trang video rồi dán ở <a href="#home">Trang Chủ</a> như YouTube. Tổng cộng hơn 1.800 trang được hỗ trợ.</p>
    <div class="site-list">${['Vimeo', 'Dailymotion', 'Facebook', 'Instagram', 'TikTok', 'X (Twitter)', 'Twitch (video đã phát)', 'Bilibili', 'Niconico',
      'SoundCloud', 'Bandcamp', 'Reddit', 'Archive.org', 'TED', 'Mixcloud', 'VK'].map(s => `<span class="chip">${s}</span>`).join('')}</div>
    <p class="hint">Trang không có trong danh sách, hoặc dán link báo lỗi: dùng cách <b>Phim từ trang khác</b> ở trên.</p>
  </div>`;

  $('#useYt').addEventListener('change', async e => {
    try { await api('/api/config', {method: 'PUT', body: {use_youtube_account: e.target.checked}}); toast('Đã lưu.'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#ytLogout')?.addEventListener('click', async () => {
    await desk.youtubeLogout();
    toast('Đã đăng xuất YouTube trong app.'); renderOnline();
  });
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.open;
    desk.openBrowser(k === 'youtube-login' ? 'youtube' : k,
      k === 'youtube-login' ? 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F' : undefined);
  }));
  $('#webForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#webUrl').value.trim();
    if (!v) return $('#webUrl').focus();
    desk.openBrowser('web', v);
  });
}
if (desk && desk.onYoutubeLogin) desk.onYoutubeLogin(() => { if (window.CV.S.view === 'online') renderOnline(); });

/* ================================================================ XEM CHUNG */
let partyTimer = 0, videos = [], lastKey = '';
async function loadVideos() {
  try { videos = (await api('/api/library?limit=500')).items.filter(i => i.exists && !/\.(mp3|m4a|opus|ogg|flac|wav)$/i.test(i.filepath)); }
  catch (e) { videos = []; }
}
function sourceForm(prefix, room) {
  const opts = videos.map(v => `<option value="${v.id}" ${room && room.source.item_id === v.id ? 'selected' : ''}>${esc(v.title)}</option>`).join('');
  const isYt = room ? room.source.type === 'youtube' : !videos.length;
  return `
    <div class="src-tabs">
      <label class="check"><input type="radio" name="${prefix}Src" value="file" ${isYt ? '' : 'checked'} ${videos.length ? '' : 'disabled'}> Phim trong thư viện</label>
      <label class="check"><input type="radio" name="${prefix}Src" value="youtube" ${isYt ? 'checked' : ''}> Video YouTube</label>
    </div>
    <label class="field" data-src="file" ${isYt ? 'hidden' : ''}>Chọn phim<select id="${prefix}Item">${opts || '<option value="">Thư viện chưa có phim</option>'}</select></label>
    <label class="field" data-src="youtube" ${isYt ? '' : 'hidden'}>Link video YouTube<input type="url" id="${prefix}Yt" placeholder="https://www.youtube.com/watch?v=…" value="${room && room.source.type === 'youtube' ? 'https://www.youtube.com/watch?v=' + esc(room.source.video_id) : ''}"></label>
    <label class="field">Tên phòng (tuỳ chọn)<input type="text" id="${prefix}Title" maxlength="120" placeholder="Ví dụ: Tối thứ 7 xem phim" value="${room ? esc(room.title) : ''}"></label>
    <div class="src-tabs">
      <label class="check"><input type="radio" name="${prefix}Ctl" value="everyone" ${!room || room.control === 'everyone' ? 'checked' : ''}> Ai cũng phát/dừng/tua được</label>
      <label class="check"><input type="radio" name="${prefix}Ctl" value="host" ${room && room.control === 'host' ? 'checked' : ''}> Chỉ mình tôi điều khiển</label>
    </div>`;
}
function readSource(prefix) {
  const src = document.querySelector(`[name=${prefix}Src]:checked`)?.value;
  const body = {title: $(`#${prefix}Title`).value.trim() || null, control: document.querySelector(`[name=${prefix}Ctl]:checked`).value};
  if (src === 'youtube') body.youtube_url = $(`#${prefix}Yt`).value.trim();
  else body.item_id = +$(`#${prefix}Item`).value || null;
  return body;
}
function bindSourceToggle(prefix) {
  document.querySelectorAll(`[name=${prefix}Src]`).forEach(r => r.addEventListener('change', () => {
    document.querySelectorAll('#partyBox [data-src]').forEach(el => { el.hidden = el.dataset.src !== r.value; });
  }));
}
function copyBtn(text, label = 'Sao chép') {
  return `<button class="btn sm cyan" type="button" data-copy="${esc(text)}">${label}</button>`;
}
async function renderParty(st) {
  if (!st) { try { st = await api('/api/party'); } catch (e) { return; } }
  const box = $('#partyBox');
  const key = JSON.stringify([st.room && {...st.room, state: null}, st.tunnel, st.lan]);
  if (key === lastKey && box.childElementCount) return;                                   // không đổi gì
  if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return; // đang gõ
  lastKey = key;
  const wasOpen = !!box.querySelector('details[open]');
  if (!st.room) {
    await loadVideos();
    box.innerHTML = `
    <div class="cols2">
      <form class="box pcard" id="newRoom">
        <h3>Tạo phòng xem chung</h3>
        ${sourceForm('n', null)}
        <div><button class="btn green" type="submit">TẠO PHÒNG</button></div>
      </form>
      <div class="box pcard">
        <h3>Cách hoạt động</h3>
        <ol class="steps">
          <li>Bạn tạo phòng, chọn phim trong thư viện hoặc một video YouTube.</li>
          <li>Bấm <b>Mở cho bạn bè qua Internet</b> rồi gửi link cho bạn bè (Zalo, Messenger…). Bạn bè mở bằng trình duyệt, không cần cài gì.</li>
          <li>Cả phòng xem cùng lúc: ai bấm phát, dừng hay tua thì mọi người cùng theo. Có chat và thả cảm xúc.</li>
        </ol>
        <p class="hint">Phim trong thư viện được phát từ máy bạn: mỗi người xem cần khoảng 3–5 Mbps tốc độ <b>tải lên</b> của mạng nhà bạn. Video YouTube thì mỗi người xem thẳng từ YouTube, không tốn mạng của bạn.</p>
      </div>
    </div>`;
    bindSourceToggle('n');
    $('#newRoom').addEventListener('submit', async e => {
      e.preventDefault();
      try { renderParty(await api('/api/party', {method: 'POST', body: readSource('n')})); toast('Đã tạo phòng.'); }
      catch (err) { toast(err.message, 'err'); }
    });
    return;
  }
  const r = st.room, L = r.links, tn = st.tunnel;
  const tunnelHtml = {
    off: `<p>Bạn bè ở xa cần link Internet. App mở một đường hầm Cloudflare miễn phí (không cần tài khoản); link tự hết khi bạn đóng phòng.</p>
          <div><button class="btn yellow" type="button" id="tunnelOn">MỞ CHO BẠN BÈ QUA INTERNET</button></div>`,
    downloading: '<p class="loading"><span class="spin"></span>Lần đầu: đang tải công cụ đường hầm (khoảng 40 MB)…</p>',
    starting: '<p class="loading"><span class="spin"></span>Đang mở đường hầm, chờ khoảng 10 giây…</p>',
    ready: L.internet ? `<div class="linkbox"><code>${esc(L.internet)}</code>${copyBtn(L.internet, 'Sao chép link')}</div>
          <p class="hint">Gửi link này cho bạn bè. Ai có link đều vào được phòng, nên chỉ gửi cho người bạn tin.</p>
          <div><button class="btn sm plain" type="button" id="tunnelOff">Tắt link Internet</button></div>` : '',
    error: `<p class="no">${esc(tn.error || 'Không mở được đường hầm.')}</p><div><button class="btn yellow" type="button" id="tunnelOn">Thử lại</button></div>`,
  }[tn.status] || '';
  box.innerHTML = `
  <div class="box pcard room-card">
    <div class="row-between">
      <div><span class="badge" style="background:var(--green)">Phòng đang mở</span><h3 style="margin-top:8px">${esc(r.title)}</h3>
        <p class="hint">${r.source.type === 'youtube' ? 'Video YouTube' : 'Phim trong thư viện'} · ${r.members.length} người đang xem${r.members.length ? ': ' + r.members.map(m => esc(m.name)).join(', ') : ''}</p></div>
      <button class="btn green" type="button" id="enterRoom">VÀO PHÒNG</button>
    </div>
  </div>
  <div class="cols2">
    <div class="box pcard"><h3>Link cho bạn bè ở xa</h3>${tunnelHtml}</div>
    <div class="box pcard"><h3>Link cho người cùng Wi-Fi</h3>
      ${L.lan ? `<div class="linkbox"><code>${esc(L.lan)}</code>${copyBtn(L.lan)}</div>`
        : '<p class="hint">Đang tắt. Bật ở tab Lưu Trữ → Mạng → "Cho điện thoại cùng Wi-Fi", rồi mở lại app. Người cùng nhà xem bằng điện thoại/TV sẽ mượt hơn đi qua Internet.</p>'}
    </div>
  </div>
  <details class="box pcard">
    <summary><b>Đổi phim / cài đặt phòng</b></summary>
    <form id="editRoom" class="main" style="margin-top:12px">
      ${sourceForm('e', r)}
      <div class="btn-row"><button class="btn yellow" type="submit">Đổi phim cho cả phòng</button></div>
    </form>
  </details>
  <div><button class="btn red" type="button" id="closeRoom">Đóng phòng</button></div>`;
  bindSourceToggle('e');
  if (wasOpen) box.querySelector('details').open = true;
  $('#enterRoom').addEventListener('click', () => (desk && desk.openParty ? desk.openParty(L.host) : window.open(L.host, '_blank')));
  $('#tunnelOn')?.addEventListener('click', async () => { try { renderParty(await api('/api/party/tunnel', {method: 'POST'})); } catch (err) { toast(err.message, 'err'); } });
  $('#tunnelOff')?.addEventListener('click', async () => renderParty(await api('/api/party/tunnel', {method: 'DELETE'})));
  $('#editRoom').addEventListener('submit', async e => {
    e.preventDefault();
    try { renderParty(await api('/api/party', {method: 'POST', body: readSource('e')})); toast('Đã đổi phim cho cả phòng.'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#closeRoom').addEventListener('click', async e => {
    const b = e.currentTarget;
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa: mọi người sẽ bị đưa ra khỏi phòng'; return; }
    renderParty(await api('/api/party', {method: 'DELETE'})); toast('Đã đóng phòng.');
  });
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast('Đã sao chép link.'); }
  catch (err) { toast('Không sao chép được, hãy bôi đen link rồi Ctrl+C.', 'err'); }
});

function pollParty() {
  clearTimeout(partyTimer);
  if (window.CV.S.view !== 'party') return;
  renderParty().finally(() => { partyTimer = setTimeout(pollParty, 2500); });
}

window.CV.views.online = renderOnline;
window.CV.views.party = pollParty;
})();
