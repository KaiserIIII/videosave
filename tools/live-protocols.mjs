import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspectMediaBuffer } from './media-inspector.mjs';
import { ApiError, FFMPEG, runMedia } from './media-source.mjs';
import { createRequestContext } from './request-context.mjs';
import { dashPlan } from './dash-manifest.mjs';

const attrRegex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
function parseAttributes(text) {
  const attrs = {};
  for (const [, k, v] of text.matchAll(attrRegex)) {
    attrs[k] = v.startsWith('"') ? v.slice(1, -1) : v;
  }
  return attrs;
}

/**
 * Parse an HLS media playlist including LL-HLS (#EXT-X-PART, #EXT-X-PRELOAD-HINT,
 * #EXT-X-SERVER-CONTROL), multi-init (#EXT-X-MAP per discontinuity), and sliding-window state.
 */
export function parseLiveHlsPlaylist(text, baseUrl) {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') {
    throw new ApiError('INVALID_HLS_MANIFEST', 'Not a valid #EXTM3U playlist', 422);
  }
  let mediaSequence = 0;
  let targetDuration = 2;
  let endList = false;
  let currentMap = null;
  let currentDuration = null;
  let discontinuitySeq = 0;
  let partTarget = null;
  let serverControl = null;
  const preloadHints = [];
  const items = [];
  const initMaps = [];

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(11));
      if (attrs.METHOD && attrs.METHOD !== 'NONE' && attrs.METHOD !== 'AES-128') {
        throw new ApiError('DRM', `Unsupported protected HLS method ${attrs.METHOD}`, 422);
      }
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      throw new ApiError('DRM', 'Protected HLS session key is not supported', 422);
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.slice(22), 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(line.slice(22)) || 2;
      continue;
    }
    if (line.startsWith('#EXT-X-PART-INF:')) {
      const attrs = parseAttributes(line.slice(16));
      partTarget = Number.parseFloat(attrs['PART-TARGET']) || null;
      continue;
    }
    if (line.startsWith('#EXT-X-SERVER-CONTROL:')) {
      serverControl = parseAttributes(line.slice(22));
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      if (line === '#EXT-X-DISCONTINUITY') discontinuitySeq++;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(11));
      if (attrs.URI) {
        currentMap = {
          url: new URL(attrs.URI, base).href,
          discontinuitySeq,
        };
        initMaps.push(currentMap);
      }
      continue;
    }
    if (line.startsWith('#EXT-X-PART:')) {
      const attrs = parseAttributes(line.slice(12));
      if (attrs.URI) {
        items.push({
          kind: 'll-hls-part',
          url: new URL(attrs.URI, base).href,
          duration: Number.parseFloat(attrs.DURATION) || partTarget || 0.5,
          independent: attrs.INDEPENDENT === 'YES',
          map: currentMap,
          discontinuitySeq,
        });
      }
      continue;
    }
    if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
      const attrs = parseAttributes(line.slice(20));
      if (attrs.URI) {
        preloadHints.push({
          type: attrs.TYPE || 'PART',
          url: new URL(attrs.URI, base).href,
        });
      }
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      currentDuration = Number.parseFloat(line.slice(8).split(',')[0]) || targetDuration;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = new URL(line, base).href;
    items.push({
      kind: 'segment',
      url,
      duration: currentDuration ?? targetDuration,
      map: currentMap,
      discontinuitySeq,
    });
    currentDuration = null;
  }

  const hasParts = items.some(i => i.kind === 'll-hls-part');
  const fullSegments = items.filter(i => i.kind === 'segment');
  // In LL-HLS, prefer full segments for completed windows and append trailing partial segments
  const effectiveItems = hasParts && fullSegments.length
    ? [...fullSegments, ...items.slice(items.lastIndexOf(fullSegments.at(-1)) + 1)]
    : items;

  return {
    mediaSequence,
    targetDuration,
    partTarget,
    serverControl,
    preloadHints,
    endList,
    live: !endList,
    llHls: hasParts || preloadHints.length > 0,
    discontinuityCount: discontinuitySeq,
    initMaps,
    items: effectiveItems,
  };
}

