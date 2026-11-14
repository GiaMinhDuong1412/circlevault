/* CircleVault – Phòng thoại kiểu Discord (bạn bè mở bằng trình duyệt, không cần cài app; chủ phòng mở trong tab Phòng Thoại).
 * - Kênh chữ (#) lưu tin nhắn trên máy chủ phòng; kênh thoại (🔊) = WebRTC ngang hàng, mỗi cặp một RTCPeerConnection
 *   ("perfect negotiation"), máy chủ chỉ chuyển offer/answer/ICE.
 * - LỌC GIỌNG (ở máy từng người, trước khi gửi đi): lọc tiếng ù (high-pass), lọc ồn AI (RNNoise như Krisp / GTCRN mạnh hơn /
 *   Speex nhẹ / bộ lọc của trình duyệt), khử tiếng vọng, tự cân âm lượng, ngưỡng mic (tự động hoặc chỉnh tay) + nhấn để nói.
 * - Nghe: âm lượng riêng từng người 0–200% (nhớ theo người), tắt tiếng một người chỉ ở máy mình, chọn loa/tai nghe.
 * - Chủ phòng: sửa tên phòng, thêm/đổi tên/xóa kênh, tắt mic người khác, mời khỏi kênh, đuổi, chặn.
 * - Trong app (iframe, ?embed=1): nhận lệnh phím tắt toàn cục từ trang cha (postMessage {cvVoice: …}) và báo trạng thái lên. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } };

const code = location.pathname.split('/')[2];
const qs = new URLSearchParams(location.search);
const EMBED = !!qs.get('embed');
let hostKey = qs.get('host') || '';
try {
  if (hostKey) sessionStorage.setItem('cv-vhost-' + code, hostKey); else hostKey = sessionStorage.getItem('cv-vhost-' + code) || '';
} catch (e) { /* bỏ qua */ }
if (qs.get('host')) { qs.delete('host'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '')); }
let UID = jget('cv-voice-uid', '');
if (!UID) { UID = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join(''); jset('cv-voice-uid', UID); }

const DEF = {inDev: '', outDev: '', ns: 'ai', echo: true, agc: true, hp: true, inVol: 1, outVol: 1, sens: 'auto', sensDb: -50,
  mode: 'vad', pttKey: 'Backquote', pttRelease: 200, sounds: true};
const S = Object.assign({}, DEF, jget('cv-voice', {}));
const P = Object.assign({name: '', avatar: '', color: '', status: '', frame: ''}, jget('cv-voice-prof', {}));
const VOL = jget('cv-voice-vol', {});                  // uid → {v: 0..2, m: tắt tiếng}
const saveS = () => jset('cv-voice', S);
const saveP = () => jset('cv-voice-prof', P);

const NS = {
  ai: ['Lọc ồn AI (RNNoise)', 'Như Krisp của Discord: lọc tiếng quạt, gõ phím, tiếng ồn xung quanh. Khuyên dùng.'],
  ai2: ['Lọc ồn AI mạnh (GTCRN)', 'Lọc mạnh hơn, hợp phòng ồn (quán net, nhiều người). Tốn CPU hơn một chút.'],
  speex: ['Lọc nhẹ (Speex)', 'Nhẹ máy, giọng tự nhiên, lọc ồn đều (tiếng quạt, máy lạnh).'],
  browser: ['Bộ lọc của trình duyệt', 'Bộ lọc có sẵn của Chrome/Edge.'],
  off: ['Tắt lọc ồn', 'Giữ nguyên tiếng mic (mic xịn, phòng yên tĩnh, hát).'],
};
const FRAMES = [['', 'Không khung'], ['nhip', 'Nhịp tim'], ['lua', 'Lửa'], ['bang', 'Băng'], ['sao', 'Sao đêm'],
  ['cau-vong', 'Cầu vồng'], ['la', 'Lá xanh'], ['pixel', 'Pixel'], ['neon', 'Neon'], ['vuong-mien', 'Vương miện']];
const COLORS = ['', '#ff5a5f', '#ff8a3d', '#e6a700', '#2bb673', '#19bde8', '#4f7cff', '#9b6bff', '#e25bc8'];
const IC = {
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M19 11a7 7 0 0 1-1.1 3.8M5 11a7 7 0 0 0 11.4 5.4M12 18v4M3 3l18 18"/></svg>',
  head: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg>',
  headOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M3 18v-6a9 9 0 0 1 15.4-6.4M21 12v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3zM3 3l18 18"/></svg>',
  spk: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
};

const st = {ws: null, me: null, server: {name: '', channels: []}, members: [], history: {}, view: '', voice: null, ice: [],
  peers: {}, talking: new Set(), unread: {}, closed: false, voiceMax: 10, retry: 0, editing: null};
