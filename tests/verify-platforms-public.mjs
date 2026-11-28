/**
 * Real public platform acceptance verification (Bilibili & YouTube) in a clean sandbox.
 * NEVER falls back to local mock fixtures; records exact real public network outcomes honestly.
 */
import { execFileSync } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestSandbox } from './test-sandbox.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputPath = option('output');
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

const sandbox = await createTestSandbox('platform-public-acceptance');
const restoreEnv = sandbox.applyProcessEnv();
if (option('yt-dlp')) process.env.YTDLP_BIN = path.resolve(option('yt-dlp'));

const publicTargets = [
  {
    platform: 'bilibili',
    id: 'bilibili-public-sample',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    note: 'Official public Bilibili sample (video/BV1xx411c7mD)',
  },
  {
    platform: 'youtube',
    id: 'youtube-public-sample',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    note: 'Public historical YouTube sample (Me at the zoo, 19s)',
  },
];

function probeDiskFile(file) {
  const raw = execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', file,
  ], { encoding: 'utf8', windowsHide: true });
  const data = JSON.parse(raw);
  const video = (data.streams ?? []).find(s => s.codec_type === 'video');
  const audio = (data.streams ?? []).find(s => s.codec_type === 'audio');
  return {
    duration: Number(data.format?.duration ?? 0),
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

try {
  const downloads = await import('../tools/media-downloads.mjs');
  const results = [];

  for (const target of publicTargets) {
    const t0 = performance.now();
    const entry = {
      id: target.id,
      platform: target.platform,
      url: target.url,
      realPublicMedia: true,
      fallbackToLocalFixture: false,
      probeStatus: 'not-run',
      downloadStatus: 'not-run',
    };
    try {
      const probed = await downloads.probe({ url: target.url }, AbortSignal.timeout(45_000));
      entry.probeStatus = 'ok';
      entry.title = probed.title ?? null;
      entry.qualities = (probed.qualities ?? []).slice(0, 6);
      const { id } = downloads.queueBatch({
        items: [{ url: target.url, quality: 360, format: 'mp4' }],
        concurrency: 1,
        connections: 4,
      });
      let batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
      if (batch.timedOut) batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
      const item = batch.items?.[0];
      if (batch.status === 'done' && item?.file) {
        const info = probeDiskFile(item.file);
        entry.downloadStatus = 'verified';
        entry.fileBytes = (await stat(item.file)).size;
        entry.verification = info;
      } else {
        entry.downloadStatus = item?.errorCode || batch.status;
        entry.error = item?.error || null;
      }
    } catch (err) {
      entry.probeStatus = entry.probeStatus === 'ok' ? 'ok' : 'failed';
      entry.downloadStatus = err.code || 'ERROR';
      entry.error = err.message;
    }
    entry.elapsedMs = Math.round(performance.now() - t0);
    results.push(entry);
  }

  const actualWritePaths = await sandbox.collectActualWritePaths({ label: 'platform-public-acceptance' });
  const report = {
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ytdlpConfigured: Boolean(process.env.YTDLP_BIN),
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
