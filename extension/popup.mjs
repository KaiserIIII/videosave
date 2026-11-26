import { browserApi, downloadsPage, downloadSettingsPage, isAndroid, nativeDownloads } from './browser.mjs';
import { classify, isPlaylist, pageStreams, scanDocument, sourceTitle } from './media.mjs';
import { activeStates, companion, endpointDefault, usesCompanion } from './downloads.mjs';
import { defaults, downloadFolder, maxConcurrency, readDownloadSettings } from './settings.mjs';
import { canQuerySize, preparePreview, queryMediaSize } from './preview.mjs';

const $ = id => document.getElementById(id);
const storage = browserApi.storage.local;
document.documentElement.dataset.mobile = String(isAndroid || !nativeDownloads);
document.documentElement.dataset.directOnly = String(!nativeDownloads);
const acceptedEndpoint = /^http:\/\/127\.0\.0\.1(?::[0-9]+)?$/;
const statusNames = {queued:'排队中', starting:'正在启动', processing:'本机处理中',
  downloading:'下载中', paused:'已暂停', done:'已完成', failed:'下载失败', cancelled:'已取消'};
const optionSets = {
  mode:['下载内容', [['combined','音视频合并'], ['video','仅视频'], ['audio','仅音频'], ['separate','音频与视频分开']]],
  quality:['画质上限', [['','原画'], ['4320','4320p · 8K'], ['2160','2160p · 4K'], ['1440','1440p'],
    ['1080','1080p'], ['720','720p'], ['480','480p'], ['360','360p'], ['240','240p']]],
  format:['视频格式', [['auto','自动 · 原格式 / MP4'], ['mp4','MP4'], ['mkv','MKV']]],
  audioFormat:['音频格式', [['m4a','M4A'], ['mp3','MP3']]],
  subtitles:['源文件内嵌字幕', [['false','不保留'], ['true','有则保留']]],
  concurrency:['同时下载 · 1–' + maxConcurrency],
  accelerate:['原画直链加速', [['true','自动 · 需本机服务'], ['false','浏览器直接下载']]],
  connections:['单任务连接数', [['4','4 · 稳定'], ['8','8 · 默认'], ['12','12 · 高速']]],
  fastStart:['MP4 / M4A 文件优化', [['true','支持边下边播'], ['false','优先完成保存']]],
  naming:['默认文件名', [['title','视频标题'], ['source','源文件名']]],
  conflictAction:['遇到同名文件', [['uniquify','自动加序号'], ['prompt','询问保存位置']]],
  density:['列表密度', [['comfortable','标准'], ['compact','紧凑']]],
  preview:['动态预览', [['click','点击封面'], ['hover','悬停或点击'], ['off','关闭']]],
  previewSeconds:['预览时长', [['3','3 秒'], ['6','6 秒'], ['10','10 秒']]],
  showSize:['源视频大小', [['true','显示'], ['false','隐藏']]],
  sizeLookup:['缺少大小时', [['true','轻量查询'], ['false','仅用网页记录']]],
  showThumbnails:['封面', [['true','显示'], ['false','隐藏']]],
  startPanel:['打开时显示', [['videos','视频'], ['downloads','下载队列']]],
  autoScan:['自动补扫', [['true','开启'], ['false','仅手动扫描']]],
  showHost:['视频来源域名', [['false','隐藏'], ['true','显示']]],
};
const themes = {system:'跟随系统',light:'浅色',dark:'深色',jade:'竹青',amber:'琥珀'};

let panel = 'videos';
let preferences = {...defaults};
let connection = {endpoint:endpointDefault, token:''};
let tab;
let pageTitle = '';
let streams = [];
let lastStreams;
let lastJobs;
let downloadJobs = [];
let scanning = false;
let scanTimer;
let pollTimer;
let polling = false;
let openedOptions;
let hoverPreview;
let previewController;
let previewObjectUrl;
let sizeLookupRunning = false;
const observedSizes = new Map();
const selected = new Set();

function status(message) { $('status').textContent = message; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function guarded(handler) {
  return async event => {
    try { await handler(event); }
    catch (error) { status(error.message || String(error)); }
  };
}
function button(text, className, handler) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', guarded(handler));
  return node;
}