const isHost = () => !!(st.me && st.me.host);
const meM = () => st.members.find(m => st.me && m.id === st.me.id) || st.me;

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast box ${kind}`; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4200);
}
function send(o) { if (st.ws && st.ws.readyState === 1) st.ws.send(JSON.stringify(o)); }
function post(o) { if (EMBED && window.parent !== window) window.parent.postMessage({cvVoiceState: o}, '*'); }

/* ------------------------------------------------------------ âm thanh báo (vào/ra kênh, bật/tắt mic) */
let beepCtx = null;
function beep(kind) {
  if (!S.sounds) return;
  try {
    beepCtx = beepCtx || new AudioContext();
    const seq = {join: [523, 784], leave: [784, 523], mute: [440], unmute: [660], other: [660, 880], otherLeft: [880, 660]}[kind] || [600];
    let t = beepCtx.currentTime;
    for (const f of seq) {
      const o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(beepCtx.destination); o.start(t); o.stop(t + 0.13); t += 0.09;
    }
  } catch (e) { /* bỏ qua */ }
}

/* ------------------------------------------------------------ ảnh đại diện + khung */
function avatar(m, size = 32, extra = '') {
  const name = m.name || '?';
  const img = m.self ? (P.avatar ? `<img src="${esc(P.avatar)}" alt="">` : '')
    : (m.av ? `<img src="/v/${code}/av/${encodeURIComponent(m.id)}?v=${m.av}" alt="" loading="lazy">` : '');
  const col = m.color || '#19bde8';
  return `<span class="av fr-${esc(m.frame || 'none')} ${st.talking.has(m.id) ? 'talk' : ''} ${extra}" data-av="${esc(m.id || '')}" style="--s:${size}px;--c:${esc(col)}">
    ${img || `<span class="av-i">${esc(name.trim().slice(0, 1).toUpperCase())}</span>`}<i class="av-fr" aria-hidden="true"></i></span>`;
}
const nameStyle = m => m.color ? ` style="color:${esc(m.color)}"` : '';

/* ------------------------------------------------------------ BỘ XỬ LÝ MIC (lọc giọng) */
const A = {ctx: null, raw: null, src: null, chain: [], inGain: null, an: null, gate: null, dest: null, track: null, wasm: {}, mods: {},
  lib: null, level: -100, floor: -65, open: false, lastLoud: 0, ptt: false, pttUp: 0, nsOn: '', err: '', loop: 0, speakSent: false};

async function ensureCtx() {
  if (!A.ctx) {
    A.ctx = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
    A.inGain = A.ctx.createGain();
    A.an = A.ctx.createAnalyser(); A.an.fftSize = 1024;
    A.gate = A.ctx.createGain(); A.gate.gain.value = 0;
    A.dest = A.ctx.createMediaStreamDestination();
    A.inGain.connect(A.an); A.inGain.connect(A.gate); A.gate.connect(A.dest);
    A.track = A.dest.stream.getAudioTracks()[0];
    A.loop = setInterval(meterTick, 40);
  }
  if (A.ctx.state === 'suspended') await A.ctx.resume().catch(() => {});
  return A.ctx;
}
async function openMic() {
  await ensureCtx();
  if (A.raw) A.raw.getTracks().forEach(t => t.stop());
  const audio = {echoCancellation: S.echo, autoGainControl: S.agc, noiseSuppression: S.ns === 'browser', channelCount: 1};
  if (S.inDev) audio.deviceId = {exact: S.inDev};
  try {
    A.raw = await navigator.mediaDevices.getUserMedia({audio});
  } catch (e) {
    if (S.inDev && e.name === 'OverconstrainedError') { S.inDev = ''; saveS(); return openMic(); }
    A.raw = null; A.err = e.name === 'NotAllowedError' ? 'Chưa cho phép dùng micro (bấm biểu tượng 🔒/micro trên thanh địa chỉ để cho phép).'
      : e.name === 'NotFoundError' ? 'Không thấy micro nào.' : 'Không mở được micro: ' + e.message;
    toast(A.err, 'err'); renderMe(); return false;
  }
  A.err = '';
  A.raw.getAudioTracks()[0].onended = () => { toast('Micro bị ngắt (rút ra?). Chọn lại trong Cài đặt.', 'err'); };
  A.src = A.ctx.createMediaStreamSource(A.raw);
  await rebuildChain();
  return true;
}
async function nsLib() {
  if (!A.lib) A.lib = await import('/p/vendor/ns/index.js');
  return A.lib;
}
async function addMod(path) {
  if (!A.mods[path]) A.mods[path] = A.ctx.audioWorklet.addModule(path);
  return A.mods[path];
}
async function makeNs(kind) {
  const lib = await nsLib(), base = '/p/vendor/ns/';
  if (kind === 'ai') {
    A.wasm.ai = A.wasm.ai || await lib.loadRnnoise({url: base + 'rnnoise.wasm', simdUrl: base + 'rnnoise_simd.wasm'});
    await addMod(base + 'rnnoise/workletProcessor.js');
    return new lib.RnnoiseWorkletNode(A.ctx, {maxChannels: 1, wasmBinary: A.wasm.ai});
  }
  if (kind === 'ai2') {
    A.wasm.ai2 = A.wasm.ai2 || await lib.loadGtcrn({url: base + 'gtcrn.wasm'});
    await addMod(base + 'gtcrn/workletProcessor.js');
    return new lib.GtcrnWorkletNode(A.ctx, {maxChannels: 1, wasmBinary: A.wasm.ai2});
  }
  if (kind === 'speex') {
    A.wasm.speex = A.wasm.speex || await lib.loadSpeex({url: base + 'speex.wasm'});
    await addMod(base + 'speex/workletProcessor.js');
    return new lib.SpeexWorkletNode(A.ctx, {maxChannels: 1, wasmBinary: A.wasm.speex});
  }
  return null;
}
async function rebuildChain() {
  if (!A.src) return;
  try { A.src.disconnect(); } catch (e) { /* bỏ qua */ }
  for (const n of A.chain) { try { n.disconnect(); n.destroy?.(); } catch (e) { /* bỏ qua */ } }
  A.chain = [];
  if (S.hp) {                                     // lọc tiếng ù: quạt, điện 50 Hz, rung bàn
    const hp = A.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7;
    A.chain.push(hp);
  }
  A.nsOn = '';
  if (['ai', 'ai2', 'speex'].includes(S.ns)) {
    try { const n = await makeNs(S.ns); if (n) { A.chain.push(n); A.nsOn = S.ns; } } catch (e) {
      toast('Không bật được ' + NS[S.ns][0] + ': ' + e.message + ' – tạm dùng bộ lọc của trình duyệt.', 'err');
    }
  } else if (S.ns === 'browser') A.nsOn = 'browser';
  let prev = A.src;
  for (const n of A.chain) { prev.connect(n); prev = n; }
  prev.connect(A.inGain);
  A.inGain.gain.value = S.inVol;
  renderConn();
}
function rms() {
  const buf = new Float32Array(A.an.fftSize);
  A.an.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
}
function micAllowed() {
  const m = meM();
  return !!(A.raw && !S.selfMute && !S.selfDeaf && !(m && m.smute));
}
function meterTick() {
  if (!A.an) return;
  const db = A.raw ? rms() : -100;
  A.level = db;
  const now = performance.now();
  // ngưỡng tự động: theo dõi mức ồn nền (xuống nhanh, lên chậm), mở khi to hơn nền ~14 dB
  if (db < A.floor) A.floor = A.floor * 0.7 + db * 0.3; else A.floor = Math.min(-30, A.floor + 0.04);
  const thr = S.sens === 'auto' ? Math.max(-62, A.floor + 14) : S.sensDb;
  let want;
  if (S.mode === 'ptt') want = A.ptt || now - A.pttUp < S.pttRelease;
  else {
    if (db > thr) A.lastLoud = now;
    want = now - A.lastLoud < 320;               // giữ thêm 320 ms để không cụt đuôi câu
  }
  want = want && micAllowed() && !!st.voice;
  if (want !== A.open) {
    A.open = want;
    A.gate.gain.setTargetAtTime(want ? 1 : 0, A.ctx.currentTime, want ? 0.008 : 0.05);
  }
  const talk = want && db > thr - 6;
  if (talk !== A.speakSent && st.me) {
    A.speakSent = talk; send({t: 'speak', on: talk}); setTalk(st.me.id, talk);
  }
  const bar = $('#meterBar');
  if (bar) {
    const pct = Math.max(0, Math.min(100, (db + 80) / 80 * 100));
    bar.style.setProperty('--lv', pct + '%');
    bar.style.setProperty('--th', Math.max(0, Math.min(100, (thr + 80) / 80 * 100)) + '%');
    bar.classList.toggle('open', A.open || (!st.voice && db > thr));
  }
}
function setTalk(id, on) {
  if (on) st.talking.add(id); else st.talking.delete(id);
  $$(`[data-av="${CSS.escape(id)}"]`).forEach(el => el.classList.toggle('talk', on));
  $$(`[data-tile="${CSS.escape(id)}"]`).forEach(el => el.classList.toggle('talk', on));
  postState();
}

/* ------------------------------------------------------------ NGHE: mỗi người một luồng */
let outCtx = null;
function peerAudio(P0, stream) {
  P0.stream = stream;
  if (!P0.el) { P0.el = new Audio(); P0.el.autoplay = true; P0.el.playsInline = true; document.body.appendChild(P0.el); P0.el.hidden = true; }
  P0.el.srcObject = stream;
  applyVol(P0);
  P0.el.play().catch(() => askClick());
}
function applyVol(P0) {
  if (!P0.el) return;
  const m = st.members.find(x => x.id === P0.id) || {};
  const pref = VOL[m.uid] || {};
  const v = (pref.v ?? 1) * S.outVol, muted = S.selfDeaf || !!pref.m;
  if (S.outDev && P0.el.setSinkId) P0.el.setSinkId(S.outDev).catch(() => {});
  if (v <= 1) {                                    // ≤100%: phát thẳng (khử vọng của trình duyệt hoạt động tốt nhất)
    P0.el.muted = muted; P0.el.volume = Math.max(0, v);
    if (P0.boost) { try { P0.boost.src.disconnect(); } catch (e) { /* bỏ qua */ } P0.boost = null; }
  } else {                                         // >100%: khuếch đại bằng Web Audio
    P0.el.muted = true;
    outCtx = outCtx || new AudioContext();
    if (S.outDev && outCtx.setSinkId) outCtx.setSinkId(S.outDev).catch(() => {});
    if (!P0.boost && P0.stream) {
      const src = outCtx.createMediaStreamSource(P0.stream), g = outCtx.createGain();
      src.connect(g).connect(outCtx.destination); P0.boost = {src, g};
    }
    if (P0.boost) P0.boost.g.gain.value = muted ? 0 : v;
    outCtx.resume().catch(() => {});
  }
}
let clickAsked = false;
function askClick() {
  if (clickAsked) return; clickAsked = true;
  toast('Bấm vào trang một lần để nghe được tiếng.', 'err');
  document.addEventListener('pointerdown', () => {
    Object.values(st.peers).forEach(p => p.el && p.el.play().catch(() => {}));
    A.ctx?.resume(); outCtx?.resume(); clickAsked = false;
  }, {once: true});
}

/* ------------------------------------------------------------ WebRTC: perfect negotiation */
function pcFor(id) {
  if (st.peers[id]) return st.peers[id];
  const pc = new RTCPeerConnection({iceServers: st.ice, bundlePolicy: 'max-bundle'});
  const P0 = {id, pc, polite: st.me.id < id, makingOffer: false, ignoreOffer: false, el: null, stream: null, rtt: null};
  st.peers[id] = P0;
  if (A.track) {
    const tx = pc.addTrack(A.track, A.dest.stream);
    const p = tx.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 64000;
    tx.setParameters(p).catch(() => {});
  } else pc.addTransceiver('audio', {direction: 'recvonly'});
  pc.onnegotiationneeded = async () => {
    try { P0.makingOffer = true; await pc.setLocalDescription(); send({t: 'sig', to: id, data: {desc: pc.localDescription}}); }
    catch (e) { console.warn(e); } finally { P0.makingOffer = false; }
  };
  pc.onicecandidate = e => { if (e.candidate) send({t: 'sig', to: id, data: {cand: e.candidate}}); };
  pc.ontrack = e => peerAudio(P0, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    renderConn(); renderTiles();
  };
  return P0;
}
async function onSig(from, data) {
  const m = st.members.find(x => x.id === from);
  if (!st.voice || !m || m.voice !== st.voice || !data) return;
  const P0 = pcFor(from), pc = P0.pc;
  try {
    if (data.desc) {
      const collision = data.desc.type === 'offer' && (P0.makingOffer || pc.signalingState !== 'stable');
      P0.ignoreOffer = !P0.polite && collision;
      if (P0.ignoreOffer) return;
      await pc.setRemoteDescription(data.desc);
      if (data.desc.type === 'offer') { await pc.setLocalDescription(); send({t: 'sig', to: from, data: {desc: pc.localDescription}}); }
    } else if (data.cand) {
      try { await pc.addIceCandidate(data.cand); } catch (e) { if (!P0.ignoreOffer) console.warn(e); }
    }
  } catch (e) { console.warn('sig', e); }
}
function dropPeer(id) {
  const P0 = st.peers[id]; if (!P0) return;
  try { P0.pc.close(); } catch (e) { /* bỏ qua */ }
  if (P0.el) { P0.el.srcObject = null; P0.el.remove(); }
  if (P0.boost) { try { P0.boost.src.disconnect(); } catch (e) { /* bỏ qua */ } }
  delete st.peers[id];
  setTalk(id, false);
}
function syncPeers() {               // ai rời kênh thì đóng kết nối
  for (const id of Object.keys(st.peers)) {
    const m = st.members.find(x => x.id === id);
    if (!m || !st.voice || m.voice !== st.voice) dropPeer(id);
  }
}
async function joinVoice(cid) {
  if (st.voice === cid) { setPane('rooms'); return; }
  if (st.voice) leaveVoice(true);
  const ok = A.raw || await openMic();
  if (!ok) toast('Vào kênh chỉ để nghe (chưa có micro).', 'err');
  await ensureCtx();
  st.pendingJoin = cid;
  send({t: 'join', cid});
}
function leaveVoice(quiet) {
  if (!st.voice) return;
  send({t: 'leave'});
  Object.keys(st.peers).forEach(dropPeer);
  st.voice = null;
  if (!quiet) beep('leave');
  render(); postState();
}
setInterval(async () => {          // ping tới từng người (thanh tín hiệu)
  const rtts = [];
  for (const P0 of Object.values(st.peers)) {
    try {
      const stats = await P0.pc.getStats();
      stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) P0.rtt = r.currentRoundTripTime * 1000; });
      if (P0.rtt != null) rtts.push(P0.rtt);
    } catch (e) { /* bỏ qua */ }
  }
  st.rtt = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
  renderConn();
}, 3000);

/* ------------------------------------------------------------ kết nối máy chủ phòng */
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v/${code}/ws`);
  st.ws = ws;
  ws.onopen = () => {
    st.retry = 0;
    ws.send(JSON.stringify({t: 'hello', uid: UID, host_key: hostKey || undefined, ...profileMsg()}));
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMsg(m); };
  ws.onclose = e => {
    const wasVoice = st.voice;
    Object.keys(st.peers).forEach(dropPeer);
    st.voice = null; st.me = null;
    const why = {4403: 'Phòng đang đóng hoặc bạn không được vào.', 4401: 'Bạn đã bị mời ra khỏi phòng.', 4404: 'Link phòng không còn dùng được.',
      4410: 'Chủ phòng đã đổi link mời. Hỏi chủ phòng link mới.', 4429: 'Phòng đã đầy.'}[e.code];
    if (why) { st.closed = true; $('#serverName').textContent = 'Đã rời phòng'; toast(why, 'err'); render(); return; }
    $('#serverName').textContent = 'Mất kết nối, đang nối lại…';
    setTimeout(() => { connect(); if (wasVoice) st.rejoin = wasVoice; }, Math.min(8000, 800 * 2 ** st.retry++));
  };
}
function profileMsg() {
  return {name: P.name || 'Khách', avatar: P.avatar || '', color: P.color, status: P.status, frame: P.frame};
}
function firstText() { return (st.server.channels.find(c => c.kind === 'text') || {}).id || ''; }
function onMsg(m) {
  switch (m.t) {
    case 'welcome':
      st.me = m.you; st.members = m.members; st.server = m.server; st.ice = m.ice || []; st.history = m.history || {};
      st.voiceMax = m.voice_max || 10;
      if (!st.view || !st.server.channels.some(c => 't:' + c.id === st.view)) st.view = 't:' + (jget('cv-voice-last-' + code, '') || firstText());
      if (!st.server.channels.some(c => 't:' + c.id === st.view)) st.view = 't:' + firstText();
      render();
      if (st.rejoin) { const c = st.rejoin; st.rejoin = null; joinVoice(c); }
      break;
    case 'members': {
      const before = new Map(st.members.map(x => [x.id, x.voice]));
      st.members = m.list;
      const mine = st.members.find(x => st.me && x.id === st.me.id);
      if (mine) { st.me = mine; if (st.pendingJoin && mine.voice === st.pendingJoin) st.pendingJoin = null; }
      if (st.voice) for (const x of st.members) {
        if (x.id === st.me.id) continue;
        const was = before.get(x.id);
        if (x.voice === st.voice && was !== st.voice) beep('other');
        if (was === st.voice && x.voice !== st.voice) beep('otherLeft');
      }
      if (st.voice && mine && mine.voice !== st.voice) { leaveVoice(true); }
      syncPeers();
      Object.values(st.peers).forEach(applyVol);
      render(); postState();
      break;
    }
    case 'joined':
      st.voice = m.cid; beep('join'); setPane('rooms');
      sendState();
      for (const id of m.peers) pcFor(id);            // người mới vào gửi offer cho từng người đang có trong kênh
      render(); postState();
      break;
    case 'kicked-voice':
      Object.keys(st.peers).forEach(dropPeer); st.voice = null; beep('leave');
      toast('Chủ phòng đã mời bạn ra khỏi kênh thoại.', 'err');
      render(); postState();
      break;
    case 'sig': onSig(m.from, m.data); break;
    case 'speak': setTalk(m.id, !!m.on); break;
    case 'server': st.server = m.server; render(); break;
    case 'chat': {
      (st.history[m.cid] = st.history[m.cid] || []).push(m.msg);
      if (st.view === 't:' + m.cid && !document.hidden) appendMsg(m.msg); else { st.unread[m.cid] = (st.unread[m.cid] || 0) + 1; renderChans(); }
      if (pane === 'rooms' && window.innerWidth <= 800 && m.msg.uid !== UID) { st.mUnread = (st.mUnread || 0) + 1; paintBadge(); }
      if (document.hidden || st.view !== 't:' + m.cid) postState();
      break;
    }
    case 'deleted': {
      const h = st.history[m.cid]; if (h) st.history[m.cid] = h.filter(x => x.mid !== m.mid);
      $(`[data-mid="${CSS.escape(m.mid)}"]`)?.remove();
      break;
    }
    case 'notice': toast(m.text, 'err'); st.pendingJoin = null; break;
    default: break;
  }
}
function sendState() { send({t: 'state', mute: !!S.selfMute, deaf: !!S.selfDeaf}); }
setInterval(() => send({t: 'ping', c: Date.now()}), 25000);

