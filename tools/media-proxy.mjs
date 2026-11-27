import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { connect, isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from './media-source.mjs';
import { settingsFile } from './preferences.mjs';

const defaultConfiguration = Object.freeze({mode:'environment'});
const loopback = ['localhost','127.0.0.1','[::1]'];
const mediaLoopback = [...loopback,'::1'];
const proxyEnvironmentKey = /^(?:https?_proxy|all_proxy|no_proxy)$/i;
const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
let effective = defaultConfiguration;
let effectiveProxies = [];
let installed = false;
let environmentStatus = 'not-configured';

function invalidSettings() {
  return new ApiError('INVALID_NETWORK_SETTINGS',
    'Choose environment, direct, or an HTTP proxy without credentials. Bypass entries must be hostnames, IP addresses, or *.');
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['mode','proxyUrl','noProxy'].includes(key)) ||
      ['proxyUrl','noProxy'].some(name => Object.hasOwn(value,name) && typeof value[name] !== 'string') ||
      !['environment','direct','http'].includes(value.mode)) throw invalidSettings();
  if (value.mode === 'direct' && (value.proxyUrl || value.noProxy)) throw invalidSettings();
  if (value.mode === 'direct') return {mode:'direct'};
  if (value.mode === 'environment' && value.proxyUrl) throw invalidSettings();

  const bypass = value.noProxy ?? '';
  if (typeof bypass !== 'string' || bypass.length > 2048 || /[\x00-\x1f\x7f]/.test(bypass)) throw invalidSettings();
  const entries = [...new Set(bypass.toLowerCase().split(',').map(entry => entry.trim()).filter(Boolean))];
  if (entries.length > 40 || entries.includes('*') && entries.length !== 1 || entries.some(entry => {
    if (entry === '*') return false;
    if (entry.startsWith('[') && entry.endsWith(']')) return isIP(entry.slice(1,-1)) !== 6;
    return !hostnamePattern.test(entry.replace(/^\./,''));
  })) throw invalidSettings();
  const noProxy = entries.join(',');
  if (value.mode === 'environment') return {mode:'environment',...(noProxy && {noProxy})};

  const address = value.proxyUrl;
  if (typeof address !== 'string' || address.length > 512 ||
      !/^http:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d{1,5})?\/?$/i.test(address)) throw invalidSettings();
  const proxy = URL.parse(address);
  if (!proxy || proxy.port === '0' ||
      !hostnamePattern.test(proxy.hostname) && !(proxy.hostname.startsWith('[') && isIP(proxy.hostname.slice(1,-1)) === 6)) {
    throw invalidSettings();
  }
  return {mode:'http',proxyUrl:proxy.origin,...(noProxy && {noProxy})};
}

