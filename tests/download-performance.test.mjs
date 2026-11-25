import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('finite HLS transfer', async t => {
  const folder = await mkdtemp(fileURLToPath(new URL('../.hls-test-', import.meta.url)));
  const outputDir = process.env.OUT_DIR;
  process.env.OUT_DIR = folder;
  const { queue, progress, cancel } = await import('../tools/media-downloads.mjs');
  const requests = new Map();
  let active = 0;
  let peak = 0;
  let failNextSegment = false;
  let failures = 0;
  const source = createServer(async (req, res) => {
    try {
      const filename = path.basename(new URL(req.url, 'http://localhost').pathname);
      const bytes = await readFile(path.join(folder, filename));
      if (filename.endsWith('.ts')) {
        active++;
        peak = Math.max(peak, active);
        requests.set(filename, (requests.get(filename) || 0) + 1);
        try { await sleep(220); }
        finally { active--; }
        if (failNextSegment) {
          failNextSegment = false;
          failures++;
          return res.writeHead(503).end();
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
    await t.test('fetches each segment once with up to eight concurrent requests', async () => {
      const started = performance.now();
      const { items } = await finish(start('HLS performance'));
      const elapsed = Math.round(performance.now() - started);
      verifyMedia(items[0]);
      console.log(`HLS ${elapsed} ms, ${peak} concurrent, ${[...requests.values()].reduce((sum, count) => sum + count, 0)} requests for ${requests.size} segments`);
      assert.equal(peak, 8);
      assert.equal(requests.size, 12);
      assert.ok([...requests.values()].every(count => count === 1));
    });
    await t.test('falls back after a segment request fails and still saves a complete video', async () => {
      failNextSegment = true;
      const { items } = await finish(start('HLS fallback'));
      assert.equal(failures, 1);
      verifyMedia(items[0]);
    });
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
    if (outputDir === undefined) delete process.env.OUT_DIR;
    else process.env.OUT_DIR = outputDir;
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
