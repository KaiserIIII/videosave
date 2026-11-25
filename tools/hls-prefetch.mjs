import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const segmentWorkers = 8;
const manifestByteLimit = 128 * 1024;
const supportedTag = /^#EXT(?:M3U|INF:[\d.]+,.*|-X-(?:VERSION:\d+|TARGETDURATION:\d+|MEDIA-SEQUENCE:\d+|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS|ENDLIST))$/;

async function request(url, origin, cookies, signal) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: cookies && url.origin === origin ? { cookie: cookies } : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error('HLS response unavailable for parallel download');
  }
  return response.body;
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

function parseManifest(text, source) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U' || lines.at(-1) !== '#EXT-X-ENDLIST') return null;
  const segments = [];
  const playlist = [];
  let needsSegment = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      if (!supportedTag.test(line) || needsSegment) return null;
      needsSegment = line.startsWith('#EXTINF:');
      playlist.push(line);
      continue;
    }
    const url = URL.parse(line, source);
    if (!needsSegment || !url || !/^https?:$/.test(url.protocol) || url.username || url.password ||
        !/\.ts$/i.test(url.pathname)) return null;
    const filename = 'segment-' + segments.length + '.ts';
    segments.push({ url, filename });
    playlist.push(filename);
    needsSegment = false;
  }
  if (segments.length < 2) return null;
  return { segments, playlist: playlist.join('\n') + '\n' };
}

export async function prefetchHls(source, cookies, staging, signal, onProgress) {
  if (!/\.m3u8$/i.test(source.pathname)) return null;
  const cookieHeader = cookies.map(({ name, value }) => name + '=' + value).join('; ');
  const controller = new AbortController();
  const transferSignal = AbortSignal.any([signal, controller.signal]);
  const directory = path.join(staging, 'segments');
  let directoryCreated = false;
  try {
    const body = await request(source, source.origin, cookieHeader,
      AbortSignal.any([transferSignal, AbortSignal.timeout(3000)]));
    const manifest = parseManifest(await readManifest(body), source);
    if (!manifest) return null;
    const { segments, playlist } = manifest;
    await mkdir(directory);
    directoryCreated = true;
    let next = 0;
    let finished = 0;
    const download = async () => {
      try {
        while (next < segments.length) {
          const { url, filename } = segments[next++];
          const segment = await request(url, source.origin, cookieHeader, transferSignal);
          const output = createWriteStream(path.join(directory, filename));
          await pipeline(segment, output, { signal: transferSignal });
          if (!output.bytesWritten) throw new Error('Empty HLS segment');
          onProgress(++finished / segments.length);
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(segmentWorkers, segments.length) }, download));
    if (results.some(result => result.status === 'rejected')) throw transferSignal.reason;
    const filename = path.join(directory, 'download.m3u8');
    await writeFile(filename, playlist);
    return filename;
  } catch {
    if (directoryCreated) await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    signal.throwIfAborted();
    return null;
  }
}
