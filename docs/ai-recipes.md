# VideoSave AI Agent & CLI Cookbook (8+ Copy-Paste Recipes)

All examples below use authorized, legal media sources and real VideoSave `v1.1.0` MCP tools & CLI flags. VideoSave never bypasses DRM, paywalls, or anti-bot challenges.

---

## Recipe 1 — One-Call Probe, Verified Best Quality & FFprobe Check
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
What happens: probes page → verifies each quality candidate with a 2-byte Range probe (`available` / `unavailable` / `restricted`) → picks highest verified quality → downloads with unified `RequestContext` → runs FFprobe verification.

---

## Recipe 2 — Serial Batch Download by Media IDs + Template + Conflict Policy
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

---

## Recipe 3 — Harvest Visible IDs on a Catalog Page → Preview → Confirm Serial Batch
Step 1 (extract & preview URLs safely; catastrophic-backtracking `idPattern` is automatically rejected):
```json
{
  "tool": "probe_page",
  "arguments": {
    "url": "https://example.org/catalog",
    "harvestCodes": true,
    "idPattern": "[A-Z]{2,6}-\\d{2,5}",
    "urlTemplate": "https://example.org/watch/{id}"
  }
}
```
Step 2 (dry-run preview with deduplication):
```json
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
Step 3: re-call `start_batch` with `"previewOnly": false` after user confirmation.

---

## Recipe 4 — Diagnose HTTP 403 / Transfer Failures by Stage (Sanitized)
```json
{
  "tool": "diagnose_download",
  "arguments": { "id": "<batch-id>" }
}
```
Returns exact failing stage (`master-playlist | variant | segment | key | init | mpd | mux | verification`), HTTP status, engine, sanitized `sentHeaderNames` (never values), `failedSegments`, `resumable`, and actionable `nextAction`.

---

## Recipe 5 — Authorized Stream Refresh + Checkpoint Reuse After Token Expiry
```json
{
  "tool": "start_download",
  "arguments": {
    "items": [{
      "kind": "stream",
      "url": "https://cdn.example.org/hls/master.m3u8?token=short-lived",
      "title": "Conference Keynote"
    }],
    "headers": {
      "Referer": "https://example.org/watch/keynote",
      "Origin": "https://example.org",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    "refresh": {
      "pageUrl": "https://example.org/watch/keynote",
      "maxRefreshes": 2
    },
    "resume": true
  }
}
```
When the signed token expires (HTTP 410), VideoSave re-probes the original authorized page, verifies origin/format identity, preserves headers & same-origin cookies, and reuses SHA-256-verified segments from `checkpoint.json`.

---

## Recipe 6 — Dedicated Isolated Browser Session (Normal Login / Interactive Sites)
VideoSave never reads system browser profiles or accepts challenge cookies (`cf_clearance`). Instead, use a dedicated isolated profile stored under `<stateDir>/VideoSave/profiles/<id>`:
```json
// 1. Optional clean reset
{ "tool": "get_browser_session_status", "arguments": { "browserSessionId": "member-site", "action": "reset" } }

// 2. Launch headed dedicated window once so the user signs in normally
{
  "tool": "probe_page",
  "arguments": {
    "url": "https://member.example.org/video/1",
    "mode": "headed",
    "profileMode": "dedicated",
    "browserSessionId": "member-site",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  }
}

// 3. Verify readiness (look for usable: true, hasCookies: true, blockers: [])
{ "tool": "get_browser_session_status", "arguments": { "browserSessionId": "member-site" } }
```
Concurrent calls to the same `browserSessionId` automatically serialize via an in-process queue + cross-process lockfile.

---

## Recipe 7 — FFprobe Output Verification & Task Summary Report
```json
{ "tool": "verify_download", "arguments": { "id": "<batch-id>", "durationToleranceSec": 1.0 } }
{ "tool": "get_task_report", "arguments": { "id": "<batch-id>" } }
```
Returns `duration`, `size`, `width`, `height`, `videoCodec`, `audioCodec`, `container`, `subtitleTracks`, `durationDiffSec`, plus batch summary counts and average speed.

---

## Recipe 8 — Inspect Checkpoints & Resume Interrupted Long Jobs
```json
{ "tool": "recover_download", "arguments": { "id": "<batch-id>" } }
```
Inspects `checkpoint.json` (`total`, `completed`, `missing`, `corrupted`, `savedBytes`, `failedSegments`). Re-submit the original `start_download` request to fetch only missing or corrupted parts without re-downloading verified segments.

---

## Recipe 9 — Long-Running CLI Job Outside MCP Timeouts (JSONL + Exit Codes)
```bash
node tools/media-cli.mjs \
  --out ./downloads \
  --cookie-file ./authorized-cookies.txt \
  --headers-json '{"Referer":"https://example.org/watch/1","Origin":"https://example.org"}' \
  --ua "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" \
  --quality best \
  --conflict-action skip \
  --filename-template "{title}_{height}p" \
  --connections 8 \
  --resume \
  --json-progress \
  --verify \
  "https://cdn.example.org/hls/master.m3u8"
```
Documented CLI exit codes:
- `0` = Completed & verified
- `1` = Unexpected runtime error
- `2` = Invalid arguments / input
- `3` = Insufficient disk space (`NO_SPACE`)
- `4` = Login, challenge, or access restriction (HTTP 401/403/451)
- `5` = Media or requested quality unavailable / DRM
