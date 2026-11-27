import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequestContext } from '../tools/request-context.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

test('request context preserves explicit headers across all phases and strictly isolates cross-origin cookies', () => {
  const ctx = createRequestContext({
    sourceUrl: 'https://primary.example/media/master.m3u8?token=abc',
    headers: {
      Referer: 'https://primary.example/watch/123',
      Origin: 'https://primary.example',
      'User-Agent': 'VideoSave-Context-Test/1.0',
    },
    cookies: [{ name: 'sid', value: 'secret-session', domain: 'primary.example', path: '/', secure: true }],
  });

  const sameOriginHeaders = ctx.headersFor('https://primary.example/media/seg0.ts', { phase: 'segment' });
  assert.equal(sameOriginHeaders.Referer, 'https://primary.example/watch/123');
  assert.equal(sameOriginHeaders.Origin, 'https://primary.example');
  assert.equal(sameOriginHeaders['User-Agent'], 'VideoSave-Context-Test/1.0');
  assert.equal(sameOriginHeaders.Cookie, 'sid=secret-session');

  const crossOriginHeaders = ctx.headersFor('https://cdn.thirdparty.example/chunks/seg0.ts', { phase: 'segment' });
  assert.equal(crossOriginHeaders.Referer, 'https://primary.example/watch/123');
  assert.equal(crossOriginHeaders.Origin, 'https://primary.example');
  assert.equal(crossOriginHeaders['User-Agent'], 'VideoSave-Context-Test/1.0');
  assert.equal(crossOriginHeaders.Cookie, undefined, 'Cookies must NEVER be forwarded cross-origin');
  assert.equal(crossOriginHeaders.Authorization, undefined);

  const crossOriginKey = ctx.headersFor('https://keys.thirdparty.example/aes.key', { phase: 'key' });
  assert.equal(crossOriginKey.Referer, 'https://primary.example/watch/123');
  assert.equal(crossOriginKey['User-Agent'], 'VideoSave-Context-Test/1.0');
  assert.equal(crossOriginKey.Cookie, undefined, 'Cookies must NEVER leak to cross-origin key servers');

  const rangeHeaders = ctx.headersFor('https://cdn.thirdparty.example/movie.mp4', {
    phase: 'byte-range',
    range: { start: 0, end: 1023 },
    extra: { 'If-Range': '"etag-1"' },
  });
  assert.equal(rangeHeaders.Range, 'bytes=0-1023');
  assert.equal(rangeHeaders['If-Range'], '"etag-1"');
  assert.equal(rangeHeaders.Cookie, undefined);

  const ffArgs = ctx.ffmpegInputArgs('https://primary.example/media/master.m3u8');
  assert.ok(ffArgs.includes('-user_agent'));
  assert.ok(ffArgs.includes('VideoSave-Context-Test/1.0'));
  const headersIdx = ffArgs.indexOf('-headers');
  assert.ok(headersIdx >= 0);
  assert.match(ffArgs[headersIdx + 1], /Referer: https:\/\/primary\.example\/watch\/123/);
  assert.match(ffArgs[headersIdx + 1], /Origin: https:\/\/primary\.example/);
  const cookiesIdx = ffArgs.indexOf('-cookies');
  assert.ok(cookiesIdx >= 0);
  assert.match(ffArgs[cookiesIdx + 1], /sid=secret-session; path=\/; domain=primary\.example;/);

  const crossFfArgs = ctx.ffmpegInputArgs('https://cdn.thirdparty.example/media/master.m3u8');
  assert.equal(crossFfArgs.indexOf('-cookies'), -1);
});