/**
 * Record an authorized sliding-window live HLS or LL-HLS stream for a bounded duration (`maxSec`).
 * Handles multi-init (#EXT-X-MAP), #EXT-X-DISCONTINUITY transitions, LL-HLS partial segments,
 * and stops immediately on HTTP 401/403/451 or DRM without bypassing access controls.
 */
export async function recordSlidingWindowHls(sourceUrl, headers = {}, stagingDir, signal, onProgress = () => {}, {
  maxSec = 10,
  pollIntervalMs = 500,
  requestContext = null,
  cookie = null,
  cookies = null,
  outputFile = null,
} = {}) {
  const source = sourceUrl instanceof URL ? sourceUrl : new URL(sourceUrl);
  const headerObj = Array.isArray(headers) ? Object.fromEntries(headers) : (headers ?? {});
  const ctx = requestContext ?? createRequestContext({ sourceUrl: source, headers: headerObj, cookie, cookies });
  const targetSec = Math.max(1, Math.min(7200, Number(maxSec) || 10));
  await mkdir(stagingDir, { recursive: true });

  const seenUrls = new Set();
  const recordedParts = [];
  const initCache = new Map();
  let accumulatedSec = 0;
  let totalBytes = 0;
  let polls = 0;
  let llHlsDetected = false;
  let discontinuityCount = 0;
  let lastInitUrl = null;
  const maxPolls = Math.max(8, Math.ceil((targetSec * 1000) / Math.max(150, pollIntervalMs)) + 12);

  async function fetchChecked(url, phase) {
    const reqHeaders = ctx.headersFor(url, { phase });
    const res = await fetch(url, { signal, redirect: 'follow', headers: reqHeaders });
    ctx.recordStage(phase, { status: res.status, url });
    if ([401, 402, 403, 451].includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw ctx.accessError(res.status, { phase, url });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError('LIVE_HLS_FETCH_FAILED', `HTTP ${res.status} at ${phase}`, 502, { status: res.status, phase });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  while (accumulatedSec < targetSec && polls < maxPolls) {
    signal?.throwIfAborted();
    polls++;
    const manifestBuf = await fetchChecked(source.href, 'variant');
    const parsed = parseLiveHlsPlaylist(manifestBuf.toString('utf8'), source);
    if (parsed.llHls) llHlsDetected = true;
    discontinuityCount = Math.max(discontinuityCount, parsed.discontinuityCount);

    let addedThisPoll = 0;
    for (const item of parsed.items) {
      if (accumulatedSec >= targetSec) break;
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      if (item.map && item.map.url !== lastInitUrl) {
        let initBuf = initCache.get(item.map.url);
        if (!initBuf) {
          initBuf = await fetchChecked(item.map.url, 'init');
          const initCheck = inspectMediaBuffer(initBuf, { expectedKind: 'fmp4-init' });
          if (initCheck.rejected && (initCheck.drm || initCheck.reason === 'drm-protected')) {
            throw new ApiError('DRM', 'Protected fMP4 init segment is not supported', 422);
          }
          initCache.set(item.map.url, initBuf);
        }
        const initFile = path.join(stagingDir, `part-${String(recordedParts.length).padStart(5, '0')}.init.mp4`);
        await writeFile(initFile, initBuf);
        recordedParts.push({ file: initFile, isInit: true, discontinuitySeq: item.discontinuitySeq, duration: 0, url: item.map.url });
        lastInitUrl = item.map.url;
        totalBytes += initBuf.length;
      }

      const segBuf = await fetchChecked(item.url, 'segment');
      const inspected = inspectMediaBuffer(segBuf, { expectedKind: item.map ? 'fmp4-segment' : 'mpegts' });
      if (inspected.rejected) {
        if (inspected.drm || inspected.reason === 'drm-protected') throw new ApiError('DRM', 'DRM-protected segment rejected', 422);
        throw new ApiError('INVALID_HLS_SEGMENT', `Invalid live HLS segment (${inspected.reason})`, 422);
      }

      const ext = item.map ? '.m4s' : '.ts';
      const partFile = path.join(stagingDir, `part-${String(recordedParts.length).padStart(5, '0')}${ext}`);
      await writeFile(partFile, segBuf);
      recordedParts.push({
        file: partFile,
        isInit: false,
        kind: item.kind,
        discontinuitySeq: item.discontinuitySeq,
        duration: item.duration,
        sha256: createHash('sha256').update(segBuf).digest('hex'),
      });
      accumulatedSec += item.duration;
      totalBytes += segBuf.length;
      addedThisPoll++;
      onProgress(Math.min(1, accumulatedSec / targetSec), totalBytes, null);
    }

    if (parsed.endList || accumulatedSec >= targetSec) break;
    await sleep(addedThisPoll ? Math.min(pollIntervalMs, Math.max(150, (parsed.partTarget ?? parsed.targetDuration) * 400)) : pollIntervalMs, undefined, { signal });
  }

  const mediaParts = recordedParts.filter(p => !p.isInit);
  if (!mediaParts.length) {
    throw new ApiError('NO_MEDIA', 'No media segments captured from live HLS playlist', 422);
  }

  // Group by discontinuity / init segment so multi-init fMP4 and discontinuous TS streams remux cleanly
  const outMp4 = outputFile ? path.resolve(outputFile) : path.join(stagingDir, 'live-recorded.mp4');
  const hasFmp4 = recordedParts.some(p => p.isInit);
  if (hasFmp4) {
    // Assemble each discontinuity group (init + media parts) into a contiguous fMP4 chunk, then concat via FFmpeg
    const chunks = [];
    let current = [];
    for (const part of recordedParts) {
      if (part.isInit && current.length) {
        chunks.push(current);
        current = [part];
      } else {
        current.push(part);
      }
    }
    if (current.length) chunks.push(current);
    const chunkFiles = [];
    for (let i = 0; i < chunks.length; i++) {
      const bufs = await Promise.all(chunks[i].map(p => readFile(p.file)));
      const chunkPath = path.join(stagingDir, `group-${i}.mp4`);
      await writeFile(chunkPath, Buffer.concat(bufs));
      chunkFiles.push(chunkPath);
    }
    if (chunkFiles.length === 1) {
      await runMedia(FFMPEG, ['-v', 'error', '-y', '-i', chunkFiles[0], '-c', 'copy', '-movflags', '+faststart', outMp4], signal);
    } else {
      const concatList = path.join(stagingDir, 'groups.txt');
      await writeFile(concatList, chunkFiles.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n') + '\n', 'utf8');
      await runMedia(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', '-movflags', '+faststart', outMp4], signal);
    }
  } else {
    const tsAll = path.join(stagingDir, 'combined.ts');
    const bufs = await Promise.all(mediaParts.map(p => readFile(p.file)));
    await writeFile(tsAll, Buffer.concat(bufs));
    await runMedia(FFMPEG, ['-v', 'error', '-y', '-i', tsAll, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outMp4], signal);
  }

  return {
    file: outMp4,
    bytes: (await stat(outMp4)).size,
    capturedDurationSec: Number(accumulatedSec.toFixed(3)),
    segmentCount: mediaParts.length,
    polls,
    llHls: llHlsDetected,
    discontinuityCount,
    multiInit: initCache.size > 1,
    stages: ctx.getStageSummary(),
  };
}

/**
 * Record a bounded slice of an authorized dynamic DASH (type="dynamic", SegmentTimeline/SegmentTemplate,
 * including multi-Period) manifest up to `maxSec`.
 */
export async function recordDynamicDash(sourceUrl, stagingDir, signal, onProgress = () => {}, {
  maxSec = 10,
  pollIntervalMs = 500,
  quality = null,
  headers = {},
  requestContext = null,
  outputFile = null,
} = {}) {
  const source = sourceUrl instanceof URL ? sourceUrl : new URL(sourceUrl);
  const headerObj = Array.isArray(headers) ? Object.fromEntries(headers) : (headers ?? {});
  const ctx = requestContext ?? createRequestContext({ sourceUrl: source, headers: headerObj });
  const targetSec = Math.max(1, Math.min(7200, Number(maxSec) || 10));
  await mkdir(stagingDir, { recursive: true });

  async function fetchChecked(url, phase) {
    const res = await fetch(url, { signal, redirect: 'follow', headers: ctx.headersFor(url, { phase }) });
    ctx.recordStage(phase, { status: res.status, url });
    if ([401, 402, 403, 451].includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw ctx.accessError(res.status, { phase, url });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError('DYNAMIC_DASH_FETCH_FAILED', `HTTP ${res.status} at ${phase}`, 502, { status: res.status, phase });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const seenVideo = new Set();
  const seenAudio = new Set();
  const videoParts = [];
  const audioParts = [];
  let videoInit = null;
  let audioInit = null;
  let capturedSec = 0;
  let totalBytes = 0;
  let polls = 0;
  let periodCount = 1;
  const maxPolls = Math.max(8, Math.ceil((targetSec * 1000) / Math.max(150, pollIntervalMs)) + 12);

  while (capturedSec < targetSec && polls < maxPolls) {
    signal?.throwIfAborted();
    polls++;
    const xml = (await fetchChecked(source.href, 'mpd')).toString('utf8');
    // Parse dynamic MPD by allowing SegmentTimeline/SegmentTemplate extraction across periods
    const normalizedXml = xml.replace(/\btype\s*=\s*["']dynamic["']/i, 'type="static"');
    const periods = dashPlan(normalizedXml, source, { quality });
    periodCount = Math.max(periodCount, periods.length);
    const tracks = periods[0]?.tracks ?? [];
    const videoTrack = tracks.find(t => t.type === 'video');
    const audioTrack = tracks.find(t => t.type === 'audio');
    if (!videoTrack) {
      throw new ApiError('NO_MEDIA', 'No supported video representation in dynamic DASH MPD', 422);
    }

    if (!videoInit && videoTrack.init?.urls?.[0]) {
      videoInit = await fetchChecked(videoTrack.init.urls[0].href, 'init');
      totalBytes += videoInit.length;
    }
    if (!audioInit && audioTrack?.init?.urls?.[0]) {
      audioInit = await fetchChecked(audioTrack.init.urls[0].href, 'init');
      totalBytes += audioInit.length;
    }

    const segDur = (periods[0]?.duration && videoTrack.parts?.length)
      ? Math.max(0.5, periods[0].duration / videoTrack.parts.length)
      : 1;
    for (const part of videoTrack.parts ?? []) {
      const segUrl = part.urls?.[0]?.href;
      if (!segUrl || capturedSec >= targetSec) break;
      if (seenVideo.has(segUrl)) continue;
      seenVideo.add(segUrl);
      const buf = await fetchChecked(segUrl, 'segment');
      videoParts.push(buf);
      totalBytes += buf.length;
      capturedSec += segDur;
      onProgress(Math.min(1, capturedSec / targetSec), totalBytes, null);
    }
    for (const part of audioTrack?.parts ?? []) {
      const segUrl = part.urls?.[0]?.href;
      if (!segUrl || seenAudio.has(segUrl)) continue;
      seenAudio.add(segUrl);
      const buf = await fetchChecked(segUrl, 'audio-segment');
      audioParts.push(buf);
      totalBytes += buf.length;
    }

    if (!/\btype\s*=\s*["']dynamic["']/i.test(xml) || capturedSec >= targetSec) break;
    await sleep(pollIntervalMs, undefined, { signal });
  }

  if (!videoParts.length) {
    throw new ApiError('NO_MEDIA', 'No video segments captured from dynamic DASH MPD', 422);
  }

  const videoPath = path.join(stagingDir, 'video.m4s');
  await writeFile(videoPath, Buffer.concat([...(videoInit ? [videoInit] : []), ...videoParts]));
  const outMp4 = outputFile ? path.resolve(outputFile) : path.join(stagingDir, 'dynamic-dash.mp4');
  if (audioParts.length) {
    const audioPath = path.join(stagingDir, 'audio.m4s');
    await writeFile(audioPath, Buffer.concat([...(audioInit ? [audioInit] : []), ...audioParts]));
    await runMedia(FFMPEG, ['-v', 'error', '-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', outMp4], signal);
  } else {
    await runMedia(FFMPEG, ['-v', 'error', '-y', '-i', videoPath, '-c', 'copy', '-movflags', '+faststart', outMp4], signal);
  }

  return {
    file: outMp4,
    bytes: (await stat(outMp4)).size,
    capturedDurationSec: Number(capturedSec.toFixed(3)),
    videoSegments: videoParts.length,
    audioSegments: audioParts.length,
    periodCount,
    polls,
    stages: ctx.getStageSummary(),
  };
}
