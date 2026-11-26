
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { classify, mediaResponseSize, pageStreams, pickStreams, sourceTitle } from '../extension/media.mjs';
import { downloadFolder, readDownloadSettings } from '../extension/settings.mjs';
import { queue, queueOriginal, cancel, progress } from '../tools/media-downloads.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

test('discovers extensionless DASH and video, ignores segments and unrelated responses', () => {
  assert.equal(classify('https://cdn.example/manifest?id=1', 'application/dash+xml'), 'mpd');
  assert.equal(classify('https://cdn.example/play', 'video/webm'), 'webm');
  assert.equal(classify('https://cdn.example/watch?id=4', 'text/html'), null);
  assert.equal(classify('https://cdn.example/segment.m4s', 'video/mp4'), null);
  assert.equal(classify('https://cdn.example/init.mp4', 'video/mp4'), null);
  assert.equal(classify('https://cdn.example/video.mp4', 'text/html'), null);
});
test('combines markup and request metadata and prioritizes playlists', () => {
  const result = pickStreams([
    { url: 'https://cdn.example/movie.mp4' },
    { url: 'https://cdn.example/movie.mp4', mime: 'video/mp4', width: 640 },
    { url: 'https://cdn.example/master', mime: 'application/vnd.apple.mpegurl' },
    { url: 'blob:https://cdn.example/z', mediaElement: true },
  ]);
  assert.deepEqual(result.map(row => row.kind), ['m3u8', 'mp4']);
  assert.equal(result[1].width, 640);
});
test('drops known non-video responses despite a video-looking URL', () => {
  assert.equal(classify('https://cdn.example/asset.mp4', 'application/json'), null);
  assert.equal(classify('https://cdn.example/dub.mp4', 'audio/mp4'), null);
  assert.equal(classify('https://cdn.example/player/init_0.m4v', 'video/mp4'), null);
  assert.equal(classify('https://cdn.example/video', 'video/iso.segment'), null);
  const url = 'https://cdn.example/asset.mp4';
  assert.deepEqual(pageStreams([{frameId:0,result:{candidates:[{url}]}}],
    [{frameId:0,url,mime:'application/json'}]), []);
});
test('uses the total byte range for partial video and never counts a playlist as a video file', () => {
  const url = 'https://cdn.example/video.mp4';
  assert.equal(mediaResponseSize('mp4', 206, name => ({'content-length':'42','content-range':'bytes 0-41/1048576'})[name]), 1048576);
  assert.equal(mediaResponseSize('mp4', 206, name => ({'content-length':'42'})[name]), undefined);
  assert.equal(mediaResponseSize('m3u8', 200, name => ({'content-length':'42'})[name]), undefined);
  assert.equal(mediaResponseSize('mp4', 200, name => ({'content-length':'42','content-encoding':'gzip'})[name]), undefined);
  const rows = pageStreams([{frameId:0,result:{candidates:[{url,mediaElement:true,title:'测试'}]}}],
    [{url,mime:'video/mp4',frameId:0,size:1048576}]);
  assert.equal(rows[0].size, 1048576);
});
test('prefers the actual player and suppresses noise without discarding a separate verified player', () => {
  const frames = [{frameId:0,result:{candidates:[
    {url:'https://cdn.example/film.mp4', mediaElement:true, title:'实际片名'},
    {url:'https://cdn.example/preview.mp4', mediaElement:true, title:'独立播放的短片'},
  ]}}];
  const result = pageStreams(frames, [
    {frameId:0,url:'https://cdn.example/storyboard/preview.mp4',mime:'video/mp4'},
    {frameId:0,url:'https://cdn.example/ads/spot.m3u8'},
    {frameId:0,url:'https://cdn.example/film.mp4',mime:'video/mp4'},
  ]);
  assert.deepEqual(result.map(({title}) => title), ['实际片名','独立播放的短片']);
});
test('uses a master playlist for an opaque player and hides its observed renditions', () => {
  const frames = [{frameId:0,result:{candidates:[],opaquePlayer:{title:'电影名称',duration:80}}}];
  const result = pageStreams(frames, ['master.m3u8','720p/index.m3u8','1080p/index.m3u8'].map(path =>
    ({frameId:0,url:`https://cdn.example/movie/${path}`,mime:'application/vnd.apple.mpegurl'})));
  assert.deepEqual(result.map(({url,title,duration}) => [url,title,duration]),
    [['https://cdn.example/movie/master.m3u8','电影名称',80]]);
});
test('shows the active source once and keeps alternate encodings for the same player', () => {
  const frames = [{frameId:0,result:{candidates:[
    {url:'https://cdn.example/film.webm',mediaElement:true,playerIndex:0},
    {url:'https://cdn.example/film.mp4',mediaElement:true,playerIndex:0,currentSource:true},
    {url:'https://cdn.example/second.mp4',mediaElement:true,playerIndex:1,currentSource:true},
  ]}}];
  const rows = pageStreams(frames, []);
  assert.deepEqual(rows.map(row => row.url), ['https://cdn.example/film.mp4','https://cdn.example/second.mp4']);
  assert.deepEqual(rows[0].alternates.map(row => row.url), ['https://cdn.example/film.webm']);
});
test('recovers a meaningful title from the response or the embedding page', () => {
  assert.equal(sourceTitle({url:'https://cdn.example/123.mp4',filename:'%E6%98%A5%E5%A4%A9.mp4'}), '春天');
  assert.equal(sourceTitle({url:'https://cdn.example/a9b03fda-8c64-4a6a-a7ee-167f05ada507.mp4'}), '');
  const result = pageStreams([
    {frameId:0,result:{playerCount:0,candidates:[],pageMetadata:{videoTitle:'夜间列车'}}},
    {frameId:3,result:{playerCount:1,candidates:[{url:'https://cdn.example/123.mp4',mediaElement:true,title:'Embed player'}]}},
  ], []);
  assert.equal(result[0].title, '夜间列车');
});
test('uses an opaque player’s metadata only for a single playlist from the same frame', () => {
  const player = {title: '示例节目', duration: 95};
  const frames = [{frameId: 2, result: {opaquePlayer: player, candidates: []}}];
  const playlist = {frameId: 2, url: 'https://cdn.example/watch', mime: 'application/vnd.apple.mpegurl'};
  const sibling = {frameId: 3, url: 'https://cdn.example/other.m3u8'};
  const matched = pageStreams(frames, [playlist, sibling]);
  assert.deepEqual(matched.map(({title, duration}) => ({title, duration})),
    [player, {title: undefined, duration: undefined}]);

  const ambiguous = pageStreams(frames, [playlist, {...sibling, frameId: 2}]);
  assert.ok(ambiguous.every(stream => stream.duration === undefined));
});
test('a cancelled batch can be queued again with the same options', async () => {
  const input = { items: [{kind:'stream', url:'http://127.0.0.1:1/missing.mp4'}] };
  const first = queue(input);
  assert.equal(queue(input).id, first.id);
  cancel(first.id);
  for (let i=0; i<50 && progress(first.id).status !== 'cancelled'; i++) await sleep(50);
  assert.equal(progress(first.id).status, 'cancelled');
  const retry = queue(input);
  assert.notEqual(retry.id, first.id);
  cancel(retry.id);
});

