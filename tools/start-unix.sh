#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
TOOLS_DIR="${VIDEOSAVE_TOOLS_DIR:-$DATA_HOME/videosave/tools}"
PORT="${PORT:-8765}"

NODE_VERSION="24.22.3"
NODE_SHA_DARWIN_ARM64="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"
NODE_SHA_DARWIN_X64="977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7"
NODE_SHA_LINUX_X64="4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"
NODE_SHA_LINUX_ARM64="6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c"

YTDLP_VERSION="2026.11.23"
YTDLP_SHA_MACOS="57654854886d0398a798895aadf5173e2749fbb5e249b9f3728022ab376e11fb"
YTDLP_SHA_LINUX_X64="249ddb058234276bc449b9cd9492aad9f133bda5923c61a9e39983ae114ef17d"
YTDLP_SHA_LINUX_ARM64="fb847a2e4a9ddc8cf5fcfb4bb7f42ba8969ecf72068def0278074f9d300bd13c"

FFMPEG_BTBN_TAG="autobuild-2026-11-27-12-42"
FFMPEG_LINUX_X64_ARCHIVE="ffmpeg-n8.1.3-41-ga8029b6528-linux64-gpl-8.1.tar.xz"
FFMPEG_LINUX_X64_SHA="a6c7acd3f9e883d49b4f2b0c6dfccd4d70f9c7497f67348de2782c3ec26169ca"
FFMPEG_LINUX_ARM64_ARCHIVE="ffmpeg-n8.1.3-41-ga8029b6528-linuxarm64-gpl-8.1.tar.xz"
FFMPEG_LINUX_ARM64_SHA="59a1cd08a0c87bb76a7326934e252ed37d73f734275fbf8beb557aeb49cbc910"

MODE="server"
CLIENT=""
SHARED_QUEUE=0
PASSTHROUGH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-only) MODE="setup"; shift ;;
    --health) MODE="health"; shift ;;
    --mcp-config) MODE="mcp-config"; shift ;;
    --shared-queue) SHARED_QUEUE=1; shift ;;
    --client) CLIENT="${2:-}"; shift 2 ;;
    --run-cli) MODE="cli"; shift; PASSTHROUGH_ARGS=("$@"); break ;;
    --run-mcp) MODE="mcp"; shift; PASSTHROUGH_ARGS=("$@"); break ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: ./tools/start-unix.sh [OPTIONS]
  --setup-only        Auto-bootstrap verified Node.js 24 LTS if absent and verify FFmpeg/yt-dlp
  --health            Print JSON runtime health diagnostics
  --mcp-config        Print MCP client configuration (use --client NAME for native format)
  --client NAME       deepseek-harness | codex | claude-code | claude-desktop | cursor | antigravity
  --shared-queue      Configure MCP to share the local companion queue
  --run-cli [ARGS...] Run VideoSave CLI using managed Node.js 24 runtime
  --run-mcp [ARGS...] Run VideoSave MCP stdio server using managed Node.js 24 runtime
  --uninstall         Remove managed VideoSave runtime cache (preserves all downloaded videos)
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ "$MODE" == "uninstall" ]]; then
  echo "Removing VideoSave managed tools cache at $TOOLS_DIR (your downloaded videos are untouched)..."
  rm -rf "$TOOLS_DIR"
  echo "Done. You can safely delete $PROJECT_DIR to finish uninstalling."
  exit 0
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required to verify runtime downloads." >&2
    return 1
  fi
}

