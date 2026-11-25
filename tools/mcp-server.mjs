#!/usr/bin/env node
import { createInterface } from 'node:readline';
import * as downloads from './media-downloads.mjs';

const latestProtocol = '2025-11-25';
const supportedProtocols = new Set([latestProtocol, '2025-06-18', '2025-03-26', '2024-11-05']);
const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required });
const operations = [
  ['probe_page', 'Find playable streams and linked pages.', object({ url: string, cookie: string }, ['url']), downloads.probe],
  ['start_download', 'Queue media streams or pages for download.', object({
    items: { type: 'array', minItems: 1, items: object({
      kind: { type: 'string', enum: ['stream', 'page'] }, url: string, title: string, format: { type: 'string', enum: ['mp4', 'mkv'] },
      mode: { type: 'string', enum: ['combined', 'video', 'audio', 'separate'] },
      quality: { type: 'integer', minimum: 144, maximum: 4320 },
      audioFormat: { type: 'string', enum: ['m4a', 'mp3'] },
      subtitles: { type: 'boolean' },
    }, ['kind', 'url']) },
    maxSec: { type: 'number', exclusiveMinimum: 0 }, concurrency: { type: 'integer', minimum: 1, maximum: 2 }, cookie: string,
  }, ['items']), downloads.queue],
  ['get_progress', 'Read the current status and log for a batch.', object({ id: string }, ['id']),
    ({ id }) => downloads.progress(id)],
  ['list_downloads', 'List recently downloaded videos.', object({}), downloads.recent],
  ['open_file', 'Open the download directory or select a video in Explorer.', object({ file: string }),
    ({ file }) => downloads.openDownload(file)],
];
const tools = operations.map(([name, description, inputSchema]) => ({ name, description, inputSchema }));
const handlers = new Map(operations.map(([name, , , handler]) => [name, handler]));

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' || Number.isFinite(id);
const send = payload => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
const sendError = (id, code, message) => send({ id, error: { code, message } });
let protocol;

async function dispatch({ method, params }) {
  if (method === 'ping') return {};
  if (method === 'initialize') {
    if (protocol) throw new RpcError(-32600, 'Session is already initialized');
    if (!isObject(params) || typeof params.protocolVersion !== 'string') {
      throw new RpcError(-32602, 'protocolVersion is required');
    }
    protocol = supportedProtocols.has(params.protocolVersion) ? params.protocolVersion : latestProtocol;
    return { protocolVersion: protocol, serverInfo: { name: 'media-toolkit', version: downloads.VERSION },
      capabilities: { tools: {} } };
  }
  if (!protocol) throw new RpcError(-32002, 'Session is not initialized');
  if (method === 'tools/list') return { tools };
  if (method !== 'tools/call') throw new RpcError(-32601, 'Method not found');
  const handler = handlers.get(params?.name);
  const args = params?.arguments === undefined ? {} : params.arguments;
  if (!handler || !isObject(args)) throw new RpcError(-32602, 'Invalid tool name or arguments');

  try {
    const result = await handler(args);
    const content = [{ type: 'text', text: JSON.stringify(result) }];
    return protocol >= '2025-06-18' ? { content, structuredContent: result } : { content };
  } catch (error) {
    const details = downloads.errorDetails(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }] };
  }
}

async function receive(line) {
  let message;
  try { message = JSON.parse(line); }
  catch { return sendError(null, -32700, 'Parse error'); }
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      ('id' in message && !validId(message.id))) {
    return sendError(validId(message?.id) ? message.id : null, -32600, 'Invalid request');
  }
  if (!('id' in message)) return;
  try { send({ id: message.id, result: await dispatch(message) }); }
  catch (error) {
    if (error instanceof RpcError) sendError(message.id, error.code, error.message);
    else sendError(message.id, -32603, 'Internal error');
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', line => { if (line.trim()) void receive(line); });
input.once('close', downloads.shutdown);
