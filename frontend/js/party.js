/* CircleVault – trang phòng xem chung (bạn bè mở bằng trình duyệt bất kỳ, không cần cài app).
 * Đồng bộ: máy chủ giữ {playing, pos, rate, at}; mỗi máy tự tính vị trí đúng theo đồng hồ máy chủ (ước lượng bằng ping)
 * rồi tua (lệch nhiều) hoặc chỉnh tốc độ rất nhẹ (lệch ít, chỉ với file phim) để bắt kịp. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const store = {get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } }};
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const EMOJI = ['❤️', '😂', '😮', '😢', '👏', '🔥'];

const token = location.pathname.split('/')[2];
const hostKey = new URLSearchParams(location.search).get('host');
let ws = null, me = null, room = null, player = null, closed = false, name = '';
let offset = 0, bestRtt = Infinity, dragging = false, loadingSrc = null;
const nowS = () => Date.now() / 1000 + offset;
const expected = st => st.pos + (st.playing ? (nowS() - st.at) * st.rate : 0);

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast box ${kind}`; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000);
}
function stageMsg(html, btn) {
  const el = $('#stageMsg');
  if (!html) { el.hidden = true; return; }
  el.innerHTML = `<div>${html}${btn ? `<div><button class="btn yellow" type="button" id="msgBtn">${esc(btn.label)}</button></div>` : ''}</div>`;
  el.hidden = false;
  if (btn) $('#msgBtn').onclick = btn.on;
}

/* ------------------------------------------------------------ trình phát */
function filePlayer(src) {
  const holder = $('#player');
  holder.className = 'player' + (src.audio ? ' audio' : '');
  holder.innerHTML = src.audio ? `<div>${esc(src.title)}</div>` : '';
  const v = document.createElement(src.audio ? 'audio' : 'video');
  v.src = `/r/${token}/media`; v.preload = 'auto'; v.playsInline = true;
  holder.appendChild(v);
  v.addEventListener('waiting', () => { $('#ctlNote').textContent = 'Đang tải phim từ máy chủ phòng…'; });
  v.addEventListener('playing', () => { $('#ctlNote').textContent = ctlNote(); });
  v.addEventListener('error', () => stageMsg('Trình duyệt này không phát được file phim. Thử Chrome hoặc Edge bản mới.'));
  return {
    kind: 'file',
    play: () => v.play().catch(e => { if (e.name === 'NotAllowedError') needGesture(); }),
    pause: () => v.pause(),
    seek: t => { v.currentTime = t; },
    time: () => v.currentTime || 0,
    duration: () => (isFinite(v.duration) ? v.duration : 0),
    playing: () => !v.paused && !v.ended,
    setRate: r => { v.playbackRate = r; },
    setVolume: x => { v.volume = x; },
    destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); holder.innerHTML = ''; },
  };
}
let ytReady = null;
function loadYT() {
  if (!ytReady) ytReady = new Promise((res, rej) => {
    if (window.YT && window.YT.Player) return res();
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => rej(new Error('Không tải được trình phát YouTube. Kiểm tra mạng.'));
    document.head.appendChild(s);
  });
  return ytReady;
}
async function ytPlayer(src) {
  await loadYT();
  const holder = $('#player');
  holder.className = 'player'; holder.innerHTML = '<div id="ytFrame"></div>';
  return new Promise(res => {
    let p = null;
    const api = {
      kind: 'youtube',
      play: () => p.playVideo(), pause: () => p.pauseVideo(),
      seek: t => p.seekTo(t, true),
      time: () => (p.getCurrentTime ? p.getCurrentTime() || 0 : 0),
      duration: () => (p.getDuration ? p.getDuration() || 0 : 0),
      playing: () => [1, 3].includes(p.getPlayerState ? p.getPlayerState() : -1),
      setRate: r => p.setPlaybackRate(r), setVolume: x => p.setVolume(Math.round(x * 100)),
      destroy: () => { try { p.destroy(); } catch (e) { /* bỏ qua */ } holder.innerHTML = ''; },
    };
    p = new window.YT.Player('ytFrame', {
      videoId: src.video_id, width: '100%', height: '100%',
      playerVars: {controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, origin: location.origin},
      events: {
        onReady: () => res(api),
        onError: e => stageMsg(`YouTube không cho phát video này trong phòng (mã ${esc(e.data)}). Chủ phòng hãy chọn video khác.`),
      },
    });
  });
}
async function loadSource() {
  const src = room.source, key = JSON.stringify(src);
  if (loadingSrc === key) return;
  loadingSrc = key;
  if (player) { player.destroy(); player = null; }
  $('#roomTitle').textContent = room.title;
  document.title = `${room.title} · Xem chung`;
  stageMsg('');
  try {
    player = src.type === 'youtube' ? await ytPlayer(src) : filePlayer(src);
    player.setVolume(+$('#cVol').value);
    apply(true);
  } catch (e) { stageMsg(esc(e.message)); loadingSrc = null; }
}
function needGesture() {
  stageMsg('Trình duyệt cần bạn bấm một lần để phát có tiếng.', {label: 'Xem cùng mọi người', on: () => { stageMsg(''); player.play(); apply(true); }});
}

