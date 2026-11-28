import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformVideo } from '../extension/media.mjs';
import { ApiError, FFMPEG, runMedia } from './media-source.mjs';
import { locateManagedBinary } from './runtime-manager.mjs';

const installed = new URL('../.local-tools/yt-dlp.exe', import.meta.url);
export function extractorPath() {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  if (process.platform === 'win32' && existsSync(installed)) return fileURLToPath(installed);
  return locateManagedBinary('yt-dlp')?.path ?? null;
}

export function platformDownloadsEnabled() {
  return Boolean(extractorPath());
}

/**
 * Safely resolve legitimate b23.tv short links (strictly verifying destination stays on bilibili.com).
 */
export async function resolvePlatformShortLink(video, signal) {
  if (!video?.shortLink || video.platform !== 'bilibili') return video;
  const res = await fetch(video.url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  await res.body?.cancel().catch(() => {});
  const location = res.headers.get('location');
  if (!location) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '无法解析 Bilibili 短链接目标地址', 502, { platform: 'bilibili' });
  }
  const canonical = platformVideo(new URL(location, video.url).href);
  if (!canonical || canonical.platform !== 'bilibili' || canonical.shortLink) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', 'Bilibili 短链接未指向标准视频页面', 422, { platform: 'bilibili' });
  }
  return canonical;
}

export function platformFailure(platform, { failure, stdout = '', stderr = '' }) {
  if (failure) {
    return new ApiError('PLATFORM_TOOL_REQUIRED', '无法启动 yt-dlp，请运行 Start VideoSave.cmd 自动安装或检查 YTDLP_BIN', 503, {
      platform,
      category: 'component-missing',
    });
  }
  const combined = `${stderr}\n${stdout}`;
  if (/DRM|Widevine|PlayReady|FairPlay|protected/i.test(combined)) {
    return new ApiError('DRM', '该平台视频受 DRM 保护，不支持下载', 422, { platform, category: 'drm-or-restricted' });
  }
  if (/Sign in to confirm|login required|requires authentication|members-only|HTTP Error 401/i.test(combined)) {
    return new ApiError('LOGIN_REQUIRED', '该平台视频需要正常登录账号后才能访问', 401, { platform, category: 'login-required' });
  }
  if (/Video unavailable|Private video|This video has been removed|not available in your country/i.test(combined)) {
    return new ApiError('NO_MEDIA', '该平台视频不可用、已下架或受地区限制', 422, { platform, category: 'download-not-allowed' });
  }
  const status = Number(/(?:HTTP Error|Server returned) (\d{3})/i.exec(stderr)?.[1] ??
    /^\[download\].*?\bHTTP Error (\d{3})/im.exec(stdout)?.[1]);
  const detail = { platform, ...(status && { status }) };
  if ([401, 402, 403, 451].includes(status) || (platform === 'bilibili' && status === 567)) {
    return new ApiError('MEDIA_ACCESS_RESTRICTED', `平台媒体服务器拒绝访问（HTTP ${status}）`, 403, detail);
  }
  if (/timed out|Connection reset|getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(combined)) {
    return new ApiError('PLATFORM_DOWNLOAD_FAILED', '连接平台媒体服务器超时或网络异常', 502, detail);
  }
  return new ApiError('PLATFORM_DOWNLOAD_FAILED', status ? `平台媒体服务器返回 HTTP ${status}` :
    '本机解析器无法读取该视频，请确认视频公开可播放，并检查 yt-dlp 版本', 502, detail);
}

function runExtractor(video, args, signal, onLine) {
  const executable = extractorPath();
  if (!executable) {
    throw new ApiError('PLATFORM_TOOL_REQUIRED', '请运行 Start VideoSave.cmd 自动准备本机 yt-dlp 或配置 YTDLP_BIN 后重试', 503, {
      platform: video.platform,
      category: 'component-missing',
    });
  }
  return runMedia(executable, [
    '--ignore-config', '--no-playlist', '--no-cache-dir', '--no-remote-components', '--no-plugin-dirs',
    '--encoding', 'utf-8', '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2',
    '--match-filters', '!is_live & !is_upcoming & !has_drm',
    ...(video.platform === 'youtube' ? ['--no-js-runtimes', '--js-runtimes', 'node:' + process.execPath] : []),
    ...(FFMPEG !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG] : []),
    ...args, '--', video.url,
  ], signal, onLine, { onFailure: result => platformFailure(video.platform, result) });
}

