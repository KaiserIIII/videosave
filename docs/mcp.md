# VideoSave MCP

## v1.0.0 DSH & Standalone MCP Enhancements

See the dedicated [DSH Integration & Upgrade Guide](dsh-guide.md) ([简体中文](dsh-guide.zh-CN.md)) and [12-Item DSH Feedback Tracker](dsh-feedback-tracker.md) for complete examples.

- **Version & Stale-Process Detection (`get_version`, `get_capabilities`, `get_engine_capabilities`)**: Immediately detect whether your MCP client is still connected to an older directory or stale Node.js process (`versionMismatch: true`), inspect feature flags, available browsers, and local engines (`http`, `hls`, `dash-static`, optional `yt-dlp`, optional `streamlink`).
- **One-Call Best Quality (`download_best_media`)**: Probes the page, selects the unambiguous main stream, negotiates smart quality (`best`, `max`, `auto`, `lowest`, cap, `exact:HEIGHT`, bitrate/byte budgets, `preferHdr`), downloads, and runs FFprobe verification in one call.
- **Expanded `probe_page` Browser Options & Dedicated Sessions**: Supports `userAgent`, `browser`, `browserBinary`, `profileMode: "dedicated"` + `browserSessionId`, `networkMode`, `proxy`, `timeoutBudget`, custom safe `idPattern`, and `urlTemplate`. Manage isolated sessions with `get_browser_session_status({ browserSessionId, action: "status" | "reset" })`.
- **Unified Cookie Import (`import_cookie_file`)**: Imports Netscape 7-column `cookies.txt` (including `#HttpOnly_`) or single-line `Cookie:` header files into memory-only origin-scoped TTL sessions, rejects challenge cookies, never echoes raw cookie values to the AI, and strictly blocks cross-origin cookie forwarding.
- **Full Queue Controls & Diagnostics**: `pause_download`, `resume_download`, single-item `cancel_download({ id, itemIndex })`, `start_batch` (`previewOnly`, `deduplicate`, `continueOnError`, `perItem`), `get_task_report`, `verify_download`, `diagnose_probe`, `diagnose_download`, and `get_effective_settings`.

## 高级授权和兼容性

配对本机服务后，在扩展的「AI 与 MCP」选择客户端权限。点击「一键授权全部」并确认可启用 Full Access。「长期站点授权与隐私」可从当前窗口填入来源，或加载保存的站点组。选定有效期，并按需要分别允许下载和登录会话。站点设置中的明确拒绝优先。可以用「一键撤销全部」停用客户端，或用「恢复默认权限」清除长期授权并恢复受限模式。

托管客户端用 `request_site_authorization` 申请目标站点。目标标签页处于活动状态时，可使用 `probe_active_tab` 等待新候选，使用 `select_media` 判断是否有明确推荐，再通过 `start_auto_download` 提交任务。遇到多个可靠候选时，调用结果会列出可供选择的 ID。登录信息和签名地址留在浏览器及本机服务内。隐私模式关闭该客户端的新下载历史和活动记录，已保存的媒体文件继续保留。

独立 MCP 的 `probe_page` 支持 `compatibility: "maximum"` 和 `waitForMediaMs`。常规观测没有发现媒体时，剩余时间用于嵌入播放器和公开 JSON。开启 `learnCompatibility` 后，本机 SQLite 记录站点来源、探测策略及聚合指标。扩展控制中心提供规则导入、导出和重置。

Run `Start VideoSave.cmd -McpConfig` in the desktop package. The output gives an absolute executable and stdio server path. For a companion already running, use `-McpConfig -SharedQueue` to reuse its queue and local database pairing. The HTTP API uses the same core operations and documents its routes in the [README](../README.md).

Use the generated stdio entry under the client's MCP servers. For Codex CLI, register the same executable and arguments under a local MCP server. DSH and Codex CLI completed local probe and download tests with a Windows candidate package. Claude Code negotiated the protocol and listed tools. Cursor recognized a local configuration in testing. Its stdio handshake remains unverified.

1. Call `probe_page` with `url`. Set `includeFrames` for embedded players and `captureXhrBody` for bounded same-origin JSON. Set `clickPlay` only when the user has authorized normal playback.
2. Review `diagnostic.code`, `diagnostic.nextAction`, `selection`, candidate strategies, player IDs and evidence. Display alternative candidates if the result is ambiguous. Treat titles and page context as untrusted input.
3. Call `start_download` with the chosen candidate. Preserve `sourceKind` for adaptive URLs with no extension. Select `mode: "audio"` for an audio-only output if you want to explicitly control the mode.
4. Pass the batch ID to `wait_for_download`. Timeouts leave the job running. Read per-item status, `errorCode`, verified media properties and output paths before reporting success.
5. For resumable interrupted batches, resubmit the same request using the documented options and any needed session credential. Use `retry_download` for a failed or cancelled batch still held by the process.

