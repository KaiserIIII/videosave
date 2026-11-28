import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import manifest from '../extension/manifest.json' with { type: 'json' };
import { ApiError } from './media-source.mjs';
import { assertSandboxPath, getSettingsFile } from './preferences.mjs';
import { getRuntimeHealth, PINNED_COMPONENTS } from './runtime-manager.mjs';

const OFFICIAL_REPO = 'KaiserIIII/videosave';
const ALLOWED_RELEASE_HOST = 'github.com';
const ALLOWED_DOWNLOAD_PREFIX = `https://github.com/${OFFICIAL_REPO}/releases/download/`;
const CURRENT_VERSION = manifest.version_name ?? manifest.version;

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9.-]+))?$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

export function selectPlatformAsset(assets, version, platform = process.platform) {
  const list = Array.isArray(assets) ? assets : [];
  if (platform === 'win32') {
    return list.find(a => a.name === `VideoSave-${version}-Setup.exe`) ||
      list.find(a => a.name === `VideoSave-${version}.zip`) ||
      null;
  }
  if (platform === 'linux') {
    return list.find(a => a.name === `videosave_${version}_all.deb`) ||
      list.find(a => a.name === `VideoSave-${version}-unix.tar.gz`) ||
      null;
  }
  return list.find(a => a.name === `VideoSave-${version}-unix.tar.gz`) || null;
}

export function assertOfficialReleaseUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    throw new ApiError('UNTRUSTED_UPDATE_URL', 'Update URL is malformed', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_RELEASE_HOST || !parsed.href.startsWith(ALLOWED_DOWNLOAD_PREFIX)) {
    throw new ApiError(
      'UNTRUSTED_UPDATE_URL',
      `Refusing update download outside official ${ALLOWED_DOWNLOAD_PREFIX}`,
      403,
    );
  }
  return parsed.href;
}

