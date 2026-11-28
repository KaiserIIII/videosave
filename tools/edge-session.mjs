import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { browserProxyArgs } from './media-proxy.mjs';
import { prepareDedicatedProfile, withDedicatedSessionQueue } from './browser-sessions.mjs';
import { ApiError } from './media-source.mjs';

const edgeDefault = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const exec = promisify(execFile);

export const BROWSER_STAGES = Object.freeze({
  BROWSER_NOT_STARTED: 'BROWSER_NOT_STARTED',
  BROWSER_EXITED_EARLY: 'BROWSER_EXITED_EARLY',
  CDP_NOT_READY: 'CDP_NOT_READY',
  EXTENSION_LOAD_FAILED: 'EXTENSION_LOAD_FAILED',
  PAGE_LOAD_FAILED: 'PAGE_LOAD_FAILED',
  PROBE_FAILED: 'PROBE_FAILED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  READY: 'READY',
});

export const STARTUP_RETRYABLE_STAGES = new Set([
  BROWSER_STAGES.BROWSER_NOT_STARTED,
  BROWSER_STAGES.BROWSER_EXITED_EARLY,
  BROWSER_STAGES.CDP_NOT_READY,
  BROWSER_STAGES.EXTENSION_LOAD_FAILED,
]);

export class BrowserTransportError extends Error {
  constructor(message, options = {}) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'BrowserTransportError';
    this.stage = options.stage ?? BROWSER_STAGES.CDP_NOT_READY;
    this.code = options.code ?? this.stage;
    this.retryable = Boolean(options.retryable ?? STARTUP_RETRYABLE_STAGES.has(this.stage));
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    if (options.signalCode !== undefined) this.signalCode = options.signalCode;
    if (options.stderrTail) this.stderrTail = options.stderrTail;
    if (options.elapsedMs !== undefined) this.elapsedMs = options.elapsedMs;
  }
}

function candidatePaths(browser) {
  const roots = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
    .map(name => process.env[name])
    .filter(Boolean);
  const byBrowser = {
    edge: [
      process.env.EDGE_BIN,
      edgeDefault,
      ...roots.map(r => path.join(r, 'Microsoft/Edge/Application/msedge.exe')),
      '/usr/bin/microsoft-edge',
    ],
    chrome: [
      process.env.CHROME_BIN,
      ...roots.map(r => path.join(r, 'Google/Chrome/Application/chrome.exe')),
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ],
    brave: [
      process.env.BRAVE_BIN,
      ...roots.map(r => path.join(r, 'BraveSoftware/Brave-Browser/Application/brave.exe')),
      '/usr/bin/brave-browser',
    ],
  };
  if (browser && browser !== 'auto') {
    return (byBrowser[browser] ?? []).filter(Boolean);
  }
  return [
    process.env.BROWSER_BIN,
    process.env.EDGE_BIN,
    ...byBrowser.edge,
    ...byBrowser.chrome,
    ...byBrowser.brave,
  ].filter(Boolean);
}

export function detectAvailableBrowsers() {
  const found = {};
  for (const name of ['edge', 'chrome', 'brave']) {
    const bin = candidatePaths(name).find(existsSync);
    if (bin) found[name] = bin;
  }
  return found;
}

export function resolveChromiumExecutable({ browser = 'auto', browserBinary } = {}) {
  if (browserBinary !== undefined) {
    if (typeof browserBinary !== 'string' || !browserBinary.trim() || /[\x00-\x1f]/.test(browserBinary)) {
      throw new ApiError('INVALID_BROWSER_BINARY', 'browserBinary 必须为有效的浏览器可执行文件路径');
    }
    const resolved = path.resolve(browserBinary);
    const base = path.basename(resolved).toLowerCase();
    if (!/^(?:msedge|chrome|chromium|chromium-browser|brave|brave-browser|google-chrome)(?:\.exe)?$/.test(base) || !existsSync(resolved)) {
      throw new ApiError('INVALID_BROWSER_BINARY', 'browserBinary 必须指向本机已安装的受支持 Chromium 浏览器（Edge/Chrome/Brave/Chromium）');
    }
    return resolved;
  }
  const installed = candidatePaths(browser).find(existsSync);
  if (!installed) {
    throw new Error(
      browser && browser !== 'auto'
        ? `找不到指定的 ${browser} 浏览器。请检查安装或通过 BROWSER_BIN 指定。`
        : '找不到 Chromium 浏览器。请用 BROWSER_BIN 指定 Edge、Chrome 或 Brave。',
    );
  }
  return installed;
}

