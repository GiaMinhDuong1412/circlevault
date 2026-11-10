/* CircleVault – bộ chỉnh âm (EQ) 10 dải + bộ máy âm thanh Web Audio.
 *
 * Chuỗi xử lý:  <audio> → Preamp (gain) → 10 BiquadFilter → Cân bằng trái/phải → Chống rè (limiter) → Analyser → loa
 *   dải 31 Hz là low-shelf, 16 kHz là high-shelf, còn lại là peaking (Q 1,41 ≈ 1 quãng tám) – giống EQ đồ hoạ 10 dải
 *   của Winamp/foobar2000/Peace.
 * Đường cong đáp tuyến vẽ từ BiquadFilterNode.getFrequencyResponse() trên một OfflineAudioContext riêng, nên hiện được
 * cả khi chưa phát nhạc.
 */
(() => {
'use strict';
const {esc} = window.CV;

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
const Q = 1.41;
const MAX_DB = 12;

/* Ý nghĩa từng dải – tổng hợp từ các bảng tần số mix nhạc phổ biến */
const BAND_INFO = [
  ['Sub-bass', 'Độ rung, cảm giác "đập ngực". Loa laptop/điện thoại gần như không phát được dải này.'],
  ['Bass sâu', 'Trống kick, bass EDM, hip-hop. Tăng ở đây là cách "bass mạnh" ít làm đục giọng nhất.'],
  ['Bass ấm', 'Độ dày của nhạc cụ, giọng nam trầm. Tăng nhẹ cho nhạc nghe ấm hơn.'],
  ['Ấm / đục', 'Nhiều quá nghe ù, "đục", giọng bị chìm. Giảm 1–3 dB thường giúp giọng rõ ra.'],
  ['Thân âm', 'Phần thân nhạc cụ. Nhiều quá nghe như "trong hộp", nghẹt mũi.'],
  ['Trung âm', 'Độ rõ của giọng và nhạc cụ chính. Giữ gần 0 cho tự nhiên.'],
  ['Chi tiết giọng', 'Độ rõ chữ, tiếng gảy đàn. Tăng nhẹ để nghe rõ lời.'],
  ['Presence', 'Giọng "nổi" lên trước nhạc. Tăng quá +4 dB dễ chói, mỏi tai khi nghe lâu.'],
  ['Độ sáng', 'Tiếng chũm chọe, âm "s", "x". Nhiều quá nghe xì, rát tai.'],
  ['Không khí', 'Độ thoáng, lấp lánh. Tăng nhẹ cho bản thu nghe "mở" hơn.'],
];

/* Preset có sẵn (dB cho 31…16K). Tham khảo các preset của Winamp, Spotify, Peace/Equalizer APO và hướng dẫn EQ giọng hát */
const PRESETS = {
  flat:     {name: 'Phẳng (gốc)',       g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],       d: 'Âm thanh nguyên bản, không chỉnh.'},
  bass:     {name: 'Tăng Bass',          g: [5, 6, 4, 1, 0, 0, 0, 0, 0, 0],       d: 'Bass chắc, đập mạnh mà giọng vẫn rõ: tăng 31–125 Hz, giữ nguyên 250 Hz trở lên.'},
  bassplus: {name: 'Bass cực mạnh',      g: [8, 7, 5, 2, -1, -1, 0, 1, 2, 2],     d: 'Cho EDM, remix, nhạc sàn. Nên bật "Chống rè" và dùng tai nghe/loa có sub.'},
  vocal:    {name: 'Giọng hát rõ',       g: [-2, -1, -1, -2, 0, 1, 3, 3, 2, 1],   d: 'Giảm vùng đục 250 Hz, tăng 2–4 kHz cho giọng nổi lên, 8 kHz chỉ +2 để không xì.'},
  ballad:   {name: 'Ballad / Bolero',    g: [1, 2, 2, 0, -1, 1, 2, 2, 1, 1],      d: 'Giọng ấm, mượt, hơi nổi; bass nhẹ đỡ nền. Hợp nhạc trữ tình, acoustic có lời.'},
  pop:      {name: 'Pop / V-Pop',        g: [-1, 1, 2, 1, -1, 0, 1, 2, 3, 3],     d: 'Bass gọn, giọng sáng, nhiều "không khí".'},
  rock:     {name: 'Rock',               g: [5, 4, 2, -1, -2, -1, 1, 3, 4, 4],    d: 'Hình chữ V: kick và guitar mạnh, trung âm lùi lại.'},
  edm:      {name: 'EDM / Dance',        g: [6, 5, 2, 0, -2, 0, 1, 2, 4, 4],      d: 'Bass sâu + treble sáng.'},
  acoustic: {name: 'Acoustic',           g: [2, 2, 2, 1, 1, 1, 2, 2, 2, 2],       d: 'Đàn mộc, piano, giọng mộc: ấm và chi tiết, ít thay đổi.'},
  classic:  {name: 'Cổ điển / Hòa tấu',  g: [3, 2, 1, 0, 0, 0, 0, 1, 2, 3],       d: 'Mở rộng hai đầu dải, giữ nguyên trung âm.'},
  podcast:  {name: 'Podcast / Lời nói',  g: [-6, -4, -2, 0, 1, 2, 3, 2, 0, -2],   d: 'Bớt ù, tiếng nói rõ hơn. Hợp video bài giảng, sách nói.'},
  night:    {name: 'Nghe nhỏ ban đêm',   g: [4, 3, 1, 0, 0, 0, 0, 1, 2, 3],       d: 'Tai người nghe kém bass/treble khi âm lượng nhỏ; preset này bù lại.'},
  laptop:   {name: 'Loa laptop / điện thoại', g: [-4, -2, 3, 3, 1, 0, 1, 2, 1, 0], d: 'Loa nhỏ không phát được dưới 100 Hz: bỏ bớt dải đó (tránh rè), tăng 125–250 Hz để nghe đầy hơn.'},
  treble:   {name: 'Tăng Treble',        g: [0, 0, 0, 0, 0, 1, 2, 4, 5, 5],       d: 'Sáng, chi tiết. Tai nghe "tối tiếng" sẽ hợp.'},
};

const DEFAULT = {enabled: true, preset: 'flat', gains: PRESETS.flat.g.slice(), preamp: 0, autoPreamp: true, limiter: true,
  balance: 0, custom: {}};

/* ------------------------------------------------------------ máy âm thanh */
class Engine {
  constructor(audio) { this.audio = audio; this.ctx = null; this.st = {...DEFAULT}; }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.src = ctx.createMediaElementSource(this.audio);
    this.pre = ctx.createGain();
    this.filters = BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = Q; b.gain.value = 0;
      return b;
    });
    this.pan = ctx.createStereoPanner();
    this.limiter = ctx.createDynamicsCompressor();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.82;
    let node = this.src.connect(this.pre);
    for (const f of this.filters) node = node.connect(f);
    node.connect(this.pan).connect(this.limiter).connect(this.analyser).connect(ctx.destination);
    this.apply(this.st);
  }
  resume() { this.init(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
  apply(st) {
    this.st = st;
    if (!this.ctx) return;
    const t = this.ctx.currentTime, on = st.enabled;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? st.gains[i] : 0, t, 0.03));
    this.pre.gain.setTargetAtTime(Math.pow(10, (on ? preampDb(st) : 0) / 20), t, 0.03);
    this.pan.pan.setTargetAtTime(st.balance || 0, t, 0.03);
    const L = this.limiter;
    if (st.limiter) { L.threshold.value = -1.5; L.knee.value = 0; L.ratio.value = 20; L.attack.value = 0.002; L.release.value = 0.12; }
    else { L.threshold.value = 0; L.knee.value = 0; L.ratio.value = 1; }
  }
}
/* Preamp tự động: hạ đúng bằng mức tăng lớn nhất để tổng không vượt 0 dB (cách Peace/Equalizer APO khuyên dùng) */
function preampDb(st) { return st.autoPreamp ? -Math.max(0, ...st.gains) : st.preamp; }

