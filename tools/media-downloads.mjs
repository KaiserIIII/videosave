import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, FFMPEG, discover, inputArgs, mediaUrl, parseCookies, probeStream, runMedia } from './media-source.mjs';

export { ApiError };
export const VERSION = '0.2.0';

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

const session = new AbortController();
const workQueue = [];
let running = 0;
const batches = new Map();
const batchKeys = new Map();

function pump() {
  while (running < 2 && workQueue.length) {
    const next = workQueue.findIndex(job => job.signal.aborted || !job.batch || job.batch.running < job.batch.concurrency);
    if (next < 0) return;
    const [{ signal, run, resolve, reject, batch }] = workQueue.splice(next, 1);
    if (signal.aborted) { reject(signal.reason); continue; }
    running += 1;
    if (batch) batch.running += 1;
    Promise.resolve().then(run).then(resolve, reject).finally(() => {
      running -= 1;
      if (batch) batch.running -= 1;
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
  return error instanceof ApiError ? { code: error.code, message: error.message }
    : { code: 'INTERNAL', message: '本地媒体工具执行失败' };
}

export async function probe({ url: value, cookie } = {}) {
  const url = mediaUrl(value);
  const cookies = parseCookies(cookie);
  return schedule(session.signal, async () => {
    const result = await discover(url, cookies, session.signal).catch(error => {
      if (error instanceof ApiError) throw error;
      throw new ApiError('PAGE_FAILED', '隔离 Edge 探测失败', 502);
    });
    for (const stream of result.streams) {
      const source = mediaUrl(stream.url);
      Object.assign(stream, await probeStream(source, source.origin === url.origin ? cookies : [], session.signal));
    }
    return result;
  });
}

function snapshot(batch) {
  return { id: batch.id, status: batch.status, items: batch.items.map(item => ({ ...item })), log: batch.log.slice(-40) };
}

function publish(batch, line) {
  if (line) {
    batch.log.push(line);
    if (batch.log.length > 40) batch.log.shift();
  }
  if (batch.listeners.size) {
    const current = snapshot(batch);
    for (const notify of batch.listeners) notify(current);
  }
}

function lookup(id) {
  if (!batches.has(id)) throw new ApiError('BATCH_NOT_FOUND', '找不到下载批次', 404);
  return batches.get(id);
}

export function progress(id) {
  return snapshot(lookup(id));
}

export function subscribe(id, notify) {
  const batch = lookup(id);
  if (batch.status === 'running' || batch.status === 'cancelling') batch.listeners.add(notify);
  notify(snapshot(batch));
  return () => batch.listeners.delete(notify);
}

export function cancel(id) {
  const batch = lookup(id);
  if (batch.status === 'running') {
    batch.status = 'cancelling';
    batch.controller.abort();
    publish(batch, '正在取消');
    pump();
  }
  return { ok: true };
}

function getTargets(values) {
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
    return { kind: value.kind, url: mediaUrl(value.url).href, format: value.format ?? 'mp4',
      mode: value.mode ?? 'combined', quality: value.quality ?? null, audioFormat: value.audioFormat ?? 'm4a',
      subtitles: value.subtitles ?? false,
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

export function queue({ items, maxSec, cookie, concurrency = 2, delivery = 'local' } = {}) {
  const targets = getTargets(items);
  if (concurrency !== 1 && concurrency !== 2) throw new ApiError('INVALID_CONCURRENCY', '并发数应为 1 或 2');
  if (delivery !== 'local' && delivery !== 'browser') throw new ApiError('INVALID_DELIVERY', '无效的保存方式');
  const limit = durationLimit(maxSec);
  const cookies = parseCookies(cookie);
  const key = createHash('sha256').update(JSON.stringify([targets, limit, cookies, concurrency, delivery])).digest('hex');
  const existing = batches.get(batchKeys.get(key));
  if (existing?.status === 'running') return { id: existing.id, total: targets.length };

  const id = randomUUID();
  const batch = {
    id, status: 'running', controller: new AbortController(), log: [], listeners: new Set(),
    concurrency, running: 0, delivery, files: new Map(),
    items: targets.map(({ kind, title }, idx) => ({ idx, kind, title, status: 'queued', percent: 0, file: null, error: null })),
  };
  batches.set(id, batch);
  batchKeys.set(key, id);
  const signal = AbortSignal.any([batch.controller.signal, session.signal]);
  const jobs = targets.map((target, index) => schedule(signal,
    () => runItem(batch, batch.items[index], target, limit, cookies, signal), batch)
    .catch(error => {
      const item = batch.items[index];
      item.status = signal.aborted ? 'cancelled' : 'error';
      if (!signal.aborted) item.error = errorDetails(error).message;
      publish(batch, `[${index + 1}] ${item.error || '已取消'}`);
    }));
  void Promise.all(jobs).then(() => {
    batch.status = signal.aborted ? 'cancelled' : 'done';
    if (batchKeys.get(key) === id) batchKeys.delete(key);
    publish(batch, signal.aborted ? '批次已取消' : '批次已结束');
  });
  return { id, total: targets.length };
}

function filename(title) {
  return (title || 'video').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ')
    .trim().slice(0, 70).replace(/[. ]+$/, '').replace(/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?=\.|$)/i, '_$1') || 'video';
}

async function save(source, name, extension) {
  for (let index = 1; ; index += 1) {
    const target = path.join(OUT_DIR, `${name}${index === 1 ? '' : `_${index}`}.${extension}`);
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

function outputTracks(target, tracks) {
  const videos = tracks?.filter(track => track.codec_type === 'video' && !track.disposition?.attached_pic)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (Number(b.bit_rate) || 0) - (Number(a.bit_rate) || 0));
  const within = videos?.find(track => track.height && (!target.quality || track.height <= target.quality));
  const video = within || (target.quality ? videos?.filter(track => track.height).at(-1) : videos?.[0]);
  const audioTracks = tracks?.filter(track => track.codec_type === 'audio');
  const audio = audioTracks?.find(track => track.disposition?.default) || audioTracks?.[0];
  if (target.mode !== 'audio' && tracks && !video) throw new ApiError('NO_VIDEO', '源文件里没有可用的视频轨');
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
  let source = input;
  if (target.kind === 'page') {
    const found = await discover(input, cookies, signal);
    const stream = found.streams[0];
    if (!stream) throw new ApiError('NO_MEDIA', '页面里没有找到可下载的媒体', 422);
    source = mediaUrl(stream.url);
    item.title ||= found.pageTitle || '';
  }
  const scopedCookies = source.origin === input.origin ? cookies : [];
  const { duration, width, height, tracks } = await probeStream(source, scopedCookies, signal, true);
  const { video, scaled, videoArgs, combinedAudio, audioArgs, subtitleArgs } = outputTracks(target, tracks);
  const actualHeight = scaled ? target.quality - target.quality % 2 : video?.height ?? height;
  const actualWidth = scaled ? Math.round(video.width * actualHeight / video.height / 2) * 2 : video?.width ?? width;
  item.info = { duration, width: actualWidth, height: actualHeight };
  const expected = duration && limit ? Math.min(duration, limit) : duration || limit;
  const name = [filename(item.title), target.mode !== 'audio' && actualWidth && actualHeight ? `${actualWidth}x${actualHeight}` : null,
    limit ? `前${limit}秒` : null].filter(Boolean).join('_');
  const directory = batch.delivery === 'browser' ? os.tmpdir() : OUT_DIR;
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, '.media-toolkit-'));
  const outputs = [];
  const addOutput = (suffix, extension, args) => {
    const outputName = name + suffix;
    const file = path.join(staging, outputName + '.' + extension);
    outputs.push({ name: outputName, extension, file,
      args: [...args, ...(limit ? ['-t', String(limit)] : []),
        ...(['mp4', 'm4a'].includes(extension) ? ['-movflags', '+faststart'] : []), file] });
  };
  if (target.mode !== 'audio') addOutput(target.mode === 'combined' ? '' : '_视频', target.format,
    [...videoArgs, ...(target.mode === 'combined' ? combinedAudio : []), ...subtitleArgs]);
  if (['audio', 'separate'].includes(target.mode)) addOutput('_音频', target.audioFormat, audioArgs);
  let held = false;
  const saved = [];
  try {
    item.status = 'downloading';
    publish(batch, `[${item.idx + 1}] 正在下载`);
    await runMedia(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats',
      ...inputArgs(source, scopedCookies), '-i', source.href, ...outputs.flatMap(output => output.args)], signal, line => {
      const seconds = /^out_time_us=(\d+)$/.exec(line)?.[1];
      if (!seconds || !expected) return;
      const percent = Math.min(99, Math.floor(Number(seconds) / 10000 / expected));
      if (percent > item.percent) { item.percent = percent; publish(batch); }
    });
    signal.throwIfAborted();
    if (batch.delivery === 'browser') {
      const files = await Promise.all(outputs.map(async output => ({
        file: output.file, name: path.basename(output.file), size: (await stat(output.file)).size,
      })));
      signal.throwIfAborted();
      const timer = setTimeout(() => void releaseFiles(batch.id, item.idx), browserFileLifetime);
      timer.unref();
      batch.files.set(item.idx, { staging, outputs: files, timer });
      held = true;
      item.outputs = files.map(({ name }, index) => ({ name, href: `/api/batch/${batch.id}/files/${item.idx}/${index}` }));
    } else {
      for (const output of outputs) {
        signal.throwIfAborted();
        const file = await save(output.file, output.name, output.extension);
        saved.push({ file, name: path.basename(file) });
      }
      signal.throwIfAborted();
      item.file = saved[0].file;
      item.outputs = saved;
    }
    item.status = 'done';
    item.percent = 100;
    publish(batch, `[${item.idx + 1}] 下载完成`);
  } catch (error) {
    await Promise.all(saved.map(({ file }) => rm(file, { force: true }).catch(() => {})));
    throw error;
  } finally {
    if (!held) await rm(staging, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

export async function recent() {
  const entries = await readdir(OUT_DIR, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mp4|mkv|m4a|mp3)$/i.test(entry.name)) continue;
    const info = await stat(path.join(OUT_DIR, entry.name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.isFile()) items.push({ name: entry.name, size: info.size, mtime: info.mtimeMs });
  }
  return { dir: OUT_DIR, items: items.sort((a, b) => b.mtime - a.mtime).slice(0, 20) };
}

export async function openDownload(file) {
  await mkdir(OUT_DIR, { recursive: true });
  const directory = await realpath(OUT_DIR);
  let args = [directory];
  if (file !== undefined) {
    if (typeof file !== 'string' || !file || !/\.(mp4|mkv|m4a|mp3)$/i.test(file) || /[\x00-\x1f,]/.test(file)) {
      throw new ApiError('INVALID_FILE', '请选择下载目录中的媒体文件');
    }
    const requested = path.resolve(OUT_DIR, file);
    if (path.relative(OUT_DIR, path.dirname(requested))) throw new ApiError('INVALID_FILE', '文件应在下载目录中');
    const actual = await realpath(requested).catch(error => {
      if (error.code === 'ENOENT') throw new ApiError('FILE_NOT_FOUND', '找不到下载文件', 404);
      throw error;
    });
    if (path.relative(directory, path.dirname(actual)) || !(await stat(actual)).isFile()) {
      throw new ApiError('INVALID_FILE', '文件应在下载目录中');
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
