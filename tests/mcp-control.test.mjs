import assert from 'node:assert/strict';
import { activeTab, approveGrant, boundClientToken, grantStatus, requestGrant } from '../tools/mcp-control.mjs';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    streams:[{url:'https://media.example/film.mp4',kind:'mp4'},
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
  const other = await request('/api/ai/clients',{name:'Other QA',preset:'standard'});
  assert.equal((await request('/api/ai/call',{name:'get_authorization_status',args:{id:requestId}},boundClientToken(owner,other.body.id))).status,404);
  await request('/api/ai/revoke',{id:requestId});
  assert.equal((await call('probe_active_tab')).body.error.code,'MCP_TAB_REQUIRED');
  await request('/api/ai/clients',{id,disabled:true});
  assert.equal((await call('get_capabilities')).status,401);
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
