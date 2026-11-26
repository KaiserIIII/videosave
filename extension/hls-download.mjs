import { browserApi, isFirefox } from './browser.mjs';
import { httpUrl, parseManifest, readManifest, selectRendition } from './hls.mjs';

export const canSaveHls = Boolean(isFirefox || browserApi?.offscreen?.createDocument && browserApi.runtime.getContexts);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const segmentIdleMs = 8000;
const pending = new Map();
let creatingDocument;

export async function hlsStorage() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('hls-downloads', {create:true});
}

async function readPart(directory, name) {
  try {
    return await (await directory.getFileHandle(name)).getFile();
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    return null;
  }
}

async function writePart(directory, name, data, signal) {
  signal.throwIfAborted();
  const handle = await directory.getFileHandle(name, {create:true});
  const writer = await handle.createWritable();
  try {
    signal.throwIfAborted();
    await writer.write(data);
    signal.throwIfAborted();
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

async function checkpoint(key, playlist, signal) {
  const data = new TextEncoder().encode(JSON.stringify([playlist.url, playlist.etag, playlist.text]));
  const hash = await crypto.subtle.digest('SHA-256', data);
  const tag = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const root = await hlsStorage();
  const dirname = 'parts-' + key;
  const get = () => root.getDirectoryHandle(dirname, {create:true});
  let directory = await get();
  const saved = await readPart(directory, 'playlist');
  if (saved?.size === tag.length && await saved.text() === tag) return directory;
  await root.removeEntry(dirname, {recursive:true});
  directory = await get();
  await writePart(directory, 'playlist', tag, signal);
  return directory;
}

// Fixed-width indexes keep parts in playback order when a job resumes or finishes.
const partName = index => 'segment-' + String(index).padStart(8, '0');

async function response(url, origin, signal, headers) {
  const reply = await fetch(url, {signal, headers, ...(headers && {cache:'no-store'}),
    credentials:url.origin === origin ? 'include' : 'omit'});
  if ((reply.status === 200 || headers && reply.status === 206) && reply.body) return reply;
  await reply.body?.cancel();
  const error = new Error('媒体服务器返回错误');
  error.status = reply.status;
  error.permanent = !transientStatuses.has(reply.status);
  throw error;
}

async function segmentBlob(segment, origin, signal, onBytes, validateRange) {
  let maximum = 0;
  let received = 0;
  let parts = [];
  let resume;
  const slice = segment.range;
  for (let attempt = 0; ; attempt++) {
    const request = new AbortController();
    const requestSignal = AbortSignal.any([signal, request.signal]);
    let timer;
    const resetDeadline = delay => {
      clearTimeout(timer);
      timer = setTimeout(() => request.abort(new DOMException('HLS 分片无响应', 'TimeoutError')), delay);
    };
    try {
      resetDeadline(12000);
      const resuming = resume && received > 0 && received < resume.size;
      const start = resuming ? (slice?.start ?? 0) + received : slice?.start;
      const end = slice?.end ?? (resuming ? resume.size - 1 : undefined);
      const headers = start === undefined ? undefined : {Range:`bytes=${start}-${end}`,
        ...(resuming && {'If-Range':resume.etag})};
      const reply = await response(segment.url, origin, requestSignal, headers);
      const encoding = reply.headers.get('content-encoding')?.toLowerCase() ?? 'identity';
      const etag = reply.headers.get('etag');
      const strongEtag = /^"[!#-\x7e]*"$/.test(etag);
      const length = reply.headers.get('content-length');
      let expected;
      if (reply.status === 200) {
        received = 0;
        parts = [];
        resume = undefined;
        if (slice) throw Object.assign(new Error('HLS 分片范围不可用'), {permanent:!resuming});
        const size = Number(length);
        if (encoding === 'identity' && Number.isSafeInteger(size) && size > 0) {
          expected = size;
          if (strongEtag && reply.headers.get('accept-ranges')?.toLowerCase() === 'bytes') resume = {size,total:size,etag};
        }
      } else {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(reply.headers.get('content-range'));
        const total = Number(range?.[3]);
        if (encoding !== 'identity' || !Number.isSafeInteger(total) || total <= end ||
            Number(range[1]) !== start || Number(range[2]) !== end ||
            (resuming && (etag !== resume.etag || total !== resume.total)) ||
            (length !== null && Number(length) !== end - start + 1)) {
          parts = [];
          received = 0;
          resume = undefined;
          throw new Error('HLS 分片范围已变化');
        }
        if (slice) validateRange(total, strongEtag ? etag : null);
        expected = end - (slice?.start ?? 0) + 1;
        resume = strongEtag ? {size:expected,total,etag} : undefined;
      }
      resetDeadline(segmentIdleMs);
      for await (const chunk of reply.body) {
        resetDeadline(segmentIdleMs);
        received += chunk.byteLength;
        if (expected !== undefined && received > expected) {
          parts = [];
          received = 0;
          resume = undefined;
          throw new Error('HLS 分片大小已变化');
        }
        parts.push(chunk);
        if (received > maximum) {
          onBytes(received - maximum);
          maximum = received;
        }
      }
      if (expected !== undefined && received !== expected) throw new Error('HLS 分片不完整');
      const blob = new Blob(parts);
      const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      const box = String.fromCharCode(...header.slice(4));
      const valid = segment.filename.endsWith('.ts') ? header[0] === 0x47
        : segment.filename.endsWith('.mp4') ? box === 'ftyp' : ['styp','moof','sidx','emsg','prft','free'].includes(box);
      if (!valid) throw new Error('分片格式无法直接保存');
      return blob;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 2 || error.permanent && !(resume && error.status === 416)) throw error;
      if (error.status === 416 || resume && received >= resume.size) {
        parts = [];
        received = 0;
        resume = undefined;
      }
    } finally {
      clearTimeout(timer);
      request.abort();
    }
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
}

async function assemble(job, controller, update) {
  const signal = controller.signal;
  const source = httpUrl(job.stream.url);
  if (!source) throw new Error('媒体地址必须使用 HTTP(S)');
  const read = async url => {
    const reply = await response(url, source.origin, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
    return {url:reply.url, etag:reply.headers.get('etag'), text:await readManifest(reply.body)};
  };
  const first = await read(source);
  const quality = Number(job.settings.quality);
  const rendition = selectRendition(first.text, first.url, quality);
  if (rendition?.audio) throw new Error('此 HLS 需要本机服务合并独立音轨');
  if (quality && (!rendition || rendition.height > quality)) {
    throw new Error('此 HLS 没有符合画质上限的版本，请连接本机服务');
  }
  const selected = rendition ? await read(rendition.video) : first;
  const video = parseManifest(selected.text, selected.url, 'video', {byteRanges:true});
  if (!video) throw new Error('此 HLS 无法直接保存，请连接本机服务');
  const {segments} = video;
  const fragmented = segments[0].filename.endsWith('.mp4');
  if (segments.slice(1).some(part => !part.filename.endsWith(fragmented ? '.m4s' : '.ts'))) {
    throw new Error('此 HLS 无法直接保存，请连接本机服务');
  }
  const hasByteRanges = segments.some(segment => segment.range);
  const directory = await checkpoint(job.attemptId, selected, signal);
  const connections = Math.min(job.settings.connections, segments.length);
  const representations = new Map();
  const validateRange = url => (total, etag) => {
    const previous = representations.get(url.href);
    if (previous && (previous.total !== total || previous.etag !== etag)) {
      throw Object.assign(new Error('HLS 分片来源已变化'), {permanent:true});
    }
    if (!previous) representations.set(url.href, {total,etag});
  };
  let next = 0;
  let completed = 0;
  let bytes = 0;
  const progress = () => update(Math.floor(completed * 99 / segments.length), bytes);
  const onBytes = received => {
    bytes += received;
    progress();
  };
  const downloadParts = async () => {
    try {
      while (!signal.aborted && next < segments.length) {
        const index = next++;
        const name = partName(index);
        const saved = await readPart(directory, name);
        if (saved?.size && !hasByteRanges) {
          bytes += saved.size;
        } else {
          const segment = segments[index];
          const blob = await segmentBlob(segment, source.origin, signal, onBytes, validateRange(segment.url));
          await writePart(directory, name, blob, signal);
        }
        completed++;
        progress();
      }
    } catch (error) {
      controller.abort(error);
    }
  };
  await Promise.all(Array.from({length:connections}, downloadParts));
  signal.throwIfAborted();
  return {extension:fragmented ? 'mp4' : 'ts', segmentCount:segments.length};
}

export async function hlsFileUrl(action, key, url, extension, segmentCount) {
  if (action === 'revoke') return URL.revokeObjectURL(url);
  const root = await hlsStorage();
  const directory = await root.getDirectoryHandle('parts-' + key);
  const files = [];
  for (let index = 0; index < segmentCount; index++) {
    const file = await readPart(directory, partName(index));
    if (!file?.size) throw new Error('HLS 分片不完整');
    files.push(file);
  }
  if (!files.length) throw new Error('HLS 分片不完整');
  return URL.createObjectURL(new Blob(files, {type:extension === 'mp4' ? 'video/mp4' : 'video/mp2t'}));
}

async function fileUrl(action, key, url, extension, segmentCount) {
  if (isFirefox) return hlsFileUrl(action, key, url, extension, segmentCount);
  const documentUrl = browserApi.runtime.getURL('hls-file.html');
  if (action === 'create') {
    creatingDocument ??= (async () => {
      const contexts = await browserApi.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[documentUrl]});
      if (!contexts.length) await browserApi.offscreen.createDocument({
        url:documentUrl, reasons:['BLOBS'], justification:'Save the assembled video through the browser download manager.',
      });
    })().finally(() => { creatingDocument = undefined; });
    await creatingDocument;
  }
  const result = await browserApi.runtime.sendMessage({scope:'hls-file-url',action,key,url,extension,segmentCount});
  if (result?.error) throw new Error(result.error);
  return result?.url;
}

export function prepareHls(job, refresh) {
  let transfer = pending.get(job.attemptId);
  if (!transfer) {
    const controller = new AbortController();
    transfer = {controller, percent:0, bytes:0, speed:0};
    let sampledAt = performance.now();
    let sampledBytes = 0;
    pending.set(job.attemptId, transfer);
    transfer.promise = assemble(job, controller, (percent, bytes) => {
      Object.assign(transfer, {percent, bytes});
      const now = performance.now();
      if (now - sampledAt >= 300) {
        const speed = 1000 * (bytes - sampledBytes) / (now - sampledAt);
        transfer.speed = Math.round(transfer.speed ? (transfer.speed + speed) / 2 : speed);
        sampledAt = now;
        sampledBytes = bytes;
      }
    })
      .then(async ({extension, segmentCount}) => {
        controller.signal.throwIfAborted();
        const url = await fileUrl('create', job.attemptId, null, extension, segmentCount);
        if (!url?.startsWith('blob:')) throw new Error('浏览器无法保存分片文件');
        Object.assign(transfer, {url,extension});
      }).catch(error => { transfer.error = error; }).finally(refresh);
  }
  return transfer;
}

export async function releaseHls(job) {
  const transfer = pending.get(job.attemptId);
  transfer?.controller.abort();
  await transfer?.promise;
  pending.delete(job.attemptId);
  const url = job.hlsUrl || transfer?.url;
  if (url) await fileUrl('revoke', job.attemptId, url).catch(() => {});
  const directory = await hlsStorage().catch(() => null);
  await directory?.removeEntry('parts-' + job.attemptId, {recursive:true}).catch(() => {});
  await directory?.removeEntry(job.attemptId).catch(() => {});
  delete job.hlsUrl;
}

export function finishHls(job) {
  pending.delete(job.attemptId);
}