function showPanel(next) {
  stopHoverPreview();
  if (panel !== next) $(next).animate([{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'none'}],
    {duration:matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,easing:'ease-out'});
  panel = next;
  for (const nav of document.querySelectorAll('nav [data-panel]')) {
    const current = nav.dataset.panel === panel;
    $(nav.dataset.panel).hidden = !current;
    if (current) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  $('status').textContent = '';
  document.querySelector('main').scrollTop = 0;
  if (panel === 'downloads') void tick();
}

function showServiceSettings() {
  showPanel('settings');
  $('service-settings').open = true;
  $('endpoint').focus();
}

function durationLabel(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return '时长未知';
  const total = Math.round(duration);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds : minutes + ':' + seconds;
}

function optionsInto(parent, keys, values, changed) {
  const controls = {};
  const syncControls = () => {
    if (controls.format) controls.format.disabled = values.mode === 'audio';
    if (controls.quality) controls.quality.disabled = values.mode === 'audio';
    if (controls.subtitles) controls.subtitles.disabled = values.mode === 'audio';
    if (controls.audioFormat) controls.audioFormat.disabled = !['audio','separate'].includes(values.mode);
    if (controls.previewSeconds) controls.previewSeconds.disabled = values.preview === 'off';
    if (controls.sizeLookup) controls.sizeLookup.disabled = !values.showSize;
  };
  for (const key of keys) {
    const [label, choices] = optionSets[key];
    const field = element('label', '', label);
    const control = element(choices ? 'select' : 'input');
    control.dataset.option = key;
    if (choices) {
      for (const [value, text] of choices) control.add(new Option(text, value));
    } else {
      control.type = 'number';
      control.min = '1';
      control.max = String(maxConcurrency);
      control.required = true;
    }
    control.value = String(values[key]);
    control.addEventListener('change', guarded(async () => {
      if (!control.checkValidity()) {
        control.value = String(values[key]);
        throw new Error('同时下载数量须为 1 至 ' + maxConcurrency + ' 的整数');
      }
      values[key] = typeof defaults[key] === 'number' ? Number(control.value)
        : typeof defaults[key] === 'boolean' ? control.value === 'true' : control.value;
      syncControls();
      await changed(values);
    }));
    controls[key] = control;
    field.append(control);
    parent.append(field);
  }
  syncControls();
  parent.addEventListener('settings-sync', () => {
    for (const [key, control] of Object.entries(controls)) control.value = String(values[key]);
    syncControls();
  });
  return values;
}

function connectionLabel() {
  const node = $('connection-status');
  node.dataset.connected = Boolean(connection.token);
  node.lastChild.textContent = connection.token ? '已配对' : '连接服务';
}

async function request(action, args = {}) {
  const result = await browserApi.runtime.sendMessage({scope:'media-downloads', action, ...args});
  if (!result || result.error) throw new Error(result?.error || '下载队列暂不可用');
  updateJobs(result.jobs);
}

async function enqueue(items) {
  if (!nativeDownloads) {
    if (items.length !== 1 || isPlaylist(items[0].kind)) throw new Error('手机版可打开单个直链。分片流请使用桌面版。');
    await browserApi.tabs.create({url:items[0].url});
    status('在新标签页长按视频，选择浏览器的保存选项。');
    return;
  }
  if (!connection.token && items.some(stream => usesCompanion(stream, {...preferences, ...stream.options}))) {
    showServiceSettings();
    throw new Error('当前选项需要连接本机服务');
  }
  await request('enqueue', {streams:items.map(stream => ({...stream,title:downloadTitle(stream)}))});
  selected.clear();
  document.querySelectorAll('#media input[type=checkbox]').forEach(input => { input.checked = false; });
  updateBulk();
  showPanel('downloads');
  status(items.length === 1 ? '已加入队列' : '已加入 ' + items.length + ' 个任务');
}

function downloadTitle(stream) {
  if (stream.customTitle) return stream.customTitle;
  const filename = sourceTitle(stream);
  return (preferences.naming === 'source' && filename) || stream.title || filename || (streams.length <= 1 && pageTitle) || '未命名视频';
}

function updateBulk() {
  $('bulk').hidden = !nativeDownloads || streams.length < 2;
  $('media-count').hidden = !streams.length;
  $('media-count').textContent = streams.length;
  $('all').checked = streams.length > 0 && streams.every(stream => selected.has(stream.url));
  $('all').indeterminate = selected.size > 0 && !$('all').checked;
  $('queue-selected').disabled = !selected.size;
  $('queue-selected').textContent = selected.size ? '下载所选 · ' + selected.size : '下载所选';
}

function sizeLabel(stream) {
  const result = stream.size ? {size:stream.size, estimated:stream.sizeEstimated} : observedSizes.get(stream.url);
  return result ? (result.estimated ? '约 ' : '') + formatBytes(result.size) : '大小未知';
}

async function queryMissingSizes() {
  if (!preferences.showSize || !preferences.sizeLookup || sizeLookupRunning) return;
  const pending = streams.filter(stream => !stream.size && canQuerySize(stream) && !observedSizes.has(stream.url)).slice(0, 12);
  if (!pending.length) return;
  sizeLookupRunning = true;
  try {
    await Promise.all(Array.from({length:Math.min(4, pending.length)}, async () => {
      while (pending.length) {
        const stream = pending.shift();
        observedSizes.set(stream.url, await queryMediaSize(stream).catch(() => null));
        const row = Array.from($('media').children).find(item => item.dataset.url === stream.url);
        const label = row?.querySelector('.media-size');
        const current = streams.find(item => item.url === stream.url);
        if (current && label) label.textContent = sizeLabel(current);
      }
    }));
  } finally {
    sizeLookupRunning = false;
  }
}

function resetVideo(video) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function stopHoverPreview(container) {
  if (!hoverPreview || container && hoverPreview.container !== container) return;
  const {timer, video} = hoverPreview;
  hoverPreview = undefined;
  clearTimeout(timer);
  if (video) {
    resetVideo(video);
    video.remove();
  }
}

function scheduleHoverPreview(container, stream) {
  if ($('preview-dialog').open || matchMedia('(prefers-reduced-motion: reduce)').matches || isPlaylist(stream.kind)) return;
  stopHoverPreview();
  const pending = {container, timer:setTimeout(() => {
    const video = element('video');
    pending.video = video;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.src = stream.url;
    video.addEventListener('timeupdate', () => {
      if (video.currentTime >= preferences.previewSeconds) video.pause();
    });
    video.addEventListener('error', () => stopHoverPreview(container), {once:true});
    container.append(video);
    void video.play().catch(() => stopHoverPreview(container));
  }, 320)};
  hoverPreview = pending;
}

async function openPreview(stream, title) {
  const dialog = $('preview-dialog');
  if (dialog.open) return;
  stopHoverPreview();
  const video = $('preview-video');
  const notice = $('preview-status');
  const setNotice = message => {
    notice.textContent = message;
    notice.hidden = !message;
  };
  const controller = new AbortController();
  previewController = controller;
  $('preview-title').textContent = title;
  setNotice('正在加载预览…');
  dialog.showModal();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
  const play = async url => {
    signal.throwIfAborted();
    video.src = url;
    const stop = () => resetVideo(video);
    signal.addEventListener('abort', stop, {once:true});
    try {
      await video.play();
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', stop);
    }
    setNotice('');
  };
  try {
    if (!isPlaylist(stream.kind) || stream.kind === 'm3u8' && video.canPlayType('application/vnd.apple.mpegurl')) {
      try {
        await play(stream.url);
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!connection.token) throw error;
      }
    }
    if (!connection.token) {
      setNotice('连接本机服务后可预览此视频。');
      return;
    }
    const clip = await preparePreview(connection, stream, preferences.previewSeconds, signal);
    signal.throwIfAborted();
    previewObjectUrl = URL.createObjectURL(clip);
    await play(previewObjectUrl);
  } catch (error) {
    if (!controller.signal.aborted) setNotice('预览不可用 · ' + (signal.aborted ? '加载超时' : error.message));
  }
}

