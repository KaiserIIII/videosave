import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSandboxPath } from '../tools/preferences.mjs';
import { matchStoredCookies, parseCookieText } from '../tools/cookie-store.mjs';
import { resolveDedicatedProfileDir } from '../tools/browser-sessions.mjs';
import { createRequestContext } from '../tools/request-context.mjs';
import { resolveChromiumExecutable } from '../tools/edge-session.mjs';
import { assertRealDownloadDirsUntouched, createTestSandbox, snapshotRealDownloadDirs } from './test-sandbox.mjs';

const serverEntry = fileURLToPath(new URL('../tools/server.mjs', import.meta.url));
const mcpEntry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));

test('sandbox guardrail refuses accessing settings or downloads outside the active test sandbox', async t => {
  const sandbox = await createTestSandbox('isolation-guard');
  const restoreEnv = sandbox.applyProcessEnv();
  t.after(async () => {
    restoreEnv();
    await sandbox.cleanup();
  });

  // Inside sandbox and os.tmpdir() are permitted
  assert.ok(assertSandboxPath(path.join(sandbox.downloads, 'ok.mp4'), 'output directory'));
  assert.ok(assertSandboxPath(path.join(os.tmpdir(), 'videosave-allowed-tmp'), 'temp'));

  // Outside sandbox (e.g., user's real home Downloads or LOCALAPPDATA) MUST throw TEST_SANDBOX_VIOLATION
  assert.throws(
    () => assertSandboxPath(path.join(os.homedir(), 'Downloads', 'must-not-write'), 'output directory'),
    { code: 'TEST_SANDBOX_VIOLATION' },
  );
  assert.throws(
    () => assertSandboxPath(path.join(os.homedir(), 'Videos', 'real-user-folder'), 'output directory'),
    { code: 'TEST_SANDBOX_VIOLATION' },
  );

  // Snapshot verification catches simulated file addition in a monitored dir
  const fakeMonitored = new Map([[sandbox.media, new Map()]]);
  await assertRealDownloadDirsUntouched(fakeMonitored, 'clean check');
  await writeFile(path.join(sandbox.media, 'leaked.mp4'), 'leak');
  await assert.rejects(
    () => assertRealDownloadDirsUntouched(fakeMonitored, 'simulated leak'),
    /Real download directory polluted/,
  );

  // Confirm real system download directories are untouched
  const realSnap = await snapshotRealDownloadDirs();
  await assertRealDownloadDirsUntouched(realSnap, 'isolation-guard self check');
});

