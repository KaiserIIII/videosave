import { isPlaylist, mediaResponseSize, classify } from './media.mjs';

export function canQuerySize(stream) {
  return stream.kind !== 'page' && (!isPlaylist(stream.kind) || stream.kind === 'm3u8' && stream.duration > 0);
}

async function estimateHlsSize(stream, signal) {
  const response = await fetch(stream.url, {credentials:'omit', signal});
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const decoder = new TextDecoder();
  let manifest = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 128 * 1024) return null;
    manifest += decoder.decode(chunk, {stream:true});
  }
  manifest += decoder.decode();
  if (!manifest.trimStart().startsWith('#EXTM3U')) return null;
  const variants = [...manifest.matchAll(/^#EXT-X-STREAM-INF:([^\r\n]+)$/gm)].map(([, attributes]) => ({
    rate:Number(/(?:^|,)AVERAGE-BANDWIDTH=(\d+)(?:,|$)/.exec(attributes)?.[1]),
    height:Number(/(?:^|,)RESOLUTION=\d+x(\d+)(?:,|$)/.exec(attributes)?.[1]),
  })).filter(variant => variant.rate > 0 && variant.height > 0);
  const matching = stream.height ? variants.filter(variant => variant.height === stream.height) : variants;
  const rate = matching.sort((a,b) => b.height - a.height || b.rate - a.rate)[0]?.rate;
  const size = Math.round(rate * stream.duration / 8);
  return Number.isSafeInteger(size) && size > 0 ? {size, estimated:true} : null;
}

export async function queryMediaSize(stream) {
  const signal = AbortSignal.timeout(4000);
  if (stream.kind === 'm3u8' && stream.duration > 0) return estimateHlsSize(stream, signal);
  if (isPlaylist(stream.kind)) return null;
  for (const method of ['HEAD', 'GET']) {
    const response = await fetch(stream.url, {method, credentials:'omit', signal,
      ...(method === 'GET' && {headers:{Range:'bytes=0-0'}})});
    void response.body?.cancel().catch(() => {});
    const mime = response.headers.get('content-type') || '';
    const kind = classify(response.url, mime);
    const size = mediaResponseSize(kind, response.status, name => response.headers.get(name));
    if (size != null) return {size, estimated:false};
  }
  return null;
}

export async function preparePreview(connection, stream, seconds, signal) {
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(connection.endpoint)) throw new Error('本机服务地址无效');
  const response = await fetch(connection.endpoint + '/api/preview', {
    method:'POST', headers:{authorization:'Bearer ' + connection.token,'content-type':'application/json'},
    body:JSON.stringify({url:stream.url, seconds}), signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(response.status === 404 ? '请启动新版的本机服务' : data?.error?.message || '本机服务无法生成预览');
  }
  const size = Number(response.headers.get('content-length'));
  if (response.headers.get('content-type') !== 'video/mp4' || size <= 0 || size > 8 * 1024 * 1024) {
    await response.body?.cancel();
    throw new Error('预览文件不可用');
  }
  return response.blob();
}
