# VideoSave AI Agent 与 CLI 实战手册（8+ 可直接复制模板）

以下全部示例均基于 `VideoSave v1.1.0` 真实 MCP 工具与 CLI 参数，仅面向合法授权媒体。VideoSave 绝不绕过 DRM、付费墙或反机器人挑战。

---

## 模板 1 — 一次调用完成探测、最高已验证画质选择、下载与 FFprobe 核验
```json
{
  "tool": "download_best_media",
  "arguments": {
    "url": "https://example.org/watch/lecture-01",
    "quality": "best",
    "format": "mp4",
    "verify": true,
    "waitTimeoutMs": 60000
  }
}
```

## 模板 2 — 媒体标识严格串行批量下载（去重 + 命名模板 + 重名跳过）
```json
{
  "tool": "download_media_batch",
  "arguments": {
    "items": [
      { "kind": "id", "id": "EP-001" },
      { "kind": "id", "id": "EP-002" },
      { "kind": "id", "id": "EP-003" }
    ],
    "urlTemplate": "https://example.org/watch/{id}",
    "concurrency": 1,
    "continueOnError": true,
    "deduplicate": true,
    "conflictAction": "skip",
    "filenameTemplate": "{id}_{title}_{height}p",
    "perItem": {
      "quality": "best",
      "format": "mp4",
      "headers": {
        "Referer": "https://example.org/",
        "Origin": "https://example.org"
      }
    },
    "verify": true
  }
}
```

## 模板 3 — 列表页提取标识 → 预览去重 → 确认后串行下载
```json
// 1. 提取可见文本与结构化 JSON 中的标识（自动拒绝灾难回溯正则）
{
  "tool": "probe_page",
  "arguments": {
    "url": "https://example.org/catalog",
    "harvestCodes": true,
    "idPattern": "[A-Z]{2,6}-\\d{2,5}",
    "urlTemplate": "https://example.org/watch/{id}"
  }
}
// 2. 干跑预览（previewOnly: true 不启动下载）
{
  "tool": "start_batch",
  "arguments": {
    "items": [{ "kind": "id", "id": "EP-001" }, { "kind": "id", "id": "EP-002" }],
    "urlTemplate": "https://example.org/watch/{id}",
    "deduplicate": true,
    "previewOnly": true
  }
}
```

## 模板 4 — 403 / 失败阶段诊断（脱敏头名 + 分阶段耗时）
```json
{ "tool": "diagnose_download", "arguments": { "id": "<batch-id>" } }
```
返回具体失败阶段（`master-playlist | variant | segment | key | init | mpd | mux | verification`）、HTTP 状态码、实际引擎、脱敏后的 `sentHeaderNames` 与可执行下一步建议。

## 模板 5 — 临时授权链接过期自动刷新并复用检查点分片
```json
{
  "tool": "start_download",
  "arguments": {
    "items": [{ "kind": "stream", "url": "https://cdn.example.org/hls/master.m3u8?token=short", "title": "Keynote" }],
    "headers": { "Referer": "https://example.org/watch/keynote", "Origin": "https://example.org", "User-Agent": "Mozilla/5.0" },
    "refresh": { "pageUrl": "https://example.org/watch/keynote", "maxRefreshes": 2 },
    "resume": true
  }
}
```

## 模板 6 — 专用隔离浏览器会话登录与跨进程复用
VideoSave 拒绝导入挑战 Cookie（如 `cf_clearance`），也绝不读取系统浏览器配置目录。正确路径：
```json
// 1. 首次使用有头专用配置，由用户正常登录或完成页面交互
{
  "tool": "probe_page",
  "arguments": {
    "url": "https://member.example.org/video/1",
    "mode": "headed",
    "profileMode": "dedicated",
    "browserSessionId": "member-site",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  }
}
// 2. 检查会话状态（确认 usable: true, hasCookies: true, blockers: []）
{ "tool": "get_browser_session_status", "arguments": { "browserSessionId": "member-site" } }
```
同一 `browserSessionId` 自动通过跨进程锁与内存队列串行执行，避免多并发抢占同一目录。

## 模板 7 — 成品 FFprobe 核验与任务汇总报告
```json
{ "tool": "verify_download", "arguments": { "id": "<batch-id>", "durationToleranceSec": 1.0 } }
{ "tool": "get_task_report", "arguments": { "id": "<batch-id>" } }
```

## 模板 8 — 检查点核查与中断续传
```json
{ "tool": "recover_download", "arguments": { "id": "<batch-id>" } }
```
查看 `checkpoint.json` 中的 `total / completed / missing / corrupted / savedBytes / failedSegments`，随后重新提交原下载请求即可只补缺片与坏片。

## 模板 9 — CLI 长时间后台任务（摆脱 MCP 超时 + 结构化退出码）
```bash
node tools/media-cli.mjs \
  --out ./downloads \
  --cookie-file ./cookies.txt \
  --headers-json '{"Referer":"https://example.org/watch/1","Origin":"https://example.org"}' \
  --quality best --conflict-action skip --filename-template "{title}_{height}p" \
  --connections 8 --resume --json-progress --verify \
  "https://cdn.example.org/hls/master.m3u8"
```
退出码语义：`0` 成功 / `1` 通用错误 / `2` 参数无效 / `3` 磁盘空间不足 / `4` 需人工登录或挑战 / `5` 媒体或画质不可用。