$('preview-video').addEventListener('timeupdate', event => {
  const video = event.target;
  if (!video.dataset.previewEnded && video.currentTime >= preferences.previewSeconds) {
    video.dataset.previewEnded = 'true';
    video.pause();
  }
});
$('preview-dialog').addEventListener('close', () => {
  previewController?.abort();
  const video = $('preview-video');
  resetVideo(video);
  delete video.dataset.previewEnded;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = undefined;
});

function renderMedia(stream) {
  const row = element('li');
  row.dataset.url = stream.url;
  const summary = element('div');
  const label = element('strong', 'media-title', stream.title || sourceTitle(stream) || '未命名视频');
  label.title = label.textContent;
  const details = element('small', 'details', [
    ({m3u8:'HLS', mpd:'DASH'}[stream.kind] || stream.kind.toUpperCase()),
    stream.duration && durationLabel(stream.duration), stream.width && stream.height && (stream.width + '×' + stream.height),
    preferences.showHost && new URL(stream.url).hostname,
  ].filter(Boolean).join(' · '));
  if (preferences.showSize) details.append(element('span', 'media-size', sizeLabel(stream)));
  summary.append(label, details);

  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(stream.url);
  checkbox.setAttribute('aria-label', '选择 ' + label.textContent);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(stream.url);
    else selected.delete(stream.url);
    updateBulk();
  });
  const preview = preferences.preview === 'off' ? element('div', 'preview')
    : button('', 'preview preview-trigger', () => openPreview(stream, label.textContent));
  preview.append(element('span', 'play-icon'));
  if (preferences.preview !== 'off') preview.setAttribute('aria-label', '预览 ' + label.textContent);
  else preview.setAttribute('aria-hidden', 'true');
  if (preferences.showThumbnails && stream.poster && /^https?:$/.test(URL.parse(stream.poster)?.protocol || '')) {
    const image = element('img');
    image.src = stream.poster;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), {once:true});
    preview.append(image);
  }
  if (preferences.preview === 'hover') {
    preview.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') scheduleHoverPreview(preview, stream); });
    preview.addEventListener('pointerleave', () => stopHoverPreview(preview));
  }
  const actions = element('div', 'actions');
  const config = element('div', 'card-options');
  config.hidden = true;
  const optionsToggle = button('⋯', 'quiet options-button', () => {
    const opening = config.hidden;
    if (openedOptions && openedOptions.config !== config) {
      openedOptions.config.hidden = true;
      openedOptions.button.setAttribute('aria-expanded', 'false');
    }
    config.hidden = !opening;
    optionsToggle.setAttribute('aria-expanded', String(opening));
    openedOptions = opening ? {config, button:optionsToggle} : null;
  });
  optionsToggle.setAttribute('aria-label', '打开 ' + label.textContent + ' 的下载选项');
  optionsToggle.setAttribute('aria-expanded', 'false');
  const downloadLabel = nativeDownloads ? '下载' : '打开视频';
  const download = button(downloadLabel, 'download-button', async () => enqueue([stream]));
  download.setAttribute('aria-label', downloadLabel + ' ' + label.textContent);

  const rename = element('label', '', '文件名');
  const name = element('input');
  name.type = 'text';
  name.value = downloadTitle(stream);
  name.maxLength = 150;
  rename.append(name);
  const grid = element('div', 'option-grid');
  const options = nativeDownloads ? optionsInto(grid, ['mode', 'quality', 'format', 'audioFormat', 'subtitles'],
    {...preferences}, () => {}) : {};
  let chosen = stream;
  if (stream.alternates?.length) {
    const sources = [stream, ...stream.alternates];
    const field = element('label', '', '媒体来源');
    const picker = element('select');
    for (const [index, source] of sources.entries()) {
      picker.add(new Option(`${source.kind.toUpperCase()} · ${new URL(source.url).hostname}`, index));
    }
    picker.addEventListener('change', () => { chosen = sources[Number(picker.value)]; });
    field.append(picker);
    grid.prepend(field);
  }
  const configActions = element('div', 'actions');
  configActions.append(button('复制链接', 'quiet', async () => {
    await navigator.clipboard.writeText(chosen.url);
    status('链接已复制');
  }), button(downloadLabel, '', () => enqueue([{...chosen, customTitle:name.value.trim(), options}])));
  if (nativeDownloads) config.append(rename);
  if (nativeDownloads || stream.alternates?.length) config.append(grid);
  config.append(configActions);
  actions.append(optionsToggle, download);
  const select = element('div','select-media');
  if (!nativeDownloads) select.hidden = true;
  select.append(checkbox);
  row.append(select, preview, summary, actions, config);
  return row;
}

