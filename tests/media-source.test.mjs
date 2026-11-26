import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMediaError, runMedia } from '../tools/media-source.mjs';

test('classifies FFmpeg diagnostics and redacts paths and signed query strings', () => {
  const examples = [
    ["Protocol 'file' not on whitelist", 'PROTOCOL_NOT_ALLOWED'],
    ['Error opening input: Connection timed out', 'TIMEOUT'],
    ['Output file does not contain any stream', 'NO_VIDEO_TRACK'],
    ['Failed to open segment 4 of playlist', 'SEGMENT_FAILED'],
    ['Error decrypting with crypto: invalid padding', 'DECRYPT_FAILED'],
  ];
  for (const [stderr,code] of examples) assert.equal(classifyMediaError(stderr).code,code);
  const error = classifyMediaError([
    '[https @ 0000] HTTP error 403 Forbidden',
    "Failed to open segment 'https://media.example/video/04.ts?token=secret'",
    "Could not read 'C:\\Users\\Private Folder\\Downloads\\key'",
    "Could not read 'file:///private/files/key'",
  ].join('\n'));
  assert.equal(error.code,'HTTP_STATUS');
  assert.equal(error.detail.status,403);
  assert.equal(error.detail.url,'https://media.example/video/04.ts');
  assert.doesNotMatch(error.detail.stderr,/secret|Private Folder|private\/files/);
});

test('Windows media cancellation waits for the parent and its child to exit', {
  timeout:10_000, skip:process.platform !== 'win32',
}, async () => {
  const code = [
    "const {spawn} = require('node:child_process');",
    "const child = spawn(process.execPath,['-e','setInterval(() => {},1000)'],{windowsHide:true});",
    "child.on('spawn',() => console.log(process.pid + ' ' + child.pid));",
    "setInterval(() => {},1000);",
  ].join('\n');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
  let pids;
  await assert.rejects(runMedia(process.execPath,['-e',code],signal,line => {
    pids = line.split(' ').map(Number);
    controller.abort();
  }),{name:'AbortError'});
  assert.equal(pids?.length,2);
  for (const pid of pids) assert.throws(() => process.kill(pid,0),{code:'ESRCH'});
});
