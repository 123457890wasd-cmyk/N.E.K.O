// system-cursor-ipc.js
// 在 Electron **主进程** 注册 IPC handler，把渲染进程发来的光标请求
// 转给 native-system-cursor.js 处理（替代原 PowerShell 子进程方案）。
//
// 用法：在 Electron main 进程的 ready 事件之前或之后任何位置调用：
//   require('./system-cursor-ipc').register(ipcMain, electronApp);
// （electronApp 可选，传了则用于在退出/lifecycle 事件自动 restore）
//
// 集成契约（docs/design/yui-guide-system-cursor-hiding.md）：
// - 隐藏请求必须有对应恢复路径。
// - 窗口销毁、renderer 崩溃、超时和应用退出时**强制恢复**。
// - 用户离开或应用失焦时优先恢复。
// - 多 renderer 同时持 hide 请求时，按引用计数共享同一"隐藏态"——避免
//   第一个 renderer 关闭时把第二个正在用的光标暴露出来。
// - 普通网页模式时安全 no-op（仅在 Electron 渲染进程场景下生效）。

'use strict';

const cursor = require('./native-system-cursor');

/**
 * 单实例注册，避免重复 handler / 重复事件监听。
 */
let registered = false;
/** webContents.id -> Set<{"kind":"hide","reason":string,...}>：该 renderer 当前未匹配的隐藏请求 */
const pendingByWebContentsId = new Map();

function register(ipcMain, electronApp) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('[NekoCursor] 需要传入 ipcMain');
  }
  if (registered) {
    return;
  }
  registered = true;

  // 把日志接到主进程 console，便于排查
  cursor.setLogger((msg) => {
    try { console.log(msg); } catch (_) {}
  });

  ipcMain.handle('neko:native-cursor-hide', async (event) => {
    const wcId = event && event.sender && event.sender.id;
    rememberPending(wcId, { kind: 'hide' });
    const count = cursor.hide();
    return { ok: count > 0, count };
  });

  ipcMain.handle('neko:native-cursor-restore', async (event) => {
    const wcId = event && event.sender && event.sender.id;
    // 先清掉本 renderer 的挂起 hide 请求
    const cleared = clearPending(wcId, 'hide');
    if (cleared > 0 && isAllPendingCleared()) {
      // 全局再无挂起 hide 时才调用底层 restore（实现多 renderer 共享 + 引用计数）
      const ok = cursor.restore();
      return { ok };
    }
    if (cleared > 0) {
      // 仍有其他 renderer 持 hide：noop（保持光标隐藏）
      return { ok: true, shared: true };
    }
    // 没有匹配的隐藏请求（含已经 restore 的同一 renderer）：noop
    return { ok: true, noop: true };
  });

  // 强制清理已挂起的隐藏请求，避免 renderer 关闭/crash 后光标永久隐藏
  installLifecycleGuards(electronApp);

  console.log('[NekoCursor] IPC handlers 已注册');
}

/**
 * 记录某个 renderer 发出的隐藏请求（按 webContents 维度引用计数）。
 */
function rememberPending(wcId, entry) {
  if (typeof wcId !== 'number') return;
  let set = pendingByWebContentsId.get(wcId);
  if (!set) {
    set = new Set();
    pendingByWebContentsId.set(wcId, set);
  }
  set.add(entry);
}

function clearPending(wcId, kind) {
  if (typeof wcId !== 'number') return 0;
  const set = pendingByWebContentsId.get(wcId);
  if (!set) return 0;
  let n = 0;
  for (const item of Array.from(set)) {
    if (item.kind === kind) {
      set.delete(item);
      n++;
    }
  }
  if (set.size === 0) pendingByWebContentsId.delete(wcId);
  return n;
}

function dropPendingForWebContents(wcId) {
  if (typeof wcId !== 'number') return 0;
  const set = pendingByWebContentsId.get(wcId);
  if (!set) return 0;
  const n = set.size;
  pendingByWebContentsId.delete(wcId);
  return n;
}

function isAllPendingCleared() {
  if (pendingByWebContentsId.size === 0) return true;
  for (const set of pendingByWebContentsId.values()) {
    if (set.size > 0) return false;
  }
  return true;
}

/**
 * 安装 lifecycle 兜底：如果 renderer hide 了光标后就关闭、刷新、crash，
 * 主进程收不到 restore；这里硬恢复一次。设计文档要求"renderer 崩溃不能
 * 让系统鼠标永久隐藏"。
 */
function installLifecycleGuards(electronApp) {
  if (!electronApp || typeof electronApp.on !== 'function') return;

  const appEmit = (eventName) => () => {
    try {
      const n = forceRestoreAll();
      if (n > 0) console.log(`[NekoCursor] 收到 ${eventName}，强制恢复 ${n} 个挂起 hide`);
    } catch (e) {
      try { console.error('[NekoCursor] 强恢复失败:', e && e.message); } catch (_) {}
    }
  };

  electronApp.on('will-quit', appEmit('will-quit'));
  electronApp.on('before-quit', appEmit('before-quit'));

  // 任何 webContents 创建时同步挂上 destroyed/render-process-gone 守护
  if (typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try { attachContentsGuards(contents); } catch (_) {}
    });
  }
}

/**
 * 给单个 webContents 装上生命周期守卫：
 * - 'destroyed'：正常关闭路径（页面跳转、窗口关闭、用户切换）
 * - 'render-process-gone'：crash / OOM / killed
 * 任何一种都会自动清掉该 renderer 的挂起 hide；如果清完后全局无挂起，
 * 调一次底层 restore。
 */
function attachContentsGuards(contents) {
  if (!contents || contents.__nekoCursorGuards) return;
  contents.__nekoCursorGuards = true;

  const wcId = contents.id;
  const cleanup = (label) => () => {
    const n = dropPendingForWebContents(wcId);
    if (n > 0 && isAllPendingCleared()) {
      try {
        const ok = cursor.restore();
        console.log(`[NekoCursor] ${label} -> 自动 restore（清掉 ${n} 项挂起 hide），结果 ${ok}`);
      } catch (e) {
        try { console.error('[NekoCursor] 自动 restore 抛错:', e && e.message); } catch (_) {}
      }
    } else if (n > 0) {
      console.log(`[NekoCursor] ${label} -> 清掉 ${n} 项挂起 hide，仍有其他 renderer 在隐藏，跳过 restore`);
    }
  };
  contents.on('destroyed', cleanup('webContents destroyed'));
  contents.on('render-process-gone', (_event, details) =>
    cleanup('render-process-gone(' + (details && details.reason) + ')')()
  );
}

/**
 * 把所有 renderer 的挂起 hide 一次性清掉 + 调一次底层 restore。
 * 一般只在 app 退出事件中调用。
 */
function forceRestoreAll() {
  let total = 0;
  for (const set of pendingByWebContentsId.values()) total += set.size;
  pendingByWebContentsId.clear();
  if (total === 0) return 0;
  try {
    const ok = cursor.restore();
    console.log('[NekoCursor] forceRestoreAll: 实际恢复结果=' + ok);
    return total;
  } catch (e) {
    try { console.error('[NekoCursor] forceRestoreAll 抛错:', e && e.message); } catch (_) {}
    return total;
  }
}

module.exports = {
  register,
  // 测试用
  _internal: { pendingByWebContentsId, forceRestoreAll, attachContentsGuards },
};