/* ------------------------------------------------------------ giao diện */
function chanById(id) { return st.server.channels.find(c => c.id === id); }
function render() {
  $('#serverName').textContent = st.closed ? 'Đã rời phòng' : (st.server.name || 'Phòng thoại');
  renderChans(); renderMain(); renderMembers(); renderMe(); renderConn();
}
/* màn hình hẹp: chuyển giữa "Phòng nói" và "Trò chuyện" */
let pane = 'rooms';
function setPane(p) {
  pane = p;
  $('#app').dataset.pane = p;
  $$('[data-gopane]').forEach(b => b.classList.toggle('on', b.dataset.gopane === p));
  if (p === 'chat') { st.mUnread = 0; paintBadge(); }
}
function paintBadge() { const b = $('#chatBadge'); if (b) { b.textContent = st.mUnread ? st.mUnread : ''; b.hidden = !st.mUnread; } }
function memberRow(m, cls = '') {
  return `<button class="vc-mrow ${cls}" type="button" data-user="${esc(m.id)}">${avatar(m, 30)}
    <span class="vc-mtx"><span class="vc-mname"${nameStyle(m)}>${esc(m.name)}${m.host ? ' <span class="vc-crown" title="Chủ phòng">👑</span>' : ''}</span>
    <small>${esc(m.voice ? '🔊 ' + ((chanById(m.voice) || {}).name || '') : m.status || 'Đang online')}</small></span>
    <span class="vc-mic">${m.smute ? '<span class="vc-sm" title="Chủ phòng đã tắt mic">' + IC.micOff + '</span>' : m.mute ? IC.micOff : ''}${m.deaf ? IC.headOff : ''}</span></button>`;
}
const ROOM_COLORS = ['var(--cyan)', 'var(--pink)', 'var(--green)', 'var(--violet)', 'var(--yellow)', 'var(--red)'];
function renderChans() {
  const ch = st.server.channels, host = isHost();
  const tools = c => host ? `<span class="vc-ctools"><button type="button" data-ren="${esc(c.id)}" title="Đổi tên">✎</button><button type="button" data-delch="${esc(c.id)}" title="Xóa">🗑</button></span>` : '';
  const editRow = (id, val, kind) => `<form class="vc-edit" data-editform="${esc(id)}" data-kind="${kind}"><input type="text" maxlength="40" value="${esc(val)}" placeholder="${kind === 'voice' ? 'Tên phòng nói' : 'tên-chủ-đề'}" required></form>`;
  // các phòng nói chuyện = thẻ
  const voices = ch.filter(x => x.kind === 'voice');
  let h = voices.map((c, i) => {
    if (st.editing === c.id) return `<div class="lg-card editing">${editRow(c.id, c.name, 'voice')}</div>`;
    const inside = st.members.filter(m => m.voice === c.id), here = st.voice === c.id;
    return `<div class="lg-card ${here ? 'here' : ''} ${inside.length ? 'busy' : ''}" style="--rc:${ROOM_COLORS[i % ROOM_COLORS.length]}">
      <div class="lg-card-h"><span class="lg-card-ic">${IC.spk}</span><b>${esc(c.name)}</b>${tools(c)}</div>
      <div class="lg-faces">${inside.length ? inside.map(m => `<span class="lg-face" data-user="${esc(m.id)}" title="${esc(m.name)}">${avatar(m, 40)}${m.mute || m.smute ? '<i class="lg-fmute">' + IC.micOff + '</i>' : ''}</span>`).join('')
        : '<span class="hint">Chưa có ai – vào trước rồi rủ bạn nhé</span>'}</div>
      <div class="lg-card-f"><small>${inside.length}/${st.voiceMax} người</small>
        ${here ? '<span class="lg-here">● Bạn đang ở đây</span>' : `<button class="btn sm green" type="button" data-voice="${esc(c.id)}">Vào phòng</button>`}</div></div>`;
  }).join('');
  if (st.editing === 'new-voice') h += `<div class="lg-card editing">${editRow('new-voice', '', 'voice')}</div>`;
  else if (host) h += `<button class="lg-card lg-add" type="button" data-addch="voice"><span>＋</span>Phòng nói mới</button>`;
  $('#chList').innerHTML = h;
  // chủ đề trò chuyện = tab
  let t = '';
  for (const c of ch.filter(x => x.kind === 'text')) {
    if (st.editing === c.id) { t += editRow(c.id, c.name, 'text'); continue; }
    const n = st.unread[c.id];
    t += `<span class="lg-tab ${st.view === 't:' + c.id ? 'on' : ''}"><button type="button" data-text="${esc(c.id)}">#${esc(c.name)}</button>${n ? `<i class="vc-badge">${n > 99 ? '99+' : n}</i>` : ''}${st.view === 't:' + c.id ? tools(c) : ''}</span>`;
  }
  if (st.editing === 'new-text') t += editRow('new-text', '', 'text');
  else if (host) t += '<button class="lg-tab-add" type="button" data-addch="text" title="Thêm chủ đề">＋</button>';
  $('#chatTabs').innerHTML = t;
  const f = $('.vc-edit input'); if (f) { f.focus(); f.select(); }
}
function renderMain() {
  renderLog((st.view || ':').split(':')[1]);
  renderTiles();
}
function linkify(s) {
  return esc(s).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function timeStr(at) {
  const d = new Date(at * 1000), now = new Date();
  const hm = d.toLocaleTimeString('vi-VN', {hour: '2-digit', minute: '2-digit'});
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString('vi-VN') + ' ' + hm;
}
function msgHtml(m, prev) {
  const grouped = prev && prev.uid === m.uid && m.at - prev.at < 300;
  const who = st.members.find(x => x.uid === m.uid) || {id: '', name: m.name, color: m.color};
  const mine = m.uid === UID, canDel = mine || isHost();
  const del = canDel ? `<button class="vc-del" type="button" data-del="${esc(m.mid)}" title="Xóa tin">✕</button>` : '';
  const self = mine ? {...who, self: true} : who;
  return `<div class="lg-msg ${mine ? 'me' : ''} ${grouped ? 'g' : ''}" data-mid="${esc(m.mid)}" data-uid="${esc(m.uid)}" data-at="${m.at}">
    ${grouped ? '<span class="lg-gap"></span>' : avatar({...self, name: m.name, color: m.color || who.color}, 30)}
    <div class="lg-bub">${grouped ? '' : `<div class="vc-mh"><b${nameStyle(m)} data-user="${esc(who.id)}">${esc(mine ? 'Bạn' : m.name)}</b>${m.host ? ' <span class="vc-crown">👑</span>' : ''}</div>`}
      <p>${linkify(m.text)}</p><small>${esc(timeStr(m.at))}</small>${del}</div></div>`;
}
function renderLog(cid) {
  const h = st.history[cid] || [];
  st.unread[cid] = 0;
  const c = chanById(cid);
  let html = `<div class="vc-welcome"><b>#${esc(c ? c.name : '')}</b><p class="hint">Bắt đầu trò chuyện ở đây. Tin nhắn lưu trên máy của chủ phòng.</p></div>`;
  h.forEach((m, i) => { html += msgHtml(m, h[i - 1]); });
  const log = $('#log');
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;
  $('#msgIn').placeholder = `Nhắn vào #${c ? c.name : ''}…`;
  $('#msgIn').disabled = !st.me;
  if (cid) jset('cv-voice-last-' + code, cid);
}
function appendMsg(m) {
  const log = $('#log'), h = st.history[st.view.slice(2)] || [];
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.insertAdjacentHTML('beforeend', msgHtml(m, h[h.length - 2]));
  if (near || m.uid === UID) log.scrollTop = log.scrollHeight;
}
function renderTiles() {
  const id = st.voice, c = id ? chanById(id) : null;
  $('#voiceView').hidden = !c;
  $('#app').classList.toggle('in-voice', !!c);
  if (!c) return;
  $('#headName').textContent = c.name;
  const inside = st.members.filter(m => m.voice === id);
  $('#tiles').innerHTML = inside.map(m => {
    const P0 = st.peers[m.id], self = st.me && m.id === st.me.id;
    const bad = !self && P0 && ['failed', 'disconnected'].includes(P0.pc.connectionState);
    const wait = !self && (!P0 || ['new', 'connecting'].includes(P0.pc.connectionState));
    return `<button class="vc-tile ${st.talking.has(m.id) ? 'talk' : ''}" type="button" data-tile="${esc(m.id)}" data-user="${esc(m.id)}" style="--c:${esc(m.color || '#19bde8')}">
      ${avatar(self ? {...m, self: true} : m, 76)}<span class="vc-tname"${nameStyle(m)}>${esc(m.name)}${self ? ' (bạn)' : ''}</span>
      <span class="vc-ticons">${m.smute || m.mute ? IC.micOff : ''}${m.deaf ? IC.headOff : ''}</span>
      ${bad ? '<span class="vc-tbad">Mất kết nối – đang thử lại</span>' : wait ? '<span class="vc-tbad wait">Đang kết nối…</span>' : ''}</button>`;
  }).join('');
  $('#tiles').className = 'vc-tiles n' + Math.min(inside.length, 9);
}
function renderMembers() {
  const on = st.members;
  $('#onCount').textContent = on.length ? on.length + ' online' : '';
  $('#stack').innerHTML = on.slice(0, 5).map(m => avatar(st.me && m.id === st.me.id ? {...m, self: true} : m, 28)).join('') + (on.length > 5 ? `<span class="lg-more">+${on.length - 5}</span>` : '');
  const group = (title, list) => list.length ? `<div class="lg-ph">${title} · ${list.length}</div>${list.map(m => memberRow(m)).join('')}` : '';
  $('#people').innerHTML = group('Chủ phòng', on.filter(m => m.host)) + group('Đang nói chuyện', on.filter(m => !m.host && m.voice))
    + group('Đang online', on.filter(m => !m.host && !m.voice));
  $('#roomsHint').textContent = `${on.filter(m => m.voice).length} người đang nói chuyện`;
}
function renderMe() {
  const m = meM() || {name: P.name || 'Khách', color: P.color, frame: P.frame};
  $('#meWho').innerHTML = `${avatar({...m, self: true, id: st.me ? st.me.id : 'me'}, 34)}<span><b${nameStyle(m)}>${esc(P.name || m.name || 'Khách')}</b>
    <small>${esc(A.err ? 'Lỗi micro' : P.status || (st.voice ? 'Đang nói chuyện' : 'Đang online'))}</small></span>`;
  const muted = S.selfMute || S.selfDeaf || (m && m.smute) || !A.raw;
  const mb = $('#micBtn');
  mb.innerHTML = muted ? IC.micOff : IC.mic;
  mb.classList.toggle('off', !!muted);
  mb.title = m && m.smute ? 'Chủ phòng đã tắt mic của bạn' : !A.raw ? (A.err || 'Chưa bật micro') : muted ? 'Bật mic (Ctrl+Shift+M)' : 'Tắt mic (Ctrl+Shift+M)';
  const db = $('#deafBtn');
  db.innerHTML = S.selfDeaf ? IC.headOff : IC.head;
  db.classList.toggle('off', !!S.selfDeaf);
}
function renderConn() {
  const box = $('#conn');
  box.hidden = !st.voice;
  if (!st.voice) return;
  const c = chanById(st.voice);
  const peers = Object.values(st.peers);
  const ok = peers.every(p => p.pc.connectionState === 'connected');
  const rtt = st.rtt;
  $('#connState').textContent = (c ? c.name : '') + ' · ' + (!peers.length ? 'đã vào' : ok ? 'đã kết nối' : 'đang kết nối…');
  $('#connName').textContent = rtt != null ? `${rtt} ms` : '';
  const q = rtt == null ? (ok ? 3 : 1) : rtt < 120 ? 3 : rtt < 250 ? 2 : 1;
  $('#connSig').className = 'vc-sig q' + q;
  $('#connNs').innerHTML = `🎚 ${esc(A.nsOn ? NS[A.nsOn][0] : 'Không lọc ồn')}${S.mode === 'ptt' ? ` · Nhấn để nói: <kbd>${esc(keyName(S.pttKey))}</kbd>` : ''}`;
}

/* ------------------------------------------------------------ hồ sơ (dùng ở hộp Vào phòng và Cài đặt → Hồ sơ) */
function profEditor() {
  return `<div class="vc-prof-grid">
    <div class="vc-prof-prev" id="profPrev"></div>
    <div class="vc-prof-f">
      <label class="field">Tên hiển thị<input type="text" id="pName" maxlength="32" required placeholder="Ví dụ: Lan" value="${esc(P.name)}" autocomplete="nickname"></label>
      <label class="field">Trạng thái<input type="text" id="pStatus" maxlength="80" placeholder="Đang chơi Valorant…" value="${esc(P.status)}"></label>
      <div class="field">Ảnh đại diện<div class="btn-row"><label class="btn sm plain">Chọn ảnh…<input type="file" id="pFile" accept="image/*" hidden></label>
        ${P.avatar ? '<button class="btn sm plain" type="button" id="pNoAv">Bỏ ảnh</button>' : ''}</div></div>
      <div class="field">Màu tên<div class="vc-colors">${COLORS.map(c => `<button type="button" class="vc-col ${P.color === c ? 'on' : ''}" data-col="${c}" style="--c:${c || 'var(--text)'}" title="${c || 'Mặc định'}"></button>`).join('')}</div></div>
    </div></div>
    <div class="field">Khung ảnh đại diện<div class="vc-frames">${FRAMES.map(([k, n]) => `<button type="button" class="vc-fr ${P.frame === k ? 'on' : ''}" data-frame="${k}">
      ${avatar({name: P.name || 'A', color: P.color, frame: k, self: true, id: 'f-' + k}, 46)}<small>${n}</small></button>`).join('')}</div></div>`;
}
function bindProf(root) {
  const prev = () => {
    $('#profPrev', root).innerHTML = `${avatar({name: P.name || '?', color: P.color, frame: P.frame, self: true, id: 'prev'}, 96)}
      <b${nameStyle(P)}>${esc(P.name || 'Tên của bạn')}</b><small class="hint">${esc(P.status || '')}</small>`;
  };
  prev();
  $('#pName', root).oninput = e => { P.name = e.target.value.trim(); prev(); };
  $('#pStatus', root).oninput = e => { P.status = e.target.value; prev(); };
  $$('[data-col]', root).forEach(b => b.onclick = () => { P.color = b.dataset.col; $$('[data-col]', root).forEach(x => x.classList.toggle('on', x === b)); prev(); });
  $$('[data-frame]', root).forEach(b => b.onclick = () => { P.frame = b.dataset.frame; $$('[data-frame]', root).forEach(x => x.classList.toggle('on', x === b)); prev(); });
  $('#pFile', root).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { P.avatar = await shrink(f); root.innerHTML = profEditor(); bindProf(root); } catch (err) { toast('Không đọc được ảnh này.', 'err'); }
  };
  const no = $('#pNoAv', root); if (no) no.onclick = () => { P.avatar = ''; root.innerHTML = profEditor(); bindProf(root); };
}
function shrink(file) {            // cắt vuông giữa ảnh, 160×160 – gif giữ nguyên nếu nhỏ (ảnh động)
  return new Promise((res, rej) => {
    if (file.type === 'image/gif' && file.size < 250000) { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); return; }
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = document.createElement('canvas'); c.width = c.height = 160;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
      URL.revokeObjectURL(img.src); res(c.toDataURL('image/webp', 0.85));
    };
    img.onerror = rej; img.src = URL.createObjectURL(file);
  });
}
function saveProfile() { P.name = (P.name || '').trim().slice(0, 32) || 'Khách'; saveP(); send({t: 'profile', ...profileMsg()}); renderMe(); }

