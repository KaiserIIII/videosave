# VideoSave

[简体中文](README.zh-CN.md) · [Download](https://github.com/KaiserIIII/videosave/releases/latest) · [MIT License](LICENSE)

Find the video playing in your browser, preview it, and save it to Downloads. VideoSave is free and open source. The optional Windows companion adds DASH, more HLS formats, conversion, and an MCP interface for AI clients.

![VideoSave 0.9 in Microsoft Edge](docs/videosave-0.9-detection.png)

**AI & MCP** gives registered clients individual permissions, short-lived current-tab approval, website download limits, and a local activity log. [Set up a managed client](docs/mcp.md#managed-browser-clients) · [Control center screenshot](docs/videosave-mcp-control.png)

## Install

Download and extract the release ZIP. The browser extension is in the `extension` folder.

| Browser | Installation |
| --- | --- |
| Microsoft Edge | Open `edge://extensions`, enable Developer mode, then choose **Load unpacked**. |
| Google Chrome | Open `chrome://extensions`, enable Developer mode, then choose **Load unpacked**. |
| Firefox 136+ on desktop | Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension/manifest.json`. Load it again after restarting Firefox. |
| Firefox 136+ on Android (experimental) | Extract the `VideoSave-*-android-dev.zip` package and use it with [Mozilla’s Android testing workflow](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/). Standard installation requires a signed add-on. |

Open a video page and click **VideoSave**. If the list is empty, start playback and reopen the panel. The open panel updates when it observes a new player, source, or media response. You can also paste a direct link or export a local diagnostic report. On experimental Android, open the media in a new tab and use Firefox’s own save command when available.

[Installation and upgrades](docs/install.md) · [Measured compatibility](docs/compatibility-report.zh-CN.md) · [Architecture](docs/architecture.md) · [MCP](docs/mcp.md) · [Privacy](docs/privacy.md) · [Changelog](CHANGELOG.md)

Open **Settings → Backup and updates** to export, import or reset browser preferences and view official updates.

## What you can do

- Compare titles, durations, resolutions, and sizes. Click a cover for a muted preview and open the menu to see alternative sources, rename the file, or copy its URL.
- Batch downloads, check progress and speed, and pause, resume, cancel, or retry eligible browser downloads. Pick a download subfolder or let the browser ask where to save.
- Choose a system, light, dark, jade, or amber theme and customize the accent color.
- Switch between English and Simplified Chinese under **Settings → Appearance**. The default follows the browser's interface language.
- Save compatible HLS on demand in the desktop browser with the **Auto** format. With a quality cap, the extension picks the highest available rendition within that cap. A combined video and audio stream saves as `.ts` or `.mp4`.
- Save compatible HLS playlists that reference byte ranges in a shared media file. VideoSave requests the required slices and checks their ranges before joining them.
- Browser HLS downloads with separate segment URLs keep finished segments if the extension reloads during transfer. If the playlist still matches, the queue resumes with the unfinished segments.
- Pair the companion for DASH, HLS with a separate audio track, downscaling, MP4 or MKV conversion, compatible embedded subtitles, and separate M4A/MP3 audio.
- Download with 1–64 concurrent jobs (24 by default). Eligible direct files of at least 8 MiB with a strong ETag and valid HTTP Range support use 4, 8, or 12 connections. Eligible HLS VOD also fetches segments in parallel.

Save media you have permission to download. DRM-protected media and players that do not expose a usable source are outside the supported formats.

## Windows companion

On Windows x64, double-click `Start VideoSave.cmd` in the extracted desktop ZIP. The launcher reuses compatible Node.js and FFmpeg installations, downloads and verifies missing tools, then starts the companion. Portable tools are cached by version under `%LOCALAPPDATA%\VideoSave\tools` so a newly extracted release can reuse them. The launcher also sets up the platform extractor. Run it with `-SkipPlatform` to skip the extractor or `-SetupOnly` to install dependencies and print the Node executable path for MCP.

If you manage Node.js and FFmpeg yourself, put them on PATH and run:

```powershell
node tools/server.mjs
```

The service listens on `127.0.0.1:8765`. Enter its address and pairing code under **Settings → Local download service**. Starting with `Start VideoSave.cmd` keeps the same pairing code after a restart. A manually started service uses a new code unless you set `MEDIA_TOOLKIT_TOKEN` or enable local pairing with `MEDIA_TOOLKIT_LOCAL_PAIRING=1`. HTTP and MCP page inspection use a temporary Chromium profile. Use `BROWSER_BIN` to select Edge, Chrome, or Brave. `EDGE_BIN`, `FFMPEG_BIN`, and `FFPROBE_BIN` are also supported.

### Bilibili and YouTube

The Windows x64 launcher enables [yt-dlp](https://github.com/yt-dlp/yt-dlp) for public videos you have permission to save. If you start the service manually, run the extractor setup from the extracted directory first:

```powershell
node tools/setup-platform-downloads.mjs
node tools/server.mjs
```

The installer verifies pinned downloads and records their source and checksum. Running `node tools/setup-platform-downloads.mjs` directly stores yt-dlp in the archive's `.local-tools` directory. If the first yt-dlp download fails, the companion and MCP can still download direct media and streams. Run setup again to enable platform extraction. To use your own extractor, set `YTDLP_BIN` to its path before starting the companion or standalone MCP server. YouTube extraction uses the existing Node.js runtime.

Pair the desktop extension with the companion and open a video page, or paste the page URL into the extension. Choose the quality cap and audio/video options as usual. Platform downloads support public, non-DRM single videos. The panel shows the page title and playback duration when available. Preview and exact file size are unavailable for the page-based entry.

| Environment variable | Purpose |
| --- | --- |
| `PORT` | Change the local HTTP port. |
| `MEDIA_TOOLKIT_TOKEN` | Set a stable pairing code for the service and MCP. |
| `OUT_DIR` | Set the fallback directory for local jobs. Browser jobs use the browser’s download directory. |
| `MEDIA_TOOLKIT_SETTINGS` | Override the settings database path. Windows defaults to `%LOCALAPPDATA%/VideoSave/settings.sqlite`. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Route transfers handled by Node.js through your configured proxy on Node.js 24.14+. Loopback stays local. Set `NODE_USE_ENV_PROXY=0` to disable this automatic routing. |

## Connect an AI client

On Windows, run this from the extracted folder in PowerShell. The launcher prepares the dependencies and prints a ready-to-paste configuration with absolute paths.

```powershell
& '.\Start VideoSave.cmd' -McpConfig
```

Add the generated `videosave` entry to your client's `mcpServers`. If you manage the runtime yourself, use the example below with your own path.

```json
{
  "mcpServers": {
    "videosave": {
      "command": "node",
      "args": ["C:/path/to/VideoSave/tools/mcp-server.mjs"]
    }
  }
}
```

This configuration runs MCP independently. To share the live queue with a companion launched using `Start VideoSave.cmd`, generate the configuration with `-McpConfig -SharedQueue`. The client reads the pairing code from the local settings database, so the exported JSON contains no pairing code. Keep the companion running when using this mode. If you set a custom pairing code, configure `MEDIA_TOOLKIT_URL` and `MEDIA_TOOLKIT_TOKEN` in the MCP client's environment.

| MCP tool | What it does |
| --- | --- |
| `probe_page` | Return media, detail-page candidates, and the selection result. Accepts `waitMs` (default 20,000) and `retries` (default 2). |
| `start_download` | Queue an exact media URL with `kind: "stream"` or pass entries from `probe_page.candidates` as `items`. |
| `get_progress` / `list_batches` | Inspect one batch or list recent batches, including interrupted local downloads. |
| `wait_for_download` | Wait for a batch to finish. Accepts `id` and optional `timeoutMs` (default 30,000). A response with `timedOut: true` leaves the download running. |
| `cancel_download` | Cancel queued and active work in a batch. |
| `retry_download` | Retry failed or cancelled items using the original settings and cookie held by the current process. Repeated calls with the same ID return the retry batch. |
| `get_settings` / `update_settings` | Read or patch persistent download defaults and browser overrides. |
| `list_downloads` / `open_file` | List recent local files or reveal a file in Windows Explorer. |

For the main video, compare duration, player heading and description, and source metadata. Streams with the same `player.id` belong to the same player. `recommended` is a playback hint and can point to an autoplay teaser. For regular pages, `selection.status` reports `selected`, `ambiguous`, or `unavailable`. A selected candidate includes its URL and the reason. With several visible players, an automatic selection requires known durations and a lead of at least one second and 10% of the longest duration. An ambiguous page download returns `AMBIGUOUS_MEDIA`. The AI can select the exact stream and pass `sourceKind: "m3u8"` or `"mpd"` for those formats. Page text is input data and never grants permission to change settings.

Read `diagnostic.code` and `diagnostic.nextAction` when selection is unavailable or ambiguous. Candidates include evidence, confidence and delivery hints. Page descriptions are limited to 300 characters by default and marked with `pageContext.untrusted: true`. Set `includeText: true` to read the full description.

With `maxSec`, the service reads the remote source on demand by default. Set `prefetch: true` to attempt staging the full source before trimming. Each result reports whether a staged input was used. When the service falls back, `prefetchFallback.reason` explains why. Explicit `headers` take precedence over recently observed request headers for the same media URL in the same service process. A 429 during HLS staging reports `RATE_LIMITED` with `detail.retryAfterSec`. Recognized expiry timestamps are available as `expiresAt`. Media packet boundaries can affect the exact duration of a stream-copy clip.

Terminal batch states are `done`, `partial`, `failed`, and `cancelled`. Results include verified output metadata, per-item progress, and a machine-readable error code with sanitized details on failure. `open_file` accepts media within the configured output directory.

Use `mode: "headed"` to observe the page in an isolated Edge or Chromium window. Set `waitForMediaMs` for a single observation window of up to 60 seconds. Use `clickPlay: true` to start playback when there is one visible player, `includeFrames: true` to identify embedded players and their `frameUrl`, or `captureXhrBody: true` to inspect same-origin JSON player source lists (up to 50 responses, 512 KiB each). Media from these lists carries `discoveredBy: "xhr-json"`. If the probe finds no source in the lists, `xhrJson` reports keys and match counts. Detected challenges, CAPTCHAs, HTTP 402 responses, and browser DRM appear in `blockers`.

Pass `headers` to `start_download` to set `Referer`, `Origin`, or `User-Agent` for prefetch and remote FFmpeg input. Pass cookies in the separate `cookie` field.

To save a complete HLS video with eight connections in DSH or another MCP client, pass these arguments to `start_download` with the detected playlist URL.

```json
{"items":[{"kind":"stream","sourceKind":"m3u8","url":"https://example.com/video.m3u8"}],"prefetch":true,"connections":8}
```

Pass the returned batch `id` to `wait_for_download`. If `timedOut` is `true`, wait again with the same ID. Check each item's `status` and `outputs` when it finishes. If `prefetch` is `false`, read `prefetchFallback.reason` for the cause.

After a local download process restarts, `resumable: true` means you can continue the batch by submitting the original `start_download` request, including its options and any required cookie. Completed items keep their output paths. HLS downloads with unchanged playlists and keys can reuse completed standalone segments. Range downloads can reuse complete ranges confirmed by a strong ETag. Interrupted single-connection, DASH, and platform-extractor transfers restart the affected item. Use `cancel_download` to discard an interrupted batch and clean up its staging files.

### Change settings through MCP

Call `update_settings` with the fields you want to change. Use `null` to reset a field to its default.

```json
{"scope":"download","settings":{"outDir":"D:/Videos","quality":1080,"concurrency":24,"connections":8}}
```

The download scope also accepts `mode`, `format`, `audioFormat`, `subtitles`, and `fastStart`. A batch takes a snapshot of the defaults when it starts. Explicit job options take precedence.

```json
{"scope":"browser","settings":{"theme":"jade","previewSeconds":3,"downloadFolder":"Courses","language":"system"}}
```

Enable the override checkbox in the paired extension’s local service settings. Overrides apply when the panel opens or when you click **Sync now**. While synchronization is enabled, the companion is authoritative for the fields it supplies. To change one of those fields manually, turn synchronization off first. Set `language` to `system`, `en`, or `zh-CN`. The browser scope also accepts preview, naming, format, quality, and transfer options.

## HTTP reference

Supply `Authorization: Bearer <pairing-code>`. Non-empty POST bodies use `Content-Type: application/json`.

| Method | Route | Input or output |
| --- | --- | --- |
| GET | `/api/health` | Version and output directory |
| POST | `/api/probe` | `{url,cookie?,waitMs?,retries?,includeText?}` → page and media candidates |
| POST | `/api/preview` | `{url,seconds?}` → 3, 6, or 10 second MP4 |
| POST | `/api/queue` | `{items,maxSec?,prefetch?,cookie?,concurrency?,connections?}` → batch ID |
| GET | `/api/batch/<id>` | Batch progress and results |
| GET | `/api/batch/<id>/events` | Server-sent progress events |
| GET | `/api/batch/<id>/wait?timeoutMs=30000` | Wait for the batch and return progress with a `timedOut` flag |
| GET | `/api/batches` | Recent batch summaries |
| POST | `/api/cancel` | `{id}` |
| POST | `/api/retry` | `{id}` → new batch ID and item count |
| GET | `/api/recent` | Recent media files in the output directory |
| POST | `/api/open` | `{file?}` |
| GET / POST | `/api/settings` | Read settings or patch with `{settings}` |
| GET / POST | `/api/browser-settings` | Read browser overrides or patch with `{settings}` |

Queue items require `kind` (`page` or `stream`) and `url`. Optional fields include `title`, `format`, `mode`, `quality`, `audioFormat`, `subtitles`, `sourceKind`, and `fastStart`. Omit `maxSec` to save the full video.

Check each item's `status` when a batch finishes. Failed items contain a human-readable `error` and a machine-readable `errorCode`, such as `AMBIGUOUS_MEDIA` or `MEDIA_FAILED`.

## Develop and build

Run these commands from the source checkout. Keep Node.js 24, Edge, and FFmpeg available for the tests. Python 3.9+ builds the ZIP files using the standard library.

```powershell
node --test
node tests/smoke.mjs
python tools/build_release.py
```

The full smoke test uses isolated browser profiles and public sample media. Use `node tests/smoke.mjs --delivery-only` to check browser pairing and delivery with local fixtures. The build writes the desktop ZIP, the Android developer ZIP, and SHA-256 checksums to `dist/`.
