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
  'ielts/vocab': 'Từ vựng IELTS theo chủ đề (Environment, Education, Technology, Health…) và Academic Word List, kèm phiên âm, ví dụ, collocation.',
  'ielts/listening': 'Luyện nghe Part 1–4: audio, câu hỏi, đáp án và transcript; ghi lại từ hay bị nghe nhầm.',
  'ielts/reading': 'Bài đọc Academic / General với các dạng True/False/Not Given, Matching Headings, Summary completion.',
  'ielts/writing': 'Đề Task 1 (biểu đồ, quy trình, thư) và Task 2 (nghị luận), bài mẫu band 7+, cấu trúc câu, từ nối.',
  'ielts/speaking': 'Câu hỏi Part 1–3 theo chủ đề, cue card, câu trả lời mẫu và từ vựng ăn điểm.',
  'ja/kana': 'Hiragana và Katakana: âm cơ bản, âm đục, âm ghép.',
  'ja/vocab': 'Từ vựng JLPT N5 → N1 theo bài: kanji, cách đọc kana, nghĩa, Hán Việt, câu ví dụ.',
  'ja/kanji': 'Kanji theo cấp JLPT: âm On / Kun, Hán Việt, bộ thủ, từ ghép thường gặp.',
  'ja/grammar': 'Mẫu ngữ pháp N5 → N1: cấu trúc, cách dùng, ví dụ có dịch.',
  'zh/pinyin': 'Thanh điệu, thanh mẫu, vận mẫu – nghe và đọc theo.',
  'zh/vocab': 'Từ vựng HSK 1 → 6 (và HSK 3.0): chữ giản thể, pinyin, Hán Việt, nghĩa, ví dụ.',
  'zh/hanzi': 'Chữ Hán: bộ thủ, số nét, Hán Việt, từ ghép.',
  'zh/grammar': 'Ngữ pháp HSK theo cấp: cấu trúc câu, trợ từ, bổ ngữ.',
  'ko/hangul': 'Nguyên âm, phụ âm, phụ âm căng/bật hơi, patchim.',
  'ko/vocab': 'Từ vựng TOPIK I (cấp 1–2) và TOPIK II (cấp 3–6): nghĩa, Hán Hàn, ví dụ.',
  'ko/grammar': 'Ngữ pháp sơ – trung – cao cấp: đuôi câu, tiểu từ, cấu trúc thường thi.',
};
const CHART = new Set(['kana', 'hangul', 'pinyin']);
const MODES = [['card', 'Thẻ ghi nhớ'], ['quiz', 'Trắc nghiệm'], ['type', 'Gõ đáp án']];
const GRADES = [['Quên', 'red'], ['Khó', 'yellow'], ['Nhớ', 'green'], ['Dễ', 'cyan']];

const L = {subject: null, section: null, deck: null, study: null, mode: 'card', ov: null, sv: null};
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
          <li>Bấm <b>HỌC NGAY</b>: mỗi thẻ tự đánh giá Quên / Khó / Nhớ / Dễ, app tự xếp lịch ôn.</li>
          <li>Từ vựng, ngữ pháp, đề IELTS: sẽ được nạp ở bản sau; bạn cũng tự tạo bộ thẻ hoặc nhập file JSON/CSV.</li>
        </ol>
      </div>
    </div>`;
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

function quit() { L.study = null; document.removeEventListener('keydown', onKey); render(); }

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
      <div class="btn-row"><button class="btn green" type="button" id="lnMore">HỌC TIẾP</button><button class="btn plain" type="button" id="lnQuit">Về trang môn học</button></div></div>`;
    $('#lnQuit').addEventListener('click', quit);
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

window.CV.views.learn = render;
})();
