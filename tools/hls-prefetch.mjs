import { createHash } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { detectLlHls, httpUrl, parseManifest, parseMasterVariants, rankRenditions, readManifest, selectRendition } from '../extension/hls.mjs';
import { prefetchRanges } from './range-prefetch.mjs';
import { ApiError } from './media-source.mjs';
import { createRequestContext } from './request-context.mjs';
import { assertValidSegment, inspectEncryptedHlsSegment, inspectMediaFile, normalizeStagedSegment } from './media-inspector.mjs';
import { negotiateQuality } from './quality-negotiator.mjs';
import {
  checkHostBackoff, isTransientNetworkError, paceBandwidth,
  recordHostFailure, recordHostSuccess, recordHostThrottle, recommendedConcurrencyForHost,
} from './rate-controller.mjs';

const segmentWorkers = 8;
const segmentConnectMs = 12_000;
const segmentIdleMs = 8_000;
const tailDelayMs = 2_000;
const queuedBackupDelayMs = 4_000;
const strongEtag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const transientStatuses = new Set([408, 500, 502, 503, 504]);
const rateLimits = new Map();

function rateLimited(retryAfterSec) {
  return new ApiError('RATE_LIMITED', '媒体服务器要求降低请求频率', 429, { status: 429, retryAfterSec });
}

function checkHlsProtection(content) {
  for (const line of content.split(/\r?\n/)) {
    const attributes = /^\s*#EXT-X-(?:SESSION-)?KEY:(.*)$/.exec(line)?.[1];
    if (attributes && (/(?:^|,)\s*METHOD=SAMPLE-AES(?:-CTR)?\s*(?:,|$)/i.test(attributes) ||
        /(?:^|,)\s*KEYFORMAT="(?:com\.(?:apple\.streamingkeydelivery|widevine|microsoft\.playready)[^"]*|urn:uuid:(?:edef8ba9|9a04f079)[^"]*)"/i.test(attributes))) {
      throw new ApiError('DRM', '媒体清单标记为 DRM 保护', 422);
    }
  }
}