async function refresh(retries = 4) {
  if (!tab || scanning) return;
  clearTimeout(scanTimer);
  scanning = true;
  if (retries === 4) $('refresh').disabled = true;
  try {
    const scan = allFrames => browserApi.scripting.executeScript({target:{tabId:tab.id, allFrames},func:scanDocument});
    const frames = (await scan(true).catch(() => scan(false).catch(() => []))).filter(frame => frame.result);
    const observations = frames.map(frame => frame.result);
    const top = frames.find(frame => frame.frameId === 0)?.result;
    pageTitle = top?.pageTitle || tab.title || '';
    $('site').textContent = URL.parse(tab.url)?.hostname || '';
    $('page-title').textContent = pageTitle || '当前标签页';
    $('page-title').title = pageTitle;
    const key = 'media:' + tab.id;
    const requests = (await browserApi.storage.session.get(key))[key] || [];
    const encrypted = observations.some(row => row.encrypted);
    streams = encrypted ? [] : pageStreams(frames, requests);
    if (!nativeDownloads) streams = streams.flatMap(stream => {
      const [direct, ...alternates] = [stream, ...(stream.alternates ?? [])].filter(source => !isPlaylist(source.kind));
      return direct ? [{...direct, alternates}] : [];
    });
    const snapshot = JSON.stringify(streams);
    if (snapshot !== lastStreams && !openedOptions && !hoverPreview) {
      for (const url of selected) {
        if (!streams.some(stream => stream.url === url)) selected.delete(url);
      }
      $('media').replaceChildren(...streams.map(renderMedia));
      lastStreams = snapshot;
      updateBulk();
    }
    const hint = $('hint');
    hint.hidden = streams.length > 0;
    hint.textContent = encrypted ? '播放器启用了 DRM' : !nativeDownloads
      ? '还没有找到直链视频。播放后可以再扫描。分片流需要桌面版。' : observations.some(row => row.opaque)
      ? '播放一段视频后再扫描，查找分片清单。'
      : '还没有找到视频。开始播放后再扫描，也可以粘贴媒体链接。';
    void queryMissingSizes();
    if (preferences.autoScan && retries && observations.length && !encrypted &&
        (!streams.length || streams.some(stream => !stream.duration || !stream.title ||
          preferences.showSize && canQuerySize(stream) && !stream.size && !observedSizes.has(stream.url)))) {
      scanTimer = setTimeout(guarded(() => refresh(retries - 1)), 1500);
    }
  } finally {
    scanning = false;
    if (retries === 4) $('refresh').disabled = false;
  }
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  const scale = bytes >= 1024 ** 3 ? [1024 ** 3, 'GB'] : bytes >= 1024 ** 2 ? [1024 ** 2, 'MB'] : [1024, 'KB'];
  return (bytes / scale[0]).toFixed(1) + ' ' + scale[1];
}

