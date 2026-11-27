import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

const fixture = randomBytes(16 * 1024 * 1024 + 7);
const etag = '"fixture-v1"';
const bytesPerConnection = 128 * 1024;
const bytesPerTick = 8 * bytesPerConnection;
const tickMs = 80;

async function removeFixture(file) {
  for (let attempt = 0; ; attempt++) {
    try { return await rm(file); }
    catch (error) {
      if (attempt === 4 || !['EBUSY','EPERM'].includes(error.code)) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
}

test('parallel Range transfer', async t => {
  const { prefetchRanges } = await import('../tools/range-prefetch.mjs');
  const staging = await mkdtemp(path.join(os.tmpdir(),'videosave-range-test-'));
  const transfers = new Set();
  const redirectedRequests = [];
  const retries = [];
  const unexpectedSizeRequests = [];
  let interrupted = false;
  let peak = 0;
  const serve = (req, res) => {
    const mode = path.basename(req.url, '.mp4');
    if (mode === 'redirect') {
      const target = `http://127.0.0.1:${cdn.address().port}/cdn.mp4`;
      return res.writeHead(302, {location:target}).end();
    }
    if (mode === 'cdn') redirectedRequests.push(req.headers);
    if (mode === 'size-mismatch') unexpectedSizeRequests.push(req.headers.range);
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const partial = range && mode !== 'ignore';
    const first = partial ? Number(range[1]) : 0;
    const end = partial ? Number(range[2]) + 1 : fixture.length;
    const probe = partial && end === 1;
    if (mode === 'interrupted' && partial && !probe) retries.push([first, end]);
    res.writeHead(partial ? 206 : 200, {
      'content-length': end - first,
      etag: !probe && mode === 'changed' ? '"fixture-v2"' : etag,
      ...(partial && {'content-range': `bytes ${first + Number(!probe && mode === 'wrong')}-${end - 1}/${fixture.length}`}),
    });
    if (probe) return res.end(fixture.subarray(first, end));
    if (partial && req.headers['if-range'] !== etag) return res.destroy();
    const transfer = {res, offset: first, end, mode, first};
    transfers.add(transfer);
    peak = Math.max(peak, transfers.size);
    res.on('close', () => transfers.delete(transfer));
    res.flushHeaders();
  };
  const source = createServer(serve);
  const cdn = createServer(serve);
  const ticker = setInterval(() => {
    let budget = bytesPerTick;
    for (const transfer of transfers) {
      const { res, offset, end } = transfer;
      if (res.writableNeedDrain || res.writableEnded || !budget) continue;
      if (transfer.mode === 'interrupted' && !interrupted && transfer.first === 0 && offset >= bytesPerConnection * 2) {
        interrupted = true;
        res.destroy();
        continue;
      }
      const count = Math.min(end - offset, budget, bytesPerConnection);
      budget -= count;
      transfer.offset += count;
      const chunk = fixture.subarray(offset, transfer.offset);
      if (transfer.offset === end) res.end(chunk);
      else res.write(chunk);
    }
  }, tickMs);
  source.listen(0, '127.0.0.1');
  cdn.listen(0, '127.0.0.1');
  await Promise.all([once(source, 'listening'), once(cdn, 'listening')]);
  const url = mode => new URL(`http://127.0.0.1:${source.address().port}/${mode}.mp4`);
  try {
    await t.test('abandons the whole-file path when the playlist covers only part of the source', async () => {
      const file = await prefetchRanges(url('size-mismatch'), [], staging, AbortSignal.timeout(3000), () => {},
        {expectedSize:fixture.length - 1});
      assert.equal(file, null);
      assert.deepEqual(unexpectedSizeRequests, ['bytes=0-0']);
      assert.deepEqual(await readdir(staging), []);
    });
    await t.test('uses most of the shared throughput and saves identical bytes', async () => {
      const singleStart = performance.now();
      const response = await fetch(url('single'));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
      const singleMs = performance.now() - singleStart;
      await sleep(tickMs);
      peak = 0;
      const parallelStart = performance.now();
      const file = await prefetchRanges(url('parallel'), [], staging, AbortSignal.timeout(15000), () => {});
      const elapsed = performance.now() - parallelStart;
      assert.ok(file);
      assert.deepEqual(await readFile(file), fixture);
      const ceilingMs = fixture.length / bytesPerTick * tickMs;
      const effectiveCeiling = singleMs / (bytesPerTick / bytesPerConnection);
      console.log(`Range single ${Math.round(singleMs)} ms, parallel ${Math.round(elapsed)} ms, ${peak} connections, ${(effectiveCeiling / elapsed * 100).toFixed(1)}% of the ceiling measured from the single transfer`);
      assert.equal(peak, 8);
      assert.ok(elapsed < singleMs / 4 && elapsed < ceilingMs * 1.6);
      await removeFixture(file);
    });
    await t.test('retries an interrupted range from the last written byte without restarting other ranges', async () => {
      let progress = 0;
      const file = await prefetchRanges(url('interrupted'), [], staging, AbortSignal.timeout(15000), (_, bytes) => {
        assert.ok(bytes >= progress && bytes <= fixture.length);
        progress = bytes;
      });
      assert.ok(file);
      assert.deepEqual(await readFile(file), fixture);
      assert.equal(progress, fixture.length);
      const initial = retries.find(([start]) => start === 0);
      assert.deepEqual(retries.filter(([, end]) => end === initial[1]), [initial, [bytesPerConnection * 2, initial[1]]]);
      assert.equal(retries.length, 9);
      console.log('Range recovery resumed at byte', bytesPerConnection * 2, 'with no repeated bytes');
      await removeFixture(file);
    });
    await t.test('accelerates a redirect to a media origin without forwarding cookies', async () => {
      const cookies = [{name:'session',value:'source-only'}];
      const file = await prefetchRanges(url('redirect'), cookies, staging, AbortSignal.timeout(8000), () => {});
      assert.ok(file);
      assert.deepEqual(await readFile(file), fixture);
      assert.equal(redirectedRequests.length, 9);
      assert.ok(redirectedRequests.every(headers => headers.cookie === undefined));
      await removeFixture(file);
    });
    for (const mode of ['ignore', 'wrong', 'changed']) {
      await t.test(`abandons ${mode} responses and removes staging`, async () => {
        assert.equal(await prefetchRanges(url(mode), [], staging, AbortSignal.timeout(5000), () => {}), null);
        assert.deepEqual(await readdir(staging), []);
      });
    }
    await t.test('cancels every request and removes staging', async () => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
      const pending = assert.rejects(prefetchRanges(url('cancel'), [], staging, signal, () => {}), { name: 'AbortError' });
      while (transfers.size < 4) await sleep(10, undefined, {signal});
      controller.abort();
      await pending;
      assert.deepEqual(await readdir(staging), []);
    });
  } finally {
    clearInterval(ticker);
    source.closeAllConnections();
    source.close();
    cdn.closeAllConnections();
    cdn.close();
    await rm(staging, {recursive:true, force:true, maxRetries:5});
  }
});
