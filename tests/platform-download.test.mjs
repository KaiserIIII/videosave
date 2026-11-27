import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import * as media from '../extension/media.mjs';
import * as downloads from '../tools/media-downloads.mjs';
import { platformFailure } from '../tools/platform-downloads.mjs';
import { runMedia } from '../tools/media-source.mjs';

const bili = 'https://www.bilibili.com/video/BV1RrKTeSEcv/?p=2&share_source=copy';
const youtube = 'https://www.youtube.com/watch?v=YE7VzlLtp-4&list=ignored';

test('only canonicalizes single-video links on the supported platforms', () => {
  assert.deepEqual(media.platformVideo(bili), {platform:'bilibili',url:'https://www.bilibili.com/video/BV1RrKTeSEcv/?p=2'});
  assert.deepEqual(media.platformVideo(youtube), {platform:'youtube',url:'https://www.youtube.com/watch?v=YE7VzlLtp-4'});
  assert.equal(media.platformVideo('https://youtu.be/YE7VzlLtp-4')?.url,media.platformVideo(youtube).url);
  assert.equal(media.platformVideo('https://www.youtube.com/shorts/YE7VzlLtp-4')?.url,media.platformVideo(youtube).url);
  assert.equal(media.platformVideo('https://www.youtube.com/playlist?list=abcdef'),null);
  assert.equal(media.platformVideo('https://www.youtube.com.invalid/watch?v=YE7VzlLtp-4'),null);
  assert.equal(media.platformVideo('https://www.bilibili.com:444/video/BV1RrKTeSEcv/'),null);
  assert.equal(media.platformVideo('https://name@www.youtube.com/watch?v=YE7VzlLtp-4'),null);
});

test('built-in platform integration requires explicitly configuring the local extractor', () => {
  const installed = process.platform === 'win32' && existsSync(new URL('../.local-tools/yt-dlp.exe', import.meta.url));
  assert.equal(downloads.platformDownloadsEnabled(), Boolean(process.env.YTDLP_BIN || installed));
});

test('reports sanitized platform transfer restrictions and the original HTTP status', () => {
  for (const status of [403,451,567]) {
    const error = platformFailure('bilibili',{
      stdout:`[download] Got error: HTTP Error ${status}: private data`,
      stderr:'ERROR: download failed at https://example.test/?signature=secret',
    });
    assert.equal(error.code,'MEDIA_ACCESS_RESTRICTED');
    assert.deepEqual(error.detail,{status,platform:'bilibili'});
    assert.doesNotMatch(error.message,/private|secret/);
  }
  const unavailable = platformFailure('bilibili',{failure:new Error('ENOENT'),stderr:''});
  assert.equal(unavailable.code,'PLATFORM_TOOL_REQUIRED');
  assert.equal(platformFailure('youtube',{stderr:'ERROR: Server returned 503'}).code,'PLATFORM_DOWNLOAD_FAILED');
});

test('reads the extractor HTTP status even when progress already consumes stdout', async () => {
  const lines = [];
  await assert.rejects(runMedia(process.execPath,['-e',
    'console.log("[download] Got error: HTTP Error 567: Unknown Status"); process.exitCode = 1;'],
  AbortSignal.timeout(5000),line => lines.push(line),{onFailure:result => platformFailure('bilibili',result)}),
  error => error.code === 'MEDIA_ACCESS_RESTRICTED' && error.detail.status === 567);
  assert.equal(lines.length,1);
});
