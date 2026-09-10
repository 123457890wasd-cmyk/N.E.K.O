# N.E.K.O 光标卡顿修复（cursor-fix）

> 适用版本：**v0.9.0.1_win**（`S:\Relax_event\N.E.K.O_v0.9.0.1_win\resources\app.asar`）
>
> 状态（2026-09-10 更新）：**已定位真根因并部署第二版修复**。第一版（PowerShell→Win32 helper）是误诊，见下。

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
- 第一版文件（`neko_cursor_helper.c` / `compile.bat` / `patch-app-asar.js` / `system-cursor-visibility-service.js.patch`）保留在本目录供审计；`patch-app-asar.js install` 现在会因 PATCH_MARKER 已存在而 no-op。

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