/* ------------------------------------------------------------ đồng bộ */
function apply(force) {
  if (!player || !room) return;
  const st = room.state, dur = player.duration();
  let target = expected(st);
  if (dur) target = Math.min(target, Math.max(0, dur - 0.3));
  if (st.playing && !player.playing()) player.play();
  if (!st.playing && player.playing()) player.pause();
  const drift = player.time() - target;
  const limit = player.kind === 'youtube' ? 1.2 : (st.playing ? 0.8 : 0.25);
  if (force ? Math.abs(drift) > 0.15 : Math.abs(drift) > limit) {
    player.seek(target);
    if (player.kind === 'file') player.setRate(st.rate);
  } else if (player.kind === 'file' && st.playing) {
    // lệch ít: chạy nhanh/chậm hơn tối đa 8% cho tới khi khớp, không giật hình
    player.setRate(Math.abs(drift) < 0.08 ? st.rate : st.rate * (1 - Math.max(-0.08, Math.min(0.08, drift * 0.25))));
  } else if (player.kind === 'youtube' && force) {
    player.setRate(st.rate);
  }
}
function renderCtl() {
  if (!player || !room) return;
  const t = player.time(), d = player.duration();
  $('#cPlay').innerHTML = room.state.playing ? ICON_PAUSE : ICON_PLAY;
  $('#cPlay').setAttribute('aria-label', room.state.playing ? 'Tạm dừng' : 'Phát');
  $('#cCur').textContent = fmt(t); $('#cDur').textContent = fmt(d);
  if (!dragging) { $('#cSeek').max = d || 1; $('#cSeek').value = t; }
  $('#cSeek').style.setProperty('--p', d ? (($('#cSeek').value / d) * 100) + '%' : '0%');
}
setInterval(() => { apply(false); renderCtl(); }, 600);

const canControl = () => room && me && (room.control === 'everyone' || me.host);
const ctlNote = () => (room && me && !canControl()) ? 'Chủ phòng điều khiển phim. Bạn vẫn chỉnh được âm lượng của mình.'
  : 'Ai trong phòng bấm phát, tạm dừng hay tua thì cả phòng cùng theo.';
function control(a, pos) {
  if (!canControl()) return toast('Chỉ chủ phòng được điều khiển phim.', 'err');
  const p = pos ?? (player ? player.time() : 0);
  room.state = {...room.state, playing: a === 'play' ? true : a === 'pause' ? false : room.state.playing, pos: p, at: nowS()};
  apply(true); renderCtl();
  send({t: 'ctl', a, pos: p});
}

