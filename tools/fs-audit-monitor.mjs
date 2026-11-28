import assert from 'node:assert/strict';
import { existsSync, watch } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const SKIP_CACHE_DIRS = new Set([
  'cfprofile', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'Crashpad',
  'component_crx_cache', 'extensions_crx_cache', 'node_modules', '.git',
]);
const OS_SHELL_NOISE_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

async function scanTree(root, acc = new Map(), { depth = 0, maxDepth = 6, maxEntries = 10_000, state = { truncated: false } } = {}) {
  if (!existsSync(root)) return acc;
  if (depth > maxDepth || acc.size >= maxEntries) {
    state.truncated = true;
    return acc;
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (acc.size >= maxEntries) {
      state.truncated = true;
      break;
    }
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
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if (depth < maxDepth) {
        await scanTree(full, acc, { depth: depth + 1, maxDepth, maxEntries, state });
      } else {
        const sub = await readdir(full).catch(() => []);
        if (sub.length > 0) state.truncated = true;
      }
    }
  }
  return acc;
}

async function collectSubdirsForLinuxInotify(root, out = [], depth = 0, maxDepth = 4, maxDirs = 200) {
  if (!existsSync(root) || depth > maxDepth || out.length >= maxDirs) return out;
  out.push(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= maxDirs) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_CACHE_DIRS.has(entry.name)) continue;
    await collectSubdirsForLinuxInotify(path.join(root, entry.name), out, depth + 1, maxDepth, maxDirs);
  }
  return out;
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
 * Hardened OS-level filesystem write monitor (v1.3.0):
 * - Recursive OS watchers on BOTH sandbox AND every protected directory (ReadDirectoryChangesW on Windows,
 *   FSEvents on macOS, recursive subdirectory inotify on Linux) so short-lived create+delete writes and
 *   deep-subdirectory writes are reliably caught.
 * - Strict completeness enforcement: watcher errors, event buffer overflow on protected directories,
 *   or protected-dir tree truncation mark `auditComplete: false` and FAIL strict assertions instead
 *   of ever silently reporting zero pollution.
 * - Tracks child process tree metadata and verifies sandbox environment containment.
 */
