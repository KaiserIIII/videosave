# Third-Party Component Notices

VideoSave's own source code (browser extension, local companion server, local management console, MCP server, and CLI) uses **zero third-party npm packages** and is licensed under the **MIT License** (`LICENSE`).

When run via the Windows launcher (`Start VideoSave.cmd`) or optional platform extractors, VideoSave downloads or locates pinned, SHA-256-verified binaries from their official upstream releases:

| Component | Pinned Version | License | Upstream Source | Usage |
| --- | --- | --- | --- | --- |
| **Node.js** | `24.22.3` | MIT (plus bundled V8/libuv/OpenSSL licenses) | https://github.com/nodejs/node | Runs the local companion, CLI, and MCP server |
| **FFmpeg / FFprobe** | `8.1.2` (`essentials_build`) | GPL-3.0-or-later | https://github.com/FFmpeg/FFmpeg (Windows build: https://github.com/GyanD/codexffmpeg) | Container muxing, remuxing, preview clips, and FFprobe output verification |
| **yt-dlp** (optional) | `2026.11.23` | Unlicense (Windows standalone bundle: GPL-3.0-or-later) | https://github.com/yt-dlp/yt-dlp | Authorized public video downloads on Bilibili and YouTube |
| **Streamlink** (optional, user-provided) | User-installed via `STREAMLINK_BIN` | BSD-2-Clause | https://github.com/streamlink/streamlink | Optional live-stream adapter when explicitly configured by the user |

Every release publishes a machine-readable CycloneDX 1.6 SBOM (`VideoSave-<version>-sbom.cdx.json`), `SHA256SUMS.txt`, and GitHub Actions build provenance attestations.
