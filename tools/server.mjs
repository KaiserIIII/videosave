#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import * as downloads from './media-downloads.mjs';

const { ApiError, VERSION, OUT_DIR } = downloads;
const port = Number(process.env.PORT ?? 8765);
const pairingCode = process.env.MEDIA_TOOLKIT_TOKEN || randomBytes(24).toString('base64url');
const expected = Buffer.from('Bearer ' + pairingCode);
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
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      req.resume();
      throw new ApiError('BODY_TOO_LARGE', '请求超过 1 MiB', 413);
    }
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

const server = http.createServer(async (req, res) => {
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
    if (!authorized(req)) throw new ApiError('UNAUTHORIZED', '配对码无效', 401);
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    const route = req.method + ' ' + pathname;
    switch (route) {
      case 'GET /api/health':
        return reply(res, 200, { ok: true, version: VERSION, outDir: OUT_DIR });
      case 'POST /api/probe':
        return reply(res, 200, await downloads.probe(await body(req)));
      case 'POST /api/preview': {
        const controller = new AbortController();
        res.once('close', () => controller.abort());
        const clip = await downloads.preview(await body(req), controller.signal);
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
        return reply(res, 200, downloads.cancel((await body(req)).id));
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
    const batch = /^\/api\/batch\/([\w-]+)(\/events)?$/.exec(pathname);
    if (req.method === 'GET' && batch) {
      const [, id, events] = batch;
      if (!events) return reply(res, 200, downloads.progress(id));
      downloads.progress(id);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const unsubscribe = downloads.subscribe(id, current => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(current)}\n\n`);
        if (current.status === 'done' || current.status === 'cancelled') res.end();
      });
      res.once('close', unsubscribe);
      return;
    }
    throw new ApiError('NOT_FOUND', '找不到此接口', 404);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) reply(res, error instanceof ApiError ? error.status : 500, { error: downloads.errorDetails(error) });
    else if (!res.writableEnded) res.end();
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
  console.log('下载目录 ' + OUT_DIR);
});
