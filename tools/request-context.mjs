import { ApiError, allowedMediaHeaders, mergeMediaHeaders, parseMediaHeaders, sanitizeReferer } from './media-source.mjs';

const sensitiveHeaders = new Set(['cookie', 'authorization', 'proxy-authorization']);

export const REQUEST_PHASES = Object.freeze([
  'master-playlist',
  'variant',
  'playlist',
  'init',
  'init-segment',
  'segment',
  'byte-range',
  'audio-playlist',
  'audio-segment',
  'subtitle-playlist',
  'subtitle-segment',
  'key',
  'mpd',
  'direct',
  'mux',
  'verification',
]);

export const HLS_PHASES = REQUEST_PHASES;

export function canonicalHlsPhase(phase) {
  if (!phase) return 'playlist';
  if (phase === 'master-playlist' || phase === 'variant' || phase === 'audio-playlist' || phase === 'subtitle-playlist' || phase === 'mpd') return 'playlist';
  if (phase === 'init' || phase === 'init-segment' || phase === 'byte-range' || phase === 'audio-segment' || phase === 'subtitle-segment') return 'segment';
  if (phase === 'key' || phase === 'segment' || phase === 'playlist') return phase;
  return 'playlist';
}

export function normalizeDiagnosticPhase(phase) {
  if (!phase) return 'master-playlist';
  if (phase === 'playlist') return 'variant';
  if (phase === 'init-segment') return 'init';
  if (phase === 'manifest') return 'mpd';
  return phase;
}

function serializeCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return '';
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
}

/**
 * Unified request context for VideoSave's download, prefetch, probe, refresh, and fallback paths.
 * - Normalizes and merges headers case-insensitively across global, perItem, and item inputs.
 * - Respects Referrer-Policy (preserves explicit full-URL Referer where authorized while preventing
 *   accidental path/query leakage on automatically observed cross-origin requests).
 * - Strictly isolates Cookie / Authorization credentials to the authorized origin.
 * - Records sanitized per-stage request diagnostics (never raw credential values).
 */
