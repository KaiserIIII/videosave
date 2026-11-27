import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import manifest from '../extension/manifest.json' with {type:'json'};
import { defaultConcurrency, maxConcurrency, validConcurrency } from '../extension/settings.mjs';
import { assessCandidates, detectionDiagnostic } from '../extension/detection.mjs';
import { audioFormats, canUseMediaTitle, classify, isPlaylist, longestFirst, platformVideo, primaryCandidates, selectPageStream } from '../extension/media.mjs';
import { checkManifestProtection, hlsQualities, prefetchHls } from './hls-prefetch.mjs';
import { prefetchRanges } from './range-prefetch.mjs';
import { dashQualities, localDashRequest, prefetchDash } from './dash-prefetch.mjs';
import { ApiError, FFMPEG, discover, inspectOutput, mediaInput, mediaUrl, parseCookies, parseMediaHeaders, probeStream, runMedia, streamExpiry } from './media-source.mjs';
import { assertSandboxPath, getSettingsFile, readPreferences, writePreferences } from './preferences.mjs';
import { claimBatch, claimInterruptedCancellation, completedStatus, pendingItem, storeBatch, storedBatch, storedBatches } from './download-history.mjs';
import { platformDownloadsEnabled, probePlatform, stagePlatform } from './platform-downloads.mjs';
import { preferredProbeStrategy, probeModes, probePlan, recordCompatibility } from './compatibility-policy.mjs';
import { createRequestContext } from './request-context.mjs';
import { legacyQualityCap, normalizeQualitySpec } from './quality-negotiator.mjs';
import { detectAvailableBrowsers } from './edge-session.mjs';
import { getBrowserSessionStatus, recordDedicatedOrigin, resetBrowserSession } from './browser-sessions.mjs';
import { importCookieSession, listCookieSessions, resolveCookieSession, revokeCookieSession } from './cookie-store.mjs';
import { streamlinkAvailable } from './streamlink-adapter.mjs';
import { networkPreferences } from './media-proxy.mjs';

export { ApiError, platformDownloadsEnabled, getBrowserSessionStatus, resetBrowserSession, importCookieSession, listCookieSessions, revokeCookieSession };
export const VERSION = manifest.version_name ?? manifest.version;

function defaultDownloads() {
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const value = output.match(/REG_\w+\s+(.+?)\s*$/m)?.[1];
    if (value) return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
  } catch {}
  return path.join(os.homedir(), 'Downloads');
}

export function getDefaultOutDir() {
  const dir = path.resolve(process.env.OUT_DIR || defaultDownloads());
  return assertSandboxPath(dir, 'download output directory');
}

export const OUT_DIR = path.resolve(process.env.OUT_DIR || defaultDownloads());
const defaultOutput = () => ({outDir:getDefaultOutDir(), format:'mp4', mode:'combined', quality:null, audioFormat:'m4a',
  subtitles:false, fastStart:true, concurrency:defaultConcurrency, connections:8});

export function getSettings({scope = 'download'} = {}) {
  const saved = readPreferences(scope);
  if (scope === 'download') {
    const merged = {...defaultOutput(), ...saved};
    merged.outDir = assertSandboxPath(merged.outDir, 'download output directory');
    return {scope, settings:merged};
  }
  return {scope, settings:saved};
}

export function updateSettings({scope = 'download', settings} = {}) {
  const saved = writePreferences(scope, settings);
  if (scope === 'download') {
    const merged = {...defaultOutput(), ...saved};
    merged.outDir = assertSandboxPath(merged.outDir, 'download output directory');
    return {scope, settings:merged};
  }
  return {scope, settings:saved};
}

export async function getVersionInfo() {
  let installedVersion = VERSION;
  try {
    const diskManifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
    installedVersion = diskManifest.version_name ?? diskManifest.version;
  } catch {}
  const versionMismatch = installedVersion !== VERSION;
  return {
    version: VERSION,
    browserVersion: manifest.version,
    installedVersion,
    versionMismatch,
    mismatch: versionMismatch,
    entry: fileURLToPath(new URL('./mcp-server.mjs', import.meta.url)),
    ...(versionMismatch && {
      staleProcessWarning: `Running MCP process (${VERSION}) differs from installed package (${installedVersion}). Restart the MCP client or companion process to load the updated tools.`,
    }),
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    settingsFile: getSettingsFile(),
  };
}

export function getEngineCapabilities() {
  return {
    version: VERSION,
    observation: 'isolated-chromium-cdp',
    browsers: detectAvailableBrowsers(),
    ffmpeg: { available: true, bin: FFMPEG },
    transfer: ['http', 'hls', 'dash-static', ...(platformDownloadsEnabled() ? ['yt-dlp'] : []), ...(streamlinkAvailable() ? ['streamlink'] : [])],
    processing: ['ffmpeg', 'ffprobe'],
    features: {
      unifiedRequestContext: true,
      hlsHeadersConsistent: true,
      nonstandardSegmentSniffing: true,
      aes128Hls: true,
      hlsSubtitles: true,
      hlsResume: true,
      rangeResume: true,
      dashStatic: true,
      dashResume: true,
      boundedRefresh: true,
      dedicatedBrowserSessions: true,
      cookieFileImport: true,
      netscapeCookieFile: true,
      smartQualityNegotiation: true,
      platformDownloads: platformDownloadsEnabled(),
      streamlinkFallback: streamlinkAvailable(),
    },
  };
}

export function getEffectiveSettings() {
  const download = getSettings({ scope: 'download' }).settings;
  const network = networkPreferences();
  return {
    version: VERSION,
    download,
    network: {
      configured: network.configured.mode,
      effective: network.effective.mode,
      restartRequired: network.restartRequired,
    },
  };
}

const session = new AbortController();
const workQueue = [];
let runningDownloads = 0;
let runningProbes = 0;
let runningPreviews = 0;
const batches = new Map();
const batchKeys = new Map();
const mediaHeaders = new Map();

function rememberMediaHeaders(source, headers) {
  mediaHeaders.delete(source);
  if (mediaHeaders.size >= 240) mediaHeaders.delete(mediaHeaders.keys().next().value);
  mediaHeaders.set(source,{headers,until:Date.now() + 15 * 60_000});
}

function capturedHeaders(source) {
  const entry = mediaHeaders.get(source);
  if (!entry) return {};
  if (entry.until > Date.now()) return entry.headers;
  mediaHeaders.delete(source);
  return {};
}

function pump() {
  while (workQueue.length) {
    const next = workQueue.findIndex(job => job.signal.aborted || (job.batch
      ? !job.batch.paused && runningDownloads < maxConcurrency && job.batch.running < job.batch.concurrency
      : runningProbes < 2));
    if (next < 0) return;
    const [{ signal, run, resolve, reject, batch }] = workQueue.splice(next, 1);
    if (signal.aborted) { reject(signal.reason); continue; }
    if (batch) {
      runningDownloads += 1;
      batch.running += 1;
    } else runningProbes += 1;
    Promise.resolve().then(run).then(resolve, reject).finally(() => {
      if (batch) {
        runningDownloads -= 1;
        batch.running -= 1;
      } else runningProbes -= 1;
      pump();
    });
  }
}

function schedule(signal, run, batch) {
  return new Promise((resolve, reject) => {
    workQueue.push({ signal, run, resolve, reject, batch });
    pump();
  });
}

export function shutdown() {
  session.abort();
  for (const batch of batches.values()) void releaseFiles(batch.id);
  pump();
}

export function errorDetails(error) {
  return error instanceof ApiError ? {code:error.code,message:error.message,...(error.detail && {detail:error.detail})}
    : { code: 'INTERNAL', message: '本地媒体工具执行失败' };
}

function validateSafeIdPattern(pattern) {
  if (pattern === undefined) return undefined;
  if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 128 || /[\x00-\x1f]/.test(pattern)) {
    throw new ApiError('INVALID_ID_PATTERN', 'idPattern 必须为不超过 128 字符的有效正则表达式');
  }
  if (/\([^)]*[+*][^)]*\)[+*{]|(\+\+|\*\*|\{\d+,\d*\}[+*])/.test(pattern)) {
    throw new ApiError('INVALID_ID_PATTERN', 'idPattern 不允许嵌套量词表达式');
  }
  try { new RegExp(pattern, 'g'); }
  catch { throw new ApiError('INVALID_ID_PATTERN', 'idPattern 正则表达式语法无效'); }
  return pattern;
}

function validateUrlTemplate(template, placeholderNames = ['code', 'id']) {
  if (template === undefined) return undefined;
  if (typeof template !== 'string' || template.length > 2048 || /[\x00-\x1f]/.test(template)) {
    throw new ApiError('INVALID_CODE_TEMPLATE', 'Include one {code} or {id} placeholder in an HTTP(S) URL template');
  }
  const found = placeholderNames.filter(name => template.includes(`{${name}}`));
  if (found.length !== 1) {
    throw new ApiError('INVALID_CODE_TEMPLATE', 'Include one {code} or {id} placeholder in an HTTP(S) URL template');
  }
  const token = `{${found[0]}}`;
  const marker = 'videosave-reference-placeholder';
  if (template.split(token).length !== 2 || template.includes(marker)) {
    throw new ApiError('INVALID_CODE_TEMPLATE', 'Include one {code} or {id} placeholder in an HTTP(S) URL template');
  }
  const parsed = mediaUrl(template.replace(token, marker));
  if (!parsed.pathname.includes(marker) && !parsed.search.includes(marker)) {
    throw new ApiError('INVALID_CODE_TEMPLATE', 'Placeholder must appear in the URL path or query');
  }
  return { template, token };
}

function validateProbeProxy(networkMode, proxy) {
  if (networkMode !== undefined && !['environment', 'direct', 'http'].includes(networkMode)) {
    throw new ApiError('INVALID_NETWORK_SETTINGS', 'networkMode 应为 environment、direct 或 http');
  }
  if (proxy !== undefined) {
    if (typeof proxy !== 'string' || !/^http:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d{1,5})?\/?$/i.test(proxy)) {
      throw new ApiError('INVALID_NETWORK_SETTINGS', 'proxy 应为不含凭据的 http://host:port 地址');
    }
    const parsed = URL.parse(proxy);
    if (!parsed || parsed.port === '0') throw new ApiError('INVALID_NETWORK_SETTINGS', 'proxy 地址无效');
    return { networkMode: networkMode ?? 'http', proxy: parsed.origin };
  }
  if (networkMode === 'http') {
    throw new ApiError('INVALID_NETWORK_SETTINGS', 'networkMode 为 http 时必须提供 proxy 地址');
  }
  return { networkMode, proxy: undefined };
}

