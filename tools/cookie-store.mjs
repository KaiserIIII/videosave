import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isChallengeCookie } from './approved-cookies.mjs';
import { ApiError, mediaUrl, parseCookies } from './media-source.mjs';

const MAX_COOKIE_FILE_BYTES = 64 * 1024;
const MAX_COOKIES = 50;
const MAX_SESSIONS = 32;
const sessions = new Map();

function sweepSessions(now = Date.now()) {
  for (const [id, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(id);
  }
}

function domainMatches(cookieDomain, hostname, includeSubdomains) {
  const host = hostname.toLowerCase();
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  if (host === domain) return true;
  return includeSubdomains && host.endsWith('.' + domain);
}

function pathMatches(cookiePath, pathname) {
  if (pathname === cookiePath) return true;
  const prefix = cookiePath.endsWith('/') ? cookiePath : cookiePath + '/';
  return pathname.startsWith(prefix);
}

/**
 * Parse either a Netscape cookies.txt file OR a single-line HTTP Cookie header.
 * Rejects challenge/anti-bot cookies and enforces size and format safety limits.
 */
export function parseCookieText(text, targetUrl) {
  const url = targetUrl instanceof URL ? targetUrl : mediaUrl(targetUrl);
  if (typeof text !== 'string' || !text.trim()) {
    throw new ApiError('INVALID_COOKIE', 'Cookie 内容不能为空');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_COOKIE_FILE_BYTES) {
    throw new ApiError('INVALID_COOKIE', 'Cookie 文件超过 64 KiB 上限');
  }
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map(line => line.trim()).filter(Boolean);
  const looksNetscape = nonEmpty.some(line => line.startsWith('# Netscape') || line.startsWith('# HTTP Cookie') || line.includes('\t'));

  if (!looksNetscape) {
    const headerLine = nonEmpty.filter(line => !line.startsWith('#')).join('; ').replace(/^cookie\s*:\s*/i, '');
    const pairs = parseCookies(headerLine);
    if (!pairs.length) throw new ApiError('INVALID_COOKIE', '未解析到有效的 Cookie');
    if (pairs.some(({ name }) => isChallengeCookie(name))) {
      throw new ApiError('INVALID_COOKIE', '不接受反机器人挑战类 Cookie（如 cf_clearance）');
    }
    return {
      format: 'header',
      cookies: pairs.slice(0, MAX_COOKIES).map(({ name, value }) => ({
        name,
        value,
        domain: url.hostname.toLowerCase(),
        includeSubdomains: false,
        path: '/',
        secure: url.protocol === 'https:',
      })),
    };
  }

  const nowSec = Date.now() / 1000;
  const parsed = [];
  let sawChallenge = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const line = trimmed.replace(/^#HttpOnly_/i, '');
    if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length !== 7) {
      throw new ApiError('INVALID_COOKIE', 'Netscape Cookie 文件列格式无效（应为 7 列制表符分隔）');
    }
    const [host, subdomains, cookiePath, secure, expires, name, value] = parts;
    if (!['TRUE', 'FALSE'].includes(subdomains) || !['TRUE', 'FALSE'].includes(secure) ||
        !cookiePath.startsWith('/') || !/^\d+$/.test(expires)) {
      throw new ApiError('INVALID_COOKIE', 'Netscape Cookie 条目包含非法字段');
    }
    if (!/^[!#$%&'*+.\x60^_|~\w-]{1,128}$/.test(name) || /[^\x20-\x7e]/.test(value)) {
      throw new ApiError('INVALID_COOKIE', 'Cookie 名称或值包含非法字符');
    }
    const includeSubdomains = subdomains === 'TRUE';
    if (!domainMatches(host, url.hostname, includeSubdomains)) continue;
    if (isChallengeCookie(name)) {
      sawChallenge = true;
      continue;
    }
    const expirationDate = Number(expires);
    if (expirationDate > 0 && expirationDate <= nowSec) continue;
    parsed.push({
      name,
      value,
      domain: host.replace(/^\./, '').toLowerCase(),
      includeSubdomains,
      path: cookiePath,
      secure: secure === 'TRUE',
      ...(expirationDate > 0 && { expirationDate }),
    });
    if (parsed.length >= MAX_COOKIES) break;
  }
  if (!parsed.length) {
    throw new ApiError(
      'INVALID_COOKIE',
      sawChallenge ? '不接受反机器人挑战类 Cookie（如 cf_clearance）' : 'Cookie 文件中没有匹配目标站点的有效未过期 Cookie',
    );
  }
  parsed.sort((a, b) => b.path.length - a.path.length);
  return { format: 'netscape', cookies: parsed };
}

export async function readCookieFileForOrigin(filePath, targetUrl) {
  if (typeof filePath !== 'string' || !filePath.trim() || /[\x00-\x1f]/.test(filePath)) {
    throw new ApiError('INVALID_COOKIE', 'Cookie 文件路径无效');
  }
  const resolved = path.resolve(filePath);
  const handle = await open(resolved, 'r').catch(() => null);
  if (!handle) throw new ApiError('INVALID_COOKIE', '无法打开指定的 Cookie 文件');
  try {
    const buffer = Buffer.alloc(MAX_COOKIE_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) {
      throw new ApiError('INVALID_COOKIE', 'Cookie 文件超过 64 KiB 上限');
    }
    return parseCookieText(buffer.subarray(0, bytesRead).toString('utf8'), targetUrl);
  } finally {
    await handle.close();
  }
}

export function matchStoredCookies(cookies, targetUrl) {
  const url = targetUrl instanceof URL ? targetUrl : URL.parse(targetUrl);
  if (!url || !Array.isArray(cookies)) return [];
  const nowSec = Date.now() / 1000;
  return cookies
    .filter(cookie =>
      domainMatches(cookie.domain, url.hostname, cookie.includeSubdomains === true) &&
      (!cookie.secure || url.protocol === 'https:') &&
      (cookie.expirationDate === undefined || cookie.expirationDate > nowSec) &&
      pathMatches(cookie.path ?? '/', url.pathname),
    )
    .map(({ name, value }) => ({ name, value }));
}

export async function importCookieSession({ filePath, origin, ttlMinutes = 30 } = {}) {
  sweepSessions();
  const url = mediaUrl(origin);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 120) {
    throw new ApiError('INVALID_COOKIE', 'Cookie 临时授权时长应为 1 至 120 分钟');
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new ApiError('COOKIE_SESSION_LIMIT', '临时 Cookie 会话数量已达上限', 429);
  }
  const { format, cookies } = await readCookieFileForOrigin(filePath, url);
  const id = randomUUID();
  const expiresAt = Date.now() + ttlMinutes * 60_000;
  sessions.set(id, { id, origin: url.origin, format, cookies, createdAt: Date.now(), expiresAt });
  // Never return raw cookie values to the AI model or caller.
  return {
    sessionId: id,
    cookieSessionId: id,
    origin: url.origin,
    format,
    cookieCount: cookies.length,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function resolveCookieSession(sessionId, targetUrl) {
  sweepSessions();
  if (!sessionId) return [];
  const entry = sessions.get(sessionId);
  if (!entry) throw new ApiError('SESSION_EXPIRED', '导入的临时 Cookie 会话已过期或不存在，请重新导入', 401);
  const url = targetUrl instanceof URL ? targetUrl : mediaUrl(targetUrl);
  if (url.origin !== entry.origin) return [];
  return matchStoredCookies(entry.cookies, url);
}

export function listCookieSessions() {
  sweepSessions();
  return {
    items: [...sessions.values()].map(({ id, origin, format, cookies, createdAt, expiresAt }) => ({
      sessionId: id,
      origin,
      format,
      cookieCount: cookies.length,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    })),
  };
}

export function revokeCookieSession(sessionId) {
  const existed = sessions.delete(sessionId);
  return { ok: true, revoked: existed };
}

export function clearCookieSessions() {
  sessions.clear();
}
