
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, pageStreams, pickStreams } from '../extension/media.mjs';
import { queue, cancel, progress } from '../tools/media-downloads.mjs';
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

test('rejects unsupported media options and keeps the AI queue capped at two', () => {
  const video = {kind:'stream', url:'http://127.0.0.1:1/missing.mp4'};
  assert.throws(() => queue({items:[{...video, mode:'typo'}]}), {code:'INVALID_MODE'});
  assert.throws(() => queue({items:[{...video, quality:-1}]}), {code:'INVALID_QUALITY'});
  assert.throws(() => queue({items:[video], concurrency:3}), {code:'INVALID_CONCURRENCY'});
});