async function inspectPage(url, cookies, signal, {
  selectionOnly = false, waitMs = 20_000, retries = 2, includeText = false,
  clickPlay = false, captureXhrBody = true, includeFrames = true, mode = 'headless', singleWindow = false,
  harvestCodes = false, idPattern, urlTemplate,
  compatibility = 'standard', learn = false,
  userAgent, browser = 'auto', browserBinary, browserSessionId, profileMode = 'ephemeral',
  networkMode, proxy, timeoutBudget, extraHeaders = {},
} = {}) {
  const started = performance.now();
  const stagedProbe = ['maximum','adaptive'].includes(compatibility);
  let preferred;
  if (compatibility === 'adaptive' || stagedProbe && learn) {
    try { preferred = preferredProbeStrategy(url.origin); } catch { /* Local history is optional for probing. */ }
  }
  const plan = probePlan(compatibility,{waitMs,retries,singleWindow,preferred});
  let result;
  let stage;
  let attempts = 0;
  for (const {waitMs,deep} of plan) {
    attempts++;
    stage = deep ? 'deep' : 'standard';
    result = await discover(url, cookies, signal, {waitMs, includeText, clickPlay,
      captureXhrBody:captureXhrBody || deep, includeFrames:includeFrames || deep, mode, harvestCodes, idPattern,
      userAgent, browser, browserBinary, browserSessionId, profileMode, networkMode, proxy, timeoutBudget,
      onMediaHeaders:rememberMediaHeaders}).catch(error => {
      signal.throwIfAborted();
      if (/timed out|超时/i.test(error.message)) return {pageTitle:null,pageContext:null,streams:[],pages:[],candidates:[],reason:'timeout'};
      if (error instanceof ApiError) throw error;
      throw new ApiError('PAGE_FAILED', error.message?.includes('browserBinary') || error.message?.includes('找不到') ? error.message : '隔离浏览器探测失败', 502);
    });
    if (result.streams.length || result.reason === 'blocked' || !stagedProbe && result.candidates.length && result.reason === 'no-player') break;
  }
  if (profileMode === 'dedicated' && browserSessionId) {
    await recordDedicatedOrigin(browserSessionId, url.origin).catch(() => {});
  }
  const protectedUrls = new Set();
  const pending = selectionOnly ? [...new Set([...primaryCandidates(result.streams),
    ...result.streams.filter(stream => isPlaylist(stream.kind))])] : [...result.streams];
  const inspectMetadata = !selectionOnly || pending.length > 1;
  if (pending.length) {
    const budget = AbortSignal.timeout(compatibility === 'fast' ? 2000 : compatibility === 'standard' ? 45_000 : 12_000);
    const metadataSignal = AbortSignal.any([signal,budget]);
    await Promise.all(Array.from({length:Math.min(4, pending.length)}, async () => {
      while (pending.length && !budget.aborted) {
        signal.throwIfAborted();
        const stream = pending.shift();
        const source = mediaUrl(stream.url);
        const scopedCookies = source.origin === url.origin ? cookies : [];
        const headers = {...capturedHeaders(source.href), ...extraHeaders, ...(userAgent && {'User-Agent':userAgent})};
        if (isPlaylist(stream.kind)) {
          try {
            await checkManifestProtection(source,scopedCookies,metadataSignal,{kind:stream.kind,headers});
          } catch (error) {
            signal.throwIfAborted();
            if (budget.aborted) return;
            if (error.code === 'DRM') {
              protectedUrls.add(stream.url);
              continue;
            }
            if (error instanceof ApiError) continue;
            throw error;
          }
        }
        if (!inspectMetadata) continue;
        const [info, quality] = await Promise.all([
          probeStream(source, scopedCookies, metadataSignal, false, stream.kind, headers),
          !selectionOnly && stream.kind === 'm3u8'
            ? hlsQualities(source, scopedCookies, metadataSignal, headers)
            : !selectionOnly && stream.kind === 'mpd'
              ? dashQualities(source, scopedCookies, metadataSignal, headers)
              : null,
        ]).catch(error => {
          signal.throwIfAborted();
          if (budget.aborted) return [{},null];
          throw error;
        });
        if (quality?.length) {
          stream.qualities = quality.map(({height,bandwidth,url,codecs,frameRate,hdr,audioTracks,subtitleTracks}) => ({
            height,bandwidth,url,
            ...(codecs && {codecs}),...(frameRate && {frameRate}),...(hdr && {hdr}),
            ...(audioTracks?.length && {audioTracks}),...(subtitleTracks?.length && {subtitleTracks}),
          }));
          stream.quality = quality.map(({height,bitrate,url}) => ({height,bitrate,url}));
        }
        const hasObservedSize = stream.size != null;
        for (const [key, value] of Object.entries(info)) {
          if (value != null && (!['size','sizeEstimated'].includes(key) || !hasObservedSize)) stream[key] = value;
        }
        if (stream.mediaTitle && canUseMediaTitle(stream.titleSource)) {
          stream.title = stream.mediaTitle;
          stream.titleSource = 'media-tag';
        }
      }
    }));
  }
  if (protectedUrls.size) {
    result.streams = result.streams.filter(stream => !protectedUrls.has(stream.url));
    result.blockers = [...new Set(['drm',...(result.blockers ?? [])])];
    if (!result.streams.length) result.reason = 'blocked';
  }
  result.streams.sort(longestFirst);
  if (!selectionOnly) {
    const players = Map.groupBy(result.streams.filter(stream => stream.player), stream => stream.player.id);
    for (const sources of players.values()) {
      if (sources.length < 2) continue;
      const quality = sources.filter(stream => stream.height).map(stream => ({
        height:stream.height, bitrate:stream.bitrate ?? null, url:stream.url,
      })).sort((a,b) => b.height - a.height || b.bitrate - a.bitrate);
      if (quality.length > 1) for (const stream of sources) stream.quality ??= quality;
    }
  }
  const {reason,...page} = result;
  for (const stream of page.streams) Object.assign(stream,assessCandidates([stream])[0]);
  const selection = selectPageStream(page.streams);
  if (selection.status === 'unavailable') selection.reason = reason;
  const qualities = page.streams.find(stream => stream.url === selection.url)?.qualities ?? [];
  const harvestedUrls = harvestCodes && urlTemplate && page.codes?.length
    ? page.codes.map(code => ({ id: code, url: urlTemplate.template.replace(urlTemplate.token, encodeURIComponent(code)) }))
    : undefined;
  if (learn) {
    try { recordCompatibility(url,{stage,success:page.streams.length > 0,elapsedMs:performance.now()-started,kind:page.streams[0]?.kind}); }
    catch { /* Learning must not stop an otherwise successful probe. */ }
  }
  return {
    ...page,
    ...(compatibility !== 'standard' && {probeStrategy:{stage,attempts}}),
    ...(harvestCodes && {codes:page.codes ?? []}),
    ...(harvestedUrls && {generatedPages:harvestedUrls, resolvedUrls:harvestedUrls.map(h => h.url)}),
    ...(profileMode === 'dedicated' && browserSessionId && {browserSession:{id:browserSessionId,browserSessionId,profileMode:'dedicated'}}),
    qualities,
    selection,
    diagnostic:detectionDiagnostic({
      ...page.diagnostic, streams:page.streams, blockers:page.blockers, selection, reason,
    }),
  };
}

export async function probe({
  url: value, cookie, cookieSessionId, waitMs = 20_000, waitForMediaMs, retries = waitForMediaMs === undefined ? 2 : 0, includeText = false,
  compatibility = 'standard', learnCompatibility = false,
  clickPlay = false, captureXhrBody = false, includeFrames = false, harvestCodes = false, idPattern, urlTemplate,
  mode = 'headless', profile, useBrowserCookies, profileDir,
  userAgent, browser = 'auto', browserBinary, browserSessionId, profileMode = 'ephemeral',
  networkMode, proxy, timeoutBudget,
} = {}, requestSignal) {
  const url = mediaUrl(value);
  if (!probeModes.includes(compatibility) || typeof learnCompatibility !== 'boolean') {
    throw new ApiError('INVALID_COMPATIBILITY','Choose a supported probe mode');
  }
  const cookies = cookieSessionId ? resolveCookieSession(cookieSessionId, url) : parseCookies(cookie);
  if (!Number.isInteger(waitMs) || waitMs < 100 || waitMs > 30_000) {
    throw new ApiError('INVALID_WAIT', 'waitMs 必须为 100–30000 毫秒');
  }
  if (waitForMediaMs !== undefined && (!Number.isInteger(waitForMediaMs) || waitForMediaMs < 100 || waitForMediaMs > 60_000)) {
    throw new ApiError('INVALID_WAIT', 'waitForMediaMs 必须为 100–60000 毫秒');
  }
  if (timeoutBudget !== undefined && (!Number.isInteger(timeoutBudget) || timeoutBudget < 1000 || timeoutBudget > 180_000)) {
    throw new ApiError('INVALID_TIMEOUT', 'timeoutBudget 必须为 1000–180000 毫秒');
  }
  if (!['headless','headed'].includes(mode)) throw new ApiError('INVALID_MODE', '浏览器模式应为 headless 或 headed');
  if (profileDir !== undefined || profile !== undefined && profile !== 'fresh' ||
      useBrowserCookies !== undefined && useBrowserCookies !== false) {
    throw new ApiError('BROWSER_SESSION_UNAVAILABLE', '探测禁止直接读取系统浏览器目录或凭据，请使用 profileMode:"dedicated" 与 browserSessionId 管理专用独立会话');
  }
  if (!['auto','edge','chrome','brave'].includes(browser)) {
    throw new ApiError('INVALID_BROWSER', 'browser 应为 auto、edge、chrome 或 brave');
  }
  if (!['ephemeral','dedicated'].includes(profileMode)) {
    throw new ApiError('INVALID_BROWSER_SESSION', 'profileMode 应为 ephemeral 或 dedicated');
  }
  if (profileMode === 'dedicated' && !browserSessionId) {
    throw new ApiError('INVALID_BROWSER_SESSION', 'dedicated 模式需要指定 browserSessionId');
  }
  if (userAgent !== undefined) parseMediaHeaders({'User-Agent':userAgent});
  const safeIdPattern = validateSafeIdPattern(idPattern);
  const parsedTemplate = validateUrlTemplate(urlTemplate);
  const net = validateProbeProxy(networkMode, proxy);
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
    throw new ApiError('INVALID_RETRIES', 'retries 必须为 0–2');
  }
  if (typeof includeText !== 'boolean') throw new ApiError('INVALID_INCLUDE_TEXT', 'includeText 必须为布尔值');
  if (typeof harvestCodes !== 'boolean') throw new ApiError('INVALID_HARVEST_CODES','harvestCodes 必须为布尔值');
  if (typeof clickPlay !== 'boolean') throw new ApiError('INVALID_CLICK_PLAY', 'clickPlay 必须为布尔值');
  if (typeof captureXhrBody !== 'boolean') throw new ApiError('INVALID_CAPTURE_XHR', 'captureXhrBody 必须为布尔值');
  if (typeof includeFrames !== 'boolean') throw new ApiError('INVALID_INCLUDE_FRAMES', 'includeFrames 必须为布尔值');
  const signal = requestSignal ? AbortSignal.any([session.signal,requestSignal]) : session.signal;
  signal.throwIfAborted();
  return schedule(signal, async () => {
    signal.throwIfAborted();
    const platform = platformVideo(url);
    if (platform && platformDownloadsEnabled()) {
      const target = await probePlatform(platform, signal);
      return {pageTitle:target.title, pageContext:{url:target.url,untrusted:true}, streams:[], pages:[], candidates:[],
        downloadTargets:[target], qualities:[],...(harvestCodes && {codes:[]}),selection:{status:'selected',url:target.url,reason:'platform'},
        diagnostic:detectionDiagnostic({streams:[target]})};
    }
    const maximum = compatibility === 'maximum';
    return inspectPage(url, cookies, signal, {waitMs:waitForMediaMs ?? (maximum && waitMs === 20_000 ? 30_000 : waitMs),
      retries,includeText,clickPlay,captureXhrBody,includeFrames,mode,harvestCodes,idPattern:safeIdPattern,urlTemplate:parsedTemplate,
      singleWindow:waitForMediaMs !== undefined,compatibility,learn:learnCompatibility,
      userAgent:userAgent?.trim(),browser,browserBinary,browserSessionId,profileMode,networkMode:net.networkMode,proxy:net.proxy,timeoutBudget});
  });
}

