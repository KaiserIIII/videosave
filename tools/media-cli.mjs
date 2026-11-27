#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { platformVideo } from '../extension/media.mjs';
import * as downloads from './media-downloads.mjs';
import { mediaUrl } from './media-source.mjs';
import { readCookieFileForOrigin } from './cookie-store.mjs';
import { configureMediaProxy } from './media-proxy.mjs';

const options = {
  help: { type: 'boolean' },
  page: { type: 'boolean' },
  'cookie-file': { type: 'string' },
  ua: { type: 'string' },
  referer: { type: 'string' },
  origin: { type: 'string' },
  connections: { type: 'string' },
  concurrency: { type: 'string' },
  quality: { type: 'string' },
  format: { type: 'string' },
  mode: { type: 'string' },
  subtitles: { type: 'boolean' },
  'no-resume': { type: 'boolean' },
};
const emit = result => process.stdout.write(JSON.stringify(result) + '\n');

async function loadCookieHeader(filename, urls) {
  if (new Set(urls.map(url => url.origin)).size !== 1) {
    throw new downloads.ApiError('INVALID_COOKIE', 'Use one origin per invocation when supplying a cookie file.');
  }
  const { cookies } = await readCookieFileForOrigin(filename, urls[0]);
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
}

function parseCliQuality(raw) {
  if (raw === undefined) return undefined;
  const text = raw.trim().toLowerCase();
  if (['max', 'best', 'auto', 'lowest'].includes(text) || /^exact:\d+$/.test(text)) return text;
  const num = Number(text.replace(/p$/, ''));
  return Number.isInteger(num) ? num : raw;
}

try {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  if (values.help) {
    process.stdout.write(
      'Usage: node tools/media-cli.mjs [--page] [--cookie-file PATH] [--ua USER_AGENT] [--referer URL] [--origin ORIGIN] [--quality max|best|auto|lowest|HEIGHT] [--format mp4|mkv] [--mode combined|video|audio|separate] [--subtitles] [--connections 4|8|12] [--concurrency N] [--no-resume] URL...\n',
    );
  } else {
    configureMediaProxy();
    if (!positionals.length) throw new downloads.ApiError('INVALID_ITEMS', 'Provide at least one HTTP(S) media or page URL.');
    const urls = positionals.map(mediaUrl);
    const cookie = values['cookie-file'] ? await loadCookieHeader(values['cookie-file'], urls) : undefined;
    const quality = parseCliQuality(values.quality);
    const headers = {};
    if (values.ua) headers['User-Agent'] = values.ua;
    if (values.referer) headers.Referer = values.referer;
    if (values.origin) headers.Origin = values.origin;
    const { id } = downloads.queueBatch({
      items: urls.map(url => ({
        kind: values.page || platformVideo(url) ? 'page' : 'stream',
        url: url.href,
        ...(quality !== undefined && { quality }),
        ...(values.format && { format: values.format }),
        ...(values.mode && { mode: values.mode }),
        ...(values.subtitles && { subtitles: true }),
      })),
      cookie,
      headers: Object.keys(headers).length ? headers : undefined,
      resume: values['no-resume'] ? false : true,
      connections: values.connections === undefined ? undefined : Number(values.connections),
      concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
    });
    const observer = new AbortController();
    const interrupt = () => observer.abort(new downloads.ApiError(
      'DOWNLOAD_INTERRUPTED', 'Interrupted. Submit the same request to resume.', 409));
    process.once('SIGINT', interrupt);
    let result;
    do {
      result = await downloads.waitForBatch({ id, timeoutMs: 1000 }, observer.signal);
      emit({
        id,
        status: result.status,
        ...(result.resumable && { resumable: true }),
        items: result.items.map(item => ({
          index: item.idx,
          status: item.status,
          phase: item.phase ?? item.status,
          engine: item.engine ?? null,
          fallbackReason: item.prefetchFallback?.reason ?? null,
          percent: item.percent,
          speed: item.speed,
          bytes: item.bytes,
          totalBytes: item.totalBytes,
          etaSec: item.etaSec,
          segments: item.segments,
          resumable: Boolean(item.resumable ?? result.resumable),
          file: item.file,
          info: item.info ?? null,
          verification: item.verification ?? (item.status === 'done' && item.info ? {
            ok: true,
            width: item.info.width ?? null,
            height: item.info.height ?? null,
            duration: item.info.duration ?? null,
            codec: item.info.codec ?? null,
            audioCodec: item.info.audioCodec ?? null,
          } : null),
          errorCode: item.errorCode ?? null,
          ...(item.detail && { detail: item.detail }),
        })),
      });
    } while (result.timedOut);
    process.removeListener('SIGINT', interrupt);
    process.exitCode = result.status === 'done' ? 0 : 1;
  }
} catch (error) {
  emit({ status: 'failed', ...downloads.errorDetails(error) });
  process.exitCode = 1;
} finally {
  downloads.shutdown();
}
