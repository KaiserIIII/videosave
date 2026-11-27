import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from './media-source.mjs';
import { settingsFile } from './preferences.mjs';

const strategies = new Set(['standard','deep']);
const limit = 250;

function database(run) {
  mkdirSync(path.dirname(settingsFile),{recursive:true});
  const db = new DatabaseSync(settingsFile,{timeout:5000});
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS compatibility_rules (
      origin TEXT PRIMARY KEY, preferred TEXT, samples INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0, deep_successes INTEGER NOT NULL DEFAULT 0,
      elapsed INTEGER NOT NULL DEFAULT 0, kind TEXT
    )`);
    return run(db);
  } finally { db.close(); }
}

const preference = row => row?.preferred ?? (row?.deep_successes >= 2 && row.deep_successes * 2 >= row.successes ? 'deep' : 'standard');

export function preferredProbeStrategy(origin) {
  return database(db => preference(db.prepare('SELECT * FROM compatibility_rules WHERE origin=?').get(origin)));
}

export function maximumProbePlan(waitMs, preferred) {
  if (preferred === 'deep' || waitMs <= 8000) return [{waitMs,deep:true}];
  return [{waitMs:6000,deep:false},{waitMs:waitMs-6000,deep:true}];
}

export function recordCompatibility(url,{stage,success,elapsedMs,kind}) {
  const format = /^(?:mp4|m4v|mov|webm|mkv|flv|ts|ogv|m4a|mp3|aac|wav|flac|m3u8|mpd)$/.test(kind ?? '') ? kind : null;
  database(db => {
    db.prepare(`INSERT INTO compatibility_rules(origin,samples,successes,deep_successes,elapsed,kind)
      VALUES (?,1,?,?,?,?) ON CONFLICT(origin) DO UPDATE SET
      samples=samples+1,successes=successes+excluded.successes,deep_successes=deep_successes+excluded.deep_successes,
      elapsed=elapsed+excluded.elapsed,kind=coalesce(excluded.kind,kind)`).run(url.origin,Number(success),
      Number(success && stage === 'deep'),Math.min(120_000,Math.max(0,Math.round(elapsedMs))),format);
    db.prepare('DELETE FROM compatibility_rules WHERE rowid IN (SELECT rowid FROM compatibility_rules ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(limit);
  });
}

export function compatibilityRules(update) {
  const invalid = () => new ApiError('INVALID_COMPATIBILITY_RULE','Use up to 250 exact origins and known probe strategies');
  if (update && update.action !== 'reset' && (update.action !== 'import' || !Array.isArray(update.items) || update.items.length > limit)) throw invalid();
  const items = update?.action === 'import' ? update.items.map(item => {
    const url = item && typeof item.origin === 'string' && item.origin.length <= 2048 && URL.parse(item.origin);
    if (!url || !['http:','https:'].includes(url.protocol) || url.origin !== item.origin ||
        !strategies.has(item.preferred) || Object.keys(item).some(key => !['origin','preferred','samples','successes','averageMs','kind'].includes(key))) throw invalid();
    return {origin:url.origin,preferred:item.preferred};
  }) : [];
  return database(db => {
    if (update?.action === 'reset') db.exec('DELETE FROM compatibility_rules');
    if (items.length) {
      const set = db.prepare(`INSERT INTO compatibility_rules(origin,preferred) VALUES (?,?)
        ON CONFLICT(origin) DO UPDATE SET preferred=excluded.preferred`);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const {origin,preferred} of items) set.run(origin,preferred);
        if (db.prepare('SELECT count(*) AS count FROM compatibility_rules').get().count > limit) throw invalid();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return {items:db.prepare('SELECT * FROM compatibility_rules ORDER BY origin').all().map(row => ({
      origin:row.origin,preferred:preference(row),samples:row.samples,successes:row.successes,
      averageMs:row.samples ? Math.round(row.elapsed/row.samples) : null,kind:row.kind,
    }))};
  });
}
