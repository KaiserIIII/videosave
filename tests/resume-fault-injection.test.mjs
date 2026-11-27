import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTestSandbox } from './test-sandbox.mjs';

const mcpEntry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));
const serverEntry = fileURLToPath(new URL('../tools/server.mjs', import.meta.url));
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

async function startMcp(env) {
  const child = spawn(process.execPath, [mcpEntry], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n');
    const { value } = await replies.next();
    assert.ok(value, 'MCP exited unexpectedly');
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply));
    return reply.result.structuredContent ?? reply.result;
  }
  await call('initialize', { protocolVersion: '2025-11-25' });
  return {
    child,
    tool: (name, args) => call('tools/call', { name, arguments: args }),
    async stop(force = false) {
      if (force) child.kill('SIGKILL');
      else child.stdin.end();
      await closed;
    },
  };
}

function streamHash(file) {
  return execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-c', 'copy', '-f', 'streamhash', '-'],
    { encoding: 'utf8', windowsHide: true });
}

test('fault injection at 25%, 50%, 90% SIGKILL + single corrupted segment detection + manifest change + cancel cleanup on HLS', { timeout: 90_000 }, async t => {
  const sandbox = await createTestSandbox('resume-hls-faults');
  const env = sandbox.env({ MEDIA_TOOLKIT_URL: '' });
  const count = 20;
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(count), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'long.m3u8'),
  ], { windowsHide: true });

  const manifest = (await readFile(path.join(sandbox.media, 'long.m3u8'), 'utf8')).trim();
  const segments = manifest.split(/\r?\n/).filter(l => l.endsWith('.ts'));
  assert.equal(segments.length, count);
  const segBytes = new Map(await Promise.all(segments.map(async s => [s, await readFile(path.join(sandbox.media, s))])));
  const refMp4 = path.join(sandbox.media, 'ref.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', path.join(sandbox.media, 'long.m3u8'), '-c', 'copy', refMp4], { windowsHide: true });
  const expectedHash = streamHash(refMp4);

  let holdFrom = count;
  const hitCounts = new Map();
  let mcp;
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (p === 'long.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(manifest);
    const idx = segments.indexOf(p);
    if (idx < 0) return res.writeHead(404).end();
    hitCounts.set(idx, (hitCounts.get(idx) ?? 0) + 1);
    const buf = segBytes.get(p);
    if (idx >= holdFrom) {
      res.writeHead(200, { 'content-length': buf.length });
      res.write(buf.subarray(0, 64));
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': buf.length }).end(buf);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    try { await mcp?.stop(true); } catch {}
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });

  // Kill at 25% (5/20), 50% (10/20), and 90% (18/20) on separate titles, verifying zero re-download of completed segments!
  for (const [label, stopIdx] of [['25pct', 5], ['50pct', 10], ['90pct', 18]]) {
    hitCounts.clear();
    holdFrom = stopIdx;
    const req = { items: [{ kind: 'stream', url: `${origin}/long.m3u8?run=${label}`, title: `Fault-${label}` }], connections: 4 };
    mcp = await startMcp(env);
    const { id } = await mcp.tool('start_download', req);
    const deadline = AbortSignal.timeout(10_000);
    while (true) {
      const state = await mcp.tool('get_progress', { id });
      const completed = state.items[0].segments?.completed ?? 0;
      if (completed >= stopIdx && (hitCounts.get(stopIdx) ?? 0) >= 1) break;
      await sleep(30, undefined, { signal: deadline });
    }
    await mcp.stop(true);
    mcp = null;
    server.closeAllConnections();

    // If this is 50pct, intentionally corrupt segment 2 on disk to prove SHA-256 detects & re-downloads ONLY segment 2!
    if (label === '50pct') {
      const stagingDir = path.join(sandbox.downloads, `.media-toolkit-${id}-0`);
      const cpDir = (await readdir(stagingDir)).find(n => n.startsWith('segments-'));
      assert.ok(cpDir, 'Expected HLS checkpoint dir');
      const corruptedPath = path.join(stagingDir, cpDir, 'video-2.ts');
      const orig = await readFile(corruptedPath);
      const flipped = Buffer.from(orig);
      flipped[10] ^= 0xff;
      await writeFile(corruptedPath, flipped);
    }

    hitCounts.clear();
    holdFrom = count;
    mcp = await startMcp(env);
    const resumed = await mcp.tool('start_download', req);
    assert.equal(resumed.id, id);
    const done = await mcp.tool('wait_for_download', { id, timeoutMs: 15_000 });
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(streamHash(done.items[0].file), expectedHash, `Streamhash mismatch after ${label} kill`);

    const redownloaded = [...hitCounts.keys()].sort((a, b) => a - b);
    const expected = Array.from({ length: count - stopIdx }, (_, i) => stopIdx + i);
    if (label === '50pct') expected.unshift(2); // corrupted segment 2 MUST be redownloaded, none of 0,1,3..9!
    assert.deepEqual(redownloaded, expected, `Unexpected redownloaded segments at ${label}: ${JSON.stringify(redownloaded)}`);
    await mcp.stop();
    mcp = null;
  }
});

