import { assessCandidates, detectionDiagnostic, diagnosticReport } from './detection.mjs';
import { observeMediaChanges, inspectPublicManifest, inspectPublicPlayerJson, publicPlayerJsonUrl } from './live-detection.mjs';
import { browserApi, downloadsPage, downloadSettingsPage, isAndroid, nativeDownloads } from './browser.mjs';
import { canUseMediaTitle, classify, isPlaylist, pageStreams, platformVideo, scanDocument, selectPageStream, sourceTitle } from './media.mjs';
import { bindMcpCenter } from './mcp-center.mjs';
import { queryMp4Metadata } from './media-metadata.mjs';
import { activeStates, companion, endpointDefault, usesCompanion } from './downloads.mjs';
import { defaults, downloadFolder, interfaceLanguage, maxConcurrency, readDownloadSettings,
  restoreSettingsBackup, settingsBackup } from './settings.mjs';
import { translate } from './locale.mjs';
import { canQuerySize, preparePreview, queryMediaSize } from './preview.mjs';

const $ = id => document.getElementById(id);
const storage = browserApi.storage.local;
const staticText = [...document.querySelectorAll('[data-i18n]')].map(node =>
  [node, node.textContent, node.dataset.i18n || node.textContent]);
const staticLabels = [...document.querySelectorAll('[data-i18n-aria]')].map(node => [node, node.getAttribute('aria-label')]);
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
  concurrency:['同时下载 · 1–{0}'],
  accelerate:['原画直链加速', [['true','自动 · 需本机服务'], ['false','浏览器直接下载']]],
  connections:['单任务连接数', [['4','4 · 稳定'], ['8','8 · 默认'], ['12','12 · 高速']]],
  fastStart:['MP4 / M4A 文件优化', [['true','支持边下边播'], ['false','优先完成保存']]],
  naming:['默认文件名', [['title','视频标题'], ['source','源文件名']]],
  conflictAction:['遇到同名文件', [['uniquify','自动加序号'], ['prompt','询问保存位置']]],
  density:['列表密度', [['comfortable','标准'], ['compact','紧凑']]],
  preview:['动态预览', [['click','点击封面'], ['hover','悬停或点击'], ['off','关闭']]],
  previewSeconds:['预览时长', [['3','{0} 秒'], ['6','{0} 秒'], ['10','{0} 秒']]],
  showSize:['源视频大小', [['true','显示'], ['false','隐藏']]],
  sizeLookup:['缺少大小时', [['true','轻量查询'], ['false','仅用网页记录']]],
  showThumbnails:['封面', [['true','显示'], ['false','隐藏']]],
  startPanel:['打开时显示', [['videos','视频'], ['downloads','下载队列']]],
  autoScan:['自动补扫', [['true','开启'], ['false','仅手动扫描']]],
  showHost:['视频来源域名', [['false','隐藏'], ['true','显示']]],
  language:['界面语言', [['system','跟随系统'], ['zh-CN','简体中文'], ['en','English']]],
};
const themes = {system:'跟随系统',light:'浅色',dark:'深色',jade:'竹青',amber:'琥珀'};
const connectionCopy = {
  unpaired:['连接服务', '双击 Start VideoSave.cmd，输入窗口显示的地址和配对码。直链下载无需配对。'],
  checking:['正在连接…', '正在检查本机服务…'],
  connected:['已连接', '本机服务已连接'],
  unauthorized:['配对码无效', '请输入当前服务终端显示的配对码，然后重新连接。'],
  offline:['服务离线', '请确认本机服务正在运行，并核对地址和端口。'],
};

