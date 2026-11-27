#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as downloads from './media-downloads.mjs';
import { configureMediaProxy, diagnoseNetwork, networkPreferences } from './media-proxy.mjs';
import { localPairingCode } from './preferences.mjs';
import { activity, approveGrant, auditSettings, authenticateClient, listClients, listGrants, renewGrant, revokeGrant, saveClient, sitePreferences } from './mcp-control.mjs';
import { invokeManaged, managedTools } from './managed-mcp.mjs';

configureMediaProxy();
const { ApiError, VERSION } = downloads;
const port = Number(process.env.PORT ?? 8765);
const pairingCode = process.env.MEDIA_TOOLKIT_TOKEN || (process.env.MEDIA_TOOLKIT_LOCAL_PAIRING === '1'
  ? localPairingCode({create:true}) : randomBytes(24).toString('base64url'));
const expected = Buffer.from('Bearer ' + pairingCode);
const maxBody = 1024 * 1024;
function authorized(request) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
    if (origin && !/^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(origin)) {
      throw new ApiError('FORBIDDEN_ORIGIN', '仅接受浏览器扩展或本机工具', 403);
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('access-control-allow-private-network', 'true');
      }
    }
    if (origin && req.method === 'OPTIONS') {
      res.writeHead(204, {'access-control-allow-methods':'GET, POST', 'access-control-allow-headers':'authorization, content-type'});
      return res.end();
    }
    if (!/^\/(?![\/\\])/.test(req.url) || req.url.includes('\\')) {
      throw new ApiError('INVALID_REQUEST_TARGET', '仅接受本机接口路径');
    }
    const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');
    const route = req.method + ' ' + pathname;
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
      case 'GET /api/ai/authorizations': return reply(res,200,listGrants());
      case 'POST /api/ai/approve': return reply(res,200,approveGrant(await body(req)));
      case 'POST /api/ai/renew': return reply(res,200,renewGrant((await body(req)).id));
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
      case 'GET /api/health':
        return reply(res, 200, { ok: true, version: VERSION, mcpControl:true, outDir: downloads.getSettings().settings.outDir,
          ...(downloads.platformDownloadsEnabled() && {platformDownloads:true}) });
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
      case 'POST /api/queue/original':
        return reply(res, 200, downloads.queueOriginal(await body(req)));
      case 'GET /api/recent':
        return reply(res, 200, await downloads.recent());
      case 'POST /api/open':
        return reply(res, 200, await downloads.openDownload((await body(req)).file));
      case 'POST /api/cancel':
        return reply(res, 200, await downloads.cancel((await body(req)).id));
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
    const batch = /^\/api\/batch\/([\w-]+)(?:\/(events|wait))?$/.exec(pathname);
    if (req.method === 'GET' && batch) {
      const [, id, action] = batch;
      if (!action) return reply(res, 200, downloads.progress(id));
      if (action === 'wait') {
        const signal = responseSignal(res);
        const timeoutMs = searchParams.has('timeoutMs') ? Number(searchParams.get('timeoutMs')) : undefined;
        const outcome = await downloads.waitForBatch({id, timeoutMs}, signal);
        if (!res.destroyed) reply(res, 200, outcome);
        return;
      }
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
  console.log('本机服务 http://127.0.0.1:' + server.address().port);
  if (!process.env.MEDIA_TOOLKIT_TOKEN) console.log('本次配对码 ' + pairingCode);
  console.log('下载目录 ' + downloads.getSettings().settings.outDir);
});
