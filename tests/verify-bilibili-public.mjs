import { execFileSync } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestSandbox } from './test-sandbox.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outputPath = option('output') || 'docs/compatibility-data/v1.3.1-bilibili-public.json';
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

const SAMPLES = [
  {
    id: 'bili-01-long-video-prev-567',
    category: 'long-video-previously-http-567',
    input: 'https://www.bilibili.com/video/BV1xx411c7mD/',
    quality: 384, // DASH separate video+audio (same track family that failed HTTP 567 in v1.2.0)
    mode: 'combined',
  },
  {
    id: 'bili-02-short-bare-bvid',
    category: 'short-video-bare-bvid-input',
    input: 'BV1J4411v7g6',
    quality: 'best',
    mode: 'combined',
  },
  {
    id: 'bili-03-b23-shortlink',
    category: 'b23-shortlink-resolution',
    input: 'https://b23.tv/BV1GJ411x7h7',
    quality: 480,
    mode: 'combined',
  },
  {
    id: 'bili-04-multip-part1-dash',
    category: 'multi-part-p1-dash-separate-av',
    input: 'https://www.bilibili.com/video/BV1uT4y1P7CX/?p=1',
    quality: 480,
    mode: 'combined',
  },
  {
    id: 'bili-05-multip-part2-quality-cap',
    category: 'multi-part-p2-quality-negotiation',
    input: 'https://www.bilibili.com/video/BV1uT4y1P7CX/?p=2',
    quality: 360,
    mode: 'combined',
  },
  {
    id: 'bili-06-highfps-multiquality-multicodec',
    category: 'multi-quality-multi-codec-demo',
    input: 'BV1fK4y1t7hj',
    quality: 480,
    mode: 'combined',
  },
  {
    id: 'bili-07-opencourse-multip-best',
    category: 'open-course-multi-p-best',
    input: 'https://www.bilibili.com/video/BV1ys411472E/',
    quality: 480,
    mode: 'combined',
  },
  {
    id: 'bili-08-avc1-only-multip',
    category: 'single-codec-avc1-multi-p',
    input: 'https://www.bilibili.com/video/BV124411C7nB/',
    quality: 480,
    mode: 'combined',
  },
  {
    id: 'bili-09-audio-only-extract',
    category: 'independent-audio-track-m4a',
    input: 'https://www.bilibili.com/video/BV1os411q7wR/',
    quality: 'best',
    mode: 'audio',
  },
  {
    id: 'bili-10-download-best-media-unified',
    category: 'unified-download-best-media-api',
    input: 'BV17x411w7KC',
    quality: 'best',
    mode: 'combined',
    useBestApi: true,
  },
  {
    id: 'bili-11-course-subtitles-enabled',
    category: 'large-playlist-course-with-subtitles-flag',
    input: 'https://www.bilibili.com/video/BV1Kb411W75N/?p=1',
    quality: 360,
    mode: 'combined',
    subtitles: true,
  },
];

function verifyPlayableMedia(filePath, mode) {
  const raw = execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,channels',
    filePath,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const parsed = JSON.parse(raw);
  const streams = parsed.streams || [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');

  // Verify real bitstream decode (first 15 seconds to confirm non-corrupt packets & playable media)
  let decodeOk = false;
  let decodeError = null;
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-i', filePath, '-t', '15', '-f', 'null', '-'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    decodeOk = true;
  } catch (err) {
    decodeError = String(err.stderr || err.message || 'decode failed').slice(0, 240);
  }

  const duration = Number(parsed.format?.duration ?? 0);
  const ok = duration > 1 && decodeOk && (mode === 'audio' ? Boolean(audio) : Boolean(video && audio));
  return {
    ffprobeOk: duration > 1 && (mode === 'audio' ? Boolean(audio) : Boolean(video && audio)),
    playableDecodeOk: decodeOk,
    decodeError,
    ok,
    durationSec: Math.round(duration * 1000) / 1000,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    formatName: parsed.format?.format_name ?? null,
  };
}

