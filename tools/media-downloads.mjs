import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import manifest from '../extension/manifest.json' with {type:'json'};
import { defaultConcurrency, maxConcurrency, validConcurrency } from '../extension/settings.mjs';
import { assessCandidates, detectionDiagnostic } from '../extension/detection.mjs';
import { audioFormats, canUseMediaTitle, classify, isPlaylist, longestFirst, platformVideo, primaryCandidates, selectPageStream } from '../extension/media.mjs';
import { checkManifestProtection, hlsQualities, prefetchHls } from './hls-prefetch.mjs';
import { prefetchRanges } from './range-prefetch.mjs';
import { ApiError, FFMPEG, discover, inspectOutput, mediaInput, mediaUrl, parseCookies, parseMediaHeaders, probeStream, runMedia, streamExpiry } from './media-source.mjs';
import { readPreferences, writePreferences } from './preferences.mjs';
import { claimBatch, claimInterruptedCancellation, completedStatus, pendingItem, storeBatch, storedBatch, storedBatches } from './download-history.mjs';
import { platformDownloadsEnabled, probePlatform, stagePlatform } from './platform-downloads.mjs';

export { ApiError, platformDownloadsEnabled };
export const VERSION = manifest.version;

function defaultDownloads() {
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const value = output.match(/REG_\w+\s+(.+?)\s*$/m)?.[1];
    if (value) return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
  } catch {}
  return path.join(os.homedir(), 'Downloads');
}

export const OUT_DIR = path.resolve(process.env.OUT_DIR || defaultDownloads());
const defaultOutput = {outDir:OUT_DIR, format:'mp4', mode:'combined', quality:null, audioFormat:'m4a',
  subtitles:false, fastStart:true, concurrency:defaultConcurrency, connections:8};

export function getSettings({scope = 'download'} = {}) {
  const saved = readPreferences(scope);
  return {scope, settings:scope === 'download' ? {...defaultOutput, ...saved} : saved};
}

