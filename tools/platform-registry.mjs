/**
 * Maintainable, evidence-backed platform capability registry for VideoSave.
 *
 * Honesty policy:
 * - Never claims upstream yt-dlp's site list as VideoSave's verified platform count.
 * - Each platform explicitly separates status:
 *     verified | partial | probe-only | unverified | unsupported
 * - Updated strictly from real reproducible verification reports in docs/compatibility-data/.
 */

export const PLATFORM_CAPABILITY_REGISTRY = Object.freeze([
  {
    id: 'bilibili',
    name: 'Bilibili',
    domains: ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com', 'b23.tv'],
    engine: 'bilibili-native (built-in API + multi-CDN failover + HTTP Range + FFmpeg mux; zero yt-dlp required)',
    status: 'verified',
    capabilities: {
      identify: true,
      pageParse: true,
      videoDownload: true,
      audioDownload: true,
      subtitles: true,
      multiQuality: true,
      multiPartPages: true,
      batchQueue: true,
      authorizedLoginSession: true,
      liveRecording: false,
      androidNative: true,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: 'docs/compatibility-data/v1.3.0-bilibili-public.json',
    knownLimitations: [
      'Anonymous sessions receive public qualities (typically 360p–720p/1080p depending on video). Higher authorized tiers require a user-imported Bilibili cookie session.',
      'Paid/VIP-only bangumi, region-locked entries, and DRM-protected streams are strictly refused without circumvention.',
    ],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    domains: ['www.youtube.com', 'm.youtube.com', 'youtube.com', 'youtu.be', 'music.youtube.com'],
    engine: 'managed yt-dlp + Node 24 JS runtime + FFmpeg mux',
    status: 'verified',
    capabilities: {
      identify: true,
      pageParse: true,
      videoDownload: true,
      audioDownload: true,
      subtitles: true,
      multiQuality: true,
      multiPartPages: false,
      batchQueue: true,
      authorizedLoginSession: true,
      liveRecording: false,
      androidNative: false,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: 'docs/compatibility-data/v1.3.0-platforms-public.json',
    knownLimitations: [
      'Requires managed yt-dlp + Node.js >= 24 (auto-managed on desktop; not bundled on Android APK).',
      'Members-only, age-gated, private, and DRM-protected videos are not bypassed.',
    ],
  },
  {
    id: 'internet-archive',
    name: 'Internet Archive',
    domains: ['archive.org'],
    engine: 'internet-archive-native (built-in Metadata API + HTTP Range; zero yt-dlp required)',
    status: 'verified',
    capabilities: {
      identify: true,
      pageParse: true,
      videoDownload: true,
      audioDownload: true,
      subtitles: false,
      multiQuality: true,
      multiPartPages: false,
      batchQueue: true,
      authorizedLoginSession: false,
      liveRecording: false,
      androidNative: true,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: 'docs/compatibility-data/v1.3.0-platforms-public.json',
    knownLimitations: [
      'Supports public open-access items with downloadable MP4/WebM/OGV/audio derivatives; lending-library DRM items are excluded.',
    ],
  },
  {
    id: 'wikimedia',
    name: 'Wikimedia Commons',
    domains: ['commons.wikimedia.org'],
    engine: 'wikimedia-native (built-in MediaWiki imageinfo API + HTTP Range; zero yt-dlp required)',
    status: 'verified',
    capabilities: {
      identify: true,
      pageParse: true,
      videoDownload: true,
      audioDownload: true,
      subtitles: false,
      multiQuality: false,
      multiPartPages: false,
      batchQueue: true,
      authorizedLoginSession: false,
      liveRecording: false,
      androidNative: true,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: 'docs/compatibility-data/v1.3.0-platforms-public.json',
    knownLimitations: [
      'Downloads the canonical original WebM/OGV/MP4/audio asset published under its Creative Commons / public domain license.',
    ],
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    domains: ['vimeo.com', 'player.vimeo.com'],
    engine: 'managed yt-dlp / browser extension HLS+DASH capture',
    status: 'partial',
    capabilities: {
      identify: true,
      pageParse: true,
      videoDownload: true,
      audioDownload: true,
      subtitles: true,
      multiQuality: true,
      multiPartPages: false,
      batchQueue: true,
      authorizedLoginSession: true,
      liveRecording: false,
      androidNative: false,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: 'docs/compatibility-data/v1.3.0-platforms-public.json',
    knownLimitations: [
      'Public embeddable videos work via managed yt-dlp or browser capture; password-protected, domain-locked, or private VODs are strictly respected.',
    ],
  },
  {
    id: 'open-hls-dash-html5',
    name: 'Standard HTML5 / HLS / LL-HLS / Static & Dynamic DASH / Public Podcasts',
    domains: ['* (any authorized public web origin)'],
    engine: 'VideoSave native HTTP Range + HLS + LL-HLS + DASH + FFmpeg/Streamlink',
    status: 'verified',
    capabilities: {
      identify: true,
      pageParse: true,
      videoDownload: true,
      audioDownload: true,
      subtitles: true,
      multiQuality: true,
      multiPartPages: false,
      batchQueue: true,
      authorizedLoginSession: true,
      liveRecording: true,
      androidNative: true,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: 'docs/compatibility-data/v1.2.0-dsh-acceptance.json',
    knownLimitations: [
      'Live HLS/DASH streams require explicit bounded maxSeconds limit.',
      'DRM (Widevine/PlayReady/FairPlay/SAMPLE-AES), CAPTCHAs, and HTTP 401/403/451 restrictions are never bypassed.',
    ],
  },
  {
    id: 'drm-subscription-platforms',
    name: 'DRM Subscription Streaming Platforms (Widevine/PlayReady/FairPlay)',
    domains: ['netflix.com', 'disneyplus.com', 'primevideo.com', 'iqiyi.com (DRM)', 'v.qq.com (DRM)'],
    engine: 'none (explicitly refused)',
    status: 'unsupported',
    capabilities: {
      identify: false,
      pageParse: false,
      videoDownload: false,
      audioDownload: false,
      subtitles: false,
      multiQuality: false,
      multiPartPages: false,
      batchQueue: false,
      authorizedLoginSession: false,
      liveRecording: false,
      androidNative: false,
    },
    lastVerifiedAt: '2026-11-28',
    verificationReport: null,
    knownLimitations: [
      'VideoSave detects EME/DRM declarations and explicitly reports DRM without attempting decryption or bypass.',
    ],
  },
]);

export function getPlatformCapabilitySummary() {
  const counts = { verified: 0, partial: 0, 'probe-only': 0, unverified: 0, unsupported: 0 };
  for (const entry of PLATFORM_CAPABILITY_REGISTRY) {
    if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
  }
  return {
    updatedAt: '2026-11-28',
    honestyNote: 'Counts reflect only platforms directly tested and verified by VideoSave — never upstream extractor totals.',
    counts,
    platforms: PLATFORM_CAPABILITY_REGISTRY,
  };
}
