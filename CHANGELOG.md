# Changelog

## 1.1.0

- **Unified RequestContext, Referrer-Policy & Stage Diagnostics (`tools/request-context.mjs`, `tools/media-source.mjs`)**: Added case-insensitive header merging (`item > perItem > batch > observed`), `Accept` / `Accept-Language` support alongside `Referer` / `Origin` / `User-Agent`, `Referrer-Policy` enforcement (preventing private path/query leakage on auto-observed cross-origin requests while preserving explicit authorized full-URL `Referer`), and granular per-stage diagnostics (`master-playlist`, `variant`, `segment`, `key`, `init`, `mpd`, `mux`, `verification`) with sanitized `sentHeaderNames`.
- **True Quality Availability Probing & Codec/Network Negotiation (`tools/hls-prefetch.mjs`, `tools/dash-manifest.mjs`, `tools/quality-negotiator.mjs`)**: Probes HLS variants via low-traffic 2-byte Range checks (`playlist+range-2b`) to classify `available`, `unavailable` (404/410), `restricted` (401/403/451), and `unknown`; adds `preferCodec` (`av1`/`hevc`/`h264`/`vp9`) and `networkProfile` (`auto`/`high`/`medium`/`low`); automatically falls back past missing 404/410 variants while never bypassing 403/401 access restrictions.
- **Industrial Checkpoint Resume & 2,000-Segment Stress Validation**: Persists structured `checkpoint.json` with recovery telemetry (`completed`, `missing`, `corrupted`, `restored`, `duplicateBytes`, `savedBytes`, `failedSegments`), adds `recover_download`, retries transient CDN HTML error pages on HLS segments before failing cleanly, and verified 2,000-segment 50% interruption resuming 1,000/1,000 segments with zero redundant transfers.
- **Multi-Engine Smart Scheduler, WebM DASH & Adaptive Rate Control (`tools/engine-scheduler.mjs`, `tools/rate-controller.mjs`, `tools/compatibility-policy.mjs`)**: Real executable engine planner with strict non-bypass termination, per-host AIMD concurrency & `429 Retry-After` throttling, WebM (VP9+Opus) static DASH support, CMAF/SRT inspection, and privacy-safe SQLite Compatibility Knowledge Base with 30-day automatic decay.
- **Dedicated Browser Session Serial Lock & Unified Cookie Filtering (`tools/browser-sessions.mjs`, `tools/cookie-store.mjs`)**: Serializes concurrent probes sharing one `browserSessionId` via in-process queue + cross-process lockfile; reports `hasCookies`, `usable`, `diagnosticState`, `lastChallengeAt`; supports in-memory `content` in `import_cookie_file` and consistent `warnings: ["challenge-cookie-ignored"]`.
- **Local Management Center (`/console`) & 6-Client MCP Config Generator (`tools/console/`, `tools/mcp-config-generator.mjs`, `tools/server.mjs`)**: Authenticated loopback-only (`127.0.0.1`) control panel with strict CSP, `X-Frame-Options: DENY`, `HttpOnly; SameSite=Strict` cookie + CSRF checks, live probing, verified quality badges, queue control, runtime health, telemetry, and native config generation for DeepSeek Harness (YAML), Codex (TOML), Claude Code (JSON/CLI), Claude Desktop, Cursor, and Antigravity.
- **Zero-Setup Cross-Platform Packaging & Distribution Kits (`tools/runtime-manager.mjs`, `tools/install-windows.ps1`, `tools/uninstall-windows.ps1`, `tools/start-unix.sh`, `packaging/`)**: User-scoped Windows Setup/Uninstall with atomic rollback (zero PATH pollution, never deletes user videos), macOS/Linux `.tar.gz` release archive & CI verification, upgraded CLI (`--out`, `--headers-json`, `--json-progress`, `--verify`, documented exit codes `0/1/2/3/4/5`), `download_media_batch`, `filenameTemplate`, `conflictAction` (`uniquify|skip|overwrite`), 8+ AI recipes, FAQ, and Winget/Scoop/Homebrew/MCP Registry manifests.