/* ------------------------------------------------------------ đường cong đáp tuyến */
const design = (() => {
  try {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OC(1, 128, 44100);
    const filters = BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = Q;
      return b;
    });
    return {filters};
  } catch (e) { return null; }
})();
const N = 220;
const FREQS = new Float32Array(N).map((_, i) => 20 * Math.pow(1000, i / (N - 1)));   // 20 Hz → 20 kHz, thang log
function responseDb(st) {
  const out = new Float32Array(N).fill(st.enabled ? preampDb(st) : 0);
  if (!design || !st.enabled) return out;
  const mag = new Float32Array(N), ph = new Float32Array(N);
  design.filters.forEach((f, i) => {
    f.gain.value = st.gains[i];
    f.getFrequencyResponse(FREQS, mag, ph);
    for (let k = 0; k < N; k++) out[k] += 20 * Math.log10(mag[k] || 1e-6);
  });
  return out;
}

/* ------------------------------------------------------------ giao diện EQ */
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

function createEQ({mount, engine, initial, onChange}) {
  let st = {...DEFAULT, ...(initial || {}), custom: {...((initial || {}).custom || {})}};
  st.gains = (st.gains && st.gains.length === 10) ? st.gains.slice() : DEFAULT.gains.slice();
  engine.apply(st);

  mount.innerHTML = `
  <div class="eq box" id="eqBox">
    <div class="eq-head">
      <div><h3>Bộ chỉnh âm (EQ) 10 dải</h3><p class="hint" id="eqDesc"></p></div>
      <label class="switch"><input type="checkbox" id="eqOn"><span>Bật EQ</span></label>
    </div>
    <div class="eq-presets" id="eqPresets"></div>
    <div class="eq-graph"><canvas id="eqCanvas" aria-label="Đường cong chỉnh âm và phổ âm thanh"></canvas></div>
    <div class="eq-sliders">
      <div class="eq-band pre">
        <output id="preOut"></output>
        <input type="range" id="preamp" min="-12" max="6" step="0.5" aria-label="Preamp">
        <span>Preamp</span>
      </div>
      ${BANDS.map((f, i) => `<div class="eq-band" data-i="${i}">
        <output id="bandOut${i}"></output>
        <input type="range" id="band${i}" min="-${MAX_DB}" max="${MAX_DB}" step="0.5" aria-label="${LABELS[i]} Hz">
        <span>${LABELS[i]}</span></div>`).join('')}
    </div>
    <p class="eq-info" id="eqInfo">Rê chuột hoặc chạm vào một thanh để xem dải đó ảnh hưởng gì tới âm thanh.</p>
    <div class="eq-opts">
      <label class="check"><input type="checkbox" id="autoPre"> Tự hạ preamp để không rè</label>
      <label class="check"><input type="checkbox" id="limiter"> Chống rè (limiter)</label>
      <label class="field bal">Cân bằng trái / phải<input type="range" id="balance" min="-1" max="1" step="0.05"></label>
      <div class="save-row">
        <input type="text" id="presetName" placeholder="Tên preset của bạn" maxlength="30" aria-label="Tên preset">
        <button class="btn sm yellow" type="button" id="savePreset">Lưu preset</button>
        <button class="btn sm plain" type="button" id="resetEq">Về phẳng</button>
      </div>
    </div>
    <details class="eq-guide">
      <summary>Mẹo chỉnh: mức nào hợp cho giọng hát, cho bass?</summary>
      <div class="guide-grid">
        <div><b>Giọng hát rõ, nổi</b><ul>
          <li>Giảm <b>250 Hz</b> khoảng −1 đến −3 dB: bớt ù, đục.</li>
          <li>Tăng <b>2K–4K</b> khoảng +2 đến +4 dB: giọng tiến lên trước nhạc.</li>
          <li><b>8K</b> tối đa +2 dB, nhiều hơn dễ xì tiếng "s".</li></ul></div>
        <div><b>Bass mạnh mà không đục</b><ul>
          <li>Tăng <b>62–125 Hz</b> +3 đến +6 dB.</li>
          <li>Không tăng <b>250 Hz</b> cùng lúc (vùng này làm ù).</li>
          <li>Loa laptop: tăng 125 thay vì 31–62 (loa không phát nổi).</li></ul></div>
        <div><b>Tránh rè, méo tiếng</b><ul>
          <li>Ưu tiên <b>giảm</b> dải thừa hơn là tăng dải thiếu.</li>
          <li>Giữ bật "Tự hạ preamp" và "Chống rè".</li>
          <li>Tăng càng nhiều dB thì âm lượng tổng càng nhỏ lại: đó là để không méo.</li></ul></div>
      </div>
      <table class="band-table"><tbody>${BANDS.map((f, i) => `<tr><td>${LABELS[i]}${f < 1000 ? ' Hz' : 'Hz'}</td><td><b>${BAND_INFO[i][0]}</b></td><td>${BAND_INFO[i][1]}</td></tr>`).join('')}</tbody></table>
    </details>
  </div>`;

  const $ = (s) => mount.querySelector(s);
  const canvas = $('#eqCanvas');

  function renderPresets() {
    const builtIn = Object.entries(PRESETS).map(([k, p]) =>
      `<button type="button" class="chip ${st.preset === k ? 'on' : ''}" data-p="${k}" title="${esc(p.d)}">${esc(p.name)}</button>`);
    const custom = Object.keys(st.custom).map(n =>
      `<span class="chip-wrap"><button type="button" class="chip ${st.preset === 'u:' + n ? 'on' : ''}" data-p="u:${esc(n)}">★ ${esc(n)}</button><button type="button" class="chip-x" data-del="${esc(n)}" aria-label="Xóa preset ${esc(n)}">×</button></span>`);
    $('#eqPresets').innerHTML = builtIn.concat(custom).join('');
    const p = st.preset.startsWith('u:') ? {d: 'Preset bạn tự lưu.'} : PRESETS[st.preset];
    $('#eqDesc').textContent = p ? p.d : 'Đang dùng mức chỉnh tự do.';
  }
  function fmtDb(v) { return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toString().replace('.', ','); }
  function sync() {
    $('#eqOn').checked = st.enabled;
    $('#eqBox').classList.toggle('off', !st.enabled);
    st.gains.forEach((g, i) => { $('#band' + i).value = g; $('#bandOut' + i).textContent = fmtDb(g); });
    const pre = preampDb(st);
    $('#preamp').value = pre; $('#preamp').disabled = st.autoPreamp; $('#preOut').textContent = fmtDb(pre);
    $('#autoPre').checked = st.autoPreamp; $('#limiter').checked = st.limiter; $('#balance').value = st.balance;
    renderPresets(); drawCurve();
  }
  function changed() { engine.apply(st); sync(); onChange && onChange(st); }

  /* ---- vẽ */
  let spectrum = null;
  function drawCurve() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const xOf = f => Math.log(f / 20) / Math.log(1000) * W;
    const yOf = db => H / 2 - db / 15 * (H / 2 - 10);
    // lưới
    g.strokeStyle = css('--grid'); g.lineWidth = 1; g.font = '10px ' + css('--f-mono'); g.fillStyle = css('--muted');
    for (const db of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, yOf(db)); g.lineTo(W, yOf(db)); g.stroke(); g.fillText((db > 0 ? '+' : '') + db + ' dB', 4, yOf(db) - 3); }
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => { g.beginPath(); g.moveTo(xOf(f), 0); g.lineTo(xOf(f), H); g.stroke(); });
    ['100', '1K', '10K'].forEach((l, i) => g.fillText(l, xOf([100, 1000, 10000][i]) + 3, H - 4));
    // phổ đang phát
    if (spectrum) {
      const {data, rate} = spectrum, bins = data.length, bars = 72;
      g.fillStyle = css('--spec');
      for (let b = 0; b < bars; b++) {
        const f0 = 20 * Math.pow(1000, b / bars), f1 = 20 * Math.pow(1000, (b + 1) / bars);
        const i0 = Math.max(1, Math.floor(f0 / (rate / 2) * bins)), i1 = Math.max(i0 + 1, Math.floor(f1 / (rate / 2) * bins));
        let m = 0; for (let i = i0; i < i1 && i < bins; i++) m = Math.max(m, data[i]);
        const h = m / 255 * (H - 8);
        g.fillRect(xOf(f0) + 1, H - h, Math.max(1, xOf(f1) - xOf(f0) - 2), h);
      }
    }
    // đường cong
    const r = responseDb(st);
    g.beginPath();
    for (let k = 0; k < N; k++) { const x = k / (N - 1) * W, y = yOf(Math.max(-15, Math.min(15, r[k]))); k ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = st.enabled ? css('--accent-line') : css('--muted'); g.lineWidth = 3; g.stroke();
    g.lineTo(W, yOf(0)); g.lineTo(0, yOf(0)); g.closePath();
    g.fillStyle = st.enabled ? css('--accent-fill') : 'transparent'; g.fill();
    // điểm từng dải
    if (st.enabled) BANDS.forEach((f, i) => {
      g.beginPath(); g.arc(xOf(f), yOf(st.gains[i]), 4.5, 0, Math.PI * 2);
      g.fillStyle = css('--yellow'); g.fill(); g.lineWidth = 2; g.strokeStyle = css('--ink'); g.stroke();
    });
  }
  let raf = 0;
  function loop() {
    raf = 0;
    if (!engine.analyser || engine.audio.paused || !canvas.isConnected || !canvas.offsetParent) { spectrum = null; drawCurve(); return; }
    const data = new Uint8Array(engine.analyser.frequencyBinCount);
    engine.analyser.getByteFrequencyData(data);
    spectrum = {data, rate: engine.ctx.sampleRate};
    drawCurve();
    raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf && !matchMedia('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(loop); else drawCurve(); };
  engine.audio.addEventListener('play', kick);
  engine.audio.addEventListener('pause', () => setTimeout(drawCurve, 50));
  new ResizeObserver(() => drawCurve()).observe(canvas);

  /* ---- sự kiện */
  $('#eqPresets').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { delete st.custom[del.dataset.del]; if (st.preset === 'u:' + del.dataset.del) st.preset = 'custom'; return changed(); }
    const b = e.target.closest('[data-p]'); if (!b) return;
    const k = b.dataset.p;
    st.gains = (k.startsWith('u:') ? st.custom[k.slice(2)] : PRESETS[k].g).slice();
    st.preset = k; st.enabled = true; changed();
  });
  mount.querySelectorAll('.eq-band[data-i]').forEach(el => {
    const i = +el.dataset.i, input = el.querySelector('input');
    input.addEventListener('input', () => { st.gains[i] = +input.value; st.preset = 'custom'; changed(); });
    input.addEventListener('dblclick', () => { st.gains[i] = 0; st.preset = 'custom'; changed(); });
    const info = () => { $('#eqInfo').innerHTML = `<b>${LABELS[i]}${BANDS[i] < 1000 ? ' Hz' : 'Hz'} · ${esc(BAND_INFO[i][0])}:</b> ${esc(BAND_INFO[i][1])} <span class="hint">(bấm đúp để về 0)</span>`; };
    el.addEventListener('mouseenter', info); input.addEventListener('focus', info);
  });
  $('#preamp').addEventListener('input', e => { st.preamp = +e.target.value; changed(); });
  $('#eqOn').addEventListener('change', e => { st.enabled = e.target.checked; changed(); });
  $('#autoPre').addEventListener('change', e => { st.autoPreamp = e.target.checked; if (!st.autoPreamp) st.preamp = preampDb({...st, autoPreamp: true}); changed(); });
  $('#limiter').addEventListener('change', e => { st.limiter = e.target.checked; changed(); });
  $('#balance').addEventListener('input', e => { st.balance = +e.target.value; changed(); });
  $('#balance').addEventListener('dblclick', () => { st.balance = 0; changed(); });
  $('#savePreset').addEventListener('click', () => {
    const name = $('#presetName').value.trim();
    if (!name) { $('#presetName').focus(); return window.CV.toast('Đặt tên cho preset trước khi lưu.', 'err'); }
    st.custom[name] = st.gains.slice(); st.preset = 'u:' + name; $('#presetName').value = '';
    changed(); window.CV.toast(`Đã lưu preset "${name}".`);
  });
  $('#resetEq').addEventListener('click', () => { st.gains = PRESETS.flat.g.slice(); st.preset = 'flat'; changed(); });

  sync();
  return {
    get state() { return st; },
    redraw: drawCurve,
    toggle() { st.enabled = !st.enabled; changed(); },
  };
}

window.CV.eq = {Engine, createEQ, PRESETS, BANDS};
})();
