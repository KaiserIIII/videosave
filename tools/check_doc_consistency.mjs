#!/usr/bin/env node
/**
 * Automated documentation, version, packaging, privacy, and test-data consistency verifier.
 * Fails CI if README / docs / packaging / site drift from verified structured JSON reports
 * or contain unsubstantiated marketing claims, UTF-8 BOMs, or personal path leaks.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];
const assertCond = (ok, msg) => { if (!ok) errors.push(msg); };

const manifest = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const version = manifest.version_name ?? manifest.version;

// 1. Version alignment across AndroidManifest, CHANGELOG, packaging, README, install
const androidManifest = readFileSync(path.join(root, 'android/AndroidManifest.xml'), 'utf8');
assertCond(androidManifest.includes(`android:versionName="${version}"`), `AndroidManifest.xml versionName must match ${version}`);

const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
assertCond(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(changelog), `CHANGELOG.md must contain section ## ${version}`);

for (const rel of [
  'packaging/winget/KaiserIIII.VideoSave.yaml',
  'packaging/scoop/videosave.json',
  'packaging/homebrew/videosave.rb',
  'packaging/mcp-registry/server.json',
]) {
  const buf = readFileSync(path.join(root, rel));
  assertCond(!(buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${rel} must not contain UTF-8 BOM`);
  assertCond(buf.toString('utf8').includes(version), `${rel} must reference version ${version}`);
}

const readmeEn = readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeZh = readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
const installDoc = readFileSync(path.join(root, 'docs/install.md'), 'utf8');
const consoleHtml = readFileSync(path.join(root, 'tools/console/index.html'), 'utf8');
assertCond(readmeEn.includes(version), `README.md must reference ${version}`);
assertCond(readmeZh.includes(version), `README.zh-CN.md must reference ${version}`);
assertCond(installDoc.includes(version), `docs/install.md must reference ${version}`);
assertCond(consoleHtml.includes(`v${version}`), `tools/console/index.html must reference v${version}`);

// 2. Verify README stats match real verified JSON reports (preventing drift like old IA 640x360 vs 1280x720)
const platReportPath = path.join(root, `docs/compatibility-data/v${version}-platforms-public.json`);
if (existsSync(platReportPath)) {
  const plat = JSON.parse(readFileSync(platReportPath, 'utf8'));
  const ia = (plat.results || []).find(r => r.platform === 'internet-archive');
  if (ia?.verification?.width && ia?.verification?.height) {
    const dim = `${ia.verification.width}×${ia.verification.height}`;
    assertCond(readmeEn.includes(dim), `README.md Internet Archive dimension must match report (${dim})`);
  }
}

const biliReportPath = path.join(root, `docs/compatibility-data/v${version}-bilibili-public.json`);
if (existsSync(biliReportPath)) {
  const bili = JSON.parse(readFileSync(biliReportPath, 'utf8'));
  for (const row of (bili.results || [])) {
    if (row.downloadStatus === 'verified' && row.requestedMode !== 'audio' && row.qualityNegotiation) {
      assertCond(
        row.qualityNegotiation.actualQuality?.height === row.verification?.height,
        `Bilibili report ${row.id}: actualQuality.height (${row.qualityNegotiation.actualQuality?.height}) must equal verification.height (${row.verification?.height})`,
      );
      assertCond(
        row.qualityNegotiation.selectedQuality?.height === row.verification?.height || row.qualityNegotiation.fallbackApplied === true,
        `Bilibili report ${row.id}: if selectedHeight != actualHeight, fallbackApplied MUST be true`,
      );
    }
  }
}

// 3. Enforce honest boundaries: no forbidden exaggerated claims, DSH-12 remains pending user verification
const forbiddenClaims = [/全面超越\s*IDM/i, /全球最快/i, /100%\s*全网兼容/i];
for (const rel of ['README.md', 'README.zh-CN.md', 'site/index.html', 'site/app.js', 'docs/launch-kit.md']) {
  const full = path.join(root, rel);
  if (!existsSync(full)) continue;
  const txt = readFileSync(full, 'utf8');
  for (const re of forbiddenClaims) {
    assertCond(!re.test(txt), `${rel} contains forbidden exaggerated claim matching ${re}`);
  }
}

const tracker = readFileSync(path.join(root, 'docs/dsh-feedback-tracker.md'), 'utf8');
assertCond(tracker.includes('部分修复') && tracker.includes('待独立用户验收'), 'DSH-12 must remain transparently marked pending independent user verification');

// 4. Privacy leak scan across docs, site, packaging, tools
const leakPattern = new RegExp(['Users[\\\\/]17271', 'OneDrive', 'Videos[\\\\/]片'].join('|'), 'i');
function scanDir(relDir) {
  const fullDir = path.join(root, relDir);
  if (!existsSync(fullDir)) return;
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '_site'].includes(entry.name)) continue;
      scanDir(rel);
    } else if (/\.(md|json|mjs|js|html|css|yaml|yml|rb|java|py|sh|ps1|txt)$/i.test(entry.name)) {
      if (rel.replace(/\\/g, '/') === 'tools/check_doc_consistency.mjs') continue;
      const txt = readFileSync(path.join(root, rel), 'utf8');
      if (leakPattern.test(txt)) errors.push(`Privacy path leak detected in ${rel}`);
    }
  }
}
for (const d of ['docs', 'site', 'packaging', 'tools', 'android', 'extension']) scanDir(d);

if (errors.length) {
  console.error('DOC_CONSISTENCY_FAILED:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log(`DOC_CONSISTENCY_OK version=${version}`);