let panel = 'videos';
let preferences = {...defaults};
let language;
let statusMessage = [''];
let connection = {endpoint:endpointDefault, token:''};
let serviceState = 'unpaired';
let serviceHealth;
let tab;
let pageTitle = '';
let pageHeading = '正在扫描…';
let scanHint = '';
let detection = {code:'no-player'};
let scanQueued = false;
let watchingTab;
let scannedUrl;
let scannedDocument;
const manifestCache = new Map();
const playerJsonCache = new Map();
const diagnosticHints = {
  'multiple-candidates':'检测到多个候选，请确认要下载的视频。',
  'no-player':'页面中未检测到播放器。',
  'media-not-loaded':'请正常播放视频，候选列表会自动更新。',
  'no-playlist-request':'播放器已就绪，尚未观察到媒体清单。',
  'frame-access':'无法访问一个或多个嵌入播放器。',
  'unsupported-format':'播放器使用了暂不支持的媒体来源。',
  'only-ads':'页面目前只提供了广告候选。',
  'login-required':'请在网站上登录后重新扫描。',
  paywall:'站点要求授权访问。',
  forbidden:'站点限制了访问。',
  'rate-limited':'站点要求稍后重试。',
  captcha:'站点要求完成验证码。',
  'cf-turnstile':'站点要求完成安全验证。',
  'cloudflare-challenge':'站点返回 Cloudflare 验证页，未探测到媒体流。',
  drm:'播放器启用了 DRM',
};
let streams = [];
let lastStreams;
let lastJobs;
let downloadJobs = [];
let scanning = false;
let scanTimer;
let discoveryRetry;
let pollTimer;
let polling = false;
let openedOptions;
let hoverPreview;
let previewController;
let previewObjectUrl;
let metadataLookupRunning = false;
const observedSizes = new Map();
const observedTitles = new Map();
const updateRowTitle = new WeakMap();
const selected = new Set();

const t = (message, ...values) => translate(language, message, ...values);

function status(message, ...values) {
  statusMessage = [message, ...values];
  $('status').textContent = t(...statusMessage);
}

function applyLanguage() {
  const next = interfaceLanguage(preferences.language, browserApi.i18n?.getUILanguage?.() || navigator.language);
  if (next === language) return false;
  language = next;
  document.documentElement.lang = language;
  for (const [node, original, message] of staticText) node.textContent = language === 'en' ? t(message) : original;
  for (const [node, label] of staticLabels) node.setAttribute('aria-label', t(label));
  for (const label of $('themes').querySelectorAll('[data-theme-label]')) label.textContent = t(label.dataset.themeLabel);
  for (const grid of $('settings').querySelectorAll('.option-grid')) grid.dispatchEvent(new Event('language-change'));
  $('download-folder').placeholder = t('浏览器默认下载目录');
  $('manual').querySelector('button').textContent = t(nativeDownloads ? '下载' : '打开视频');
  $('page-title').textContent = pageTitle || t(pageHeading);
  $('hint').textContent = t(scanHint);
  connectionLabel();
  updateBulk();
  status(...statusMessage);
  openedOptions = null;
  stopHoverPreview();
  $('media').replaceChildren(...streams.map(renderMedia));
  lastJobs = undefined;
  updateJobs(downloadJobs);
  return true;
}
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
  status('');
  document.querySelector('main').scrollTop = 0;
  if (panel === 'downloads') void tick();
}

function showServiceSettings() {
  showPanel('settings');
  $('service-settings').open = true;
  $('endpoint').focus();
}

function durationLabel(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return t('时长未知');
  const total = Math.round(duration);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds : minutes + ':' + seconds;
}

function optionsInto(parent, keys, values, changed) {
  const controls = {};
  const copy = [];
  const syncCopy = () => {
    for (const [node, message, value] of copy) node.textContent = t(message, value);
  };
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
    const field = element('label');
    const caption = element('span');
    copy.push([caption, label, maxConcurrency]);
    const control = element(choices ? 'select' : 'input');
    control.dataset.option = key;
    if (choices) {
      for (const [value, text] of choices) {
        const option = new Option('', value);
        control.add(option);
        copy.push([option, text, value]);
      }
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
        status('同时下载数量须为 1 至 {0} 的整数', maxConcurrency);
        return;
      }
      values[key] = typeof defaults[key] === 'number' ? Number(control.value)
        : typeof defaults[key] === 'boolean' ? control.value === 'true' : control.value;
      syncControls();
      await changed(values);
    }));
    controls[key] = control;
    field.append(caption, control);
    parent.append(field);
  }
  syncControls();
  syncCopy();
  parent.addEventListener('language-change', syncCopy);
  parent.addEventListener('settings-sync', () => {
    for (const [key, control] of Object.entries(controls)) control.value = String(values[key]);
    syncControls();
  });
  return values;
}

