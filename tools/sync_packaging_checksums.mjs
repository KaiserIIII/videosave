#!/usr/bin/env node
/**
 * Synchronize and verify BOM-free Winget, Scoop, Homebrew, and MCP Registry manifests
 * against dist/SHA256SUMS.txt (or a custom --sums=<path> file).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check');
const sumsArg = process.argv.find(a => a.startsWith('--sums='))?.slice('--sums='.length);
const sumsPath = path.resolve(root, sumsArg || 'dist/SHA256SUMS.txt');

const manifest = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const version = manifest.version_name ?? manifest.version;

const sumsText = readFileSync(sumsPath, 'utf8');
const sums = new Map();
for (const line of sumsText.split(/\r?\n/)) {
  const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m) sums.set(m[2].trim(), m[1].toLowerCase());
}

const zipName = `VideoSave-${version}.zip`;
const unixName = `VideoSave-${version}-unix.tar.gz`;
const setupName = `VideoSave-${version}-Setup.exe`;
const zipSha = sums.get(zipName);
const unixSha = sums.get(unixName);
const setupSha = sums.get(setupName);
if (!zipSha || !unixSha) {
  console.error(`Missing expected checksums in ${sumsPath}: ${zipName}=${zipSha}, ${unixName}=${unixSha}`);
  process.exit(1);
}

const targets = [
  {
    rel: 'packaging/winget/KaiserIIII.VideoSave.yaml',
    render: prev => prev
      .replace(/PackageVersion:\s*\S+/g, `PackageVersion: ${version}`)
      .replace(/^(\s*-\s+RelativeFilePath:[ \t]*)VideoSave-[^\\\r\n]+\\Start VideoSave\.cmd[ \t]*$/m,
        (_, field) => `${field}VideoSave-${version}\\Start VideoSave.cmd`)
      .replace(/\/releases\/download\/v[^/]+\/VideoSave-[^/\s]+\.zip/g, `/releases/download/v${version}/${zipName}`)
      .replace(/InstallerSha256:\s*[0-9a-fA-F]{64}/g, `InstallerSha256: ${zipSha.toUpperCase()}`)
      .replace(/ReleaseNotesUrl:\s*\S+/g, `ReleaseNotesUrl: https://github.com/KaiserIIII/videosave/releases/tag/v${version}`),
  },
  ...(setupSha ? [{
    rel: 'packaging/winget/setup/KaiserIIII.VideoSave.yaml',
    render: prev => prev
      .replace(/PackageVersion:\s*\S+/g, `PackageVersion: ${version}`)
      .replace(/\/releases\/download\/v[^/]+\/VideoSave-[^/\s]+-Setup\.exe/g, `/releases/download/v${version}/${setupName}`)
      .replace(/InstallerSha256:\s*[0-9a-fA-F]{64}/g, `InstallerSha256: ${setupSha.toUpperCase()}`)
      .replace(/ReleaseNotesUrl:\s*\S+/g, `ReleaseNotesUrl: https://github.com/KaiserIIII/videosave/releases/tag/v${version}`),
  }] : []),
  {
    rel: 'packaging/scoop/videosave.json',
    render: prev => {
      const obj = JSON.parse(prev);
      obj.version = version;
      obj.url = `https://github.com/KaiserIIII/videosave/releases/download/v${version}/${zipName}`;
      obj.hash = zipSha;
      obj.extract_dir = `VideoSave-${version}`;
      return JSON.stringify(obj, null, 2) + '\n';
    },
  },
  {
    rel: 'packaging/homebrew/videosave.rb',
    render: prev => prev
      .replace(/url\s+"https:\/\/github\.com\/KaiserIIII\/videosave\/releases\/download\/v[^"]+"/g,
        `url "https://github.com/KaiserIIII/videosave/releases/download/v${version}/${unixName}"`)
      .replace(/sha256\s+"[0-9a-fA-F]{64}"/g, `sha256 "${unixSha}"`)
      .replace(/version\s+"[^"]+"/g, `version "${version}"`),
  },
];

let drifted = false;
for (const t of targets) {
  const full = path.join(root, t.rel);
  const rawBuf = readFileSync(full);
  const hasBom = rawBuf.length >= 3 && rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf;
  const current = (hasBom ? rawBuf.subarray(3) : rawBuf).toString('utf8').replace(/\r\n/g, '\n');
  const next = t.render(current).replace(/\r\n/g, '\n');
  if (hasBom || current !== next) {
    if (checkOnly) {
      console.error(`DRIFT: ${t.rel} (hasBom=${hasBom})`);
      drifted = true;
    } else {
      writeFileSync(full, next, 'utf8');
      console.log(`SYNCED: ${t.rel} (BOM-free, v${version})`);
    }
  } else {
    console.log(`OK: ${t.rel}`);
  }
}

if (checkOnly && drifted) process.exit(1);