function storedSettings(update) {
  if (update === undefined && !existsSync(settingsFile)) return defaultConfiguration;
  if (update !== undefined) mkdirSync(path.dirname(settingsFile),{recursive:true,mode:0o700});
  const db = new DatabaseSync(settingsFile,{timeout:5000});
  try {
    if (update !== undefined) {
      db.exec('CREATE TABLE IF NOT EXISTS network_preferences (id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL)');
      db.prepare('INSERT OR REPLACE INTO network_preferences VALUES (1,?)').run(JSON.stringify(update));
      return update;
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='network_preferences'").get()) return defaultConfiguration;
    const row = db.prepare('SELECT settings FROM network_preferences WHERE id=1').get();
    return row ? validateSettings(JSON.parse(row.settings)) : defaultConfiguration;
  } finally {
    db.close();
  }
}

function environment() {
  return {
    http_proxy:process.env.http_proxy ?? process.env.HTTP_PROXY,
    https_proxy:process.env.https_proxy ?? process.env.HTTPS_PROXY,
    no_proxy:process.env.no_proxy ?? process.env.NO_PROXY,
  };
}

function bypassList(value, local = loopback) {
  const entries = (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  return entries.includes('*') ? '*' : [...new Set([...entries,...local])].join(',');
}

export function configureMediaProxy() {
  if (installed) return;
  const configuration = storedSettings();
  const env = environment();
  effective = configuration;
  installed = true;
  if (!http.setGlobalProxyFromEnv) {
    environmentStatus = 'runtime-unsupported';
    return;
  }
  if (configuration.mode === 'direct') {
    // The native API cannot replace a proxy already enabled by Node startup without proxy endpoints.
    // A wildcard bypass makes both native HTTP agents and fetch connect directly.
    const unusedEndpoint = 'http://127.0.0.1:1';
    http.setGlobalProxyFromEnv({http_proxy:unusedEndpoint,https_proxy:unusedEndpoint,no_proxy:'*'});
    return;
  }
  if (configuration.mode === 'http') {
    http.setGlobalProxyFromEnv({http_proxy:configuration.proxyUrl,https_proxy:configuration.proxyUrl,
      no_proxy:bypassList(configuration.noProxy)});
    effectiveProxies = [new URL(configuration.proxyUrl)];
    return;
  }
  if (process.env.NODE_USE_ENV_PROXY === '0') {
    environmentStatus = 'disabled-by-environment';
    return;
  }
  if (!env.http_proxy && !env.https_proxy) return;
  try {
    http.setGlobalProxyFromEnv({...env,no_proxy:bypassList(configuration.noProxy ?? env.no_proxy)});
    effectiveProxies = [...new Set([env.http_proxy,env.https_proxy].filter(Boolean))].map(value => new URL(value));
    environmentStatus = 'configured';
  } catch (error) {
    if (error.code !== 'ERR_PROXY_INVALID_CONFIG' && error.code !== 'UND_ERR_INVALID_ARG') throw error;
    environmentStatus = 'invalid-environment';
    console.error('VideoSave ignored invalid proxy settings. Check HTTP_PROXY and HTTPS_PROXY.');
  }
}

export function networkPreferences(update) {
  const configured = storedSettings(update === undefined ? undefined : validateSettings(update));
  return {
    configured,
    effective:{...effective,...(effective.mode === 'environment' && {environmentStatus})},
    restartRequired:JSON.stringify(configured) !== JSON.stringify(effective),
    engines:{
      node:effective.mode === 'environment' ? 'environment' : effective.mode,
      browser:effective.mode === 'environment' ? 'system' : effective.mode,
      ffmpeg:effective.mode === 'environment' ? 'environment-http' : effective.mode,
      extension:'browser',
    },
  };
}

export async function diagnoseNetwork() {
  const current = networkPreferences();
  let connection = effective.mode === 'direct' ? 'direct' : environmentStatus;
  if (effectiveProxies.length) {
    const reachable = await Promise.all(effectiveProxies.map(proxy => new Promise(resolve => {
      const socket = connect({host:proxy.hostname.replace(/^\[|\]$/g,''),port:Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)});
      const timer = setTimeout(() => finish(false),1500);
      function finish(ok) { clearTimeout(timer); socket.destroy(); resolve(ok); }
      socket.once('connect',() => finish(true));
      socket.once('error',() => finish(false));
    })));
    connection = reachable.every(Boolean) ? 'proxy-reachable' : reachable.some(Boolean) ? 'proxy-partial' : 'proxy-unreachable';
  }
  return {...current,connection};
}

export function browserProxyArgs() {
  if (effective.mode === 'environment') return [];
  if (effective.mode === 'direct') return ['--no-proxy-server'];
  return [
    '--proxy-server=' + effective.proxyUrl,
    '--proxy-bypass-list=' + bypassList(effective.noProxy).split(',').join(';'),
  ];
}

export function mediaProcessEnvironment() {
  if (effective.mode === 'environment') {
    const inherited = environment();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^no_proxy$/i.test(name)));
    return {...env,no_proxy:bypassList(effective.noProxy ?? inherited.no_proxy,mediaLoopback)};
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !proxyEnvironmentKey.test(name)));
  if (effective.mode === 'direct') return env;
  return {...env,http_proxy:effective.proxyUrl,https_proxy:effective.proxyUrl,no_proxy:bypassList(effective.noProxy,mediaLoopback)};
}
