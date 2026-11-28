import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ApiError, runMedia } from './media-source.mjs';
import { locateManagedBinary } from './runtime-manager.mjs';

const execFileAsync = promisify(execFile);

export function streamlinkBinary() {
  const configured = process.env.STREAMLINK_BIN;
  if (configured && existsSync(configured)) return path.resolve(configured);
  return locateManagedBinary('streamlink')?.path ?? null;
}

export function streamlinkAvailable() {
  return Boolean(streamlinkBinary());
}

export async function getStreamlinkHealth() {
  const bin = streamlinkBinary();
  if (!bin) return { available: false, path: null, version: null };
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000, windowsHide: true });
    return { available: true, path: bin, version: stdout.trim().split(/\r?\n/)[0] || 'unknown' };
  } catch {
    return { available: false, path: bin, version: null };
  }
}

/**
 * Optional, explicitly configured Streamlink fallback for authorized public streams.
 * Never attempts to bypass HTTP 403/401/DRM or anti-bot protections.
 */
export async function stageWithStreamlink(sourceUrl, destinationFile, signal, { headers = {}, quality = 'best' } = {}) {
  const bin = streamlinkBinary();
  if (!bin) {
    throw new ApiError('STREAMLINK_UNAVAILABLE', '未配置本机 STREAMLINK_BIN', 503);
  }
  const url = sourceUrl instanceof URL ? sourceUrl.href : String(sourceUrl);
  const qualityArg = typeof quality === 'number' ? `${quality}p,best` : (quality === 'lowest' ? 'worst' : 'best');
  const headerArgs = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (['Referer', 'Origin', 'User-Agent'].includes(name) && typeof value === 'string' && value.trim()) {
      headerArgs.push('--http-header', `${name}=${value.trim()}`);
    }
  }
  await runMedia(
    bin,
    ['--stdout', '--retry-streams', '1', '--retry-open', '1', ...headerArgs, '-o', destinationFile, '--', url, qualityArg],
    signal,
    undefined,
    {
      onFailure: ({ stderr }) => {
        const status = Number(/\b(401|402|403|410|451)\b/.exec(stderr)?.[1]);
        if ([401, 402, 403, 451].includes(status)) {
          return new ApiError('MEDIA_ACCESS_RESTRICTED', `Streamlink 收到服务器拒绝访问（HTTP ${status}）`, 403, { status, engine: 'streamlink' });
        }
        return new ApiError('STREAMLINK_FAILED', 'Streamlink 无法读取该公开媒体流', 502, { engine: 'streamlink' });
      },
    },
  );
  return destinationFile;
}
