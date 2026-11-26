import { downloadFolder, readDownloadSettings } from './settings.mjs';

export const activeStates = ['queued', 'starting', 'processing', 'downloading', 'paused'];
export const endpointDefault = 'http://127.0.0.1:8765';

const storage = chrome.storage.local;
const alarm = 'media-download-queue';
let processingTimer;
let actions = Promise.resolve();
let refreshQueued = false;

export async function companion(connection, route, body) {
  if (!connection?.token) throw new Error('请先连接本机服务');
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(connection.endpoint)) throw new Error('本机服务地址无效');
  const response = await fetch(connection.endpoint + route, {
    headers:{authorization:'Bearer ' + connection.token, ...(body && {'content-type':'application/json'})},
    ...(body && {method:'POST', body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(6500),
  }).catch(() => { throw new Error('本机服务未响应'); });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || '本机服务请求失败'), {status:response.status});
  return data;
}

export function usesCompanion(stream, settings) {
  return ['m3u8', 'mpd'].includes(stream.kind) || settings.mode !== 'combined' ||
    settings.format !== 'auto' || Boolean(settings.quality) || settings.subtitles;
}

function safeFilename(name, kind) {
  const base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 110).replace(/[. ]+$/, '')
    .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=\.|$)/i, '_$1');
  return (base || 'video') + '.' + kind;
}

function serial(work) {
  const next = actions.then(work, work);
  actions = next.catch(() => {});
  return next;
}

async function readState() {
  const saved = await storage.get(['downloadJobs', 'downloadSettings', 'connection']);
  return {jobs:saved.downloadJobs ?? [], settings:readDownloadSettings(saved.downloadSettings), connection:saved.connection};
}

async function persist(jobs) {
  await storage.set({downloadJobs:jobs});
}

async function startBrowser(job, output, connection) {
  const file = output.href ? {
    url:connection.endpoint + output.href,
    filename:output.name,
    headers:[{name:'Authorization', value:'Bearer ' + connection.token}],
  } : {url:job.stream.url, filename:safeFilename(job.title, job.stream.kind)};
  const folder = downloadFolder(job.settings.downloadFolder ?? '');
  if (folder) file.filename = folder + '/' + file.filename;
  return chrome.downloads.download({...file, ...(job.settings.saveAs && {saveAs:true}), conflictAction:'uniquify'});
}

async function startNative(job, connection) {
  job.files = [{id:await startBrowser(job, {}, connection)}];
  job.batch = null;
  delete job.unreachableSince;
  job.percent = null;
  job.note = '';
  job.speed = job.bytes = job.totalBytes = 0;
  job.sampledAt = job.sampledBytes = 0;
  job.state = 'downloading';
}

async function startJob(job, connection) {
  if (!job.processed) {
    if (job.settings.accelerate && connection?.token) {
      const batch = await companion(connection, '/api/queue/original', {
        url:job.stream.url, title:job.title, extension:job.stream.kind, connections:job.settings.connections, requestId:job.attemptId,
      }).catch(() => null);
      if (batch?.id) {
        job.batch = batch.id;
        job.state = 'processing';
        return;
      }
    }
    return startNative(job, connection);
  }
  const {mode, quality, audioFormat, format, subtitles, connections, fastStart} = job.settings;
  const sourceKind = ['m3u8','mpd'].includes(job.stream.kind) ? job.stream.kind : undefined;
  const batch = await companion(connection, '/api/queue', {delivery:'browser', connections, requestId:job.attemptId, items:[{
    kind:'stream', url:job.stream.url, title:job.title, mode, audioFormat, subtitles, sourceKind, fastStart,
    format:format === 'mkv' ? 'mkv' : 'mp4', ...(quality && {quality:Number(quality)}),
  }]});
  job.batch = batch.id;
  job.state = 'processing';
}

async function transfer(job, connection, jobs) {
  const batch = await companion(connection, '/api/batch/' + job.batch);
  delete job.unreachableSince;
  const item = batch.items[0];
  job.percent = item.percent;
  job.bytes = item.bytes || 0;
  job.totalBytes = item.totalBytes || 0;
  job.speed = item.speed || 0;
  job.note = job.processed ? {queued:'等待本机处理', resolving:'读取媒体轨道', downloading:'正在下载并处理'}[item.status] || ''
    : {queued:'等待本机下载', resolving:'检查分段下载支持', downloading:'多连接下载中'}[item.status] || '';
  if (!job.processed && (item.native || item.status === 'error')) return startNative(job, connection);
  if (item.status === 'cancelled' || item.status === 'error') {
    job.state = item.status === 'error' ? 'failed' : 'cancelled';
    job.note = item.error || '';
    return;
  }
  if (item.status !== 'done') return;
  if (!item.outputs?.length || item.outputs.some((output, idx) => output.href !==
    `/api/batch/${job.batch}/files/0/${idx}`)) throw new Error('请使用当前版本的本机服务');
  job.files ??= [];
  for (const [index, output] of item.outputs.entries()) {
    if (job.files[index]) continue;
    job.files[index] = {id:await startBrowser(job, output, connection), name:output.name};
    await persist(jobs);
  }
  job.state = 'downloading';
  job.percent = null;
  job.speed = job.bytes = job.totalBytes = 0;
  job.sampledAt = job.sampledBytes = 0;
}

