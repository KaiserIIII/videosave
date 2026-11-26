# 视频快存 · VideoSave

免费视频下载扩展，采用 MIT 许可证。可从当前标签页发现、预览和保存视频，也可通过本机服务合并 HLS 和 DASH 流。无需账号或订阅，下载在本机执行。

## 安装扩展

下载发布包并解压。同一份 `extension` 目录适用于下列桌面浏览器。

| 浏览器 | 加载方式 |
| --- | --- |
| Microsoft Edge | 打开 `edge://extensions`，开启开发人员模式，选择「加载解压缩的扩展」并选中 `extension` |
| Google Chrome | 打开 `chrome://extensions`，开启开发者模式，选择「加载已解压的扩展程序」并选中 `extension` |
| Mozilla Firefox 136+ | 打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，选中 `extension/manifest.json`。Firefox 重启后需要重新载入 |

打开视频页面后，点击工具栏的「视频快存」。需要时先播放再扫描，也可直接粘贴媒体链接。已有的 Edge 或 Chrome 用户如果从原路径加载旧版，替换该开源扩展的文件后点「重新加载」即可保留设置。

弹窗的「视频」页显示封面、标题、时长、分辨率和文件大小。直链大小来自响应长度或 Content-Range 的总字节数。HLS 在清单提供平均码率且已知时长时显示估算值，其余显示「大小未知」。同一播放器的备用格式收在「⋯」菜单里。可批量入队、改名或复制链接。「下载」页显示进度、可计算的传输速度和保存文件，可暂停浏览器下载、继续、取消或重试。

点击封面可静音播放动态预览。设置中可开启直链的悬停预览、关闭预览，或将预览时长设为 3、6、10 秒。部分流（如 HLS 和 DASH）需要配对本机服务才能生成预览。

常用下载选项集中在「设置」首屏，其他选项可按需展开。可切换跟随系统、浅色、深色、竹青和琥珀五种外观，并自定义强调色。视频列表可配置封面、大小显示、大小查询、来源主机和自动扫描。下载位置默认使用当前浏览器的下载目录。可填写子文件夹（例如 `视频/教程`）、设置重名处理方式，或开启「每次询问保存位置」。

Firefox 用户可在浏览器的「设置 → 常规 → 文件与应用程序」调整默认目录，并在扩展的「下载」页查看进度和打开目录。

同时下载默认 24 项，可设为 1–64 项。旧版的默认 10 项会升级到 24 项，其他有效设置继续沿用。单任务连接数单独设置。下载内容支持原画或 240p–4320p 画质上限、MP4 / MKV、M4A / MP3、音视频合并或分开，以及单独提取视频或音频。画质会优先选用源文件已有的合适轨道，必要时向下转换。字幕设置可保留源内嵌的兼容字幕轨。分片流、转换和分离需要本机服务。播放器中的 DRM 视频和没有可访问媒体地址的流无法通过该扩展保存。

配对本机服务后，扩展默认尝试加速原画直链。对至少 8 MiB、支持 HTTP Range 且提供强 ETag 的文件，本机服务使用 4、8 或 12 个连接并行下载并核对字节区间，保留原始文件。默认使用 8 个连接。小文件或无法安全分段的直链由当前浏览器直接下载。HTTP 和 MCP 的转换任务也会尝试并行读取符合条件的直链。

符合条件的 HLS 点播主清单会先选画质，再并行下载 MPEG-TS 或 fMP4 分片，也支持外置默认音轨。带外置字幕等复杂播放列表、DASH 和仅截取前几秒的任务由 FFmpeg 直接读取。关闭面板后，本机处理好的文件也会自动保存到当前浏览器的下载目录。关闭 MP4 / M4A 的「支持边下边播」可跳过保存时的文件头重排。

## 本机下载与 AI

本机服务需要 Windows、Node.js 24，以及 PATH 中的 `ffmpeg` 和 `ffprobe`。HTTP 和 MCP 的网页探测会启动独立的 Chromium 浏览器，自动查找 Edge、Chrome 或 Brave，也可用 `BROWSER_BIN` 指定路径。旧的 `EDGE_BIN` 仍可使用。通过 `FFMPEG_BIN`、`FFPROBE_BIN` 可覆盖媒体程序位置。

