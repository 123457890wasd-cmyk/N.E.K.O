#!/usr/bin/env node
/*
 * patch-app-asar.js
 * 在已编译的 N.E.K.O v0.9.0.1_win/resources/app.asar 上应用 / 回滚 / 验证
 * 「光标隐藏走原生 Win32 helper」补丁。
 *
 * 用法（任选其一）：
 *   node patch-app-asar.js install   [--asar <path>] [--helper <exe>]
 *   node patch-app-asar.js rollback  [--asar <path>]
 *   node patch-app-asar.js verify    [--asar <path>]
 *
 * 默认 asar 路径：S:\Relax_event\N.E.K.O_v0.9.0.1_win\resources\app.asar
 * 默认 helper 路径：<asar 同级 bin 目录>/neko_cursor_helper.exe
 *
 * 依赖：@electron/asar（推荐通过 tools/asar_tools 安装，统一锁版本）。
 *
 * 行为小结：
 * - helper 部署位置**始终**来自 asar 路径（`path.dirname(args.asar) + bin/neko_cursor_helper.exe`），
 *   不再受 --helper 参数影响，避免自我复制。
 * - 备份 .original_backup 写入时会伴随 .original_backup.sha256 校验值；下次 install
 *   比较"现存备份 sha256" vs "当前 asar sha256"，只有在两者一致（即当前 asar 仍是原始版）
 *   才跳过备份。否则视为上游升级，重新备份。
 * - 重打包/替换采用原子风格：原 asar -> .old -> 新 .new -> asar；任一 rename 失败时
 *   立即回滚 .old -> asar，避免半截状态导致 app 启动不了。
 * - 即使已检测到 patch，helper 部署也照样执行，便于补救之前 helper 复制失败/被
 *   杀软隔离的情况。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const DEFAULT_ASAR = 'S:\\Relax_event\\N.E.K.O_v0.9.0.1_win\\resources\\app.asar';
const HELPER_EXE_NAME = 'neko_cursor_helper.exe';
const BACKUP_SUFFIX = '.original_backup';
const BACKUP_SHA_SUFFIX = '.sha256';
const PATCH_MARKER = '2026-09-09 patch: 替换 PowerShell 子进程为原生 Win32 helper';
const ORIGINAL_SNIPPET = "Buffer.from(buildWin32CursorHelperScript(), 'utf16le').toString('base64')";
const TARGET_FILE_IN_ASAR = 'src/system-cursor-visibility-service.js';

function sha256OfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeSha256Sidecar(targetPath) {
  const sum = sha256OfFile(targetPath);
  fs.writeFileSync(targetPath + BACKUP_SHA_SUFFIX, sum + '\n', 'utf8');
  return sum;
}

function readSha256Sidecar(targetPath) {
  const side = targetPath + BACKUP_SHA_SUFFIX;
  if (!fs.existsSync(side)) return null;
  return fs.readFileSync(side, 'utf8').trim();
}

/**
 * helper 部署目标：永远是 asar 同级 resources/bin/。
 * 不论用户传什么 --helper，本函数始终只产出同一个目标路径，避免自我复制。
 */
function helperDestDir(asarPath) {
  return path.join(path.dirname(asarPath), 'bin');
}
function helperDestPath(asarPath) {
  return path.join(helperDestDir(asarPath), HELPER_EXE_NAME);
}

function parseArgs(argv) {
  const args = { mode: null, asar: DEFAULT_ASAR, helper: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar') { args.asar = argv[++i]; }
    else if (a === '--helper') { args.helper = argv[++i]; }
    else if (!args.mode) { args.mode = a; }
    else { throw new Error(`未知参数: ${a}`); }
  }
  if (!['install', 'rollback', 'verify'].includes(args.mode)) {
    throw new Error('必须指定 install / rollback / verify 之一');
  }
  return args;
}

function ensureAsarCli() {
  try {
    require.resolve('@electron/asar');
    return;
  } catch (_) {
    // 不在 require 路径，尝试 tools/asar_tools 本地安装
  }
  const localTools = path.join(__dirname, '..', 'asar_tools');
  if (fs.existsSync(path.join(localTools, 'node_modules', '@electron', 'asar'))) {
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') +
      path.join(localTools, 'node_modules');
    require('module').Module._initPaths();
    return;
  }
  // 兜底：提示用户安装
  console.error('未找到 @electron/asar。请执行：');
  console.error('  cd tools/asar_tools && npm install');
  process.exit(2);
}