function release(job, connection) {
  if (job.batch) void companion(connection, `/api/batch/${job.batch}/files/0`, {}).catch(() => {});
}

async function browserProgress(job, connection) {
  const files = await Promise.all(job.files.map(async file => (await chrome.downloads.search({id:file.id}))[0]));
  job.files.forEach((record, index) => {
    if (files[index]?.filename) record.name = files[index].filename.split(/[\\/]/).at(-1);
  });
  const interrupted = files.find(file => file?.state === 'interrupted');
  job.canResume = files.some(file => file?.canResume);
  if ((files.some(file => !file) || interrupted) && !files.some(file => file?.state === 'in_progress')) {
    job.state = 'failed';
    job.note = interrupted?.error === 'USER_CANCELED' ? '浏览器已取消下载' : '浏览器下载中断';
    return;
  }
  const total = files.reduce((sum, file) => sum + Math.max(0, file?.totalBytes || 0), 0);
  const received = files.reduce((sum, file) => sum + (file?.bytesReceived || 0), 0);
  const now = Date.now();
  const elapsed = now - (job.sampledAt || now);
  if (!job.sampledAt || elapsed >= 750) {
    const speed = elapsed > 0 && !job.batch ? Math.max(0, (received - (job.sampledBytes || 0)) * 1000 / elapsed) : 0;
    job.speed = Math.round(speed && job.speed ? speed * .7 + job.speed * .3 : speed);
    job.sampledAt = now;
    job.sampledBytes = received;
  }
  job.bytes = received;
  job.totalBytes = total;
  job.percent = total > 0 ? Math.min(100, Math.floor(received / total * 100)) : null;
  job.note = job.batch ? '正在保存到 Edge' : '';
  if (files.every(file => file?.state === 'complete')) {
    job.state = 'done';
    job.percent = 100;
    job.note = '';
    release(job, connection);
  } else {
    job.state = files.some(file => file?.paused) ? 'paused' : 'downloading';
  }
}

function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  void serial(async () => {
    refreshQueued = false;
    await tick(await readState());
  }).catch(() => {});
}

function updateProcessingTimer(jobs, delay) {
  if (!jobs.some(job => job.state === 'processing')) {
    clearTimeout(processingTimer);
    processingTimer = undefined;
  } else if (processingTimer === undefined) {
    // The alarm recovers persisted jobs if the worker is stopped. While active,
    // check only as long as a companion task still needs to hand files to Edge.
    processingTimer = setTimeout(() => {
      processingTimer = undefined;
      void refresh();
    }, delay);
  }
}

async function tick(state) {
  const {jobs, settings, connection} = state;
  const before = JSON.stringify(jobs);
  let processingDelay = 750;
  await Promise.all(jobs.filter(job => ['processing', 'downloading', 'paused'].includes(job.state)).map(async job => {
    try {
      if (job.state === 'processing') await transfer(job, connection, jobs);
      if (['downloading', 'paused'].includes(job.state)) await browserProgress(job, connection);
    } catch (error) {
      job.note = error.message;
      const serviceUnavailable = !error.status && /未响应|请先连接/.test(error.message);
      if (job.state === 'processing' && !job.processed && !job.files?.some(Boolean) &&
          (serviceUnavailable || [401, 404].includes(error.status))) {
        if (serviceUnavailable && connection?.token) {
          job.unreachableSince ??= Date.now();
          if (Date.now() - job.unreachableSince < 15000) {
            processingDelay = 4000;
            return;
          }
        }
        try { await startNative(job, connection); }
        catch (fallbackError) { job.note = fallbackError.message; job.state = 'failed'; }
        return;
      }
      if (job.state === 'processing' && serviceUnavailable) {
        processingDelay = 4000;
        return;
      }
      if (error.status === 404) job.expired = true;
      job.state = 'failed';
    }
  }));
  // Persist the current state before assigning more browser downloads.
  if (JSON.stringify(jobs) !== before) await persist(jobs);
  const inFlight = jobs.filter(job => ['starting', 'processing', 'downloading', 'paused'].includes(job.state)).length;
  let available = Math.max(0, settings.concurrency - inFlight);
  const queued = jobs.filter(job => job.state === 'queued').reverse();
  while (available > 0 && queued.length) {
    const starting = queued.splice(0, available);
    for (const job of starting) {
      job.state = 'starting';
      if (!job.batch && !job.resumePending) job.attemptId = crypto.randomUUID();
    }
    await persist(jobs);
    const started = await Promise.all(starting.map(async job => {
      try {
        if (job.resumePending) {
          await resumeFiles(job);
          job.resumePending = false;
          job.state = 'downloading';
        } else if (job.batch) {
          job.state = 'processing';
        } else {
          await startJob(job, connection);
        }
        return 1;
      } catch (error) {
        job.state = 'failed';
        job.note = error.message;
        return 0;
      }
    }));
    available -= started.reduce((total, count) => total + count, 0);
    await persist(jobs);
  }
  updateProcessingTimer(jobs, processingDelay);
  if (jobs.some(job => activeStates.includes(job.state))) {
    if (!await chrome.alarms.get(alarm)) await chrome.alarms.create(alarm, {periodInMinutes:0.5});
  } else {
    await chrome.alarms.clear(alarm);
  }
  return jobs;
}

