import { classify, pageStreams, scanDocument } from './media.mjs';
import { activeStates, companion, defaults, endpointDefault, usesCompanion } from './downloads.mjs';

const $ = id => document.getElementById(id);
const storage = chrome.storage.local;
const acceptedEndpoint = /^http:\/\/127\.0\.0\.1(?::[0-9]+)?$/;
const statusNames = {queued:'排队中', starting:'正在启动', processing:'本机处理中',
  downloading:'下载中', paused:'已暂停', done:'已完成', failed:'下载失败', cancelled:'已取消'};
const optionSets = {
  mode:['下载内容', [['combined','音视频合并'], ['video','仅视频'], ['audio','仅音频'], ['separate','音频与视频分开']]],
  quality:['画质', [['','原画'], ['2160','最高 2160p'], ['1440','最高 1440p'], ['1080','最高 1080p'],
    ['720','最高 720p'], ['480','最高 480p'], ['360','最高 360p']]],
  format:['视频格式', [['auto','自动 · 原格式 / MP4'], ['mp4','MP4'], ['mkv','MKV']]],
  audioFormat:['音频格式', [['m4a','M4A'], ['mp3','MP3']]],
  subtitles:['源文件内嵌字幕', [['false','不保留'], ['true','有则保留']]],
  concurrency:['并发任务', [['1','1 个'], ['2','2 个']]],
};

let panel = 'videos';
let preferences = {...defaults};
let connection = {endpoint:endpointDefault, token:''};
let tab;
let pageTitle = '';
let streams = [];
let lastStreams;
let lastJobs;
let scanning = false;
let scanTimer;
let pollTimer;
let polling = false;
let openedOptions;
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

function durationLabel(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return '时长未知';
  const total = Math.round(duration);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds : minutes + ':' + seconds;
}

function optionsInto(parent, keys, initial, changed) {
  const controls = {};
  const values = {...initial};
  const syncControls = () => {
    if (controls.format) controls.format.disabled = values.mode === 'audio';
    if (controls.quality) controls.quality.disabled = values.mode === 'audio';
    if (controls.subtitles) controls.subtitles.disabled = values.mode === 'audio';
    if (controls.audioFormat) controls.audioFormat.disabled = !['audio','separate'].includes(values.mode);
  };
  for (const key of keys) {
    const [label, choices] = optionSets[key];
    const field = element('label', '', label);
    const select = element('select');
    select.dataset.option = key;
    for (const [value, text] of choices) select.add(new Option(text, value));
    select.value = String(values[key]);
    select.addEventListener('change', guarded(async () => {
      values[key] = key === 'concurrency' ? Number(select.value)
        : key === 'subtitles' ? select.value === 'true' : select.value;
      syncControls();
      await changed(values);
    }));
    controls[key] = select;
    field.append(select);
    parent.append(field);
  }
  syncControls();
  return values;
}

function connectionLabel() {
  const node = $('connection-status');
  node.dataset.connected = Boolean(connection.token);
  node.lastChild.textContent = connection.token ? '已配对' : '连接服务';
}

async function request(action, args = {}) {
  const result = await chrome.runtime.sendMessage({scope:'media-downloads', action, ...args});
  if (!result || result.error) throw new Error(result?.error || '下载队列暂不可用');
  updateJobs(result.jobs);
}

async function enqueue(items) {
  if (!connection.token && items.some(stream => usesCompanion(stream, {...preferences, ...stream.options}))) {
    showPanel('settings');
    $('endpoint').focus();
    throw new Error('当前选项需要连接本机服务');
  }
  await request('enqueue', {streams:items.map(stream => ({...stream,title:stream.title || pageTitle || '视频'}))});
  selected.clear();
  document.querySelectorAll('#media input[type=checkbox]').forEach(input => { input.checked = false; });
  updateBulk();
  showPanel('downloads');
  status(items.length === 1 ? '已加入队列' : '已加入 ' + items.length + ' 个任务');
}

