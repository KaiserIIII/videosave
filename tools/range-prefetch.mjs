import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { classify, isPlaylist } from '../extension/media.mjs';
import { ApiError } from './media-source.mjs';
import { createRequestContext } from './request-context.mjs';
import { inspectMediaFile } from './media-inspector.mjs';
import { paceBandwidth, recordHostFailure, recordHostSuccess } from './rate-controller.mjs';

const MiB = 1024 * 1024;
const minimumParallelSize = 8 * MiB;
const maxConnections = 8;
const strongEtag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const transientStatuses = new Set([408, 500, 502, 503, 504]);
const redirects = new Set([301, 302, 303, 307, 308]);

function enforceExactResponse(response) {
  if (redirects.has(response.status)) {
    response.body.destroy();
    throw new ApiError('MCP_MEDIA_REDIRECT','The approved media URL redirected. Open the destination in the browser and request approval again.',403);
  }
  if ([401,402,403,429,451].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge') {
    response.body.destroy();
    throw new ApiError('MCP_MEDIA_ACCESS_RESTRICTED','The media server denied this request. Confirm access in the browser.',403);
  }
}

function requestFile(url, headers, signal) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url,{headers,signal},body => {
      // A response can fail before the caller starts consuming the stream.
      body.on('error', () => {});
      resolve({status:body.statusCode,headers:new Headers(body.headers),body});
    });
    request.once('error',reject);
  });
}

function validRange(response, start, end, size, etag) {
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  return response.status === 206 && response.body && (!encoding || encoding === 'identity') &&
    response.headers.get('content-range') === `bytes ${start}-${end}/${size}` &&
    response.headers.get('etag') === etag && (length === null || length === String(end - start + 1));
}