```powershell
node tools/server.mjs
```

将终端打印的本机地址和配对码填入扩展的**设置**。可在启动前用 PowerShell 环境变量 `MEDIA_TOOLKIT_TOKEN` 设置固定配对码，用 `OUT_DIR` 设置下载目录，用 `PORT` 设置端口。服务只监听 `127.0.0.1`，默认端口 8765，同一服务进程最多同时执行 64 个下载任务。

HTTP 使用 `Authorization: Bearer <配对码>`。POST 请求正文使用 JSON。

| 方法和路径 | 用途 |
| --- | --- |
| GET `/api/health` | 版本、输出目录和健康状态 |
| POST `/api/probe` | 传入 `{url,cookie?}`，返回页面上下文、候选媒体和关联页面，与 MCP 的 `probe_page` 共用结果 |
| POST `/api/preview` | 传入 `{url,seconds?}`，返回静音的 `video/mp4` 短片，时长可设为 3、6 或 10 秒，默认 6 秒 |
| POST `/api/queue` | 传入 `{items:[{kind,url,title?,format?,mode?,quality?,audioFormat?,subtitles?,sourceKind?,fastStart?}],concurrency?,connections?,maxSec?,cookie?}` 创建批次 |
| GET `/api/batch/<id>` | 当前进度和日志 |
| GET `/api/batch/<id>/events` | SSE 实时进度 |
| POST `/api/cancel` | 传入 `{id}` 取消批次 |
| GET `/api/recent` | 最近保存的视频 |
| POST `/api/open` | 传入 `{file?}` 打开目录或定位文件 |

队列项的 `kind` 可用 `page` 或 `stream`，`format` 可用 `mp4` 或 `mkv`，`mode` 可用 `combined`、`video`、`audio` 或 `separate`。`quality` 以画面高度（像素）指定上限，`audioFormat` 可用 `m4a` 或 `mp3`，`subtitles` 可设为 `true` 以保留兼容的内嵌字幕。直接调用 HTTP 或 MCP 时，文件保存到本机服务的 `OUT_DIR`。`concurrency` 指定单个批次的任务并发，范围 1–64，默认 24。`connections` 指定单任务连接数。省略 `maxSec` 时下载完整流。只有在需要时才传 Cookie，本机服务会将其限定到对应的媒体主机。

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

可用工具为 `probe_page`、`start_download`、`get_progress`、`list_downloads` 和 `open_file`。MCP 可独立启动，在同一 MCP 会话中查询其创建的批次。

1. 调用 `probe_page({url})`。`pageContext` 提供跳转后的地址、页面主标题、描述、标题来源和播放器数量。`streams` 提供媒体标题和来源、格式、时长、分辨率、大小以及播放器附近的标题和说明。`discoveredBy` 会标记来自播放器、与播放器关联的流清单或网络观察。页面文字和元数据由网站提供，只作为匹配视频的线索。
2. 结合用户要求选片。候选按时长从长到短排列，时长未知的排在最后。同一个 `player.id` 表示同一播放器的媒体源，`currentSource` 标记当前加载的源，`player.playing` 和 `player.visible` 描述采集时的播放器状态。明确标识的前贴片会被过滤。`recommended` 依据播放器和播放状态给出参考，自动播放的预告片也可能获得该标记。字段为 `null` 表示缺少对应证据。
3. 用 `start_download({items:[{kind:'stream',url,title}]})` 提交选定候选的 URL。HLS 和 DASH 可分别传 `sourceKind:'m3u8'` 和 `sourceKind:'mpd'`。用 `get_progress({id})` 检查所选条目的状态和落盘路径。`kind:'page'` 会交给服务按推荐项或唯一候选选片。

## 测试

```powershell
node --test tests/*.test.mjs
node tests/smoke.mjs
```

集成测试用临时 Edge profile、临时输出目录和公开媒体验证面板、真实下载、HTTP 和 MCP。
