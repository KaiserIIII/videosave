import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaults, downloadFolder, interfaceLanguages, maxConcurrency } from '../extension/settings.mjs';
import { ApiError } from './media-source.mjs';

const choice = (...values) => ({enum:values});
const integer = (minimum, maximum) => ({type:'integer', minimum, maximum});
const bool = {type:'boolean'};
const transfer = {
  mode:choice('combined','video','audio','separate'), audioFormat:choice('m4a','mp3'),
  subtitles:bool, fastStart:bool, connections:choice(4,8,12), concurrency:integer(1,maxConcurrency),
};
const profiles = {
  download:{...transfer, outDir:{type:'string', minLength:1, description:'Absolute local directory'},
    quality:integer(144,4320), format:choice('mp4','mkv')},
  browser:{...transfer, quality:choice('', '240','360','480','720','1080','1440','2160','4320'),
    format:choice('auto','mp4','mkv'), downloadFolder:{type:'string',maxLength:100},
    accelerate:bool, saveAs:bool, naming:choice('title','source'),
    conflictAction:choice('uniquify','prompt'), theme:choice('system','light','dark','jade','amber'),
    accent:{type:'string',pattern:'^(?:#[0-9a-fA-F]{6})?$'}, density:choice('comfortable','compact'),
    language:choice(...interfaceLanguages),
    autoScan:bool, showHost:bool, showSize:bool, sizeLookup:bool, showThumbnails:bool,
    preview:choice('click','hover','off'), previewSeconds:choice(3,6,10), startPanel:choice('videos','downloads')},
};

export const settingsScope = choice('download','browser');
export const settingsPatchSchema = {anyOf:Object.values(profiles).map(fields => ({type:'object',
  additionalProperties:false, properties:Object.fromEntries(Object.entries(fields)
    .map(([key, schema]) => [key, {anyOf:[schema, {type:'null'}]}]))}))};

const stateDirectory = () => process.env.LOCALAPPDATA || path.join(os.homedir(), '.config');
const realUserStateDir = () => path.resolve(path.join(stateDirectory(), 'VideoSave'));
const realUserSettingsFile = () => path.resolve(path.join(realUserStateDir(), 'settings.sqlite'));

/**
 * Resolve symlinks and Windows directory junctions through the deepest existing
 * ancestor so symlink/junction escapes inside a sandbox are caught BEFORE writing.
 */
