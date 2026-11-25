import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = randomBytes(16 * 1024 * 1024 + 7);
const etag = '"fixture-v1"';
const bytesPerConnection = 128 * 1024;
const bytesPerTick = 8 * bytesPerConnection;
const tickMs = 80;

test('parallel Range transfer', async t => {
  const { prefetchRanges } = await import('../tools/range-prefetch.mjs');
  const staging = await mkdtemp(fileURLToPath(new URL('../.range-test-', import.meta.url)));
  const transfers = new Set();
  let peak = 0;
  const source = createServer((req, res) => {
    const mode = path.basename(req.url, '.mp4');
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const partial = range && mode !== 'ignore';
    const first = partial ? Number(range[1]) : 0;
    const end = partial ? Number(range[2]) + 1 : fixture.length;
    const probe = partial && end === 1;
    res.writeHead(partial ? 206 : 200, {
      'content-length': end - first,
      etag: !probe && mode === 'changed' ? '"fixture-v2"' : etag,
      ...(partial && {'content-range': `bytes ${first + Number(!probe && mode === 'wrong')}-${end - 1}/${fixture.length}`}),
    });
    if (probe) return res.end(fixture.subarray(first, end));
    if (partial && req.headers['if-range'] !== etag) return res.destroy();
    const transfer = {res, offset: first, end};
    transfers.add(transfer);
    peak = Math.max(peak, transfers.size);
    res.on('close', () => transfers.delete(transfer));
    res.flushHeaders();
  });
  const ticker = setInterval(() => {
    let budget = bytesPerTick;
    for (const transfer of transfers) {
      const { res, offset, end } = transfer;
      if (res.writableNeedDrain || res.writableEnded || !budget) continue;
      const count = Math.min(end - offset, budget, bytesPerConnection);
      budget -= count;
      transfer.offset += count;
      const chunk = fixture.subarray(offset, transfer.offset);
      if (transfer.offset === end) res.end(chunk);
      else res.write(chunk);
    }
  }, tickMs);
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const url = mode => new URL(`http://127.0.0.1:${source.address().port}/${mode}.mp4`);
  try {
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
      await rm(file);
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
    await rm(staging, {recursive:true, force:true, maxRetries:5});
  }
});
