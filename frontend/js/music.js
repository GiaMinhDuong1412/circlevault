/* CircleVault – trang Nghe Nhạc: thư viện bài hát, playlist, thanh phát nhạc cố định ở đáy, phím media. */
(() => {
'use strict';
const {api, esc, toast, fmtDur, gradient} = window.CV;
const $ = (s, r = document) => r.querySelector(s);

const audio = new Audio();
audio.preload = 'metadata';
const engine = new window.CV.eq.Engine(audio);

const M = {
  tracks: [], playlists: [], list: 'all', q: '', sort: 'recent',
  queue: [], qi: -1, shuffle: false, repeat: 'off', settings: {}, eq: null, loaded: false,
  yt: {logged_in: false, items: [], saved: [], loading: false, error: null}, online: null, seq: 0, pseq: 0, errRun: 0, opening: '',
};
const isYt = l => typeof l === 'string' && l.startsWith('yt:');
const keyOf = t => t ? (t.ou ? 'o:' + (t.yt || t.ou) : 'l:' + t.id) : '';
const enc = encodeURIComponent;
const srcName = t => t.site || (t.yt ? 'YouTube' : 'Online');
const sameTrack = (a, b) => !!a && !!b && keyOf(a) === keyOf(b);

/* ------------------------------------------------------------ lưu cài đặt (debounce) */
let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = {...M.settings, eq: M.eq ? M.eq.state : M.settings.eq, volume: audio.volume, shuffle: M.shuffle, repeat: M.repeat};
    api('/api/music/settings', {method: 'PUT', body: s}).catch(() => {});
  }, 600);
}

/* ------------------------------------------------------------ dữ liệu */
async function loadPlaylists() {
  try { M.playlists = await api('/api/music/playlists'); } catch (e) { M.playlists = []; }
  renderSide();
}
async function loadTracks() {
  if (M.list === 'yt:@search') { if (M.search) { M.online = M.search; M.tracks = filterQ(M.search.entries); } return renderTracks(); }
  if (isYt(M.list)) return loadOnline(false);
  M.online = null;
  const p = new URLSearchParams();
  if (typeof M.list === 'number') p.set('playlist', M.list);
  else { p.set('sort', M.list === 'plays' ? 'plays' : M.sort); if (M.q) p.set('q', M.q); }
  try { M.tracks = await api('/api/music/tracks?' + p); } catch (e) { M.tracks = []; toast(e.message, 'err'); }
  if (typeof M.list === 'number' && M.q) {
    const q = M.q.toLowerCase();
    M.tracks = M.tracks.filter(t => [t.title, t.artist, t.album].some(x => (x || '').toLowerCase().includes(q)));
  }
  renderTracks();
}

/* ------------------------------------------------------------ YouTube online */
async function loadYt(refresh) {
  M.yt.loading = true; renderSide();
  try { Object.assign(M.yt, await api('/api/music/yt/playlists' + (refresh ? '?refresh=1' : '')), {loading: false}); }
  catch (e) { Object.assign(M.yt, {loading: false, error: e.message}); }
  renderSide();
}
function filterQ(list) {
  if (!M.q) return list;
  const q = M.q.toLowerCase();
  return list.filter(t => [t.title, t.artist].some(x => (x || '').toLowerCase().includes(q)));
}
async function loadOnline(refresh, src) {
  const key = String(M.list).slice(3);
  const my = ++M.seq;
  $('#trackList').innerHTML = '<div class="empty"><h3>Đang lấy danh sách bài…</h3><p>Playlist dài có thể mất vài chục giây.</p></div>';
  $('#plTools').hidden = true; $('#ytTools').hidden = true;
  try {
    const p = new URLSearchParams({src: src || key});
    if (refresh) p.set('refresh', '1');
    if (src) p.set('save', '1');
    const data = await api('/api/music/yt/list?' + p);
    if (my !== M.seq) return;
    M.online = data;
    if (src && data.key !== key) { M.list = 'yt:' + data.key; }
    M.tracks = filterQ(data.entries);
    if (src) loadYt(false);
  } catch (e) {
    if (my !== M.seq) return;
    M.online = {key, title: key, entries: [], error: e.message}; M.tracks = [];
  }
  renderSide(); renderTracks();
}
async function searchOnline(q, site) {
  const my = ++M.seq;
  M.list = 'yt:@search'; M.q = ''; $('#mSearch').value = '';
  renderSide();
  $('#trackList').innerHTML = `<div class="empty"><h3>Đang tìm “${esc(q)}”…</h3></div>`;
  $('#plTools').hidden = true; $('#ytTools').hidden = true;
  try {
    const data = await api('/api/music/yt/search?' + new URLSearchParams({q, site}));
    if (my !== M.seq) return;
    M.online = M.search = data; M.tracks = data.entries;
  } catch (e) {
    if (my !== M.seq) return;
    M.online = {key: '@search', title: `Tìm “${q}”`, entries: [], error: e.message, search: true}; M.tracks = [];
  }
  renderTracks();
}
async function addTask(url, playlist, label) {
  try {
    await api('/api/tasks', {method: 'POST', body: {url, quality: 'audio', playlist}});
    toast(`Đã thêm ${label} vào hàng đợi tải. Tải xong bài sẽ có trong Tất cả bài hát và phát từ máy.`);
    window.CV.refreshStatus && window.CV.refreshStatus();
  } catch (e) { toast(e.message, 'err'); }
}

