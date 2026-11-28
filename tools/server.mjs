#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { access, constants as fsConstants, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as downloads from './media-downloads.mjs';
import { configureMediaProxy, diagnoseNetwork, networkPreferences } from './media-proxy.mjs';
import { configureSandboxFromArgv, isSandboxActive, localPairingCode } from './preferences.mjs';
import { activity, approveGrant, auditSettings, authenticateClient, clientAccess, listClients, listGrants, renewGrant, revokeGrant,
  saveClient, sitePreferences, updateClientAccess, updateGrantSnapshot } from './mcp-control.mjs';
import { invokeManaged, managedTools } from './managed-mcp.mjs';
import { compatibilityRules } from './compatibility-policy.mjs';
import { SUPPORTED_MCP_CLIENTS, detectMcpClients, generateMcpClientConfig } from './mcp-config-generator.mjs';
import { checkForUpdates, getUpdateHistory } from './updater.mjs';

const execFileAsync = promisify(execFile);

configureSandboxFromArgv(process.argv);
configureMediaProxy();
const { ApiError, VERSION } = downloads;
const port = Number(process.env.PORT ?? 8765);
const pairingCode = process.env.MEDIA_TOOLKIT_TOKEN || (process.env.MEDIA_TOOLKIT_LOCAL_PAIRING === '1'
  ? localPairingCode({create:true}) : randomBytes(24).toString('base64url'));
const expected = Buffer.from('Bearer ' + pairingCode);
const expectedRaw = Buffer.from(pairingCode);
const maxBody = 1024 * 1024;
const consoleDir = fileURLToPath(new URL('./console', import.meta.url));
const logoFile = fileURLToPath(new URL('../docs/logo.svg', import.meta.url));
const consoleCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function safeCompare(actualText, targetBuf) {
  const actual = Buffer.from(String(actualText ?? ''));
  return actual.length === targetBuf.length && timingSafeEqual(actual, targetBuf);
}

function cookieValue(request, name) {
  const raw = request.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
}

function authorized(request) {
  if (safeCompare(request.headers.authorization ?? '', expected)) return true;
  const sessionCookie = cookieValue(request, 'videosave_console');
  if (!sessionCookie || !safeCompare(sessionCookie, expectedRaw)) return false;
  // Require strict same-origin context when authenticating via console cookie.
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) return false;
  return true;
}