bootstrap_node() {
  local os_name arch_name slug ext expected_sha
  os_name="$(uname -s)"
  arch_name="$(uname -m)"
  case "${os_name}:${arch_name}" in
    Darwin:arm64)  slug="darwin-arm64"; ext="tar.gz"; expected_sha="$NODE_SHA_DARWIN_ARM64" ;;
    Darwin:x86_64) slug="darwin-x64";   ext="tar.gz"; expected_sha="$NODE_SHA_DARWIN_X64" ;;
    Linux:x86_64)  slug="linux-x64";    ext="tar.xz"; expected_sha="$NODE_SHA_LINUX_X64" ;;
    Linux:aarch64|Linux:arm64) slug="linux-arm64"; ext="tar.xz"; expected_sha="$NODE_SHA_LINUX_ARM64" ;;
    *)
      echo "Unsupported platform for automatic Node.js bootstrap (${os_name}/${arch_name}). Install Node.js 24+ manually." >&2
      return 1
      ;;
  esac

  local folder="node-v${NODE_VERSION}-${slug}"
  local target_dir="${TOOLS_DIR}/${folder}"
  local target_bin="${target_dir}/bin/node"
  if [[ -x "$target_bin" ]]; then
    echo "$target_bin"
    return 0
  fi

  local bundled_bin="${PROJECT_DIR}/.local-tools/${folder}/bin/node"
  if [[ -x "$bundled_bin" ]]; then
    echo "$bundled_bin"
    return 0
  fi

  mkdir -p "$TOOLS_DIR"
  local staging
  staging="$(mktemp -d "${TOOLS_DIR}/node-setup-XXXXXX")"
  trap 'rm -rf "$staging"' RETURN
  local archive="${staging}/${folder}.${ext}"
  local url="https://nodejs.org/dist/v${NODE_VERSION}/${folder}.${ext}"
  echo "Downloading verified Node.js v${NODE_VERSION} (${slug}) into ${TOOLS_DIR}..." >&2
  curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 240 --output "$archive" "$url"
  local actual_sha
  actual_sha="$(sha256_file "$archive")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "SHA-256 verification failed for Node.js v${NODE_VERSION} (${slug})! Expected ${expected_sha}, got ${actual_sha}." >&2
    return 1
  fi
  if [[ "$ext" == "tar.gz" ]]; then
    tar -xzf "$archive" -C "$staging"
  else
    tar -xJf "$archive" -C "$staging"
  fi
  mv "${staging}/${folder}" "$target_dir"
  echo "$target_bin"
}

resolve_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN:-}" ]]; then
    echo "$NODE_BIN"
    return 0
  fi
  local sys_node
  sys_node="$(command -v node || true)"
  if [[ -n "$sys_node" ]]; then
    local major
    major="$("$sys_node" -p 'parseInt(process.versions.node, 10)' 2>/dev/null || echo 0)"
    if [[ "$major" -ge 24 ]]; then
      echo "$sys_node"
      return 0
    fi
  fi
  bootstrap_node
}

bootstrap_ytdlp() {
  if [[ -n "${YTDLP_BIN:-}" && -x "${YTDLP_BIN:-}" ]]; then
    echo "$YTDLP_BIN"
    return 0
  fi
  local os_name arch_name asset expected_sha
  os_name="$(uname -s)"
  arch_name="$(uname -m)"
  case "${os_name}:${arch_name}" in
    Darwin:*) asset="yt-dlp_macos"; expected_sha="$YTDLP_SHA_MACOS" ;;
    Linux:x86_64) asset="yt-dlp_linux"; expected_sha="$YTDLP_SHA_LINUX_X64" ;;
    Linux:aarch64|Linux:arm64) asset="yt-dlp_linux_aarch64"; expected_sha="$YTDLP_SHA_LINUX_ARM64" ;;
    *) return 0 ;;
  esac
  local target_dir="${TOOLS_DIR}/yt-dlp-${YTDLP_VERSION}"
  local target_bin="${target_dir}/yt-dlp"
  if [[ -x "$target_bin" ]]; then
    echo "$target_bin"
    return 0
  fi
  mkdir -p "$target_dir"
  local tmp_file="${target_dir}/yt-dlp.part-$$"
  local url="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"
  echo "Downloading verified yt-dlp ${YTDLP_VERSION} (${asset}) into ${target_dir}..." >&2
  if curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 180 --output "$tmp_file" "$url"; then
    local actual_sha
    actual_sha="$(sha256_file "$tmp_file")"
    if [[ "$actual_sha" == "$expected_sha" ]]; then
      chmod 755 "$tmp_file"
      mv "$tmp_file" "$target_bin"
      echo "$target_bin"
      return 0
    fi
    echo "SHA-256 verification failed for yt-dlp ${YTDLP_VERSION} (${asset})!" >&2
  fi
  rm -f "$tmp_file"
  return 0
}

