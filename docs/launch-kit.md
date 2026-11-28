# VideoSave v1.3.1 Bilingual Launch & Promotion Kit

> Ready-to-use promotional drafts in Chinese and English for owner-approved publication. **Nothing is posted automatically.** All claims strictly reflect verified `v1.3.1` evidence — zero fabricated metrics, zero exaggerated slogans.

---

## 1. GitHub Repository About Metadata (Manual 1-Minute Setup)

Open **https://github.com/KaiserIIII/videosave** → click the gear icon next to **About**:

- **Description**:
  `Local-first, open-source media downloader for browsers, desktop and Android, featuring native Bilibili support, intelligent download engines, resumable transfers and MCP automation.`
- **Website**:
  `https://kaiseriiii.github.io/videosave/`
- **Topics**:
  `video-downloader`, `media-downloader`, `browser-extension`, `bilibili`, `android`, `mcp`, `model-context-protocol`, `hls`, `dash`, `ffmpeg`, `yt-dlp`, `download-manager`, `cross-platform`, `privacy-first`, `ai-agent`

---

## 2. Short Product Pitch (GitHub / Personal Site / WeChat Moments)

### 简体中文（朋友圈 / 个人网站简版）
> 开源、免费、本地优先的跨平台视频下载与 AI 媒体工具 **VideoSave v1.3.1** 正式发布！
> - **内置 Bilibili 原生下载引擎**：无需额外安装 `yt-dlp`，直接粘贴 BV 号、网页链接或 `b23.tv` 短链，自动选择真实画质与音视频无损封装，11/11 真实公网视频（含 34 分钟长片与多 P）通过 FFprobe 与解码实测。
> - **零门槛开箱即用**：Windows 提供免管理员图形化 `Setup.exe` 与纯离线便携包；Linux/macOS 自动校验准备 Node 24 与 FFmpeg；附带免 Root/Termux 的独立 Android APK（Beta，支持静态 DASH 混流与 Bilibili）。
> - **高速可恢复 + 原生 MCP**：支持多连接 HLS/DASH/Range 与 SHA-256 分片级断点续传，原生提供 27 个 MCP 工具无缝接入 DeepSeek Harness (DSH)、Codex、Claude Code 与 Cursor。
> - 零 npm 第三方依赖，零遥测，严守合法边界不绕过 DRM 或付费限制。
>
> 官网与全部实测报告：https://kaiseriiii.github.io/videosave/
> GitHub 开源仓库：https://github.com/KaiserIIII/videosave

### English (Short Pitch)
> **VideoSave v1.3.1** is out — a free, MIT-licensed, local-first media downloader for browsers, desktop, Android (Beta), and AI agents, built with **zero third-party npm dependencies**.
> - **Built-in Native Bilibili Engine** (zero `yt-dlp` required) alongside YouTube, Internet Archive, Wikimedia Commons, and standard HTML5/HLS/DASH streams.
> - **Verified Integrity & Resumable Speed**: SHA-256 per-segment checkpoints, strict container inspection, unified quality negotiation backed by post-FFprobe verification.
> - **Zero-Friction Installers**: Windows non-admin `Setup.exe` & true offline portable ZIP, Linux `.deb` & self-bootstrapping macOS/Linux `.tar.gz`, plus a standalone Java Android APK (Beta).
> - **Native MCP Server (27 tools)** for DeepSeek Harness, Codex, Claude, and Cursor with scoped permissions and cross-origin cookie isolation.
>
> Website & live JSON test reports: https://kaiseriiii.github.io/videosave/
> GitHub: https://github.com/KaiserIIII/videosave

---

## 3. Technical Launch Post (Hacker News — Show HN / Reddit r/opensource & r/selfhosted)

**Title**:
`Show HN: VideoSave v1.3.1 – Local-first media downloader (zero npm deps, browser + desktop + Android Beta + native MCP)`