### 简体中文

- **全链路请求头统一、Referrer-Policy 与分阶段诊断**：实现大小写无关的请求头合并（`item > perItem > batch > observed`），新增 `Accept` / `Accept-Language` 支持与 `Referrer-Policy` 策略（自动观察请求跨域自动剥离隐私路径，显式授权 `Referer` 保留完整 URL），并在失败与诊断中精确上报 `master-playlist | variant | segment | key | init | mpd | mux | verification` 阶段、耗时与脱敏 `sentHeaderNames`。
- **真正的画质可用性探测与智能协商**：通过 2 字节 Range 低流量探测将变体准确标记为 `available`、`unavailable`（404/410）、`restricted`（401/403/451）或 `unknown`；新增编码偏好（`av1`/`hevc`/`h264`/`vp9`）与网络档位（`low`/`medium`/`high`）；高画质资源缺失（404）自动回退至已验证可用档，访问控制拒绝（403）严格终止不绕过。
- **工业级 `checkpoint.json` 断点续传与 2,000 分片压测**：持久化恢复统计（`savedBytes`、`corrupted`、`restored`、`failedSegments`），新增 `recover_download` 工具，分片瞬时 HTML 错误页支持有限重试并准确区分非媒体错误与解密失败；实测 2,000 分片 50% 中断恢复零重复下载复用 1,000 片。
- **多引擎智能调度、WebM DASH 与自适应并发控制**：新增可执行多引擎调度器（`engine-scheduler.mjs`）、按主机 AIMD 并发与 429 退避控制器（`rate-controller.mjs`）、WebM（VP9+Opus）静态 DASH、CMAF/SRT 容器校验与隐私安全的 30 天自动衰减网站兼容性知识库。
- **专用隔离浏览器会话串行锁与统一 Cookie 过滤**：同一 `browserSessionId` 并发探测自动串行排队并跨进程加锁，避免互相踢出；状态接口新增 `hasCookies`、`usable`、`diagnosticState` 与 `lastChallengeAt`；`import_cookie_file` 支持内存文本导入并返回统一的 `challenge-cookie-ignored` 告警。
- **独立本机管理中心（`/console`）与 6 大 MCP 客户端配置生成器**：新增仅限 127.0.0.1 配对码认证的现代深浅双色中英文管理中心（严格 CSP、防 CSRF、100% 真实后端接口），支持画质验证、队列控制、组件健康、实时遥测，并一键生成 DeepSeek Harness / Codex / Claude Code / Claude Desktop / Cursor / Antigravity 原生配置。
- **跨平台安装交付与分发套件**：新增 Windows 一键用户态安装/卸载脚本（原子回滚、不污染 PATH、绝不删除用户视频）、macOS/Linux `.tar.gz` 发行包与多系统 CI、增强版 CLI（`--out`、`--headers-json`、`--json-progress`、`--verify` 与 `0/1/2/3/4/5` 退出码）、`download_media_batch`、命名模板与冲突策略、8+ AI 实战手册及 Winget/Scoop/Homebrew/MCP Registry 分发清单。

## 1.0.0