export function createRequestContext({
  origin,
  sourceUrl,
  headers = {},
  explicitHeaders = null,
  referrerPolicy = null,
  cookies = [],
  cookiesFor = null,
  restrictedOrigin = false,
  transport = null,
  onRequest = null,
} = {}) {
  const sanitized = parseMediaHeaders(headers);
  const explicitSet = explicitHeaders instanceof Set
    ? explicitHeaders
    : Array.isArray(explicitHeaders)
      ? new Set(explicitHeaders.map(h => h.toLowerCase()))
      : new Set(Object.keys(sanitized).map(h => h.toLowerCase()));
  const effectivePolicy = referrerPolicy || (explicitSet.has('referer') ? 'unsafe-url' : 'strict-origin-when-cross-origin');
  const rawOrigin = origin ?? sourceUrl;
  const credentialOrigin = rawOrigin instanceof URL
    ? rawOrigin.origin
    : (typeof rawOrigin === 'string' ? URL.parse(rawOrigin)?.origin ?? null : null);
  const staticCookies = Array.isArray(cookies) ? cookies.map(({ name, value }) => ({ name, value })) : [];
  const stageHistory = new Map();
  let lastSentHeaders = [];

  function resolveCookies(targetUrl) {
    const url = targetUrl instanceof URL ? targetUrl : URL.parse(targetUrl);
    if (!url || !credentialOrigin || url.origin !== credentialOrigin) return [];
    if (typeof cookiesFor === 'function') {
      const matched = cookiesFor(url);
      return Array.isArray(matched) ? matched : [];
    }
    return staticCookies;
  }

  function recordStage(phase, details = {}) {
    const diagPhase = normalizeDiagnosticPhase(phase);
    const prev = stageHistory.get(diagPhase) ?? { phase: diagPhase, requests: 0, elapsedMs: 0 };
    const next = {
      ...prev,
      requests: prev.requests + 1,
      ...(details.status !== undefined && { status: details.status }),
      ...(details.engine && { engine: details.engine }),
      ...(details.sentHeaderNames && { sentHeaderNames: details.sentHeaderNames }),
      ...(details.sentCookie !== undefined && { sentCookie: details.sentCookie }),
      ...(details.elapsedMs !== undefined && { elapsedMs: Math.round(prev.elapsedMs + details.elapsedMs) }),
      ...(details.errorCode && { errorCode: details.errorCode }),
    };
    stageHistory.set(diagPhase, next);
    return next;
  }

  function getStageSummary() {
    return [...stageHistory.values()];
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
      if (!Object.hasOwn(sanitized, name)) continue;
      if (name === 'Referer') {
        const ref = sanitizeReferer(sanitized.Referer, url, {
          policy: effectivePolicy,
          explicit: explicitSet.has('referer'),
        });
        if (ref) out.Referer = ref;
      } else {
        out[name] = sanitized[name];
      }
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
    const headerNames = Object.keys(out).map(key => key.toLowerCase()).sort();
    lastSentHeaders = headerNames;
    recordStage(phase, { sentHeaderNames: headerNames, sentCookie: Boolean(cookieHeader) });
    if (typeof onRequest === 'function') {
      onRequest({
        phase: normalizeDiagnosticPhase(phase),
        rawPhase: phase,
        canonicalPhase: canonicalHlsPhase(phase),
        origin: url.origin,
        pathname: url.pathname,
        sameCredentialOrigin: url.origin === credentialOrigin,
        headerNames,
        sentCookie: Boolean(cookieHeader),
      });
    }
    return out;
  }

  function ffmpegInputArgs(targetUrl) {
    const url = targetUrl instanceof URL ? targetUrl : URL.parse(targetUrl);
    const args = ['-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-rw_timeout', '15000000'];
    const effective = {};
    for (const name of allowedMediaHeaders) {
      if (!Object.hasOwn(sanitized, name)) continue;
      if (name === 'Referer' && url) {
        const ref = sanitizeReferer(sanitized.Referer, url, {
          policy: effectivePolicy,
          explicit: explicitSet.has('referer'),
        });
        if (ref) effective.Referer = ref;
      } else {
        effective[name] = sanitized[name];
      }
    }
    if (effective['User-Agent']) args.push('-user_agent', effective['User-Agent']);
    const otherHeaders = Object.entries(effective)
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

  function forRefresh(newSourceUrl, { preserveHeaders = true, preserveCookies = true, extraHeaders = null } = {}) {
    const nextUrl = newSourceUrl instanceof URL ? newSourceUrl : URL.parse(newSourceUrl);
    const nextOrigin = nextUrl?.origin ?? credentialOrigin;
    const sameOrigin = Boolean(nextOrigin && credentialOrigin && nextOrigin === credentialOrigin);
    const nextHeaders = preserveHeaders
      ? mergeMediaHeaders(sanitized, extraHeaders ?? {})
      : mergeMediaHeaders(extraHeaders ?? {});
    return createRequestContext({
      origin: nextOrigin,
      headers: nextHeaders,
      explicitHeaders: preserveHeaders ? explicitSet : new Set(Object.keys(nextHeaders).map(h => h.toLowerCase())),
      referrerPolicy: effectivePolicy,
      cookies: preserveCookies && sameOrigin ? staticCookies : [],
      cookiesFor: preserveCookies && sameOrigin ? cookiesFor : null,
      restrictedOrigin,
      transport,
      onRequest,
    });
  }

  function accessError(status, responseHeaders, phase = 'playlist', { engine = null, sentHeaderNames = null } = {}) {
    const diagPhase = normalizeDiagnosticPhase(phase);
    const canonical = canonicalHlsPhase(phase);
    const headerList = sentHeaderNames ?? stageHistory.get(diagPhase)?.sentHeaderNames ?? lastSentHeaders;
    const detail = {
      status,
      hlsPhase: canonical,
      phase: diagPhase,
      ...(engine && { engine }),
      ...(headerList?.length && { sentHeaderNames: headerList }),
    };
    if (responseHeaders?.get?.('cf-mitigated') === 'challenge') {
      recordStage(diagPhase, { status, errorCode: 'MEDIA_ACCESS_RESTRICTED', engine });
      return new ApiError(
        restrictedOrigin ? 'MCP_MEDIA_ACCESS_RESTRICTED' : 'MEDIA_ACCESS_RESTRICTED',
        'The media server returned a browser challenge',
        403,
        {
          ...detail,
          blocker: 'cloudflare-challenge',
          nextAction: 'Open the site in a dedicated VideoSave browser session (mode:"headed", profileMode:"dedicated", browserSessionId) to complete the user verification, then retry.',
        },
      );
    }
    if ([401, 402, 403, 451].includes(status)) {
      recordStage(diagPhase, { status, errorCode: 'MEDIA_ACCESS_RESTRICTED', engine });
      return new ApiError(
        restrictedOrigin ? 'MCP_MEDIA_ACCESS_RESTRICTED' : 'MEDIA_ACCESS_RESTRICTED',
        `The media server denied access during ${diagPhase} (HTTP ${status})`,
        403,
        {
          ...detail,
          nextAction: status === 401
            ? 'Authenticate in a dedicated browser session or import an authorized same-origin cookie file.'
            : `Verify authorized Referer, Origin, User-Agent, and active session for ${diagPhase}. VideoSave will not bypass access restrictions.`,
        },
      );
    }
    if (status === 410) {
      recordStage(diagPhase, { status, errorCode: 'STREAM_EXPIRED', engine });
      return new ApiError(
        'STREAM_EXPIRED',
        'The media resource is no longer available. Re-probe the original page.',
        410,
        {
          ...detail,
          nextAction: 'Re-probe the original authorized page (or enable refresh.pageUrl) to obtain a fresh signed URL and resume from checkpoints.',
        },
      );
    }
    return null;
  }

  return {
    origin: credentialOrigin,
    headers: Object.freeze({ ...sanitized }),
    referrerPolicy: effectivePolicy,
    cookies: staticCookies,
    restrictedOrigin,
    transport,
    resolveCookies,
    headersFor,
    ffmpegInputArgs,
    forRefresh,
    accessError,
    recordStage,
    getStageSummary,
  };
}