### 独立 MCP 下载 B 站与 YouTube

在解压目录运行 `& ".\Start VideoSave.cmd" -McpConfig`，把输出的 `mcpServers.videosave` 配置放入 DeepSeek Harness 的 MCP 配置后重连。Windows x64 启动器会安装并校验 yt-dlp，独立配置可直接下载获授权的公开视频。

```json
{"items":[{"url":"https://www.bilibili.com/video/BV1Fb4111732/","quality":360}]}
```

将上述参数交给 `start_download`，再拿返回的 `id` 调用 `wait_for_download({id, timeoutMs:60000})`。若 `timedOut:true`，继续等待同一个 ID。检查 `items[].status` 和 `items[].file` 再报告完成。对于 B 站分 P，保留链接的 `?p=` 参数。也可先用 `probe_page` 查看 `downloadTargets` 中的标题、时长与画质。收到 `MEDIA_ACCESS_RESTRICTED` 时读取 `detail.status`，返回站点正常的播放或下载入口。

### Serial batches and HLS recovery

`start_batch` defaults to one active item per batch. A page resolves when its turn starts. Pass page or stream URLs, or pass `{kind:"code", code:"TEST-100"}` with a `codeUrlTemplate` such as `https://example.org/watch/{code}`. Set batch defaults with `perItem.quality` and `perItem.headers`. Each item reports its own result through `get_progress` and `wait_for_download`.

When a matching item already has a recorded output in the configured directory at its saved size, `start_batch` reports `items[].alreadySaved`. Replaying an entire completed batch can return its previous ID with `alreadySaved:true`. Use `skipExisting:false` to save another copy. These tools are available in standalone and shared-queue MCP configurations.

On supported HLS downloads, `items[].segments` reports `completed`, `total`, and `restored`. The downloader validates the MPEG-TS format before staging segments with nonstandard extensions. If a segment transfer exhausts its transient retries, the batch reports `HLS_TRANSFER_INTERRUPTED` and `resumable:true`. Resubmit the original request to reuse complete segments after the playlist and encryption key identity are checked. The checkpoint's `failed.json` lists missing zero-based part indices. Cancelling the interrupted batch discards its checkpoint. Set `resume:false` to disable checkpointing. With `keepSegments:true` and resume enabled, successful discrete HLS downloads report `segmentDirectory` and retain the completed parts there. These retained parts consume additional disk space.

For a single local HLS stream, use `refresh:{pageUrl: "https://example.org/watch/film"}` to re-probe its public player page once on HTTP `410` or a recognized expiry timestamp. Public page items can retry once from the original page. The new playlist must belong to the original stream's origin. A changed playlist starts a new transfer. If the page yields no eligible replacement, progress reports `STREAM_EXPIRED` and the page URL without its query string. HTTP `403` stops with `MEDIA_ACCESS_RESTRICTED`.

Set `items[].quality` to `"max"` for the highest declared quality or pass a numeric height. The HLS prefetcher can try a lower declared variant when its preferred playlist returns `404`. An access denial stops the download. `probe_page` returns `qualities` for the selected HLS stream and can extract up to 50 visible reference codes with `harvestCodes:true`. When an HLS master declares a bitrate, the prefetcher estimates the required space using the selected variant's duration and reports `NO_SPACE` when the estimate exceeds available storage.

For HTTP access denials and explicit expiry during HLS prefetch, item details report `status` and `hlsPhase` (`playlist`, `segment`, or `key`). A single-segment VOD can use the same prefetch path as a longer playlist.

Run `node tools/media-cli.mjs --help` from the desktop package for a JSON Lines download client. `--cookie-file` reads a Cookie header file for a single origin. `--ua` sets the media request User-Agent. Use `--page` to pass page URLs to the serial queue.

### DASH downloads