export function resolveThroughSymlinks(targetPath) {
  const absolute = path.resolve(targetPath);
  const trailing = [];
  let cursor = absolute;
  while (true) {
    if (existsSync(cursor)) {
      try {
        const real = realpathSync(cursor);
        return trailing.length ? path.join(real, ...trailing.reverse()) : real;
      } catch {
        return absolute;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    trailing.push(path.basename(cursor));
    cursor = parent;
  }
}

function isPathInside(parent, child) {
  const normParent = path.resolve(parent);
  const normChild = path.resolve(child);
  const a = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
  const b = process.platform === 'win32' ? normChild.toLowerCase() : normChild;
  if (a === b) return true;
  const rel = path.relative(a, b);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isRealPathInside(parent, child) {
  const realParent = resolveThroughSymlinks(parent);
  const realChild = resolveThroughSymlinks(child);
  return isPathInside(parent, child) && isPathInside(realParent, realChild);
}

export function isSandboxActive() {
  return Boolean(
    process.env.VIDEOSAVE_TEST_SANDBOX ||
    process.env.VIDEOSAVE_NO_USER_SETTINGS === '1' ||
    process.env.VIDEOSAVE_SANDBOX_MODE === '1',
  );
}

/**
 * Enable forced sandbox mode when --sandbox[=DIR] or VIDEOSAVE_SANDBOX_MODE=1 is set.
 * Overrides OUT_DIR, MEDIA_TOOLKIT_SETTINGS, VIDEOSAVE_PROFILES_DIR, and VIDEOSAVE_TOOLS_DIR
 * into a temporary isolated directory and forbids reading user settings.sqlite.
 */
export function configureSandboxFromArgv(argv = process.argv) {
  let enabled = process.env.VIDEOSAVE_SANDBOX_MODE === '1';
  let explicitDir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sandbox') {
      enabled = true;
    } else if (arg.startsWith('--sandbox=')) {
      enabled = true;
      explicitDir = arg.slice('--sandbox='.length).trim() || null;
    } else if (arg === '--sandbox-dir' && argv[i + 1]) {
      enabled = true;
      explicitDir = argv[++i].trim() || null;
    } else if (arg.startsWith('--sandbox-dir=')) {
      enabled = true;
      explicitDir = arg.slice('--sandbox-dir='.length).trim() || null;
    }
  }
  if (!enabled) {
    if (process.env.VIDEOSAVE_TEST_SANDBOX) {
      process.env.VIDEOSAVE_NO_USER_SETTINGS = '1';
      return {
        active: true,
        sandboxRoot: path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX),
        outDir: process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX), 'downloads'),
        settingsFile: process.env.MEDIA_TOOLKIT_SETTINGS ? path.resolve(process.env.MEDIA_TOOLKIT_SETTINGS) : path.join(path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX), 'settings.sqlite'),
      };
    }
    return { active: false };
  }
  const sandboxRoot = explicitDir
    ? path.resolve(explicitDir)
    : process.env.VIDEOSAVE_TEST_SANDBOX
      ? path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX)
      : mkdtempSync(path.join(os.tmpdir(), 'videosave-sandbox-'));
  const downloadsDir = path.join(sandboxRoot, 'downloads');
  const profilesDir = path.join(sandboxRoot, 'profiles');
  const toolsDir = path.join(sandboxRoot, 'tools');
  const dbFile = path.join(sandboxRoot, 'settings.sqlite');
  mkdirSync(downloadsDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  process.env.VIDEOSAVE_TEST_SANDBOX = sandboxRoot;
  process.env.VIDEOSAVE_NO_USER_SETTINGS = '1';
  process.env.VIDEOSAVE_SANDBOX_MODE = '1';
  if (!process.env.OUT_DIR || !isPathInside(sandboxRoot, process.env.OUT_DIR)) {
    process.env.OUT_DIR = downloadsDir;
  }
  if (!process.env.MEDIA_TOOLKIT_SETTINGS || !isPathInside(sandboxRoot, process.env.MEDIA_TOOLKIT_SETTINGS)) {
    process.env.MEDIA_TOOLKIT_SETTINGS = dbFile;
  }
  if (!process.env.VIDEOSAVE_PROFILES_DIR || !isPathInside(sandboxRoot, process.env.VIDEOSAVE_PROFILES_DIR)) {
    process.env.VIDEOSAVE_PROFILES_DIR = profilesDir;
  }
  if (!process.env.VIDEOSAVE_TOOLS_DIR || !isPathInside(sandboxRoot, process.env.VIDEOSAVE_TOOLS_DIR)) {
    process.env.VIDEOSAVE_TOOLS_DIR = toolsDir;
  }
  if (process.env.VIDEOSAVE_SANDBOX_ALLOW_COMPANION !== '1') {
    delete process.env.MEDIA_TOOLKIT_URL;
    delete process.env.MEDIA_TOOLKIT_LOCAL_PAIRING;
    delete process.env.MEDIA_TOOLKIT_MCP_CLIENT;
  }
  return {
    active: true,
    sandboxRoot,
    outDir: path.resolve(process.env.OUT_DIR),
    settingsFile: path.resolve(process.env.MEDIA_TOOLKIT_SETTINGS),
  };
}

export function assertSandboxPath(targetPath, label = 'path') {
  const sandbox = process.env.VIDEOSAVE_TEST_SANDBOX;
  const raw = String(targetPath ?? '');
  if (sandbox && (raw.startsWith('\\\\') || raw.startsWith('//'))) {
    throw new ApiError(
      'TEST_SANDBOX_VIOLATION',
      `Refusing UNC/network ${label} while active test sandbox is enforced`,
      403,
    );
  }
  const resolved = path.resolve(raw);
  const realResolved = resolveThroughSymlinks(resolved);
  if (process.env.VIDEOSAVE_NO_USER_SETTINGS === '1') {
    const userState = realUserStateDir();
    if (isRealPathInside(userState, resolved) || isPathInside(userState, realResolved)) {
      throw new ApiError(
        'TEST_SANDBOX_VIOLATION',
        `Refusing to access real user VideoSave state directory (${label}) while sandbox/no-user-settings mode is active`,
        403,
      );
    }
  }
  if (!sandbox) return resolved;
  // Only ephemeral 'temp' paths may use os.tmpdir(); all output/settings/profile writes MUST stay strictly inside sandbox!
  const allowedRoots = label === 'temp' ? [sandbox, os.tmpdir()] : [sandbox];
  if (!allowedRoots.some(root => isRealPathInside(root, resolved))) {
    throw new ApiError(
      'TEST_SANDBOX_VIOLATION',
      `Refusing to access ${label} outside the active test sandbox (resolved=${realResolved})`,
      403,
    );
  }
  return resolved;
}

export function getSettingsFile() {
  if (isSandboxActive() && !process.env.MEDIA_TOOLKIT_SETTINGS) {
    if (process.env.VIDEOSAVE_TEST_SANDBOX) {
      return assertSandboxPath(path.join(path.resolve(process.env.VIDEOSAVE_TEST_SANDBOX), 'settings.sqlite'), 'settings database');
    }
    throw new ApiError('TEST_SANDBOX_VIOLATION', 'Refusing to fall back to user settings.sqlite while sandbox mode is active', 403);
  }
  const target = path.resolve(process.env.MEDIA_TOOLKIT_SETTINGS || realUserSettingsFile());
  return assertSandboxPath(target, 'settings database');
}

