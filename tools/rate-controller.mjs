import { setTimeout as sleep } from 'node:timers/promises';

const MAX_HOSTS = 256;
const hostStates = new Map();
let globalBandwidthLimit = 0; // bytes/sec, 0 = unlimited
let windowStart = Date.now();
let windowBytes = 0;

export const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'EAI_NODATA',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isTransientNetworkError(error) {
  if (!error) return false;
  const code = error.code || error.cause?.code;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if (error instanceof TypeError && /fetch failed|network|socket/i.test(error.message || '')) return true;
  return false;
}

function getHostState(host, initialCwnd = 8) {
  let state = hostStates.get(host);
  if (!state) {
    if (hostStates.size >= MAX_HOSTS) hostStates.delete(hostStates.keys().next().value);
    const cap = Math.max(1, Math.min(12, Number(initialCwnd) || 8));
    state = {
      host,
      cwnd: cap,
      maxCwnd: cap,
      minCwnd: 1,
      active: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      throttles: 0,
      retryUntil: 0,
      avgLatencyMs: 0,
      totalBytes: 0,
      lastUpdatedAt: Date.now(),
    };
    hostStates.set(host, state);
  }
  return state;
}

export function setBandwidthLimit(bytesPerSec = 0) {
  globalBandwidthLimit = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? Math.floor(bytesPerSec) : 0;
}

export function getBandwidthLimit() {
  return globalBandwidthLimit;
}

export function recommendedConcurrencyForHost(host, requested = 8) {
  const cap = Math.max(1, Math.min(12, Number(requested) || 8));
  const state = getHostState(host, cap);
  if (state.throttles === 0 && state.failures === 0 && state.cwnd < cap) {
    state.cwnd = cap;
  }
  state.maxCwnd = cap;
  return Math.max(state.minCwnd, Math.min(cap, Math.floor(state.cwnd)));
}

export function checkHostBackoff(host) {
  const state = hostStates.get(host);
  if (!state) return 0;
  const remainingMs = state.retryUntil - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export function recordHostSuccess(host, { latencyMs = 0, bytes = 0 } = {}) {
  const state = getHostState(host);
  state.successes++;
  state.consecutiveFailures = 0;
  state.totalBytes += Math.max(0, bytes);
  if (latencyMs > 0) {
    state.avgLatencyMs = state.avgLatencyMs ? Math.round(state.avgLatencyMs * 0.8 + latencyMs * 0.2) : Math.round(latencyMs);
  }
  // AIMD additive increase: smooth growth up to maxCwnd when latency stays healthy.
  if (latencyMs < 4000 && state.cwnd < state.maxCwnd) {
    state.cwnd = Math.min(state.maxCwnd, state.cwnd + 0.25);
  }
  state.lastUpdatedAt = Date.now();
}

export function recordHostThrottle(host, retryAfterSec = 5) {
  const state = getHostState(host);
  state.throttles++;
  state.cwnd = Math.max(state.minCwnd, Math.floor(state.cwnd / 2));
  const waitSec = Math.max(1, Math.min(120, Number(retryAfterSec) || 5));
  state.retryUntil = Math.max(state.retryUntil, Date.now() + waitSec * 1000);
  state.lastUpdatedAt = Date.now();
  return Math.ceil((state.retryUntil - Date.now()) / 1000);
}

export function recordHostFailure(host) {
  const state = getHostState(host);
  state.failures++;
  state.consecutiveFailures++;
  // Only cut concurrency after repeated consecutive failures, not a single transient hiccup.
  if (state.consecutiveFailures >= 3) {
    state.cwnd = Math.max(state.minCwnd, Math.floor(state.cwnd * 0.7));
  }
  state.lastUpdatedAt = Date.now();
}

export async function paceBandwidth(bytes, signal) {
  if (!globalBandwidthLimit || !bytes) return;
  const now = Date.now();
  if (now - windowStart >= 1000) {
    windowStart = now;
    windowBytes = 0;
  }
  windowBytes += bytes;
  if (windowBytes > globalBandwidthLimit) {
    const waitMs = Math.min(1000, Math.ceil(((windowBytes - globalBandwidthLimit) / globalBandwidthLimit) * 1000));
    if (waitMs > 5) await sleep(waitMs, undefined, { signal });
  }
}

export function getRateTelemetry() {
  const mem = process.memoryUsage();
  return {
    bandwidthLimitBytesPerSec: globalBandwidthLimit,
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
    hosts: [...hostStates.values()].map(s => ({
      host: s.host,
      effectiveConcurrency: Math.max(s.minCwnd, Math.floor(s.cwnd)),
      maxConcurrency: s.maxCwnd,
      successes: s.successes,
      failures: s.failures,
      throttles: s.throttles,
      avgLatencyMs: s.avgLatencyMs,
      totalBytes: s.totalBytes,
      backoffSec: Math.max(0, Math.ceil((s.retryUntil - Date.now()) / 1000)),
    })),
  };
}

export function resetRateTelemetry() {
  hostStates.clear();
  globalBandwidthLimit = 0;
}
