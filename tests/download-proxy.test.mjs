import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {connect} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('uses the configured proxy for media while keeping loopback requests local', async t => {
  if (!http.setGlobalProxyFromEnv) return t.skip('Requires Node.js with the native proxy API');
  const seen = [];
  const tunnels = [];
  const localRanges = [];
  const respondToMedia = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`).href;
    seen.push([req.method, url, req.headers.host, req.headers.range]);
    res.writeHead(200, {'content-length':5, connection:'close'}).end('media');
  };
  const tunnelTarget = http.createServer(respondToMedia);
  const proxy = http.createServer(respondToMedia);
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url);
    const upstream = connect(tunnelTarget.address().port, '127.0.0.1');
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const local = http.createServer((req, res) => {
    localRanges.push(req.headers.range);
    res.end('local');
  });
  const outsideBypass = http.createServer((req, res) => res.end('direct'));
  for (const [server, host] of [[tunnelTarget,'127.0.0.1'],[proxy,'127.0.0.1'],[local,'127.0.0.1'],[outsideBypass,'127.0.0.2']]) {
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
  const upstreamHost = 'videosave-proxy.test';
  const fetchUrl = `http://${upstreamHost}/media`;
  const rangeUrl = `http://${upstreamHost}/direct-file`;
  assert.deepEqual(await run({}, fetchUrl, localUrl), ['media', 'local']);
  assert.deepEqual(seen, [['GET', fetchUrl, upstreamHost, undefined]]);
  const tunnelCount = tunnels.length;
  // An invalid proxy must not keep the local MCP and companion from starting.
  assert.deepEqual(await run({HTTP_PROXY:'none'}, localUrl), ['local']);
  // A wildcard must bypass the proxy even for hosts outside the loopback list.
  assert.deepEqual(await run({NO_PROXY:'*'}, `http://127.0.0.2:${outsideBypass.address().port}/media`), ['direct']);
  assert.deepEqual(seen, [['GET', fetchUrl, upstreamHost, undefined]]);
  assert.equal(tunnels.length, tunnelCount);
  assert.deepEqual(await run({}, rangeUrl,
    new URL('/direct-file',localUrl).href), ['media','local']);
  assert.deepEqual(seen, [
    ['GET', fetchUrl, upstreamHost, undefined],
    ['GET', rangeUrl, upstreamHost, 'bytes=0-0'],
  ]);
  assert.deepEqual(localRanges, [undefined, undefined, 'bytes=0-0']);
  for (const authority of tunnels) assert.equal(authority, `${upstreamHost}:80`);
});

