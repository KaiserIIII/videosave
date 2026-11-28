import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './media-source.mjs';
import { assertSandboxPath } from './preferences.mjs';

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const STALE_LOCK_MS = 5 * 60_000;
const activeSessions = new Set();
const sessionWaiters = new Map();

export function profilesRoot() {
  if (process.env.VIDEOSAVE_PROFILES_DIR) return assertSandboxPath(path.resolve(process.env.VIDEOSAVE_PROFILES_DIR), 'browser profiles directory');
  if (process.env.VIDEOSAVE_TEST_SANDBOX) return assertSandboxPath(path.join(path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX), 'profiles'), 'browser profiles directory');
  const stateDir = process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
  return assertSandboxPath(path.join(stateDir, 'VideoSave', 'profiles'), 'browser profiles directory');
}

export function validateSessionId(browserSessionId) {
  if (typeof browserSessionId !== 'string' || !SESSION_ID_RE.test(browserSessionId)) {
    throw new ApiError('INVALID_BROWSER_SESSION', 'browserSessionId 应为 1–48 位字母、数字、下划线或连字符');
  }
  return browserSessionId;
}

export function resolveDedicatedProfileDir(sessionId) {
  const root = profilesRoot();
  const dir = assertSandboxPath(path.resolve(root, validateSessionId(sessionId)), 'dedicated browser profile');
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ApiError('INVALID_BROWSER_SESSION', '浏览器会话目录超出受控范围');
  }
  return dir;
}

const sessionDirectory = resolveDedicatedProfileDir;

function metadataPath(dir) {
  return path.join(dir, 'videosave-session.json');
}

function lockPath(dir) {
  return path.join(dir, 'videosave-session.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function isLockHeldByLiveProcess(dir) {
  const file = lockPath(dir);
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    const age = Date.now() - Number(parsed.acquiredAt || 0);
    if (age > STALE_LOCK_MS || !pidAlive(parsed.pid)) {
      await rm(file, { force: true }).catch(() => {});
      return false;
    }
    return true;
  } catch {
    await rm(file, { force: true }).catch(() => {});
    return false;
  }
}

async function acquireFileLock(dir, sessionId, { signal, waitTimeoutMs = 20_000 } = {}) {
  const file = lockPath(dir);
  const deadline = Date.now() + waitTimeoutMs;
  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, sessionId, acquiredAt: Date.now() }) + '\n');
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(file, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const alive = await isLockHeldByLiveProcess(dir);
      if (!alive) continue;
      if (Date.now() >= deadline) {
        throw new ApiError('SESSION_BUSY', `专用浏览器会话 ${sessionId} 正在由另一任务使用，请稍候重试`, 409, {
          browserSessionId: sessionId,
          diagnosticState: 'SESSION_BUSY',
        });
      }
      await sleep(150, undefined, { signal });
    }
  }
}

/**
 * Serialize in-process tasks that share the same dedicated browserSessionId so concurrent probes
 * never fight over the same Chromium profile or invalidate an authorized session.
 */
export async function withDedicatedSessionQueue(browserSessionId, task, { signal } = {}) {
  const id = validateSessionId(browserSessionId);
  const prev = sessionWaiters.get(id) ?? Promise.resolve();
  let releaseTurn;
  const current = new Promise(resolve => { releaseTurn = resolve; });
  const tail = prev.then(() => current);
  sessionWaiters.set(id, tail);
  try {
    await prev;
    signal?.throwIfAborted();
    return await task();
  } finally {
    releaseTurn();
    if (sessionWaiters.get(id) === tail) sessionWaiters.delete(id);
  }
}

async function inspectProfileCookiesPresence(dir) {
  for (const rel of [path.join('Default', 'Network', 'Cookies'), path.join('Default', 'Cookies')]) {
    const info = await stat(path.join(dir, rel)).catch(() => null);
    if (info?.isFile() && info.size > 0) return true;
  }
  return false;
}

function computeDiagnosticState({ exists, locked, meta, hasCookies }) {
  if (locked) return 'SESSION_BUSY';
  if (!exists) return 'USER_ACTION_REQUIRED';
  if (meta?.lastBlockers?.includes('auth-required') || meta?.lastBlockers?.includes('login')) return 'LOGIN_REQUIRED';
  if (meta?.lastBlockers?.includes('cloudflare-challenge') || meta?.lastBlockers?.includes('cf-turnstile') || meta?.lastBlockers?.includes('captcha')) {
    return 'USER_ACTION_REQUIRED';
  }
  if (meta?.lastBlockers?.includes('access-denied')) return 'MEDIA_ACCESS_RESTRICTED';
  if (hasCookies || (meta?.authorizedOrigins?.length ?? 0) > 0) return 'READY';
  return 'USER_ACTION_REQUIRED';
}

