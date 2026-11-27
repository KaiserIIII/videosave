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
process.env.VIDEOSAVE_TEST_SANDBOX = settingsTemp;
process.env.VIDEOSAVE_NO_USER_SETTINGS = '1';
process.env.MEDIA_TOOLKIT_SETTINGS = path.join(settingsTemp,'settings.sqlite');
process.env.OUT_DIR = path.join(settingsTemp,'out');
after(() => rm(settingsTemp,{recursive:true,force:true,maxRetries:4,retryDelay:100}));
const {activeTab,approveGrant,boundClientToken,grantStatus,renewGrant,requestGrant,saveClient,updateGrantSnapshot,
  sitePreferences,updateClientAccess} = await import('../tools/mcp-control.mjs');
const {prefetchHls} = await import('../tools/hls-prefetch.mjs');

test('full access requires owner confirmation and standing approvals remain scoped to the saved origins', () => {
  assert.throws(() => saveClient({name:'Full QA',preset:'full-access'}),{code:'MCP_CONFIRM_ACCESS'});
  const client = saveClient({name:'Full QA',preset:'full-access',confirm:true});
  assert.ok(client.scopes.includes('automation') && client.scopes.includes('network'));
  const origin = 'https://standing.example';
  const other = 'https://not-trusted.example';
  assert.throws(() => updateClientAccess({id:client.id,action:'trust',origins:[origin]}),{code:'MCP_CONFIRM_ACCESS'});
  updateClientAccess({id:client.id,action:'trust',origins:[origin],days:30,allowDownload:true,confirm:true});
  const request = requestGrant(client,origin);
  const outside = requestGrant(client,other);
  assert.equal(request.automatic,true);
  assert.equal(Boolean(outside.automatic),false);
  assert.throws(() => approveGrant({id:outside.id,automatic:true,tab:{url:other,streams:[]}}),{code:'MCP_SITE_DENIED'});
  approveGrant({id:request.id,automatic:true,tab:{url:origin,streams:[{url:origin+'/movie.mp4?token=session-only',kind:'mp4',observed:true}]}});
  assert.equal(activeTab(client,request.id).streams.length,1);
  assert.equal(activeTab(client,request.id).standingDownload,true);
  assert.equal(sitePreferences(origin).settings.download,false);
  assert.equal(requestGrant(client,origin).id,request.id);
  updateClientAccess({id:client.id,action:'reset'});
  assert.equal(grantStatus(request.id,client).status,'revoked');
  assert.equal(requestGrant(client,origin).automatic,undefined);
});

