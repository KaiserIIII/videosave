# VideoSave Official Store & Package Registry Submission Kit

This directory contains ready-to-submit distribution manifests and store metadata for VideoSave. None of these channels are claimed as already published—submission to third-party stores requires maintainer developer accounts, store review, or upstream PR approval.

## 1. Chrome Web Store & Microsoft Edge Add-ons
- **Upload artifact**: `VideoSave-<version>-extension.zip` (MV3 service worker, zero `browser_specific_settings`).
- **Permissions Justification**:
  - `activeTab`: Inspect media elements and playback state on the active tab when invoked by the user.
  - `alarms`: Maintain periodic local companion health checks and cleanup timers.
  - `downloads`: Trigger browser-native saves for direct media URLs when requested by the user.
  - `offscreen`: Perform in-browser HLS/fMP4 segment assembly when no local companion is connected.
  - `scripting`: Inject isolated read-only media scanners into the current tab.
  - `storage`: Persist user UI preferences, theme, and paired companion settings locally.
  - `webRequest`: Observe media response headers (MIME type, Content-Length, manifest URLs) for accurate detection.
  - `cookies` (optional): Requested only if the user explicitly approves sharing same-origin session state for one authorized tab.
- **Privacy Policy URL**: `https://github.com/KaiserIIII/videosave/blob/main/docs/privacy.md`
- **Single Purpose**: Discover, preview, and download authorized web video/audio streams using local-only processing.

## 2. Firefox Add-ons (AMO) & Firefox Android
- **Desktop artifact**: `VideoSave-<version>-firefox.zip` (gecko ID `videosave@local.extension`, `data_collection_permissions: { required: ["none"] }`, minimum Firefox 136.0).
- **Android artifact**: `VideoSave-<version>-android-dev.zip` (`gecko_android` enabled, `downloads` permission removed for Android compatibility).
- **Source submission**: Attach GitHub release source archive (pure vanilla ESM, zero bundler/minification required!).

## 3. Winget, Scoop & Homebrew
1. After the official GitHub Release tag is published, replace `REPLACE_WITH_RELEASE_SHA256_AFTER_TAG_BUILD` in:
   - `packaging/winget/KaiserIIII.VideoSave.yaml` (from `VideoSave-<ver>.zip` SHA-256)
   - `packaging/scoop/videosave.json` (from `VideoSave-<ver>.zip` SHA-256)
   - `packaging/homebrew/videosave.rb` (from `VideoSave-<ver>-unix.tar.gz` SHA-256)
2. Submit PRs to `microsoft/winget-pkgs`, your Scoop bucket (or `ScoopInstaller/Extras`), and your Homebrew tap (`brew tap KaiserIIII/videosave`).

## 4. Official MCP Registry
- Publish `packaging/mcp-registry/server.json` via `mcp-publisher publish` once GitHub OIDC authentication for `io.github.kaiseriiii` is enabled by the repository owner.