export async function probePlatform(video, signal) {
  const resolved = await resolvePlatformShortLink(video, signal);
  const result = await runExtractor(resolved, [
    '--skip-download', '--print', '%(.{title,duration,thumbnail,subtitles})j',
    '--print', '%(formats.:.{format_id,height,width,fps,tbr,vcodec,acodec,has_drm,ext})j',
  ], AbortSignal.any([signal, AbortSignal.timeout(55_000)]));
  let metadata, formats;
  try { [metadata, formats] = result.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '本机解析器没有返回可用的视频信息', 502); }
  const videos = Array.isArray(formats)
    ? formats.filter(format => format.height > 0 && format.vcodec && format.vcodec !== 'none' && !format.has_drm)
      .sort((a, b) => b.height - a.height || (b.tbr || 0) - (a.tbr || 0))
    : [];
  const audios = Array.isArray(formats)
    ? formats.filter(format => (!format.vcodec || format.vcodec === 'none') && format.acodec && format.acodec !== 'none' && !format.has_drm)
    : [];
  const best = videos[0];
  if (!metadata?.title || !best) throw new ApiError('NO_MEDIA', '平台未提供可下载的视频轨', 422);
  const poster = URL.parse(metadata.thumbnail ?? '');
  const checkedAt = new Date().toISOString();
  const seenHeights = new Set();
  const detailedQualities = [];
  for (const v of videos) {
    if (seenHeights.has(v.height)) continue;
    seenHeights.add(v.height);
    detailedQualities.push({
      candidateId: `${video.platform}-${v.format_id ?? v.height}`,
      height: v.height,
      width: v.width ?? null,
      bandwidth: v.tbr ? Math.round(v.tbr * 1000) : 0,
      codec: v.vcodec ?? null,
      frameRate: v.fps ?? null,
      audioTracks: audios.length ? [{ codecs: audios[0].acodec ?? null, bandwidth: audios[0].tbr ? Math.round(audios[0].tbr * 1000) : 0 }] : [],
      subtitleTracks: metadata.subtitles && typeof metadata.subtitles === 'object' ? Object.keys(metadata.subtitles).map(lang => ({ language: lang })) : [],
      availability: 'available',
      available: true,
      probeStatus: 200,
      verificationMethod: 'platform-extractor',
      checkedAt,
      url: video.url,
    });
  }
  return {
    ...video,
    kind: 'page',
    title: metadata.title,
    duration: metadata.duration ?? null,
    width: best.width ?? null,
    height: best.height,
    qualities: [...seenHeights],
    qualityDetails: detailedQualities,
    ...(poster?.protocol === 'https:' && { poster: poster.href }),
  };
}

function selection({ mode, quality }) {
  if (mode === 'audio') return 'ba/b';
  const cap = quality ? '[height<=' + quality + ']' : '';
  const low = quality ? '/wv+ba/w' : '';
  if (mode === 'video') return 'bv*' + cap + (quality ? '/wv*/w' : '/b');
  return 'bv' + cap + '+ba/b' + cap + low;
}

export async function stagePlatform(video, target, staging, connections, signal, onProgress, headers = {}) {
  const resolved = await resolvePlatformShortLink(video, signal);
  const transfers = new Map();
  const subArgs = target.subtitles ? ['--write-subs', '--sub-langs', 'zh.*,en.*,all', '--embed-subs'] : [];
  await runExtractor(resolved, [
    ...Object.entries(headers).flatMap(([name, value]) => ['--add-headers', name + ':' + value]),
    '--no-simulate', '--newline', '--progress', '--progress-template',
    'download:videosave=%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
    '--concurrent-fragments', String(connections), '--windows-filenames', '--no-mtime',
    '-f', selection(target), '--merge-output-format', 'mkv', ...subArgs, '-P', staging, '-o', 'platform.%(ext)s',
    '--print', 'after_move:%(title)j',
  ], signal, line => {
    const progress = /^videosave=([^|]+)\|(\d+)\|(\d+|NA)\|(\d+|NA)$/.exec(line);
    if (progress) {
      const [, id, bytes, total, estimate] = progress;
      transfers.set(id, { bytes: Number(bytes), total: Number(total) || Number(estimate) || 0 });
      const samples = [...transfers.values()];
      const received = samples.reduce((sum, sample) => sum + sample.bytes, 0);
      const length = samples.reduce((sum, sample) => sum + Math.max(sample.bytes, sample.total), 0);
      onProgress(length ? received / length : null, received, length);
    }
    if (line.startsWith('"')) {
      try { target.title ||= JSON.parse(line); } catch {}
    }
  });
  const files = await readdir(staging, { withFileTypes: true });
  const media = files.find(file => file.isFile() && /^platform\.(?:mp4|m4a|mp3|mkv|webm|ogg|opus|aac|mov|flac)$/.test(file.name));
  if (!media) throw new ApiError('NO_MEDIA', '本机解析器没有生成媒体文件', 422);
  return path.join(staging, media.name);
}
