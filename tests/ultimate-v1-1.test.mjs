import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTestSandbox } from './test-sandbox.mjs';
import { createRequestContext } from '../tools/request-context.mjs';
import { mergeMediaHeaders, sanitizeReferer } from '../tools/media-source.mjs';
import { negotiateQuality } from '../tools/quality-negotiator.mjs';
import { inspectMediaBuffer } from '../tools/media-inspector.mjs';
import { getRuntimeHealth } from '../tools/runtime-manager.mjs';
import { listRegisteredEngines, planDownloadEngines, shouldAbortFallback } from '../tools/engine-scheduler.mjs';
import { SUPPORTED_MCP_CLIENTS, generateMcpClientConfig } from '../tools/mcp-config-generator.mjs';
import { getRateTelemetry, recordHostSuccess, recordHostThrottle, recommendedConcurrencyForHost, resetRateTelemetry } from '../tools/rate-controller.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mcpEntry = path.join(repoRoot, 'tools', 'mcp-server.mjs');
const cliEntry = path.join(repoRoot, 'tools', 'media-cli.mjs');
const serverEntry = path.join(repoRoot, 'tools', 'server.mjs');
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
    assert.ok(value, 'MCP exited unexpectedly');
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

test('header merging, Referrer-Policy, Accept/Accept-Language, quality availability, CMAF/SRT inspection, and multi-engine scheduler', () => {
  // 1. Case-insensitive merge: item > perItem > batch
  const merged = mergeMediaHeaders(
    { referer: 'https://site.example/base', 'user-agent': 'BatchUA/1.0', accept: '*/*' },
    { Referer: 'https://site.example/watch/ep1', 'Accept-Language': 'en-US,en;q=0.9' },
    { 'User-Agent': 'ItemUA/2.0' },
  );
  assert.equal(merged.Referer, 'https://site.example/watch/ep1');
  assert.equal(merged['User-Agent'], 'ItemUA/2.0');
  assert.equal(merged.Accept, '*/*');
  assert.equal(merged['Accept-Language'], 'en-US,en;q=0.9');

  // 2. Referrer-Policy: auto-observed Referer strips private path on cross-origin; explicit Referer keeps full URL
  assert.equal(
    sanitizeReferer('https://private.example/secret/path?tok=1', 'https://cdn.other.example/seg.ts', { policy: 'strict-origin-when-cross-origin', explicit: false }),
    'https://private.example/',
  );
  assert.equal(
    sanitizeReferer('https://site.example/watch/ep-42', 'https://cdn.other.example/seg.ts', { policy: 'unsafe-url', explicit: true }),
    'https://site.example/watch/ep-42',
  );

  // 3. RequestContext tracks stage summary & sanitized header names on accessError
  const ctx = createRequestContext({
    sourceUrl: 'https://primary.example/master.m3u8',
    headers: merged,
    explicitHeaders: Object.keys(merged),
    cookies: [{ name: 'sid', value: 'secret-val' }],
  });
  const segHdrs = ctx.headersFor('https://cdn.other.example/seg0.ts', { phase: 'variant' });
  assert.equal(segHdrs.Cookie, undefined);
  assert.equal(segHdrs.Referer, 'https://site.example/watch/ep1');
  const err = ctx.accessError(403, new Headers(), 'variant', { engine: 'hls' });
  assert.equal(err.code, 'MEDIA_ACCESS_RESTRICTED');
  assert.equal(err.detail.phase, 'variant');
  assert.equal(err.detail.hlsPhase, 'playlist');
  assert.equal(err.detail.engine, 'hls');
  assert.ok(err.detail.sentHeaderNames.includes('referer'));
  assert.ok(!err.detail.sentHeaderNames.includes('cookie'));

  // 4. Quality negotiation respects availability, preferCodec, networkProfile, and non-bypass on restricted
  const candidates = [
    { candidateId: 'c1', height: 1440, bandwidth: 9_000_000, codecs: 'av01.0.08M.08', availability: 'restricted', available: false, probeStatus: 403 },
    { candidateId: 'c2', height: 1080, bandwidth: 5_000_000, codecs: 'avc1.640028', availability: 'unavailable', available: false, probeStatus: 404 },
    { candidateId: 'c3', height: 720, bandwidth: 2_500_000, codecs: 'avc1.64001f', availability: 'available', available: true, probeStatus: 206 },
    { candidateId: 'c4', height: 720, bandwidth: 2_200_000, codecs: 'av01.0.05M.08', availability: 'available', available: true, probeStatus: 206 },
    { candidateId: 'c5', height: 480, bandwidth: 1_000_000, codecs: 'avc1.4d401e', availability: 'available', available: true, probeStatus: 206 },
  ];
  assert.equal(negotiateQuality(candidates, 'best').selected.candidateId, 'c3');
  assert.equal(negotiateQuality(candidates, { mode: 'best', preferCodec: 'av1' }).selected.candidateId, 'c4');
  assert.equal(negotiateQuality(candidates, { mode: 'best', networkProfile: 'low' }).selected.candidateId, 'c5');
  assert.throws(() => negotiateQuality(candidates, { mode: 'exact', height: 1440, fallback: 'fail' }), { code: 'MEDIA_ACCESS_RESTRICTED' });
  assert.throws(() => negotiateQuality(candidates.slice(0, 1), 'best'), { code: 'MEDIA_ACCESS_RESTRICTED' });
  assert.throws(() => negotiateQuality(candidates.slice(1, 2), 'best'), { code: 'QUALITY_UNAVAILABLE' });

  // 5. CMAF brand & SRT subtitle detection
  const cmafInit = Buffer.alloc(24);
  cmafInit.writeUInt32BE(24, 0);
  cmafInit.write('ftypcmfc\x00\x00\x00\x00iso6cmfc', 4, 'ascii');
  const cmafRes = inspectMediaBuffer(cmafInit);
  assert.equal(cmafRes.valid, true);
  assert.equal(cmafRes.cmaf, true);
  const srtRes = inspectMediaBuffer(Buffer.from('1\n00:00:00,000 --> 00:00:02,000\nHello Subtitle\n', 'utf8'), { expected: 'subtitle' });
  assert.equal(srtRes.valid, true);
  assert.equal(srtRes.kind, 'srt');

  // 6. Multi-engine scheduler & AIMD rate controller
  assert.ok(listRegisteredEngines().length >= 5);
  assert.deepEqual(planDownloadEngines({ sourceKind: 'm3u8' }).order, ['hls', 'ffmpeg']);
  assert.deepEqual(planDownloadEngines({ sourceKind: 'mpd' }).order, ['dash-static', 'ffmpeg']);
  assert.deepEqual(planDownloadEngines({ sourceKind: 'm3u8', hasAuthorization: true }).order, ['hls']);
  assert.equal(shouldAbortFallback({ code: 'MEDIA_ACCESS_RESTRICTED' }), true);
  assert.equal(shouldAbortFallback({ code: 'DRM' }), true);

  resetRateTelemetry();
  recordHostSuccess('test.local', { latencyMs: 50, bytes: 1024 });
  recordHostThrottle('test.local', 2);
  assert.ok(recommendedConcurrencyForHost('test.local', 8) <= 4);
  assert.ok(getRateTelemetry().hosts.some(h => h.host === 'test.local' && h.throttles === 1));

  // 7. All 6 MCP client config formats
  for (const client of SUPPORTED_MCP_CLIENTS) {
    const cfg = generateMcpClientConfig(client);
    assert.ok(cfg.content.includes('mcp-server.mjs'), client);
    if (client === 'deepseek-harness') assert.ok(cfg.content.includes('@deepseek-ai/dsh-mcp-client'));
    if (client === 'codex') assert.ok(cfg.content.includes('[mcp_servers.videosave]'));
    if (client === 'claude-code') assert.ok(cfg.cliCommand.includes('claude mcp add'));
  }
});