export async function preview({url: value, seconds = 6}, requestSignal) {
  const url = mediaUrl(value);
  if (![3,6,10].includes(seconds)) throw new ApiError('INVALID_PREVIEW_DURATION', '预览时长可设为 3、6 或 10 秒');
  if (runningPreviews >= 2) throw new ApiError('PREVIEW_BUSY', '本机服务正在生成预览，请稍后再试', 429);
  const signal = AbortSignal.any([requestSignal, session.signal, AbortSignal.timeout(21000)]);
  const limit = 8 * 1024 * 1024;
  let staging;
  runningPreviews++;
  try {
    staging = await mkdtemp(path.join(os.tmpdir(), '.media-toolkit-preview-'));
    const file = path.join(staging, 'clip.mp4');
    await runMedia(FFMPEG, ['-hide_banner','-loglevel','error','-nostdin',
      ...mediaInput(url, [], undefined, '-i'), '-map','0:v:0','-an','-sn','-dn',
      '-t',String(seconds),'-vf',"scale=-2:'min(240,ih)',fps=16",'-threads','2',
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-fs',String(limit - 65536),'-movflags','+faststart',file], signal);
    const size = (await stat(file)).size;
    if (size <= 0 || size > limit) throw new ApiError('PREVIEW_FAILED', '预览文件超出大小限制', 502);
    return await readFile(file, {signal});
  } catch (error) {
    if (signal.aborted) throw new ApiError('PREVIEW_TIMED_OUT', '生成预览超时', 504);
    throw error;
  } finally {
    if (staging) await rm(staging, {recursive:true,force:true,maxRetries:5}).catch(() => {});
    runningPreviews--;
  }
}

export function isTerminal(status) {
  return ['done','partial','failed','cancelled'].includes(status);
}

function displayedStatus(batch) {
  return batch.status === 'running' && batch.paused ? 'paused' : batch.status;
}

function snapshot(batch) {
  const counts = {active:0,queued:0,failed:0};
  for (const item of batch.items) {
    if (item.status === 'error') counts.failed++;
    else if (item.status === 'queued') counts.queued++;
    else if (['resolving','downloading','verifying'].includes(item.status)) counts.active++;
  }
  return {id:batch.id,status:displayedStatus(batch),...counts,items:batch.items.map(item => ({...item})),
    log:[...batch.log],lastError:batch.lastError ?? null,...(batch.resumable && {resumable:true})};
}

function publish(batch, line) {
  if (line) {
    batch.log.push(line);
    if (batch.log.length > 5) batch.log.shift();
  }
  if (batch.listeners.size) {
    const current = snapshot(batch);
    for (const notify of batch.listeners) notify(current);
  }
}

const INTERRUPTED_CODES = new Set(['HLS_TRANSFER_INTERRUPTED', 'DASH_TRANSFER_INTERRUPTED', 'RANGE_TRANSFER_INTERRUPTED']);

function historyRecord(batch, status = batch.status) {
  const redact = detail => detail && {stderr:'',...(detail.status && {status:detail.status}),
    ...(detail.reason && {reason:detail.reason}), ...(detail.expiresAt && {expiresAt:detail.expiresAt}),
    ...(detail.hlsPhase && {hlsPhase:detail.hlsPhase}),
    ...(detail.phase && {phase:detail.phase}),
    ...(detail.platform && {platform:detail.platform}),
    ...(Number.isSafeInteger(detail.retryAfterSec) && {retryAfterSec:detail.retryAfterSec})};
  return {id:batch.id, status, outDir:batch.outDir, delivery:batch.delivery, createdAt:batch.createdAt,
    log:batch.log, itemKeys:batch.itemKeys, items:batch.items.map(item => {
      const recorded = item.detail ? {...item,detail:redact(item.detail)} : item;
      return ['running','interrupted'].includes(status) && INTERRUPTED_CODES.has(item.errorCode)
        ? {...recorded,status:'queued'} : recorded;
    }),
    lastError:batch.lastError && {...batch.lastError,detail:redact(batch.lastError.detail)}, retry:batch.retry, principal:batch.principal,
    ...(status === 'running' && batch.paused && {paused:true}), managedRetry:batch.managedRetry};
}

function savedBatch(id) {
  const batch = storedBatch(id);
  if (batch?.status !== 'interrupted') return batch;
  const message = '下载进程已中断，请重新提交原下载请求以继续';
  for (const item of batch.items.filter(pendingItem)) {
    const detail = {stderr:''};
    Object.assign(item,{status:'error',errorCode:item.errorCode ?? 'DOWNLOAD_INTERRUPTED',
      error:item.error ?? message,speed:0,etaSec:null,detail:item.detail ?? detail});
    batch.lastError = {idx:item.idx,code:item.errorCode,message,detail};
  }
  batch.status = batch.items.some(item => item.status === 'done') ? 'partial' : 'failed';
  batch.resumable = true;
  return batch;
}

function lookup(id) {
  const batch = batches.get(id) ?? (typeof id === 'string' ? savedBatch(id) : undefined);
  if (!batch) throw new ApiError('BATCH_NOT_FOUND', '找不到下载批次', 404);
  return batch;
}

export function progress(id) {
  return snapshot(lookup(id));
}

export function batchPrincipal(id) { return lookup(id).principal; }

export function batchAuthorizationId(id) { return lookup(id).managedRetry?.authorizationId; }

export function managedRetryPlan(id) {
  const batch = lookup(id);
  if (!isTerminal(batch.status)) throw new ApiError('BATCH_ACTIVE','Wait for the batch to stop or finish',409);
  const retryItems = batch.items.filter(item => ['error','cancelled'].includes(item.status));
  if (!retryItems.length) throw new ApiError('NOTHING_TO_RETRY','All downloads in this batch already finished',409);
  if (!batch.managedRetry) throw new ApiError('MCP_REAPPROVAL_REQUIRED','Start a new download from an approved tab',409);
  return {...batch.managedRetry,items:retryItems.map(item => batch.managedRetry.items[item.idx])};
}

async function checkedBatchOutput(batch,file) {
  const directory = await realpath(batch.outDir);
  const actual = await realpath(file);
  if (path.relative(directory,path.dirname(actual)) || !(await lstat(file)).isFile()) {
    throw new ApiError('INVALID_PATH','The saved output is outside its download directory');
  }
  return actual;
}

export async function verifyBatchFiles(id, signal) {
  const batch = lookup(id);
  const result = snapshot(batch);
  const budget = AbortSignal.any([signal,AbortSignal.timeout(25_000)]);
  for (const item of result.items) {
    item.verification = [];
    for (const output of item.outputs ?? []) {
      const {file,info} = output;
      try {
        budget.throwIfAborted();
        const actual = await checkedBatchOutput(batch,file);
        const current = await inspectOutput(actual,budget,/\.(mp3|m4a)$/i.test(file) ? 'audio' : 'video',info?.duration);
        const savedFields = ['size','audioCodec','codec','width','height','container','subtitleTracks'];
        if (!info || savedFields.some(key => info[key] !== undefined && info[key] !== current[key]) ||
            Math.abs(info.duration-current.duration) > 0.05) {
          throw new ApiError('OUTPUT_CHANGED','The output differs from its saved media properties',409);
        }
        item.verification.push({status:'verified',info:current});
      } catch (error) {
        signal.throwIfAborted();
        const errorCode = budget.aborted ? 'VERIFY_TIMEOUT' : error.code === 'ENOENT' ? 'FILE_NOT_FOUND' : errorDetails(error).code;
        item.verification.push({status:'error',errorCode});
      }
    }
  }
  result.ok = result.items.length > 0 && result.items.every(item =>
    item.verification?.length > 0 && item.verification.every(v => v.status === 'verified'));
  return result;
}

function knownBatches() {
  const all = new Map(storedBatches().map(batch => [batch.id,batch]));
  for (const [id,batch] of batches) all.set(id,batch);
  return all.values();
}

export function activeBatchCount(principal) {
  let count = 0;
  for (const batch of knownBatches()) {
    if (batch.principal === principal && ['running','cancelling'].includes(batch.status)) count++;
  }
  return count;
}

export function listBatches({limit = 20} = {}, principal) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('INVALID_LIMIT', 'limit must be 1–100');
  const items = [];
  for (const batch of knownBatches()) {
    if (principal !== undefined && batch.principal !== principal) continue;
    const interrupted = batch.status === 'interrupted';
    const completed = batch.items.filter(item => item.status === 'done').length;
    const status = interrupted ? (completed ? 'partial' : 'failed') : displayedStatus(batch);
    items.push({id:batch.id, status, delivery:batch.delivery, createdAt:batch.createdAt,
      ...((interrupted || batch.resumable) && {resumable:true}),
      total:batch.items.length, completed,
      failed:batch.items.filter(item => item.status === 'error' || interrupted && pendingItem(item)).length});
  }
  return {items:items.reverse().sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,limit)};
}

export function subscribe(id, notify) {
  const batch = lookup(id);
  if (!batch.listeners) {
    notify(snapshot(batch));
    if (isTerminal(batch.status)) return () => {};
    const timer = setInterval(() => {
      try {
        const current = lookup(id);
        if (isTerminal(current.status)) clearInterval(timer);
        notify(snapshot(current));
      } catch (error) {
        if (error.code !== 'BATCH_NOT_FOUND') return;
        clearInterval(timer);
        notify({...snapshot(batch),status:'failed'});
      }
    },250);
    timer.unref();
    return () => clearInterval(timer);
  }
  if (batch.status === 'running' || batch.status === 'cancelling') batch.listeners.add(notify);
  notify(snapshot(batch));
  return () => batch.listeners.delete(notify);
}

export function waitForBatch({id, timeoutMs = 30_000} = {}, signal = session.signal) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ApiError('INVALID_TIMEOUT', 'timeoutMs must be an integer from 1 to 60000');
  }
  const batch = lookup(id);
  const terminal = () => isTerminal(batch.status);
  signal.throwIfAborted();
  if (terminal()) return {...snapshot(batch), timedOut:false};
  if (!batch.listeners) return waitForStoredBatch(id,timeoutMs,signal);
  return new Promise((resolve, reject) => {
    const complete = current => {
      if (!terminal()) return;
      cleanup();
      resolve({...current, timedOut:false});
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve({...snapshot(batch), timedOut:true});
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timeout);
      batch.listeners.delete(complete);
      signal.removeEventListener('abort', abort);
    }
    batch.listeners.add(complete);
    signal.addEventListener('abort', abort, {once:true});
  });
}

async function waitForStoredBatch(id, timeoutMs, signal) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const batch = lookup(id);
    const terminal = isTerminal(batch.status);
    const remaining = deadline - performance.now();
    if (terminal || remaining <= 0) return {...snapshot(batch),timedOut:!terminal};
    await sleep(Math.min(250, remaining),undefined,{signal});
  }
}

