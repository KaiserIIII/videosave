import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, withEdge } from './edge-session.mjs';
import { classify, pageStreams, scanDocument, sourceTitle } from '../extension/media.mjs';

export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function mediaUrl(value) {
  if (typeof value === 'string' && value.length <= 8192) {
    const url = URL.parse(value);
    if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      url.hash = '';
      return url;
    }
  }
  throw new ApiError('INVALID_URL', '需要一个不含登录信息的 HTTP(S) 链接');
}

export function parseCookies(header = '') {
  if (typeof header !== 'string' || header.length > 16384 || /[^\x20-\x7e]/.test(header)) {
    throw new ApiError('INVALID_COOKIE', 'Cookie 必须是有效的单行请求头');
  }
  return header.split(';').map(pair => pair.trim()).filter(Boolean).map(pair => {
    const match = /^([!#$%&'*+.\x60^_|~\w-]+)=(.*)$/.exec(pair);
    if (!match) throw new ApiError('INVALID_COOKIE', 'Cookie 格式应为 name=value');
    return { name: match[1], value: match[2] };
  });
}

export async function discover(url, cookies, signal) {
  return withEdge(['--autoplay-policy=no-user-gesture-required'], async ({ list }) => {
    const target = (await list()).find(t => t.type === 'page' && t.url === 'about:blank');
    if (!target) throw new ApiError('PAGE_FAILED', '隔离 Edge 未创建页面', 502);
    const page = await connectCdp(target.webSocketDebuggerUrl, signal);
    try {
      const responses = new Map();
      page.on('Network.responseReceived', ({ response, frameId, type }) => {
        if (response.status < 200 || response.status >= 300 || (!classify(response.url, response.mimeType) && !classify(response.url))) return;
        if (responses.size < 120 || responses.has(response.url)) {
          responses.set(response.url, {url:response.url, mime:response.mimeType, frameId, type:type?.toLowerCase()});
        }
      });
      await page.send('Network.enable');
      if (cookies.length) {
        await page.send('Network.setCookies', { cookies: cookies.map(cookie => ({ ...cookie, url: url.origin, path: '/', secure: url.protocol === 'https:' })) });
      }
      const nav = await page.send('Page.navigate', { url: url.href });
      if (nav.errorText) throw new ApiError('PAGE_FAILED', 'Edge 无法打开目标页面', 502);
      const deadline = Date.now() + 20000;
      let collectUntil = deadline;
      let found;
      do {
        await sleep(300, undefined, { signal });
        found = await page.evaluate(`(${scanDocument})()`).catch(error => {
          if (signal.aborted || !/context.*(destroyed|find)/i.test(error.message) &&
              !/Cannot find context/i.test(error.message)) throw error;
        });
        if (found?.candidates.some(candidate => classify(candidate.url, candidate.mime, candidate.mediaElement)) || responses.size) collectUntil = Math.min(collectUntil, Date.now() + 1200);
        else if (found?.ready && found.pages.length) collectUntil = Math.min(collectUntil, Date.now() + 3000);
      } while (Date.now() < collectUntil);
      const observed = [...responses.values()].map(row => ({...row, frameId:row.frameId === nav.frameId ? 0 : row.frameId}));
      const streams = found?.encrypted ? [] : pageStreams(found ? [{frameId:0,result:found}] : [], observed);
      return {
        pageTitle: found?.pageMetadata?.title || found?.pageTitle || null,
        streams: streams.flatMap(stream => [stream,...(stream.alternates ?? [])]).slice(0, 24)
          .map(({url,kind,title,filename,duration,width,height}) =>
          ({url,kind,title:title || sourceTitle({url,filename}) || undefined,duration,width,height})),
        pages: found?.pages || [],
      };
    } finally { page.close(); }
  }, signal);
}

function inputArgs(url, cookies = []) {
  return [
    '-protocol_whitelist', 'http,https,tcp,tls,httpproxy', '-rw_timeout', '15000000',
    ...(cookies.length ? ['-cookies', cookies.map(({ name, value }) =>
      `${name}=${value}; path=/; domain=${url.hostname};`).join('\n')] : []),
  ];
}

export async function runMedia(bin, args, signal, onLine) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '', stderr = '', pending = '', failure;
    proc.stdout.setEncoding('utf8').on('data', chunk => {
      if (!onLine) { stdout = (stdout + chunk).slice(-65536); return; }
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) onLine(line.trim());
    });
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    proc.on('error', error => { failure = error; });
    proc.on('close', code => {
      if (signal.aborted) return reject(signal.reason);
      if (failure) return reject(new ApiError('TOOL_UNAVAILABLE', `无法启动 ${bin}`, 503));
      if (code !== 0) {
        const httpStatus = /(?:HTTP error|Server returned) (\d{3})/i.exec(stderr)?.[1];
        return reject(new ApiError('MEDIA_FAILED', httpStatus ? `媒体服务器返回 HTTP ${httpStatus}` : '媒体读取或封装失败', 502));
      }
      resolve(stdout);
    });
  });
}

const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
export const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

export async function probeStream(url, cookies, signal, tracks = false) {
  try {
    const entries = tracks
      ? 'format=duration:stream=index,codec_type,codec_name,width,height,bit_rate:stream_disposition=attached_pic,default'
      : 'format=duration:stream=width,height';
    const raw = await runMedia(FFPROBE, ['-v', 'error', '-show_entries', entries,
      '-of', 'json', ...mediaInput(url, cookies)], AbortSignal.any([signal, AbortSignal.timeout(25000)]));
    const parsed = JSON.parse(raw);
    const video = parsed.streams?.find(s => s.width);
    return { duration: Number(parsed.format?.duration) || null, width: video?.width ?? null, height: video?.height ?? null,
      ...(tracks && {tracks:parsed.streams ?? []}) };
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'TOOL_UNAVAILABLE') throw error;
    return { duration: null, width: null, height: null };
  }
}

export function mediaInput(source, cookies, ...beforeSource) {
  // Only the locally generated HLS playlist can reference other files.
  if (typeof source === 'string') return ['-protocol_whitelist', 'file',
    ...(source.endsWith('.bin') ? ['-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,avi,mpegts,mpeg'] : []),
    ...beforeSource, source];
  return [...inputArgs(source, cookies), ...beforeSource, source.href];
}