function probeProxyArgs({ networkMode, proxy } = {}) {
  if (!networkMode) return browserProxyArgs();
  if (networkMode === 'direct') return ['--no-proxy-server'];
  if (networkMode === 'http' && proxy) {
    return ['--proxy-server=' + proxy, '--proxy-bypass-list=localhost;127.0.0.1;[::1]'];
  }
  return [];
}

export async function connectCdp(url, signal) {
  signal?.throwIfAborted();
  const ws = new WebSocket(url);
  const pending = new Map();
  const subscriptions = new Map();
  let nextId = 0;
  const closed = () => new BrowserTransportError('Edge 调试连接已关闭');
  const rejectPending = error => {
    for (const reply of pending.values()) reply(error);
  };
  const close = () => ws.close();
  const abort = () => { rejectPending(signal.reason); close(); };
  ws.addEventListener('close', () => {
    signal?.removeEventListener('abort', abort);
    rejectPending(signal?.aborted ? signal.reason : closed());
  });
  signal?.addEventListener('abort', abort, { once: true });
  ws.addEventListener('message', ({ data }) => {
    const { id, error, result, method, params, sessionId } = JSON.parse(data);
    if (method) for (const handler of subscriptions.get(`${sessionId ?? ''} ${method}`) ?? []) handler(params);
    pending.get(id)?.(error && new Error(error.message), result);
  });
  try {
    await new Promise((resolve, reject) => {
      const listeners = new AbortController();
      const timeout = setTimeout(() => finish(new BrowserTransportError('连接 Edge 超时')), 5000);
      const finish = error => {
        clearTimeout(timeout);
        listeners.abort();
        if (error) reject(error);
        else resolve();
      };
      const options = { signal: listeners.signal };
      ws.addEventListener('open', () => finish(), options);
      ws.addEventListener('error', () => finish(new BrowserTransportError('无法连接 Edge')), options);
      ws.addEventListener('close', () => finish(closed()), options);
      signal?.addEventListener('abort', () => finish(signal.reason), options);
      if (signal?.aborted) finish(signal.reason);
    });
  } catch (error) {
    close();
    throw error;
  }
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (ws.readyState !== WebSocket.OPEN) return reject(closed());
    const id = ++nextId;
    const finish = (error, result) => {
      clearTimeout(timeout);
      pending.delete(id);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new BrowserTransportError(`Edge 调试请求超时（${method}）`)), 8000);
    pending.set(id, finish);
    try { ws.send(JSON.stringify({ id, method, params, sessionId })); }
    catch (error) { finish(error); }
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
  return { ...session(), session, close };
}

export function withEdge(args, run, signal, options) {
  return withChromium(args, run, signal, { ...options, executable: process.env.EDGE_BIN || edgeDefault });
}