async function fileSha256(filePath) {
  const bytes = await readFile(filePath);
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function canonicalPlaylistSignature(url, content, parsed) {
  const canonicalUrl = url.origin + url.pathname;
  const durations = [...content.matchAll(/^#EXTINF:([\d.]+),/gm)].map(m => m[1]);
  const segmentPaths = parsed ? parsed.segments.map(seg => `${seg.url.origin}${seg.url.pathname}:${seg.range ? `${seg.range.start}-${seg.range.end}` : ''}`) : [];
  return {
    canonicalUrl,
    mediaSequence: parsed?.mediaSequence ?? 0,
    durations,
    segmentPaths,
  };
}

function ivBufferForSegment(encryption) {
  if (encryption.iv) {
    return Buffer.from(encryption.iv.slice(2).padStart(32, '0'), 'hex');
  }
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(encryption.sequenceNumber >>> 0, 12);
  return buf;
}

export async function checkManifestProtection(source, cookies, signal, { kind, quality, headers, requestContext }) {
  const ctx = requestContext ?? createRequestContext({ origin: source.origin, headers, cookies });
  const budget = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const inspect = async (url, phase = 'playlist') => {
    const { url: resolved, response } = await request(url, ctx, budget, undefined, false, false, phase);
    const content = await readManifest(response.body);
    if (kind === 'mpd') {
      const drm = /<ContentProtection\b[^>]*\bschemeIdUri\s*=\s*["'](?:urn:uuid:(?:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95)|urn:mpeg:dash:mp4protection:2011)["']/i;
      if (drm.test(content)) throw new ApiError('DRM', '媒体清单标记为 DRM 保护', 422);
    } else checkHlsProtection(content);
    return { resolved, content };
  };
  try {
    const { resolved, content } = await inspect(source, 'master-playlist');
    const rendition = kind === 'm3u8' && selectRendition(content, resolved, typeof quality === 'number' ? quality : undefined);
    if (rendition) await Promise.all([inspect(rendition.video, 'playlist'), rendition.audio && inspect(rendition.audio, 'audio-playlist')]);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
  }
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

function assertManagedOrigin(url, origin, approvedEntry = false) {
  if (url.origin !== origin || url.search && !approvedEntry || url.hash || url.username || url.password) {
    throw new ApiError('MCP_MEDIA_SCOPE', 'An HLS resource falls outside the approved site scope', 403);
  }
}

async function request(url, ctx, signal, range, restrictedOrigin = false, approvedEntry = false, hlsPhase = 'playlist') {
  if (restrictedOrigin && !ctx.transport) assertManagedOrigin(url, ctx.origin, approvedEntry);
  for (let hop = 0; hop < 5; hop++) {
    const host = url.host;
    const until = rateLimits.get(host);
    if (until > Date.now()) throw rateLimited(Math.ceil((until - Date.now()) / 1000));
    if (until !== undefined) rateLimits.delete(host);
    const backoffSec = checkHostBackoff(host);
    if (backoffSec > 0) throw rateLimited(backoffSec);
    const ranged = range && (!range.url || range.url === url.href);
    const reqStarted = performance.now();
    const sentHeaders = ctx.transport ? null : ctx.headersFor(url, { phase: hlsPhase, range: ranged ? range : undefined });
    const sentHeaderNames = sentHeaders ? Object.keys(sentHeaders).map(k => k.toLowerCase()).sort() : undefined;
    const response = await (ctx.transport
      ? ctx.transport.fetchResource(url, { signal, range: ranged ? range : undefined }).then(result => {
          url = result.url;
          return result.response;
        })
      : fetch(url, {
          redirect: 'manual',
          headers: sentHeaders,
          signal,
        })
    ).catch(error => {
      if (error instanceof ApiError) throw error;
      recordHostFailure(host);
      throw Object.assign(new Error('HLS connection interrupted', { cause: error }), {
        retryable: true,
        transientNetwork: isTransientNetworkError(error),
      });
    });
    const elapsedMs = performance.now() - reqStarted;
    ctx.recordStage(hlsPhase, { status: response.status, elapsedMs, engine: 'hls', sentHeaderNames });
    const accessErr = ctx.accessError(response.status, response.headers, hlsPhase, { engine: 'hls', sentHeaderNames });
    if (accessErr && (response.headers.get('cf-mitigated') === 'challenge' || [401, 402, 403, 410, 451].includes(response.status))) {
      await response.body?.cancel();
      throw accessErr;
    }
    if (response.body && (response.status === 200 || ranged && response.status === 206)) {
      recordHostSuccess(host, { latencyMs: elapsedMs });
      return { url, response };
    }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (restrictedOrigin && [301, 302, 303, 307, 308].includes(response.status)) {
      throw new ApiError('MCP_MEDIA_REDIRECT', 'An approved HLS resource redirected', 403);
    }
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      if (response.status === 429) {
        const value = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(value ?? '') ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
        const retryAfterSec = Number.isSafeInteger(seconds) ? Math.max(0, seconds) : 5;
        const retryAt = Math.max(rateLimits.get(host) ?? 0, Date.now() + retryAfterSec * 1000);
        if (!rateLimits.has(host) && rateLimits.size >= 256) rateLimits.delete(rateLimits.keys().next().value);
        rateLimits.set(host, retryAt);
        recordHostThrottle(host, retryAfterSec);
        throw rateLimited(Math.ceil((retryAt - Date.now()) / 1000));
      }
      recordHostFailure(host);
      const restart = ranged && response.status === 416;
      throw Object.assign(new Error('HLS response unavailable for parallel download'), {
        status: response.status,
        phase: hlsPhase,
        sentHeaderNames,
        retryable: restart || transientStatuses.has(response.status),
        restart,
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

async function probeVariantAvailability(variant, ctx, signal) {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(variant.url, {
      redirect: 'manual',
      headers: ctx.headersFor(variant.url, { phase: 'variant' }),
      signal,
    });
    const status = res.status;
    if (res.headers.get('cf-mitigated') === 'challenge' || [401, 402, 403, 451].includes(status)) {
      await res.body?.cancel();
      return { availability: 'restricted', available: false, probeStatus: status, verificationMethod: 'variant-playlist', checkedAt };
    }
    if (status === 404 || status === 410) {
      await res.body?.cancel();
      return { availability: 'unavailable', available: false, probeStatus: status, verificationMethod: 'variant-playlist', checkedAt };
    }
    if (status !== 200 || !res.body) {
      await res.body?.cancel();
      return { availability: 'unknown', available: false, probeStatus: status, verificationMethod: 'variant-playlist', checkedAt };
    }
    const playlistText = await readManifest(res.body);
    try { checkHlsProtection(playlistText); } catch {
      return { availability: 'restricted', available: false, probeStatus: 422, verificationMethod: 'variant-playlist', checkedAt };
    }
    const parsed = parseManifest(playlistText, variant.url, 'video', { byteRanges: true, aes128: true, sniffTransport: true });
    const firstSeg = parsed?.segments?.[0];
    if (!firstSeg?.url) {
      return { availability: 'unknown', available: false, probeStatus: status, verificationMethod: 'variant-playlist', checkedAt };
    }
    const rangeStart = firstSeg.range?.start ?? 0;
    const rangeEnd = firstSeg.range ? Math.min(firstSeg.range.end, rangeStart + 1) : 1;
    const segRes = await fetch(firstSeg.url, {
      redirect: 'manual',
      headers: ctx.headersFor(firstSeg.url, { phase: 'segment', range: { start: rangeStart, end: rangeEnd } }),
      signal,
    });
    const segStatus = segRes.status;
    const ct = (segRes.headers.get('content-type') || '').toLowerCase();
    await segRes.body?.cancel();
    if (segRes.headers.get('cf-mitigated') === 'challenge' || [401, 402, 403, 451].includes(segStatus)) {
      return { availability: 'restricted', available: false, probeStatus: segStatus, verificationMethod: 'playlist+range-2b', checkedAt };
    }
    if (segStatus === 404 || segStatus === 410) {
      return { availability: 'unavailable', available: false, probeStatus: segStatus, verificationMethod: 'playlist+range-2b', checkedAt };
    }
    if ((segStatus === 206 || segStatus === 200) && !/^text\/html|^application\/json/i.test(ct)) {
      return { availability: 'available', available: true, probeStatus: segStatus, verificationMethod: 'playlist+range-2b', checkedAt };
    }
    return { availability: 'unavailable', available: false, probeStatus: segStatus, verificationMethod: 'playlist+range-2b', checkedAt };
  } catch {
    return { availability: 'unknown', available: false, probeStatus: null, verificationMethod: 'manifest-only', checkedAt };
  }
}

export async function hlsQualities(source, cookies, signal, headers, requestContext, { verifyAvailability = true } = {}) {
  const ctx = requestContext ?? createRequestContext({ origin: source.origin, headers, cookies });
  try {
    const budget = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const { url, response } = await request(source, ctx, budget, undefined, false, false, 'master-playlist');
    const content = await readManifest(response.body);
    const { variants } = parseMasterVariants(content, url);
    if (!variants.length) return [];
    const sorted = variants
      .filter(v => v.height || v.bandwidth)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
    const probeBudget = AbortSignal.any([signal, AbortSignal.timeout(4500)]);
    const probeResults = new Map();
    if (verifyAvailability) {
      const toProbe = sorted.slice(0, 8);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, toProbe.length) }, async () => {
        while (cursor < toProbe.length && !probeBudget.aborted) {
          const idx = cursor++;
          const v = toProbe[idx];
          probeResults.set(v.url.href, await probeVariantAvailability(v, ctx, probeBudget));
        }
      }));
    }
    const checkedAt = new Date().toISOString();
    return sorted.map((v, idx) => {
      const probed = probeResults.get(v.url.href) ?? {
        availability: 'unknown',
        available: true,
        probeStatus: null,
        verificationMethod: 'manifest-only',
        checkedAt,
      };
      return {
        candidateId: `hls-v${idx}-${v.height || 0}p`,
        ...(v.width && { width: v.width }),
        height: v.height ?? 0,
        bitrate: v.bandwidth,
        bandwidth: v.bandwidth,
        ...(v.averageBandwidth && { averageBandwidth: v.averageBandwidth }),
        ...(v.codecs && { codec: v.codecs, codecs: v.codecs }),
        ...(v.frameRate && { frameRate: v.frameRate }),
        ...(v.videoRange && { videoRange: v.videoRange }),
        ...(v.hdr && { hdr: true }),
        ...(v.audioTracks?.length && { audioTracks: v.audioTracks.map(({ name, language, channels, preferred }) => ({ name, language, channels, preferred })) }),
        ...(v.subtitleTracks?.length && { subtitleTracks: v.subtitleTracks.map(({ name, language, preferred }) => ({ name, language, preferred })) }),
        url: v.url.href,
        available: probed.available,
        availability: probed.availability,
        probeStatus: probed.probeStatus,
        verificationMethod: probed.verificationMethod,
        checkedAt: probed.checkedAt,
      };
    });
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

async function validateStagedSegment(file, segment, keyBuffers, strict = false) {
  if (segment.encryption) {
    const key = keyBuffers.get(segment.encryption.keyFilename);
    if (!key) throw new ApiError('INVALID_HLS_SEGMENT', '缺少用于校验分片的 AES-128 密钥', 422);
    const iv = ivBufferForSegment(segment.encryption);
    const inspection = await inspectEncryptedHlsSegment(file, key, iv, { expected: segment.expectedKind });
    if (strict || segment.verifyTransport || ['image-payload', 'html-error-page', 'json-error-response', 'drm-isobmff', 'empty-payload'].includes(inspection.reason)) {
      return assertValidSegment(inspection, { code: 'INVALID_HLS_SEGMENT' });
    }
    return inspection;
  }
  const inspection = await inspectMediaFile(file, { expected: segment.expectedKind });
  const alwaysReject = ['image-payload', 'html-error-page', 'json-error-response', 'xml-response', 'drm-isobmff', 'empty-payload'];
  if (strict || segment.verifyTransport || alwaysReject.includes(inspection.reason)) {
    assertValidSegment(inspection, { code: 'INVALID_HLS_SEGMENT' });
  }
  if (inspection.valid && inspection.needsStrip) {
    await normalizeStagedSegment(file, inspection);
  }
  return inspection;
}

async function checkStagingSpace(directory, rendition, playlist) {
  if (!rendition) return;
  const duration = Array.from(playlist.matchAll(/^#EXTINF:([\d.]+),/gm), entry => Number(entry[1]))
    .reduce((total, seconds) => total + seconds, 0);
  const estimate = Math.ceil(duration * rendition.bandwidth / 8);
  if (!Number.isSafeInteger(estimate) || estimate <= 0) return;
  const space = await statfs(directory).catch(() => null);
  const requiredBytes = Math.ceil(estimate * 1.5);
  if (space && space.bavail * space.bsize < requiredBytes) {
    throw new ApiError('NO_SPACE', 'The output volume has insufficient space for this HLS download', 507,
      { requiredBytes, freeBytes: space.bavail * space.bsize });
  }
}

async function downloadSegment(url, destination, ctx, signal, onBytes, slice, restrictedOrigin, phase = 'segment', attempts = 3) {
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
        ? { url: resume.url, start: (slice?.start ?? 0) + offset, end: slice?.end ?? resume.size - 1, etag: resume.etag }
        : slice;
      const { url: finalUrl, response } = await request(url, ctx, requestSignal, range, restrictedOrigin, false, phase);
      clearTimeout(timeout);
      reader = response.body.getReader();
      const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? 'identity';
      const length = response.headers.get('content-length');
      const etag = response.headers.get('etag');
      let expected;
      if (response.status === 200) {
        if (slice) {
          throw Object.assign(new Error('HLS segment range unavailable'), { retryable: Boolean(range.etag), restart: true });
        }
        offset = 0;
        const size = Number(length);
        resume = encoding === 'identity' && Number.isSafeInteger(size) && size > 0 && strongEtag.test(etag) &&
          response.headers.get('accept-ranges')?.toLowerCase() === 'bytes' ? { url: finalUrl.href, size, total: size, etag } : undefined;
        expected = resume?.size;
      } else {
        const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range'));
        const total = Number(contentRange?.[3]);
        if (encoding !== 'identity' || !Number.isSafeInteger(total) || total <= range.end ||
            Number(contentRange[1]) !== range.start || Number(contentRange[2]) !== range.end ||
            (range.etag && (etag !== range.etag || total !== resume.total)) ||
            (length !== null && Number(length) !== range.end - range.start + 1)) {
          throw Object.assign(new Error('Unexpected HLS segment range'), { retryable: true, restart: true });
        }
        slice?.validate(total, strongEtag.test(etag) ? etag : null);
        expected = range.end - (slice?.start ?? 0) + 1;
        resume = strongEtag.test(etag) ? { url: finalUrl.href, size: expected, total, etag } : undefined;
      }
      const totalBytes = encoding === 'identity' && length !== null ? (expected ?? Number(length)) : expected;
      output = await open(destination, offset ? 'r+' : 'w');
      timeout = setTimeout(abortStalled, segmentIdleMs);
      while (true) {
        const { done, value } = await reader.read().catch(error => {
          throw Object.assign(new Error('HLS segment interrupted', { cause: error }), { retryable: true });
        });
        if (done) break;
        timeout.refresh();
        if (expected !== undefined && offset + value.byteLength > expected) {
          throw Object.assign(new Error('HLS segment exceeded its declared size'), { retryable: true, restart: true });
        }
        signal.throwIfAborted();
        const { bytesWritten } = await output.write(value, 0, value.byteLength, offset);
        if (bytesWritten !== value.byteLength) throw new Error('Could not write the complete HLS segment chunk');
        offset += bytesWritten;
        onBytes(offset, totalBytes);
        await paceBandwidth(bytesWritten, signal);
      }
      if (!offset || expected !== undefined && offset !== expected) {
        throw Object.assign(new Error('Incomplete HLS segment'), { retryable: true });
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
    await sleep(150 * (attempt + 1), undefined, { signal });
  }
}

export async function prefetchHls(source, cookies, staging, signal, onProgress, {
  quality, sourceKind, connections = segmentWorkers, recovery, headers, onFallback, onSegmentsStored,
  onQualityNegotiated, subtitles = false, strictSegmentCheck = false, restrictedOrigin = false, signedEntry = false, transport, requestContext,
} = {}) {
  if (sourceKind !== 'm3u8' && !/\.m3u8$/i.test(source.pathname)) return null;
  const ctx = requestContext ?? createRequestContext({
    origin: source.origin,
    headers,
    cookies,
    restrictedOrigin,
    transport,
  });
  const controller = new AbortController();
  const transferSignal = AbortSignal.any([signal, controller.signal]);
  const directory = path.join(staging, 'segments');
  let directoryCreated = false;
  try {
    const read = async (url, readBody = readManifest, approvedEntry = false, hlsPhase = 'playlist') => {
      for (let attempt = 0; ; attempt++) {
        const deadline = AbortSignal.timeout(5000);
        try {
          const resource = await request(url, ctx, AbortSignal.any([transferSignal, deadline]),
            undefined, restrictedOrigin, approvedEntry, hlsPhase);
          return { url: resource.url, content: await readBody(resource.response.body) };
        } catch (error) {
          transferSignal.throwIfAborted();
          if (attempt || !(error.retryable || deadline.aborted || error instanceof TypeError)) throw error;
          await sleep(150, undefined, { signal: transferSignal });
        }
      }
    };
    const first = await read(source, readManifest, signedEntry, 'master-playlist');
    checkHlsProtection(first.content);
    let rendition, sound, subtitlePlaylist;
    let selected = first;
    const { variants } = parseMasterVariants(first.content, first.url);
    let renditions = [];
    if (variants.length) {
      const negotiated = negotiateQuality(variants, quality);
      onQualityNegotiated?.({
        requested: negotiated.requested,
        selected: negotiated.selected ? {
          width: negotiated.selected.width,
          height: negotiated.selected.height,
          bandwidth: negotiated.selected.bandwidth,
          codecs: negotiated.selected.codecs,
          hdr: negotiated.selected.hdr,
        } : null,
        available: variants.map(v => ({ width: v.width, height: v.height, bandwidth: v.bandwidth, hdr: v.hdr })),
        fallbackApplied: negotiated.fallbackApplied,
        reason: negotiated.reason,
      });
      renditions = negotiated.ranked.slice(0, 4).map(v => (v.missingAudioGroup ? null : v));
    } else {
      renditions = rankRenditions(first.content, first.url, typeof quality === 'number' ? quality : undefined).slice(0, 4);
    }
    for (const [index, candidate] of renditions.entries()) {
      if (!candidate) break;
      try {
        selected = await read(candidate.video, readManifest, false, 'variant');
        rendition = candidate;
        break;
      } catch (error) {
        if ((error.status === 404 || error.status === 410) && index < renditions.length - 1) {
          continue;
        }
        if ((error.status === 404 || error.status === 410) && index === renditions.length - 1 && renditions.length > 1) {
          throw new ApiError('QUALITY_UNAVAILABLE', '所有候选画质清单均不可用（404/410）', 422, {
            phase: 'variant',
            status: error.status,
          });
        }
        throw error;
      }
    }
    if (rendition?.audio) sound = await read(rendition.audio, readManifest, false, 'audio-playlist');
    if (subtitles && rendition?.subtitle) {
      subtitlePlaylist = await read(rendition.subtitle, readManifest, false, 'subtitle-playlist').catch(() => null);
    }
    if (rendition) checkHlsProtection(selected.content);
    if (sound) checkHlsProtection(sound.content);
    const parseOptions = { byteRanges: true, aes128: true, sniffTransport: true };
    const video = parseManifest(selected.content, selected.url, 'video', parseOptions);
    const audio = sound && parseManifest(sound.content, sound.url, 'audio', parseOptions);
    const subs = subtitlePlaylist && parseManifest(subtitlePlaylist.content, subtitlePlaylist.url, 'subtitle', {
      byteRanges: true, aes128: true, sniffTransport: true, subtitle: true,
    });
    if (!video || sound && !audio) {
      const reason = detectLlHls(selected.content) ? 'll-hls-live-unsupported' : 'unsupported-hls-playlist';
      onFallback?.({ reason });
      return null;
    }
    await checkStagingSpace(staging, rendition, video.playlist);
    const taggedSegments = [
      ...video.segments.map(seg => ({
        ...seg,
        hlsPhase: seg.isInit ? 'init-segment' : seg.range ? 'byte-range' : 'segment',
      })),
      ...(audio?.segments.map(seg => ({ ...seg, hlsPhase: 'audio-segment' })) ?? []),
      ...(subs?.segments.map(seg => ({ ...seg, hlsPhase: 'subtitle-segment' })) ?? []),
    ];
    const keys = [...(video.keys ?? []), ...(audio?.keys ?? []), ...(subs?.keys ?? [])];
    if (restrictedOrigin) {
      for (const resource of [...taggedSegments, ...keys]) {
        if (ctx.transport) ctx.transport.assertUrl(resource.url);
        else assertManagedOrigin(resource.url, ctx.origin);
      }
    }
    await mkdir(directory);
    directoryCreated = true;

    const runWorkers = async (count, work) => {
      const results = await Promise.allSettled(Array.from({ length: count }, async () => {
        try { await work(); }
        catch (error) { controller.abort(error); throw error; }
      }));
      if (results.some(result => result.status === 'rejected')) throw transferSignal.reason;
    };
    const keyHashes = new Map();
    const keyBuffers = new Map();
    if (keys.length) {
      let nextKey = 0;
      await runWorkers(Math.min(connections, keys.length), async () => {
        while (nextKey < keys.length) {
          const { url, filename } = keys[nextKey++];
          const { content } = await read(url, readKey, false, 'key');
          await writeFile(path.join(directory, filename), content, { mode: 0o600, flag: 'wx', signal: transferSignal });
          keyBuffers.set(filename, content);
          keyHashes.set(filename, createHash('sha256').update(content).digest('hex'));
        }
      });
    }
    const firstPart = taggedSegments[0];
    const sharedFile = !audio && !subs && firstPart.filename.endsWith('.mp4') &&
      taggedSegments.every((part, index) => part.range && part.url.href === firstPart.url.href &&
        part.range.start === (index === 0 ? 0 : taggedSegments[index - 1].range.end + 1) &&
        (index === 0 || part.filename.endsWith('.m4s')));
    if (sharedFile) {
      // Only use the complete file when the manifest covers every byte in playback order.
      const expectedSize = taggedSegments.at(-1).range.end + 1;
      const scopedCookies = firstPart.url.origin === ctx.origin ? ctx.cookies : [];
      const file = await prefetchRanges(firstPart.url, scopedCookies, directory, transferSignal, onProgress,
        { connections, expectedSize, recovery, headers: ctx.headers, exactSource: restrictedOrigin, transport: ctx.transport, requestContext: ctx });
      if (file) return file;
    }

    // Build a canonical checkpoint identity that survives signed query-token refresh when playlist structure
    // and key material match, while invalidating immediately if sequence, durations, paths, or keys change.
    let checkpoint;
    let mediaIdentity = null;
    if (recovery) {
      mediaIdentity = [
        canonicalPlaylistSignature(selected.url, selected.content, video),
        sound ? canonicalPlaylistSignature(sound.url, sound.content, audio) : null,
        subs ? canonicalPlaylistSignature(subtitlePlaylist.url, subtitlePlaylist.content, subs) : null,
        keys.map(({ filename }) => keyHashes.get(filename)),
      ];
      const digest = createHash('sha256').update(JSON.stringify(mediaIdentity)).digest('hex');
      checkpoint = path.join(recovery, 'segments-' + digest);
      await mkdir(checkpoint, { recursive: true, mode: 0o700 });
      if (!(await lstat(checkpoint)).isDirectory()) throw new Error('Invalid HLS checkpoint directory');
    }
    const adaptiveWorkers = recommendedConcurrencyForHost(selected.url.host, connections);
    let next = 0;
    let finished = 0;
    let received = 0;
    let restored = 0;
    let corruptedCount = 0;
    let savedBytes = 0;
    let duplicateBytes = 0;
    const completedIndices = new Set();
    const failedSegments = [];
    const workers = Math.min(Math.max(1, adaptiveWorkers), taggedSegments.length);
    const active = new Set();
    const representations = new Map();
    let backupTimer;
    let backupDue;
    let backupInFlight = false;
    let nextBackupCheck = 0;
    let lastQueuedBackup = -Infinity;
    let lastCheckpointWrite = 0;

    async function writeCheckpointManifest(force = false) {
      if (!checkpoint) return;
      const now = performance.now();
      if (!force && now - lastCheckpointWrite < 1000) return;
      lastCheckpointWrite = now;
      const data = {
        version: 1,
        mediaIdentity,
        total: taggedSegments.length,
        completed: completedIndices.size,
        missing: taggedSegments.length - completedIndices.size,
        corrupted: corruptedCount,
        restored,
        duplicateBytes,
        savedBytes,
        completedIndices: [...completedIndices].sort((a, b) => a - b),
        failedSegments,
        updatedAt: new Date().toISOString(),
      };
      const tmp = path.join(checkpoint, 'checkpoint.json.tmp');
      await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }).catch(() => {});
      await rename(tmp, path.join(checkpoint, 'checkpoint.json')).catch(() => {});
    }

    function scheduleBackup(checkNow = false) {
      if (transferSignal.aborted || backupInFlight || !active.size) return;
      const atTail = next === taggedSegments.length && active.size < workers;
      const hasBacklog = next < taggedSegments.length && active.size === workers && workers >= 4;
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
      backupInFlight = true;
      candidate.backup = downloadSegment(candidate.url, candidate.destination + '.backup', ctx,
        candidate.backupSignal, candidate.report, candidate.range, restrictedOrigin, candidate.hlsPhase, 1).then(() => {
        candidate.primary.abort();
        return true;
      }, () => false).finally(() => {
        backupInFlight = false;
        scheduleBackup();
      });
    }

    async function transferSegment(entry, segIndex) {
      const { url, filename, range: segmentRange, verifyTransport, verifyContent, hlsPhase } = entry;
      const destination = path.join(directory, filename);
      const checkpointFile = checkpoint && path.join(checkpoint, filename);
      const checksumFile = checkpointFile && (checkpointFile + '.sha256');
      if (checkpointFile) {
        const saved = await lstat(checkpointFile).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (saved?.isFile() && saved.size > 0) {
          let intact = true;
          try {
            const expectedMeta = await readFile(checksumFile, 'utf8').then(JSON.parse).catch(() => null);
            if (expectedMeta) {
              const actual = await fileSha256(checkpointFile);
              if (actual.size !== expectedMeta.size || actual.sha256 !== expectedMeta.sha256) intact = false;
            }
            if (intact && (verifyTransport || verifyContent)) {
              await validateStagedSegment(checkpointFile, entry, keyBuffers, strictSegmentCheck);
            }
          } catch {
            intact = false;
          }
          if (intact) {
            await copyCompletedPart(checkpointFile, destination, destination + '.restore');
            received += saved.size;
            savedBytes += saved.size;
            completedIndices.add(segIndex);
            return true;
          }
          corruptedCount++;
          // Corrupted checkpoint segment detected: remove only this part and re-download it.
          await Promise.allSettled([
            rm(checkpointFile, { force: true }),
            rm(checksumFile, { force: true }),
          ]);
        }
      }
      for (let contentAttempt = 0; ; contentAttempt++) {
        const primary = new AbortController();
        const backup = new AbortController();
        const range = segmentRange && { ...segmentRange, validate(total, etag) {
          const previous = representations.get(url.href);
          if (previous && (previous.total !== total || previous.etag !== etag)) {
            throw new Error('HLS byte ranges disagree on the source file');
          }
          if (!previous) representations.set(url.href, { total, etag });
        } };
        let highWater = 0;
        const report = offset => {
          if (offset <= highWater) {
            duplicateBytes += offset;
            return;
          }
          received += offset - highWater;
          highWater = offset;
          onProgress(null, received);
        };
        const startedAt = performance.now();
        const segment = {
          url, destination, range, primary, backupSignal: AbortSignal.any([transferSignal, backup.signal]),
          report, startedAt, lastProgress: startedAt, bytes: 0, total: 0, hlsPhase,
        };
        active.add(segment);
        scheduleBackup();
        try {
          await downloadSegment(url, destination, ctx,
            AbortSignal.any([transferSignal, primary.signal]), (offset, total) => {
              segment.lastProgress = performance.now();
              segment.bytes = offset;
              segment.total = total;
              report(offset);
            }, range, restrictedOrigin, hlsPhase);
        } catch (error) {
          if (!await segment.backup) {
            failedSegments.push({ index: segIndex, status: error.status ?? null, reason: error.code ?? error.message });
            throw error;
          }
          transferSignal.throwIfAborted();
          await rename(destination + '.backup', destination);
        } finally {
          active.delete(segment);
          if (segment.backup) {
            backup.abort();
            await segment.backup;
            await rm(destination + '.backup', { force: true, maxRetries: 5 });
          }
        }
        if (verifyTransport || verifyContent) {
          try {
            await validateStagedSegment(destination, entry, keyBuffers, strictSegmentCheck);
          } catch (valErr) {
            if (valErr.detail?.reason === 'html-error-page' && contentAttempt < 2) {
              duplicateBytes += highWater;
              await rm(destination, { force: true }).catch(() => {});
              await sleep(200 * (contentAttempt + 1), undefined, { signal: transferSignal });
              continue;
            }
            failedSegments.push({ index: segIndex, status: 200, reason: valErr.detail?.reason ?? valErr.code ?? 'invalid-segment' });
            throw valErr;
          }
        }
        break;
      }
      completedIndices.add(segIndex);
      if (checkpointFile) {
        signal.throwIfAborted();
        const meta = await fileSha256(destination);
        // Only publish a fully verified and closed file into the checkpoint with its SHA-256 sidecar.
        await copyCompletedPart(destination, checkpointFile, destination + '.checkpoint');
        await writeFile(checksumFile, JSON.stringify(meta), { mode: 0o600 });
        await writeCheckpointManifest(false);
      }
      return false;
    }

    try {
      await runWorkers(workers, async () => {
        while (next < taggedSegments.length) {
          const segIndex = next++;
          if (await transferSegment(taggedSegments[segIndex], segIndex)) restored++;
          onProgress(++finished / taggedSegments.length, received, null, {
            completed: finished,
            total: taggedSegments.length,
            missing: taggedSegments.length - finished,
            corrupted: corruptedCount,
            restored,
            duplicateBytes,
            savedBytes,
            failedSegments,
          });
          scheduleBackup();
        }
      });
      await writeCheckpointManifest(true);
    } catch (error) {
      await writeCheckpointManifest(true);
      if (checkpoint && error.retryable && !signal.aborted) {
        const missing = [];
        for (const [index, { filename }] of taggedSegments.entries()) {
          const complete = await lstat(path.join(checkpoint, filename)).catch(() => null);
          if (!complete?.isFile() || !complete.size) missing.push(index);
        }
        await writeFile(path.join(checkpoint, 'failed.json'), JSON.stringify({ total: taggedSegments.length, missing }), { mode: 0o600 });
        throw new ApiError('HLS_TRANSFER_INTERRUPTED', 'HLS transfer interrupted. Resubmit the original batch to resume.', 503, {
          ...(Number.isInteger(error.status) && { status: error.status }),
          missingCount: missing.length,
          failedSegments: missing.slice(0, 64),
        });
      }
      throw error;
    } finally {
      clearTimeout(backupTimer);
    }
    const filename = path.join(directory, 'download.m3u8');
    if (audio || subs) {
      const writes = [writeFile(path.join(directory, 'video.m3u8'), video.playlist)];
      const masterLines = ['#EXTM3U'];
      const streamAttrs = [`BANDWIDTH=${rendition?.bandwidth || 1_000_000}`];
      if (audio) {
        writes.push(writeFile(path.join(directory, 'audio.m3u8'), audio.playlist));
        masterLines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,URI="audio.m3u8"');
        streamAttrs.push('AUDIO="audio"');
      }
      if (subs) {
        writes.push(writeFile(path.join(directory, 'subtitle.m3u8'), subs.playlist));
        masterLines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="subtitle.m3u8"');
        streamAttrs.push('SUBTITLES="subs"');
      }
      masterLines.push(`#EXT-X-STREAM-INF:${streamAttrs.join(',')}`, 'video.m3u8', '');
      await Promise.all(writes);
      await writeFile(filename, masterLines.join('\n'));
    } else {
      await writeFile(filename, video.playlist);
    }
    if (checkpoint && onSegmentsStored) {
      await rm(path.join(checkpoint, 'failed.json'), { force: true });
      onSegmentsStored(checkpoint);
    }
    return filename;
  } catch (error) {
    controller.abort(error);
    if (directoryCreated) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    if (recovery && !directoryCreated && error.retryable) {
      throw new ApiError('HLS_TRANSFER_INTERRUPTED', 'HLS transfer interrupted. Resubmit the original batch to resume.', 503,
        Number.isInteger(error.status) ? { status: error.status } : undefined);
    }
    if (error.code === 'ENOSPC') throw new ApiError('NO_SPACE', 'The output volume has run out of space', 507);
    onFallback?.(Number.isInteger(error?.status) ? { reason: 'hls-http-error', status: error.status }
      : { reason: 'hls-transfer-failed' });
    return null;
  }
}
