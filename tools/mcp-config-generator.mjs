import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../extension/manifest.json' with { type: 'json' };
import { locateManagedBinary } from './runtime-manager.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultMcpScript = path.join(repoRoot, 'tools', 'mcp-server.mjs');
const currentVersion = manifest.version_name ?? manifest.version;

function defaultClientPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  return {
    'deepseek-harness': isWin
      ? path.join(home, 'Documents', 'deepseek-harness', 'default-workspace', 'mcp-bundles', 'videosave-mcp', 'cordis.patch.yml')
      : path.join(home, 'deepseek-harness', 'default-workspace', 'mcp-bundles', 'videosave-mcp', 'cordis.patch.yml'),
    codex: path.join(home, '.codex', 'config.toml'),
    'claude-code': path.join(home, '.claude.json'),
    'claude-desktop': isWin
      ? path.join(appData, 'Claude', 'claude_desktop_config.json')
      : isMac
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    antigravity: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    _localAppData: localAppData,
  };
}

function yamlSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export const SUPPORTED_MCP_CLIENTS = Object.freeze([
  'deepseek-harness',
  'codex',
  'claude-code',
  'claude-desktop',
  'cursor',
  'antigravity',
]);

/**
 * Generate native configuration snippets for major MCP clients without modifying user files.
 */
export function generateMcpClientConfig(client, {
  nodePath = process.execPath,
  mcpScriptPath = defaultMcpScript,
  mode = 'standalone',
  companionPort = 8765,
  managedClientId = null,
  includeMediaBins = true,
} = {}) {
  if (!SUPPORTED_MCP_CLIENTS.includes(client)) {
    throw new Error(`Unsupported MCP client: ${client}. Supported: ${SUPPORTED_MCP_CLIENTS.join(', ')}`);
  }
  const env = {};
  if (includeMediaBins) {
    const ffmpeg = locateManagedBinary('ffmpeg')?.path;
    const ffprobe = locateManagedBinary('ffprobe')?.path;
    const ytdlp = locateManagedBinary('yt-dlp')?.path;
    if (ffmpeg) env.FFMPEG_BIN = ffmpeg;
    if (ffprobe) env.FFPROBE_BIN = ffprobe;
    if (ytdlp) env.YTDLP_BIN = ytdlp;
  }
  if (mode === 'shared-queue' || mode === 'managed') {
    env.MEDIA_TOOLKIT_URL = `http://127.0.0.1:${Number(companionPort) || 8765}`;
    env.MEDIA_TOOLKIT_LOCAL_PAIRING = '1';
  }
  if (mode === 'managed' && managedClientId) {
    env.MEDIA_TOOLKIT_MCP_CLIENT = managedClientId;
  }

  const paths = defaultClientPaths();
  const targetPath = paths[client];
  const baseServer = {
    command: nodePath,
    args: [mcpScriptPath],
    ...(Object.keys(env).length && { env }),
  };

  if (client === 'deepseek-harness') {
    const envLines = Object.keys(env).length
      ? ['          env:', ...Object.entries(env).map(([k, v]) => `            ${k}: ${yamlSingleQuote(v)}`)]
      : [];
    const content = [
      '- insert:',
      '    - id: videosave-mcp',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: videosave',
      '        transport: stdio',
      `        command: ${yamlSingleQuote(nodePath)}`,
      '        args:',
      `          - ${yamlSingleQuote(mcpScriptPath)}`,
      ...envLines,
      '        toolCallTimeoutMs: 300000',
      '        startupTimeoutMs: 60000',
      '        failOnStartupError: true',
      '',
    ].join('\n');
    return { client, format: 'yaml', suggestedPath: targetPath, version: currentVersion, content };
  }

  if (client === 'codex') {
    const envBlock = Object.keys(env).length
      ? ['', '[mcp_servers.videosave.env]', ...Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`)]
      : [];
    const content = [
      '[mcp_servers.videosave]',
      `command = ${tomlString(nodePath)}`,
      `args = [${tomlString(mcpScriptPath)}]`,
      'startup_timeout_sec = 60',
      'tool_timeout_sec = 300',
      ...envBlock,
      '',
    ].join('\n');
    return { client, format: 'toml', suggestedPath: targetPath, version: currentVersion, content };
  }

  if (client === 'claude-code') {
    const json = JSON.stringify({ mcpServers: { videosave: baseServer } }, null, 2) + '\n';
    const cliCommand = `claude mcp add videosave -- "${nodePath}" "${mcpScriptPath}"`;
    return { client, format: 'json', suggestedPath: targetPath, cliCommand, version: currentVersion, content: json };
  }

  const content = JSON.stringify({ mcpServers: { videosave: baseServer } }, null, 2) + '\n';
  return { client, format: 'json', suggestedPath: targetPath, version: currentVersion, content };
}

export function detectMcpClients() {
  const paths = defaultClientPaths();
  return SUPPORTED_MCP_CLIENTS.map(client => ({
    client,
    suggestedPath: paths[client],
    configExists: existsSync(paths[client]),
  }));
}