test('HLS lifecycle propagates Referer/Origin/User-Agent consistently across all stages while isolating cross-origin cookies', { timeout: 45_000 }, async t => {
  const sandbox = await createTestSandbox('hls-request-context');
  const restoreEnv = sandbox.applyProcessEnv();
  const { queue, waitForBatch } = await import('../tools/media-downloads.mjs');

  const reqHeaders = {
    Referer: 'https://authorized.example/player/42',
    Origin: 'https://authorized.example',
    'User-Agent': 'VideoSave-HeaderAudit/1.0',
  };
  const cookieHeader = 'session=top-secret-primary-cookie';

  // Generate real HLS fixtures: fMP4 video+audio, separate audio, subtitles, and AES-128 encrypted TS
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'plain.m3u8'),
  ], { windowsHide: true });

  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000',
    '-map', '0:v', '-map', '1:a',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes,language:eng',
    '-master_pl_name', 'ext-master.m3u8',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'ext-%v.m3u8'),
  ], { windowsHide: true });

  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-i', path.join(sandbox.media, 'plain.m3u8'),
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-hls_flags', 'single_file', '-hls_segment_type', 'fmp4',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'byterange.m3u8'),
  ], { windowsHide: true });

  const aesKey = Buffer.alloc(16, 0x5a);
  const aesIv = Buffer.alloc(16, 0x11);
  const tsParts = await Promise.all([0, 1, 2].map(i => readFile(path.join(sandbox.media, `plain${i}.ts`))));
  const encParts = tsParts.map(buf => {
    const cipher = createCipheriv('aes-128-cbc', aesKey, aesIv);
    return Buffer.concat([cipher.update(buf), cipher.final()]);
  });

  const primaryLog = [];
  const cdnLog = [];
  let retryOnce = true;
  let denyPath = null;
  let rotatingCount = 0;

  const checkRequiredHeaders = req =>
    req.headers.referer === reqHeaders.Referer &&
    req.headers.origin === reqHeaders.Origin &&
    req.headers['user-agent'] === reqHeaders['User-Agent'];

  const cdnServer = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    cdnLog.push({
      pathname,
      referer: req.headers.referer,
      origin: req.headers.origin,
      ua: req.headers['user-agent'],
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      range: req.headers.range,
    });
    if (!checkRequiredHeaders(req)) return res.writeHead(403).end();
    if (pathname === denyPath) return res.writeHead(403).end();
    if (pathname === '/aes.key') return res.writeHead(200).end(aesKey);
    if (pathname === '/enc-1.ts' && retryOnce) {
      retryOnce = false;
      return res.writeHead(503).end();
    }
    const encMatch = /^\/enc-(\d+)\.ts$/.exec(pathname);
    if (encMatch) return res.writeHead(200, { 'content-type': 'video/mp2t' }).end(encParts[Number(encMatch[1])]);
    if (pathname === '/byterange.m4s') {
      const bytes = await readFile(path.join(sandbox.media, 'byterange.m4s'));
      const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!r) return res.writeHead(200).end(bytes);
      const start = Number(r[1]), end = Number(r[2]);
      return res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'content-length': end - start + 1,
      }).end(bytes.subarray(start, end + 1));
    }
    const file = path.join(sandbox.media, path.basename(pathname));
    const data = await readFile(file).catch(() => null);
    if (!data) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': data.length }).end(data);
  }).listen(0, '127.0.0.1');

  await once(cdnServer, 'listening');
  const cdnBase = `http://127.0.0.1:${cdnServer.address().port}`;

  const primaryServer = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    primaryLog.push({
      pathname,
      referer: req.headers.referer,
      origin: req.headers.origin,
      ua: req.headers['user-agent'],
      cookie: req.headers.cookie,
    });
    if (pathname === '/watch/refresh-page') {
      rotatingCount++;
      return res.writeHead(200, { 'content-type': 'text/html' })
        .end('<title>Refreshable</title><video controls preload="none" src="/fresh.m3u8"></video>');
    }
    if (!checkRequiredHeaders(req)) return res.writeHead(403).end();
    if (pathname === denyPath) return res.writeHead(403).end();
    if (pathname === '/cross-master.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="/subs.m3u8"\n` +
        `#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,SUBTITLES="subs"\n/cross-media.m3u8\n`,
      );
    }
    if (pathname === '/cross-media.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end([
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0',
        `#EXT-X-KEY:METHOD=AES-128,URI="${cdnBase}/aes.key",IV=0x${aesIv.toString('hex')}`,
        '#EXTINF:1.0,', `${cdnBase}/enc-0.ts`,
        '#EXTINF:1.0,', `${cdnBase}/enc-1.ts`,
        '#EXTINF:1.0,', `${cdnBase}/enc-2.ts`,
        '#EXT-X-ENDLIST',
      ].join('\n'));
    }
    if (pathname === '/subs.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3.0,\n/subs-0.vtt\n#EXT-X-ENDLIST\n',
      );
    }
    if (pathname === '/subs-0.vtt') {
      return res.writeHead(200, { 'content-type': 'text/vtt' }).end(
        'WEBVTT\n\n00:00.100 --> 00:02.500\nAuthorized subtitle track\n',
      );
    }
    if (pathname === '/ext-master.m3u8') {
      const text = await readFile(path.join(sandbox.media, 'ext-master.m3u8'), 'utf8');
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(text);
    }
    if (pathname === '/byterange-cdn.m3u8') {
      const text = (await readFile(path.join(sandbox.media, 'byterange.m3u8'), 'utf8'))
        .replaceAll('byterange.m4s', `${cdnBase}/byterange.m4s`);
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(text);
    }
    if (pathname === '/expired.m3u8') return res.writeHead(410).end();
    if (pathname === '/fresh.m3u8') {
      return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        .end(await readFile(path.join(sandbox.media, 'plain.m3u8'), 'utf8'));
    }
    const file = path.join(sandbox.media, path.basename(pathname));
    const data = await readFile(file).catch(() => null);
    if (!data) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': data.length }).end(data);
  }).listen(0, '127.0.0.1');

  await once(primaryServer, 'listening');
  const primaryBase = `http://127.0.0.1:${primaryServer.address().port}`;

  t.after(async () => {
    primaryServer.closeAllConnections();
    cdnServer.closeAllConnections();
    await Promise.all([
      new Promise(resolve => primaryServer.close(resolve)),
      new Promise(resolve => cdnServer.close(resolve)),
    ]);
    restoreEnv();
    await sandbox.cleanup();
  });

  // 1. Cross-origin encrypted HLS + retry + subtitles + cookie isolation
  const b1 = queue({
    items: [{ kind: 'stream', url: `${primaryBase}/cross-master.m3u8`, title: 'CrossOriginEnc', subtitles: true, format: 'mkv' }],
    headers: reqHeaders,
    cookie: cookieHeader,
    connections: 4,
  });
  const r1 = await waitForBatch({ id: b1.id, timeoutMs: 20_000 });
  assert.equal(r1.status, 'done', JSON.stringify(r1));
  assert.equal(r1.items[0].prefetch, true);
  assert.ok(r1.items[0].subtitleTracks >= 1, 'Expected HLS subtitle track to be preserved');

  // Verify every primary request received headers + same-origin cookie
  assert.ok(primaryLog.some(e => e.pathname === '/cross-master.m3u8'));
  assert.ok(primaryLog.some(e => e.pathname === '/cross-media.m3u8'));
  assert.ok(primaryLog.some(e => e.pathname === '/subs.m3u8'));
  assert.ok(primaryLog.some(e => e.pathname === '/subs-0.vtt'));
  for (const entry of primaryLog) {
    assert.equal(entry.referer, reqHeaders.Referer);
    assert.equal(entry.origin, reqHeaders.Origin);
    assert.equal(entry.ua, reqHeaders['User-Agent']);
    assert.equal(entry.cookie, cookieHeader, `Primary request ${entry.pathname} must include same-origin cookie`);
  }
  // Verify every cross-origin CDN request received Referer/Origin/UA (including retry of enc-1.ts and aes.key) AND ZERO cookies!
  assert.ok(cdnLog.some(e => e.pathname === '/aes.key'));
  assert.equal(cdnLog.filter(e => e.pathname === '/enc-1.ts').length, 2, 'Expected transient 503 retry');
  for (const entry of cdnLog) {
    assert.equal(entry.referer, reqHeaders.Referer);
    assert.equal(entry.origin, reqHeaders.Origin);
    assert.equal(entry.ua, reqHeaders['User-Agent']);
    assert.equal(entry.cookie, undefined, `Cross-origin request ${entry.pathname} MUST NOT receive cookies`);
    assert.equal(entry.authorization, undefined);
  }

  // 2. External audio track HLS
  primaryLog.length = 0;
  const b2 = queue({
    items: [{ kind: 'stream', url: `${primaryBase}/ext-master.m3u8`, title: 'ExtAudio' }],
    headers: reqHeaders,
    cookie: cookieHeader,
  });
  const r2 = await waitForBatch({ id: b2.id, timeoutMs: 15_000 });
  assert.equal(r2.status, 'done', JSON.stringify(r2));
  assert.ok(primaryLog.some(e => e.pathname === '/ext-0.m3u8'));
  assert.ok(primaryLog.some(e => e.pathname === '/ext-1.m3u8'));
  assert.ok(primaryLog.every(e => e.referer === reqHeaders.Referer && e.ua === reqHeaders['User-Agent'] && e.cookie === cookieHeader));

  // 3. Cross-origin fMP4 Byte-Range HLS (init + media ranges)
  cdnLog.length = 0;
  const b3 = queue({
    items: [{ kind: 'stream', url: `${primaryBase}/byterange-cdn.m3u8`, title: 'CrossByteRange' }],
    headers: reqHeaders,
    cookie: cookieHeader,
  });
  const r3 = await waitForBatch({ id: b3.id, timeoutMs: 15_000 });
  assert.equal(r3.status, 'done', JSON.stringify(r3));
  assert.ok(cdnLog.length >= 3);
  assert.ok(cdnLog.every(e => e.referer === reqHeaders.Referer && e.origin === reqHeaders.Origin && e.ua === reqHeaders['User-Agent'] && e.cookie === undefined));

  // 4. FFmpeg fallback path (prefetch: false) still sends Referer, Origin, User-Agent, same-origin Cookie
  primaryLog.length = 0;
  const b4 = queue({
    items: [{ kind: 'stream', url: `${primaryBase}/fresh.m3u8`, title: 'FfmpegFallback' }],
    headers: reqHeaders,
    cookie: cookieHeader,
    prefetch: false,
  });
  const r4 = await waitForBatch({ id: b4.id, timeoutMs: 15_000 });
  assert.equal(r4.status, 'done', JSON.stringify(r4));
  assert.equal(r4.items[0].prefetch, false);
  assert.ok(primaryLog.some(e => e.pathname === '/fresh.m3u8'));
  assert.ok(primaryLog.some(e => e.pathname === '/plain0.ts'));
  assert.ok(primaryLog.every(e => e.referer === reqHeaders.Referer && e.origin === reqHeaders.Origin && e.ua === reqHeaders['User-Agent'] && e.cookie === cookieHeader));

  // 5. Authorized refresh path preserves headers & same-origin cookies
  primaryLog.length = 0;
  const b5 = queue({
    items: [{ kind: 'stream', url: `${primaryBase}/expired.m3u8`, title: 'RefreshedHeaders' }],
    headers: reqHeaders,
    cookie: cookieHeader,
    refresh: { pageUrl: `${primaryBase}/watch/refresh-page` },
  });
  const r5 = await waitForBatch({ id: b5.id, timeoutMs: 20_000 });
  assert.equal(r5.status, 'done', JSON.stringify(r5));
  assert.equal(rotatingCount, 1);
  const freshRequests = primaryLog.filter(e => e.pathname === '/fresh.m3u8' || e.pathname.endsWith('.ts'));
  assert.ok(freshRequests.length >= 4);
  assert.ok(freshRequests.every(e => e.referer === reqHeaders.Referer && e.ua === reqHeaders['User-Agent'] && e.cookie === cookieHeader));

  // 6. Accurate 403 phase reporting WITHOUT identity/engine bypass
  for (const [targetPath, denied, expectedPhase] of [
    ['/cross-master.m3u8?d=1', '/cross-master.m3u8', 'playlist'],
    ['/cross-master.m3u8?d=2', '/cross-media.m3u8', 'playlist'],
    ['/cross-master.m3u8?d=3', '/aes.key', 'key'],
    ['/cross-master.m3u8?d=4', '/enc-2.ts', 'segment'],
  ]) {
    denyPath = denied;
    primaryLog.length = 0;
    cdnLog.length = 0;
    const bd = queue({
      items: [{ kind: 'stream', url: `${primaryBase}${targetPath}`, title: 'Deny-' + expectedPhase }],
      headers: reqHeaders,
      cookie: cookieHeader,
    });
    const rd = await waitForBatch({ id: bd.id, timeoutMs: 15_000 });
    assert.equal(rd.items[0].status, 'error');
    assert.equal(rd.items[0].errorCode, 'MEDIA_ACCESS_RESTRICTED');
    assert.equal(rd.items[0].detail.status, 403);
    assert.equal(rd.items[0].detail.hlsPhase, expectedPhase, `Expected phase ${expectedPhase}, got ${JSON.stringify(rd.items[0].detail)}`);
    assert.equal(rd.items[0].prefetchFallback, undefined, '403 must never trigger fallback to another engine');
  }
  denyPath = null;

  // Verify decoded FFprobe integrity of the cross-origin encrypted + subtitled output
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-of', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', r1.items[0].file,
  ], { encoding: 'utf8', windowsHide: true }));
  const types = probe.streams.map(s => s.codec_type);
  assert.ok(types.includes('video') && types.includes('audio') && types.includes('subtitle'), JSON.stringify(probe));
  assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.25);
});
