import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { platformVideo } from '../extension/media.mjs';
import { ApiError, FFMPEG, runMedia } from './media-source.mjs';
import { buildQualityNegotiationReport, negotiateQuality, normalizeQualitySpec } from './quality-negotiator.mjs';
import { paceBandwidth, recordHostFailure, recordHostSuccess } from './rate-controller.mjs';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BILIBILI_API_HOSTS = new Set(['api.bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'bilibili.com']);
// Access denials and non-standard Bilibili 567 policy rejections strictly abort without mirror rotation.
const ACCESS_DENIED_STATUSES = new Set([401, 402, 403, 412, 451, 567]);
// Only standard RFC transient server/network failures may fail over across Bilibili's official backup_url mirrors.
const RETRYABLE_CDN_STATUSES = new Set([408, 500, 502, 503, 504]);
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB adaptive range chunks
const directHttpsAgent = new https.Agent({ keepAlive: true });
let cachedPublicBuvidCookie = '';

function isPrivateOrLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIPv4(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  if (net.isIPv6(host)) {
    if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  }
  return false;
}

export function isSafeBilibiliMediaUrl(rawUrl) {
  const parsed = URL.parse(rawUrl);
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (isPrivateOrLoopbackHost(parsed.hostname)) return false;
  return true;
}

/**
 * Rank official Bilibili CDN mirrors returned in [baseUrl, ...backupUrl].
 * Prefers stable domestic UPOS / CN edge mirrors over known flaky overseas/PCDN nodes
 * (e.g. upos-sz-mirrorcosov / mcdn / pcdn that frequently return transient HTTP 567).
 * Strictly uses only official URLs returned by Bilibili's own playurl response.
 */
export function rankCdnMirrors(urls) {
  const unique = [];
  const seen = new Set();
  for (const raw of urls) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (seen.has(trimmed) || !isSafeBilibiliMediaUrl(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  const score = u => {
    const host = new URL(u).hostname.toLowerCase();
    // Deprioritize known flaky overseas / PCDN / mcdn nodes (commonly return 567 or slow P2P)
    if (/(?:^|\.)mcdn\.|mountaintoys\.cn|szbdyd\.com|mirrorcosov|pcdn|^\d+\.\d+\.\d+\.\d+$/.test(host)) return 30;
    if (/^upos-sz-(?:mirrorcos|mirrorcoso1|estgoss|mirrorhw|mirrorali|mirrorbd)\.bilivideo\.com$/.test(host)) return 0;
    if (/^upos-.*\.bilivideo\.com$/.test(host)) return 5;
    if (/^cn-.*\.bilivideo\.com$/.test(host)) return 8;
    if (/\.bilivideo\.(?:com|cn)$/.test(host)) return 12;
    return 20;
  };
  return unique.sort((a, b) => score(a) - score(b));
}

function buildCookieHeader(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return '';
  return cookies
    .filter(c => c && c.name && typeof c.value === 'string' && (!c.domain || /(?:^|\.)bilibili\.com$/i.test(c.domain)))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function bilibiliHeaders({ referer = 'https://www.bilibili.com/', userAgent, cookies, includeCookie = false } = {}) {
  const hdrs = {
    'User-Agent': userAgent || DEFAULT_UA,
    Referer: referer,
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (includeCookie) {
    const cookieStr = buildCookieHeader(cookies) || cachedPublicBuvidCookie;
    if (cookieStr) hdrs.Cookie = cookieStr;
  }
  return hdrs;
}

export function parseBilibiliId(rawUrl) {
  const canonical = platformVideo(rawUrl);
  if (!canonical || canonical.platform !== 'bilibili') return null;
  if (canonical.shortLink) return { shortLink: true, url: canonical.url };
  const parsed = new URL(canonical.url);
  const match = /^\/video\/(BV[A-Za-z0-9]{10}|av([1-9]\d*))\/?$/i.exec(parsed.pathname);
  if (!match) return null;
  const id = match[1];
  const p = Number.parseInt(parsed.searchParams.get('p') || '1', 10);
  const partIndex = Number.isInteger(p) && p >= 1 ? p : 1;
  return {
    shortLink: false,
    bvid: id.startsWith('BV') ? id : null,
    aid: match[2] ? Number(match[2]) : null,
    partIndex,
    url: canonical.url,
  };
}

export async function resolveBilibiliShortLink(video, signal) {
  if (!video?.shortLink) return video;
  const res = await fetch(video.url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { 'User-Agent': DEFAULT_UA },
  });
  await res.body?.cancel().catch(() => {});
  const location = res.headers.get('location');
  if (!location) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '无法解析 Bilibili 短链接目标地址', 502, { platform: 'bilibili' });
  }
  const dest = new URL(location, video.url);
  if (!BILIBILI_API_HOSTS.has(dest.hostname.toLowerCase())) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', 'Bilibili 短链接未指向合法的 Bilibili 视频页面', 422, { platform: 'bilibili' });
  }
  const canonical = platformVideo(dest.href);
  if (!canonical || canonical.platform !== 'bilibili' || canonical.shortLink) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', 'Bilibili 短链接未指向标准视频页面', 422, { platform: 'bilibili' });
  }
  return canonical;
}

async function ensurePublicBuvidCookie(signal, userAgent) {
  if (cachedPublicBuvidCookie) return cachedPublicBuvidCookie;
  try {
    const res = await httpGetRaw('https://www.bilibili.com/', {
      'User-Agent': userAgent || DEFAULT_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, signal, true);
    const setCookies = res.headers['set-cookie'] || [];
    res.resume();
    res.destroy();
    const pairs = setCookies.map(c => String(c).split(';')[0]).filter(Boolean);
    if (pairs.length) cachedPublicBuvidCookie = pairs.join('; ');
  } catch {}
  return cachedPublicBuvidCookie;
}

async function fetchBiliJsonDirect(urlStr, signal, headers) {
  let res = await httpGetRaw(urlStr, headers, signal, true);
  if (res.statusCode === 412 && !headers.Cookie) {
    res.destroy();
    const buvid = await ensurePublicBuvidCookie(signal, headers['User-Agent']);
    if (buvid) {
      res = await httpGetRaw(urlStr, { ...headers, Cookie: buvid }, signal, true);
    }
  }
  const status = res.statusCode;
  if ([401, 402, 403, 451].includes(status)) {
    res.destroy();
    throw new ApiError('MEDIA_ACCESS_RESTRICTED', `Bilibili 接口拒绝访问（HTTP ${status}）`, 403, { platform: 'bilibili', status });
  }
  if (status < 200 || status >= 300) {
    res.destroy();
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `Bilibili 接口返回 HTTP ${status}`, 502, { platform: 'bilibili', status });
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchBiliJson(urlStr, signal, { referer, userAgent, cookies } = {}) {
  const parsed = new URL(urlStr);
  if (!BILIBILI_API_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '拒绝访问非 Bilibili 官方接口主机', 422, { platform: 'bilibili' });
  }
  const hdrs = bilibiliHeaders({ referer, userAgent, cookies, includeCookie: true });
  // Prefer direct local TLS connection for domestic Bilibili APIs so global overseas proxies do not trigger 412/timeouts;
  // fall back to global fetch (respecting configured proxy) if direct socket fails.
  try {
    return await fetchBiliJsonDirect(urlStr, signal, hdrs);
  } catch (directErr) {
    if (directErr instanceof ApiError && directErr.code === 'MEDIA_ACCESS_RESTRICTED') throw directErr;
    const res = await fetch(urlStr, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: hdrs,
    });
    if ([401, 402, 403, 451].includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError('MEDIA_ACCESS_RESTRICTED', `Bilibili 接口拒绝访问（HTTP ${res.status}）`, 403, { platform: 'bilibili', status: res.status });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `Bilibili 接口返回 HTTP ${res.status}`, 502, { platform: 'bilibili', status: res.status });
    }
    return await res.json();
  }
}

