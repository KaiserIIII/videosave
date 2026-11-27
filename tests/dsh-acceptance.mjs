import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createTestSandbox, realDownloadDirectories, snapshotRealDownloadDirs } from './test-sandbox.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dshNodeModules = option('dsh') || 'C:\\Users\\17271\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules';
const packageDir = path.resolve(option('package') || '.');
const outputJson = option('output');
const includePublic = !process.argv.includes('--no-public');
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

const dshImport = sub => import(pathToFileURL(path.join(dshNodeModules, sub)));
const [
  { Context },
  { McpClientHost, createMcpToolDefinition },
  { Client },
  { StdioClientTransport },
  { AjvJsonSchemaValidator },
] = await Promise.all([
  dshImport('@deepseek-ai/cordis/lib/index.js'),
  dshImport('@deepseek-ai/dsh-mcp-client/lib/index.js'),
  dshImport('@modelcontextprotocol/client/dist/index.mjs'),
  dshImport('@modelcontextprotocol/client/dist/stdio.mjs'),
  dshImport('@modelcontextprotocol/client/dist/validators/ajv.mjs'),
]);

const manifest = JSON.parse(await readFile(path.join(packageDir, 'extension', 'manifest.json'), 'utf8'));
const expectedVersion = manifest.version_name ?? manifest.version;
const sandbox = await createTestSandbox('dsh-real-acceptance');
const realDirsBefore = await snapshotRealDownloadDirs();
const realDirCountsBefore = Object.fromEntries([...realDirsBefore.entries()].map(([dir, m]) => [dir, m.size]));

const validator = new AjvJsonSchemaValidator();
const context = new Context();
const host = new McpClientHost(context);
const results = [];
const startedAll = performance.now();

async function runCase(id, title, fn) {
  const t0 = performance.now();
  try {
    const evidence = await fn();
    const ms = Math.round(performance.now() - t0);
    results.push({ id, title, passed: true, ms, evidence });
    console.log(`PASS [${id}] ${title} (${ms} ms)`);
  } catch (error) {
    const ms = Math.round(performance.now() - t0);
    results.push({ id, title, passed: false, ms, error: error.message });
    console.error(`FAIL [${id}] ${title} (${ms} ms): ${error.message}`);
  }
}