test('security audit: cookie isolation, challenge cookie rejection, browser session traversal, binary allowlist, ReDoS, Host/Origin checks', async t => {
  const sandbox = await createTestSandbox('security-audit');
  const restoreEnv = sandbox.applyProcessEnv();
  t.after(async () => {
    restoreEnv();
    await sandbox.cleanup();
  });

  // 1. Challenge cookies rejected in both Netscape and header formats
  assert.throws(() => parseCookieText('cf_clearance=abc123', 'https://site.example/'), { code: 'INVALID_COOKIE' });
  assert.throws(() => parseCookieText('.site.example\tTRUE\t/\tTRUE\t0\t__cf_bm\ttok', 'https://site.example/'), { code: 'INVALID_COOKIE' });

  // 2. Netscape domain/path/Secure isolation
  const parsed = parseCookieText([
    '# Netscape HTTP Cookie File',
    '#HttpOnly_video.example\tFALSE\t/members\tTRUE\t0\tsid\tsecret1',
    '.evil.example\tTRUE\t/\tFALSE\t0\tbad\tleak',
  ].join('\n'), 'https://video.example/members/1');
  assert.equal(parsed.cookies.length, 1);
  assert.equal(parsed.cookies[0].name, 'sid');
  // Must NOT match insecure HTTP or wrong path
  const wrongPath = parseCookieText(
    '#HttpOnly_video.example\tFALSE\t/members\tTRUE\t0\tsid\tsecret1',
    'http://video.example/members/1',
  );
  assert.equal(wrongPath.cookies.length, 1);
  // matchStoredCookies enforces Secure + path on runtime resolution!
  assert.equal(matchStoredCookies(parsed.cookies, 'https://video.example/members/1').length, 1);
  assert.equal(matchStoredCookies(parsed.cookies, 'http://video.example/members/1').length, 0);
  assert.equal(matchStoredCookies(parsed.cookies, 'https://video.example/public/1').length, 0);

  // 3. Dedicated browserSessionId traversal blocked
  for (const badId of ['../escape', 'a/b', 'a\\b', 'has space', '', '-leading']) {
    assert.throws(() => resolveDedicatedProfileDir(badId), { code: 'INVALID_BROWSER_SESSION' });
  }
  const safeProfile = resolveDedicatedProfileDir('clean_session-1');
  assert.ok(safeProfile.startsWith(sandbox.profiles));

  // 4. browserBinary rejects non-browser executables (command injection / arbitrary exec prevention)
  assert.throws(() => resolveChromiumExecutable({ browserBinary: process.execPath }), { code: 'INVALID_BROWSER_BINARY' });
  assert.throws(() => resolveChromiumExecutable({ browserBinary: 'relative/chrome.exe' }), { code: 'INVALID_BROWSER_BINARY' });

  // 5. Request context never leaks cookies/Authorization cross-origin
  const ctx = createRequestContext({
    sourceUrl: 'https://origin-a.example/master.m3u8',
    headers: { Referer: 'https://origin-a.example/p', 'User-Agent': 'AuditUA' },
    cookies: [{ name: 'token', value: 'priv', domain: 'origin-a.example', path: '/', secure: true }],
  });
  assert.equal(ctx.headersFor('https://origin-b.example/seg.ts').Cookie, undefined);
  assert.equal(ctx.headersFor('https://origin-b.example/seg.ts').Authorization, undefined);

  // 6. Companion HTTP server rejects untrusted Origin and missing Bearer token
  const env = sandbox.env({ PORT: '0', MEDIA_TOOLKIT_TOKEN: 'audit-tok', MEDIA_TOOLKIT_URL: '' });
  const srv = spawn(process.execPath, [serverEntry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const srvClosed = once(srv, 'close');
  const lines = createInterface({ input: srv.stdout })[Symbol.asyncIterator]();
  const { value } = await lines.next();
  const endpoint = value.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(endpoint);

  // 7. MCP server rejects ReDoS idPattern and unsafe open_file path
  const mcp = spawn(process.execPath, [mcpEntry], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const mcpClosed = once(mcp, 'close');
  const mcpLines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  let reqId = 0;
  const mcpCall = async (method, params) => {
    const id = ++reqId;
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return JSON.parse((await mcpLines.next()).value);
  };
  try {
    assert.equal((await fetch(endpoint + '/api/version')).status, 401);
    assert.equal((await fetch(endpoint + '/api/version', { headers: { origin: 'https://evil.example', authorization: 'Bearer audit-tok' } })).status, 403);
    assert.equal((await fetch(endpoint + '/api/version', { headers: { authorization: 'Bearer audit-tok' } })).status, 200);

    await mcpCall('initialize', { protocolVersion: '2025-11-25' });
    const redos = await mcpCall('tools/call', {
      name: 'probe_page',
      arguments: { url: 'http://127.0.0.1:1/watch', harvestCodes: true, idPattern: '(a+)+$' },
    });
    assert.equal(redos.result.isError, true);
    assert.equal(redos.result.structuredContent.code, 'INVALID_ID_PATTERN');

    const traversal = await mcpCall('tools/call', {
      name: 'open_file',
      arguments: { file: path.join(os.homedir(), 'Downloads', 'anything.mp4') },
    });
    assert.equal(traversal.result.isError, true);
    assert.equal(traversal.result.structuredContent.code, 'INVALID_PATH');
  } finally {
    mcp.stdin.end();
    srv.kill();
    await Promise.all([mcpClosed, srvClosed]);
  }
});
