import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { createTestSandbox } from './test-sandbox.mjs';

const run = promisify(execFile);

test('downloads a contiguous shared fMP4 in bounded ranges', async t => {
  const {prefetchHls} = await import('../tools/hls-prefetch.mjs');
  const sandbox = await createTestSandbox('hls-shared');
  const folder = sandbox.staging;
  const MiB = 1024 * 1024;
  const video = Buffer.alloc(21 * MiB);
  for (let start = 0; start < video.length; start += MiB) video.fill(start / MiB, start, start + MiB);
  const requested = [];
  const map = '#EXT-X-MAP:URI="movie.mp4",BYTERANGE="1048576@0"';
  const entries = Array.from({length:20}, () => '#EXTINF:1,\n#EXT-X-BYTERANGE:1048576\nmovie.mp4');
  entries[0] = entries[0].replace('1048576\n', '1048576@1048576\n');
  const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', map, ...entries, '#EXT-X-ENDLIST'].join('\n');
  const server = createServer((req, res) => {
    if (req.url === '/video.m3u8') return res.end(playlist);
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!range) return res.writeHead(400).end();
    const [,start,end] = range.map(Number);
    requested.push([start,end]);
    const bytes = video.subarray(start,end + 1);
    res.writeHead(206, {'content-range':`bytes ${start}-${end}/${video.length}`,
      'content-length':bytes.length,etag:'"movie"'}).end(bytes);
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });
  await once(server, 'listening');
  const source = new URL(`http://127.0.0.1:${server.address().port}/video.m3u8`);
  const staged = await prefetchHls(source, [], folder, AbortSignal.timeout(6000), () => {}, {connections:4});
  assert.ok(staged);
  assert.deepEqual(requested[0], [0,0]);
  const slices = requested.slice(1).sort(([start], [other]) => start - other);
  assert.equal(slices.length, 6);
  let offset = 0;
  for (const [start,end] of slices) {
    assert.equal(start, offset);
    assert.ok(end - start + 1 <= 4 * MiB);
    offset = end + 1;
  }
  assert.equal(offset,video.length);
  assert.deepEqual(await readFile(staged), video);
});

test('uses a spare connection for a slow final HLS segment', async t => {
  const {prefetchHls} = await import('../tools/hls-prefetch.mjs');
  const sandbox = await createTestSandbox('hls-tail-1');
  const folder = sandbox.staging;
  const firstPart = Buffer.from('first segment');
  const lastPart = Buffer.from('slowly delivered final segment');
  let firstRequests = 0;
  let lastRequests = 0;
  let slowClosed = false;
  const server = createServer((req, res) => {
    if (req.url === '/video.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.ts\n#EXTINF:1,\nlast.ts\n#EXT-X-ENDLIST\n');
    }
    if (req.url === '/first.ts') {
      firstRequests++;
      return res.end(firstPart);
    }
    if (++lastRequests === 1) {
      res.writeHead(200, {'content-length':lastPart.length});
      res.write(lastPart.subarray(0, 1));
      let offset = 1;
      const timer = setInterval(() => {
        res.write(lastPart.subarray(offset, ++offset));
        if (offset === lastPart.length) res.end();
      }, 350);
      res.once('close', () => {
        clearInterval(timer);
        slowClosed = true;
      });
      return;
    }
    res.end(lastPart);
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });
  await once(server, 'listening');
  const source = new URL(`http://127.0.0.1:${server.address().port}/video.m3u8`);
  let received;
  const signal = AbortSignal.timeout(6000);
  const manifest = await prefetchHls(source, [], folder, signal, (fraction, bytes) => { received = bytes; }, {connections:2});
  assert.ok(manifest);
  const directory = path.dirname(manifest);
  assert.deepEqual(await readFile(path.join(directory, 'video-1.ts')), lastPart);
  assert.deepEqual((await readdir(directory)).filter(name => !name.endsWith('.sha256')).sort(), ['download.m3u8', 'video-0.ts', 'video-1.ts']);
  assert.equal(firstRequests, 1);
  assert.equal(lastRequests, 2);
  assert.equal(received, firstPart.length + lastPart.length);
  assert.ok(slowClosed, 'the slower response was still open');
});

