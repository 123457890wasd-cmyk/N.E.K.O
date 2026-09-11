// native-system-cursor.js
// 原生 Win32 系统光标隐藏/恢复（替换 N.E.K.O 原版 PowerShell 子进程方案）
// 解决每次隐藏/恢复系统光标都 spawn powershell.exe 导致 0.5-1.5s 鼠标卡顿的问题。
//
// 用法：
//   const cursor = require('./native-system-cursor');
//   cursor.hide();    // 隐藏全部 18 个系统光标
//   cursor.restore(); // 调用 SPI_SETCURSORS 让系统重载默认光标
//
// 依赖：koffi（需 `pnpm add koffi` 或 `npm i koffi`）
// 仅 Windows 平台有效；其他平台调用为 no-op。
//
// 集成契约（见 docs/design/yui-guide-system-cursor-hiding.md）：
// - hide() 成功后必须配对调用 restore()，否则系统光标永久透明。
// - 部分 SetSystemCursor 失败时，已成功的 ID 仍然跟踪；下一次 hide()
//   会 retry 剩余失败的 ID（按 ID 而非全局 short-circuit）。
// - restore() 失败时**不清空** hiddenEntries，留给下一次重试。
// - 应用退出、renderer 崩溃、窗口销毁时必须 restore；具体 lifecycle 监听
//   见 system-cursor-ipc.js。

'use strict';

const SYSTEM_CURSOR_IDS = Object.freeze([
  32512, // IDC_ARROW
  32513, // IDC_IBEAM
  32514, // IDC_WAIT
  32515, // IDC_CROSS
  32516, // IDC_UPARROW
  32640, // IDC_SIZE       (SIZEWE in old headers)
  32641, // IDC_ICON
  32642, // IDC_SIZENESW
  32643, // IDC_SIZENWSE
  32644, // IDC_SIZEWE
  32645, // IDC_SIZENS
  32646, // IDC_SIZEALL
  32648, // IDC_NO
  32649, // IDC_HAND
  32650, // IDC_APPSTARTING
  32651, // IDC_HELP
  32671, // IDC_PIN
  32672, // IDC_PERSON
]);

const SPI_SETCURSORS = 0x0057;

let bound = null;            // { lib, CreateCursor, SetSystemCursor, DestroyCursor, SPI } or null on non-win32
const hiddenById = new Map(); // id -> handle — 当前生效中；restore 或 DeleteCursor 后从 map 删除
const failedIds = new Set();  // 上一次循环失败的 ID，下一次 hide() 会重试
let logging = null;           // optional (msg) => void

function setLogger(fn) { logging = typeof fn === 'function' ? fn : null; }
function log(msg) { if (logging) { try { logging(msg); } catch (_) {} } }

function tryLoad() {
  if (bound) return bound;
  if (process.platform !== 'win32') return null;

  let koffi;
  try {
    koffi = require('koffi');
  } catch (err) {
    log('[NekoCursor] koffi 未安装，请执行 pnpm add koffi（错误：' + (err && err.message) + '）');
    return null;
  }

  const lib = koffi.load('user32.dll');

  // 注：CreateCursor 的 pvANDPlane / pvXORPlane 在 32x32 1bpp 时各 128 字节
  const CreateCursor = lib.func(
    'void* __stdcall CreateCursor(void* hInst, int xHotSpot, int yHotSpot, int nWidth, int nHeight, uint8_t* lpANDPlane, uint8_t* lpXORPlane)'
  );
  const SetSystemCursor = lib.func(
    'bool __stdcall SetSystemCursor(void* hcur, uint32_t id)'
  );
  // 用于回收 SetSystemCursor 失败时的孤儿句柄，避免 USER/GDI 句柄泄漏。
  const DestroyCursor = lib.func(
    'bool __stdcall DestroyCursor(void* hcur)'
  );
  const SystemParametersInfo = lib.func(
    'bool __stdcall SystemParametersInfo(uint32_t uiAction, uint32_t uiParam, void* pvParam, uint32_t fWinIni)'
  );

  bound = { lib, CreateCursor, SetSystemCursor, DestroyCursor, SystemParametersInfo };
  return bound;
}

function isNullHandle(h) {
  return h === null || h === undefined || h === 0 || h === 0n;
}