function classifyBiliApiCode(code, message = '') {
  if (code === 0) return null;
  if (code === -404 || code === 62002 || code === 62004 || code === 62012) {
    return new ApiError('NO_MEDIA', '该 Bilibili 视频不存在、已下架或仅作者可见', 422, { platform: 'bilibili', biliCode: code });
  }
  if (code === -10403) {
    const isLogin = /登录|大会员|付费|vip/i.test(message);
    return new ApiError(
      isLogin ? 'LOGIN_REQUIRED' : 'MEDIA_ACCESS_RESTRICTED',
      isLogin ? '该 Bilibili 视频需要合法登录或对应会员授权' : '该 Bilibili 视频受地区或版权访问限制',
      isLogin ? 401 : 403,
      { platform: 'bilibili', biliCode: code },
    );
  }
  if (code === -101) {
    return new ApiError('LOGIN_REQUIRED', '该 Bilibili 视频需要正常登录账号后才能访问', 401, { platform: 'bilibili', biliCode: code });
  }
  return new ApiError('PLATFORM_DOWNLOAD_FAILED', `Bilibili API 返回错误码 ${code}`, 502, { platform: 'bilibili', biliCode: code });
}

function normalizePosterUrl(pic) {
  if (typeof pic !== 'string' || !pic.trim()) return null;
  const fixed = pic.startsWith('http://') ? 'https://' + pic.slice(7) : pic.startsWith('//') ? 'https:' + pic : pic;
  const parsed = URL.parse(fixed);
  return parsed?.protocol === 'https:' ? parsed.href : null;
}

function parseFrameRate(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  if (raw.includes('/')) {
    const [num, den] = raw.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return Math.round((num / den) * 100) / 100;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function codecRank(codecs = '') {
  const c = String(codecs).toLowerCase();
  if (c.startsWith('avc1') || c.includes('h264')) return 3; // Broadest MP4 compatibility
  if (c.startsWith('hev1') || c.startsWith('hvc1') || c.includes('hevc')) return 2;
  if (c.startsWith('av01') || c.includes('av1')) return 1;
  return 0;
}

async function fetchBilibiliTracks(meta, signal, { referer, userAgent, cookies } = {}) {
  const idParam = meta.bvid ? `bvid=${encodeURIComponent(meta.bvid)}` : `aid=${encodeURIComponent(meta.aid)}`;
  const cidParam = `cid=${encodeURIComponent(meta.cid)}`;
  const dashUrl = `https://api.bilibili.com/x/player/playurl?${idParam}&${cidParam}&qn=120&fnval=4048&fnver=0&fourk=1`;
  const mp4Url = `https://api.bilibili.com/x/player/playurl?${idParam}&${cidParam}&qn=80&fnval=1&fnver=0&fourk=0`;

  const [dashPayload, mp4Payload] = await Promise.all([
    fetchBiliJson(dashUrl, signal, { referer, userAgent, cookies }).catch(() => null),
    fetchBiliJson(mp4Url, signal, { referer, userAgent, cookies }).catch(() => null),
  ]);

  if (!dashPayload && !mp4Payload) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '无法获取 Bilibili 播放流信息', 502, { platform: 'bilibili' });
  }
  if (dashPayload && dashPayload.code !== 0 && (!mp4Payload || mp4Payload.code !== 0)) {
    throw classifyBiliApiCode(dashPayload.code, dashPayload.message);
  }

  const dash = dashPayload?.code === 0 ? dashPayload.data?.dash : null;
  const videoTracks = [];
  if (Array.isArray(dash?.video)) {
    for (const v of dash.video) {
      const mirrors = rankCdnMirrors([v.baseUrl, v.base_url, ...(v.backupUrl || []), ...(v.backup_url || [])]);
      if (!mirrors.length) continue;
      videoTracks.push({
        formatKind: 'dash',
        qn: Number(v.id) || 0,
        codecid: Number(v.codecid) || 0,
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
        bandwidth: Number(v.bandwidth) || 0,
        codec: v.codecs || '',
        frameRate: parseFrameRate(v.frameRate || v.frame_rate),
        mimeType: v.mimeType || v.mime_type || 'video/mp4',
        mirrors,
      });
    }
  }

  const audioTracks = [];
  const rawAudios = [
    ...(Array.isArray(dash?.audio) ? dash.audio : []),
    ...(Array.isArray(dash?.dolby?.audio) ? dash.dolby.audio : []),
    ...(dash?.flac?.audio ? [dash.flac.audio] : []),
  ];
  for (const a of rawAudios) {
    const mirrors = rankCdnMirrors([a.baseUrl, a.base_url, ...(a.backupUrl || []), ...(a.backup_url || [])]);
    if (!mirrors.length) continue;
    audioTracks.push({
      id: Number(a.id) || 0,
      bandwidth: Number(a.bandwidth) || 0,
      codec: a.codecs || 'mp4a.40.2',
      mimeType: a.mimeType || a.mime_type || 'audio/mp4',
      mirrors,
    });
  }
  audioTracks.sort((a, b) => b.bandwidth - a.bandwidth);

  // Sort DASH video tracks: highest height, then highest bitrate, then broadest codec (AVC > HEVC > AV1) at same tier
  videoTracks.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth || codecRank(b.codec) - codecRank(a.codec));
  const maxDashHeight = videoTracks[0]?.height || 0;

  const durlTracks = [];
  const rawDurl = mp4Payload?.code === 0 && Array.isArray(mp4Payload.data?.durl) ? mp4Payload.data.durl : [];
  if (rawDurl.length === 1) {
    const d = rawDurl[0];
    const mirrors = rankCdnMirrors([d.url, ...(d.backup_url || [])]);
    if (mirrors.length) {
      const qn = Number(mp4Payload.data?.quality) || 64;
      const heightMap = { 120: 2160, 116: 1080, 112: 1080, 80: 1080, 64: 720, 32: 480, 16: 360 };
      const nominalHeight = heightMap[qn] || 720;
      // Bilibili's durl playurl can return nominal qn=64 ("720p" tier) even when the original video's
      // true pixel height (view.data.dimension) is lower (e.g. 512x384 or 640x360). Clamp using real
      // source/DASH dimensions so reported candidate height never contradicts the actual media stream.
      const srcH = Number(meta.sourceDimension?.height) || 0;
      const srcW = Number(meta.sourceDimension?.width) || 0;
      const effectiveCeiling = Math.max(srcH, maxDashHeight);
      const resolvedHeight = effectiveCeiling > 0 ? Math.min(nominalHeight, effectiveCeiling) : nominalHeight;
      const aspect = (srcW > 0 && srcH > 0) ? (srcW / srcH) : (16 / 9);
      const resolvedWidth = Math.round((resolvedHeight * aspect) / 2) * 2;
      durlTracks.push({
        formatKind: 'durl',
        qn,
        declaredHeight: nominalHeight,
        height: resolvedHeight,
        width: resolvedWidth,
        bandwidth: d.size && meta.duration ? Math.round((d.size * 8) / Math.max(1, meta.duration)) : 0,
        size: Number(d.size) || 0,
        codec: 'avc1+mp4a',
        frameRate: null,
        mimeType: 'video/mp4',
        mirrors,
      });
    }
  }

  return {
    videoTracks,
    audioTracks,
    durlTracks,
    acceptQuality: dashPayload?.data?.accept_quality || mp4Payload?.data?.accept_quality || [],
    acceptDescription: dashPayload?.data?.accept_description || mp4Payload?.data?.accept_description || [],
  };
}

