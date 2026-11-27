import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PINNED_COMPONENTS = Object.freeze({
  node: {
    name: 'Node.js',
    version: '24.22.3',
    minMajor: 24,
    license: 'MIT',
    source: 'https://github.com/nodejs/node',
    commit: 'e63cab040c09d43ceef8cb35508c40044614e906',
    winX64Url: 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.7z',
    winX64Sha256: 'e15e37b60cca7eeadad76e52515a19729c91fe7f4ed3dc3299ac66ce9dc940f7',
  },
  ffmpeg: {
    name: 'FFmpeg',
    version: '8.1.2',
    license: 'GPL-3.0-or-later',
    source: 'https://github.com/FFmpeg/FFmpeg',
    commit: '38b88335f99e76ed89ff3c93f877fdefce736c13',
    winX64Url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.7z',
    winX64Sha256: 'e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6',
  },
  ytdlp: {
    name: 'yt-dlp',
    version: '2026.11.23',
    license: 'Unlicense / GPL-3.0-or-later (Windows standalone)',
    source: 'https://github.com/yt-dlp/yt-dlp',
    commit: '6f73a8d1664a58cdef8c25f01ffb5ab9cf730408',
    winX64Url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp.exe',
    winX64Sha256: '622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c',
  },
});

export function managedToolsRoot() {
  if (process.env.VIDEOSAVE_TOOLS_DIR) return path.resolve(process.env.VIDEOSAVE_TOOLS_DIR);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'VideoSave', 'tools');
  }
  return path.join(os.homedir(), '.local', 'share', 'videosave', 'tools');
}

export function portableToolsRoot() {
  return path.join(fileURLToPath(new URL('..', import.meta.url)), '.local-tools');
}

function findInToolRoots(subpaths) {
  for (const root of [portableToolsRoot(), managedToolsRoot()]) {
    for (const rel of subpaths) {
      const full = path.join(root, rel);
      if (existsSync(full)) return { path: full, origin: root === portableToolsRoot() ? 'portable-bundle' : 'managed-cache' };
    }
    // Check versioned subdirectories (e.g. yt-dlp-2026.11.23/yt-dlp.exe or ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe)
    if (existsSync(root)) {
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          for (const rel of subpaths) {
            const nested = path.join(root, entry.name, rel);
            if (existsSync(nested)) return { path: nested, origin: root === portableToolsRoot() ? 'portable-bundle' : 'managed-cache' };
          }
        }
      } catch {}
    }
  }
  return null;
}

export function locateManagedBinary(kind) {
  const isWin = process.platform === 'win32';
  if (kind === 'ffmpeg') {
    if (process.env.FFMPEG_BIN && existsSync(process.env.FFMPEG_BIN)) return { path: process.env.FFMPEG_BIN, origin: 'env' };
    return findInToolRoots(isWin ? ['bin/ffmpeg.exe', 'ffmpeg.exe'] : ['bin/ffmpeg', 'ffmpeg']);
  }
  if (kind === 'ffprobe') {
    if (process.env.FFPROBE_BIN && existsSync(process.env.FFPROBE_BIN)) return { path: process.env.FFPROBE_BIN, origin: 'env' };
    return findInToolRoots(isWin ? ['bin/ffprobe.exe', 'ffprobe.exe'] : ['bin/ffprobe', 'ffprobe']);
  }
  if (kind === 'yt-dlp') {
    if (process.env.YTDLP_BIN) {
      return existsSync(process.env.YTDLP_BIN) ? { path: process.env.YTDLP_BIN, origin: 'env' } : null;
    }
    return findInToolRoots(isWin ? ['yt-dlp.exe'] : ['yt-dlp']);
  }
  if (kind === 'streamlink') {
    if (process.env.STREAMLINK_BIN) {
      return existsSync(process.env.STREAMLINK_BIN) ? { path: process.env.STREAMLINK_BIN, origin: 'env' } : null;
    }
    return findInToolRoots(isWin ? ['streamlink.exe', 'bin/streamlink.exe'] : ['streamlink', 'bin/streamlink']);
  }
  return null;
}

async function probeBinaryVersion(bin, args = ['--version']) {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 5000, windowsHide: true });
    return stdout.trim().split(/\r?\n/)[0]?.slice(0, 120) || 'unknown';
  } catch {
    return null;
  }
}

