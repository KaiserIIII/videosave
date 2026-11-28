import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startFsAuditMonitor } from '../tools/fs-audit-monitor.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const SANDBOX_BASE = path.resolve(
  process.env.VIDEOSAVE_TEST_SANDBOX_ROOT || path.join(repoRoot, '.ots', 'tmp', 'videosave-tests'),
);

function windowsDownloadsFolder() {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
          '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      const value = output.match(/REG_\w+\s+(.+?)\s*$/m)?.[1];
      if (value) return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
    } catch {}
  }
  return path.join(os.homedir(), 'Downloads');
}

function userConfiguredOutDir() {
  const stateDir = process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
  const realDb = path.join(stateDir, 'VideoSave', 'settings.sqlite');
  if (!existsSync(realDb)) return null;
  let db;
  try {
    db = new DatabaseSync(realDb, { readOnly: true, timeout: 1000 });
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preferences'").get();
    if (!hasTable) return null;
    const row = db.prepare("SELECT value FROM preferences WHERE scope='download' AND name='outDir'").get();
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function realDownloadDirectories() {
  const stateDir = process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
  const candidates = [windowsDownloadsFolder(), userConfiguredOutDir(), path.join(stateDir, 'VideoSave')].filter(Boolean);
  return [...new Set(candidates.map(dir => path.resolve(dir)))].filter(existsSync);
}

async function directorySnapshot(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = new Map();
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const info = await stat(full).catch(() => null);
    if (info) files.set(entry.name, { size: info.size, mtimeMs: Math.round(info.mtimeMs), isDir: info.isDirectory() });
  }
  return files;
}

export async function snapshotRealDownloadDirs() {
  const dirs = realDownloadDirectories();
  const snapshots = new Map();
  for (const dir of dirs) snapshots.set(dir, await directorySnapshot(dir));
  return snapshots;
}

export async function assertRealDownloadDirsUntouched(beforeSnapshots, context = 'test run') {
  const violations = [];
  for (const [dir, before] of beforeSnapshots.entries()) {
    const after = await directorySnapshot(dir);
    for (const [name, info] of after.entries()) {
      const prior = before.get(name);
      if (!prior) {
        violations.push({ dir, name, change: 'added', size: info.size });
      } else if (prior.size !== info.size || prior.mtimeMs !== info.mtimeMs) {
        violations.push({ dir, name, change: 'modified', before: prior, after: info });
      }
    }
    for (const [name, prior] of before.entries()) {
      if (!after.has(name)) {
        violations.push({ dir, name, change: 'deleted', before: prior });
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    `Real download directory polluted during ${context}: ${JSON.stringify(violations)}`,
  );
}

export async function createTestSandbox(label = 'run') {
  const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'run';
  const id = `${safeLabel}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const root = path.join(SANDBOX_BASE, id);
  const dirs = {
    root,
    media: path.join(root, 'media'),
    downloads: path.join(root, 'downloads'),
    staging: path.join(root, 'staging'),
    dbDir: path.join(root, 'db'),
    cookies: path.join(root, 'cookies'),
    profiles: path.join(root, 'profiles'),
    logs: path.join(root, 'logs'),
    packages: path.join(root, 'packages'),
    results: path.join(root, 'results'),
    tools: path.join(root, 'tools'),
  };
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })));
  const settingsFile = path.join(dirs.dbDir, 'settings.sqlite');
  const realBefore = await snapshotRealDownloadDirs();
  const fsMonitor = await startFsAuditMonitor({
    sandboxRoot: root,
    protectedDirs: realDownloadDirectories(),
    label: safeLabel,
  });
  let stoppedAudit = null;

  function env(extra = {}) {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:OUT_DIR|MEDIA_TOOLKIT_(?:URL|TOKEN|MCP_CLIENT|LOCAL_PAIRING|SETTINGS)|VIDEOSAVE_(?:PROFILES_DIR|TEST_SANDBOX|TOOLS_DIR|NO_USER_SETTINGS|SANDBOX_MODE|FORCE_OUT_DIR))$/i.test(name),
      ),
    );
    return {
      ...clean,
      OUT_DIR: dirs.downloads,
      MEDIA_TOOLKIT_SETTINGS: settingsFile,
      VIDEOSAVE_PROFILES_DIR: dirs.profiles,
      VIDEOSAVE_TEST_SANDBOX: root,
      VIDEOSAVE_TOOLS_DIR: dirs.tools,
      VIDEOSAVE_NO_USER_SETTINGS: '1',
      VIDEOSAVE_SANDBOX_MODE: '1',
      ...extra,
    };
  }

  function applyProcessEnv(overrides = {}) {
    const previous = {
      OUT_DIR: process.env.OUT_DIR,
      MEDIA_TOOLKIT_SETTINGS: process.env.MEDIA_TOOLKIT_SETTINGS,
      VIDEOSAVE_PROFILES_DIR: process.env.VIDEOSAVE_PROFILES_DIR,
      VIDEOSAVE_TEST_SANDBOX: process.env.VIDEOSAVE_TEST_SANDBOX,
      VIDEOSAVE_TOOLS_DIR: process.env.VIDEOSAVE_TOOLS_DIR,
      VIDEOSAVE_NO_USER_SETTINGS: process.env.VIDEOSAVE_NO_USER_SETTINGS,
      VIDEOSAVE_SANDBOX_MODE: process.env.VIDEOSAVE_SANDBOX_MODE,
      VIDEOSAVE_FORCE_OUT_DIR: process.env.VIDEOSAVE_FORCE_OUT_DIR,
    };
    for (const key of Object.keys(overrides)) {
      if (!(key in previous)) previous[key] = process.env[key];
    }
    process.env.OUT_DIR = dirs.downloads;
    process.env.MEDIA_TOOLKIT_SETTINGS = settingsFile;
    process.env.VIDEOSAVE_PROFILES_DIR = dirs.profiles;
    process.env.VIDEOSAVE_TEST_SANDBOX = root;
    process.env.VIDEOSAVE_TOOLS_DIR = dirs.tools;
    process.env.VIDEOSAVE_NO_USER_SETTINGS = '1';
    process.env.VIDEOSAVE_SANDBOX_MODE = '1';
    delete process.env.VIDEOSAVE_FORCE_OUT_DIR;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null) delete process.env[key];
      else process.env[key] = String(value);
    }
    return () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  function sandboxArgs() {
    return [`--sandbox=${root}`];
  }

  async function listFilesRecursive(dir, acc = []) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await listFilesRecursive(full, acc);
      else if (entry.isFile()) acc.push(full);
    }
    return acc;
  }

  async function collectActualWritePaths({ label: reportLabel = safeLabel, extraDirs = [] } = {}) {
    const scanDirs = [...new Set([dirs.downloads, ...extraDirs.map(d => path.resolve(d))])];
    const writtenFiles = [];
    for (const dir of scanDirs) {
      await listFilesRecursive(dir, writtenFiles);
    }
    const realDirs = realDownloadDirectories();
    const isInside = (parent, child) => {
      const rel = path.relative(path.resolve(parent), path.resolve(child));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    for (const target of [dirs.downloads, settingsFile, ...extraDirs, ...writtenFiles]) {
      assert.ok(isInside(root, target), `Actual write path escaped sandbox: ${target} (sandbox=${root})`);
      for (const realDir of realDirs) {
        assert.ok(!isInside(realDir, target), `Actual write path targeted real user download directory: ${target}`);
      }
    }
    const auditReport = stoppedAudit ?? await fsMonitor.stop({ assertClean: true });
    stoppedAudit = auditReport;
    return {
      label: reportLabel,
      sandboxEnforced: true,
      noUserSettings: true,
      sandboxRoot: root,
      actualOutDir: dirs.downloads,
      actualSettingsFile: settingsFile,
      extraDirs: extraDirs.map(d => path.resolve(d)),
      writtenFileCount: writtenFiles.length,
      writtenFiles: writtenFiles.map(file => path.relative(root, file).replaceAll('\\', '/')),
      osMonitorMechanism: auditReport.osMonitorMechanism,
      auditComplete: auditReport.auditComplete,
      protectedRecursiveWatched: auditReport.protectedRecursiveWatched,
      observedSandboxEventCount: auditReport.observedSandboxEventCount,
      observedSandboxWritePaths: auditReport.observedSandboxWritePaths,
      outOfBoundsViolationCount: auditReport.outOfBoundsViolationCount,
      allWritesInsideSandbox: auditReport.clean,
    };
  }

  async function verifyIsolation() {
    if (!stoppedAudit) stoppedAudit = await fsMonitor.stop({ assertClean: true });
    await assertRealDownloadDirsUntouched(realBefore, safeLabel);
    return stoppedAudit;
  }

  async function cleanup({ keep = false } = {}) {
    await verifyIsolation();
    if (keep) return;
    const relative = path.relative(SANDBOX_BASE, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to clean path outside test sandbox: ${root}`);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }

  return { ...dirs, settingsFile, env, applyProcessEnv, sandboxArgs, collectActualWritePaths, verifyIsolation, cleanup, recordProcess: fsMonitor.recordProcess };
}
