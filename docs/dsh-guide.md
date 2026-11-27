# DeepSeek Harness (DSH) Integration & Upgrade Guide

VideoSave `1.0.0` is engineered and verified directly against the real DeepSeek Harness (DSH) MCP client runtime (`@deepseek-ai/dsh-mcp-client` + `AjvJsonSchemaValidator`).

## 1. Upgrading From Older Versions (Avoiding Stale `v0.9.0` Drift)

A common issue when updating VideoSave is that DSH's `cordis.patch.yml` still points to an older local directory (for example `media-toolkit/open-media` running `v0.9.0`) or keeps an old `mcp-server.mjs` process alive in the background.

### Step 1: Verify which version DSH is actually running
Call the MCP tool `get_version`:
- If `get_version` does not exist in `tools/list`, DSH is still connected to `v0.9.0` or `v0.10.0`.
- If `versionMismatch: true` is returned, the running Node.js process differs from the extracted package on disk — restart the MCP server or DSH.

### Step 2: Point DSH to the extracted `VideoSave-1.0.0` release package
Extract `VideoSave-1.0.0.zip` to a stable path (e.g., `C:\VideoSave\VideoSave-1.0.0`), run `.\Start VideoSave.cmd -McpConfig` once to prepare Node.js/FFmpeg, and point your DSH MCP bundle's `cordis.patch.yml` to the new `tools/mcp-server.mjs`:

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

To share a live queue with the paired desktop companion (`Start VideoSave.cmd`):

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

## 2. Recommended DSH Workflows

### One-Call Best Quality Download & Verification
```json
{
  "url": "https://media.example/watch/101",
  "quality": "best",
  "verify": true
}
```
Call `download_best_media` — it probes the page, selects the unambiguous main video, negotiates the highest observed variant (never guessing URLs), downloads with full header consistency, and verifies video/audio/resolution/duration via `ffprobe`.

### Dedicated Isolated Browser Session (Authorized Login)
Never pass system browser profile directories or `useBrowserCookies: true` (VideoSave blocks these by design to protect user privacy). Instead:
1. Launch a dedicated VideoSave-managed profile:
   `probe_page({ url: "https://site.example/login", mode: "headed", profileMode: "dedicated", browserSessionId: "my-site", userAgent: "..." })`
2. Sign in normally in the isolated window.
3. Reuse `profileMode: "dedicated", browserSessionId: "my-site"` on subsequent probes, or check status/reset with `get_browser_session_status`.

### Authorized Netscape `cookies.txt` or Header Cookie Import
```json
{
  "filePath": "C:/path/to/cookies.txt",
  "origin": "https://site.example",
  "ttlMinutes": 30
}
```
Call `import_cookie_file`. VideoSave parses both Netscape 7-column TSV (`cookies.txt`, including `#HttpOnly_`) and single-line `Cookie:` headers, rejects challenge cookies (`cf_clearance`, `__cf_bm`), stores credentials strictly in memory for the target origin only, returns a `cookieSessionId` without ever echoing raw cookie values to the AI, and never forwards cookies cross-origin.

### Serial Batch Queue & Identifier Harvesting
1. Extract identifiers from a list page:
   `probe_page({ url: "https://site.example/list", harvestCodes: true, idPattern: "EP_\\d{3}", urlTemplate: "https://site.example/watch/{id}" })`
2. Preview & deduplicate before downloading:
   `start_batch({ items: [{ kind: "id", id: "EP_001" }, { kind: "id", id: "EP_002" }], urlTemplate: "https://site.example/watch/{id}", deduplicate: true, previewOnly: true })`
3. Submit with `previewOnly: false`, `concurrency: 1`, `perItem: { quality: "best" }`, and control with `pause_download`, `resume_download`, `cancel_download({ id, itemIndex })`, `verify_download`, and `diagnose_download`.