export async function getRuntimeHealth() {
  const isWin = process.platform === 'win32';
  const ffmpegFound = locateManagedBinary('ffmpeg') ?? { path: isWin ? 'ffmpeg.exe' : 'ffmpeg', origin: 'system-path' };
  const ffprobeFound = locateManagedBinary('ffprobe') ?? { path: isWin ? 'ffprobe.exe' : 'ffprobe', origin: 'system-path' };
  const ytdlpFound = locateManagedBinary('yt-dlp');
  const streamlinkFound = locateManagedBinary('streamlink');

  const [ffmpegVer, ffprobeVer, ytdlpVer, streamlinkVer] = await Promise.all([
    probeBinaryVersion(ffmpegFound.path, ['-version']),
    probeBinaryVersion(ffprobeFound.path, ['-version']),
    ytdlpFound ? probeBinaryVersion(ytdlpFound.path, ['--version']) : Promise.resolve(null),
    streamlinkFound ? probeBinaryVersion(streamlinkFound.path, ['--version']) : Promise.resolve(null),
  ]);

  const { detectAvailableBrowsers } = await import('./edge-session.mjs');
  const browsers = detectAvailableBrowsers();
  const nodeMajor = Number.parseInt(process.versions.node, 10);
  const distributionMode = existsSync(path.join(portableToolsRoot(), 'ffmpeg-8.1.2-essentials_build', 'bin', 'ffmpeg.exe')) ||
    existsSync(path.join(portableToolsRoot(), 'bin', 'ffmpeg.exe'))
    ? 'portable-offline'
    : 'standard-managed';

  const components = {
    node: {
      status: nodeMajor >= 24 ? 'ready' : 'incompatible',
      version: process.version,
      pinnedVersion: PINNED_COMPONENTS.node.version,
      source: 'runtime',
      license: PINNED_COMPONENTS.node.license,
    },
    ffmpeg: {
      status: ffmpegVer ? 'ready' : 'missing',
      version: ffmpegVer,
      pinnedVersion: PINNED_COMPONENTS.ffmpeg.version,
      source: ffmpegFound.origin,
      license: PINNED_COMPONENTS.ffmpeg.license,
    },
    ffprobe: {
      status: ffprobeVer ? 'ready' : 'missing',
      version: ffprobeVer,
      pinnedVersion: PINNED_COMPONENTS.ffmpeg.version,
      source: ffprobeFound.origin,
      license: PINNED_COMPONENTS.ffmpeg.license,
    },
    ytdlp: {
      status: ytdlpVer ? 'ready' : ytdlpFound ? 'incompatible' : 'missing',
      version: ytdlpVer,
      pinnedVersion: PINNED_COMPONENTS.ytdlp.version,
      source: ytdlpFound?.origin ?? null,
      license: PINNED_COMPONENTS.ytdlp.license,
    },
    streamlink: {
      status: streamlinkVer ? 'ready' : 'optional-not-installed',
      version: streamlinkVer,
      source: streamlinkFound?.origin ?? null,
    },
  };

  const platforms = {
    bilibili: {
      status: components.ytdlp.status === 'ready' && components.ffmpeg.status === 'ready' ? 'ready' : 'component-missing',
      requiredComponents: ['yt-dlp', 'ffmpeg'],
      hint: components.ytdlp.status === 'ready'
        ? 'Bilibili public video direct download ready.'
        : 'Run Start VideoSave.cmd or setup-platform-downloads.mjs to install pinned yt-dlp automatically.',
    },
    youtube: {
      status: components.ytdlp.status === 'ready' && components.ffmpeg.status === 'ready' && nodeMajor >= 24 ? 'ready' : 'component-missing',
      requiredComponents: ['yt-dlp', 'ffmpeg', 'node>=24'],
      hint: components.ytdlp.status === 'ready'
        ? 'YouTube public video direct download ready.'
        : 'Run Start VideoSave.cmd or setup-platform-downloads.mjs to install pinned yt-dlp automatically.',
    },
  };

  return {
    platform: process.platform,
    arch: process.arch,
    distributionMode,
    managedToolsDir: managedToolsRoot(),
    browsers: Object.keys(browsers),
    components,
    platforms,
    ready: components.node.status === 'ready' && components.ffmpeg.status === 'ready' && components.ffprobe.status === 'ready',
  };
}
