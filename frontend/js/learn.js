/* CircleVault – tab "Học": IELTS, tiếng Nhật, tiếng Trung, tiếng Hàn (bộ thẻ + ôn tập ngắt quãng). */
(() => {
'use strict';
const {api, esc, toast} = window.CV;
const $ = (s, r = document) => r.querySelector(s);

const SUBJ = {
  ielts: {mark: 'EN', color: 'var(--cyan)', tag: 'Band 5.0 → 8.0', blurb: 'Từ vựng học thuật + 4 kỹ năng thi IELTS'},
  ja: {mark: 'あ', color: 'var(--pink)', tag: 'JLPT N5 → N1', blurb: 'Kana, từ vựng, Kanji, ngữ pháp'},
  zh: {mark: '中', color: 'var(--yellow)', tag: 'HSK 1 → 6', blurb: 'Pinyin, từ vựng, Hán tự, ngữ pháp'},
  ko: {mark: '한', color: 'var(--violet)', tag: 'TOPIK I → II', blurb: 'Hangul, từ vựng, ngữ pháp'},
};
/* Nội dung dự kiến của từng mục (dữ liệu sẽ nhập ở các bản sau). */
const PLAN = {
  'ielts/vocab': 'Chọn một cấp trong “Lộ trình chuẩn” ở trên (CEFR A1 → C2) để có bộ từ vựng theo cấp; hoặc tự nhập bộ theo chủ đề.',
  'ielts/listening': 'Luyện nghe Part 1–4: audio, câu hỏi, đáp án và transcript; ghi lại từ hay bị nghe nhầm.',
  'ielts/reading': 'Bài đọc Academic / General với các dạng True/False/Not Given, Matching Headings, Summary completion.',
  'ielts/writing': 'Đề Task 1 (biểu đồ, quy trình, thư) và Task 2 (nghị luận), bài mẫu band 7+, cấu trúc câu, từ nối.',
  'ielts/speaking': 'Câu hỏi Part 1–3 theo chủ đề, cue card, câu trả lời mẫu và từ vựng ăn điểm.',
  'ja/kana': 'Hiragana và Katakana: âm cơ bản, âm đục, âm ghép.',
  'ja/vocab': 'Chọn một cấp JLPT (N5 → N1) trong “Lộ trình chuẩn” ở trên để có bộ từ vựng theo cấp.',
  'ja/kanji': 'Kanji theo cấp JLPT: âm On / Kun, Hán Việt, bộ thủ, từ ghép thường gặp.',
  'ja/grammar': 'Mẫu ngữ pháp N5 → N1: cấu trúc, cách dùng, ví dụ có dịch.',
  'zh/pinyin': 'Thanh điệu, thanh mẫu, vận mẫu – nghe và đọc theo.',
  'zh/vocab': 'Chọn một cấp HSK 3.0 (1 → 9) trong “Lộ trình chuẩn” ở trên để có bộ từ vựng theo cấp.',
  'zh/hanzi': 'Chữ Hán: bộ thủ, số nét, Hán Việt, từ ghép.',
  'zh/grammar': 'Ngữ pháp HSK theo cấp: cấu trúc câu, trợ từ, bổ ngữ.',
  'ko/hangul': 'Nguyên âm, phụ âm, phụ âm căng/bật hơi, patchim.',
  'ko/vocab': 'Chọn TOPIK I cấp 1 hoặc 2 trong “Lộ trình chuẩn” ở trên; TOPIK II nhập thêm bằng file.',
  'ko/grammar': 'Ngữ pháp sơ – trung – cao cấp: đuôi câu, tiểu từ, cấu trúc thường thi.',
};
const CHART = new Set(['kana', 'hangul', 'pinyin']);
const MODES = [['card', 'Thẻ ghi nhớ'], ['quiz', 'Trắc nghiệm'], ['type', 'Gõ đáp án']];
const GRADES = [['Quên', 'red'], ['Khó', 'yellow'], ['Nhớ', 'green'], ['Dễ', 'cyan']];

const L = {subject: null, section: null, deck: null, study: null, quiz: null, mode: 'card', ov: null, sv: null, plan: false, editPlan: false};
try {
  L.subject = localStorage.getItem('cv-ln-subj') || null;
  L.mode = localStorage.getItem('cv-ln-mode') || 'card';
} catch (e) { /* bỏ qua */ }
const keep = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } };

/* ---------------------------------------------------------------- đọc phát âm (giọng có sẵn trong Windows / trình duyệt) */
function voiceFor(lang) {
  const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  const base = lang.split('-')[0];
  return vs.find(v => v.lang === lang) || vs.find(v => v.lang && v.lang.toLowerCase().startsWith(base)) || null;
}
function speak(text, lang) {
  if (!window.speechSynthesis || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[\/]/g, ' '));
  u.lang = lang;
  const v = voiceFor(lang);
  if (v) u.voice = v;
  u.rate = lang.startsWith('en') ? 0.95 : 0.85;
  speechSynthesis.speak(u);
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { if (L.ov && $('#lnVoice')) paintVoiceHint(); };
function paintVoiceHint() {
  const el = $('#lnVoice');
  if (!el || !L.sv) return;
  el.hidden = !!voiceFor(L.sv.lang) || !window.speechSynthesis;
}

/* ---------------------------------------------------------------- khung chính */
async function render() {
  const box = $('#lnBox');
  if (!box) return;
  if (L.study) return paintStudy();
  if (L.quiz) return paintQuiz();
  try { L.ov = await api('/api/learn'); } catch (e) { box.innerHTML = `<div class="notice box err"><b>Không tải được tab Học</b><span>${esc(e.message)}</span></div>`; return; }
  if (L.subject && !SUBJ[L.subject]) L.subject = null;
  const ov = L.ov;
  const today = ov.subjects.reduce((a, s) => a + s.today.reviews, 0);
  box.innerHTML = `
    <div class="ln-hero">
      <div><h2>Học ngoại ngữ</h2><p class="hint">Mỗi ngày một chút: thẻ đến hạn ôn trước, rồi thẻ mới. Ôn đúng lúc sắp quên để nhớ lâu.</p></div>
      <div class="ln-badges">
        <span class="ln-streak${ov.streak ? ' on' : ''}" title="Số ngày học liên tiếp"><b>${ov.streak}</b> ngày liên tiếp</span>
        <span class="ln-today"><b>${today}</b> thẻ hôm nay</span>
      </div>
    </div>
    <div class="ln-subjects${L.subject ? ' compact' : ''}">${ov.subjects.map(s => subjectCard(s)).join('')}</div>
    <div id="lnMain" class="main"></div>`;
  box.querySelectorAll('[data-subj]').forEach(b => b.addEventListener('click', () => {
    L.subject = L.subject === b.dataset.subj ? null : b.dataset.subj; L.section = null; L.deck = null;
    keep('cv-ln-subj', L.subject); render();
  }));
  if (L.deck) return renderDeck();
  if (L.subject) return renderSubject();
  renderOverview();
}

function subjectCard(s) {
  const m = SUBJ[s.id];
  const pct = s.total ? Math.round(s.learned / s.total * 100) : 0;
  return `<button type="button" class="ln-subj box${L.subject === s.id ? ' on' : ''}" data-subj="${s.id}" aria-pressed="${L.subject === s.id}">
    <span class="ln-mark" style="background:${m.color}" lang="${s.lang}">${m.mark}</span>
    <span class="ln-subj-t"><b>${esc(s.name)}</b><small>${m.tag}</small></span>
    <span class="ln-subj-n">${s.due ? `<em class="due">${s.due} cần ôn</em>` : ''}${s.total ? `<em>${s.learned}/${s.total} đã thuộc</em>` : '<em>Chưa có dữ liệu</em>'}</span>
    <span class="bar" aria-hidden="true"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:${m.color}"></i></span>
  </button>`;
}