export function parseSha256Sums(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

function recordUpdateLog(entry) {
  const file = getSettingsFile();
  const dir = path.dirname(file);
  if (!existsSync(dir)) return;
  let db;
  try {
    db = new DatabaseSync(file, { timeout: 3000 });
    db.exec(`CREATE TABLE IF NOT EXISTS update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_version TEXT NOT NULL,
      to_version TEXT NOT NULL,
      asset_name TEXT,
      sha256 TEXT,
      status TEXT NOT NULL,
      detail TEXT
    )`);
    db.prepare(`INSERT INTO update_history (recorded_at, kind, from_version, to_version, asset_name, sha256, status, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      new Date().toISOString(),
      entry.kind ?? 'app',
      entry.fromVersion ?? CURRENT_VERSION,
      entry.toVersion ?? CURRENT_VERSION,
      entry.assetName ?? null,
      entry.sha256 ?? null,
      entry.status ?? 'checked',
      entry.detail ?? null,
    );
  } catch {
    // Non-fatal if DB is read-only
  } finally {
    try { db?.close(); } catch {}
  }
}

export function getUpdateHistory(limit = 20) {
  const file = getSettingsFile();
  if (!existsSync(file)) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='update_history'").get();
    if (!hasTable) return [];
    return db.prepare('SELECT * FROM update_history ORDER BY id DESC LIMIT ?').all(Math.min(50, Math.max(1, limit)));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export async function checkForUpdates({
  includePrerelease = false,
  currentVersion = CURRENT_VERSION,
  repo = OFFICIAL_REPO,
  fetchImpl = fetch,
  signal = AbortSignal.timeout(10_000),
} = {}) {
  const endpoint = includePrerelease
    ? `https://api.github.com/repos/${repo}/releases?per_page=10`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchImpl(endpoint, {
    signal,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `VideoSave/${currentVersion}` },
  });
  if (!res.ok) {
    throw new ApiError('UPDATE_CHECK_FAILED', `GitHub Releases API returned HTTP ${res.status}`, 502);
  }
  const payload = await res.json();
  const release = Array.isArray(payload)
    ? payload.find(r => !r.draft && (includePrerelease || !r.prerelease))
    : payload;
  if (!release?.tag_name) {
    throw new ApiError('UPDATE_CHECK_FAILED', 'No published GitHub Release found', 502);
  }
  const latestVersion = String(release.tag_name).replace(/^v/i, '');
  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
  const recommendedAsset = selectPlatformAsset(release.assets, latestVersion);
  const checksumAsset = (release.assets ?? []).find(a => a.name === 'SHA256SUMS.txt') ?? null;

  const runtime = await getRuntimeHealth().catch(() => null);
  const componentStatus = runtime
    ? Object.fromEntries(Object.entries(runtime.components).map(([k, v]) => [k, {
      status: v.status,
      installedVersion: v.version ?? null,
      pinnedVersion: v.pinnedVersion ?? PINNED_COMPONENTS[k]?.version ?? null,
    }]))
    : null;

  return {
    currentVersion,
    latestVersion,
    channel: includePrerelease ? 'prerelease' : 'stable',
    updateAvailable,
    publishedAt: release.published_at ?? null,
    releaseUrl: release.html_url ?? `https://github.com/${repo}/releases/tag/${release.tag_name}`,
    recommendedAsset: recommendedAsset
      ? { name: recommendedAsset.name, size: recommendedAsset.size, url: recommendedAsset.browser_download_url }
      : null,
    checksumAsset: checksumAsset
      ? { name: checksumAsset.name, url: checksumAsset.browser_download_url }
      : null,
    components: componentStatus,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Download an official release asset and strictly verify its SHA-256 against
 * the official SHA256SUMS.txt before committing it to destinationDir.
 * Never executes downloaded binaries automatically.
 */
export async function downloadAndVerifyUpdate({
  assetUrl,
  checksumsUrl,
  assetName,
  destinationDir,
  toVersion = 'unknown',
  fetchImpl = fetch,
  signal = AbortSignal.timeout(120_000),
} = {}) {
  const safeAssetUrl = assertOfficialReleaseUrl(assetUrl);
  const safeSumsUrl = assertOfficialReleaseUrl(checksumsUrl);
  const safeDir = assertSandboxPath(path.resolve(destinationDir), 'update download directory');
  if (!assetName || /[\\/\x00-\x1f]/.test(assetName) || assetName.includes('..')) {
    throw new ApiError('INVALID_UPDATE_ASSET', 'Invalid release asset filename', 400);
  }

  const sumsRes = await fetchImpl(safeSumsUrl, { signal, redirect: 'follow' });
  if (!sumsRes.ok) throw new ApiError('UPDATE_CHECKSUM_FAILED', `Failed to fetch SHA256SUMS.txt (HTTP ${sumsRes.status})`, 502);
  const sumsText = await sumsRes.text();
  const sums = parseSha256Sums(sumsText);
  const expectedSha = sums.get(assetName);
  if (!expectedSha) {
    throw new ApiError('UPDATE_CHECKSUM_MISSING', `Asset ${assetName} is missing from official SHA256SUMS.txt`, 422);
  }

  await mkdir(safeDir, { recursive: true });
  const staged = path.join(safeDir, `${assetName}.part-${Date.now()}`);
  const finalPath = path.join(safeDir, assetName);
  try {
    const assetRes = await fetchImpl(safeAssetUrl, { signal, redirect: 'follow' });
    if (!assetRes.ok) throw new ApiError('UPDATE_DOWNLOAD_FAILED', `Failed to fetch ${assetName} (HTTP ${assetRes.status})`, 502);
    const buf = Buffer.from(await assetRes.arrayBuffer());
    const actualSha = createHash('sha256').update(buf).digest('hex');
    if (actualSha !== expectedSha) {
      recordUpdateLog({ kind: 'app', toVersion, assetName, sha256: actualSha, status: 'checksum-mismatch', detail: `expected ${expectedSha}` });
      throw new ApiError('UPDATE_CHECKSUM_MISMATCH', `SHA-256 verification failed for ${assetName}`, 422, {
        expected: expectedSha,
        actual: actualSha,
      });
    }
    await writeFile(staged, buf);
    await rename(staged, finalPath);
    recordUpdateLog({ kind: 'app', toVersion, assetName, sha256: actualSha, status: 'verified-staged' });
    return {
      ok: true,
      file: finalPath,
      assetName,
      bytes: buf.length,
      sha256: actualSha,
      verifiedAgainst: 'SHA256SUMS.txt',
      autoExecuted: false,
    };
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    throw err;
  }
}