/**
 * 用一个完全透明的 32x32 1bpp 光标句柄替换全部 18 个系统光标。
 * 返回成功替换的数量；非 win32 平台返回 0。
 *
 * 幂等性：已成功的 ID 不会重复替换；之前失败的 ID 会被 retry。配合 restore
 * 语义使用。SetSystemCursor 成功时系统接管句柄，不得 DestroyCursor；只有在
 * SetSystemCursor 失败时本函数负责 DestroyCursor 回收孤儿句柄。
 */
function hide() {
  const b = tryLoad();
  if (!b) return 0;

  // AND 掩码全 0xFF（表示该位"透明"），XOR 全 0 → 完全不可见
  const andMask = Buffer.alloc(128, 0xff);
  const xorMask = Buffer.alloc(128, 0x00);

  // 候选 ID 集合：未成功过的 + 上次失败的
  const candidates = [];
  for (const id of SYSTEM_CURSOR_IDS) {
    if (!hiddenById.has(id)) candidates.push(id);
  }
  for (const id of failedIds) {
    if (!hiddenById.has(id) && !candidates.includes(id)) candidates.push(id);
  }
  if (candidates.length === 0) return hiddenById.size;

  let ok = 0;
  const stillFailing = new Set();
  for (const id of candidates) {
    let hCursor = null;
    try {
      hCursor = b.CreateCursor(null, 0, 0, 32, 32, andMask, xorMask);
    } catch (e) {
      log('[NekoCursor] CreateCursor 抛错 id=' + id + ' err=' + (e && e.message));
      stillFailing.add(id);
      continue;
    }
    if (isNullHandle(hCursor)) {
      // koffi 对 NULL 句柄返回 0n (BigInt) 或 0
      stillFailing.add(id);
      continue;
    }
    let setOk = false;
    try {
      setOk = b.SetSystemCursor(hCursor, id);
    } catch (e) {
      log('[NekoCursor] SetSystemCursor 抛错 id=' + id + ' err=' + (e && e.message));
    }
    if (setOk) {
      hiddenById.set(id, hCursor);
      ok++;
    } else {
      // 失败：句柄未交接给系统，本进程仍持有所有权，必须回收。
      try { b.DestroyCursor(hCursor); } catch (_) {}
      stillFailing.add(id);
    }
  }
  failedIds = stillFailing;
  log('[NekoCursor] hide: 新增 ' + ok + '/' + candidates.length +
      '（累计 ' + hiddenById.size + '/' + SYSTEM_CURSOR_IDS.length +
      '，仍失败 ' + failedIds.size + '）');
  return ok;
}

/**
 * 通过 SPI_SETCURSORS 让系统从 user32 资源重载默认光标。
 * 这是 PowerShell 原版脚本用的同一个恢复 API。
 *
 * 关键：**仅在 SPI_SETCURSORS 返回成功时清空 hiddenById**。
 * 失败时保留映射，把"已隐藏 ID"留给下一次 retry；这样 quit-cleanup 路径
 * 看到失败光标才能再次尝试，不会因为 early-return 而留下永久透明光标。
 *
 * 注意：SetSystemCursor 成功的句柄已经把所有权交接给系统，我们不应
 * DestroyCursor；这里没把隐藏句柄列入"失败销毁"集合，正是这个原因。
 */
function restore() {
  const b = tryLoad();
  if (!b) return false;

  if (hiddenById.size === 0) {
    failedIds.clear();
    return true; // 没有处于隐藏态
  }

  let ok = false;
  try {
    ok = b.SystemParametersInfo(SPI_SETCURSORS, 0, null, 0);
  } catch (e) {
    log('[NekoCursor] SystemParametersInfo 抛错 err=' + (e && e.message));
  }

  if (ok) {
    hiddenById.clear();
    failedIds.clear();
  }
  // 失败时保留 hiddenById + failedIds，让下一次调用有 retry 基础。
  log('[NekoCursor] restore: SPI_SETCURSORS=' + ok +
      '（' + hiddenById.size + ' 项仍跟踪）');
  return !!ok;
}

/** 测试用：查询是否处于隐藏态 */
function isHidden() { return hiddenById.size > 0; }

/** 测试用：上轮失败 ID 列表 */
function getFailedIds() { return new Set(failedIds); }

module.exports = {
  hide, restore, isHidden, getFailedIds,
  setLogger, SYSTEM_CURSOR_IDS,
};