- **Unified Request Context & HLS Header Consistency (`tools/request-context.mjs`)**: Consistent `Referer`, `Origin`, and `User-Agent` propagation across Master Playlist, Media Playlist, init segments, media segments, byte ranges, separate audio and subtitle tracks, authorized AES-128 keys, retries, checkpoint resumes, bounded refreshes, and FFmpeg fallback (including host+port scoped `-cookies`), with strict cross-origin `Cookie` / `Authorization` isolation and accurate HTTP 403 phase reporting.
- **Binary Media Content Identification (`tools/media-inspector.mjs`)**: Content-first container validation for MPEG-TS (including 1-packet, ID3v2-prefixed, M2TS, and verified custom-wrapped TS), fMP4/ISOBMFF, WebVTT subtitles, and AES-128 encrypted segments behind nonstandard URL extensions (`.jpeg`, `.jpg`, `.png`, extensionless) or misleading MIME types. Strictly rejects real images, HTML/JSON/XML error responses, corrupted segments, and DRM containers.
- **SHA-256 Verified Resumable Downloads & Authorized URL Refresh**: Fault-tolerant checkpointing with per-segment/part SHA-256 verification across HLS, static DASH, and HTTP Range transfers. Survives hard process termination (`SIGKILL`), network drops, companion restarts, MCP client disconnects, and signed URL refreshes; detects and selectively re-downloads corrupted parts; supports HLS subtitle staging and 1,000-segment VOD transfers.
- **Expanded `probe_page` & Dedicated Isolated Browser Sessions (`tools/browser-sessions.mjs`, `tools/edge-session.mjs`)**: Added `userAgent`, `browser`, `browserBinary`, `profileMode: "dedicated"`, `browserSessionId`, `networkMode`, `proxy`, and `timeoutBudget` with clean CDP shutdown and status/reset controls (`get_browser_session_status`) while never touching system browser profiles.
- **Smart Quality Negotiation, Batch Queue & DSH MCP Suite**: Added `quality-negotiator.mjs` (`best`, `max`, `auto`, `lowest`, height caps, `exact:HEIGHT`, bitrate/size budgets, SDR/HDR preference), `download_best_media`, `get_version` (with stale-process mismatch detection), `get_capabilities`, `get_engine_capabilities`, `get_effective_settings`, `get_task_report`, `verify_download`, `pause_download`, `resume_download`, single-item `cancel_download({ id, itemIndex })`, `diagnose_probe`, `diagnose_download`, generalized identifier extraction (`idPattern`, `urlTemplate`, `previewOnly`, `deduplicate`), optional Streamlink adapter, unified Netscape/Header `import_cookie_file` + CLI `--cookie-file`, and richer JSONL progress.
- **Complete Test Sandbox Isolation & CI Gate (`tests/test-sandbox.mjs`)**: Dynamic settings/output path resolution and `VIDEOSAVE_TEST_SANDBOX` confinement with automated real-download-directory immutability assertions across all tests and CI.
- **Extension UI Polish & Official Product Website (`site/`)**: Refined visual hierarchy across all 5 themes, companion version mismatch indicators, bilingual DSH integration guides, and an independent GitHub Pages product website powered by live repository JSON reports.

### 简体中文

- **统一请求上下文与 HLS 请求头全链路一致性（`tools/request-context.mjs`）**：在 Master/Media 清单、初始化分片、普通分片、Byte-Range、独立音轨、字幕轨、授权 AES-128 密钥、重试、断点续传、合法刷新及 FFmpeg 回退（修复非默认端口 `-cookies` 域匹配）中一致传递 `Referer`、`Origin`、`User-Agent`，同时严格禁止跨域泄露 `Cookie` 与 `Authorization`，访问被拒时准确报告拒绝阶段。
- **统一二进制媒体内容识别（`tools/media-inspector.mjs`）**：不依赖 URL 后缀（`.jpeg`/`.jpg`/`.png`/无后缀）与 MIME，按字节结构识别 MPEG-TS（含单包、ID3 前缀、M2TS、合法自定义前缀）、fMP4/ISOBMFF、WebVTT 字幕及 AES-128 解密内容；严格拒绝真实图片、HTML/JSON/XML 错误页、损坏分片与 DRM 容器。
- **SHA-256 校验断点续传与合法临时链接刷新**：覆盖 HLS、静态 DASH 与 HTTP Range 的分片级 SHA-256 校验断点续传，通过 25%/50%/90% 强制终止、断网、服务重启、单分片损坏篡改检测、清单变更与千分片压力测试；临时签名过期刷新可复用已完成分片。
- **完善 `probe_page` 与 VideoSave 专用隔离浏览器会话**：新增 `userAgent`、`browser`、`browserBinary`、`profileMode: "dedicated"`、`browserSessionId`、`networkMode`、`proxy`、`timeoutBudget` 与 `get_browser_session_status`，绝不读取系统浏览器隐私数据。
- **智能画质协商、完整串行批量队列与 DSH 专用 MCP 工具集**：新增 `download_best_media`、`get_version`（含旧版进程漂移检测）、`get_capabilities`、`get_engine_capabilities`、`get_effective_settings`、`get_task_report`、`verify_download`、`pause_download`、`resume_download`、单项取消 `cancel_download({ id, itemIndex })`、`diagnose_probe`、`diagnose_download`、通用媒体标识提取与预览确认、统一 Netscape/Header `import_cookie_file` 及增强版 CLI JSONL 进度输出。
- **测试环境彻底沙箱隔离与 CI 强制门禁**：修复静态导入锁死真实 `settings.sqlite` 导致写入用户真实下载目录的问题，所有测试运行于 `.ots/tmp/videosave-tests/` 独立沙箱并执行真实下载目录前后零变更断言。
- **扩展界面精修与独立 GitHub Pages 官网（`site/`）**：优化 5 套主题视觉质感与伴侣版本不一致提醒，新增中英双语 DSH 指南与直接读取真实仓库 JSON 报告的产品官网。