export const settingsFile = path.resolve(process.env.MEDIA_TOOLKIT_SETTINGS || realUserSettingsFile());

function withDatabase(run) {
  const file = getSettingsFile();
  mkdirSync(path.dirname(file), {recursive:true});
  const connection = new DatabaseSync(file, {timeout:5000});
  try {
    connection.exec(`CREATE TABLE IF NOT EXISTS preferences (
      scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope,name)
    )`);
    return run(connection);
  } finally { connection.close(); }
}

function fieldsFor(scope) {
  if (typeof scope !== 'string' || !Object.hasOwn(profiles, scope)) throw new ApiError('INVALID_SETTINGS', 'Unknown settings scope');
  return profiles[scope];
}

export function localPairingCode({create = false} = {}) {
  const file = getSettingsFile();
  if (!create && !existsSync(file)) return;
  return withDatabase(connection => {
    if (create) {
      connection.exec('CREATE TABLE IF NOT EXISTS companion_pairing (id INTEGER PRIMARY KEY CHECK(id=1), code TEXT NOT NULL)');
      connection.prepare('INSERT OR IGNORE INTO companion_pairing VALUES (1,?)').run(randomBytes(24).toString('base64url'));
    } else if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_pairing'").get()) return;
    return connection.prepare('SELECT code FROM companion_pairing WHERE id=1').get()?.code;
  });
}

function localDirectory(value) {
  if (value !== value.trim() || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value) ||
      process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)) {
    throw new ApiError('INVALID_SETTINGS', 'outDir must be an absolute local directory');
  }
  const directory = path.resolve(value);
  const root = path.parse(directory).root;
  if (directory === root) throw new ApiError('INVALID_SETTINGS', 'outDir must be a directory below the filesystem root');
  if (process.platform === 'win32') {
    try { downloadFolder(directory.slice(root.length), 4096); }
    catch { throw new ApiError('INVALID_SETTINGS', 'outDir contains an invalid directory name'); }
  }
  return directory;
}

function validate(name, value, rule) {
  const valid = rule.enum ? rule.enum.includes(value) : rule.type === 'integer'
    ? Number.isInteger(value) && value >= rule.minimum && value <= rule.maximum
    : rule.type === 'boolean' ? typeof value === 'boolean'
    : typeof value === 'string' && value.length >= (rule.minLength ?? 0) &&
      value.length <= (rule.maxLength ?? 4096) && (!rule.pattern || new RegExp(rule.pattern).test(value));
  if (!valid) throw new ApiError('INVALID_SETTINGS', `Invalid value for ${name}`);
  if (name === 'outDir') return assertSandboxPath(localDirectory(value), 'download output directory');
  if (name === 'downloadFolder') {
    try { return downloadFolder(value); }
    catch { throw new ApiError('INVALID_SETTINGS', 'downloadFolder must be relative to the browser download directory'); }
  }
  return value;
}

function read(connection, scope, fields) {
  return Object.fromEntries(connection.prepare('SELECT name,value FROM preferences WHERE scope=? ORDER BY name').all(scope)
    .filter(({name}) => Object.hasOwn(fields,name)).map(({name,value}) => [name, JSON.parse(value)]));
}

export function readPreferences(scope) {
  const fields = fieldsFor(scope);
  return existsSync(getSettingsFile()) ? withDatabase(connection => read(connection, scope, fields)) : {};
}

export function writePreferences(scope, patch) {
  const fields = fieldsFor(scope);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new ApiError('INVALID_SETTINGS', 'settings must contain at least one field');
  }
  const changes = Object.entries(patch).map(([name, value]) => {
    if (!Object.hasOwn(fields,name)) throw new ApiError('INVALID_SETTINGS', `Unknown setting ${name}`);
    return [name, value === null ? (scope === 'browser' ? defaults[name] : null) : validate(name,value,fields[name])];
  });
  return withDatabase(connection => {
    const remove = connection.prepare('DELETE FROM preferences WHERE scope=? AND name=?');
    const set = connection.prepare('INSERT INTO preferences VALUES (?,?,?) ON CONFLICT(scope,name) DO UPDATE SET value=excluded.value');
    connection.exec('BEGIN IMMEDIATE');
    try {
      for (const [name,value] of changes) {
        if (value === null) remove.run(scope,name);
        else set.run(scope,name,JSON.stringify(value));
      }
      const settings = read(connection, scope, fields);
      connection.exec('COMMIT');
      return settings;
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  });
}
