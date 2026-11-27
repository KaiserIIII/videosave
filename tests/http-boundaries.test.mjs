import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../tools/server.mjs',import.meta.url));
const extension = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const maxBody = 1024 * 1024;

test('companion HTTP boundary rejects invalid requests and keeps failures private', {timeout:20_000}, async t => {
  const state = await mkdtemp(path.join(os.tmpdir(),'videosave-http-test-'));
  const token = randomBytes(24).toString('base64url');
  const controller = new AbortController();
  const child = spawn(process.execPath,[entry],{env:{...process.env,PORT:'0',MEDIA_TOOLKIT_TOKEN:token,
    MEDIA_TOOLKIT_SETTINGS:path.join(state,'settings.sqlite'),OUT_DIR:state},
    signal:controller.signal,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.on('error', () => {});
  const closed = once(child,'close').catch(() => {});
  let startup = '';
  try {
    const lines = createInterface({input:child.stdout,signal:t.signal});
    child.stdout.setEncoding('utf8').on('data', chunk => { startup += chunk; });
    const ready = await once(lines,'line',{signal:t.signal});
    const endpoint = URL.parse(ready[0].match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    assert.ok(endpoint);
    const send = (route, {authorized = true, method = 'GET', headers, data, endRequest = true} = {}) => new Promise((resolve,reject) => {
      const pending = request({
        hostname:endpoint.hostname,port:endpoint.port,path:route,method,agent:false,signal:t.signal,
        headers:{...(authorized && {Authorization:'Bearer ' + token}),...headers},
      }, response => {
        const chunks = [];
        response.setEncoding('utf8');
        response.on('data',chunk => chunks.push(chunk));
        response.on('error',reject);
        response.on('end',() => resolve({status:response.statusCode,headers:response.headers,text:chunks.join('')}));
      });
      pending.on('error',reject);
      if (endRequest) pending.end(data);
      else if (data) pending.write(data);
      else pending.flushHeaders();
    });
    const code = response => JSON.parse(response.text).error.code;

    const health = await send('/api/health');
    assert.equal(health.status,200);
    assert.equal(JSON.parse(health.text).ok,true);
    assert.equal(health.headers['cache-control'],'no-store');
    const unpaired = await send('/api/health',{authorized:false});
    assert.equal(unpaired.status,401);
    assert.equal(code(unpaired),'UNAUTHORIZED');
    const deniedHost = await send('/api/health',{headers:{Host:'media.example.test'}});
    assert.equal(deniedHost.status,403);
    assert.equal(code(deniedHost),'FORBIDDEN_HOST');
    const deniedOrigin = await send('/api/health',{headers:{Origin:'https://media.example.test'}});
    assert.equal(deniedOrigin.status,403);
    assert.equal(code(deniedOrigin),'FORBIDDEN_ORIGIN');
    assert.equal(deniedOrigin.headers['access-control-allow-origin'],undefined);

    const preflight = await send('/api/health',{authorized:false,method:'OPTIONS',
      headers:{Origin:extension,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers['access-control-allow-origin'],extension);
    assert.equal(preflight.headers.vary,'Origin');
    assert.equal((await send('/api/health',{authorized:false,headers:{Origin:extension}})).status,401);

    const route = '/api/settings';
    const json = {'Content-Type':'application/json'};
    const mediaType = await send(route,{method:'POST',headers:{'Content-Type':'text/plain'},data:'{}'});
    assert.equal(mediaType.status,415);
    const malformed = await send(route,{method:'POST',headers:json,data:'{'});
    assert.equal(malformed.status,400);
    assert.equal(code(malformed),'INVALID_JSON');
    const oversized = ' '.repeat(maxBody + 1);
    // An oversized declared body must be rejected before any upload is sent.
    const size = await send(route,{method:'POST',headers:{...json,'Content-Length':oversized.length},endRequest:false});
    assert.equal(size.status,413);
    assert.equal(code(size),'BODY_TOO_LARGE');
    assert.equal(size.headers.connection,'close');
    const sizeChunked = await send(route,{method:'POST',headers:{...json,'Transfer-Encoding':'chunked'},data:oversized,endRequest:false});
    assert.equal(sizeChunked.status,413);
    assert.equal(code(sizeChunked),'BODY_TOO_LARGE');
    const requestTarget = await send(endpoint.href + 'api/health');
    assert.equal(requestTarget.status,400);
    assert.equal(code(requestTarget),'INVALID_REQUEST_TARGET');
    assert.equal(health.headers['x-content-type-options'],'nosniff');

    for (const response of [health,unpaired,deniedHost,deniedOrigin,mediaType,malformed,size,sizeChunked,requestTarget]) {
      assert.equal(response.text.includes(token),false);
    }
    assert.equal(startup.includes(token),false);
    assert.equal((await send('/api/health')).status,200);
  } finally {
    controller.abort();
    await closed;
    await rm(state,{recursive:true,force:true});
  }
});

test('a cancelled probe request never acquires a browser or queue slot', async () => {
  const {probe} = await import('../tools/media-downloads.mjs');
  const reason = new Error('Caller disconnected');
  await assert.rejects(probe({url:'http://127.0.0.1:1/test',waitForMediaMs:100},AbortSignal.abort(reason)),
    error => error === reason);
});
