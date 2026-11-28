import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { negotiateQuality, normalizeQualitySpec } from '../tools/quality-negotiator.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const execFileAsync = promisify(execFile);
const mcpEntry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));
const cliEntry = fileURLToPath(new URL('../tools/media-cli.mjs', import.meta.url));
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

test('smart quality negotiator handles best, max, auto, lowest, cap, exact, budget, HDR preference, and fallbacks', () => {
  const variants = [
    { height: 360, bandwidth: 500_000, codecs: 'avc1.4d401e', url: 'https://v.test/360.m3u8' },
    { height: 720, bandwidth: 2_000_000, codecs: 'avc1.64001f', url: 'https://v.test/720.m3u8' },
    { height: 1080, bandwidth: 4_500_000, codecs: 'avc1.640028', hdr: false, url: 'https://v.test/1080-sdr.m3u8' },
    { height: 1080, bandwidth: 5_000_000, codecs: 'hvc1.2.4.L120', hdr: true, url: 'https://v.test/1080-hdr.m3u8' },
  ];

  assert.equal(negotiateQuality(variants, 'best').selected.url, 'https://v.test/1080-hdr.m3u8');
  assert.equal(negotiateQuality(variants, 'max').selected.height, 1080);
  assert.equal(negotiateQuality(variants, 'lowest').selected.height, 360);
  assert.equal(negotiateQuality(variants, 720).selected.height, 720);
  assert.equal(negotiateQuality(variants, 900).selected.height, 720);
  assert.equal(negotiateQuality(variants, { mode: 'cap', height: 240, fallback: 'higher' }).selected.height, 360);
  assert.throws(() => negotiateQuality(variants, { mode: 'cap', height: 240, fallback: 'fail' }), { code: 'QUALITY_UNAVAILABLE' });
  assert.equal(negotiateQuality(variants, 'exact:720').selected.height, 720);
  assert.throws(() => negotiateQuality(variants, { mode: 'exact', height: 480, fallback: 'fail' }), { code: 'QUALITY_UNAVAILABLE' });
  assert.equal(negotiateQuality(variants, { mode: 'exact', height: 480, fallback: 'closest' }).selected.height, 360);
  assert.equal(negotiateQuality(variants, { mode: 'budget', maxBitrate: 2_500_000 }).selected.height, 720);
  assert.equal(negotiateQuality(variants, { mode: 'best', preferHdr: false }).selected.url, 'https://v.test/1080-sdr.m3u8');
  assert.equal(normalizeQualitySpec('best').mode, 'best');
});

