import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const release = '2026.11.23';
const commit = '6f73a8d1664a58cdef8c25f01ffb5ab9cf730408';
const sha256 = '622ed48023cac1daa52a3bf3a6ac38f03514de214b5f0fa069389fd0f6d17e5c';
const source = 'https://github.com/yt-dlp/yt-dlp';
const directory = new URL('../.local-tools/', import.meta.url);
const executable = new URL('yt-dlp.exe', directory);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This installer requires Windows x64. Use YTDLP_BIN with an executable for your system.');
}
await mkdir(directory, {recursive:true});
const current = await readFile(executable).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (current && digest(current) !== sha256) throw new Error('Unexpected yt-dlp.exe in .local-tools. Set YTDLP_BIN to use your own copy.');
if (!current) {
  const temp = await mkdtemp(fileURLToPath(new URL('download-', directory)));
  const file = path.join(temp, 'yt-dlp.exe');
  try {
    await promisify(execFile)('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120',
      '--output', file, source + '/releases/download/' + release + '/yt-dlp.exe'], {windowsHide:true});
    if (digest(await readFile(file)) !== sha256) throw new Error('yt-dlp SHA-256 check failed');
    await rename(file, executable);
  } finally {
    await rm(file, {force:true});
    await rmdir(temp);
  }
}
const record = new URL('yt-dlp-install.json', directory);
try {
  await writeFile(record, JSON.stringify({source,release,commit,license:'GPL-3.0-or-later (Windows executable)',
    sha256,installedAt:new Date().toISOString()}, null, 2) + '\n', {flag:'wx'});
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
console.log('yt-dlp ' + release + ' verified at ' + fileURLToPath(executable));