async function fetchBilibiliSubtitles(meta, signal, { referer, userAgent, cookies } = {}) {
  try {
    const idParam = meta.bvid ? `bvid=${encodeURIComponent(meta.bvid)}` : `aid=${encodeURIComponent(meta.aid)}`;
    const url = `https://api.bilibili.com/x/player/v2?${idParam}&cid=${encodeURIComponent(meta.cid)}`;
    const data = await fetchBiliJson(url, signal, { referer, userAgent, cookies });
    const subNode = data?.code === 0 ? data?.data?.subtitle : null;
    const list = subNode?.subtitles;
    const needLogin = Boolean(subNode?.need_login_subtitle);
    const tracks = Array.isArray(list)
      ? list
        .map(s => {
          let subUrl = s.subtitle_url || '';
          if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
          if (!isSafeBilibiliMediaUrl(subUrl)) return null;
          return {
            language: s.lan || 'und',
            label: s.lan_doc || s.lan || 'Subtitle',
            url: subUrl,
          };
        })
        .filter(Boolean)
      : [];
    return {
      tracks,
      needLogin,
      status: tracks.length ? 'available' : needLogin ? 'login-required' : 'none-available',
    };
  } catch {
    return { tracks: [], needLogin: false, status: 'unavailable' };
  }
}

