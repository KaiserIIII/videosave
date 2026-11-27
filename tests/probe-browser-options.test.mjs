import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTestSandbox } from './test-sandbox.mjs';

const mcpEntry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';

async function startMcp(env) {
  const child = spawn(process.execPath, [mcpEntry], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let nextId = 0;
  async function call(method, params, expectError = false) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n');
    const { value } = await replies.next();
    assert.ok(value, 'MCP exited before replying');
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    assert.ok(reply.result && Boolean(reply.result.isError) === expectError, JSON.stringify(reply));
    return reply.result.structuredContent ?? reply.result;
  }
  await call('initialize', { protocolVersion: '2025-11-25' });
  return {
    tool: (name, args, expectError = false) => call('tools/call', { name, arguments: args }, expectError),
    async stop() { child.stdin.end(); await closed; },
  };
}

test('probe_page supports custom userAgent, dedicated isolated browserSessionId persistence, timeoutBudget, and rejects unsafe browserBinary/profileDir', { timeout: 60_000 }, async t => {
  const sandbox = await createTestSandbox('probe-browser-opts');
  const env = sandbox.env({ MEDIA_TOOLKIT_URL: '' });
  const clipFile = path.join(sandbox.media, 'clip.mp4');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-t', '1', '-c:v', 'libx264', '-movflags', '+faststart', clipFile,
  ], { windowsHide: true });
  const clipBytes = await readFile(clipFile);

  const seenUAs = [];
  const seenCookies = [];
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    seenUAs.push({ p, ua: req.headers['user-agent'] });
    if (p === '/clip.mp4') {
      return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': clipBytes.length }).end(clipBytes);
    }
    if (p === '/login') {
      return res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'dedicated_session=logged-in-ok; Path=/; Max-Age=3600',
      }).end('<title>Dedicated Login</title><video controls src="/clip.mp4"></video>');
    }
    if (p === '/member-video') {
      seenCookies.push(req.headers.cookie || '');
      if (!String(req.headers.cookie || '').includes('dedicated_session=logged-in-ok')) {
        return res.writeHead(401, { 'content-type': 'text/html' }).end('<title>Login Required</title>');
      }
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<title>Member Area</title><video controls src="/clip.mp4"></video>');
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const mcp = await startMcp(env);

  t.after(async () => {
    try { await mcp.stop(); } catch {}
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });

  // 1. Custom User-Agent + timeoutBudget
  const customUa = 'VideoSave-DedicatedProbe/2.0 (Test)';
  const p1 = await mcp.tool('probe_page', {
    url: `${base}/login`,
    userAgent: customUa,
    browser: 'auto',
    profileMode: 'dedicated',
    browserSessionId: 'dsh-test-session',
    timeoutBudget: 20_000,
    waitForMediaMs: 2500,
  });
  assert.equal(p1.selection.status, 'selected', JSON.stringify(p1));
  assert.equal(p1.browserSession.browserSessionId, 'dsh-test-session');
  assert.equal(p1.browserSession.profileMode, 'dedicated');
  assert.ok(seenUAs.some(e => e.p === '/login' && e.ua === customUa), JSON.stringify(seenUAs));

  // 2. Query browser session status -> must show dedicated session exists inside sandbox profiles dir
  const status1 = await mcp.tool('get_browser_session_status', { browserSessionId: 'dsh-test-session' });
  assert.equal(status1.session.exists, true);
  assert.equal(status1.session.active, false);
  assert.ok(status1.session.profilePath.startsWith(sandbox.profiles));

  // 3. Second probe reusing the SAME dedicated browserSessionId must retain its authorized session cookie!
  const p2 = await mcp.tool('probe_page', {
    url: `${base}/member-video`,
    profileMode: 'dedicated',
    browserSessionId: 'dsh-test-session',
    waitForMediaMs: 2500,
  });
  assert.equal(p2.selection.status, 'selected', JSON.stringify(p2));
  assert.ok(seenCookies.some(c => c.includes('dedicated_session=logged-in-ok')));

  // 4. Resetting dedicated browser session clears cookies cleanly
  const reset = await mcp.tool('get_browser_session_status', { browserSessionId: 'dsh-test-session', reset: true });
  assert.equal(reset.session.exists, false);

  // 5. Unsafe browserBinary, profileDir, useBrowserCookies, and CRLF userAgent MUST be rejected!
  const badBin = await mcp.tool('probe_page', { url: `${base}/login`, browserBinary: 'C:\\Windows\\System32\\cmd.exe' }, true);
  assert.equal(badBin.code, 'INVALID_BROWSER_BINARY');

  const badUa = await mcp.tool('probe_page', { url: `${base}/login`, userAgent: 'Bad\r\nInjected: 1' }, true);
  assert.equal(badUa.code, 'INVALID_HEADERS');

  const badSession = await mcp.tool('probe_page', { url: `${base}/login`, profileMode: 'dedicated', browserSessionId: '../escape' }, true);
  assert.equal(badSession.code, 'INVALID_BROWSER_SESSION');

  const badCookies = await mcp.tool('probe_page', { url: `${base}/login`, useBrowserCookies: true }, true);
  assert.equal(badCookies.code, 'BROWSER_SESSION_UNAVAILABLE');
});