export function updateSettings({scope = 'download', settings} = {}) {
  const saved = writePreferences(scope, settings);
  return {scope, settings:scope === 'download' ? {...defaultOutput, ...saved} : saved};
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
      ? runningDownloads < maxConcurrency && job.batch.running < job.batch.concurrency
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

async function inspectPage(url, cookies, signal, {
  selectionOnly = false, waitMs = 20_000, retries = 2, includeText = false,
  clickPlay = false, captureXhrBody = true, includeFrames = true, mode = 'headless', singleWindow = false,
} = {}) {
  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const budget = singleWindow ? waitMs : Math.round(waitMs * (1 + attempt / 2));
    result = await discover(url, cookies, signal, {waitMs:budget, includeText, clickPlay, captureXhrBody, includeFrames, mode,
      onMediaHeaders:rememberMediaHeaders}).catch(error => {
      signal.throwIfAborted();
      if (/timed out|超时/i.test(error.message)) return {pageTitle:null,pageContext:null,streams:[],pages:[],candidates:[],reason:'timeout'};
      if (error instanceof ApiError) throw error;
      throw new ApiError('PAGE_FAILED', '隔离浏览器探测失败', 502);
    });
    if (result.streams.length || result.reason === 'blocked' || result.candidates.length && result.reason === 'no-player') break;
  }
  const protectedUrls = new Set();
  const pending = selectionOnly ? [...new Set([...primaryCandidates(result.streams),
    ...result.streams.filter(stream => isPlaylist(stream.kind))])] : [...result.streams];
  const inspectMetadata = !selectionOnly || pending.length > 1;
  if (pending.length) {
    const budget = AbortSignal.timeout(45_000);
    const metadataSignal = AbortSignal.any([signal,budget]);
    await Promise.all(Array.from({length:Math.min(4, pending.length)}, async () => {
      while (pending.length && !budget.aborted) {
        signal.throwIfAborted();
        const stream = pending.shift();
        const source = mediaUrl(stream.url);
        const scopedCookies = source.origin === url.origin ? cookies : [];
        const headers = capturedHeaders(source.href);
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
          !selectionOnly && stream.kind === 'm3u8' ? hlsQualities(source, scopedCookies, metadataSignal, headers) : null,
        ]).catch(error => {
          signal.throwIfAborted();
          if (budget.aborted) return [{},null];
          throw error;
        });
        if (quality?.length) stream.quality = quality;
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
  return {...page, selection, diagnostic:detectionDiagnostic({
    ...page.diagnostic, streams:page.streams, blockers:page.blockers, selection, reason,
  })};
}

export async function probe({
  url: value, cookie, waitMs = 20_000, waitForMediaMs, retries = waitForMediaMs === undefined ? 2 : 0, includeText = false,
  clickPlay = false, captureXhrBody = false, includeFrames = false, mode = 'headless', profile, useBrowserCookies,
} = {}, requestSignal) {
  const url = mediaUrl(value);
  const cookies = parseCookies(cookie);
  if (!Number.isInteger(waitMs) || waitMs < 100 || waitMs > 30_000) {
    throw new ApiError('INVALID_WAIT', 'waitMs 必须为 100–30000 毫秒');
  }
  if (waitForMediaMs !== undefined && (!Number.isInteger(waitForMediaMs) || waitForMediaMs < 100 || waitForMediaMs > 60_000)) {
    throw new ApiError('INVALID_WAIT', 'waitForMediaMs 必须为 100–60000 毫秒');
  }
  if (!['headless','headed'].includes(mode)) throw new ApiError('INVALID_MODE', '浏览器模式应为 headless 或 headed');
  if (profile !== undefined && profile !== 'fresh' || useBrowserCookies !== undefined && useBrowserCookies !== false) {
    throw new ApiError('BROWSER_SESSION_UNAVAILABLE', '探测使用独立浏览器会话');
  }
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
    throw new ApiError('INVALID_RETRIES', 'retries 必须为 0–2');
  }
  if (typeof includeText !== 'boolean') throw new ApiError('INVALID_INCLUDE_TEXT', 'includeText 必须为布尔值');
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
        downloadTargets:[target], selection:{status:'selected',url:target.url,reason:'platform'},
        diagnostic:detectionDiagnostic({streams:[target]})};
    }
    return inspectPage(url, cookies, signal, {waitMs:waitForMediaMs ?? waitMs,retries,includeText,clickPlay,captureXhrBody,
      includeFrames,mode,singleWindow:waitForMediaMs !== undefined});
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

function snapshot(batch) {
  const counts = {active:0,queued:0,failed:0};
  for (const item of batch.items) {
    if (item.status === 'error') counts.failed++;
    else if (item.status === 'queued') counts.queued++;
    else if (['resolving','downloading','verifying'].includes(item.status)) counts.active++;
  }
  return {id:batch.id,status:batch.status,...counts,items:batch.items.map(item => ({...item})),
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

function historyRecord(batch, status = batch.status) {
  const redact = detail => detail && {stderr:'',...(detail.status && {status:detail.status}),
    ...(detail.reason && {reason:detail.reason}), ...(detail.expiresAt && {expiresAt:detail.expiresAt}),
    ...(Number.isSafeInteger(detail.retryAfterSec) && {retryAfterSec:detail.retryAfterSec})};
  return {id:batch.id, status, outDir:batch.outDir, delivery:batch.delivery, createdAt:batch.createdAt,
    log:batch.log, items:batch.items.map(item => item.detail ? {...item,detail:redact(item.detail)} : item),
    lastError:batch.lastError && {...batch.lastError,detail:redact(batch.lastError.detail)}, retry:batch.retry};
}

function savedBatch(id) {
  const batch = storedBatch(id);
  if (batch?.status !== 'interrupted') return batch;
  const message = '下载进程已中断，请重新提交原下载请求以继续';
  for (const item of batch.items.filter(pendingItem)) {
    const detail = {stderr:''};
    Object.assign(item,{status:'error',errorCode:'DOWNLOAD_INTERRUPTED',error:message,speed:0,etaSec:null,detail});
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

export function listBatches({limit = 20} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('INVALID_LIMIT', 'limit must be 1–100');
  const items = [];
  const all = new Map(storedBatches().map(batch => [batch.id,batch]));
  for (const [id,batch] of batches) all.set(id,batch);
  for (const batch of all.values()) {
    const interrupted = batch.status === 'interrupted';
    const completed = batch.items.filter(item => item.status === 'done').length;
    const status = interrupted ? (completed ? 'partial' : 'failed') : batch.status;
    items.push({id:batch.id, status, delivery:batch.delivery, createdAt:batch.createdAt,
      ...(interrupted && {resumable:true}),
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

export function cancel(id) {
  const batch = lookup(id);
  if (batch.resumable) return cancelInterrupted(id);
  if (batch.status === 'running' && !batch.controller) {
    throw new ApiError('BATCH_OTHER_PROCESS','请在提交批次的下载进程取消',409);
  }
  if (batch.status === 'running') {
    batch.status = 'cancelling';
    batch.controller.abort();
    if (batch.delivery === 'local') storeBatch(historyRecord(batch));
    publish(batch, '正在取消');
    pump();
  }
  return { ok: true };
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
  return {ok:true};
}

function getTargets(values, defaults) {
  if (!Array.isArray(values) || !values.length) {
    throw new ApiError('INVALID_ITEMS', '请添加至少一个媒体目标');
  }
  return values.map(value => {
    if (!value || !['page', 'stream'].includes(value.kind)) throw new ApiError('INVALID_KIND', 'kind 必须为 page 或 stream');
    if (value.title !== undefined && typeof value.title !== 'string') throw new ApiError('INVALID_TITLE', '标题必须是文本');
    if (value.format !== undefined && !['mp4', 'mkv'].includes(value.format)) {
      throw new ApiError('INVALID_FORMAT', '输出格式应为 mp4 或 mkv');
    }
    if (value.mode !== undefined && !['combined', 'video', 'audio', 'separate'].includes(value.mode)) {
      throw new ApiError('INVALID_MODE', '请选择音视频、仅视频、仅音频或分开保存');
    }
    if (value.quality != null && (!Number.isInteger(value.quality) || value.quality < 144 || value.quality > 4320)) {
      throw new ApiError('INVALID_QUALITY', '画质应为 144 至 4320 之间的整数');
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
    let url;
    try { url = mediaUrl(value.url).href; }
    catch (error) {
      if (error.code !== 'INVALID_URL' || values.length === 1) throw error;
      url = null;
    }
    return { kind: value.kind, url, format: value.format ?? defaults.format,
      mode: value.mode ?? defaults.mode, quality: value.quality === undefined ? defaults.quality : value.quality,
      audioFormat: value.audioFormat ?? defaults.audioFormat, subtitles: value.subtitles ?? defaults.subtitles,
      sourceKind:value.sourceKind, fastStart:value.fastStart ?? defaults.fastStart,
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

export function queue({ items, maxSec, prefetch, cookie, headers, concurrency, connections, delivery = 'local', requestId, useBrowserCookies } = {},
  originalExtension) {
  if (delivery !== 'local' && delivery !== 'browser') throw new ApiError('INVALID_DELIVERY', '无效的保存方式');
  if (useBrowserCookies !== undefined && useBrowserCookies !== false) {
    throw new ApiError('BROWSER_SESSION_UNAVAILABLE', '下载使用独立会话');
  }
  const defaults = delivery === 'local' ? getSettings().settings : defaultOutput;
  const targets = getTargets(items, defaults);
  if (concurrency === undefined) concurrency = defaults.concurrency;
  if (connections === undefined) connections = defaults.connections;
  if (!validConcurrency(concurrency)) throw new ApiError('INVALID_CONCURRENCY', '并发数应为 1 至 ' + maxConcurrency + ' 的整数');
  if (![4,8,12].includes(connections)) throw new ApiError('INVALID_CONNECTIONS', '单任务连接数应为 4、8 或 12');
  if (prefetch !== undefined && typeof prefetch !== 'boolean') throw new ApiError('INVALID_PREFETCH', 'prefetch 必须为布尔值');
  if (requestId !== undefined && (delivery !== 'browser' || typeof requestId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId))) {
    throw new ApiError('INVALID_REQUEST_ID', '浏览器任务编号无效');
  }
  const limit = durationLimit(maxSec);
  return enqueue({targets, limit, prefetch:prefetch ?? !limit, cookies:parseCookies(cookie), concurrency, connections,
    delivery, originalExtension, requestId, outDir:defaults.outDir, headers:parseMediaHeaders(headers)});
}

export function retryBatch({id} = {}) {
  const batch = lookup(id);
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

function enqueue(request) {
  const {targets, limit, prefetch, cookies, concurrency, connections, delivery, originalExtension, requestId, outDir} = request;
  const hashInputs = [targets, limit, prefetch, cookies, concurrency, connections, delivery, originalExtension, requestId, outDir];
  if (Object.keys(request.headers).length) hashInputs.push(request.headers);
  const key = createHash('sha256').update(JSON.stringify(hashInputs)).digest('hex');
  const existing = batches.get(batchKeys.get(key));
  if (existing?.status === 'running') return { id: existing.id, total: targets.length };

  const newRecord = previous => {
    const items = targets.map(({kind,title},idx) => ({idx,kind,title,status:'queued',percent:0,speed:0,bytes:0,
      totalBytes:null,etaSec:null,prefetch:null,file:null,error:null}));
    return {id:previous?.id ?? randomUUID(),status:'running',outDir,delivery,
      createdAt:previous?.createdAt ?? new Date().toISOString(),
      log:previous ? ['已恢复中断的下载批次'] : [],
      items:items.map((item,index) => {
        const prior = previous?.items[index];
        return prior && !pendingItem(prior) ? prior : item;
      })};
  };
  const claimed = delivery === 'local' ? claimBatch(key,newRecord) : {claimed:true,batch:newRecord()};
  const {id} = claimed.batch;
  if (!claimed.claimed) return {id,total:targets.length};
  const batch = {
    ...claimed.batch, controller: new AbortController(), listeners: new Set(),
    concurrency, connections, running: 0, delivery, originalExtension, files: new Map(),
    request,
  };
  batches.set(id, batch);
  batchKeys.set(key, id);
  const signal = AbortSignal.any([batch.controller.signal, session.signal]);
  const jobs = targets.flatMap((target, index) => pendingItem(batch.items[index]) ? [schedule(signal,
    () => runItem(batch, batch.items[index], {...target}, limit, cookies, signal), batch)
    .catch(error => {
      const item = batch.items[index];
      if (session.signal.aborted && !batch.controller.signal.aborted && delivery === 'local') return;
      item.status = signal.aborted ? 'cancelled' : 'error';
      item.speed = 0;
      item.etaSec = null;
      if (!signal.aborted) {
        const {code, message, detail} = errorDetails(error);
        item.error = message;
        item.errorCode = code;
        item.detail = detail ?? {stderr:''};
        batch.lastError = {idx:index,code,message,detail:item.detail};
      }
      if (delivery === 'local') storeBatch(historyRecord(batch));
      publish(batch, `[${index + 1}] ${item.error || '已取消'}`);
    })] : []);
  void Promise.all(jobs).then(() => {
    if (session.signal.aborted && !batch.controller.signal.aborted && delivery === 'local' && batch.items.some(pendingItem)) {
      storeBatch(historyRecord(batch,'interrupted'));
      return;
    }
    batch.status = batch.controller.signal.aborted || signal.aborted && batch.items.some(item => item.status === 'cancelled')
      ? 'cancelled' : completedStatus(batch.items);
    if (delivery !== 'local' || batch.items.every(item => item.status === 'done')) delete batch.request;
    if (batchKeys.get(key) === id) batchKeys.delete(key);
    if (delivery === 'local') storeBatch(historyRecord(batch));
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

function outputTracks(target, tracks) {
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
  const combinedAudio = !tracks || audio ? ['-map', audioMap + '?', '-c:a',
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
  item.status = 'resolving';
  publish(batch, `[${item.idx + 1}] 正在解析`);
  const input = mediaUrl(target.url);
  const supportedPage = target.kind === 'page' ? platformVideo(input) : null;
  const platform = platformDownloadsEnabled() ? supportedPage : null;
  let source = input;
  let sourceKind = target.sourceKind;
  let resolvedTitleSource;
  if (target.kind === 'page' && !platform) {
    const found = await inspectPage(input, cookies, signal, {selectionOnly:true});
    if (!found.streams.length) {
      if (found.blockers?.includes('drm')) throw new ApiError('DRM', '网页播放器使用 DRM', 422);
      if (supportedPage) throw new ApiError('PLATFORM_TOOL_REQUIRED', '请配置本机 yt-dlp 后重试', 503);
      const message = found.blockers?.includes('cloudflare-challenge')
        ? '站点返回 Cloudflare 验证页，未探测到媒体流'
        : '页面里没有找到可下载的媒体';
      throw new ApiError('NO_MEDIA', message, 422, {reason:found.selection.reason,diagnostic:found.diagnostic,stderr:'',
        ...(found.blockers && {blockers:found.blockers})});
    }
    const stream = found.streams.find(candidate => candidate.url === found.selection.url);
    if (!stream) throw new ApiError('AMBIGUOUS_MEDIA', '页面中有多个视频，请选择明确的视频来源', 422);
    source = mediaUrl(stream.url);
    sourceKind ||= ['m3u8','mpd'].includes(stream.kind) ? stream.kind : undefined;
    if (audioFormats.has(stream.kind) && target.mode === 'combined') target = {...target,mode:'audio'};
    if (!item.title) {
      item.title = stream.title || found.pageTitle || '';
      resolvedTitleSource = stream.titleSource;
    }
  }
  const scopedCookies = source.origin === input.origin ? cookies : [];
  const headers = {...capturedHeaders(source.href), ...batch.request.headers};
  const expiresAt = streamExpiry(source);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new ApiError('STREAM_EXPIRED', '媒体地址已过期，请重新探测原页面', 422, {expiresAt});
  }
  const directory = batch.delivery === 'browser' ? os.tmpdir() : batch.outDir;
  await mkdir(directory, { recursive: true });
  const recovery = batch.delivery === 'local' ? stagingRoot(directory,batch.id,item.idx) : null;
  if (recovery) {
    await mkdir(recovery,{recursive:true,mode:0o700});
    if (!(await lstat(recovery)).isDirectory()) throw new ApiError('INVALID_PATH','下载暂存路径无效');
  }
  let staging;
  let held = false;
  const saved = [];
  try {
    staging = recovery ? await mkdtemp(path.join(recovery,'attempt-')) : await mkdtemp(path.join(directory,'.media-toolkit-'));
    const updateProgress = percent => {
      if (percent > item.percent) { item.percent = percent; publish(batch); }
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
    const downloadProgress = (fraction, bytes, totalBytes) => {
      item.status = 'downloading';
      measure(bytes,totalBytes);
      if (fraction != null) updateProgress(Math.min(90,Math.floor(fraction * 90)));
    };
    sourceKind ||= classify(source);
    let staged;
    if (platform) {
      staged = await stagePlatform(platform,target,staging,batch.connections,signal,downloadProgress,headers);
    } else if (batch.request.prefetch) {
      if (sourceKind !== 'm3u8' && sourceKind !== 'mpd') {
        staged = await prefetchRanges(source,scopedCookies,staging,signal,downloadProgress,{
          connections:batch.connections,stageFull:!batch.originalExtension,onKind:kind => { sourceKind = kind; }, recovery,headers,
        });
      }
      if (!staged && sourceKind === 'm3u8') {
        staged = await prefetchHls(source,scopedCookies,staging,signal,downloadProgress,{
          quality:target.quality,sourceKind,connections:batch.connections,recovery,headers,
          onFallback: outcome => { item.prefetchFallback = outcome; },
        });
      }
      if (!staged) item.prefetchFallback ??= {reason:sourceKind === 'mpd' ? 'unsupported-dash-playlist' : 'direct-prefetch-unavailable'};
    }
    if (sourceKind === 'mpd' || sourceKind === 'm3u8' && !batch.request.prefetch) {
      await checkManifestProtection(source,scopedCookies,signal,{kind:sourceKind,quality:target.quality,headers});
    }
    if (platform) item.title ||= target.title;
    signal.throwIfAborted();
    item.prefetch = Boolean(staged);
    if (staged) publish(batch, '媒体预取完成');
    item.speed = 0;
    item.etaSec = null;
    if (batch.originalExtension) {
      if (staged) {
        await holdBrowserFiles(batch, item, staging, [{file:staged, name:`${filename(item.title)}.${batch.originalExtension}`}], signal);
        held = true;
      } else {
        item.native = true;
      }
      item.status = 'done';
      item.percent = 100;
      publish(batch, staged ? '原画下载完成' : '交给浏览器直接下载');
      return;
    }
    if (item.prefetchFallback) {
      item.status = 'resolving';
      publish(batch, `[${item.idx + 1}] 媒体预取未完成（${item.prefetchFallback.reason}），改用 FFmpeg 读取原地址`);
    }
    let media = staged || source;
    let info = await probeStream(media, scopedCookies, signal, true, undefined, headers);
    if (staged?.endsWith('.bin') && !platform && !info.tracks?.length) {
      media = source;
      item.prefetch = false;
      item.prefetchFallback = {reason:'staged-media-unrecognized'};
      publish(batch, '改用原地址读取媒体格式');
      info = await probeStream(media, scopedCookies, signal, true, undefined, headers);
    }
    const { duration, width, height, mediaTitle, tracks } = info;
    if (target.mode === 'combined' && tracks?.some(row => row.codec_type === 'audio') &&
        !tracks.some(row => row.codec_type === 'video' && !row.disposition?.attached_pic)) {
      target = {...target,mode:'audio'};
    }
    if (mediaTitle && (!item.title || (target.kind === 'page' && !target.title && canUseMediaTitle(resolvedTitleSource) && !platform))) {
      item.title = mediaTitle;
    }
    const { video, scaled, videoArgs, combinedAudio, audioArgs, subtitleArgs } = outputTracks(target, tracks);
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
    }, {strict:true});
    try {
      await encode();
    } catch (error) {
      const remoteDash = media instanceof URL && (sourceKind === 'mpd' || /\.mpd$/i.test(media.pathname));
      if (!remoteDash || !error.transientFirstFragment) throw error;
      publish(batch, '首个 DASH 分片暂时不可用，正在重试');
      await sleep(300, undefined, {signal});
      await encode();
    }
    signal.throwIfAborted();
    item.status = 'verifying';
    item.speed = 0;
    item.etaSec = null;
    if (batch.delivery === 'browser') {
      if (staged) {
        const stagedInput = sourceKind === 'm3u8' ? path.join(staging,'segments') : staged;
        await rm(stagedInput, {recursive:true,force:true,maxRetries:5}).catch(() => {});
      }
      for (const output of outputs) {
        await inspectOutput(output.file,signal,['mp3','m4a'].includes(output.extension) ? 'audio' : 'video',expected);
      }
      await holdBrowserFiles(batch, item, staging, outputs.map(({file}) => ({file})), signal);
      held = true;
    } else {
      for (const output of outputs) {
        signal.throwIfAborted();
        const file = await save(directory, output.file, output.name, output.extension);
        const record = {file,name:path.basename(file)};
        saved.push(record);
        record.info = await inspectOutput(file,signal,['mp3','m4a'].includes(output.extension) ? 'audio' : 'video',expected);
      }
      signal.throwIfAborted();
      item.file = saved[0].file;
      item.outputs = saved;
      item.info = saved[0].info;
      if (target.subtitles) item.subtitleTracks = saved.reduce((total, output) => total + output.info.subtitleTracks,0);
      const outputBytes = saved.reduce((total, output) => total + output.info.size,0);
      item.bytes = Math.max(item.bytes,outputBytes);
    }
    item.totalBytes = item.bytes;
    item.status = 'done';
    item.percent = 100;
    if (recovery) storeBatch(historyRecord(batch));
    publish(batch, `[${item.idx + 1}] 下载完成`);
  } catch (error) {
    await Promise.all(saved.map(({ file }) => rm(file, { force: true }).catch(() => {})));
    throw error;
  } finally {
    if (!held && staging) await rm(staging, {recursive:true,force:true,maxRetries:5}).catch(() => {});
    const interrupted = session.signal.aborted && !batch.controller.signal.aborted && item.status !== 'done';
    if (recovery && !interrupted) await rm(recovery,{recursive:true,force:true,maxRetries:5}).catch(() => {});
  }
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
  await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
    child.once('error', () => reject(new ApiError('OPEN_FAILED', '无法打开资源管理器', 503)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { ok: true };
}