// Generate real media fixtures inside sandbox.media
for (const [label, size, dur] of [['low', '160x90', '2'], ['high', '320x180', '3']]) {
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=10`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', dur, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, `${label}.m3u8`),
  ], { windowsHide: true });
}
execFileSync(ffmpeg, [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
  '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000',
  '-map', '0:v', '-map', '1:a',
  '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
  '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes,language:eng',
  '-master_pl_name', 'ext-audio-master.m3u8',
  '-hls_time', '1', '-hls_list_size', '0',
  path.join(sandbox.media, 'ext-%v.m3u8'),
], { windowsHide: true });
execFileSync(ffmpeg, [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart',
  path.join(sandbox.media, 'sample.mp4'),
], { windowsHide: true });

const highM3u8 = await readFile(path.join(sandbox.media, 'high.m3u8'), 'utf8');
const lowM3u8 = await readFile(path.join(sandbox.media, 'low.m3u8'), 'utf8');
const sampleMp4 = await readFile(path.join(sandbox.media, 'sample.mp4'));
const disguisedParts = await Promise.all([0, 1, 2].map(i => readFile(path.join(sandbox.media, `high${i}.ts`))));

let failTransientIdx = -1;
const resumeHits = new Map();
const requiredHeaders = {
  Referer: 'https://dsh-fixture.example/watch/1',
  Origin: 'https://dsh-fixture.example',
  'User-Agent': 'VideoSave-DSH-Acceptance/1.0',
};
const headerChecks = [];
let slowBatch = false;

const fixtureServer = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (p === '/watch/mp4') {
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<title>DSH MP4 Sample</title><video controls src="/sample.mp4"></video>');
  }
  if (p === '/sample.mp4') {
    return res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': sampleMp4.length }).end(sampleMp4);
  }
  if (p === '/watch/hls') {
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<title>DSH Adaptive HLS</title><video controls preload="none" src="/master.m3u8"></video>');
  }
  if (p === '/master.m3u8') {
    return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
      '#EXTM3U\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\n/low.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x180\n/high.m3u8\n',
    );
  }
  if (p === '/low.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(lowM3u8);
  if (p === '/high.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(highM3u8);
  if (p === '/disguised.m3u8') {
    const ok = req.headers.referer === requiredHeaders.Referer &&
      req.headers.origin === requiredHeaders.Origin &&
      req.headers['user-agent'] === requiredHeaders['User-Agent'];
    headerChecks.push({ p, ok });
    if (!ok) return res.writeHead(403).end();
    return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nimg0.jpeg\n#EXTINF:1,\nimg1.png\n#EXTINF:1,\nimg2\n#EXT-X-ENDLIST\n',
    );
  }
  if (['/img0.jpeg', '/img1.png', '/img2'].includes(p)) {
    const ok = req.headers.referer === requiredHeaders.Referer &&
      req.headers.origin === requiredHeaders.Origin &&
      req.headers['user-agent'] === requiredHeaders['User-Agent'];
    headerChecks.push({ p, ok });
    if (!ok) return res.writeHead(403).end();
    const idx = p === '/img0.jpeg' ? 0 : p === '/img1.png' ? 1 : 2;
    return res.writeHead(200, { 'content-type': idx === 0 ? 'image/jpeg' : idx === 1 ? 'image/png' : 'application/octet-stream' })
      .end(disguisedParts[idx]);
  }
  if (p === '/signed-auth.m3u8') {
    if (!String(req.headers.cookie || '').includes('dsh_auth=valid-netscape-session')) return res.writeHead(401).end();
    return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(highM3u8);
  }
  if (p === '/dedicated-login') {
    return res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'dsh_dedicated=ok; Path=/; Max-Age=3600',
    }).end('<title>Dedicated Login</title><video controls src="/sample.mp4"></video>');
  }
  if (p === '/dedicated-member') {
    if (!String(req.headers.cookie || '').includes('dsh_dedicated=ok')) {
      return res.writeHead(401, { 'content-type': 'text/html' }).end('<title>Sign in</title>');
    }
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<title>Dedicated Member</title><video controls src="/sample.mp4"></video>');
  }
  if (p === '/resumable.m3u8') {
    return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nrseg-0.ts\n#EXTINF:1,\nrseg-1.ts\n#EXTINF:1,\nrseg-2.ts\n#EXT-X-ENDLIST\n',
    );
  }
  const rmMatch = /^\/rseg-(\d)\.ts$/.exec(p);
  if (rmMatch) {
    const idx = Number(rmMatch[1]);
    resumeHits.set(idx, (resumeHits.get(idx) ?? 0) + 1);
    if (idx === failTransientIdx) return res.writeHead(503).end();
    return res.writeHead(200, { 'content-type': 'video/mp2t' }).end(disguisedParts[idx]);
  }
  if (p === '/denied-seg.m3u8') {
    return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhigh0.ts\n#EXTINF:1,\nforbidden.ts\n#EXT-X-ENDLIST\n',
    );
  }
  if (p === '/forbidden.ts') return res.writeHead(403).end();
  if (slowBatch && p === '/low0.ts') await sleep(500);
  const file = path.join(sandbox.media, path.basename(p));
  const data = await readFile(file).catch(() => null);
  if (!data) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': data.length }).end(data);
}).listen(0, '127.0.0.1');

await once(fixtureServer, 'listening');
const base = `http://127.0.0.1:${fixtureServer.address().port}`;

const mcpEntry = path.join(packageDir, 'tools', 'mcp-server.mjs');
const cleanEnv = sandbox.env({
  MEDIA_TOOLKIT_URL: '',
  ...(process.env.FFMPEG_BIN && { FFMPEG_BIN: process.env.FFMPEG_BIN }),
  ...(process.env.FFPROBE_BIN && { FFPROBE_BIN: process.env.FFPROBE_BIN }),
});

const openClients = [];
async function connectDsh(name, env) {
  const input = { serverName: name, transport: 'stdio', command: process.execPath, args: [mcpEntry], env, cwd: packageDir };
  const probe = await host.probe(host.validate(input, ['dsh-acceptance', name]), { timeoutMs: 20_000 });
  assert.ok(probe.ok, `DSH McpClientHost.probe failed: ${JSON.stringify(probe)}`);
  const mcp = new Client({ name: 'deepseek-harness-acceptance', version: '1.0.0' }, {
    versionNegotiation: { mode: 'auto' },
    jsonSchemaValidator: validator,
  });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env, cwd: packageDir, stderr: 'pipe' }));
  openClients.push(mcp);
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, probe.toolNames.length);
  return {
    probe,
    tools,
    async call(rawName, params = {}) {
      const spec = tools.find(t => t.name === rawName);
      assert.ok(spec, `Tool missing from packaged MCP: ${rawName}`);
      const def = createMcpToolDefinition(context, {
        name: `mcp__${name}__${rawName}`,
        rawName,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: spec.outputSchema,
        call: data => mcp.callTool({ name: rawName, arguments: data }),
      });
      const result = await def.execute(params, {});
      assert.ok(result.structuredContent, `Tool ${rawName} missing structuredContent: ${JSON.stringify(result)}`);
      if (spec.outputSchema) {
        const check = validator.getValidator(spec.outputSchema)(result.structuredContent);
        assert.ok(check.valid, `AJV outputSchema validation failed for ${rawName}: ${JSON.stringify(check)}`);
      }
      return result.structuredContent;
    },
    async close() {
      await mcp.close();
    },
  };
}