## 1.0.0-rc.2

- Accept single-segment HLS VOD and report whether an access denial came from a playlist, segment or key. Test all three explicit media headers through a master playlist and variant, then verify decoded audio and video from MPEG-TS segments with nonstandard filenames.
- Accept recognized Bilibili and YouTube video page URLs directly in standalone MCP and the CLI. Expose platform download targets in the tool schema and return sanitized CDN status codes when an extractor fails.
- Keep downloads from disposable Chromium profiles and packaged MCP smoke tests in temporary directories. Packaged smoke tests now set their own SQLite path.

### 简体中文

- 支持只有一个分片的 HLS 点播。媒体访问被拒绝时，报告问题发生在清单、分片还是密钥阶段。回归测试核对三种请求头，并校验非标准后缀分片合并后的实际音视频内容。
- 独立 MCP 和命令行可直接接收已识别的 B 站、YouTube 视频页链接。探测工具公开平台下载目标的结构，下载失败时保留脱敏后的 CDN 状态码。
- 临时 Chromium 配置和发行包验收都使用临时下载目录。发行包验收单独创建 SQLite。

## 1.0.0-rc.1

- Allow approved browser playback to supply public HTTPS CDN candidates to managed MCP. Additional origins require exact same-player evidence. Keep observed signed URLs and playback credentials inside the approved session.
- Stage supported clear static DASH before local muxing. Select a video representation and preserve eligible alternate audio and optional external subtitles. Use the native path for local prefetch, with a bounded legacy fallback for selected public manifests.
- Report the failed Chromium startup phase and retry an early connection failure once. Expose Fast, Balanced, Deep, Maximum and Adaptive probe options, retaining the legacy Standard argument and default.
- Show the actual transfer engine and elapsed time in batch progress. Managed MCP adds `get_engine_capabilities` and `get_task_report`. Candidate eligibility reflects the current client's download permission.
- Package the release candidate as portable Windows and developer extension ZIPs. Browser build `0.99.0.1` sorts between the current stable version and `1.0.0`.
- See the [compatibility results](docs/compatibility-report.zh-CN.md), [authorization and format limits](docs/mcp.md), and [security changes](docs/v1-security.md).

### 简体中文

- 托管 MCP 可以使用用户授权的浏览器播放证据下载公网 HTTPS CDN 媒体。关联来源按播放器和具体请求授权，签名地址和会话凭据保留在本机授权流程中。
- 原生静态 DASH 支持选画质、多音轨、独立文本字幕和并行暂存。动态 DASH、跨任务续传和部分复杂多 Period 清单仍待支持。
- 探测增加 Fast、Balanced、Deep、Maximum 和 Adaptive。Chromium 导航前的连接失败可重试一次。托管 MCP 可查询可用引擎，并返回当前任务实际使用的引擎、耗时及校验结果。
- 桌面便携包与三个浏览器开发包附 SHA-256 和 CycloneDX SBOM。浏览器版本为 `0.99.0.1`。安装步骤和已知限制见[安装文档](docs/install.md)与[兼容性实测](docs/compatibility-report.zh-CN.md)。

