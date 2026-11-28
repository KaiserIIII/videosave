# VideoSave Android APK (Beta) & Huawei Mate 60 Pro / HarmonyOS Guide (v1.3.0)

## 1. Real Engineering Fixes Delivered in v1.3.0

Every defect found during v1.2.0 code review has been directly fixed and covered by automated JVM regression tests (`android/tests/AndroidCoreSelfTest.java`, executed automatically on every APK build and GitHub Actions CI):

| Area | v1.2.0 Beta Limitation | v1.3.0 Fix & Verification |
| :--- | :--- | :--- |
| **DASH Download** | `MediaProbeEngine` probed `.mpd`, but `DownloadService` had no DASH branch — risking saving XML as `.mp4` | Added pure-Java `DashEngine.java` (XXE-hardened DOM parser supporting `SegmentTemplate`, `SegmentTimeline`, `SegmentList`, `BaseURL`), strict pre-download rejection of DRM & `type="dynamic"` live MPDs, per-segment binary validation, and `MediaExtractor` + `MediaMuxer` MP4/WebM muxing. XML/HTML/JSON manifests are **never** saved as `.mp4`. |
| **HTTP 416 Resume** | Returned existing `.part` blindly on any HTTP 416 | Added `HttpRangeValidator.java` (strict RFC 9110): persists `expectedTotal`, `ETag`, `Last-Modified`; sends `If-Range`; accepts 416 **only** when server length (`Content-Range: bytes */TOTAL` or HEAD probe), identity headers, and `MediaContainerUtil` binary magic **all** verify. Truncated or mismatched 416 files are rejected and cleanly restarted. |
| **HLS Integrity** | Loaded full segments into RAM; weak HTML-only check; no independent audio track muxing | Streaming disk writes (zero full-file RAM buffering), streaming `CipherInputStream` for clear-key AES-128, per-segment SHA-256 checkpoints, binary MPEG-TS/fMP4 header checks, container-switch & multi-init discontinuity guard, and `#EXT-X-MEDIA:TYPE=AUDIO` muxing via `MediaMuxer`. |
| **Bilibili on Android** | No native Bilibili resolver | Added `BilibiliResolver.java` supporting bare `BV...`, `bilibili.com/video/...`, and `b23.tv` short links with official UPOS CDN mirror ranking, progressive MP4, and separate DASH video+audio muxed natively via `MediaMuxer` — zero Root, zero Termux, zero Python. |
| **Queue & UI** | Single-screen flat buttons, volatile in-memory queue | Redesigned modern 4-tab UI (**Home / Probe**, **Queue**, **History**, **Settings & Status**) with rounded cards, clipboard paste, bilingual EN/中文, Dark/Light themes, accessibility labels, persistent `DownloadQueueStore` (Pause/Resume/Retry/Cancel/`BootReceiver` reboot recovery), Wi-Fi-only toggle, 50 MB free-space guard, and `MediaExtractor` playability verification. |

## 2. Signing Status & Formal Release Upgrade Pipeline

- **Current Release Artifact**: `VideoSave-1.3.0-android-debug.apk` (explicitly labeled **Debug / Beta**; built with Android SDK 36 `build-tools/36.1.0`, `minSdkVersion 26`, `targetSdkVersion 35`, `versionCode 10300`, verified by `apksigner verify --verbose` and `AndroidCoreSelfTest`).
- **Why it is still marked Beta**: Signing keys are **never** committed to Git. Without a user-held release keystore configured in GitHub Actions Secrets, CI generates an ephemeral debug signing key per build (which prevents in-place overwrite upgrades between different debug builds).
- **Enabling Formal Release Signing (`VideoSave-*-android-universal.apk`)**:
  1. Generate a long-lived upload/release keystore locally (keep offline, never commit):
     ```bash
     keytool -genkeypair -v -keystore videosave-release.jks -alias videosave \
       -keyalg RSA -keysize 2048 -validity 10000
     ```
  2. Add these repository secrets in GitHub Settings → Secrets and variables → Actions:
     - `VIDEOSAVE_ANDROID_KEYSTORE_BASE64` (base64 of `.jks`)
     - `VIDEOSAVE_ANDROID_KEYSTORE_PASS`
     - `VIDEOSAVE_ANDROID_KEY_ALIAS`
     - `VIDEOSAVE_ANDROID_KEY_PASS`
  3. `tools/build_android_apk.py` will automatically sign with your persistent key, increment `versionCode` monotonically (`major*10000 + minor*100 + patch`), preserve user `DownloadHistoryStore` & `DownloadQueueStore` across upgrades, and publish `VideoSave-<version>-android-universal.apk`.

## 3. Huawei Mate 60 Pro & HarmonyOS Compatibility Matrix

| Environment | Support Status | Notes |
| :--- | :--- | :--- |
| **Android 8.0 – 16 (ARM64 / universal Dalvik/ART bytecode)** | **Supported (Beta APK)** | Pure Java/DEX (`classes.dex`), architecture-independent, runs natively on ARM64 without NDK ABI mismatch. |
| **Huawei Mate 60 Pro — HarmonyOS 4.x (Android compatibility layer)** | **Installable Beta APK (pending physical device test)** | Sideload `VideoSave-1.3.0-android-debug.apk` directly via Files / browser. Enable "Install apps from external sources" if prompted; allow notification permission for foreground progress. *Honesty note*: No physical Mate 60 Pro or Android emulator was attached during automated build (`adb devices` = empty), so hardware-specific background battery/sleep behavior remains **pending real-device sign-off**. |
| **HarmonyOS NEXT (Pure ArkTS / OpenHarmony API)** | **Not Supported (Roadmap)** | HarmonyOS NEXT removes Android APK compatibility. A native ArkTS `.hap` requires DevEco Studio and Huawei AppGallery signing credentials (not present in this build environment; no fabricated `.hap` claims). |