function updateBulk() {
  $('bulk').hidden = streams.length < 2;
  $('media-count').hidden = !streams.length;
  $('media-count').textContent = streams.length;
  $('all').checked = streams.length > 0 && streams.every(stream => selected.has(stream.url));
  $('all').indeterminate = selected.size > 0 && !$('all').checked;
  $('queue-selected').disabled = !selected.size;
  $('queue-selected').textContent = selected.size ? '下载所选 · ' + selected.size : '下载所选';
}

function renderMedia(stream) {
  const row = element('li');
  row.dataset.url = stream.url;
  const summary = element('div');
  const label = element('strong', 'media-title', stream.title || '未命名视频');
  label.title = label.textContent;
  const details = element('small', 'details', [
    ({m3u8:'HLS', mpd:'DASH'}[stream.kind] || stream.kind.toUpperCase()),
    durationLabel(stream.duration), stream.width && stream.height && (stream.width + '×' + stream.height),
    new URL(stream.url).hostname,
  ].filter(Boolean).join(' · '));
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
  const preview = element('div', 'preview', '▶');
  preview.setAttribute('aria-hidden', 'true');
  if (stream.poster && /^https?:$/.test(URL.parse(stream.poster)?.protocol || '')) {
    const image = element('img');
    image.src = stream.poster;
    image.alt = '';
    image.addEventListener('error', () => image.remove(), {once:true});
    preview.append(image);
  }
  const actions = element('div', 'actions');
  const config = element('div', 'card-options');
  config.hidden = true;
  const optionsToggle = button('⋯', 'quiet', () => {
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
  const download = button('下载', '', async () => enqueue([stream]));
  download.setAttribute('aria-label', '下载 ' + label.textContent);

  const rename = element('label', '', '文件名');
  const name = element('input');
  name.type = 'text';
  name.value = stream.title || pageTitle;
  name.maxLength = 150;
  rename.append(name);
  const grid = element('div', 'option-grid');
  const options = optionsInto(grid, ['mode', 'quality', 'format', 'audioFormat', 'subtitles'], preferences, () => {});
  const configActions = element('div', 'actions');
  configActions.append(button('复制链接', 'quiet', async () => {
    await navigator.clipboard.writeText(stream.url);
    status('链接已复制');
  }), button('按此选项下载', '', () => enqueue([{...stream, title:name.value, options}])));
  config.append(rename, grid, configActions);
  actions.append(optionsToggle, download);
  row.append(checkbox, preview, summary, actions, config);
  return row;
}

async function refresh(retries = 4) {
  if (!tab || scanning) return;
  clearTimeout(scanTimer);
  scanning = true;
  if (retries === 4) $('refresh').disabled = true;
  try {
    const frames = (await chrome.scripting.executeScript({target:{tabId:tab.id, allFrames:true},func:scanDocument})
      .catch(() => [])).filter(frame => frame.result);
    const observations = frames.map(frame => frame.result);
    const top = frames.find(frame => frame.frameId === 0)?.result;
    pageTitle = top?.pageTitle || tab.title || '';
    $('page-title').textContent = pageTitle || '当前标签页';
    $('page-title').title = pageTitle;
    const key = 'media:' + tab.id;
    const requests = (await chrome.storage.session.get(key))[key] || [];
    const encrypted = observations.some(row => row.encrypted);
    streams = encrypted ? [] : pageStreams(frames, requests);
    const snapshot = JSON.stringify(streams);
    if (snapshot !== lastStreams && !openedOptions) {
      for (const url of selected) {
        if (!streams.some(stream => stream.url === url)) selected.delete(url);
      }
      $('media').replaceChildren(...streams.map(renderMedia));
      lastStreams = snapshot;
      updateBulk();
    }
    const hint = $('hint');
    hint.hidden = streams.length > 0;
    hint.textContent = encrypted ? '播放器启用了 DRM' : observations.some(row => row.opaque)
      ? '播放一段视频后再扫描，查找分片清单。'
      : '还没有找到视频。开始播放后再扫描，也可以粘贴媒体链接。';
    if (retries && observations.length && !encrypted && (!streams.length || streams.some(stream => !stream.duration))) {
      scanTimer = setTimeout(guarded(() => refresh(retries - 1)), 1500);
    }
  } finally {
    scanning = false;
    if (retries === 4) $('refresh').disabled = false;
  }
}

function formatBytes(bytes) {
  if (!bytes) return '';
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
    job.bytes ? formatBytes(job.bytes) + (job.totalBytes ? ' / ' + formatBytes(job.totalBytes) : '') : '', job.note]
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
        'quiet', () => chrome.downloads.show(file.id)));
    }
  }
  if (actions.childElementCount) row.append(actions);
  return row;
}