export async function withChromium(args, run, signal, options = {}) {
  const {
    profileMode = 'ephemeral',
    browserSessionId,
    maxStartupRetries = profileMode === 'dedicated' ? 1 : 2,
    onLaunchTelemetry,
  } = options;
  const execLaunch = async () => {
    const attempts = [];
    let lastError;
    for (let attempt = 1; attempt <= 1 + maxStartupRetries; attempt++) {
      signal?.throwIfAborted();
      const startedAt = performance.now();
      let enteredRun = false;
      try {
        const result = await runChromiumOnce(
          args,
          ctx => {
            enteredRun = true;
            return run({
              ...ctx,
              launchTelemetry: {
                attempts: attempt,
                retries: attempt - 1,
                firstFailure: attempts[0] ?? null,
                priorAttempts: [...attempts],
                finalStage: BROWSER_STAGES.READY,
                launchMs: Math.round(performance.now() - startedAt),
              },
            });
          },
          signal,
          options,
        );
        onLaunchTelemetry?.({
          attempts: attempt,
          retries: attempt - 1,
          firstFailure: attempts[0] ?? null,
          priorAttempts: [...attempts],
          finalStage: BROWSER_STAGES.READY,
          launchMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        const stage = error?.stage ?? (enteredRun ? BROWSER_STAGES.PROBE_FAILED : BROWSER_STAGES.CDP_NOT_READY);
        const record = {
          attempt,
          stage,
          message: error?.message ?? String(error),
          exitCode: error?.exitCode ?? null,
          elapsedMs,
        };
        attempts.push(record);
        lastError = error;
        // Never retry functional failures after browser/CDP startup succeeded, except explicit EXTENSION_LOAD_FAILED.
        const canRetry = !signal?.aborted &&
          attempt <= maxStartupRetries &&
          STARTUP_RETRYABLE_STAGES.has(stage) &&
          (!enteredRun || stage === BROWSER_STAGES.EXTENSION_LOAD_FAILED);
        if (!canRetry) {
          if (error && typeof error === 'object') {
            error.launchTelemetry = {
              attempts: attempt,
              retries: attempt - 1,
              firstFailure: attempts[0] ?? null,
              priorAttempts: [...attempts],
              finalStage: stage,
            };
          }
          onLaunchTelemetry?.(error?.launchTelemetry);
          if (process.env.CI || process.env.VIDEOSAVE_DEBUG_BROWSER) {
            console.error('[browser-launch-diagnostic]', JSON.stringify({
              stage,
              attempts: attempt,
              elapsedMs,
              exitCode: error?.exitCode ?? null,
              message: error?.message ?? String(error),
              stderrTail: error?.stderrTail ?? undefined,
            }));
          }
          throw error;
        }
        await sleep(300 * attempt, undefined, { signal }).catch(() => {});
      }
    }
    throw lastError;
  };
  if (profileMode === 'dedicated' && browserSessionId) {
    return withDedicatedSessionQueue(browserSessionId, execLaunch, { signal });
  }
  return execLaunch();
}

async function runChromiumOnce(args, run, signal, {
  downloadsDirectory,
  executable,
  browser = 'auto',
  browserBinary,
  headed = false,
  userAgent,
  profileMode = 'ephemeral',
  browserSessionId,
  networkMode,
  proxy,
  startupTimeoutMs = 30_000,
} = {}) {
  signal?.throwIfAborted();
  const binary = executable || resolveChromiumExecutable({ browser, browserBinary });
  const dedicated = profileMode === 'dedicated' && browserSessionId
    ? await prepareDedicatedProfile(browserSessionId, { browser: path.basename(binary), userAgent, signal })
    : null;
  const profile = dedicated ? dedicated.profileDir : await mkdtemp(path.join(os.tmpdir(), 'media-toolkit-edge-'));
  let edge;
  let stderrBuf = '';
  const startedAt = performance.now();
  try {
    const settings = path.join(profile, 'Default');
    await mkdir(settings, { recursive: true });
    const prefPath = path.join(settings, 'Preferences');
    let existingPrefs = {};
    if (dedicated) {
      existingPrefs = await readFile(prefPath, 'utf8').then(JSON.parse).catch(() => ({}));
    }
    await writeFile(prefPath, JSON.stringify({
      ...existingPrefs,
      download: {
        ...(existingPrefs.download ?? {}),
        default_directory: downloadsDirectory ?? (dedicated ? dedicated.downloadsDir : path.join(profile, 'Downloads')),
        prompt_for_download: false,
      },
    }));
    const devToolsPortFile = path.join(profile, 'DevToolsActivePort');
    if (dedicated) {
      await rm(devToolsPortFile, { force: true }).catch(() => {});
    }
    signal?.throwIfAborted();
    edge = spawn(binary, [
      ...(headed ? [] : ['--headless=new']),
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-dev-shm-usage', '--no-service-autorun', '--password-store=basic',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio', '--disable-background-networking', '--disable-component-update',
      '--disable-sync', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      ...(userAgent ? [`--user-agent=${userAgent}`] : []),
      ...probeProxyArgs({ networkMode, proxy }),
      ...args,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: !headed, detached: process.platform !== 'win32' });
    edge.stderr?.setEncoding('utf8');
    edge.stderr?.on('data', chunk => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
    });
    const edgeExited = new Promise(resolve => {
      if (edge.exitCode !== null || edge.signalCode !== null) resolve();
      else edge.once('exit', () => resolve());
    });
    let startupError;
    let activeBrowserUrl;
    edge.once('error', error => { startupError = error; });
    const deadline = Date.now() + Math.max(12_000, Number(startupTimeoutMs) || 30_000);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (startupError) {
        throw new BrowserTransportError('无法启动隔离的 Chromium 浏览器', {
          cause: startupError,
          stage: BROWSER_STAGES.BROWSER_NOT_STARTED,
          stderrTail: stderrBuf.trim().slice(-600),
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      }
      if (edge.exitCode !== null || edge.signalCode !== null) {
        throw new BrowserTransportError(
          `隔离的 Chromium 浏览器提前退出 (code=${edge.exitCode}, signal=${edge.signalCode})`,
          {
            stage: BROWSER_STAGES.BROWSER_EXITED_EARLY,
            exitCode: edge.exitCode,
            signalCode: edge.signalCode,
            stderrTail: stderrBuf.trim().slice(-600),
            elapsedMs: Math.round(performance.now() - startedAt),
          },
        );
      }
      const ports = await readFile(devToolsPortFile, 'utf8').catch(() => '');
      const [port, browserPath] = ports.trim().split(/\r?\n/);
      if (port && browserPath) {
        const origin = `http://127.0.0.1:${port}`;
        // Confirm HTTP CDP listener is actually accepting requests before entering run()
        const versionOk = await fetch(`${origin}/json/version`, {
          signal: AbortSignal.any([AbortSignal.timeout(2500), ...(signal ? [signal] : [])]),
        }).then(async r => {
          const ok = r.ok;
          await r.body?.cancel().catch(() => {});
          return ok;
        }).catch(() => false);
        if (!versionOk) {
          await sleep(120, undefined, { signal });
          continue;
        }
        activeBrowserUrl = `ws://127.0.0.1:${port}${browserPath}`;
        const list = async () => {
          try {
            const response = await fetch(`${origin}/json/list`, {
              signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]),
            });
            if (!response.ok) { await response.body?.cancel(); throw new Error('Chromium target list unavailable'); }
            return await response.json();
          } catch (error) {
            signal?.throwIfAborted();
            throw new BrowserTransportError('读取 Chromium 调试目标失败', {
              cause: error,
              stage: BROWSER_STAGES.CDP_NOT_READY,
              retryable: false,
            });
          }
        };
        try {
          return await run({ list, profile, dedicated: Boolean(dedicated), browserUrl: activeBrowserUrl, pid: edge.pid });
        } finally {
          // For dedicated profiles, ask Chromium to close cleanly and wait for its process &
          // NetworkService SQLite cookie store to flush to disk before ever forcing termination.
          if (dedicated && activeBrowserUrl && edge.exitCode === null && edge.signalCode === null) {
            let closedViaCdp = false;
            for (let closeTry = 0; closeTry < 2 && !closedViaCdp && edge.exitCode === null && edge.signalCode === null; closeTry++) {
              try {
                const browserCdp = await connectCdp(activeBrowserUrl, AbortSignal.timeout(5000));
                try {
                  await browserCdp.send('Browser.close').catch(() => {});
                  closedViaCdp = true;
                } finally {
                  browserCdp.close();
                }
              } catch {
                if (closeTry === 0) await sleep(200);
              }
            }
            await Promise.race([edgeExited, sleep(10_000)]);
            if (edge.exitCode === null && edge.signalCode === null) {
              if (process.platform === 'win32') {
                await exec('taskkill.exe', ['/PID', String(edge.pid)], { windowsHide: true, timeout: 4000 }).catch(() => {});
                await Promise.race([edgeExited, sleep(4000)]);
              } else {
                try { process.kill(-edge.pid, 'SIGTERM'); } catch {}
                await Promise.race([edgeExited, sleep(4000)]);
              }
            }
          }
        }
      }
      await sleep(100, undefined, { signal });
    }
    throw new BrowserTransportError('Chromium 调试端口启动超时', {
      stage: BROWSER_STAGES.CDP_NOT_READY,
      stderrTail: stderrBuf.trim().slice(-600),
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  } finally {
    if (edge?.pid && edge.exitCode === null && edge.signalCode === null) {
      if (process.platform === 'win32') {
        await exec('taskkill.exe', ['/PID', String(edge.pid), '/F', '/T'], { windowsHide: true, timeout: 5000 }).catch(() => edge.kill());
      } else {
        try { process.kill(-edge.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    if (dedicated) {
      // Wait briefly for NetworkService SQLite cookie journal / WAL flush to settle (size === 0 or absent) before releasing lock.
      const settleDeadline = Date.now() + 2500;
      const cookieJournals = [
        path.join(profile, 'Default', 'Network', 'Cookies-journal'),
        path.join(profile, 'Default', 'Network', 'Cookies-wal'),
        path.join(profile, 'Default', 'Cookies-journal'),
      ];
      while (Date.now() < settleDeadline) {
        const pendingBytes = await Promise.all(cookieJournals.map(p => stat(p).then(s => s.size > 0, () => false)));
        if (!pendingBytes.some(Boolean)) break;
        await sleep(80);
      }
      await rm(path.join(profile, 'DevToolsActivePort'), { force: true }).catch(() => {});
      await dedicated.release();
    } else {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  }
}
