# Changelog

## 1.0.0-rc.1

- Allow approved browser playback to supply public HTTPS CDN candidates to managed MCP. Additional origins require exact same-player evidence. Keep observed signed URLs and playback credentials inside the approved session.
- Stage supported clear static DASH before local muxing. Select a video representation and preserve eligible alternate audio and optional external subtitles. Use the native path for local prefetch, with a bounded legacy fallback for selected public manifests.
- Report the failed Chromium startup phase and retry an early connection failure once. Expose Fast, Balanced, Deep, Maximum and Adaptive probe options, retaining the legacy Standard argument and default.
- Show the actual transfer engine and elapsed time in batch progress. Managed MCP adds `get_engine_capabilities` and `get_task_report`. Candidate eligibility reflects the current client's download permission.
- Package the release candidate as portable Windows and developer extension ZIPs. Browser build `0.99.0.1` sorts between the current stable version and `1.0.0`.
- See the [compatibility results](docs/compatibility-report.zh-CN.md), [authorization and format limits](docs/mcp.md), and [security changes](docs/v1-security.md).

## 0.10.0

- Add **AI & MCP** settings with individually scoped local clients and credential-free stdio configuration generation.
- Share a user-approved current-tab snapshot and use candidate IDs to queue same-origin media. Grants have a short expiry and can be revoked.
- Add opt-in, temporary browser login sharing for observed same-origin direct media. Managed requests reject redirects and keep cookies out of tool results and persisted settings.
- Accept a site-specific cookie header or Netscape file for a temporary approval. Optionally limit any authorization to one download batch.
- Stage eligible public same-origin HLS, report probe diagnostics, and recheck completed files on disk through managed MCP.
- Recover additional sources from observed public same-origin player JSON in Edge, Chrome, and Firefox.
- Recheck an empty media panel within a bounded window for players attached to open Shadow DOM after loading.
- Apply website settings to managed downloads. Add batch ownership, download limits and an optional activity log with retention and export controls.
- Report site authorization status, candidate eligibility and observed download size without requesting media again.
- Add hour-long and browser-session grants, inherited website download defaults, batch-size limits, minimum known duration and preview filtering.
- Pause and resume queued items, or reapprove failed sources to retry them. Audit records can be filtered by client and outcome.
- Configure direct, environment or unauthenticated HTTP proxy routing for the companion, with a restart pending indicator and connection check.
- Exercise Edge and Chrome login approval, denied access, redirect rejection, dual-track output and same-URL reload revocation through MCP in CI.
- Stage MPEG-TS HLS segments with nonstandard extensions after validating their contents. Resume interrupted transfers from completed parts, track missing indices and optionally retain completed parts.
- Queue serial batches through MCP and HTTP, resolve page links or explicit reference codes when their turn starts, and reuse existing outputs from matching requests.
- Report HLS variants and free-space errors, try the next quality when a variant playlist is missing, and re-probe a public player once after explicit stream expiry.
- Add a local CLI with JSON Lines progress, a single-origin cookie file and a media request User-Agent.
- Add Advanced and Full Access presets, standing approvals for selected site groups, optional private batch history, and explicit reset and revocation controls.
- Update standing browser grants with observed media, preserve IDs for unchanged candidates, and select or download a clear recommendation with managed MCP.
- Require each standing client to opt into unattended downloads. Revoke shared login access when its cookie state changes, including before the first media observation.
- Stage public same-origin AES-128 HLS VOD with validated key length, while preserving managed resource boundaries and DRM diagnostics.
- Replay the observed same-origin playback context for approved managed media and give pending site requests a sanitized access diagnostic.
- Add bounded Maximum Compatibility probing, optional local strategy learning, and rule import, export, and reset controls.
- Recognize FLV sources declared in structured page data and extend compatibility coverage across browser and MCP paths.

## 0.9.0

- Combine visible player evidence, media request MIME, open Shadow DOM, public source metadata and adaptive manifests.
- Refresh the browser panel when players, sources or observed responses change. Group alternate qualities and suppress manifest initialization fragments.
- Recheck an empty panel once for players that attach open Shadow DOM after the initial scan. Group observed DASH fragments with their manifest and distinguish fragment-only playback from a page with no player.
- Give HTTP and MCP consumers candidate evidence, confidence and legal next actions. Recognize DRM and site access restrictions when the observable evidence identifies them.
- Export a diagnostic report through a local allowlist and back up, import or reset browser preferences.
- Produce portable Windows, Chromium, Firefox and experimental Android archives with SHA-256 checksums and a software bill of materials.
- Add cross-browser, packaging and local service security checks. See the [compatibility report](docs/compatibility-report.zh-CN.md) and [HLS benchmarks](docs/hls-benchmark.zh-CN.md) for measurements, source data and failures.

## 0.8.1

Added the Windows portable setup flow, adaptive prefetch, MCP batch waiting and failure details, headers and checkpoint-based recovery.
