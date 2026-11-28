import { execFileSync } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestSandbox } from './test-sandbox.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputPath = option('output') || 'docs/compatibility-data/v1.3.1-platforms-public.json';
const ytdlp = option('yt-dlp') || process.env.YTDLP_BIN || null;
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

const SAMPLES = [
  {
    id: 'bilibili-public-verified',
    platform: 'bilibili',
    url: 'BV1J4411v7g6',
    quality: 'best',
    note: 'Native bilibili-native engine (zero yt-dlp required)',
  },
  {
    id: 'youtube-public-verified',
    platform: 'youtube',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    quality: 360,
    note: 'Managed yt-dlp + Node 24 JS runtime',
  },
  {
    id: 'internet-archive-public-verified',
    platform: 'internet-archive',
    url: 'https://archive.org/details/SampleVideo1280x7205mb',
    quality: 'best',
    note: 'Native Internet Archive metadata API (zero yt-dlp required)',
  },
  {
    id: 'wikimedia-commons-public-verified',
    platform: 'wikimedia',
    url: 'https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_extract.ogv',
    quality: 'best',
    note: 'Native Wikimedia Commons imageinfo API (zero yt-dlp required)',
  },
];

function verifyPlayable(filePath) {
  const raw = execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    filePath,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const data = JSON.parse(raw);
  const v = (data.streams || []).find(s => s.codec_type === 'video');
  const a = (data.streams || []).find(s => s.codec_type === 'audio');
  let decodeOk = false;
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-i', filePath, '-t', '10', '-f', 'null', '-'], { windowsHide: true, timeout: 25_000 });
    decodeOk = true;
  } catch {}
  return {
    duration: Math.round(Number(data.format?.duration ?? 0) * 1000) / 1000,
    width: v?.width ?? null,
    height: v?.height ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    playableDecodeOk: decodeOk,
    ok: Number(data.format?.duration ?? 0) > 1 && decodeOk && Boolean(v || a),
  };
}

const sandbox = await createTestSandbox('platforms-public-v13');
const restoreEnv = sandbox.applyProcessEnv(ytdlp ? { YTDLP_BIN: ytdlp } : {});

try {
  const { configureMediaProxy } = await import('../tools/media-proxy.mjs');
  configureMediaProxy();
  const downloads = await import('../tools/media-downloads.mjs');
  const results = [];

  for (const sample of SAMPLES) {
    const t0 = performance.now();
    const entry = {
      id: sample.id,
      platform: sample.platform,
      url: sample.url,
      note: sample.note,
      realPublicMedia: true,
      fallbackToLocalFixture: false,
      probeStatus: 'pending',
      engine: null,
      downloadStatus: 'pending',
      title: null,
      qualities: [],
      fileBytes: 0,
      verification: null,
      error: null,
      elapsedMs: 0,
    };

    try {
      const probed = await downloads.probe({ url: sample.url });
      const pt = probed.downloadTargets?.[0];
      entry.probeStatus = pt ? 'ok' : 'no-media';
      entry.title = pt?.title ?? probed.pageTitle ?? null;
      entry.qualities = pt?.qualities ?? [];

      const { id } = downloads.queueBatch({
        items: [{ kind: 'page', url: sample.url, quality: sample.quality }],
        connections: 8,
      });
      let batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
      for (let w = 0; w < 2 && batch.timedOut; w++) {
        batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
      }
      const item = batch.items?.[0];
      entry.engine = item?.engine ?? pt?.engine ?? null;
      if (item?.status === 'done' && item.file) {
        entry.fileBytes = (await stat(item.file)).size;
        entry.verification = verifyPlayable(item.file);
        entry.downloadStatus = entry.verification.ok ? 'verified' : 'verification-failed';
      } else {
        entry.downloadStatus = item?.errorCode || batch.status;
        entry.error = item?.error || 'Download did not complete';
      }
    } catch (err) {
      entry.downloadStatus = err.code || 'error';
      entry.error = err.message;
    }

    entry.elapsedMs = Math.round(performance.now() - t0);
    results.push(entry);
    console.log(
      entry.downloadStatus === 'verified' ? 'PASS' : 'FAIL',
      `[${entry.platform}]`,
      `engine=${entry.engine}`,
      entry.verification ? `${entry.verification.width}x${entry.verification.height} ${entry.verification.duration}s ${entry.verification.videoCodec}+${entry.verification.audioCodec} decode=${entry.verification.playableDecodeOk}` : entry.error,
      `(${entry.elapsedMs} ms)`,
    );
  }

  const actualWritePaths = await sandbox.collectActualWritePaths({ label: 'platforms-public-v13' });
  const report = {
    recordedAt: new Date().toISOString(),
    version: '1.3.1',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ytdlpConfigured: downloads.platformDownloadsEnabled(),
    summary: {
      total: results.length,
      probed: results.filter(r => r.probeStatus === 'ok').length,
      verified: results.filter(r => r.downloadStatus === 'verified').length,
    },
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
  console.log('MULTI_PLATFORM_SUMMARY:', JSON.stringify(report.summary));
} finally {
  restoreEnv();
  await sandbox.cleanup();
}