test('uses a spare connection while two HLS segments are stalled at the end', async t => {
  const {prefetchHls} = await import('../tools/hls-prefetch.mjs');
  const sandbox = await createTestSandbox('hls-tail-2');
  const folder = sandbox.staging;
  const requests = new Map();
  const closed = [];
  let activeBackups = 0;
  let peakBackups = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/video.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.ts\n#EXTINF:1,\nsecond.ts\n#EXTINF:1,\nthird.ts\n#EXT-X-ENDLIST\n');
    }
    const count = (requests.get(req.url) || 0) + 1;
    requests.set(req.url, count);
    const bytes = Buffer.from(req.url);
    if (req.url === '/first.ts') return res.end(bytes);
    res.writeHead(200, {'content-length':bytes.length});
    if (count === 1) {
      res.once('close', () => closed.push(req.url));
      return res.write(bytes.subarray(0, 3));
    }
    peakBackups = Math.max(peakBackups, ++activeBackups);
    await sleep(100);
    activeBackups--;
    res.end(bytes);
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });
  await once(server, 'listening');
  const source = new URL(`http://127.0.0.1:${server.address().port}/video.m3u8`);
  const staged = await prefetchHls(source, [], folder, AbortSignal.timeout(6000), () => {}, {connections:3});
  assert.ok(staged);
  assert.equal(peakBackups, 1);
  assert.equal(requests.get('/first.ts'), 1);
  assert.equal(requests.get('/second.ts'), 2);
  assert.equal(requests.get('/third.ts'), 2);
  const directory = path.dirname(staged);
  assert.equal(await readFile(path.join(directory, 'video-1.ts'), 'utf8'), '/second.ts');
  assert.equal(await readFile(path.join(directory, 'video-2.ts'), 'utf8'), '/third.ts');
  assert.deepEqual(closed.sort(), ['/second.ts', '/third.ts']);
  assert.deepEqual((await readdir(directory)).filter(name => !name.endsWith('.sha256')).sort(), ['download.m3u8', 'video-0.ts', 'video-1.ts', 'video-2.ts']);
});

test('recovers when every HLS worker is occupied by slow responses with more work queued', async t => {
  const {prefetchHls} = await import('../tools/hls-prefetch.mjs');
  const sandbox = await createTestSandbox('hls-backlog');
  const folder = sandbox.staging;
  const parts = Array.from({length:8}, (_, index) => `part-${index}.ts`);
  const requests = new Map();
  const media = Buffer.alloc(256, 42);
  let sent = 0;
  let inFlight = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    if (req.url === '/video.m3u8') {
      return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:1',
        ...parts.flatMap(part => ['#EXTINF:1,', part]), '#EXT-X-ENDLIST'].join('\n'));
    }
    const part = parts.indexOf(req.url.slice(1));
    const attempts = (requests.get(part) || 0) + 1;
    requests.set(part, attempts);
    peak = Math.max(peak, ++inFlight);
    res.writeHead(200, {'content-length':media.length});
    let offset = 0;
    if (part < 4 && attempts === 1) {
      const tick = () => { res.write(media.subarray(offset, ++offset)); sent++; };
      tick();
      const timer = setInterval(tick, part === 0 ? 350 : 20);
      res.once('close', () => { clearInterval(timer); inFlight--; });
      if (part !== 0) {
        const finish = setTimeout(() => { sent += media.length - offset; res.end(media.subarray(offset)); }, 4900);
        res.once('close', () => clearTimeout(finish));
      }
    } else {
      res.once('finish', () => inFlight--);
      sent += media.length;
      res.end(media);
    }
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });
  await once(server, 'listening');
  const source = new URL(`http://127.0.0.1:${server.address().port}/video.m3u8`);
  const started = performance.now();
  const staged = await prefetchHls(source, [], folder, AbortSignal.timeout(6125), () => {}, {connections:4});
  assert.ok(staged);
  const elapsed = Math.round(performance.now() - started);
  const directory = path.dirname(staged);
  for (const index of parts.keys()) assert.deepEqual(await readFile(path.join(directory, `video-${index}.ts`)), media);
  assert.equal(await readFile(path.join(directory, 'download.m3u8'), 'utf8').then(list => list.match(/^video-\d+\.ts$/gm)?.length), parts.length);
  assert.equal(requests.get(0), 2);
  assert.ok(peak <= 5);
  assert.ok(sent - media.length * parts.length < 64, `repeated ${sent - media.length * parts.length} bytes`);
  t.diagnostic(`completed in ${elapsed} ms with ${peak} concurrent requests and ${sent - media.length * parts.length} repeated bytes`);
});