const consoleAssets = new Map([
  ['/console', { file: path.join(consoleDir, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/console/', { file: path.join(consoleDir, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/console/styles.css', { file: path.join(consoleDir, 'styles.css'), type: 'text/css; charset=utf-8' }],
  ['/console/app.js', { file: path.join(consoleDir, 'app.js'), type: 'application/javascript; charset=utf-8' }],
  ['/console/logo.svg', { file: logoFile, type: 'image/svg+xml; charset=utf-8' }],
]);

function serveConsoleAsset(res, pathname) {
  const asset = consoleAssets.get(pathname);
  if (!asset) return false;
  try {
    const data = readFileSync(asset.file);
    res.writeHead(200, {
      'content-type': asset.type,
      'content-length': data.byteLength,
      'cache-control': 'no-store',
      'content-security-policy': consoleCsp,
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function reply(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function body(req) {
  if (!/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError('INVALID_CONTENT_TYPE', '请求应使用 application/json', 415);
  }
  const tooLarge = () => new ApiError('BODY_TOO_LARGE', '请求超过 1 MiB', 413);
  if (Number(req.headers['content-length']) > maxBody) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) throw tooLarge();
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError('INVALID_JSON', '请求正文应为 JSON 对象');
  }
  return data;
}

function sendFile(req, res, {file, name, size}) {
  const bytes = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = bytes ? Number(bytes[1]) : 0;
  const end = bytes?.[2] ? Math.min(size - 1, Number(bytes[2])) : size - 1;
  if (req.headers.range && (!bytes || start > end)) {
    res.writeHead(416, {'content-range': 'bytes */' + size});
    return res.end();
  }
  const types = {mp4:'video/mp4', mkv:'video/x-matroska', m4a:'audio/mp4', mp3:'audio/mpeg'};
  res.writeHead(bytes ? 206 : 200, {
    'content-type': types[name.split('.').at(-1)] || 'application/octet-stream',
    'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/[!'()*]/g,
      char => '%' + char.charCodeAt(0).toString(16).toUpperCase()),
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    ...(bytes && {'content-range': `bytes ${start}-${end}/${size}`}),
  });
  pipeline(createReadStream(file, {start, end}), res, () => {});
}

function responseSignal(res) {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

const server = http.createServer({headersTimeout:10_000,requestTimeout:30_000}, async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  try {
    const localPort = req.socket.localPort;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    if (localPort === 80) hosts.push('127.0.0.1', 'localhost');
    if (!hosts.includes(req.headers.host)) throw new ApiError('FORBIDDEN_HOST', '仅接受本机地址', 403);
    const origin = req.headers.origin || '';
    const isExtensionOrigin = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(origin);
    const isSameLoopbackOrigin = Boolean(origin && origin === `http://${req.headers.host}`);
    if (origin && !isExtensionOrigin && !isSameLoopbackOrigin) {
      throw new ApiError('FORBIDDEN_ORIGIN', '仅接受浏览器扩展或本机工具', 403);
    }
    if (isExtensionOrigin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('access-control-allow-private-network', 'true');
      }
    }
    if (isExtensionOrigin && req.method === 'OPTIONS') {
      res.writeHead(204, {'access-control-allow-methods':'GET, POST', 'access-control-allow-headers':'authorization, content-type'});
      return res.end();
    }
    if (!/^\/(?![\/\\])/.test(req.url) || req.url.includes('\\')) {
      throw new ApiError('INVALID_REQUEST_TARGET', '仅接受本机接口路径');
    }
    const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(302, { location: '/console', 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && consoleAssets.has(pathname)) {
      if (serveConsoleAsset(res, pathname)) return;
    }
    const route = req.method + ' ' + pathname;
    if (route === 'POST /api/console/auth') {
      const payload = await body(req);
      if (!safeCompare(payload.pairingCode ?? '', expectedRaw)) {
        throw new ApiError('UNAUTHORIZED', '配对码无效', 401);
      }
      res.setHeader('set-cookie', `videosave_console=${pairingCode}; HttpOnly; SameSite=Strict; Path=/`);
      return reply(res, 200, { ok: true, version: VERSION });
    }
    if (route === 'POST /api/console/logout') {
      res.setHeader('set-cookie', 'videosave_console=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return reply(res, 200, { ok: true });
    }
    if (route === 'POST /api/ai/call' || route === 'GET /api/ai/tools') {
      const managed = () => authenticateClient(req.headers.authorization,pairingCode);
      const client = origin ? null : managed();
      if (!client) throw new ApiError('UNAUTHORIZED','Managed MCP authentication required',401);
      if (req.method === 'GET') return reply(res,200,{tools:managedTools(client)});
      const signal = responseSignal(res);
      const invocation = await body(req);
      const current = managed();
      if (!current) throw new ApiError('UNAUTHORIZED','Managed MCP client is disabled',401);
      const result = await invokeManaged(current,invocation,signal);
      if (!res.destroyed) {
        const latest = managed();
        if (!latest) throw new ApiError('UNAUTHORIZED','Managed MCP client is disabled',401);
        if (latest.scopes.join() !== current.scopes.join()) throw new ApiError('MCP_PERMISSION_CHANGED','Client permissions changed during the call',403);
        reply(res,200,result);
      }
      return;
    }
    if (!authorized(req)) throw new ApiError('UNAUTHORIZED', '配对码无效', 401);
    switch (route) {
      case 'GET /api/ai/clients': return reply(res,200,listClients());
      case 'GET /api/ai/config': {
        const id = searchParams.get('id');
        if (!listClients().items.some(client => client.id === id && !client.disabled)) {
          throw new ApiError('MCP_CLIENT_NOT_FOUND','Active client not found',404);
        }
        if (process.env.MEDIA_TOOLKIT_TOKEN || process.env.MEDIA_TOOLKIT_LOCAL_PAIRING !== '1') {
          throw new ApiError('MCP_CONFIG_UNAVAILABLE','Start the companion with the Windows launcher to generate this configuration',409);
        }
        const env = {MEDIA_TOOLKIT_URL:'http://127.0.0.1:' + localPort,MEDIA_TOOLKIT_LOCAL_PAIRING:'1',MEDIA_TOOLKIT_MCP_CLIENT:id};
        if (process.env.MEDIA_TOOLKIT_SETTINGS) env.MEDIA_TOOLKIT_SETTINGS = process.env.MEDIA_TOOLKIT_SETTINGS;
        return reply(res,200,{mcpServers:{videosave:{command:process.execPath,
          args:[fileURLToPath(new URL('./mcp-server.mjs',import.meta.url))],env}}});
      }
      case 'POST /api/ai/clients': return reply(res,200,saveClient(await body(req)));
      case 'GET /api/ai/access': return reply(res,200,clientAccess(searchParams.get('id')));
      case 'POST /api/ai/access': return reply(res,200,updateClientAccess(await body(req)));
      case 'GET /api/ai/authorizations': return reply(res,200,listGrants());
      case 'POST /api/ai/approve': return reply(res,200,approveGrant(await body(req)));
      case 'POST /api/ai/renew': return reply(res,200,renewGrant((await body(req)).id));
      case 'POST /api/ai/snapshot': return reply(res,200,updateGrantSnapshot(await body(req)));
      case 'POST /api/ai/revoke': return reply(res,200,revokeGrant((await body(req)).id));
      case 'GET /api/ai/site': return reply(res,200,sitePreferences(searchParams.get('origin')));
      case 'POST /api/ai/site': {
        const {origin:site,settings} = await body(req);
        return reply(res,200,sitePreferences(site,settings));
      }
      case 'GET /api/ai/activity': return reply(res,200,activity());
      case 'POST /api/ai/activity': {
        const options = await body(req);
        return reply(res,200,options.clear === true ? activity(true) : auditSettings(options));
      }
      case 'GET /api/ai/network': return reply(res,200,networkPreferences());
      case 'POST /api/ai/network': return reply(res,200,networkPreferences(await body(req)));
      case 'GET /api/ai/network/check': return reply(res,200,await diagnoseNetwork());
      case 'GET /api/ai/compatibility': return reply(res,200,compatibilityRules());
      case 'POST /api/ai/compatibility': return reply(res,200,compatibilityRules(await body(req)));
      case 'GET /api/health':
        return reply(res, 200, { ok: true, version: VERSION, mcpControl:true, outDir: downloads.getSettings().settings.outDir,
          ...(downloads.platformDownloadsEnabled() && {platformDownloads:true}) });
      case 'GET /api/version':
        return reply(res, 200, await downloads.getVersionInfo());
      case 'GET /api/engines':
        return reply(res, 200, downloads.getEngineCapabilities());
      case 'GET /api/platforms':
        return reply(res, 200, downloads.getEngineCapabilities().platformRegistry);
      case 'GET /api/runtime/health':
        return reply(res, 200, await downloads.getRuntimeHealth());
      case 'POST /api/runtime/repair': {
        const setupScript = fileURLToPath(new URL('./setup-platform-downloads.mjs', import.meta.url));
        const toolsDir = (await downloads.getRuntimeHealth()).managedToolsDir;
        try {
          const { stdout } = await execFileAsync(process.execPath, [setupScript, `--cache-dir=${toolsDir}`], {
            timeout: 120_000,
            windowsHide: true,
          });
          return reply(res, 200, { ok: true, repaired: true, detail: stdout.trim(), health: await downloads.getRuntimeHealth() });
        } catch (err) {
          return reply(res, 502, { ok: false, code: 'COMPONENT_REPAIR_FAILED', error: err.stderr || err.message });
        }
      }
      case 'GET /api/system/storage': {
        const outDir = downloads.getSettings().settings.outDir;
        let writable = false;
        let freeBytes = null;
        let totalBytes = null;
        try {
          await access(outDir, fsConstants.W_OK);
          writable = true;
        } catch {}
        try {
          const fsInfo = await statfs(outDir);
          freeBytes = Number(fsInfo.bavail) * Number(fsInfo.bsize);
          totalBytes = Number(fsInfo.blocks) * Number(fsInfo.bsize);
        } catch {}
        return reply(res, 200, { outDir, writable, freeBytes, totalBytes, sandboxActive: isSandboxActive() });
      }
      case 'GET /api/updates/check': {
        const includePrerelease = searchParams.get('prerelease') === '1';
        return reply(res, 200, await checkForUpdates({ includePrerelease }));
      }
      case 'GET /api/updates/history':
        return reply(res, 200, { items: getUpdateHistory(20) });
      case 'GET /api/diagnostics/export': {
        const health = await downloads.getRuntimeHealth();
        const engines = downloads.getEngineCapabilities();
        const batches = downloads.listBatches({ limit: 10 }).items.map(b => ({
          id: b.id, status: b.status, total: b.total, completed: b.completed, failed: b.failed,
          errorCodes: (b.items ?? []).map(i => i.errorCode).filter(Boolean),
        }));
        return reply(res, 200, {
          exportedAt: new Date().toISOString(),
          sanitized: true,
          version: VERSION,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          sandboxActive: isSandboxActive(),
          components: Object.fromEntries(Object.entries(health.components).map(([k, v]) => [k, { status: v.status, version: v.version, source: v.source }])),
          platforms: health.platforms,
          engines: engines.transfer,
          recentBatchSummary: batches,
          updateHistory: getUpdateHistory(5),
        });
      }
      case 'GET /api/telemetry':
        return reply(res, 200, downloads.getRateTelemetry());
      case 'GET /api/mcp/configs': {
        const mode = searchParams.get('mode') || 'standalone';
        const clientId = searchParams.get('clientId') || null;
        return reply(res, 200, {
          clients: detectMcpClients(),
          configs: Object.fromEntries(SUPPORTED_MCP_CLIENTS.map(client => [
            client,
            generateMcpClientConfig(client, { mode, companionPort: localPort, managedClientId: clientId }),
          ])),
        });
      }
      case 'GET /api/effective-settings':
        return reply(res, 200, downloads.getEffectiveSettings());
      case 'POST /api/diagnose/probe': {
        const signal = responseSignal(res);
        const found = await downloads.probe(await body(req), signal);
        if (!res.destroyed) reply(res, 200, { selection: found.selection, diagnostic: found.diagnostic, blockers: found.blockers ?? [],
          probeStrategy: found.probeStrategy, browserProbe: found.browserProbe, candidateCount: found.streams?.length ?? 0, qualities: found.qualities ?? [] });
        return;
      }
      case 'POST /api/download-best': {
        const signal = responseSignal(res);
        const result = await downloads.downloadBestMedia(await body(req), signal);
        if (!res.destroyed) reply(res, 200, result);
        return;
      }
      case 'POST /api/download-batch': {
        const signal = responseSignal(res);
        const result = await downloads.downloadMediaBatch(await body(req), signal);
        if (!res.destroyed) reply(res, 200, result);
        return;
      }
      case 'POST /api/browser-sessions': {
        const args = await body(req);
        return reply(res, 200, (args.action === 'reset' || args.action === 'revoke' || args.reset === true)
          ? await downloads.resetBrowserSession(args.browserSessionId)
          : await downloads.getBrowserSessionStatus(args.browserSessionId));
      }
      case 'POST /api/cookies/import':
        return reply(res, 200, await downloads.importCookieSession(await body(req)));
      case 'GET /api/settings':
        return reply(res, 200, downloads.getSettings());
      case 'POST /api/settings':
        return reply(res, 200, downloads.updateSettings({settings:(await body(req)).settings}));
      case 'GET /api/browser-settings':
        return reply(res, 200, downloads.getSettings({scope:'browser'}));
      case 'POST /api/browser-settings':
        return reply(res, 200, downloads.updateSettings({scope:'browser',settings:(await body(req)).settings}));
      case 'GET /api/batches':
        return reply(res, 200, downloads.listBatches({limit:searchParams.has('limit') ? Number(searchParams.get('limit')) : undefined}));
      case 'POST /api/probe': {
        const signal = responseSignal(res);
        const found = await downloads.probe(await body(req), signal);
        if (!res.destroyed) reply(res, 200, found);
        return;
      }
      case 'POST /api/preview': {
        const signal = responseSignal(res);
        const clip = await downloads.preview(await body(req), signal);
        if (res.destroyed) return;
        res.writeHead(200, {'content-type':'video/mp4','content-length':clip.length,'cache-control':'no-store'});
        return res.end(clip);
      }
      case 'POST /api/queue':
        return reply(res, 200, downloads.queue(await body(req)));
      case 'POST /api/queue/batch':
        return reply(res, 200, downloads.queueBatch(await body(req)));
      case 'POST /api/queue/original':
        return reply(res, 200, downloads.queueOriginal(await body(req)));
      case 'GET /api/recent':
        return reply(res, 200, await downloads.recent());
      case 'POST /api/open':
        return reply(res, 200, await downloads.openDownload((await body(req)).file));
      case 'POST /api/cancel': {
        const { id, itemIndex } = await body(req);
        return reply(res, 200, await downloads.cancel(id, itemIndex !== undefined ? { itemIndex } : undefined));
      }
      case 'POST /api/retry':
        return reply(res, 200, downloads.retryBatch(await body(req)));
    }
    const transfer = /^\/api\/batch\/([\w-]+)\/files\/(\d+)(?:\/(\d+))?$/.exec(pathname);
    if (transfer) {
      const [, id, item, output] = transfer;
      if (req.method === 'GET' && output !== undefined) {
        return sendFile(req, res, downloads.browserFile(id, Number(item), Number(output)));
      }
      if (req.method === 'POST' && output === undefined) {
        return reply(res, 200, await downloads.releaseFiles(id, Number(item)));
      }
    }
    const batch = /^\/api\/batch\/([\w-]+)(?:\/(events|wait|verify|pause|resume|diagnose|report|recover))?$/.exec(pathname);
    if (batch) {
      const [, id, action] = batch;
      if (req.method === 'POST' && action === 'verify') {
        const opts = req.headers['content-type'] ? await body(req).catch(() => ({})) : {};
        return reply(res, 200, await downloads.verifyBatchFiles(id, responseSignal(res), { durationToleranceSec: opts.durationToleranceSec }));
      }
      if (req.method === 'POST' && action === 'pause') {
        return reply(res, 200, downloads.setBatchPaused(id, true));
      }
      if (req.method === 'POST' && action === 'resume') {
        return reply(res, 200, downloads.setBatchPaused(id, false));
      }
      if (req.method === 'GET' && action === 'diagnose') {
        return reply(res, 200, downloads.diagnoseDownload(id));
      }
      if (req.method === 'GET' && action === 'report') {
        return reply(res, 200, downloads.getTaskReport(id));
      }
      if (req.method === 'GET' && action === 'recover') {
        return reply(res, 200, await downloads.recoverDownload({ id }));
      }
      if (req.method === 'GET') {
        if (!action) return reply(res, 200, downloads.progress(id));
        if (action === 'wait') {
          const signal = responseSignal(res);
          const timeoutMs = searchParams.has('timeoutMs') ? Number(searchParams.get('timeoutMs')) : undefined;
          const outcome = await downloads.waitForBatch({id, timeoutMs}, signal);
          if (!res.destroyed) reply(res, 200, outcome);
          return;
        }
        if (action === 'events') {
          downloads.progress(id);
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
          const unsubscribe = downloads.subscribe(id, current => {
            if (res.destroyed || res.writableEnded) return;
            res.write(`data: ${JSON.stringify(current)}\n\n`);
            if (downloads.isTerminal(current.status)) res.end();
          });
          res.once('close', unsubscribe);
          return;
        }
      }
    }
    throw new ApiError('NOT_FOUND', '找不到此接口', 404);
  } catch (error) {
    if (res.destroyed) return;
    if (!res.headersSent) {
      if (error.code === 'BODY_TOO_LARGE') res.setHeader('connection','close');
      reply(res, error instanceof ApiError ? error.status : 500, { error: downloads.errorDetails(error) });
    } else if (!res.writableEnded) res.end();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    downloads.shutdown();
    server.close();
  });
}

server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  console.log('本机服务 http://127.0.0.1:' + actualPort);
  if (!process.env.MEDIA_TOOLKIT_TOKEN) console.log('本次配对码 ' + pairingCode);
  console.log('本机管理中心 http://127.0.0.1:' + actualPort + '/console');
  console.log('下载目录 ' + downloads.getSettings().settings.outDir);
});