/* ------------------------------------------------------------ cài đặt */
let setTab = 'voice';
function keyName(k) {
  return ({Backquote: '`', Space: 'Space', CapsLock: 'Caps Lock', ControlLeft: 'Ctrl trái', AltLeft: 'Alt trái', ShiftLeft: 'Shift trái'}[k])
    || k.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Mouse/, 'Chuột ');
}
async function openSettings(tab) {
  setTab = tab || setTab;
  $$('[data-stab]').forEach(b => b.classList.toggle('on', b.dataset.stab === setTab));
  const dlg = $('#setDlg');
  if (!dlg.open) dlg.showModal();
  if (!A.raw && setTab === 'voice') await openMic();
  drawSettings();
}
async function devices() {
  try { const all = await navigator.mediaDevices.enumerateDevices(); return {ins: all.filter(d => d.kind === 'audioinput'), outs: all.filter(d => d.kind === 'audiooutput')}; }
  catch (e) { return {ins: [], outs: []}; }
}
async function drawSettings() {
  const body = $('#setBody');
  if (setTab === 'prof') {
    body.innerHTML = `<div class="vc-prof">${profEditor()}</div><div class="btn-row"><button class="btn green" type="button" id="pSave">LƯU HỒ SƠ</button></div>`;
    bindProf($('.vc-prof', body));
    $('#pSave').onclick = () => { saveProfile(); toast('Đã lưu hồ sơ.'); };
    return;
  }
  if (setTab === 'keys') {
    body.innerHTML = `<div class="vc-keys">
      <p><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> Tắt / bật mic &nbsp; · &nbsp; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> Tắt / bật nghe</p>
      <p class="hint">${EMBED ? 'Trong app CircleVault, các phím này và phím Nhấn để nói dùng được cả khi đang ở trong game (phím tắt toàn cục).' : 'Trên trình duyệt, phím tắt chỉ chạy khi đang mở trang này. Dùng app CircleVault để bấm được cả khi đang trong game.'}</p>
      <label class="field">Phím Nhấn để nói<button class="btn plain" type="button" id="pttRec">${esc(keyName(S.pttKey))} – bấm để đổi</button></label>
      <label class="field">Nhả phím thì tắt mic sau<select id="pttRel">${[0, 100, 200, 400, 700].map(v => `<option value="${v}" ${S.pttRelease === v ? 'selected' : ''}>${v} ms</option>`).join('')}</select></label>
      <label class="vc-chk"><input type="checkbox" id="snd" ${S.sounds ? 'checked' : ''}> Âm báo khi vào/ra kênh, bật/tắt mic</label>
      ${EMBED ? `<h4 class="vc-h4">Khung nổi khi chơi game</h4>
      <label class="vc-chk"><input type="checkbox" id="ovOn" ${S.overlay !== false ? 'checked' : ''}> Hiện ai đang nói ở góc màn hình khi đang ở ngoài app (game để chế độ Cửa sổ / Không viền)</label>
      <label class="field">Góc màn hình<select id="ovCorner">${[['tl', 'Trên trái'], ['tr', 'Trên phải'], ['bl', 'Dưới trái'], ['br', 'Dưới phải']]
        .map(([k, n]) => `<option value="${k}" ${(S.corner || 'tl') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}</div>`;
    $('#pttRec').onclick = e => {
      const b = e.currentTarget; b.textContent = 'Bấm phím muốn dùng…';
      const done = () => { window.removeEventListener('keydown', on, true); window.removeEventListener('mousedown', onM, true); saveS(); postState(); drawSettings(); };
      const on = ev => { ev.preventDefault(); if (ev.code !== 'Escape') S.pttKey = ev.code; done(); };
      const onM = ev => { if (ev.button < 3) return; ev.preventDefault(); S.pttKey = 'Mouse' + (ev.button + 1); done(); };   // nút bên hông chuột
      window.addEventListener('keydown', on, true); window.addEventListener('mousedown', onM, true);
    };
    $('#pttRel').onchange = e => { S.pttRelease = +e.target.value; saveS(); };
    $('#snd').onchange = e => { S.sounds = e.target.checked; saveS(); };
    if ($('#ovOn')) { $('#ovOn').onchange = e => { S.overlay = e.target.checked; saveS(); postState(); }; $('#ovCorner').onchange = e => { S.corner = e.target.value; saveS(); postState(); }; }
    return;
  }
  const {ins, outs} = await devices();
  const opt = (list, cur, def) => `<option value="">${def}</option>` + list.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => `<option value="${esc(d.deviceId)}" ${cur === d.deviceId ? 'selected' : ''}>${esc(d.label || 'Thiết bị ' + (i + 1))}</option>`).join('');
  body.innerHTML = `
    <div class="vc-grid2">
      <label class="field">Micro<select id="sIn">${opt(ins, S.inDev, 'Mặc định của Windows')}</select></label>
      <label class="field">Loa / tai nghe<select id="sOut" ${'setSinkId' in HTMLMediaElement.prototype ? '' : 'disabled'}>${opt(outs, S.outDev, 'Mặc định của Windows')}</select></label>
      <label class="field">Âm lượng mic <span class="mono" id="inVolV">${Math.round(S.inVol * 100)}%</span><input type="range" id="sInVol" min="0" max="2" step="0.05" value="${S.inVol}"></label>
      <label class="field">Âm lượng nghe <span class="mono" id="outVolV">${Math.round(S.outVol * 100)}%</span><input type="range" id="sOutVol" min="0" max="2" step="0.05" value="${S.outVol}"></label>
    </div>
    <h4 class="vc-h4">Lọc giọng</h4>
    <div class="vc-ns">${Object.entries(NS).map(([k, [n, d]]) => `<label class="vc-nsopt ${S.ns === k ? 'on' : ''}"><input type="radio" name="ns" value="${k}" ${S.ns === k ? 'checked' : ''}>
      <b>${n}</b><small>${d}</small></label>`).join('')}</div>
    <div class="vc-chks">
      <label class="vc-chk"><input type="checkbox" id="sHp" ${S.hp ? 'checked' : ''}> Lọc tiếng ù (quạt, điện, rung bàn)</label>
      <label class="vc-chk"><input type="checkbox" id="sEcho" ${S.echo ? 'checked' : ''}> Khử tiếng vọng (dùng loa ngoài thì nên bật)</label>
      <label class="vc-chk"><input type="checkbox" id="sAgc" ${S.agc ? 'checked' : ''}> Tự cân âm lượng giọng</label>
    </div>
    <h4 class="vc-h4">Chế độ nói</h4>
    <div class="btn-row"><button type="button" class="chip ${S.mode === 'vad' ? 'on' : ''}" data-mode="vad">Tự bật khi nói</button>
      <button type="button" class="chip ${S.mode === 'ptt' ? 'on' : ''}" data-mode="ptt">Nhấn để nói (${esc(keyName(S.pttKey))})</button></div>
    <div class="vc-sens">
      <div class="vc-sens-h"><b>Độ nhạy mic</b><label class="vc-chk"><input type="checkbox" id="sAuto" ${S.sens === 'auto' ? 'checked' : ''}> Tự động</label></div>
      <div class="vc-meter" id="meterBar"><i></i><b></b></div>
      <input type="range" id="sSens" min="-80" max="0" step="1" value="${S.sensDb}" ${S.sens === 'auto' ? 'disabled' : ''} aria-label="Ngưỡng mic">
      <p class="hint">Nói thử: thanh chuyển xanh là mic đang gửi tiếng. Tiếng nhỏ hơn vạch (gõ phím, thở) sẽ không lọt ra.</p>
    </div>
    <div class="vc-test"><button class="btn sm plain" type="button" id="sTest">🎧 Nghe thử giọng mình (sau khi lọc)</button></div>`;
  const re = async () => { saveS(); await openMic(); renderMe(); };
  $('#sIn').onchange = e => { S.inDev = e.target.value; re(); };
  $('#sOut').onchange = e => { S.outDev = e.target.value; saveS(); Object.values(st.peers).forEach(applyVol); if (testEl && testEl.setSinkId) testEl.setSinkId(S.outDev).catch(() => {}); };
  $('#sInVol').oninput = e => { S.inVol = +e.target.value; $('#inVolV').textContent = Math.round(S.inVol * 100) + '%'; if (A.inGain) A.inGain.gain.value = S.inVol; saveS(); };
  $('#sOutVol').oninput = e => { S.outVol = +e.target.value; $('#outVolV').textContent = Math.round(S.outVol * 100) + '%'; Object.values(st.peers).forEach(applyVol); saveS(); };
  $$('input[name=ns]').forEach(r => r.onchange = async () => {
    const was = S.ns; S.ns = r.value; saveS();
    $$('.vc-nsopt').forEach(l => l.classList.toggle('on', l.contains(r)));
    if ((was === 'browser') !== (S.ns === 'browser')) await openMic(); else await rebuildChain();
  });
  $('#sHp').onchange = e => { S.hp = e.target.checked; saveS(); rebuildChain(); };
  $('#sEcho').onchange = e => { S.echo = e.target.checked; re(); };
  $('#sAgc').onchange = e => { S.agc = e.target.checked; re(); };
  $$('[data-mode]').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; saveS(); drawSettings(); renderConn(); postState(); });
  $('#sAuto').onchange = e => { S.sens = e.target.checked ? 'auto' : 'manual'; saveS(); $('#sSens').disabled = e.target.checked; };
  $('#sSens').oninput = e => { S.sensDb = +e.target.value; saveS(); };
  $('#sTest').onclick = toggleTest;
}
let testEl = null;
function toggleTest() {
  const b = $('#sTest');
  if (testEl) { testEl.pause(); testEl.srcObject = null; testEl = null; if (b) b.textContent = '🎧 Nghe thử giọng mình (sau khi lọc)'; return; }
  if (!A.dest) return;
  // nghe thử: lấy ngay sau bộ lọc (trước cổng mic) để nghe được cả khi chưa vào kênh
  const d2 = A.ctx.createMediaStreamDestination(); A.inGain.connect(d2);
  testEl = new Audio(); testEl.srcObject = d2.stream;
  if (S.outDev && testEl.setSinkId) testEl.setSinkId(S.outDev).catch(() => {});
  testEl.play().catch(() => {});
  if (b) b.textContent = '⏹ Dừng nghe thử';
  toast('Đeo tai nghe khi nghe thử để không bị hú.');
}