test('does not duplicate steady HLS responses while the queue is full', async t => {
  const {prefetchHls} = await import('../tools/hls-prefetch.mjs');
  const sandbox = await createTestSandbox('hls-steady');
  const folder = sandbox.staging;
  const parts = Array.from({length:9}, (_, index) => `part-${index}.ts`);
  const requests = [];
  const media = Buffer.alloc(10, 42);
  const server = createServer((req, res) => {
    if (req.url === '/video.m3u8') {
      return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:1',
        ...parts.flatMap(part => ['#EXTINF:1,', part]), '#EXT-X-ENDLIST'].join('\n'));
    }
    requests.push(req.url);
    const index = parts.indexOf(req.url.slice(1));
    if (index >= 4 || requests.filter(url => url === req.url).length > 1) return res.end(media);
    res.writeHead(200, {'content-length':media.length});
    res.write(media.subarray(0, 1));
    let offset = 1;
    const timer = setInterval(() => {
      if (offset === media.length - 1) res.end(media.subarray(offset));
      else res.write(media.subarray(offset, ++offset));
    }, 1000);
    res.once('close', () => clearInterval(timer));
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sandbox.cleanup();
  });
  await once(server, 'listening');
  const source = new URL(`http://127.0.0.1:${server.address().port}/video.m3u8`);
  const staged = await prefetchHls(source, [], folder, AbortSignal.timeout(15000), () => {}, {connections:4});
  assert.ok(staged);
  assert.deepEqual(requests.sort(), parts.map(part => '/' + part));
});

test('recovers a partial HLS segment without mixing response versions', async t => {
  const {prefetchHls} = await import('../tools/hls-prefetch.mjs');
  const media = Buffer.from('complete segment');
  const changed = Buffer.from('modified segment');
  const offset = 5;
  for (const scenario of ['resume', 'full replacement', 'invalid range', 'stalled body']) {
    await t.test(scenario, async t => {
      const sandbox = await createTestSandbox('hls-resume-' + scenario.replace(/\s+/g, '-'));
      const folder = sandbox.staging;
      const requests = [];
      let sent = 0;
      const server = createServer(async (req, res) => {
        if (req.url === '/video.m3u8') {
          return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\npart.ts\n#EXTINF:1,\ntail.ts\n#EXT-X-ENDLIST\n');
        }
        if (req.url === '/tail.ts') return res.end('last segment');
        const headers = {'accept-ranges':'bytes', 'content-length':media.length, etag:'"original"'};
        requests.push([req.headers.range, req.headers['if-range']]);
        const send = bytes => { sent += bytes.length; res.end(bytes); };
        if (requests.length === 1) {
          res.writeHead(200, headers);
          sent += offset;
          res.write(media.subarray(0, offset));
          if (scenario === 'stalled body') return;
          await sleep(80);
          return res.destroy();
        }
        if (req.headers.range && scenario !== 'full replacement') {
          const start = scenario === 'invalid range' ? offset + 1 : offset;
          const bytes = media.subarray(start);
          res.writeHead(206, {...headers, 'content-length':bytes.length,
            'content-range':`bytes ${start}-${media.length - 1}/${media.length}`});
          return send(bytes);
        }
        if (['invalid range', 'full replacement'].includes(scenario)) {
          res.writeHead(200, {...headers, etag:'"replacement"'});
          return send(changed);
        }
        res.writeHead(200, headers);
        send(media);
      }).listen(0, '127.0.0.1');
      t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await sandbox.cleanup();
      });
      await once(server, 'listening');
      const source = new URL(`http://127.0.0.1:${server.address().port}/video.m3u8`);
      const signal = AbortSignal.timeout(15_000);
      const manifest = await prefetchHls(source, [], folder, signal, () => {}, {connections:1});
      assert.ok(manifest);
      const replacement = ['invalid range', 'full replacement'].includes(scenario);
      assert.deepEqual(await readFile(path.join(path.dirname(manifest), 'video-0.ts')), replacement ? changed : media);
      assert.deepEqual(requests, [[undefined, undefined], [`bytes=${offset}-${media.length - 1}`, '"original"'],
        ...(scenario === 'invalid range' ? [[undefined, undefined]] : [])]);
      if (!replacement) assert.equal(sent, media.length, 'only the missing bytes should be transmitted');
    });
  }
});

