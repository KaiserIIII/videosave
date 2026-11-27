import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, FFMPEG, runMedia } from './media-source.mjs';

const installed = new URL('../.local-tools/yt-dlp.exe', import.meta.url);
function extractorPath() {
  return process.env.YTDLP_BIN || (process.platform === 'win32' && existsSync(installed) ? fileURLToPath(installed) : null);
}

export function platformDownloadsEnabled() {
  return Boolean(extractorPath());
}

export function platformFailure(platform, {failure, stdout = '', stderr = ''}) {
  if (failure) return new ApiError('PLATFORM_TOOL_REQUIRED', '无法启动 yt-dlp，请检查 YTDLP_BIN', 503);
  const status = Number(/(?:HTTP Error|Server returned) (\d{3})/i.exec(stderr)?.[1] ??
    /^\[download\].*?\bHTTP Error (\d{3})/im.exec(stdout)?.[1]);
  const detail = {platform,...(status && {status})};
  if ([401,402,403,451].includes(status) || platform === 'bilibili' && status === 567) {
    return new ApiError('MEDIA_ACCESS_RESTRICTED', `平台媒体服务器拒绝访问（HTTP ${status}）`,403,detail);
  }
  return new ApiError('PLATFORM_DOWNLOAD_FAILED', status ? `平台媒体服务器返回 HTTP ${status}` :
    '本机解析器无法读取该视频，请确认视频公开可播放，并检查 yt-dlp 版本',502,detail);
}

function runExtractor(video, args, signal, onLine) {
  const executable = extractorPath();
  if (!executable) throw new ApiError('PLATFORM_TOOL_REQUIRED', '请配置本机 yt-dlp 后重试', 503);
  return runMedia(executable, [
    '--ignore-config', '--no-playlist', '--no-cache-dir', '--no-remote-components', '--no-plugin-dirs',
    '--encoding', 'utf-8', '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2',
    '--match-filters', '!is_live & !is_upcoming & !has_drm',
    ...(video.platform === 'youtube' ? ['--no-js-runtimes', '--js-runtimes', 'node:' + process.execPath] : []),
    ...(FFMPEG !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG] : []),
    ...args, '--', video.url,
  ], signal, onLine, {onFailure:result => platformFailure(video.platform,result)});
}

export async function probePlatform(video, signal) {
  const result = await runExtractor(video, [
    '--skip-download', '--print', '%(.{title,duration,thumbnail})j',
    '--print', '%(formats.:.{height,width,vcodec,has_drm})j',
  ], AbortSignal.any([signal, AbortSignal.timeout(55_000)]));
  let metadata, formats;
  try { [metadata, formats] = result.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '本机解析器没有返回可用的视频信息', 502); }
  const videos = Array.isArray(formats) ? formats.filter(format => format.height > 0 &&
    format.vcodec && format.vcodec !== 'none' && !format.has_drm).sort((a,b) => b.height - a.height) : [];
  const best = videos[0];
  if (!metadata?.title || !best) throw new ApiError('NO_MEDIA', '平台未提供可下载的视频轨', 422);
  const poster = URL.parse(metadata.thumbnail ?? '');
  return {
    ...video, kind:'page', title:metadata.title, duration:metadata.duration ?? null,
    width:best.width ?? null, height:best.height, qualities:[...new Set(videos.map(({height})=>height))],
    ...(poster?.protocol === 'https:' && {poster:poster.href}),
  };
}

function selection({mode, quality}) {
  if (mode === 'audio') return 'ba/b';
  const cap = quality ? '[height<=' + quality + ']' : '';
  const low = quality ? '/wv+ba/w' : '';
  if (mode === 'video') return 'bv*' + cap + (quality ? '/wv*/w' : '/b');
  return 'bv' + cap + '+ba/b' + cap + low;
}

export async function stagePlatform(video, target, staging, connections, signal, onProgress, headers = {}) {
  const transfers = new Map();
  await runExtractor(video, [
    ...Object.entries(headers).flatMap(([name,value]) => ['--add-headers',name + ':' + value]),
    '--no-simulate', '--newline', '--progress', '--progress-template',
    'download:videosave=%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
    '--concurrent-fragments', String(connections), '--windows-filenames', '--no-mtime',
    '-f', selection(target), '--merge-output-format', 'mkv', '-P', staging, '-o', 'platform.%(ext)s',
    '--print', 'after_move:%(title)j',
  ], signal, line => {
    const progress = /^videosave=([^|]+)\|(\d+)\|(\d+|NA)\|(\d+|NA)$/.exec(line);
    if (progress) {
      const [, id, bytes, total, estimate] = progress;
      transfers.set(id, {bytes:Number(bytes), total:Number(total) || Number(estimate) || 0});
      const samples = [...transfers.values()];
      const received = samples.reduce((sum, sample) => sum + sample.bytes, 0);
      const length = samples.reduce((sum, sample) => sum + Math.max(sample.bytes, sample.total), 0);
      onProgress(length ? received / length : null, received, length);
    }
    if (line.startsWith('"')) {
      try { target.title ||= JSON.parse(line); } catch {}
    }
  });
  const files = await readdir(staging, {withFileTypes:true});
  const media = files.find(file => file.isFile() && /^platform\.(?:mp4|m4a|mp3|mkv|webm|ogg|opus|aac|mov|flac)$/.test(file.name));
  if (!media) throw new ApiError('NO_MEDIA', '本机解析器没有生成媒体文件', 422);
  return path.join(staging, media.name);
}
