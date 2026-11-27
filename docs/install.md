# Install, upgrade, and remove VideoSave

Use the [stable Releases page](https://github.com/KaiserIIII/videosave/releases/latest) or choose a [published release](https://github.com/KaiserIIII/videosave/releases). Compare the downloaded ZIP with the matching entry in `SHA256SUMS.txt` before loading an unpacked extension or running its launcher. PowerShell can show a file SHA-256 with `Get-FileHash -Algorithm SHA256 -LiteralPath 'VideoSave-1.0.0.zip'`. GitHub provenance can be checked with `gh attestation verify <archive> --repo KaiserIIII/videosave`. For DeepSeek Harness (DSH) setup and stale-version upgrade verification (`get_version`), see [docs/dsh-guide.md](dsh-guide.md).

For Edge or Chrome, extract the desktop or Chromium-only ZIP and load the extension using your browser's developer mode. Firefox requires a signed build for permanent normal installation. The Firefox developer ZIP can be installed temporarily from `about:debugging`. The Android developer ZIP is experimental.

On Windows x64, open `Start VideoSave.cmd` from the extracted desktop package. It can reuse cached tools and prepares missing pinned dependencies. The extension's local service panel accepts the address and pairing code shown by the launcher. Direct file downloads can start without pairing.

Extract an upgrade into a fresh directory and load the new source. Browser storage is tied to the extension identity. Export browser settings under **Settings → Backup and updates** before changing the unpacked extension path. The shared Windows settings database and cached tools live under `%LOCALAPPDATA%\VideoSave`.

To uninstall, remove the browser extension, stop the companion, and remove the extracted program directory. The optional local settings and tool cache can be removed separately when you no longer need them. Keep your downloads directory independent from the program directory. The project distributes portable archives and developer extension packages. Store submissions, signing, MSI, Winget, and Scoop have separate verification requirements.

## Store submission materials

Use the real extension screenshots in the project docs, the [privacy policy](privacy.md), and the package for the intended browser. The extension requests active-tab scripting, request observation, local settings and queue storage, downloads and alarms for queue updates, and Chromium offscreen processing for compatible HLS. HTTP and HTTPS hosts are needed for user-selected pages and their media requests. Review current store-specific publisher and packaging requirements before submission.

Chrome Web Store and Edge Add-ons can use the Chromium archive as the submission input. Mozilla Add-ons uses the desktop Firefox manifest and a separately signed archive. For a review walkthrough, load a public test video, open the panel and save it. To review companion and MCP behavior, start the portable package, pair it, register a client and approve your test tab. Cookie access is optional and requested in the authorization flow.

The MCP server currently ships as a local stdio script in the portable ZIP. `Start VideoSave.cmd -McpConfig` supplies the absolute executable path and script arguments for client setup. For a registry submission, the proposed name is `io.github.kaiseriiii/videosave`. Validate the metadata against the official publisher requirements after a supported package can reproduce the local launcher setup and its runtime checks. The managed settings require `MEDIA_TOOLKIT_URL` and the locally registered `MEDIA_TOOLKIT_MCP_CLIENT` identifier. The initial launch should be verified from a clean user profile using the published package. See the [official registry submission requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md).

Winget and Scoop would also need their own submission and install or upgrade validation.
