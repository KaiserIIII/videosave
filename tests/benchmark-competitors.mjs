import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTestSandbox } from './test-sandbox.mjs';

const execFileAsync = promisify(execFile);
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputPath = option('output');
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const ytdlp = option('yt-dlp') || process.env.YTDLP_BIN || null;
const streamlink = process.env.STREAMLINK_BIN || null;

const sandbox = await createTestSandbox('competitor-benchmark');
const restoreEnv = sandbox.applyProcessEnv();

function verifyOutput(file) {
  const raw = execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', file,
  ], { encoding: 'utf8', windowsHide: true });
  const data = JSON.parse(raw);
  return {
    duration: Number(data.format?.duration ?? 0),
    tracks: (data.streams ?? []).map(s => s.codec_type),
    sizeBytes: null,
  };
}

try {
  // Build identical 120-segment x 15ms RTT HLS fixture for apples-to-apples speed comparison
  const SEG_COUNT = 120;
  const RTT_MS = 15;
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-sc_threshold', '0', '-c:a', 'aac',
    '-f', 'mpegts', path.join(sandbox.media, 'unit.ts'),
  ], { windowsHide: true });
  const unitTs = await readFile(path.join(sandbox.media, 'unit.ts'));
  const manifestLines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < SEG_COUNT; i++) manifestLines.push('#EXTINF:1.0,', `seg-${i}.ts`);
  manifestLines.push('#EXT-X-ENDLIST');
  const manifestBody = manifestLines.join('\n') + '\n';

  const srv = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/bench.m3u8') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(manifestBody);
    if (/^\/seg-\d+\.ts$/.test(p)) {
      await new Promise(r => setTimeout(r, RTT_MS));
      return res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': unitTs.length }).end(unitTs);
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const url = `http://127.0.0.1:${srv.address().port}/bench.m3u8`;

  const downloads = await import('../tools/media-downloads.mjs');
  const results = [];

  // 1. VideoSave Native HLS (12 connections)
  {
    const t0 = performance.now();
    const { id } = downloads.queueBatch({
      items: [{ kind: 'stream', url, sourceKind: 'm3u8', title: 'vs-native-12' }],
      connections: 12,
      prefetch: true,
    });
    const batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
    const ms = Math.round(performance.now() - t0);
    const file = batch.items[0]?.file;
    const v = file ? verifyOutput(file) : null;
    results.push({
      tool: 'VideoSave v1.2.0 (Native HLS, 12 conn)',
      installed: true,
      status: batch.status,
      elapsedMs: ms,
      durationSec: v?.duration ?? null,
      fileBytes: file ? (await stat(file)).size : 0,
      resumableCheckpoint: true,
      mcpNative: true,
    });
  }

  // 2. FFmpeg Direct (serial)
  {
    const outFile = path.join(sandbox.downloads, 'ffmpeg-direct.mp4');
    const t0 = performance.now();
    await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outFile], { windowsHide: true, timeout: 60_000 });
    const ms = Math.round(performance.now() - t0);
    const v = verifyOutput(outFile);
    results.push({
      tool: 'FFmpeg 8.1.2 (Direct Serial)',
      installed: true,
      status: 'done',
      elapsedMs: ms,
      durationSec: v.duration,
      fileBytes: (await stat(outFile)).size,
      resumableCheckpoint: false,
      mcpNative: false,
    });
  }

  // 3. yt-dlp (native m3u8, 8 concurrent fragments) — ONLY if actually installed/supplied
  if (ytdlp && existsSync(ytdlp)) {
    const outFile = path.join(sandbox.downloads, 'ytdlp-hls.mp4');
    const t0 = performance.now();
    const ytVer = execFileSync(ytdlp, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    await execFileAsync(ytdlp, [
      '--ignore-config', '--no-playlist', '--proxy', '', '--downloader', 'm3u8:native',
      '--concurrent-fragments', '8', '--no-progress', '--no-mtime',
      '--ffmpeg-location', ffmpeg, '-o', outFile, url,
    ], { windowsHide: true, timeout: 60_000 });
    const ms = Math.round(performance.now() - t0);
    const v = verifyOutput(outFile);
    results.push({
      tool: `yt-dlp ${ytVer} (m3u8:native, 8 conn)`,
      installed: true,
      status: 'done',
      elapsedMs: ms,
      durationSec: v.duration,
      fileBytes: (await stat(outFile)).size,
      resumableCheckpoint: true,
      mcpNative: false,
    });
  } else {
    results.push({ tool: 'yt-dlp', installed: false, status: 'not-installed' });
  }

  // 4. Honest status for tools not installed on this host
  for (const name of [
    streamlink && existsSync(streamlink) ? null : 'Streamlink',
    'Video DownloadHelper',
    'JDownloader',
    'Internet Download Manager (IDM)',
  ].filter(Boolean)) {
    results.push({ tool: name, installed: false, status: 'not-tested-not-installed-on-host' });
  }

  srv.closeAllConnections();
  await new Promise(r => srv.close(r));

  const actualWritePaths = await sandbox.collectActualWritePaths({ label: 'competitor-benchmark' });
  const report = {
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    fixture: { type: 'controlled-local-hls', segments: SEG_COUNT, simulatedRttMs: RTT_MS, totalDurationSec: SEG_COUNT },
    results,
    actualWritePaths: {
      sandboxEnforced: actualWritePaths.sandboxEnforced,
      osMonitorMechanism: actualWritePaths.osMonitorMechanism,
      outOfBoundsViolationCount: actualWritePaths.outOfBoundsViolationCount,
      writtenFileCount: actualWritePaths.writtenFileCount,
      allWritesInsideSandbox: actualWritePaths.allWritesInsideSandbox,
    },
  };
  if (outputPath) await writeFile(path.resolve(outputPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  restoreEnv();
  await sandbox.cleanup();
}