export async function startFsAuditMonitor({
  sandboxRoot,
  protectedDirs = [],
  label = 'audit',
  maxProtectedEvents = 10_000,
  maxSandboxEvents = 25_000,
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

  const sandboxScanState = { truncated: false };
  const sandboxBefore = await scanTree(resolvedSandbox, new Map(), { state: sandboxScanState });
  const protectedBefore = new Map();
  const protectedScanTruncated = [];
  for (const dir of uniqueProtected) {
    const st = { truncated: false };
    protectedBefore.set(dir, await scanTree(dir, new Map(), { state: st }));
    if (st.truncated) protectedScanTruncated.push(dir);
  }

  const watchers = [];
  const watchedDirs = new Set();
  const watcherErrors = [];
  const osSandboxEvents = [];
  const osProtectedEvents = [];
  let droppedSandboxEvents = 0;
  let droppedProtectedEvents = 0;
  let recursiveCoverageIncomplete = false;
  const trackedProcesses = [];
  const startedAt = new Date().toISOString();

  function attachSingleWatcher(dir, bucket, kind, useRecursive) {
    const normKey = `${kind}:${process.platform === 'win32' ? dir.toLowerCase() : dir}`;
    if (watchedDirs.has(normKey)) return;
    if (!useRecursive && kind === 'protected' && watchedDirs.size >= 400) {
      recursiveCoverageIncomplete = true;
      return;
    }
    watchedDirs.add(normKey);
    try {
      const w = watch(dir, { recursive: useRecursive, persistent: false }, (eventType, filename) => {
        const nameStr = filename ? String(filename).replaceAll('\\', '/') : null;
        if (nameStr && SKIP_CACHE_DIRS.has(nameStr.split('/')[0])) return;
        if (kind === 'protected' && nameStr && OS_SHELL_NOISE_FILES.has(path.basename(nameStr).toLowerCase())) return;
        const limit = kind === 'protected' ? maxProtectedEvents : maxSandboxEvents;
        if (bucket.length >= limit) {
          if (kind === 'protected') droppedProtectedEvents += 1;
          else droppedSandboxEvents += 1;
          return;
        }
        const fullPath = filename ? path.resolve(dir, String(filename)) : dir;
        bucket.push({
          ts: new Date().toISOString(),
          osMechanism: process.platform === 'win32' ? 'ReadDirectoryChangesW' : process.platform === 'darwin' ? 'FSEvents' : 'inotify',
          watchRoot: dir,
          recursive: useRecursive,
          eventType,
          filename: nameStr,
          fullPath,
        });
        // On Linux (non-recursive inotify), dynamically attach watchers to newly created subdirectories
        if (!useRecursive && filename) {
          void lstat(fullPath).then(st => {
            if (st.isDirectory() && !st.isSymbolicLink() && !SKIP_CACHE_DIRS.has(path.basename(fullPath))) {
              attachSingleWatcher(fullPath, bucket, kind, false);
            }
          }).catch(() => {});
        }
      });
      w.on('error', err => watcherErrors.push({ kind, dir, message: err.message }));
      watchers.push(w);
    } catch (err) {
      watcherErrors.push({ kind, dir, message: err.message });
    }
  }

  const nativeRecursive = process.platform === 'win32' || process.platform === 'darwin';
  attachSingleWatcher(resolvedSandbox, osSandboxEvents, 'sandbox', nativeRecursive);

  for (const dir of uniqueProtected) {
    if (nativeRecursive) {
      attachSingleWatcher(dir, osProtectedEvents, 'protected', true);
    } else {
      const subdirs = await collectSubdirsForLinuxInotify(dir);
      if (subdirs.length >= 200) recursiveCoverageIncomplete = true;
      for (const sd of subdirs) {
        attachSingleWatcher(sd, osProtectedEvents, 'protected', false);
      }
    }
  }

  function recordProcess({ pid, ppid = process.pid, command, args = [], cwd = null, role = 'child', envSandbox = null } = {}) {
    trackedProcesses.push({
      pid: pid ?? null,
      ppid,
      role,
      command: command ? path.basename(String(command)) : null,
      argsCount: Array.isArray(args) ? args.length : 0,
      cwd: cwd ? path.resolve(cwd) : null,
      envSandbox: envSandbox ? path.resolve(envSandbox) : null,
      recordedAt: new Date().toISOString(),
    });
  }

  function simulateWatcherErrorForTest(dir, message) {
    watcherErrors.push({ kind: 'protected', dir, message });
  }

  async function stop({ assertClean = true, requireCompleteAudit = true } = {}) {
    // Allow kernel event drain on ReadDirectoryChangesW / FSEvents / inotify
    await new Promise(r => setTimeout(r, 120));
    for (const w of watchers) {
      try { w.close(); } catch {}
    }

    const sandboxAfter = await scanTree(resolvedSandbox);
    const sandboxDiff = diffTrees(sandboxBefore, sandboxAfter, resolvedSandbox);

    const protectedViolations = [];
    for (const dir of uniqueProtected) {
      const stAfter = { truncated: false };
      const after = await scanTree(dir, new Map(), { state: stAfter });
      if (stAfter.truncated && !protectedScanTruncated.includes(dir)) protectedScanTruncated.push(dir);
      const diff = diffTrees(protectedBefore.get(dir), after, dir);
      for (const change of diff) {
        protectedViolations.push({ source: 'tree-diff', root: dir, ...change });
      }
    }
    for (const ev of osProtectedEvents) {
      protectedViolations.push({ source: 'os-watcher', ...ev });
    }

    const incompletenessReasons = [];
    if (watcherErrors.length > 0) incompletenessReasons.push(`watcher_errors:${watcherErrors.length}`);
    if (droppedProtectedEvents > 0) incompletenessReasons.push(`protected_event_overflow:${droppedProtectedEvents}`);
    if (recursiveCoverageIncomplete) incompletenessReasons.push('linux_inotify_dir_limit_reached');

    const auditComplete = incompletenessReasons.length === 0;
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
        ? 'ReadDirectoryChangesW(recursive)+TreeDiff'
        : process.platform === 'darwin'
          ? 'FSEvents(recursive)+TreeDiff'
          : 'inotify(recursive-walk+dynamic-subdir)+TreeDiff',
      auditBoundary: {
        preventionEnforced: Boolean(process.env.VIDEOSAVE_TEST_SANDBOX && process.env.VIDEOSAVE_NO_USER_SETTINGS === '1'),
        monitoredScope: 'sandboxRoot + configured protected user directories (Downloads, VideoSave appdata, user outDir)',
        limitations: [
          'OS filesystem watchers observe monitored directories only (not system-wide kernel ETW/auditd across unrelated volumes).',
          'Independent user re-verification on a separate user environment remains required before closing DSH-12.',
        ],
      },
      sandboxRoot: resolvedSandbox,
      protectedDirCount: uniqueProtected.length,
      protectedRecursiveWatched: nativeRecursive || !recursiveCoverageIncomplete,
      osWatcherActiveCount: watchers.length,
      watcherErrors,
      droppedProtectedEvents,
      droppedSandboxEvents,
      protectedScanTruncated,
      auditComplete,
      incompletenessReasons,
      trackedProcesses,
      observedSandboxEventCount: osSandboxEvents.length,
      observedSandboxFileDiffCount: sandboxDiff.filter(d => !d.isDir).length,
      observedSandboxWritePaths: observedSandboxFiles,
      outOfBoundsViolations: protectedViolations,
      outOfBoundsViolationCount: protectedViolations.length,
      clean: protectedViolations.length === 0 && auditComplete,
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
    if (assertClean && requireCompleteAudit && !auditComplete) {
      const error = new Error(
        `OS filesystem audit INCOMPLETE during ${label} (refusing to declare zero pollution): ${incompletenessReasons.join(', ')}`,
      );
      error.code = 'SANDBOX_AUDIT_INCOMPLETE';
      error.auditReport = report;
      throw error;
    }
    return report;
  }

  return {
    sandboxRoot: resolvedSandbox,
    protectedDirs: uniqueProtected,
    recordProcess,
    simulateWatcherErrorForTest,
    stop,
  };
}