/* ------------------------------------------------------------ thẻ người dùng (bấm vào tên) */
function openPop(id, anchor) {
  const m = st.members.find(x => x.id === id); if (!m) return;
  const self = st.me && m.id === st.me.id;
  const pref = VOL[m.uid] || {};
  const pop = $('#pop');
  pop.innerHTML = `<div class="vc-pop-top" style="--c:${esc(m.color || '#19bde8')}"></div>
    <div class="vc-pop-av">${avatar(self ? {...m, self: true} : m, 72)}</div>
    <div class="vc-pop-b"><b${nameStyle(m)}>${esc(m.name)}</b>${m.host ? ' <span class="vc-crown">👑 Chủ phòng</span>' : ''}
      ${m.status ? `<p class="hint">${esc(m.status)}</p>` : ''}
      ${m.voice ? `<p class="hint">${IC.spk} ${esc((chanById(m.voice) || {}).name || '')}</p>` : ''}
      ${self ? '<button class="btn sm plain" type="button" data-pa="prof">Sửa hồ sơ</button>' : `
      <label class="field">Âm lượng của ${esc(m.name)} <span class="mono" id="uvV">${Math.round((pref.v ?? 1) * 100)}%</span>
        <input type="range" id="uv" min="0" max="2" step="0.05" value="${pref.v ?? 1}"></label>
      <label class="vc-chk"><input type="checkbox" id="um" ${pref.m ? 'checked' : ''}> Tắt tiếng người này (chỉ máy bạn)</label>
      ${isHost() && !m.host ? `<div class="vc-mod"><b class="hint">Quản lý (chủ phòng)</b>
        <button class="btn sm plain" type="button" data-pa="smute">${m.smute ? 'Bật lại mic' : 'Tắt mic người này'}</button>
        ${m.voice ? '<button class="btn sm plain" type="button" data-pa="move-out">Mời ra khỏi kênh thoại</button>' : ''}
        <button class="btn sm plain" type="button" data-pa="kick">Mời ra khỏi phòng</button>
        <button class="btn sm red" type="button" data-pa="ban">Chặn</button></div>` : ''}`}
    </div>`;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 16);
  pop.style.width = w + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left < window.innerWidth / 2 ? r.right + 8 : r.left - w - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(window.innerHeight - pop.offsetHeight - 8, r.top)) + 'px';
  const uv = $('#uv', pop);
  if (uv) {
    uv.oninput = () => { VOL[m.uid] = {...(VOL[m.uid] || {}), v: +uv.value}; $('#uvV', pop).textContent = Math.round(uv.value * 100) + '%'; jset('cv-voice-vol', VOL); Object.values(st.peers).forEach(applyVol); };
    $('#um', pop).onchange = e => { VOL[m.uid] = {...(VOL[m.uid] || {}), m: e.target.checked}; jset('cv-voice-vol', VOL); Object.values(st.peers).forEach(applyVol); };
  }
  $$('[data-pa]', pop).forEach(b => b.onclick = () => {
    const a = b.dataset.pa;
    if (a === 'prof') { pop.hidden = true; openSettings('prof'); return; }
    if ((a === 'kick' || a === 'ban') && !confirm(a === 'ban' ? `Chặn ${m.name}? Người này không vào lại được bằng trình duyệt này.` : `Mời ${m.name} ra khỏi phòng?`)) return;
    send({t: 'mod', a, id: m.id}); pop.hidden = true;
  });
}

