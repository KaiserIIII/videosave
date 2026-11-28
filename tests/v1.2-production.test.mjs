import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { platformVideo } from '../extension/media.mjs';
import { BROWSER_STAGES, BrowserTransportError } from '../tools/edge-session.mjs';
import { parseLiveHlsPlaylist, recordDynamicDash, recordSlidingWindowHls } from '../tools/live-protocols.mjs';
import { assertOfficialReleaseUrl, compareSemver, downloadAndVerifyUpdate, parseSha256Sums } from '../tools/updater.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const upgradeDshEntry = fileURLToPath(new URL('../tools/upgrade-dsh.mjs', import.meta.url));
const serverEntry = fileURLToPath(new URL('../tools/server.mjs', import.meta.url));

function probeMp4(file) {
  const raw = execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', file,
  ], { encoding: 'utf8', windowsHide: true });
  const data = JSON.parse(raw);
  return {
    duration: Number(data.format?.duration ?? 0),
    tracks: (data.streams ?? []).map(s => s.codec_type),
    video: (data.streams ?? []).find(s => s.codec_type === 'video'),
  };
}

test('v1.2 protocols: LL-HLS partial segments, sliding-window live HLS recording, multi-init discontinuity, and Dynamic DASH', { timeout: 45_000 }, async t => {
  const sandbox = await createTestSandbox('v12-live-protocols');
  const restoreEnv = sandbox.applyProcessEnv();
  t.after(async () => {
    restoreEnv();
    await sandbox.cleanup();
  });

  // 1. Parse LL-HLS manifest with EXT-X-PART, EXT-X-PRELOAD-HINT, EXT-X-SERVER-CONTROL, and multi-init discontinuity
  const sampleLlHls = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5',
    '#EXT-X-PART-INF:PART-TARGET=0.5',
    '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-MAP:URI="init-a.mp4"',
    '#EXTINF:1.0,',
    'seg10.m4s',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-MAP:URI="init-b.mp4"',
    '#EXT-X-PART:DURATION=0.5,URI="part11.0.m4s",INDEPENDENT=YES',
    '#EXT-X-PART:DURATION=0.5,URI="part11.1.m4s"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part11.2.m4s"',
  ].join('\n');
  const parsed = parseLiveHlsPlaylist(sampleLlHls, 'https://live.example/ll/index.m3u8');
  assert.equal(parsed.live, true);
  assert.equal(parsed.llHls, true);
  assert.equal(parsed.discontinuityCount, 1);
  assert.equal(parsed.initMaps.length, 2);
  assert.equal(parsed.preloadHints.length, 1);
  assert.equal(parsed.items.length, 3);

  // 2. Generate real TS segments & record a live sliding-window HLS playlist + verify with FFprobe
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-hls_time', '1', '-hls_list_size', '0', path.join(sandbox.media, 'live.m3u8'),
  ], { windowsHide: true });
  const tsParts = await Promise.all([0, 1, 2, 3].map(i => readFile(path.join(sandbox.media, `live${i}.ts`))));

  // Generate real fMP4 DASH assets for Dynamic DASH recording
  const dashDir = path.join(sandbox.media, 'dash');
  await mkdir(dashDir, { recursive: true });
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'dash', '-seg_duration', '1', path.join(dashDir, 'seed.mpd'),
  ], { cwd: dashDir, windowsHide: true });
  const seedMpd = await readFile(path.join(dashDir, 'seed.mpd'), 'utf8');
  const dynamicMpd = seedMpd.replace(/\btype="static"/i, 'type="dynamic"');

  let hlsPoll = 0;
  const liveServer = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/sliding.m3u8') {
      hlsPoll++;
      // Slide window forward each poll (0..1 -> 1..2 -> 2..3 + ENDLIST)
      const start = Math.min(2, hlsPoll - 1);
      const end = Math.min(3, start + 1);
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${start}`];
      for (let i = start; i <= end; i++) {
        if (i === 2) lines.push('#EXT-X-DISCONTINUITY');
        lines.push('#EXTINF:1.0,', `/live${i}.ts`);
      }
      if (hlsPoll >= 3) lines.push('#EXT-X-ENDLIST');
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(lines.join('\n') + '\n');
    }
    if (p === '/forbidden-live.m3u8') return res.writeHead(403).end();
    const tsM = /^\/live(\d)\.ts$/.exec(p);
    if (tsM) return res.writeHead(200, { 'content-type': 'video/mp2t' }).end(tsParts[Number(tsM[1])]);
    if (p === '/dash/dynamic.mpd') return res.writeHead(200, { 'content-type': 'application/dash+xml' }).end(dynamicMpd);
    if (p.startsWith('/dash/')) {
      const f = await readFile(path.join(dashDir, path.basename(p))).catch(() => null);
      if (!f) return res.writeHead(404).end();
      return res.writeHead(200).end(f);
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(liveServer, 'listening');
  t.after(async () => {
    liveServer.closeAllConnections();
    await new Promise(r => liveServer.close(r));
  });
  const base = `http://127.0.0.1:${liveServer.address().port}`;

  // Record bounded sliding-window live HLS
  const hlsRec = await recordSlidingWindowHls(
    `${base}/sliding.m3u8`, [], path.join(sandbox.staging, 'live-hls'), AbortSignal.timeout(15_000),
    () => {}, { maxSec: 4, pollIntervalMs: 80, outputFile: path.join(sandbox.downloads, 'live-hls.mp4') },
  );
  assert.equal(hlsRec.segmentCount, 4);
  assert.equal(hlsRec.discontinuityCount, 1);
  const hlsProbe = probeMp4(hlsRec.file);
  assert.ok(hlsProbe.duration >= 3.5 && hlsProbe.tracks.includes('video') && hlsProbe.tracks.includes('audio'));

  // Never bypass HTTP 403 on live HLS
  await assert.rejects(
    () => recordSlidingWindowHls(`${base}/forbidden-live.m3u8`, [], path.join(sandbox.staging, 'live-403'), AbortSignal.timeout(5000)),
    { code: 'MEDIA_ACCESS_RESTRICTED' },
  );

  // Record bounded Dynamic DASH
  const dashRec = await recordDynamicDash(
    `${base}/dash/dynamic.mpd`, path.join(sandbox.staging, 'live-dash'), AbortSignal.timeout(15_000),
    () => {}, { maxSec: 3, pollIntervalMs: 80, outputFile: path.join(sandbox.downloads, 'live-dash.mp4') },
  );
  assert.ok(dashRec.videoSegments >= 2);
  const dashProbe = probeMp4(dashRec.file);
  assert.ok(dashProbe.duration >= 1.5 && dashProbe.tracks.includes('video'));
});

