import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('uses the configured proxy for media while keeping loopback requests local', async t => {
  if (!http.setGlobalProxyFromEnv) return t.skip('Requires Node.js with the native proxy API');
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nmedia');
    });
  });
  proxy.on('request', (req,res) => {
    seen.push(req.url);
    res.writeHead(200,{'content-length':5,'connection':'close'}).end('media');
  });
  const local = http.createServer((req, res) => res.end('local'));
  const outsideBypass = http.createServer((req, res) => res.end('direct'));
  for (const [server, host] of [[proxy,'127.0.0.1'],[local,'127.0.0.1'],[outsideBypass,'127.0.0.2']]) {
    server.listen(0, host);
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const code = [
    'import { configureMediaProxy } from "./media-proxy.mjs";',
    'import { mkdtemp, readFile, rm } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { tmpdir } from "node:os";',
    'import { prefetchRanges } from "./range-prefetch.mjs";',
    'configureMediaProxy();',
    'for (const url of process.argv.slice(1)) {',
    '  if (new URL(url).pathname !== "/direct-file") { console.log(await (await fetch(url)).text()); continue; }',
    '  const folder = await mkdtemp(join(tmpdir(),"videosave-proxy-"));',
    '  try {',
    '    const file = await prefetchRanges(new URL(url),[],folder,AbortSignal.timeout(2000),() => {},{stageFull:true});',
    '    console.log(await readFile(file,"utf8"));',
    '  } finally { await rm(folder,{recursive:true,force:true}); }',
    '}',
  ].join('\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:https?_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(key)));
  env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  const localUrl = `http://127.0.0.1:${local.address().port}/media`;
  const run = async (settings, ...urls) => {
    const child = spawn(process.execPath, ['--input-type=module','-e',code, ...urls], {
      cwd:fileURLToPath(new URL('../tools/', import.meta.url)),
      env:{...env, ...settings}, windowsHide:true,
    });
    const timer = setTimeout(() => child.kill(), 4000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const [exit] = await once(child, 'close').finally(() => clearTimeout(timer));
    assert.equal(exit, 0, stderr);
    return stdout.trim().split(/\r?\n/);
  };
  assert.deepEqual(await run({}, 'http://videosave-proxy.test/media', localUrl), ['media', 'local']);
  assert.deepEqual(seen, ['videosave-proxy.test:80']);
  // An invalid proxy must not keep the local MCP and companion from starting.
  assert.deepEqual(await run({HTTP_PROXY:'none'}, localUrl), ['local']);
  // A wildcard must bypass the proxy even for hosts outside the loopback list.
  assert.deepEqual(await run({NO_PROXY:'*'}, `http://127.0.0.2:${outsideBypass.address().port}/media`), ['direct']);
  assert.deepEqual(seen, ['videosave-proxy.test:80']);
  assert.deepEqual(await run({}, 'http://videosave-proxy.test/direct-file',
    new URL('/direct-file',localUrl).href), ['media','local']);
  assert.ok(seen[1].includes('videosave-proxy.test'));
});
