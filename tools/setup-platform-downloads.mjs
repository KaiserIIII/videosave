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
const projectDirectory = fileURLToPath(new URL('../.local-tools/', import.meta.url));
const cacheArgument = process.argv[2];
const cache = cacheArgument?.startsWith('--cache-dir=') ? cacheArgument.slice('--cache-dir='.length) : null;
if (cacheArgument && (!cache || !path.isAbsolute(cache))) throw new Error('Expected --cache-dir with an absolute path.');
const directory = cache ? path.join(cache,'yt-dlp-' + release) : projectDirectory;
const executable = path.join(directory,'yt-dlp.exe');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This installer requires Windows x64. Use YTDLP_BIN with an executable for your system.');
}
async function verified(file) {
  const bytes = await readFile(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (bytes && digest(bytes) !== sha256) {
    throw new Error('Unexpected yt-dlp.exe at ' + file + '. Move it aside or set YTDLP_BIN to use your own copy.');
  }
  return bytes;
}

const current = await verified(executable);
if (!current) {
  const legacy = cache ? await verified(path.join(projectDirectory,'yt-dlp.exe')) : null;
  await mkdir(directory,{recursive:true});
  const temp = await mkdtemp(path.join(directory,'download-'));
  const file = path.join(temp, 'yt-dlp.exe');
  try {
    if (legacy) await writeFile(file,legacy);
    else {
      await promisify(execFile)('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120',
        '--output', file, source + '/releases/download/' + release + '/yt-dlp.exe'], {windowsHide:true});
      if (!await verified(file)) throw new Error('yt-dlp download did not produce a file');
    }
    try { await rename(file, executable); }
    catch (error) { if (!await verified(executable)) throw error; }
  } finally {
    await rm(file, {force:true});
    await rmdir(temp);
  }
}
const record = path.join(directory,'yt-dlp-install.json');
try {
  await writeFile(record, JSON.stringify({source,release,commit,license:'GPL-3.0-or-later (Windows executable)',
    sha256,installedAt:new Date().toISOString()}, null, 2) + '\n', {flag:'wx'});
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const ascii = character => '\\u' + character.charCodeAt(0).toString(16).padStart(4,'0');
console.log(cache ? JSON.stringify({path:executable}).replace(/[^\x20-\x7e]/g,ascii)
  : 'yt-dlp ' + release + ' verified at ' + executable);