/* ------------------------------------------------------------ cột trái */
function renderSide() {
  const item = (key, label, n) => `<li><a href="#music" data-list="${key}" class="${String(M.list) === String(key) ? 'on' : ''}">${label}${n != null ? `<span class="n">${n}</span>` : ''}</a></li>`;
  const folders = (window.CV.S.config?.music_folders || []);
  $('#mSide').innerHTML = `
    <div><h4>Thư viện nhạc</h4><ul>
      ${item('all', 'Tất cả bài hát')}${item('plays', 'Nghe nhiều nhất')}</ul></div>
    <div><h4>Playlist</h4><ul>
      ${M.playlists.map(p => item(p.id, esc(p.name), p.count)).join('') || '<li class="hint">Chưa có playlist.</li>'}</ul>
      <form class="mini-form" id="newPl"><input type="text" id="newPlName" placeholder="Tên playlist mới" maxlength="80" aria-label="Tên playlist mới"><button class="btn sm yellow" type="submit">Tạo</button></form></div>
    ${ytSide(item)}
    <div><h4>Thư mục nhạc trên máy</h4>
      <ul class="folders">${folders.map((f, i) => `<li><span title="${esc(f)}">${esc(f)}</span><button type="button" class="chip-x" data-rmf="${i}" aria-label="Bỏ thư mục">×</button></li>`).join('') || '<li class="hint">Chưa thêm thư mục nào. Nhạc tải từ YouTube luôn có sẵn ở đây.</li>'}</ul>
      <form class="mini-form" id="addFolder">
        <input type="text" id="folderPath" placeholder="D:\\Nhac" aria-label="Đường dẫn thư mục nhạc">
        <button class="btn sm plain" type="submit">Thêm</button>
      </form>
      ${window.cvDesktop?.pickFolder ? '<button class="btn sm cyan" type="button" id="pickFolder">Chọn thư mục…</button>' : ''}
      <button class="btn sm green" type="button" id="scanBtn">Quét lại nhạc</button>
      <p class="hint" id="scanState"></p>
    </div>
    ${window.cvDesktop?.musicState ? `<div><h4>Trình phát mini</h4>
      <label class="check"><input type="checkbox" id="miniOn" ${M.settings.mini !== false ? 'checked' : ''}> Hiện khi thu nhỏ app</label></div>` : ''}`;
  if (typeof M.list === 'number' && !M.playlists.some(p => p.id === M.list)) M.list = 'all';
}
function ytSide(item) {
  const y = M.yt;
  let body;
  if (y.loading && !y.items.length) body = '<p class="hint">Đang lấy playlist YouTube của bạn…</p>';
  else if (!y.logged_in) body = `<p class="hint">Đăng nhập YouTube trong app để thấy playlist, video đã thích, xem sau của bạn.</p>
    <button class="btn sm red" type="button" id="ytLogin">Đăng nhập YouTube</button>`;
  else body = `<ul>${y.items.map(p => item('yt:' + p.id, (p.builtin ? '♥ ' : '▶ ') + esc(p.title))).join('')}</ul>
    ${y.error ? `<p class="hint err">${esc(y.error)}</p>` : ''}
    ${y.items.length <= 2 && !y.error ? '<p class="hint">Chưa thấy playlist nào. Bấm ⟳ để tải lại.</p>' : ''}`;
  const saved = (y.saved || []).filter(s => !y.items.some(p => p.id === s.id));
  return `<div class="yt-side"><h4>Tìm nhạc online</h4>
    <form class="ol-search" id="olSearch">
      <input type="search" id="olQ" placeholder="Tên bài, ca sĩ…" aria-label="Tìm nhạc online" value="${esc(M.olq || '')}">
      <div class="mini-form"><select id="olSite" aria-label="Nguồn">
        <option value="yt" ${M.olsite !== 'sc' ? 'selected' : ''}>YouTube</option><option value="sc" ${M.olsite === 'sc' ? 'selected' : ''}>SoundCloud</option>
      </select><button class="btn sm green" type="submit">Tìm</button></div>
    </form>
    ${M.list === 'yt:@search' ? `<ul>${item('yt:@search', '🔎 Kết quả tìm vừa rồi')}</ul>` : ''}
    <h4 class="row-h">YouTube của tôi${y.logged_in ? `<button type="button" class="chip-x" id="ytRefresh" title="Tải lại danh sách playlist" aria-label="Tải lại">${y.loading ? '…' : '⟳'}</button>` : ''}</h4>
    ${body}
    ${saved.length ? `<h4>Đã mở bằng link</h4><ul class="folders">${saved.map(s => `<li><a href="#music" data-list="yt:${esc(s.id)}" class="${M.list === 'yt:' + s.id ? 'on' : ''}" title="${esc(s.title)}">${esc(s.title)}</a><button type="button" class="chip-x" data-forget="${esc(s.id)}" aria-label="Bỏ khỏi danh sách">×</button></li>`).join('')}</ul>` : ''}
    <form class="mini-form" id="ytOpen"><input type="text" id="ytLink" placeholder="Link YouTube / SoundCloud / Bandcamp" aria-label="Link playlist online"><button class="btn sm cyan" type="submit">Mở</button></form>
  </div>`;
}
async function setFolders(folders) {
  try {
    window.CV.S.config = await api('/api/config', {method: 'PUT', body: {music_folders: folders}});
    renderSide(); scan();
  } catch (e) { toast(e.message, 'err'); }
}
async function scan() {
  try { await api('/api/music/scan', {method: 'POST'}); } catch (e) { return toast(e.message, 'err'); }
  const tick = async () => {
    let s; try { s = await api('/api/music/scan'); } catch (e) { return; }
    const el = $('#scanState');
    if (s.running) { if (el) el.textContent = `Đang quét ${s.done}/${s.total} file…`; return setTimeout(tick, 700); }
    if (el) el.textContent = s.error ? 'Lỗi: ' + s.error : `Xong: ${s.total} file, thêm ${s.added}, bỏ ${s.removed} file không còn.`;
    loadTracks();
  };
  tick();
}
document.addEventListener('submit', async e => {
  if (e.target.id === 'newPl') {
    e.preventDefault();
    const name = $('#newPlName').value.trim(); if (!name) return;
    try { const p = await api('/api/music/playlists', {method: 'POST', body: {name}}); M.list = p.id; await loadPlaylists(); loadTracks(); toast(`Đã tạo playlist "${name}".`); }
    catch (err) { toast(err.message, 'err'); }
  } else if (e.target.id === 'olSearch') {
    e.preventDefault();
    const q = $('#olQ').value.trim(); if (!q) return $('#olQ').focus();
    M.olq = q; M.olsite = $('#olSite').value;
    searchOnline(q, M.olsite);
  } else if (e.target.id === 'ytOpen') {
    e.preventDefault();
    const src = $('#ytLink').value.trim(); if (!src) return;
    M.list = 'yt:?'; M.q = ''; $('#mSearch').value = '';
    renderSide(); loadOnline(false, src);
  } else if (e.target.id === 'addFolder') {
    e.preventDefault();
    const f = $('#folderPath').value.trim(); if (!f) return;
    setFolders([...(window.CV.S.config?.music_folders || []), f]);
  } else if (e.target.id === 'dlMusic') {
    e.preventDefault();
    const url = $('#musicUrl').value.trim(); if (!url) return;
    let playlist = $('#musicList').checked;
    try {
      await api('/api/tasks', {method: 'POST', body: {url, quality: 'audio', playlist}});
      $('#musicUrl').value = '';
      toast('Đã thêm vào hàng đợi. Bài hát tự hiện ở đây khi tải xong.');
      window.CV.refreshStatus && window.CV.refreshStatus();
    } catch (err) { toast(err.message, 'err'); }
  }
});
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-list]');
  if (a) { const v = a.dataset.list; M.list = /^\d+$/.test(v) ? +v : v; renderSide(); loadTracks(); return; }
  if (e.target.id === 'ytRefresh') return loadYt(true);
  if (e.target.id === 'ytLogin') return window.CV.ytLogin ? window.CV.ytLogin() : window.cvDesktop?.openBrowser('youtube');
  const fg = e.target.closest('[data-forget]');
  if (fg) { try { M.yt.saved = (await api('/api/music/yt/saved/' + encodeURIComponent(fg.dataset.forget), {method: 'DELETE'})).saved; } catch (err) { toast(err.message, 'err'); } renderSide(); return; }
  const yb = e.target.closest('[data-yta]');
  if (yb && M.online) {
    const o = M.online, act = yb.dataset.yta;
    if (act === 'dlall') return addTask(o.url, true, `${o.entries.length - o.local_count} bài của "${o.title}"`);
    if (act === 'reload') return loadOnline(true);
  }
  const rm = e.target.closest('[data-rmf]');
  if (rm) { const f = [...(window.CV.S.config?.music_folders || [])]; f.splice(+rm.dataset.rmf, 1); return setFolders(f); }
  if (e.target.id === 'scanBtn') return scan();
  if (e.target.id === 'miniOn') { M.settings.mini = e.target.checked; saveSettings(); return pushMini(true); }
  if (e.target.id === 'pickFolder') {
    const f = await window.cvDesktop.pickFolder();
    if (f) setFolders([...(window.CV.S.config?.music_folders || []), f]);
  }
});