export function formatVttTimestamp(sec) {
  const totalMs = Math.max(0, Math.round(Number(sec || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function formatSrtTimestamp(sec) {
  return formatVttTimestamp(sec).replace('.', ',');
}

export function convertBilibiliSubtitleJson(json) {
  if (!Array.isArray(json?.body) || !json.body.length) return null;
  const validCues = [];
  for (const cue of json.body) {
    const from = Number(cue?.from);
    const to = Number(cue?.to);
    const text = typeof cue?.content === 'string' ? cue.content.replace(/\r?\n/g, '\n').trim() : '';
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || !text) continue;
    validCues.push({ from, to: Math.max(to, from + 0.05), text });
  }
  if (!validCues.length) return null;
  validCues.sort((a, b) => a.from - b.from || a.to - b.to);

  const vttLines = ['WEBVTT', ''];
  const srtLines = [];
  for (let i = 0; i < validCues.length; i++) {
    const cue = validCues[i];
    vttLines.push(`${formatVttTimestamp(cue.from)} --> ${formatVttTimestamp(cue.to)}`, cue.text, '');
    srtLines.push(String(i + 1), `${formatSrtTimestamp(cue.from)} --> ${formatSrtTimestamp(cue.to)}`, cue.text, '');
  }
  const firstCueSec = Math.round(validCues[0].from * 1000) / 1000;
  const lastCueSec = Math.round(validCues[validCues.length - 1].to * 1000) / 1000;
  return {
    cueCount: validCues.length,
    firstCueSec,
    lastCueSec,
    timelineValid: validCues.length > 0 && lastCueSec >= firstCueSec,
    vtt: vttLines.join('\n'),
    srt: srtLines.join('\n'),
  };
}

async function downloadBilibiliSubtitleFiles(sub, baseDestPath, signal, { referer, userAgent, format = 'both' } = {}) {
  const res = await fetch(sub.url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { 'User-Agent': userAgent || DEFAULT_UA, Referer: referer },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const json = await res.json().catch(() => null);
  const converted = convertBilibiliSubtitleJson(json);
  if (!converted || !converted.timelineValid) return null;

  const out = {
    language: sub.language,
    label: sub.label,
    cueCount: converted.cueCount,
    firstCueSec: converted.firstCueSec,
    lastCueSec: converted.lastCueSec,
    timelineValid: true,
    vttPath: null,
    srtPath: null,
  };
  if (format === 'vtt' || format === 'both') {
    const vttPath = `${baseDestPath}.vtt`;
    await writeFile(vttPath, converted.vtt, 'utf8');
    out.vttPath = vttPath;
  }
  if (format === 'srt' || format === 'both') {
    const srtPath = `${baseDestPath}.srt`;
    await writeFile(srtPath, converted.srt, 'utf8');
    out.srtPath = srtPath;
  }
  return out;
}

export function selectSubtitleTracks(availableTracks, requestedLanguages = null, maxTracks = 3) {
  if (!Array.isArray(availableTracks) || !availableTracks.length) return [];
  if (Array.isArray(requestedLanguages) && requestedLanguages.length) {
    const wanted = requestedLanguages.map(l => String(l).trim().toLowerCase()).filter(Boolean);
    if (wanted.includes('all')) return availableTracks.slice(0, Math.max(maxTracks, 8));
    const matched = availableTracks.filter(t => {
      const lang = String(t.language || '').toLowerCase();
      return wanted.some(w => lang === w || lang.startsWith(w + '-'));
    });
    return matched.slice(0, maxTracks);
  }
  return availableTracks.slice(0, maxTracks);
}

export function expandBilibiliParts(probed, { multiPartMode = 'current', pages = null, maxParts = 100 } = {}) {
  const allPages = Array.isArray(probed?.pages) && probed.pages.length
    ? probed.pages
    : [{ page: probed?.partIndex || 1, url: probed?.url, part: probed?.title || 'P1' }];
  const currentPage = probed?.partIndex || 1;
  if (multiPartMode === 'all') {
    if (allPages.length > maxParts) {
      throw new ApiError(
        'TOO_MANY_PARTS',
        `该多P视频共有 ${allPages.length} 集，超过单批次安全上限 ${maxParts} 集；请使用 pages 分批指定分P范围。`,
        422,
        { totalPages: allPages.length, maxParts },
      );
    }
    return {
      mode: 'all',
      currentPage,
      totalPages: allPages.length,
      selectedPages: allPages.map(p => p.page),
      entries: allPages,
    };
  }
  if (multiPartMode === 'selected' || (Array.isArray(pages) && pages.length)) {
    const wanted = [...new Set((pages || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= allPages.length))];
    if (!wanted.length) {
      throw new ApiError('INVALID_PART_SELECTION', `指定的分P编号超出有效范围（1..${allPages.length}）`, 422, {
        totalPages: allPages.length,
      });
    }
    if (wanted.length > maxParts) {
      throw new ApiError('TOO_MANY_PARTS', `单次最多选择 ${maxParts} 个分P`, 422, { totalPages: allPages.length, maxParts });
    }
    const entries = wanted.map(n => allPages.find(p => p.page === n)).filter(Boolean);
    return {
      mode: 'selected',
      currentPage,
      totalPages: allPages.length,
      selectedPages: entries.map(p => p.page),
      entries,
    };
  }
  const single = allPages.find(p => p.page === currentPage) ?? allPages[0];
  return {
    mode: 'current',
    currentPage: single.page,
    totalPages: allPages.length,
    selectedPages: [single.page],
    entries: [single],
  };
}

export async function probeBilibili(video, signal, { headers = {}, cookies = [] } = {}) {
  const resolved = await resolveBilibiliShortLink(video, signal);
  const parsed = parseBilibiliId(resolved.url);
  if (!parsed || parsed.shortLink) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', '无法识别的 Bilibili 视频地址', 422, { platform: 'bilibili' });
  }
  const userAgent = headers['User-Agent'] || headers['user-agent'] || DEFAULT_UA;
  const idQuery = parsed.bvid ? `bvid=${encodeURIComponent(parsed.bvid)}` : `aid=${encodeURIComponent(parsed.aid)}`;
  const view = await fetchBiliJson(`https://api.bilibili.com/x/web-interface/view?${idQuery}`, signal, {
    referer: resolved.url,
    userAgent,
    cookies,
  });
  const viewErr = classifyBiliApiCode(view?.code, view?.message);
  if (viewErr) throw viewErr;

  const d = view.data;
  const pages = Array.isArray(d.pages) && d.pages.length
    ? d.pages.map(pg => ({
      page: pg.page,
      cid: pg.cid,
      part: pg.part || `P${pg.page}`,
      duration: pg.duration ?? null,
      dimension: pg.dimension?.width && pg.dimension?.height
        ? { width: Number(pg.dimension.width), height: Number(pg.dimension.height) }
        : null,
      url: `https://www.bilibili.com/video/${d.bvid}/?p=${pg.page}`,
    }))
    : [{
      page: 1,
      cid: d.cid,
      part: d.title,
      duration: d.duration ?? null,
      dimension: d.dimension?.width && d.dimension?.height
        ? { width: Number(d.dimension.width), height: Number(d.dimension.height) }
        : null,
      url: `https://www.bilibili.com/video/${d.bvid}/`,
    }];

  const selectedPage = pages.find(p => p.page === parsed.partIndex) ?? pages[0];
  const sourceDimension = selectedPage.dimension
    ?? (d.dimension?.width && d.dimension?.height ? { width: Number(d.dimension.width), height: Number(d.dimension.height) } : null);
  const meta = {
    bvid: d.bvid,
    aid: d.aid,
    cid: selectedPage.cid,
    partIndex: selectedPage.page,
    totalPages: pages.length,
    sourceDimension,
    title: pages.length > 1 && selectedPage.part && selectedPage.part !== d.title
      ? `${d.title} - P${selectedPage.page} ${selectedPage.part}`
      : d.title,
    duration: selectedPage.duration ?? d.duration ?? null,
    poster: normalizePosterUrl(d.pic),
    owner: d.owner?.name ?? null,
    pages,
    canonicalUrl: pages.length > 1 && selectedPage.page > 1
      ? `https://www.bilibili.com/video/${d.bvid}/?p=${selectedPage.page}`
      : `https://www.bilibili.com/video/${d.bvid}/`,
  };

  const [tracks, subtitleInfo] = await Promise.all([
    fetchBilibiliTracks(meta, signal, { referer: meta.canonicalUrl, userAgent, cookies }),
    fetchBilibiliSubtitles(meta, signal, { referer: meta.canonicalUrl, userAgent, cookies }),
  ]);
  const subtitles = subtitleInfo.tracks;

  // Combine DASH tracks + any strictly higher-resolution progressive durl MP4 track so best quality is genuinely selected
  const maxDashHeight = tracks.videoTracks[0]?.height || 0;
  const higherDurl = tracks.durlTracks.filter(d => d.height > maxDashHeight);
  const allVideos = [...higherDurl, ...tracks.videoTracks, ...(tracks.videoTracks.length ? [] : tracks.durlTracks)];
  if (!allVideos.length) {
    throw new ApiError('NO_MEDIA', '该 Bilibili 视频未返回可用的公开视频流', 422, { platform: 'bilibili' });
  }

  const checkedAt = new Date().toISOString();
  const seenHeights = new Set();
  const qualityDetails = [];
  for (const v of allVideos) {
    const key = v.height;
    if (seenHeights.has(key)) continue;
    seenHeights.add(key);
    qualityDetails.push({
      candidateId: `bilibili-${v.formatKind}-${v.qn}-${v.codecid || 0}`,
      height: v.height,
      width: v.width || null,
      declaredHeight: v.declaredHeight ?? v.height,
      bandwidth: v.bandwidth,
      codec: v.codec || null,
      frameRate: v.frameRate ?? null,
      formatKind: v.formatKind,
      cdnMirrors: v.mirrors.length,
      audioTracks: tracks.audioTracks.length
        ? tracks.audioTracks.slice(0, 3).map(a => ({ codecs: a.codec, bandwidth: a.bandwidth }))
        : [{ codecs: 'mp4a.40.2', bandwidth: 0 }],
      subtitleTracks: subtitles.map(s => ({ language: s.language, label: s.label })),
      availability: 'available',
      available: true,
      probeStatus: 200,
      verificationMethod: 'bilibili-native-api',
      checkedAt,
      url: meta.canonicalUrl,
    });
  }

  const best = allVideos[0];
  return {
    ...resolved,
    url: meta.canonicalUrl,
    kind: 'page',
    engine: 'bilibili-native',
    bvid: meta.bvid,
    cid: meta.cid,
    partIndex: meta.partIndex,
    totalPages: meta.totalPages,
    partSelection: {
      mode: 'current',
      currentPage: meta.partIndex,
      totalPages: meta.totalPages,
      selectedPages: [meta.partIndex],
    },
    pages: meta.pages,
    owner: meta.owner,
    title: meta.title,
    duration: meta.duration,
    width: best.width || null,
    height: best.height,
    qualities: [...seenHeights],
    qualityDetails,
    subtitles,
    subtitleInfo,
    ...(meta.poster && { poster: meta.poster }),
    _resolvedMeta: meta,
    _tracks: tracks,
  };
}

export function selectBilibiliVideoTrack(videoTracks, durlTracks, qualitySpec, { durationSec = null } = {}) {
  const maxDashHeight = videoTracks[0]?.height || 0;
  const higherDurl = durlTracks.filter(d => d.height > maxDashHeight);
  const candidates = [...higherDurl, ...videoTracks, ...(videoTracks.length ? [] : durlTracks)];
  if (!candidates.length) return null;

  // Prefer broadest playable codec (AVC > HEVC > AV1) when height & availability tie and caller did not pin a codec
  const spec = normalizeQualitySpec(qualitySpec);
  const ordered = [...candidates].sort((a, b) =>
    (b.height || 0) - (a.height || 0)
    || (!spec.preferCodec ? codecRank(b.codec) - codecRank(a.codec) : 0)
    || (b.bandwidth || 0) - (a.bandwidth || 0)
  );
  const negotiation = negotiateQuality(
    ordered.map(c => ({ ...c, availability: 'available', available: true })),
    qualitySpec,
    { durationSec },
  );
  if (!negotiation?.selected) return null;
  // When height ties with multiple codecs and caller didn't force preferCodec, keep broadest AVC candidate
  const pickedHeight = negotiation.selected.height;
  const tiedSameHeight = negotiation.ranked.filter(c => c.height === pickedHeight);
  const chosen = (!spec.preferCodec && tiedSameHeight.length > 1)
    ? [...tiedSameHeight].sort((a, b) => codecRank(b.codec) - codecRank(a.codec) || (b.bandwidth || 0) - (a.bandwidth || 0))[0]
    : negotiation.selected;

  return {
    selected: chosen,
    requested: negotiation.requested,
    fallbackApplied: negotiation.fallbackApplied,
    reason: negotiation.reason,
    availableHeights: [...new Set(ordered.map(c => c.height).filter(Boolean))].sort((a, b) => b - a),
  };
}

function httpGetRaw(urlStr, headers, signal, direct = true) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const client = isHttps ? https : http;
  const opts = { headers, signal, timeout: 20_000, ...(direct && isHttps ? { agent: directHttpsAgent } : {}) };
  return new Promise((resolve, reject) => {
    const req = client.get(u, opts, res => {
      res.on('error', () => {});
      resolve(res);
    });
    req.on('timeout', () => {
      req.destroy(new Error('HTTP request timed out'));
    });
    req.on('error', reject);
  });
}

async function inspectStagedBinaryHeader(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buf, 0, 64, 0);
    if (bytesRead < 12) return { ok: false, reason: 'file-too-small' };
    const headTxt = buf.subarray(0, bytesRead).toString('utf8').trimStart().toLowerCase();
    if (headTxt.startsWith('<!doctype') || headTxt.startsWith('<html') || headTxt.startsWith('<?xml') || headTxt.startsWith('{')) {
      return { ok: false, reason: 'html-or-text-error-payload' };
    }
    // Check ISOBMFF box signature (ftyp / styp / moov / moof / sidx / mdat) or FLV/EBML
    const boxType = buf.subarray(4, 8).toString('ascii');
    if (['ftyp', 'styp', 'moov', 'moof', 'sidx', 'mdat', 'free', 'wide'].includes(boxType)) return { ok: true, format: 'isobmff' };
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ok: true, format: 'webm' };
    if (buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56) return { ok: true, format: 'flv' };
    return { ok: true, format: 'binary-unclassified' };
  } finally {
    await handle.close();
  }
}