test('v1.2 updater security, platform short links, BrowserLaunchError stages, safe DSH upgrader, and /api/diagnostics/export', { timeout: 30_000 }, async t => {
  const sandbox = await createTestSandbox('v12-updater-security');
  const restoreEnv = sandbox.applyProcessEnv();
  t.after(async () => {
    restoreEnv();
    await sandbox.cleanup();
  });

  // 1. Platform URL recognition (BV ID, b23.tv short link, YouTube shorts/live/music)
  assert.equal(platformVideo('BV1xx411c7mD')?.platform, 'bilibili');
  assert.equal(platformVideo('https://b23.tv/abc1234')?.shortLink, true);
  assert.equal(platformVideo('https://music.youtube.com/watch?v=dQw4w9WgXcQ')?.platform, 'youtube');
  assert.equal(platformVideo('https://www.youtube.com/live/dQw4w9WgXcQ')?.platform, 'youtube');

  // 2. Updater semver + strict official origin allowlist + SHA-256 verification + mismatch rejection
  assert.equal(compareSemver('1.2.0', '1.1.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.2.0-rc.1'), 1);
  assert.throws(() => assertOfficialReleaseUrl('https://evil.example/VideoSave-1.2.0.zip'), { code: 'UNTRUSTED_UPDATE_URL' });
  assert.throws(() => assertOfficialReleaseUrl('http://github.com/KaiserIIII/videosave/releases/download/v1.2.0/VideoSave-1.2.0.zip'), { code: 'UNTRUSTED_UPDATE_URL' });

  const goodBytes = Buffer.from('fake-release-zip-payload-v1.2.0');
  const goodSha = createHash('sha256').update(goodBytes).digest('hex');
  const sumsText = `${goodSha}  VideoSave-1.2.0.zip\n`;
  assert.equal(parseSha256Sums(sumsText).get('VideoSave-1.2.0.zip'), goodSha);

  const mockFetch = async url => {
    if (url.endsWith('SHA256SUMS.txt')) return new Response(sumsText, { status: 200 });
    return new Response(goodBytes, { status: 200 });
  };
  const verified = await downloadAndVerifyUpdate({
    assetUrl: 'https://github.com/KaiserIIII/videosave/releases/download/v1.2.0/VideoSave-1.2.0.zip',
    checksumsUrl: 'https://github.com/KaiserIIII/videosave/releases/download/v1.2.0/SHA256SUMS.txt',
    assetName: 'VideoSave-1.2.0.zip',
    destinationDir: sandbox.downloads,
    toVersion: '1.2.0',
    fetchImpl: mockFetch,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.sha256, goodSha);
  assert.equal(verified.autoExecuted, false);

  // Tampered payload MUST fail SHA-256 verification and NOT persist
  const tamperedFetch = async url => {
    if (url.endsWith('SHA256SUMS.txt')) return new Response(sumsText, { status: 200 });
    return new Response(Buffer.from('tampered-bytes'), { status: 200 });
  };
  await assert.rejects(() => downloadAndVerifyUpdate({
    assetUrl: 'https://github.com/KaiserIIII/videosave/releases/download/v1.2.0/VideoSave-1.2.0.zip',
    checksumsUrl: 'https://github.com/KaiserIIII/videosave/releases/download/v1.2.0/SHA256SUMS.txt',
    assetName: 'VideoSave-1.2.0.zip',
    destinationDir: path.join(sandbox.downloads, 'tampered'),
    toVersion: '1.2.0',
    fetchImpl: tamperedFetch,
  }), { code: 'UPDATE_CHECKSUM_MISMATCH' });

  // 3. Browser Launch State Machine error classification
  const errInit = new BrowserTransportError('CDP timeout', { stage: BROWSER_STAGES.CDP_NOT_READY });
  const errProbe = new BrowserTransportError('Probe failed', { stage: BROWSER_STAGES.PROBE_FAILED });
  assert.equal(errInit.retryable, true);
  assert.equal(errProbe.retryable, false);

  // 4. Safe opt-in DSH upgrader dry-run & backup + apply in isolated sandbox
  const fakeDshCfg = path.join(sandbox.root, 'cordis.patch.yml');
  await writeFile(fakeDshCfg, '# old config\n', 'utf8');
  const dry = JSON.parse(execFileSync(process.execPath, [upgradeDshEntry, `--config=${fakeDshCfg}`], { encoding: 'utf8', windowsHide: true }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.applied, false);
  assert.equal(await readFile(fakeDshCfg, 'utf8'), '# old config\n');

  const applied = JSON.parse(execFileSync(process.execPath, [upgradeDshEntry, `--config=${fakeDshCfg}`, '--apply'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(applied.applied, true);
  assert.ok(applied.backupPath && (await stat(applied.backupPath)).size > 0);
  assert.match(await readFile(fakeDshCfg, 'utf8'), /videosave-mcp/);

  // 5. Companion /api/system/storage and sanitized /api/diagnostics/export
  const srv = spawn(process.execPath, [serverEntry, `--sandbox=${sandbox.root}`], {
    env: sandbox.env({ PORT: '0', MEDIA_TOOLKIT_TOKEN: 'v12-tok' }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const closed = once(srv, 'close');
  try {
    const out = await new Promise(resolve => srv.stdout.once('data', d => resolve(d.toString('utf8'))));
    const endpoint = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(endpoint);
    const hdr = { authorization: 'Bearer v12-tok' };
    const storage = await (await fetch(endpoint + '/api/system/storage', { headers: hdr })).json();
    assert.equal(storage.writable, true);
    assert.equal(storage.sandboxActive, true);
    assert.ok(storage.freeBytes > 0);

    const diag = await (await fetch(endpoint + '/api/diagnostics/export', { headers: hdr })).json();
    assert.equal(diag.sanitized, true);
    assert.equal(diag.sandboxActive, true);
    assert.ok(!JSON.stringify(diag).includes('v12-tok'));
  } finally {
    srv.kill();
    await closed;
  }
});
