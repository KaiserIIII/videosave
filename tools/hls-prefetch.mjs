import { createHash } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { httpUrl, parseManifest, rankRenditions, readManifest, selectRendition } from '../extension/hls.mjs';
import { prefetchRanges } from './range-prefetch.mjs';
import { ApiError } from './media-source.mjs';

const segmentWorkers = 8;
const segmentConnectMs = 12_000;
const segmentIdleMs = 8_000;
const tailDelayMs = 2_000;
const queuedBackupDelayMs = 4_000;
const strongEtag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const transientStatuses = new Set([408, 500, 502, 503, 504]);
const rateLimits = new Map();

function rateLimited(retryAfterSec) {
  return new ApiError('RATE_LIMITED','媒体服务器要求降低请求频率',429,{status:429,retryAfterSec});
}

function checkHlsProtection(content) {
  for (const line of content.split(/\r?\n/)) {
    const attributes = /^\s*#EXT-X-(?:SESSION-)?KEY:(.*)$/.exec(line)?.[1];
    if (attributes && (/(?:^|,)\s*METHOD=SAMPLE-AES(?:-CTR)?\s*(?:,|$)/i.test(attributes) ||
        /(?:^|,)\s*KEYFORMAT="(?:com\.(?:apple\.streamingkeydelivery|widevine|microsoft\.playready)[^"]*|urn:uuid:(?:edef8ba9|9a04f079)[^"]*)"/i.test(attributes))) {
      throw new ApiError('DRM','媒体清单标记为 DRM 保护',422);
    }
  }
}