async function probeMirrorSize(mirrorUrl, headers, signal) {
  const res = await httpGetRaw(mirrorUrl, { ...headers, Range: 'bytes=0-0' }, signal);
  const status = res.statusCode;
  const contentRange = res.headers['content-range'];
  const contentLength = res.headers['content-length'];
  const contentType = String(res.headers['content-type'] || '').toLowerCase();
  res.resume();
  res.destroy();

  if (ACCESS_DENIED_STATUSES.has(status)) {
    throw new ApiError('MEDIA_ACCESS_RESTRICTED', `Bilibili 媒体服务器拒绝访问（HTTP ${status}）`, 403, { platform: 'bilibili', status });
  }
  if (status !== 206 && status !== 200) {
    const err = new Error(`Mirror returned HTTP ${status}`);
    err.httpStatus = status;
    err.retryableCdn = RETRYABLE_CDN_STATUSES.has(status);
    throw err;
  }
  if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('text/xml')) {
    const err = new Error(`Mirror returned non-media Content-Type: ${contentType}`);
    err.httpStatus = status;
    throw err;
  }
  let totalSize = 0;
  if (status === 206 && contentRange) {
    const m = /^bytes \d+-\d+\/(\d+)$/i.exec(contentRange.trim());
    if (m) totalSize = Number(m[1]);
  } else if (status === 200 && contentLength) {
    totalSize = Number(contentLength);
  }
  return { totalSize, supportsRange: status === 206 && totalSize > 0 };
}

