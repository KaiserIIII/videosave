import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MiB = 1024 * 1024;
const maxConnections = 8;
const strongEtag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

function validRange(response, start, end, size, etag) {
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  return response.status === 206 && response.body && (!encoding || encoding === 'identity') &&
    response.headers.get('content-range') === `bytes ${start}-${end}/${size}` &&
    response.headers.get('etag') === etag && (length === null || length === String(end - start + 1));
}

export async function prefetchRanges(source, cookies, staging, signal, onProgress) {
  const cookie = cookies.map(({ name, value }) => name + '=' + value).join('; ');
  const headers = { 'accept-encoding': 'identity', ...(cookie && {cookie}) };
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  const file = path.join(staging, 'source.bin');
  let created = false;
  try {
    const response = await fetch(source, { headers: {...headers, range:'bytes=0-0'}, redirect:'manual', signal:probeSignal });
    const size = Number(/^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range'))?.[1]);
    const etag = response.headers.get('etag');
    if (!Number.isSafeInteger(size) || size < 8 * MiB || !strongEtag.test(etag) || !validRange(response, 0, 0, size, etag)) {
      await response.body?.cancel();
      return null;
    }
    // Drain the one-byte probe so its connection can serve a later range.
    let probeBytes = 0;
    for await (const chunk of response.body) {
      probeBytes += chunk.byteLength;
      if (probeBytes > 1) throw new Error('Invalid range probe');
    }
    if (probeBytes !== 1) return null;
    const output = await open(file, 'wx');
    created = true;
    try { await output.truncate(size); }
    finally { await output.close(); }

    const chunkCount = Math.max(maxConnections, Math.ceil(size / (16 * MiB)));
    const chunkSize = Math.ceil(size / chunkCount);
    const controller = new AbortController();
    const transferSignal = AbortSignal.any([signal, controller.signal]);
    let offset = 0;
    let received = 0;
    const worker = async () => {
      try {
        while (offset < size) {
          const start = offset;
          const end = Math.min(size, start + chunkSize) - 1;
          offset = end + 1;
          const stalled = new AbortController();
          const timeout = setTimeout(() => stalled.abort(), 15000);
          const rangeSignal = AbortSignal.any([transferSignal, stalled.signal]);
          try {
            const part = await fetch(source, {redirect:'manual', signal:rangeSignal,
              headers:{...headers, range:`bytes=${start}-${end}`, 'if-range':etag}});
            if (!validRange(part, start, end, size, etag)) {
              await part.body?.cancel();
              throw new Error('Unexpected range response');
            }
            const expected = end - start + 1;
            let count = 0;
            await pipeline(part.body, async function* (chunks) {
              for await (const chunk of chunks) {
                timeout.refresh();
                count += chunk.byteLength;
                if (count > expected) throw new Error('Range exceeded its declared size');
                received += chunk.byteLength;
                onProgress(received / size);
                yield chunk;
              }
              if (count !== expected) throw new Error('Range ended early');
            }, createWriteStream(file, {flags:'r+', start}), {signal:rangeSignal});
          } finally { clearTimeout(timeout); }
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };
    await Promise.allSettled(Array.from({length:maxConnections}, worker));
    transferSignal.throwIfAborted();
    return file;
  } catch {
    if (created) await rm(file, {force:true, maxRetries:5});
    signal.throwIfAborted();
    return null;
  }
}
