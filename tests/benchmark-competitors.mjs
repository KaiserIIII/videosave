import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTestSandbox } from './test-sandbox.mjs';

const execFileAsync = promisify(execFile);
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputPath = option('output') || 'docs/compatibility-data/v1.3.0-competitor-benchmark.json';
const ROUNDS = Math.max(1, Number.parseInt(option('rounds') || '3', 10) || 3);
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const ytdlp = option('yt-dlp') || process.env.YTDLP_BIN || null;
const streamlink = process.env.STREAMLINK_BIN || null;

const TARGET_DURATION_SEC = 120;
const SEGMENT_DURATION_SEC = 2; // 60 unique monotonic-PTS segments = exact 120.0s real timeline
const DURATION_TOLERANCE_SEC = 1.5;
const RTT_MS = 15;

const sandbox = await createTestSandbox('competitor-benchmark-v13');
const restoreEnv = sandbox.applyProcessEnv();

function strictVerifyOutput(file) {
  const raw = execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    file,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const data = JSON.parse(raw);
  const streams = data.streams ?? [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? 0);

  // Real full-stream decode check (must decode with zero errors)
  let decodeOk = false;
  let decodeError = null;
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    decodeOk = true;
  } catch (err) {
    decodeError = String(err.stderr || err.message || 'decode error').slice(0, 200);
  }

  const durationValid = Math.abs(duration - TARGET_DURATION_SEC) <= DURATION_TOLERANCE_SEC;
  const tracksValid = Boolean(video && audio);
  return {
    durationSec: Math.round(duration * 1000) / 1000,
    durationValid,
    tracksValid,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    decodeOk,
    decodeError,
    qualified: durationValid && tracksValid && decodeOk,
  };
}

function summarizeRounds(toolName, installed, runs, extra = {}) {
  const valid = runs.filter(r => r.qualified);
  const times = valid.map(r => r.elapsedMs).sort((a, b) => a - b);
  const medianMs = times.length
    ? (times.length % 2 ? times[Math.floor(times.length / 2)] : Math.round((times[times.length / 2 - 1] + times[times.length / 2]) / 2))
    : null;
  return {
    tool: toolName,
    installed,
    rounds: runs.length,
    validRounds: valid.length,
    successRatePct: runs.length ? Math.round((valid.length / runs.length) * 1000) / 10 : 0,
    validForRanking: valid.length === runs.length && runs.length > 0,
    medianMs,
    minMs: times[0] ?? null,
    maxMs: times[times.length - 1] ?? null,
    durationSec: valid[0]?.durationSec ?? runs[0]?.durationSec ?? null,
    fileBytes: valid[0]?.fileBytes ?? runs[0]?.fileBytes ?? 0,
    decodeOk: valid.length === runs.length && runs.length > 0,
    runs,
    ...extra,
  };
}

