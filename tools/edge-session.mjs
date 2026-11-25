import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

export async function connectCdp(url, signal) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const subscriptions = new Map();
  let nextId = 0;
  const rejectPending = () => {
    for (const reply of pending.values()) reply(new Error('Edge 调试连接已关闭'));
  };
  const close = () => ws.close();
  ws.addEventListener('close', rejectPending);
  ws.addEventListener('close', () => signal?.removeEventListener('abort', close));
  signal?.addEventListener('abort', close, { once: true });
  ws.addEventListener('message', ({ data }) => {
    const { id, error, result, method, params } = JSON.parse(data);
    if (method) for (const handler of subscriptions.get(method) ?? []) handler(params);
    pending.get(id)?.(error && new Error(error.message), result);
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('连接 Edge 超时')), 5000);
      const finish = (error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      ws.addEventListener('open', () => finish(), { once: true });
      ws.addEventListener('error', () => finish(new Error('无法连接 Edge')), { once: true });
      ws.addEventListener('close', () => finish(new Error('Edge 调试连接已关闭')), { once: true });
      if (signal?.aborted) close();
    });
  } catch (error) {
    close();
    throw error;
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('Edge 调试连接已关闭'));
    const id = ++nextId;
    const finish = (error, result) => {
      clearTimeout(timeout);
      pending.delete(id);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error(`Edge 调试请求超时（${method}）`)), 8000);
    pending.set(id, finish);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send, close,
    on(method, handler) {
      if (!subscriptions.has(method)) subscriptions.set(method, new Set());
      subscriptions.get(method).add(handler);
    },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

export async function withEdge(args, run, signal, {downloadsDirectory} = {}) {
  signal?.throwIfAborted();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'media-toolkit-edge-'));
  if (downloadsDirectory) {
    const settings = path.join(profile, 'Default');
    await mkdir(settings);
    await writeFile(path.join(settings, 'Preferences'),
      JSON.stringify({download:{default_directory:downloadsDirectory, prompt_for_download:false}}));
  }
  const edge = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--mute-audio', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, ...args, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let startupError;
  edge.once('error', error => { startupError = error; });
  try {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (startupError || edge.exitCode !== null) throw new Error('无法启动隔离的 Edge');
      const ports = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [port, browserPath] = ports.trim().split(/\r?\n/);
      if (port && browserPath) {
        const origin = `http://127.0.0.1:${port}`;
        const list = async () => (await fetch(`${origin}/json/list`, {
          signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
        })).json();
        return await run({ list, profile, browserUrl: `ws://127.0.0.1:${port}${browserPath}` });
      }
      await sleep(100, undefined, { signal });
    }
    throw new Error('Edge 调试端口启动超时');
  } finally {
    if (edge.pid && edge.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(edge.pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}
