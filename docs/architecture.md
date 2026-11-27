# VideoSave architecture

```mermaid
flowchart LR
  Tab[Browser tab] --> DOM[DOM and playback observations]
  Tab --> Net[Browser request observations]
  DOM --> Detect[Shared candidates and diagnostics]
  Net --> Detect
  CDP[Isolated Chromium probe] --> Detect
  Detect --> Popup[Extension panel]
  Detect --> API[Loopback HTTP and MCP]
  Popup --> Browser[Browser downloads]
  Popup --> API
  API --> Queue[Companion queue and SQLite checkpoints]
  Queue --> Transfer[HTTP Range, HLS, FFmpeg and optional yt-dlp]
  Transfer --> Verify[Output validation and final save]
```

`extension/media.mjs` harvests DOM evidence and merges observations by HTTP(S) resource. `media-adapters.mjs` recognizes explicit source arrays and schema.org VideoObject metadata. It processes a bounded stack of public JSON and ignores unknown schemas. Add a supported schema there and exercise the expected candidates in the compatibility fixtures.

`manifest-evidence.mjs` relates adaptive manifests, renditions and initialization resources. It never offers blob URLs as downloads. `detection.mjs` records the signals used to rank a candidate and reports ambiguity or blockers. It also defines the diagnostic export allowlist. A playing element is a weak signal by itself because it can be a trailer. Where evidence supports the legacy duration rule, the API retains its existing selection reason.

The extension listens to request metadata through its existing browser permissions. Content observers run in the isolated world while the panel is active. They coalesce playback and source changes and expire after a bounded interval. The extension can inspect a bounded public manifest without sending credentials. MCP observes CDP response metadata and optionally inspects same-origin JSON response bodies. Both surfaces preserve access restrictions and leave normal site authorization to the user.

Windows workers use the requested connection count as their per-transfer ceiling. Range prefetch verifies ETags and offsets. HLS prefetch retries transient segment failures and bounds duplicate requests from spare workers. Local queue recovery preserves completed outputs and revalidates checkpoint inputs before resuming. FFprobe verifies output tracks and duration where available.

The managed MCP tools use a profile-scoped credential on the paired loopback server. The extension confirms the identity of the approved document and periodically renews the grant. Optional login credentials are matched to the approved direct resource for each HTTP request. Managed jobs reject redirects and stage direct media or eligible public same-origin HLS before passing a local file to FFmpeg. SQLite stores policy, audit metadata, and batch ownership.

See [compatibility evidence](compatibility-report.zh-CN.md), [MCP operations](mcp.md), [installation](install.md), and the [privacy policy](privacy.md).