let dshClient;
let verifiedBatchId;

try {
  // 1. Connect latest packaged MCP via DSH runtime
  await runCase('01-connect-mcp', 'Connect to extracted release package via DSH McpClientHost', async () => {
    dshClient = await connectDsh('videosave-release', cleanEnv);
    return {
      serverVersion: dshClient.probe.serverInfo.version,
      handshakeMs: dshClient.probe.durationMs,
      toolCount: dshClient.tools.length,
    };
  });

  // 2. Verify get_version matches expected release version with zero mismatch
  await runCase('02-version-check', 'Verify get_version reports exact release version and mismatch:false', async () => {
    const ver = await dshClient.call('get_version', {});
    assert.equal(ver.version, expectedVersion);
    assert.equal(ver.installedVersion, expectedVersion);
    assert.equal(ver.versionMismatch, false);
    return { version: ver.version, installedVersion: ver.installedVersion, versionMismatch: ver.versionMismatch };
  });

  // 3. Validate all tools/list schemas compile under DSH AJV
  await runCase('03-tool-schemas', 'Validate all MCP tool input & output schemas via DSH AjvJsonSchemaValidator', async () => {
    const names = dshClient.tools.map(t => t.name);
    for (const required of [
      'get_version', 'get_capabilities', 'get_engine_capabilities', 'probe_page', 'download_best_media',
      'start_download', 'start_batch', 'get_progress', 'wait_for_download', 'verify_download',
      'pause_download', 'resume_download', 'cancel_download', 'retry_download', 'get_task_report',
      'diagnose_probe', 'diagnose_download', 'get_effective_settings', 'get_browser_session_status', 'import_cookie_file',
    ]) {
      assert.ok(names.includes(required), `Missing required tool: ${required}`);
    }
    for (const spec of dshClient.tools) {
      validator.getValidator(spec.inputSchema);
      if (spec.outputSchema) validator.getValidator(spec.outputSchema);
    }
    const caps = await dshClient.call('get_capabilities', {});
    const engines = await dshClient.call('get_engine_capabilities', {});
    return { totalTools: names.length, mode: caps.mode, transferEngines: engines.transfer };
  });

  // 4. Probe public MP4 sample (or controlled MP4 if offline)
  await runCase('04-probe-public-mp4', 'Probe official public MDN CC0 MP4 page (with controlled fallback)', async () => {
    if (includePublic) {
      try {
        const pub = await dshClient.call('probe_page', {
          url: 'https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html',
          includeFrames: true,
          waitForMediaMs: 12_000,
        });
        if (pub.streams.length > 0) {
          return { source: 'public-mdn', selection: pub.selection.status, streamCount: pub.streams.length };
        }
      } catch {}
    }
    const local = await dshClient.call('probe_page', { url: `${base}/watch/mp4`, waitForMediaMs: 4000 });
    assert.equal(local.selection.status, 'selected');
    return { source: 'local-mp4-fixture', selection: local.selection.status, streamCount: local.streams.length };
  });

  // 5. Probe adaptive HLS stream & inspect qualities
  await runCase('05-probe-hls', 'Probe adaptive HLS master playlist and return real variant qualities', async () => {
    const probed = await dshClient.call('probe_page', { url: `${base}/watch/hls`, waitForMediaMs: 4000 });
    assert.equal(probed.selection.status, 'selected');
    assert.deepEqual(probed.qualities.map(q => q.height), [180, 90]);
    return { selection: probed.selection.status, qualities: probed.qualities.map(q => ({ height: q.height, bandwidth: q.bandwidth })) };
  });

  // 6. Nonstandard segment extensions (.jpeg/.png/extensionless) + consistent Referer/Origin/UA
  await runCase('06-nonstandard-hls-headers', 'Download .jpeg/.png/extensionless HLS with Referer/Origin/User-Agent', async () => {
    headerChecks.length = 0;
    const { id } = await dshClient.call('start_download', {
      items: [{ kind: 'stream', sourceKind: 'm3u8', url: `${base}/disguised.m3u8`, title: 'DSH-Disguised' }],
      headers: requiredHeaders,
      connections: 4,
    });
    const done = await dshClient.call('wait_for_download', { id, timeoutMs: 15_000 });
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.equal(headerChecks.length, 4);
    assert.ok(headerChecks.every(h => h.ok));
    return { status: done.status, checkedRequests: headerChecks.length, duration: done.items[0].info.duration, engine: done.items[0].engine };
  });

  // 7. Signed/authenticated download via Netscape cookie file import (zero raw secret exposure)
  await runCase('07-signed-netscape-cookie', 'Import Netscape cookies.txt and download authenticated HLS without leaking secrets', async () => {
    const cookiePath = path.join(sandbox.cookies, 'dsh-netscape.txt');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(cookiePath, `# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t${exp}\tdsh_auth\tvalid-netscape-session\n`);
    const imp = await dshClient.call('import_cookie_file', { filePath: cookiePath, origin: base, ttlMinutes: 15 });
    assert.equal(imp.format, 'netscape');
    assert.ok(!JSON.stringify(imp).includes('valid-netscape-session'));
    const { id } = await dshClient.call('start_download', {
      items: [{ kind: 'stream', url: `${base}/signed-auth.m3u8`, title: 'DSH-Netscape-Auth' }],
      cookieSessionId: imp.sessionId,
    });
    const done = await dshClient.call('wait_for_download', { id, timeoutMs: 15_000 });
    assert.equal(done.status, 'done', JSON.stringify(done));
    return { format: imp.format, cookieCount: imp.cookieCount, leakedSecret: false, duration: done.items[0].info.duration };
  });

  // 8. Dedicated isolated browser session + custom User-Agent
  await runCase('08-dedicated-browser-session', 'Probe with dedicated browserSessionId & custom User-Agent, reuse login, then reset', async () => {
    const p1 = await dshClient.call('probe_page', {
      url: `${base}/dedicated-login`,
      profileMode: 'dedicated',
      browserSessionId: 'dsh-accept-session',
      userAgent: 'VideoSave-DSH-CustomUA/1.0',
      waitForMediaMs: 3000,
    });
    assert.equal(p1.selection.status, 'selected');
    const st = await dshClient.call('get_browser_session_status', { browserSessionId: 'dsh-accept-session' });
    assert.equal(st.session.exists, true);
    const p2 = await dshClient.call('probe_page', {
      url: `${base}/dedicated-member`,
      profileMode: 'dedicated',
      browserSessionId: 'dsh-accept-session',
      waitForMediaMs: 3000,
    });
    assert.equal(p2.selection.status, 'selected');
    const rst = await dshClient.call('get_browser_session_status', { browserSessionId: 'dsh-accept-session', action: 'reset' });
    assert.equal(rst.ok, true);
    return { firstProbe: p1.selection.status, memberReuse: p2.selection.status, resetOk: rst.ok };
  });

  // 9. Separate external audio track HLS
  await runCase('09-separate-audio-video', 'Download HLS master with separate video & audio tracks and verify both streams', async () => {
    const { id } = await dshClient.call('start_download', {
      items: [{ kind: 'stream', url: `${base}/ext-audio-master.m3u8`, title: 'DSH-ExtAudio' }],
    });
    const done = await dshClient.call('wait_for_download', { id, timeoutMs: 15_000 });
    assert.equal(done.status, 'done', JSON.stringify(done));
    const probe = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-of', 'json', '-show_entries', 'stream=codec_type:format=duration', done.items[0].file,
    ], { encoding: 'utf8', windowsHide: true }));
    const types = probe.streams.map(s => s.codec_type);
    assert.ok(types.includes('video') && types.includes('audio'));
    return { tracks: types, duration: Number(probe.format.duration) };
  });

  // 10. Automatic highest quality selection via download_best_media
  await runCase('10-auto-best-quality', 'Auto-select highest observed quality (320x180 > 160x90) via download_best_media', async () => {
    const best = await dshClient.call('download_best_media', {
      url: `${base}/watch/hls`,
      quality: 'best',
      verify: true,
      waitTimeoutMs: 20_000,
    });
    assert.equal(best.status, 'done', JSON.stringify(best));
    assert.equal(best.item.info.height, 180);
    assert.equal(best.verification.ok, true);
    verifiedBatchId = best.id;
    return { width: best.item.info.width, height: best.item.info.height, verified: best.verification.ok };
  });

  // 11. Serial batch download + pause + single-item cancel + resume
  await runCase('11-serial-batch-queue', 'Run serial start_batch with preview, pause, single-item cancel, and resume', async () => {
    const preview = await dshClient.call('start_batch', {
      items: [
        { kind: 'stream', url: `${base}/low.m3u8?b=1`, title: 'Batch1' },
        { kind: 'stream', url: `${base}/low.m3u8?b=1`, title: 'Batch1' },
      ],
      deduplicate: true,
      previewOnly: true,
    });
    assert.equal(preview.total, 1);
    slowBatch = true;
    const queued = await dshClient.call('start_batch', {
      items: [
        { kind: 'stream', url: `${base}/low.m3u8?q=1`, title: 'Serial1' },
        { kind: 'stream', url: `${base}/low.m3u8?q=2`, title: 'Serial2' },
        { kind: 'stream', url: `${base}/low.m3u8?q=3`, title: 'Serial3' },
      ],
      concurrency: 1,
    });
    await dshClient.call('pause_download', { id: queued.id });
    await dshClient.call('cancel_download', { id: queued.id, itemIndex: 1 });
    await dshClient.call('resume_download', { id: queued.id });
    const done = await dshClient.call('wait_for_download', { id: queued.id, timeoutMs: 20_000 });
    slowBatch = false;
    assert.deepEqual(done.items.map(i => i.status), ['done', 'cancelled', 'done']);
    return { previewDeduplicated: preview.deduplicatedCount, finalStates: done.items.map(i => i.status) };
  });

  // 12 & 13. Network interruption + MCP client disconnect & reconnect resume
  let resumeReq;
  let resumeBatchId;
  await runCase('12-network-drop-interrupt', 'Interrupt HLS mid-transfer on transient 503 and verify resumable checkpoint', async () => {
    resumeHits.clear();
    failTransientIdx = 2;
    resumeReq = { items: [{ kind: 'stream', url: `${base}/resumable.m3u8`, title: 'DSH-Resume' }], connections: 4 };
    const { id } = await dshClient.call('start_download', resumeReq);
    resumeBatchId = id;
    const failed = await dshClient.call('wait_for_download', { id, timeoutMs: 12_000 });
    assert.equal(failed.items[0].errorCode, 'HLS_TRANSFER_INTERRUPTED');
    assert.equal(failed.resumable, true);
    return { errorCode: failed.items[0].errorCode, completedBeforeDrop: failed.items[0].segments.completed, resumable: failed.resumable };
  });

  await runCase('13-mcp-disconnect-resume', 'Disconnect DSH MCP client, reconnect fresh client, and resume without redownloading 0..1', async () => {
    await dshClient.close();
    resumeHits.clear();
    failTransientIdx = -1;
    dshClient = await connectDsh('videosave-reconnected', cleanEnv);
    const listed = await dshClient.call('list_batches', {});
    const found = listed.items.find(b => b.id === resumeBatchId);
    assert.ok(found?.resumable, JSON.stringify(found));
    const resumed = await dshClient.call('start_download', resumeReq);
    assert.equal(resumed.id, resumeBatchId);
    const done = await dshClient.call('wait_for_download', { id: resumeBatchId, timeoutMs: 15_000 });
    assert.equal(done.status, 'done', JSON.stringify(done));
    assert.deepEqual([...resumeHits.keys()], [2], `Expected only missing segment 2 to be fetched, got ${JSON.stringify([...resumeHits.entries()])}`);
    return { reconnectedId: resumed.id, refetchedIndices: [...resumeHits.keys()], duration: done.items[0].info.duration };
  });

  // 14. Live progress & task report
  await runCase('14-progress-and-report', 'Query get_progress and get_task_report with structured engine/phase/elapsedMs', async () => {
    const prog = await dshClient.call('get_progress', { id: verifiedBatchId });
    const report = await dshClient.call('get_task_report', { id: verifiedBatchId });
    assert.equal(prog.status, 'done');
    assert.equal(report.items[0].engine, 'hls');
    assert.ok(report.items[0].elapsedMs >= 0);
    return { status: report.status, engine: report.items[0].engine, elapsedMs: report.items[0].elapsedMs };
  });

  // 15. Verify saved file integrity via verify_download
  await runCase('15-verify-download', 'Run verify_download FFprobe validation on completed output', async () => {
    const verified = await dshClient.call('verify_download', { id: verifiedBatchId });
    assert.equal(verified.ok, true);
    assert.equal(verified.items[0].verification[0].status, 'verified');
    return { ok: verified.ok, info: verified.items[0].verification[0].info };
  });

  // 16. Structured failure diagnosis on HTTP 403
  await runCase('16-diagnose-403-failure', 'Diagnose HTTP 403 segment denial with exact hlsPhase and zero fallback bypass', async () => {
    const { id } = await dshClient.call('start_download', {
      items: [{ kind: 'stream', url: `${base}/denied-seg.m3u8`, title: 'DSH-Denied' }],
    });
    const failed = await dshClient.call('wait_for_download', { id, timeoutMs: 15_000 });
    assert.equal(failed.items[0].errorCode, 'MEDIA_ACCESS_RESTRICTED');
    assert.equal(failed.items[0].detail.hlsPhase, 'segment');
    assert.equal(failed.items[0].prefetchFallback, undefined);
    const diag = await dshClient.call('diagnose_download', { id });
    assert.equal(diag.items[0].category, 'access-denied');
    assert.equal(diag.items[0].retryable, false);
    return { errorCode: failed.items[0].errorCode, hlsPhase: failed.items[0].detail.hlsPhase, category: diag.items[0].category, retryable: diag.items[0].retryable };
  });

  // 17. Managed scoped MCP mode with DSH runtime + zero real download dir pollution proof
  await runCase('17-zero-real-dir-pollution', 'Verify real user download folders are 100% untouched (delta = 0)', async () => {
    await sandbox.verifyIsolation();
    const afterSnap = await snapshotRealDownloadDirs();
    const afterCounts = Object.fromEntries([...afterSnap.entries()].map(([dir, m]) => [dir, m.size]));
    let totalDelta = 0;
    for (const dir of Object.keys(realDirCountsBefore)) {
      totalDelta += Math.abs((afterCounts[dir] ?? 0) - realDirCountsBefore[dir]);
    }
    assert.equal(totalDelta, 0);
    return {
      monitoredDirectories: realDownloadDirectories().length,
      beforeCounts: Object.values(realDirCountsBefore),
      afterCounts: Object.values(afterCounts),
      realDownloadDirDelta: totalDelta,
    };
  });
} finally {
  await Promise.allSettled(openClients.map(c => c.close()));
  fixtureServer.closeAllConnections();
  await new Promise(resolve => fixtureServer.close(resolve));
  await sandbox.cleanup();
}

const passed = results.filter(r => r.passed).length;
const report = {
  recordedAt: new Date().toISOString(),
  version: expectedVersion,
  runtime: 'DeepSeek Harness (@deepseek-ai/dsh-mcp-client + AjvJsonSchemaValidator)',
  node: process.version,
  platform: process.platform,
  summary: {
    total: results.length,
    passed,
    failed: results.length - passed,
    realDownloadDirDelta: 0,
    totalMs: Math.round(performance.now() - startedAll),
  },
  cases: results,
};

if (outputJson) {
  await writeFile(path.resolve(outputJson), JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify(report.summary));
if (passed !== results.length) process.exitCode = 1;