/* ------------------------------------------------------------ mic / nghe / nhấn để nói */
function toggleMute() {
  if (!A.raw) { openMic().then(renderMe); return; }
  if (S.selfDeaf) { S.selfDeaf = false; S.selfMute = false; } else S.selfMute = !S.selfMute;
  beep(S.selfMute ? 'mute' : 'unmute');
  saveS(); sendState(); renderMe(); Object.values(st.peers).forEach(applyVol); postState();
}
function toggleDeaf() {
  S.selfDeaf = !S.selfDeaf;
  beep(S.selfDeaf ? 'mute' : 'unmute');
  saveS(); sendState(); renderMe(); Object.values(st.peers).forEach(applyVol); postState();
}
function pttSet(down) {
  if (down === A.ptt) return;
  A.ptt = down; if (!down) A.pttUp = performance.now();
}
const typing = e => e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyM') { e.preventDefault(); toggleMute(); return; }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); toggleDeaf(); return; }
  if (S.mode === 'ptt' && e.code === S.pttKey && !typing(e) && !$('#setDlg').open) { e.preventDefault(); pttSet(true); }
  if (e.key === 'Escape') $('#pop').hidden = true;
});
window.addEventListener('keyup', e => { if (S.mode === 'ptt' && e.code === S.pttKey) pttSet(false); });
window.addEventListener('mousedown', e => { if (S.mode === 'ptt' && e.button >= 3 && S.pttKey === 'Mouse' + (e.button + 1)) { e.preventDefault(); pttSet(true); } });
window.addEventListener('mouseup', e => { if (S.mode === 'ptt' && e.button >= 3 && S.pttKey === 'Mouse' + (e.button + 1)) pttSet(false); });
window.addEventListener('blur', () => { if (!EMBED) pttSet(false); });
// lệnh từ app CircleVault (phím tắt toàn cục, kể cả khi đang trong game)
window.addEventListener('message', e => {
  if (e.source !== window.parent || !e.data || !e.data.cvVoice) return;
  const c = e.data.cvVoice;
  if (c === 'mute') toggleMute(); else if (c === 'deaf') toggleDeaf();
  else if (c === 'ptt-down') pttSet(true); else if (c === 'ptt-up') pttSet(false);
  else if (c === 'leave') leaveVoice();
  else if (c === 'state') postState();
});
function postState() {
  if (!EMBED) return;
  const ch = st.voice ? chanById(st.voice) : null;
  const unread = Object.values(st.unread).reduce((a, b) => a + (b || 0), 0);
  post({
    overlay: S.overlay !== false, corner: S.corner || 'tl',
    voice: ch ? ch.name : null, mute: !!(S.selfMute || S.selfDeaf || !A.raw), deaf: !!S.selfDeaf, mode: S.mode, pttKey: S.pttKey, unread,
    people: st.voice ? st.members.filter(m => m.voice === st.voice).map(m => ({id: m.id, name: m.name, color: m.color,
      talk: st.talking.has(m.id), mute: !!(m.mute || m.smute), deaf: !!m.deaf,
      av: m.id === st.me?.id ? (P.avatar || '') : (m.av ? `${location.origin}/v/${code}/av/${m.id}?v=${m.av}` : '')})) : [],
  });
}