async function loadAsar() {
  ensureAsarCli();
  return require('@electron/asar');
}

function ensureAsarWritable(asarPath) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`asar 不存在: ${asarPath}`);
  }
}

function buildPatchedSource(originalSource) {
  // PATCH_MARKER 判定必须排在 ORIGINAL_SNIPPET 之前：一旦打过补丁，
  // ORIGINAL_SNIPPET 就已被替换掉、不再存在。如果先判 ORIGINAL_SNIPPET，
  // 对已 patch 的 asar 重跑 install 会误报"原版源码不匹配"，而不是
  // 走"已是 patched"分支去补救 helper 部署。
  if (originalSource.includes(PATCH_MARKER)) {
    return originalSource; // 已是 patched
  }
  if (!originalSource.includes(ORIGINAL_SNIPPET)) {
    throw new Error('原版源码不匹配预期片段，可能是上游已经修过或版本不一致；拒绝继续。');
  }
  const oldBlock =
`      const encodedScript = Buffer.from(buildWin32CursorHelperScript(), 'utf16le').toString('base64');
      return startHelper('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedScript,
      ], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      }, reason);`;
  const newBlock =
`      // 2026-09-09 patch: 替换 PowerShell 子进程为原生 Win32 helper
      // 原 PowerShell 路径每次 spawn 都要加载 .NET Framework（300-800ms）+ 火绒扫描，
      // 导致系统光标操作期间鼠标卡 1-3 秒。换成预编译的 neko_cursor_helper.exe，
      // 启动 <10ms，不再走 .NET。
      const path = require('path');
      const helperPath = path.join(
        path.dirname(process.execPath),
        'resources', 'bin', '${HELPER_EXE_NAME}'
      );
      return startHelper(helperPath, [], {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      }, reason);`;
  if (!originalSource.includes(oldBlock)) {
    throw new Error('找不到原 PowerShell 代码块（可能已 patch 或上游代码漂移）。');
  }
  return originalSource.replace(oldBlock, newBlock);
}

/**
 * 部署 helper 到 asar 同级 bin/ 目录。**始终**采用 asar 路径推导，不受
 * --helper 自我复制风险影响（即使你传 --helper 把 exe 放在临时目录，
 * 这里也只会拷到 asar 同级 bin/ 下）。
 *
 * @param {string} helperSourcePath 编译产出的 helper exe
 * @param {string} asarPath 作为部署位置参考的 asar 路径
 * @returns {boolean} true 表示这次实际复制了一次（之前不存在或内容变化）
 */
function deployHelper(helperSourcePath, asarPath) {
  if (!helperSourcePath) {
    throw new Error('helper 源路径为空；install 时请传 --helper <compiled exe> 或先编译。');
  }
  if (!fs.existsSync(helperSourcePath)) {
    throw new Error(`helper 不存在: ${helperSourcePath}（先编译 neko_cursor_helper.exe）`);
  }
  const realDestDir = helperDestDir(asarPath);
  const realDestPath = helperDestPath(asarPath);
  if (!fs.existsSync(realDestDir)) fs.mkdirSync(realDestDir, { recursive: true });
  // 内容一致时也允许 no-op（避免重复复制触发的杀软告警）
  if (fs.existsSync(realDestPath)) {
    const srcBuf = fs.readFileSync(helperSourcePath);
    const dstBuf = fs.readFileSync(realDestPath);
    if (srcBuf.equals(dstBuf)) {
      console.log(`[install] helper 与目标一致，跳过复制 -> ${realDestPath}`);
      return false;
    }
  }
  fs.copyFileSync(helperSourcePath, realDestPath);
  console.log(`[install] 已部署 helper -> ${realDestPath}`);
  return true;
}

/**
 * 把备份 .original_backup 写到 backupPath，并附带 sha256 副文件。
 */
