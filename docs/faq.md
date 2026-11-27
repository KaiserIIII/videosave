# VideoSave FAQ

### Does VideoSave require installing Node.js, Python, or FFmpeg manually?
No on Windows: run `Install VideoSave.cmd` or `Start VideoSave.cmd` and VideoSave automatically downloads and SHA-256-verifies pinned Node.js 24, FFmpeg 8.1.2, and yt-dlp into `%LOCALAPPDATA%\VideoSave\tools` without touching your system `PATH`. On macOS/Linux, install Node.js 24+ and FFmpeg (e.g. via Homebrew or your system package manager) and run `./tools/start-unix.sh`.

### Does VideoSave collect telemetry, browsing history, or read my system browser cookies?
No. VideoSave is 100% local-first with zero analytics or cloud relays. It never reads system browser profiles, saved passwords, or unrelated cookies. Isolated login sessions live strictly inside VideoSave's own `<stateDir>/VideoSave/profiles/<id>` folder.

### Why does VideoSave refuse DRM streams or Cloudflare challenge cookies?
VideoSave respects website authorization and DRM boundaries. Protected Widevine/PlayReady/FairPlay/SAMPLE-AES streams and anti-bot bypasses are explicitly out of scope. For websites requiring normal sign-in or interactive verification, open the site once in a dedicated headed browser session (`profileMode: "dedicated"` + `mode: "headed"`).

### How do I open the Local Management Center?
Start the companion (`Start VideoSave.cmd` on Windows or `./tools/start-unix.sh` on macOS/Linux), then open `http://127.0.0.1:8765/console` in your browser and enter the local pairing code printed in the terminal.

### My AI client (DeepSeek Harness / Codex / Claude / Cursor) still shows old tools after upgrading!
Run the `get_version` MCP tool to check `version` vs `installedVersion` and `entry`. Many MCP clients keep a persistent background stdio process or point their config file at an older extracted directory. Generate an updated config in the Local Management Center (`/console` → MCP & AI) or via `./tools/start-unix.sh --mcp-config --client <name>`, update the path, and restart the MCP client.

### Will uninstalling VideoSave delete my downloaded videos?
Never. `Uninstall VideoSave.cmd` only removes the application folder, shortcuts, and user registry entry; downloaded video files are never touched.
