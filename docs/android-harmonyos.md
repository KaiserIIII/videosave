# VideoSave Android APK (Beta) & Huawei Mate 60 Pro / HarmonyOS Guide (v1.3.1)

## 1. Real Engineering Fixes & Android 16 Runtime Verification (v1.3.1)

Every Android core path is verified by **both** our automated 24-assertion JVM test suite (`android/tests/AndroidCoreSelfTest.java`, run automatically on every APK build & CI) **and** live end-to-end execution on the **Android 16 (`android-36.1`) Emulator** (`docs/compatibility-data/v1.3.1-android-runtime.json`):

| Area | Fix & Reliability Guarantee (v1.3.1) | Verification Evidence |
| :--- | :--- | :--- |
| **Static DASH (`DashEngine.java`)** | XXE-hardened DOM parser (`SegmentTemplate`, `SegmentTimeline`, `SegmentList`, `BaseURL`), rejects DRM & dynamic live MPDs before download, muxes separate video+audio via Android `MediaExtractor` + `MediaMuxer`. Never saves XML/HTML/JSON as `.mp4`. | Verified live on Android 16 Emulator (`E2E_DASH_Muxed` pulled & decoded via FFprobe+FFmpeg) + `AndroidCoreSelfTest` |
| **Strict HTTP 416 / 206 (`HttpRangeValidator.java`)** | RFC 9110 validation: persists `expectedTotal`, `ETag`, `Last-Modified`; sends `If-Range`; rejects truncated/mismatched/HTML 416 & 206 files and cleanly restarts from byte 0. | `AndroidCoreSelfTest` (6 Range/416/206 assertions) |
| **Per-Task Cancel, Dedup & Cache Cleanup (`DownloadService.java`)** | Per-task cancellation set (cancelling one task never stops other queued tasks), immediate I/O loop stop on cancel/pause, duplicate active URL guard on network/tap bounce, 48h stale cache pruning, and immediate cache cleanup on cancel or unrecoverable 403/DRM/invalid-media errors. | Verified live on Android 16 Emulator (`android:exported="false"` confirmed; fake XML-as-MP4 rejected cleanly) |
| **Native Bilibili (`BilibiliResolver.java`)** | Bare `BV...`, `bilibili.com/video/...`, `b23.tv` short links, official UPOS CDN mirror ranking, DASH-first true pixel height clamping (never inflates 384p `durl` to 720p), and `MediaMuxer` MP4 output. HTTP `401/402/403/451/567` strictly abort without bypass. | `AndroidCoreSelfTest` + Bilibili real pixel alignment |
| **Modern 4-Tab UI & Backup Migration (`MainActivity.java`)** | Rounded-card 4-tab layout (Home/Probe, Queue, History, Settings), dynamic version & signing cert SHA-256 display, bare-BV batch support, Wi-Fi-only toggle, 50 MB free-space floor, and **Export History Backup (JSON)** to `Downloads/VideoSave/videosave-backup.json`. | Live screenshots captured on Android 16 Emulator (`docs/screenshots/android-home.png`, `android-queue.png`) |

## 2. Signing Status, Fingerprint Verification & Debug → Release Upgrade Migration

- **Current Release Artifact**: `VideoSave-1.3.1-android-debug.apk` (**Beta / Debug-Signed**; `applicationId: io.github.kaiseriiii.videosave`, `minSdkVersion 26`, `targetSdkVersion 35`, `versionCode 10301`).
- **Why still marked Beta**: Long-lived release signing keys are **never** committed to Git or generated without owner custody. Each CI run signs with an ephemeral debug key until the repository owner configures persistent signing Secrets.
- **Enabling Formal Release Signing (`VideoSave-<version>-android-universal.apk`)**:
  1. Generate a persistent keystore offline on your own machine (back it up securely; never commit to Git):
     ```bash
     keytool -genkeypair -v -keystore videosave-release.jks -alias videosave \
       -keyalg RSA -keysize 2048 -validity 10000
     ```
  2. Base64-encode `videosave-release.jks` and add these 4 repository Secrets in **GitHub → Settings → Secrets and variables → Actions**:
     - `VIDEOSAVE_ANDROID_KEYSTORE_BASE64`
     - `VIDEOSAVE_ANDROID_KEYSTORE_PASS`
     - `VIDEOSAVE_ANDROID_KEY_ALIAS`
     - `VIDEOSAVE_ANDROID_KEY_PASS`
  3. Future tagged builds automatically publish formally signed `VideoSave-<version>-android-universal.apk` with monotonically increasing `versionCode` (`major*10000 + minor*100 + patch`) and print the signing certificate SHA-256 fingerprint for user verification.
- **Upgrading Between Different Debug Builds (Without Losing History)**:
  1. Open VideoSave → **Settings & Status** → tap **Export History Backup (JSON)** (writes `Downloads/VideoSave/videosave-backup.json`; your downloaded videos in `Downloads/VideoSave/` are already stored in shared MediaStore storage and are never deleted on uninstall).
  2. Uninstall the previous ephemeral debug APK and install the new APK.
  3. Check the certificate SHA-256 fingerprint in **Settings & Status** once formally signed releases are enabled.

## 3. Huawei Mate 60 Pro & HarmonyOS Practical Usage Guide

| Environment | Support Status | Practical Guidance |
| :--- | :--- | :--- |
| **Android 8.0 – 16 (ARM64 / x86_64 ART)** | **Beta APK (Verified on Android 16 Emulator)** | Pure Dalvik/ART Java bytecode (`classes.dex`), zero native ABI mismatch. |
| **Huawei Mate 60 Pro — HarmonyOS 4.x (Android compatibility layer)** | **Installable Beta APK (Pending physical Mate 60 Pro sign-off)** | Sideload `VideoSave-1.3.1-android-debug.apk` from Files or browser. *Honesty note*: No physical Mate 60 Pro was attached during automated build (`adb devices` had emulator only), so HarmonyOS-specific sleep/keep-alive behavior remains **pending real-device verification**. |
| **HarmonyOS NEXT (5.0+ Pure ArkTS)** | **Not Supported (Roadmap)** | HarmonyOS NEXT removes Android APK compatibility. Building a verified native ArkTS `.hap` requires DevEco Studio + Huawei AppGallery signing credentials (not present in this build environment; no unverified `.hap` claims). |

### Mate 60 Pro (HarmonyOS 4.x) Recommended Settings Checklist
1. **Install from External Sources**: When prompted by HarmonyOS Pure Mode / App Guard, review the SHA-256 digest against `SHA256SUMS.txt` before allowing installation.
2. **Notifications**: Grant notification permission on first launch so the foreground download progress bar and Pause/Cancel buttons appear in the status bar.
3. **Background Keep-Alive & Screen Sleep**: For long downloads, open **Settings → Apps → App Launch → VideoSave** → switch to **Manage manually** and enable **Run in background** so HarmonyOS power management does not freeze transfers when the screen locks.
4. **Wi-Fi / 5G Switching**: Enable **Wi-Fi only** in VideoSave Settings if you want transfers to pause automatically when leaving Wi-Fi; checkpoints are preserved and resume once Wi-Fi returns.
5. **Share Menu, Files & Gallery**: Share any Bilibili or media link from browsers/apps directly to **VideoSave**; completed MP4/M4A files appear in Huawei **Files → Downloads → VideoSave** and system **Gallery / Video Player** automatically via `MediaStore`.