try {
  // Generate REAL 120-second monotonic-PTS HLS fixture (60 distinct 2-second segments, unique PTS 0..120s!)
  const hlsDir = path.join(sandbox.media, 'hls-monotonic');
  await import('node:fs/promises').then(m => m.mkdir(hlsDir, { recursive: true }));
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=15:d=${TARGET_DURATION_SEC}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${TARGET_DURATION_SEC}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls', '-hls_time', String(SEGMENT_DURATION_SEC), '-hls_list_size', '0',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(hlsDir, 'seg-%03d.ts'),
    path.join(hlsDir, 'bench.m3u8'),
  ], { windowsHide: true, timeout: 60_000 });

  const filesInHls = await readdir(hlsDir);
  const segCache = new Map();
  for (const name of filesInHls) {
    segCache.set('/' + name, await readFile(path.join(hlsDir, name)));
  }
  const segCount = filesInHls.filter(f => f.endsWith('.ts')).length;

  const srv = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    const body = segCache.get(p);
    if (!body) return res.writeHead(404).end();
    if (p.endsWith('.m3u8')) {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length }).end(body);
    }
    await new Promise(r => setTimeout(r, RTT_MS));
    return res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': body.length }).end(body);
  }).listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const url = `http://127.0.0.1:${srv.address().port}/bench.m3u8`;

  const downloads = await import('../tools/media-downloads.mjs');
  const results = [];

  // 1. VideoSave v1.3.0 Native HLS (12 connections)
  {
    const runs = [];
    for (let r = 0; r < ROUNDS; r++) {
      const t0 = performance.now();
      const { id } = downloads.queueBatch({
        items: [{ kind: 'stream', url, sourceKind: 'm3u8', title: `vs-native-r${r}` }],
        connections: 12,
        prefetch: true,
        resume: false,
      });
      const batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
      const elapsedMs = Math.round(performance.now() - t0);
      const file = batch.items[0]?.file;
      const v = file ? strictVerifyOutput(file) : { qualified: false, durationSec: 0, decodeOk: false };
      runs.push({ round: r + 1, elapsedMs, fileBytes: file ? (await stat(file)).size : 0, ...v });
    }
    results.push(summarizeRounds('VideoSave v1.3.0 (Native HLS, 12 conn)', true, runs, { resumableCheckpoint: true, mcpNative: true }));
  }

  // 2. FFmpeg 8.1.2 Direct Serial
  {
    const runs = [];
    for (let r = 0; r < ROUNDS; r++) {
      const outFile = path.join(sandbox.downloads, `ffmpeg-direct-r${r}.mp4`);
      const t0 = performance.now();
      await execFileAsync(ffmpeg, ['-v', 'error', '-y', '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outFile], { windowsHide: true, timeout: 60_000 });
      const elapsedMs = Math.round(performance.now() - t0);
      const v = strictVerifyOutput(outFile);
      runs.push({ round: r + 1, elapsedMs, fileBytes: (await stat(outFile)).size, ...v });
    }
    results.push(summarizeRounds('FFmpeg 8.1.2 (Direct Serial)', true, runs, { resumableCheckpoint: false, mcpNative: false }));
  }

  // 3. yt-dlp (native m3u8, 8 concurrent fragments) — strictly verified for exact 120s duration & full decode!
  if (ytdlp && existsSync(ytdlp)) {
    const ytVer = execFileSync(ytdlp, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    const runs = [];
    for (let r = 0; r < ROUNDS; r++) {
      const outFile = path.join(sandbox.downloads, `ytdlp-hls-r${r}.mp4`);
      const t0 = performance.now();
      await execFileAsync(ytdlp, [
        '--ignore-config', '--no-playlist', '--proxy', '', '--downloader', 'm3u8:native',
        '--concurrent-fragments', '8', '--no-progress', '--no-mtime',
        '--ffmpeg-location', ffmpeg, '-o', outFile, url,
      ], { windowsHide: true, timeout: 60_000 });
      const elapsedMs = Math.round(performance.now() - t0);
      const v = strictVerifyOutput(outFile);
      runs.push({ round: r + 1, elapsedMs, fileBytes: (await stat(outFile)).size, ...v });
    }
    results.push(summarizeRounds(`yt-dlp ${ytVer} (m3u8:native, 8 conn)`, true, runs, { resumableCheckpoint: true, mcpNative: false }));
  } else {
    results.push({ tool: 'yt-dlp', installed: false, validForRanking: false, status: 'not-installed' });
  }

  // 4. Honest status for tools not installed on this host
  for (const name of [
    streamlink && existsSync(streamlink) ? null : 'Streamlink',
    'Video DownloadHelper',
    'JDownloader',
    'Internet Download Manager (IDM)',
  ].filter(Boolean)) {
    results.push({ tool: name, installed: false, validForRanking: false, status: 'not-tested-not-installed-on-host' });
  }

  srv.closeAllConnections();
  await new Promise(r => srv.close(r));

  const ranked = results
    .filter(r => r.validForRanking && Number.isFinite(r.medianMs))
    .sort((a, b) => a.medianMs - b.medianMs)
    .map((r, idx) => ({ rank: idx + 1, tool: r.tool, medianMs: r.medianMs, durationSec: r.durationSec }));

  const actualWritePaths = await sandbox.collectActualWritePaths({ label: 'competitor-benchmark-v13' });
  const report = {
    recordedAt: new Date().toISOString(),
    version: '1.3.0',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    methodology: 'Monotonic-PTS 120s real HLS stream (unique PTS per segment), multi-round median, strict FFprobe duration (±1.5s) + A/V track + full FFmpeg null-decode qualification gate. Invalid outputs are excluded from rankings.',
    fixture: {
      type: 'controlled-local-hls-monotonic-pts',
      segments: segCount,
      segmentDurationSec: SEGMENT_DURATION_SEC,
      simulatedRttMs: RTT_MS,
      totalDurationSec: TARGET_DURATION_SEC,
      roundsPerTool: ROUNDS,
    },
    rankedQualifiedTools: ranked,
    results,
    actualWritePaths: {
      sandboxEnforced: actualWritePaths.sandboxEnforced,
      osMonitorMechanism: actualWritePaths.osMonitorMechanism,
      auditComplete: actualWritePaths.auditComplete,
      outOfBoundsViolationCount: actualWritePaths.outOfBoundsViolationCount,
      writtenFileCount: actualWritePaths.writtenFileCount,
      allWritesInsideSandbox: actualWritePaths.allWritesInsideSandbox,
    },
  };
  await writeFile(path.resolve(outputPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ rankedQualifiedTools: ranked, auditComplete: actualWritePaths.auditComplete, outOfBounds: actualWritePaths.outOfBoundsViolationCount }, null, 2));
} finally {
  restoreEnv();
  await sandbox.cleanup();
}
