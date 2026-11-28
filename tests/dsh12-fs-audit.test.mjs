import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFsAuditMonitor } from '../tools/fs-audit-monitor.mjs';
import { assertSandboxPath, writePreferences } from '../tools/preferences.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const mcpEntry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));
const serverEntry = fileURLToPath(new URL('../tools/server.mjs', import.meta.url));
const cliEntry = fileURLToPath(new URL('../tools/media-cli.mjs', import.meta.url));
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';

function stripVideoSaveEnv(base = process.env) {
  return Object.fromEntries(
    Object.entries(base).filter(([k]) => !/^(?:OUT_DIR|MEDIA_TOOLKIT_|VIDEOSAVE_)/i.test(k)),
  );
}

async function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliEntry, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
    child.once('close', status => resolve({ status, pid: child.pid, stdout, stderr }));
  });
}

async function createTinyMp4Server(workDir) {
  const mp4 = path.join(workDir, 'sample.mp4');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', mp4,
  ], { windowsHide: true });
  const bytes = await readFile(mp4);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length }).end(bytes);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/sample.mp4`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    },
  };
}

test('DSH-12 forensic audit: OS filesystem watcher verifies 8 scenarios + symlink/junction escape rejection', { timeout: 60_000 }, async t => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'videosave-dsh12-forensic-'));
  const fakeUserLocalAppData = path.join(outer, 'FakeLocalAppData');
  const fakeUserVideoSaveDir = path.join(fakeUserLocalAppData, 'VideoSave');
  const fakeUserRealOutDir = path.join(outer, 'FakeRealUserDownloads');
  const fakeUserSqlite = path.join(fakeUserVideoSaveDir, 'settings.sqlite');
  const fixtureDir = path.join(outer, 'fixture-media');
  await Promise.all([
    mkdir(fakeUserVideoSaveDir, { recursive: true }),
    mkdir(fakeUserRealOutDir, { recursive: true }),
    mkdir(fixtureDir, { recursive: true }),
  ]);
  const media = await createTinyMp4Server(fixtureDir);
  t.after(async () => {
    await media.close();
    await rm(outer, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });

  // Pre-populate simulated real user settings.sqlite pointing to fakeUserRealOutDir
  const prevSettings = process.env.MEDIA_TOOLKIT_SETTINGS;
  const prevNoUser = process.env.VIDEOSAVE_NO_USER_SETTINGS;
  const prevSb = process.env.VIDEOSAVE_TEST_SANDBOX;
  delete process.env.VIDEOSAVE_NO_USER_SETTINGS;
  delete process.env.VIDEOSAVE_TEST_SANDBOX;
  process.env.MEDIA_TOOLKIT_SETTINGS = fakeUserSqlite;
  writePreferences('download', { outDir: fakeUserRealOutDir });
  if (prevSettings === undefined) delete process.env.MEDIA_TOOLKIT_SETTINGS; else process.env.MEDIA_TOOLKIT_SETTINGS = prevSettings;
  if (prevNoUser !== undefined) process.env.VIDEOSAVE_NO_USER_SETTINGS = prevNoUser;
  if (prevSb !== undefined) process.env.VIDEOSAVE_TEST_SANDBOX = prevSb;

  // Scenario 1, 2, 3: Fresh sandbox + pre-existing real user config + SQLite with different outDir
  const sb1 = await createTestSandbox('dsh12-s123');
  const mon1 = await startFsAuditMonitor({
    sandboxRoot: sb1.root,
    protectedDirs: [fakeUserRealOutDir, fakeUserVideoSaveDir],
    label: 'dsh12-scenarios-1-2-3',
  });
  try {
    const envWithFakeUser = {
      ...stripVideoSaveEnv(),
      LOCALAPPDATA: fakeUserLocalAppData,
      HOME: outer,
    };
    const r1 = await runCli(['--sandbox-dir', sb1.root, media.url], envWithFakeUser);
    mon1.recordProcess({ pid: r1.pid, command: 'node', args: ['media-cli.mjs', '--sandbox-dir'], role: 'cli-sandbox' });
    assert.equal(r1.status, 0, r1.stderr || r1.stdout);
    const out1 = JSON.parse(r1.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(path.resolve(out1.actualOutDir), path.resolve(sb1.downloads));
    assert.equal(path.resolve(path.dirname(out1.items[0].file)), path.resolve(sb1.downloads));
    const report1 = await mon1.stop({ assertClean: true });
    assert.equal(report1.outOfBoundsViolationCount, 0);
    assert.ok(report1.observedSandboxWritePaths.some(p => p.endsWith('.mp4')));
  } finally {
    await sb1.cleanup();
  }

  // Scenario 4: CLI explicit --out overrides SQLite outDir (monitored via OS FS watcher)
  const sb4 = await createTestSandbox('dsh12-s4-cli-out');
  const mon4 = await startFsAuditMonitor({
    sandboxRoot: sb4.root,
    protectedDirs: [fakeUserRealOutDir],
    label: 'dsh12-scenario-4-cli-out',
  });
  try {
    const explicitOut = path.join(sb4.root, 'explicit-cli-out');
    const r4 = await runCli(['--out', explicitOut, media.url], {
      ...stripVideoSaveEnv(),
      LOCALAPPDATA: fakeUserLocalAppData,
      MEDIA_TOOLKIT_SETTINGS: fakeUserSqlite,
    });
    assert.equal(r4.status, 0, r4.stderr || r4.stdout);
    const out4 = JSON.parse(r4.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(path.resolve(out4.actualOutDir), path.resolve(explicitOut));
    assert.equal(path.resolve(path.dirname(out4.items[0].file)), path.resolve(explicitOut));
    const report4 = await mon4.stop({ assertClean: true });
    assert.equal(report4.outOfBoundsViolationCount, 0);
  } finally {
    await sb4.cleanup();
  }

  // Scenario 5: Running host companion exists -> sandboxed MCP ignores ambient MEDIA_TOOLKIT_URL
  const sb5 = await createTestSandbox('dsh12-s5-ambient-srv');
  const hostCompRoot = path.join(outer, 'fake-host-companion');
  await mkdir(hostCompRoot, { recursive: true });
  const hostSrv = spawn(process.execPath, [serverEntry, `--sandbox=${hostCompRoot}`], {
    env: { ...stripVideoSaveEnv(), PORT: '0', MEDIA_TOOLKIT_TOKEN: 'host-secret-tok', VIDEOSAVE_SANDBOX_ALLOW_COMPANION: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const hostClosed = once(hostSrv, 'close');
  const hostLines = createInterface({ input: hostSrv.stdout })[Symbol.asyncIterator]();
  try {
    const line1 = (await hostLines.next()).value;
    const hostEndpoint = line1.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(hostEndpoint);
    const mcp = spawn(process.execPath, [mcpEntry, `--sandbox=${sb5.root}`], {
      env: {
        ...stripVideoSaveEnv(),
        LOCALAPPDATA: fakeUserLocalAppData,
        MEDIA_TOOLKIT_URL: hostEndpoint,
        MEDIA_TOOLKIT_TOKEN: 'host-secret-tok',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const mcpClosed = once(mcp, 'close');
    const mcpLines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
    let mid = 0;
    const call = async (method, params) => {
      const id = ++mid;
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return JSON.parse((await mcpLines.next()).value);
    };
    try {
      await call('initialize', { protocolVersion: '2025-11-25' });
      const ver = (await call('tools/call', { name: 'get_version', arguments: {} })).result.structuredContent;
      assert.equal(ver.mode, 'standalone', 'Sandboxed MCP must ignore ambient MEDIA_TOOLKIT_URL');
      const eff = (await call('tools/call', { name: 'get_effective_settings', arguments: {} })).result.structuredContent;
      assert.equal(path.resolve(eff.download.outDir), path.resolve(sb5.downloads));
    } finally {
      mcp.stdin.end();
      await mcpClosed;
    }
  } finally {
    hostSrv.kill();
    await hostClosed;
    await sb5.cleanup();
  }

  // Scenario 6 + Negative Symlink / Junction Escape Test (rejected BEFORE writing a single byte)
  const sb6 = await createTestSandbox('dsh12-s6-negative');
  const restore6 = sb6.applyProcessEnv();
  const mon6 = await startFsAuditMonitor({
    sandboxRoot: sb6.root,
    protectedDirs: [fakeUserRealOutDir, fakeUserVideoSaveDir],
    label: 'dsh12-scenario-6-negative',
  });
  try {
    // 6a. Direct escape & UNC path blocked
    assert.throws(() => assertSandboxPath(fakeUserRealOutDir, 'outDir'), { code: 'TEST_SANDBOX_VIOLATION' });
    assert.throws(() => assertSandboxPath('\\\\evil-server\\share\\video.mp4', 'outDir'), { code: 'TEST_SANDBOX_VIOLATION' });
    // 6b. Symlink / Windows Junction inside sandbox pointing to fakeUserRealOutDir MUST be caught BEFORE write!
    const junctionInsideSandbox = path.join(sb6.downloads, 'escape-link');
    await symlink(fakeUserRealOutDir, junctionInsideSandbox, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => assertSandboxPath(path.join(junctionInsideSandbox, 'escaped.mp4'), 'download output'),
      { code: 'TEST_SANDBOX_VIOLATION' },
    );
    assert.equal(existsSync(path.join(fakeUserRealOutDir, 'escaped.mp4')), false);

    // 6c. Conflicting env vars: CLI with --sandbox-dir + conflicting --out outside sandbox must refuse with exit != 0
    const badCli = await runCli(['--sandbox-dir', sb6.root, '--out', fakeUserRealOutDir, media.url], {
      ...stripVideoSaveEnv(),
      LOCALAPPDATA: fakeUserLocalAppData,
    });
    assert.notEqual(badCli.status, 0);
    assert.match(badCli.stdout + badCli.stderr, /TEST_SANDBOX_VIOLATION/);
    const report6 = await mon6.stop({ assertClean: true });
    assert.equal(report6.outOfBoundsViolationCount, 0);
  } finally {
    restore6();
    await sb6.cleanup();
  }

  // Scenario 7: Abnormal SIGKILL exit leaves zero writes outside sandbox
  const sb7 = await createTestSandbox('dsh12-s7-sigkill');
  const mon7 = await startFsAuditMonitor({
    sandboxRoot: sb7.root,
    protectedDirs: [fakeUserRealOutDir, fakeUserVideoSaveDir],
    label: 'dsh12-scenario-7-sigkill',
  });
  try {
    const srv = spawn(process.execPath, [serverEntry, `--sandbox=${sb7.root}`], {
      env: { ...stripVideoSaveEnv(), PORT: '0', LOCALAPPDATA: fakeUserLocalAppData },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await once(srv.stdout, 'data');
    srv.kill('SIGKILL');
    await once(srv, 'close');
    const report7 = await mon7.stop({ assertClean: true });
    assert.equal(report7.outOfBoundsViolationCount, 0);
  } finally {
    await sb7.cleanup();
  }

  // Scenario 8: 4 concurrent sandboxed download processes — zero cross-talk, zero host writes
  const sandboxes8 = await Promise.all([0, 1, 2, 3].map(i => createTestSandbox(`dsh12-s8-p${i}`)));
  const mon8 = await startFsAuditMonitor({
    sandboxRoot: sandboxes8[0].root,
    protectedDirs: [fakeUserRealOutDir, fakeUserVideoSaveDir],
    label: 'dsh12-scenario-8-concurrent',
  });
  try {
    const runs = await Promise.all(sandboxes8.map(sb => runCli(['--sandbox-dir', sb.root, media.url], {
      ...stripVideoSaveEnv(),
      LOCALAPPDATA: fakeUserLocalAppData,
    })));
    for (let i = 0; i < runs.length; i++) {
      assert.equal(runs[i].status, 0, runs[i].stderr || runs[i].stdout);
      const out = JSON.parse(runs[i].stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(path.resolve(path.dirname(out.items[0].file)), path.resolve(sandboxes8[i].downloads));
      assert.ok((await stat(out.items[0].file)).size > 0);
    }
    const report8 = await mon8.stop({ assertClean: true });
    assert.equal(report8.outOfBoundsViolationCount, 0);
  } finally {
    await Promise.all(sandboxes8.map(sb => sb.cleanup()));
  }
});