function connectionLabel() {
  const [label, help] = connectionCopy[serviceState];
  $('connection-status').dataset.state = serviceState;
  $('connection-label').textContent = t(label);
  $('service-status').textContent = t(help);
  $('service-status').hidden = false;
}

function checkService(recheck = false) {
  if (!connection.token) return Promise.resolve(null);
  if (serviceHealth && (!recheck || serviceState === 'checking')) return serviceHealth;
  const current = connection;
  serviceState = 'checking';
  connectionLabel();
  serviceHealth = companion(current, '/api/health').then(health => {
    if (connection !== current) return null;
    serviceState = 'connected';
    connectionLabel();
    return health;
  }, error => {
    if (connection === current) {
      serviceHealth = undefined;
      serviceState = error.status === 401 ? 'unauthorized' : 'offline';
      connectionLabel();
    }
    return null;
  });
  return serviceHealth;
}

async function checkPlatformAvailability() {
  return Boolean((await checkService())?.platformDownloads);
}

async function request(action, args = {}) {
  const result = await browserApi.runtime.sendMessage({scope:'media-downloads', action, ...args});
  if (!result || result.error) throw new Error(result?.error || '下载队列暂不可用');
  updateJobs(result.jobs);
}

async function enqueue(items, fallbackTitle = pageTitle) {
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
  await request('enqueue', {streams:items.map(stream => ({...stream,title:downloadTitle(stream, fallbackTitle)}))});
  selected.clear();
  document.querySelectorAll('#media input[type=checkbox]').forEach(input => { input.checked = false; });
  updateBulk();
  showPanel('downloads');
  if (items.length === 1) status('已加入队列');
  else status('已加入 {0} 个任务', items.length);
}

function mediaTitle(stream) {
  return (canUseMediaTitle(stream.titleSource) && observedTitles.get(stream.url)) || stream.title;
}

function streamTitle(stream, naming = 'title', fallbackTitle = pageTitle) {
  const filename = sourceTitle(stream);
  return (naming === 'source' && filename) || mediaTitle(stream) || filename || fallbackTitle || t('视频文件');
}

function downloadTitle(stream, fallbackTitle = pageTitle) {
  if (stream.customTitle) return stream.customTitle;
  if (stream.kind === 'page') return stream.title || '';
  return streamTitle(stream, preferences.naming, fallbackTitle);
}

function updateBulk() {
  $('bulk').hidden = !nativeDownloads || streams.length < 2;
  $('media-count').hidden = !streams.length;
  $('media-count').textContent = streams.length;
  $('all').checked = streams.length > 0 && streams.every(stream => selected.has(stream.url));
  $('all').indeterminate = selected.size > 0 && !$('all').checked;
  $('queue-selected').disabled = !selected.size;
  $('queue-selected').textContent = t('下载所选') + (selected.size ? ' · ' + selected.size : '');
}

function sizeLabel(stream) {
  const result = stream.size ? {size:stream.size, estimated:stream.sizeEstimated} : observedSizes.get(stream.url);
  if (!result) return t('大小未知');
  const size = formatBytes(result.size);
  return result.estimated ? t('约 {0}', size) : size;
}

