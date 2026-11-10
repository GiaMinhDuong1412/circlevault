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
};

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
    <div><h4>Thư mục nhạc trên máy</h4>
      <ul class="folders">${folders.map((f, i) => `<li><span title="${esc(f)}">${esc(f)}</span><button type="button" class="chip-x" data-rmf="${i}" aria-label="Bỏ thư mục">×</button></li>`).join('') || '<li class="hint">Chưa thêm thư mục nào. Nhạc tải từ YouTube luôn có sẵn ở đây.</li>'}</ul>
      <form class="mini-form" id="addFolder">
        <input type="text" id="folderPath" placeholder="D:\\Nhac" aria-label="Đường dẫn thư mục nhạc">
        <button class="btn sm plain" type="submit">Thêm</button>
      </form>
      ${window.cvDesktop?.pickFolder ? '<button class="btn sm cyan" type="button" id="pickFolder">Chọn thư mục…</button>' : ''}
      <button class="btn sm green" type="button" id="scanBtn">Quét lại nhạc</button>
      <p class="hint" id="scanState"></p>
    </div>`;
  if (typeof M.list === 'number' && !M.playlists.some(p => p.id === M.list)) M.list = 'all';
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
  const rm = e.target.closest('[data-rmf]');
  if (rm) { const f = [...(window.CV.S.config?.music_folders || [])]; f.splice(+rm.dataset.rmf, 1); return setFolders(f); }
  if (e.target.id === 'scanBtn') return scan();
  if (e.target.id === 'pickFolder') {
    const f = await window.cvDesktop.pickFolder();
    if (f) setFolders([...(window.CV.S.config?.music_folders || []), f]);
  }
});

/* ------------------------------------------------------------ danh sách bài */
const coverUrl = t => t.has_cover ? `/api/music/${t.id}/cover` : '';
function coverEl(t, cls = '') {
  const url = coverUrl(t);
  return `<span class="mcover ${cls}" style="background:${gradient(t.album || t.title)}">${url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}
function renderTracks() {
  const box = $('#trackList');
  const pl = typeof M.list === 'number' ? M.playlists.find(p => p.id === M.list) : null;
  $('#mTitle').textContent = pl ? `Playlist: ${pl.name}` : M.list === 'plays' ? 'Nghe nhiều nhất' : 'Tất cả bài hát';
  $('#plTools').hidden = !pl;
  if (!M.tracks.length) {
    box.innerHTML = `<div class="empty"><h3>${pl ? 'Playlist trống' : 'Chưa có bài hát nào'}</h3>
      <p>${pl ? 'Bấm nút + ở một bài hát để thêm vào playlist này.' : 'Dán link YouTube ở ô "Tải nhạc" phía trên, hoặc thêm thư mục nhạc có sẵn trên máy ở cột bên trái rồi bấm Quét lại nhạc.'}</p></div>`;
    return;
  }
  const cur = M.queue[M.qi];
  box.innerHTML = `<table class="tracks"><thead><tr><th class="n">#</th><th>Bài hát</th><th class="hide-sm">Album</th><th class="tnum">Thời lượng</th><th class="tnum hide-sm">Lượt nghe</th><th></th></tr></thead><tbody>
    ${M.tracks.map((t, i) => `<tr data-i="${i}" class="${cur && cur.id === t.id ? 'playing' : ''}">
      <td class="n">${cur && cur.id === t.id && !audio.paused ? '<span class="eqbars" aria-label="Đang phát"><i></i><i></i><i></i></span>' : i + 1}</td>
      <td><div class="tcell">${coverEl(t)}<div><b>${esc(t.title)}</b><span>${esc(t.artist || 'Không rõ ca sĩ')}</span></div></div></td>
      <td class="hide-sm">${esc(t.album || '')}</td>
      <td class="tnum">${fmtDur(t.duration)}</td>
      <td class="tnum hide-sm">${t.play_count || ''}</td>
      <td class="act"><button type="button" class="btn sm plain" data-add="${i}" title="Thêm vào playlist" aria-label="Thêm vào playlist">+</button>${pl ? `<button type="button" class="btn sm plain" data-rmt="${t.id}" title="Bỏ khỏi playlist" aria-label="Bỏ khỏi playlist">×</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}
$('#trackList').addEventListener('click', async e => {
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
  $('#plPickList').innerHTML = M.playlists.length
    ? M.playlists.map(p => `<button type="button" class="btn plain" data-pp="${p.id}">${esc(p.name)} <span class="hint">(${p.count})</span></button>`).join('')
    : '<p class="hint">Chưa có playlist. Tạo playlist ở cột bên trái trước.</p>';
  $('#plPickList').onclick = async e => {
    const b = e.target.closest('[data-pp]'); if (!b) return;
    try {
      await api(`/api/music/playlists/${b.dataset.pp}/tracks`, {method: 'POST', body: {track_ids: [track.id]}});
      toast('Đã thêm vào playlist.'); dlg.close(); loadPlaylists();
    } catch (err) { toast(err.message, 'err'); }
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
function playAt(i) {
  if (i < 0 || i >= M.queue.length) return;
  M.qi = i;
  const t = M.queue[i];
  engine.resume();
  audio.src = `/api/music/${t.id}/file`;
  audio.play().catch(err => toast('Không phát được bài này: ' + err.message, 'err'));
  api(`/api/music/${t.id}/played`, {method: 'POST'}).catch(() => {});
  t.play_count = (t.play_count || 0) + 1;
  renderBar(); renderTracks(); mediaSession(t);
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
audio.addEventListener('error', () => { if (audio.src) toast('File nhạc lỗi hoặc không còn trên ổ, chuyển bài tiếp.', 'err'); setTimeout(() => next(true), 800); });
audio.addEventListener('timeupdate', updateSeek);
audio.addEventListener('loadedmetadata', updateSeek);

function mediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const art = coverUrl(t) ? [{src: location.origin + coverUrl(t), sizes: '512x512'}] : [];
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
  $('#pbArtist').textContent = t.artist || 'Không rõ ca sĩ';
  $('#pbPlay').innerHTML = audio.paused ? ICON.play : ICON.pause;
  $('#pbPlay').setAttribute('aria-label', audio.paused ? 'Phát' : 'Tạm dừng');
  $('#pbShuffle').classList.toggle('on', M.shuffle);
  $('#pbRepeat').classList.toggle('on', M.repeat !== 'off');
  $('#pbRepeat').dataset.one = M.repeat === 'one' ? '1' : '';
  $('#pbRepeat').title = {off: 'Không lặp', all: 'Lặp cả danh sách', one: 'Lặp 1 bài'}[M.repeat];
  $('#pbEq').classList.toggle('on', !!(M.eq && M.eq.state.enabled));
  document.title = `${audio.paused ? '' : '▶ '}${t.title} · CircleVault`;
}
function updateSeek() {
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
$('#mSearch').addEventListener('input', () => { clearTimeout(M._qt); M._qt = setTimeout(() => { M.q = $('#mSearch').value.trim(); loadTracks(); }, 250); });
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
  M.eq && M.eq.redraw();
};
window.CV.music = {reload: () => { if (M.loaded) loadTracks(); }, initOnce};
initBar();
initOnce();   // nạp cài đặt EQ ngay để thanh phát nhạc dùng được ở mọi trang
})();