function renderJob(job) {
  const row = element('li');
  row.dataset.id = job.id;
  row.dataset.state = job.state;
  const header = element('div', 'queue-top');
  const title = element('strong', 'media-title', job.title);
  title.title = job.title;
  const badge = element('span', 'queue-status', statusNames[job.state]);
  badge.dataset.state = job.state;
  header.append(title, badge);
  row.append(header);
  if (['processing', 'downloading', 'paused'].includes(job.state)) {
    const progress = element('progress');
    progress.max = 100;
    if (job.percent != null) progress.value = job.percent;
    progress.setAttribute('aria-label', title.textContent + ' 下载进度');
    row.append(progress);
  }
  const description = [job.percent != null && job.state !== 'done' ? job.percent + '%' : '',
    job.bytes && job.state !== 'done' ? formatBytes(job.bytes) + (job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : '') : '',
    job.speed && ['downloading','processing'].includes(job.state) ? formatBytes(job.speed) + '/s' : '', job.note]
    .filter(Boolean).join(' · ');
  if (description) row.append(element('p', 'details', description));
  const actions = element('div', 'actions');
  if (job.state === 'downloading') actions.append(button('暂停', 'quiet', () => request('pause', {id:job.id})));
  if (job.canResume && ['paused','failed'].includes(job.state)) {
    actions.append(button('继续', 'quiet', () => request('resume', {id:job.id})));
  }
  if (activeStates.includes(job.state)) actions.append(button('取消', 'quiet', () => request('cancel', {id:job.id})));
  if (['failed','cancelled'].includes(job.state)) actions.append(button('重试', 'quiet', () => request('retry', {id:job.id})));
  if (job.state === 'done') {
    for (const [index, file] of job.files.entries()) {
      const label = element('p', 'filename', file.name);
      label.title = file.name;
      row.append(label);
      actions.append(button(job.files.length === 1 ? '在文件夹中显示' : '显示' + (index === 0 ? '视频' : '音频'),
        'quiet', () => browserApi.downloads.show(file.id)));
    }
  }
  if (actions.childElementCount) row.append(actions);
  return row;
}