function backupAsar(asarPath, backupPath) {
  fs.copyFileSync(asarPath, backupPath);
  const sum = writeSha256Sidecar(backupPath);
  console.log(`[install] 已备份原版 asar -> ${backupPath}`);
  console.log(`[install]        sha256  -> ${sum}`);
  return sum;
}

/**
 * 快速判断某个 asar 是否已经被打过补丁（不解析 archive，直接扫原始字节）。
 * asar 默认把文件内容原样存放，所以 PATCH_MARKER 的 UTF-8 字节可以直接
 * 在二进制里命中。
 */
function asarLooksPatched(asarPath) {
  try {
    return fs.readFileSync(asarPath).includes(Buffer.from(PATCH_MARKER, 'utf8'));
  } catch (_) {
    return false;
  }
}

/**
 * 决定是否要重新备份。语义：`.original_backup` 保存的是"最后一个未打补丁的
 * 原始 asar"，用来在 rollback 时把安装还原回去。
 *
 * 规则（顺序很重要）：
 *  1. 没有备份 -> 必须建。
 *  2. 当前 asar 已打过补丁 -> 现有备份就是货真价实的原件，**绝不覆盖**
 *     （否则第二次 install 会把唯一的原版备份毁掉，rollback 就还原不了了）。
 *  3. 当前 asar 未打补丁：
 *     - 与备份 sha256 一致 -> 备份已经对得上，沿用。
 *     - 与备份 sha256 不一致 -> 说明上游升级替换了 asar（新的未打补丁版本），
 *       用当前 asar 重新备份，保证 rollback 回到的是这次升级后的版本。
 */
function shouldRebackup(asarPath, backupPath) {
  if (!fs.existsSync(backupPath)) return true;
  if (asarLooksPatched(asarPath)) {
    // 已 patch：备份仍是原件，保留
    const backupSha = readSha256Sidecar(backupPath);
    if (!backupSha) {
      // 早期版本遗留的无 sidecar 备份：补写一次，便于后续比较
      try { writeSha256Sidecar(backupPath); } catch (_) {}
    }
    return false;
  }
  const currentSum = sha256OfFile(asarPath);
  const backupSha = readSha256Sidecar(backupPath);
  if (backupSha) return currentSum !== backupSha;
  // 无 sidecar 的旧备份：直接比对内容
  return sha256OfFile(backupPath) !== currentSum;
}

async function actionInstall(args) {
  ensureAsarWritable(args.asar);
  if (!args.helper) {
    throw new Error('install 需要 --helper <编译产出的 neko_cursor_helper.exe 路径>，见 compile.bat');
  }

  const backupPath = args.asar + BACKUP_SUFFIX;
  if (shouldRebackup(args.asar, backupPath)) {
    backupAsar(args.asar, backupPath);
  } else {
    console.log(`[install] 备份无需更新，沿用 -> ${backupPath}`);
  }

  const work = path.join(path.dirname(args.asar), '.asar-patch-' + Date.now());
  fs.mkdirSync(work, { recursive: true });
  try {
    const asar = await loadAsar();
    console.log(`[install] 解包 asar -> ${work}`);
    asar.extractAll(args.asar, work);

    const target = path.join(work, TARGET_FILE_IN_ASAR);
    const original = fs.readFileSync(target, 'utf8');
    const patched = buildPatchedSource(original);
    const needsRepack = (patched !== original);

    if (needsRepack) {
      fs.writeFileSync(target, patched, 'utf8');
      console.log(`[install] 已应用 patch（${TARGET_FILE_IN_ASAR}）`);

      const outAsar = args.asar + '.new';
      // 清理上次失败可能残留的中间产物，否则 createPackageWithOptions 会直接失败
      if (fs.existsSync(outAsar)) {
        try { fs.unlinkSync(outAsar); } catch (_) {}
      }
      console.log(`[install] 重打包 asar -> ${outAsar}`);
      const unpackDirs = [];
      const gw = path.join(work, 'node_modules', 'get-windows');
      if (fs.existsSync(gw)) unpackDirs.push('**/node_modules/get-windows/**');
      await asar.createPackageWithOptions(work, outAsar, {
        unpackDir: unpackDirs.join('|'),
      });
      atomicReplaceAsar(args.asar, outAsar);
    } else {
      console.log('[install] 当前 asar 已是 patched，无需重打');
    }
    // 无论是否重打，helper 部署都执行一次，便于补救"helper 复制失败/被隔离"场景
    deployHelper(args.helper, args.asar);
  } finally {
    try { cp.execSync(`rmdir /s /q "${work}"`, { stdio: 'ignore', shell: true }); } catch (_) {}
  }
  console.log('[install] ✅ 完成。下次启动 N.E.K.O.exe 即生效。');
}

