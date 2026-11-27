# VideoSave DSH 真实用户反馈追踪表

> 本追踪表逐项核实、复现、修复并重新验收了 DeepSeek Harness (DSH) 在真实使用中反馈的全部 12 类问题。
> 原始问题反馈源自 `v0.9.0` 实测；本轮完整核对了本地进程/DSH 配置、Codex `v1.0.0-rc.2` 成果及本次接管后的全链路修复、131 项自动化回归与 **真实 DSH 运行时（`@deepseek-ai/dsh-mcp-client` + `AjvJsonSchemaValidator`）连接解压后的 `VideoSave-1.0.0.zip` 发行包 17/17 实测验收**。

## 环境漂移排查结论（Section 01）

| 检查项 | 接管前实际状态 | 发现的问题与处理结论 |
| --- | --- | --- |
| GitHub 正式版 | `v0.10.0` (`60dc366`) | 已基于最新开发分支继续推进至 `v1.0.0` |
| Codex 开发分支 | `product/videosave-1.0` (`8fa2b6c`, `v1.0.0-rc.2`) | 完整保留 Codex 已完成成果，在此之上逐项补齐全部剩余缺口 |
| DSH 实际加载的 MCP 路径 | `<DSH_WORKSPACE>\mcp-bundles\videosave-mcp\cordis.patch.yml` → `...\open-media\tools\mcp-server.mjs` | **严重版本漂移**：历史运行中的 DSH 进程实际连接的是旧版 **`v0.9.0`** 目录，完全未加载 `v0.10.0` 或新版工具 Schema。现已新增 `get_version` 实时版本与旧进程漂移检测，并提供 [DSH 升级指南](dsh-guide.zh-CN.md) 与多客户端配置生成器。 |
| 真实下载目录污染 | `%LOCALAPPDATA%\VideoSave\settings.sqlite` 中配置的真实下载目录 | **部分修复（待独立复测）**：此前测试仍写入用户真实 `outDir`（共落盘 118 个历史测试视频文件），先前报告中的 `Delta = 0` 属拿已经被污染的基线进行比对，不能作为隔离证明。现已新增运行时强制 `--sandbox` 模式与 `VIDEOSAVE_NO_USER_SETTINGS=1`（强制将 `outDir` 与 `settings.sqlite` 覆写到临时沙箱目录、禁止读取用户 `settings.sqlite`），并要求测试/冒烟/验收报告直接打印 `ACTUAL_WRITE_PATHS`（实际写入路径），待用户独立复测通过后方可关闭。 |

## 12 项 DSH 真实反馈逐项追踪与最终验收

