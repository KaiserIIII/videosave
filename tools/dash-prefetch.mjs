import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { dashPlan, dashQualitiesFromXml } from './dash-manifest.mjs';
import { ApiError, FFMPEG, probeStream, runMedia, streamExpiry } from './media-source.mjs';
import { createRequestContext } from './request-context.mjs';
import { assertValidSegment, inspectMediaFile } from './media-inspector.mjs';

const manifestLimit = 1024 * 1024;
const maxParts = 10_000;
const maxBytes = 64 * 1024 ** 3;
const accessDenied = new Set([401, 402, 403, 407, 429, 451]);
const transientStatuses = new Set([408, 500, 502, 503, 504]);
const transientSockets = new Set(['EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT']);
const redirects = new Set([301, 302, 303, 307, 308]);

function transferFailure(message = 'An eligible DASH resource could not be staged', retryable = false) {
  return Object.assign(new ApiError('DASH_TRANSFER_FAILED', message, 502), { retryable });
}

async function readBounded(body, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw transferFailure('A DASH document or index exceeded the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function fileSha256(filePath) {
  const bytes = await readFile(filePath);
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function copyCompletedPart(source, target, temporary) {
  try {
    await link(source, target);
  } catch (error) {
    if (!['ENOTSUP', 'ENOSYS', 'EPERM', 'EOPNOTSUPP', 'EEXIST'].includes(error.code)) throw error;
    await copyFile(source, temporary);
    await rename(temporary, target);
  }
}

export function localDashRequest(source, cookies, headers, requestContext) {
  const ctx = requestContext ?? createRequestContext({ origin: source.origin, headers, cookies });
  return async (url, { signal, range, kind = 'segment' }) => {
    for (let hop = 0; hop <= 3; hop++) {
      if (url.origin !== source.origin || url.username || url.password || url.hash) {
        throw new ApiError('DASH_RESOURCE_SCOPE', 'A DASH resource is outside the selected manifest origin', 403);
      }
      const response = await fetch(url, {
        signal,
        redirect: 'manual',
        headers: ctx.headersFor(url, { phase: kind, range }),
      });
      if (!redirects.has(response.status)) return { url, response };
      await response.body?.cancel();
      const location = response.headers.get('location');
      url = location && URL.parse(location, url);
      if (!url || hop === 3) break;
    }
    throw new ApiError('DASH_RESOURCE_REDIRECT', 'A DASH resource returned an invalid redirect', 403);
  };
}

export async function dashQualities(source, cookies, signal, headers, requestContext) {
  try {
    const fetchResource = localDashRequest(source, cookies, headers, requestContext);
    const opened = await resourceResponse({ urls: [source], kind: 'manifest' }, fetchResource, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
    const body = await readBounded(opened.response.body, manifestLimit);
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return dashQualitiesFromXml(xml, opened.url);
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

async function resourceResponse(part, fetchResource, signal) {
  let failure;
  for (const url of part.urls) {
    if (Date.parse(streamExpiry(url)) <= Date.now()) {
      failure = new ApiError('STREAM_EXPIRED', 'The observed media URL has expired', 410);
      continue;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const deadline = AbortSignal.timeout(part.kind === 'segment' ? 60_000 : 15_000);
      const requestSignal = AbortSignal.any([signal, deadline]);
      let opened;
      try {
        opened = await fetchResource(url, { kind: part.kind, range: part.range, signal: requestSignal });
      } catch (error) {
        signal.throwIfAborted();
        if (!deadline.aborted && !(error instanceof TypeError) && !error.retryable && !transientSockets.has(error.code)) throw error;
        failure = transferFailure(undefined, true);
        if (!attempt) await sleep(150, undefined, { signal });
        continue;
      }
      const response = opened.response ?? opened;
      const resolved = opened.url instanceof URL ? opened.url : url;
      const { status, headers, body } = response;
      if (response.redirected || !/^https?:$/.test(resolved.protocol) || resolved.username || resolved.password || resolved.hash) {
        await body?.cancel();
        throw new ApiError('MCP_MEDIA_REDIRECT', 'The DASH request policy did not approve the redirect', 403);
      }
      if (headers.get('cf-mitigated') === 'challenge' || accessDenied.has(status)) {
        await body?.cancel();
        throw new ApiError('MEDIA_ACCESS_RESTRICTED', 'The media server denied access to a DASH resource', 403, { status, phase: part.kind });
      }
      if (status >= 300 && status < 400) {
        await body?.cancel();
        throw new ApiError('MCP_MEDIA_REDIRECT', 'The DASH request policy did not approve the redirect', 403);
      }
      if (status === (part.range ? 206 : 200) && body) {
        const encoding = headers.get('content-encoding');
        const rawLength = headers.get('content-length');
        const length = rawLength === null ? null : Number(rawLength);
        if ((!encoding || encoding === 'identity' || part.kind === 'manifest') &&
            (length === null || Number.isSafeInteger(length) && length > 0 && length <= maxBytes)) {
          if (!part.range) return { url: resolved, response, length, requestSignal };
          const { start, end } = part.range;
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') ?? '');
          const total = Number(range?.[3]);
          const expected = end - start + 1;
          if (range && Number(range[1]) === start && Number(range[2]) === end && Number.isSafeInteger(total) && total > end &&
              (length === null || length === expected)) return { url: resolved, response, length: expected, requestSignal };
        }
        await body.cancel();
        throw transferFailure('A DASH resource did not match its requested byte range or encoding');
      }
      await body?.cancel();
      if (status === 410) failure = new ApiError('STREAM_EXPIRED', 'The observed media URL has expired', 410);
      else failure = transferFailure(undefined, transientStatuses.has(status));
      if (!transientStatuses.has(status)) break;
      if (!attempt) await sleep(150, undefined, { signal });
    }
  }
  throw failure ?? transferFailure(undefined, true);
}

function indexSegments(bytes, start, urls) {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || offset + size > bytes.length) break;
    if (bytes.toString('ascii', offset + 4, offset + 8) !== 'sidx') {
      offset += size;
      continue;
    }
    const box = bytes.subarray(offset, offset + size);
    const version = box[8];
    const countAt = version === 0 ? 30 : 38;
    if (version !== 0 && version !== 1 || size < countAt + 2 || box.readUInt32BE(16) === 0) break;
    const firstOffset = version === 0 ? box.readUInt32BE(24) : Number(box.readBigUInt64BE(28));
    let first = start + offset + size + firstOffset;
    const count = box.readUInt16BE(countAt);
    if (!count || count > maxParts || countAt + 2 + count * 12 !== size) break;
    const parts = [];
    for (let position = countAt + 2; position < size; position += 12) {
      const reference = box.readUInt32BE(position);
      const end = first + reference - 1;
      if (!reference || reference >= 0x80000000 || !Number.isSafeInteger(end + 1)) {
        throw transferFailure('The DASH index contains an unsupported segment reference');
      }
      parts.push({ kind: 'segment', urls, range: { start: first, end } });
      first = end + 1;
    }
    return parts;
  }
  throw transferFailure('The DASH segment index is invalid or unsupported');
}

async function savePart(part, file, fetchResource, signal, onBytes, expectedKind = null) {
  const { response, length, requestSignal } = await resourceResponse(part, fetchResource, signal);
  let transferred = 0;
  await pipeline(response.body, async function* (chunks) {
    for await (const chunk of chunks) {
      transferred += chunk.byteLength;
      if (length !== null && transferred > length) throw transferFailure();
      onBytes(chunk.byteLength);
      yield chunk;
    }
  }, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: requestSignal });
  if (!transferred || length !== null && transferred !== length) throw transferFailure('A DASH resource body was incomplete', true);
  if (expectedKind) {
    const inspection = await inspectMediaFile(file, { expected: expectedKind });
    assertValidSegment(inspection, { code: 'INVALID_DASH_SEGMENT', message: 'DASH 分片内容校验失败' });
  }
}

async function joinParts(parts, file, signal) {
  const readable = async function* () {
    for (const part of parts) {
      yield* createReadStream(part, { signal });
      await rm(part);
    }
  };
  await pipeline(readable(), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
}

function verifyTrackLayout(expected, actual) {
  const need = expected.map(track => track.type);
  const have = actual.map(track => track.codec_type);
  if (have.length !== need.length || need.some((type, index) => have[index] !== type)) {
    throw new ApiError('INCOMPLETE_OUTPUT', 'The staged DASH file is missing an expected track', 502);
  }
}

const ffmpeg = (args, signal) => runMedia(FFMPEG, ['-nostdin', '-v', 'error', ...args], signal, undefined, { strict: true });

async function verifyClearMp4(file, signal) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let foundMetadata = false;
    let boxes = 0;
    for (let position = 0; position + 8 <= size;) {
      signal.throwIfAborted();
      if (++boxes > maxParts * 8) throw transferFailure('The DASH media exceeded the container box limit');
      const { bytesRead } = await handle.read(header, 0, Math.min(header.length, size - position), position);
      if (bytesRead < 8) break;
      const length32 = header.readUInt32BE();
      if (length32 === 1 && bytesRead < 16) break;
      const length = length32 === 0 ? size - position : length32 === 1 ? Number(header.readBigUInt64BE(8)) : length32;
      const headerBytes = length32 === 1 ? 16 : 8;
      if (!Number.isSafeInteger(length) || length < headerBytes || length > size - position) break;
      const type = header.toString('ascii', 4, 8);
      if (type === 'pssh') throw new ApiError('DRM', 'The DASH media declares protected ISOBMFF content', 422);
      if (type === 'moov') {
        if (foundMetadata || length > 32 * 1024 * 1024) throw transferFailure('The DASH initialization metadata exceeded the size limit');
        const metadata = Buffer.alloc(length);
        if ((await handle.read(metadata, 0, length, position)).bytesRead !== length) break;
        for (const tag of ['pssh', 'sinf', 'encv', 'enca', 'tenc']) {
          for (let at = metadata.indexOf(tag, 4); at !== -1; at = metadata.indexOf(tag, at + 4)) {
            const boxSize = metadata.readUInt32BE(at - 4);
            if (boxSize >= 8 && at - 4 + boxSize <= length) throw new ApiError('DRM', 'The DASH media declares protected ISOBMFF content', 422);
          }
        }
        foundMetadata = true;
      }
      position += length;
      if (position === size && foundMetadata) return;
    }
    throw transferFailure('The DASH media lacks complete ISOBMFF initialization metadata');
  } finally { await handle.close(); }
}

async function muxPeriod(tracks, files, output, signal) {
  for (const [index, track] of tracks.entries()) if (track.extension === 'mp4') await verifyClearMp4(files[index], signal);
  const inputs = tracks.flatMap(({ extension, offset }, index) => [
    ...(offset ? ['-itsoffset', String(-offset)] : []),
    '-protocol_whitelist', 'file', '-f', extension === 'mp4' ? 'mov' : extension === 'vtt' ? 'webvtt' : 'srt',
    ...(extension === 'mp4' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-i', files[index],
  ]);
  const outputs = tracks.flatMap(({ type, language }, index) => [
    '-map', index + ':' + { video: 'v', audio: 'a', subtitle: 's' }[type] + ':0',
    ...(language ? ['-metadata:s:' + index, 'language=' + language] : []),
  ]);
  await ffmpeg(['-copyts', ...inputs, ...outputs, '-c', 'copy',
    ...(tracks.some(track => track.type === 'subtitle') ? ['-c:s', 'srt'] : []), '-avoid_negative_ts', 'disabled', output], signal);
  const info = await probeStream(output, [], signal, true);
  verifyTrackLayout(tracks, info.tracks ?? []);
  return info;
}

export async function prefetchDash(source, staging, signal, onProgress, {
  quality, connections = 8, subtitles = false, fetchResource, recovery, onQualityNegotiated,
} = {}) {
  if (typeof fetchResource !== 'function') throw new TypeError('DASH staging requires a resource request policy');
  const opened = await resourceResponse({ urls: [source], kind: 'manifest' }, fetchResource, signal);
  const body = await readBounded(opened.response.body, manifestLimit);
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new ApiError('DASH_INVALID_MANIFEST', 'The DASH playlist must be valid UTF-8 XML', 422); }
  let periods;
  try { periods = dashPlan(xml, opened.url, { quality, subtitles, onQualityNegotiated }); }
  catch (error) {
    if (error.detail?.legacyCompatible && opened.url.href !== source.href) delete error.detail.legacyCompatible;
    throw error;
  }
  let checkpoint = null;
  if (recovery) {
    const digest = createHash('sha256').update(JSON.stringify([opened.url.origin + opened.url.pathname, xml, quality ?? null, subtitles])).digest('hex');
    checkpoint = path.join(recovery, 'dash-' + digest);
    await mkdir(checkpoint, { recursive: true, mode: 0o700 });
    if (!(await lstat(checkpoint)).isDirectory()) throw new Error('Invalid DASH checkpoint directory');
  }
  const directory = path.join(staging, 'dash');
  const output = path.join(staging, 'dash-source.mkv');
  await mkdir(directory, { mode: 0o700 });
  const controller = new AbortController();
  const transferSignal = AbortSignal.any([signal, controller.signal]);
  let bytes = 0;
  let totalParts = 0;
  let completed = 0;
  let restored = 0;
  const periodFiles = [];
  let complete = false;

  async function transferJobs(jobs) {
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(jobs.length, Math.max(1, Math.min(8, connections))) }, async () => {
      try {
        while (next < jobs.length) {
          transferSignal.throwIfAborted();
          const { part, file, checkpointName, expectedKind } = jobs[next++];
          const checkpointFile = checkpoint && path.join(checkpoint, checkpointName);
          const checksumFile = checkpointFile && (checkpointFile + '.sha256');
          let reused = false;
          if (checkpointFile) {
            const saved = await lstat(checkpointFile).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
            if (saved?.isFile() && saved.size > 0) {
              let intact = true;
              try {
                const expectedMeta = await readFile(checksumFile, 'utf8').then(JSON.parse).catch(() => null);
                if (!expectedMeta) intact = false;
                else {
                  const actual = await fileSha256(checkpointFile);
                  if (actual.size !== expectedMeta.size || actual.sha256 !== expectedMeta.sha256) intact = false;
                }
                if (intact && part.kind === 'init') await verifyClearMp4(checkpointFile, transferSignal);
              } catch {
                intact = false;
              }
              if (intact) {
                await copyCompletedPart(checkpointFile, file, file + '.restore');
                bytes += saved.size;
                reused = true;
                restored++;
              } else {
                await Promise.allSettled([rm(checkpointFile, { force: true }), rm(checksumFile, { force: true })]);
              }
            }
          }
          if (!reused) {
            await savePart(part, file, fetchResource, transferSignal, count => {
              bytes += count;
              if (bytes > maxBytes) throw transferFailure('The DASH presentation exceeded the staging size limit');
            }, expectedKind);
            if (part.kind === 'init') await verifyClearMp4(file, transferSignal);
            if (checkpointFile) {
              transferSignal.throwIfAborted();
              const meta = await fileSha256(file);
              await copyCompletedPart(file, checkpointFile, file + '.checkpoint');
              await writeFile(checksumFile, JSON.stringify(meta), { mode: 0o600 });
            }
          }
          completed++;
          onProgress(completed / totalParts, bytes, null, { completed, total: totalParts, restored });
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }));
    if (results.some(result => result.status === 'rejected')) throw transferSignal.reason;
  }

  try {
    for (const { tracks } of periods) {
      for (const track of tracks) {
        if (track.index) {
          const { response, url, length } = await resourceResponse(track.index, fetchResource, transferSignal);
          const index = await readBounded(response.body, manifestLimit);
          if (index.byteLength !== length) throw transferFailure();
          track.parts = indexSegments(index, track.index.range.start, [url]);
        }
        if (track.init) track.parts.unshift(track.init);
        totalParts += track.parts.length;
        if (totalParts > maxParts) throw transferFailure('The DASH presentation exceeded the segment count limit');
      }
    }
    let firstInfo;
    for (const [periodIndex, { tracks, duration }] of periods.entries()) {
      const prefix = path.join(directory, 'period-' + periodIndex);
      const trackFiles = tracks.map(({ extension }, index) => prefix + '-track-' + index + '.' + extension);
      const partFiles = tracks.map(({ parts }, index) => parts.map((_, part) => trackFiles[index] + '-' + part + '.part'));
      const jobs = tracks.flatMap(({ parts, extension }, index) => parts.map((part, position) => ({
        part,
        file: partFiles[index][position],
        checkpointName: `p${periodIndex}-t${index}-s${position}.part`,
        expectedKind: extension === 'vtt' ? 'webvtt' : extension === 'mp4' ? (part.kind === 'init' ? 'fmp4-init' : 'fmp4') : null,
      })));
      await transferJobs(jobs.filter(({ part }) => part.kind === 'init'));
      await transferJobs(jobs.filter(({ part }) => part.kind !== 'init'));
      for (const [index, file] of trackFiles.entries()) await joinParts(partFiles[index], file, transferSignal);
      const periodFile = periods.length === 1 ? output : prefix + '.mkv';
      const info = await muxPeriod(tracks, trackFiles, periodFile, transferSignal);
      if (duration && (!info.duration || info.duration + Math.max(0.25, duration * 0.02) < duration)) {
        throw new ApiError('INCOMPLETE_OUTPUT', 'The staged DASH period is shorter than its declared duration', 502);
      }
      const signature = info.tracks.map(({ codec_type, codec_name, width, height }, index) =>
        JSON.stringify([codec_type, codec_name, width, height, tracks[index].language])).join(';');
      if (firstInfo !== undefined && firstInfo !== signature) {
        throw new ApiError('DASH_UNSUPPORTED', 'DASH periods change their media track layout', 422);
      }
      firstInfo = signature;
      periodFiles.push(periodFile);
      for (const file of trackFiles) await rm(file);
    }
    if (periodFiles.length > 1) {
      const concat = path.join(directory, 'periods.ffconcat');
      await writeFile(concat, 'ffconcat version 1.0\n' + periodFiles.map(file => 'file ' + path.basename(file)).join('\n') + '\n',
        { mode: 0o600, flag: 'wx', signal: transferSignal });
      await ffmpeg(['-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', concat, '-map', '0', '-c', 'copy', output], transferSignal);
      verifyTrackLayout(periods[0].tracks, (await probeStream(output, [], transferSignal, true)).tracks ?? []);
    }
    complete = true;
    return output;
  } catch (error) {
    if (checkpoint && error.retryable && !signal.aborted) {
      throw new ApiError('DASH_TRANSFER_INTERRUPTED', 'DASH transfer interrupted. Resubmit the original batch to resume.', 503);
    }
    if (error.code === 'ENOSPC') throw new ApiError('NO_SPACE', 'The output volume has run out of space', 507);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    if (!complete) await rm(output, { force: true }).catch(() => {});
  }
}
