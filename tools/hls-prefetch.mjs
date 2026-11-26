import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const segmentWorkers = 8;
const manifestByteLimit = 128 * 1024;
const supportedTag = /^#EXT(?:M3U|INF:[\d.]+,.*|-X-(?:VERSION:\d+|TARGETDURATION:\d+|MEDIA-SEQUENCE:\d+|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS|ENDLIST))$/;

function httpUrl(value, base) {
  const url = URL.parse(value, base);
  return url && /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
}

async function request(url, origin, cookies, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: cookies && url.origin === origin ? { cookie: cookies } : undefined,
      signal: deadline,
    });
    if (response.status === 200 && response.body) return {url, body:response.body};
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301,302,303,307,308].includes(response.status) || !location) break;
    url = httpUrl(location, url);
    if (!url) break;
  }
  throw new Error('HLS response unavailable for parallel download');
}

async function readManifest(body) {
  let bytes = 0;
  const chunks = [];
  // Leaving a for-await loop early cancels the response body.
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > manifestByteLimit) return '';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function manifestLines(text) {
  return text.trim().split(/\r?\n/).map(line => line.trim()).filter(line => line && (!line.startsWith('#') || line.startsWith('#EXT')));
}

function selectRendition(text, source, quality) {
  const [header, ...lines] = manifestLines(text);
  if (header !== '#EXTM3U') return null;
  const variants = [];
  const audio = [];
  let pending;
  for (const line of lines) {
    if (pending) {
      const url = !line.startsWith('#') && httpUrl(line, source);
      if (!url) return null;
      variants.push({...pending, url});
      pending = null;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = line.slice(line.indexOf(':') + 1);
      if (/(?:^|,)(?:VIDEO|SUBTITLES|CLOSED-CAPTIONS)=(?!NONE(?:,|$))/.test(attributes)) return null;
      const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attributes)?.[1]);
      const height = Number(/(?:^|,)RESOLUTION=\d+x(\d+)/.exec(attributes)?.[1]);
      if (!bandwidth || !height) return null;
      pending = {height, bandwidth, audioGroup:attribute(attributes,'AUDIO')};
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = line.slice(line.indexOf(':') + 1);
      const group = attribute(attributes, 'GROUP-ID');
      const uri = attribute(attributes, 'URI');
      if (!/(?:^|,)TYPE=AUDIO(?:,|$)/.test(attributes) || !group || !uri) return null;
      const url = httpUrl(uri, source);
      if (!url) return null;
      audio.push({url,group,preferred:/(?:^|,)DEFAULT=YES(?:,|$)/.test(attributes)});
    } else if (!/^#EXT-X-(?:VERSION:\d+|INDEPENDENT-SEGMENTS)$/.test(line)) {
      return null;
    }
  }
  if (pending || !variants.length) return null;
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const lowest = variants.find(variant => variant.height === variants.at(-1).height);
  const variant = variants.find(variant => !quality || variant.height <= quality) ?? lowest;
  const group = audio.filter(track => track.group === variant.audioGroup);
  const sound = group.find(track => track.preferred) ?? group[0];
  if (variant.audioGroup && !sound) return null;
  return {video:variant.url, audio:sound?.url, bandwidth:variant.bandwidth};
}

function attribute(attributes, key) {
  return new RegExp(`(?:^|,)${key}="([^"]+)"`).exec(attributes)?.[1];
}

function parseManifest(text, source, prefix) {
  const lines = manifestLines(text);
  if (lines[0] !== '#EXTM3U' || lines.at(-1) !== '#EXT-X-ENDLIST') return null;
  const segments = [];
  const playlist = [];
  let needsSegment = false;
  let initFilename;
  let mediaCount = 0;
  for (const line of lines) {
    if (line.startsWith('#')) {
      const map = /^#EXT-X-MAP:URI="([^"]+)"$/.exec(line);
      if (map) {
        const url = httpUrl(map[1], source);
        if (!url || needsSegment) return null;
        initFilename = `${prefix}-init-${segments.length}.mp4`;
        segments.push({url, filename:initFilename});
        playlist.push(`#EXT-X-MAP:URI="${initFilename}"`);
        continue;
      }
      if (/^#EXT-X-BITRATE:\d+$/.test(line)) continue;
      if (!supportedTag.test(line) || needsSegment) return null;
      needsSegment = line.startsWith('#EXTINF:');
      playlist.push(line);
      continue;
    }
    const url = httpUrl(line, source);
    if (!needsSegment || !url || !initFilename && !/\.ts$/i.test(url.pathname)) return null;
    const filename = `${prefix}-${segments.length}.${initFilename ? 'm4s' : 'ts'}`;
    segments.push({ url, filename });
    playlist.push(filename);
    mediaCount++;
    needsSegment = false;
  }
  if (mediaCount < 2 || needsSegment) return null;
  return { segments, playlist: playlist.join('\n') + '\n' };
}

export async function prefetchHls(source, cookies, staging, signal, onProgress, { quality, sourceKind, connections = segmentWorkers } = {}) {
  if (sourceKind !== 'm3u8' && !/\.m3u8$/i.test(source.pathname)) return null;
  const cookieHeader = cookies.map(({ name, value }) => name + '=' + value).join('; ');
  const controller = new AbortController();
  const transferSignal = AbortSignal.any([signal, controller.signal]);
  const directory = path.join(staging, 'segments');
  let directoryCreated = false;
  try {
    const read = async url => {
      const response = await request(url, source.origin, cookieHeader,
        AbortSignal.any([transferSignal, AbortSignal.timeout(5000)]));
      return {url:response.url, text:await readManifest(response.body)};
    };
    const first = await read(source);
    const rendition = selectRendition(first.text, first.url, quality);
    const [selected, sound] = rendition ? await Promise.all([read(rendition.video), rendition.audio && read(rendition.audio)]) : [first];
    const video = parseManifest(selected.text, selected.url, 'video');
    const audio = sound && parseManifest(sound.text, sound.url, 'audio');
    if (!video || sound && !audio) return null;
    const segments = video.segments.concat(audio?.segments || []);
    await mkdir(directory);
    directoryCreated = true;
    let next = 0;
    let finished = 0;
    let received = 0;
    const download = async () => {
      try {
        while (next < segments.length) {
          const { url, filename } = segments[next++];
          const segment = await request(url, source.origin, cookieHeader, transferSignal);
          const output = createWriteStream(path.join(directory, filename));
          await pipeline(segment.body, async function* (chunks) {
            for await (const chunk of chunks) {
              received += chunk.byteLength;
              onProgress(null, received);
              yield chunk;
            }
          }, output, { signal: transferSignal });
          if (!output.bytesWritten) throw new Error('Empty HLS segment');
          onProgress(++finished / segments.length, received);
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(connections, segments.length) }, download));
    if (results.some(result => result.status === 'rejected')) throw transferSignal.reason;
    const filename = path.join(directory, 'download.m3u8');
    if (audio) {
      await Promise.all([writeFile(path.join(directory,'video.m3u8'),video.playlist),
        writeFile(path.join(directory,'audio.m3u8'),audio.playlist)]);
      await writeFile(filename, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,URI="audio.m3u8"\n' +
        `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AUDIO="audio"\nvideo.m3u8\n`);
    } else {
      await writeFile(filename, video.playlist);
    }
    return filename;
  } catch (error) {
    controller.abort(error);
    if (directoryCreated) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    signal.throwIfAborted();
    return null;
  }
}
