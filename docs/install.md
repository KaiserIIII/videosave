# Install, Upgrade, and Uninstall VideoSave (v1.3.2)

Download official release packages from the [GitHub Releases page](https://github.com/KaiserIIII/videosave/releases/latest) or the [official website](https://kaiseriiii.github.io/videosave/) (which auto-detects your OS and recommends the right package).

## 1. Windows x64 (No Admin Rights, Zero Manual Dependencies)

Choose one of three official options:

1. **Graphical Installer (Recommended)** — `VideoSave-1.3.2-Setup.exe`
   - Native Windows WinForms wizard; installs to `%LOCALAPPDATA%\Programs\VideoSave` without administrator privileges or `PATH` modifications.
   - Automatically prepares SHA-256-verified Node.js 24.22.3 LTS, FFmpeg 8.1.2, and yt-dlp 2026.11.23, then opens the Local Management Center (`http://127.0.0.1:8765/console`).
   - Supports silent unattended installs: `VideoSave-1.3.2-Setup.exe /S /D=C:\Path\To\VideoSave`.
   - *Code-signing disclosure*: `Setup.exe` is currently unsigned (no paid Authenticode EV certificate is configured); Windows SmartScreen may show "More info → Run anyway". Always verify `SHA256SUMS.txt` and `gh attestation verify` first.
2. **True Offline Portable ZIP** — `VideoSave-1.3.2-win-x64-offline.zip` (~133 MB)
   - Bundles Node.js 24.22.3, FFmpeg/FFprobe 8.1.2, and yt-dlp 2026.11.23 inside `.local-tools/`.
   - Works in **zero-internet, zero-PATH** clean Windows environments; extract and double-click `Start VideoSave.cmd`.
3. **Lightweight Portable ZIP** — `VideoSave-1.3.2.zip` (~810 KB)
   - Extract and double-click `Start VideoSave.cmd`. Bilibili (`bilibili-native`), Internet Archive, Wikimedia Commons, HLS, DASH, and HTTP Range work natively without `yt-dlp`; YouTube uses the managed `yt-dlp` binary.

## 2. Linux (x64 & ARM64) and macOS (Apple Silicon & Intel)

- **Debian / Ubuntu**: Install `videosave_1.3.2_all.deb` via `sudo apt install ./videosave_1.3.2_all.deb` (registers `videosave`, `videosave-cli`, `videosave-mcp`).
- **Other Linux Distros & macOS**: Extract `VideoSave-1.3.2-unix.tar.gz` and run `./tools/start-unix.sh` (or double-click `Launch VideoSave.command` on macOS).
  - **Linux x64 & ARM64**: Automatically downloads and SHA-256-verifies Node.js `24.22.3`, **FFmpeg/FFprobe `8.1.3`** (immutable BtbN release `autobuild-2026-11-27-12-42`), and `yt-dlp 2026.11.23` into `~/.local/share/videosave/tools` if not already installed on the system.
  - **macOS (Apple Silicon & Intel)**: Automatically downloads and SHA-256-verifies Node.js `24.22.3` and `yt-dlp 2026.11.23`, reuses Homebrew/system FFmpeg (`/opt/homebrew/bin/ffmpeg` or `/usr/local/bin/ffmpeg`), and prints exact `brew install ffmpeg` guidance if FFmpeg is absent.
  - *Honesty note*: CI verifies Ubuntu 24.04 x64 and macOS 15 ARM64 directly; Linux ARM64 and Intel macOS binaries use pinned official upstream SHA-256 hashes but are not executed on physical ARM64 Linux / Intel Mac CI runners. macOS packages are not Apple Developer ID notarized (right-click → Open on first run).

## 3. Android 8–16 & Huawei Mate 60 Pro (HarmonyOS 4.x) — Beta APK

- Download `VideoSave-1.3.2-android-debug.apk` (or `VideoSave-1.3.2-android-universal.apk` once persistent release signing Secrets are configured).
- Zero Root, zero Termux, zero Python. Verified live on Android 16 Emulator (`docs/compatibility-data/v1.3.1-android-runtime.json`); Huawei Mate 60 Pro physical sign-off pending real device.
- See [docs/android-harmonyos.md](android-harmonyos.md) for signing migration and HarmonyOS 4.x vs HarmonyOS NEXT details.

## 4. Browser Extensions & MCP (DSH / Codex / Claude / Cursor / Antigravity)

- **Edge / Chrome / Brave**: Load `extension/` from the desktop package or extract `VideoSave-1.3.2-extension.zip` via Developer Mode (store listing packages ready; not yet published on Chrome Web Store / Edge Add-ons).
- **Firefox 136+**: Load `VideoSave-1.3.2-firefox.zip` temporarily via `about:debugging` (AMO submission pending review).
- **MCP Setup**: Run `.\Start VideoSave.cmd -McpConfig` (Windows) or `./tools/start-unix.sh --mcp-config --client deepseek-harness` (macOS/Linux). See [docs/dsh-guide.md](dsh-guide.md).

## 5. Supply-Chain Verification, Upgrading & Uninstalling

```powershell
# 1. Verify same-channel SHA-256 digest against SHA256SUMS.txt
Get-FileHash -Algorithm SHA256 -LiteralPath 'VideoSave-1.3.2-Setup.exe'

# 2. Verify independent GitHub Sigstore OIDC Build Provenance (recommended)
gh attestation verify VideoSave-1.3.2-Setup.exe --repo KaiserIIII/videosave
```

- **Upgrading DSH safely**: `node tools/upgrade-dsh.mjs --package="<path>"` (dry-run by default; add `--apply` to create a timestamped `.bak` backup and verify `get_version`).
- **Uninstalling**: Use Windows Add/Remove Programs (for `Setup.exe`), `Uninstall VideoSave.command` (macOS), `./tools/start-unix.sh --uninstall` (Linux), or delete the extracted portable folder. Your downloaded videos and history are never deleted.
