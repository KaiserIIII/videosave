import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import * as media from '../extension/media.mjs';
import * as downloads from '../tools/media-downloads.mjs';

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