/**
 * 把 outAsar 替换到 asarPath，失败时回滚。流程：
 *   1) asar -> .old
 *   2) outAsar -> asar
 *   3) 删除 .old
 * 步骤 2 失败时把 .old 还原回 asar（保留 .outAsar 留给调试）。
 */
function atomicReplaceAsar(asarPath, outAsar) {
  const oldAsar = asarPath + '.old';
  // 清理可能存在的旧 .old（不致命）
  if (fs.existsSync(oldAsar)) {
    try { fs.unlinkSync(oldAsar); } catch (_) {}
  }
  // 步骤 1：asar -> .old
  fs.renameSync(asarPath, oldAsar);

  // 步骤 2：.new -> asar；失败立刻回滚
  let step2ok = false;
  try {
    fs.renameSync(outAsar, asarPath);
    step2ok = true;
  } catch (e) {
    // 回滚 .old -> asar
    try {
      fs.renameSync(oldAsar, asarPath);
    } catch (rbErr) {
      throw new Error(`asar 替换失败且回滚失败：${e && e.message}; rollback=${rbErr && rbErr.message}`);
    }
    try { fs.unlinkSync(outAsar); } catch (_) {}
    throw new Error(`asar 替换失败，已回滚：${e && e.message}`);
  }

  // 步骤 3：删除 .old（即使是 .new -> asar 成功，我们也用独立 try 包住，避免异常导致
  // 残留中间状态）
  try {
    fs.unlinkSync(oldAsar);
  } catch (e) {
    // 这里失败不致命——下次 install/rollback 会清理
    console.warn(`[install] 残留 ${oldAsar} 未删除，可手动清理：${e && e.message}`);
  }
  if (step2ok) console.log(`[install] 已就地替换 ${asarPath}`);
}

async function actionRollback(args) {
  const backupPath = args.asar + BACKUP_SUFFIX;
  if (!fs.existsSync(backupPath)) {
    throw new Error(`找不到备份: ${backupPath}`);
  }
  fs.copyFileSync(backupPath, args.asar);
  console.log(`[rollback] 已从 ${backupPath} 还原 -> ${args.asar}`);
  console.log('[rollback] ✅ 完成。建议同时从 resources/bin/ 删除 neko_cursor_helper.exe（如果它没有别的用处）。');
}

async function actionVerify(args) {
  const asar = await loadAsar();
  const buf = asar.extractFile(args.asar, TARGET_FILE_IN_ASAR).toString('utf8');
  const installed = buf.includes(PATCH_MARKER);
  const helperPath = helperDestPath(args.asar);
  const helperPresent = fs.existsSync(helperPath);
  console.log(`[verify] asar : ${args.asar}`);
  console.log(`[verify] patched          : ${installed ? 'YES' : 'NO'}`);
  console.log(`[verify] helper exe       : ${helperPath}`);
  console.log(`[verify] helper installed : ${helperPresent ? 'YES' : 'NO'}`);
  if (installed && helperPresent) {
    console.log('[verify] ✅ 当前已是修复版');
    process.exit(0);
  } else {
    console.log('[verify] ❌ 当前不是修复版（' +
      [!installed && 'asar 未 patch', !helperPresent && 'helper 未部署'].filter(Boolean).join('，') +
      '）');
    process.exit(1);
  }
}

(async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('参数错误:', e.message);
    console.error('用法：node patch-app-asar.js install|rollback|verify [--asar <path>] [--helper <path>]');
    process.exit(2);
  }
  try {
    if (args.mode === 'install') await actionInstall(args);
    else if (args.mode === 'rollback') await actionRollback(args);
    else if (args.mode === 'verify') await actionVerify(args);
  } catch (e) {
    console.error(`[${args.mode}] 失败:`, e.message);
    process.exit(1);
  }
})();
