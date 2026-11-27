import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ApiError } from './media-source.mjs';
import { settingsFile } from './preferences.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const roles = Object.freeze(['read-only','standard','custom']);
export const scopes = Object.freeze(['read','download','session','files']);
const presets = {'read-only':['read','session'], standard:['read','session','download']};
const mediaKinds = new Set(['mp4','m4v','mov','webm','ogv','m4a','mp3','aac','wav','flac','m3u8','mpd']);
const sessions = new Map();
let onRevocation = () => {};
export function handleGrantRevocation(handler) { onRevocation = handler; }
const maxSessions = 100;
const scopeError = () => new ApiError('MCP_PERMISSION_DENIED','This client lacks permission for the requested operation',403);

function db(run) {
  mkdirSync(path.dirname(settingsFile),{recursive:true,mode:0o700});
  const connection = new DatabaseSync(settingsFile,{timeout:5000});
  try {
    connection.exec('CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT NOT NULL, scopes TEXT NOT NULL, disabled INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS mcp_audit (time TEXT NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL, result TEXT NOT NULL, origin TEXT, batch TEXT);' +
      'CREATE TABLE IF NOT EXISTS mcp_audit_options (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, days INTEGER NOT NULL)');
    return run(connection);
  } finally { connection.close(); }
}

function clientRecord(row) {
  return row && {...row,scopes:JSON.parse(row.scopes),disabled:Boolean(row.disabled)};
}

export function listClients() {
  return {items:db(connection => connection.prepare('SELECT * FROM mcp_clients ORDER BY name,id').all().map(clientRecord))};
}

export function saveClient({id,name,preset,scopes:custom,disabled} = {}) {
  return db(connection => {
    const existing = id === undefined ? null : clientRecord(connection.prepare('SELECT * FROM mcp_clients WHERE id=?').get(assertId(id)));
    if (id !== undefined && !existing) throw new ApiError('MCP_CLIENT_NOT_FOUND','Client not found',404);
    if (!existing && connection.prepare('SELECT count(*) AS n FROM mcp_clients').get().n >= 50) {
      throw new ApiError('MCP_CLIENT_LIMIT','At most 50 MCP clients can be registered',409);
    }
    name = name ?? existing?.name;
    preset = preset ?? existing?.preset;
    disabled = disabled ?? existing?.disabled ?? false;
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\x00-\x1f\x7f]/.test(name) ||
        !roles.includes(preset) || typeof disabled !== 'boolean') {
      throw new ApiError('MCP_INVALID_CLIENT','A valid name and permission preset are required');
    }
    const granted = preset === 'custom' ? custom ?? existing?.scopes : presets[preset];
    if (!Array.isArray(granted) || granted.length > scopes.length || granted.some(value => !scopes.includes(value))) {
      throw new ApiError('MCP_INVALID_CLIENT','Invalid custom permissions');
    }
    id ??= randomUUID();
    const record = {id,name:name.trim(),preset,scopes:[...new Set(granted)],disabled};
    connection.prepare('INSERT OR REPLACE INTO mcp_clients VALUES (?,?,?,?,?)')
      .run(id,record.name,preset,JSON.stringify(record.scopes),Number(disabled));
    if (disabled || !record.scopes.includes('session') || existing?.scopes.includes('download') && !record.scopes.includes('download')) {
      for (const grant of sessions.values()) if (grant.clientId === id) revoke(grant);
    }
    return record;
  });
}

export function boundClientToken(pairing, id) {
  if (!uuid.test(id ?? '')) return '';
  const mac = createHmac('sha256',pairing).update('VideoSave MCP client v1\0' + id).digest('base64url');
  return 'mcp.' + id + '.' + mac;
}

export function authenticateClient(authorization, pairing) {
  const match = /^Bearer (mcp\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
  if (!match || !uuid.test(match[2])) return;
  const expected = boundClientToken(pairing,match[2]);
  if (!timingSafeEqual(Buffer.from(expected),Buffer.from(match[1]))) return;
  const client = db(connection => clientRecord(connection.prepare('SELECT * FROM mcp_clients WHERE id=?').get(match[2])));
  return client?.disabled === false ? client : undefined;
}

export function requireScope(client, scope) {
  if (!client.scopes.includes(scope)) throw scopeError();
}

function assertId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new ApiError('MCP_INVALID_ID','Invalid identifier');
  return id;
}