test('batch queue controls, identifier extraction, quality verification, cookie import, CLI Netscape JSONL, and DSH diagnostic tools', { timeout: 75_000 }, async t => {
  const sandbox = await createTestSandbox('batch-quality-dsh');
  const env = sandbox.env({ MEDIA_TOOLKIT_URL: '' });

  // Create two distinct resolutions (160x90 low and 320x180 high)
  for (const [label, size] of [['low', '160x90'], ['high', '320x180']]) {
    execFileSync(ffmpeg, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=10`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
      '-hls_time', '1', '-hls_list_size', '0',
      path.join(sandbox.media, `${label}.m3u8`),
    ], { windowsHide: true });
  }
  const lowM3u8 = await readFile(path.join(sandbox.media, 'low.m3u8'), 'utf8');
  const highM3u8 = await readFile(path.join(sandbox.media, 'high.m3u8'), 'utf8');

  let slowSecond = false;
  const seenCookieRequests = [];
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.headers.cookie) seenCookieRequests.push({ path: u.pathname, cookie: req.headers.cookie });
    if (u.pathname === '/catalog') {
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        '<title>Catalog</title><main><p>Episodes: EP_001, EP_002, EP_001 and STD-900</p></main>',
      );
    }
    if (u.pathname === '/watch/EP_001' || u.pathname === '/watch/EP_002') {
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<title>Episode ${u.pathname.slice(7)}</title><video controls preload="none" src="/master.m3u8"></video>`,
      );
    }
    if (u.pathname === '/private-master.m3u8') {
      if (!String(req.headers.cookie || '').includes('auth_tok=netscape-secret-val')) {
        return res.writeHead(401).end();
      }
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(highM3u8);
    }
    if (u.pathname === '/master.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="avc1.4d400c,mp4a.40.2",FRAME-RATE=10.0\n/low.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x180,CODECS="avc1.640015,mp4a.40.2",FRAME-RATE=10.0\n/high.m3u8\n',
      );
    }
    if (u.pathname === '/low.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(lowM3u8);
    if (u.pathname === '/high.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(highM3u8);
    if (u.pathname === '/denied.m3u8') return res.writeHead(403).end();
    if (slowSecond && u.pathname === '/low0.ts') await sleep(600);
    const data = await readFile(path.join(sandbox.media, path.basename(u.pathname))).catch(() => null);
    if (!data) return res.writeHead(404).end();
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

  // 1. DSH version, capabilities, engine capabilities, effective settings
  const ver = await mcp.tool('get_version', {});
  assert.ok(ver.version && ver.entry.endsWith('mcp-server.mjs'));
  assert.equal(ver.mismatch, false);
  const caps = await mcp.tool('get_capabilities', {});
  assert.equal(caps.features.unifiedRequestContext, true);
  assert.equal(caps.features.netscapeCookieFile, true);
  assert.equal(caps.features.smartQualityNegotiation, true);
  const engines = await mcp.tool('get_engine_capabilities', {});
  for (const requiredEngine of ['http', 'hls', 'dash-static', 'bilibili-native', 'internet-archive-native', 'wikimedia-native']) {
    assert.ok(engines.transfer.includes(requiredEngine), `missing required engine: ${requiredEngine}`);
  }
  assert.equal(engines.ffmpeg.available, true);
  const eff = await mcp.tool('get_effective_settings', {});
  assert.equal(eff.download.outDir, sandbox.downloads);

  // 2. Generalized identifier extraction + previewOnly batch confirmation
  const catalog = await mcp.tool('probe_page', {
    url: `${base}/catalog`,
    harvestCodes: true,
    idPattern: 'EP_\\d{3}',
    urlTemplate: `${base}/watch/{id}`,
    waitMs: 500,
  });
  assert.deepEqual(catalog.codes, ['EP_001', 'EP_002']);
  assert.deepEqual(catalog.resolvedUrls, [`${base}/watch/EP_001`, `${base}/watch/EP_002`]);

  const preview = await mcp.tool('start_batch', {
    items: [{ kind: 'id', id: 'EP_001' }, { kind: 'id', id: 'EP_002' }, { kind: 'id', id: 'EP_001' }],
    urlTemplate: `${base}/watch/{id}`,
    deduplicate: true,
    previewOnly: true,
  });
  assert.equal(preview.previewOnly, true);
  assert.equal(preview.total, 2);
  assert.equal(preview.deduplicatedCount, 1);
  assert.deepEqual(preview.items.map(i => i.url), [`${base}/watch/EP_001`, `${base}/watch/EP_002`]);

  // 3. download_best_media automatically selects highest available quality (320x180) and verifies output with FFprobe!
  const best = await mcp.tool('download_best_media', {
    url: `${base}/watch/EP_001`,
    quality: 'best',
    verify: true,
    waitTimeoutMs: 20_000,
  });
  assert.equal(best.status, 'done', JSON.stringify(best));
  assert.equal(best.item.info.height, 180);
  assert.equal(best.item.info.width, 320);
  assert.equal(best.verification.ok, true);
  assert.equal(best.verification.height, 180);
  assert.equal(best.verification.hasVideo, true);
  assert.equal(best.verification.hasAudio, true);

  // Verify standalone verify_download & get_task_report
  const verified = await mcp.tool('verify_download', { id: best.id });
  assert.equal(verified.ok, true);
  assert.equal(verified.items[0].verification[0].status, 'verified');
  assert.equal(verified.items[0].verification[0].info.height, 180);
  const report = await mcp.tool('get_task_report', { id: best.id });
  assert.equal(report.status, 'done');
  assert.equal(report.items[0].engine, 'hls');

  // 4. Pause, resume, single-item cancel, and continueOnError: false
  slowSecond = true;
  const pausedBatch = await mcp.tool('start_batch', {
    items: [
      { kind: 'stream', url: `${base}/low.m3u8?p=1`, title: 'PauseItem1' },
      { kind: 'stream', url: `${base}/low.m3u8?p=2`, title: 'PauseItem2' },
      { kind: 'stream', url: `${base}/low.m3u8?p=3`, title: 'PauseItem3' },
    ],
    concurrency: 1,
  });
  await mcp.tool('pause_download', { id: pausedBatch.id });
  await mcp.tool('cancel_download', { id: pausedBatch.id, itemIndex: 1 });
  await mcp.tool('resume_download', { id: pausedBatch.id });
  const pausedDone = await mcp.tool('wait_for_download', { id: pausedBatch.id, timeoutMs: 20_000 });
  assert.equal(pausedDone.items[0].status, 'done', JSON.stringify(pausedDone));
  assert.equal(pausedDone.items[1].status, 'cancelled', JSON.stringify(pausedDone));
  assert.equal(pausedDone.items[2].status, 'done', JSON.stringify(pausedDone));
  slowSecond = false;

  // continueOnError: false stops remaining items after first error + diagnose_download reports structured cause
  const stopBatch = await mcp.tool('start_batch', {
    items: [
      { kind: 'stream', url: `${base}/denied.m3u8`, title: 'DeniedFirst' },
      { kind: 'stream', url: `${base}/low.m3u8?after=deny`, title: 'SkippedSecond' },
    ],
    concurrency: 1,
    continueOnError: false,
  });
  const stopRes = await mcp.tool('wait_for_download', { id: stopBatch.id, timeoutMs: 15_000 });
  assert.equal(stopRes.items[0].errorCode, 'MEDIA_ACCESS_RESTRICTED');
  assert.equal(stopRes.items[1].status, 'cancelled');
  const diag = await mcp.tool('diagnose_download', { id: stopBatch.id });
  assert.equal(diag.items[0].category, 'access-denied');
  assert.equal(diag.items[0].retryable, false);

  // 5. Netscape cookies.txt import via MCP import_cookie_file (zero secret leakage!) + authenticated download
  const netscapeFile = path.join(sandbox.cookies, 'netscape-cookies.txt');
  const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
  await writeFile(netscapeFile, [
    '# Netscape HTTP Cookie File',
    `127.0.0.1\tFALSE\t/\tFALSE\t${futureExpiry}\tauth_tok\tnetscape-secret-val`,
    `other.example\tFALSE\t/\tFALSE\t${futureExpiry}\tother_tok\tmust-not-send`,
  ].join('\n'));
  const imported = await mcp.tool('import_cookie_file', { filePath: netscapeFile, origin: base });
  assert.ok(imported.cookieSessionId);
  assert.equal(imported.format, 'netscape');
  assert.equal(imported.cookieCount, 1);
  assert.ok(!JSON.stringify(imported).includes('netscape-secret-val'), 'Raw cookie value MUST NEVER appear in MCP output');

  const authBatch = await mcp.tool('start_download', {
    items: [{ kind: 'stream', url: `${base}/private-master.m3u8`, title: 'NetscapeAuthMcp' }],
    cookieSessionId: imported.cookieSessionId,
  });
  const authDone = await mcp.tool('wait_for_download', { id: authBatch.id, timeoutMs: 15_000 });
  assert.equal(authDone.status, 'done', JSON.stringify(authDone));

  // 6. CLI --cookie-file with Netscape cookies.txt + JSONL structured progress output
  const cliResult = await execFileAsync(process.execPath, [
    cliEntry, '--cookie-file', netscapeFile, '--quality', 'best', '--connections', '4', `${base}/private-master.m3u8`,
  ], { env, windowsHide: true });
  assert.doesNotMatch(cliResult.stdout, /netscape-secret-val/);
  const lines = cliResult.stdout.trim().split('\n').map(l => JSON.parse(l));
  const finalLine = lines.at(-1);
  assert.equal(finalLine.status, 'done');
  assert.equal(finalLine.items[0].engine, 'hls');
  assert.equal(finalLine.items[0].verification.ok, true);
  assert.equal(finalLine.items[0].verification.height, 180);
});