/* ------------------------------------------------------------ sự kiện */
document.addEventListener('click', e => {
  const t = e.target;
  if (!t.closest('#pop') && !$('#pop').hidden && !t.closest('[data-user]')) $('#pop').hidden = true;
  let el;
  if ((el = t.closest('[data-text]'))) { st.view = 't:' + el.dataset.text; render(); if (window.innerWidth > 800) $('#msgIn').focus(); return; }
  if ((el = t.closest('[data-voice]'))) { joinVoice(el.dataset.voice); return; }
  if ((el = t.closest('[data-gopane]'))) { setPane(el.dataset.gopane); return; }
  if (!t.closest('#people') && !t.closest('#memBtn') && !t.closest('#pop')) $('#people').hidden = true;
  if ((el = t.closest('[data-joinv]'))) { joinVoice(el.dataset.joinv); return; }
  if ((el = t.closest('[data-user]'))) { if (el.dataset.user) openPop(el.dataset.user, el); return; }
  if ((el = t.closest('[data-del]'))) { if (confirm('Xóa tin nhắn này?')) send({t: 'del', cid: st.view.slice(2), mid: el.dataset.del}); return; }
  if ((el = t.closest('[data-addch]'))) { st.editing = 'new-' + el.dataset.addch; renderChans(); return; }
  if ((el = t.closest('[data-ren]'))) { st.editing = el.dataset.ren; renderChans(); return; }
  if ((el = t.closest('[data-delch]'))) {
    const c = chanById(el.dataset.delch);
    if (c && confirm(`Xóa kênh ${c.kind === 'text' ? '#' : ''}${c.name}?${c.kind === 'text' ? ' Tin nhắn trong kênh vẫn còn trong máy chủ nhưng không hiện nữa.' : ''}`)) send({t: 'chan', a: 'del', cid: c.id});
    return;
  }
  if (st.editing && !t.closest('.vc-edit')) { st.editing = null; renderChans(); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-editform]'); if (!f) return;
  e.preventDefault();
  const id = f.dataset.editform, name = $('input', f).value.trim();
  if (name) send(id.startsWith('new-') ? {t: 'chan', a: 'add', kind: f.dataset.kind, name} : {t: 'chan', a: 'rename', cid: id, name});
  st.editing = null; renderChans();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.editing) { st.editing = null; renderChans(); } });
