#!/usr/bin/env node
/**
 * Safe, opt-in DeepSeek Harness (DSH) VideoSave MCP configuration upgrader.
 * - Dry-run by default: NEVER modifies user files unless --apply is explicitly passed.
 * - Creates a timestamped .bak backup before writing.
 * - Verifies get_version over real stdio MCP handshake after upgrading.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { generateMcpClientConfig } from './mcp-config-generator.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify-only');
const packageDir = path.resolve(option('package') || fileURLToPath(new URL('..', import.meta.url)));
const mcpEntry = path.join(packageDir, 'tools', 'mcp-server.mjs');
const configPath = option('config')
  ? path.resolve(option('config'))
  : path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'mcp-bundles', 'videosave-mcp', 'cordis.patch.yml');

async function probeMcpVersion(entryPath) {
  const child = spawn(process.execPath, [entryPath, '--sandbox'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return JSON.parse((await lines.next()).value);
  };
  try {
    await call(1, 'initialize', { protocolVersion: '2025-11-25' });
    const ver = await call(2, 'tools/call', { name: 'get_version', arguments: {} });
    return ver.result?.structuredContent ?? null;
  } finally {
    child.stdin.end();
    await closed;
  }
}

if (!existsSync(mcpEntry)) {
  console.error(JSON.stringify({ ok: false, error: `MCP entrypoint not found: ${mcpEntry}` }));
  process.exit(2);
}

const targetVersionInfo = await probeMcpVersion(mcpEntry);
const generated = generateMcpClientConfig('deepseek-harness', {
  nodePath: process.execPath,
  mcpScriptPath: mcpEntry,
  mode: 'standalone',
});

let currentEntry = null;
let currentVersion = null;
if (existsSync(configPath)) {
  const existing = await readFile(configPath, 'utf8');
  const match = existing.match(/args:\s*\r?\n\s*-\s*['"]?([^'"\r\n]+mcp-server\.mjs)['"]?/i);
  if (match) {
    currentEntry = match[1].trim();
    if (existsSync(currentEntry)) {
      currentVersion = (await probeMcpVersion(currentEntry).catch(() => null))?.version ?? null;
    }
  }
}

const plan = {
  mode: verifyOnly ? 'verify-only' : apply ? 'apply' : 'dry-run',
  configExists: existsSync(configPath),
  currentVersion,
  targetVersion: targetVersionInfo?.version ?? null,
  versionDrift: Boolean(currentVersion && targetVersionInfo?.version && currentVersion !== targetVersionInfo.version),
  backupPath: null,
  applied: false,
};

if (apply && !verifyOnly) {
  if (existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    plan.backupPath = `${configPath}.${stamp}.bak`;
    await copyFile(configPath, plan.backupPath);
  }
  await writeFile(configPath, generated.content, 'utf8');
  plan.applied = true;
  plan.verifiedPostUpgradeVersion = (await probeMcpVersion(mcpEntry))?.version ?? null;
}

console.log(JSON.stringify(plan, null, 2));