export async function prepareDedicatedProfile(browserSessionId, { browser, userAgent, signal, waitTimeoutMs = 20_000 } = {}) {
  const id = validateSessionId(browserSessionId);
  const dir = sessionDirectory(id);
  const downloadsDir = path.join(dir, 'Downloads');
  await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
  const releaseFileLock = await acquireFileLock(dir, id, { signal, waitTimeoutMs });
  const now = new Date().toISOString();
  let meta = { id, createdAt: now, authorizedOrigins: [], lastChallengeAt: null, lastBlockers: [] };
  try {
    meta = { ...meta, ...JSON.parse(await readFile(metadataPath(dir), 'utf8')) };
  } catch {}
  meta.lastUsedAt = now;
  if (browser) meta.browser = browser;
  if (userAgent) meta.userAgent = userAgent;
  await writeFile(metadataPath(dir), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  activeSessions.add(id);
  let released = false;
  return {
    id,
    profileDir: dir,
    downloadsDir,
    async release() {
      if (released) return;
      released = true;
      activeSessions.delete(id);
      await releaseFileLock();
    },
  };
}

export async function recordDedicatedOrigin(browserSessionId, origin, { blockers = [], streamCount = 0 } = {}) {
  const id = validateSessionId(browserSessionId);
  const dir = sessionDirectory(id);
  try {
    const meta = JSON.parse(await readFile(metadataPath(dir), 'utf8'));
    const origins = new Set(Array.isArray(meta.authorizedOrigins) ? meta.authorizedOrigins : []);
    if (origin) origins.add(origin);
    meta.authorizedOrigins = [...origins].slice(-32);
    const now = new Date().toISOString();
    meta.lastUsedAt = now;
    meta.lastBlockers = Array.isArray(blockers) ? blockers.slice(0, 8) : [];
    if (meta.lastBlockers.some(b => ['cloudflare-challenge', 'cf-turnstile', 'captcha'].includes(b))) {
      meta.lastChallengeAt = now;
    } else if (streamCount > 0 && !meta.lastBlockers.length) {
      meta.lastVerifiedAt = now;
    }
    await writeFile(metadataPath(dir), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

export async function getBrowserSessionStatus(browserSessionId) {
  const root = profilesRoot();
  if (browserSessionId !== undefined) {
    const id = validateSessionId(browserSessionId);
    const dir = sessionDirectory(id);
    const exists = existsSync(dir);
    let meta = null;
    if (exists) {
      meta = await readFile(metadataPath(dir), 'utf8').then(JSON.parse).catch(() => null);
    }
    const locked = activeSessions.has(id) || (exists && await isLockHeldByLiveProcess(dir));
    const hasCookies = exists ? await inspectProfileCookiesPresence(dir) : false;
    const diagnosticState = computeDiagnosticState({ exists, locked, meta, hasCookies });
    const usable = Boolean(exists && !locked && diagnosticState === 'READY');
    return {
      isolatedRoot: root,
      profileMode: 'dedicated',
      session: {
        id,
        exists,
        active: locked,
        locked,
        hasCookies,
        usable,
        diagnosticState,
        profilePath: dir,
        browser: meta?.browser ?? null,
        userAgent: meta?.userAgent ?? null,
        createdAt: meta?.createdAt ?? null,
        lastUsedAt: meta?.lastUsedAt ?? null,
        lastVerifiedAt: meta?.lastVerifiedAt ?? null,
        lastChallengeAt: meta?.lastChallengeAt ?? null,
        lastBlockers: meta?.lastBlockers ?? [],
        authorizedOrigins: meta?.authorizedOrigins ?? [],
        userActionHint: usable
          ? '可在 probe_page 中设置 profileMode:"dedicated" 与此 browserSessionId 复用该专用会话；确认无拦截时 probe_page 返回 blockers: []。'
          : diagnosticState === 'LOGIN_REQUIRED'
            ? '目标站点要求登录。请使用 mode:"headed", profileMode:"dedicated" 打开专用浏览器完成正常登录后重试。'
            : diagnosticState === 'SESSION_BUSY'
              ? '该专用会话正被另一个探测任务占用，VideoSave 会自动串行排队或请稍候重试。'
              : '该专用会话尚未完成初始化或需要用户交互。请使用 mode:"headed", profileMode:"dedicated" 启动专用浏览器并完成正常登录或页面交互。',
      },
    };
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const meta = await readFile(metadataPath(dir), 'utf8').then(JSON.parse).catch(() => null);
    const locked = activeSessions.has(entry.name) || await isLockHeldByLiveProcess(dir);
    const hasCookies = await inspectProfileCookiesPresence(dir);
    const diagnosticState = computeDiagnosticState({ exists: true, locked, meta, hasCookies });
    items.push({
      id: entry.name,
      exists: true,
      active: locked,
      locked,
      hasCookies,
      usable: !locked && diagnosticState === 'READY',
      diagnosticState,
      browser: meta?.browser ?? null,
      createdAt: meta?.createdAt ?? null,
      lastUsedAt: meta?.lastUsedAt ?? null,
      lastChallengeAt: meta?.lastChallengeAt ?? null,
      authorizedOrigins: meta?.authorizedOrigins ?? [],
    });
  }
  return {
    isolatedRoot: root,
    sessions: items,
    guidance: 'VideoSave 仅管理专用隔离浏览器配置目录，绝不读取系统浏览器全部 Cookie、密码或历史记录。同一 browserSessionId 的任务自动串行调度以保护会话一致性。',
  };
}

export async function resetBrowserSession(browserSessionId) {
  const id = validateSessionId(browserSessionId);
  const dir = sessionDirectory(id);
  const locked = activeSessions.has(id) || (existsSync(dir) && await isLockHeldByLiveProcess(dir));
  if (locked) {
    throw new ApiError('BROWSER_SESSION_BUSY', '请等待该专用浏览器会话结束后再重置', 409, { diagnosticState: 'SESSION_BUSY' });
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  return { ok: true, id, revoked: true, session: { id, exists: false, hasCookies: false, usable: false } };
}