function renderOverview() {
  const ov = L.ov;
  const max = Math.max(1, ...ov.days.map(d => d.reviews));
  const cells = ov.days.map(d => {
    const lv = d.reviews ? Math.min(4, 1 + Math.floor(d.reviews / max * 3.99)) : 0;
    return `<i class="l${lv}" title="${d.day}: ${d.reviews} thẻ"></i>`;
  }).join('');
  $('#lnMain').innerHTML = `
    <div id="lnToday"></div>
    <div class="cols2">
      <div class="box pcard">
        <h3>12 tuần gần đây</h3>
        <div class="ln-heat" role="img" aria-label="Số thẻ đã ôn mỗi ngày trong 12 tuần">${cells}</div>
        <p class="hint">Mỗi ô là một ngày, màu đậm là ôn nhiều. Ngày học tính từ 4 giờ sáng.</p>
      </div>
      <div class="box pcard">
        <h3>Bắt đầu thế nào?</h3>
        <ol class="steps">
          <li>Chọn một môn ở trên.</li>
          <li>Tiếng Nhật / Hàn / Trung: học <b>bảng chữ</b> trước (có sẵn), bấm từng chữ để nghe đọc.</li>
          <li>Chọn <b>Lộ trình chuẩn</b> (CEFR / JLPT / HSK / TOPIK) và số từ mới mỗi ngày.</li>
          <li>Mỗi sáng chọn <b>Hôm nay học gì</b> ở trên, rồi bấm Bắt đầu. App nhắc học vào giờ bạn chọn.</li>
          <li>Học thẻ: tự đánh giá Quên / Khó / Nhớ / Dễ, app tự xếp lịch ôn. Học đủ từ thì làm <b>bài tập</b> và <b>kiểm tra tuần</b>.</li>
        </ol>
      </div>
    </div>`;
  paintToday();
}

/* ---------------------------------------------------------------- một môn */
async function renderSubject() {
  const el = $('#lnMain');
  el.innerHTML = '<div class="loading"><span class="spin"></span>Đang tải…</div>';
  let v;
  try { v = await api(`/api/learn/subject/${L.subject}`); } catch (e) { el.innerHTML = `<div class="notice box err">${esc(e.message)}</div>`; return; }
  L.sv = v;
  if (!L.section || !v.sections.some(s => s[0] === L.section)) L.section = v.sections[0][0];
  const st = v.stats;
  const todo = st.due + Math.min(v.new_left, st.new);
  el.innerHTML = `
    <div class="ln-dash box">
      <div class="ln-tiles">
        <div class="ln-tile red"><b>${st.due}</b><span>cần ôn hôm nay</span></div>
        <div class="ln-tile yellow"><b>${Math.min(v.new_left, st.new)}</b><span>thẻ mới còn lại hôm nay</span></div>
        <div class="ln-tile green"><b>${st.learned}</b><span>đã thuộc</span></div>
        <div class="ln-tile"><b>${st.total}</b><span>tổng số thẻ</span></div>
      </div>
      <div class="ln-go">
        <div class="tr-seg" role="group" aria-label="Cách học">${MODES.map(([k, n]) => `<button type="button" class="chip${L.mode === k ? ' on' : ''}" data-mode="${k}">${n}</button>`).join('')}</div>
        <button class="btn green ln-start" type="button" id="lnStart" ${todo ? '' : 'disabled'}>${todo ? `HỌC NGAY · ${todo} thẻ` : 'HÔM NAY ĐÃ XONG'}</button>
      </div>
      <p class="hint" id="lnVoice" hidden>Máy chưa có giọng đọc ${{ielts: 'tiếng Anh', ja: 'tiếng Nhật', zh: 'tiếng Trung', ko: 'tiếng Hàn'}[v.id]}: Windows → Cài đặt → Thời gian &amp; ngôn ngữ → Ngôn ngữ → thêm ngôn ngữ này (kèm “Chuyển văn bản thành giọng nói”).</p>
    </div>
    <div class="cols2 ln-pt"><div class="box pcard" id="lnPath"></div><div class="box pcard" id="lnTests"></div></div>
    <div class="ln-secs" role="tablist">${v.sections.map(([k, n]) => {
      const c = v.decks.filter(d => d.section === k).reduce((a, d) => a + d.total, 0);
      return `<button type="button" class="ln-sec${L.section === k ? ' on' : ''}" data-sec="${k}" role="tab" aria-selected="${L.section === k}">${n}<small>${c ? c + ' thẻ' : 'trống'}</small></button>`;
    }).join('')}</div>
    <div id="lnSec" class="main"></div>
    <details class="box pcard tr-help"><summary>Cài đặt học</summary>
      <div class="ln-set">
        <label class="field">Thẻ mới mỗi ngày (mỗi môn)<input type="number" id="lnNew" min="0" max="200" value="${v.settings.new_per_day}"></label>
        <label class="check"><input type="checkbox" id="lnSpeak" ${v.settings.auto_speak ? 'checked' : ''}> Tự đọc phát âm khi lật thẻ</label>
      </div>
    </details>`;
  paintVoiceHint();
  el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    L.mode = b.dataset.mode; keep('cv-ln-mode', L.mode);
    el.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#lnStart').addEventListener('click', () => startStudy({subject: L.subject}));
  el.querySelectorAll('[data-sec]').forEach(b => b.addEventListener('click', () => {
    L.section = b.dataset.sec;
    el.querySelectorAll('[data-sec]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    paintSection();
  }));
  $('#lnNew').addEventListener('change', e => api('/api/learn/settings', {method: 'PUT', body: {new_per_day: +e.target.value}}).then(() => render()).catch(err => toast(err.message, 'err')));
  $('#lnSpeak').addEventListener('change', e => api('/api/learn/settings', {method: 'PUT', body: {auto_speak: e.target.checked}}).then(s => { L.sv.settings = s; }).catch(err => toast(err.message, 'err')));
  paintSection();
  paintPath();
  paintTests();
}

function paintSection() {
  const v = L.sv, el = $('#lnSec');
  const decks = v.decks.filter(d => d.section === L.section);
  const secName = (v.sections.find(s => s[0] === L.section) || ['', ''])[1];
  const plan = PLAN[`${v.id}/${L.section}`] || '';
  el.innerHTML = `
    ${decks.length ? `<div class="ln-decks">${decks.map(d => deckCard(d)).join('')}</div>` : `
      <div class="box empty ln-empty">
        <span class="badge" style="background:var(--yellow)">Sắp có</span>
        <h3>${esc(secName)}</h3>
        <p>${esc(plan)}</p>
        <p>Dữ liệu cho mục này sẽ được thêm ở bản cập nhật sau. Trong lúc chờ, bạn có thể tự tạo bộ thẻ hoặc nhập file.</p>
      </div>`}
    ${CHART.has(L.section) && decks.length ? '<div id="lnChart"></div>' : ''}
    <div class="box pcard ln-add">
      <div class="row-between"><h3>Thêm bộ thẻ vào “${esc(secName)}”</h3></div>
      <form class="paste-row" id="lnNewDeck">
        <input type="text" id="lnDeckName" placeholder="Tên bộ thẻ, ví dụ: ${v.id === 'ja' ? 'JLPT N5 – Bài 1' : v.id === 'zh' ? 'HSK 1 – Chào hỏi' : v.id === 'ko' ? 'TOPIK I – Gia đình' : 'Topic: Environment'}" aria-label="Tên bộ thẻ">
        <input type="text" id="lnDeckLevel" placeholder="Cấp độ (tùy chọn)" aria-label="Cấp độ" class="ln-lv">
        <button class="btn yellow" type="submit">TẠO BỘ THẺ</button>
      </form>
      <div class="btn-row"><label class="btn sm cyan">Nhập file JSON / CSV…<input type="file" id="lnImport" accept=".json,.csv,.tsv,.txt" hidden></label>
        <span class="hint">CSV có hàng tiêu đề: <code>front,reading,meaning,example,example_vi</code> (hoặc word, pinyin, nghĩa…).</span></div>
    </div>`;
  el.querySelectorAll('[data-deck]').forEach(c => c.addEventListener('click', e => deckAct(e, +c.dataset.deck)));
  $('#lnNewDeck').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#lnDeckName').value.trim();
    if (!name) return;
    try { const d = await api('/api/learn/decks', {method: 'POST', body: {subject: v.id, section: L.section, name, level: $('#lnDeckLevel').value.trim() || null}}); L.deck = d.id; render(); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#lnImport').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await fetch(`/api/learn/import?subject=${v.id}&section=${L.section}&name=${encodeURIComponent(f.name.replace(/\.[^.]+$/, ''))}`, {method: 'POST', body: f});
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Không nhập được.');
      toast(`Đã nhập ${d.cards} thẻ vào ${d.decks.length} bộ.`); render();
    } catch (err) { toast(err.message, 'err'); }
  });
  if ($('#lnChart')) paintChart(decks);
}