export async function checkManifestProtection(source, cookies, signal, {kind,quality,headers}) {
  const cookie = cookies.map(({name,value}) => name + '=' + value).join('; ');
  const budget = AbortSignal.any([signal,AbortSignal.timeout(5000)]);
  const inspect = async url => {
    const {url:resolved,response} = await request(url,source.origin,cookie,budget,undefined,headers);
    const content = await readManifest(response.body);
    if (kind === 'mpd') {
      const drm = /<ContentProtection\b[^>]*\bschemeIdUri\s*=\s*["'](?:urn:uuid:(?:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95)|urn:mpeg:dash:mp4protection:2011)["']/i;
      if (drm.test(content)) throw new ApiError('DRM','媒体清单标记为 DRM 保护',422);
    } else checkHlsProtection(content);
    return {resolved,content};
  };
  try {
    const {resolved,content} = await inspect(source);
    const rendition = kind === 'm3u8' && selectRendition(content,resolved,quality);
    if (rendition) await Promise.all([inspect(rendition.video),rendition.audio && inspect(rendition.audio)]);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
  }
}

async function copyCompletedPart(source, target, temporary) {
  try {
    await link(source,target);
  } catch (error) {
    if (!['ENOTSUP','ENOSYS','EPERM','EOPNOTSUPP'].includes(error.code)) throw error;
    await copyFile(source,temporary);
    await rename(temporary,target);
  }
}

function assertManagedOrigin(url, origin, approvedEntry = false) {
  if (url.origin !== origin || url.search && !approvedEntry || url.hash || url.username || url.password) {
    throw new ApiError('MCP_MEDIA_SCOPE','An HLS resource falls outside the approved site scope',403);
  }
}

async function request(url, origin, cookies, signal, range, headers, restrictedOrigin = false, approvedEntry = false, transport,
  hlsPhase = 'playlist') {
  if (restrictedOrigin && !transport) assertManagedOrigin(url,origin,approvedEntry);
  for (let hop = 0; hop < 5; hop++) {
    const host = url.host;
    const until = rateLimits.get(host);
    if (until > Date.now()) throw rateLimited(Math.ceil((until - Date.now()) / 1000));
    if (until !== undefined) rateLimits.delete(host);
    const ranged = range && (!range.url || range.url === url.href);
    const response = await (transport ? transport.fetchResource(url,{signal,range:ranged ? range : undefined}).then(result => {
      url = result.url;
      return result.response;
    }) : fetch(url, {
      redirect: 'manual',
      headers: {
        ...headers,
        'accept-encoding':'identity',
        ...(cookies && url.origin === origin && {cookie:cookies}),
        ...(ranged && {range:`bytes=${range.start}-${range.end}`, ...(range.etag && {'if-range':range.etag})}),
      },
      signal,
    })).catch(error => {
      if (error instanceof ApiError) throw error;
      throw Object.assign(new Error('HLS connection interrupted', {cause:error}), {retryable:true});
    });
    if (response.headers.get('cf-mitigated') === 'challenge') {
      await response.body?.cancel();
      throw new ApiError(restrictedOrigin ? 'MCP_MEDIA_ACCESS_RESTRICTED' : 'MEDIA_ACCESS_RESTRICTED',
        'The media server returned a browser challenge',403,{status:response.status,hlsPhase});
    }
    if (response.body && (response.status === 200 || ranged && response.status === 206)) return {url, response};
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (restrictedOrigin && [301,302,303,307,308].includes(response.status)) {
      throw new ApiError('MCP_MEDIA_REDIRECT','An approved HLS resource redirected',403);
    }
    if ([401,402,403,451].includes(response.status)) {
      throw new ApiError(restrictedOrigin ? 'MCP_MEDIA_ACCESS_RESTRICTED' : 'MEDIA_ACCESS_RESTRICTED',
        'The media server denied access to an HLS resource',403,{status:response.status,hlsPhase});
    }
    if (response.status === 410) {
      throw new ApiError('STREAM_EXPIRED','The HLS resource is no longer available. Re-probe the original page.',410,{status:410,hlsPhase});
    }
    if (![301,302,303,307,308].includes(response.status) || !location) {
      if (response.status === 429) {
        const value = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(value ?? '') ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
        const retryAfterSec = Number.isSafeInteger(seconds) ? Math.max(0,seconds) : 5;
        const retryAt = Math.max(rateLimits.get(host) ?? 0,Date.now() + retryAfterSec * 1000);
        if (!rateLimits.has(host) && rateLimits.size >= 256) rateLimits.delete(rateLimits.keys().next().value);
        rateLimits.set(host,retryAt);
        throw rateLimited(Math.ceil((retryAt - Date.now()) / 1000));
      }
      const restart = ranged && response.status === 416;
      throw Object.assign(new Error('HLS response unavailable for parallel download'), {
        status:response.status,
        retryable:restart || transientStatuses.has(response.status), restart,
      });
    }
    url = httpUrl(location, url);
    if (!url) break;
  }
  throw new Error('HLS response unavailable for parallel download');
}

async function readKey(body) {
  const key = Buffer.alloc(16);
  let size = 0;
  for await (const chunk of body) {
    if (size + chunk.byteLength > key.length) throw new Error('Invalid HLS AES-128 key length');
    key.set(chunk, size);
    size += chunk.byteLength;
  }
  if (size !== key.length) throw new Error('Invalid HLS AES-128 key length');
  return key;
}

export async function hlsQualities(source, cookies, signal, headers) {
  const cookieHeader = cookies.map(({name,value}) => name + '=' + value).join('; ');
  try {
    const {url,response} = await request(source, source.origin, cookieHeader, AbortSignal.any([signal,AbortSignal.timeout(5000)]),undefined,headers);
    const [header,...lines] = (await readManifest(response.body)).trim().split(/\r?\n/).map(line => line.trim());
    if (header !== '#EXTM3U') return [];
    return lines.flatMap((line,index) => {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) return [];
      const next = lines[index + 1];
      const variant = next && !next.startsWith('#') && httpUrl(next,url);
      const height = Number(/(?:[:,])RESOLUTION=\d+x(\d+)/.exec(line)?.[1]);
      const bitrate = Number(/(?:[:,])BANDWIDTH=(\d+)/.exec(line)?.[1]);
      return variant && height && bitrate ? [{height,bitrate,bandwidth:bitrate,url:variant.href}] : [];
    }).sort((a,b) => b.height - a.height || b.bitrate - a.bitrate);
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

async function checkTransportStream(file) {
  const part = await open(file,'r');
  try {
    const packetHeaders = Buffer.alloc(377);
    const {bytesRead} = await part.read(packetHeaders,0,packetHeaders.length,0);
    if (bytesRead !== packetHeaders.length || [0,188,376].some(index => packetHeaders[index] !== 0x47)) {
      throw new ApiError('INVALID_HLS_SEGMENT','The HLS resource did not contain MPEG-TS packets',422);
    }
  } finally {
    await part.close();
  }
}

async function checkStagingSpace(directory, rendition, playlist) {
  if (!rendition) return;
  const duration = Array.from(playlist.matchAll(/^#EXTINF:([\d.]+),/gm),entry => Number(entry[1]))
    .reduce((total,seconds) => total + seconds,0);
  const estimate = Math.ceil(duration * rendition.bandwidth / 8);
  if (!Number.isSafeInteger(estimate) || estimate <= 0) return;
  const space = await statfs(directory).catch(() => null);
  const requiredBytes = Math.ceil(estimate * 1.5);
  if (space && space.bavail * space.bsize < requiredBytes) {
    throw new ApiError('NO_SPACE','The output volume has insufficient space for this HLS download',507,
      {requiredBytes,freeBytes:space.bavail * space.bsize});
  }
}

async function downloadSegment(url, destination, origin, cookies, signal, onBytes, slice, headers, restrictedOrigin, transport, attempts = 3) {
  let offset = 0;
  let resume;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    const abortStalled = () => controller.abort(new Error('HLS segment stopped responding'));
    let timeout = setTimeout(abortStalled, segmentConnectMs);
    let reader;
    let output;
    try {
      const range = resume && offset > 0 && offset < resume.size
        ? {url:resume.url, start:(slice?.start ?? 0) + offset, end:slice?.end ?? resume.size - 1, etag:resume.etag}
        : slice;
      const {url: finalUrl, response} = await request(url, origin, cookies, requestSignal, range, headers, restrictedOrigin,false,transport,'segment');
      clearTimeout(timeout);
      reader = response.body.getReader();
      const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? 'identity';
      const length = response.headers.get('content-length');
      const etag = response.headers.get('etag');
      let expected;
      if (response.status === 200) {
        if (slice) {
          throw Object.assign(new Error('HLS segment range unavailable'), {retryable:Boolean(range.etag), restart:true});
        }
        offset = 0;
        const size = Number(length);
        resume = encoding === 'identity' && Number.isSafeInteger(size) && size > 0 && strongEtag.test(etag) &&
          response.headers.get('accept-ranges')?.toLowerCase() === 'bytes' ? {url:finalUrl.href, size, total:size, etag} : undefined;
        expected = resume?.size;
      } else {
        const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range'));
        const total = Number(contentRange?.[3]);
        if (encoding !== 'identity' || !Number.isSafeInteger(total) || total <= range.end ||
            Number(contentRange[1]) !== range.start || Number(contentRange[2]) !== range.end ||
            (range.etag && (etag !== range.etag || total !== resume.total)) ||
            (length !== null && Number(length) !== range.end - range.start + 1)) {
          throw Object.assign(new Error('Unexpected HLS segment range'), {retryable:true, restart:true});
        }
        slice?.validate(total, strongEtag.test(etag) ? etag : null);
        expected = range.end - (slice?.start ?? 0) + 1;
        resume = strongEtag.test(etag) ? {url:finalUrl.href, size:expected, total, etag} : undefined;
      }
      const totalBytes = encoding === 'identity' && length !== null ? (expected ?? Number(length)) : expected;
      output = await open(destination, offset ? 'r+' : 'w');
      timeout = setTimeout(abortStalled, segmentIdleMs);
      while (true) {
        const {done, value} = await reader.read().catch(error => {
          throw Object.assign(new Error('HLS segment interrupted', {cause:error}), {retryable:true});
        });
        if (done) break;
        timeout.refresh();
        if (expected !== undefined && offset + value.byteLength > expected) {
          throw Object.assign(new Error('HLS segment exceeded its declared size'), {retryable:true, restart:true});
        }
        signal.throwIfAborted();
        const {bytesWritten} = await output.write(value, 0, value.byteLength, offset);
        if (bytesWritten !== value.byteLength) throw new Error('Could not write the complete HLS segment chunk');
        offset += bytesWritten;
        onBytes(offset, totalBytes);
      }
      if (!offset || expected !== undefined && offset !== expected) {
        throw Object.assign(new Error('Incomplete HLS segment'), {retryable:true});
      }
      return;
    } catch (error) {
      signal.throwIfAborted();
      // A temporarily missing segment can recover without restarting the whole playlist.
      if (!(error.retryable || error.status === 404) || attempt + 1 >= attempts) throw error;
      if (error.restart || !resume || offset >= resume.size) {
        resume = undefined;
        offset = 0;
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await reader?.cancel().catch(() => {});
      await output?.close();
    }
    await sleep(150 * (attempt + 1), undefined, {signal});
  }
}

export async function prefetchHls(source, cookies, staging, signal, onProgress, {
  quality, sourceKind, connections = segmentWorkers, recovery, headers, onFallback, onSegmentsStored,
  restrictedOrigin = false, signedEntry = false, transport,
} = {}) {
  if (sourceKind !== 'm3u8' && !/\.m3u8$/i.test(source.pathname)) return null;
  const cookieHeader = cookies.map(({ name, value }) => name + '=' + value).join('; ');
  const controller = new AbortController();
  const transferSignal = AbortSignal.any([signal, controller.signal]);
  const directory = path.join(staging, 'segments');
  let directoryCreated = false;
  try {
    const read = async (url, readBody = readManifest, approvedEntry = false, hlsPhase = 'playlist') => {
      for (let attempt = 0; ; attempt++) {
        const deadline = AbortSignal.timeout(5000);
        try {
          const resource = await request(url, source.origin, cookieHeader, AbortSignal.any([transferSignal, deadline]),
            undefined,headers,restrictedOrigin,approvedEntry,transport,hlsPhase);
          return {url:resource.url, content:await readBody(resource.response.body)};
        } catch (error) {
          transferSignal.throwIfAborted();
          if (attempt || !(error.retryable || deadline.aborted || error instanceof TypeError)) throw error;
          await sleep(150, undefined, {signal:transferSignal});
        }
      }
    };
    const first = await read(source,readManifest,signedEntry);
    checkHlsProtection(first.content);
    let rendition, sound;
    let selected = first;
    const renditions = rankRenditions(first.content,first.url,quality).slice(0,4);
    for (const [index, candidate] of renditions.entries()) {
      if (!candidate) break;
      try {
        selected = await read(candidate.video);
        rendition = candidate;
        break;
      } catch (error) {
        if (error.status !== 404 || index === renditions.length - 1) throw error;
      }
    }
    if (rendition?.audio) sound = await read(rendition.audio);
    if (rendition) checkHlsProtection(selected.content);
    if (sound) checkHlsProtection(sound.content);
    const parseOptions = {byteRanges:true,aes128:true,sniffTransport:true};
    const video = parseManifest(selected.content, selected.url, 'video', parseOptions);
    const audio = sound && parseManifest(sound.content, sound.url, 'audio', parseOptions);
    if (!video || sound && !audio) {
      onFallback?.({reason:'unsupported-hls-playlist'});
      return null;
    }
    await checkStagingSpace(staging,rendition,video.playlist);
    const segments = video.segments.concat(audio?.segments || []);
    const keys = [...(video.keys ?? []),...(audio?.keys ?? [])];
    if (restrictedOrigin) {
      for (const resource of [...segments,...keys]) {
        if (transport) transport.assertUrl(resource.url);
        else assertManagedOrigin(resource.url,source.origin);
      }
    }
    await mkdir(directory);
    directoryCreated = true;

    const runWorkers = async (count, work) => {
      const results = await Promise.allSettled(Array.from({length:count}, async () => {
        try { await work(); }
        catch (error) { controller.abort(error); throw error; }
      }));
      if (results.some(result => result.status === 'rejected')) throw transferSignal.reason;
    };
    const keyHashes = new Map();
    if (keys.length) {
      let nextKey = 0;
      await runWorkers(Math.min(connections, keys.length), async () => {
        while (nextKey < keys.length) {
          const {url, filename} = keys[nextKey++];
          const {content} = await read(url,readKey,false,'key');
          await writeFile(path.join(directory, filename), content, {mode:0o600,flag:'wx',signal:transferSignal});
          keyHashes.set(filename,createHash('sha256').update(content).digest('hex'));
        }
      });
    }
    const firstPart = segments[0];
    const sharedFile = !audio && firstPart.filename.endsWith('.mp4') &&
      segments.every((part, index) => part.range && part.url.href === firstPart.url.href &&
        part.range.start === (index === 0 ? 0 : segments[index - 1].range.end + 1) &&
        (index === 0 || part.filename.endsWith('.m4s')));
    if (sharedFile) {
      // Only use the complete file when the manifest covers every byte in playback order.
      const expectedSize = segments.at(-1).range.end + 1;
      const scopedCookies = firstPart.url.origin === source.origin ? cookies : [];
      const file = await prefetchRanges(firstPart.url, scopedCookies, directory, transferSignal, onProgress,
        {connections,expectedSize,recovery,headers,exactSource:restrictedOrigin,transport});
      if (file) return file;
    }
    // A ranged representation needs validators shared across all parts of that representation.
    let checkpoint;
    if (recovery && segments.every(segment => !segment.range)) {
      const identity = [selected.url.href,selected.content,sound?.url.href,sound?.content,keys.map(({filename}) => keyHashes.get(filename))];
      const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      checkpoint = path.join(recovery,'segments-' + digest);
      await mkdir(checkpoint,{recursive:true,mode:0o700});
      if (!(await lstat(checkpoint)).isDirectory()) throw new Error('Invalid HLS checkpoint directory');
    }
    let next = 0;
    let finished = 0;
    let received = 0;
    const workers = Math.min(connections, segments.length);
    const active = new Set();
    const representations = new Map();
    let backupTimer;
    let backupDue;
    let backupInFlight = false;
    let nextBackupCheck = 0;
    let lastQueuedBackup = -Infinity;

    function scheduleBackup(checkNow = false) {
      if (transferSignal.aborted || backupInFlight || !active.size) return;
      const atTail = next === segments.length && active.size < workers;
      const hasBacklog = next < segments.length && active.size === workers && workers >= 4;
      if (!atTail && !hasBacklog) return;
      const candidates = [...active].filter(segment => !segment.backup);
      if (!candidates.length) return;
      const now = performance.now();
      const delay = atTail ? tailDelayMs : queuedBackupDelayMs;
      const last = atTail && active.size === 1;
      if (last) candidates[0].tailSince ??= candidates[0].lastProgress;
      const earliest = Math.min(...candidates.map(segment => atTail
        ? segment.tailSince ?? segment.lastProgress : segment.startedAt));
      const due = Math.max(nextBackupCheck, (atTail ? earliest : Math.max(earliest, lastQueuedBackup)) + delay);
      if (!checkNow || now < due) {
        if (!backupTimer || due < backupDue) {
          clearTimeout(backupTimer);
          backupDue = due;
          backupTimer = setTimeout(() => {
            backupTimer = undefined;
            scheduleBackup(true);
          }, Math.max(1, Math.ceil(due - now)));
        }
        return;
      }
      const bestRate = hasBacklog ? Math.max(0, ...candidates.map(segment =>
        now - segment.startedAt >= tailDelayMs ? segment.bytes / (now - segment.startedAt) : 0)) : 0;
      let candidate;
      let worst = 0;
      for (const segment of candidates) {
        const elapsed = now - segment.startedAt;
        const idle = now - segment.lastProgress;
        const rate = segment.bytes / elapsed;
        // If every connection is progressing at a similar pace, another request would compete for the same bandwidth.
        const lagging = rate > 0 && rate * 3 < bestRate && segment.total > segment.bytes;
        const remaining = lagging ? (segment.total - segment.bytes) / rate : 0;
        const score = atTail ? now - (segment.tailSince ?? segment.lastProgress)
          : elapsed >= delay ? Math.max(idle, remaining) : 0;
        if (score >= delay && score > worst) { candidate = segment; worst = score; }
      }
      if (!candidate) {
        nextBackupCheck = now + 250;
        scheduleBackup();
        return;
      }
      if (!atTail) lastQueuedBackup = now;
      // Race one request at a time and keep both response bodies separate.
      backupInFlight = true;
      candidate.backup = downloadSegment(candidate.url, candidate.destination + '.backup', source.origin, cookieHeader,
        candidate.backupSignal, candidate.report, candidate.range, headers, restrictedOrigin, transport, 1).then(() => {
        candidate.primary.abort();
        return true;
      }, () => false).finally(() => {
        backupInFlight = false;
        scheduleBackup();
      });
    }

    async function transferSegment({url, filename, range:segmentRange, verifyTransport}) {
      const destination = path.join(directory, filename);
      const checkpointFile = checkpoint && path.join(checkpoint,filename);
      if (checkpointFile) {
        const saved = await lstat(checkpointFile).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (saved?.isFile() && saved.size > 0) {
          if (verifyTransport) await checkTransportStream(checkpointFile);
          await copyCompletedPart(checkpointFile,destination,destination + '.restore');
          received += saved.size;
          return true;
        }
      }
      const primary = new AbortController();
      const backup = new AbortController();
      const range = segmentRange && {...segmentRange, validate(total, etag) {
        const previous = representations.get(url.href);
        if (previous && (previous.total !== total || previous.etag !== etag)) {
          throw new Error('HLS byte ranges disagree on the source file');
        }
        if (!previous) representations.set(url.href, {total, etag});
      }};
      let highWater = 0;
      const report = offset => {
        if (offset <= highWater) return;
        received += offset - highWater;
        highWater = offset;
        onProgress(null, received);
      };
      const startedAt = performance.now();
      const segment = {url, destination, range, primary, backupSignal:AbortSignal.any([transferSignal, backup.signal]),
        report, startedAt, lastProgress:startedAt, bytes:0, total:0};
      active.add(segment);
      scheduleBackup();
      try {
        await downloadSegment(url, destination, source.origin, cookieHeader,
          AbortSignal.any([transferSignal, primary.signal]), (offset, total) => {
            segment.lastProgress = performance.now();
            segment.bytes = offset;
            segment.total = total;
            report(offset);
          }, range, headers, restrictedOrigin, transport);
      } catch (error) {
        if (!await segment.backup) throw error;
        transferSignal.throwIfAborted();
        await rename(destination + '.backup', destination);
      } finally {
        active.delete(segment);
        if (segment.backup) {
          backup.abort();
          await segment.backup;
          await rm(destination + '.backup', {force:true, maxRetries:5});
        }
      }
      if (verifyTransport) await checkTransportStream(destination);
      if (checkpointFile) {
        transferSignal.throwIfAborted();
        // Only publish a fully written and closed file into the checkpoint.
        await copyCompletedPart(destination,checkpointFile,destination + '.checkpoint');
      }
      return false;
    }

    try {
      let restored = 0;
      await runWorkers(workers, async () => {
        while (next < segments.length) {
          if (await transferSegment(segments[next++])) restored++;
          onProgress(++finished / segments.length,received,null,{completed:finished,total:segments.length,restored});
          scheduleBackup();
        }
      });
    } catch (error) {
      if (checkpoint && error.retryable && !signal.aborted) {
        const missing = [];
        for (const [index,{filename}] of segments.entries()) {
          const complete = await lstat(path.join(checkpoint,filename)).catch(() => null);
          if (!complete?.isFile() || !complete.size) missing.push(index);
        }
        await writeFile(path.join(checkpoint,'failed.json'),JSON.stringify({total:segments.length,missing}),{mode:0o600});
        throw new ApiError('HLS_TRANSFER_INTERRUPTED','HLS transfer interrupted. Resubmit the original batch to resume.',503,
          Number.isInteger(error.status) ? {status:error.status} : undefined);
      }
      throw error;
    } finally {
      clearTimeout(backupTimer);
    }
    const filename = path.join(directory, 'download.m3u8');
    if (audio) {
      await Promise.all([writeFile(path.join(directory,'video.m3u8'),video.playlist),
        writeFile(path.join(directory,'audio.m3u8'),audio.playlist)]);
      await writeFile(filename, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,URI="audio.m3u8"\n' +
        `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AUDIO="audio"\nvideo.m3u8\n`);
    } else {
      await writeFile(filename, video.playlist);
    }
    if (checkpoint && onSegmentsStored) {
      await rm(path.join(checkpoint,'failed.json'),{force:true});
      onSegmentsStored(checkpoint);
    }
    return filename;
  } catch (error) {
    controller.abort(error);
    if (directoryCreated) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    if (recovery && !directoryCreated && error.retryable) {
      throw new ApiError('HLS_TRANSFER_INTERRUPTED','HLS transfer interrupted. Resubmit the original batch to resume.',503,
        Number.isInteger(error.status) ? {status:error.status} : undefined);
    }
    if (error.code === 'ENOSPC') throw new ApiError('NO_SPACE','The output volume has run out of space',507);
    onFallback?.(Number.isInteger(error?.status) ? {reason:'hls-http-error',status:error.status}
      : {reason:'hls-transfer-failed'});
    return null;
  }
}