export function siteOrigin(value) {
  const parsed = typeof value === 'string' && value.length <= 2048 ? URL.parse(value) : null;
  if (!parsed || !['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError('MCP_INVALID_ORIGIN','An HTTP(S) origin is required');
  }
  return parsed.origin;
}

function publicGrant({id,clientId,clientName,origin,status,expiresAt}) {
  return {id,clientId,clientName,origin,status,expiresAt:new Date(expiresAt).toISOString()};
}

function sweep(now = Date.now()) {
  for (const [id,grant] of sessions) {
    if (grant.expiresAt <= now) {
      if (grant.status === 'approved') onRevocation(id);
      grant.tab = null;
      if (grant.status !== 'revoked') grant.status = 'expired';
      if (grant.expiresAt + 600_000 <= now) sessions.delete(id);
    }
  }
}

export function requestGrant(client, value) {
  const origin = siteOrigin(value);
  sweep();
  const pending = [...sessions.values()].find(grant => grant.clientId === client.id && grant.origin === origin && grant.status === 'pending');
  if (pending) return publicGrant(pending);
  if (sessions.size >= maxSessions || [...sessions.values()].filter(grant => grant.clientId === client.id && grant.status === 'pending').length >= 5) {
    throw new ApiError('MCP_AUTHORIZATION_LIMIT','Too many authorization requests',429);
  }
  const grant = {id:randomUUID(),clientId:client.id,clientName:client.name,origin,status:'pending',expiresAt:Date.now()+300_000};
  sessions.set(grant.id,grant);
  return publicGrant(grant);
}

function getGrant(id, client) {
  sweep();
  const grant = sessions.get(assertId(id));
  if (!grant || client && client.id !== grant.clientId) throw new ApiError('MCP_AUTHORIZATION_NOT_FOUND','Site authorization not found',404);
  return grant;
}

export function grantStatus(id, client) {
  return publicGrant(getGrant(id,client));
}

export function listGrants(client) {
  sweep();
  return {items:[...sessions.values()].filter(grant => !client || grant.clientId === client.id).reverse().map(publicGrant)};
}

export function approveGrant({id,tab,minutes = 5} = {}) {
  const grant = getGrant(id);
  if (grant.status !== 'pending') throw new ApiError('MCP_AUTHORIZATION_INACTIVE','Request is no longer pending',409);
  const valid = tab && tab.restricted !== true && Array.isArray(tab.streams) && tab.streams.length <= 40;
  if (!valid || siteOrigin(tab.url) !== grant.origin || ![1,5,15].includes(minutes)) {
    throw new ApiError('MCP_INVALID_TAB','Open the requested site and select an allowed authorization duration');
  }
  const streams = new Map();
  for (const item of tab.streams) {
    const url = typeof item?.url === 'string' && item.url.length <= 2048 ? URL.parse(item.url) : null;
    if (!url || url.origin !== grant.origin || url.search || url.hash || !mediaKinds.has(item.kind) ||
        url.username || url.password || item.restricted || item.drm) continue;
    streams.set(url.href,{candidateId:randomUUID(),url:url.href,kind:item.kind,
      ...(Number.isFinite(item.duration) && item.duration > 0 && {duration:item.duration}),
      ...(Number.isInteger(item.height) && item.height > 0 && {height:item.height})});
  }
  for (const previous of sessions.values()) if (previous.clientId === grant.clientId && previous.status === 'approved') revoke(previous);
  grant.tab = {origin:grant.origin,title:typeof tab.title === 'string' ? tab.title.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160) : '',
    playing:tab.playing === true,streams:[...streams.values()]};
  grant.status = 'approved';
  grant.expiresAt = Date.now() + minutes * 60_000;
  return publicGrant(grant);
}

const sessionTimer = setInterval(sweep,1000);
sessionTimer.unref();

function revoke(grant) {
  if (grant.status === 'approved') onRevocation(grant.id);
  grant.status = 'revoked';
  grant.expiresAt = Date.now();
  grant.tab = null;
}

export function revokeGrant(id) {
  const grant = getGrant(id);
  revoke(grant);
  return publicGrant(grant);
}