/* ------------------------------------------------------------ kết nối */
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/r/${token}/ws`);
  ws.onopen = () => {
    send({t: 'hello', name, host_key: hostKey || undefined});
    let n = 0; const burst = setInterval(() => { send({t: 'ping', c: Date.now() / 1000}); if (++n >= 6) clearInterval(burst); }, 250);
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'pong': {
        const t = Date.now() / 1000, rtt = t - m.c;
        if (rtt <= bestRtt + 0.03) { bestRtt = Math.min(bestRtt, rtt); offset = m.s + rtt / 2 - t; }
        break;
      }
      case 'welcome':
        me = m.you; room = m.room;
        offset = m.server - Date.now() / 1000;
        $('#chatLog').innerHTML = '';
        room.chat.forEach(addChat);
        renderMembers(room.members); renderWho(); loadSource();
        $('#ctlNote').textContent = ctlNote();
        break;
      case 'source':
        room = {...m.room, chat: room ? room.chat : []};
        sys(`Chủ phòng đổi sang: ${room.title}`); loadSource(); $('#ctlNote').textContent = ctlNote();
        break;
      case 'state': {
        room.state = m.state;
        apply(true); renderCtl();
        const verb = {play: 'phát tiếp', pause: 'tạm dừng', seek: `tua tới ${fmt(m.state.pos)}`, rate: `đổi tốc độ ${m.state.rate}x`}[m.a];
        if (verb && m.by !== me.name) sys(`${m.by} ${verb}`);
        break;
      }
      case 'members':
        room.members = m.list; renderMembers(m.list);
        if (m.joined && m.joined !== me.name) sys(`${m.joined} vào phòng`);
        if (m.left) sys(`${m.left} rời phòng`);
        break;
      case 'chat': addChat(m.msg); break;
      case 'react': fly(m.e, m.name); break;
      case 'notice': toast(m.text, 'err'); break;
      case 'closed':
        closed = true;
        if (player) player.pause();
        stageMsg('Chủ phòng đã đóng phòng xem chung. Cảm ơn bạn đã xem cùng!');
        break;
    }
  };
  ws.onclose = () => {
    if (closed) return;
    $('#ctlNote').textContent = 'Mất kết nối, đang nối lại…';
    setTimeout(connect, 2000);
  };
}
setInterval(() => send({t: 'ping', c: Date.now() / 1000}), 10000);

/* ------------------------------------------------------------ giao diện */
function renderMembers(list) {
  $('#mCount').textContent = `(${list.length})`;
  $('#mList').innerHTML = list.map(x => `<li class="${x.host ? 'host' : ''} ${me && x.id === me.id ? 'me' : ''}">${esc(x.name)}${x.host ? ' · chủ phòng' : ''}</li>`).join('');
}
function renderWho() {
  $('#whoBox').innerHTML = me.host ? '<span class="badge" style="background:var(--yellow)">Bạn là chủ phòng</span>'
    : `<span>Bạn là <b>${esc(me.name)}</b></span>`;
}
function addChat(msg) {
  const log = $('#chatLog');
  const d = document.createElement('div');
  d.className = 'm' + (msg.host ? ' host' : '');
  d.innerHTML = `<b>${esc(msg.name)}</b>${esc(msg.text)}`;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function sys(text) {
  const log = $('#chatLog');
  const d = document.createElement('div');
  d.className = 'sys'; d.textContent = text;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function fly(e, who) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return sys(`${who}: ${e}`);
  const el = document.createElement('div');
  el.className = 'react-fly';
  el.style.left = (10 + Math.random() * 80) + '%';
  el.innerHTML = `${e}<span>${esc(who)}</span>`;
  $('#reactLayer').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

$('#cPlay').addEventListener('click', () => control(room && room.state.playing ? 'pause' : 'play'));
$('#cSeek').addEventListener('input', () => { dragging = true; $('#cCur').textContent = fmt(+$('#cSeek').value); });
$('#cSeek').addEventListener('change', () => { dragging = false; control('seek', +$('#cSeek').value); });
$('#cVol').addEventListener('input', e => { if (player) player.setVolume(+e.target.value); $('#cVol').style.setProperty('--p', e.target.value * 100 + '%'); });
$('#cVol').style.setProperty('--p', '100%');
$('#cSync').addEventListener('click', () => { apply(true); toast('Đã tua về đúng chỗ cả phòng đang xem.'); });
$('#cFull').addEventListener('click', () => { const s = $('#stage'); (document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen()).catch(() => {}); });
$('#reacts').innerHTML = EMOJI.map(e => `<button type="button" data-e="${e}" aria-label="Thả ${e}">${e}</button>`).join('');
$('#reacts').addEventListener('click', e => { const b = e.target.closest('[data-e]'); if (b) send({t: 'react', e: b.dataset.e}); });
$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#chatInput').value.trim(); if (!text) return;
  send({t: 'chat', text}); $('#chatInput').value = '';
});
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#cPlay').click(); }
});

/* ------------------------------------------------------------ vào phòng */
$('#cPlay').innerHTML = ICON_PLAY;
$('#joinName').value = store.get('cv-name') || (hostKey ? 'Chủ phòng' : '');
$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  name = $('#joinName').value.trim().slice(0, 30) || 'Khách';
  store.set('cv-name', name);
  $('#joinDlg').close();
  connect();
});
$('#joinDlg').addEventListener('cancel', e => e.preventDefault());
$('#joinDlg').showModal();
})();