function updateJobs(jobs) {
  downloadJobs = jobs;
  const active = jobs.filter(job => activeStates.includes(job.state)).length;
  $('active-count').hidden = !active;
  $('active-count').textContent = active;
  $('queue-empty').hidden = Boolean(jobs.length);
  $('clear').hidden = !jobs.some(job => !activeStates.includes(job.state));
  const snapshot = JSON.stringify(jobs);
  if (snapshot !== lastJobs) {
    const focused = document.activeElement;
    const id = focused?.closest('#queue li')?.dataset.id;
    const previous = new Map([...$('queue').children].map(row => [row.dataset.id, row]));
    const rows = jobs.map(job => {
      const old = previous.get(job.id);
      const row = renderJob(job);
      if (!old) row.classList.add('new-job');
      const bar = row.querySelector('progress');
      const oldValue = old?.querySelector('progress')?.getAttribute('value');
      if (bar?.hasAttribute('value') && oldValue != null) {
        bar.style.setProperty('--progress-before', oldValue + '%');
        bar.style.setProperty('--progress-now', bar.value + '%');
        bar.classList.add('progress-change');
      }
      return row;
    });
    $('queue').replaceChildren(...rows);
    if (id) {
      const row = rows.find(node => node.dataset.id === id);
      [...(row?.querySelectorAll('button') || [])].find(node => node.textContent === focused.textContent)?.focus({preventScroll:true});
    }
    lastJobs = snapshot;
  }
  clearTimeout(pollTimer);
  if (panel === 'downloads' && jobs.some(job => job.state === 'downloading')) pollTimer = setTimeout(tick, 1100);
}

async function tick() {
  if (polling) return;
  polling = true;
  try { await request('tick'); }
  catch (error) { status(error.message); }
  finally { polling = false; }
}

for (const nav of document.querySelectorAll('nav [data-panel]')) {
  nav.addEventListener('click', () => showPanel(nav.dataset.panel));
}
$('connection-status').addEventListener('click', showServiceSettings);
$('refresh').addEventListener('click', guarded(() => refresh()));
$('all').addEventListener('change', () => {
  selected.clear();
  for (const input of $('media').querySelectorAll('input[type=checkbox]')) {
    input.checked = $('all').checked;
    if (input.checked) selected.add(input.closest('li').dataset.url);
  }
  updateBulk();
});
$('queue-selected').addEventListener('click', guarded(() => enqueue(streams.filter(stream => selected.has(stream.url)))));
function linkToBrowserPage(id, url) {
  const link = $(id);
  link.hidden = !url;
  if (url) link.addEventListener('click', guarded(() => browserApi.tabs.create({url})));
}
linkToBrowserPage('history', downloadsPage);
$('folder').addEventListener('click', guarded(async () => {
  if (preferences.downloadFolder && !preferences.saveAs) {
    const ids = downloadJobs.filter(job => job.state === 'done' && job.settings.downloadFolder === preferences.downloadFolder)
      .flatMap(job => job.files.map(file => file.id));
    const downloads = await Promise.all(ids.map(id => browserApi.downloads.search({id, exists:true, state:'complete'})));
    const suffix = '/' + preferences.downloadFolder.toLowerCase();
    const match = downloads.flat().find(file => file.filename.toLowerCase().replaceAll('\\', '/')
      .split('/').slice(0, -1).join('/').endsWith(suffix));
    if (match) return browserApi.downloads.show(match.id);
  }
  return browserApi.downloads.showDefaultFolder();
}));
linkToBrowserPage('browser-download-settings', downloadSettingsPage);
$('clear').addEventListener('click', guarded(() => request('clear')));
$('pair').addEventListener('submit', guarded(async event => {
  event.preventDefault();
  const endpoint = $('endpoint').value.replace(/\/$/, '');
  if (!acceptedEndpoint.test(endpoint) || !URL.canParse(endpoint)) throw new Error('请输入 127.0.0.1 的本机 HTTP 地址');
  const next = {endpoint, token:$('token').value.trim()};
  await companion(next, '/api/health');
  await storage.set({connection:next});
  connection = next;
  connectionLabel();
  if ($('settings-sync').checked) await request('sync-settings');
  status('本机服务已连接');
}));
$('manual').addEventListener('submit', guarded(async event => {
  event.preventDefault();
  const url = $('manual-url').value.trim();
  const kind = classify(url, '', true);
  if (!kind) throw new Error('请输入 HTTP(S) 媒体地址');
  const filename = new URL(url).pathname.split('/').at(-1);
  let decoded;
  try { decoded = decodeURIComponent(filename); } catch { decoded = filename; }
  await enqueue([{url, kind, title:decoded.replace(/\.[^.]+$/, '')}]);
}));