function deckCard(d) {
  const pct = d.total ? Math.round(d.learned / d.total * 100) : 0;
  return `<div class="box ln-deck" data-deck="${d.id}">
    <div class="ln-deck-h"><b>${esc(d.name)}</b>${d.level ? `<span class="badge" style="background:${SUBJ[L.subject].color}">${esc(d.level)}</span>` : ''}</div>
    ${d.descr ? `<p class="hint">${esc(d.descr)}</p>` : ''}
    <div class="prog"><div class="bar"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:var(--green)"></i></div>
      <span class="hint">${d.learned}/${d.total} đã thuộc${d.due ? ` · <b class="ln-due">${d.due} cần ôn</b>` : ''}</span></div>
    <div class="btn-row">
      <button class="btn sm green" type="button" data-da="study" ${d.total ? '' : 'disabled'}>Học bộ này</button>
      <button class="btn sm plain" type="button" data-da="all" ${d.total ? '' : 'disabled'} title="Xem lại ngẫu nhiên, không tính lịch ôn">Ôn tự do</button>
      <button class="btn sm plain" type="button" data-da="open">Xem thẻ</button>
    </div></div>`;
}

async function deckAct(e, id) {
  const b = e.target.closest('[data-da]');
  if (!b) return;
  if (b.dataset.da === 'open') { L.deck = id; return render(); }
  if (b.dataset.da === 'study') return startStudy({subject: L.subject, deck: id});
  if (b.dataset.da === 'all') return startStudy({subject: L.subject, deck: id, mode: 'all', limit: 30});
}

function paintChart(decks) {
  const el = $('#lnChart');
  Promise.all(decks.map(d => api(`/api/learn/decks/${d.id}?limit=400`))).then(full => {
    el.innerHTML = full.map(d => {
      const groups = {};
      d.cards.forEach(c => { const g = (c.extra && c.extra.group) || ''; (groups[g] = groups[g] || []).push(c); });
      return `<div class="box pcard"><h3>${esc(d.name)} – bấm để nghe</h3>${Object.entries(groups).map(([g, cs]) => `
        ${g ? `<div class="sec-title ln-g">${esc(g)}</div>` : ''}
        <div class="ln-chart">${cs.map(c => `<button type="button" class="ln-ch ${c.state === 'review' ? 'ok' : c.state === 'learning' ? 'half' : ''}" data-say="${esc(c.front)}" title="${esc(c.meaning || '')}">
          <b lang="${L.sv.lang}">${esc(c.front)}</b><small>${esc(c.reading || '')}</small></button>`).join('')}</div>`).join('')}</div>`;
    }).join('');
    el.querySelectorAll('[data-say]').forEach(b => b.addEventListener('click', () => speak(sayText(b.dataset.say), L.sv.lang)));
  }).catch(err => { el.innerHTML = `<div class="notice box err">${esc(err.message)}</div>`; });
}
/* chữ cái Hangul rời (ㄱ, ㅏ) đọc bằng âm tiết mẫu cho dễ nghe */
function sayText(t) {
  if (/^[ㄱ-ㅎ]$/.test(t)) return String.fromCharCode(0xac00 + ('ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.indexOf(t)) * 588);
  if (/^[ㅏ-ㅣ]$/.test(t)) return String.fromCharCode(0xc544 + (t.charCodeAt(0) - 0x314f) * 28);
  return t;
}

/* ---------------------------------------------------------------- xem / sửa thẻ của một bộ */
async function renderDeck(q = '') {
  const el = $('#lnMain');
  let d;
  try { d = await api(`/api/learn/decks/${L.deck}?q=${encodeURIComponent(q)}&limit=500`); } catch (e) { L.deck = null; toast(e.message, 'err'); return render(); }
  const lang = SUBJ[d.subject] ? L.ov.subjects.find(s => s.id === d.subject).lang : 'en';
  el.innerHTML = `
    <div class="box tr-bar">
      <button class="btn sm plain" type="button" id="lnBack">← ${esc((L.ov.subjects.find(s => s.id === d.subject) || {}).name || 'Quay lại')}</button>
      <b class="tr-name" id="lnDName" title="Bấm để đổi tên">${esc(d.name)}</b>${d.level ? `<span class="badge" style="background:var(--yellow)">${esc(d.level)}</span>` : ''}
      <span class="hint">${d.total} thẻ · ${d.learned} đã thuộc</span>
      <span class="tr-seg">
        <button class="btn sm green" type="button" id="lnDStudy" ${d.total ? '' : 'disabled'}>Học bộ này</button>
        <a class="btn sm plain" href="/api/learn/decks/${d.id}/export" download="${esc(d.name)}.json">Xuất JSON</a>
        <button class="btn sm plain" type="button" id="lnDReset">Học lại từ đầu</button>
        <button class="btn sm plain" type="button" id="lnDDel">Xóa bộ</button>
      </span>
    </div>
    <form class="box pcard ln-cardform" id="lnCardForm">
      <h3>Thêm thẻ</h3>
      <div class="ln-cf">
        <input type="text" name="front" placeholder="Mặt trước (từ / chữ)" aria-label="Mặt trước" required>
        <input type="text" name="reading" placeholder="Cách đọc (kana / pinyin / phiên âm)" aria-label="Cách đọc">
        <input type="text" name="meaning" placeholder="Nghĩa tiếng Việt" aria-label="Nghĩa">
        <input type="text" name="example" placeholder="Câu ví dụ" aria-label="Câu ví dụ">
        <input type="text" name="example_vi" placeholder="Dịch câu ví dụ" aria-label="Dịch câu ví dụ">
        <button class="btn yellow" type="submit">THÊM</button>
      </div>
    </form>
    <div class="box pcard">
      <div class="vh-tools"><input type="search" id="lnQ" placeholder="Tìm thẻ…" value="${esc(q)}" aria-label="Tìm thẻ"><span class="hint">${d.matched} thẻ</span></div>
      ${d.cards.length ? `<div class="ln-table" role="table">
        <div class="ln-tr ln-th" role="row"><span>Mặt trước</span><span>Cách đọc</span><span>Nghĩa</span><span>Ví dụ</span><span></span></div>
        ${d.cards.map(c => `<div class="ln-tr" role="row" data-cid="${c.id}">
          <span class="ln-front" lang="${lang}"><button type="button" class="ln-say" data-say="${esc(c.front)}" aria-label="Nghe">🔊</button>${esc(c.front)}</span>
          <span>${esc(c.reading || '')}</span><span>${esc(c.meaning || '')}</span>
          <span class="hint">${esc(c.example || '')}${c.example_vi ? `<br>${esc(c.example_vi)}` : ''}</span>
          <span class="ln-row-act"><span class="ln-state ${c.state}">${{new: 'Mới', learning: 'Đang học', review: 'Đã thuộc'}[c.state] || c.state}</span>
            <button class="btn sm plain" type="button" data-ca="edit">Sửa</button><button class="btn sm plain" type="button" data-ca="del" aria-label="Xóa thẻ">✕</button></span>
        </div>`).join('')}</div>` : '<p class="hint">Chưa có thẻ nào. Thêm ở khung trên hoặc nhập file JSON/CSV.</p>'}
    </div>`;
  $('#lnBack').addEventListener('click', () => { L.deck = null; render(); });
  $('#lnDStudy').addEventListener('click', () => startStudy({subject: d.subject, deck: d.id}));
  $('#lnDName').addEventListener('click', async () => {
    const name = prompt('Tên bộ thẻ:', d.name);
    if (!name) return;
    await api(`/api/learn/decks/${d.id}`, {method: 'PATCH', body: {name}}).catch(err => toast(err.message, 'err'));
    renderDeck(q);
  });
  $('#lnDReset').addEventListener('click', async () => {
    if (!confirm('Đưa mọi thẻ của bộ này về “Mới” để học lại từ đầu?')) return;
    await api(`/api/learn/decks/${d.id}/reset`, {method: 'POST'}); toast('Đã đặt lại.'); renderDeck(q);
  });
  $('#lnDDel').addEventListener('click', async e => {
    const b = e.currentTarget;
    if (b.dataset.ok !== '1') { b.dataset.ok = '1'; b.textContent = `Bấm lần nữa để xóa ${d.total} thẻ`; return; }
    await api(`/api/learn/decks/${d.id}`, {method: 'DELETE'}); toast('Đã xóa bộ thẻ.'); L.deck = null; render();
  });
  $('#lnCardForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const card = Object.fromEntries([...f.entries()].map(([k, x]) => [k, String(x).trim() || null]));
    try { await api(`/api/learn/decks/${d.id}/cards`, {method: 'POST', body: [card]}); e.target.reset(); renderDeck(q); e.target.front && setTimeout(() => $('#lnCardForm [name=front]').focus(), 50); }
    catch (err) { toast(err.message, 'err'); }
  });
  let qt = 0;
  $('#lnQ').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => renderDeck(e.target.value), 300); });
  el.querySelectorAll('[data-say]').forEach(b => b.addEventListener('click', () => speak(sayText(b.dataset.say), lang)));
  el.querySelectorAll('[data-cid]').forEach(row => row.addEventListener('click', async e => {
    const b = e.target.closest('[data-ca]');
    if (!b) return;
    const c = d.cards.find(x => x.id === +row.dataset.cid);
    if (b.dataset.ca === 'del') {
      if (!confirm(`Xóa thẻ “${c.front}”?`)) return;
      await api(`/api/learn/cards/${c.id}`, {method: 'DELETE'}); return renderDeck(q);
    }
    const front = prompt('Mặt trước:', c.front); if (front == null) return;
    const reading = prompt('Cách đọc:', c.reading || ''); if (reading == null) return;
    const meaning = prompt('Nghĩa:', c.meaning || ''); if (meaning == null) return;
    try { await api(`/api/learn/cards/${c.id}`, {method: 'PUT', body: {...c, front, reading, meaning}}); renderDeck(q); } catch (err) { toast(err.message, 'err'); }
  }));
}

