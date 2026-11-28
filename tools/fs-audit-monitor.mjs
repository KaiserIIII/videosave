import assert from 'node:assert/strict';
import { existsSync, watch } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SKIP_CACHE_DIRS = new Set([
  'cfprofile', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'Crashpad',
  'component_crx_cache', 'extensions_crx_cache', 'node_modules', '.git',
]);

async function scanTree(root, acc = new Map(), { depth = 0, maxDepth = 3, maxEntries = 2000 } = {}) {
  if (!existsSync(root) || depth > maxDepth || acc.size >= maxEntries) return acc;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (acc.size >= maxEntries) break;
    if (entry.isDirectory() && SKIP_CACHE_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    const info = await lstat(full).catch(() => null);
    if (!info) continue;
    acc.set(full, {
      size: info.size,
      mtimeMs: Math.round(info.mtimeMs),
      isDir: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
    });
    if (info.isDirectory() && !info.isSymbolicLink() && depth < maxDepth) {
      await scanTree(full, acc, { depth: depth + 1, maxDepth, maxEntries });
    }
  }
  return acc;
}

function diffTrees(before, after, root) {
  const changes = [];
  for (const [full, info] of after.entries()) {
    const prev = before.get(full);
    if (!prev) {
      changes.push({ kind: 'created', path: full, relative: path.relative(root, full).replaceAll('\\', '/'), size: info.size, isDir: info.isDir });
    } else if (!info.isDir && (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs)) {
      changes.push({ kind: 'modified', path: full, relative: path.relative(root, full).replaceAll('\\', '/'), size: info.size, prevSize: prev.size });
    }
  }
  for (const [full, prev] of before.entries()) {
    if (!after.has(full)) {
      changes.push({ kind: 'deleted', path: full, relative: path.relative(root, full).replaceAll('\\', '/'), prevSize: prev.size, isDir: prev.isDir });
    }
  }
  return changes;
}

/**
 * Real OS-level filesystem write monitor using native recursive fs.watch
 * (ReadDirectoryChangesW on Windows, FSEvents on macOS, inotify on Linux)
 * paired with pre/post recursive tree verification.
 *
 * Observes BOTH protected host directories (must see ZERO writes) AND the
 * allowed sandbox directory (records actual observed writes, not declared intent).
 */
export async function startFsAuditMonitor({
  sandboxRoot,
  protectedDirs = [],
  label = 'audit',
} = {}) {
  assert.ok(sandboxRoot, 'sandboxRoot is required');
  const resolvedSandbox = await realpath(sandboxRoot).catch(() => path.resolve(sandboxRoot));
  const uniqueProtected = [];
  const seen = new Set();
  for (const dir of protectedDirs.filter(Boolean)) {
    const resolved = await realpath(dir).catch(() => path.resolve(dir));
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(resolved)) uniqueProtected.push(resolved);
  }

  const sandboxBefore = await scanTree(resolvedSandbox);
  const protectedBefore = new Map();
  for (const dir of uniqueProtected) {
    protectedBefore.set(dir, await scanTree(dir));
  }

  const watchers = [];
  const watcherErrors = [];
  const osSandboxEvents = [];
  const osProtectedEvents = [];
  const trackedProcesses = [];
  const startedAt = new Date().toISOString();

  function attachWatcher(dir, bucket, kind) {
    try {
      const useRecursive = kind === 'sandbox' && (process.platform === 'win32' || process.platform === 'darwin');
      const w = watch(dir, { recursive: useRecursive, persistent: false }, (eventType, filename) => {
        if (bucket.length >= 2000) return;
        const nameStr = filename ? String(filename).replaceAll('\\', '/') : null;
        if (nameStr && SKIP_CACHE_DIRS.has(nameStr.split('/')[0])) return;
        const entry = {
          ts: new Date().toISOString(),
          osMechanism: process.platform === 'win32' ? 'ReadDirectoryChangesW' : process.platform === 'darwin' ? 'FSEvents' : 'inotify',
          watchRoot: dir,
          eventType,
          filename: nameStr,
          fullPath: filename ? path.resolve(dir, String(filename)) : dir,
        };
        bucket.push(entry);
      });
      w.on('error', err => watcherErrors.push({ kind, dir, message: err.message }));
      watchers.push(w);
    } catch (err) {
      watcherErrors.push({ kind, dir, message: err.message });
    }
  }

  attachWatcher(resolvedSandbox, osSandboxEvents, 'sandbox');
  for (const dir of uniqueProtected) {
    attachWatcher(dir, osProtectedEvents, 'protected');
  }

  function recordProcess({ pid, command, args = [], cwd = null, role = 'child' } = {}) {
    trackedProcesses.push({
      pid: pid ?? null,
      role,
      command: command ? path.basename(String(command)) : null,
      argsCount: Array.isArray(args) ? args.length : 0,
      cwd: cwd ? path.resolve(cwd) : null,
      recordedAt: new Date().toISOString(),
    });
  }

  async function stop({ assertClean = true } = {}) {
    // Allow brief kernel event drain on Windows ReadDirectoryChangesW
    await new Promise(r => setTimeout(r, 80));
    for (const w of watchers) {
      try { w.close(); } catch {}
    }

    const sandboxAfter = await scanTree(resolvedSandbox);
    const sandboxDiff = diffTrees(sandboxBefore, sandboxAfter, resolvedSandbox);

    const protectedViolations = [];
    for (const dir of uniqueProtected) {
      const after = await scanTree(dir);
      const diff = diffTrees(protectedBefore.get(dir), after, dir);
      for (const change of diff) {
        protectedViolations.push({ source: 'tree-diff', root: dir, ...change });
      }
    }
    for (const ev of osProtectedEvents) {
      protectedViolations.push({ source: 'os-watcher', ...ev });
    }

    const observedSandboxFiles = [...new Set([
      ...sandboxDiff.filter(d => !d.isDir && d.kind !== 'deleted').map(d => d.relative),
      ...osSandboxEvents.filter(e => e.filename).map(e => e.filename),
    ])].sort();

    const report = {
      label,
      startedAt,
      completedAt: new Date().toISOString(),
      platform: process.platform,
      osMonitorMechanism: process.platform === 'win32'
        ? 'ReadDirectoryChangesW+TreeDiff'
        : process.platform === 'darwin'
          ? 'FSEvents+TreeDiff'
          : 'inotify+TreeDiff',
      sandboxRoot: resolvedSandbox,
      protectedDirCount: uniqueProtected.length,
      osWatcherActiveCount: watchers.length,
      watcherErrors,
      trackedProcesses,
      observedSandboxEventCount: osSandboxEvents.length,
      observedSandboxFileDiffCount: sandboxDiff.filter(d => !d.isDir).length,
      observedSandboxWritePaths: observedSandboxFiles,
      outOfBoundsViolations: protectedViolations,
      outOfBoundsViolationCount: protectedViolations.length,
      clean: protectedViolations.length === 0,
    };

    if (assertClean && protectedViolations.length > 0) {
      const error = new Error(
        `OS filesystem audit detected ${protectedViolations.length} out-of-bounds write(s) during ${label}: ` +
        JSON.stringify(protectedViolations.slice(0, 5)),
      );
      error.code = 'SANDBOX_REAL_FS_VIOLATION';
      error.auditReport = report;
      throw error;
    }
    return report;
  }

  return {
    sandboxRoot: resolvedSandbox,
    protectedDirs: uniqueProtected,
    recordProcess,
    stop,
  };
}
