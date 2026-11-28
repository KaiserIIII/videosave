import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createTestSandbox } from './test-sandbox.mjs';

const sandbox = await createTestSandbox('v131-quality-subtitles');
const restoreEnv = sandbox.applyProcessEnv();
test.after(async () => {
  const audit = await sandbox.collectActualWritePaths({ label: 'v131-quality-subtitles' });
  assert.equal(audit.auditComplete, true);
  assert.equal(audit.outOfBoundsViolationCount, 0);
  restoreEnv();
  await sandbox.cleanup();
});

const { buildQualityNegotiationReport } = await import('../tools/quality-negotiator.mjs');
const {
  convertBilibiliSubtitleJson,
  expandBilibiliParts,
  selectBilibiliVideoTrack,
  selectSubtitleTracks,
} = await import('../tools/bilibili-adapter.mjs');
const { platformFailure } = await import('../tools/platform-downloads.mjs');
const { FFMPEG, inspectOutput } = await import('../tools/media-source.mjs');

test('Bilibili quality selection accurately respects cap, best, lowest, and strict exact:HEIGHT', () => {
  const dashTracks = [
    { formatKind: 'dash', qn: 32, height: 480, width: 852, bandwidth: 900_000, codec: 'avc1.64001E', mirrors: ['https://upos-sz-mirrorcos.bilivideo.com/480.m4s'] },
    { formatKind: 'dash', qn: 32, height: 480, width: 852, bandwidth: 650_000, codec: 'hev1.1.6.L120.90', mirrors: ['https://upos-sz-mirrorcos.bilivideo.com/480h.m4s'] },
    { formatKind: 'dash', qn: 16, height: 360, width: 640, bandwidth: 450_000, codec: 'avc1.64001E', mirrors: ['https://upos-sz-mirrorcos.bilivideo.com/360.m4s'] },
  ];
  const durl720 = [
    { formatKind: 'durl', qn: 64, declaredHeight: 720, height: 720, width: 1280, bandwidth: 1_800_000, codec: 'avc1+mp4a', mirrors: ['https://upos-sz-mirrorcos.bilivideo.com/720.mp4'] },
  ];

  // Cap 480 MUST select 480p DASH, NOT 720p durl!
  const pick480 = selectBilibiliVideoTrack(dashTracks, durl720, 480);
  assert.equal(pick480.selected.height, 480);
  assert.equal(pick480.selected.formatKind, 'dash');
  assert.equal(pick480.selected.codec, 'avc1.64001E');
  assert.equal(pick480.fallbackApplied, false);
  assert.equal(pick480.reason, 'exact-cap-match');

  // Cap 360 MUST select 360p DASH
  const pick360 = selectBilibiliVideoTrack(dashTracks, durl720, 360);
  assert.equal(pick360.selected.height, 360);
  assert.equal(pick360.fallbackApplied, false);
  assert.equal(pick360.reason, 'exact-cap-match');

  // Best selects 720p durl
  const pickBest = selectBilibiliVideoTrack(dashTracks, durl720, 'best');
  assert.equal(pickBest.selected.height, 720);
  assert.equal(pickBest.fallbackApplied, false);

  // Lowest selects 360p DASH
  const pickLow = selectBilibiliVideoTrack(dashTracks, durl720, 'lowest');
  assert.equal(pickLow.selected.height, 360);

  // exact:720 succeeds with exact match
  const pickExact720 = selectBilibiliVideoTrack(dashTracks, durl720, 'exact:720');
  assert.equal(pickExact720.selected.height, 720);
  assert.equal(pickExact720.fallbackApplied, false);
  assert.equal(pickExact720.reason, 'exact-match');

  // exact:1080 MUST fail explicitly instead of silently downgrading!
  assert.throws(
    () => selectBilibiliVideoTrack(dashTracks, durl720, 'exact:1080'),
    err => err.code === 'QUALITY_UNAVAILABLE',
  );
});

test('Unified quality negotiation model accurately detects actual-vs-declared discrepancies', () => {
  const consistent = buildQualityNegotiationReport({
    requestedQuality: 480,
    availableQualities: [720, 480, 360],
    declaredQuality: { height: 480, width: 852, codec: 'avc1', formatKind: 'dash' },
    selectedQuality: { height: 480, width: 852, codec: 'avc1', formatKind: 'dash' },
    actualQuality: { height: 480, width: 852, videoCodec: 'h264', audioCodec: 'aac', duration: 60 },
    fallbackApplied: false,
    reason: 'exact-cap-match',
    verificationLevel: 'deep',
    verificationStatus: 'verified',
  });
  assert.equal(consistent.selectedQuality.height, 480);
  assert.equal(consistent.actualQuality.height, 480);
  assert.equal(consistent.fallbackApplied, false);
  assert.equal(consistent.fallbackReason, null);
  assert.equal(consistent.verificationLevel, 'deep');

  // If actual FFprobe height differs from platform declared height, fallbackApplied MUST become true with clear reason!
  const discrepant = buildQualityNegotiationReport({
    requestedQuality: 'best',
    availableQualities: [720, 384],
    declaredQuality: { height: 720, width: 1280, codec: 'avc1+mp4a', formatKind: 'durl' },
    selectedQuality: { height: 720, width: 1280, codec: 'avc1+mp4a', formatKind: 'durl' },
    actualQuality: { height: 384, width: 512, videoCodec: 'h264', audioCodec: 'aac', duration: 120 },
    fallbackApplied: false,
    reason: 'highest-available',
  });
  assert.equal(discrepant.fallbackApplied, true);
  assert.match(discrepant.fallbackReason, /384p.*720p/);
  assert.equal(discrepant.actualHeight, 384);
});