bootstrap_ffmpeg() {
  if [[ -n "${FFMPEG_BIN:-}" && -x "${FFMPEG_BIN:-}" && -n "${FFPROBE_BIN:-}" && -x "${FFPROBE_BIN:-}" ]]; then
    return 0
  fi
  # Reuse system / Homebrew FFmpeg + FFprobe if already present
  local sys_ff sys_fp
  sys_ff="$(command -v ffmpeg || true)"
  sys_fp="$(command -v ffprobe || true)"
  if [[ -z "$sys_ff" && -x "/opt/homebrew/bin/ffmpeg" && -x "/opt/homebrew/bin/ffprobe" ]]; then
    sys_ff="/opt/homebrew/bin/ffmpeg"; sys_fp="/opt/homebrew/bin/ffprobe"
  elif [[ -z "$sys_ff" && -x "/usr/local/bin/ffmpeg" && -x "/usr/local/bin/ffprobe" ]]; then
    sys_ff="/usr/local/bin/ffmpeg"; sys_fp="/usr/local/bin/ffprobe"
  fi
  if [[ -n "$sys_ff" && -n "$sys_fp" ]]; then
    export FFMPEG_BIN="$sys_ff"
    export FFPROBE_BIN="$sys_fp"
    return 0
  fi

  local os_name arch_name archive expected_sha
  os_name="$(uname -s)"
  arch_name="$(uname -m)"
  if [[ "$os_name" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      echo "FFmpeg/FFprobe not found on macOS. Install verified FFmpeg via: brew install ffmpeg" >&2
    else
      echo "FFmpeg/FFprobe not found on macOS. Install Homebrew (https://brew.sh) and run: brew install ffmpeg" >&2
    fi
    return 0
  fi

  case "${os_name}:${arch_name}" in
    Linux:x86_64) archive="$FFMPEG_LINUX_X64_ARCHIVE"; expected_sha="$FFMPEG_LINUX_X64_SHA" ;;
    Linux:aarch64|Linux:arm64) archive="$FFMPEG_LINUX_ARM64_ARCHIVE"; expected_sha="$FFMPEG_LINUX_ARM64_SHA" ;;
    *) return 0 ;;
  esac

  local folder="${archive%.tar.xz}"
  local target_dir="${TOOLS_DIR}/${folder}"
  if [[ -x "${target_dir}/bin/ffmpeg" && -x "${target_dir}/bin/ffprobe" ]]; then
    export FFMPEG_BIN="${target_dir}/bin/ffmpeg"
    export FFPROBE_BIN="${target_dir}/bin/ffprobe"
    return 0
  fi

  mkdir -p "$TOOLS_DIR"
  local staging
  staging="$(mktemp -d "${TOOLS_DIR}/ffmpeg-setup-XXXXXX")"
  trap 'rm -rf "$staging"' RETURN
  local dl_file="${staging}/${archive}"
  local url="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/${archive}"
  echo "Downloading SHA-256 verified FFmpeg + FFprobe (${arch_name}) into ${TOOLS_DIR}..." >&2
  if curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 300 --output "$dl_file" "$url"; then
    local actual_sha
    actual_sha="$(sha256_file "$dl_file")"
    if [[ "$actual_sha" == "$expected_sha" ]]; then
      tar -xJf "$dl_file" -C "$staging"
      mv "${staging}/${folder}" "$target_dir"
      chmod 755 "${target_dir}/bin/ffmpeg" "${target_dir}/bin/ffprobe"
      export FFMPEG_BIN="${target_dir}/bin/ffmpeg"
      export FFPROBE_BIN="${target_dir}/bin/ffprobe"
      return 0
    fi
    echo "SHA-256 verification failed for ${archive}! Expected ${expected_sha}, got ${actual_sha}." >&2
  fi
  return 0
}

NODE_BIN="$(resolve_node)"
mkdir -p "$TOOLS_DIR"
if [[ "$MODE" == "setup" || "$MODE" == "server" || "$MODE" == "mcp" || "$MODE" == "cli" ]]; then
  bootstrap_ffmpeg || true
fi
if [[ "$MODE" == "setup" || "$MODE" == "server" ]]; then
  MANAGED_YTDLP="$(bootstrap_ytdlp || true)"
  if [[ -n "${MANAGED_YTDLP:-}" && -x "${MANAGED_YTDLP:-}" ]]; then
    export YTDLP_BIN="$MANAGED_YTDLP"
  fi
fi

if [[ "$MODE" == "cli" ]]; then
  exec "$NODE_BIN" "$PROJECT_DIR/tools/media-cli.mjs" "${PASSTHROUGH_ARGS[@]}"
fi

if [[ "$MODE" == "mcp" ]]; then
  exec "$NODE_BIN" "$PROJECT_DIR/tools/mcp-server.mjs" "${PASSTHROUGH_ARGS[@]}"
fi

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
if [[ "$(uname -s)" == "Darwin" ]]; then
  (sleep 1.5 && open "http://127.0.0.1:${PORT}/console" >/dev/null 2>&1 || true) &
fi
exec "$NODE_BIN" "$PROJECT_DIR/tools/server.mjs"
