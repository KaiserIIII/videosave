import assert from 'node:assert/strict';
import { approvedCookies } from '../tools/approved-cookies.mjs';
import { importedCookies } from '../extension/session-credentials.mjs';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const settingsTemp = await mkdtemp(path.join(os.tmpdir(),'videosave-control-settings-'));
process.env.MEDIA_TOOLKIT_SETTINGS = path.join(settingsTemp,'settings.sqlite');
after(() => rm(settingsTemp,{recursive:true,force:true,maxRetries:4,retryDelay:100}));
const {activeTab,approveGrant,boundClientToken,grantStatus,renewGrant,requestGrant} = await import('../tools/mcp-control.mjs');
const {prefetchHls} = await import('../tools/hls-prefetch.mjs');

test('managed HLS stages same-origin VOD and stops at a foreign child or redirect', async t => {
  const staging = await mkdtemp(path.join(os.tmpdir(),'videosave-managed-hls-'));
  let destination;
  let foreignRequests = 0;
  let child = '/segment.ts';
  const remote = createServer((_req,res) => { foreignRequests++; res.end('foreign'); }).listen(0,'127.0.0.1');
  const local = createServer((req,res) => {
    if (req.url === '/main.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n' + child + '\n#EXTINF:2,\n/second.ts\n#EXT-X-ENDLIST');
    if (req.url === '/redirect.ts') return res.writeHead(302,{location:destination}).end();
    return res.end('local media fixture');
  }).listen(0,'127.0.0.1');
  t.after(async () => {
    local.closeAllConnections();
    remote.closeAllConnections();
    await Promise.all([new Promise(resolve => local.close(resolve)),new Promise(resolve => remote.close(resolve))]);
    await rm(staging,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  await Promise.all([once(local,'listening'),once(remote,'listening')]);
  const source = new URL('http://127.0.0.1:' + local.address().port + '/main.m3u8');
  destination = 'http://127.0.0.1:' + remote.address().port + '/foreign.ts';
  const stage = () => prefetchHls(source,[],staging,AbortSignal.timeout(4000),() => {},{restrictedOrigin:true});
  child = destination;
  await assert.rejects(stage,{code:'MCP_MEDIA_SCOPE'});
  child = '/redirect.ts';
  await assert.rejects(stage,{code:'MCP_MEDIA_REDIRECT'});
  assert.equal(foreignRequests,0);
  child = '/segment.ts';
  assert.ok(await stage());
});

test('paired management and managed sessions use separate permissions', {timeout:20000}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'videosave-control-'));
  const owner = 'isolated-test-pairing';
  const env = {...process.env,PORT:'0',MEDIA_TOOLKIT_TOKEN:owner,
    MEDIA_TOOLKIT_SETTINGS:path.join(temp,'settings.sqlite'),OUT_DIR:path.join(temp,'out')};
  const child = spawn(process.execPath,['tools/server.mjs'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const closed = once(child,'close');
  t.after(async () => {
    child.kill();
    await closed;
    await rm(temp,{recursive:true,force:true});
  });
  const output = createInterface({input:child.stdout});
  const [ready] = await once(output,'line');
  const endpoint = ready.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(endpoint);
  async function request(route, data, token = owner) {
    const response = await fetch(endpoint + route,{method:data ? 'POST' : 'GET',
      headers:{authorization:'Bearer ' + token,...(data && {'content-type':'application/json'})},
      ...(data && {body:JSON.stringify(data)})});
    return {status:response.status,body:await response.json()};
  }

  assert.equal((await request('/api/ai/clients',undefined,'unpaired')).status,401);
  const provisioned = await request('/api/ai/clients',{name:'Local QA',preset:'read-only'});
  assert.equal(provisioned.status,200);
  const {id} = provisioned.body;
  const token = boundClientToken(owner,id);
  assert.ok(id && token);
  assert.ok(!('token' in provisioned.body));
  assert.equal((await request('/api/ai/config?id=' + id)).body.error.code,'MCP_CONFIG_UNAVAILABLE');
  assert.ok(!(await request('/api/ai/clients')).body.items.some(item => 'token' in item));
  assert.equal((await request('/api/ai/clients',{id,preset:'standard'},token)).status,401);
  const call = (name,args = {}) => request('/api/ai/call',{name,args},token);
  assert.equal((await call('get_capabilities')).body.preset,'read-only');
  assert.equal((await call('start_download',{items:[]})).body.error?.code,'MCP_PERMISSION_DENIED');
  assert.equal((await call('probe_active_tab')).body.error?.code,'MCP_TAB_REQUIRED');
  const pending = await call('request_site_authorization',{origin:'https://media.example'});
  assert.equal(pending.body.status,'pending');
  const requestId = pending.body.id;
  const tab = {url:'https://media.example/watch?private=1',title:'Test media',
    streams:[{url:'https://media.example/film.mp4',kind:'mp4',size:1048576},
      {url:'https://media.example/signed.mp4?signature=secret',kind:'mp4'},
      {url:'https://other.example/film.mp4',kind:'mp4'}]};
  const approved = await request('/api/ai/approve',{id:requestId,tab,minutes:5});
  assert.equal(approved.status,200);
  assert.equal((await request('/api/ai/approve',{id:requestId,tab,minutes:5})).status,409);
  const active = await call('probe_active_tab');
  assert.equal(active.body.streams.length,1);
  assert.ok(active.body.streams[0].candidateId);
  assert.ok(!('url' in active.body.streams[0]));
  assert.equal((await call('probe_active_tab',{cookie:'fixture-value'})).body.error.code,'MCP_INVALID_ARGUMENTS');
  assert.equal(active.body.tab.origin,'https://media.example');
  assert.ok(!JSON.stringify(active.body).includes('secret'));
  assert.ok(!JSON.stringify(active.body).includes('private'));
  const status = await call('get_session_status',{origin:'https://media.example'});
  assert.equal(status.body.status,'approved');
  assert.equal(status.body.authorizationId,requestId);
  assert.equal(status.body.sessionShared,false);
  assert.deepEqual((await call('get_session_status',{origin:'https://unapproved.example'})).body,
    {origin:'https://unapproved.example',status:'unavailable'});
  const candidate = {authorizationId:requestId,candidateId:active.body.streams[0].candidateId};
  const validation = await call('validate_media',candidate);
  assert.deepEqual(validation.body,{candidateId:candidate.candidateId,kind:'mp4',eligible:false,
    code:'MCP_PERMISSION_DENIED',availabilityChecked:false});
  assert.equal((await call('validate_media',{...candidate,candidateId:requestId})).body.error.code,'MCP_SOURCE_NOT_APPROVED');
  const estimate = await call('estimate_download',candidate);
  assert.equal(estimate.body.sourceBytes,1048576);
  assert.ok(estimate.body.freeBytes > 0);
  assert.equal(estimate.body.settings.connections,8);
  assert.ok(!JSON.stringify(estimate.body).includes(temp));
  assert.equal(estimate.body.settings.maxBatchItems,8);
  assert.equal(estimate.body.settings.minDurationSec,0);
  const updated = await request('/api/ai/site',{origin:tab.url,settings:{excludePreviews:true,maxBatchItems:3,minDurationSec:100}});
  assert.equal(updated.body.settings.excludePreviews,true);
  assert.equal(updated.body.settings.maxBatchItems,3);
  assert.equal(updated.body.settings.minDurationSec,100);
  const diagnostic = await call('diagnose_probe',{authorizationId:requestId});
  assert.equal(diagnostic.body.code,'media-found');
  assert.equal(diagnostic.body.candidateCount,1);
  const other = await request('/api/ai/clients',{name:'Other QA',preset:'standard'});
  assert.equal((await request('/api/ai/call',{name:'get_authorization_status',args:{id:requestId}},boundClientToken(owner,other.body.id))).status,404);
  assert.equal((await request('/api/ai/call',{name:'revoke_site_authorization',args:{id:requestId}},boundClientToken(owner,other.body.id))).status,404);
  const second = await call('request_site_authorization',{origin:'https://second.example'});
  await request('/api/ai/approve',{id:second.body.id,tab:{url:'https://second.example',streams:[]}});
  assert.equal((await call('probe_active_tab')).body.error.code,'MCP_AUTHORIZATION_REQUIRED');
  assert.equal((await call('probe_active_tab',{authorizationId:requestId})).body.streams.length,1);
  await request('/api/ai/revoke',{id:second.body.id});
  await request('/api/ai/revoke',{id:requestId});
  assert.equal((await call('probe_active_tab')).body.error.code,'MCP_TAB_REQUIRED');
  await request('/api/ai/clients',{id,disabled:true});
  assert.equal((await call('get_capabilities')).status,401);
});

test('a browser grant stops when the extension can no longer confirm the tab', t => {
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-27T00:00:00Z')});
  const client = {id:'fixture-lease-client',name:'Reachability test'};
  const request = requestGrant(client,'https://lease.example');
  const approved = approveGrant({id:request.id,tab:{url:'https://lease.example/watch',streams:[]},sessionMode:'browser'});
  assert.equal(approved.sessionMode,'browser');
  assert.equal(Date.parse(approved.expiresAt) - Date.now(),12*60*60_000);
  t.mock.timers.tick(50_000);
  renewGrant(request.id);
  t.mock.timers.tick(50_000);
  assert.equal(grantStatus(request.id,client).expiresAt,approved.expiresAt);
  assert.equal(activeTab(client).authorizationId,request.id);
  t.mock.timers.tick(26_000);
  assert.equal(grantStatus(request.id,client).status,'revoked');
  assert.throws(() => activeTab(client),{code:'MCP_TAB_REQUIRED'});
  assert.throws(() => renewGrant(request.id),{code:'MCP_AUTHORIZATION_INACTIVE'});
});

test('temporary browser credentials respect domain, path, expiry and secure attributes', () => {
  const now = Math.floor(Date.now()/1000);
  const cookie = {name:'session',value:'login-fixture',domain:'media.example',path:'/video',hostOnly:true,secure:true,expirationDate:now+60};
  const entries = [cookie,{...cookie,name:'expired',expirationDate:now-1},{...cookie,name:'cf_clearance'},
    {...cookie,name:'partitioned',partitionKey:{}},{...cookie,name:'other',domain:'third.example'},
    {...cookie,name:'injection',value:'a; invalid=1'},{...cookie,name:'legacy',domain:'.example',hostOnly:false}];
  const matcher = approvedCookies(entries);
  assert.deepEqual(matcher(new URL('https://media.example/video/movie.mp4')).map(row => row.name),['session']);
  assert.deepEqual(matcher(new URL('https://media.example/videotrailer/movie.mp4')),[]);
  assert.deepEqual(matcher(new URL('https://cdn.media.example/video/movie.mp4')),[]);
  assert.deepEqual(matcher(new URL('http://media.example/video/movie.mp4')),[]);
});

test('manually selected credentials are scoped to the approved hostname and paths', () => {
  const origin = new URL('https://media.example');
  const raw = importedCookies('session=fixture; theme=dark',origin);
  assert.deepEqual(approvedCookies(raw)(new URL('/film.mp4',origin)).map(row => row.name),['session','theme']);
  assert.throws(() => importedCookies('session=fixture\nAuthorization: hidden',origin));
  const file = '# Netscape HTTP Cookie File\n#HttpOnly_media.example\tFALSE\t/media\tTRUE\t0\tsession\tfixture\n' +
    'other.example\tFALSE\t/\tTRUE\t0\tsession\tignored\n';
  const parsed = approvedCookies(importedCookies(file,origin,{file:true}));
  assert.deepEqual(parsed(new URL('/media/film.mp4',origin)).map(row => row.name),['session']);
  assert.deepEqual(parsed(new URL('/film.mp4',origin)),[]);
});


test('a browser grant expires and cannot be used again', t => {
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-27T00:00:00Z')});
  const client = {id:'fixture-expiry-client',name:'Expiry test'};
  const request = requestGrant(client,'https://expiry.example');
  approveGrant({id:request.id,tab:{url:'https://expiry.example/watch',streams:[]},minutes:1});
  assert.equal(activeTab(client).authorizationId,request.id);
  t.mock.timers.tick(60_000);
  assert.equal(grantStatus(request.id,client).status,'expired');
  assert.throws(() => activeTab(client),{code:'MCP_TAB_REQUIRED'});
  assert.throws(() => approveGrant({id:request.id}),{code:'MCP_AUTHORIZATION_INACTIVE'});
});
