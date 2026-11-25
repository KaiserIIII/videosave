# Open Media Toolkit

面向 Edge 的免费视频下载扩展，采用 MIT 许可证。可从当前标签页发现视频、复制地址、下载直链，也可通过本机服务合并 HLS 和 DASH 流。扩展和下载服务无需账号、订阅或用量配额。下载在本机执行。

## 安装扩展

1. 下载并解压仓库源码。
2. 打开 `edge://extensions`，启用开发人员模式，选择**加载解压缩的扩展**。
3. 选中源码中的 `extension` 目录。打开视频页并开始播放，点击工具栏里的 Open Media Toolkit。也可以直接在面板里粘贴媒体链接。

弹窗的「视频」页显示封面、标题、时长和分辨率，可批量入队，也可打开单条视频的下载选项、改名或复制链接。「下载」页显示进度和保存文件，可暂停、继续、取消或重试。扩展发起的所有下载使用 Edge 的下载目录，开启「每次询问保存位置」后可逐次选择。

「设置」可选择原画或最高画质、MP4 / MKV、M4A / MP3 和 1–2 个并发任务。支持音视频合并、单独提取视频或音频，以及保存成两个文件。画质会优先选用源文件已有的合适轨道，必要时向下转换。字幕设置可保留源内嵌的兼容字幕轨。分片流、转换和分离需要本机服务。播放器中的 DRM 视频和没有可访问媒体地址的流无法通过该扩展保存。

## 本机下载与 AI

需要 Windows、Edge、Node.js 24，以及 PATH 中的 `ffmpeg` 和 `ffprobe`。可通过 `EDGE_BIN`、`FFMPEG_BIN`、`FFPROBE_BIN` 覆盖程序位置。

```powershell
node tools/server.mjs
```

将终端打印的本机地址和配对码填入扩展的**设置**。可在启动前用 PowerShell 环境变量 `MEDIA_TOOLKIT_TOKEN` 设置固定配对码，用 `OUT_DIR` 设置下载目录，用 `PORT` 设置端口。服务只监听 `127.0.0.1`，默认端口 8765，两个下载任务可同时执行。

HTTP 使用 `Authorization: Bearer <配对码>`。POST 请求正文使用 JSON。

| 方法和路径 | 用途 |
| --- | --- |
| GET `/api/health` | 版本、输出目录和健康状态 |
| POST `/api/probe` | 传入 `{url,cookie?}` 探测页面及媒体信息 |
| POST `/api/queue` | 传入 `{items:[{kind,url,title?,format?,mode?,quality?,audioFormat?,subtitles?}],concurrency?,maxSec?,cookie?}` 创建批次 |
| GET `/api/batch/<id>` | 当前进度和日志 |
| GET `/api/batch/<id>/events` | SSE 实时进度 |
| POST `/api/cancel` | 传入 `{id}` 取消批次 |
| GET `/api/recent` | 最近保存的视频 |
| POST `/api/open` | 传入 `{file?}` 打开目录或定位文件 |

队列项的 `kind` 可用 `page` 或 `stream`，`format` 可用 `mp4` 或 `mkv`，`mode` 可用 `combined`、`video`、`audio` 或 `separate`。`quality` 以画面高度（像素）指定上限，`audioFormat` 可用 `m4a` 或 `mp3`，`subtitles` 可设为 `true` 以保留兼容的内嵌字幕。直接调用 HTTP 或 MCP 时，文件保存到本机服务的 `OUT_DIR`。`concurrency` 支持 1 或 2。省略 `maxSec` 时下载完整流。只有在需要时才传 Cookie，本机服务会将其限定到对应的媒体主机。

MCP 通过 stdio 运行，客户端配置中将路径换成本机的绝对路径。

```json
{
  "mcpServers": {
    "open-media-toolkit": {
      "command": "node",
      "args": ["C:/path/to/open-media-toolkit/tools/mcp-server.mjs"]
    }
  }
}
```

可用工具为 `probe_page`、`start_download`、`get_progress`、`list_downloads` 和 `open_file`。MCP 可独立启动，无需先启动 HTTP 服务。在同一 MCP 会话中查询其创建的批次。

## 测试

```powershell
node --test tests/media.test.mjs
node tests/smoke.mjs
```

集成测试用临时 Edge profile、临时输出目录和公开媒体验证面板、真实下载、HTTP 和 MCP。