test('finite HLS transfer', async t => {
  const sandbox = await createTestSandbox('hls-finite');
  const folder = sandbox.downloads;
  const restoreEnv = sandbox.applyProcessEnv();
  const { queue, progress, cancel } = await import('../tools/media-downloads.mjs');
  const requests = new Map();
  let directRequests = [];
  let active = 0;
  let peak = 0;
  let failNextSegment;
  let interruptNextSegment = false;
  let failures = 0;
  let failedSegment;
  const dashRequests = [];
  let firstDashFragmentStatus;
  let dashRedirect;
  const hlsRanges = [];
  let playlistAttempts = 0;
  let requireReferer = false;
  const fixtureReferer = 'https://fixture.example/player';
  const source = createServer(async (req, res) => {
    try {
      const filename = path.basename(new URL(req.url, 'http://localhost').pathname);
      if (requireReferer && /\.(?:m3u8|ts)$/.test(filename) && req.headers.referer !== fixtureReferer) {
        return res.writeHead(403).end();
      }
      if (filename === 'retry-playlist.m3u8' && ++playlistAttempts === 1) return res.writeHead(503).end();
      if (filename === 'redirect.mpd') return res.writeHead(302,{location:dashRedirect}).end();
      const bytes = await readFile(path.join(folder, filename));
      if (filename.endsWith('.mpd') || filename.startsWith('dash-')) {
        dashRequests.push({filename,referer:req.headers.referer,cookie:req.headers.cookie});
      }
      if (filename === 'dash-segment-0-1.m4s' && firstDashFragmentStatus) {
        const status = firstDashFragmentStatus;
        firstDashFragmentStatus = undefined;
        return res.writeHead(status).end();
      }
      if (filename === 'direct.mp4') {
        directRequests.push(req.headers.range || 'full');
        res.setHeader('content-type', 'video/mp4');
      }
      if (filename === 'single.m4s') {
        hlsRanges.push(req.headers.range);
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (!range) return res.end(bytes);
        const start = Number(range[1]);
        const end = Number(range[2]);
        const partial = bytes.subarray(start, end + 1);
        return res.writeHead(206, {'content-length':partial.length,
          'content-range':`bytes ${start}-${end}/${bytes.length}`}).end(partial);
      }
      if (/\.(?:ts|m4s)$/.test(filename)) {
        active++;
        peak = Math.max(peak, active);
        requests.set(filename, (requests.get(filename) || 0) + 1);
        try { await sleep(220); }
        finally { active--; }
        if (failNextSegment) {
          const status = failNextSegment;
          failNextSegment = undefined;
          failures++;
          failedSegment = filename;
          return res.writeHead(status).end();
        }
        if (interruptNextSegment) {
          interruptNextSegment = false;
          failedSegment = filename;
          res.writeHead(200, {'content-length':bytes.length});
          res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
          await sleep(40);
          return res.destroy();
        }
      }
      res.writeHead(200, { 'content-length': bytes.length });
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  try {
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24', '-f', 'lavfi', '-i', 'sine=frequency=800',
      '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-sc_threshold', '0',
      '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', path.join(folder, 'fixture.m3u8')], { windowsHide: true });
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    const url = `http://127.0.0.1:${source.address().port}/fixture.m3u8`;
    const start = title => queue({ items: [{ kind: 'stream', url, title }] }).id;
    const finish = async id => {
      const signal = AbortSignal.timeout(20000);
      while (['running', 'cancelling'].includes(progress(id).status)) await sleep(50, undefined, { signal });
      return progress(id);
    };
    const verifyMedia = result => {
      assert.equal(result.status, 'done', JSON.stringify(result));
      const info = JSON.parse(execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-of', 'json',
        '-show_entries', 'format=duration:stream=codec_type,width,height', result.file], { encoding: 'utf8', windowsHide: true }));
      assert.deepEqual(info.streams, [{ codec_type: 'video', width: 320, height: 240 }, { codec_type: 'audio' }]);
      assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.2);
    };
    await t.test('natively stages DASH and retries the first fragment without reopening the manifest', async () => {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=s=320x240:r=24',
        '-f','lavfi','-i','sine=frequency=800','-t','12','-c:v','libx264','-preset','ultrafast','-g','48','-sc_threshold','0',
        '-c:a','aac','-f','dash','-seg_duration','2','-init_seg_name','dash-init-$RepresentationID$.m4s',
        '-media_seg_name','dash-segment-$RepresentationID$-$Number$.m4s','fixture.mpd'], {cwd:folder,windowsHide:true});
      firstDashFragmentStatus = 503;
      const {id} = queue({items:[{kind:'stream',url:new URL('fixture.mpd',url).href,format:'mkv'}],
        headers:{Referer:fixtureReferer},cookie:'session=test'});
      const {items} = await finish(id);
      verifyMedia(items[0]);
      assert.equal(items[0].prefetch,true);
      assert.equal(dashRequests.filter(request => request.filename === 'fixture.mpd').length,1);
      assert.equal(dashRequests.filter(request => request.filename === 'dash-segment-0-1.m4s').length,2);
      assert.ok(dashRequests.every(request => request.referer === fixtureReferer && request.cookie === 'session=test'));
    });
    await t.test('keeps FFmpeg for an unsupported public DASH manifest', async () => {
      dashRequests.length = 0;
      const text = await readFile(path.join(folder,'fixture.mpd'),'utf8');
      const fallback = text.replaceAll('mimeType="video/mp4"','mimeType="video/quicktime"')
        .replaceAll('mimeType="audio/mp4"','mimeType="audio/quicktime"');
      await writeFile(path.join(folder,'fallback.mpd'),fallback);
      const {id} = queue({items:[{kind:'stream',url:new URL('fallback.mpd',url).href,format:'mkv'}]});
      const {items} = await finish(id);
      verifyMedia(items[0]);
      assert.equal(items[0].prefetch,false);
      assert.equal(items[0].prefetchFallback?.reason,'unsupported-dash-playlist');
      assert.ok(dashRequests.filter(request => request.filename === 'fallback.mpd').length > 1);
    });
    await t.test('stops DASH on a fragment access denial without a remote FFmpeg retry', async () => {
      dashRequests.length = 0;
      firstDashFragmentStatus = 403;
      const {id} = queue({items:[{kind:'stream',url:new URL('fixture.mpd?deny=first',url).href,format:'mkv'}]});
      const {items} = await finish(id);
      assert.equal(items[0].status,'error');
      assert.equal(items[0].errorCode,'MEDIA_ACCESS_RESTRICTED');
      assert.equal(dashRequests.filter(request => request.filename === 'fixture.mpd').length,1);
      assert.equal(dashRequests.filter(request => request.filename === 'dash-segment-0-1.m4s').length,1);
    });
    await t.test('keeps local DASH redirects within the selected origin', async () => {
      let crossOriginRequests = 0;
      const outside = createServer((_req,res) => { crossOriginRequests++; res.writeHead(403).end(); }).listen(0,'127.0.0.1');
      try {
        await once(outside,'listening');
        const entry = new URL('redirect.mpd',url);
        dashRedirect = '/fixture.mpd';
        const sameOrigin = await finish(queue({items:[{kind:'stream',url:entry.href,format:'mkv'}]}).id);
        verifyMedia(sameOrigin.items[0]);
        assert.equal(sameOrigin.items[0].prefetch,true);
        dashRedirect = `http://127.0.0.1:${outside.address().port}/fixture.mpd`;
        entry.searchParams.set('case','different-origin');
        const outsideOrigin = await finish(queue({items:[{kind:'stream',url:entry.href,format:'mkv'}],cookie:'session=test'}).id);
        assert.equal(outsideOrigin.items[0].errorCode,'DASH_RESOURCE_SCOPE');
        assert.equal(crossOriginRequests,0);
      } finally { outside.closeAllConnections(); outside.close(); }
    });
    await t.test('fetches direct MP4 once when the origin ignores Range', async () => {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-i',path.join(folder,'fixture.m3u8'),
        '-c','copy','-movflags','+faststart',path.join(folder,'direct.mp4')], {windowsHide:true});
      directRequests = [];
      const id = queue({items:[{kind:'stream',url:new URL('direct.mp4',url).href}]}).id;
      const {items} = await finish(id);
      verifyMedia(items[0]);
      assert.deepEqual(directRequests, ['bytes=0-0']);
    });
    await t.test('sends Referer for the playlist and each of eight concurrent segment requests', async () => {
      requests.clear();
      peak = 0;
      const started = performance.now();
      requireReferer = true;
      const {id} = queue({items:[{kind:'stream',url,title:'HLS performance'}],
        headers:{Referer:fixtureReferer},prefetch:true,connections:8});
      const {items} = await finish(id).finally(() => { requireReferer = false; });
      const elapsed = Math.round(performance.now() - started);
      verifyMedia(items[0]);
      assert.equal(items[0].prefetch,true);
      console.log(`HLS ${elapsed} ms, ${peak} concurrent, ${[...requests.values()].reduce((sum, count) => sum + count, 0)} requests for ${requests.size} segments`);
      assert.equal(peak, 8);
      assert.equal(requests.size, 12);
      assert.ok([...requests.values()].every(count => count === 1));
    });
    await t.test('prefetches AES-128 HLS with eight connections and preserves the complete media', async () => {
      const firstKey = Buffer.alloc(16, 17);
      const secondKey = Buffer.alloc(16, 34);
      const explicitIv = Buffer.alloc(16, 51);
      const crossOriginRequests = [];
      const keyServer = createServer((req, res) => {
        crossOriginRequests.push({url:req.url,cookie:req.headers.cookie});
        res.end(secondKey);
      }).listen(0, '127.0.0.1');
      try {
        await once(keyServer, 'listening');
        const crossOriginKey = `http://127.0.0.1:${keyServer.address().port}/second,key?test=1`;
        await writeFile(path.join(folder, 'first.key'), firstKey);
        let index = 0;
        const playlist = [];
        for (const line of (await readFile(path.join(folder, 'fixture.m3u8'), 'utf8')).split('\n')) {
          if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            playlist.push('#EXT-X-MEDIA-SEQUENCE:42');
          } else if (line.startsWith('#EXTINF:')) {
            if (index === 0) playlist.push('#EXT-X-KEY:METHOD=AES-128,URI="first.key"');
            if (index === 4) playlist.push(`#EXT-X-KEY:URI="${crossOriginKey}",KEYFORMAT="identity",IV=0x${explicitIv.toString('hex')},METHOD=AES-128`);
            if (index === 8) playlist.push('#EXT-X-KEY:METHOD=NONE');
            playlist.push(line);
          } else if (line.endsWith('.ts') && index < 8) {
            const bytes = await readFile(path.join(folder, line));
            const implicitIv = Buffer.alloc(16);
            implicitIv.writeUInt32BE(42 + index, 12);
            const cipher = createCipheriv('aes-128-cbc', index < 4 ? firstKey : secondKey, index < 4 ? implicitIv : explicitIv);
            const name = 'encrypted-' + line;
            await writeFile(path.join(folder, name), Buffer.concat([cipher.update(bytes), cipher.final()]));
            playlist.push(name);
            index++;
          } else {
            playlist.push(line);
            if (line.endsWith('.ts')) index++;
          }
        }
        await writeFile(path.join(folder, 'encrypted.m3u8'), playlist.join('\n'));
        peak = 0;
        requests.clear();
        const {id} = queue({items:[{kind:'stream', url:new URL('encrypted.m3u8', url).href, title:'AES-128 HLS'}],
          prefetch:true, connections:8, cookie:'session=test'});
        const [item] = (await finish(id)).items;
        verifyMedia(item);
        assert.equal(item.prefetch, true);
        assert.equal(peak, 8);
        assert.equal(requests.size, 12);
        assert.ok([...requests.values()].every(count => count === 1));
        assert.deepEqual(crossOriginRequests, [{url:'/second,key?test=1',cookie:undefined}]);
        const plainFile = path.join(folder,'plain-reference.mp4');
        execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-i',path.join(folder,'fixture.m3u8'),
          '-c','copy',plainFile], {windowsHide:true});
        const hash = file => execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-i',file,
          '-c','copy','-f','streamhash','-'], {encoding:'utf8',windowsHide:true});
        assert.equal(hash(item.file), hash(plainFile));
      } finally {
        keyServer.closeAllConnections();
        keyServer.close();
      }
    });
    await t.test('prefetches the selected video and default external audio from a master playlist', async () => {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner','-loglevel','error','-y',
        '-f','lavfi','-i','testsrc2=s=320x240:r=24','-f','lavfi','-i','sine=frequency=800',
        '-map','0:v','-map','1:a','-t','12','-c:v','libx264','-preset','ultrafast','-g','24','-sc_threshold','0','-c:a','aac',
        '-var_stream_map','v:0,agroup:sound a:0,agroup:sound,default:yes,language:eng',
        '-master_pl_name','external.m3u8','-hls_time','1','-hls_list_size','0','track-%v.m3u8'], {cwd:folder,windowsHide:true});
      requests.clear();
      peak = 0;
      const url = new URL(`http://127.0.0.1:${source.address().port}/external.m3u8`);
      const id = queue({items:[{kind:'stream', url:url.href, title:'HLS external sound'}]}).id;
      const {items} = await finish(id);
      verifyMedia(items[0]);
      assert.equal(peak, 8);
      assert.ok([...requests.values()].every(count => count === 1));
    });
    await t.test('resolves a master playlist once before fetching the selected rendition in parallel', async () => {
      await writeFile(path.join(folder, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x240\nfixture.m3u8\n');
      requests.clear();
      peak = 0;
      const startTime = performance.now();
      const id = queue({items:[{kind:'stream', url:new URL('master.m3u8',url).href, title:'HLS master'}]}).id;
      const {items} = await finish(id);
      verifyMedia(items[0]);
      console.log(`HLS master ${Math.round(performance.now()-startTime)} ms, ${peak} concurrent, ${[...requests.values()].reduce((sum,count)=>sum+count,0)} segments`);
      assert.equal(peak, 8);
      assert.ok([...requests.values()].every(count => count === 1));
    });
    await t.test('keeps parallel transfer when the HLS manifest temporarily fails', async () => {
      await writeFile(path.join(folder,'retry-playlist.m3u8'), await readFile(path.join(folder,'fixture.m3u8')));
      peak = 0;
      requests.clear();
      const retryUrl = new URL('retry-playlist.m3u8', url).href;
      const {id} = queue({items:[{kind:'stream',url:retryUrl,title:'HLS manifest retry'}]});
      const result = await finish(id);
      verifyMedia(result.items[0]);
      assert.equal(playlistAttempts, 2);
      assert.equal(peak, 8);
      assert.equal(requests.size, 12);
      assert.ok([...requests.values()].every(count => count === 1));
    });
    await t.test('stages fragmented MP4 and preserves its initialization segment', async () => {
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner','-loglevel','error','-y',
        '-i',path.join(folder,'fixture.m3u8'),'-c','copy','-bsf:a','aac_adtstoasc','-hls_segment_type','fmp4','-hls_time','1',
        '-hls_list_size','0','fragmented.m3u8'], {cwd:folder,windowsHide:true});
      requests.clear();
      peak = 0;
      const url = new URL(`http://127.0.0.1:${source.address().port}/fragmented.m3u8`);
      const startTime = performance.now();
      const id = queue({items:[{kind:'stream', url:url.href, title:'HLS fMP4'}],connections:4}).id;
      const {items} = await finish(id);
      verifyMedia(items[0]);
      console.log(`HLS fMP4 ${Math.round(performance.now()-startTime)} ms, ${peak} concurrent`);
      assert.equal(peak, 4);
      assert.ok([...requests.values()].every(count => count === 1));
    });
    await t.test('stages byte-range HLS and requests each slice of the shared file once', async () => {
      const playlist = path.join(folder, 'single.m3u8');
      execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-y',
        '-i',path.join(folder,'fixture.m3u8'),'-c','copy','-bsf:a','aac_adtstoasc',
        '-hls_flags','single_file','-hls_segment_type','fmp4','-hls_time','1','-hls_list_size','0',playlist],
      {cwd:folder,windowsHide:true});
      const text = await readFile(playlist,'utf8');
      const expected = [...text.matchAll(/(?:BYTERANGE="|#EXT-X-BYTERANGE:)(\d+)@(\d+)/g)]
        .map(([,length, position]) => `bytes=${position}-${Number(position) + Number(length) - 1}`);
      assert.equal(expected.length, 13);
      let index = 0;
      await writeFile(playlist, text.replace(/(#EXT-X-BYTERANGE:\d+)@\d+/g,
        (line, length) => index++ % 2 ? length : line));
      const url = new URL('single.m3u8', `http://127.0.0.1:${source.address().port}`).href;
      const {id} = queue({items:[{kind:'stream',url,title:'HLS byte ranges'}]});
      const result = await finish(id);
      verifyMedia(result.items[0]);
      assert.deepEqual([...hlsRanges].sort(), expected.sort());
    });
    for (const status of [503, 404]) {
      await t.test(`retries only the HLS segment that temporarily returned HTTP ${status}`, async () => {
        requests.clear();
        failures = 0;
        failNextSegment = status;
        const started = performance.now();
        const { items } = await finish(start('HLS retry ' + status));
        assert.equal(failures, 1);
        verifyMedia(items[0]);
        assert.equal(requests.size, 12);
        assert.deepEqual([...requests].filter(([, count]) => count !== 1), [[failedSegment, 2]]);
        console.log(`HLS recovered in ${Math.round(performance.now() - started)} ms with 13 requests for 12 segments`);
      });
    }
    await t.test('keeps completed segments when another segment connection breaks mid-body', async () => {
      requests.clear();
      interruptNextSegment = true;
      const {items} = await finish(start('HLS interrupted segment'));
      verifyMedia(items[0]);
      assert.equal(requests.size, 12);
      assert.deepEqual([...requests].filter(([, count]) => count !== 1), [[failedSegment, 2]]);
    });
    if (process.env.VIDEOSAVE_BENCH_YTDLP) {
      await t.test('reports paired time to a verified MP4 against yt-dlp with eight HLS connections', async () => {
        const rows = [];
        for (let round = 0; round < 5; round++) {
          const commands = {
            VideoSave:async () => (await finish(start('HLS benchmark ' + round))).items[0],
            'yt-dlp':async () => {
              const target = path.join(folder, 'yt-dlp-' + round + '.mp4');
              await run(process.env.VIDEOSAVE_BENCH_YTDLP, [
                '--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-remote-components',
                '--downloader', 'native', '--concurrent-fragments', '8', '--no-hls-use-mpegts',
                '--remux-video', 'mp4', '-o', target, '--', url,
              ], {timeout:30000, windowsHide:true});
              return {status:'done', file:target};
            },
          };
          const order = Object.keys(commands);
          if (round % 2) order.reverse();
          for (const name of order) {
            requests.clear();
            peak = 0;
            const started = performance.now();
            const output = await commands[name]();
            const elapsed = Math.round(performance.now() - started);
            verifyMedia(output);
            rows.push({round:round + 1, tool:name, ms:elapsed, peak,
              requests:[...requests.values()].reduce((sum, count) => sum + count, 0)});
          }
        }
        console.table(rows);
        for (const name of ['VideoSave', 'yt-dlp']) {
          const times = rows.filter(row => row.tool === name).map(row => row.ms).sort((a, b) => a - b);
          console.log(`${name} median ${times[2]} ms`);
        }
      });
    }
    await t.test('cancels in-flight requests and cleans up intermediate segment files', async () => {
      const id = start('HLS cancel');
      const signal = AbortSignal.timeout(5000);
      while (active < 3) await sleep(10, undefined, { signal });
      cancel(id);
      const { items } = await finish(id);
      assert.equal(items[0].status, 'cancelled');
      assert.equal(items[0].file, null);
      assert.ok(!(await readdir(folder)).some(name => name.startsWith('.media-toolkit-') || name.startsWith('HLS cancel')));
    });
  } finally {
    source.closeAllConnections();
    source.close();
    restoreEnv();
    await sandbox.cleanup();
  }
});
