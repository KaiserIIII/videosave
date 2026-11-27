import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(),'videosave-batch-controls-'));
process.env.MEDIA_TOOLKIT_SETTINGS = path.join(directory,'settings.sqlite');
process.env.OUT_DIR = path.join(directory,'out');
const {approveGrant, revokeGrant, sitePreferences} = await import('../tools/mcp-control.mjs');
const {invokeManaged, managedTools} = await import('../tools/managed-mcp.mjs');
const {shutdown} = await import('../tools/media-downloads.mjs');
after(async () => {
  shutdown();
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

const clientProfile = () => ({id:randomUUID(),name:'Batch QA',preset:'standard',scopes:['session','read','download']});
const call = (client,name,args) => invokeManaged(client,{name,args});

async function fixture(t, handler) {
  const server = createServer(handler).listen(0,'127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await once(server,'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  sitePreferences(origin,{download:true,concurrency:1});
  return origin;
}

async function approve(client,origin,sources,{singleTask = false} = {}) {
  const {id:authorizationId} = await call(client,'request_site_authorization',{origin});
  approveGrant({id:authorizationId,singleTask,tab:{url:origin + '/watch',title:'Fixture film',
    streams:sources.map(source => typeof source === 'string' ? {url:origin + source,kind:'mp4'} :
      {...source,url:origin + source.url,kind:'mp4'})}});
  const {streams} = await call(client,'probe_active_tab',{authorizationId});
  return {authorizationId,items:streams.map(({candidateId}) => ({candidateId}))};
}

test('site limits reject ineligible candidates before making a media request', {timeout:8000}, async t => {
  const requests = [];
  const origin = await fixture(t,(req,res) => {
    requests.push(req.url);
    res.writeHead(403).end();
  });
  sitePreferences(origin,{maxBatchItems:1,minDurationSec:3,excludePreviews:true});
  const client = clientProfile();
  const {authorizationId,items} = await approve(client,origin,[
    {url:'/preview.mp4',preview:true,duration:10},
    {url:'/short.mp4',duration:2},
    {url:'/full.mp4',duration:10},
  ],{singleTask:true});
  const submit = items => call(client,'start_download',{authorizationId,items});
  await assert.rejects(submit(items),{code:'MCP_SITE_BATCH_LIMIT'});
  await assert.rejects(submit([items[0]]),{code:'MCP_MEDIA_PREVIEW'});
  await assert.rejects(submit([items[1]]),{code:'MCP_MEDIA_TOO_SHORT'});
  assert.deepEqual(requests,[]);
  const {id} = await submit([items[2]]);
  assert.equal((await call(client,'wait_for_download',{id,timeoutMs:2000})).status,'failed');
  assert.deepEqual(requests,['/full.mp4']);
});

test('owned pause holds queued work and resume continues the same one-time batch', {timeout:8000}, async t => {
  const requests = [];
  const started = Promise.withResolvers();
  const origin = await fixture(t,(req,res) => {
    requests.push(req.url);
    if (req.url === '/first.mp4') started.resolve(res);
    else res.writeHead(403).end();
  });
  const client = clientProfile();
  const authorization = await approve(client,origin,['/first.mp4','/next.mp4'],{singleTask:true});
  const {id} = await call(client,'start_download',authorization);
  const first = await started.promise;
  assert.ok(managedTools(client).some(tool => tool.name === 'pause_download' && tool.outputSchema));
  await assert.rejects(call(clientProfile(),'pause_download',{id}),{code:'BATCH_NOT_FOUND'});
  assert.deepEqual(await call(client,'pause_download',{id}),{ok:true});
  first.writeHead(403).end();
  const paused = await call(client,'wait_for_download',{id,timeoutMs:400});
  assert.equal(paused.status,'paused');
  assert.equal(paused.timedOut,true);
  assert.deepEqual(paused.items.map(item => item.status),['error','queued']);
  assert.deepEqual(requests,['/first.mp4']);
  assert.equal((await call(client,'list_batches')).items[0].status,'paused');
  assert.deepEqual(await call(client,'resume_download',{id}),{ok:true});
  assert.equal((await call(client,'wait_for_download',{id,timeoutMs:2000})).status,'failed');
  assert.deepEqual(requests,['/first.mp4','/next.mp4']);
  await assert.rejects(call(client,'start_download',authorization),{code:'MCP_AUTHORIZATION_USED'});
});

test('revoking a grant cancels a paused batch without starting another item', {timeout:8000}, async t => {
  const requests = [];
  const started = Promise.withResolvers();
  const origin = await fixture(t,(req,res) => {
    requests.push(req.url);
    if (req.url === '/first.mp4') started.resolve();
    else res.writeHead(403).end();
  });
  const client = clientProfile();
  const authorization = await approve(client,origin,['/first.mp4','/next.mp4']);
  const {id} = await call(client,'start_download',authorization);
  await started.promise;
  await call(client,'pause_download',{id});
  revokeGrant(authorization.authorizationId,client);
  const result = await call(client,'wait_for_download',{id,timeoutMs:2000});
  assert.equal(result.status,'cancelled');
  await assert.rejects(call(client,'resume_download',{id}),{code:'MCP_TAB_REQUIRED'});
  assert.deepEqual(requests,['/first.mp4']);
});

test('paused batches keep their active client slots', {timeout:8000}, async t => {
  const client = clientProfile();
  const active = [];
  for (const index of [1,2,3]) {
    const started = Promise.withResolvers();
    const origin = await fixture(t,(req,res) => {
      if (req.url === '/first.mp4') started.resolve();
      else res.writeHead(403).end();
    });
    const grant = await approve(client,origin,['/first.mp4','/next.mp4']);
    if (index === 3) {
      await assert.rejects(call(client,'start_download',grant),{code:'MCP_BATCH_LIMIT'});
    } else {
      const {id} = await call(client,'start_download',grant);
      await started.promise;
      await call(client,'pause_download',{id});
      active.push(id);
    }
  }
  for (const id of active) {
    await call(client,'cancel_download',{id});
    assert.equal((await call(client,'wait_for_download',{id,timeoutMs:2000})).status,'cancelled');
  }
});

test('managed retry saves only failed items after the new owner grant observes those sources again', {timeout:15000}, async t => {
  const mediaPath = path.join(directory,'diagnostic-film.mp4');
  execFileSync(process.env.FFMPEG_BIN || 'ffmpeg',[
    '-v','error','-f','lavfi','-i','testsrc2=s=144x144:r=10','-f','lavfi','-i','sine=frequency=440',
    '-t','1','-c:v','libx264','-c:a','aac','-movflags','+faststart',mediaPath,
  ],{windowsHide:true,timeout:8000});
  const media = await readFile(mediaPath);
  const requests = [];
  let allowOriginal = false;
  const origin = await fixture(t,(req,res) => {
    requests.push(req.url);
    if (req.url === '/complete.mp4' || allowOriginal && req.url === '/original.mp4') {
      res.writeHead(200,{'content-type':'video/mp4','content-length':media.length}).end(media);
    } else res.writeHead(403).end();
  });
  const client = clientProfile();
  const authorization = await approve(client,origin,['/original.mp4','/complete.mp4'],{singleTask:true});
  const {id} = await call(client,'start_download',authorization);
  assert.equal((await call(client,'wait_for_download',{id,timeoutMs:5000})).status,'partial');
  await assert.rejects(call(clientProfile(),'retry_download',{id,authorizationId:authorization.authorizationId}),{code:'BATCH_NOT_FOUND'});
  const retry = authorizationId => call(client,'retry_download',{id,authorizationId});
  await assert.rejects(retry(authorization.authorizationId),{code:'MCP_REAPPROVAL_REQUIRED'});
  const other = await approve(client,origin,['/substitute.mp4']);
  await assert.rejects(retry(other.authorizationId),{code:'MCP_SOURCE_NOT_APPROVED'});
  assert.deepEqual(requests,['/original.mp4','/complete.mp4']);
  allowOriginal = true;
  const approved = await approve(client,origin,[{url:'/original.mp4',duration:1},'/complete.mp4','/unrelated.mp4'],{singleTask:true});
  sitePreferences(origin,{minDurationSec:3});
  await assert.rejects(retry(approved.authorizationId),{code:'MCP_MEDIA_TOO_SHORT'});
  assert.deepEqual(requests,['/original.mp4','/complete.mp4']);
  sitePreferences(origin,{minDurationSec:0});
  const retried = await retry(approved.authorizationId);
  assert.equal(retried.total,1);
  assert.notEqual(retried.id,id);
  const saved = await call(client,'wait_for_download',{id:retried.id,timeoutMs:5000});
  assert.equal(saved.status,'done');
  assert.equal(saved.items[0].info.height,144);
  assert.ok(saved.items[0].info.audioCodec);
  assert.deepEqual(requests,['/original.mp4','/complete.mp4','/original.mp4']);
  await assert.rejects(retry(approved.authorizationId),{code:'MCP_AUTHORIZATION_USED'});
  assert.ok(!JSON.stringify(await call(client,'get_progress',{id})).includes(origin + '/original.mp4'));
});
