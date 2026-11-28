import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startFsAuditMonitor } from '../tools/fs-audit-monitor.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

test('DSH-12 hardened audit: detects create+immediate-delete, deep-subdir write, subprocess OOB write, and fails on watcher error', async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), 'vs-dsh12-hardened-'));
  const sandboxDir = path.join(tempBase, 'sandbox');
  const protectedDir = path.join(tempBase, 'protected-user-downloads');
  const deepDir = path.join(protectedDir, 'level1', 'level2', 'level3');
  await mkdir(sandboxDir, { recursive: true });
  await mkdir(deepDir, { recursive: true });

  try {
    // Scenario 1 & 2: Short-lived file created then IMMEDIATELY deleted inside protected dir
    // Tree-diff alone would see 0 files changed, but live recursive OS watcher MUST catch it!
    {
      const mon = await startFsAuditMonitor({
        sandboxRoot: sandboxDir,
        protectedDirs: [protectedDir],
        label: 'short-lived-create-delete',
      });
      const ephemeral = path.join(protectedDir, 'ephemeral-write-delete.tmp');
      await writeFile(ephemeral, 'leak', 'utf8');
      await unlink(ephemeral);
      await assert.rejects(
        () => mon.stop({ assertClean: true }),
        err => err.code === 'SANDBOX_REAL_FS_VIOLATION' && err.auditReport.outOfBoundsViolations.some(v => v.source === 'os-watcher'),
        'Must catch create+immediate-delete via OS watcher even when tree-diff is empty',
      );
    }

    // Scenario 3: Deep subdirectory write inside protected directory
    {
      const mon = await startFsAuditMonitor({
        sandboxRoot: sandboxDir,
        protectedDirs: [protectedDir],
        label: 'deep-subdir-write',
      });
      const deepFile = path.join(deepDir, 'sneaky.mp4');
      await writeFile(deepFile, 'payload', 'utf8');
      await assert.rejects(
        () => mon.stop({ assertClean: true }),
        err => err.code === 'SANDBOX_REAL_FS_VIOLATION' && err.auditReport.protectedRecursiveWatched === true,
        'Must catch write in deep subdirectory of protected directory',
      );
      await unlink(deepFile).catch(() => {});
    }

    // Scenario 4: Separate child subprocess out-of-bounds write with process-tree tracking
    {
      const mon = await startFsAuditMonitor({
        sandboxRoot: sandboxDir,
        protectedDirs: [protectedDir],
        label: 'child-process-oob',
      });
      const childTarget = path.join(protectedDir, 'child-escape.bin');
      const child = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(childTarget)}, 'child-oob')`], {
        windowsHide: true,
      });
      mon.recordProcess({ pid: child.pid, command: process.execPath, role: 'oob-child-test', envSandbox: sandboxDir });
      await new Promise((res, rej) => { child.once('exit', res); child.once('error', rej); });
      await assert.rejects(
        () => mon.stop({ assertClean: true }),
        err => err.code === 'SANDBOX_REAL_FS_VIOLATION' && err.auditReport.trackedProcesses.length === 1,
        'Must detect subprocess out-of-bounds write and record tracked process tree',
      );
      await unlink(childTarget).catch(() => {});
    }

    // Scenario 11: Watcher error MUST mark auditComplete=false and fail with SANDBOX_AUDIT_INCOMPLETE (never false clean!)
    {
      const mon = await startFsAuditMonitor({
        sandboxRoot: sandboxDir,
        protectedDirs: [protectedDir],
        label: 'watcher-error-incomplete',
      });
      mon.simulateWatcherErrorForTest(protectedDir, 'EACCES simulated kernel watch failure');
      await assert.rejects(
        () => mon.stop({ assertClean: true, requireCompleteAudit: true }),
        err => err.code === 'SANDBOX_AUDIT_INCOMPLETE' && err.auditReport.auditComplete === false && err.auditReport.clean === false,
        'Must never report clean when OS watcher had errors',
      );
    }
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {});
  }
});

test('DSH-12 symlink / Windows Junction & path traversal escape blocked BEFORE write', async () => {
  const sandbox = await createTestSandbox('dsh12-junction');
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'vs-outside-target-'));
  const restore = sandbox.applyProcessEnv();
  try {
    const linkPath = path.join(sandbox.downloads, 'escape-link');
    await symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const { assertSandboxPath } = await import('../tools/preferences.mjs');
    assert.throws(
      () => assertSandboxPath(path.join(linkPath, 'escaped.mp4'), 'download output directory'),
      err => err.code === 'TEST_SANDBOX_VIOLATION',
      'Symlink/Junction escape must be rejected BEFORE any file is written',
    );
    assert.throws(
      () => assertSandboxPath(path.join(sandbox.downloads, '..', '..', '..', 'outside.mp4'), 'download output directory'),
      err => err.code === 'TEST_SANDBOX_VIOLATION',
      'Parent directory traversal must be rejected',
    );
    if (process.platform === 'win32') {
      assert.throws(
        () => assertSandboxPath('\\\\127.0.0.1\\c$\\temp\\escape.mp4', 'download output directory'),
        err => err.code === 'TEST_SANDBOX_VIOLATION',
        'UNC network path must be rejected in sandbox mode',
      );
    }
    const audit = await sandbox.collectActualWritePaths({ label: 'dsh12-junction' });
    assert.equal(audit.outOfBoundsViolationCount, 0);
    assert.equal(audit.auditComplete, true);
  } finally {
    restore();
    await sandbox.cleanup();
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('DSH-12 conflicting env vars, SQLite settings escape, browser profile escape & companion leak prevention', async () => {
  const sandbox = await createTestSandbox('dsh12-env-sqlite-profile');
  const fakeOutside = await mkdtemp(path.join(os.tmpdir(), 'vs-fake-user-dir-'));
  try {
    // Spawn MCP server with --sandbox=sandbox.root PLUS hostile conflicting env vars pointing outside
    const env = {
      ...process.env,
      OUT_DIR: fakeOutside,
      MEDIA_TOOLKIT_SETTINGS: path.join(fakeOutside, 'hostile-settings.sqlite'),
      MEDIA_TOOLKIT_URL: 'http://127.0.0.1:8765',
      MEDIA_TOOLKIT_LOCAL_PAIRING: '1',
      MEDIA_TOOLKIT_MCP_CLIENT: 'hostile-client',
    };
    const child = spawn(process.execPath, [path.join(repoRoot, 'tools', 'mcp-server.mjs'), `--sandbox=${sandbox.root}`], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const send = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('MCP timeout')), 10_000);
        const onData = chunk => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl >= 0) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(JSON.parse(buf.slice(0, nl)));
          }
        };
        child.stdout.on('data', onData);
      });
    };
    try {
      await send(1, 'initialize', { protocolVersion: '2025-11-25' });
      const ver = await send(2, 'tools/call', { name: 'get_version', arguments: {} });
      const sc = ver.result.structuredContent;
      assert.equal(sc.sandboxActive, true);
      assert.ok(sc.settingsFile.startsWith(sandbox.root), `Expected settingsFile inside sandbox, got ${sc.settingsFile}`);

      // Attempt hostile update_settings pointing to fakeOutside -> MUST be rejected BEFORE persisting to SQLite!
      const badSet = await send(3, 'tools/call', {
        name: 'update_settings',
        arguments: { scope: 'download', settings: { outDir: fakeOutside } },
      });
      assert.equal(badSet.result.isError, true, 'Hostile outDir outside sandbox must be rejected by update_settings');

      const eff = await send(4, 'tools/call', { name: 'get_effective_settings', arguments: {} });
      const effOut = eff.result.structuredContent.download.outDir;
      assert.ok(effOut.startsWith(sandbox.root), `Effective outDir must remain inside sandbox, got ${effOut}`);
    } finally {
      child.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 200));
    }

    // Also verify browser-sessions.mjs dedicated profiles stay strictly inside sandbox
    const restore = sandbox.applyProcessEnv();
    try {
      const { resolveDedicatedProfileDir } = await import('../tools/browser-sessions.mjs');
      const profileDir = resolveDedicatedProfileDir('audit-test-session');
      assert.ok(profileDir.startsWith(sandbox.root), `Dedicated browser profile must be inside sandbox: ${profileDir}`);
    } finally {
      restore();
    }

    const audit = await sandbox.collectActualWritePaths({ label: 'dsh12-env-sqlite-profile' });
    assert.equal(audit.outOfBoundsViolationCount, 0);
    assert.equal(audit.auditComplete, true);
  } finally {
    await sandbox.cleanup();
    await rm(fakeOutside, { recursive: true, force: true }).catch(() => {});
  }
});

test('DSH-12 CLI --sandbox + SIGKILL abnormal termination leaves zero out-of-bounds writes', async () => {
  const sandbox = await createTestSandbox('dsh12-cli-sigkill');
  try {
    const cli = path.join(repoRoot, 'tools', 'media-cli.mjs');
    const { stdout } = await execFileAsync(process.execPath, [cli, `--sandbox=${sandbox.root}`, '--help'], {
      env: sandbox.env(),
      windowsHide: true,
      timeout: 10_000,
    });
    assert.match(stdout, /--sandbox/);

    // Launch server under --sandbox then abruptly SIGKILL it
    const srv = spawn(process.execPath, [path.join(repoRoot, 'tools', 'server.mjs'), `--sandbox=${sandbox.root}`], {
      env: sandbox.env({ PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await new Promise(r => setTimeout(r, 700));
    srv.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 250));

    const audit = await sandbox.collectActualWritePaths({ label: 'dsh12-cli-sigkill' });
    assert.equal(audit.outOfBoundsViolationCount, 0);
    assert.equal(audit.auditComplete, true);
  } finally {
    await sandbox.cleanup();
  }
});
