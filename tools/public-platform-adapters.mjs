import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './media-source.mjs';
import { buildQualityNegotiationReport } from './quality-negotiator.mjs';
import { paceBandwidth } from './rate-controller.mjs';

const DEFAULT_UA = 'VideoSave/1.3.1 (+https://github.com/KaiserIIII/videosave)';

function mediaExtRank(name = '') {
  const lower = name.toLowerCase();
  if (lower.endsWith('.mp4')) return 0;
  if (lower.endsWith('.webm')) return 1;
  if (lower.endsWith('.mkv') || lower.endsWith('.mov')) return 2;
  if (lower.endsWith('.ogv')) return 3;
  if (lower.endsWith('.m4a') || lower.endsWith('.mp3') || lower.endsWith('.ogg') || lower.endsWith('.flac')) return 4;
  return 99;
}

export async function probeInternetArchive(video, signal) {
  const parsed = new URL(video.url);
  const id = /^\/details\/([A-Za-z0-9._-]+)\/?/.exec(parsed.pathname)?.[1];
  if (!id) throw new ApiError('NO_MEDIA', '无效的 Internet Archive 资源标识', 422, { platform: 'internet-archive' });

  const metaUrl = `https://archive.org/metadata/${encodeURIComponent(id)}`;
  const res = await fetch(metaUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `Internet Archive 返回 HTTP ${res.status}`, 502, { platform: 'internet-archive', status: res.status });
  }
  const data = await res.json();
  const files = Array.isArray(data.files) ? data.files : [];
  const candidates = files
    .filter(f => f && typeof f.name === 'string' && /\.(?:mp4|webm|ogv|mkv|mov|m4a|mp3|ogg|flac)$/i.test(f.name) && !/\.thumbs?\./i.test(f.name))
    .map(f => ({
      name: f.name,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      size: Number(f.size) || 0,
      height: Number(f.height) || 0,
      width: Number(f.width) || 0,
      duration: Number(f.length) || null,
      format: f.format || '',
      ext: path.extname(f.name).slice(1).toLowerCase(),
      isAudio: /\.(?:m4a|mp3|ogg|flac)$/i.test(f.name),
    }))
    .sort((a, b) => Number(a.isAudio) - Number(b.isAudio) || mediaExtRank(a.name) - mediaExtRank(b.name) || b.height - a.height || b.size - a.size);

  if (!candidates.length) {
    throw new ApiError('NO_MEDIA', '该 Internet Archive 条目下未找到可直接下载的音视频文件', 422, { platform: 'internet-archive' });
  }
  const best = candidates[0];
  const title = (Array.isArray(data.metadata?.title) ? data.metadata.title[0] : data.metadata?.title) || id;
  const checkedAt = new Date().toISOString();
  const seen = new Set();
  const qualityDetails = [];
  for (const c of candidates.slice(0, 8)) {
    const key = `${c.height}-${c.ext}`;
    if (seen.has(key)) continue;
    seen.add(key);
    qualityDetails.push({
      candidateId: `archive-${c.ext}-${c.height || 0}`,
      height: c.height || 0,
      width: c.width || null,
      bandwidth: c.duration && c.size ? Math.round((c.size * 8) / Math.max(1, c.duration)) : 0,
      codec: c.format || c.ext,
      availability: 'available',
      available: true,
      probeStatus: 200,
      verificationMethod: 'internet-archive-metadata-api',
      checkedAt,
      url: c.url,
    });
  }
  return {
    ...video,
    kind: 'page',
    engine: 'internet-archive-native',
    title: String(title),
    duration: best.duration,
    width: best.width || null,
    height: best.height || 0,
    qualities: [...new Set(candidates.map(c => c.height).filter(h => h > 0))],
    qualityDetails,
    _candidates: candidates,
  };
}

