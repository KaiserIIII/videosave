# VideoSave v1.1.0 Product Launch & Community Copy Kit

> Note: All copy below uses strictly verified engineering facts and real test outputs. Do not publish automatically without maintainer review and approval.

---

## 1. GitHub Release / Hacker News / Reddit (English)

**Title:** VideoSave v1.1.0 — Open-source, zero-npm local media downloader, management center, and native MCP server for AI agents

**Summary:**
VideoSave is an MIT-licensed, local-first browser extension + companion downloader + native MCP server built with zero third-party npm dependencies (Node.js 24 built-ins + vanilla browser ESM).

**What's new in v1.1.0:**
- **Unified RequestContext & Stage Diagnostics**: Consistent case-insensitive header merging (`Referer`, `Origin`, `User-Agent`, `Accept`, `Accept-Language`), `Referrer-Policy` enforcement, strict cross-origin cookie isolation, and granular stage diagnostics (`master-playlist`, `variant`, `segment`, `key`, `init`, `mpd`, `mux`, `verification`).
- **True Quality Availability Probing**: 2-byte Range probing (`playlist+range-2b`) distinguishes `available`, `unavailable` (404), and `restricted` (403) variants; smart negotiation supports codec preference (`av1`/`hevc`/`h264`/`vp9`), HDR/SDR preference, bitrate/size budgets, and network profiles.
- **Industrial Checkpoint Resume (`checkpoint.json`)**: Cross-process SHA-256 segment verification, corrupted-part selective retry, authorized token-refresh checkpoint reuse, and 2,000-segment interrupt/resume verification (restoring 1,000/1,000 completed segments with zero duplicate transfers).
- **Local Management Center (`/console`)**: Authenticated loopback-only (`127.0.0.1`) control panel with live probing, verified quality badges, queue control, runtime component health, telemetry, and a 6-client MCP config generator (DeepSeek Harness, Codex, Claude Code, Claude Desktop, Cursor, Antigravity).
- **Cross-Platform Delivery**: One-click Windows Setup/Uninstall scripts (zero PATH pollution), Unix launcher (`tools/start-unix.sh`), WebM VP9+Opus DASH support, CycloneDX SBOM, SHA-256 checksums, and GitHub provenance attestations.

**Repo:** https://github.com/KaiserIIII/videosave  
**Website:** https://kaiseriiii.github.io/videosave/

---

## 2. V2EX / B站 / 开源社区 / 个人博客（中文）

**标题：** 开源零依赖的本地媒体下载工具 + AI 原生 MCP 服务：VideoSave v1.1.0 发布

**正文要点：**
VideoSave 是一款 MIT 开源、本地优先（零遥测、零云中转、零第三方 npm 依赖）的浏览器媒体探测与高速下载工具，同时提供独立的本机管理中心和原生 MCP 接口，支持 DeepSeek Harness、Codex、Claude Code/Desktop、Cursor、Antigravity 等 AI 客户端直接编排合法媒体下载任务。

**核心亮点：**
1. **开箱即用**：Windows 一键安装与启动自动拉取并校验 SHA-256 固定的 Node.js 24、FFmpeg 8.1.2 与 yt-dlp，不污染系统 PATH；提供 macOS / Linux 启动脚本与 `.tar.gz` 发行包。
2. **全链路请求头统一与非标准分片识别**：基于真实二进制结构识别 `.jpeg`/`.png`/无后缀 TS、fMP4、CMAF、ID3-TS、AES-128 解密分片，严格隔离跨域 Cookie。
3. **真正可用画质探测**：2 字节 Range 探测区分 `available / unavailable / restricted`，支持编码、HDR/SDR、体积预算与网络档位协商。
4. **工业级断点续传**：`checkpoint.json` + 分片 SHA-256 校验，实测 2,000 分片 50% 中断恢复直接复用 1,000 片（零重复下载），授权链接过期刷新后无缝续传。
5. **独立本机管理中心**：访问 `http://127.0.0.1:8765/console`（仅本机配对码认证），提供画质探测、队列控制、实时遥测、隔离会话与 6 大 AI 客户端配置一键生成。
6. **严守边界与透明证据**：不绕过 DRM 或反机器人挑战，不读取系统浏览器密码与全量 Cookie，所有测试与兼容性报告均公开可复现。

**项目主页：** https://github.com/KaiserIIII/videosave  
**产品官网：** https://kaiseriiii.github.io/videosave/

---

## 3. Short Social Post / 朋友圈 / MCP 社区简版
> 开源了 VideoSave v1.1.0：零 npm 依赖、本地优先的浏览器视频探测 + 多连接 HLS/DASH 断点续传下载器 + 本机管理中心 + 原生 MCP 服务（支持 DeepSeek Harness / Codex / Claude / Cursor / Antigravity）。带完整 CycloneDX SBOM 与可复现测试报告：https://github.com/KaiserIIII/videosave
