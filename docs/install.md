# Install, Upgrade, and Uninstall VideoSave (v1.3.0)

Download official release packages from the [GitHub Releases page](https://github.com/KaiserIIII/videosave/releases/latest) or the [official website](https://kaiseriiii.github.io/videosave/) (which auto-detects your OS and recommends the right package).

## 1. Windows x64 (No Admin Rights, Zero Manual Dependencies)

Choose one of three official options:

1. **Graphical Installer (Recommended)** — `VideoSave-1.3.0-Setup.exe`
   - Native Windows wizard; installs to `%LOCALAPPDATA%\Programs\VideoSave` without administrator privileges or `PATH` modifications.
   - Automatically prepares SHA-256-verified Node.js 24 LTS, FFmpeg 8.1.2, and yt-dlp 2026.11.23, then opens the Local Management Center (`http://127.0.0.1:8765/console`).
   - Supports silent unattended installs: `VideoSave-1.3.0-Setup.exe /S /D=C:\Path\To\VideoSave`.
2. **True Offline Portable ZIP** — `VideoSave-1.3.0-win-x64-offline.zip` (~133 MB)
   - Bundles Node.js 24.22.3, FFmpeg/FFprobe 8.1.2, and yt-dlp 2026.11.23 inside `.local-tools/`.
   - Works in **zero-internet, zero-PATH** environments; just extract and run `Start VideoSave.cmd`.
3. **Lightweight Portable ZIP** — `VideoSave-1.3.0.zip` (~750 KB)
   - Extract and double-click `Start VideoSave.cmd`. Bilibili, Internet Archive, Wikimedia Commons, HLS, DASH, and HTTP Range work natively with only FFmpeg; YouTube auto-downloads pinned `yt-dlp` on first setup.

## 2. macOS (Apple Silicon & Intel) and Linux (x64 & ARM64)

- **Debian / Ubuntu**: Install `videosave_1.3.0_all.deb` via `sudo apt install ./videosave_1.3.0_all.deb` (registers `videosave`, `videosave-cli`, `videosave-mcp`).
- **macOS & Other Linux Distros**: Extract `VideoSave-1.3.0-unix.tar.gz` and run `./tools/start-unix.sh` (or double-click `Launch VideoSave.command` on macOS).
  - Automatically downloads and SHA-256-verifies Node.js 24.22.3 LTS and `yt-dlp 2026.11.23` into `~/.local/share/videosave/tools`.
  - If `ffmpeg`/`ffprobe` is absent on macOS/Linux, install via `brew install ffmpeg` or `sudo apt install ffmpeg`.
  - *Honesty note*: macOS builds are not yet Apple Developer ID notarized; Gatekeeper may prompt for right-click → Open on first run.

## 3. Android 8–16 & Huawei Mate 60 Pro (HarmonyOS 4.x) — Beta APK

- Download `VideoSave-1.3.0-android-debug.apk` (or `VideoSave-1.3.0-android-universal.apk` once release-signed).
- Zero Root, zero Termux, zero Python. Supports native Bilibili, Static DASH (`MediaMuxer`), Resumable HLS, strict HTTP 416 Range resume, Share Menu intake, and `Downloads/VideoSave`.
- See [docs/android-harmonyos.md](android-harmonyos.md) for signing status and HarmonyOS 4.x vs HarmonyOS NEXT details.

## 4. Browser Extensions & MCP (DSH / Codex / Claude / Cursor / Antigravity)

- **Edge / Chrome / Brave**: Load `extension/` from the desktop package or extract `VideoSave-1.3.0-extension.zip` via Developer Mode.
- **Firefox 136+**: Load `VideoSave-1.3.0-firefox.zip` temporarily via `about:debugging` (permanent store signing pending AMO review).
- **MCP Setup**: Run `.\Start VideoSave.cmd -McpConfig` (Windows) or `./tools/start-unix.sh --mcp-config --client deepseek-harness` (macOS/Linux). See [docs/dsh-guide.md](dsh-guide.md).

## 5. Supply-Chain Verification & Upgrading

Verify every archive before running:

```powershell
# 1. Verify SHA-256 against SHA256SUMS.txt
Get-FileHash -Algorithm SHA256 -LiteralPath 'VideoSave-1.3.0-Setup.exe'

# 2. Verify independent GitHub Sigstore OIDC Provenance (recommended)
gh attestation verify VideoSave-1.3.0-Setup.exe --repo KaiserIIII/videosave
```

- **Upgrading DSH safely**: `node tools/upgrade-dsh.mjs --package="<path>"` (dry-run by default; add `--apply` to create a timestamped `.bak` backup and verify `get_version`).
- **Uninstalling**: Use Windows Add/Remove Programs (for `Setup.exe`), `Uninstall VideoSave.command` (macOS), `./tools/start-unix.sh --uninstall` (Linux), or delete the extracted portable folder. Your downloaded media folder is never deleted.
