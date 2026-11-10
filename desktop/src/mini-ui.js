'use strict';
/* Trình phát mini: hiện trạng thái do cửa sổ chính gửi sang, gửi lệnh điều khiển ngược lại. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ms = window.mshell;
  const ICON = {
    play: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    vol: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
    mute: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  };
  let s = { has: false };
  let at = Date.now();
  let cover = null;
  let dragVol = false;

  const fmt = (x) => {
    x = Math.max(0, Math.floor(x || 0));
    const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = String(x % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const now = () => (s.playing ? Math.min(s.dur || Infinity, (s.cur || 0) + (Date.now() - at) / 1000) : s.cur || 0);

  function paintTime() {
    const c = now(), d = s.dur || 0;
    $('cur').textContent = fmt(c);
    $('dur').textContent = fmt(d);
    $('fill').style.width = d ? Math.min(100, (c / d) * 100) + '%' : '0';
  }

  function paint() {
    const title = s.title || 'CircleVault';
    const box = $('title'), tt = $('titleText');
    if (tt.dataset.t !== title) {
      tt.dataset.t = title;
      tt.textContent = title;
      box.classList.remove('run');
      tt.style.removeProperty('--t');
      requestAnimationFrame(() => {
        if (tt.scrollWidth > box.clientWidth + 2) {   // tên dài: chạy chữ (nhân đôi để nối vòng)
          tt.textContent = title + ' • ' + title + ' • ';
          box.style.setProperty('--t', Math.max(8, title.length * 0.28) + 's');
          box.classList.add('run');
        }
      });
    }
    $('artist').textContent = s.artist || '';
    document.title = (s.playing ? '▶ ' : '') + title;
    $('play').innerHTML = s.playing ? ICON.pause : ICON.play;
    $('play').setAttribute('aria-label', s.playing ? 'Tạm dừng' : 'Phát');
    $('disc').classList.toggle('on', !!s.playing);
    $('shuffle').classList.toggle('on', !!s.shuffle);
    $('repeat').classList.toggle('on', s.repeat && s.repeat !== 'off');
    $('repeat').classList.toggle('one', s.repeat === 'one');
    $('repeat').title = { off: 'Không lặp', all: 'Lặp cả danh sách', one: 'Lặp 1 bài' }[s.repeat || 'off'];
    $('mute').innerHTML = s.muted || !s.volume ? ICON.mute : ICON.vol;
    if (!dragVol) $('vol').value = s.muted ? 0 : (s.volume ?? 0.9);
    if (cover !== (s.cover || '')) {
      cover = s.cover || '';
      $('label').innerHTML = '';
      if (cover) {
        const img = new Image();
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.remove();
        img.src = cover;
        $('label').appendChild(img);
      }
    }
    paintTime();
  }

  ms.onState((v) => { s = v || { has: false }; at = Date.now(); paint(); });
  ms.state().then((v) => { if (v) { s = v; at = Date.now(); paint(); } });
  setInterval(() => { if (s.playing) paintTime(); }, 250);

  for (const id of ['prev', 'next', 'shuffle', 'repeat', 'mute', 'open', 'close']) $(id).addEventListener('click', () => ms.send(id));
  $('play').addEventListener('click', () => { s.playing = !s.playing; s.cur = now(); at = Date.now(); paint(); ms.send('toggle'); });
  $('disc').addEventListener('click', () => ms.send('open'));
  $('bar').addEventListener('click', (e) => {
    if (!s.dur) return;
    const r = $('bar').getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * s.dur;
    s.cur = v; at = Date.now(); paintTime();
    ms.send('seek', v);
  });
  $('vol').addEventListener('input', (e) => { dragVol = true; ms.send('vol', Number(e.target.value)); });
  $('vol').addEventListener('change', () => { dragVol = false; });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
    else if (e.key === 'ArrowRight') ms.send('next');
    else if (e.key === 'ArrowLeft') ms.send('prev');
    else if (e.key === 'Escape') ms.send('close');
  });
})();
