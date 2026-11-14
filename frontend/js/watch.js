/* CircleVault – tab "Xem Online" (YouTube bằng tài khoản của bạn, phim từ trang khác) và tab "Xem Chung" (tạo phòng). */
(() => {
'use strict';
const {api, esc, toast} = window.CV;
const $ = (s, r = document) => r.querySelector(s);
const desk = window.cvDesktop;

/* ================================================================ TRÌNH DUYỆT NGAY TRONG APP
 * YouTube, trang phim và phòng xem chung không mở cửa sổ riêng: app (Electron) đặt trang web đè lên vùng .dock-area của tab.
 * Trang báo vị trí vùng đó liên tục; đổi tab / mở hộp thoại thì báo null để ẩn. */
const DOCK_VIEW = {youtube: 'online', web: 'online', party: 'party'};
const DOCK_NAME = {youtube: 'YouTube', web: 'Trang phim', party: 'Phòng xem chung'};
const dock = {open: {}, shown: null, last: {}, timer: 0};
function dockOpen(mode, url) {
  if (!desk || !desk.dockRect) return desk && desk.openBrowser(mode, url);
  if (mode === 'party') desk.openParty(url); else desk.openBrowser(mode, url);
}
function dockShow(mode) {
  dock.shown = mode;
  const v = DOCK_VIEW[mode];
  if (window.CV.S.view !== v) location.hash = '#' + v; else window.CV.views[v]();
}
function dockHtml(view) {
  const modes = Object.keys(dock.open).filter(m => DOCK_VIEW[m] === view);
  return `<div class="dock-head">
      ${view === 'online' ? modes.map(m => `<button class="chip${m === dock.shown ? ' on' : ''}" type="button" data-dock="${m}">${DOCK_NAME[m]}</button>`).join('')
        + (dock.open.youtube ? '' : '<button class="chip" type="button" data-dock-new="youtube">+ YouTube</button>')
        + (dock.open.web ? '' : '<button class="chip" type="button" data-dock-new="web">+ Trang phim</button>')
        : `<b class="dock-title">${esc(dock.last.party || 'Phòng xem chung')}</b>`}
      <span class="sp"></span>
      <button class="btn sm plain" type="button" data-dock-back>${view === 'online' ? '← Trang Xem Online' : '← Quản lý phòng'}</button>
      <button class="btn sm red" type="button" data-dock-close="${dock.shown}">${view === 'online' ? 'Đóng ' + DOCK_NAME[dock.shown] : 'Rời phòng'}</button>
    </div>
    <div class="dock-area"><div class="loading"><span class="spin"></span>Đang mở…</div></div>`;
}
function bindDock(box) {
  box.querySelectorAll('[data-dock]').forEach(b => b.addEventListener('click', () => dockShow(b.dataset.dock)));
  box.querySelectorAll('[data-dock-new]').forEach(b => b.addEventListener('click', () => dockOpen(b.dataset.dockNew)));
  box.querySelector('[data-dock-back]')?.addEventListener('click', () => { dock.shown = null; lastKey = ''; dockSync(); window.CV.views[window.CV.S.view](); });
  box.querySelector('[data-dock-close]')?.addEventListener('click', e => desk.dockClose(e.currentTarget.dataset.dockClose));
}
const dockArea = view => document.querySelector(`[data-panel="${view}"] .dock-area`);
function dockSync() {
  if (!desk || !desk.dockRect) return;
  const area = dock.shown && dockArea(DOCK_VIEW[dock.shown]);
  const want = dock.shown && window.CV.S.view === DOCK_VIEW[dock.shown] && area && !document.querySelector('dialog[open]') ? dock.shown : null;
  document.body.classList.toggle('view-dock', !!want);
  let rect = null;
  if (want) {
    const bar = document.getElementById('playerBar');
    const bottom = bar && !bar.hidden ? bar.getBoundingClientRect().height : 0;
    const top = area.getBoundingClientRect().top;
    area.style.height = Math.max(240, innerHeight - top - bottom - 12) + 'px';
    const r = area.getBoundingClientRect();
    rect = {x: r.left, y: r.top, width: r.width, height: r.height};
  }
  for (const m of Object.keys(dock.open)) {
    const r = m === want ? rect : null, key = JSON.stringify(r);
    if (dock.open[m].sent !== key) { dock.open[m].sent = key; desk.dockRect(m, r); }
  }
}
if (desk && desk.onDock) {
  desk.onDock((ch, v) => {
    if (ch === 'dock-open') { dock.open[v] = dock.open[v] || {}; dockShow(v); }
    else if (ch === 'dock-closed') {
      delete dock.open[v];
      lastKey = '';
      if (dock.shown === v) { dock.shown = null; window.CV.views[window.CV.S.view] && window.CV.views[window.CV.S.view](); }
    } else if (ch === 'dock-state' && v && v.mode === 'party') dock.last.party = v.title;
    else if (ch === 'sites-changed') { loadSites(true).then(() => { lastKey = ''; if (!dock.shown) window.CV.views[window.CV.S.view]?.(); }); }
    else if (ch === 'party-go') { if (dock.shown !== 'party') dock.shown = null; dockSync(); lastKey = ''; location.hash = '#party'; }
  });
  desk.dockState().then(st => { for (const m of Object.keys(st || {})) dock.open[m] = {}; }).catch(() => {});
  setInterval(dockSync, 200);
  window.addEventListener('resize', dockSync);
}

/* ================================================================ ĐĂNG NHẬP YOUTUBE
 * Google thường chặn đăng nhập trong cửa sổ nhúng của app ("Couldn't sign you in"). Cách chắc ăn: lấy đăng nhập YouTube
 * có sẵn trong trình duyệt của bạn, hoặc nhập file cookies.txt. Cookie chỉ lưu trên máy này. */
async function ytDone(res) {
  if (desk && desk.youtubeImport) { try { await desk.youtubeImport(); } catch (e) { /* bỏ qua */ } }
  toast('Đã đăng nhập YouTube. Playlist của bạn sẽ hiện ở tab Nghe Nhạc.');
  $('#ytDlg')?.close();
  window.dispatchEvent(new Event('cv-youtube'));
}
let ytPoll = 0;
function ytLogin() {
  let dlg = $('#ytDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'ytDlg'; dlg.className = 'box yt-dlg';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<div class="dlg-head"><h3>Đăng nhập YouTube</h3><button class="btn plain iconbtn" type="button" data-ytx aria-label="Đóng">✕</button></div>
    <p class="hint">Google chặn đăng nhập ngay trong app ("Couldn't sign you in"). Cách dưới đây dùng lại đăng nhập YouTube trong Chrome/Edge của bạn: bạn đăng nhập trên chính Chrome nên Google không chặn. Mật khẩu không đi qua app, đăng nhập chỉ lưu trên máy này.</p>
    <section class="yt-way best">
      <h4>1. Tiện ích CircleVault cho Chrome / Edge <span class="badge" style="background:var(--green)">Khuyên dùng</span></h4>
      <ol class="steps">
        <li>Bấm <b>Mở thư mục tiện ích</b> dưới đây (thư mục <code>tien-ich-trinh-duyet</code> mở ra, cứ để đó).</li>
        <li>Trên Chrome, gõ <code>chrome://extensions</code> vào thanh địa chỉ (Edge: <code>edge://extensions</code>), bật <b>Chế độ dành cho nhà phát triển</b> (Developer mode).</li>
        <li>Bấm <b>Tải tiện ích đã giải nén</b> (Load unpacked) → chọn thư mục vừa mở ở bước 1.</li>
        <li>Mở youtube.com trên Chrome và đăng nhập như bình thường (đã đăng nhập sẵn thì thôi). Vài giây sau app tự báo đã đăng nhập.</li>
      </ol>
      <div class="btn-row"><button class="btn green" type="button" id="ytExt">MỞ THƯ MỤC TIỆN ÍCH</button><span class="hint mono" id="ytExtPath"></span></div>
      <p class="hint">Tiện ích chỉ gửi tới app trên chính máy này (127.0.0.1) và tự gửi lại khi Google làm mới phiên, nên app không bị đăng xuất. Chrome để mở là được, không cần tắt.</p>
    </section>
    <details class="yt-more"><summary>Cách khác (Firefox, file cookies.txt, đăng nhập trong app)</summary>
    <section class="yt-way">
      <h4>2. Lấy từ Firefox</h4>
      <p>Đăng nhập youtube.com trên Firefox rồi bấm. Chrome/Edge bản mới mã hóa đăng nhập nên cách này thường không đọc được, dùng cách 1.</p>
      <div class="btn-row"><select id="ytBrowser" aria-label="Trình duyệt">
        ${[['firefox', 'Firefox'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi'], ['chromium', 'Chromium']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select><button class="btn plain" type="button" id="ytFromBrowser">LẤY ĐĂNG NHẬP</button></div>
    </section>
    <section class="yt-way">
      <h4>3. Nhập file cookies.txt</h4>
      <p>Xuất bằng tiện ích <b>Get cookies.txt LOCALLY</b> trên youtube.com, rồi chọn file ở đây. Đăng nhập kiểu này có thể hết hạn sau vài ngày.</p>
      <label class="btn plain file-btn">CHỌN FILE COOKIES.TXT<input type="file" id="ytFile" accept=".txt,text/plain" hidden></label>
    </section>
    <section class="yt-way">
      <h4>4. Đăng nhập trong cửa sổ YouTube của app</h4>
      <p class="hint">Thường bị Google từ chối. Nếu vào được thì app tự nhận.</p>
      <button class="btn plain" type="button" id="ytInApp" ${desk ? '' : 'disabled'}>Mở trang đăng nhập</button>
    </section>
    </details>
    <p class="hint err" id="ytErr" role="alert"></p>`;
  const err = m => { $('#ytErr').textContent = m || ''; };
  dlg.querySelector('[data-ytx]').onclick = () => dlg.close();
  $('#ytFromBrowser').onclick = async e => {
    const b = e.currentTarget; err(''); b.disabled = true; b.textContent = 'ĐANG ĐỌC…';
    try { await ytDone(await api('/api/youtube/import', {method: 'POST', body: {browser: $('#ytBrowser').value}})); }
    catch (x) { err(x.message); }
    finally { b.disabled = false; b.textContent = 'LẤY ĐĂNG NHẬP'; }
  };
  $('#ytFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; err('');
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return err('File quá lớn, không phải file cookies.txt.');
    try {
      const r = await fetch('/api/youtube/import-file', {method: 'POST', headers: {'content-type': 'text/plain', 'X-CircleVault': '1'}, body: await f.text()});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : 'Lỗi ' + r.status);
      await ytDone(d);
    } catch (x) { err(x.message); }
  };
  $('#ytExt').onclick = async e => {
    const b = e.currentTarget; err(''); b.disabled = true;
    try { const r = await api('/api/youtube/extension', {method: 'POST'}); $('#ytExtPath').textContent = r.path; }
    catch (x) { err(x.message); }
    finally { b.disabled = false; }
  };
  // tiện ích gửi đăng nhập sang thì backend ghi file: hỏi lại mỗi 3 giây, có thì báo xong
  clearInterval(ytPoll);
  let before = null;
  api('/api/youtube').then(y => { if (before === null) before = y.logged_in ? y.updated_at : 0; }).catch(() => {});
  ytPoll = setInterval(async () => {
    if (!dlg.open) return clearInterval(ytPoll);
    let y; try { y = await api('/api/youtube'); } catch (x) { return; }
    const key = y.logged_in ? y.updated_at : 0;
    if (before === null) before = key;
    else if (y.logged_in && key !== before) { clearInterval(ytPoll); ytDone({count: 0}); }
  }, 3000);
  $('#ytInApp').onclick = () => { dlg.close(); dockOpen('youtube', 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'); };
  dlg.showModal();
}
window.CV.ytLogin = ytLogin;
window.addEventListener('cv-youtube', () => { if (window.CV.S.view === 'online') renderOnline(); });

/* ================================================================ TRANG PHIM ĐÃ LƯU (bấm nhanh) */
let sites = null;
async function loadSites(force) {
  if (sites && !force) return sites;
  try { sites = await api('/api/web-sites'); } catch (e) { sites = []; }
  return sites;
}
function sitesHtml(kind) {     // kind: 'open' (mở trong trình duyệt app) | 'party' (mở để tạo phòng)
  if (!sites || !sites.length) return '';
  return `<div class="saved-sites"><b>Trang phim đã lưu:</b>${sites.map(x => `<span class="chip-wrap"><button class="chip" type="button"
    data-site-${kind}="${esc(x.url)}" title="${esc(x.url)}">${esc(x.name || x.host)}</button><button class="chip-x" type="button" data-site-del="${esc(x.url)}"
    aria-label="Bỏ ${esc(x.name || x.host)}">×</button></span>`).join('')}</div>`;
}
async function saveSite(url) {
  try { sites = await api('/api/web-sites', {method: 'POST', body: {url}}); toast('Đã lưu trang.'); return true; }
  catch (e) { toast(e.message, 'err'); return false; }
}
/** Link trang phim mà máy chủ không đọc thẳng được: mở trang trong app, bấm phát → app tự tạo phòng. */
function partyCapture(url, opts) {
  if (!desk || !desk.partyCapture) return false;
  desk.partyCapture(url, opts || {});
  toast('Đã mở trang trong app: chọn phim rồi bấm phát, bắt được luồng phim là phòng tự tạo.');
  return true;
}
document.addEventListener('click', async e => {
  const o = e.target.closest('[data-site-open]');
  if (o) return dockOpen('web', o.dataset.siteOpen);
  const p = e.target.closest('[data-site-party]');
  if (p) {
    if (!partyCapture(p.dataset.siteParty, {title: $('#nTitle')?.value.trim() || '', control: document.querySelector('[name=nCtl]:checked')?.value}))
      toast('Chỉ làm được trong app CircleVault trên Windows.', 'err');
    return;
  }
  const d = e.target.closest('[data-site-del]');
  if (d) {
    try { sites = await api('/api/web-sites?url=' + encodeURIComponent(d.dataset.siteDel), {method: 'DELETE'}); } catch (err) { toast(err.message, 'err'); }
    lastKey = '';
    window.CV.views[window.CV.S.view] && window.CV.views[window.CV.S.view]();
  }
});

/* ================================================================ XEM ONLINE */
async function renderOnline() {
  if (dock.shown && DOCK_VIEW[dock.shown] === 'online' && dock.open[dock.shown]) {
    $('#onlineBox').innerHTML = dockHtml('online');
    bindDock($('#onlineBox'));
    return dockSync();
  }
  let yt = {logged_in: false, use_account: true};
  try { yt = await api('/api/youtube'); } catch (e) { /* bỏ qua */ }
  await loadSites();
  const appOnly = desk ? '' : `<div class="notice box warn"><b>Chỉ có trong app CircleVault trên Windows</b>
    <span>Bạn đang mở CircleVault bằng trình duyệt nên không mở được cửa sổ YouTube và trình duyệt bắt link. Cài app từ trang Releases để dùng phần này.</span></div>`;
  const opened = Object.keys(dock.open).filter(m => DOCK_VIEW[m] === 'online');
  $('#onlineBox').innerHTML = `${appOnly}
  ${opened.length ? `<div class="box pcard dock-again"><b>Đang mở trong app:</b>${opened.map(m => `<button class="btn sm cyan" type="button" data-dock="${m}">${DOCK_NAME[m]}</button>`).join('')}</div>` : ''}
  <div class="cols2">
    <div class="box pcard yt-card">
      <div class="row-between"><h3>YouTube bằng tài khoản của bạn</h3>
        <span class="badge" style="background:${yt.logged_in ? 'var(--green)' : 'var(--surface-2)'};${yt.logged_in ? '' : 'color:var(--text)'}">${yt.logged_in ? 'Đã đăng nhập' : 'Chưa đăng nhập'}</span></div>
      <p>Xem YouTube ngay trong cửa sổ app. Có <b>YouTube Premium</b> thì xem không quảng cáo như trên Chrome. Đang xem video nào, bấm <span class="ui-k g">Tải video này</span> trên thanh công cụ là xong.</p>
      <ul class="tick">
        <li>Đăng nhập một lần, app nhớ cho lần sau.</li>
        <li>Tải bằng tài khoản: tải được video giới hạn tuổi, video dành cho hội viên kênh, chất lượng 1080p Premium nếu có.</li>
        <li>Đăng nhập bằng tài khoản YouTube có sẵn trong Firefox/Chrome/Edge của bạn hoặc file cookies.txt; CircleVault không đọc và không lưu mật khẩu.</li>
      </ul>
      <div class="btn-row">
        <button class="btn green" type="button" data-open="youtube" ${desk ? '' : 'disabled'}>MỞ YOUTUBE</button>
        ${yt.logged_in ? '<button class="btn plain" type="button" id="ytLogout" ' + (desk ? '' : 'disabled') + '>Đăng xuất</button>'
          : '<button class="btn yellow" type="button" id="ytLoginBtn">Đăng nhập YouTube</button>'}
      </div>
      <label class="check"><input type="checkbox" id="useYt" ${yt.use_account ? 'checked' : ''}> Dùng tài khoản này khi tải video YouTube</label>
    </div>

    <div class="box pcard">
      <h3>Phim từ trang khác</h3>
      <p>Mở trang xem phim bằng trình duyệt trong app. Khi phim bắt đầu phát, app tự <b>bắt link luồng phim</b> (.m3u8, .mp4) kèm thông tin cần thiết; bạn chỉ việc bấm <span class="ui-k g">Tải</span>.</p>
      <form class="paste-row" id="webForm">
        <input type="text" id="webUrl" placeholder="Địa chỉ trang phim, ví dụ vimeo.com/… hoặc tên phim để tìm" aria-label="Địa chỉ trang phim" ${desk ? '' : 'disabled'}>
        <button class="btn yellow" type="submit" ${desk ? '' : 'disabled'}>MỞ</button>
        <button class="btn plain" type="button" id="webSave" title="Lưu trang này để lần sau bấm nhanh">☆ Lưu</button>
      </form>
      ${sitesHtml('open')}
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
  $('#ytLoginBtn')?.addEventListener('click', ytLogin);
  $('#ytLogout')?.addEventListener('click', async () => {
    if (desk) await desk.youtubeLogout(); else await api('/api/youtube', {method: 'DELETE'}).catch(() => {});
    toast('Đã đăng xuất YouTube trong app.'); renderOnline();
  });
  document.querySelectorAll('#onlineBox [data-open]').forEach(b => b.addEventListener('click', () => dockOpen(b.dataset.open)));
  bindDock($('#onlineBox'));
  $('#webSave').addEventListener('click', async () => {
    const v = $('#webUrl').value.trim();
    if (!v || /\s/.test(v)) { toast('Gõ địa chỉ trang phim (vd. ten-trang.com) rồi bấm Lưu. Đang mở trang thì bấm ☆ Lưu trang trên thanh công cụ.', 'err'); return $('#webUrl').focus(); }
    if (await saveSite(v)) renderOnline();
  });
  $('#webForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#webUrl').value.trim();
    if (!v) return $('#webUrl').focus();
    dockOpen('web', v);
  });
}
if (desk && desk.onYoutubeLogin) desk.onYoutubeLogin(() => { if (window.CV.S.view === 'online') renderOnline(); });

/* ================================================================ XEM CHUNG */
let partyTimer = 0, videos = [], lastKey = '';
async function loadVideos() {
  try { videos = (await api('/api/library?limit=500')).items.filter(i => i.exists && !/\.(mp3|m4a|opus|ogg|flac|wav)$/i.test(i.filepath)); }
  catch (e) { videos = []; }
}
const SRC_NAME = {file: 'Phim trong thư viện', path: 'File trên máy', youtube: 'Video YouTube', link: 'Link trang phim', stream: 'Luồng bắt từ trình duyệt'};
function srcKind(src) {
  if (!src) return null;
  if (src.type === 'youtube') return 'youtube';
  if (src.type === 'stream') return src.origin === 'link' ? 'link' : 'stream';
  return src.item_id ? 'file' : 'path';
}
function srcLabel(src) {
  const k = srcKind(src);
  return SRC_NAME[k] + (src.site ? ' · ' + src.site : '');
}
function sourceForm(prefix, room) {
  const cur = room ? srcKind(room.source) : null;
  const opts = videos.map(v => `<option value="${v.id}" ${room && room.source.item_id === v.id ? 'selected' : ''}>${esc(v.title)}</option>`).join('');
  const sel = cur || (videos.length ? 'file' : 'youtube');
  const kinds = [...(room ? ['keep'] : []), 'file', 'path', 'youtube', 'link'];
  const label = k => k === 'keep' ? `Giữ phim đang chiếu (${esc(srcLabel(room.source))})` : SRC_NAME[k];
  const on = k => (room ? k === 'keep' : k === sel);
  return `
    <div class="src-tabs">${kinds.map(k => `<label class="check"><input type="radio" name="${prefix}Src" value="${k}" ${on(k) ? 'checked' : ''}
      ${k === 'file' && !videos.length ? 'disabled' : ''}> ${label(k)}</label>`).join('')}</div>
    <label class="field" data-src="file" ${on('file') ? '' : 'hidden'}>Chọn phim<select id="${prefix}Item">${opts || '<option value="">Thư viện chưa có phim</option>'}</select></label>
    <div class="field" data-src="path" ${on('path') ? '' : 'hidden'}>File phim trên máy
      <div class="paste-row"><input type="text" id="${prefix}Path" placeholder="D:\\Phim\\ten-phim.mp4">
      ${desk && desk.pickFile ? `<button class="btn plain" type="button" data-pickvid="${prefix}">Chọn file…</button>` : ''}</div></div>
    <label class="field" data-src="youtube" ${on('youtube') ? '' : 'hidden'}>Link video YouTube<input type="url" id="${prefix}Yt" placeholder="https://www.youtube.com/watch?v=…"></label>
    <div class="field" data-src="link" ${on('link') ? '' : 'hidden'}>Link trang phim<input type="url" id="${prefix}Link" placeholder="https://vimeo.com/… · dailymotion · facebook · bilibili…">
      <small class="hint">Dán link trang phim rồi bấm Tạo phòng. Trang app không đọc thẳng được thì app tự mở trang đó: chọn phim, bấm phát là phòng tự tạo. Phim có DRM (Netflix, FPT Play…) không chiếu được.</small>
      ${prefix === 'n' ? sitesHtml('party') : ''}</div>
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
  else if (src === 'link') body.link = $(`#${prefix}Link`).value.trim();
  else if (src === 'path') body.path = $(`#${prefix}Path`).value.trim();
  else if (src === 'file') body.item_id = +$(`#${prefix}Item`).value || null;
  return body;
}
function bindSourceToggle(prefix) {
  document.querySelectorAll(`[name=${prefix}Src]`).forEach(r => r.addEventListener('change', () => {
    r.closest('form').querySelectorAll('[data-src]').forEach(el => { el.hidden = el.dataset.src !== r.value; });
  }));
  document.querySelectorAll(`[data-pickvid="${prefix}"]`).forEach(b => b.addEventListener('click', async () => {
    const f = await desk.pickFile('Chọn file phim', ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'mp3', 'm4a', 'flac']);
    if (f) $(`#${prefix}Path`).value = f;
  }));
}
function copyBtn(text, label = 'Sao chép') {
  return `<button class="btn sm cyan" type="button" data-copy="${esc(text)}">${label}</button>`;
}
async function renderParty(st) {
  if (!st) { try { st = await api('/api/party'); } catch (e) { return; } }
  if (dock.shown === 'party' && dock.open.party) return;          // đang ở trong phòng (vùng nhúng)
  const box = $('#partyBox');
  const key = JSON.stringify([st.room && {...st.room, state: null}, st.tunnel, st.lan]);
  if (key === lastKey && box.childElementCount) return;                                   // không đổi gì
  if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return; // đang gõ
  lastKey = key;
  const wasOpen = !!box.querySelector('details[open]');
  if (!st.room) {
    await Promise.all([loadVideos(), loadSites()]);
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
          <li>Bạn tạo phòng, chọn phim trong thư viện, file trên máy, video YouTube hoặc link trang phim. Đang xem phim trên trang nào ở tab Xem Online cũng bấm <b>Xem chung</b> được.</li>
          <li>Bấm <b>Mở cho bạn bè qua Internet</b> rồi gửi link cho bạn bè (Zalo, Messenger…). Bạn bè mở bằng trình duyệt, không cần cài gì.</li>
          <li>Cả phòng xem cùng lúc: ai bấm phát, dừng hay tua thì mọi người cùng theo. Có chat và thả cảm xúc.</li>
        </ol>
        <p class="hint">Phim trong thư viện, file trên máy và phim từ trang khác đều đi qua máy bạn: mỗi người xem cần khoảng 3–5 Mbps tốc độ <b>tải lên</b> của mạng nhà bạn. Video YouTube thì mỗi người xem thẳng từ YouTube, không tốn mạng của bạn.</p>
      </div>
    </div>`;
    bindSourceToggle('n');
    $('#newRoom').addEventListener('submit', async e => {
      e.preventDefault();
      const b = e.submitter || e.target.querySelector('[type=submit]'); b.disabled = true; b.textContent = 'ĐANG MỞ…';
      const body = readSource('n');
      try { renderParty(await api('/api/party', {method: 'POST', body})); toast('Đã tạo phòng.'); }
      catch (err) {
        b.disabled = false; b.textContent = 'TẠO PHÒNG';
        if (err.status === 424 && body.link && partyCapture(body.link, {title: body.title || '', control: body.control})) return;
        toast(err.message, 'err');
      }
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
        <p class="hint">${esc(srcLabel(r.source))} · ${r.members.length} người đang xem${r.members.length ? ': ' + r.members.map(m => esc(m.name)).join(', ') : ''}</p></div>
      <button class="btn green" type="button" id="enterRoom">VÀO PHÒNG</button>
    </div>
  </div>
  <div class="cols2">
    <div class="box pcard"><h3>Link cho bạn bè ở xa</h3>${tunnelHtml}</div>
    <div class="box pcard"><h3>Link cho người cùng Wi-Fi</h3>
      ${L.lan ? `<div class="linkbox"><code>${esc(L.lan)}</code>${copyBtn(L.lan)}</div>`
        : '<p class="hint">Đang tắt. Bật ở tab Cài đặt → Mạng → "Cho điện thoại cùng Wi-Fi", rồi mở lại app. Người cùng nhà xem bằng điện thoại/TV sẽ mượt hơn đi qua Internet.</p>'}
    </div>
  </div>
  <details class="box pcard">
    <summary><b>Đổi phim / cài đặt phòng</b></summary>
    <form id="editRoom" class="main" style="margin-top:12px">
      ${sourceForm('e', r)}
      <div class="btn-row"><button class="btn yellow" type="submit">Lưu thay đổi</button></div>
    </form>
  </details>
  <div><button class="btn red" type="button" id="closeRoom">Đóng phòng</button></div>`;
  bindSourceToggle('e');
  if (wasOpen) box.querySelector('details').open = true;
  $('#enterRoom').addEventListener('click', () => { dock.last.party = r.title; desk && desk.openParty ? dockOpen('party', L.host) : window.open(L.host, '_blank'); });
  $('#tunnelOn')?.addEventListener('click', async () => { try { renderParty(await api('/api/party/tunnel', {method: 'POST'})); } catch (err) { toast(err.message, 'err'); } });
  $('#tunnelOff')?.addEventListener('click', async () => renderParty(await api('/api/party/tunnel', {method: 'DELETE'})));
  $('#editRoom').addEventListener('submit', async e => {
    e.preventDefault();
    const body = readSource('e'), same = !body.youtube_url && !body.link && !body.path && !body.item_id;
    try { lastKey = ''; renderParty(await api('/api/party', {method: 'POST', body})); toast(same ? 'Đã lưu cài đặt phòng.' : 'Đã đổi phim cho cả phòng.'); }
    catch (err) {
      if (err.status === 424 && body.link && partyCapture(body.link, {title: body.title || '', control: body.control})) return;
      toast(err.message, 'err');
    }
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
  if (dock.shown === 'party' && dock.open.party) {       // đang ở trong phòng: không vẽ lại khung quản lý
    if (!dockArea('party')) { $('#partyBox').innerHTML = dockHtml('party'); bindDock($('#partyBox')); lastKey = ''; }
    dockSync();
    partyTimer = setTimeout(pollParty, 1000);
    return;
  }
  renderParty().finally(() => { partyTimer = setTimeout(pollParty, 2500); });
}

window.CV.views.online = renderOnline;
window.CV.views.party = pollParty;
})();
