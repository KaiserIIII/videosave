import { ApiError, allowedMediaHeaders, parseMediaHeaders } from './media-source.mjs';

const sensitiveHeaders = new Set(['cookie', 'authorization', 'proxy-authorization']);

export const HLS_PHASES = Object.freeze([
  'master-playlist',
  'playlist',
  'init-segment',
  'segment',
  'byte-range',
  'audio-playlist',
  'audio-segment',
  'subtitle-playlist',
  'subtitle-segment',
  'key',
]);

export function canonicalHlsPhase(phase) {
  if (!phase) return 'playlist';
  if (phase === 'master-playlist' || phase === 'audio-playlist' || phase === 'subtitle-playlist') return 'playlist';
  if (phase === 'init-segment' || phase === 'byte-range' || phase === 'audio-segment' || phase === 'subtitle-segment') return 'segment';
  if (phase === 'key' || phase === 'segment' || phase === 'playlist') return phase;
  return 'playlist';
}

function serializeCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return '';
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
}

/**
 * Unified request context for VideoSave's download, prefetch, probe, refresh, and fallback paths.
 * Enforces consistent Referer / Origin / User-Agent propagation across all authorized phases
 * while strictly preventing cross-origin credential (Cookie / Authorization) leakage.
 */
export function createRequestContext({
  origin,
  sourceUrl,
  headers = {},
  cookies = [],
  cookiesFor = null,
  restrictedOrigin = false,
  transport = null,
  onRequest = null,
} = {}) {
  const sanitized = parseMediaHeaders(headers);
  const rawOrigin = origin ?? sourceUrl;
  const credentialOrigin = rawOrigin instanceof URL ? rawOrigin.origin : (typeof rawOrigin === 'string' ? URL.parse(rawOrigin)?.origin ?? null : null);
  const staticCookies = Array.isArray(cookies) ? cookies.map(({ name, value }) => ({ name, value })) : [];

  function resolveCookies(targetUrl) {
    const url = targetUrl instanceof URL ? targetUrl : URL.parse(targetUrl);
    if (!url || !credentialOrigin || url.origin !== credentialOrigin) return [];
    if (typeof cookiesFor === 'function') {
      const matched = cookiesFor(url);
      return Array.isArray(matched) ? matched : [];
    }
    return staticCookies;
  }

  function headersFor(targetUrl, {
    phase = 'playlist',
    range = null,
    acceptEncoding = 'identity',
    extra = null,
  } = {}) {
    const url = targetUrl instanceof URL ? targetUrl : URL.parse(targetUrl);
    if (!url) throw new ApiError('INVALID_URL', '需要一个有效的 HTTP(S) 链接');
    const out = {};
    for (const name of allowedMediaHeaders) {
      if (Object.hasOwn(sanitized, name)) out[name] = sanitized[name];
    }
    if (extra && typeof extra === 'object') {
      for (const [name, value] of Object.entries(extra)) {
        if (sensitiveHeaders.has(name.toLowerCase())) continue;
        if (typeof value === 'string' && value.length <= 2048 && !/[^\x20-\x7e]/.test(value)) {
          out[name] = value;
        }
      }
    }
    if (acceptEncoding) out['Accept-Encoding'] = acceptEncoding;
    const scoped = resolveCookies(url);
    const cookieHeader = serializeCookies(scoped);
    if (cookieHeader) out.Cookie = cookieHeader;
    if (range) {
      out.Range = `bytes=${range.start}-${range.end}`;
      if (range.etag) out['If-Range'] = range.etag;
    }
    if (typeof onRequest === 'function') {
      onRequest({
        phase,
        canonicalPhase: canonicalHlsPhase(phase),
        origin: url.origin,
        pathname: url.pathname,
        sameCredentialOrigin: url.origin === credentialOrigin,
        headerNames: Object.keys(out).map(key => key.toLowerCase()).sort(),
        sentCookie: Boolean(cookieHeader),
      });
    }
    return out;
  }

  function ffmpegInputArgs(targetUrl) {
    const url = targetUrl instanceof URL ? targetUrl : URL.parse(targetUrl);
    const args = ['-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-rw_timeout', '15000000'];
    if (sanitized['User-Agent']) args.push('-user_agent', sanitized['User-Agent']);
    const otherHeaders = Object.entries(sanitized)
      .filter(([name]) => name !== 'User-Agent')
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    if (otherHeaders) args.push('-headers', otherHeaders);
    const scoped = url ? resolveCookies(url) : [];
    if (scoped.length && url) {
      args.push(
        '-cookies',
        scoped.map(({ name, value }) => `${name}=${value}; path=/; domain=${url.host};`).join('\n'),
      );
    }
    return args;
  }

  function forRefresh(newSourceUrl, { preserveHeaders = true, preserveCookies = true } = {}) {
    const nextUrl = newSourceUrl instanceof URL ? newSourceUrl : URL.parse(newSourceUrl);
    const nextOrigin = nextUrl?.origin ?? credentialOrigin;
    const sameOrigin = Boolean(nextOrigin && credentialOrigin && nextOrigin === credentialOrigin);
    return createRequestContext({
      origin: nextOrigin,
      headers: preserveHeaders ? sanitized : {},
      cookies: preserveCookies && sameOrigin ? staticCookies : [],
      cookiesFor: preserveCookies && sameOrigin ? cookiesFor : null,
      restrictedOrigin,
      transport,
      onRequest,
    });
  }

  function accessError(status, responseHeaders, phase = 'playlist') {
    const canonical = canonicalHlsPhase(phase);
    const detail = { status, hlsPhase: canonical, phase };
    if (responseHeaders?.get?.('cf-mitigated') === 'challenge') {
      return new ApiError(
        restrictedOrigin ? 'MCP_MEDIA_ACCESS_RESTRICTED' : 'MEDIA_ACCESS_RESTRICTED',
        'The media server returned a browser challenge',
        403,
        { ...detail, blocker: 'cloudflare-challenge' },
      );
    }
    if ([401, 402, 403, 451].includes(status)) {
      return new ApiError(
        restrictedOrigin ? 'MCP_MEDIA_ACCESS_RESTRICTED' : 'MEDIA_ACCESS_RESTRICTED',
        `The media server denied access during ${phase} (HTTP ${status})`,
        403,
        detail,
      );
    }
    if (status === 410) {
      return new ApiError(
        'STREAM_EXPIRED',
        'The media resource is no longer available. Re-probe the original page.',
        410,
        detail,
      );
    }
    return null;
  }

  return {
    origin: credentialOrigin,
    headers: Object.freeze({ ...sanitized }),
    cookies: staticCookies,
    restrictedOrigin,
    transport,
    resolveCookies,
    headersFor,
    ffmpegInputArgs,
    forRefresh,
    accessError,
  };
}