**Body**:
> Hi HN,
>
> I built **VideoSave** ([https://github.com/KaiserIIII/videosave](https://github.com/KaiserIIII/videosave), MIT license), a local-first media downloader for public and authorized web media with **zero third-party npm dependencies** (pure Node.js 24 stdlib, Manifest V3 WebExtensions, pure-Java Android SDK, and FFmpeg/FFprobe).
>
> **Why build another media downloader?**
> Most workflows either require stitching together a browser extension, CLI flags, cookies, and manual FFmpeg commands, or give AI agents fragile shell wrappers with no structured diagnostics or permission boundaries.
>
> **Engineering highlights in v1.3.1:**
> - **Unified Request Context & Binary Media Sniffing**: Keeps `Referer`/`Origin`/`User-Agent` consistent across Master → Variant → Init → Segment → Key → Resume while strictly isolating `Cookie`/`Authorization` by origin. Validates actual container signatures (MPEG-TS, fMP4, WebM, AES-128 plaintext) instead of trusting `.jpeg`/extensionless URLs.
> - **Native Built-In Bilibili Engine + Public Platform Adapters**: Downloads public Bilibili (`BV...`, multi-P, `b23.tv`), Internet Archive, and Wikimedia Commons natively without requiring `yt-dlp`, plus managed `yt-dlp` for YouTube. Every task reconciles requested vs. selected vs. post-FFprobe actual quality so reports cannot contradict output files.
> - **Verified Resumable Performance**: In controlled 3-round 120s monotonic-PTS HLS benchmarks (full FFprobe + decode verified), VideoSave's native multi-connection HLS engine runs in ~0.76s–0.9s vs. ~1.8s for serial FFmpeg and ~2.3s for `yt-dlp` at matched concurrency, while persisting SHA-256 segment checkpoints across process crashes.
> - **Native MCP Server (27 tools)**: Works standalone or paired with the browser extension's permission control center (scoped origins, current-tab approval, no raw cookie echoing to models).
> - **Standalone Android APK (Beta)**: Pure-Java app (`minSdk 26`, `targetSdk 35`) with XXE-hardened static DASH + `MediaMuxer` muxing, strict RFC 9110 HTTP 416 resume validation, and `Downloads/VideoSave` export — verified live on Android 16 Emulator.
>
> **Honest scope & limitations**: VideoSave strictly refuses DRM, CAPTCHAs, and HTTP 401/403/451 restrictions. The Android APK is currently debug-signed Beta pending release keystore provisioning, macOS builds are unsigned, and every public test report + benchmark JSON is published unmodified on the project website: https://kaiseriiii.github.io/videosave/
>
> Would love feedback on the architecture, MCP schema design, and cross-platform packaging!

---

## 4. 中文社区技术贴（V2EX / B站专栏 / MCP 社区）

**标题**：`开源了一款零 npm 依赖、本地优先的跨平台媒体下载器 VideoSave v1.3.1（内置 Bilibili 原生引擎 + 浏览器扩展 + Android Beta + 27 个 MCP 工具）`

**正文**：
> 大家好，最近把 **VideoSave** 打磨到了 **v1.3.1**，想分享给同样关心本地隐私、下载可靠性和 AI Agent 媒体工作流的朋友。
>
> 1. **核心定位**：开源免费（MIT）、零第三方 npm 依赖、零遥测，严守合规边界（仅面向公开和获授权媒体，绝不绕过 DRM/付费墙/验证码）。
> 2. **Bilibili 开箱即用（免装 yt-dlp）**：内置原生 `bilibili-native` 引擎，支持直接粘贴裸 `BV` 号、网页链接、`b23.tv` 短链与多 P 视频，自动按真实分辨率协商画质（杜绝声明与成片不一致）、并行拉取音视频并由 FFmpeg 无损封装；11 个真实公网测试样本（含 34 分钟长片、HEVC、纯音频提取等）全部通过 FFprobe 与解码实测。
> 3. **多平台与真离线交付**：
>    - Windows 提供免管理员 `Setup.exe`、纯离线便携包（内置校验好的 Node 24 + FFmpeg + yt-dlp，断网可直接启动）及精简便携包；
>    - Linux 提供 `.deb` 与自动校验引导 Node 24 / FFmpeg / yt-dlp 的 `.tar.gz`；macOS 提供一键自举启动脚本；
>    - Android 提供免 Root/Termux 的独立 APK（Beta，内置静态 DASH `MediaMuxer` 混流、严格 HTTP 416 校验与 Bilibili 解析，已在 Android 16 模拟器跑通端到端下载，鸿蒙 4.x 可侧载，纯血鸿蒙 NEXT 暂不支持）。
> 4. **AI Agent 原生 MCP 集成**：提供 27 个标准化 MCP 工具（`download_best_media`、`probe_page`、`start_batch`、`verify_download`、`diagnose_download`、`recover_download` 等），支持 DeepSeek Harness (DSH)、Codex、Claude Code、Cursor 一键生成配置，并已在真实 DSH 运行时通过 21/21 发行包端到端验收。
> 5. **透明可复现的实测数据**：所有兼容性矩阵、公网实测、3 轮公平竞品基准（含同并发对照组）均以原始 JSON 公开在官网，严守实证原则，绝不做无证据的夸大对比宣传。
>
> - 项目官网与实时实测：https://kaiseriiii.github.io/videosave/
> - GitHub 仓库与发行版：https://github.com/KaiserIIII/videosave/releases/latest

---

## 5. Live Demo Script & Verified Screenshot Index

- **Demo Flow (60 seconds)**:
  1. Launch `VideoSave-1.3.1-Setup.exe` (or double-click `Start VideoSave.cmd`) → opens Local Management Center at `http://127.0.0.1:8765/console`.
  2. Paste bare `BV1J4411v7g6` → click **Probe** → displays real verified qualities (`720p`, `480p`, `360p`) → click **Download** → outputs verified MP4 in seconds.
  3. Open **MCP Config** tab → pick DeepSeek Harness / Codex / Claude Code → copy ready-to-use config → call `download_best_media({ "url": "BV1J4411v7g6", "quality": "best", "verify": true })`.
  4. On Android, share a link from any browser to VideoSave → tap probed quality → verified MP4 saved cleanly to `Downloads/VideoSave/`.
- **Real Captured Screenshots in Repository**:
  - Local Management Center (`/console`): `docs/screenshots/console-desktop.png`
  - Official Product Website (Desktop & Mobile): `docs/screenshots/website-desktop.png`, `docs/screenshots/website-mobile.png`
  - Standalone Android App on real Android 16 Emulator: `docs/screenshots/android-home.png`, `docs/screenshots/android-queue.png`
  - Browser Extension & MCP Control Center: `docs/videosave-0.9-detection.png`, `docs/videosave-mcp-control.png`