async function downloadRangeChunk(mirrorUrls, start, end, headers, signal, onBytes) {
  let lastError;
  for (let mIdx = 0; mIdx < mirrorUrls.length; mIdx++) {
    const url = mirrorUrls[mIdx];
    const host = new URL(url).hostname;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      try {
        const res = await httpGetRaw(url, { ...headers, Range: `bytes=${start}-${end}` }, signal);
        if (ACCESS_DENIED_STATUSES.has(res.statusCode)) {
          res.destroy();
          throw new ApiError('MEDIA_ACCESS_RESTRICTED', `Bilibili 媒体分块被拒绝访问（HTTP ${res.statusCode}）`, 403, {
            platform: 'bilibili',
            status: res.statusCode,
          });
        }
        if (res.statusCode !== 206 && !(start === 0 && res.statusCode === 200)) {
          res.destroy();
          const err = new Error(`HTTP ${res.statusCode}`);
          err.httpStatus = res.statusCode;
          err.retryableCdn = RETRYABLE_CDN_STATUSES.has(res.statusCode);
          throw err;
        }
        const expected = end - start + 1;
        const chunks = [];
        let got = 0;
        for await (const chunk of res) {
          signal.throwIfAborted();
          await paceBandwidth(chunk.length, signal);
          chunks.push(chunk);
          got += chunk.length;
          onBytes?.(chunk.length);
        }
        if (got !== expected) {
          throw new Error(`Short read on range ${start}-${end}: got ${got}, expected ${expected}`);
        }
        recordHostSuccess(host);
        return Buffer.concat(chunks, expected);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'MEDIA_ACCESS_RESTRICTED') throw err;
        if (signal.aborted) throw err;
        if (err.httpStatus && !RETRYABLE_CDN_STATUSES.has(err.httpStatus)) {
          throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `Bilibili 媒体服务器返回不可容灾状态码 HTTP ${err.httpStatus}`, 502, {
            platform: 'bilibili',
            status: err.httpStatus,
          });
        }
        recordHostFailure(host, err.httpStatus ?? 502);
        lastError = err;
        if (attempt === 0) await sleep(200, undefined, { signal }).catch(() => {});
      }
    }
  }
  throw lastError || new Error('All Bilibili CDN mirrors failed for chunk');
}

async function downloadTrackWithMirrors(mirrors, destFile, { headers, connections = 4, signal, recoveryDir, trackKey, onProgress }) {
  // 1. Find first responsive official mirror and get exact total size
  let orderedMirrors = [...mirrors];
  let probe = null;
  let lastProbeErr = null;
  for (let i = 0; i < mirrors.length; i++) {
    const candidate = mirrors[i];
    try {
      probe = await probeMirrorSize(candidate, headers, signal);
      // Put responsive mirror first
      orderedMirrors = [candidate, ...mirrors.filter(u => u !== candidate)];
      break;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MEDIA_ACCESS_RESTRICTED') throw err;
      lastProbeErr = err;
    }
  }
  if (!probe) {
    throw new ApiError(
      'PLATFORM_DOWNLOAD_FAILED',
      `所有 Bilibili 官方 CDN 镜像均暂不可用（最后错误：${lastProbeErr?.message || 'unknown'}）`,
      502,
      { platform: 'bilibili', status: lastProbeErr?.httpStatus ?? 502, mirrorsTried: mirrors.length },
    );
  }

  const totalSize = probe.totalSize;
  // Single-stream fallback if total size unknown or small (< 2 MiB)
  if (!probe.supportsRange || totalSize <= 2 * 1024 * 1024) {
    let lastErr;
    for (const url of orderedMirrors) {
      try {
        const res = await httpGetRaw(url, headers, signal);
        if ([401, 402, 403, 451].includes(res.statusCode)) {
          res.destroy();
          throw new ApiError('MEDIA_ACCESS_RESTRICTED', `Bilibili 媒体服务器拒绝访问（HTTP ${res.statusCode}）`, 403, { platform: 'bilibili', status: res.statusCode });
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          throw new Error(`HTTP ${res.statusCode}`);
        }
        const ws = createWriteStream(destFile);
        let written = 0;
        try {
          for await (const chunk of res) {
            signal.throwIfAborted();
            await paceBandwidth(chunk.length, signal);
            ws.write(chunk);
            written += chunk.length;
            onProgress?.(written, totalSize || written);
          }
          await new Promise((resolve, reject) => ws.end(err => (err ? reject(err) : resolve())));
        } catch (e) {
          ws.destroy();
          throw e;
        }
        const headerCheck = await inspectStagedBinaryHeader(destFile);
        if (!headerCheck.ok) throw new ApiError('INVALID_MEDIA_CONTENT', `Bilibili 返回了无效媒体内容（${headerCheck.reason}）`, 422);
        return { file: destFile, bytes: written, mirror: new URL(url).hostname };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        lastErr = err;
      }
    }
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', `Bilibili 轨道下载失败：${lastErr?.message || 'unknown'}`, 502, { platform: 'bilibili' });
  }

  // Multi-connection chunked Range transfer with optional SHA-256 recovery checkpoint
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
  const cpDir = recoveryDir ? path.join(recoveryDir, `bili-${trackKey}`) : null;
  const workFile = cpDir ? path.join(cpDir, 'track.bin') : destFile;
  const completedChunks = new Set();

  if (cpDir) {
    await mkdir(cpDir, { recursive: true, mode: 0o700 });
    const existing = await stat(workFile).catch(() => null);
    if (existing?.isFile() && existing.size === totalSize) {
      const metaRaw = await readFile(path.join(cpDir, 'chunks.json'), 'utf8').catch(() => null);
      const savedMap = metaRaw ? JSON.parse(metaRaw) : {};
      const handle = await open(workFile, 'r');
      try {
        for (const [idxStr, expectedHash] of Object.entries(savedMap)) {
          const idx = Number(idxStr);
          if (!Number.isInteger(idx) || idx < 0 || idx >= chunkCount) continue;
          const start = idx * CHUNK_SIZE;
          const len = Math.min(CHUNK_SIZE, totalSize - start);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await handle.read(buf, 0, len, start);
          if (bytesRead === len && createHash('sha256').update(buf).digest('hex') === expectedHash) {
            completedChunks.add(idx);
          }
        }
      } finally {
        await handle.close();
      }
    } else {
      await rm(path.join(cpDir, 'chunks.json'), { force: true }).catch(() => {});
    }
  }

  const fh = await open(workFile, completedChunks.size > 0 ? 'r+' : 'w', 0o600);
  const chunkHashes = {};
  let transferredBytes = 0;
  for (const idx of completedChunks) {
    const start = idx * CHUNK_SIZE;
    transferredBytes += Math.min(CHUNK_SIZE, totalSize - start);
  }
  onProgress?.(transferredBytes, totalSize);

  const pending = [];
  for (let i = 0; i < chunkCount; i++) {
    if (!completedChunks.has(i)) pending.push(i);
  }

  const workers = Math.max(1, Math.min(connections, 6, pending.length || 1));
  let cursor = 0;
  try {
    await fh.truncate(totalSize);
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < pending.length) {
        const idx = pending[cursor++];
        const start = idx * CHUNK_SIZE;
        const end = Math.min(totalSize - 1, start + CHUNK_SIZE - 1);
        const buf = await downloadRangeChunk(orderedMirrors, start, end, headers, signal, delta => {
          transferredBytes += delta;
          onProgress?.(Math.min(totalSize, transferredBytes), totalSize);
        });
        await fh.write(buf, 0, buf.length, start);
        if (cpDir) {
          chunkHashes[idx] = createHash('sha256').update(buf).digest('hex');
        }
      }
    }));
  } finally {
    await fh.close();
    if (cpDir && Object.keys(chunkHashes).length) {
      const prev = await readFile(path.join(cpDir, 'chunks.json'), 'utf8').then(JSON.parse).catch(() => ({}));
      await writeFile(path.join(cpDir, 'chunks.json'), JSON.stringify({ ...prev, ...chunkHashes }), 'utf8').catch(() => {});
    }
  }

  const headerCheck = await inspectStagedBinaryHeader(workFile);
  if (!headerCheck.ok) {
    throw new ApiError('INVALID_MEDIA_CONTENT', `Bilibili 轨道校验失败（${headerCheck.reason}）`, 422, { platform: 'bilibili' });
  }
  return { file: workFile, bytes: totalSize, mirror: new URL(orderedMirrors[0]).hostname, restoredChunks: completedChunks.size };
}

