import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';

async function startMcp(env) {
  const child = spawn(process.execPath, [entry], {env,windowsHide:true,stdio:['pipe','pipe','inherit']});
  const closed = once(child, 'close');
  const replies = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({id, jsonrpc:'2.0', method, params}) + '\n');
    const reply = JSON.parse((await replies.next()).value);
    assert.equal(reply.id,id);
    assert.ok(reply.result,JSON.stringify(reply));
    return reply.result.structuredContent ?? reply.result;
  }
  await call('initialize',{protocolVersion:'2025-11-25'});
  return {
    tool:(name,args) => call('tools/call',{name,arguments:args}),
    async stop(force = false) {
      if (force) child.kill('SIGKILL');
      else child.stdin.end();
      await closed;
    },
  };
}

test('MCP recovers a killed local batch, validates its HLS checkpoint and preserves finished outputs', {timeout:50_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'videosave-resume-'));
  const out = path.join(root, 'saved');
  const settings = path.join(root,'settings.sqlite');
  const env = {...process.env, OUT_DIR:out, MEDIA_TOOLKIT_SETTINGS:settings, MEDIA_TOOLKIT_URL:''};
  const cookie = 'session=fixture-cookie-must-not-persist';
  const signedQuery = 'sig=fixture-query-must-not-persist';
  const connections = 4;
  const length = 10;
  let mcp;
  let server;
  t.after(async () => {
    try { await mcp?.stop(); }
    finally {
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await rm(root,{recursive:true,force:true,maxRetries:5});
    }
  });

  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10','-c:v','libx264',
    '-g','10','-sc_threshold','0','-t',String(length),'-hls_time','1','-hls_list_size','0','film.m3u8'],
  {cwd:root,windowsHide:true});
  execFileSync(ffmpeg, ['-v','error','-i','film.m3u8','-t','2','-c','copy','prior.mp4'],{cwd:root,windowsHide:true});
  const original = (await readFile(path.join(root,'film.m3u8'),'utf8')).trim();
  const segments = original.split(/\r?\n/).filter(line => line.endsWith('.ts'));
  assert.equal(segments.length,length);
  const contents = new Map(await Promise.all([...segments,'prior.mp4'].map(async name => [name,await readFile(path.join(root,name))])));
  let allowRemaining = false;
  let changePlaylist = false;
  let key;
  const iv = Buffer.alloc(16,42);
  const encrypt = bytes => {
    const cipher = createCipheriv('aes-128-cbc',key,iv);
    return Buffer.concat([cipher.update(bytes),cipher.final()]);
  };
  const requests = [];
  server = createServer((req,res) => {
    const url = new URL(req.url,'http://localhost');
    const name = url.pathname.slice(1);
    if (req.headers.cookie !== cookie) return res.writeHead(401).end();
    if (name === 'film.key' && key) return res.end(key);
    if (name === 'film.m3u8') {
      let playlist = changePlaylist ? original.replace('#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-MEDIA-SEQUENCE:17') : original;
      if (key) playlist = playlist.replace('#EXTINF:',`#EXT-X-KEY:METHOD=AES-128,URI="film.key",IV=0x${iv.toString('hex')}\n#EXTINF:`);
      return res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end(playlist);
    }
    const content = contents.get(name);
    if (!content) return res.writeHead(404).end();
    requests.push(name);
    const index = segments.indexOf(name);
    const bytes = key && index >= 0 ? encrypt(content) : content;
    if (!allowRemaining && index >= connections) {
      // Send an incomplete segment so a crash must not mark it reusable.
      res.writeHead(200, {'content-length':bytes.length});
      res.write(bytes.subarray(0,100));
      return;
    }
    res.writeHead(200, {'content-type':index < 0 ? 'video/mp4' : 'video/mp2t','content-length':bytes.length}).end(bytes);
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const input = {items:[
    {kind:'stream',url:origin+'/prior.mp4',title:'Already saved'},
    {kind:'stream',url:origin+'/film.m3u8?'+signedQuery,title:'Resume me'},
  ],prefetch:true,cookie,connections,concurrency:1};

  async function interrupt() {
    const {id} = await mcp.tool('start_download',input);
    const deadline = AbortSignal.timeout(8_000);
    while (true) {
      const [{status},item] = (await mcp.tool('get_progress',{id})).items;
      if (status === 'done' && item.percent >= 36 && item.percent < 90 && requests.includes(segments[4])) break;
      await sleep(25,undefined,{signal:deadline});
    }
    await mcp.stop(true);
    mcp = null;
    server.closeAllConnections();
    return id;
  }
  async function recover(id, expected) {
    requests.length = 0;
    allowRemaining = true;
    mcp = await startMcp(env);
    const batches = (await mcp.tool('list_batches')).items;
    assert.equal(batches[0]?.id,id);
    const interrupted = await mcp.tool('get_progress',{id});
    assert.equal(interrupted.status,'partial');
    assert.deepEqual(interrupted.items.map(item => item.errorCode ?? item.status), ['done','DOWNLOAD_INTERRUPTED']);
    const state = await readFile(settings);
    for (const secret of [cookie.split('=')[1],signedQuery.split('=')[1]]) assert.equal(state.includes(secret),false);
    assert.equal((await mcp.tool('start_download',input)).id,id);
    const result = await mcp.tool('wait_for_download',{id,timeoutMs:10_000});
    assert.equal(result.status,'done',JSON.stringify(result));
    assert.equal(result.items[0].file,interrupted.items[0].file);
    const output = result.items[1];
    assert.equal(output.prefetch,true);
    assert.equal(output.info.duration,length);
    assert.deepEqual(requests.sort(),expected.toSorted());
    assert.ok(!(await readdir(out)).some(name => name.startsWith('.media-toolkit-')));
    await mcp.stop();
    mcp = null;
  }

  mcp = await startMcp(env);
  await recover(await interrupt(),segments.slice(connections));

  allowRemaining = false;
  requests.length = 0;
  mcp = await startMcp(env);
  const id = await interrupt();
  changePlaylist = true;
  await recover(id,segments);

  for (const rotate of [false,true]) {
    allowRemaining = false;
    requests.length = 0;
    key = Buffer.alloc(16,71);
    mcp = await startMcp(env);
    const encrypted = await interrupt();
    if (rotate) key = Buffer.alloc(16,93);
    await recover(encrypted,rotate ? segments : segments.slice(connections));
  }

  allowRemaining = false;
  requests.length = 0;
  mcp = await startMcp(env);
  const discarded = await interrupt();
  mcp = await startMcp(env);
  assert.deepEqual(await mcp.tool('cancel_download',{id:discarded}),{ok:true});
  const cancelled = await mcp.tool('get_progress',{id:discarded});
  assert.equal(cancelled.status,'cancelled');
  assert.deepEqual(cancelled.items.map(item => item.status),['done','cancelled']);
  assert.ok(!(await readdir(out)).some(name => name.startsWith('.media-toolkit-')));
});