export function diagnoseDownload(id) {
  const batch = lookup(id);
  const current = snapshot(batch);
  const itemReports = current.items.map(item => {
    let category = 'ok';
    let nextAction = 'No action required.';
    if (item.status === 'error') {
      const code = item.errorCode || 'MEDIA_FAILED';
      if (code === 'MEDIA_ACCESS_RESTRICTED' || code === 'MCP_MEDIA_ACCESS_RESTRICTED') {
        category = 'access-denied';
        nextAction = `Media host rejected the request at ${item.detail?.hlsPhase ?? item.detail?.phase ?? 'transfer'} (HTTP ${item.detail?.status ?? 403}). Verify authorized login/session or playback headers in the browser; VideoSave will not bypass access restrictions.`;
      } else if (code === 'STREAM_EXPIRED' || code === 'SESSION_EXPIRED') {
        category = 'expired';
        nextAction = 'Re-probe the original authorized page to obtain a fresh signed URL or renew the session.';
      } else if (INTERRUPTED_CODES.has(code) || code === 'DOWNLOAD_INTERRUPTED') {
        category = 'interrupted-resumable';
        nextAction = 'Resubmit the original request (with the same options/cookie) to resume from verified checkpoints.';
      } else if (code === 'INVALID_HLS_SEGMENT' || code === 'INVALID_DASH_SEGMENT' || code === 'INVALID_MEDIA_CONTENT') {
        category = 'invalid-media-payload';
        nextAction = 'The server returned non-media or corrupted content (e.g. HTML/JSON error or image) instead of valid media segments.';
      } else if (code === 'DRM') {
        category = 'drm-protected';
        nextAction = 'This stream uses DRM protection and cannot be downloaded.';
      } else if (code === 'NO_SPACE') {
        category = 'disk-space';
        nextAction = 'Free disk space on the output volume or configure a different outDir.';
      } else if (code === 'QUALITY_UNAVAILABLE') {
        category = 'quality-mismatch';
        nextAction = 'Choose an available quality or set quality fallback to lower/closest.';
      } else {
        category = 'transfer-error';
        nextAction = 'Inspect detail.status and retry the batch or verify the media source.';
      }
    } else if (item.status === 'cancelled') {
      category = 'cancelled';
      nextAction = 'Task was cancelled by user or caller.';
    } else if (item.status !== 'done') {
      category = 'in-progress';
      nextAction = 'Call wait_for_download or get_progress to track completion.';
    }
    return {
      idx: item.idx,
      status: item.status,
      phase: item.phase ?? item.status,
      engine: item.engine ?? null,
      fallbackReason: item.prefetchFallback?.reason ?? null,
      errorCode: item.errorCode ?? null,
      detail: item.detail ?? null,
      resumable: Boolean(current.resumable || INTERRUPTED_CODES.has(item.errorCode)),
      retryable: Boolean(item.status === 'error' && ['interrupted-resumable', 'expired', 'transfer-error'].includes(category)),
      category,
      nextAction,
    };
  });
  return {
    id: current.id,
    status: current.status,
    resumable: Boolean(current.resumable),
    lastError: current.lastError,
    items: itemReports,
  };
}

export function cancel(id, options) {
  const batch = lookup(id);
  const itemIndex = options && typeof options === 'object' ? options.itemIndex : undefined;
  if (itemIndex !== undefined) {
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= batch.items.length) {
      throw new ApiError('INVALID_ITEM_INDEX', '任务索引超出批次范围');
    }
    if (!batch.controller) throw new ApiError('BATCH_OTHER_PROCESS', '请在提交批次的下载进程取消单个任务', 409);
    const controller = batch.itemControllers?.[itemIndex];
    const item = batch.items[itemIndex];
    if (controller && pendingItem(item)) {
      controller.abort(new DOMException('Single item cancelled', 'AbortError'));
      if (item.status === 'queued') {
        item.status = 'cancelled';
        item.phase = 'cancelled';
      }
      if (batch.delivery === 'local' && !batch.private) storeBatch(historyRecord(batch));
      publish(batch, `[${itemIndex + 1}] 正在取消单项任务`);
      pump();
    }
    return { ok: true, itemIndex };
  }
  if (batch.resumable) return cancelInterrupted(id);
  if (batch.status === 'running' && !batch.controller) {
    throw new ApiError('BATCH_OTHER_PROCESS','请在提交批次的下载进程取消',409);
  }
  if (batch.status === 'running') {
    batch.status = 'cancelling';
    batch.controller.abort();
    if (batch.delivery === 'local' && !batch.private) storeBatch(historyRecord(batch));
    publish(batch, '正在取消');
    pump();
  }
  return { ok: true };
}

export function setBatchPaused(id, paused) {
  const batch = lookup(id);
  if (batch.status !== 'running') throw new ApiError('BATCH_INACTIVE','This batch is no longer running',409);
  if (!batch.controller) throw new ApiError('BATCH_OTHER_PROCESS','Control this batch in the download process that submitted it',409);
  if (Boolean(batch.paused) === paused) return {ok:true};
  if (batch.delivery === 'local' && !batch.private) storeBatch(historyRecord({...batch,paused}));
  batch.paused = paused;
  publish(batch, paused ? '已暂停后续队列任务' : '已恢复队列任务');
  if (!paused) pump();
  return {ok:true};
}

function stagingRoot(outDir, id, index) {
  return path.join(outDir,`.media-toolkit-${id}-${index}`);
}

async function cancelInterrupted(id) {
  const batch = claimInterruptedCancellation(id);
  if (!batch) throw new ApiError('BATCH_ACTIVE','下载批次已由另一个进程接管',409);
  const pending = batch.items.filter(pendingItem);
  try {
    await Promise.all(pending.map(item => rm(stagingRoot(batch.outDir,id,item.idx),{recursive:true,force:true,maxRetries:5})));
  } catch (error) {
    storeBatch(historyRecord(batch,'interrupted'));
    throw error;
  }
  for (const item of pending) Object.assign(item,{status:'cancelled',speed:0,etaSec:null});
  storeBatch(historyRecord(batch,'cancelled'));
  if (batches.get(id)?.resumable) batches.delete(id);
  return {ok:true};
}

function getTargets(values, defaults) {
  if (!Array.isArray(values) || !values.length) {
    throw new ApiError('INVALID_ITEMS', '请添加至少一个媒体目标');
  }
  return values.map(value => {
    const kind = value?.kind === undefined && platformVideo(value?.url) ? 'page' : value?.kind;
    if (!['page', 'stream'].includes(kind)) throw new ApiError('INVALID_KIND', 'kind 必须为 page 或 stream');
    if (value.title !== undefined && typeof value.title !== 'string') throw new ApiError('INVALID_TITLE', '标题必须是文本');
    if (value.format !== undefined && !['mp4', 'mkv'].includes(value.format)) {
      throw new ApiError('INVALID_FORMAT', '输出格式应为 mp4 或 mkv');
    }
    if (value.mode !== undefined && !['combined', 'video', 'audio', 'separate'].includes(value.mode)) {
      throw new ApiError('INVALID_MODE', '请选择音视频、仅视频、仅音频或分开保存');
    }
    if (value.quality !== undefined && value.quality !== null) {
      normalizeQualitySpec(value.quality);
    }
    if (value.audioFormat !== undefined && !['m4a', 'mp3'].includes(value.audioFormat)) {
      throw new ApiError('INVALID_AUDIO_FORMAT', '音频格式应为 M4A 或 MP3');
    }
    if (value.subtitles !== undefined && typeof value.subtitles !== 'boolean') {
      throw new ApiError('INVALID_SUBTITLES', '字幕选项应为布尔值');
    }
    if (value.sourceKind !== undefined && !['m3u8','mpd'].includes(value.sourceKind)) {
      throw new ApiError('INVALID_SOURCE_KIND', '流类型应为 m3u8 或 mpd');
    }
    if (value.fastStart !== undefined && typeof value.fastStart !== 'boolean') {
      throw new ApiError('INVALID_FAST_START', '快速播放选项应为布尔值');
    }
    let itemRefresh;
    if (value.refresh !== undefined) {
      if (!value.refresh || typeof value.refresh !== 'object' || Array.isArray(value.refresh) ||
          Object.keys(value.refresh).some(key => !['pageUrl','maxRefreshes'].includes(key))) {
        throw new ApiError('INVALID_REFRESH', 'item.refresh 仅支持 pageUrl 与 maxRefreshes', 422);
      }
      const refUrl = mediaUrl(value.refresh.pageUrl).href;
      if (platformVideo(new URL(refUrl))) throw new ApiError('INVALID_REFRESH', 'Provide the original player page', 422);
      const maxRefreshes = value.refresh.maxRefreshes ?? 1;
      if (!Number.isInteger(maxRefreshes) || maxRefreshes < 1 || maxRefreshes > 2) {
        throw new ApiError('INVALID_REFRESH', 'maxRefreshes 应为 1 或 2', 422);
      }
      itemRefresh = { pageUrl: refUrl, maxRefreshes };
    }
    const itemHeaders = value.headers !== undefined ? parseMediaHeaders(value.headers) : undefined;
    let url;
    try { url = mediaUrl(value.url).href; }
    catch (error) {
      if (error.code !== 'INVALID_URL' || values.length === 1) throw error;
      url = null;
    }
    const resolvedQuality = value.quality === 'max' || value.quality === 'best' ? null
      : value.quality === undefined ? defaults.quality : value.quality;
    return { kind, url, format: value.format ?? defaults.format,
      mode: value.mode ?? defaults.mode,
      quality: typeof resolvedQuality === 'number' || resolvedQuality === null ? resolvedQuality : legacyQualityCap(resolvedQuality),
      qualitySpec: value.quality !== undefined ? value.quality : (defaults.quality ?? null),
      audioFormat: value.audioFormat ?? defaults.audioFormat, subtitles: value.subtitles ?? defaults.subtitles,
      sourceKind:value.sourceKind, fastStart:value.fastStart ?? defaults.fastStart,
      ...(itemRefresh && {refresh:itemRefresh}),
      ...(itemHeaders && Object.keys(itemHeaders).length && {headers:itemHeaders}),
      title: value.title?.trim().slice(0, 160) || '' };
  });
}

function durationLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new ApiError('INVALID_DURATION', '时长上限必须是正数（秒）');
  }
  return Number(value);
}

const directMedia = /^(?:mp4|webm|mkv|mov|m4v|ogv|avi|ts|mp3|m4a|ogg|wav|flac)$/i;

export function queueOriginal({ url, title, extension, connections, requestId } = {}) {
  if (typeof extension !== 'string' || !directMedia.test(extension)) {
    throw new ApiError('INVALID_FORMAT', '需要一个直链视频格式');
  }
  return queue({items:[{kind:'stream', url, title}], connections, delivery:'browser', requestId}, extension.toLowerCase());
}