/* ---------------------------------------------------------------- phiên học */
async function startStudy(opt) {
  const p = new URLSearchParams({subject: opt.subject, mode: opt.mode || 'mix', limit: opt.limit || 20});
  if (opt.deck) p.set('deck', opt.deck);
  let r;
  try { r = await api(`/api/learn/study?${p}`); } catch (e) { return toast(e.message, 'err'); }
  if (!r.cards.length) return toast(opt.deck ? 'Bộ này hôm nay không còn thẻ cần học. Bấm “Ôn tự do” để xem lại.' : 'Hôm nay đã học xong. Quay lại ngày mai nhé!');
  L.study = {opt, cards: r.cards, lang: r.lang, i: 0, flipped: false, done: 0, right: 0, again: [], t0: Date.now(), free: opt.mode === 'all',
    speak: !L.sv || L.sv.settings.auto_speak !== false};
  paintStudy();
}

function quit() { L.study = null; document.removeEventListener('keydown', onKey); refreshRemind(); render(); }

function paintStudy() {
  const s = L.study, box = $('#lnBox');
  document.removeEventListener('keydown', onKey);
  document.addEventListener('keydown', onKey);
  if (s.i >= s.cards.length) {
    if (s.again.length) { s.cards.push(...s.again); s.again = []; return paintStudy(); }
    const pct = s.done ? Math.round(s.right / s.done * 100) : 0;
    box.innerHTML = `<div class="box pcard ln-finish">
      <span class="ln-mark big" style="background:var(--green)">✓</span>
      <h2>Xong lượt học!</h2>
      <p>${s.done} lượt trả lời · nhớ đúng ${pct}% · ${Math.max(1, Math.round((Date.now() - s.t0) / 60000))} phút</p>
      <div class="btn-row"><button class="btn green" type="button" id="lnMore">HỌC TIẾP</button><button class="btn plain" type="button" id="lnQuit">Về trang môn học</button></div>
      <div id="lnNextPlan"></div></div>`;
    $('#lnQuit').addEventListener('click', quit);
    paintNextPlan();
    $('#lnMore').addEventListener('click', () => { const o = s.opt; L.study = null; startStudy(o); });
    return;
  }
  const c = s.cards[s.i];
  const mode = s.free && L.mode === 'card' ? 'card' : L.mode;
  const total = s.cards.length;
  s.shown = Date.now();
  s.flipped = false;
  const head = `<div class="ln-study-top">
      <button class="btn sm plain" type="button" id="lnQuit">✕ Dừng</button>
      <div class="bar ln-sbar" aria-hidden="true"><i style="width:${Math.round(s.i / total * 100)}%;background:var(--green)"></i></div>
      <span class="hint mono">${s.i + 1}/${total}</span></div>`;
  const front = `<div class="ln-front-big" lang="${s.lang}">${esc(c.front)}</div>
      <button type="button" class="btn sm plain ln-listen" id="lnSay">🔊 Nghe</button>
      <span class="hint">${esc(c.deck_name || '')}${c.state === 'new' ? ' · <b>thẻ mới</b>' : ''}</span>`;
  let body = '';
  if (mode === 'quiz' && c.meaning && c.choices.length >= 1) {
    s.opts = shuffle([c.meaning, ...c.choices]);
    body = `<div class="ln-quiz">${s.opts.map((o, i) => `<button type="button" class="ln-opt" data-opt="${i}"><b>${i + 1}</b>${esc(o)}</button>`).join('')}</div>`;
  } else if (mode === 'type' && c.meaning) {
    body = `<form id="lnTypeF" class="paste-row"><input type="text" id="lnType" placeholder="Gõ nghĩa tiếng Việt (hoặc cách đọc)…" autocomplete="off" aria-label="Đáp án">
      <button class="btn yellow" type="submit">KIỂM TRA</button></form><p class="hint">Không cần dấu cũng được. Enter để kiểm tra.</p>`;
  } else {
    body = `<button class="btn yellow ln-flip" type="button" id="lnFlip">LẬT THẺ <span class="ui-k">Space</span></button>`;
  }
  box.innerHTML = `<div class="ln-study">${head}
    <div class="box ln-card" id="lnCard">${front}<div id="lnRev"></div><div id="lnAct">${body}</div></div></div>`;
  $('#lnQuit').addEventListener('click', quit);
  $('#lnSay').addEventListener('click', () => speak(sayText(c.front), s.lang));
  if (s.speak && c.state === 'new') speak(sayText(c.front), s.lang);
  $('#lnFlip')?.addEventListener('click', () => flip(null));
  box.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', () => pick(+b.dataset.opt)));
  $('#lnTypeF')?.addEventListener('submit', e => { e.preventDefault(); checkTyped(); });
  $('#lnType')?.focus();
}

