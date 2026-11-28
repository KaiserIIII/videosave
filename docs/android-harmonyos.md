# VideoSave Android & Huawei HarmonyOS (Mate 60 Pro) Support Guide

## Support Matrix

| Device / OS | Route A: Standalone Android APK | Route B: Firefox Android Extension | Status |
| :--- | :--- | :--- | :--- |
| **Android 8.0 – 16 (ARM64-v8a / ARMv7 / x86_64)** | **Supported (Beta APK)** — direct install, zero Root, zero Termux, zero Python | Supported (Firefox Nightly / custom add-on collection; AMO signing prepared) | Real APK built & verified via `apksigner` + `aapt2`; formal release keystore pending developer certificate |
| **Huawei Mate 60 Pro — HarmonyOS 4.x** (Android compatibility layer) | **Supported (Beta APK)** — installs via standard APK installer (`Unknown sources` / `Pure Mode` opt-in) | Supported via Firefox Android | Compatible with HarmonyOS 4.x Android runtime; physical Mate 60 Pro on-device test pending user verification |
| **Huawei Mate 60 Pro — HarmonyOS NEXT (5.0+)** | **Not Supported** — HarmonyOS NEXT removes native Android APK execution | Not Supported | See **HarmonyOS NEXT ArkTS/ArkUI Roadmap** below; use Desktop Companion `/console` in the meantime |

---

## Route A: Standalone Android APK

### What's Inside (`android/`)
Built strictly with official Android SDK 36 (`minSdkVersion 26`, `targetSdkVersion 35`, pure Java 8 / ART bytecode — native performance on **ARM64-v8a** without bloated native runtime bundles):

- **Standalone App & Launcher Icon**: No browser debugging menu, no Termux, no Python, no Root required.
- **Android Share Menu Integration (`ACTION_SEND`)**: Share links directly from Huawei Browser, Chrome, Firefox, or media apps into VideoSave.
- **Media Probe & 2-Byte Quality Availability**: Probes Direct MP4/Audio, HLS Master/Variant playlists (with 2-byte Range availability check), static DASH manifests, and static HTML pages. Never bypasses HTTP 401/403/451 or DRM.
- **Foreground Service + Notification Progress Bar**: Android 14/15 compliant (`foregroundServiceType="dataSync"`, runtime `POST_NOTIFICATIONS` request) with live progress percentage and Cancel button.
- **Resumable Downloads**:
  - HTTP Range `.part` checkpoint resume
  - Native HLS segment downloader with `checkpoint.properties` resume and authorized clear-key AES-128 decryption (`javax.crypto.Cipher`)
  - Serial batch queue (paste multiple URLs one per line)
- **Scoped Storage & System Gallery Integration**: Exports completed files to `Downloads/VideoSave/` via `MediaStore.Downloads` (Android 10–16 compliant; no broad external storage permission needed).
- **Download History & In-App Preview**: Local private history (`videosave-history.json`) with tap-to-play via Android system player.
- **Bilingual EN / 中文 & Dark / Light Themes**.

### Debug Build vs Formal Release Signed APK
- **Signing keys are NEVER committed to GitHub.**
- When release signing secrets (`VIDEOSAVE_ANDROID_KEYSTORE`, `VIDEOSAVE_ANDROID_KEYSTORE_PASS`, `VIDEOSAVE_ANDROID_KEY_ALIAS`) are configured in the build environment, `python tools/build_android_apk.py` outputs a formally signed **`VideoSave-1.2.0-android-universal.apk`**.
- Without formal release secrets, the build generates an ephemeral build-time signing key (deleted immediately after build) and explicitly labels the artifact **`VideoSave-1.2.0-android-debug.apk`** so test/beta builds are never misrepresented as formally release-signed APKs.

### Installing on Huawei Mate 60 Pro (HarmonyOS 4.x)
1. Download `VideoSave-1.2.0-android-debug.apk` (or formally signed `-android-universal.apk` once release signing is configured) from [GitHub Releases](https://github.com/KaiserIIII/videosave/releases/latest).
2. On HarmonyOS 4.x, open **Files**, tap the `.apk`, and allow installation when prompted by HarmonyOS Pure Mode / security check (if installing a debug-signed build, HarmonyOS may ask for confirmation for an unrecognized developer signature).
3. Grant notification permission on first launch to see background download progress in the notification shade.

---

## Route B: Firefox Android Extension
- Packaged as `VideoSave-1.2.0-firefox.zip` and `VideoSave-1.2.0-android-dev.zip` (`gecko_android` strict_min_version `136.0`, minimal permissions without desktop `downloads`/`offscreen`).
- Ordinary Firefox stable requires Mozilla AMO signing (see `packaging/stores/SUBMISSION-GUIDE.md`). Disabling signature checks is **not** recommended for normal users.

---

## HarmonyOS NEXT (5.0+ Pure HarmonyOS) Feasibility & ArkTS Roadmap
HarmonyOS NEXT removes the Android runtime (AOSP/ART), so neither `.apk` nor Android Firefox can run natively.

- **Technical Assessment**:
  - **UI & Share Intake**: ArkUI (ArkTS) + `Share Kit` (`systemShare`) replaces Android `ACTION_SEND`.
  - **Networking & HLS/HTTP Engine**: `@ohos.net.http` / `@ohos.request` background agent + ArkTS port of `extension/hls.mjs` and `tools/quality-negotiator.mjs` (TypeScript/ESM logic shares ~80% conceptual parity with ArkTS!).
  - **Media Storage**: `@ohos.file.photoAccessHelper` / `@ohos.file.fs` replaces `MediaStore.Downloads`.
  - **Build & Signing Requirements**: Requires **DevEco Studio** + HarmonyOS SDK + Huawei AppGallery Connect developer certificate/provisioning profile (not available on standard GitHub Actions runners or this host).
- **Current Status**: **Planned (Not Built in v1.2.0)** — clearly labeled as planned until DevEco Studio SDK + Huawei developer signing environment is provisioned.
