import { platformDownloadsEnabled, platformSupported } from './platform-downloads.mjs';
import { streamlinkAvailable } from './streamlink-adapter.mjs';

export const NON_FALLBACK_ERROR_CODES = new Set([
  'MEDIA_ACCESS_RESTRICTED',
  'MCP_MEDIA_ACCESS_RESTRICTED',
  'DRM',
  'NO_SPACE',
  'SESSION_EXPIRED',
  'LOGIN_REQUIRED',
  'QUALITY_UNAVAILABLE',
  'INVALID_HLS_SEGMENT',
  'INVALID_DASH_SEGMENT',
  'INVALID_MEDIA_CONTENT',
  'MCP_MEDIA_REDIRECT',
  'MCP_MEDIA_SCOPE',
]);

export function shouldAbortFallback(error) {
  if (!error) return false;
  if (NON_FALLBACK_ERROR_CODES.has(error.code)) return true;
  if ([401, 402, 403, 451].includes(error.status) || [401, 402, 403, 451].includes(error.detail?.status)) return true;
  return false;
}

export function listRegisteredEngines() {
  return [
    {
      id: 'http',
      label: 'VideoSave Native HTTP Range',
      protocols: ['mp4', 'webm', 'mkv', 'mov', 'flv', 'm4a', 'mp3', 'aac', 'wav', 'flac'],
      available: true,
      supportsResume: true,
      supportsMultiConnection: true,
    },
    {
      id: 'hls',
      label: 'VideoSave Native HLS Prefetch',
      protocols: ['m3u8', 'hls-vod', 'hls-byterange', 'hls-aes128', 'hls-fmp4'],
      available: true,
      supportsResume: true,
      supportsMultiConnection: true,
    },
    {
      id: 'dash-static',
      label: 'VideoSave Native Static DASH',
      protocols: ['mpd', 'dash-static', 'cmaf', 'webm-dash'],
      available: true,
      supportsResume: true,
      supportsMultiConnection: true,
    },
    {
      id: 'ffmpeg',
      label: 'FFmpeg Direct / Muxer',
      protocols: ['m3u8', 'mpd', 'mp4', 'webm', 'mkv', 'mov', 'flv', 'ts', 'hls-live-bounded'],
      available: true,
      supportsResume: false,
      supportsMultiConnection: false,
    },
    {
      id: 'bilibili-native',
      label: 'VideoSave Native Bilibili (Multi-CDN Range + FFmpeg)',
      protocols: ['bilibili'],
      available: true,
      supportsResume: true,
      supportsMultiConnection: true,
    },
    {
      id: 'public-native',
      label: 'VideoSave Native Public Platforms (Internet Archive / Wikimedia)',
      protocols: ['internet-archive', 'wikimedia'],
      available: true,
      supportsResume: true,
      supportsMultiConnection: false,
    },
    {
      id: 'yt-dlp',
      label: 'Managed Platform Extractor (yt-dlp)',
      protocols: ['youtube', 'vimeo', 'bilibili'],
      available: platformDownloadsEnabled(),
      supportsResume: true,
      supportsMultiConnection: true,
    },
    {
      id: 'streamlink',
      label: 'Optional Streamlink Adapter',
      protocols: ['hls-live-bounded'],
      available: streamlinkAvailable(),
      supportsResume: false,
      supportsMultiConnection: false,
    },
  ];
}

/**
 * Compute an executable, auditable download engine plan based on protocol, platform,
 * authorization scope, historical compatibility data, and live engine availability.
 * Never selects fallback engines to circumvent access controls or DRM.
 */
export function planDownloadEngines({
  sourceKind = null,
  platform = null,
  prefetch = true,
  hasAuthorization = false,
  maxSec = null,
  historyRule = null,
  liveStream = false,
} = {}) {
  const steps = [];
  let rationale = 'default-native';

  if (hasAuthorization) {
    if (sourceKind === 'mpd') steps.push('dash-static');
    else if (sourceKind === 'm3u8') steps.push('hls');
    else steps.push('http');
    return {
      primary: steps[0],
      fallbacks: [],
      order: steps,
      rationale: 'managed-authorized-native-only',
      strictTerminationCodes: [...NON_FALLBACK_ERROR_CODES],
    };
  }

  if (platform && platformSupported(platform)) {
    const engineId = platform === 'bilibili'
      ? 'bilibili-native'
      : (platform === 'internet-archive' || platform === 'wikimedia')
        ? 'public-native'
        : 'yt-dlp';
    steps.push(engineId);
    return {
      primary: engineId,
      fallbacks: [],
      order: steps,
      rationale: `recognized-platform:${platform}`,
      strictTerminationCodes: [...NON_FALLBACK_ERROR_CODES],
    };
  }

  if (!prefetch) {
    steps.push('ffmpeg');
    return {
      primary: 'ffmpeg',
      fallbacks: [],
      order: steps,
      rationale: maxSec ? 'bounded-clip-ffmpeg' : 'prefetch-disabled',
      strictTerminationCodes: [...NON_FALLBACK_ERROR_CODES],
    };
  }

  if (sourceKind === 'm3u8') {
    if (liveStream && maxSec) {
      if (streamlinkAvailable()) steps.push('streamlink');
      steps.push('ffmpeg');
      rationale = 'bounded-live-hls';
    } else if (historyRule?.bestEngine === 'ffmpeg' && historyRule.samples >= 3 && historyRule.successes === 0) {
      steps.push('hls', 'ffmpeg');
      rationale = 'native-hls-with-learned-ffmpeg-fallback';
    } else {
      steps.push('hls', 'ffmpeg');
      rationale = 'native-hls-primary';
    }
  } else if (sourceKind === 'mpd') {
    steps.push('dash-static', 'ffmpeg');
    rationale = 'native-dash-primary';
  } else {
    steps.push('http', 'ffmpeg');
    rationale = 'native-http-range-primary';
  }

  return {
    primary: steps[0],
    fallbacks: steps.slice(1),
    order: steps,
    rationale,
    strictTerminationCodes: [...NON_FALLBACK_ERROR_CODES],
  };
}