export async function probeWikimediaCommons(video, signal) {
  const parsed = new URL(video.url);
  const fileMatch = /^\/wiki\/(File:[^#?]+)$/i.exec(parsed.pathname);
  if (!fileMatch) throw new ApiError('NO_MEDIA', '无效的 Wikimedia Commons 媒体页面', 422, { platform: 'wikimedia' });
  const fileTitle = decodeURIComponent(fileMatch[1]);
  const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileTitle)}&prop=imageinfo&iiprop=url|size|mime|mediatype|metadata&format=json`;
  const res = await fetch(apiUrl, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `Wikimedia API 返回 HTTP ${res.status}`, 502, { platform: 'wikimedia', status: res.status });
  }
  const data = await res.json();
  const page = Object.values(data?.query?.pages || {})[0];
  const info = page?.imageinfo?.[0];
  const mediaPathname = info?.url ? (URL.parse(info.url)?.pathname || '') : '';
  const isMedia = Boolean(info?.url) && (
    ['VIDEO', 'AUDIO'].includes(String(info.mediatype || '').toUpperCase())
    || /^(?:video|audio)\//i.test(info.mime || '')
    || /\.(?:webm|mp4|ogv|ogg|mp3|flac|wav)$/i.test(mediaPathname)
  );
  if (!isMedia) {
    throw new ApiError('NO_MEDIA', '该 Wikimedia Commons 页面不包含公开音视频文件', 422, { platform: 'wikimedia' });
  }
  const ext = path.extname(mediaPathname).slice(1).toLowerCase() || 'webm';
  const durationMeta = info.duration ?? (Array.isArray(info.metadata) ? info.metadata.find(m => m.name === 'length')?.value : null);
  const duration = Number(durationMeta) || null;
  const title = fileTitle.replace(/^File:/i, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  return {
    ...video,
    kind: 'page',
    engine: 'wikimedia-native',
    title,
    duration,
    width: Number(info.width) || null,
    height: Number(info.height) || 0,
    qualities: info.height ? [Number(info.height)] : [],
    qualityDetails: [{
      candidateId: `wikimedia-${ext}-${info.height || 0}`,
      height: Number(info.height) || 0,
      width: Number(info.width) || null,
      bandwidth: duration && info.size ? Math.round((info.size * 8) / Math.max(1, duration)) : 0,
      codec: info.mime || ext,
      availability: 'available',
      available: true,
      probeStatus: 200,
      verificationMethod: 'wikimedia-commons-api',
      checkedAt: new Date().toISOString(),
      url: info.url,
    }],
    _candidates: [{ url: info.url, ext, size: Number(info.size) || 0, height: Number(info.height) || 0 }],
  };
}

export async function stageDirectPublicPlatform(video, target, staging, signal, onProgress, { onQualityNegotiated } = {}) {
  const probed = video.platform === 'internet-archive'
    ? await probeInternetArchive(video, signal)
    : await probeWikimediaCommons(video, signal);
  target.title ||= probed.title;
  const candidates = probed._candidates || [];
  let chosen = candidates[0];
  let fallbackApplied = false;
  let reason = 'highest-available';
  if (target.mode === 'audio') {
    chosen = candidates.find(c => c.isAudio) || chosen;
    reason = 'audio-only';
  } else if (typeof target.quality === 'number') {
    const within = candidates.find(c => c.height > 0 && c.height <= target.quality);
    if (within) {
      chosen = within;
      fallbackApplied = within.height < target.quality;
      reason = within.height === target.quality ? 'exact-cap-match' : 'highest-within-cap';
    } else {
      fallbackApplied = true;
      reason = 'fallback-available-source';
    }
  }
  if (!chosen?.url) throw new ApiError('NO_MEDIA', '未找到可下载的公开媒体文件', 422, { platform: video.platform });
  onQualityNegotiated?.(buildQualityNegotiationReport({
    requestedQuality: target.qualitySpec ?? target.quality ?? 'best',
    availableQualities: probed.qualities ?? [],
    declaredQuality: { height: chosen.height || null, width: chosen.width || null, codec: chosen.ext || null, formatKind: video.platform },
    selectedQuality: { height: chosen.height || null, width: chosen.width || null, codec: chosen.ext || null, formatKind: video.platform },
    fallbackApplied,
    fallbackReason: fallbackApplied ? reason : null,
    reason,
    verificationStatus: 'pending',
  }));

  const res = await fetch(chosen.url, {
    signal,
    headers: { 'User-Agent': DEFAULT_UA },
  });
  if ([401, 402, 403, 451].includes(res.status)) {
    await res.body?.cancel().catch(() => {});
    throw new ApiError('MEDIA_ACCESS_RESTRICTED', `平台拒绝访问（HTTP ${res.status}）`, 403, { platform: video.platform, status: res.status });
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `下载公开媒体失败（HTTP ${res.status}）`, 502, { platform: video.platform, status: res.status });
  }

  const total = Number(res.headers.get('content-length')) || chosen.size || 0;
  const ext = ['mp4', 'webm', 'mkv', 'mov', 'ogv', 'm4a', 'mp3', 'ogg', 'flac', 'wav'].includes(chosen.ext) ? chosen.ext : 'mp4';
  const outFile = path.join(staging, `platform.${ext}`);
  const ws = createWriteStream(outFile);
  let written = 0;
  try {
    for await (const chunk of res.body) {
      signal.throwIfAborted();
      const buf = Buffer.from(chunk);
      await paceBandwidth(buf.length, signal);
      ws.write(buf);
      written += buf.length;
      onProgress?.(total ? written / total : null, written, total);
    }
    await new Promise((resolve, reject) => ws.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    ws.destroy();
    throw err;
  }
  const st = await stat(outFile).catch(() => null);
  if (!st?.isFile() || st.size < 256) {
    throw new ApiError('INVALID_MEDIA_CONTENT', '公开媒体下载为空或文件损坏', 422, { platform: video.platform });
  }
  return outFile;
}