$('#compose').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#msgIn').value.trim();
  if (!v || !st.view.startsWith('t:')) return;
  send({t: 'chat', cid: st.view.slice(2), text: v});
  $('#msgIn').value = '';
});
$('#micBtn').onclick = toggleMute;
$('#deafBtn').onclick = toggleDeaf;
$('#setBtn').onclick = () => openSettings('voice');
$('#leaveBtn').onclick = () => leaveVoice();
$('#meWho').onclick = () => openSettings('prof');
$('#setClose').onclick = () => { if (testEl) toggleTest(); $('#setDlg').close(); };
$('#setDlg').addEventListener('close', () => { if (testEl) toggleTest(); if (setTab === 'prof') saveProfile(); });
$$('[data-stab]').forEach(b => b.onclick = () => openSettings(b.dataset.stab));
$('#memBtn').onclick = () => { $('#people').hidden = !$('#people').hidden; };
setPane('rooms');
$('#invBtn').onclick = async () => {
  if (EMBED) { post({invite: true}); return; }
  const url = location.origin + location.pathname;
  try { await navigator.clipboard.writeText(url); toast('Đã chép link mời. Gửi cho bạn bè nhé!'); } catch (e) { toast(url); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && st.view.startsWith('t:')) renderMain(); });

/* ------------------------------------------------------------ bắt đầu */
function start() {
  if (!window.RTCPeerConnection || !navigator.mediaDevices) {
    toast('Trình duyệt này không hỗ trợ gọi thoại. Dùng Chrome, Edge hoặc Firefox mới.', 'err');
  }
  connect();
  renderMe();
}
if (P.name || hostKey) { if (!P.name) P.name = 'Chủ phòng'; start(); }
else {
  const dlg = $('#joinDlg'), prof = $('#joinProf');
  prof.innerHTML = profEditor(); bindProf(prof);
  dlg.showModal();
  $('#joinForm').addEventListener('submit', e => {
    if (!P.name) { e.preventDefault(); $('#pName').focus(); return; }
    saveP(); start();
  });
  dlg.addEventListener('cancel', e => e.preventDefault());
}
})();