| 编号 | DSH 反馈问题 | 旧版 (`v0.9.0`) 表现 | Codex `v1.0.0-rc.2` 状态 | 相关源码 | 本轮修复方案 | 自动化测试 | 真实 DSH 发行包验收结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DSH-01 | HLS 预取阶段返回 HTTP 403，而正常获授权请求可以成功 | 无法准确区分拒绝阶段，含字幕/扩展标签清单被拒绝回退 | 部分修复：支持 `hlsPhase`，但无统一请求上下文，含字幕/I-Frame/Discontinuity 清单仍被拒绝回退 | `tools/request-context.mjs`, `tools/hls-prefetch.mjs`, `extension/hls.mjs` | 建立统一 `RequestContext`，扩展主/子清单合法标签支持（字幕轨、I-Frame、Discontinuity 等），精准上报 `playlist`/`segment`/`key` 阶段拒绝且不绕过访问限制 | `tests/request-context.test.mjs`, `tests/download-recovery.test.mjs` | **通过** (`06-nonstandard-hls-headers`, `16-diagnose-403-failure`) |
| DSH-02 | Referer、Origin、User-Agent 未完整传递至媒体分片请求 | 预取或回退链路请求头丢失/不一致；FFmpeg `-cookies` 非默认端口失效 | 部分修复：refresh 丢弃显式 headers，缺少全链路与跨域 Cookie 隔离实测 | `tools/request-context.mjs`, `tools/hls-prefetch.mjs`, `tools/media-downloads.mjs`, `tools/media-source.mjs`, `tools/dash-prefetch.mjs` | 统一 HLS/Range/DASH/刷新/FFmpeg 回退走 `RequestContext`；修复 FFmpeg `-cookies` `domain=${url.host}` 域匹配；严格禁止 Cookie/Authorization 跨域泄露 | `tests/request-context.test.mjs` (双源服务器全阶段实测) | **通过** (`06-nonstandard-hls-headers`, 4/4 请求头完全匹配) |
| DSH-03 | 非标准扩展名媒体分片导致 FFmpeg 返回 `Invalid data found` | `parseManifest` 拒绝非 `.ts` 分片，回退 FFmpeg 报错 | 部分修复：仅对未加密 TS 检查 0/188/376 字节，不支持 1 包 TS、ID3 前缀、非标准后缀 fMP4/init、加密非标准后缀及自定义前缀封装 | `tools/media-inspector.mjs`, `extension/hls.mjs`, `extension/hls-download.mjs`, `tools/hls-prefetch.mjs` | 新增统一二进制媒体内容识别模块 `tools/media-inspector.mjs`，按真实容器字节识别 TS/ID3-TS/M2TS/自定义前缀 TS/fMP4/AES-128 解密明文/WebVTT，严格拒绝真图片/HTML/JSON/XML/损坏分片/DRM | `tests/media-inspector.test.mjs` (含 FFprobe 与 decoded `streamhash` 校验) | **通过** (`06-nonstandard-hls-headers`: `.jpeg`/`.png`/无后缀 3.03s 校验通过) |
| DSH-04 | 下载失败后的备用引擎未能解决问题 | 预取失败回退 FFmpeg 仍失败 | 部分修复：仍易触发无谓回退，无 Streamlink 适配器 | `tools/media-downloads.mjs`, `tools/hls-prefetch.mjs`, `tools/streamlink-adapter.mjs` | 扩大原生预取能力；FFmpeg 回退复用统一 `RequestContext`；403/401/451/挑战直接中止不绕过；新增可选 `STREAMLINK_BIN` 适配器并暴露 `get_engine_capabilities` | `tests/request-context.test.mjs`, `tests/batch-queue-and-quality.test.mjs` | **通过** (`03-tool-schemas`, `16-diagnose-403-failure`) |
| DSH-05 | 断点续传缺少完整的真实验收 | 缺故障注入与完整性验证 | 部分修复：无 DASH 持久化续传、无分片 SHA-256 校验、无 25%/50%/90%/损坏分片/千分片压力验收 | `tools/hls-prefetch.mjs`, `tools/dash-prefetch.mjs`, `tools/range-prefetch.mjs`, `tools/media-downloads.mjs` | 为 HLS/DASH/Range 断点增加 SHA-256 校验（自动发现并仅重下单个损坏分片）；完成 25%/50%/90% `SIGKILL`、断网、服务重启、MCP 断连、清单变化、取消清理及 1,000 分片压力测试 | `tests/resume-fault-injection.test.mjs`, `tests/download-recovery.test.mjs` | **通过** (`12-network-drop-interrupt`, `13-mcp-disconnect-resume`, 仅补下缺失分片 `[2]`) |
| DSH-06 | 临时媒体地址过期后的自动刷新能力不足 | 无刷新机制 | 部分修复：刷新清空 headers/cookies，且不复用已完成 checkpoint 分片 | `tools/media-downloads.mjs`, `tools/hls-prefetch.mjs` | 有界刷新（最多 2 次）保留原授权 headers 与同源 Cookie；规范化清单签名支持刷新后无缝复用已完成分片；校验媒体身份一致；明确区分 403/登录失效与 410 过期 | `tests/resume-fault-injection.test.mjs` (实测 `tok2` 复用 `0..2` 仅拉取 `3..5`) | **通过** (回归与刷新校验全绿) |
| DSH-07 | `probe_page` 缺少自定义 User-Agent 和安全的独立浏览器会话配置 | 不支持 | **未修复**：`v1.0.0-rc.2` 硬编码拒绝全部会话/UA 参数 | `tools/browser-sessions.mjs`, `tools/edge-session.mjs`, `tools/media-source.mjs`, `tools/media-downloads.mjs`, `tools/mcp-server.mjs` | 完整支持 `userAgent`、`browser`、`browserBinary`、`profileMode:"dedicated"`、`browserSessionId`、`networkMode`、`proxy`、`timeoutBudget` 与 `get_browser_session_status`；CDP 优雅退出刷新 Cookie 且不接触系统浏览器隐私数据 | `tests/probe-browser-options.test.mjs` | **通过** (`08-dedicated-browser-session`: 自定义 UA + 独立登录态跨次复用 + 重置) |
| DSH-08 | 内置串行下载队列不够完善 | 仅 `start_download` | 部分修复：缺独立 MCP 的暂停/恢复、单项取消、去重、`continueOnError` 与完整 `perItem` | `tools/media-downloads.mjs`, `tools/mcp-server.mjs`, `tools/server.mjs` | 补齐 `pause_download`、`resume_download`、单项取消 `cancel_download({id, itemIndex})`、`deduplicate`、`continueOnError`、完整 `perItem` 与重启恢复 | `tests/batch-queue-and-quality.test.mjs` | **通过** (`11-serial-batch-queue`: 预览去重 + 暂停 + 单项取消 + 恢复) |
| DSH-09 | 缺少方便的批量媒体标识提取及处理能力 | 无 | 部分修复：仅硬编码 `[A-Z]{2,6}-\d{2,5}`，不支持自定义正则与预览确认 | `tools/media-source.mjs`, `tools/media-downloads.mjs`, `tools/mcp-server.mjs` | 通用化 ID 提取：支持安全自定义 `idPattern`（防 ReDoS）、通用 `urlTemplate` (`{id}`/`{code}`)、去重与 `previewOnly: true` 列表预览确认 | `tests/batch-queue-and-quality.test.mjs`, `tests/test-isolation-and-security.test.mjs` | **通过** (`11-serial-batch-queue` + 回归测试) |
| DSH-10 | 无法方便地自动选择最高可用画质 | 仅数字高度上限 | 部分修复：仅支持 `"max"`，缺智能策略、DASH qualities 与一键下载工具 | `tools/quality-negotiator.mjs`, `extension/hls.mjs`, `tools/dash-manifest.mjs`, `tools/media-downloads.mjs` | 新增 `quality-negotiator.mjs`（支持 `best`/`max`/`auto`/`lowest`/上限/`exact:HEIGHT`/预算/HDR 偏好/回退策略）与 `download_best_media`，自动 FFprobe 核验成品分辨率 | `tests/batch-queue-and-quality.test.mjs` | **通过** (`05-probe-hls`, `10-auto-best-quality`: 自动选中 320x180 并通过校验) |
| DSH-11 | Cookie 文件导入和 JSON 结构化进度不够完善 | 无 CLI / 无 Netscape 导入 | 部分修复：CLI 不支持 Netscape `cookies.txt`，MCP 无独立 Cookie 导入，缺丰富进度字段 | `tools/cookie-store.mjs`, `tools/media-cli.mjs`, `tools/media-downloads.mjs`, `tools/mcp-server.mjs` | 统一支持 Netscape 7 列与 Header 双格式导入（内存 TTL 会话、拒绝挑战 Cookie、绝不向 AI 回显明文）；丰富 CLI JSONL 与 MCP 结构化进度（`phase`/`engine`/`fallbackReason`/`etaSec`/`verification`） | `tests/batch-queue-and-quality.test.mjs`, `tests/test-isolation-and-security.test.mjs` | **通过** (`07-signed-netscape-cookie`, `14-progress-and-report`, `15-verify-download`) |
| DSH-12 | 自动化测试向用户真实下载目录写入 157 个测试视频文件 | 严重污染真实目录 | **未彻底修复**：`preferences.mjs` 顶层固化 `settingsFile`，导致测试继续向用户真实下载目录落盘 | `tools/preferences.mjs`, `tools/media-downloads.mjs`, `tools/server.mjs`, `tools/mcp-server.mjs`, `tools/media-cli.mjs`, `tools/verify_release.py`, `tests/test-sandbox.mjs`, 全量 `tests/*.mjs` | 新增强制 `--sandbox[=DIR]` 模式与 `VIDEOSAVE_NO_USER_SETTINGS=1` 禁止读取用户 `settings.sqlite`，强制将测试与冒烟的 `outDir` 覆写至临时目录；修复 CLI `--out` 被 `settings.sqlite` 覆盖的问题；冒烟/兼容/验收报告改为直接打印 `ACTUAL_WRITE_PATHS` 实际写入路径，不再用前后基线比对证明干净 | `tests/test-isolation-and-security.test.mjs` + 全量测试与冒烟 | **部分修复**：测试仍写入用户 `outDir`，`Delta=0` 属基线污染；已补齐强制 `--sandbox` 覆写与实际写入路径打印，待用户独立复测验收 |

