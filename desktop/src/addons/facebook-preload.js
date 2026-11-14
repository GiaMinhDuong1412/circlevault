'use strict';
// Khung Facebook trong app: tắt đăng nhập bằng passkey (Windows Hello) – trong cửa sổ nhúng hộp passkey của Windows
// hiện ra khó dùng; Facebook sẽ quay về đăng nhập mật khẩu. Cách chính vẫn là nhận đăng nhập từ Chrome qua tiện ích CircleVault.
const { contextBridge, webFrame } = require('electron');

const off = () => {
  try { delete window.PublicKeyCredential; } catch (e) { /* bỏ qua */ }
  try {
    const c = navigator.credentials;
    if (c) {
      const no = () => Promise.reject(new DOMException('Passkey không dùng trong CircleVault', 'NotAllowedError'));
      Object.defineProperty(c, 'get', { value: (o) => (o && o.publicKey ? no() : Promise.resolve(null)), configurable: true });
      Object.defineProperty(c, 'create', { value: no, configurable: true });
    }
  } catch (e) { /* bỏ qua */ }
};
try {
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: off });
  else webFrame.executeJavaScript(`(${off.toString()})()`);
} catch (e) { /* bỏ qua */ }