export function activeTab(client, id) {
  sweep();
  const grant = id ? getGrant(id,client) : [...sessions.values()].find(grant => grant.clientId === client.id && grant.status === 'approved');
  if (!grant?.tab) throw new ApiError('MCP_TAB_REQUIRED','Approve a current tab in VideoSave to use its media context',409);
  const {streams,...tab} = grant.tab;
  return {authorizationId:grant.id,tab,streams};
}

export function auditSettings(update) {
  return db(connection => {
    if (update) {
      const {enabled,days} = update;
      if (typeof enabled !== 'boolean' || ![1,7,30,90].includes(days)) throw new ApiError('MCP_INVALID_AUDIT','Invalid activity retention');
      connection.prepare('INSERT OR REPLACE INTO mcp_audit_options VALUES (1,?,?)').run(Number(enabled),days);
    }
    const value = connection.prepare('SELECT enabled,days FROM mcp_audit_options WHERE id=1').get() ?? {enabled:1,days:7};
    connection.prepare("DELETE FROM mcp_audit WHERE time < ?").run(new Date(Date.now()-value.days*86400_000).toISOString());
    return {enabled:Boolean(value.enabled),days:value.days};
  });
}

export function recordActivity({client,tool,result,origin,batch}) {
  if (!auditSettings().enabled) return;
  db(connection => {
    connection.prepare('INSERT INTO mcp_audit VALUES (?,?,?,?,?,?)').run(new Date().toISOString(),client,tool,result,origin ?? null,batch ?? null);
    connection.exec('DELETE FROM mcp_audit WHERE rowid NOT IN (SELECT rowid FROM mcp_audit ORDER BY rowid DESC LIMIT 1000)');
  });
}

export function activity(clear = false) {
  const settings = auditSettings();
  const items = db(connection => {
    if (clear) connection.exec('DELETE FROM mcp_audit');
    return connection.prepare('SELECT time,client,tool,result,origin,batch FROM mcp_audit ORDER BY rowid DESC LIMIT 200').all();
  });
  return {settings,items};
}


const siteDefaults = Object.freeze({probe:true,download:false,quality:1080,format:'mp4',audioFormat:'m4a',
  subtitles:false,connections:8,concurrency:1});
export const preferenceProperties = {
  probe:{type:'boolean'},download:{type:'boolean'},quality:{type:'integer',minimum:144,maximum:4320},
  format:{enum:['mp4','mkv']},audioFormat:{enum:['m4a','mp3']},subtitles:{type:'boolean'},
  connections:{enum:[4,8,12]},concurrency:{type:'integer',minimum:1,maximum:2}
};

export function sitePreferences(value, settings) {
  const origin = siteOrigin(value);
  return db(connection => {
    connection.exec('CREATE TABLE IF NOT EXISTS mcp_site_policies (origin TEXT PRIMARY KEY, policy TEXT NOT NULL)');
    if (settings !== undefined) {
      verifyInput({type:'object',properties:preferenceProperties,additionalProperties:false},settings);
      const count = connection.prepare('SELECT count(*) AS n FROM mcp_site_policies').get().n;
      if (count >= 100 && !connection.prepare('SELECT 1 FROM mcp_site_policies WHERE origin=?').get(origin)) {
        throw new ApiError('MCP_SITE_LIMIT','At most 100 site policies can be stored',409);
      }
      connection.prepare('INSERT OR REPLACE INTO mcp_site_policies VALUES (?,?)').run(origin,JSON.stringify(settings));
      if (settings.probe === false || settings.download === false) {
        for (const grant of sessions.values()) if (grant.origin === origin && grant.status === 'approved') revoke(grant);
      }
    }
    const stored = connection.prepare('SELECT policy FROM mcp_site_policies WHERE origin=?').get(origin);
    return {origin,settings:{...siteDefaults,...(stored && JSON.parse(stored.policy))}};
  });
}

export function verifyInput(schema,value) {
  const invalid = () => { throw new ApiError('MCP_INVALID_ARGUMENTS','Arguments do not match the tool schema'); };
  if (schema.enum && !schema.enum.includes(value)) invalid();
  switch (schema.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
      if (schema.required?.some(key => !Object.hasOwn(value,key))) invalid();
      for (const [key,entry] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties,key)) invalid();
        verifyInput(schema.properties[key],entry);
      }
      break;
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 2048)) invalid();
      break;
    case 'integer':
      if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) invalid();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') invalid();
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) invalid();
      for (const item of value) verifyInput(schema.items,item);
      break;
  }
}