test('owner proxy settings apply on restart and keep the three engine configurations aligned', async t => {
  if (!http.setGlobalProxyFromEnv) return t.skip('Requires Node.js with the native proxy API');
  const directory = await mkdtemp(path.join(os.tmpdir(),'videosave-network-policy-'));
  t.after(() => rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const upstream = 'http://videosave-policy.test/network-fixture';
  const mediaAddress = new URL('/fixture.wav',upstream).href;
  const seen = [];
  const localRequests = [];
  const media = Buffer.alloc(44 + 1600);
  media.write('RIFF',0);
  media.writeUInt32LE(media.length - 8,4);
  media.write('WAVEfmt ',8);
  media.writeUInt32LE(16,16);
  media.writeUInt16LE(1,20);
  media.writeUInt16LE(1,22);
  media.writeUInt32LE(8000,24);
  media.writeUInt32LE(16000,28);
  media.writeUInt16LE(2,32);
  media.writeUInt16LE(16,34);
  media.write('data',36);
  media.writeUInt32LE(media.length - 44,40);
  const proxy = http.createServer((req,res) => {
    const url = new URL(req.url,'http://' + req.headers.host);
    if (url.hostname !== 'videosave-policy.test') return res.writeHead(502).end();
    if (url.pathname === '/favicon.ico') return res.writeHead(404).end();
    seen.push(url.href);
    if (url.href === mediaAddress) return res.writeHead(200,{'content-length':media.length,'content-type':'audio/wave'}).end(media);
    res.writeHead(200,{'content-length':5}).end('proxy');
  });
  const tunnelTarget = http.createServer((req,res) => {
    seen.push(new URL(req.url,'http://videosave-policy.test').href);
    res.writeHead(200,{'content-length':5}).end('proxy');
  });
  proxy.on('connect',(req,socket,head) => {
    if (req.url !== 'videosave-policy.test:80') return socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    const upstream = connect(tunnelTarget.address().port,'127.0.0.1');
    socket.on('error',() => upstream.destroy());
    socket.on('close',() => upstream.destroy());
    upstream.on('error',() => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  tunnelTarget.listen(0,'127.0.0.1');
  await once(tunnelTarget,'listening');
  t.after(() => { tunnelTarget.closeAllConnections(); tunnelTarget.close(); });
  proxy.listen(0,'127.0.0.1');
  await once(proxy,'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const address = `http://127.0.0.1:${proxy.address().port}`;
  const local = http.createServer((req,res) => {
    localRequests.push(req.url);
    res.end('direct');
  });
  local.listen(0,'127.0.0.1');
  await once(local,'listening');
  t.after(() => { local.closeAllConnections(); local.close(); });
  const localAddress = 'http://127.0.0.1:' + local.address().port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:https?_proxy|no_proxy|all_proxy|node_use_env_proxy|node_options)$/i.test(key)));
  env.MEDIA_TOOLKIT_SETTINGS = path.join(directory,'settings.sqlite');
  const run = async (code, settings = {}) => {
    const child = spawn(process.execPath,['--input-type=module','-e',code],{
      cwd:fileURLToPath(new URL('../tools/',import.meta.url)),env:{...env,...settings},windowsHide:true,
    });
    const timer = setTimeout(() => child.kill(),25_000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data',chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data',chunk => { stderr += chunk; });
    const [status] = await once(child,'close').finally(() => clearTimeout(timer));
    assert.equal(status,0,stderr);
    return JSON.parse(stdout);
  };
  const setup = 'import * as proxy from "./media-proxy.mjs"; proxy.configureMediaProxy();';
  const update = configuration => 'console.log(JSON.stringify(proxy.networkPreferences(' + JSON.stringify(configuration) + ')));';
  const privateEnvironment = await run(setup + 'console.log(JSON.stringify(await proxy.diagnoseNetwork()));',
    {HTTP_PROXY:address.replace('127.0.0.1','test-user:test-value@127.0.0.1')});
  assert.equal(privateEnvironment.connection,'proxy-reachable');
  assert.doesNotMatch(JSON.stringify(privateEnvironment),/test-user|test-value|127\.0\.0\.1/);
  const configured = await run(setup + update({mode:'http',proxyUrl:address,noProxy:'local.test'}));
  assert.deepEqual(configured.configured,{mode:'http',proxyUrl:address,noProxy:'local.test'});
  assert.equal(configured.effective.mode,'environment');
  assert.equal(configured.restartRequired,true);
  const active = await run(setup + `
    const settings = proxy.networkPreferences();
    const diagnosis = await proxy.diagnoseNetwork();
    const remote = await (await fetch(${JSON.stringify(upstream)})).text();
    const local = await (await fetch(${JSON.stringify(localAddress + '/local')})).text();
    const env = proxy.mediaProcessEnvironment();
    console.log(JSON.stringify({settings,diagnosis,remote,local,args:proxy.browserProxyArgs(),
      childProxy:env.http_proxy,childNoProxy:env.no_proxy}));`);
  assert.equal(active.settings.restartRequired,false);
  assert.equal(active.settings.effective.mode,'http');
  assert.equal(active.diagnosis.connection,'proxy-reachable');
  assert.deepEqual(seen,[upstream]);
  assert.deepEqual(localRequests,['/local']);
  assert.equal(active.remote,'proxy');
  assert.equal(active.local,'direct');
  assert.ok(active.args.includes('--proxy-server=' + address));
  assert.equal(active.childProxy,address);
  assert.ok(active.childNoProxy.split(',').includes('127.0.0.1'));

  if (process.platform === 'win32') {
    const browserAddress = new URL('/browser',upstream).href;
    const engines = await run(setup + `
      const {withChromium,connectCdp} = await import("./edge-session.mjs");
      const {runMedia,FFMPEG} = await import("./media-source.mjs");
      const {spawnSync} = await import("node:child_process");
      const ffmpeg = spawnSync(FFMPEG,["-version"],{stdio:"ignore",windowsHide:true}).status === 0;
      const signal = AbortSignal.timeout(18000);
      if (ffmpeg) await runMedia(FFMPEG,["-hide_banner","-loglevel","error","-i",${JSON.stringify(mediaAddress)},"-f","null","-"],signal);
      await withChromium([],async ({list}) => {
        const target = (await list()).find(row => row.type === "page");
        const page = await connectCdp(target.webSocketDebuggerUrl,signal);
        try { await page.send("Page.navigate",{url:${JSON.stringify(browserAddress)}}); }
        finally { page.close(); }
      },signal);
      console.log(JSON.stringify({ffmpeg}));
    `);
    const expected = [upstream,...(engines.ffmpeg ? [mediaAddress] : []),browserAddress];
    assert.deepEqual(seen,expected);
    seen.splice(1);
  }

  const invalid = await run(setup + `
    const result = [];
    for (const configuration of [
      {mode:'socks5',proxyUrl:'socks5://proxy.invalid:1080'},
      {mode:'http',proxyUrl:'http://secret-user:secret-value@proxy.invalid:8080'},
      {mode:'http',proxyUrl:'http://proxy.invalid:8080/path'},
      {mode:'http',proxyUrl:'http://proxy.invalid:8080',noProxy:'localhost,<-loopback>'},
    ]) {
      try { proxy.networkPreferences(configuration); }
      catch (error) { result.push({code:error.code,message:error.message}); }
    }
    console.log(JSON.stringify(result));`);
  assert.equal(invalid.length,4);
  assert.ok(invalid.every(error => error.code === 'INVALID_NETWORK_SETTINGS'));
  assert.doesNotMatch(JSON.stringify(invalid),/secret|proxy\.invalid/);
  await run(setup + update({mode:'direct'}));
  const direct = await run(setup + `
    let usedProxy = false;
    try { usedProxy = (await fetch(${JSON.stringify(upstream)}, {signal:AbortSignal.timeout(1500)})).ok; } catch {}
    const local = await (await fetch(${JSON.stringify(localAddress + '/still-local')})).text();
    const env = proxy.mediaProcessEnvironment();
    console.log(JSON.stringify({usedProxy,local,args:proxy.browserProxyArgs(),childProxy:env.http_proxy,
      childNoProxy:env.no_proxy,processProxy:process.env.HTTP_PROXY,diagnosis:await proxy.diagnoseNetwork()}));`,
  {HTTP_PROXY:address,HTTPS_PROXY:address,NODE_USE_ENV_PROXY:'1'});
  assert.deepEqual(seen,[upstream]);
  assert.deepEqual(localRequests,['/local','/still-local']);
  assert.equal(direct.usedProxy,false);
  assert.equal(direct.local,'direct');
  assert.deepEqual(direct.args,['--no-proxy-server']);
  assert.equal(direct.childProxy,undefined);
  assert.equal(direct.childNoProxy,'*');
  assert.equal(direct.processProxy,address);
  assert.equal(direct.diagnosis.connection,'direct');
});