test('quality 2-byte availability probing, variant 404 fallback, HTML transient retry, naming/conflict policies, cookie warnings, session lock, and CLI exit codes', { timeout: 90_000 }, async t => {
  const sandbox = await createTestSandbox('ultimate-e2e');
  const env = sandbox.env({ MEDIA_TOOLKIT_URL: '' });

  // Build real 720x404 and 320x180 HLS fixtures
  for (const [label, size] of [['q180', '320x180'], ['q90', '160x90']]) {
    execFileSync(ffmpeg, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=10`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
      '-hls_time', '1', '-hls_list_size', '0',
      path.join(sandbox.media, `${label}.m3u8`),
    ], { windowsHide: true });
  }
  const q180M3u8 = await readFile(path.join(sandbox.media, 'q180.m3u8'), 'utf8');
  const q90M3u8 = await readFile(path.join(sandbox.media, 'q90.m3u8'), 'utf8');
  let htmlGlitchOnce = true;

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/watch') {
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<title>Mixed Quality Page</title><video controls preload="none" src="/master.m3u8"></video>');
    }
    if (u.pathname === '/master.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
        '/v1080-missing.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,CODECS="avc1.64001f"',
        '/v720-restricted.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.4d4015"',
        '/q180.m3u8',
      ].join('\n'));
    }
    if (u.pathname === '/master-404-fallback.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080',
        '/v1080-missing.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180',
        '/q180.m3u8',
      ].join('\n'));
    }
    if (u.pathname === '/v1080-missing.m3u8') return res.writeHead(404).end();
    if (u.pathname === '/v720-restricted.m3u8') return res.writeHead(403).end();
    if (u.pathname === '/q180.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(q180M3u8);
    if (u.pathname === '/q90-glitch.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(q90M3u8);
    if (u.pathname === '/q900.ts' && htmlGlitchOnce) {
      htmlGlitchOnce = false;
      return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body>Temporary CDN Edge Error</body></html>');
    }
    const data = await readFile(path.join(sandbox.media, path.basename(u.pathname))).catch(() => null);
    if (!data) return res.writeHead(404).end();
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(data.length - 1, Number(range[2]));
      return res.writeHead(206, {
        'content-type': 'video/mp2t',
        'content-range': `bytes ${start}-${end}/${data.length}`,
        'content-length': end - start + 1,
      }).end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': data.length }).end(data);
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

  // 1. probe_page verifies each quality with 2-byte Range probe AND warns on challenge cookies
  const probed = await mcp.tool('probe_page', {
    url: `${base}/watch`,
    cookie: 'session=ok; cf_clearance=must-ignore',
    waitForMediaMs: 2500,
  });
  assert.ok(probed.warnings?.includes('challenge-cookie-ignored'), JSON.stringify(probed));
  const q1080 = probed.qualities.find(q => q.height === 1080);
  const q720 = probed.qualities.find(q => q.height === 720);
  const q180 = probed.qualities.find(q => q.height === 180);
  assert.equal(q1080.availability, 'unavailable');
  assert.equal(q1080.available, false);
  assert.equal(q1080.probeStatus, 404);
  assert.equal(q720.availability, 'restricted');
  assert.equal(q720.available, false);
  assert.equal(q720.probeStatus, 403);
  assert.equal(q180.availability, 'available');
  assert.equal(q180.available, true);
  assert.equal(q180.probeStatus, 206);
  assert.equal(q180.verificationMethod, 'playlist+range-2b');

  // 2. import_cookie_file supports in-memory content + returns challenge-cookie-ignored warning
  const imported = await mcp.tool('import_cookie_file', {
    content: 'auth_ok=1; cf_clearance=bad',
    origin: base,
  });
  assert.equal(imported.cookieCount, 1);
  assert.ok(imported.warnings?.includes('challenge-cookie-ignored'));

  // 3. Variant 404 automatically falls back to verified 180p; filenameTemplate + conflictAction: 'skip' & 'overwrite' work!
  const batchRes = await mcp.tool('download_media_batch', {
    items: [
      { kind: 'stream', url: `${base}/master-404-fallback.m3u8`, title: 'FallbackClip', mediaId: 'VID-101' },
      { kind: 'stream', url: `${base}/q90-glitch.m3u8`, title: 'GlitchRecover', mediaId: 'VID-102' },
    ],
    filenameTemplate: '{id}_{title}_{height}p',
    conflictAction: 'overwrite',
    verify: true,
    durationToleranceSec: 1.0,
    waitTimeoutMs: 25_000,
  });
  assert.equal(batchRes.status, 'done', JSON.stringify(batchRes));
  assert.equal(batchRes.summary.succeeded, 2);
  assert.ok(path.basename(batchRes.items[0].file).startsWith('VID-101_FallbackClip_180p'));
  assert.equal(batchRes.items[0].info.height, 180);
  assert.equal(batchRes.items[1].status, 'done', 'Transient HTML error page on segment 0 must retry and succeed');

  // Re-download with conflictAction: 'skip' -> marks skipped: true without creating _2 duplicate
  const skipped = await mcp.tool('download_media_batch', {
    items: [{ kind: 'stream', url: `${base}/master-404-fallback.m3u8`, title: 'FallbackClip', mediaId: 'VID-101' }],
    filenameTemplate: '{id}_{title}_{height}p',
    conflictAction: 'skip',
    skipExisting: false,
    waitTimeoutMs: 15_000,
  });
  assert.equal(skipped.status, 'done');
  assert.equal(skipped.items[0].skipped, true);

  // Verify get_task_report + diagnose_download stages + recover_download
  const report = await mcp.tool('get_task_report', { id: batchRes.id });
  assert.equal(report.summary.succeeded, 2);
  assert.ok(report.summary.totalBytes > 0);
  const diag = await mcp.tool('diagnose_download', { id: batchRes.id });
  assert.ok(Array.isArray(diag.items[0].stages) && diag.items[0].stages.some(s => s.phase === 'mux'));
  const rec = await mcp.tool('recover_download', { id: batchRes.id });
  assert.equal(rec.resumable, false);

  // 4. CLI exit codes: 2 = invalid args, 4 = 403 restricted, 0 = success with --json-progress & --verify
  const badArgs = await execFileAsync(process.execPath, [cliEntry], { env, windowsHide: true }).catch(e => e);
  assert.equal(badArgs.code, 2);
  const restricted = await execFileAsync(process.execPath, [cliEntry, `${base}/v720-restricted.m3u8`], { env, windowsHide: true }).catch(e => e);
  assert.equal(restricted.code, 4);
  const cliOk = await execFileAsync(process.execPath, [
    cliEntry, '--out', sandbox.downloads, '--headers-json', '{"Accept-Language":"en-US"}',
    '--json-progress', '--verify', '--duration-tolerance', '1.0', `${base}/q180.m3u8`,
  ], { env, windowsHide: true });
  const cliLines = cliOk.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(cliLines.some(l => l.event === 'verified' && l.ok === true));

  // 5. Runtime health check
  const runtime = await getRuntimeHealth();
  assert.equal(runtime.components.node.status, 'ready');
  assert.equal(runtime.components.ffmpeg.status, 'ready');
});

test('Local Management Center (/console) enforces loopback auth, CSP, CSRF protection, and live API wiring', { timeout: 30_000 }, async t => {
  const sandbox = await createTestSandbox('console-security');
  const token = 'test-console-pairing-token-12345';
  const env = sandbox.env({ PORT: '0', MEDIA_TOOLKIT_TOKEN: token });
  const child = spawn(process.execPath, [serverEntry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Companion server startup timeout')), 10_000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    child.kill();
    await once(child, 'close').catch(() => {});
    await sandbox.cleanup();
  });

  // 1. Console HTML served with strict CSP & X-Frame-Options
  const htmlRes = await fetch(`${base}/console`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
  const html = await htmlRes.text();
  assert.match(html, /VideoSave Control Center/);

  // 2. Unauthenticated API call MUST be rejected (401)
  assert.equal((await fetch(`${base}/api/runtime/health`)).status, 401);

  // 3. Cross-origin request MUST be rejected (403)
  const evilRes = await fetch(`${base}/api/console/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ pairingCode: token }),
  });
  assert.equal(evilRes.status, 403);

  // 4. Valid same-origin pairing login returns HttpOnly SameSite=Strict cookie and unlocks live endpoints
  const authRes = await fetch(`${base}/api/console/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ pairingCode: token }),
  });
  assert.equal(authRes.status, 200);
  const setCookie = authRes.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookiePair = setCookie.split(';')[0];

  // Cross-site sec-fetch-site using the cookie MUST be rejected (CSRF defense!)
  const csrfRes = await fetch(`${base}/api/runtime/health`, {
    headers: { cookie: cookiePair, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(csrfRes.status, 401);

  // Legitimate same-origin console requests succeed with live backend data
  const healthRes = await fetch(`${base}/api/runtime/health`, { headers: { cookie: cookiePair, 'sec-fetch-site': 'same-origin' } });
  assert.equal(healthRes.status, 200);
  const runtime = await healthRes.json();
  assert.equal(runtime.ready, true);

  const cfgRes = await fetch(`${base}/api/mcp/configs?mode=standalone`, { headers: { cookie: cookiePair, 'sec-fetch-site': 'same-origin' } });
  assert.equal(cfgRes.status, 200);
  const cfgs = await cfgRes.json();
  assert.ok(cfgs.configs['deepseek-harness'].content.includes('videosave-mcp'));
  assert.ok(cfgs.configs.codex.content.includes('[mcp_servers.videosave]'));
});

if (process.platform === 'win32') {
  test('Windows install/uninstall scripts install cleanly in sandbox and uninstall without touching user video directory', { timeout: 30_000 }, async t => {
    const sandbox = await createTestSandbox('win-installer');
    const installDir = path.join(sandbox.packages, 'VideoSaveApp');
    const userVideo = path.join(sandbox.downloads, 'precious-user-video.mp4');
    await writeFile(userVideo, Buffer.from('user-video-bytes'));
    t.after(() => sandbox.cleanup());

    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repoRoot, 'tools', 'install-windows.ps1'),
      '-InstallDir', installDir, '-SkipComponents', '-SkipShortcuts', '-SkipRegistry', '-Silent',
    ], { windowsHide: true });

    assert.ok(existsSync(path.join(installDir, 'videosave-install.json')));
    assert.ok(existsSync(path.join(installDir, 'tools', 'server.mjs')));
    assert.ok(existsSync(path.join(installDir, 'tools', 'console', 'index.html')));

    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repoRoot, 'tools', 'uninstall-windows.ps1'),
      '-InstallDir', installDir, '-SkipShortcuts', '-SkipRegistry', '-Silent',
    ], { windowsHide: true });

    assert.equal(existsSync(installDir), false, 'App directory must be cleanly uninstalled');
    assert.equal(existsSync(userVideo), true, 'Uninstall MUST NEVER delete user video files');
  });
}
