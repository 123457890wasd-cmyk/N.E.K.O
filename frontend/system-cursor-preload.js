// system-cursor-preload.js
// 在 Electron **preload** 中：拦截渲染进程对 window.YuiGuideCommon.syncPcSystemCursorHidden
// 的调用，把"隐藏/恢复系统光标"那条路径转到主进程的原生 IPC（替代 PowerShell 子进程）。
//
// 集成方式（在你的 preload 入口文件末尾加一行）：
//   require('./system-cursor-preload').install(ipcRenderer, window);
//
// ⚠️ 关键设计点 ⚠️
// 这个 wrapper **必须彻底替换** YuiGuideCommon.syncPcSystemCursorHidden，
// 不能"先调原版再发 IPC"。原版 syncPcSystemCursorHidden 内部通过
// BroadcastChannel('yui_guide_system_cursor_visibility') 把消息广播给主进程
// 的 system-cursor-visibility-service.js，那个 handler 仍然是 PowerShell
// 启动路径。如果保留对原函数的调用，仍然会触发 PowerShell 冷启动 → 卡顿。
//
// 集成节奏：
//   1) 在主进程的 system-cursor-visibility-service.js 里把 syncPcSystemCursorHidden
//      收到 IPC 后**直接转发**给本 IPC 通道（彻底改写主进程处理器）；
//      或用 patch-app-asar.js 打完补丁后再装本 wrapper。
//   2) 在 renderer/preload 末尾调用 install()，让 wrapper 拦截对原函数的引用。
//
// 单一事实来源：是否调用原版，由 N.E.K.O.-PC 的主进程侧统一决定；本文件
// 只负责"窗口侧不再保留引用广播"，避免无意中有第二条路径发 PowerShell。

'use strict';

const cursor = require('./native-system-cursor');

function install(ipcRenderer, win) {
  if (!win || !win.YuiGuideCommon) {
    // 部分渲染窗口可能没有 YuiGuideCommon（懒加载），等它出现再装
    Object.defineProperty(win, 'YuiGuideCommon', {
      configurable: true,
      set(v) { wrapAndExpose(v, ipcRenderer, win); Object.defineProperty(win, 'YuiGuideCommon', { value: v, writable: true, configurable: true }); },
      get() { return undefined; },
    });
  } else {
    wrapAndExpose(win.YuiGuideCommon, ipcRenderer, win);
  }
}

function wrapAndExpose(common, ipcRenderer, win) {
  if (!common || typeof common.syncPcSystemCursorHidden !== 'function') return;
  if (common.__nekoNativeCursorInstalled) return;

  common.syncPcSystemCursorHidden = function patched(hidden, reason, options) {
    // 完全替换原实现：不调用原函数（避免 PowerShell 广播路径被重新触发）。
    // 仅在 Windows 走原生 IPC；其他平台发送原因但 noop。
    if (process.platform !== 'win32') {
      try { console.log('[NekoCursor] 非 Windows 平台跳过 hide/restore:', reason || '(no reason)'); } catch (_) {}
      return Promise.resolve({ ok: true, noop: true });
    }
    return Promise.resolve().then(() => {
      const inv = (hidden === true)
        ? ipcRenderer.invoke('neko:native-cursor-hide', reason)
        : ipcRenderer.invoke('neko:native-cursor-restore', reason);
      inv.then(
        () => {},
        (err) => { try { console.error('[NekoCursor] IPC 调用失败：', err); } catch (_) {} }
      );
      // sync 接口返回的是 boolean；这里改成返回 Promise 适配 await 调用方式
      return inv;
    });
  };

  common.__nekoNativeCursorInstalled = true;
  cursor.setLogger((msg) => { try { console.log(msg); } catch (_) {} });
}

module.exports = { install };
