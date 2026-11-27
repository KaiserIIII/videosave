# Roadmap

## Delivered in v1.0.0
- Unified `RequestContext` across HLS, DASH, HTTP Range, retries, resume, bounded URL refresh, and FFmpeg fallback (with strict cross-origin credential isolation).
- Binary `MediaInspector` supporting nonstandard segment extensions (`.jpeg`, `.jpg`, `.png`, extensionless), fMP4, custom-wrapped TS, WebVTT subtitles, and AES-128 post-decrypt validation while rejecting images/HTML/JSON/DRM.
- SHA-256 verified checkpoint recovery tested with 25%/50%/90% hard kills, single corrupted segment recovery, service restarts, manifest changes, and 1,000-segment VOD stress tests.
- Dedicated isolated VideoSave browser sessions (`profileMode: "dedicated"`, `browserSessionId`, custom `userAgent`, `browser`, `browserBinary`, `proxy`, `timeoutBudget`).
- Smart quality negotiation, generalized identifier harvesting, unified Netscape/Header cookie import, full DSH MCP tool suite (`get_version`, `download_best_media`, `verify_download`, `diagnose_download`, etc.), and mandatory test sandbox isolation.

## Next Milestones (v1.1+)
- Support live/sliding-window DASH (`type="dynamic"`) and Low-Latency HLS (LL-HLS) partial segments with bounded live recording.
- Evaluate signed extension store listings (Edge Add-ons, Chrome Web Store, Firefox AMO) and official MCP Registry publishing.
- Expand public sample test matrix for multi-language audio/subtitle tracks and long-running large-file memory profiling.
- Cross-platform macOS and Linux launcher parity alongside Windows x64 portable packages.
