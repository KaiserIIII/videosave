# VideoSave v1.3.0 Security & Privacy Audit

- **Audit Date**: 2026-11-28
- **Scope**: Internal engineering security audit across `v1.3.0` additions & existing core (Bilibili native adapter, public platform adapters, Android native app, hardened DSH-12 OS audit monitor, adaptive rate controller, supply-chain updater, installers, MCP, HTTP companion).
- **Disclaimer**: This is an internal engineering audit backed by automated tests, not a third-party external penetration-test certification.

## 1. Findings & Mitigations Implemented in v1.3.0

| Domain | Risk Reviewed | Concrete Mitigation & Test Evidence |
| :--- | :--- | :--- |
| **Bilibili Native Adapter (`tools/bilibili-adapter.mjs`)** | SSRF via untrusted CDN URLs or malicious `b23.tv` redirects; cross-origin cookie leakage | `resolveBilibiliShortLink` enforces `redirect: 'manual'` and verifies destination host is strictly `www/m/bilibili.com`. `isSafeBilibiliMediaUrl` strictly enforces `https:` and blocks RFC1918/loopback/link-local/IPv6 ULA IPs. Optional user-authorized cookies are sent **only** to `*.bilibili.com` API hosts. Verified in `tests/v1.3-compatibility.test.mjs`. |
| **Android DASH XML Parser (`DashEngine.java`)** | XXE (XML External Entity) injection & billion-laughs DoS from malicious `.mpd` manifests | Disables DOCTYPE declarations and external entities (`disallow-doctype-decl`, `expandEntityReferences=false`), caps manifest read to 1 MiB, caps segment expansion to 5,000 segments, and rejects DRM/dynamic/unsupported manifests before writing any disk file. |
| **Android Output Verification (`MediaContainerUtil.java` + `DownloadService.java`)** | Saving HTML/XML/JSON error pages or truncated HTTP 416 `.part` files as valid `.mp4` | Strict binary magic verification (`ftyp`/`styp`/`moov`/`moof`, MPEG-TS `0x47`, WebM EBML) rejects XML/MPD/HTML/JSON/images; `HttpRangeValidator` enforces RFC 9110 length + ETag + Last-Modified checks on HTTP 416 & 206; final output undergoes Android `MediaExtractor` track check before export. Verified by 19 assertions in `AndroidCoreSelfTest.java`. |
| **DSH-12 Sandbox Audit (`tools/fs-audit-monitor.mjs`)** | Silent false-clean results when OS watchers error, overflow, or miss deep-subdirectory / ephemeral create-then-delete writes | Recursive OS watching enabled on protected dirs (Windows `ReadDirectoryChangesW`, macOS `FSEvents`, Linux recursive walk `inotify`). Watcher errors or protected event buffer overflow set `auditComplete: false` and throw `SANDBOX_AUDIT_INCOMPLETE` instead of reporting clean. Verified in `tests/dsh12-fs-audit.test.mjs`. |
| **Supply-Chain Updater (`tools/updater.mjs`)** | Conflating same-channel `SHA256SUMS.txt` with independent cryptographic signing | `downloadAndVerifyUpdate` strictly restricts URLs to `https://github.com/KaiserIIII/videosave/releases/download/`, verifies `SHA256SUMS.txt`, attempts independent `gh attestation verify` (GitHub Sigstore OIDC provenance) when `gh` is present, explicitly reports `trustLevel` (`sigstore-provenance-verified` vs `sha256-same-channel-only`), backs up `settings.sqlite`, and **never** auto-executes downloaded installers. |
| **Unix Auto-Bootstrap (`tools/start-unix.sh`)** | Compromised upstream runtime downloads | Both Node.js `v24.22.3` and `yt-dlp 2026.11.23` (`yt-dlp_macos`, `yt-dlp_linux`, `yt-dlp_linux_aarch64`) are verified against pinned official SHA-256 digests before moving into `~/.local/share/videosave/tools`. |
| **Android Signing Hygiene (`tools/build_android_apk.py`)** | Accidental commit of release keystores or misrepresenting ephemeral debug APKs as upgradeable release builds | Zero `.jks`/`.keystore` files in Git. Ephemeral debug builds are explicitly named `-android-debug.apk`; formal `-android-universal.apk` requires user-supplied CI secrets. |
| **Anti-Bypass / Legal Boundaries** | Circumventing DRM, paywalls, CAPTCHAs, or HTTP 401/403/451 | Strictly preserved across Desktop, Extension, MCP, and Android. Bilibili official `backup_url` failover applies **only** to CDN 5xx/567 edge errors and transient socket failures, never 401/402/403/451 or DRM. |

## 2. Privacy & Repository Leak Scan
- Full staged index & release archives scanned for personal usernames, cloud-sync folders, personal download paths, cookies, tokens, and signing keys: **0 leaks in working tree and release packages**.
- Existing Git history was **not** rewritten.