/* ------------------------------------------------------------ danh sách bài */
const coverUrl = t => t.ou ? (t.thumb || (t.yt ? `https://i.ytimg.com/vi/${t.yt}/mqdefault.jpg` : '')) : t.has_cover ? `/api/music/${t.id}/cover` : '';
const absUrl = u => u && u.startsWith('/') ? location.origin + u : u;
function coverEl(t, cls = '') {
  const url = coverUrl(t);
  return `<span class="mcover ${cls}" style="background:${gradient(t.album || t.title)}">${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
}
function renderOnline() {
  const box = $('#trackList'), o = M.online || {entries: []};
  $('#mTitle').textContent = o.search ? (o.title || 'Tìm nhạc') : 'Online: ' + (o.title || '');
  $('#plTools').hidden = true; $('#mSort').hidden = true;
  const tools = $('#ytTools');
  tools.hidden = !!o.error;
  const missing = o.entries.length - (o.local_count || 0);
  tools.innerHTML = `<span class="hint">${o.entries.length} bài · ${o.local_count || 0} bài đã có trên máy${o.owner ? ' · ' + esc(o.owner) : ''}</span>
    ${missing > 0 && !o.search ? `<button class="btn sm yellow" type="button" data-yta="dlall">Tải ${missing} bài về máy (MP3)</button>` : ''}
    ${o.search ? '' : '<button class="btn sm plain" type="button" data-yta="reload">Tải lại danh sách</button>'}`;
  if (o.error) {
    box.innerHTML = `<div class="empty"><h3>${o.search ? 'Không tìm được' : 'Không mở được playlist'}</h3><p>${esc(o.error)}</p></div>`; return;
  }
  if (!M.tracks.length) { box.innerHTML = `<div class="empty"><h3>${o.entries.length ? 'Không có bài nào khớp' : o.search ? 'Không thấy bài nào' : 'Playlist trống'}</h3></div>`; return; }
  const cur = M.queue[M.qi];
  box.innerHTML = `<table class="tracks"><thead><tr><th class="n">#</th><th>Bài hát</th><th class="hide-sm">Nguồn</th><th class="tnum">Thời lượng</th><th></th></tr></thead><tbody>
    ${M.tracks.map((t, i) => { const on = sameTrack(cur, t); return `<tr data-i="${i}" class="${on ? 'playing' : ''}">
      <td class="n">${on && !audio.paused ? '<span class="eqbars" aria-label="Đang phát"><i></i><i></i><i></i></span>' : i + 1}</td>
      <td><div class="tcell">${coverEl(t)}<div><b>${esc(t.title)}</b><span>${esc(t.artist || '')}</span></div></div></td>
      <td class="hide-sm">${t.local ? '<span class="tag green">Trên máy</span>' : `<span class="tag">${esc(srcName(t))}</span>`}</td>
      <td class="tnum">${fmtDur(t.duration)}</td>
      <td class="act">${t.local ? `<button type="button" class="btn sm plain" data-addl="${i}" title="Thêm vào playlist" aria-label="Thêm vào playlist">+</button>`
        : `<button type="button" class="btn sm plain" data-dl="${i}" title="Tải bài này về máy (MP3) – tải xong thì thêm vào playlist được" aria-label="Tải về máy">⬇</button>`}</td>
    </tr>`; }).join('')}</tbody></table>`;
}
function renderTracks() {
  if (isYt(M.list)) return renderOnline();
  $('#ytTools').hidden = true; $('#mSort').hidden = false;
  const box = $('#trackList');
  const pl = typeof M.list === 'number' ? M.playlists.find(p => p.id === M.list) : null;
  $('#mTitle').textContent = pl ? `Playlist: ${pl.name}` : M.list === 'plays' ? 'Nghe nhiều nhất' : 'Tất cả bài hát';
  $('#plTools').hidden = !pl;
  if (!M.tracks.length) {
    box.innerHTML = `<div class="empty"><h3>${pl ? 'Playlist trống' : 'Chưa có bài hát nào'}</h3>
      <p>${pl ? 'Bấm "+ Thêm bài từ thư viện" ở trên, hoặc nút + ở một bài hát trong Tất cả bài hát.' : 'Dán link YouTube ở ô "Tải nhạc" phía trên, hoặc thêm thư mục nhạc có sẵn trên máy ở cột bên trái rồi bấm Quét lại nhạc.'}</p></div>`;
    return;
  }
  const cur = M.queue[M.qi];
  box.innerHTML = `<table class="tracks"><thead><tr><th class="n">#</th><th>Bài hát</th><th class="hide-sm">Album</th><th class="tnum">Thời lượng</th><th class="tnum hide-sm">Lượt nghe</th><th></th></tr></thead><tbody>
    ${M.tracks.map((t, i) => `<tr data-i="${i}" class="${sameTrack(cur, t) ? 'playing' : ''}">
      <td class="n">${sameTrack(cur, t) && !audio.paused ? '<span class="eqbars" aria-label="Đang phát"><i></i><i></i><i></i></span>' : i + 1}</td>
      <td><div class="tcell">${coverEl(t)}<div><b>${esc(t.title)}</b><span>${esc(t.artist || 'Không rõ ca sĩ')}</span></div></div></td>
      <td class="hide-sm">${esc(t.album || '')}</td>
      <td class="tnum">${fmtDur(t.duration)}</td>
      <td class="tnum hide-sm">${t.play_count || ''}</td>
      <td class="act"><button type="button" class="btn sm plain" data-add="${i}" title="Thêm vào playlist" aria-label="Thêm vào playlist">+</button>${pl ? `<button type="button" class="btn sm plain" data-rmt="${t.id}" title="Bỏ khỏi playlist" aria-label="Bỏ khỏi playlist">×</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}
$('#trackList').addEventListener('click', async e => {
  const dl = e.target.closest('[data-dl]');
  if (dl) { e.stopPropagation(); const t = M.tracks[+dl.dataset.dl]; return addTask(t.ou, false, `"${t.title}"`); }
  const addl = e.target.closest('[data-addl]');
  if (addl) { e.stopPropagation(); const t = M.tracks[+addl.dataset.addl]; return pickPlaylist({id: t.local, title: t.title}); }
  const add = e.target.closest('[data-add]');
  if (add) { e.stopPropagation(); return pickPlaylist(M.tracks[+add.dataset.add]); }
  const rmt = e.target.closest('[data-rmt]');
  if (rmt) {
    e.stopPropagation();
    await api(`/api/music/playlists/${M.list}/tracks/${rmt.dataset.rmt}`, {method: 'DELETE'}).catch(err => toast(err.message, 'err'));
    loadPlaylists(); return loadTracks();
  }
  const row = e.target.closest('tr[data-i]');
  if (row) playList(M.tracks, +row.dataset.i);
});

function pickPlaylist(track) {
  const dlg = $('#plPick');
  $('#plPickTitle').textContent = `Thêm "${track.title}" vào playlist`;
  $('#plPickList').innerHTML = (M.playlists.length
    ? M.playlists.map(p => `<button type="button" class="btn plain" data-pp="${p.id}">${esc(p.name)} <span class="hint">(${p.count})</span></button>`).join('')
    : '<p class="hint">Chưa có playlist nào.</p>')
    + `<form class="mini-form" id="plPickNew"><input type="text" placeholder="Hoặc tạo playlist mới…" maxlength="80" aria-label="Tên playlist mới"><button class="btn sm yellow" type="submit">Tạo &amp; thêm</button></form>`;
  const addTo = async pid => {
    try {
      await api(`/api/music/playlists/${pid}/tracks`, {method: 'POST', body: {track_ids: [track.id]}});
      toast('Đã thêm vào playlist.'); dlg.close(); loadPlaylists();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#plPickList').onclick = e => { const b = e.target.closest('[data-pp]'); if (b) addTo(b.dataset.pp); };
  $('#plPickNew').onsubmit = async e => {
    e.preventDefault();
    const name = e.target.querySelector('input').value.trim(); if (!name) return;
    try { const p = await api('/api/music/playlists', {method: 'POST', body: {name}}); addTo(p.id); } catch (err) { toast(err.message, 'err'); }
  };
  dlg.showModal();
}

/* ------------------------------------------------------------ phát nhạc */
function playList(list, index) {
  M.queue = list.slice();
  if (M.shuffle) {
    const first = M.queue.splice(index, 1)[0];
    for (let i = M.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [M.queue[i], M.queue[j]] = [M.queue[j], M.queue[i]]; }
    M.queue.unshift(first); index = 0;
  }
  playAt(index);
}
async function playAt(i) {
  if (i < 0 || i >= M.queue.length) return;
  M.qi = i;
  const t = M.queue[i], my = ++M.pseq;
  M.opening = '';
  engine.resume();
  const localId = t.ou ? t.local : t.id;
  renderBar(); renderTracks(); mediaSession(t);
  if (localId) {
    audio.src = `/api/music/${localId}/file`;
    api(`/api/music/${localId}/played`, {method: 'POST'}).catch(() => {});
    if (!t.ou) t.play_count = (t.play_count || 0) + 1;
  } else {
    M.opening = keyOf(t);
    audio.pause(); renderBar();
    try {
      const r = await api(`/api/music/yt/prepare?u=${enc(t.ou)}`, {method: 'POST'});
      if (r.preview && my === M.pseq) toast(`"${t.title}" chỉ có đoạn nghe thử (bài dành cho tài khoản trả phí).`);
    }
    catch (err) {
      if (my !== M.pseq) return;
      M.opening = '';
      toast(`Không nghe online được "${t.title}": ${err.message}`, 'err');
      if (++M.errRun < 5 && M.qi + 1 < M.queue.length) setTimeout(() => { if (my === M.pseq) playAt(M.qi + 1); }, 1200);
      renderBar(); return;
    }
    if (my !== M.pseq) return;
    M.opening = '';
    audio.src = `/api/music/yt/stream?u=${enc(t.ou)}`;
  }
  audio.play().catch(err => { if (err.name !== 'AbortError') toast('Không phát được bài này: ' + err.message, 'err'); });
  renderBar();
}
function prefetchNext() {   // lấy sẵn link bài online tiếp theo để chuyển bài nhanh
  const n = M.queue[M.qi + 1];
  if (n && n.ou && !n.local && !n._pre) { n._pre = 1; api(`/api/music/yt/prepare?u=${enc(n.ou)}`, {method: 'POST'}).catch(() => { n._pre = 0; }); }
}
function next(auto) {
  if (!M.queue.length) return;
  if (auto && M.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (M.qi + 1 < M.queue.length) playAt(M.qi + 1);
  else if (M.repeat === 'all' || !auto) playAt(0);
  else { renderBar(); renderTracks(); }
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playAt(M.qi > 0 ? M.qi - 1 : M.queue.length - 1);
}
function togglePlay() {
  if (!audio.src) { if (M.tracks.length) playList(M.tracks, 0); return; }
  engine.resume();
  audio.paused ? audio.play() : audio.pause();
}
audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => { renderBar(); renderTracks(); });
audio.addEventListener('pause', () => { renderBar(); renderTracks(); });
audio.addEventListener('playing', () => { M.errRun = 0; prefetchNext(); });
audio.addEventListener('error', () => {
  if (!audio.src || !audio.getAttribute('src')) return;
  const t = M.queue[M.qi];
  toast(t && t.ou && !t.local ? `Bài online bị ngắt hoặc ${srcName(t)} chặn, chuyển bài tiếp.` : 'File nhạc lỗi hoặc không còn trên ổ, chuyển bài tiếp.', 'err');
  if (++M.errRun < 5) setTimeout(() => next(true), 800);
});
audio.addEventListener('volumechange', () => pushMini());
audio.addEventListener('timeupdate', updateSeek);
audio.addEventListener('loadedmetadata', updateSeek);

function mediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const art = coverUrl(t) ? [{src: absUrl(coverUrl(t)), sizes: '512x512'}] : [];
  navigator.mediaSession.metadata = new MediaMetadata({title: t.title, artist: t.artist || '', album: t.album || '', artwork: art});
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => { engine.resume(); audio.play(); });
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', () => next(false));
  try { ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; }); } catch (e) { /* trình duyệt cũ */ }
}

