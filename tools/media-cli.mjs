#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { platformVideo } from '../extension/media.mjs';
import * as downloads from './media-downloads.mjs';
import { mediaUrl, mergeMediaHeaders } from './media-source.mjs';
import { readCookieFileForOrigin } from './cookie-store.mjs';
import { configureMediaProxy } from './media-proxy.mjs';
import { configureSandboxFromArgv } from './preferences.mjs';

/**
 * Exit code semantics (Section 08 / P2-1):
 *   0 = Success
 *   1 = General/unexpected runtime error
 *   2 = Invalid CLI arguments / invalid input
 *   3 = Insufficient disk space (NO_SPACE)
 *   4 = User action / login / challenge / access restricted (401/403/451/SESSION_EXPIRED)
 *   5 = Media or requested quality unavailable (NO_MEDIA / QUALITY_UNAVAILABLE / STREAM_EXPIRED / DRM)
 */
function exitCodeForError(code) {
  if (!code) return 1;
  if (/^INVALID_/.test(code) || code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return 2;
  if (code === 'NO_SPACE') return 3;
  if (['MEDIA_ACCESS_RESTRICTED', 'MCP_MEDIA_ACCESS_RESTRICTED', 'SESSION_EXPIRED', 'LOGIN_REQUIRED', 'USER_ACTION_REQUIRED', 'BROWSER_SESSION_BUSY', 'SESSION_BUSY'].includes(code)) return 4;
  if (['NO_MEDIA', 'QUALITY_UNAVAILABLE', 'STREAM_EXPIRED', 'DRM', 'INVALID_HLS_SEGMENT', 'INVALID_DASH_SEGMENT', 'INVALID_MEDIA_CONTENT'].includes(code)) return 5;
  return 1;
}

const options = {
  help: { type: 'boolean' },
  page: { type: 'boolean' },
  out: { type: 'string' },
  'cookie-file': { type: 'string' },
  ua: { type: 'string' },
  referer: { type: 'string' },
  origin: { type: 'string' },
  'headers-json': { type: 'string' },
  'session-id': { type: 'string' },
  connections: { type: 'string' },
  concurrency: { type: 'string' },
  quality: { type: 'string' },
  format: { type: 'string' },
  mode: { type: 'string' },
  'conflict-action': { type: 'string' },
  'filename-template': { type: 'string' },
  subtitles: { type: 'boolean' },
  resume: { type: 'boolean' },
  'no-resume': { type: 'boolean' },
  'json-progress': { type: 'boolean' },
  verify: { type: 'boolean' },
  'duration-tolerance': { type: 'string' },
  sandbox: { type: 'boolean' },
  'sandbox-dir': { type: 'string' },
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
      'Usage: node tools/media-cli.mjs [OPTIONS] URL...\n' +
      'Options:\n' +
      '  --out DIR                    Output directory override\n' +
      '  --page                       Treat input URLs as web pages to probe\n' +
      '  --cookie-file PATH           Netscape cookies.txt or HTTP Cookie header file\n' +
      '  --ua USER_AGENT              Custom User-Agent header\n' +
      '  --referer URL                Referer header\n' +
      '  --origin ORIGIN              Origin header\n' +
      '  --headers-json JSON          JSON object of allowed media headers\n' +
      '  --session-id ID              Dedicated VideoSave browser session ID (for --page)\n' +
      '  --quality SPEC               max|best|auto|lowest|exact:HEIGHT|HEIGHT\n' +
      '  --format mp4|mkv             Output container format\n' +
      '  --mode MODE                  combined|video|audio|separate\n' +
      '  --conflict-action ACTION     uniquify|skip|overwrite\n' +
      '  --filename-template TPL      Filename template ({id}, {title}, {height}, {date})\n' +
      '  --subtitles                  Include subtitle tracks\n' +
      '  --connections 4|8|12         Per-item worker connections\n' +
      '  --concurrency N              Concurrent batch items (default 1)\n' +
      '  --resume / --no-resume       Enable (default) or disable checkpoint resume\n' +
      '  --json-progress              Emit structured JSONL progress every 2s\n' +
      '  --verify                     Run FFprobe post-save verification\n' +
      '  --duration-tolerance SEC     Allowed duration delta for --verify (default 1.0)\n' +
      '  --sandbox                    Force isolated temp sandbox (forbids reading user settings)\n' +
      '  --sandbox-dir DIR            Force isolated sandbox inside a specific temp directory\n' +
      'Exit codes: 0=ok, 1=error, 2=invalid-args, 3=no-space, 4=auth/challenge, 5=media-unavailable\n',
    );
  } else {
    configureSandboxFromArgv(process.argv);
    if (values.out) {
      const resolvedOut = path.resolve(values.out);
      process.env.OUT_DIR = resolvedOut;
      process.env.VIDEOSAVE_FORCE_OUT_DIR = resolvedOut;
    }
    configureMediaProxy();
    if (!positionals.length) throw new downloads.ApiError('INVALID_ITEMS', 'Provide at least one HTTP(S) media or page URL.');
    const urls = positionals.map(mediaUrl);
    const cookie = values['cookie-file'] ? await loadCookieHeader(values['cookie-file'], urls) : undefined;
    const quality = parseCliQuality(values.quality);
    let parsedHeadersJson = {};
    if (values['headers-json']) {
      try { parsedHeadersJson = JSON.parse(values['headers-json']); }
      catch { throw new downloads.ApiError('INVALID_HEADERS', '--headers-json must be a valid JSON object'); }
    }
    const cliHeaders = {};
    if (values.ua) cliHeaders['User-Agent'] = values.ua;
    if (values.referer) cliHeaders.Referer = values.referer;
    if (values.origin) cliHeaders.Origin = values.origin;
    const headers = mergeMediaHeaders(parsedHeadersJson, cliHeaders);

    const { id } = downloads.queueBatch({
      items: urls.map(url => ({
        kind: values.page || platformVideo(url) ? 'page' : 'stream',
        url: url.href,
        ...(quality !== undefined && { quality }),
        ...(values.format && { format: values.format }),
        ...(values.mode && { mode: values.mode }),
        ...(values.subtitles && { subtitles: true }),
        ...(values['conflict-action'] && { conflictAction: values['conflict-action'] }),
        ...(values['filename-template'] && { filenameTemplate: values['filename-template'] }),
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
    const pollMs = values['json-progress'] ? 2000 : 1000;
    let result;
    do {
      result = await downloads.waitForBatch({ id, timeoutMs: pollMs }, observer.signal);
      const first = result.items[0];
      emit({
        id,
        status: result.status,
        actualOutDir: result.outDir ?? downloads.getSettings().settings.outDir,
        ...(first?.segments && { done: first.segments.completed, total: first.segments.total }),
        ...(first && { speed: first.speed, phase: first.phase ?? first.status }),
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
          skipped: Boolean(item.skipped || item.alreadySaved),
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

    if (values.verify && result.status === 'done') {
      const tol = values['duration-tolerance'] !== undefined ? Number(values['duration-tolerance']) : 1.0;
      const verified = await downloads.verifyBatchFiles(id, AbortSignal.timeout(25_000), { durationToleranceSec: tol });
      emit({ id, event: 'verified', ok: verified.ok, items: verified.items.map(i => ({ index: i.idx, verification: i.verification })) });
      process.exitCode = verified.ok ? 0 : 1;
    } else if (result.status === 'done') {
      process.exitCode = 0;
    } else {
      const firstErr = result.items.find(i => i.errorCode)?.errorCode ?? result.lastError?.code;
      process.exitCode = exitCodeForError(firstErr);
    }
  }
} catch (error) {
  const details = downloads.errorDetails(error);
  emit({ status: 'failed', ...details });
  process.exitCode = exitCodeForError(error?.code ?? details.code);
} finally {
  downloads.shutdown();
}
