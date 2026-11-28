import assert from 'node:assert/strict';
import test from 'node:test';
import { platformVideo } from '../extension/media.mjs';
import { isSafeBilibiliMediaUrl, parseBilibiliId, rankCdnMirrors } from '../tools/bilibili-adapter.mjs';
import { getPlatformCapabilitySummary } from '../tools/platform-registry.mjs';
import { computeSlowTailDeadlineMs, parseRetryAfterSeconds, recordHostSuccess, resetRateTelemetry } from '../tools/rate-controller.mjs';

test('v1.3 Bilibili CDN mirror ranking prioritizes stable UPOS mirrors over cosov/mcdn and enforces SSRF guard', () => {
  const ranked = rankCdnMirrors([
    'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/a.m4s',
    'https://xy123.mcdn.bilivideo.cn:8082/upgcxcode/a.m4s',
    'https://127.0.0.1/evil.m4s',
    'http://upos-sz-mirrorcos.bilivideo.com/insecure.m4s',
    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s',
    'https://cn-gd-ct-01-01.bilivideo.com/upgcxcode/a.m4s',
  ]);
  assert.equal(ranked.length, 4, 'Must strip loopback and plain-http URLs');
  assert.ok(ranked[0].includes('upos-sz-mirrorcos.bilivideo.com'), `Expected stable domestic UPOS first, got ${ranked[0]}`);
  assert.ok(ranked[1].includes('cn-gd-ct-01-01.bilivideo.com'), `Expected CN mirror second, got ${ranked[1]}`);
  assert.equal(isSafeBilibiliMediaUrl('https://10.0.0.1/a.m4s'), false);
  assert.equal(isSafeBilibiliMediaUrl('https://[::1]/a.m4s'), false);
  assert.equal(isSafeBilibiliMediaUrl('https://upos-sz-estgoss.bilivideo.com/a.m4s'), true);

  assert.deepEqual(parseBilibiliId('BV1xx411c7mD'), {
    shortLink: false,
    bvid: 'BV1xx411c7mD',
    aid: null,
    partIndex: 1,
    url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  });
  assert.equal(parseBilibiliId('https://www.bilibili.com/video/BV1uT4y1P7CX/?p=2')?.partIndex, 2);
  assert.equal(parseBilibiliId('https://b23.tv/BV1GJ411x7h7')?.shortLink, true);
});

test('v1.3 multi-platform canonicalization and honest capability registry', () => {
  assert.equal(platformVideo('https://archive.org/details/BigBuckBunny_124')?.platform, 'internet-archive');
  assert.equal(platformVideo('https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_Trailer_400p.ogv')?.platform, 'wikimedia');
  assert.equal(platformVideo('https://vimeo.com/76979871')?.platform, 'vimeo');
  const reg = getPlatformCapabilitySummary();
  assert.ok(reg.platforms.some(p => p.id === 'bilibili' && p.status === 'verified'));
  assert.ok(reg.platforms.some(p => p.id === 'drm-subscription-platforms' && p.status === 'unsupported'));
  assert.match(reg.honestyNote, /never upstream extractor totals/i);
});

test('v1.3 adaptive rate controller parses Retry-After (seconds + HTTP-date) and computes slow-tail deadlines', () => {
  resetRateTelemetry();
  assert.equal(parseRetryAfterSeconds('12'), 12);
  assert.equal(parseRetryAfterSeconds('999'), 120, 'Must clamp extreme Retry-After');
  const futureDate = new Date(Date.now() + 8000).toUTCString();
  const parsedSec = parseRetryAfterSeconds(futureDate);
  assert.ok(parsedSec >= 6 && parsedSec <= 10, `Expected ~8s from HTTP-date, got ${parsedSec}`);

  for (let i = 0; i < 4; i++) recordHostSuccess('cdn.example.test', { latencyMs: 1500, bytes: 1024 * 1024 });
  const tailMs = computeSlowTailDeadlineMs('cdn.example.test');
  assert.ok(tailMs >= 5000 && tailMs <= 8000, `Expected adaptive slow-tail deadline ~6000ms, got ${tailMs}`);
});