await guarded(async () => {
  if (!isAndroid && browserApi.windows?.getCurrent && !(await browserApi.tabs.getCurrent())) {
    const browser = await browserApi.windows.getCurrent();
    const width = Math.min(screen.availWidth, browser.width ?? screen.availWidth);
    const height = Math.min(screen.availHeight, browser.height ?? screen.availHeight);
    const style = document.documentElement.style;
    const preferredWidth = Math.max(180, width - 32);
    style.setProperty('--popup-available-width', preferredWidth + 'px');
    style.setProperty('--popup-available-height', Math.max(160, height - 120) + 'px');
    // The browser can cap the popup after opening a provisional viewport
    // to a narrower area around its toolbar.
    let fitTimer;
    const fitWidth = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (innerWidth >= Math.min(260, preferredWidth) && innerWidth < document.body.offsetWidth) {
          style.setProperty('--popup-available-width', innerWidth + 'px');
        }
      }, 80);
    };
    window.addEventListener('resize', fitWidth);
    fitWidth();
  }
  const saved = await storage.get(['connection','downloadSettings','downloadJobs','settingsSync']);
  connection = saved.connection ?? connection;
  preferences = readDownloadSettings(saved.downloadSettings);
  const root = document.documentElement;
  const accentInput = $('theme-accent');
  const folderInput = $('download-folder');
  const applyAppearance = () => {
    root.dataset.theme = preferences.theme;
    root.dataset.density = preferences.density;
    const accent = /^#[\da-f]{6}$/i.test(preferences.accent) ? preferences.accent : '';
    if (accent) {
      root.style.setProperty('--custom-accent', accent);
      const luminance = accent.slice(1).match(/../g).reduce((total, component, index) => {
        const channel = parseInt(component, 16) / 255;
        return total + [0.2126, 0.7152, 0.0722][index] * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      }, 0);
      root.style.setProperty('--mark-ink', luminance > 0.179 ? '#000' : '#fff');
    } else {
      root.style.removeProperty('--custom-accent');
      root.style.removeProperty('--mark-ink');
    }
    accentInput.value = accent || getComputedStyle(root).getPropertyValue('--accent').trim();
    $('reset-accent').hidden = !accent;
  };
  applyAppearance();
  $('endpoint').value = connection.endpoint;
  $('token').value = connection.token;
  $('save-as').checked = preferences.saveAs;
  folderInput.value = preferences.downloadFolder;
  connectionLabel();
  const saveOptions = async options => {
    preferences = {...options};
    applyAppearance();
    if (nativeDownloads) await request('settings', {settings:preferences});
    else await storage.set({downloadSettings:preferences});
    if (!openedOptions) $('media').replaceChildren(...streams.map(renderMedia));
    void queryMissingSizes();
  };
  const values = {...preferences};
  const syncToggle = $('settings-sync');
  const syncNow = $('sync-now');
  syncToggle.checked = Boolean(saved.settingsSync);
  syncNow.disabled = !syncToggle.checked;
  const pullSettings = () => {
    if (nativeDownloads && syncToggle.checked && connection.token) return request('sync-settings');
  };
  syncToggle.addEventListener('change', guarded(async () => {
    await storage.set({settingsSync:syncToggle.checked});
    syncNow.disabled = !syncToggle.checked;
    await pullSettings();
  }));
  syncNow.addEventListener('click', guarded(async () => {
    if (!connection.token) throw new Error('请先连接本机服务');
    await pullSettings();
    status('浏览器设置已同步');
  }));
  for (const [theme, name] of Object.entries(themes)) {
    const label = element('label', 'theme-choice');
    label.dataset.preview = theme;
    const input = element('input');
    input.type = 'radio';
    input.name = 'theme';
    input.value = theme;
    input.checked = values.theme === theme;
    input.dataset.option = 'theme';
    input.addEventListener('change', guarded(() => {
      values.theme = theme;
      return saveOptions(values);
    }));
    const swatch = element('span', 'theme-swatch');
    swatch.setAttribute('aria-hidden', 'true');
    label.append(input, swatch, element('span', '', name));
    $('themes').append(label);
  }
  accentInput.addEventListener('change', guarded(() => {
    values.accent = accentInput.value;
    return saveOptions(values);
  }));
  $('reset-accent').addEventListener('click', guarded(() => {
    values.accent = '';
    return saveOptions(values);
  }));
  optionsInto($('settings-options'), ['quality','concurrency','mode','format','audioFormat','subtitles'], values, saveOptions);
  optionsInto($('transfer-options'), ['connections','accelerate','fastStart','naming','conflictAction'], values, saveOptions);
  optionsInto($('interface-options'), ['density','startPanel'], values, saveOptions);
  optionsInto($('detection-options'), ['preview','previewSeconds','showSize','sizeLookup','showThumbnails','autoScan','showHost'], values, saveOptions);
  folderInput.addEventListener('input', () => folderInput.setCustomValidity(''));
  folderInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) folderInput.blur();
  });
  folderInput.addEventListener('change', guarded(() => {
    try {
      values.downloadFolder = downloadFolder(folderInput.value);
      folderInput.value = values.downloadFolder;
    } catch (error) {
      folderInput.setCustomValidity(error.message);
      folderInput.reportValidity();
      throw error;
    }
    status('');
    return saveOptions(values);
  }));
  $('save-as').addEventListener('change', guarded(() => {
    values.saveAs = $('save-as').checked;
    return saveOptions(values);
  }));
  storage.onChanged.addListener(changes => {
    if (changes.downloadJobs) updateJobs(changes.downloadJobs.newValue ?? []);
    if (changes.downloadSettings) {
      preferences = readDownloadSettings(changes.downloadSettings.newValue);
      Object.assign(values, preferences);
      applyAppearance();
      $('save-as').checked = preferences.saveAs;
      folderInput.value = preferences.downloadFolder;
      for (const input of $('themes').querySelectorAll('input')) input.checked = input.value === preferences.theme;
      for (const id of ['settings-options','transfer-options','interface-options','detection-options']) {
        $(id).dispatchEvent(new Event('settings-sync'));
      }
      lastStreams = undefined;
      if (tab) void guarded(refresh)();
    }
  });
  if (!nativeDownloads) {
    $('connection-status').hidden = true;
    $('downloads-toggle').hidden = true;
    $('settings-options').closest('.option-card').hidden = true;
    $('transfer-options').closest('details').hidden = true;
    $('interface-options').querySelector('[data-option="startPanel"]').closest('label').hidden = true;
    $('service-settings').hidden = true;
    $('manual').querySelector('button').textContent = '打开视频';
  }
  updateJobs(saved.downloadJobs ?? []);
  await pullSettings()?.catch(() => {});
  if (nativeDownloads && syncToggle.checked) {
    preferences = readDownloadSettings((await storage.get('downloadSettings')).downloadSettings);
  }
  [tab] = await browserApi.tabs.query({active:true,currentWindow:true});
  if (nativeDownloads && preferences.startPanel === 'downloads') showPanel('downloads');
  await refresh();
})()