test('static DASH fault injection with single corrupted segment recovery and cancel cleanup', { timeout: 45_000 }, async t => {
  const sandbox = await createTestSandbox('resume-dash-faults');
  const env = sandbox.env({ MEDIA_TOOLKIT_URL: '' });
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'dash', '-seg_duration', '1',
    '-init_seg_name', 'init-$RepresentationID$.m4s',
    '-media_seg_name', 'chunk-$RepresentationID$-$Number$.m4s',
    'dash.mpd',
  ], { cwd: sandbox.media, windowsHide: true });

  let failChunk5 = true;
  const requests = [];
  const server = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname.slice(1);
    requests.push(p);
    if (failChunk5 && p === 'chunk-0-5.m4s') return res.writeHead(503).end();
    const bytes = await readFile(path.join(sandbox.media, p)).catch(() => null);
    if (!bytes) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let mcp = await startMcp(env);

  t.after(async () => {
    try { await mcp?.stop(true); } catch {}
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });

  const req = { items: [{ kind: 'stream', url: `${origin}/dash.mpd`, title: 'DashResume' }], connections: 4 };
  const { id } = await mcp.tool('start_download', req);
  const first = await mcp.tool('wait_for_download', { id, timeoutMs: 12_000 });
  assert.equal(first.items[0].errorCode, 'DASH_TRANSFER_INTERRUPTED', JSON.stringify(first));
  assert.equal(first.resumable, true);

  // Corrupt one already-downloaded DASH part in checkpoint to prove SHA-256 detects & re-downloads it!
  const staging = path.join(sandbox.downloads, `.media-toolkit-${id}-0`);
  const cpName = (await readdir(staging)).find(n => n.startsWith('dash-'));
  assert.ok(cpName, 'Expected DASH checkpoint directory');
  const cpDir = path.join(staging, cpName);
  // p0-t0-s0.part is init-0.m4s; p0-t0-s1.part is chunk-0-1.m4s
  const partFiles = (await readdir(cpDir)).filter(n => n.endsWith('.part') && n.startsWith('p0-t0-s1'));
  assert.ok(partFiles.length === 1, JSON.stringify(await readdir(cpDir)));
  const corruptPart = path.join(cpDir, partFiles[0]);
  const rawPart = Buffer.from(await readFile(corruptPart));
  rawPart[12] ^= 0xff;
  await writeFile(corruptPart, rawPart);

  // Disconnect MCP cleanly and reconnect
  await mcp.stop();
  requests.length = 0;
  failChunk5 = false;
  mcp = await startMcp(env);

  const resumed = await mcp.tool('start_download', req);
  assert.equal(resumed.id, id);
  const done = await mcp.tool('wait_for_download', { id, timeoutMs: 15_000 });
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(Math.abs(done.items[0].info.duration - 6) < 0.25);
  // Corrupted chunk-0-1.m4s (index 0) and failed chunk-0-5.m4s MUST have been re-fetched, while intact chunk-0-2.m4s was NOT!
  assert.ok(requests.includes('chunk-0-1.m4s'), 'Corrupted DASH chunk-0-1 must be re-fetched');
  assert.ok(requests.includes('chunk-0-5.m4s'), 'Failed DASH chunk-0-5 must be re-fetched');
  assert.ok(!requests.includes('chunk-0-2.m4s'), 'Intact DASH chunk-0-2 must NOT be re-fetched');
  assert.ok(!(await readdir(sandbox.downloads)).some(n => n.startsWith('.media-toolkit-')));
});