async function queryMissingMetadata() {
  if (metadataLookupRunning) return;
  const needsTitle = stream => stream.kind === 'mp4' && canUseMediaTitle(stream.titleSource) && !observedTitles.has(stream.url);
  const needsSize = stream => preferences.showSize && preferences.sizeLookup &&
    !stream.size && canQuerySize(stream) && !observedSizes.has(stream.url);
  const pending = streams.filter(stream => needsTitle(stream) || needsSize(stream)).slice(0, 12);
  if (!pending.length) return;
  metadataLookupRunning = true;
  try {
    await Promise.all(Array.from({length:Math.min(4, pending.length)}, async () => {
      while (pending.length) {
        const stream = pending.shift();
        const metadata = needsTitle(stream) ? await queryMp4Metadata(stream.url) : null;
        if (metadata || needsTitle(stream)) observedTitles.set(stream.url, metadata?.title || null);
        if (metadata?.size) observedSizes.set(stream.url, {size:metadata.size, estimated:false});
        else if (needsSize(stream)) observedSizes.set(stream.url, await queryMediaSize(stream).catch(() => null));
        const row = Array.from($('media').children).find(item => item.dataset.url === stream.url);
        const label = row?.querySelector('.media-size');
        const current = streams.find(item => item.url === stream.url);
        if (current && metadata?.title) updateRowTitle.get(row)?.(current);
        if (current && label) label.textContent = sizeLabel(current);
      }
    }));
  } finally {
    metadataLookupRunning = false;
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
  const setNotice = (message, ...values) => {
    notice.textContent = t(message, ...values);
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
    if (!controller.signal.aborted) setNotice('预览不可用 · {0}', t(signal.aborted ? '加载超时' : error.message));
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
  const label = element('strong', 'media-title');
  const details = element('small', 'details', [
    ({m3u8:'HLS', mpd:'DASH', page:t('本机解析')}[stream.kind] || stream.kind.toUpperCase()),
    stream.duration && durationLabel(stream.duration), stream.width && stream.height && (stream.width + '×' + stream.height),
    preferences.showHost && new URL(stream.url).hostname,
  ].filter(Boolean).join(' · '));
  if (preferences.showSize) details.append(element('span', 'media-size', sizeLabel(stream)));
  summary.append(label, details);

  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(stream.url);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(stream.url);
    else selected.delete(stream.url);
    updateBulk();
  });
  const canPreview = preferences.preview !== 'off' && stream.kind !== 'page';
  const preview = !canPreview ? element('div', 'preview')
    : button('', 'preview preview-trigger', () => openPreview(stream, label.textContent));
  preview.append(element('span', 'play-icon'));
  if (!canPreview) preview.setAttribute('aria-hidden', 'true');
  if (preferences.showThumbnails && stream.poster && /^https?:$/.test(URL.parse(stream.poster)?.protocol || '')) {
    const image = element('img');
    image.src = stream.poster;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), {once:true});
    preview.append(image);
  }
  if (canPreview && preferences.preview === 'hover') {
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
  optionsToggle.setAttribute('aria-expanded', 'false');
  const downloadLabel = t(nativeDownloads ? '下载' : '打开视频');
  const download = button(downloadLabel, 'download-button', async () => enqueue([stream]));

  const rename = element('label', '', t('文件名'));
  const name = element('input');
  name.type = 'text';
  if (stream.kind === 'page') name.placeholder = t('使用平台的视频标题');
  name.maxLength = 150;
  rename.append(name);
  const grid = element('div', 'option-grid');
  const options = nativeDownloads ? optionsInto(grid, ['mode', 'quality', 'format', 'audioFormat', 'subtitles'],
    {...preferences}, () => {}) : {};
  let chosen = stream;
  if (stream.alternates?.length) {
    const sources = [stream, ...stream.alternates];
    const field = element('label', '', t('媒体来源'));
    const picker = element('select');
    for (const [index, source] of sources.entries()) {
      picker.add(new Option(`${source.kind.toUpperCase()} · ${new URL(source.url).hostname}`, index));
    }
    picker.addEventListener('change', () => { chosen = sources[Number(picker.value)]; });
    field.append(picker);
    grid.prepend(field);
  }
  const configActions = element('div', 'actions');
  configActions.append(button(t('复制链接'), 'quiet', async () => {
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
  const setTitle = source => {
    const title = streamTitle(source);
    label.textContent = label.title = title;
    checkbox.setAttribute('aria-label', t('选择 {0}', title));
    if (canPreview) preview.setAttribute('aria-label', t('预览 {0}', title));
    optionsToggle.setAttribute('aria-label', t('打开 {0} 的下载选项', title));
    download.setAttribute('aria-label', t(nativeDownloads ? '下载 {0}' : '打开视频 {0}', title));
    name.defaultValue = downloadTitle(source);
  };
  setTitle(stream);
  updateRowTitle.set(row, setTitle);
  return row;
}

function scheduleScan() {
  if (!tab || !preferences.autoScan) return;
  scanQueued = true;
  if (scanning || scanTimer) return;
  scanTimer = setTimeout(guarded(async () => {
    scanTimer = undefined;
    await refresh(false);
  }), 500);
}

async function stopWatching() {
  const tabId = watchingTab;
  watchingTab = undefined;
  if (tabId !== undefined) await browserApi.scripting.executeScript({
    target:{tabId,allFrames:true},func:observeMediaChanges,args:[false],
  }).catch(() => {});
}

async function refresh(manual = true) {
  if (!tab || scanning) return;
  clearTimeout(scanTimer);
  scanTimer = undefined;
  scanQueued = false;
  scanning = true;
  if (manual) $('refresh').disabled = true;
  try {
    const currentTab = await browserApi.tabs.get?.(tab.id).catch(() => null);
    if (currentTab) tab = currentTab;
    const pageChanged = scannedUrl !== undefined && scannedUrl !== tab.url;
    if (pageChanged) manifestCache.clear();
    scannedUrl = tab.url;
    const scan = allFrames => browserApi.scripting.executeScript({target:{tabId:tab.id, allFrames},func:scanDocument,args:[true]});
    const frames = (await scan(true).catch(() => scan(false).catch(() => []))).filter(frame => frame.result);
    const observations = frames.map(frame => frame.result);
    const topFrame = frames.find(frame => frame.frameId === 0);
    const top = topFrame?.result;
    if (scannedDocument?.timeOrigin !== top?.documentTimeOrigin || pageChanged) playerJsonCache.clear();
    scannedDocument = top && {url:top.documentUrl,timeOrigin:top.documentTimeOrigin,id:topFrame.documentId ?? null};
    const previousPageTitle = pageTitle;
    pageTitle = top?.pageTitle?.trim() || tab.title?.trim() || '';
    pageHeading = '当前标签页';
    $('site').textContent = URL.parse(tab.url)?.hostname || '';
    $('page-title').textContent = pageTitle || t(pageHeading);
    $('page-title').title = pageTitle;
    const key = 'media:' + tab.id;
    const stored = (await browserApi.storage.session.get(key))[key] || [];
    const allowedFrames = new Map(frames.map(frame => [frame.frameId,frame]));
    const matchedRequests = stored.filter(row => {
      const frame = allowedFrames.get(row.frameId);
      if ((!row.url && !row.fragment) || !frame) return false;
      if (row.documentId && frame.documentId && row.documentId !== frame.documentId) return false;
      if (row.documentUrl && row.documentUrl !== frame.result.documentUrl) return false;
      return !frame.result.routeStartedAt || !row.timeStamp || row.timeStamp >= frame.result.routeStartedAt;
    });
    const blockers = new Set(stored.filter(row => row.blocker).map(row => row.blocker));
    if (top?.blocker) blockers.add(top.blocker);
    if (top?.encrypted) blockers.add('drm');
    const available = !blockers.size;
    const requests = matchedRequests.filter(row => !row.playerJson);
    if (available && top && nativeDownloads) {
      const origin = URL.parse(top.documentUrl)?.origin;
      const jsonUrls = new Set([...(top.publicJsonRequests ?? []),...matchedRequests.filter(row => row.playerJson).map(row => row.url)]);
      const eligible = [...jsonUrls].filter(url => URL.parse(url)?.origin === origin && publicPlayerJsonUrl(url)).slice(-4);
      const sources = await Promise.all(eligible.map(async url => {
        if (!playerJsonCache.has(url) && playerJsonCache.size < 12) {
          playerJsonCache.set(url,await inspectPublicPlayerJson(url,top.documentUrl));
        }
        return playerJsonCache.get(url) ?? [];
      }));
      requests.push(...sources.flat().map(source => ({...source,frameId:0,xhrJson:true})));
    }
    streams = available ? pageStreams(frames, requests) : [];
    const manifests = nativeDownloads ? streams.filter(stream => isPlaylist(stream.kind)).slice(0,4) : [];
    await Promise.all(manifests.map(async stream => {
      if (!manifestCache.has(stream.url) && manifestCache.size < 24) {
        manifestCache.set(stream.url,await inspectPublicManifest(stream));
      }
    }));
    const enriched = [...requests];
    for (const stream of manifests) {
      const evidence = manifestCache.get(stream.url);
      if (!evidence) continue;
      enriched.push({url:stream.url,manifestOnly:true,mime:stream.kind === 'm3u8' ? 'application/x-mpegurl' : 'application/dash+xml',
        frameId:stream.frameId,...evidence});
      if (evidence.drm) blockers.add('drm');
    }
    if (available && manifests.length) streams = pageStreams(frames,enriched);
    if (!streams.length && observations.some(row => row.encrypted)) blockers.add('drm');
    const platform = nativeDownloads && !blockers.size ? platformVideo(tab.url) : null;
    if (platform && !streams.length && await checkPlatformAvailability()) {
      streams = [{...platform, ...top?.opaquePlayer, kind:'page',
        title:top?.pageMetadata?.title || pageTitle || null,
        poster:top?.opaquePlayer?.poster || top?.pageMetadata?.poster}];
    }
    if (!nativeDownloads) streams = streams.flatMap(stream => {
      const [direct, ...alternates] = [stream, ...(stream.alternates ?? [])].filter(source => !isPlaylist(source.kind));
      return direct ? [{...direct, alternates}] : [];
    });
    const previews = new Set(streams.filter(stream => assessCandidates([stream])[0].evidence.includes('preview-label')));
    const selection = selectPageStream(streams);
    const plausible = streams.filter(stream => !previews.has(stream));
    detection = detectionDiagnostic({streams,selection,blockers:[...blockers],
      players:observations.reduce((n,row) => n + row.playerCount,0),
      unloaded:observations.reduce((n,row) => n + row.unloaded,0),
      opaque:observations.reduce((n,row) => n + row.opaqueCount,0),
      unsupported:observations.reduce((n,row) => n + row.unsupported,0) + requests.filter(row => row.fragment).length,
      excluded:observations.reduce((n,row) => n + (row.excludedMedia?.length ?? 0),0),
      blockedFrames:Math.max(0, (top?.iframeCount ?? 0) - frames.filter(frame => frame.frameId !== 0).length),
    });
    streams = [...plausible,...streams.filter(stream => previews.has(stream))];
    const snapshot = JSON.stringify(streams);
    if (snapshot !== lastStreams && !openedOptions && !hoverPreview) {
      for (const url of selected) {
        if (!streams.some(stream => stream.url === url)) selected.delete(url);
      }
      $('media').replaceChildren(...streams.map(renderMedia));
      lastStreams = snapshot;
      updateBulk();
    } else if (pageTitle !== previousPageTitle) {
      for (const row of $('media').children) {
        const stream = streams.find(item => item.url === row.dataset.url);
        if (stream) updateRowTitle.get(row)?.(stream);
      }
    }
    const hint = $('hint');
    hint.hidden = streams.length > 0 && detection.code !== 'multiple-candidates';
    scanHint = platform && !streams.length ? '此视频需要配对已配置 yt-dlp 的本机服务。'
      : diagnosticHints[detection.code] ?? '还没有找到视频。开始播放后再扫描，也可以粘贴媒体链接。';
    hint.textContent = t(scanHint);
    void queryMissingMetadata();
    if (preferences.autoScan && observations.length && (manual || pageChanged || watchingTab !== tab.id)) {
      watchingTab = tab.id;
      await browserApi.scripting.executeScript({target:{tabId:tab.id,allFrames:true},
        func:observeMediaChanges,args:[true]}).catch(() => {});
    } else if (!preferences.autoScan) await stopWatching();
    if (manual || pageChanged) {
      clearTimeout(discoveryRetry);
      if (preferences.autoScan && available && !streams.length) {
        discoveryRetry = setTimeout(() => {
          if (!streams.length) scheduleScan();
        },2600);
      }
    }
  } finally {
    scanning = false;
    if (manual) $('refresh').disabled = false;
    if (scanQueued) scheduleScan();
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
  const badge = element('span', 'queue-status', t(statusNames[job.state]));
  badge.dataset.state = job.state;
  header.append(title, badge);
  row.append(header);
  if (['processing', 'downloading', 'paused'].includes(job.state)) {
    const progress = element('progress');
    progress.max = 100;
    if (job.percent != null) progress.value = job.percent;
    progress.setAttribute('aria-label', t('{0} 下载进度', title.textContent));
    row.append(progress);
  }
  const description = [job.percent != null && job.state !== 'done' ? job.percent + '%' : '',
    job.bytes && job.state !== 'done' ? formatBytes(job.bytes) + (job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : '') : '',
    job.speed && ['downloading','processing'].includes(job.state) ? formatBytes(job.speed) + '/s' : '', t(job.note)]
    .filter(Boolean).join(' · ');
  if (description) row.append(element('p', 'details', description));
  const actions = element('div', 'actions');
  if (job.state === 'downloading') actions.append(button(t('暂停'), 'quiet', () => request('pause', {id:job.id})));
  if (job.canResume && ['paused','failed'].includes(job.state)) {
    actions.append(button(t('继续'), 'quiet', () => request('resume', {id:job.id})));
  }
  if (activeStates.includes(job.state)) actions.append(button(t('取消'), 'quiet', () => request('cancel', {id:job.id})));
  if (['failed','cancelled'].includes(job.state)) actions.append(button(t('重试'), 'quiet', () => request('retry', {id:job.id})));
  if (job.state === 'done') {
    for (const [index, file] of job.files.entries()) {
      const label = element('p', 'filename', file.name);
      label.title = file.name;
      row.append(label);
      actions.append(button(t(job.files.length === 1 ? '在文件夹中显示' : index === 0 ? '显示视频' : '显示音频'),
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
$('connection-status').addEventListener('click', () => {
  showServiceSettings();
  void checkService(true);
});
$('refresh').addEventListener('click', guarded(() => refresh()));
function saveJson(filename, report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2) + '\n'],{type:'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
bindMcpCenter({root:$('mcp-center'),translate:(zh,en) => language === 'en' ? en : zh,
  getConnection:() => connection,getTab:() => tab,saveJson,
  getSnapshot:() => ({document:scanning ? null : scannedDocument,title:pageTitle,restricted:Boolean(detection.blockers?.length),diagnostic:detection,
    playing:streams.some(stream => stream.playing),streams:scanning ? [] : streams})});
$('mcp-center').hidden = !nativeDownloads;

$('export-diagnostic').addEventListener('click', () => saveJson('videosave-diagnostic.json',
  diagnosticReport({diagnostic:detection,streams})));
$('check-release').addEventListener('click', () => browserApi.tabs.create({
  url:'https://github.com/KaiserIIII/videosave/releases/latest',
}));
browserApi.runtime?.onMessage?.addListener((message,sender) => {
  if (message?.action === 'videosave-media-changed' && sender.tab?.id === tab?.id) scheduleScan();
});
browserApi.tabs.onUpdated?.addListener((id,change) => {
  if (id === tab?.id && (change.url || change.status === 'complete')) scheduleScan();
});
window.addEventListener('pagehide', () => {
  clearTimeout(discoveryRetry);
  void stopWatching();
});
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
  const submit = $('pair').querySelector('button');
  submit.disabled = true;
  try {
    const health = await companion(next, '/api/health');
    await storage.set({connection:next});
    connection = next;
    serviceHealth = Promise.resolve(health);
    serviceState = 'connected';
    connectionLabel();
    if ($('settings-sync').checked) await request('sync-settings');
    await refresh();
    status('本机服务已连接');
  } finally {
    submit.disabled = false;
  }
}));
$('manual').addEventListener('submit', guarded(async event => {
  event.preventDefault();
  const url = $('manual-url').value.trim();
  const platform = platformVideo(url);
  if (platform) {
    if (!nativeDownloads) throw new Error('此网页视频需要桌面版和本机服务');
    const health = await checkService(true);
    if (!health?.platformDownloads) {
      showServiceSettings();
      throw new Error(health
        ? '运行 node tools/setup-platform-downloads.mjs，重启本机服务后再试。'
        : connectionCopy[serviceState][1]);
    }
    return enqueue([{...platform, kind:'page', title:''}]);
  }
  const kind = classify(url, '', true);
  if (!kind) throw new Error('请输入 HTTP(S) 媒体地址');
  const filename = new URL(url).pathname.split('/').at(-1);
  let decoded;
  try { decoded = decodeURIComponent(filename); } catch { decoded = filename; }
  await enqueue([{url, kind, title:decoded.replace(/\.[^.]+$/, '')}], '');
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
  applyLanguage();
  if (nativeDownloads) void checkService();
  window.addEventListener('languagechange', applyLanguage);
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
  const saveOptions = async options => {
    preferences = {...options};
    const changedLanguage = applyLanguage();
    applyAppearance();
    if (nativeDownloads) await request('settings', {settings:preferences});
    else await storage.set({downloadSettings:preferences});
    if (!changedLanguage && !openedOptions) $('media').replaceChildren(...streams.map(renderMedia));
    void queryMissingMetadata();
  };
  const values = {...preferences};
  const syncToggle = $('settings-sync');
  const syncNow = $('sync-now');
  $('current-version').textContent = browserApi.runtime?.getManifest?.().version || '';
  const replaceOptions = async next => {
    if (syncToggle.checked) throw Error('请先关闭本机设置同步。');
    const prior = {...values};
    try {
      await saveOptions(next);
      Object.assign(values,next);
      updateSettingsControls();
    } catch (error) {
      preferences = prior;
      applyLanguage();
      applyAppearance();
      throw error;
    }
  };
  $('export-settings').addEventListener('click', () => saveJson('videosave-settings.json',settingsBackup(preferences)));
  $('import-settings').addEventListener('click', () => $('settings-file').click());
  $('settings-file').addEventListener('change', guarded(async () => {
    const input = $('settings-file');
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 32 * 1024) throw Error('设置文件格式不受支持');
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { throw Error('设置文件格式不受支持'); }
    const choices = Object.fromEntries(Object.entries(optionSets).filter(([,entry]) => entry[1])
      .map(([key,[,options]]) => [key,options.map(([value]) => value)]));
    choices.theme = Object.keys(themes);
    await replaceOptions(restoreSettingsBackup(backup,choices));
    status('已导入浏览器设置');
  }));
  $('reset-settings').addEventListener('click', () => $('reset-settings-dialog').showModal());
  $('confirm-reset-settings').addEventListener('click', guarded(async () => {
    await replaceOptions({...defaults});
    $('reset-settings-dialog').close();
    status('已恢复默认浏览器设置');
  }));
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
    const caption = element('span', '', t(name));
    caption.dataset.themeLabel = name;
    label.append(input, swatch, caption);
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
  optionsInto($('interface-options'), ['language','density','startPanel'], values, saveOptions);
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
      folderInput.setCustomValidity(t(error.message));
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
  browserApi.storage.session.onChanged?.addListener(changes => {
    if (tab && changes['media:' + tab.id]) scheduleScan();
  });
  function updateSettingsControls() {
    $('save-as').checked = preferences.saveAs;
    folderInput.value = preferences.downloadFolder;
    for (const input of $('themes').querySelectorAll('input')) input.checked = input.value === preferences.theme;
    for (const id of ['settings-options','transfer-options','interface-options','detection-options']) {
      $(id).dispatchEvent(new Event('settings-sync'));
    }
  }
  storage.onChanged.addListener(changes => {
    if (changes.downloadJobs) updateJobs(changes.downloadJobs.newValue ?? []);
    if (changes.downloadSettings) {
      preferences = readDownloadSettings(changes.downloadSettings.newValue);
      Object.assign(values, preferences);
      applyLanguage();
      applyAppearance();
      updateSettingsControls();
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
