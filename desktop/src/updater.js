'use strict';
/**
 * Cập nhật CircleVault từ repo public GiaMinhDuong1412/circlevault-releases (không cần token) – giống AQ Auto Test.
 * Mỗi lần merge vào main, GitHub Actions của repo code build bộ cài và đẩy Setup.exe + latest.yml sang repo đó.
 *
 * Trạng thái gửi cho trang (kênh 'update'):
 *   idle | checking | latest | available | downloading | downloaded | error | unsupported
 */
const { app, shell } = require('electron');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }

const RELEASES_URL = 'https://github.com/GiaMinhDuong1412/circlevault-releases/releases/latest';

function shortError(e) {
  const m = String((e && e.message) || e || '');
  if (/404|Cannot find latest|No published versions|Unable to find latest/i.test(m)) return 'Chưa có bản phát hành nào';
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET|getaddrinfo/i.test(m)) return 'Không kết nối được GitHub';
  return m.split('\n')[0].slice(0, 160);
}

function createUpdater({ send, notify, beforeInstall }) {
  const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
  const supported = !!autoUpdater && app.isPackaged;
  let manual = false;
  let notified = null;
  let state = { status: 'idle', current: app.getVersion(), version: null, percent: 0, error: null, portable, supported };

  const set = (patch) => { state = { ...state, ...patch }; send('update', state); };

  if (supported) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;   // chỉ cài khi người dùng bấm "Khởi động lại"
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => { if (state.status !== 'downloading') set({ status: 'checking', error: null }); });
    autoUpdater.on('update-available', (info) => {
      set({ status: 'available', version: info.version, error: null });
      if (notified !== info.version) {
        notified = info.version;
        notify(`CircleVault có bản mới ${info.version}`, portable ? 'Mở app và bấm "Tải bản mới".' : 'Mở app và bấm "Cập nhật", chỉ mất vài giây.');
      }
    });
    autoUpdater.on('update-not-available', () => { set({ status: manual ? 'latest' : 'idle', version: null }); manual = false; });
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'downloaded', version: info.version, percent: 100 }));
    autoUpdater.on('error', (e) => {
      // tự kiểm tra định kỳ mà lỗi (mất mạng…) thì bỏ qua; chỉ báo khi người dùng bấm hoặc đang tải
      if (manual || state.status === 'downloading') set({ status: 'error', error: shortError(e) });
      else set({ status: state.version ? 'available' : 'idle' });
      manual = false;
    });
  }

  async function check(isManual) {
    if (!supported) { if (isManual) set({ status: 'unsupported', error: 'Bản chạy từ mã nguồn (chưa đóng gói) không tự cập nhật' }); return; }
    if (state.status === 'downloading' || state.status === 'downloaded') return;
    manual = !!isManual;
    try { await autoUpdater.checkForUpdates(); } catch (e) {
      if (manual) set({ status: 'error', error: shortError(e) });
      manual = false;
    }
  }

  /** Nút cập nhật trên trang: làm việc tuỳ trạng thái hiện tại. */
  async function act() {
    if (state.status === 'available') {
      if (portable) { shell.openExternal(RELEASES_URL); return; }
      set({ status: 'downloading', percent: 0, error: null });
      try { await autoUpdater.downloadUpdate(); } catch (e) { set({ status: 'error', error: shortError(e) }); }
    } else if (state.status === 'downloaded') {
      if (beforeInstall) beforeInstall();
      setImmediate(() => autoUpdater.quitAndInstall(true, true)); // cài im lặng rồi mở lại app
    } else if (state.status !== 'downloading' && state.status !== 'checking') {
      await check(true);
    }
  }

  return { check, act, getState: () => state };
}

module.exports = { createUpdater, RELEASES_URL };