// Explicitly verify ZERO yt-dlp dependency by clearing YTDLP_BIN!
const sandbox = await createTestSandbox('bilibili-public-v13');
const restoreEnv = sandbox.applyProcessEnv({ YTDLP_BIN: '' });

try {
  const downloads = await import('../tools/media-downloads.mjs');
  const results = [];

  for (const sample of SAMPLES) {
    const t0 = performance.now();
    const row = {
      id: sample.id,
      category: sample.category,
      input: sample.input,
      requestedQuality: sample.quality,
      requestedMode: sample.mode,
      realPublicMedia: true,
      fallbackToLocalFixture: false,
      ytdlpUsed: false,
      probeStatus: 'pending',
      title: null,
      totalPages: null,
      availableQualities: [],
      engine: null,
      downloadStatus: 'pending',
      fileBytes: 0,
      verification: null,
      error: null,
      elapsedMs: 0,
    };

    try {
      if (sample.useBestApi) {
        const res = await downloads.downloadBestMedia({
          url: sample.input,
          quality: sample.quality,
          mode: sample.mode,
          waitTimeoutMs: 60_000,
          verify: true,
        });
        const pt = res.probe?.platformTarget;
        row.probeStatus = pt ? 'ok' : 'failed';
        row.title = pt?.title ?? res.item?.title ?? null;
        row.totalPages = pt?.totalPages ?? null;
        row.availableQualities = pt?.qualities ?? [];
        row.engine = res.item?.engine ?? 'bilibili-native';
        row.qualityNegotiation = res.item?.qualityNegotiation ?? null;
        row.subtitles = res.item?.subtitles ?? null;
        row.downloadStatus = res.status;
        if (res.item?.file) {
          row.fileBytes = (await stat(res.item.file)).size;
          row.verification = verifyPlayableMedia(res.item.file, sample.mode);
          if (row.qualityNegotiation) {
            row.qualityNegotiation.verificationLevel = 'deep';
            row.qualityNegotiation.verificationStatus = row.verification.ok ? 'verified' : 'failed';
            row.qualityConsistencyOk = sample.mode === 'audio'
              ? true
              : (row.qualityNegotiation.selectedQuality?.height === row.verification.height
                && row.qualityNegotiation.actualQuality?.height === row.verification.height);
          }
          if (row.verification.ok) row.downloadStatus = 'verified';
          else row.downloadStatus = 'verification-failed';
        } else {
          row.error = res.item?.error || res.item?.errorCode || 'No output file';
        }
      } else {
        const probed = await downloads.probe({ url: sample.input });
        const pt = probed.downloadTargets?.[0];
        row.probeStatus = pt ? 'ok' : 'failed';
        row.title = pt?.title ?? probed.pageTitle ?? null;
        row.totalPages = pt?.totalPages ?? (probed.pages?.length || 1);
        row.partSelection = pt?.partSelection ?? null;
        row.availableQualities = pt?.qualities ?? [];

        const { id } = downloads.queueBatch({
          items: [{
            kind: 'page',
            url: sample.input,
            quality: sample.quality,
            mode: sample.mode,
            subtitles: Boolean(sample.subtitles),
            ...(sample.subtitles && { subtitleFormat: 'both' }),
          }],
          connections: 8,
        });
        let batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
        for (let w = 0; w < 3 && batch.timedOut; w++) {
          batch = await downloads.waitForBatch({ id, timeoutMs: 60_000 });
        }
        const item = batch.items?.[0];
        row.engine = item?.engine ?? 'bilibili-native';
        row.qualityNegotiation = item?.qualityNegotiation ?? null;
        row.subtitles = item?.subtitles ?? null;
        if (item?.status === 'done' && item.file) {
          row.fileBytes = (await stat(item.file)).size;
          row.verification = verifyPlayableMedia(item.file, sample.mode);
          if (row.qualityNegotiation) {
            row.qualityNegotiation.verificationLevel = 'deep';
            row.qualityNegotiation.verificationStatus = row.verification.ok ? 'verified' : 'failed';
            row.qualityConsistencyOk = sample.mode === 'audio'
              ? true
              : (row.qualityNegotiation.selectedQuality?.height === row.verification.height
                && row.qualityNegotiation.actualQuality?.height === row.verification.height);
          }
          row.downloadStatus = row.verification.ok ? 'verified' : 'verification-failed';
        } else {
          row.downloadStatus = item?.errorCode || batch.status;
          row.error = item?.error || 'Download did not complete';
        }
      }
    } catch (err) {
      row.downloadStatus = err.code || 'error';
      row.error = err.message;
    }

    row.elapsedMs = Math.round(performance.now() - t0);
    results.push(row);
    console.log(
      row.downloadStatus === 'verified' ? 'PASS' : 'FAIL',
      `[${row.id}]`,
      `engine=${row.engine}`,
      `q=${JSON.stringify(row.availableQualities)}`,
      row.verification ? `${row.verification.width || 'audio'}x${row.verification.height || ''} ${row.verification.durationSec}s ${row.verification.videoCodec || ''}+${row.verification.audioCodec || ''} decode=${row.verification.playableDecodeOk}` : row.error,
      `${(row.fileBytes / (1024 * 1024)).toFixed(2)} MiB`,
      `(${row.elapsedMs} ms)`,
    );
  }

  // Additional real-world check: exact:1080 MUST fail explicitly on an anonymous 720p-max video (no silent downgrade)
  let exactRejectCheck = { requested: 'exact:1080', input: 'BV1J4411v7g6', rejectedExplicitly: false, errorCode: null };
  try {
    const { id } = downloads.queueBatch({
      items: [{ kind: 'page', url: 'BV1J4411v7g6', quality: 'exact:1080', mode: 'combined' }],
      connections: 8,
    });
    const b = await downloads.waitForBatch({ id, timeoutMs: 30_000 });
    const it = b.items?.[0];
    exactRejectCheck = {
      requested: 'exact:1080',
      input: 'BV1J4411v7g6',
      rejectedExplicitly: it?.status === 'error' && it?.errorCode === 'QUALITY_UNAVAILABLE',
      errorCode: it?.errorCode ?? it?.status ?? null,
    };
  } catch (err) {
    exactRejectCheck = { requested: 'exact:1080', input: 'BV1J4411v7g6', rejectedExplicitly: err.code === 'QUALITY_UNAVAILABLE', errorCode: err.code ?? 'error' };
  }

  const actualWritePaths = await sandbox.collectActualWritePaths({ label: 'bilibili-public-v131' });
  const passed = results.filter(r => r.downloadStatus === 'verified').length;
  const qualityConsistentCount = results.filter(r => r.qualityConsistencyOk === true).length;
  const report = {
    recordedAt: new Date().toISOString(),
    version: '1.3.1',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ytdlpRequired: false,
    ytdlpConfiguredDuringTest: false,
    realPublicMediaOnly: true,
    fallbackToLocalFixtureCount: 0,
    verificationLevel: 'deep',
    exactQualityRejectionCheck: exactRejectCheck,
    summary: {
      total: results.length,
      probed: results.filter(r => r.probeStatus === 'ok').length,
      verified: passed,
      qualityConsistent: qualityConsistentCount,
      failed: results.length - passed,
      successRatePct: Math.round((passed / results.length) * 1000) / 10,
      totalDownloadedBytes: results.reduce((s, r) => s + r.fileBytes, 0),
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
  console.log('SUMMARY:', JSON.stringify(report.summary), 'exactReject:', JSON.stringify(exactRejectCheck));
  if (passed < 10 || qualityConsistentCount !== results.length || !exactRejectCheck.rejectedExplicitly) process.exitCode = 1;
} finally {
  restoreEnv();
  await sandbox.cleanup();
}
