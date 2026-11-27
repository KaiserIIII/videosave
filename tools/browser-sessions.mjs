import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from './media-source.mjs';

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const activeSessions = new Set();

export function profilesRoot() {
  if (process.env.VIDEOSAVE_PROFILES_DIR) return path.resolve(process.env.VIDEOSAVE_PROFILES_DIR);
  if (process.env.VIDEOSAVE_TEST_SANDBOX) return path.join(path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX), 'profiles');
  const stateDir = process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
  return path.join(stateDir, 'VideoSave', 'profiles');
}

export function validateSessionId(browserSessionId) {
  if (typeof browserSessionId !== 'string' || !SESSION_ID_RE.test(browserSessionId)) {
    throw new ApiError('INVALID_BROWSER_SESSION', 'browserSessionId 应为 1–48 位字母、数字、下划线或连字符');
  }
  return browserSessionId;
}

export function resolveDedicatedProfileDir(sessionId) {
  const root = profilesRoot();
  const dir = path.resolve(root, validateSessionId(sessionId));
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

export async function prepareDedicatedProfile(browserSessionId, { browser, userAgent } = {}) {
  const id = validateSessionId(browserSessionId);
  if (activeSessions.has(id)) {
    throw new ApiError('BROWSER_SESSION_BUSY', '该专用浏览器会话正在使用中，请稍候重试', 409);
  }
  const dir = sessionDirectory(id);
  const downloadsDir = path.join(dir, 'Downloads');
  await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  let meta = { id, createdAt: now, authorizedOrigins: [] };
  try {
    meta = { ...meta, ...JSON.parse(await readFile(metadataPath(dir), 'utf8')) };
  } catch {}
  meta.lastUsedAt = now;
  if (browser) meta.browser = browser;
  if (userAgent) meta.userAgent = userAgent;
  await writeFile(metadataPath(dir), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  activeSessions.add(id);
  return {
    id,
    profileDir: dir,
    downloadsDir,
    release() {
      activeSessions.delete(id);
    },
  };
}

export async function recordDedicatedOrigin(browserSessionId, origin) {
  const id = validateSessionId(browserSessionId);
  const dir = sessionDirectory(id);
  try {
    const meta = JSON.parse(await readFile(metadataPath(dir), 'utf8'));
    const origins = new Set(Array.isArray(meta.authorizedOrigins) ? meta.authorizedOrigins : []);
    if (origin) origins.add(origin);
    meta.authorizedOrigins = [...origins].slice(-32);
    meta.lastUsedAt = new Date().toISOString();
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
    return {
      isolatedRoot: root,
      profileMode: 'dedicated',
      session: {
        id,
        exists,
        active: activeSessions.has(id),
        profilePath: dir,
        browser: meta?.browser ?? null,
        createdAt: meta?.createdAt ?? null,
        lastUsedAt: meta?.lastUsedAt ?? null,
        authorizedOrigins: meta?.authorizedOrigins ?? [],
        userActionHint: exists
          ? '可在 probe_page 中设置 profileMode:"dedicated" 与此 browserSessionId 复用该专用会话；如需重新登录，请设置 mode:"headed"。'
          : '该专用会话尚未创建。请使用 mode:"headed", profileMode:"dedicated" 启动专用浏览器并完成正常登录。',
      },
    };
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const meta = await readFile(metadataPath(dir), 'utf8').then(JSON.parse).catch(() => null);
    items.push({
      id: entry.name,
      exists: true,
      active: activeSessions.has(entry.name),
      browser: meta?.browser ?? null,
      createdAt: meta?.createdAt ?? null,
      lastUsedAt: meta?.lastUsedAt ?? null,
      authorizedOrigins: meta?.authorizedOrigins ?? [],
    });
  }
  return {
    isolatedRoot: root,
    sessions: items,
    guidance: 'VideoSave 仅管理专用隔离浏览器配置目录，绝不读取系统浏览器全部 Cookie、密码或历史记录。',
  };
}

export async function resetBrowserSession(browserSessionId) {
  const id = validateSessionId(browserSessionId);
  if (activeSessions.has(id)) {
    throw new ApiError('BROWSER_SESSION_BUSY', '请等待该专用浏览器会话结束后再重置', 409);
  }
  const dir = sessionDirectory(id);
  await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  return { ok: true, id, session: { id, exists: false } };
}