function updateJobs(jobs) {
  const active = jobs.filter(job => activeStates.includes(job.state)).length;
  $('active-count').hidden = !active;
  $('active-count').textContent = active;
  $('queue-empty').hidden = Boolean(jobs.length);
  const snapshot = JSON.stringify(jobs);
  if (snapshot !== lastJobs) {
    const focused = document.activeElement;
    const id = focused?.closest('#queue li')?.dataset.id;
    const rows = jobs.map(renderJob);
    $('queue').replaceChildren(...rows);
    if (id) {
      const row = rows.find(node => node.dataset.id === id);
      [...(row?.querySelectorAll('button') || [])].find(node => node.textContent === focused.textContent)?.focus({preventScroll:true});
    }
    lastJobs = snapshot;
  }
  clearTimeout(pollTimer);
  if (active && panel === 'downloads') pollTimer = setTimeout(tick, 1100);
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
$('connection-status').addEventListener('click', () => showPanel('settings'));
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
$('history').addEventListener('click', guarded(() => chrome.tabs.create({url:'edge://downloads/'})));
$('folder').addEventListener('click', guarded(() => chrome.downloads.showDefaultFolder()));
$('pair').addEventListener('submit', guarded(async event => {
  event.preventDefault();
  const endpoint = $('endpoint').value.replace(/\/$/, '');
  if (!acceptedEndpoint.test(endpoint) || !URL.canParse(endpoint)) throw new Error('请输入 127.0.0.1 的本机 HTTP 地址');
  const next = {endpoint, token:$('token').value.trim()};
  await companion(next, '/api/health');
  await storage.set({connection:next});
  connection = next;
  connectionLabel();
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
  if (!(await chrome.tabs.getCurrent())) {
    const browser = await chrome.windows.getCurrent();
    const width = Math.min(screen.availWidth, browser.width ?? screen.availWidth);
    const height = Math.min(screen.availHeight, browser.height ?? screen.availHeight);
    const style = document.documentElement.style;
    const preferredWidth = Math.max(180, width - 32);
    style.setProperty('--popup-available-width', preferredWidth + 'px');
    style.setProperty('--popup-available-height', Math.max(160, height - 120) + 'px');
    // Edge opens with a provisional viewport and can then cap the popup
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
  const saved = await storage.get(['connection','downloadSettings','downloadJobs']);
  connection = saved.connection ?? connection;
  preferences = {...defaults, ...saved.downloadSettings};
  $('endpoint').value = connection.endpoint;
  $('token').value = connection.token;
  $('save-as').checked = preferences.saveAs;
  connectionLabel();
  const saveOptions = async options => {
    preferences = {...options, saveAs:$('save-as').checked};
    await request('settings', {settings:preferences});
    if (!openedOptions) $('media').replaceChildren(...streams.map(renderMedia));
  };
  const values = optionsInto($('settings-options'), Object.keys(optionSets), preferences, saveOptions);
  $('save-as').addEventListener('change', guarded(() => saveOptions(values)));
  storage.onChanged.addListener(changes => {
    if (changes.downloadJobs) updateJobs(changes.downloadJobs.newValue ?? []);
  });
  updateJobs(saved.downloadJobs ?? []);
  [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  await refresh();
})()
