import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { inspectEncryptedHlsSegment, inspectMediaBuffer, inspectMediaFile } from '../tools/media-inspector.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';

test('media inspector accurately identifies valid media structures and rejects images, HTML, JSON, XML, corrupt, and DRM payloads', async t => {
  const sandbox = await createTestSandbox('media-inspector-unit');
  t.after(() => sandbox.cleanup());

  // Real PNG, JPEG, GIF, WebP
  const pngFile = path.join(sandbox.media, 'real.png');
  const jpgFile = path.join(sandbox.media, 'real.jpg');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=1', '-frames:v', '1', pngFile], { windowsHide: true });
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=1', '-frames:v', '1', jpgFile], { windowsHide: true });

  const pngCheck = await inspectMediaFile(pngFile, { expected: 'segment' });
  assert.equal(pngCheck.valid, false);
  assert.equal(pngCheck.kind, 'image-png');
  assert.equal(pngCheck.reason, 'image-payload');

  const jpgCheck = await inspectMediaFile(jpgFile, { expected: 'segment' });
  assert.equal(jpgCheck.valid, false);
  assert.equal(jpgCheck.kind, 'image-jpeg');

  const gifCheck = inspectMediaBuffer(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'));
  assert.equal(gifCheck.valid, false);
  assert.equal(gifCheck.kind, 'image-gif');

  const webpCheck = inspectMediaBuffer(Buffer.from('RIFF\x18\x00\x00\x00WEBPVP8 \x0c\x00\x00\x00', 'binary'));
  assert.equal(webpCheck.valid, false);
  assert.equal(webpCheck.kind, 'image-webp');

  const htmlCheck = inspectMediaBuffer(Buffer.from('<!doctype html><html><title>403 Forbidden</title></html>'));
  assert.equal(htmlCheck.valid, false);
  assert.equal(htmlCheck.kind, 'html');

  const jsonCheck = inspectMediaBuffer(Buffer.from('{"error":"access_denied","code":403}'));
  assert.equal(jsonCheck.valid, false);
  assert.equal(jsonCheck.kind, 'json');

  const xmlCheck = inspectMediaBuffer(Buffer.from('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'));
  assert.equal(xmlCheck.valid, false);
  assert.equal(xmlCheck.kind, 'xml');

  const emptyCheck = inspectMediaBuffer(Buffer.alloc(0));
  assert.equal(emptyCheck.valid, false);
  assert.equal(emptyCheck.reason, 'empty-payload');

  const corruptCheck = inspectMediaBuffer(Buffer.alloc(1024, 0x00));
  assert.equal(corruptCheck.valid, false);

  // DRM ISOBMFF box (pssh)
  const drmBuf = Buffer.from([0, 0, 0, 8, 0x70, 0x73, 0x73, 0x68]);
  const drmCheck = inspectMediaBuffer(drmBuf);
  assert.equal(drmCheck.valid, false);
  assert.equal(drmCheck.errorCode, 'DRM');

  // WebVTT subtitle
  const vttCheck = inspectMediaBuffer(Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n'), { expected: 'subtitle' });
  assert.equal(vttCheck.valid, true);
  assert.equal(vttCheck.kind, 'webvtt');

  // Valid 1-packet MPEG-TS (188 bytes)
  const singlePacket = Buffer.alloc(188, 0xff);
  singlePacket[0] = 0x47;
  singlePacket[3] = 0x10;
  const singleTs = inspectMediaBuffer(singlePacket, { expected: 'segment' });
  assert.equal(singleTs.valid, true);
  assert.equal(singleTs.kind, 'mpegts');

  // Valid ID3v2-prefixed MPEG-TS
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // 10-byte empty ID3v2
  const id3Ts = inspectMediaBuffer(Buffer.concat([id3Header, singlePacket, singlePacket]), { expected: 'segment' });
  assert.equal(id3Ts.valid, true);
  assert.equal(id3Ts.hasId3Prefix, true);

  // Valid custom-prefixed MPEG-TS (24-byte custom wrapper + 6 valid TS packets)
  const customPrefix = Buffer.from('CUSTOM-WRAPPER-HEADER-01');
  const multiTs = Buffer.concat(Array.from({ length: 6 }, () => singlePacket));
  const customWrapped = inspectMediaBuffer(Buffer.concat([customPrefix, multiTs]), { expected: 'segment' });
  assert.equal(customWrapped.valid, true);
  assert.equal(customWrapped.needsStrip, true);
  assert.equal(customWrapped.syncOffset, customPrefix.length);

  // AES-128 encrypted TS verification
  const key = Buffer.alloc(16, 0x33);
  const iv = Buffer.alloc(16, 0x44);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encFile = path.join(sandbox.media, 'enc.jpeg');
  await writeFile(encFile, Buffer.concat([cipher.update(multiTs), cipher.final()]));
  const encOk = await inspectEncryptedHlsSegment(encFile, key, iv, { expected: 'segment' });
  assert.equal(encOk.valid, true);
  assert.equal(encOk.kind, 'mpegts');

  // Encrypted HTML masquerading as encrypted segment must fail!
  const htmlCipher = createCipheriv('aes-128-cbc', key, iv);
  const encHtmlFile = path.join(sandbox.media, 'enc-html.png');
  await writeFile(encHtmlFile, Buffer.concat([htmlCipher.update(Buffer.from('<!doctype html><html>Error</html>')), htmlCipher.final()]));
  const encBad = await inspectEncryptedHlsSegment(encHtmlFile, key, iv, { expected: 'segment' });
  assert.equal(encBad.valid, false);
  assert.equal(encBad.kind, 'html');
});

test('end-to-end downloads handle .jpeg/.jpg/.png/extensionless TS, fMP4, custom-wrapped TS, and encrypted segments while rejecting fake images/HTML/JSON', { timeout: 45_000 }, async t => {
  const sandbox = await createTestSandbox('media-inspector-e2e');
  const restoreEnv = sandbox.applyProcessEnv();
  const { queue, waitForBatch } = await import('../tools/media-downloads.mjs');

  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac',
    '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'ts.m3u8'),
  ], { windowsHide: true });

  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-i', path.join(sandbox.media, 'ts.m3u8'),
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-hls_segment_type', 'fmp4', '-hls_time', '1', '-hls_list_size', '0',
    path.join(sandbox.media, 'fmp4.m3u8'),
  ], { cwd: sandbox.media, windowsHide: true });

  const realPng = path.join(sandbox.media, 'fake.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=1', '-frames:v', '1', realPng], { windowsHide: true });
  const pngBytes = await readFile(realPng);

  const tsSegments = await Promise.all([0, 1, 2].map(i => readFile(path.join(sandbox.media, `ts${i}.ts`))));
  const fmp4Init = await readFile(path.join(sandbox.media, 'init.mp4'));
  const fmp4Parts = await Promise.all([0, 1, 2].map(i => readFile(path.join(sandbox.media, `fmp4${i}.m4s`))));

  const customPrefix = Buffer.from([0x89, 0x00, 0x01, 0x02, 0x56, 0x53, 0x57, 0x52, 0x00, 0x00, 0x00, 0x10]);
  const key = Buffer.alloc(16, 0x77);
  const iv = Buffer.alloc(16, 0x88);
  const encSegments = tsSegments.map(buf => {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(buf), cipher.final()]);
  });

  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/ts-disguised.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\npart0.jpeg\n#EXTINF:1,\npart1.jpg\n#EXTINF:1,\npart2\n#EXT-X-ENDLIST\n');
    }
    if (p === '/part0.jpeg') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(tsSegments[0]);
    if (p === '/part1.jpg') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tsSegments[1]);
    if (p === '/part2') return res.writeHead(200, { 'content-type': 'text/plain' }).end(tsSegments[2]);

    if (p === '/fmp4-disguised.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="header.png"\n#EXTINF:1,\nchunk0.jpeg\n#EXTINF:1,\nchunk1.png\n#EXTINF:1,\nchunk2\n#EXT-X-ENDLIST\n');
    }
    if (p === '/header.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(fmp4Init);
    if (p === '/chunk0.jpeg') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(fmp4Parts[0]);
    if (p === '/chunk1.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(fmp4Parts[1]);
    if (p === '/chunk2') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fmp4Parts[2]);

    if (p === '/wrapped-ts.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nwrap0.png\n#EXTINF:1,\nwrap1.png\n#EXTINF:1,\nwrap2.png\n#EXT-X-ENDLIST\n');
    }
    if (/^\/wrap([0-2])\.png$/.test(p)) {
      const i = Number(p[5]);
      return res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.concat([customPrefix, tsSegments[i]]));
    }

    if (p === '/enc-disguised.m3u8') {
      return res.end(
        `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="/k.bin",IV=0x${iv.toString('hex')}\n` +
        '#EXTINF:1,\nenc0.png\n#EXTINF:1,\nenc1.jpeg\n#EXTINF:1,\nenc2\n#EXT-X-ENDLIST\n',
      );
    }
    if (p === '/k.bin') return res.writeHead(200).end(key);
    if (p === '/enc0.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(encSegments[0]);
    if (p === '/enc1.jpeg') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(encSegments[1]);
    if (p === '/enc2') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(encSegments[2]);

    if (p === '/bad-png.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nreal.png\n#EXT-X-ENDLIST\n');
    if (p === '/real.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(pngBytes);

    if (p === '/bad-html.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nerr.jpeg\n#EXT-X-ENDLIST\n');
    if (p === '/err.jpeg') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body>Forbidden</body></html>');

    if (p === '/bad-json.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nerr.bin\n#EXT-X-ENDLIST\n');
    if (p === '/err.bin') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"error":"expired"}');

    if (p === '/bad-enc.m3u8') {
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="/k.bin",IV=0x${iv.toString('hex')}\n#EXTINF:1,\nreal.png\n#EXT-X-ENDLIST\n`);
    }
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');

  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    restoreEnv();
    await sandbox.cleanup();
  });

  const streamHash = file => execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v', '-map', '0:a', '-f', 'streamhash', '-'],
    { encoding: 'utf8', windowsHide: true });
  const refHash = streamHash(path.join(sandbox.media, 'ts.m3u8'));

  for (const [playlist, title] of [
    ['/ts-disguised.m3u8', 'TSDisguised'],
    ['/fmp4-disguised.m3u8', 'Fmp4Disguised'],
    ['/wrapped-ts.m3u8', 'WrappedTS'],
    ['/enc-disguised.m3u8', 'EncDisguised'],
  ]) {
    const b = queue({ items: [{ kind: 'stream', sourceKind: 'm3u8', url: base + playlist, title }] });
    const res = await waitForBatch({ id: b.id, timeoutMs: 15_000 });
    assert.equal(res.status, 'done', `${title} failed: ${JSON.stringify(res)}`);
    assert.equal(res.items[0].prefetch, true);
    const info = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-of', 'json', '-show_entries', 'format=duration:stream=codec_type,width,height', res.items[0].file,
    ], { encoding: 'utf8', windowsHide: true }));
    assert.ok(info.streams.some(s => s.codec_type === 'video' && s.width === 160 && s.height === 90), JSON.stringify(info));
    assert.ok(info.streams.some(s => s.codec_type === 'audio'), JSON.stringify(info));
    assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.25);
    assert.equal(streamHash(res.items[0].file), refHash, `${title} decoded streamhash mismatch`);
  }

  for (const [playlist, title] of [
    ['/bad-png.m3u8', 'RejectPNG'],
    ['/bad-html.m3u8', 'RejectHTML'],
    ['/bad-json.m3u8', 'RejectJSON'],
    ['/bad-enc.m3u8', 'RejectFakeEnc'],
  ]) {
    const b = queue({ items: [{ kind: 'stream', sourceKind: 'm3u8', url: base + playlist, title }] });
    const res = await waitForBatch({ id: b.id, timeoutMs: 15_000 });
    assert.equal(res.items[0].status, 'error', `${title} should have been rejected`);
    assert.equal(res.items[0].errorCode, 'INVALID_HLS_SEGMENT', `${title}: ${JSON.stringify(res.items[0])}`);
  }
});
