'use strict';
/**
 * Thành phần gắn thêm (addon) của app: mỗi file trong thư mục này (trừ index.js) là một addon độc lập, có
 * `setup(ctx)` và (tùy chọn) `attach(win)`. Gỡ một addon = xóa file của nó (và thư mục frontend/addons/<tên>/) – app vẫn chạy bình thường.
 * Trang ↔ addon nói chuyện qua một kênh chung: cvDesktop.addon(tên, tin) / cvDesktop.onAddon((tên, tin) => …).
 */
const fs = require('fs');
const path = require('path');

const list = [];

function setup(ctx) {
  for (const f of fs.readdirSync(__dirname).sort()) {
    if (!f.endsWith('.js') || f === 'index.js' || f.endsWith('-preload.js')) continue;   // *-preload.js: script trang của addon
    try {
      const m = require(path.join(__dirname, f));
      m.setup(ctx);
      list.push(m);
      ctx.log('Addon:', f.replace(/\.js$/, ''));
    } catch (e) { ctx.log('Không nạp được addon', f, e.message); }
  }
}

function attach(win) {
  for (const m of list) { try { if (m.attach) m.attach(win); } catch (e) { /* addon lỗi không làm hỏng app */ } }
}

module.exports = { setup, attach };