async function mutate({action, id, streams, settings}, state) {
  const {jobs, connection} = state;
  if (action === 'settings') {
    const next = readDownloadSettings(settings);
    state.settings = {...next, downloadFolder:downloadFolder(next.downloadFolder)};
    await storage.set({downloadSettings:state.settings});
  }
  if (action === 'clear') {
    for (let index = jobs.length - 1; index >= 0; index--) {
      if (!activeStates.includes(jobs[index].state)) jobs.splice(index, 1);
    }
    await persist(jobs);
  }
  if (action === 'enqueue') {
    for (const stream of streams) {
      const jobSettings = {...state.settings, ...stream.options};
      if (!/^(?:mp4|webm|mkv|mov|m4v|ogv|avi|m3u8|mpd)$/.test(stream.kind)) {
        throw new Error('不支持此媒体格式');
      }
      if (!/^https?:$/.test(new URL(stream.url).protocol)) throw new Error('媒体地址必须使用 HTTP(S)');
      const processed = usesCompanion(stream, jobSettings);
      if (processed && !connection?.token) throw new Error('请先连接本机服务');
      jobs.unshift({id:crypto.randomUUID(), stream:{url:stream.url, kind:stream.kind},
        title:stream.title?.trim() || '视频', settings:jobSettings, processed, state:'queued', percent:null});
    }
    const completed = jobs.filter(job => !activeStates.includes(job.state));
    if (completed.length > 60) jobs.splice(0, jobs.length, ...jobs.filter(job => !completed.slice(60).includes(job)));
    await persist(jobs);
  }
  const job = jobs.find(entry => entry.id === id);
  if (job && action === 'cancel') {
    await Promise.all(job.files?.filter(Boolean).map(file => chrome.downloads.cancel(file.id).catch(() => {})) ?? []);
    if (job.batch) await companion(connection, '/api/cancel', {id:job.batch}).catch(() => {});
    release(job, connection);
    job.state = 'cancelled';
    job.note = '';
    await persist(jobs);
  }
  if (job && action === 'retry' && ['failed', 'cancelled'].includes(job.state)) {
    const previous = job.files ?? [];
    const records = await Promise.all(previous.map(async file => file ? (await chrome.downloads.search({id:file.id}))[0] : null));
    if (job.state === 'failed' && job.batch && !job.expired && records.some(record =>
      ['complete', 'in_progress'].includes(record?.state))) {
      job.files = previous.map((file, index) => ['complete', 'in_progress'].includes(records[index]?.state) ? file : null);
    } else {
      release(job, connection);
      for (const file of records) {
        if (file?.state === 'in_progress') await chrome.downloads.cancel(file.id).catch(() => {});
      }
      Object.assign(job, {batch:null, files:[], bytes:0, totalBytes:0, speed:0, sampledAt:0, sampledBytes:0});
    }
    Object.assign(job, {state:'queued', percent:null, note:'', canResume:false, expired:false, resumePending:false});
    await persist(jobs);
  }
  if (job && ['pause', 'resume'].includes(action)) {
    if (action === 'resume' && job.state === 'failed') {
      Object.assign(job, {state:'queued', resumePending:true});
    } else if (action === 'resume') {
      await resumeFiles(job);
      job.state = 'downloading';
    } else {
      await Promise.all(job.files.filter(Boolean).map(async file => {
        const [current] = await chrome.downloads.search({id:file.id});
        if (current?.state === 'in_progress' && !current.paused) await chrome.downloads.pause(file.id);
      }));
      job.state = 'paused';
    }
    await persist(jobs);
  }
  return tick(state);
}

async function resumeFiles(job) {
  await Promise.all(job.files.filter(Boolean).map(async file => {
    const [current] = await chrome.downloads.search({id:file.id});
    if (current?.canResume) await chrome.downloads.resume(file.id);
  }));
}

export function registerDownloads() {
  chrome.runtime.onStartup.addListener(() => void serial(async () => {
    const state = await readState();
    for (const job of state.jobs.filter(entry => entry.state === 'starting')) {
      job.state = 'failed';
      job.note = '浏览器已重启，请检查下载记录后重试';
    }
    await persist(state.jobs);
    await tick(state);
  }).catch(() => {}));
  chrome.alarms.onAlarm.addListener(event => { if (event.name === alarm) void refresh(); });
  chrome.downloads.onChanged.addListener(event => {
    if (event.state || event.paused || event.error) void refresh();
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.scope !== 'media-downloads' || sender.id !== chrome.runtime.id || sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    serial(async () => mutate(message, await readState()))
      .then(jobs => reply({jobs}), error => reply({error:error.message}));
    return true;
  });
}
