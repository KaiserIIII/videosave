#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="${VIDEOSAVE_TOOLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/videosave/tools}"
PORT="${PORT:-8765}"

MODE="server"
CLIENT=""
SHARED_QUEUE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-only) MODE="setup"; shift ;;
    --health) MODE="health"; shift ;;
    --mcp-config) MODE="mcp-config"; shift ;;
    --shared-queue) SHARED_QUEUE=1; shift ;;
    --client) CLIENT="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./tools/start-unix.sh [OPTIONS]
  --setup-only        Verify Node.js >= 24, FFmpeg, FFprobe, and optional yt-dlp
  --health            Print JSON runtime health diagnostics
  --mcp-config        Print MCP client configuration (use --client NAME for native format)
  --client NAME       deepseek-harness | codex | claude-code | claude-desktop | cursor | antigravity
  --shared-queue      Configure MCP to share the local companion queue
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 24+ is required. Install Node.js 24 LTS (e.g. brew install node@24 or https://nodejs.org/)." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'parseInt(process.versions.node, 10)')"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "VideoSave requires Node.js 24 or newer (detected $("$NODE_BIN" -v))." >&2
  exit 1
fi

mkdir -p "$TOOLS_DIR"

if [[ "$MODE" == "health" ]]; then
  exec env VIDEOSAVE_ROOT="$PROJECT_DIR" "$NODE_BIN" --input-type=module -e "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const { getRuntimeHealth } = await import(pathToFileURL(path.join(process.env.VIDEOSAVE_ROOT, 'tools', 'runtime-manager.mjs')).href); console.log(JSON.stringify(await getRuntimeHealth(), null, 2));"
fi

if [[ "$MODE" == "setup" ]]; then
  env VIDEOSAVE_ROOT="$PROJECT_DIR" "$NODE_BIN" --input-type=module -e "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const { getRuntimeHealth } = await import(pathToFileURL(path.join(process.env.VIDEOSAVE_ROOT, 'tools', 'runtime-manager.mjs')).href); const h = await getRuntimeHealth(); console.log(JSON.stringify(h, null, 2)); if (!h.ready) process.exit(1);"
  echo "VideoSave runtime verified on $(uname -s) $(uname -m)."
  exit 0
fi

if [[ "$MODE" == "mcp-config" ]]; then
  TARGET_CLIENT="${CLIENT:-claude-desktop}"
  MCP_MODE="standalone"
  if [[ "$SHARED_QUEUE" -eq 1 ]]; then MCP_MODE="shared-queue"; fi
  exec env VIDEOSAVE_ROOT="$PROJECT_DIR" TARGET_CLIENT="$TARGET_CLIENT" MCP_MODE="$MCP_MODE" PORT="$PORT" "$NODE_BIN" --input-type=module -e "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const { generateMcpClientConfig } = await import(pathToFileURL(path.join(process.env.VIDEOSAVE_ROOT, 'tools', 'mcp-config-generator.mjs')).href); const cfg = generateMcpClientConfig(process.env.TARGET_CLIENT, { mode: process.env.MCP_MODE, companionPort: Number(process.env.PORT) }); console.log(cfg.content);"
fi

export MEDIA_TOOLKIT_LOCAL_PAIRING=1
export PORT="$PORT"
echo "Starting VideoSave companion and Local Management Center at http://127.0.0.1:${PORT}/console"
exec "$NODE_BIN" "$PROJECT_DIR/tools/server.mjs"
