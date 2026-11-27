# Install, upgrade, and remove VideoSave

Use the [official Releases page](https://github.com/KaiserIIII/videosave/releases/latest). Compare archives with SHA256SUMS.txt before loading an unpacked extension or running its launcher. PowerShell can show a file SHA-256 with `Get-FileHash -Algorithm SHA256 -LiteralPath 'VideoSave-0.10.0.zip'`.

For Edge or Chrome, extract the desktop or Chromium-only ZIP and load the extension using your browser's developer mode. Firefox requires a signed build for permanent normal installation. The Firefox developer ZIP can be installed temporarily from `about:debugging`. The Android developer ZIP is experimental.

On Windows x64, open `Start VideoSave.cmd` from the extracted desktop package. It can reuse cached tools and prepares missing pinned dependencies. The extension's local service panel accepts the address and pairing code shown by the launcher. Direct file downloads can start without pairing.

Extract an upgrade into a fresh directory and load the new source. Browser storage is tied to the extension identity. Export browser settings under **Settings → Backup and updates** before changing the unpacked extension path. The shared Windows settings database and cached tools live under `%LOCALAPPDATA%\VideoSave`.

To uninstall, remove the browser extension, stop the companion, and remove the extracted program directory. The optional local settings and tool cache can be removed separately when you no longer need them. Keep your downloads directory independent from the program directory. The project distributes portable archives and developer extension packages. Store submissions, signing, MSI, Winget, and Scoop have separate verification requirements.

## Store submission materials

Use the real extension screenshots in the project docs, the [privacy policy](privacy.md), and the package for the intended browser. The extension requests active-tab scripting, request observation, local settings and queue storage, downloads and alarms for queue updates, and Chromium offscreen processing for compatible HLS. HTTP and HTTPS hosts are needed for user-selected pages and their media requests. Review current store-specific publisher and packaging requirements before submission.