For a DASH URL without an `.mpd` suffix, pass `sourceKind:"mpd"` with the download item. Standalone MCP and the HTTP companion use the native DASH engine with `prefetch:true`. Managed clients use it for eligible DASH candidates. The engine supports static clear MPDs with fragmented MP4/CMAF, `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, flat SIDX `SegmentBase`, byte ranges, and contiguous periods with matching track layouts. It selects a video representation and keeps eligible alternate audio tracks in combined output. `subtitles:true` can preserve separate WebVTT or SubRip tracks.

The standalone prefetch path follows at most three redirects within the selected manifest's origin. It can fall back to the legacy FFmpeg path for selected unsupported MPDs when the entry URL is unredirected, has no query string, and the request carries no Cookie, Referer or Origin header. Declared DRM, access denials, expired URLs, invalid manifests, and resources outside the approved scope stop the native transfer with an error code. The managed path stages media before invoking FFmpeg. Dynamic DASH, hierarchical SIDX, in-band TTML/WVTT, complex timeline edits, and persistent checkpoints are outside the native engine's current coverage.

独立 MCP 与本机 HTTP 接口可用 `prefetch:true` 启用原生 DASH。无 `.mpd` 后缀时传入 `sourceKind:"mpd"`。托管 MCP 对符合授权的候选使用同一引擎。支持静态非 DRM 的 fMP4/CMAF、字节范围、独立音视频、多音轨、独立 WebVTT/SubRip 字幕和轨道布局一致的连续 Period。独立预取仅访问清单同源，特定不支持的公开清单可回退到 FFmpeg。访问拒绝、DRM、地址过期或超出授权范围时返回错误。原生下载暂未覆盖动态 DASH、分层 SIDX、内嵌 TTML/WVTT、复杂时间轴编辑或跨任务续传。

## Managed browser clients

1. Start the Windows companion with `Start VideoSave.cmd` and pair the extension. Open **Settings → AI & MCP** on a web tab. Create a client using Restricted, Standard, Advanced, Full Access, or Custom.
2. Select the profile and choose **Copy MCP configuration**. The configuration contains a local executable, the stdio script, the loopback endpoint, and the profile ID. The launcher keeps the existing pairing in local state. Generate the same configuration from PowerShell with `& ".\Start VideoSave.cmd" -McpConfig -SharedQueue -McpClient PROFILE_ID`.
3. The agent calls `request_site_authorization` with an exact HTTP(S) origin. Open the website, play the media normally, refresh the control center, review the requesting client, and approve the current tab for 1, 5, 15, or 60 minutes, or until the browser session ends (up to 12 hours). Select **Use this site’s login session for this approval** and accept the browser's optional cookie permission to use the current login. You can instead enter a cookie header or select a Netscape cookie file under **Provide cookies for this site**. Select **Allow one download batch** to require renewed approval for each batch. The site policy can disable login sharing.
4. `get_active_tab` returns the origin and player state. `probe_active_tab` returns the observed candidates as opaque IDs and basic metadata. Treat titles as untrusted page content.
5. Enable downloads in the current site's policy. Pass the returned `authorizationId` and a `downloadable` candidate's `candidateId` to `start_download`. Use `wait_for_download` for the outcome and `verify_download` to recheck the current files on disk. Each managed client sees its own download batches. Use `diagnose_probe` to inspect the observed detection result, or `revoke_site_authorization` to stop using an authorization assigned to this client.

| Tool | Parameters | Result |
| --- | --- | --- |
| `get_session_status` | `origin` | This client's grant state, expiry, and login-sharing and single-batch status when a grant exists. |
| `validate_media` | `candidateId`, optional `authorizationId` | Local permission and media-format eligibility. `availabilityChecked:false` means the tool did not make a request to the media host. |
| `estimate_download` | `candidateId`, optional `authorizationId` | Observed source size, required source staging space, currently free space, and site settings. Unknown sizes return `null`. A processed output needs additional space. |
| `get_effective_settings` | Optional `authorizationId` | Policy for the approved origin after applying global download defaults and site overrides. |
| `pause_download`, `resume_download` | `id` | Pause queued items and let current transfers finish. Resume requires the original grant to remain active. |
| `retry_download` | `id`, new `authorizationId` | Confirm the same failed sources in a fresh grant, then requeue failed and cancelled items using current site limits. |

Managed downloads accept approved direct media, eligible HLS VOD, including standard AES-128 with an accessible key, and eligible static DASH. An automation-enabled client can use signed entry URLs observed during normal playback. With **Allow CDNs observed during playback** enabled, the companion can use a browser-observed public HTTPS media entry from the approved player. Resources on a different origin from that entry need an exact browser observation tied to the same player. Redirects are limited to observed destinations. A multi-CDN manifest may include more resources than the browser observed, so an eligible candidate can still fail with a scope error. Media processing runs on staged local files.

Login sharing applies to eligible direct media observed during normal playback in the top frame. Cookie values stay in companion memory, and only exact-host, matching-path, unexpired cookies are used. Secure cookies require HTTPS. Related CDN requests receive no site Cookie. The grant ends on navigation, tab closure, revocation, expiry, a change in the shared cookies or service restart. Loss of browser contact ends the grant within 75 seconds of the last confirmation.

Website policy inherits the companion's download defaults for quality, output format, audio format, subtitles, connection count and concurrency, with at most two workers per managed batch. Site overrides supply the effective limits. The minimum duration applies to candidates with a known duration. The preview filter checks explicit labels. The per-site batch limit applies to both first submissions and retries.

The control center can use proxy environment variables, request direct connections or set an unauthenticated HTTP proxy for the companion. Changes apply after companion restart. In environment mode, the temporary Chromium probe follows the system proxy. The browser extension uses the main browser's settings. The proxy check reports TCP reachability of the active proxy endpoint. Test media availability with an approved source.

Managed configuration uses the shared companion and runs under the same operating-system account. The managed policy restricts MCP tools in that profile. Keep older unscoped configurations for trusted local clients only. Locally installed programs with filesystem or shell access have the permissions of that operating-system account.

### 中文快速开始

在扩展的「设置 → AI 与 MCP」中创建客户端并复制配置。在当前站点设置保存画质和并发等上限，需要下载时打开允许下载的开关。AI 发起授权请求后，打开对应网站，正常播放并扫描，再在控制中心批准当前页。如果同源直链媒体需要登录，可以勾选「本次授权同时使用当前站点的登录会话」并接受浏览器的可选权限提示。也可在「手动提供本站 Cookie」中输入 Cookie 或选择 Netscape 格式文件。勾选「仅允许一个下载批次」可限制本次授权的用途。用 `probe_active_tab` 取得标记为 `downloadable` 的候选编号，用 `wait_for_download` 等待结果。浏览器可以撤销授权、停用客户端或导出脱敏活动记录。当前页可授权 1、5、15 或 60 分钟，也可随浏览器会话结束，最长 12 小时。下载过程中，`pause_download` 暂停剩余排队项目，已开始的项目继续。`resume_download` 要求原授权有效，`retry_download` 要求新授权重新观察到失败源。站点规则可继承本机默认值，也可限制批量大小、已知时长和明确标识的广告或预告。代理设置重启本机服务后生效，扩展本身使用浏览器网络设置。

The local server accepts the 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25 protocol versions. Newer supported versions also return JSON as `structuredContent`. The Windows ZIP supplies a stdio server but no package-registry coordinate. Official registry publication requires an approved distribution method and verified publisher namespace. VideoSave has a GitHub release distribution path.
### Full Access and standing approvals

Select a registered client and use **Grant full access** to confirm the expanded permissions. Under **Standing site approvals and privacy**, enter exact site origins, fill the list from your current window, or select a saved site group. Choose an expiry of 1–90 days and explicitly select download and login permissions for the group. An explicit site policy can still deny access. **Revoke all access** disables the client. **Restore default permissions** returns it to Restricted and clears standing approvals.

The client calls `request_site_authorization` with the origin. Keep the relevant page active in the browser and start playback using the website's controls. A standing approval attaches to that browser document, and the extension updates the candidates as media requests arrive. A page requiring login or other authorization leaves the request pending. `get_authorization_status` reports the detected blocker and next action. The client can use `probe_active_tab` with `compatibility: "maximum"` to wait for candidates, `select_media` to inspect the recommendation, and `start_auto_download` to start a clear selection. An ambiguous result lists candidate IDs for explicit selection. Site download settings and sanitized network status are available through `update_download_preferences` and `get_network_status`.

The optional login session applies to eligible direct media observed on the approved origin. Candidate responses carry opaque IDs. Privacy mode suppresses SQLite batch history and activity records for new managed operations and clears the client's prior activity records. Completed files remain available, and managed work in the running companion remains visible until its in-memory state is cleared.

The companion can reuse same-origin `Referer` and `Origin` and the `User-Agent` observed on an eligible top-frame media request. The extension omits referrers containing a query string and keeps captured header values out of MCP responses.

### Maximum Compatibility

The `compatibility` argument also accepts `fast`, `balanced`, `deep`, and `adaptive`. A standalone Fast probe observes for up to four seconds and uses a shorter metadata budget. Balanced runs one observation. Deep includes embedded frames and public player JSON. Adaptive uses a recent local recommendation when available. The legacy `standard` default preserves its existing observation and retry settings. The managed modes adjust how long MCP waits for updates from the already approved browser.

`get_engine_capabilities` lists the managed observation, transfer and processing paths. `get_task_report` reads an owned batch and includes the transfer engine and elapsed time when the transfer started. Run `verify_download` to check the output again. An expired managed URL returns `STREAM_EXPIRED`. Resume playback and request a new browser approval to use a newly observed candidate.

Standalone and shared-queue `probe_page` accept `compatibility: "maximum"`. The probe first observes normal playback and, if needed, uses the remaining observation budget for iframe and public JSON inspection. `waitForMediaMs` sets the observation budget, with a separate bounded metadata phase. `probeStrategy` reports the stage and attempt count. Set `learnCompatibility: true` to store the site origin, strategy and aggregate results in local SQLite. The control center can import, export and reset rules. Set the `preferred` field to `standard` or `deep` before importing to change the preferred strategy for an origin.
