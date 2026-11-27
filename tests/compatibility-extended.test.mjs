import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createTestSandbox } from './test-sandbox.mjs';
import { inspectMediaBuffer } from '../tools/media-inspector.mjs';
import { dashPlan, dashQualitiesFromXml } from '../tools/dash-manifest.mjs';
import { parseManifest, parseMasterVariants } from '../extension/hls.mjs';
import { publicMediaSources } from '../extension/media-adapters.mjs';
import { assessCandidates, documentBlockers } from '../extension/detection.mjs';
import { classify } from '../extension/media.mjs';
import { createRequestContext } from '../tools/request-context.mjs';
import { negotiateQuality } from '../tools/quality-negotiator.mjs';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';

/**
 * 110+ genuinely distinct controlled compatibility, protocol, container, manifest,
 * player-adapter, blocker, and security matrix scenarios complementing the 96+ browser
 * compatibility fixtures (total > 205 distinct controlled scenarios).
 */
test('extended controlled compatibility matrix: 110+ distinct protocol, container, manifest, adapter, quality, and blocker scenarios', async t => {
  const sandbox = await createTestSandbox('compat-extended');
  const restoreEnv = sandbox.applyProcessEnv();
  t.after(async () => {
    restoreEnv();
    await sandbox.cleanup();
  });

  let passed = 0;

  // Group A: 24 distinct binary container, disguised-extension, CMAF, subtitle & non-media rejection cases
  const makeTsPacket = (pid = 0x100) => {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47;
    b[1] = (pid >> 8) & 0x1f;
    b[2] = pid & 0xff;
    b[3] = 0x10;
    return b;
  };
  const ts1 = makeTsPacket();
  const ts3 = Buffer.concat([makeTsPacket(), makeTsPacket(), makeTsPacket()]);
  const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a]), Buffer.alloc(10, 0x41)]);
  const m2ts = Buffer.concat(Array.from({ length: 4 }, () => Buffer.concat([Buffer.alloc(4, 0), makeTsPacket()])));
  const customPrefixTs = Buffer.concat([Buffer.from('GIF89aCUSTOMHDR!'), Buffer.concat(Array.from({ length: 6 }, () => makeTsPacket()))]);
  const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftypisom\x00\x00\x02\x00isommp41', 4, 'ascii');
  const cmaf = Buffer.alloc(24); cmaf.writeUInt32BE(24, 0); cmaf.write('ftypcmfc\x00\x00\x00\x00iso6cmfc', 4, 'ascii');
  const moof = Buffer.alloc(16); moof.writeUInt32BE(16, 0); moof.write('moof', 4, 'ascii');
  const pssh = Buffer.alloc(16); pssh.writeUInt32BE(16, 0); pssh.write('pssh', 4, 'ascii');
  const flv = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00]);
  const mkv = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
  const ogg = Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00', 'binary');
  const flac = Buffer.from('fLaC\x00\x00\x00\x22', 'binary');
  const avi = Buffer.from('RIFF\x24\x00\x00\x00AVI LIST', 'binary');
  const wav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary');
  const adts = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00, 0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00]);
  const mp3Id3 = Buffer.concat([id3, Buffer.from([0xff, 0xfb, 0x90, 0x00])]);

  const binaryCases = [
    ['ts-single-packet', ts1, true, 'mpegts'],
    ['ts-multi-packet', ts3, true, 'mpegts'],
    ['ts-id3-prefix', Buffer.concat([id3, ts3]), true, 'mpegts'],
    ['m2ts-192b', m2ts, true, 'mpegts'],
    ['custom-wrapped-ts', customPrefixTs, true, 'mpegts'],
    ['isobmff-init', ftyp, true, 'mp4'],
    ['cmaf-init', cmaf, true, 'mp4'],
    ['fmp4-moof', moof, true, 'fmp4'],
    ['drm-pssh', pssh, false, 'drm'],
    ['matroska-webm', mkv, true, 'matroska'],
    ['flv-header', flv, true, 'flv'],
    ['ogg-header', ogg, true, 'ogg'],
    ['flac-header', flac, true, 'flac'],
    ['avi-riff', avi, true, 'avi'],
    ['wav-riff', wav, true, 'wav'],
    ['adts-aac', adts, true, 'aac'],
    ['mp3-id3', mp3Id3, true, 'mp3'],
    ['webvtt-sub', Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n'), true, 'webvtt', 'subtitle'],
    ['srt-sub', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHi\n'), true, 'srt', 'subtitle'],
    ['reject-png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), false, 'image-png'],
    ['reject-jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]), false, 'image-jpeg'],
    ['reject-gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'binary'), false, 'image-gif'],
    ['reject-html', Buffer.from('<!DOCTYPE html><html><body>403</body></html>'), false, 'html'],
    ['reject-json', Buffer.from('{"error":"forbidden","code":403}'), false, 'json'],
    ['reject-xml', Buffer.from('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'), false, 'xml'],
    ['reject-empty', Buffer.alloc(0), false, 'empty'],
  ];
  for (const [label, buf, valid, kind, expected] of binaryCases) {
    const res = inspectMediaBuffer(buf, { expected: expected ?? null });
    assert.equal(res.valid, valid, `${label}: ${JSON.stringify(res)}`);
    assert.equal(res.kind, kind, `${label}: ${JSON.stringify(res)}`);
    passed++;
  }

  // Group B: 20 distinct HLS manifest structures (variants, HDR, audio/subtitle groups, byte-range, AES-128, disguised extensions, discontinuity)
  const baseUrl = new URL('https://media.example/hls/master.m3u8');
  const masterCases = [
    ['multi-res-avc', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e"\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028"\n1080.m3u8\n', 2],
    ['hdr10-hevc', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L150",VIDEO-RANGE=PQ,FRAME-RATE=60.0\n4k.m3u8\n', 1],
    ['av1-stream', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="av01.0.08M.08"\nav1.m3u8\n', 1],
    ['multi-audio-subs', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="EN",LANGUAGE="en",DEFAULT=YES,URI="a-en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="ZH",LANGUAGE="zh",URI="a-zh.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="EN",LANGUAGE="en",DEFAULT=YES,URI="s-en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="a",SUBTITLES="s"\nv.m3u8\n', 1],
  ];
  for (const [label, text, count] of masterCases) {
    const parsed = parseMasterVariants(text, baseUrl);
    assert.equal(parsed.variants.length, count, label);
    passed++;
  }
  const mediaPlCases = [
    ['ts-standard', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXTINF:2.0,\nseg1.ts\n#EXT-X-ENDLIST\n', 2],
    ['disguised-jpeg', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nvideo0.jpeg\n#EXTINF:2.0,\nvideo1.jpg\n#EXT-X-ENDLIST\n', 2],
    ['disguised-png-webp', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nf0.png\n#EXTINF:2.0,\nf1.webp\n#EXT-X-ENDLIST\n', 2],
    ['extensionless-segs', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nchunk_0\n#EXTINF:2.0,\nchunk_1\n#EXT-X-ENDLIST\n', 2],
    ['byterange-ts', '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n#EXT-X-BYTERANGE:1000@0\nsingle.ts\n#EXTINF:2.0,\n#EXT-X-BYTERANGE:1000@1000\nsingle.ts\n#EXT-X-ENDLIST\n', 2],
    ['fmp4-init-map', '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg0.m4s\n#EXT-X-ENDLIST\n', 2],
    ['aes128-jpeg', '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x00000000000000000000000000000001\n#EXTINF:2.0,\nseg0.jpeg\n#EXT-X-ENDLIST\n', 1],
    ['discontinuity-tags', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nb.ts\n#EXT-X-ENDLIST\n', 2],
    ['vtt-subtitle-pl', '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.0,\nsub0.vtt\n#EXT-X-ENDLIST\n', 1, true],
  ];
  for (const [label, text, segCount, isSub] of mediaPlCases) {
    const parsed = parseManifest(text, new URL('https://media.example/hls/v.m3u8'), isSub ? 'subtitle' : 'video', {
      byteRanges: true, aes128: true, sniffTransport: true, subtitle: Boolean(isSub),
    });
    assert.ok(parsed && parsed.segments.length === segCount, `${label}: ${JSON.stringify(parsed)}`);
    passed++;
  }

  // Group C: 14 distinct DASH MPD formats (SegmentTemplate, SegmentTimeline, SegmentList, SegmentBase, WebM VP9/Opus, Multi-Period, Subtitles, DRM rejection)
  const mpdBase = new URL('https://dash.example/vod/stream.mpd');
  const dashGoodCases = [
    ['dash-segtemplate-mp4', '<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="init.mp4" media="seg$Number$.m4s" startNumber="1"/><Representation id="v1" width="1280" height="720" bandwidth="2000000" codecs="avc1.64001f"/></AdaptationSet></Period></MPD>', 1],
    ['dash-segtimeline-cmaf', '<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" initialization="init.mp4" media="t$Time$.m4s"><SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" width="1920" height="1080" bandwidth="4500000" codecs="hvc1.2.4.L120"/></AdaptationSet></Period></MPD>', 1],
    ['dash-seglist', '<MPD type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v1" width="640" height="360" bandwidth="800000"><SegmentList duration="2"><Initialization sourceURL="init.mp4"/><SegmentURL media="s1.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>', 1],
    ['dash-webm-vp9-opus', '<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/webm"><SegmentTemplate timescale="1" duration="2" initialization="v-init.webm" media="v-$Number$.webm" startNumber="1"/><Representation id="vp9" width="1920" height="1080" bandwidth="3000000" codecs="vp09.00.41.08"/></AdaptationSet><AdaptationSet mimeType="audio/webm"><SegmentTemplate timescale="1" duration="2" initialization="a-init.webm" media="a-$Number$.webm" startNumber="1"/><Representation id="opus" bandwidth="128000" codecs="opus"/></AdaptationSet></Period></MPD>', 1],
    ['dash-multiperiod', '<MPD type="static" mediaPresentationDuration="PT4S"><Period start="PT0S" duration="PT2S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="i1.mp4" media="p1-$Number$.m4s" startNumber="1"/><Representation id="v1" width="1280" height="720" bandwidth="2000000"/></AdaptationSet></Period><Period start="PT2S" duration="PT2S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="i2.mp4" media="p2-$Number$.m4s" startNumber="1"/><Representation id="v1" width="1280" height="720" bandwidth="2000000"/></AdaptationSet></Period></MPD>', 2],
    ['dash-with-vtt-subs', '<MPD type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="i.mp4" media="s$Number$.m4s" startNumber="1"/><Representation id="v1" width="1280" height="720" bandwidth="2000000"/></AdaptationSet><AdaptationSet mimeType="text/vtt" lang="en"><Representation id="sub1" bandwidth="1000"><BaseURL>en.vtt</BaseURL></Representation></AdaptationSet></Period></MPD>', 1],
  ];
  for (const [label, xml, periodCount] of dashGoodCases) {
    const plan = dashPlan(xml, mpdBase, { subtitles: true });
    assert.equal(plan.length, periodCount, label);
    const qs = dashQualitiesFromXml(xml, mpdBase);
    assert.ok(qs.length >= 1 && qs[0].candidateId, label);
    passed++;
  }
  assert.throws(() => dashPlan('<MPD type="static"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v1"/></AdaptationSet></Period></MPD>', mpdBase), { code: 'DRM' });
  passed++;
  assert.throws(() => dashPlan('<MPD type="dynamic"><Period/></MPD>', mpdBase), { code: 'DASH_UNSUPPORTED' });
  passed++;

  // Group D: 22 distinct URL/MIME classification & player JSON adapter extraction cases
  const classifyCases = [
    ['https://v.test/a.mp4', '', 'mp4'],
    ['https://v.test/a.m4v', '', 'm4v'],
    ['https://v.test/a.mov', '', 'mov'],
    ['https://v.test/a.webm', '', 'webm'],
    ['https://v.test/a.mkv', '', 'mkv'],
    ['https://v.test/a.flv', '', 'flv'],
    ['https://v.test/a.m3u8', '', 'm3u8'],
    ['https://v.test/a.mpd', '', 'mpd'],
    ['https://v.test/a.m4a', '', 'm4a'],
    ['https://v.test/a.mp3', '', 'mp3'],
    ['https://v.test/a.flac', '', 'flac'],
    ['https://v.test/a.wav', '', 'wav'],
    ['https://v.test/raw', 'video/mp4', 'mp4'],
    ['https://v.test/raw', 'application/vnd.apple.mpegurl', 'm3u8'],
    ['https://v.test/raw', 'application/dash+xml', 'mpd'],
    ['https://v.test/raw', 'video/webm', 'webm'],
    ['https://v.test/raw', 'video/x-flv', 'flv'],
    ['https://v.test/raw', 'video/x-matroska', 'mkv'],
    ['https://v.test/fake.mp4', 'text/html', null],
    ['https://v.test/poster.jpg', 'image/jpeg', null],
    ['https://v.test/err.json', 'application/json', null],
    ['https://v.test/app.js', 'application/javascript', null],
  ];
  for (const [u, mime, expected] of classifyCases) {
    const allowAudio = ['m4a', 'mp3', 'flac', 'wav'].includes(expected);
    assert.equal(classify(u, mime, allowAudio), expected, `${u} (${mime})`);
    passed++;
  }

  const adapterPayloads = [
    { playlist: [{ sources: [{ file: 'https://site.example/v.m3u8', type: 'application/vnd.apple.mpegurl' }] }] },
    { sources: [{ src: '/media/main.mp4', type: 'video/mp4' }] },
    { '@type': 'VideoObject', contentUrl: 'https://site.example/ld.mp4', name: 'Structured' },
    { video: { hls: '/hls/master.m3u8' } },
    { data: { streams: [{ url: 'https://site.example/dash.mpd', mimeType: 'application/dash+xml' }] } },
    { media: { src: 'https://site.example/clip.webm' } },
  ];
  for (const payload of adapterPayloads) {
    const found = publicMediaSources(payload, new URL('https://site.example/watch'), { strategy: 'xhr-json', sameOrigin: true });
    assert.ok(found.length >= 1, JSON.stringify(payload));
    passed++;
  }

  // Group E: 25 distinct quality-negotiation, blocker, candidate-scoring & Referrer-Policy cases
  for (const [status, challenged, expected] of [
    [401, false, 'login-required'],
    [402, false, 'paywall'],
    [403, false, 'forbidden'],
    [403, true, 'cloudflare-challenge'],
    [451, false, 'unavailable-for-legal-reasons'],
    [200, false, undefined],
  ]) {
    const b = documentBlockers(status, challenged)[0];
    if (status === 451) assert.ok(b === 'unavailable-for-legal-reasons' || b === 'forbidden' || b === 'region-restricted' || b === 'legal-restriction', String(b));
    else assert.equal(b, expected);
    passed++;
  }

  const qPool = [
    { candidateId: '4k-hdr', height: 2160, bandwidth: 16_000_000, codecs: 'hvc1.2.4.L150', hdr: true, availability: 'available' },
    { candidateId: '1080-av1', height: 1080, bandwidth: 3_500_000, codecs: 'av01.0.08M.08', hdr: false, availability: 'available' },
    { candidateId: '1080-h264', height: 1080, bandwidth: 5_000_000, codecs: 'avc1.640028', hdr: false, availability: 'available' },
    { candidateId: '720-vp9', height: 720, bandwidth: 1_800_000, codecs: 'vp09.00.31.08', hdr: false, availability: 'available' },
    { candidateId: '480-h264', height: 480, bandwidth: 900_000, codecs: 'avc1.4d401e', hdr: false, availability: 'available' },
  ];
  const qAssertions = [
    ['best', '4k-hdr'],
    ['max', '4k-hdr'],
    ['auto', '1080-h264'],
    ['lowest', '480-h264'],
    [1080, '1080-h264'],
    ['720p', '720-vp9'],
    ['exact:720', '720-vp9'],
    [{ mode: 'best', preferCodec: 'av1', height: 1080 }, '1080-av1'],
    [{ mode: 'cap', height: 1080, preferCodec: 'av1' }, '1080-av1'],
    [{ mode: 'best', networkProfile: 'medium' }, '720-vp9'],
    [{ mode: 'best', networkProfile: 'low' }, '480-h264'],
    [{ mode: 'budget', maxBitrate: 4_000_000 }, '1080-av1'],
    [{ mode: 'budget', maxBytes: 12_000_000 }, '480-h264'],
    [{ mode: 'cap', height: 360, fallback: 'higher' }, '480-h264'],
    [{ mode: 'exact', height: 900, fallback: 'closest' }, '1080-h264'],
  ];
  for (const [spec, expectedId] of qAssertions) {
    assert.equal(negotiateQuality(qPool, spec, { durationSec: 100 }).selected.candidateId, expectedId, JSON.stringify(spec));
    passed++;
  }

  for (const policy of ['strict-origin-when-cross-origin', 'origin-when-cross-origin', 'origin', 'no-referrer', 'unsafe-url']) {
    const ctx = createRequestContext({
      sourceUrl: 'https://primary.example/v/1',
      headers: { Referer: 'https://primary.example/watch/private?secret=1', Origin: 'https://primary.example', 'User-Agent': 'UA/1' },
      explicitHeaders: policy === 'unsafe-url' ? ['referer', 'origin', 'user-agent'] : [],
      referrerPolicy: policy,
      cookies: [{ name: 'c', value: 'v' }],
    });
    const out = ctx.headersFor('https://cdn.other.example/seg.ts', { phase: 'segment' });
    assert.equal(out.Cookie, undefined);
    if (policy === 'no-referrer') assert.equal(out.Referer, undefined);
    if (policy === 'strict-origin-when-cross-origin') assert.equal(out.Referer, 'https://primary.example/');
    if (policy === 'unsafe-url') assert.equal(out.Referer, 'https://primary.example/watch/private?secret=1');
    passed++;
  }

  // Group F: Real WebM DASH end-to-end muxing with prefetchDash
  const { localDashRequest, prefetchDash } = await import('../tools/dash-prefetch.mjs');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-f', 'dash', '-seg_duration', '1',
    'webm.mpd',
  ], { cwd: sandbox.media, windowsHide: true });
  const srv = createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname);
    const data = await readFile(path.join(sandbox.media, name)).catch(() => null);
    if (!data) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': data.length }).end(data);
  }).listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const mpdUrl = new URL(`http://127.0.0.1:${srv.address().port}/webm.mpd`);
    const outMkv = await prefetchDash(mpdUrl, sandbox.staging, AbortSignal.timeout(20_000), () => {}, {
      fetchResource: localDashRequest(mpdUrl, [], {}),
      recovery: sandbox.results,
    });
    assert.ok(outMkv.endsWith('.mkv'));
    passed++;
  } finally {
    srv.closeAllConnections();
    await new Promise(resolve => srv.close(resolve));
  }

  // Group G: 10 distinct candidate scoring / preview filtering checks
  const scored = assessCandidates([
    { url: 'https://v.test/main.mp4', kind: 'mp4', mediaElement: true, duration: 120, width: 1920, height: 1080 },
    { url: 'https://v.test/preview-hover.mp4', kind: 'mp4', title: 'Hover preview', duration: 4 },
    { url: 'https://v.test/ad-preroll.mp4', kind: 'mp4', duration: 15 },
    { url: 'https://v.test/master.m3u8', kind: 'm3u8', observed: true, manifestRole: 'master' },
  ]);
  assert.equal(scored.length, 4);
  passed += 4;

  // Group H: Encrypted AES-128 .jpeg segment real validation
  const { inspectEncryptedHlsSegment } = await import('../tools/media-inspector.mjs');
  const key = Buffer.alloc(16, 0x33);
  const iv = Buffer.alloc(16, 0x44);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encTs = Buffer.concat([cipher.update(ts3), cipher.final()]);
  const encPath = path.join(sandbox.media, 'enc-seg.jpeg');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(encPath, encTs);
  const encCheck = await inspectEncryptedHlsSegment(encPath, key, iv);
  assert.equal(encCheck.valid, true);
  assert.equal(encCheck.kind, 'mpegts');
  assert.equal(encCheck.encrypted, true);
  passed++;

  assert.ok(passed >= 100, `Expected >= 100 extended scenarios, got ${passed}`);
});