/* ------------------------------------------------------------ thanh phát nhạc */
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 11V8a2 2 0 0 1 2-2h13l-3-3M20 13v3a2 2 0 0 1-2 2H5l3 3"/></svg>',
};
function renderBar() {
  const t = M.queue[M.qi], bar = $('#playerBar');
  if (!t) { bar.hidden = true; document.body.classList.remove('has-player'); return; }
  bar.hidden = false; document.body.classList.add('has-player');
  $('#pbCover').innerHTML = coverEl(t, 'lg');
  $('#pbTitle').textContent = t.title;
  $('#pbArtist').textContent = M.opening === keyOf(t) ? `Đang mở bài từ ${srcName(t)}…` : (t.artist || (t.ou ? srcName(t) : 'Không rõ ca sĩ'));
  $('#pbPlay').innerHTML = audio.paused ? ICON.play : ICON.pause;
  $('#pbPlay').setAttribute('aria-label', audio.paused ? 'Phát' : 'Tạm dừng');
  $('#pbShuffle').classList.toggle('on', M.shuffle);
  $('#pbRepeat').classList.toggle('on', M.repeat !== 'off');
  $('#pbRepeat').dataset.one = M.repeat === 'one' ? '1' : '';
  $('#pbRepeat').title = {off: 'Không lặp', all: 'Lặp cả danh sách', one: 'Lặp 1 bài'}[M.repeat];
  $('#pbEq').classList.toggle('on', !!(M.eq && M.eq.state.enabled));
  document.title = `${audio.paused ? '' : '▶ '}${t.title} · CircleVault`;
  pushMini(true);
}