test('managed HLS stages same-origin VOD and stops at a foreign child or redirect', async t => {
  const staging = await mkdtemp(path.join(os.tmpdir(),'videosave-managed-hls-'));
  let destination;
  let foreignRequests = 0;
  let child = '/segment.ts';
  let protection = '';
  const remote = createServer((_req,res) => { foreignRequests++; res.end('foreign'); }).listen(0,'127.0.0.1');
  const local = createServer((req,res) => {
    if (req.url === '/main.m3u8') return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + protection + '#EXTINF:2,\n' + child + '\n#EXTINF:2,\n/second.ts\n#EXT-X-ENDLIST');
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
  child = '/segment.ts';
  protection = `#EXT-X-KEY:METHOD=AES-128,URI="${destination}"\n`;
  await assert.rejects(stage,{code:'MCP_MEDIA_SCOPE'});
  protection = `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${destination}"\n`;
  await assert.rejects(stage,{code:'DRM'});
  assert.equal(foreignRequests,0);
  protection = '';
  assert.ok(await stage());
});

test('standing tab snapshots preserve unchanged candidate IDs and retire replaced signed URLs', () => {
  const client = saveClient({name:'Live QA',preset:'advanced',confirm:true});
  const origin = 'https://live-standing.example';
  updateClientAccess({id:client.id,action:'trust',origins:[origin],confirm:true});
  const {id} = requestGrant(client,origin);
  const blocked = updateGrantSnapshot({id,tab:{url:origin,restricted:true,streams:[],
    diagnostic:{blockers:['login-required','private-page-value'],nextAction:'private-page-text'}}});
  assert.equal(blocked.status,'pending');
  assert.equal(blocked.diagnostic.code,'login-required');
  assert.equal(blocked.diagnostic.nextAction,'sign-in-with-browser');
  assert.doesNotMatch(JSON.stringify(grantStatus(id,client)),/private-page/);
  approveGrant({id,automatic:true,tab:{url:origin,streams:[]}});
  assert.equal(grantStatus(id,client).diagnostic,undefined);
  const source = {url:origin+'/movie.mp4?token=a',observed:true,kind:'mp4',recommended:true};
  const update = streams => updateGrantSnapshot({id,tab:{url:origin,streams}});
  update([source]);
  const [first] = activeTab(client,id).streams;
  assert.equal(first.recommended,true);
  update([{...source,height:720}]);
  assert.equal(activeTab(client,id).streams[0].candidateId,first.candidateId);
  update([{...source,url:origin+'/movie.mp4?token=b'}]);
  assert.notEqual(activeTab(client,id).streams[0].candidateId,first.candidateId);
  assert.throws(() => updateGrantSnapshot({id,tab:{url:'https://elsewhere.example',streams:[]}}),{code:'MCP_INVALID_TAB'});
});

test('standing CDN access requires owner opt-in and browser-observed player evidence', () => {
  const client = saveClient({name:'CDN QA',preset:'full-access',confirm:true});
  const origin = 'https://watch.example';
  const cdn = 'https://cdn.example';
  const observed = {url:cdn+'/film.mp4?sig=cdntoken',kind:'mp4',observed:true,
    playerOrigin:origin,playerAssociated:true,requestHeaders:{Origin:origin,Referer:origin+'/watch',
      Cookie:'page-secret=1',Authorization:'Bearer page-secret'}};
  const streams = [observed,{...observed,url:cdn+'/other.mp4',playerAssociated:false},
    {...observed,url:cdn+'/declared.mp4',observed:false},
    {...observed,url:'http://insecure.example/media.mp4'}];
  const approve = allowRelatedMedia => {
    updateClientAccess({id:client.id,action:'trust',origins:[origin],allowRelatedMedia,confirm:true});
    const pending = requestGrant(client,origin);
    approveGrant({id:pending.id,automatic:true,tab:{url:origin,streams}});
    return activeTab(client,pending.id).streams;
  };
  assert.equal(approve(false).length,0);
  const [source,...other] = approve(true);
  assert.deepEqual(other,[]);
  assert.equal(source.url,observed.url);
  assert.deepEqual(source.headers,{Origin:origin,Referer:origin+'/watch'});
  assert.deepEqual(source.cookiesFor(new URL(source.url)),[]);
  assert.equal(source.relatedMedia,true);
});

test('managed resource scope accepts signed descendants and requires exact evidence for secondary origins and redirects', async () => {
  const {scopeManagedMedia} = await import('../tools/managed-media.mjs');
  const entry = new URL('https://cdn.example/main.m3u8?sig=main');
  const observed = new URL('https://backup.example/clip.m4s?sig=observed');
  const scoped = scopeManagedMedia(entry,'https://page.example',true,[observed.href]);
  scoped.assertUrl(new URL('https://cdn.example/segment.m4s?sig=child'));
  scoped.assertUrl(observed);
  scoped.assertUrl(observed,{redirect:true});
  assert.throws(() => scoped.assertUrl(new URL('https://cdn.example/other.m3u8'),{redirect:true}),{code:'MCP_MEDIA_REDIRECT'});
  assert.throws(() => scoped.assertUrl(new URL('https://backup.example/private.m4s')),{code:'MCP_MEDIA_SCOPE'});
  assert.throws(() => scoped.assertUrl(new URL('https://user:pass@cdn.example/clip.m4s')),{code:'MCP_MEDIA_SCOPE'});
  assert.throws(() => scoped.assertUrl(new URL('https://127.0.0.1/clip.m4s')),{code:'MCP_MEDIA_SCOPE'});
});

test('related playback resources stay private and are replaced when the approved snapshot changes', () => {
  const client = saveClient({name:'Related fragments QA',preset:'full-access',confirm:true});
  const origin = 'https://frames.example';
  const playerOrigin = 'https://player.example';
  const stream = {url:'https://media.example/master.mpd',kind:'mpd',observed:true,playerAssociated:true,frameId:3,playerOrigin};
  const fragment = {url:'https://parts.example/chunk.m4s?sig=private',frameId:3,playerOrigin,
    requestHeaders:{Origin:playerOrigin,Cookie:'private',Authorization:'private'}};
  updateClientAccess({id:client.id,action:'trust',origins:[origin],allowRelatedMedia:true,confirm:true});
  const pending = requestGrant(client,origin);
  const tab = {url:origin,streams:[stream]};
  const approved = approveGrant({id:pending.id,automatic:true,tab:{...tab,resources:[fragment,
    {...fragment,url:'https://parts.example/chunk2.m4s',frameId:4},
    {...fragment,url:'https://parts.example/chunk3.m4s',playerOrigin:origin}]}});
  assert.ok(!JSON.stringify(approved).includes('private'));
  const snapshot = activeTab(client,pending.id);
  assert.ok(!('resources' in snapshot.tab));
  assert.deepEqual(snapshot.resources,[{url:fragment.url,frameId:3,playerOrigin,headers:{Origin:playerOrigin}}]);
  updateGrantSnapshot({id:pending.id,tab});
  assert.deepEqual(activeTab(client,pending.id).resources,[]);
});

test('CDN connections use only publicly routable DNS answers', async () => {
  const {publicMediaAddress,publicMediaLookup} = await import('../tools/managed-media.mjs');
  for (const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','100.64.1.1','192.168.2.4',
    '203.0.113.20','::1','::ffff:8.8.8.8','fc00::2','fe80::1','2001:db8::2','ff00::1']) {
    assert.equal(publicMediaAddress(ip),false,ip);
  }
  for (const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(publicMediaAddress(ip),true,ip);
  let calls = 0;
  const lookup = publicMediaLookup(async () => ++calls === 1
    ? [{address:'1.1.1.1',family:4}] : [{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]);
  const connect = () => new Promise((resolve,reject) => lookup('media.example',{all:true},
    (error,records) => error ? reject(error) : resolve(records)));
  assert.deepEqual(await connect(),[{address:'1.1.1.1',family:4}]);
  await assert.rejects(connect,{code:'MCP_MEDIA_SCOPE'});
});

test('paired management and managed sessions use separate permissions', {timeout:20000}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'videosave-control-'));
  const owner = 'isolated-test-pairing';
  const env = {...process.env,PORT:'0',MEDIA_TOOLKIT_TOKEN:owner,
    MEDIA_TOOLKIT_SETTINGS:path.join(temp,'settings.sqlite'),OUT_DIR:path.join(temp,'out'),
    VIDEOSAVE_TEST_SANDBOX:temp,VIDEOSAVE_NO_USER_SETTINGS:'1'};
  const child = spawn(process.execPath,['tools/server.mjs',`--sandbox=${temp}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
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