test('Bilibili subtitle converter produces valid WebVTT & SRT timelines and embeds verified mov_text track in MP4', async () => {
  const sampleJson = {
    body: [
      { from: 0.2, to: 1.5, content: 'Hello VideoSave' },
      { from: 1.6, to: 2.9, content: '第二行双语字幕测试' },
      { from: -1, to: 0.5, content: 'invalid negative start ignored' },
      { from: 2.0, to: 1.0, content: 'invalid reversed cue ignored' },
    ],
  };
  const converted = convertBilibiliSubtitleJson(sampleJson);
  assert.ok(converted);
  assert.equal(converted.cueCount, 2);
  assert.equal(converted.timelineValid, true);
  assert.match(converted.vtt, /^WEBVTT\n\n00:00:00\.200 --> 00:00:01\.500\nHello VideoSave/);
  assert.match(converted.srt, /^1\n00:00:00,200 --> 00:00:01,500\nHello VideoSave/);

  // Language selection filter
  const tracks = [
    { language: 'zh-CN', label: '中文' },
    { language: 'en-US', label: 'English' },
    { language: 'ja', label: '日本語' },
  ];
  assert.deepEqual(selectSubtitleTracks(tracks, ['en']).map(t => t.language), ['en-US']);
  assert.deepEqual(selectSubtitleTracks(tracks, ['all']).map(t => t.language), ['zh-CN', 'en-US', 'ja']);

  // End-to-end real FFmpeg mov_text mux + FFprobe standard & deep verification
  const workDir = path.join(sandbox.media, 'sub-verify');
  await mkdir(workDir, { recursive: true });
  const vttFile = path.join(workDir, 'test.zh-CN.vtt');
  const srtFile = path.join(workDir, 'test.zh-CN.srt');
  const rawMp4 = path.join(workDir, 'raw.mp4');
  const muxedMp4 = path.join(workDir, 'with-sub.mp4');
  await writeFile(vttFile, converted.vtt, 'utf8');
  await writeFile(srtFile, converted.srt, 'utf8');
  execFileSync(FFMPEG, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=15:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    rawMp4,
  ], { windowsHide: true });
  execFileSync(FFMPEG, [
    '-v', 'error', '-y',
    '-i', rawMp4, '-i', vttFile,
    '-map', '0:v:0', '-map', '0:a:0', '-map', '1:0',
    '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=chi',
    muxedMp4,
  ], { windowsHide: true });

  const quick = await inspectOutput(muxedMp4, AbortSignal.timeout(10_000), 'video', 3, { level: 'quick' });
  assert.equal(quick.verificationLevel, 'quick');
  assert.equal(quick.playableDecodeOk, null);

  const standard = await inspectOutput(muxedMp4, AbortSignal.timeout(10_000), 'video', 3, { level: 'standard' });
  assert.equal(standard.verificationLevel, 'standard');
  assert.equal(standard.playableDecodeOk, null);
  assert.equal(standard.subtitleTracks, 1);
  assert.equal(standard.height, 240);

  const deep = await inspectOutput(muxedMp4, AbortSignal.timeout(15_000), 'video', 3, { level: 'deep' });
  assert.equal(deep.verificationLevel, 'deep');
  assert.equal(deep.playableDecodeOk, true);
  assert.equal(deep.subtitleTracks, 1);

  assert.ok((await stat(srtFile)).size > 20);
  assert.match(await readFile(srtFile, 'utf8'), /第二行双语字幕测试/);
});

test('Multi-P part expansion defaults strictly to current P and enforces batch safety cap', () => {
  const probed = {
    url: 'https://www.bilibili.com/video/BV1Kb411W75N/?p=3',
    partIndex: 3,
    totalPages: 716,
    pages: Array.from({ length: 716 }, (_, i) => ({
      page: i + 1,
      url: `https://www.bilibili.com/video/BV1Kb411W75N/?p=${i + 1}`,
      part: `Part ${i + 1}`,
    })),
  };

  // Default mode MUST download only current P (never explode into 716 tasks!)
  const def = expandBilibiliParts(probed);
  assert.equal(def.mode, 'current');
  assert.deepEqual(def.selectedPages, [3]);

  // Explicit selected pages
  const sel = expandBilibiliParts(probed, { multiPartMode: 'selected', pages: [1, 5, 5, 10] });
  assert.equal(sel.mode, 'selected');
  assert.deepEqual(sel.selectedPages, [1, 5, 10]);

  // Explicit all on 716-part course triggers safety guard
  assert.throws(
    () => expandBilibiliParts(probed, { multiPartMode: 'all', maxParts: 100 }),
    err => err.code === 'TOO_MANY_PARTS',
  );
});

test('HTTP 401/403/451 and non-standard Bilibili 567 remain strictly access-restricted while standard 503 is transient', () => {
  const err567 = platformFailure('bilibili', { stderr: 'ERROR: unable to download video data: HTTP Error 567: Unknown' });
  assert.equal(err567.code, 'MEDIA_ACCESS_RESTRICTED');
  assert.equal(err567.detail?.status, 567);

  const err403 = platformFailure('bilibili', { stderr: 'ERROR: HTTP Error 403: Forbidden' });
  assert.equal(err403.code, 'MEDIA_ACCESS_RESTRICTED');
  assert.equal(err403.status, 403);

  const err503 = platformFailure('bilibili', { stderr: 'ERROR: Server returned 503' });
  assert.equal(err503.code, 'PLATFORM_DOWNLOAD_FAILED');
});
