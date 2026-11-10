'use strict';
// Màn hình chờ: nội dung lấy từ tham số trên địa chỉ (?msg=&sub=&ver=), không cần cầu nối với app.
(() => {
  const q = new URLSearchParams(location.search);
  const set = (id, v) => { if (v) document.getElementById(id).textContent = v; };
  set('msg', q.get('msg'));
  set('sub', q.get('sub'));
  set('ver', q.get('ver') ? 'bản ' + q.get('ver') : '');
  // khởi động lâu (máy chậm, lần đầu sau cập nhật) thì nói rõ là app vẫn đang chạy
  if (q.get('mode') !== 'install') {
    setTimeout(() => set('sub', 'Lần đầu sau khi cài / cập nhật có thể mất 20–30 giây.'), 8000);
    setTimeout(() => set('sub', 'Vẫn đang khởi động, máy hơi chậm… sắp xong.'), 25000);
  }
})();