## 真实用户 `v1.1.0` Release 复测记录（2026-11-27）
- **已由用户独立复测通过**：
  - `VideoSave-1.1.0.zip` SHA-256 与官方发布清单一致，`get_version = 1.1.0`，27 个 MCP 工具就绪。
  - **P0-1 请求头全链路**：用户自建夹具服务器抓包确认 `master -> variant -> segment` 三跳的 `User-Agent`、`Referer`（含完整查询串）、`Origin` 原样透传。
  - **P0-4 非标准分片**：真实 TS 命名为 `seg0.jpeg` 且返回 `content-type: image/jpeg`，`start_download` 成功（`prefetch: true`、`segments 1/1`、`stages` 全 200、输出 320×240 / 4.04s / h264+aac、`qualityNegotiation` 完整）。
- **需修复（已改回「部分修复」）**：
  - **DSH-12 测试隔离**：用户实测指出真实下载目录中留存 118 个测试产物，`Delta = 0` 属拿已污染基线比对。已将本项改回「部分修复」，并新增 `--sandbox` 强制隔离（禁止读取用户 `settings.sqlite`、强制覆写 `outDir` 至临时目录）与实际写入路径报告打印。
- **待外部网络冷却后补验（非工具故障）**：
  - 外部测试站当前按 IP 限流（`curl` 亦返回 403），待冷却后由用户补验 P0-2（1080p→403 / 720p→200 自动降级）、P0-3（真站中断续传）、P0-5（会话复用 `blockers:[]`）。

## 真实 DSH 发行包验收证据
- 原始脱敏报告：[docs/compatibility-data/v1.0.0-dsh-acceptance.json](compatibility-data/v1.0.0-dsh-acceptance.json)
- 验收命令：`node tests/dsh-acceptance.mjs --package=<extracted VideoSave-1.0.0> --output=docs/compatibility-data/v1.0.0-dsh-acceptance.json`
- 结果：**17/17 全部通过（0 失败，总耗时 33.06 秒，25 个 MCP 工具全部通过 DSH `AjvJsonSchemaValidator` 校验，真实下载目录变动 = 0）**。