test('rejects unsupported media options and invalid download concurrency', () => {
  const video = {kind:'stream', url:'http://127.0.0.1:1/missing.mp4'};
  assert.throws(() => queue({items:[{...video, mode:'typo'}]}), {code:'INVALID_MODE'});
  assert.throws(() => queue({items:[{...video, quality:-1}]}), {code:'INVALID_QUALITY'});
  for (const concurrency of [0, 65, 2.5, '24']) {
    assert.throws(() => queue({items:[video], concurrency}), {code:'INVALID_CONCURRENCY'});
  }
});

test('upgrades the former default and preserves explicitly configured queue limits', () => {
  assert.equal(readDownloadSettings().concurrency, 24);
  assert.equal(readDownloadSettings({concurrency:2}).concurrency, 24);
  assert.equal(readDownloadSettings({concurrency:10, concurrencyVersion:1}).concurrency, 24);
  assert.equal(readDownloadSettings({concurrency:10, concurrencyVersion:2}).concurrency, 10);
  assert.equal(readDownloadSettings({concurrency:1}).concurrency, 1);
  assert.equal(readDownloadSettings({concurrency:2, concurrencyVersion:1}).concurrency, 2);
  assert.equal(readDownloadSettings({concurrency:24, concurrencyVersion:1}).concurrency, 24);
});

test('accepts nested download folders and rejects absolute paths and Windows device names', () => {
  assert.equal(downloadFolder(' 视频\\教程 '), '视频/教程');
  assert.equal(downloadFolder(''), '');
  for (const folder of ['C:\\Downloads', '\\\\server\\share', '/', '../video', 'video//', 'video/NUL.mp4', 'video/a.']) {
    assert.throws(() => downloadFolder(folder), /Edge 下载目录/);
  }
});

test('runs 24 default companion downloads and accepts a 64-task batch', async () => {
  let inFlight = 0;
  let peak = 0;
  const server = createServer((_req, res) => {
    peak = Math.max(peak, ++inFlight);
    res.once('close', () => inFlight--);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const created = [];
  try {
    const items = Array.from({length:64}, (_, index) =>
      ({kind:'stream', url:`http://127.0.0.1:${server.address().port}/${index}.mp4`}));
    const low = queue({items, concurrency:1});
    created.push(low.id);
    for (let index = 0; peak === 0 && index < 100; index++) await sleep(15);
    assert.equal(peak, 1);
    assert.equal(progress(low.id).items.filter(item => item.status === 'queued').length, 63);
    cancel(low.id);
    for (let index = 0; (inFlight || progress(low.id).status !== 'cancelled') && index < 100; index++) await sleep(15);
    assert.equal(progress(low.id).status, 'cancelled');
    assert.equal(inFlight, 0);
    peak = 0;

    const batch = queue({items});
    created.push(batch.id);
    for (let index = 0; peak < 24 && index < 100; index++) await sleep(15);
    assert.equal(peak, 24);
    assert.equal(progress(batch.id).items.filter(item => item.status === 'queued').length, 40);
    cancel(batch.id);
    for (let index = 0; (inFlight || progress(batch.id).status !== 'cancelled') && index < 100; index++) await sleep(15);
    assert.equal(progress(batch.id).status, 'cancelled');
    assert.equal(inFlight, 0);
    peak = 0;

    for (let index = 0; index < 24; index++) {
      const url = `http://127.0.0.1:${server.address().port}/${index}.mp4`;
      created.push(queueOriginal({url, extension:'mp4'}).id);
    }
    for (let index = 0; peak < 24 && index < 100; index++) await sleep(15);
    assert.equal(peak, 24);
    created.forEach(cancel);
    for (let index = 0; created.some(id => progress(id).status !== 'cancelled') && index < 100; index++) {
      await sleep(15);
    }
    assert.ok(created.every(id => progress(id).items[0].status === 'cancelled'));

    const maximum = queue({items, concurrency:64});
    created.push(maximum.id);
    for (let index = 0; peak < 64 && index < 100; index++) await sleep(15);
    assert.equal(peak, 64);
    cancel(maximum.id);
  } finally {
    created.forEach(cancel);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
