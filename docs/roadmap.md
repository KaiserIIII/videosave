# VideoSave Roadmap

## Delivered Milestones

### v1.0.0 — DSH Remediation & Core Reliability
- Unified `RequestContext` propagating `Referer`, `Origin`, and `User-Agent` across HLS/DASH/Range/FFmpeg with strict cross-origin Cookie isolation.
- Binary `MediaInspector` handling non-standard segment extensions (`.jpeg`, `.png`, extensionless), fMP4, custom-wrapped TS, WebVTT, and AES-128 post-decrypt checks.
- SHA-256 checkpoint resume tested under SIGKILL, single-segment corruption, service restarts, and signed URL refresh.
- Dedicated isolated browser sessions (`profileMode: "dedicated"`, `browserSessionId`, custom UA, proxy) and mandatory test sandbox isolation.

### v1.1.0 — Ultimate Multi-Engine & Local Control Center
- Local Management Center (`/console`) with pairing auth, real-time queue, diagnostics, and 6-client MCP config generator.
- Multi-engine scheduler (`engine-scheduler.mjs`), adaptive rate controller (`rate-controller.mjs`), 2,000-segment resume stress verification, and native static DASH / WebM DASH support.

### v1.2.0 — Production Ready Cross-Platform Installers & Android Beta
- Native Windows graphical `Setup.exe` (WinForms, zero admin, silent `/S`) and true zero-network `win-x64-offline.zip`.
- Self-bootstrapping macOS/Linux launcher (`start-unix.sh`), `.command` launchers, and deterministic Debian `.deb`.
- Browser Launch State Machine (`BROWSER_STAGES`) resolving Windows Chrome CI startup instability.
- LL-HLS (`EXT-X-PART`/`PRELOAD-HINT`/`SERVER-CONTROL`), sliding-window live HLS, and Dynamic DASH bounded recording.
- Standalone native Android Beta APK (`aapt2 + javac + d8 + zipalign + apksigner`) and official Release update verifier.

### v1.3.0 — Compatibility & Reliability (Current)
- **Native Bilibili Engine (`bilibili-native`)**: Zero `yt-dlp` required; solves HTTP 567 via official UPOS CDN mirror ranking & automatic `backup_url` failover, multi-connection Range resume, lossless FFmpeg MP4 muxing, multi-P, bare BV ID, `b23.tv` short links, audio-only, and legal subtitles — **11/11 real public Bilibili videos verified by FFprobe + bitstream decode (361+ MB, 100%)**.
- **Android Core Fixes & Modern UI**: Real Static DASH downloader + `MediaMuxer` muxing (never saves MPD XML as MP4), strict RFC 9110 HTTP 416/206 validator, streaming HLS with SHA-256 checkpoints & independent audio mux, native Bilibili on Android, persistent queue with Pause/Resume/Retry/Boot recovery, modern 4-tab UI, and automated `AndroidCoreSelfTest` JVM suite on every build & CI.
- **Hardened DSH-12 OS Audit**: Recursive OS kernel watchers on protected dirs catching create+immediate-delete and deep-subdir writes; strict incompleteness failure on watcher errors or event overflow.
- **Fair Multi-Round Competitor Benchmark**: Monotonic-PTS 120s HLS fixture with strict FFprobe + full decode qualification gate across VideoSave, FFmpeg, and yt-dlp (honestly invalidating the v1.2.0 repeated-PTS yt-dlp sample).
- **Expanded Native Public Platforms & Registry**: Built-in Internet Archive & Wikimedia Commons adapters + honest `platform-registry.mjs` capability matrix; macOS/Linux `start-unix.sh` auto-bootstraps SHA-256-verified `yt-dlp`; updater distinguishes Sigstore provenance from same-channel `SHA256SUMS.txt`.

## Upcoming Milestones (v1.4+)
- **Formal Android Release Signing & Mate 60 Pro Hardware Sign-Off**: Configure protected user-held signing keystore in GitHub Secrets to ship `VideoSave-*-android-universal.apk` with seamless in-place upgrades and real-device HarmonyOS 4.x verification.
- **HarmonyOS NEXT (ArkTS) Native App**: Build an ArkTS native HAP package once DevEco Studio & HarmonyOS signing environment is available.
- **Extension Store & Package Manager Submissions**: Submit signed builds to Microsoft Edge Add-ons, Chrome Web Store, Firefox AMO, Winget, Scoop, Homebrew, and Official MCP Registry (each requires publisher credentials & external review).
- **macOS Apple Developer Notarization**: Sign and notarize universal `.dmg`/`.pkg` installers once an Apple Developer ID certificate is provisioned.
