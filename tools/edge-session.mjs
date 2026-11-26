import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const edgeDefault = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function chromiumExecutable() {
  const configured = process.env.BROWSER_BIN || process.env.EDGE_BIN;
  if (configured) return configured;
  const chrome = 'Google/Chrome/Application/chrome.exe';
  const brave = 'BraveSoftware/Brave-Browser/Application/brave.exe';
  const candidates = [edgeDefault, ...['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'].flatMap(name =>
    process.env[name] ? [chrome,brave].map(entry => path.join(process.env[name],entry)) : [])];
  const installed = candidates.find(existsSync);
  if (!installed) throw new Error('找不到 Chromium 浏览器。请用 BROWSER_BIN 指定 Edge、Chrome 或 Brave。');
  return installed;
}

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
    const { id, error, result, method, params, sessionId } = JSON.parse(data);
    if (method) for (const handler of subscriptions.get(`${sessionId ?? ''} ${method}`) ?? []) handler(params);
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
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
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
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const session = sessionId => ({
    send: (method, params = {}) => send(method, params, sessionId),
    on(method, handler) {
      const key = `${sessionId ?? ''} ${method}`;
      if (!subscriptions.has(key)) subscriptions.set(key, new Set());
      subscriptions.get(key).add(handler);
    },
    async evaluate(expression, contextId) {
      const result = await send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
  });
  return {...session(), session, close};
}

export function withEdge(args, run, signal, options) {
  return withChromium(args, run, signal, {...options, executable:process.env.EDGE_BIN || edgeDefault});
}

export async function withChromium(args, run, signal, {downloadsDirectory, executable = chromiumExecutable(), headed = false} = {}) {
  signal?.throwIfAborted();
  const profile = await mkdtemp(path.join(os.tmpdir(), 'media-toolkit-edge-'));
  if (downloadsDirectory) {
    const settings = path.join(profile, 'Default');
    await mkdir(settings);
    await writeFile(path.join(settings, 'Preferences'),
      JSON.stringify({download:{default_directory:downloadsDirectory, prompt_for_download:false}}));
  }
  const edge = spawn(executable, [
    ...(headed ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--mute-audio', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, ...args, 'about:blank',
  ], { stdio: 'ignore', windowsHide: !headed });
  let startupError;
  edge.once('error', error => { startupError = error; });
  try {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (startupError || edge.exitCode !== null) throw new Error('无法启动隔离的 Chromium 浏览器');
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
    throw new Error('Chromium 调试端口启动超时');
  } finally {
    if (edge.pid && edge.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(edge.pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}