test('local HTTP companion service restart recovers interrupted queue and authorized temporary URL refresh preserves completed HLS checkpoint', { timeout: 60_000 }, async t => {
  const sandbox = await createTestSandbox('resume-refresh-and-service');
  const env = sandbox.env({ PORT: '0', MEDIA_TOOLKIT_TOKEN: 'restart-token', MEDIA_TOOLKIT_URL: '' });
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'rot.m3u8'),
  ], { windowsHide: true });

  const manifestText = await readFile(path.join(sandbox.media, 'rot.m3u8'), 'utf8');
  const parts = await Promise.all([0, 1, 2, 3, 4, 5].map(i => readFile(path.join(sandbox.media, `rot${i}.ts`))));

  let activeToken = 'tok1';
  let pageHits = 0;
  const segHits = [];
  let mismatchMode = false;
  let server;
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/watch/exp') {
      pageHits++;
      activeToken = mismatchMode ? 'mismatch' : `tok${pageHits + 1}`;
      const streamPath = mismatchMode ? '/different.m3u8' : `/rot.m3u8?sig=${activeToken}`;
      return res.writeHead(200, { 'content-type': 'text/html' })
        .end(`<title>Signed Stream</title><video controls preload="none" src="${streamPath}"></video>`);
    }
    if (u.pathname === '/different.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nrot0.ts\n#EXT-X-ENDLIST\n',
      );
    }
    if (u.pathname === '/rot.m3u8') {
      const sig = u.searchParams.get('sig');
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        .end(manifestText.replaceAll(/rot(\d+)\.ts/g, `rot$1.ts?sig=${sig}`));
    }
    const m = /^\/rot(\d+)\.ts$/.exec(u.pathname);
    if (!m) return res.writeHead(404).end();
    const idx = Number(m[1]);
    const sig = u.searchParams.get('sig');
    segHits.push({ idx, sig });
    // First token expires right after segment 2 (briefly delay 410 so 0..2 complete cleanly like real-world mid-stream expiry)
    if (sig === 'tok1' && idx >= 3) {
      setTimeout(() => res.writeHead(410).end(), 120);
      return;
    }
    if (sig !== activeToken && !(sig === 'tok1' && idx < 3)) return res.writeHead(410).end();
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': parts[idx].length }).end(parts[idx]);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const startCompanion = async () => {
    const proc = spawn(process.execPath, [serverEntry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const closed = once(proc, 'close');
    const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const { value } = await lines.next();
    const endpoint = value.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(endpoint, value);
    return {
      endpoint,
      async stop() { proc.kill(); await closed; },
    };
  };

  let companion = await startCompanion();
  t.after(async () => {
    try { await companion?.stop(); } catch {}
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });

  const api = async (route, body) => {
    const resp = await fetch(companion.endpoint + route, {
      headers: { authorization: 'Bearer restart-token', ...(body && { 'content-type': 'application/json' }) },
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
    });
    return { status: resp.status, data: await resp.json() };
  };

  // 1. Authorized refresh mid-download: tok1 downloads segments 0..2, hits 410 on segment 3,
  // refreshes page -> gets tok2 -> REUSES segments 0..2 from checkpoint and ONLY fetches 3..5!
  const { data: q1 } = await api('/api/queue', {
    items: [{ kind: 'stream', url: `${base}/rot.m3u8?sig=tok1`, title: 'RefreshCheckpoint' }],
    refresh: { pageUrl: `${base}/watch/exp`, maxRefreshes: 2 },
    connections: 4,
  });
  const { data: w1 } = await api(`/api/batch/${q1.id}/wait?timeoutMs=20000`);
  assert.equal(w1.status, 'done', JSON.stringify(w1));
  assert.equal(pageHits, 1);
  const tok2Indices = segHits.filter(h => h.sig === 'tok2').map(h => h.idx).sort((a, b) => a - b);
  assert.deepEqual(tok2Indices, [3, 4, 5], `Expected tok2 to reuse 0..2 from checkpoint and fetch only 3..5, got ${JSON.stringify(segHits)}`);

  // 2. Restart companion service and confirm persisted batch history survives restart
  await companion.stop();
  companion = await startCompanion();
  const { data: batches } = await api('/api/batches');
  assert.ok(batches.items.some(b => b.id === q1.id && b.status === 'done'));
});

test('1000-segment HLS stress test completes with bounded requests and verified FFprobe output', { timeout: 90_000 }, async t => {
  const sandbox = await createTestSandbox('hls-1000-stress');
  const restoreEnv = sandbox.applyProcessEnv();
  const { queue, waitForBatch } = await import('../tools/media-downloads.mjs');

  // Generate 1 real 0.2s TS segment and serve it 1,000 times as a valid 1,000-segment VOD playlist
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '0.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-f', 'mpegts', path.join(sandbox.media, 'unit.ts'),
  ], { windowsHide: true });
  const unitTs = await readFile(path.join(sandbox.media, 'unit.ts'));
  const totalSegments = 1000;
  const playlist = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0',
    ...Array.from({ length: totalSegments }, (_, i) => `#EXTINF:0.200,\nseg-${i}.ts`),
    '#EXT-X-ENDLIST',
  ].join('\n');

  let servedCount = 0;
  const server = createServer((req, res) => {
    if (req.url === '/stress.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(playlist);
    if (/^\/seg-\d+\.ts$/.test(req.url)) {
      servedCount++;
      return res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': unitTs.length }).end(unitTs);
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/stress.m3u8`;

  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    restoreEnv();
    await sandbox.cleanup();
  });

  const { id } = queue({ items: [{ kind: 'stream', url, title: 'Stress1000' }], connections: 12 });
  let result;
  for (let i = 0; i < 3; i++) {
    result = await waitForBatch({ id, timeoutMs: 30_000 });
    if (!result.timedOut) break;
  }
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(servedCount, totalSegments);
  assert.equal(result.items[0].segments.total, totalSegments);
  assert.equal(result.items[0].segments.completed, totalSegments);
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', result.items[0].file,
  ], { encoding: 'utf8', windowsHide: true }));
  assert.ok(probe.streams.some(s => s.codec_type === 'video' && s.width === 160 && s.height === 90));
  assert.ok(Number(probe.format.duration) > 100, `Expected long duration, got ${probe.format.duration}`);
});