export function queue({items,maxSec,prefetch,resume = true,keepSegments = false,cookie,cookieSessionId,headers,concurrency,connections,
  delivery = 'local',requestId,useBrowserCookies,refresh,skipExisting = false,continueOnError = true} = {},
  originalExtension, principal, authorization) {
  if (delivery !== 'local' && delivery !== 'browser') throw new ApiError('INVALID_DELIVERY', '无效的保存方式');
  if (useBrowserCookies !== undefined && useBrowserCookies !== false) {
    throw new ApiError('BROWSER_SESSION_UNAVAILABLE', '下载使用独立会话');
  }
  const defaults = delivery === 'local' ? getSettings().settings : defaultOutput();
  const targets = getTargets(items, defaults);
  let normalizedRefresh;
  if (refresh !== undefined) {
    if (delivery !== 'local' || authorization || targets.length !== 1 || targets[0].kind !== 'stream' ||
        !refresh || typeof refresh !== 'object' || Array.isArray(refresh) ||
        Object.keys(refresh).some(key => !['pageUrl','maxRefreshes'].includes(key))) {
      throw new ApiError('INVALID_REFRESH','Provide refresh.pageUrl (and optional maxRefreshes 1–2) for a local stream',422);
    }
    const pageUrl = mediaUrl(refresh.pageUrl).href;
    if (platformVideo(new URL(pageUrl))) throw new ApiError('INVALID_REFRESH','Provide the original media player page',422);
    const maxRefreshes = refresh.maxRefreshes ?? 1;
    if (!Number.isInteger(maxRefreshes) || maxRefreshes < 1 || maxRefreshes > 2) {
      throw new ApiError('INVALID_REFRESH','maxRefreshes must be 1 or 2',422);
    }
    normalizedRefresh = { pageUrl, maxRefreshes };
  }
  if (concurrency === undefined) concurrency = defaults.concurrency;
  if (connections === undefined) connections = defaults.connections;
  if (!validConcurrency(concurrency)) throw new ApiError('INVALID_CONCURRENCY', '并发数应为 1 至 ' + maxConcurrency + ' 的整数');
  if (![4,8,12].includes(connections)) throw new ApiError('INVALID_CONNECTIONS', '单任务连接数应为 4、8 或 12');
  if (prefetch !== undefined && typeof prefetch !== 'boolean') throw new ApiError('INVALID_PREFETCH', 'prefetch 必须为布尔值');
  if (typeof resume !== 'boolean') throw new ApiError('INVALID_RESUME','resume 必须为布尔值');
  if (typeof keepSegments !== 'boolean' || keepSegments && (!resume || delivery !== 'local' || authorization)) {
    throw new ApiError('INVALID_KEEP_SEGMENTS','keepSegments requires a local download with resume enabled');
  }
  if (typeof skipExisting !== 'boolean') throw new ApiError('INVALID_SKIP_EXISTING','skipExisting 必须为布尔值');
  if (typeof continueOnError !== 'boolean') throw new ApiError('INVALID_CONTINUE_ON_ERROR','continueOnError 必须为布尔值');
  if (requestId !== undefined && (delivery !== 'browser' || typeof requestId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId))) {
    throw new ApiError('INVALID_REQUEST_ID', '浏览器任务编号无效');
  }
  const limit = durationLimit(maxSec);
  let resolvedCookies = parseCookies(cookie);
  if (cookieSessionId && targets[0]?.url) {
    resolvedCookies = resolveCookieSession(cookieSessionId, targets[0].url);
  }
  return enqueue({targets, limit, prefetch:prefetch ?? !limit, resume, keepSegments, skipExisting, continueOnError,
    refresh:normalizedRefresh, cookies:resolvedCookies, cookieSessionId, concurrency, connections,
    delivery, originalExtension, requestId, principal, authorization, outDir:defaults.outDir, headers:parseMediaHeaders(headers)});
}

export function queueBatch({items,concurrency = 1,skipExisting = true,delivery = 'local',requestId,
  codeUrlTemplate,urlTemplate,perItem = {},deduplicate,previewOnly = false,continueOnError = true,...options} = {}) {
  if (delivery !== 'local' || requestId !== undefined) throw new ApiError('INVALID_DELIVERY','Batches save into the local output directory');
  const allowedPerItem = new Set(['quality','headers','format','mode','audioFormat','subtitles','fastStart','refresh']);
  if (!perItem || typeof perItem !== 'object' || Array.isArray(perItem) ||
      Object.keys(perItem).some(key => !allowedPerItem.has(key))) {
    throw new ApiError('INVALID_ITEM_DEFAULTS','perItem supports quality, headers, format, mode, audioFormat, subtitles, fastStart and refresh');
  }
  const templateRaw = codeUrlTemplate ?? urlTemplate;
  const parsedTemplate = validateUrlTemplate(templateRaw);
  const { headers: perItemHeaders, ...perItemDefaults } = perItem;
  let targets = Array.isArray(items) ? items.map(item => {
    if (!item) return item;
    const target = {...perItemDefaults, ...item};
    if (item.kind !== 'code' && item.kind !== 'id') return target;
    const rawId = item.kind === 'code' ? item.code : item.id;
    const validId = item.kind === 'code'
      ? (typeof rawId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(rawId))
      : (typeof rawId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawId));
    if (!validId || !parsedTemplate) {
      throw new ApiError('INVALID_CODE','Provide a valid media identifier and codeUrlTemplate / urlTemplate');
    }
    const { code: _c, id: _i, ...rest } = target;
    return {...rest, kind:'page', url:parsedTemplate.template.replace(parsedTemplate.token, encodeURIComponent(rawId))};
  }) : items;
  let deduplicatedCount = 0;
  if (deduplicate !== false && Array.isArray(targets)) {
    const seen = new Set();
    const unique = [];
    for (const entry of targets) {
      const dedupKey = entry && typeof entry === 'object'
        ? (deduplicate === true
          ? `${entry.kind ?? ''}|${entry.url ?? ''}|${entry.mode ?? ''}|${entry.format ?? ''}`
          : `${entry.kind ?? ''}|${entry.url ?? ''}|${entry.title ?? ''}|${entry.mode ?? ''}|${entry.format ?? ''}|${JSON.stringify(entry.quality ?? null)}`)
        : null;
      if (dedupKey && seen.has(dedupKey)) {
        deduplicatedCount++;
        continue;
      }
      if (dedupKey) seen.add(dedupKey);
      unique.push(entry);
    }
    targets = unique;
  }
  const headers = perItemHeaders === undefined ? options.headers :
    {...parseMediaHeaders(perItemHeaders),...parseMediaHeaders(options.headers)};
  if (previewOnly) {
    const defaults = getSettings().settings;
    const resolved = getTargets(targets, defaults);
    return {
      preview: true,
      previewOnly: true,
      total: resolved.length,
      deduplicatedCount,
      concurrency,
      continueOnError,
      items: resolved.map((t, idx) => ({ idx, kind: t.kind, url: t.url, title: t.title, quality: t.qualitySpec ?? t.quality, format: t.format, mode: t.mode })),
    };
  }
  return queue({...options, items:targets, headers, concurrency, skipExisting, continueOnError});
}

export function retryBatch({id} = {}) {
  const batch = lookup(id);
  if (batch.principal) throw new ApiError('MCP_REAPPROVAL_REQUIRED', 'Start a new download from an approved tab', 409);
  if (batch.delivery !== 'local') throw new ApiError('BROWSER_RETRY_REQUIRED', 'Retry this download from the extension', 409);
  if (!isTerminal(batch.status)) throw new ApiError('BATCH_ACTIVE', 'Wait for the batch to stop or finish', 409);
  if (batch.retry) return batch.retry;
  if (batch.resumable || !batch.request && batch.items.some(item => item.status !== 'done')) {
    throw new ApiError('RESUBMIT_REQUIRED', '请重新提交原下载请求，包含原始地址与所需 Cookie', 409);
  }
  const targets = batch.request?.targets.filter((_, index) => ['error','cancelled'].includes(batch.items[index].status)) ?? [];
  if (!targets.length) throw new ApiError('NOTHING_TO_RETRY', 'All downloads in this batch already finished', 409);
  batch.retry = enqueue({...batch.request, targets});
  delete batch.request;
  storeBatch(historyRecord(batch));
  return batch.retry;
}

function completedFilesStillPresent(batch, items = batch.items) {
  try {
    const directory = realpathSync(batch.outDir);
    return items.every(item => item.status === 'done' && item.outputs?.length &&
      item.outputs.every(({file,info}) => {
        const stat = lstatSync(file);
        return stat.isFile() && stat.size === info?.size && !path.relative(directory,path.dirname(realpathSync(file)));
      }));
  } catch {
    return false;
  }
}

function enqueue(request) {
  const {targets, limit, prefetch, cookies, concurrency, connections, delivery, originalExtension, requestId, outDir} = request;
  const hashInputs = [targets, limit, prefetch, cookies, concurrency, connections, delivery, originalExtension, requestId, outDir];
  if (request.principal) hashInputs.push({principal:request.principal});
  if (request.authorization) hashInputs.push(request.authorization.id);
  if (Object.keys(request.headers).length) hashInputs.push(request.headers);
  if (!request.resume) hashInputs.push({resume:false});
  if (request.refresh) hashInputs.push({refresh:request.refresh});
  if (request.keepSegments) hashInputs.push({keepSegments:true});
  const key = createHash('sha256').update(JSON.stringify(hashInputs)).digest('hex');
  const existing = batches.get(batchKeys.get(key));
  if (existing?.status === 'running') return { id: existing.id, total: targets.length };

  const canReuseItems = delivery === 'local' && !request.authorization && !request.principal && !originalExtension;
  const itemKeys = canReuseItems ? targets.map(target => createHash('sha256').update(JSON.stringify(
    [target,limit,cookies,outDir,request.headers,request.refresh,request.keepSegments])).digest('hex')) : undefined;
  const newRecord = previous => {
    const items = targets.map(({kind,title},idx) => ({idx,kind,title,status:'queued',percent:0,speed:0,bytes:0,
      totalBytes:null,etaSec:null,prefetch:null,file:null,error:null}));
    return {id:previous?.id ?? randomUUID(),status:'running',outDir,delivery,principal:request.principal,
      managedRetry:request.authorization?.retryPlan,itemKeys,
      createdAt:previous?.createdAt ?? new Date().toISOString(),
      log:previous ? ['已恢复中断的下载批次'] : [],
      items:items.map((item,index) => {
        const prior = previous?.items[index];
        return prior && !pendingItem(prior) ? prior : item;
      })};
  };
  const reuse = request.skipExisting && canReuseItems ? completedFilesStillPresent : undefined;
  const privateBatch = request.authorization?.privacy === true;
  const persistent = delivery === 'local' && !privateBatch;
  const claimed = persistent ? claimBatch(key,newRecord,reuse) : {claimed:true,batch:newRecord()};
  const {id} = claimed.batch;
  if (!claimed.claimed) return {id,total:targets.length,...(claimed.alreadySaved && {alreadySaved:true})};
  const batch = {
    ...claimed.batch, controller: new AbortController(), itemControllers: targets.map(() => new AbortController()),
    listeners: new Set(), concurrency, connections, running: 0, delivery, originalExtension, files: new Map(), private: privateBatch,
    request, lastPersistedAt: 0,
  };
  batches.set(id, batch);
  batchKeys.set(key, id);
  const savedItems = request.skipExisting && canReuseItems ? new Map() : null;
  if (savedItems) {
    const requestedKeys = new Set(itemKeys);
    for (const prior of storedBatches()) {
      prior.itemKeys?.forEach((itemKey,index) => {
        const item = prior.items[index];
        if (requestedKeys.has(itemKey) && item?.status === 'done' && completedFilesStillPresent(prior,[item])) {
          savedItems.set(itemKey,{batch:prior,item});
        }
      });
    }
  }
  const signal = AbortSignal.any([batch.controller.signal, session.signal]);
  const jobs = targets.flatMap((target, index) => pendingItem(batch.items[index]) ? [schedule(signal, async () => {
    const itemSignal = AbortSignal.any([signal, batch.itemControllers[index].signal]);
    itemSignal.throwIfAborted();
    request.authorization?.check?.();
    const prior = savedItems?.get(itemKeys?.[index]);
    if (prior && completedFilesStillPresent(prior.batch,[prior.item])) {
      batch.items[index] = {...prior.item,idx:index,alreadySaved:true};
      storeBatch(historyRecord(batch));
      publish(batch, `[${index + 1}] 已复用保存的文件`);
      return;
    }
    const item = batch.items[index];
    const startedAt = performance.now();
    const itemCookies = request.cookieSessionId && target.url
      ? resolveCookieSession(request.cookieSessionId, target.url)
      : cookies;
    try {
      await runItem(batch, item, {...target}, limit, itemCookies, itemSignal);
    } finally {
      item.elapsedMs = Math.round(performance.now() - startedAt);
    }
    savedItems?.set(itemKeys[index],{batch,item});
  }, batch)
    .catch(error => {
      const item = batch.items[index];
      const itemAborted = batch.itemControllers[index].signal.aborted;
      if (session.signal.aborted && !batch.controller.signal.aborted && !itemAborted && delivery === 'local') return;
      const cancelled = signal.aborted || itemAborted;
      item.status = cancelled ? 'cancelled' : 'error';
      item.phase = cancelled ? 'cancelled' : 'error';
      item.speed = 0;
      item.etaSec = null;
      if (!cancelled) {
        const {code, message, detail} = errorDetails(error);
        item.error = message;
        item.errorCode = code;
        item.detail = detail ?? {stderr:''};
        batch.lastError = {idx:index,code,message,detail:item.detail};
        if (request.continueOnError === false) {
          for (let j = index + 1; j < batch.itemControllers.length; j++) {
            batch.itemControllers[j].abort(new DOMException('Stopped after prior error', 'AbortError'));
          }
        }
      }
      if (persistent) storeBatch(historyRecord(batch));
      publish(batch, `[${index + 1}] ${item.error || '已取消'}`);
    })] : []);
  void Promise.all(jobs).then(() => {
    if (session.signal.aborted && !batch.controller.signal.aborted && persistent && batch.items.some(pendingItem)) {
      storeBatch(historyRecord(batch,'interrupted'));
      return;
    }
    batch.status = batch.controller.signal.aborted || signal.aborted && batch.items.some(item => item.status === 'cancelled')
      ? 'cancelled' : completedStatus(batch.items);
    if (request.authorization || delivery !== 'local' || batch.items.every(item => item.status === 'done')) delete batch.request;
    if (batchKeys.get(key) === id) batchKeys.delete(key);
    if (persistent) {
      const interruptedItems = batch.items.filter(item => INTERRUPTED_CODES.has(item.errorCode));
      batch.resumable = !signal.aborted && interruptedItems.length > 0;
      storeBatch(historyRecord(batch,batch.resumable ? 'interrupted' : batch.status));
      if (batch.controller.signal.aborted) {
        return Promise.allSettled(interruptedItems.map(item =>
          rm(stagingRoot(batch.outDir,id,item.idx),{recursive:true,force:true,maxRetries:5}))).then(() => {
          publish(batch,'批次已取消');
        });
      }
    }
    publish(batch, signal.aborted ? '批次已取消' : '批次已结束');
  }).catch(error => console.error('VideoSave could not record the download result:', error.code ?? error.name));
  return { id, total: targets.length };
}

