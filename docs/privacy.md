# VideoSave privacy policy

VideoSave processes media information in the browser and, when configured, in a companion running on your computer. VideoSave has no telemetry or analytics service. It stores settings and download state locally.

## Browser extension

- VideoSave examines media elements and public playback configuration in tabs you inspect. With automatic scanning enabled, it listens for playback and page changes while the panel is open. Its background listener holds recent media response metadata per tab in browser session storage. This can include media URLs, response types and filenames.
- Local extension storage keeps user preferences, download records and the optional companion pairing code. Download records can include source URLs and filenames. The extension uses the browser to retrieve media from its source or request media work from the paired companion.
- **Export detection diagnostics** creates a JSON file when you choose it. The file is written locally and contains detection codes, counts, media types, and optional resolution. It omits browsing URLs, page text, cookies, credentials and signed URL parameters. You decide whether to share it.

## Companion and MCP

- The companion uses a temporary Chromium profile for page inspection. Explicit cookies supplied to the local HTTP or MCP interface are held during the task. VideoSave does not import your main browser’s cookies. Cookie handling differs by transfer engine. Native HTTP prefetch sends explicit cookies only to the matching origin.
- The companion stores local settings, a pairing code when local pairing is enabled, and recent batches in SQLite. Local history can contain output paths, titles, times and error codes. SQLite is stored in the current user’s application data directory by default.
- MCP may return media URLs, page metadata and local output paths to your client. Consult the client’s own privacy policy before allowing it to send those details onward.
- The Windows launcher can contact dependency distribution sites to obtain verified tooling. Media probes and downloads contact the selected sites and their media hosts, subject to your network and proxy settings. The update link opens GitHub Releases when you select it.
- To remove extension settings and its local history, remove the extension. Companion state is independent of the extension. You can stop the companion and remove its state directory to clear local preferences and history. This does not affect already downloaded files stored elsewhere.

## Browser permissions

| Permission | Use |
| --- | --- |
| HTTP and HTTPS site access, `webRequest` | Observe media responses and retrieve media sources across player hosts and frames. |
| `activeTab`, `scripting` | Inspect media elements and playback events in a tab selected for scanning. |
| `storage` | Save preferences and queue information and track recent media observations per session. |
| `downloads`, `alarms` | Dispatch and resume eligible desktop downloads and maintain queue progress. |
| `offscreen` | Complete compatible Chromium HLS downloads using an extension document. |

The experimental Android package omits the desktop `downloads` and `offscreen` permissions.

## 中文

VideoSave 在浏览器和已配对的本机服务中处理媒体信息。扩展会读取播放器及媒体响应，把近期观测结果保存在浏览器会话中，并在本机保存设置、下载队列与配对码。启动器下载必要组件，探测和下载会访问媒体站点。VideoSave 不上传遥测。诊断文件仅在主动导出时写入本机，文件包含错误代码和类型等字段，不含媒体地址、页面文字、Cookie 或签名参数。MCP 客户端可以收到媒体地址、页面元数据和本机文件路径，请按客户端的隐私设置处理。

If you have a privacy-related security report, use the private reporting process. [Security policy](../SECURITY.md)