async function rangeSliceSha256(filePath, offset, length) {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(Math.min(262_144, length));
    let pos = offset;
    let remaining = length;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, remaining), pos);
      if (!bytesRead) throw new Error('Truncated range checkpoint');
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function rangeCheckpoint(root, target, size, etag, chunkSize) {
  const identity = createHash('sha256').update(JSON.stringify([target.origin + target.pathname, size, etag, chunkSize])).digest('hex');
  const directory = path.join(root, 'ranges-' + identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid range checkpoint directory');
  const file = path.join(directory, 'source.bin');
  const saved = await lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const entries = await readdir(directory, { withFileTypes: true });
  const markers = entries.filter(entry => entry.isFile() && /^complete-\d+$/.test(entry.name));
  const completed = new Set();
  let corrupted = 0;
  if (saved?.isFile() && saved.size === size) {
    for (const { name } of markers) {
      const offset = Number(name.slice('complete-'.length));
      if (offset < size && offset % chunkSize === 0) {
        const markerPath = path.join(directory, name);
        const expected = await readFile(markerPath, 'utf8').catch(() => '');
        const sliceLen = Math.min(size - offset, chunkSize);
        if (expected && /^[0-9a-f]{64}$/.test(expected.trim())) {
          const actual = await rangeSliceSha256(file, offset, sliceLen).catch(() => null);
          if (actual === expected.trim()) completed.add(offset);
          else {
            corrupted++;
            await rm(markerPath, { force: true });
          }
        } else {
          completed.add(offset);
        }
      }
    }
  } else {
    if (saved && !saved.isFile()) throw new Error('Invalid range checkpoint file');
    await Promise.all(markers.map(({ name }) => rm(path.join(directory, name), { force: true })));
    const output = await open(file, saved ? 'r+' : 'wx', 0o600);
    try { await output.truncate(size); }
    finally { await output.close(); }
  }
  return {
    file,
    directory,
    completed,
    corrupted,
    commit: async offset => {
      const sliceLen = Math.min(size - offset, chunkSize);
      const digest = await rangeSliceSha256(file, offset, sliceLen);
      await writeFile(path.join(directory, 'complete-' + offset), digest, { flag: 'wx', mode: 0o600 });
    },
  };
}

export async function prefetchRanges(source, cookies, staging, signal, onProgress, {
  connections = maxConnections, stageFull = false, expectedSize, onKind, recovery, headers: mediaHeaders,
  exactSource = false, cookiesFor, transport, requestContext,
} = {}) {
  if (expectedSize !== undefined && expectedSize < minimumParallelSize) return null;
  const request = transport?.request ?? requestFile;
  const ctx = requestContext ?? createRequestContext({
    origin: source.origin,
    headers: mediaHeaders,
    cookies,
    cookiesFor,
    restrictedOrigin: exactSource,
    transport,
  });
  const headersFor = (url, range) => ctx.headersFor(url, { phase: range ? 'byte-range' : 'direct', range });
  const probe = new AbortController();
  const probeSignal = AbortSignal.any([signal, probe.signal]);
  let deadline = setTimeout(() => probe.abort(), 2000);
  const file = path.join(staging, 'source.bin');
  let created = false;
  try {
    let target = source;
    let response;
    for (let hop = 0; hop <= 4; hop++) {
      response = await request(target,{...headersFor(target),range:'bytes=0-0'},probeSignal);
      target = response.url ?? target;
      if (exactSource) enforceExactResponse(response);
      if (!redirects.has(response.status)) break;
      response.body.destroy();
      const location = response.headers.get('location');
      const next = location && URL.parse(location, target);
      if (!next || !/^https?:$/.test(next.protocol) || next.username || next.password || hop === 4) return null;
      target = next;
    }
    const kind = classify(target, response.headers.get('content-type') || '');
    if (isPlaylist(kind)) {
      onKind?.(kind);
      response.body.destroy();
      return null;
    }
    const size = Number(/^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range'))?.[1]);
    const etag = response.headers.get('etag');
    if (expectedSize !== undefined && size !== expectedSize) {
      response.body.destroy();
      return null;
    }
    if (!Number.isSafeInteger(size) || size < minimumParallelSize || !strongEtag.test(etag) || !validRange(response, 0, 0, size, etag)) {
      if (stageFull && response.status === 206 && Number.isSafeInteger(size) && size > 0) {
        response.body.destroy();
        response = await request(target,headersFor(target),probeSignal);
        if (exactSource) enforceExactResponse(response);
      }
      const accessErr = !exactSource && ctx.accessError(response.status, response.headers, 'direct');
      if (accessErr && [401, 402, 403, 410, 451].includes(response.status)) {
        response.body.destroy();
        throw accessErr;
      }
      const encoding = response.headers.get('content-encoding');
      if (!stageFull || response.status !== 200 || !response.body || encoding && encoding !== 'identity') {
        response.body.destroy();
        return null;
      }
      clearTimeout(deadline);
      deadline = setTimeout(() => probe.abort(), 15000);
      const declared = Number(response.headers.get('content-length'));
      const length = Number.isSafeInteger(declared) && declared > 0 ? declared : null;
      let bytes = 0;
      const output = await open(file, 'wx');
      created = true;
      await output.close();
      await pipeline(response.body, async function* (chunks) {
        for await (const chunk of chunks) {
          deadline.refresh();
          bytes += chunk.byteLength;
          onProgress(length ? bytes / length : null, bytes, length);
          yield chunk;
        }
      }, createWriteStream(file, {flags:'r+'}), {signal:probeSignal});
      if (!bytes || (length && length !== bytes)) throw new Error('Incomplete media response');
      const inspected = await inspectMediaFile(file);
      if (inspected.rejected && ['html-error-page', 'json-error-response', 'image-payload', 'drm-isobmff'].includes(inspected.reason)) {
        throw inspected.errorCode === 'DRM'
          ? new ApiError('DRM', '媒体响应包含受 DRM 保护的内容', 422)
          : new ApiError('INVALID_MEDIA_CONTENT', `响应内容不是有效媒体（${inspected.reason}）`, 422, { detectedKind: inspected.kind, reason: inspected.reason });
      }
      return file;
    }
    // Drain the one-byte probe so its connection can serve a later range.
    let probeBytes = 0;
    for await (const chunk of response.body) {
      probeBytes += chunk.byteLength;
      if (probeBytes > 1) throw new Error('Invalid range probe');
    }
    if (probeBytes !== 1) return null;
    clearTimeout(deadline);
    // Give fast workers more ranges to pick up when a shared HLS source delivers one slowly.
    const rangeLimit = (expectedSize === undefined ? 16 : 4) * MiB;
    const chunkCount = Math.max(connections, Math.ceil(size / rangeLimit));
    const chunkSize = Math.ceil(size / chunkCount);
    const checkpoint = recovery && await rangeCheckpoint(recovery,target,size,etag,chunkSize);
    const destination = checkpoint?.file ?? file;
    if (!checkpoint) {
      const output = await open(file, 'wx');
      created = true;
      try { await output.truncate(size); }
      finally { await output.close(); }
    }
    const controller = new AbortController();
    const transferSignal = AbortSignal.any([signal, controller.signal]);
    let offset = 0;
    let received = 0;
    let savedBytes = 0;
    let completedChunks = checkpoint?.completed.size ?? 0;
    const restoredChunks = completedChunks;
    const corruptedChunks = checkpoint?.corrupted ?? 0;
    if (checkpoint?.completed.size) {
      for (const start of checkpoint.completed) {
        const sliceLen = Math.min(size - start, chunkSize);
        received += sliceLen;
        savedBytes += sliceLen;
      }
      onProgress(received / size, received, size, {
        completed: completedChunks,
        total: chunkCount,
        missing: chunkCount - completedChunks,
        corrupted: corruptedChunks,
        restored: restoredChunks,
        duplicateBytes: 0,
        savedBytes,
      });
    }
    const worker = async () => {
      let writer;
      try {
        writer = await open(destination, 'r+');
        while (offset < size) {
          const start = offset;
          let position = start;
          const end = Math.min(size, start + chunkSize) - 1;
          offset = end + 1;
          if (checkpoint?.completed.has(start)) continue;
          for (let attempt = 0; position <= end; attempt++) {
            transferSignal.throwIfAborted();
            if (attempt > 2) throw new Error('Range download interrupted');
            if (attempt) await sleep(150 * attempt, undefined, {signal:transferSignal});
            const stalled = new AbortController();
            const timeout = setTimeout(() => stalled.abort(), 15000);
            const rangeSignal = AbortSignal.any([transferSignal, stalled.signal]);
            let part;
            try {
              part = await request(target,{...headersFor(target),range:`bytes=${position}-${end}`,'if-range':etag},rangeSignal)
                .catch(error => {
                  if (exactSource && error instanceof ApiError) throw error;
                  return null;
                });
              if (!part) continue;
              if (exactSource) enforceExactResponse(part);
              if (!validRange(part, position, end, size, etag)) {
                if (transientStatuses.has(part.status)) continue;
                throw new Error('Unexpected range response');
              }
              const chunks = part.body[Symbol.asyncIterator]();
              while (true) {
                const result = await chunks.next().catch(() => null);
                if (!result && position > end) throw new Error('Range response did not end cleanly');
                if (!result || result.done) break;
                timeout.refresh();
                const chunk = result.value;
                if (position + chunk.byteLength > end + 1) throw new Error('Range exceeded its declared size');
                const {bytesWritten} = await writer.write(chunk, 0, chunk.byteLength, position);
                if (bytesWritten !== chunk.byteLength) throw new Error('Could not write the complete range');
                position += bytesWritten;
                received += bytesWritten;
                onProgress(received / size, received, size, {
                  completed: completedChunks,
                  total: chunkCount,
                  missing: Math.max(0, chunkCount - completedChunks),
                  corrupted: corruptedChunks,
                  restored: restoredChunks,
                  duplicateBytes: 0,
                  savedBytes,
                });
                await paceBandwidth(bytesWritten, transferSignal);
              }
              recordHostSuccess(target.host, { bytes: end - start + 1 });
            } finally {
              clearTimeout(timeout);
              part?.body.destroy();
            }
          }
          // A range marker is published only after the body ends and every byte is written.
          await checkpoint?.commit(start);
          completedChunks++;
        }
      } catch (error) {
        recordHostFailure(target.host);
        controller.abort(error);
        throw error;
      } finally {
        await writer?.close();
      }
    };
    const results = await Promise.allSettled(Array.from({length:connections}, worker));
    transferSignal.throwIfAborted();
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return destination;
  } catch (error) {
    if (created) await rm(file, {force:true, maxRetries:5});
    signal.throwIfAborted();
    if (error.code === 'ENOSPC') throw new ApiError('NO_SPACE', 'The output volume has run out of space', 507);
    if (error instanceof ApiError && (exactSource || ['DRM', 'INVALID_MEDIA_CONTENT', 'MEDIA_ACCESS_RESTRICTED', 'STREAM_EXPIRED', 'NO_SPACE'].includes(error.code))) {
      throw error;
    }
    return null;
  } finally {
    clearTimeout(deadline);
    probe.abort();
  }
}
