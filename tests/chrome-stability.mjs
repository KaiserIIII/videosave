import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable, withChromiumExtension } from './compatibility-browsers.mjs';
import { compatibilityCases, serveFixtures } from './compatibility-fixtures.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const rounds = Math.max(1, Number(option('rounds') ?? 6));
const browser = option('browser') ?? 'chrome';
const outputPath = option('output');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

if (!executable(browser)) {
  throw new Error(`Browser executable unavailable: ${browser}`);
}

const targetCases = compatibilityCases.filter(c => ['mp4', 'network-hls'].includes(c.id));
const results = [];

for (let round = 1; round <= rounds; round++) {
  const sandbox = await createTestSandbox(`stability-${browser}-r${round}`);
  const fixtures = await serveFixtures(sandbox.media, targetCases);
  const started = performance.now();
  let telemetry = null;
  try {
    await withChromiumExtension(browser, repoRoot, sandbox.downloads, async driver => {
      for (const entry of targetCases) {
        await driver.navigate(fixtures.page(entry));
        let urls = [];
        await driver.popup(async evalPopup => {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            urls = await evalPopup("[...document.querySelectorAll('#media > li[data-url]')].map(n => n.dataset.url)");
            if (Array.isArray(urls) && urls.length > 0) break;
            await new Promise(r => setTimeout(r, 150));
          }
        });
        assert.ok(Array.isArray(urls) && urls.length > 0, `Round ${round}: failed to detect media for ${entry.id}`);
      }
      results.push({
        round,
        passed: true,
        browserVersion: driver.version,
        elapsedMs: Math.round(performance.now() - started),
        launchTelemetry: driver.launchTelemetry ?? telemetry,
      });
    }, { onLaunchTelemetry: t => { telemetry = t; } });
  } catch (error) {
    results.push({
      round,
      passed: false,
      stage: error?.stage ?? 'UNKNOWN',
      error: error?.message ?? String(error),
      elapsedMs: Math.round(performance.now() - started),
      launchTelemetry: error?.launchTelemetry ?? telemetry,
    });
  } finally {
    await fixtures.close();
    await sandbox.cleanup();
  }
}

const passed = results.filter(r => r.passed).length;
const totalRetries = results.reduce((sum, r) => sum + (r.launchTelemetry?.retries ?? 0), 0);
const summary = {
  recordedAt: new Date().toISOString(),
  browser,
  platform: process.platform,
  rounds,
  passed,
  failed: rounds - passed,
  totalStartupRetries: totalRetries,
  medianRoundMs: results.map(r => r.elapsedMs).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? null,
  results,
};

if (outputPath) {
  await writeFile(path.resolve(outputPath), JSON.stringify(summary, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify(summary, null, 2));
if (passed !== rounds) process.exitCode = 1;