async function stageRequestedBilibiliSubtitles(probed, target, staging, signal, { referer, userAgent }) {
  const available = (probed.subtitles || []).map(s => ({ language: s.language, label: s.label }));
  if (!target.subtitles) {
    return {
      requested: false,
      status: available.length ? 'available-not-requested' : (probed.subtitleInfo?.status ?? 'none-available'),
      available,
      downloaded: [],
      sidecarFiles: [],
      embeddedTracks: 0,
      verified: false,
      reason: null,
      _staged: [],
    };
  }
  if (!probed.subtitles?.length) {
    const needLogin = Boolean(probed.subtitleInfo?.needLogin);
    return {
      requested: true,
      status: needLogin ? 'login-required' : 'none-available',
      available: [],
      downloaded: [],
      sidecarFiles: [],
      embeddedTracks: 0,
      verified: false,
      reason: needLogin
        ? '该 Bilibili 视频的 CC/AI 字幕需要登录后才可由官方接口返回，当前未登录故未下载字幕。'
        : '该 Bilibili 视频官方接口未提供可用的公开字幕轨。',
      _staged: [],
    };
  }
  const selectedSubs = selectSubtitleTracks(probed.subtitles, target.subtitleLanguages, 3);
  if (!selectedSubs.length) {
    return {
      requested: true,
      status: 'language-not-found',
      available,
      downloaded: [],
      sidecarFiles: [],
      embeddedTracks: 0,
      verified: false,
      reason: `请求的字幕语言 ${JSON.stringify(target.subtitleLanguages)} 在可用列表中不存在。`,
      _staged: [],
    };
  }
  const format = ['vtt', 'srt', 'both'].includes(target.subtitleFormat) ? target.subtitleFormat : 'both';
  const staged = [];
  for (let i = 0; i < selectedSubs.length; i++) {
    const sub = selectedSubs[i];
    const safeLang = String(sub.language || `sub${i}`).replace(/[^A-Za-z0-9_-]/g, '_');
    const baseDest = path.join(staging, `sub-${i}-${safeLang}`);
    const dl = await downloadBilibiliSubtitleFiles(sub, baseDest, signal, { referer, userAgent, format }).catch(() => null);
    if (dl) staged.push(dl);
  }
  if (!staged.length) {
    return {
      requested: true,
      status: 'download-failed',
      available,
      downloaded: [],
      sidecarFiles: [],
      embeddedTracks: 0,
      verified: false,
      reason: '字幕文件获取失败或不包含有效时间轴内容。',
      _staged: [],
    };
  }
  return {
    requested: true,
    status: 'downloaded',
    available,
    downloaded: staged.map(s => ({
      language: s.language,
      label: s.label,
      cueCount: s.cueCount,
      firstCueSec: s.firstCueSec,
      lastCueSec: s.lastCueSec,
      timelineValid: s.timelineValid,
      formats: [s.vttPath ? 'vtt' : null, s.srtPath ? 'srt' : null].filter(Boolean),
    })),
    sidecarFiles: [],
    embeddedTracks: 0,
    verified: staged.every(s => s.timelineValid && s.cueCount > 0),
    reason: null,
    _staged: staged,
  };
}

