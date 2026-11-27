import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import manifest from '../extension/manifest.json' with { type: 'json' };
import { ApiError } from './media-source.mjs';
import { getSettingsFile } from './preferences.mjs';

const strategies = new Set(['standard', 'deep']);
const knownEngines = new Set(['http', 'hls', 'dash-static', 'ffmpeg', 'yt-dlp', 'streamlink']);
const limit = 250;
const strategyLifetimeMs = 30 * 86400_000;
const currentAppVersion = manifest.version_name ?? manifest.version;
export const probeModes = Object.freeze(['standard', 'fast', 'balanced', 'deep', 'maximum', 'adaptive']);

const EXTRA_COLUMNS = [
  ['last_verified', 'INTEGER'],
  ['player_type', 'TEXT'],
  ['protocol', 'TEXT'],
  ['best_engine', 'TEXT'],
  ['recommended_connections', 'INTEGER'],
  ['last_error', 'TEXT'],
  ['app_version', 'TEXT'],
];

function database(run) {
  const file = getSettingsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS compatibility_rules (
      origin TEXT PRIMARY KEY, preferred TEXT, samples INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0, deep_successes INTEGER NOT NULL DEFAULT 0,
      elapsed INTEGER NOT NULL DEFAULT 0, kind TEXT, last_verified INTEGER,
      player_type TEXT, protocol TEXT, best_engine TEXT, recommended_connections INTEGER,
      last_error TEXT, app_version TEXT
    )`);
    const existing = new Set(db.prepare('PRAGMA table_info(compatibility_rules)').all().map(c => c.name));
    const missing = EXTRA_COLUMNS.filter(([name]) => !existing.has(name));
    if (missing.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const recheck = new Set(db.prepare('PRAGMA table_info(compatibility_rules)').all().map(c => c.name));
        for (const [name, type] of missing) {
          if (!recheck.has(name)) db.exec(`ALTER TABLE compatibility_rules ADD COLUMN ${name} ${type}`);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return run(db);
  } finally {
    db.close();
  }
}

const isFresh = row => Boolean(row?.last_verified && row.last_verified > Date.now() - strategyLifetimeMs);

const preference = row => row?.preferred ?? (isFresh(row) &&
  row.deep_successes >= 2 && row.deep_successes * 2 >= row.samples ? 'deep' : 'standard');

export function preferredProbeStrategy(origin) {
  return database(db => preference(db.prepare('SELECT * FROM compatibility_rules WHERE origin=?').get(origin)));
}

export function getOriginCompatibilityRule(origin) {
  return database(db => {
    const row = db.prepare('SELECT * FROM compatibility_rules WHERE origin=?').get(origin);
    if (!row) return null;
    return {
      origin: row.origin,
      preferred: preference(row),
      samples: row.samples,
      successes: row.successes,
      successRate: row.samples ? Number((row.successes / row.samples).toFixed(3)) : null,
      averageMs: row.samples ? Math.round(row.elapsed / row.samples) : null,
      kind: row.kind,
      playerType: row.player_type ?? null,
      protocol: row.protocol ?? row.kind ?? null,
      bestEngine: isFresh(row) ? (row.best_engine ?? null) : null,
      recommendedConnections: row.recommended_connections ?? null,
      lastError: row.last_error ?? null,
      appVersion: row.app_version ?? null,
      lastVerified: row.last_verified ? new Date(row.last_verified).toISOString() : null,
      decayed: !isFresh(row) && !row.preferred,
    };
  });
}

export function maximumProbePlan(waitMs, preferred) {
  if (preferred === 'deep' || waitMs <= 8000) return [{ waitMs, deep: true }];
  return [{ waitMs: 6000, deep: false }, { waitMs: waitMs - 6000, deep: true }];
}

export function probePlan(mode, { waitMs, retries, singleWindow, preferred }) {
  if (mode === 'maximum' || mode === 'adaptive') return maximumProbePlan(waitMs, preferred);
  if (mode === 'fast') return [{ waitMs: Math.min(waitMs, 4000), deep: false }];
  if (mode === 'balanced' || mode === 'deep') return [{ waitMs, deep: mode === 'deep' }];
  return Array.from({ length: retries + 1 }, (_, attempt) => ({
    waitMs: singleWindow ? waitMs : Math.round(waitMs * (1 + attempt / 2)),
    deep: false,
  }));
}

/**
 * Record privacy-safe compatibility telemetry for an origin.
 * Strictly stores origin-level protocol/engine metrics only — NEVER stores titles, URLs, paths, or cookies.
 */
export function recordCompatibility(url, {
  stage = 'standard', success = false, elapsedMs = 0, kind = null,
  playerType = null, engine = null, connections = null, errorCode = null,
} = {}) {
  const format = /^(?:mp4|m4v|mov|webm|mkv|flv|ts|ogv|m4a|mp3|aac|wav|flac|m3u8|mpd)$/.test(kind ?? '') ? kind : null;
  const safePlayer = /^[a-z0-9_-]{1,32}$/i.test(playerType ?? '') ? playerType.toLowerCase() : null;
  const safeEngine = knownEngines.has(engine) ? engine : null;
  const safeConn = [4, 8, 12].includes(connections) ? connections : null;
  const safeError = /^[A-Z0-9_]{2,48}$/.test(errorCode ?? '') ? errorCode : null;
  database(db => {
    const now = Date.now();
    const cutoff = now - strategyLifetimeMs;
    db.prepare(`INSERT INTO compatibility_rules(
      origin,samples,successes,deep_successes,elapsed,kind,last_verified,
      player_type,protocol,best_engine,recommended_connections,last_error,app_version
    ) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin) DO UPDATE SET
      samples=CASE WHEN last_verified > ? THEN samples+1 ELSE 1 END,
      successes=excluded.successes+CASE WHEN last_verified > ? THEN successes ELSE 0 END,
      deep_successes=excluded.deep_successes+CASE WHEN last_verified > ? THEN deep_successes ELSE 0 END,
      elapsed=excluded.elapsed+CASE WHEN last_verified > ? THEN elapsed ELSE 0 END,
      kind=coalesce(excluded.kind,CASE WHEN last_verified > ? THEN kind END),
      player_type=coalesce(excluded.player_type,CASE WHEN last_verified > ? THEN player_type END),
      protocol=coalesce(excluded.protocol,CASE WHEN last_verified > ? THEN protocol END),
      best_engine=CASE WHEN excluded.successes=1 AND excluded.best_engine IS NOT NULL THEN excluded.best_engine WHEN last_verified > ? THEN best_engine END,
      recommended_connections=coalesce(excluded.recommended_connections,CASE WHEN last_verified > ? THEN recommended_connections END),
      last_error=CASE WHEN excluded.successes=1 THEN NULL ELSE coalesce(excluded.last_error,last_error) END,
      app_version=excluded.app_version,
      last_verified=excluded.last_verified`)
      .run(
        url.origin, Number(success), Number(success && stage === 'deep'),
        Math.min(120_000, Math.max(0, Math.round(elapsedMs))), format, now,
        safePlayer, format, safeEngine, safeConn, safeError, currentAppVersion,
        cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff,
      );
    db.prepare('DELETE FROM compatibility_rules WHERE rowid IN (SELECT rowid FROM compatibility_rules ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(limit);
  });
}

export function compatibilityRules(update) {
  const invalid = () => new ApiError('INVALID_COMPATIBILITY_RULE', 'Use up to 250 exact origins and known probe strategies');
  if (update && update.action !== 'reset' && (update.action !== 'import' || !Array.isArray(update.items) || update.items.length > limit)) throw invalid();
  const allowedImportKeys = new Set([
    'origin', 'preferred', 'samples', 'successes', 'successRate', 'averageMs', 'kind',
    'playerType', 'protocol', 'bestEngine', 'recommendedConnections', 'lastError', 'appVersion', 'lastVerified', 'decayed',
  ]);
  const items = update?.action === 'import' ? update.items.map(item => {
    const url = item && typeof item.origin === 'string' && item.origin.length <= 2048 && URL.parse(item.origin);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== item.origin ||
        !strategies.has(item.preferred) || Object.keys(item).some(key => !allowedImportKeys.has(key))) throw invalid();
    if (item.bestEngine !== undefined && item.bestEngine !== null && !knownEngines.has(item.bestEngine)) throw invalid();
    if (item.recommendedConnections !== undefined && item.recommendedConnections !== null && ![4, 8, 12].includes(item.recommendedConnections)) throw invalid();
    return {
      origin: url.origin,
      preferred: item.preferred,
      bestEngine: item.bestEngine ?? null,
      recommendedConnections: item.recommendedConnections ?? null,
    };
  }) : [];
  return database(db => {
    if (update?.action === 'reset') db.exec('DELETE FROM compatibility_rules');
    if (items.length) {
      const set = db.prepare(`INSERT INTO compatibility_rules(origin,preferred,best_engine,recommended_connections,app_version,last_verified)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(origin) DO UPDATE SET
          preferred=excluded.preferred,
          best_engine=coalesce(excluded.best_engine,best_engine),
          recommended_connections=coalesce(excluded.recommended_connections,recommended_connections),
          app_version=excluded.app_version,
          last_verified=excluded.last_verified`);
      const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { origin, preferred, bestEngine, recommendedConnections } of items) {
          set.run(origin, preferred, bestEngine, recommendedConnections, currentAppVersion, now);
        }
        if (db.prepare('SELECT count(*) AS count FROM compatibility_rules').get().count > limit) throw invalid();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return {
      version: currentAppVersion,
      items: db.prepare('SELECT * FROM compatibility_rules ORDER BY origin').all().map(row => ({
        origin: row.origin,
        preferred: preference(row),
        samples: row.samples,
        successes: row.successes,
        averageMs: row.samples ? Math.round(row.elapsed / row.samples) : null,
        kind: row.kind,
        ...(row.player_type && { playerType: row.player_type }),
        ...(row.best_engine && { bestEngine: row.best_engine }),
        ...(row.recommended_connections && { recommendedConnections: row.recommended_connections }),
        ...(row.last_error && { lastError: row.last_error }),
        ...(row.app_version && { appVersion: row.app_version }),
        ...(row.last_verified && { lastVerified: new Date(row.last_verified).toISOString() }),
      })),
    };
  });
}
