# DeepSeek Harness (DSH) 接入与升级指南

VideoSave `1.0.0` 已直接使用本机安装的 DeepSeek Harness (DSH) MCP 客户端运行时（`@deepseek-ai/dsh-mcp-client` 与 `AjvJsonSchemaValidator`）完成端到端发行包验收。

## 1. 从旧版本升级（排查旧版 `v0.9.0` 进程漂移）

真实使用中最常见的问题是：源码或发行包已更新，但 DSH 的 `cordis.patch.yml` 仍指向旧目录（例如 `media-toolkit/open-media` 中的 `v0.9.0`），或后台旧的 `mcp-server.mjs` 进程未重启。

### 第一步：核验 DSH 实际连接的版本
调用 MCP 工具 `get_version`：
- 若 `tools/list` 中没有 `get_version`，说明 DSH 仍连接在 `v0.9.0` 或 `v0.10.0`。
- 若返回 `versionMismatch: true`，说明运行中的 Node 进程与磁盘安装包版本不一致，请重启 MCP 服务或重启 DSH。

### 第二步：将 DSH 指向解压后的 `VideoSave-1.0.0` 发行包
解压 `VideoSave-1.0.0.zip`（例如到 `C:\VideoSave\VideoSave-1.0.0`），运行一次 `.\Start VideoSave.cmd -McpConfig` 准备 Node.js 与 FFmpeg，再将 DSH 的 `cordis.patch.yml` 指向新版 `tools/mcp-server.mjs`：

```yaml
- insert:
    - id: videosave-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: videosave
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'C:\VideoSave\VideoSave-1.0.0\tools\mcp-server.mjs'
        toolCallTimeoutMs: 300000
        startupTimeoutMs: 60000
        failOnStartupError: true
```

如需与桌面伴侣（`Start VideoSave.cmd`）共享实时下载队列，添加以下环境变量（无需明文配对码）：

```yaml
- insert:
    - id: videosave-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: videosave
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'C:\VideoSave\VideoSave-1.0.0\tools\mcp-server.mjs'
        env:
          MEDIA_TOOLKIT_URL: 'http://127.0.0.1:8765'
          MEDIA_TOOLKIT_LOCAL_PAIRING: '1'
        toolCallTimeoutMs: 300000
        startupTimeoutMs: 60000
        failOnStartupError: true
```

## 2. 推荐 DSH 工作流

### 一键最高画质下载并校验（`download_best_media`）
```json
{
  "url": "https://media.example/watch/101",
  "quality": "best",
  "verify": true
}
```
自动完成页面探测、唯一正片选择、最高可用真实清晰度协商、完整请求头下载及 FFprobe 音视频核验。

### 专用隔离浏览器会话（合法登录复用）
VideoSave 禁止直接接管系统浏览器目录或读取系统全部 Cookie。请使用专用隔离会话：
1. `probe_page({ url: "https://site.example/login", mode: "headed", profileMode: "dedicated", browserSessionId: "my-site", userAgent: "..." })`
2. 在专用隔离窗口中正常登录。
3. 后续探测复用 `profileMode: "dedicated", browserSessionId: "my-site"`；可通过 `get_browser_session_status` 查询状态或重置会话。

### Netscape `cookies.txt` 与 Header Cookie 文件导入
调用 `import_cookie_file({ filePath, origin, ttlMinutes: 30 })`：
- 同时支持标准 7 列制表符 Netscape `cookies.txt`（含 `#HttpOnly_`、域名/路径/Secure/过期时间）与单行 `Cookie:` 头格式。
- 自动拒绝 `cf_clearance` 等反机器人挑战类 Cookie。
- 仅保存在本机内存中，返回 `cookieSessionId`，绝不向 AI 回显 Cookie 明文，且严格禁止跨域传递。

### 串行批量队列与通用标识提取
- 在 `probe_page` 中开启 `harvestCodes: true`，可自定义安全的 `idPattern` 与 `urlTemplate`（如 `https://site.example/watch/{id}`）。
- 在 `start_batch` 中可先传入 `previewOnly: true, deduplicate: true` 预览去重后的清单，确认后再以 `concurrency: 1` 串行执行，并配合 `pause_download`、`resume_download`、`cancel_download({ id, itemIndex })`、`verify_download`、`diagnose_download` 管理全流程。