## 0.10.0

- Add **AI & MCP** settings with individually scoped local clients and credential-free stdio configuration generation.
- Share a user-approved current-tab snapshot and use candidate IDs to queue same-origin media. Grants have a short expiry and can be revoked.
- Add opt-in, temporary browser login sharing for observed same-origin direct media. Managed requests reject redirects and keep cookies out of tool results and persisted settings.
- Accept a site-specific cookie header or Netscape file for a temporary approval. Optionally limit any authorization to one download batch.
- Stage eligible public same-origin HLS, report probe diagnostics, and recheck completed files on disk through managed MCP.
- Recover additional sources from observed public same-origin player JSON in Edge, Chrome, and Firefox.
- Recheck an empty media panel within a bounded window for players attached to open Shadow DOM after loading.
- Apply website settings to managed downloads. Add batch ownership, download limits and an optional activity log with retention and export controls.
- Report site authorization status, candidate eligibility and observed download size without requesting media again.
- Add hour-long and browser-session grants, inherited website download defaults, batch-size limits, minimum known duration and preview filtering.
- Pause and resume queued items, or reapprove failed sources to retry them. Audit records can be filtered by client and outcome.
- Configure direct, environment or unauthenticated HTTP proxy routing for the companion, with a restart pending indicator and connection check.
- Exercise Edge and Chrome login approval, denied access, redirect rejection, dual-track output and same-URL reload revocation through MCP in CI.
- Stage MPEG-TS HLS segments with nonstandard extensions after validating their contents. Resume interrupted transfers from completed parts, track missing indices and optionally retain completed parts.
- Queue serial batches through MCP and HTTP, resolve page links or explicit reference codes when their turn starts, and reuse existing outputs from matching requests.
- Report HLS variants and free-space errors, try the next quality when a variant playlist is missing, and re-probe a public player once after explicit stream expiry.
- Add a local CLI with JSON Lines progress, a single-origin cookie file and a media request User-Agent.
- Add Advanced and Full Access presets, standing approvals for selected site groups, optional private batch history, and explicit reset and revocation controls.
- Update standing browser grants with observed media, preserve IDs for unchanged candidates, and select or download a clear recommendation with managed MCP.
- Require each standing client to opt into unattended downloads. Revoke shared login access when its cookie state changes, including before the first media observation.
- Stage public same-origin AES-128 HLS VOD with validated key length, while preserving managed resource boundaries and DRM diagnostics.
- Replay the observed same-origin playback context for approved managed media and give pending site requests a sanitized access diagnostic.
- Add bounded Maximum Compatibility probing, optional local strategy learning, and rule import, export, and reset controls.
- Recognize FLV sources declared in structured page data and extend compatibility coverage across browser and MCP paths.

## 0.9.0

- Combine visible player evidence, media request MIME, open Shadow DOM, public source metadata and adaptive manifests.
- Refresh the browser panel when players, sources or observed responses change. Group alternate qualities and suppress manifest initialization fragments.
- Recheck an empty panel once for players that attach open Shadow DOM after the initial scan. Group observed DASH fragments with their manifest and distinguish fragment-only playback from a page with no player.
- Give HTTP and MCP consumers candidate evidence, confidence and legal next actions. Recognize DRM and site access restrictions when the observable evidence identifies them.
- Export a diagnostic report through a local allowlist and back up, import or reset browser preferences.
- Produce portable Windows, Chromium, Firefox and experimental Android archives with SHA-256 checksums and a software bill of materials.
- Add cross-browser, packaging and local service security checks. See the [compatibility report](docs/compatibility-report.zh-CN.md) and [HLS benchmarks](docs/hls-benchmark.zh-CN.md) for measurements, source data and failures.

## 0.8.1

Added the Windows portable setup flow, adaptive prefetch, MCP batch waiting and failure details, headers and checkpoint-based recovery.