/* ------------------------------------------------------------ trình phát mini (app desktop, khi thu nhỏ) */
let miniAt = 0;
function pushMini(force) {
  const d = window.cvDesktop; if (!d || !d.musicState) return;
  const now = Date.now();
  if (!force && now - miniAt < 900) return;
  miniAt = now;
  const t = M.queue[M.qi];
  d.musicState(t ? {
    has: true, title: t.title, artist: M.opening === keyOf(t) ? `Đang mở bài từ ${srcName(t)}…` : (t.artist || (t.ou ? srcName(t) : 'Không rõ ca sĩ')), cover: absUrl(coverUrl(t)) || '',
    playing: !audio.paused, cur: audio.currentTime || 0, dur: audio.duration || t.duration || 0,
    shuffle: M.shuffle, repeat: M.repeat, volume: audio.volume, muted: audio.muted, mini: M.settings.mini !== false,
  } : {has: false, mini: M.settings.mini !== false});
}
if (window.cvDesktop && window.cvDesktop.onMusicCmd) {
  window.cvDesktop.onMusicCmd(m => {
    switch (m && m.a) {
      case 'toggle': return togglePlay();
      case 'prev': return prev();
      case 'next': return next(false);
      case 'seek': if (isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(audio.duration, +m.v || 0)); return pushMini(true);
      case 'shuffle': M.shuffle = !M.shuffle; renderBar(); return saveSettings();
      case 'repeat': M.repeat = {off: 'all', all: 'one', one: 'off'}[M.repeat]; renderBar(); return saveSettings();
      case 'vol': audio.volume = Math.max(0, Math.min(1, +m.v)); audio.muted = false; $('#pbVol').value = audio.volume; $('#pbVol').style.setProperty('--p', audio.volume * 100 + '%'); saveSettings(); return pushMini(true);
      case 'mute': audio.muted = !audio.muted; return pushMini(true);
      case 'state': return pushMini(true);
      default:
    }
  });
}
function updateSeek() {
  pushMini();
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('#pbSeek').max = d || 1; $('#pbSeek').value = c;
  $('#pbSeek').style.setProperty('--p', d ? (c / d * 100) + '%' : '0%');
  $('#pbCur').textContent = fmtDur(c) || '0:00'; $('#pbDur').textContent = fmtDur(d) || '0:00';
}
function initBar() {
  $('#pbPrev').innerHTML = ICON.prev; $('#pbNext').innerHTML = ICON.next;
  $('#pbShuffle').innerHTML = ICON.shuffle; $('#pbRepeat').innerHTML = ICON.repeat;
  $('#pbPlay').addEventListener('click', togglePlay);
  $('#pbPrev').addEventListener('click', prev);
  $('#pbNext').addEventListener('click', () => next(false));
  $('#pbShuffle').addEventListener('click', () => { M.shuffle = !M.shuffle; renderBar(); saveSettings(); });
  $('#pbRepeat').addEventListener('click', () => { M.repeat = {off: 'all', all: 'one', one: 'off'}[M.repeat]; renderBar(); saveSettings(); });
  $('#pbSeek').addEventListener('input', e => { audio.currentTime = +e.target.value; });
  $('#pbVol').addEventListener('input', e => { audio.volume = +e.target.value; $('#pbVol').style.setProperty('--p', audio.volume * 100 + '%'); saveSettings(); });
  $('#pbEq').addEventListener('click', () => {
    if (location.hash !== '#music') location.hash = '#music';
    setTimeout(() => $('#eqPanel').scrollIntoView({behavior: 'smooth', block: 'start'}), 80);
  });
  $('#pbInfo').addEventListener('click', () => { location.hash = '#music'; });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' && M.queue.length) { e.preventDefault(); togglePlay(); }
  });
}