test('MCP resumes only complete byte ranges while the strong ETag stays the same', {timeout:30_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'videosave-range-resume-'));
  const env = {...process.env, OUT_DIR:path.join(root,'saved'), MEDIA_TOOLKIT_SETTINGS:path.join(root,'settings.sqlite'),
    MEDIA_TOOLKIT_URL:''};
  let mcp;
  let server;
  t.after(async () => {
    try { await mcp?.stop(); }
    finally {
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await rm(root,{recursive:true,force:true,maxRetries:5});
    }
  });
  const reference = path.join(root,'reference.mp4');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10','-t','2','-c:v','libx264',
    '-movflags','+faststart',reference],{windowsHide:true});
  const size = 16 * 1024 * 1024;
  const bytes = Buffer.alloc(size);
  const video = await readFile(reference);
  video.copy(bytes);
  bytes.writeUInt32BE(size-video.length,video.length);
  bytes.write('free',video.length+4);
  let etag = '"fixture-v1"';
  let stall = true;
  const requests = [];
  const connections = 4;
  const chunk = size / connections;
  server = createServer((req,res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    if (!match) return res.writeHead(400).end();
    const [,start,end] = match.map(Number);
    if (end > 0) {
      if (req.headers['if-range'] !== etag) return res.writeHead(412).end();
      requests.push(start);
    }
    res.writeHead(206,{'content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1,
      'content-type':'video/mp4',etag});
    if (stall && start >= 2*chunk) res.write(bytes.subarray(start,start+128));
    else res.end(bytes.subarray(start,end+1));
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const url = `http://127.0.0.1:${server.address().port}/film.mp4`;
  const input = {items:[{kind:'stream',url,title:'MP4 restart'}],prefetch:true,connections};

  for (const representationChanged of [false,true]) {
    requests.length = 0;
    stall = true;
    mcp = await startMcp(env);
    const {id} = await mcp.tool('start_download',input);
    const deadline = AbortSignal.timeout(8_000);
    const staging = path.join(env.OUT_DIR,`.media-toolkit-${id}-0`);
    const countMarkers = async () => {
      try {
        const checkpoint = (await readdir(staging)).find(name => name.startsWith('ranges-'));
        return checkpoint ? (await readdir(path.join(staging,checkpoint))).filter(name => name.startsWith('complete-')).length : 0;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return 0;
      }
    };
    while (await countMarkers() < 2) await sleep(25,undefined,{signal:deadline});
    await mcp.stop(true);
    mcp = null;
    server.closeAllConnections();
    requests.length = 0;
    stall = false;
    if (representationChanged) etag = '"fixture-v2"';
    mcp = await startMcp(env);
    assert.equal((await mcp.tool('start_download',input)).id,id);
    const [item] = (await mcp.tool('wait_for_download',{id,timeoutMs:10_000})).items;
    assert.equal(item.status,'done',JSON.stringify(item));
    assert.equal(item.prefetch,true);
    assert.equal(item.info.duration,2);
    const streamhash = file => execFileSync(ffmpeg,['-v','error','-i',file,'-c','copy','-f','streamhash','-'],
      {encoding:'utf8',windowsHide:true});
    assert.equal(streamhash(item.file),streamhash(reference));
    const allRanges = [0,chunk,2*chunk,3*chunk];
    assert.deepEqual(requests.sort((a,b) => a-b),representationChanged ? allRanges : allRanges.slice(2));
    assert.ok(!(await readdir(env.OUT_DIR)).some(name => name.startsWith('.media-toolkit-')));
    await mcp.stop();
    mcp = null;
  }
});