function filename(title) {
  return (title || 'video').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ')
    .trim().slice(0, 70).replace(/[. ]+$/, '').replace(/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?=\.|$)/i, '_$1') || 'video';
}

async function save(directory, source, name, extension) {
  for (let index = 1; ; index += 1) {
    const target = path.join(directory, `${name}${index === 1 ? '' : `_${index}`}.${extension}`);
    try {
      try { await link(source, target); } catch (error) {
        if (!['ENOTSUP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error;
        await copyFile(source, target, constants.COPYFILE_EXCL);
      }
      return target;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

const browserFileLifetime = 24 * 60 * 60 * 1000;

export function browserFile(id, itemIndex, outputIndex) {
  const output = lookup(id).files.get(itemIndex)?.outputs[outputIndex];
  if (!output) throw new ApiError('FILE_NOT_FOUND', '浏览器下载文件已失效，请重试任务', 404);
  return output;
}

export async function releaseFiles(id, itemIndex) {
  const files = lookup(id).files;
  const indices = itemIndex === undefined ? [...files.keys()] : [itemIndex];
  await Promise.all(indices.map(async index => {
    const entry = files.get(index);
    if (!entry) return;
    files.delete(index);
    clearTimeout(entry.timer);
    await rm(entry.staging, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }));
  return { ok: true };
}

async function holdBrowserFiles(batch, item, staging, outputs, signal) {
  const files = await Promise.all(outputs.map(async ({ file, name = path.basename(file) }) => ({
    file, name, size: (await stat(file)).size,
  })));
  signal.throwIfAborted();
  const timer = setTimeout(() => void releaseFiles(batch.id, item.idx), browserFileLifetime);
  timer.unref();
  batch.files.set(item.idx, { staging, outputs: files, timer });
  item.outputs = files.map(({ name }, index) => ({ name, href: `/api/batch/${batch.id}/files/${item.idx}/${index}` }));
}

function outputTracks(target, tracks, preserveAudioTracks = false) {
  const videos = tracks?.filter(track => track.codec_type === 'video' && !track.disposition?.attached_pic)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (Number(b.bit_rate) || 0) - (Number(a.bit_rate) || 0));
  const within = videos?.find(track => track.height && (!target.quality || track.height <= target.quality));
  const video = within || (target.quality ? videos?.filter(track => track.height).at(-1) : videos?.[0]);
  const audioTracks = tracks?.filter(track => track.codec_type === 'audio');
  const audio = audioTracks?.find(track => track.disposition?.default) || audioTracks?.[0];
  if (target.mode !== 'audio' && tracks && !video) throw new ApiError('NO_VIDEO_TRACK', '源文件里没有可用的视频轨');
  if (['audio', 'separate'].includes(target.mode) && tracks && !audio) {
    throw new ApiError('NO_AUDIO', '源文件里没有可用的音轨');
  }
  if (target.quality && target.mode !== 'audio' && !video?.height) {
    throw new ApiError('UNKNOWN_QUALITY', '无法读取源视频画质，请试试原画');
  }
  const scaled = target.quality && video?.height > target.quality;
  const transcodeVideo = scaled || (target.format === 'mp4' && video &&
    !['h264', 'hevc', 'av1', 'vp9', 'mpeg4', 'mjpeg'].includes(video.codec_name));
  const videoArgs = ['-map', video ? '0:' + video.index : '0:v:0', '-c:v', transcodeVideo ? 'libx264' : 'copy'];
  if (transcodeVideo) videoArgs.push('-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (scaled) videoArgs.push('-vf', 'scale=-2:' + (target.quality - target.quality % 2));
  const audioMap = audio ? '0:' + audio.index : '0:a:0';
  const combinedAudio = preserveAudioTracks && audioTracks?.length
    ? audioTracks.flatMap((track,index) => ['-map','0:' + track.index,'-c:a:' + index,
      target.format === 'mp4' && track.codec_name !== 'aac' ? 'aac' : 'copy'])
    : !tracks || audio ? ['-map', audioMap + '?', '-c:a',
      target.format === 'mp4' && audio && audio.codec_name !== 'aac' ? 'aac' : 'copy'] : [];
  const textSubtitles = new Set(['mov_text', 'subrip', 'ass', 'ssa', 'webvtt', 'text']);
  const subtitles = target.subtitles && tracks ? tracks.filter(track => track.codec_type === 'subtitle' &&
    (target.format === 'mkv' || textSubtitles.has(track.codec_name))) : [];
  const subtitleArgs = subtitles.flatMap((track, index) => ['-map', '0:' + track.index, '-c:s:' + index,
    target.format === 'mp4' ? 'mov_text' : track.codec_name === 'mov_text' ? 'srt' : 'copy']);
  return {
    video, scaled,
    videoArgs,
    combinedAudio,
    subtitleArgs,
    audioArgs: ['-map', audioMap, '-c:a', target.audioFormat === 'mp3' ? 'libmp3lame' :
      audio?.codec_name === 'aac' ? 'copy' : 'aac', '-b:a', '192k'],
  };
}

async function runItem(batch, item, target, limit, cookies, signal) {
  let mediaIdentity = null;
  const refreshConfig = target.refresh ?? batch.request.refresh ?? (target.kind === 'page' ? { pageUrl: target.url, maxRefreshes: 1 } : null);
  const maxRefreshes = refreshConfig?.maxRefreshes ?? 1;
  let refreshAttempt = 0;
  let currentTarget = target;

  while (true) {
    try {
      await runItemOnce(batch, item, currentTarget, limit, cookies, signal, {
        onMediaIdentity: identity => { mediaIdentity = identity; },
        refreshContext: refreshAttempt > 0 ? mediaIdentity : null,
        preserveRecoveryOnExpiry: () => Boolean(refreshConfig && refreshAttempt < maxRefreshes),
      });
      return;
    } catch (error) {
      if (error.code !== 'STREAM_EXPIRED' || !mediaIdentity || batch.request.authorization || !refreshConfig || refreshAttempt >= maxRefreshes) {
        throw error;
      }
      signal.throwIfAborted();
      refreshAttempt++;
      const page = new URL(refreshConfig.pageUrl);
      const refreshCookies = page.origin === mediaIdentity.origin ? cookies : [];
      item.refreshAttempts = refreshAttempt;
      delete item.prefetchFallback;
      publish(batch, `[${item.idx + 1}] 媒体链接已过期，正在从原授权页刷新（第 ${refreshAttempt}/${maxRefreshes} 次）`);
      try {
        currentTarget = { ...target, kind: 'page', url: page.href, sourceKind: undefined };
        await runItemOnce(batch, item, currentTarget, limit, refreshCookies, signal, {
          onMediaIdentity: identity => { mediaIdentity = identity; },
          refreshContext: mediaIdentity,
          preserveRecoveryOnExpiry: () => refreshAttempt < maxRefreshes,
        });
        return;
      } catch (failure) {
        if (failure.code === 'STREAM_EXPIRED' && refreshAttempt < maxRefreshes) {
          continue;
        }
        if (['MEDIA_ACCESS_RESTRICTED', 'DRM', 'SESSION_EXPIRED', 'NO_SPACE', 'INVALID_HLS_SEGMENT'].includes(failure.code)) {
          throw failure;
        }
        if (!['NO_MEDIA', 'AMBIGUOUS_MEDIA', 'PAGE_FAILED', 'STREAM_EXPIRED', 'REFRESH_IDENTITY_MISMATCH'].includes(failure.code)) {
          throw failure;
        }
        page.search = '';
        throw new ApiError('STREAM_EXPIRED', 'The original page did not yield a valid replacement media stream', 410,
          {
            pageUrl: page.href,
            reason: failure.detail?.reason ?? failure.code,
            refreshAttempts: refreshAttempt,
            ...(failure.detail?.blockers && { blockers: failure.detail.blockers }),
          });
      }
    }
  }
}

async function runItemOnce(batch, item, target, limit, cookies, signal, { onMediaIdentity, refreshContext, preserveRecoveryOnExpiry } = {}) {
  item.status = 'resolving';
  item.phase = 'resolving';
  publish(batch, `[${item.idx + 1}] 正在解析`);
  const input = mediaUrl(target.url);
  const supportedPage = target.kind === 'page' ? platformVideo(input) : null;
  const platform = platformDownloadsEnabled() ? supportedPage : null;
  let source = input;
  let sourceKind = target.sourceKind;
  let resolvedTitleSource;
  if (target.kind === 'page' && !platform) {
    const found = await inspectPage(input, cookies, signal,
      refreshContext ? { selectionOnly: true, waitMs: 5000, retries: 0, userAgent: batch.request.headers?.['User-Agent'], extraHeaders: batch.request.headers }
        : { selectionOnly: true, userAgent: batch.request.headers?.['User-Agent'], extraHeaders: batch.request.headers });
    if (!found.streams.length) {
      if (found.blockers?.includes('drm')) throw new ApiError('DRM', '网页播放器使用 DRM', 422);
      if (found.blockers?.includes('auth-required') || found.blockers?.includes('login')) {
        throw new ApiError('SESSION_EXPIRED', '页面需要重新登录授权，无法自动刷新临时媒体地址', 401, { blockers: found.blockers });
      }
      if (supportedPage) throw new ApiError('PLATFORM_TOOL_REQUIRED', '请配置本机 yt-dlp 后重试', 503);
      const message = found.blockers?.includes('cloudflare-challenge')
        ? '站点返回 Cloudflare 验证页，未探测到媒体流'
        : '页面里没有找到可下载的媒体';
      throw new ApiError('NO_MEDIA', message, 422, { reason: found.selection.reason, diagnostic: found.diagnostic, stderr: '',
        ...(found.blockers && { blockers: found.blockers }) });
    }
    const stream = found.streams.find(candidate => candidate.url === found.selection.url);
    if (!stream) throw new ApiError('AMBIGUOUS_MEDIA', '页面中有多个视频，请选择明确的视频来源', 422);
    source = mediaUrl(stream.url);
    if (refreshContext) {
      if (source.origin !== refreshContext.origin || (refreshContext.kind && stream.kind !== refreshContext.kind)) {
        throw new ApiError('REFRESH_IDENTITY_MISMATCH', 'The replacement stream does not match the original media origin or format', 410);
      }
      publish(batch, '已重新探测到同源媒体资源，准备恢复进度');
    }
    sourceKind ||= ['m3u8', 'mpd'].includes(stream.kind) ? stream.kind : undefined;
    if (audioFormats.has(stream.kind) && target.mode === 'combined') target = { ...target, mode: 'audio' };
    if (!item.title) {
      item.title = stream.title || found.pageTitle || '';
      resolvedTitleSource = stream.titleSource;
    }
  }
  const authorization = batch.request.authorization;
  sourceKind ||= classify(source);
  onMediaIdentity?.({ origin: source.origin, pathname: source.pathname, kind: sourceKind });
  const scopedCookies = !authorization && source.origin === input.origin ? cookies : [];
  const mergedHeaders = authorization ? {} : { ...capturedHeaders(source.href), ...batch.request.headers, ...(target.headers ?? {}) };
  const requestContext = authorization ? null : createRequestContext({
    origin: source.origin,
    headers: mergedHeaders,
    cookies: scopedCookies,
  });
  const headers = requestContext ? requestContext.headers : {};
  const expiresAt = streamExpiry(source);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new ApiError('STREAM_EXPIRED', '媒体地址已过期，请重新探测原页面', 422, { expiresAt });
  }
  const directory = batch.delivery === 'browser' ? os.tmpdir() : assertSandboxPath(batch.outDir, 'download output directory');
  await mkdir(directory, { recursive: true });
  const recovery = batch.delivery === 'local' && batch.request.resume ? stagingRoot(directory, batch.id, item.idx) : null;
  if (recovery) {
    await mkdir(recovery, { recursive: true, mode: 0o700 });
    if (!(await lstat(recovery)).isDirectory()) throw new ApiError('INVALID_PATH', '下载暂存路径无效');
  }
  let staging;
  let held = false;
  let keepRecovery = false;
  let segmentDirectory;
  const saved = [];
  const persistProgressThrottled = () => {
    if (batch.delivery !== 'local' || batch.private) return;
    const now = performance.now();
    if (now - (batch.lastPersistedAt ?? 0) >= 800) {
      batch.lastPersistedAt = now;
      try { storeBatch(historyRecord(batch)); } catch {}
    }
  };
  try {
    staging = recovery ? await mkdtemp(path.join(recovery, 'attempt-')) : await mkdtemp(path.join(directory, '.media-toolkit-'));
    const updateProgress = percent => {
      if (percent > item.percent) { item.percent = percent; publish(batch); persistProgressThrottled(); }
    };
    let sampledAt = performance.now();
    let sampledBytes = 0;
    function measure(bytes, totalBytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return;
      item.bytes = Math.max(item.bytes, bytes);
      if (totalBytes > 0) item.totalBytes = Math.max(totalBytes, item.bytes);
      const now = performance.now();
      if (now - sampledAt >= 300 && item.bytes > sampledBytes) {
        const speed = (item.bytes - sampledBytes) * 1000 / (now - sampledAt);
        item.speed = Math.round(item.speed ? (item.speed + speed) / 2 : speed);
        sampledAt = now;
        sampledBytes = item.bytes;
      }
      item.etaSec = item.totalBytes && item.speed && item.totalBytes > item.bytes
        ? Math.ceil((item.totalBytes - item.bytes) / item.speed) : null;
    }
    const downloadProgress = (fraction, bytes, totalBytes, segments) => {
      item.status = 'downloading';
      item.phase = 'prefetching';
      if (segments) item.segments = segments;
      measure(bytes, totalBytes);
      if (fraction != null) updateProgress(Math.min(90, Math.floor(fraction * 90)));
    };
    const effectiveQuality = target.qualitySpec ?? target.quality;
    let staged;
    if (authorization) {
      const transport = authorization.transportFor(source);
      if (sourceKind === 'mpd') {
        item.engine = 'dash-static';
        staged = await prefetchDash(source, staging, signal, downloadProgress, {
          quality: effectiveQuality, connections: batch.connections, subtitles: target.subtitles,
          fetchResource: transport.fetchResource,
          onQualityNegotiated: q => { item.qualityNegotiation = q; },
        });
      } else if (sourceKind === 'm3u8') {
        item.engine = 'hls';
        staged = await prefetchHls(source, [], staging, signal, downloadProgress, {
          quality: effectiveQuality, sourceKind, connections: batch.connections, subtitles: target.subtitles,
          strictSegmentCheck: true, restrictedOrigin: true, transport,
          onQualityNegotiated: q => { item.qualityNegotiation = q; },
        });
      } else {
        item.engine = 'http';
        staged = await prefetchRanges(source, [], staging, signal, downloadProgress, {
          connections: batch.connections, stageFull: true, exactSource: true, transport,
        });
      }
      if (!staged) throw new ApiError('MCP_MEDIA_UNAVAILABLE', 'The approved source did not return complete eligible media', 422);
    } else if (platform) {
      item.engine = 'yt-dlp';
      staged = await stagePlatform(platform, target, staging, batch.connections, signal, downloadProgress, headers);
    } else if (batch.request.prefetch) {
      if (sourceKind !== 'm3u8' && sourceKind !== 'mpd') {
        item.engine = 'http';
        staged = await prefetchRanges(source, scopedCookies, staging, signal, downloadProgress, {
          connections: batch.connections, stageFull: !batch.originalExtension, onKind: kind => { sourceKind = kind; },
          recovery, headers, requestContext,
        });
      }
      if (!staged && sourceKind === 'm3u8') {
        item.engine = 'hls';
        onMediaIdentity?.({ origin: source.origin, pathname: source.pathname, kind: 'm3u8' });
        staged = await prefetchHls(source, scopedCookies, staging, signal, downloadProgress, {
          quality: effectiveQuality, sourceKind, connections: batch.connections, recovery, headers, requestContext,
          subtitles: target.subtitles, strictSegmentCheck: true,
          onFallback: outcome => { item.prefetchFallback = outcome; },
          onSegmentsStored: batch.request.keepSegments ? directory => { segmentDirectory = directory; } : undefined,
          onQualityNegotiated: q => { item.qualityNegotiation = q; },
        });
      }
      if (!staged && sourceKind === 'mpd') {
        item.engine = 'dash-static';
        onMediaIdentity?.({ origin: source.origin, pathname: source.pathname, kind: 'mpd' });
        try {
          staged = await prefetchDash(source, staging, signal, downloadProgress, {
            quality: effectiveQuality, connections: batch.connections, subtitles: target.subtitles, recovery,
            fetchResource: localDashRequest(source, scopedCookies, headers, requestContext),
            onQualityNegotiated: q => { item.qualityNegotiation = q; },
          });
        } catch (error) {
          if (error.code !== 'DASH_UNSUPPORTED' || !error.detail?.legacyCompatible || source.search || scopedCookies.length ||
              Object.keys(headers).some(name => name !== 'User-Agent')) throw error;
          item.prefetchFallback = { reason: 'unsupported-dash-playlist' };
        }
      }
      if (!staged) item.prefetchFallback ??= { reason: sourceKind === 'mpd' ? 'unsupported-dash-playlist' : 'direct-prefetch-unavailable' };
    }
    if (!authorization && !batch.request.prefetch && isPlaylist(sourceKind)) {
      await checkManifestProtection(source, scopedCookies, signal, { kind: sourceKind, quality: effectiveQuality, headers, requestContext });
    }
    if (platform) item.title ||= target.title;
    signal.throwIfAborted();
    item.prefetch = Boolean(staged);
    if (staged) publish(batch, '媒体预取完成');
    item.speed = 0;
    item.etaSec = null;
    if (batch.originalExtension) {
      if (staged) {
        await holdBrowserFiles(batch, item, staging, [{ file: staged, name: `${filename(item.title)}.${batch.originalExtension}` }], signal);
        held = true;
      } else {
        item.native = true;
        item.engine = 'browser';
      }
      item.status = 'done';
      item.phase = 'done';
      item.percent = 100;
      publish(batch, staged ? '原画下载完成' : '交给浏览器直接下载');
      return;
    }
    if (item.prefetchFallback) {
      item.status = 'resolving';
      item.phase = 'resolving';
      publish(batch, `[${item.idx + 1}] 媒体预取未完成（${item.prefetchFallback.reason}），改用 FFmpeg 读取原地址`);
    }
    let media = staged || source;
    if (!staged) item.engine = 'ffmpeg';
    let info = await probeStream(media, scopedCookies, signal, true, undefined, headers);
    if (staged?.endsWith('.bin') && !platform && !info.tracks?.length) {
      if (authorization) throw new ApiError('MCP_MEDIA_UNSUPPORTED', 'The approved response did not contain supported direct media', 422);
      media = source;
      item.engine = 'ffmpeg';
      item.prefetch = false;
      item.prefetchFallback = { reason: 'staged-media-unrecognized' };
      publish(batch, '改用原地址读取媒体格式');
      info = await probeStream(media, scopedCookies, signal, true, undefined, headers);
    }
    const { duration, width, height, mediaTitle, tracks } = info;
    if (target.mode === 'combined' && tracks?.some(row => row.codec_type === 'audio') &&
        !tracks.some(row => row.codec_type === 'video' && !row.disposition?.attached_pic)) {
      target = { ...target, mode: 'audio' };
    }
    if (mediaTitle && (!item.title || (target.kind === 'page' && !target.title && canUseMediaTitle(resolvedTitleSource) && !platform))) {
      item.title = mediaTitle;
    }
    const { video, scaled, videoArgs, combinedAudio, audioArgs, subtitleArgs } =
      outputTracks(target, tracks, Boolean(staged && sourceKind === 'mpd'));
    const actualHeight = scaled ? target.quality - target.quality % 2 : video?.height ?? height;
    const actualWidth = scaled ? Math.round(video.width * actualHeight / video.height / 2) * 2 : video?.width ?? width;
    item.info = { duration, width: actualWidth, height: actualHeight };
    const expected = duration && limit ? Math.min(duration, limit) : duration || limit;
    const name = [filename(item.title), target.mode !== 'audio' && actualWidth && actualHeight ? `${actualWidth}x${actualHeight}` : null,
      limit ? `前${limit}秒` : null].filter(Boolean).join('_');
    const outputs = [];
    const addOutput = (suffix, extension, args) => {
      const outputName = name + suffix;
      const file = path.join(staging, outputName + '.' + extension);
      outputs.push({ name: outputName, extension, file,
        args: [...args, ...(limit ? ['-t', String(limit)] : []),
          ...(target.fastStart && ['mp4', 'm4a'].includes(extension) ? ['-movflags', '+faststart'] : []), file] });
    };
    if (target.mode !== 'audio') addOutput(target.mode === 'combined' ? '' : '_视频', target.format,
      [...videoArgs, ...(target.mode === 'combined' ? combinedAudio : []), ...subtitleArgs]);
    if (['audio', 'separate'].includes(target.mode)) addOutput('_音频', target.audioFormat, audioArgs);

    item.status = 'downloading';
    item.phase = staged ? 'muxing' : 'downloading';
    publish(batch, `[${item.idx + 1}] 正在下载`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
      ...mediaInput(media, scopedCookies, headers, '-i'), ...outputs.flatMap(output => output.args)];
    const encode = () => runMedia(FFMPEG, args, signal, line => {
      const written = /^total_size=(\d+)$/.exec(line)?.[1];
      if (media !== staged && written) measure(Number(written));
      const seconds = /^out_time_us=(\d+)$/.exec(line)?.[1];
      if (!seconds || !expected) return;
      const fraction = Number(seconds) / 1000000 / expected;
      updateProgress(Math.min(99, Math.floor(media === staged ? 90 + fraction * 10 : fraction * 100)));
    }, { strict: true });
    try {
      await encode();
    } catch (error) {
      const remoteDash = media instanceof URL && (sourceKind === 'mpd' || /\.mpd$/i.test(media.pathname));
      if (!remoteDash || !error.transientFirstFragment) throw error;
      publish(batch, '首个 DASH 分片暂时不可用，正在重试');
      await sleep(300, undefined, { signal });
      await encode();
    }
    signal.throwIfAborted();
    item.status = 'verifying';
    item.phase = 'verifying';
    item.speed = 0;
    item.etaSec = null;
    if (batch.delivery === 'browser') {
      if (staged) {
        const stagedInput = sourceKind === 'm3u8' ? path.join(staging, 'segments') : staged;
        await rm(stagedInput, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      }
      for (const output of outputs) {
        await inspectOutput(output.file, signal, ['mp3', 'm4a'].includes(output.extension) ? 'audio' : 'video', expected);
      }
      await holdBrowserFiles(batch, item, staging, outputs.map(({ file }) => ({ file })), signal);
      held = true;
    } else {
      for (const output of outputs) {
        signal.throwIfAborted();
        const file = await save(directory, output.file, output.name, output.extension);
        const record = { file, name: path.basename(file) };
        saved.push(record);
        record.info = await inspectOutput(file, signal, ['mp3', 'm4a'].includes(output.extension) ? 'audio' : 'video', expected);
      }
      signal.throwIfAborted();
      item.file = saved[0].file;
      item.outputs = saved;
      item.info = saved[0].info;
      if (target.subtitles) item.subtitleTracks = saved.reduce((total, output) => total + output.info.subtitleTracks, 0);
      const outputBytes = saved.reduce((total, output) => total + output.info.size, 0);
      item.bytes = Math.max(item.bytes, outputBytes);
    }
    item.totalBytes = item.bytes;
    item.status = 'done';
    item.phase = 'done';
    item.percent = 100;
    if (segmentDirectory) {
      item.segmentDirectory = segmentDirectory;
      keepRecovery = true;
      const entries = await readdir(recovery).catch(() => []);
      const other = entries.filter(name => name.startsWith('segments-') && name !== path.basename(segmentDirectory));
      await Promise.allSettled(other.map(name => rm(path.join(recovery, name), { recursive: true, force: true, maxRetries: 5 })));
    }
    if (recovery) storeBatch(historyRecord(batch));
    publish(batch, `[${item.idx + 1}] 下载完成`);
  } catch (error) {
    await Promise.all(saved.map(({ file }) => rm(file, { force: true }).catch(() => {})));
    const willRefresh = error.code === 'STREAM_EXPIRED' && preserveRecoveryOnExpiry?.();
    keepRecovery = (INTERRUPTED_CODES.has(error.code) || willRefresh) && !batch.controller.signal.aborted;
    if (error.code === 'ENOSPC') throw new ApiError('NO_SPACE', '输出磁盘空间不足', 507);
    throw error;
  } finally {
    if (!held && staging) await rm(staging, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    const interrupted = session.signal.aborted && !batch.controller.signal.aborted && item.status !== 'done';
    if (recovery && !interrupted && !keepRecovery) await rm(recovery, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

export async function downloadBestMedia({
  url, quality = 'best', format, mode, subtitles, headers, cookie, cookieSessionId,
  waitMs, waitForMediaMs, compatibility = 'adaptive', includeFrames = true, captureXhrBody = true,
  clickPlay = false, userAgent, browser, browserBinary, browserSessionId, profileMode,
  networkMode, proxy, timeoutBudget, connections, waitTimeoutMs = 60_000, verify = true,
} = {}, requestSignal) {
  const signal = requestSignal ? AbortSignal.any([session.signal, requestSignal]) : session.signal;
  const probed = await probe({
    url, cookie, cookieSessionId, waitMs, waitForMediaMs, compatibility, includeFrames, captureXhrBody,
    clickPlay, userAgent, browser, browserBinary, browserSessionId, profileMode, networkMode, proxy, timeoutBudget,
  }, signal);
  if (probed.downloadTargets?.length) {
    const target = probed.downloadTargets[0];
    const submitted = queue({
      items: [{ kind: 'page', url: target.url, title: target.title, quality, format, mode, subtitles }],
      headers, cookie, cookieSessionId, connections,
    });
    const completed = await waitForBatch({ id: submitted.id, timeoutMs: waitTimeoutMs }, signal);
    const verified = verify && !completed.timedOut && completed.status === 'done'
      ? await verifyBatchFiles(submitted.id, signal)
      : completed;
    return {
      status: completed.timedOut ? 'running' : completed.status,
      probe: { selection: probed.selection, diagnostic: probed.diagnostic, platformTarget: target },
      batch: verified,
    };
  }
  if (probed.selection?.status !== 'selected' || !probed.selection.url) {
    return {
      status: probed.selection?.status ?? 'unavailable',
      probe: { selection: probed.selection, diagnostic: probed.diagnostic, streams: probed.streams, qualities: probed.qualities },
      batch: null,
    };
  }
  const chosen = probed.streams.find(s => s.url === probed.selection.url);
  const itemHeaders = { ...(userAgent && { 'User-Agent': userAgent }), ...(headers ?? {}) };
  const submitted = queue({
    items: [{
      kind: 'stream',
      url: chosen.url,
      title: chosen.title || probed.pageTitle || undefined,
      quality,
      format,
      mode,
      subtitles,
      ...(['m3u8', 'mpd'].includes(chosen.kind) && { sourceKind: chosen.kind }),
    }],
    headers: Object.keys(itemHeaders).length ? itemHeaders : undefined,
    cookie,
    cookieSessionId,
    connections,
    ...(chosen.kind === 'm3u8' && { refresh: { pageUrl: url, maxRefreshes: 1 } }),
  });
  const completed = await waitForBatch({ id: submitted.id, timeoutMs: waitTimeoutMs }, signal);
  const verified = verify && !completed.timedOut && completed.status === 'done'
    ? await verifyBatchFiles(submitted.id, signal)
    : completed;
  const primaryItem = verified.items?.[0] ?? null;
  const primaryVerify = primaryItem?.verification?.[0];
  const verifySummary = primaryVerify ? {
    ok: primaryVerify.status === 'verified',
    status: primaryVerify.status,
    ...(primaryVerify.info && {
      width: primaryVerify.info.width ?? null,
      height: primaryVerify.info.height ?? null,
      duration: primaryVerify.info.duration ?? null,
      hasVideo: Boolean(primaryVerify.info.codec || primaryVerify.info.height),
      hasAudio: Boolean(primaryVerify.info.audioCodec),
      info: primaryVerify.info,
    }),
    ...(primaryVerify.errorCode && { errorCode: primaryVerify.errorCode }),
  } : null;
  return {
    id: submitted.id,
    status: completed.timedOut ? 'running' : completed.status,
    item: primaryItem,
    verification: verifySummary,
    probe: { selection: probed.selection, diagnostic: probed.diagnostic, qualities: probed.qualities },
    batch: verified,
  };
}

export async function recent() {
  const {outDir} = getSettings().settings;
  const entries = await readdir(outDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mp4|mkv|m4a|mp3)$/i.test(entry.name)) continue;
    const info = await stat(path.join(outDir, entry.name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.isFile()) items.push({ name: entry.name, size: info.size, mtime: info.mtimeMs });
  }
  return { dir: outDir, items: items.sort((a, b) => b.mtime - a.mtime).slice(0, 20) };
}

export async function openDownload(file) {
  const {outDir} = getSettings().settings;
  await mkdir(outDir, { recursive: true });
  const directory = await realpath(outDir);
  let args = [directory];
  if (file !== undefined) {
    if (typeof file !== 'string' || !file || !/\.(mp4|mkv|m4a|mp3)$/i.test(file) || /[\x00-\x1f,]/.test(file)) {
      throw new ApiError('INVALID_PATH', '请选择下载目录中的媒体文件');
    }
    const requested = path.resolve(outDir, file);
    if (path.relative(outDir, path.dirname(requested))) throw new ApiError('INVALID_PATH', '文件应在下载目录中');
    const actual = await realpath(requested).catch(error => {
      if (error.code === 'ENOENT') throw new ApiError('FILE_NOT_FOUND', '找不到下载文件', 404);
      throw error;
    });
    if (path.relative(directory, path.dirname(actual)) || !(await stat(actual)).isFile()) {
      throw new ApiError('INVALID_PATH', '文件应在下载目录中');
    }
    args = ['/select,', actual];
  }
  return showInExplorer(args);
}

export async function openBatchOutput(id,index) {
  const batch = lookup(id);
  const file = batch.items[index]?.outputs?.at(0)?.file;
  if (!file) throw new ApiError('MCP_FILE_NOT_READY','Wait for the verified file to finish',409);
  if (!/\.(mp4|mkv|m4a|mp3)$/i.test(file) || /[\x00-\x1f,]/.test(file)) {
    throw new ApiError('INVALID_PATH','Choose a supported output file');
  }
  const actual = await checkedBatchOutput(batch,file).catch(error => {
    if (error.code === 'ENOENT') throw new ApiError('FILE_NOT_FOUND','The output file was not found',404);
    throw error;
  });
  return showInExplorer(['/select,',actual]);
}

async function showInExplorer(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
    child.once('error', () => reject(new ApiError('OPEN_FAILED', '无法打开资源管理器', 503)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true };
}
