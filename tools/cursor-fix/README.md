# N.E.K.O 光标卡顿修复（cursor-fix）

> 适用版本：**v0.9.0.1_win**（`S:\Relax_event\N.E.K.O_v0.9.0.1_win\resources\app.asar`）
>
> 状态（2026-09-11 更新）：**已定位真根因并部署第二版修复**。第一版（PowerShell→Win32 helper）是误诊，见下。PR #3092 review 提出的工具链问题已于 2026-09-11 逐条加固，详见文末「PR #3092 review 后续加固」。
>
> ⚠️ **部署目标纠正（2026-09-11 晚）**：本机真正在运行的实例是 **Steam 版**
> `Z:\SteamLibrary\steamapps\common\n.e.k.o\`，不是上面那个 v0.9.0.1_win 安装。
> 之前所有 asar / static 补丁都打在**没被运行**的 S: 安装上，所以线上症状一直
> 复现。Steam 版现已按下方「Steam 版部署记录」完成部署。

## Steam 版部署记录（2026-09-11）

目标：`Z:\SteamLibrary\steamapps\common\n.e.k.o\`（Steam app_id 4099310，
用户数据根 `%LOCALAPPDATA%\N.E.K.O`）。

### 为什么不能照搬 S: 安装的文件

Steam build ≠ v0.9.0.1_win build。两版 `package.json` 版本串相同，但：

| 文件 | 两版差异 |
|---|---|
| `src/preload/entries/legacy-pet.js` | Steam 版多 `requestWindowsGraphicsCaptureFallback` / `restartWindowsGraphicsCaptureFallback`（WGC 兼容模式） |
| `src/preload/bridges/desktop-capture-bridge.js` | 同上 |
| `src/main.js` | 515 行差异（Steam 渠道特有逻辑） |
| `src/main/screen-capture-ipc.js` | **除本补丁外逐字节相同**（可直接换） |

结论：**除 `screen-capture-ipc.js` 外必须手工移植 hunk**，整文件覆盖会抹掉 WGC。

### asar 侧（4 文件）

与「第二版修复 / asar 侧」表格相同，逐个手工落到位：

- `screen-capture-ipc.js`：直接取自 S: 安装的已打补丁版本（已验证等价）。
- `desktop-capture-bridge.js` / `legacy-pet.js`：只改
  `captureSourceAsDataUrl` / `captureSourceWithoutNeko` 两行签名，保留 WGC 方法。
- `main.js`：`chatDisplayMediaHandler` 内 `getSources` 加
  `thumbnailSize: { width: 1, height: 1 }`。

### 前端侧（3 文件）

`resources\bin\static\app\{app-proactive,app-screen,app-websocket}.js` 整文件覆盖为
仓库 HEAD 版本。已核实 Steam 版这三个文件 == 仓库 `69e0196d`，且
`git diff --stat 69e0196d..HEAD -- static/` 只动这三个文件 → 直接覆盖无基线漂移。

### 验证

- 重打包后 asar entry 列表与原版**完全一致**（3475 条）；`app.asar.unpacked`
  35 文件逐字节一致；改动文件回读一致；`node --check` 全过。
- 离线行为测试（真模块 + 桩 Electron 依赖，13 项全过）：不传 options 仍走
  1920×1080 PNG（旧行为不变）；`format:'jpeg'` 走 bounded 1280×720 + `toJPEG`；
  屏幕源 jpeg **只枚举一次**（跳过两遍原生采样）；脏值被 clamp；`format:'png'`
  保持旧路径。

### 备份与回滚

```bash
# 退出 N.E.K.O 后：
cd /z/SteamLibrary/steamapps/common/n.e.k.o/resources
cp app.asar.bak-20260911-steam app.asar
cd bin/static/app
for f in app-proactive app-screen app-websocket; do cp $f.js.bak-20260911-steam $f.js; done
```

其他备份：`app.asar.prepatch-20260911-steam`（重命名保留的原版）。

> **Steam 会校验/更新游戏文件**（本次 Steam 在 09-11 13:10 刚覆盖过整个安装）。
> 任何一次 Steam 更新都会冲掉这些补丁，需要重新部署。

## 诊断结论（2026-09-10 修正）

### 第一版误诊：PowerShell spawn

第一版认为卡顿来自 `system-cursor-visibility-service.js` spawn PowerShell 调 `SetSystemCursor` 的开销。该补丁已成功安装，但：

- 问题依旧，症状分毫不差；
- `%APPDATA%\N.E.K.O\neko-electron-debug.log`（11.9MB）里 **0 条** helper 启动日志——helper 在症状发生期间**从未运行过**。

结论：PowerShell 路径与本症状无关（它解决的是另一个真实但独立的开销问题，补丁无害，保留）。

### 真根因：desktopCapturer 全分辨率抓帧 + PNG 编码 × WH_MOUSE_LL 全局鼠标钩子

症状：鼠标"DPI 骤降"（指针移动死区/掉帧）约 3 秒后恢复；打字时输入延迟 1–2 秒；**模型主动回复前几秒高概率触发**（≈ Phase 2 `request_fresh_screenshot(timeout=3.0)`）；开聊天框后更频繁。

机制链：

1. Pet 窗口 `setIgnoreMouseEvents(true, {forward: true})` 会在本进程安装 **WH_MOUSE_LL 全局低级鼠标钩子**（Electron 41.10.1 `native_window_views_win.cc` 确认），钩子回调派发在 **Electron 主进程 UI 线程**的消息循环上。
2. 主线程一旦卡住，全局鼠标输入事件在系统层排队——所有应用里鼠标都卡（症状是系统级的，与 GPU 无关，用户的怀疑正确）。
3. 主动视觉（proactive vision）截图路径 `capture-source-as-dataurl` IPC：
   - **屏幕源**：两遍枚举，第二遍按**整屏物理分辨率**（如 2560×1440）抓帧；
   - **窗口源**：枚举**全部窗口**，每个都抓 1080p 缩略图；
   - 然后 `thumbnail.toDataURL()` 做 **PNG 无损编码**（PNG 编码比 JPEG 慢一个数量级）。
4. 以上全在主线程。日志证实**每次主动搭话 episode 都伴随 Vision 截图**——与症状触发时机完全吻合。
5. 次要源：`chatDisplayMediaHandler`（getDisplayMedia 兜底）枚举全部窗口 + 默认 150×150 缩略图，proactive 无缓存流重建流时也会踩到。
6. 加重项：主进程出 PNG 后，renderer 还要用 canvas 把 PNG 重编码成 JPEG（后端只收 JPEG）——两端都白付一次编码。

## 第二版修复（2026-09-10，已部署）

核心思路：**视觉链路只需要模型可读的 720p JPEG，不需要全分辨率 PNG**。全部改动 opt-in（不传 options 行为不变），截图按钮/编辑器的无损 PNG 预览路径不受影响。

### asar 侧（4 个文件）

| 文件 | 改动 |
|---|---|
| `src/main/screen-capture-ipc.js` | `capture-source-as-dataurl` 接受 `(event, sourceId, options)`；`options.format==='jpeg'` 时：窗口源 bounded（≤1280×720）单遍枚举，屏幕源跳过两遍原生采样直接单遍 bounded 枚举，`toJPEG(quality)` 编码。新增 `isJpegCaptureRequest` / `boundedThumbnailSizeFromOptions` / `encodeThumbnailWithOptions` helpers |
| `src/preload/bridges/desktop-capture-bridge.js` | `captureSourceAsDataUrl` / `captureSourceWithoutNeko` 透传 options |
| `src/preload/entries/legacy-pet.js` | 同上（legacy Pet 桥） |
| `src/main.js` | `chatDisplayMediaHandler` 的 `getSources` 加 `thumbnailSize: {width:1, height:1}`（只消费 source.id，缩略图纯属浪费） |

### 前端侧（仓库源码 + 已装 static 各一份）

| 文件 | 改动 |
|---|---|
| `static/app/app-proactive.js` | 两处热路径调用（`sendOneProactiveVisionFrame` 原生捕获、`captureProactiveChatScreenshotWithSource` 策略 0b）传 `{format:'jpeg', maxWidth:1280, maxHeight:720, quality:80}` |

JPEG 由 `normalizeNativeCaptureDataUrlForStream` 直接 passthrough（app-screen.js:685），消除 renderer 端 canvas 重编码；后端 `compress_screenshot` 用 Pillow 解码，格式无关。旧 asar（桥忽略第二参数）自动退回 PNG+canvas 转码，向后兼容。

### 未改动（有意）

- `capture-source-without-neko` / galgame OCR 的 `capture_bridge_request`：OCR 对分辨率敏感，且非本症状来源。若日后 OCR 高频截图也造成卡顿，可给它们加同样的 jpeg 选项。
- 截图按钮/编辑器预览路径（app-buttons.js / app-screen.js）：用户主动操作，PNG 清晰度是产品刻意的。

## 部署状态（本机）

- 已装 asar：`S:\Relax_event\N.E.K.O_v0.9.0.1_win\resources\app.asar`（2026-09-10 11:42 替换，含第一版 helper 补丁 + 第二版 jpeg 修复）
- asar 备份（回滚点）：`resources\app.asar.bak-20260910-prejpegfix`（= 仅含第一版补丁的版本）
- 已装前端：`resources\bin\static\app\app-proactive.js`（基于 v0.9.0.1 基线单独打补丁，**不是**整文件覆盖仓库 HEAD——两者有 315 行基线差异）
- 前端备份：`resources\bin\static\app\app-proactive.js.bak-20260910`
- 重打包工作目录：`C:\Users\Mr.hancard\AppData\Local\Temp\nek_asar`（解包→修改→`npx @electron/asar pack --unpack-dir "**/node_modules/get-windows/**"`）

### 回滚

```bash
# 退出 N.E.K.O 后：
cd /s/Relax_event/N.E.K.O_v0.9.0.1_win/resources
cp app.asar.bak-20260910-prejpegfix app.asar
cp bin/static/app/app-proactive.js.bak-20260910 bin/static/app/app-proactive.js
```

## 第一版补丁（PowerShell→Win32 helper）处置

- 补丁仍在已装 asar 内，**无害但未被使用**（症状期间 helper 从未启动）。
- `neko_cursor_helper.exe`（`resources/bin/`）保留——它修的"spawn PowerShell 开销"是真实存在的另一个小问题（对话框打开时的 CPU 尖峰），留待上游评估。
- 第一版文件（`neko_cursor_helper.c` / `compile.bat` / `patch-app-asar.js` / `system-cursor-visibility-service.js.patch`）保留在本目录供审计；`patch-app-asar.js install` 对已打补丁的 asar 会跳过重打包，但仍会（重新）部署 helper，便于补救"helper 被删/被杀软隔离"的情况。

## PR #3092 review 后续加固（2026-09-11）

上游 PR #3092（第一版工具包）被 bot 审出 19 条问题，逐条复核后按下列方式处置。**本目录的所有文件都对应"第一版"工具链**——它是仓库内的审计/兜底手段，真根因（截图主线程编码）已在第二版修复并由前端源码承担。

### 已修（P1）

| 位置 | 问题 | 修法 |
|---|---|---|
| `patch-app-asar.js` | helper 部署目标由 `--helper` 的父目录推导，传了会把 exe 自我复制 | 部署目标**恒**取 `path.dirname(asar)/bin/`，不再受 `--helper` 影响 |
| `patch-app-asar.js` | `.original_backup` 存在即沿用，升级后会拿旧版备份回滚 | 改为 sha256 校验：当前 asar 未打补丁且与备份不一致 → 视为上游升级，重新备份 |
| `patch-app-asar.js` | 重打包替换非原子，第二步失败会让 app 无法启动 | `asar→.old`、`.new→asar` 两步，第二步失败立即回滚 `.old→asar` |
| `patch-app-asar.js` | 已 patched 时提前 return，跳过 helper 部署 | 重排控制流：无论是否重打都执行 helper 部署；且 `PATCH_MARKER` 判定提前到 `ORIGINAL_SNIPPET` 之前（否则已 patched 的 asar 重跑会误报） |
| `compile.bat` | `cd` 到作者机器绝对路径，他人无法编译 | 改为 `pushd "%~dp0"`（脚本所在目录） |
| `compile.bat` | `dir` 覆盖 cl 的 `%ERRORLEVEL%`，坏了也报成功 | 用 `CL_EXIT` 先存 cl 退出码，诊断后再 `exit /b %CL_EXIT%` |
| `native-system-cursor.js` | `restore()` 失败仍清空状态 → 光标可能永久透明 | 仅 `SPI_SETCURSORS` 成功时清空；失败保留映射供下次重试 |
| `native-system-cursor.js` | `SetSystemCursor` 失败时句柄泄漏 | 失败分支调用 `DestroyCursor` 回收 |
| `native-system-cursor.js` | 部分 ID 失败后 `hide()` 因非空而短路，失败 ID 永不重试 | 改为按 ID 跟踪（`Map`）+ 记录失败集，下次 `hide()` 重试失败 ID |
| `system-cursor-ipc.js` | 只在 `will-quit`/`before-quit` 恢复；renderer 关闭/崩溃后光标永久隐藏 | 监听 `web-contents-created` → 每个 webContents 挂 `destroyed` / `render-process-gone`，按 webContents 维度引用计数，归零才真正 `restore` |
| `system-cursor-preload.js` | wrapper 先调 `original()` 再发 IPC，旧 PowerShell 广播路径仍被触发 | 彻底替换原函数（不再调用 `original`），避免第二条 PowerShell 路径 |

### 已修（P2）

| 位置 | 问题 | 修法 |
|---|---|---|
| `tools/asar_tools/package.json` | `@electron/asar@4.x` 要求 Node ≥22.12，与主工程 `^20.19` 兼容性差 | 降到 `^3.2.10`（实测锁到 3.4.1，`engines.node>=10.12`）；并用到的 `extractAll`/`extractFile`/`createPackageWithOptions` API 在 3.x 全部存在 |

### 未改（有理由）

- **多窗口 hide lease 的完整实现**：属于 N.E.K.O.-PC 主进程侧契约（见 `docs/design/yui-guide-system-cursor-hiding.md`）。本目录的 `system-cursor-ipc.js` 已给出引用计数 + lifecycle 的参考实现，但桌面宿主需自行按窗口/session 落地；仓库内这些文件是**集成示例**，不会被运行时加载。

### 行为变化（重要）

- `install` **必须**显式传 `--helper <编译产出的 exe>`，不再有"默认去 resources/bin 找"的隐式行为（那个默认在全新安装时必然失败）。
- `verify` 的 helper 路径同样恒取 `asar 同级 bin/`。
- **rollback 需要一份真实的"未打补丁"`.original_backup`**。本机当前**没有**这样一份原始 asar（历史上第一次 apply 时没有保存干净原件），所以本机 rollback 目前不可用；如需可回滚基线，请用安装包重建一份未打补丁的 asar，或从上游 v0.9.0.1_win 原版复制。脚本在缺备份时会**报错退出**（而非静默还原一个已打补丁的 asar）。
- 这些改动经沙箱端到端验证：全新安装 → verify → 幂等重装（不覆盖原件备份）→ 删 helper 重装修复 → rollback 还原 → 模拟升级后重新备份，全部通过。

## 上游修复建议（N.E.K.O.-PC 私有仓库）

1. `screen-capture-ipc.js` 的 `capture-source-as-dataurl` 加 options 支持（本目录第二版改法可直接移植）。
2. 主动视觉调用点传 jpeg 选项（`app-proactive.js` 两处）。
3. `chatDisplayMediaHandler` 的 getSources 加 1×1 thumbnailSize。
4. 更根本的：评估 Pet 窗口是否必须 `forward:true` 的鼠标穿透钩子；若必须，确保主线程任何长任务（抓图/编码）都不在其上执行（如 `desktopCapturer` 之外的 GDI/DXGI 抓帧线程化）。

## 故障排查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| 鼠标仍然卡顿 | 还有别的抓图调用点 / 钩子另有来源 | 看 `%APPDATA%\N.E.K.O\neko-electron-debug.log`，症状发生时刻前后搜 `Vision` / `screenshot` / `getSources`；任务管理器看 N.E.K.O.exe 主进程线程 CPU |
| 主动视觉截图变糊 | jpeg 720p 不够模型读屏 | 调大 `maxWidth/maxHeight`（如 1600×900），quality 85 |
| 主动视觉截图失败 | 源失效 / Linux portal | 日志搜 `主进程直接捕获失败`；`maybeClearSourceOnNotFound` 会自动清源回退流路径 |
| asar 损坏闪退 | unpack 规则破坏 | 确认 `app.asar.unpacked\node_modules\get-windows\` 完整；回滚备份 |