export async function stageBilibili(video, target, staging, connections, signal, onProgress, {
  headers = {},
  cookies = [],
  recovery = null,
  onQualityNegotiated,
  onSubtitles,
} = {}) {
  const probed = await probeBilibili(video, signal, { headers, cookies });
  const meta = probed._resolvedMeta;
  const tracks = probed._tracks;
  target.title ||= meta.title;

  const userAgent = headers['User-Agent'] || headers['user-agent'] || DEFAULT_UA;
  const mediaHeaders = {
    'User-Agent': userAgent,
    Referer: meta.canonicalUrl,
    Origin: 'https://www.bilibili.com',
  };

  const mode = target.mode || 'combined';
  const qualitySpec = target.qualitySpec ?? target.quality;

  // Audio-only mode
  if (mode === 'audio' && tracks.audioTracks.length) {
    const audioTrack = tracks.audioTracks[0];
    const audioPath = path.join(staging, 'bili-audio.m4s');
    const aRes = await downloadTrackWithMirrors(audioTrack.mirrors, audioPath, {
      headers: mediaHeaders,
      connections: Math.min(connections || 4, 4),
      signal,
      recoveryDir: recovery,
      trackKey: `${meta.bvid}-${meta.cid}-a${audioTrack.id}`,
      onProgress: (done, total) => onProgress?.(total ? done / total : null, done, total),
    });
    const outAudio = path.join(staging, 'platform.m4a');
    await runMedia(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', aRes.file, '-vn', '-c:a', 'copy', '-movflags', '+faststart', outAudio], signal);
    onQualityNegotiated?.(buildQualityNegotiationReport({
      requestedQuality: qualitySpec ?? 'best',
      availableQualities: probed.qualities,
      declaredQuality: { height: null, width: null, codec: audioTrack.codec, formatKind: 'audio-only' },
      selectedQuality: { height: null, width: null, codec: audioTrack.codec, formatKind: 'audio-only' },
      fallbackApplied: false,
      reason: 'audio-only-highest-bitrate',
      verificationStatus: 'pending',
    }));
    const subReport = await stageRequestedBilibiliSubtitles(probed, target, staging, signal, { referer: meta.canonicalUrl, userAgent });
    onSubtitles?.(subReport);
    return outAudio;
  }

  const pick = selectBilibiliVideoTrack(tracks.videoTracks, tracks.durlTracks, qualitySpec, { durationSec: meta.duration });
  if (!pick?.selected) {
    throw new ApiError('NO_MEDIA', '未找到符合要求的 Bilibili 视频轨道', 422, { platform: 'bilibili' });
  }
  const vTrack = pick.selected;
  onQualityNegotiated?.(buildQualityNegotiationReport({
    requestedQuality: qualitySpec ?? 'best',
    availableQualities: pick.availableHeights,
    declaredQuality: {
      height: vTrack.declaredHeight ?? vTrack.height,
      width: vTrack.width,
      codec: vTrack.codec,
      formatKind: vTrack.formatKind,
    },
    selectedQuality: {
      height: vTrack.height,
      width: vTrack.width,
      codec: vTrack.codec,
      formatKind: vTrack.formatKind,
    },
    fallbackApplied: pick.fallbackApplied,
    fallbackReason: pick.fallbackApplied ? pick.reason : null,
    reason: pick.reason,
    verificationStatus: 'pending',
  }));

  const subReport = await stageRequestedBilibiliSubtitles(probed, target, staging, signal, { referer: meta.canonicalUrl, userAgent });
  const embedSubs = subReport._staged.filter(s => s.vttPath);

  // Progressive single-file durl MP4 path (supports subtitle embedding too!)
  if (vTrack.formatKind === 'durl') {
    const rawMp4 = path.join(staging, 'bili-durl.mp4');
    const outMp4 = path.join(staging, 'platform.mp4');
    const dl = await downloadTrackWithMirrors(vTrack.mirrors, rawMp4, {
      headers: mediaHeaders,
      connections: Math.min(connections || 6, 6),
      signal,
      recoveryDir: recovery,
      trackKey: `${meta.bvid}-${meta.cid}-durl${vTrack.qn}`,
      onProgress: (done, total) => onProgress?.(total ? done / total : null, done, total),
    });
    const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', dl.file];
    for (const sf of embedSubs) ffmpegArgs.push('-i', sf.vttPath);
    ffmpegArgs.push('-map', '0:v:0', '-map', '0:a?');
    for (let i = 0; i < embedSubs.length; i++) {
      ffmpegArgs.push('-map', `${1 + i}:0`);
      if (embedSubs[i].language) ffmpegArgs.push(`-metadata:s:s:${i}`, `language=${embedSubs[i].language.slice(0, 12)}`);
    }
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy');
    if (embedSubs.length) ffmpegArgs.push('-c:s', 'mov_text');
    ffmpegArgs.push('-movflags', '+faststart', outMp4);
    await runMedia(FFMPEG, ffmpegArgs, signal);
    subReport.embeddedTracks = embedSubs.length;
    onSubtitles?.(subReport);
    return outMp4;
  }

  // DASH separate video + audio path
  const aTrack = mode !== 'video' ? tracks.audioTracks[0] ?? null : null;
  let vDone = 0;
  let vTotal = 0;
  let aDone = 0;
  let aTotal = 0;
  const emitCombined = () => {
    const done = vDone + aDone;
    const total = vTotal + aTotal;
    onProgress?.(total ? done / total : null, done, total);
  };

  const videoPath = path.join(staging, 'bili-video.m4s');
  const audioPath = path.join(staging, 'bili-audio.m4s');
  const jobs = [
    downloadTrackWithMirrors(vTrack.mirrors, videoPath, {
      headers: mediaHeaders,
      connections: Math.min(connections || 6, 6),
      signal,
      recoveryDir: recovery,
      trackKey: `${meta.bvid}-${meta.cid}-v${vTrack.qn}-${vTrack.codecid}`,
      onProgress: (done, total) => { vDone = done; vTotal = total; emitCombined(); },
    }),
  ];
  if (aTrack) {
    jobs.push(
      downloadTrackWithMirrors(aTrack.mirrors, audioPath, {
        headers: mediaHeaders,
        connections: Math.min(connections || 4, 4),
        signal,
        recoveryDir: recovery,
        trackKey: `${meta.bvid}-${meta.cid}-a${aTrack.id}`,
        onProgress: (done, total) => { aDone = done; aTotal = total; emitCombined(); },
      }),
    );
  }

  const [vRes, aRes] = await Promise.all(jobs);

  // Lossless mux via FFmpeg into MP4 (faststart enabled)
  const outMp4 = path.join(staging, 'platform.mp4');
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', vRes.file];
  if (aRes) ffmpegArgs.push('-i', aRes.file);
  for (const sf of embedSubs) ffmpegArgs.push('-i', sf.vttPath);
  ffmpegArgs.push('-map', '0:v:0');
  if (aRes) ffmpegArgs.push('-map', '1:a:0');
  const subOffset = aRes ? 2 : 1;
  for (let i = 0; i < embedSubs.length; i++) {
    ffmpegArgs.push('-map', `${subOffset + i}:0`);
    if (embedSubs[i].language) ffmpegArgs.push(`-metadata:s:s:${i}`, `language=${embedSubs[i].language.slice(0, 12)}`);
  }
  ffmpegArgs.push('-c:v', 'copy');
  if (aRes) ffmpegArgs.push('-c:a', 'copy');
  if (embedSubs.length) ffmpegArgs.push('-c:s', 'mov_text');
  ffmpegArgs.push('-movflags', '+faststart', outMp4);

  await runMedia(FFMPEG, ffmpegArgs, signal);
  const outStat = await stat(outMp4).catch(() => null);
  if (!outStat?.isFile() || outStat.size < 1024) {
    throw new ApiError('PLATFORM_DOWNLOAD_FAILED', 'FFmpeg 封装 Bilibili 音视频失败', 502, { platform: 'bilibili' });
  }
  subReport.embeddedTracks = embedSubs.length;
  onSubtitles?.(subReport);
  return outMp4;
}
