#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const rawTag = process.argv[2] || '';
const version = rawTag.replace(/^v/i, '') || JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).version;
const lines = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const startIdx = lines.findIndex(l => l.trim() === `## ${version}`);
let endIdx = lines.length;
if (startIdx !== -1) {
  const next = lines.slice(startIdx + 1).findIndex(l => /^## \d+\./.test(l.trim()));
  if (next !== -1) endIdx = startIdx + 1 + next;
}
const section = startIdx === -1 ? '' : lines.slice(startIdx + 1, endIdx).join('\n').trim();

const notes = [
  `# VideoSave v${version}`,
  '',
  `Official Website & Live Verification Reports: https://kaiseriiii.github.io/videosave/`,
  '',
  section || `Maintenance & reliability release v${version}. See CHANGELOG.md for details.`,
  '',
  '## Release Assets & Verification',
  '',
  '- **Windows x64**: `VideoSave-' + version + '-Setup.exe` (Graphical installer, no admin rights), `VideoSave-' + version + '-win-x64-offline.zip` (Zero-network offline bundle), `VideoSave-' + version + '.zip` (Lightweight portable)',
  '- **Linux (x64 / ARM64)**: `videosave_' + version + '_all.deb`, `VideoSave-' + version + '-unix.tar.gz` (Auto-bootstraps SHA-256 verified Node 24, FFmpeg 8.1 & yt-dlp)',
  '- **macOS (Apple Silicon / Intel)**: `VideoSave-' + version + '-unix.tar.gz` (Unsigned; right-click → Open on first run)',
  '- **Android 8–16 / HarmonyOS 4.x (Beta)**: `VideoSave-' + version + '-android-debug.apk` (Debug-signed beta until formal release keystore Secrets are configured; HarmonyOS NEXT pure ArkTS not supported)',
  '- **Browser Extensions**: `VideoSave-' + version + '-extension.zip`, `VideoSave-' + version + '-firefox.zip`, `VideoSave-' + version + '-android-dev.zip`',
  '- **Supply Chain**: `SHA256SUMS.txt`, `VideoSave-' + version + '-sbom.cdx.json`, and GitHub Sigstore OIDC Provenance Attestations',
  '',
  '```bash',
  '# Verify checksums:',
  'sha256sum --check SHA256SUMS.txt',
  '# Verify independent GitHub Sigstore build provenance:',
  `gh attestation verify VideoSave-${version}-Setup.exe --repo KaiserIIII/videosave`,
  '```',
  '',
  '> **Transparency Note**: DSH-12 sandbox isolation remains transparently marked pending independent user re-verification. Android APK remains explicitly marked Beta until persistent release signing secrets are provisioned and physical Mate 60 Pro verification is completed.',
].join('\n');

process.stdout.write(notes + '\n');