/* ------------------------------------------------------------ trang */
$('#mSearch').addEventListener('input', () => { clearTimeout(M._qt); M._qt = setTimeout(() => {
  M.q = $('#mSearch').value.trim();
  if (isYt(M.list) && M.online) { M.tracks = filterQ(M.online.entries); renderTracks(); } else loadTracks();
}, 250); });
$('#mSort').addEventListener('change', e => { M.sort = e.target.value; loadTracks(); });
$('#playAll').addEventListener('click', () => { if (M.tracks.length) playList(M.tracks, 0); });
$('#shuffleAll').addEventListener('click', () => {
  if (!M.tracks.length) return;
  M.shuffle = true; playList(M.tracks, Math.floor(Math.random() * M.tracks.length)); saveSettings();
});
$('#plRename').addEventListener('click', async () => {
  const pl = M.playlists.find(p => p.id === M.list); if (!pl) return;
  const inp = $('#plNewName');
  if (inp.hidden) { inp.hidden = false; inp.value = pl.name; inp.focus(); $('#plRename').textContent = 'Lưu tên'; return; }
  await api(`/api/music/playlists/${pl.id}`, {method: 'PUT', body: {name: inp.value}}).catch(err => toast(err.message, 'err'));
  inp.hidden = true; $('#plRename').textContent = 'Đổi tên'; loadPlaylists(); loadTracks();
});
$('#plDelete').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa để xóa'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Xóa playlist'; }, 4000); return; }
  await api(`/api/music/playlists/${M.list}`, {method: 'DELETE'}).catch(err => toast(err.message, 'err'));
  b.dataset.confirm = ''; b.textContent = 'Xóa playlist';
  M.list = 'all'; loadPlaylists(); loadTracks(); toast('Đã xóa playlist (bài hát vẫn còn).');
});
$('#plPickClose').addEventListener('click', () => $('#plPick').close());