function backHtml(c, verdict) {
  return `${verdict || ''}
    ${c.reading ? `<div class="ln-reading" lang="${L.study.lang}">${esc(c.reading)}</div>` : ''}
    <div class="ln-meaning">${esc(c.meaning || '')}</div>
    ${c.example ? `<div class="ln-ex"><span lang="${L.study.lang}">${esc(c.example)}</span>${c.example_vi ? `<small>${esc(c.example_vi)}</small>` : ''}
      <button type="button" class="ln-say" id="lnSayEx" aria-label="Nghe câu ví dụ">🔊</button></div>` : ''}
    ${c.extra && Object.keys(c.extra).filter(k => k !== 'group' && k !== 'row').length ? `<div class="ln-extra">${Object.entries(c.extra).filter(([k]) => k !== 'group' && k !== 'row')
      .map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</span>`).join('')}</div>` : ''}`;
}

function flip(correct) {
  const s = L.study, c = s.cards[s.i];
  if (s.flipped) return;
  s.flipped = true;
  const verdict = correct == null ? '' : `<div class="ln-verdict ${correct ? 'ok' : 'no'}">${correct ? 'Đúng rồi!' : 'Chưa đúng'}</div>`;
  $('#lnRev').innerHTML = backHtml(c, verdict);
  $('#lnSayEx')?.addEventListener('click', () => speak(c.example, s.lang));
  if (s.speak && (c.state !== 'new' || correct != null)) speak(sayText(c.front), s.lang);
  if (s.free) {
    $('#lnAct').innerHTML = `<div class="btn-row"><button class="btn green" type="button" id="lnNext">TIẾP <span class="ui-k">Space</span></button></div>`;
    $('#lnNext').addEventListener('click', () => grade(correct === false ? 0 : 2));
    return;
  }
  const order = correct === false ? [0] : correct === true ? [1, 2, 3] : [0, 1, 2, 3];
  $('#lnAct').innerHTML = `<div class="ln-grades">${order.map(g => `<button type="button" class="btn ${GRADES[g][1]} ln-grade" data-g="${g}">
    ${GRADES[g][0]}<small>${esc(c.next[g])}</small><span class="ui-k">${g + 1}</span></button>`).join('')}</div>`;
  $('#lnAct').querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => grade(+b.dataset.g)));
}

function pick(i) {
  const s = L.study, c = s.cards[s.i];
  if (s.flipped || !s.opts) return;
  const ok = s.opts[i] === c.meaning;
  document.querySelectorAll('[data-opt]').forEach((b, k) => {
    b.disabled = true;
    if (s.opts[k] === c.meaning) b.classList.add('ok'); else if (k === i) b.classList.add('no');
  });
  flip(ok);
}

const plain = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function checkTyped() {
  const s = L.study, c = s.cards[s.i];
  const got = plain($('#lnType').value);
  if (!got) return;
  const answers = [c.meaning, c.reading].filter(Boolean).flatMap(a => a.split(/[;,/|]/)).map(plain).filter(Boolean);
  const ok = answers.some(a => a === got || (got.length >= 3 && (a.includes(got) || got.includes(a))));
  $('#lnType').disabled = true;
  flip(ok);
}

async function grade(g) {
  const s = L.study, c = s.cards[s.i];
  if (s.busy) return;
  s.busy = true;
  s.done++;
  if (g >= 2) s.right++;
  try {
    if (!s.free) {
      const r = await api('/api/learn/review', {method: 'POST', body: {card_id: c.id, grade: g, seconds: (Date.now() - s.shown) / 1000}});
      if (r.again) s.again.push({...c, state: 'learning', next: {0: '1 phút', 1: '6 phút', 2: '1 ngày', 3: '4 ngày'}});
    }
  } catch (err) { toast(err.message, 'err'); }
  s.busy = false;
  s.i++;
  paintStudy();
}

function onKey(e) {
  const s = L.study;
  if (!s || location.hash !== '#learn' || e.target.closest('input,textarea') && e.key !== 'Escape') return;
  if (e.key === 'Escape') return quit();
  if (s.i >= s.cards.length) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!s.flipped && $('#lnFlip')) flip(null);
    else if (s.flipped && $('#lnNext')) $('#lnNext').click();
    else if (s.flipped && !s.free) { const b = $('[data-g="2"]') || $('[data-g="0"]'); if (b) b.click(); }
    return;
  }
  const n = +e.key;
  if (n >= 1 && n <= 4) {
    if (!s.flipped && s.opts && $('[data-opt]')) return pick(n - 1);
    const b = $(`[data-g="${n - 1}"]`);
    if (b) b.click();
  }
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ================================================================ hôm nay học gì */
const KIND_ICON = {review: '↻', new: '＋', practice: '✎', week: '✓', level: '★'};
const subjName = id => (L.ov && (L.ov.subjects.find(s => s.id === id) || {}).name) || id;
async function paintToday() {
  const el = $('#lnToday');
  if (!el) return;
  let t;
  try { t = await api('/api/learn/today'); } catch (e) { el.innerHTML = ''; return; }
  R.today = t; paintBadge();
  const remind = `<div class="ln-remind"><label class="check"><input type="checkbox" id="lnRemOn" ${t.remind ? 'checked' : ''}> 🔔 Nhắc học mỗi ngày lúc</label>
    <input type="time" id="lnRemAt" value="${esc(t.remind_at)}" aria-label="Giờ nhắc học" ${t.remind ? '' : 'disabled'}></div>`;
  if (!t.plan || L.editPlan) {
    const chosen = new Map((t.plan || []).map(it => [it.key, it]));
    const items = t.suggest.slice();
    (t.plan || []).forEach(it => { if (!items.some(x => x.key === it.key)) items.push(it); });
    el.innerHTML = `<div class="box pcard ln-plan">
      <div class="row-between"><h3>Hôm nay học gì?</h3>${remind}</div>
      ${items.length ? `<p class="hint">Chọn việc muốn làm hôm nay (đổi được số từ mới), rồi lưu kế hoạch. App nhắc nếu chưa làm xong.</p>
      <div class="ln-todo">${items.map(it => {
        const on = t.plan ? chosen.has(it.key) : true;
        const n = (chosen.get(it.key) || it).n;
        return `<label class="ln-ti${it.done ? ' done' : ''}"><input type="checkbox" data-pk="${esc(it.key)}" ${on ? 'checked' : ''}>
          <span class="ln-ki k-${it.kind}">${KIND_ICON[it.kind]}</span>
          <span class="ln-tt"><b>${it.kind === 'new' ? `Học <input type="number" class="ln-n" data-pn="${esc(it.key)}" min="1" max="100" value="${n}" aria-label="Số từ mới"> từ mới` : esc(it.title)}</b>
            <small>${esc(it.desc || subjName(it.subject))}${it.done ? ' · đã xong' : ''}</small></span></label>`;
      }).join('')}</div>
      <div class="btn-row"><button class="btn yellow" type="button" id="lnPlanSave">LƯU KẾ HOẠCH HÔM NAY</button>
        ${L.editPlan ? '<button class="btn plain" type="button" id="lnPlanCancel">Hủy</button>' : ''}</div>`
      : '<p class="hint">Chưa có gì để học: chọn một môn ở trên rồi chọn <b>Lộ trình chuẩn</b> để bắt đầu.</p>'}
    </div>`;
    $('#lnPlanSave')?.addEventListener('click', async () => {
      const pick = items.filter(it => el.querySelector(`[data-pk="${CSS.escape(it.key)}"]`).checked).map(it => {
        const ni = el.querySelector(`[data-pn="${CSS.escape(it.key)}"]`);
        return {key: it.key, kind: it.kind, subject: it.subject, deck_id: it.deck_id || null, n: ni ? Math.max(1, +ni.value || 1) : it.n, title: it.title, desc: it.desc || ''};
      });
      if (!pick.length) return toast('Chọn ít nhất một việc.', 'err');
      try { await api('/api/learn/today', {method: 'PUT', body: {items: pick}}); L.editPlan = false; toast('Đã lưu kế hoạch hôm nay.'); render(); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('#lnPlanCancel')?.addEventListener('click', () => { L.editPlan = false; paintToday(); });
  } else {
    const done = t.plan.filter(it => it.done).length, total = t.plan.length;
    const next = t.plan.find(it => !it.done);
    el.innerHTML = `<div class="box pcard ln-plan">
      <div class="row-between"><h3>Kế hoạch hôm nay <span class="hint">${done}/${total} việc</span></h3>${remind}</div>
      <div class="bar ln-pbar" aria-hidden="true"><i class="${done ? '' : 'w0'}" style="width:${Math.round(done / total * 100)}%;background:var(--green)"></i></div>
      <div class="ln-todo">${t.plan.map((it, i) => `<div class="ln-ti${it.done ? ' done' : ''}">
          <span class="ln-ki k-${it.kind}">${it.done ? '✓' : KIND_ICON[it.kind]}</span>
          <span class="ln-tt"><b>${esc(it.title)}</b><small>${esc(subjName(it.subject))}${it.kind === 'new' ? ` · đã học ${it.got || 0}/${it.n}` : ''}${it.kind === 'review' && !it.done ? ` · còn ${it.left}` : ''}${it.pct != null ? ` · ${it.pct}%` : ''}</small></span>
          ${it.done ? '<span class="badge" style="background:var(--green)">Xong</span>' : `<button class="btn sm green" type="button" data-run="${i}">Bắt đầu</button>`}</div>`).join('')}</div>
      <div class="btn-row">${next ? `<button class="btn green ln-start" type="button" data-run="${t.plan.indexOf(next)}">${done ? 'LÀM TIẾP' : 'BẮT ĐẦU'}: ${esc(next.title)}</button>` : '<b class="ln-alldone">🎉 Xong kế hoạch hôm nay!</b>'}
        <button class="btn plain" type="button" id="lnPlanEdit">Sửa kế hoạch</button></div>
    </div>`;
    el.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runPlan(t.plan[+b.dataset.run])));
    $('#lnPlanEdit').addEventListener('click', () => { L.editPlan = true; paintToday(); });
  }
  const on = $('#lnRemOn'), at = $('#lnRemAt');
  const saveRem = () => api('/api/learn/settings', {method: 'PUT', body: {remind: on.checked, remind_at: at.value || '20:00'}})
    .then(() => { at.disabled = !on.checked; refreshRemind(); if (on.checked) askNotify(); }).catch(e => toast(e.message, 'err'));
  on.addEventListener('change', saveRem); at.addEventListener('change', saveRem);
}

function runPlan(it) {
  L.plan = true;
  if (it.kind === 'review') return startStudy({subject: it.subject, mode: 'review', limit: 200});
  if (it.kind === 'new') return startStudy({subject: it.subject, mode: 'new', limit: Math.max(1, (it.n || 10) - (it.got || 0))});
  return startQuiz({subject: it.subject, kind: it.kind, deck: it.deck_id});
}

async function paintNextPlan() {
  const el = $('#lnNextPlan');
  if (!el || !L.plan) return;
  try {
    const t = await api('/api/learn/today');
    R.today = t; paintBadge();
    const next = (t.plan || []).find(it => !it.done);
    el.innerHTML = next ? `<p class="hint">Tiếp theo trong kế hoạch hôm nay:</p><button class="btn yellow" type="button" id="lnGoNext">${esc(next.title)} · ${esc(subjName(next.subject))} →</button>`
      : t.plan ? '<p class="ln-alldone">🎉 Xong kế hoạch hôm nay!</p>' : '';
    $('#lnGoNext')?.addEventListener('click', () => { L.study = null; L.quiz = null; runPlan(next); });
  } catch (e) { /* bỏ qua */ }
}

/* ================================================================ lộ trình chuẩn */
async function paintPath() {
  const el = $('#lnPath');
  if (!el) return;
  let p;
  try { p = await api(`/api/learn/paths/${L.subject}`); } catch (e) { el.innerHTML = `<h3>Lộ trình chuẩn</h3><p class="hint">${esc(e.message)}</p>`; return; }
  const color = SUBJ[L.subject].color;
  const act = p.levels.find(l => l.id === p.active);
  el.innerHTML = `<div class="row-between"><h3>Lộ trình chuẩn · ${esc(p.short)}</h3>
      <label class="ln-pd">Từ mới/ngày <input type="number" id="lnPerDay" min="1" max="100" value="${p.per_day}" aria-label="Số từ mới mỗi ngày"></label></div>
    <p class="hint">${esc(p.about)}</p>
    <ol class="ln-levels">${p.levels.map((l, i) => {
      const pct = l.count ? Math.round(l.seen / l.count * 100) : 0;
      const on = l.id === p.active;
      return `<li class="ln-lvl${on ? ' on' : ''}${l.passed ? ' passed' : ''}">
        <span class="ln-lvl-id" style="${on || l.passed ? `background:${color}` : ''}">${esc(l.id.replace('HSK', '').replace('TOPIK', ''))}</span>
        <span class="ln-lvl-t"><b>${esc(l.name)}</b><small>${l.count} từ${l.target ? ' · ' + esc(l.target) : ''}${l.deck_id ? ` · đã học ${l.seen}` : ''}${l.passed ? ` · đã qua kiểm tra ${l.best}%` : ''}</small>
          ${l.deck_id ? `<span class="bar" aria-hidden="true"><i class="${pct ? '' : 'w0'}" style="width:${pct}%;background:${color}"></i></span>` : ''}</span>
        ${on ? '<span class="badge" style="background:var(--yellow)">Đang học</span>' : `<button class="btn sm ${l.deck_id ? 'plain' : 'green'}" type="button" data-lv="${esc(l.id)}">${l.deck_id ? 'Học tiếp cấp này' : i === 0 && !act ? 'Bắt đầu từ đây' : 'Học cấp này'}</button>`}
      </li>`;
    }).join('')}</ol>
    ${act && act.deck_id ? `<div class="ln-gloss" id="lnGloss"></div>` : ''}
    <details class="hint"><summary>Nguồn dữ liệu</summary>${esc(p.credit)}</details>`;
  el.querySelectorAll('[data-lv]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Đang chuẩn bị…';
    try { await api(`/api/learn/paths/${L.subject}/${encodeURIComponent(b.dataset.lv)}`, {method: 'POST', body: {}}); toast(`Đã chọn ${b.dataset.lv}. Mỗi ngày học ${p.per_day} từ mới – từ hay gặp học trước.`); refreshRemind(); render(); }
    catch (e) { toast(e.message, 'err'); b.disabled = false; }
  }));
  $('#lnPerDay').addEventListener('change', e => api(`/api/learn/paths/${L.subject}`, {method: 'PUT', body: {per_day: Math.max(1, +e.target.value || 10)}})
    .then(() => { toast('Đã đổi số từ mới mỗi ngày.'); render(); }).catch(err => toast(err.message, 'err')));
  if (act && act.deck_id) paintGloss(act.deck_id);
}

async function paintGloss(did, poll) {
  const el = $('#lnGloss');
  if (!el) return;
  let g;
  try { g = await api(`/api/learn/decks/${did}/gloss`); } catch (e) { return; }
  if (!g.left && !g.running) { el.innerHTML = '<span class="hint">✓ Cả cấp đã có nghĩa tiếng Việt.</span>'; return; }
  el.innerHTML = g.running
    ? `<span class="hint">Đang dịch nghĩa tiếng Việt… còn ${g.left} từ</span><button class="btn sm plain" type="button" id="lnGlossStop">Dừng</button>`
    : `<span class="hint">${g.left} từ chưa có nghĩa tiếng Việt (app tự dịch khi tới lượt học; trong lúc chờ hiện nghĩa tiếng Anh).${g.error ? ` <b class="err">${esc(g.error)}</b>` : ''}</span>
       <button class="btn sm cyan" type="button" id="lnGlossGo" title="Dùng bộ dịch đang chọn ở tab Dịch → Cài đặt (Claude viết thêm câu ví dụ)">Dịch sẵn cả cấp</button>`;
  $('#lnGlossGo')?.addEventListener('click', () => api(`/api/learn/decks/${did}/gloss`, {method: 'POST'}).then(() => paintGloss(did, true)).catch(e => toast(e.message, 'err')));
  $('#lnGlossStop')?.addEventListener('click', () => api(`/api/learn/decks/${did}/gloss/stop`, {method: 'POST'}).then(() => paintGloss(did)));
  if (g.running) setTimeout(() => { if ($('#lnGloss')) paintGloss(did, true); }, 2500);
  else if (poll && !g.running) paintGloss(did);
}

/* ================================================================ bài tập + kiểm tra định kỳ */
async function paintTests() {
  const el = $('#lnTests');
  if (!el) return;
  let t;
  try { t = await api(`/api/learn/tests?subject=${L.subject}`); } catch (e) { el.innerHTML = ''; return; }
  const w = t.week;
  const hist = t.items.slice(0, 12).reverse();
  el.innerHTML = `<h3>Luyện tập &amp; kiểm tra</h3>
    <div class="ln-tbtns">
      <button class="ln-tb" type="button" data-q="practice"><b>✎ Bài tập nhanh</b><small>12 câu: nghĩa, nghe, ghép cặp, điền từ… chấm ngay từng câu</small></button>
      <button class="ln-tb${w.due ? ' due' : ''}" type="button" data-q="week"><b>✓ Kiểm tra tuần</b><small>20 câu · 12 phút · đạt từ ${t.pass}%${w.due ? ' · <em>đã đến hạn</em>' : w.next_in ? ` · lần tới sau ${w.next_in} ngày` : w.seen < 20 ? ` · nên học ≥ 20 từ (đang ${w.seen})` : ''}</small></button>
      ${t.levels.map(l => `<button class="ln-tb due" type="button" data-q="level" data-deck="${l.deck_id}"><b>★ Kiểm tra cuối cấp ${esc(l.level)}</b><small>40 câu · 25 phút · qua thì lên cấp tiếp theo</small></button>`).join('')}
    </div>
    ${hist.length ? `<div class="ln-hist" role="img" aria-label="Điểm các bài gần đây">${hist.map(h => `<i class="${h.kind}${h.pct >= t.pass ? ' ok' : ''}" style="height:${Math.max(6, h.pct)}%" title="${esc(h.day)} · ${h.kind === 'practice' ? 'Bài tập' : h.kind === 'week' ? 'Kiểm tra tuần' : 'Cuối cấp ' + (h.level || '')}: ${h.pct}%"></i>`).join('')}</div>
      <ul class="ln-hlist">${t.items.slice(0, 4).map(h => `<li><span>${h.kind === 'practice' ? 'Bài tập' : h.kind === 'week' ? 'Kiểm tra tuần' : 'Cuối cấp ' + esc(h.level || '')}</span><span class="hint">${esc(h.day.slice(5).split('-').reverse().join('/'))}</span>
        <b class="${h.kind !== 'practice' ? (h.passed ? 'ok' : 'no') : ''}">${h.correct}/${h.total} · ${h.pct}%</b></li>`).join('')}</ul>`
      : '<p class="hint">Chưa làm bài nào. Học vài từ rồi làm bài tập để nhớ chắc hơn; mỗi tuần một bài kiểm tra.</p>'}`;
  el.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => startQuiz({subject: L.subject, kind: b.dataset.q, deck: b.dataset.deck ? +b.dataset.deck : null})));
}

async function startQuiz(opt) {
  const p = new URLSearchParams({subject: opt.subject, kind: opt.kind});
  if (opt.deck) p.set('deck', opt.deck);
  let r;
  try { r = await api(`/api/learn/quiz?${p}`); } catch (e) { return toast(e.message, 'err'); }
  if (!r.questions.length) return toast('Chưa đủ từ để ra đề.', 'err');
  L.study = null;
  L.quiz = {...r, opt, i: 0, res: [], t0: Date.now(), test: r.kind !== 'practice', answered: false};
  clearInterval(R.timer);
  if (r.time_limit) R.timer = setInterval(tickQuiz, 1000);
  paintQuiz();
}

function quitQuiz() { clearInterval(R.timer); L.quiz = null; document.removeEventListener('keydown', onQuizKey); refreshRemind(); render(); }

function tickQuiz() {
  const q = L.quiz;
  if (!q || q.finished) return clearInterval(R.timer);
  const left = q.time_limit - Math.floor((Date.now() - q.t0) / 1000);
  const el = $('#lnTimer');
  if (el) { el.textContent = `${Math.floor(Math.max(0, left) / 60)}:${String(Math.max(0, left) % 60).padStart(2, '0')}`; el.classList.toggle('low', left <= 60); }
  if (left <= 0) { toast('Hết giờ – nộp bài.'); finishQuiz(); }
}

function paintQuiz() {
  const z = L.quiz, box = $('#lnBox');
  document.removeEventListener('keydown', onQuizKey);
  document.addEventListener('keydown', onQuizKey);
  if (z.finished) return paintQuizResult();
  if (z.i >= z.questions.length) return finishQuiz();
  const q = z.questions[z.i];
  z.answered = false; z.shown = Date.now();
  const head = `<div class="ln-study-top">
      <button class="btn sm plain" type="button" id="lnQQuit">✕ ${z.test ? 'Bỏ bài' : 'Dừng'}</button>
      <div class="bar ln-sbar" aria-hidden="true"><i style="width:${Math.round(z.i / z.questions.length * 100)}%;background:${z.test ? 'var(--violet)' : 'var(--cyan)'}"></i></div>
      ${z.time_limit ? '<span class="ln-timer mono" id="lnTimer">--:--</span>' : ''}<span class="hint mono">${z.i + 1}/${z.questions.length}</span></div>`;
  let body = '';
  const bigLang = ['mean', 'tf', 'read', 'cloze'].includes(q.type);
  if (q.type === 'match') {
    z.match = {left: null, done: new Set(), miss: 0};
    body = `<div class="ln-match"><div>${q.pairs.map(p => `<button type="button" class="ln-mt" data-ml="${p.id}" lang="${z.lang}">${esc(p.front)}</button>`).join('')}</div>
      <div>${q.right.map((m, i) => `<button type="button" class="ln-mt" data-mr="${i}">${esc(m)}</button>`).join('')}</div></div>`;
  } else if (q.type === 'tf') {
    body = `<div class="ln-shown">“${esc(q.shown)}”</div><div class="ln-quiz two"><button type="button" class="ln-opt" data-tf="1"><b>1</b>Đúng</button><button type="button" class="ln-opt" data-tf="0"><b>2</b>Sai</button></div>`;
  } else if (q.type === 'spell') {
    body = `<form id="lnSpellF" class="paste-row"><input type="text" id="lnSpell" lang="${z.lang}" placeholder="Gõ từ ${z.subject === 'ielts' ? 'tiếng Anh' : '(hoặc cách đọc)'}…" autocomplete="off" aria-label="Đáp án">
      <button class="btn yellow" type="submit">KIỂM TRA</button></form>`;
  } else {
    body = `<div class="ln-quiz">${q.options.map((o, i) => `<button type="button" class="ln-opt" data-qo="${i}" ${q.type === 'mean' ? '' : `lang="${z.lang}"`}><b>${i + 1}</b>${esc(o)}</button>`).join('')}</div>`;
  }
  box.innerHTML = `<div class="ln-study">${head}
    <div class="box ln-card ln-qcard ${z.test ? 'test' : ''}">
      <span class="badge" style="background:${z.test ? 'var(--violet)' : 'var(--cyan)'}">${esc(z.title)}${z.level ? ' ' + esc(z.level) : ''}</span>
      ${q.type === 'listen' ? '<button type="button" class="ln-bigsay" id="lnQSay" aria-label="Nghe lại">🔊</button>'
        : q.type === 'match' ? '' : `<div class="${bigLang ? 'ln-front-big' : 'ln-qprompt'}${q.type === 'cloze' ? ' cloze' : ''}" ${bigLang ? `lang="${z.lang}"` : ''}>${esc(q.prompt)}</div>`}
      <p class="ln-qsub">${esc(q.sub || '')}${q.say && q.type !== 'listen' && q.type !== 'match' ? ' <button type="button" class="ln-say" id="lnQSay" aria-label="Nghe">🔊</button>' : ''}</p>
      <div id="lnQBody">${body}</div><div id="lnQFb"></div></div></div>`;
  if (z.time_limit) tickQuiz();
  $('#lnQQuit').addEventListener('click', () => { if (!z.test || z.i === 0 || confirm('Bỏ bài kiểm tra? Kết quả sẽ không được lưu.')) quitQuiz(); });
  $('#lnQSay')?.addEventListener('click', () => speak(q.say, z.lang));
  if (q.type === 'listen' || q.type === 'spell') setTimeout(() => speak(q.say, z.lang), 150);
  box.querySelectorAll('[data-qo]').forEach(b => b.addEventListener('click', () => answer(+b.dataset.qo)));
  box.querySelectorAll('[data-tf]').forEach(b => b.addEventListener('click', () => answer(b.dataset.tf === '1')));
  $('#lnSpellF')?.addEventListener('submit', e => { e.preventDefault(); answer($('#lnSpell').value); });
  $('#lnSpell')?.focus();
  box.querySelectorAll('[data-ml],[data-mr]').forEach(b => b.addEventListener('click', () => matchPick(b)));
}

const noTone = t => plain(t).replace(/\s+/g, '');
function answer(v) {
  const z = L.quiz, q = z.questions[z.i];
  if (z.answered) return;
  let ok, yours, right;
  if (q.type === 'tf') { ok = v === q.answer; yours = v ? 'Đúng' : 'Sai'; right = `${q.answer ? 'Đúng' : 'Sai'} – nghĩa: ${q.truth}`; }
  else if (q.type === 'spell') {
    if (!String(v).trim()) return;
    const got = noTone(v);
    ok = [q.answer, ...(q.alt || [])].some(a => noTone(a) === got);
    yours = v; right = q.answer;
    $('#lnSpell').disabled = true;
  } else { ok = v === q.answer; yours = q.options[v]; right = q.options[q.answer]; }
  z.answered = true;
  z.res.push({n: q.n, ok, card_ids: q.card_ids, q: q.type === 'listen' ? q.say : q.prompt, a: right, your: yours, type: q.type});
  if (z.test) { z.i++; return paintQuiz(); }          // kiểm tra: không báo đúng/sai từng câu
  document.querySelectorAll('[data-qo],[data-tf]').forEach(b => {
    b.disabled = true;
    const k = b.dataset.qo != null ? +b.dataset.qo : b.dataset.tf === '1';
    if (k === q.answer) b.classList.add('ok'); else if (k === v) b.classList.add('no');
  });
  showFeedback(q, ok);
}

function showFeedback(q, ok) {
  const z = L.quiz;
  if (!ok || q.type !== 'match') speak(q.front || q.say, z.lang);
  $('#lnQFb').innerHTML = `<div class="ln-verdict ${ok ? 'ok' : 'no'}">${ok ? 'Đúng rồi!' : 'Chưa đúng'}</div>
    ${q.type !== 'match' ? `<div class="ln-qans"><b lang="${z.lang}">${esc(q.front)}</b>${q.reading ? ` <span lang="${z.lang}">${esc(q.reading)}</span>` : ''} – ${esc(q.meaning)}</div>` : ''}
    <button class="btn green" type="button" id="lnQNext">TIẾP <span class="ui-k">Space</span></button>`;
  $('#lnQNext').addEventListener('click', () => { z.i++; paintQuiz(); });
  $('#lnQNext').focus();
}

function matchPick(b) {
  const z = L.quiz, q = z.questions[z.i], m = z.match;
  if (z.answered || b.disabled) return;
  if (b.dataset.ml) {
    document.querySelectorAll('[data-ml]').forEach(x => x.classList.toggle('sel', x === b));
    m.left = +b.dataset.ml;
    speak(q.pairs.find(p => p.id === m.left).front, z.lang);
    return;
  }
  if (m.left == null) return;
  const pair = q.pairs.find(p => p.id === m.left);
  const lb = document.querySelector(`[data-ml="${m.left}"]`);
  if (q.right[+b.dataset.mr] === pair.meaning) {
    [lb, b].forEach(x => { x.classList.remove('sel'); x.classList.add('ok'); x.disabled = true; });
    m.done.add(m.left); m.left = null;
    if (m.done.size === q.pairs.length) {
      const ok = m.miss <= 1;
      z.answered = true;
      z.res.push({n: q.n, ok, card_ids: q.card_ids, q: 'Ghép cặp', a: q.pairs.map(p => `${p.front} = ${p.meaning}`).join('; '), your: `${m.miss} lần ghép sai`, type: 'match'});
      showFeedback(q, ok);
    }
  } else {
    m.miss++;
    b.classList.add('no'); setTimeout(() => b.classList.remove('no'), 450);
  }
}

async function finishQuiz() {
  const z = L.quiz;
  if (z.finished) return;
  z.finished = true;
  clearInterval(R.timer);
  const answered = new Set(z.res.map(r => r.n));
  z.questions.forEach(q => { if (!answered.has(q.n)) z.res.push({n: q.n, ok: false, card_ids: q.card_ids, q: q.prompt || q.say, a: q.type === 'tf' ? (q.answer ? 'Đúng' : 'Sai') : q.options ? q.options[q.answer] : q.answer, your: '(chưa làm)', type: q.type}); });
  const correct = z.res.filter(r => r.ok).length;
  const wrong = z.res.filter(r => !r.ok).flatMap(r => r.card_ids);
  z.secs = Math.round((Date.now() - z.t0) / 1000);
  try {
    z.out = await api('/api/learn/quiz/result', {method: 'POST', body: {subject: z.subject, kind: z.kind, deck_id: z.deck_id, level: z.level,
      total: z.res.length, correct, seconds: z.secs, wrong, detail: z.res.filter(r => !r.ok).map(({q, a, your, type}) => ({q, a, your, type}))}});
  } catch (e) { toast(e.message, 'err'); z.out = {pct: Math.round(correct / z.res.length * 100), passed: false, pass: z.pass}; }
  z.correct = correct;
  paintQuiz();
}

function paintQuizResult() {
  const z = L.quiz, o = z.out, box = $('#lnBox');
  const wrong = z.res.filter(r => !r.ok);
  const good = z.test ? o.passed : o.pct >= 80;
  box.innerHTML = `<div class="ln-study"><div class="box pcard ln-finish">
    <span class="ln-mark big pct" style="background:${good ? 'var(--green)' : 'var(--yellow)'}">${o.pct}%</span>
    <h2>${z.test ? (o.passed ? 'Đạt! 🎉' : 'Chưa đạt') : good ? 'Làm tốt lắm!' : 'Cố thêm chút nữa!'}</h2>
    <p>${z.title}${z.level ? ' ' + esc(z.level) : ''}: đúng ${z.correct}/${z.res.length} câu · ${Math.max(1, Math.round(z.secs / 60))} phút${z.test ? ` · cần ${o.pass}% để đạt` : ''}</p>
    ${o.next_level ? `<p><b>Đã qua cấp ${esc(z.level)}.</b> Lên cấp tiếp theo?</p>` : ''}
    <div class="btn-row">
      ${o.next_level ? `<button class="btn green" type="button" id="lnNextLv">HỌC ${esc(o.next_level)}</button>` : ''}
      ${wrong.length ? `<button class="btn yellow" type="button" id="lnRedo">ÔN ${wrong.length} TỪ SAI</button>` : ''}
      <button class="btn plain" type="button" id="lnAgain">${z.test ? 'Làm lại' : 'Bài khác'}</button>
      <button class="btn plain" type="button" id="lnQBack">Về trang môn học</button></div>
    ${wrong.length ? `<div class="ln-wrong"><h3>Câu sai</h3>${wrong.map(r => `<div><span lang="${z.lang}">${esc(r.q || '')}</span><b>→ ${esc(r.a || '')}</b><small>Bạn chọn: ${esc(String(r.your ?? ''))}</small></div>`).join('')}</div>` : ''}
    <div id="lnNextPlan"></div></div></div>`;
  $('#lnQBack').addEventListener('click', () => { if (!L.subject) L.subject = z.subject; quitQuiz(); });
  $('#lnAgain').addEventListener('click', () => startQuiz(z.opt));
  $('#lnRedo')?.addEventListener('click', () => { L.quiz = null; startStudy({subject: z.subject, mode: 'review', limit: 100}); });
  $('#lnNextLv')?.addEventListener('click', async () => {
    try { await api(`/api/learn/paths/${z.subject}/${encodeURIComponent(o.next_level)}`, {method: 'POST', body: {}}); toast(`Đã chuyển sang ${o.next_level}.`); L.subject = z.subject; quitQuiz(); }
    catch (e) { toast(e.message, 'err'); }
  });
  paintNextPlan();
}

function onQuizKey(e) {
  const z = L.quiz;
  if (!z || location.hash !== '#learn') return;
  if (e.target.closest('input,textarea') && e.key !== 'Escape') return;
  if (e.key === 'Escape') { if (!z.test || z.finished) quitQuiz(); return; }
  if (z.finished) return;
  if ((e.key === ' ' || e.key === 'Enter') && $('#lnQNext')) { e.preventDefault(); return $('#lnQNext').click(); }
  const n = +e.key;
  if (n >= 1 && n <= 4 && !z.answered) {
    const q = z.questions[z.i];
    if (q.type === 'tf' && n <= 2) return answer(n === 1);
    if (q.options && n <= q.options.length) return answer(n - 1);
  }
}

/* ================================================================ nhắc học hằng ngày */
const R = {today: null, at: 0, timer: 0};
function paintBadge() {
  const tab = document.querySelector('a[data-view="learn"]');
  if (!tab || !R.today) return;
  let b = tab.querySelector('.nbadge');
  const t = R.today;
  const left = t.plan ? t.plan.filter(it => !it.done).length : null;
  const due = left == null && !t.studied && t.suggest.some(it => !it.done) && pastRemind(t);
  const txt = left ? String(left) : due ? '!' : '';
  if (!txt) { b && b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'nbadge'; tab.appendChild(b); }
  b.textContent = txt;
  b.title = left ? `Còn ${left} việc trong kế hoạch học hôm nay` : 'Hôm nay chưa học';
}
function pastRemind(t) {
  const [h, m] = (t.remind_at || '20:00').split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}
function askNotify() {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
async function refreshRemind() {
  try { R.today = await api('/api/learn/today'); R.at = Date.now(); } catch (e) { return; }
  paintBadge();
}
async function remindTick() {
  if (!R.today || Date.now() - R.at > 10 * 60 * 1000) await refreshRemind();
  const t = R.today;
  if (!t || !t.remind || !pastRemind(t)) return;
  let seen = '';
  try { seen = localStorage.getItem('cv-ln-notified') || ''; } catch (e) { /* bỏ qua */ }
  if (seen === t.day) return;
  const left = t.plan ? t.plan.filter(it => !it.done) : t.suggest.filter(it => !it.done);
  if (!left.length || (!t.plan && t.studied)) return;
  keep('cv-ln-notified', t.day);
  const msg = left.slice(0, 3).map(it => `${it.title} (${subjName(it.subject)})`).join(' · ');
  const title = t.plan ? `Còn ${left.length} việc học hôm nay` : 'Đến giờ học rồi!';
  try {
    if (window.Notification && Notification.permission === 'granted') {
      const n = new Notification('CircleVault – ' + title, {body: msg, tag: 'cv-learn', silent: false});
      n.onclick = () => { window.focus(); location.hash = '#learn'; n.close(); };
    }
  } catch (e) { /* bỏ qua */ }
  toast(`📚 ${title}: ${msg}`);
}
setTimeout(() => { remindTick(); setInterval(remindTick, 60 * 1000); }, 4000);
window.addEventListener('focus', () => { if (Date.now() - R.at > 60 * 1000) refreshRemind(); });

window.CV.views.learn = render;
})();