async function addFromLibrary() {
  const pl = M.playlists.find(p => p.id === M.list); if (!pl) return;
  let dlg = $('#plAddDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'plAddDlg'; dlg.className = 'box pl-add'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<div class="dlg-head"><h3>Thêm bài vào "${esc(pl.name)}"</h3><button class="btn plain iconbtn" type="button" data-x aria-label="Đóng">✕</button></div>
    <div class="btn-row"><input type="search" id="paQ" placeholder="Tìm bài, ca sĩ, album" aria-label="Tìm trong thư viện"><button class="btn sm plain" type="button" id="paAll">Chọn hết đang hiện</button></div>
    <div class="pa-list" id="paList"><p class="hint">Đang tải thư viện…</p></div>
    <div class="row-between"><span class="hint" id="paCount">Chưa chọn bài nào</span><button class="btn green" type="button" id="paGo" disabled>THÊM VÀO PLAYLIST</button></div>`;
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  dlg.showModal();
  let all = [], inPl = new Set();
  try {
    [all, inPl] = await Promise.all([api('/api/music/tracks?sort=title'), api(`/api/music/tracks?playlist=${pl.id}`).then(r => new Set(r.map(t => t.id)))]);
  } catch (e) { $('#paList').innerHTML = `<p class="no">${esc(e.message)}</p>`; return; }
  const picked = new Set();
  const shown = () => {
    const q = $('#paQ').value.trim().toLowerCase();
    return all.filter(t => !q || [t.title, t.artist, t.album].some(x => (x || '').toLowerCase().includes(q))).slice(0, 400);
  };
  const paint = () => {
    const list = shown();
    $('#paList').innerHTML = list.length ? list.map(t => `<label class="pa-row ${inPl.has(t.id) ? 'had' : ''}">
        <input type="checkbox" value="${t.id}" ${inPl.has(t.id) || picked.has(t.id) ? 'checked' : ''} ${inPl.has(t.id) ? 'disabled' : ''}>
        ${coverEl(t)}<span class="pa-t"><b>${esc(t.title)}</b><span>${esc(t.artist || 'Không rõ ca sĩ')}${inPl.has(t.id) ? ' · đã có trong playlist' : ''}</span></span>
        <span class="tnum hint">${fmtDur(t.duration)}</span></label>`).join('')
      : `<p class="hint">${all.length ? 'Không có bài nào khớp.' : 'Thư viện chưa có bài nào.'}</p>`;
    $('#paCount').textContent = picked.size ? `Đã chọn ${picked.size} bài` : 'Chưa chọn bài nào';
    $('#paGo').disabled = !picked.size;
    $('#paGo').textContent = picked.size ? `THÊM ${picked.size} BÀI` : 'THÊM VÀO PLAYLIST';
  };
  $('#paList').onchange = e => {
    const c = e.target.closest('input[type=checkbox]'); if (!c) return;
    c.checked ? picked.add(+c.value) : picked.delete(+c.value);
    paint();
  };
  $('#paQ').oninput = () => paint();
  $('#paAll').onclick = () => { shown().forEach(t => { if (!inPl.has(t.id)) picked.add(t.id); }); paint(); };
  $('#paGo').onclick = async () => {
    const ids = all.filter(t => picked.has(t.id)).map(t => t.id);
    try {
      await api(`/api/music/playlists/${pl.id}/tracks`, {method: 'POST', body: {track_ids: ids}});
      toast(`Đã thêm ${ids.length} bài vào "${pl.name}".`); dlg.close(); await loadPlaylists(); loadTracks();
    } catch (e) { toast(e.message, 'err'); }
  };
  paint();
  $('#paQ').focus();
}
$('#plAddFrom').addEventListener('click', addFromLibrary);

async function initOnce() {
  if (M.loaded) return;
  M.loaded = true;
  try { M.settings = await api('/api/music/settings'); } catch (e) { M.settings = {}; }
  audio.volume = M.settings.volume ?? 0.9;
  $('#pbVol').value = audio.volume; $('#pbVol').style.setProperty('--p', audio.volume * 100 + '%');
  M.shuffle = !!M.settings.shuffle; M.repeat = M.settings.repeat || 'off';
  M.eq = window.CV.eq.createEQ({mount: $('#eqPanel'), engine, initial: M.settings.eq, onChange: () => { renderBar(); saveSettings(); }});
}

window.CV.views.music = async () => {
  await initOnce();
  renderSide(); loadPlaylists(); loadTracks();
  if (!M.yt.loaded) { M.yt.loaded = true; loadYt(false); }
  M.eq && M.eq.redraw();
};
if (window.cvDesktop && window.cvDesktop.onYoutubeLogin) window.cvDesktop.onYoutubeLogin(() => { if (M.yt.loaded) loadYt(true); });
window.addEventListener('cv-youtube', () => { if (M.yt.loaded) loadYt(true); });
window.CV.music = {reload: () => { if (M.loaded) loadTracks(); }, initOnce};
initBar();
initOnce();   // nạp cài đặt EQ ngay để thanh phát nhạc dùng được ở mọi trang
})();
