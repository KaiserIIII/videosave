import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const entry = fileURLToPath(new URL('../tools/mcp-server.mjs', import.meta.url));
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';

test('MCP sends all explicit HLS headers and validates the payload behind nonstandard segment URLs', {timeout:30_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'videosave-hls-headers-'));
  const out = path.join(root,'output');
  const env = {...process.env,OUT_DIR:out,MEDIA_TOOLKIT_SETTINGS:path.join(root,'state.sqlite'),MEDIA_TOOLKIT_URL:'',
    VIDEOSAVE_TEST_SANDBOX:root,VIDEOSAVE_NO_USER_SETTINGS:'1'};
  const headers = {Referer:'https://example.test/player',Origin:'https://example.test','User-Agent':'VideoSave HLS fixture'};
  const files = ['/first.jpeg','/second.png','/third'];
  const requests = [];
  let server;
  let mcp;
  let denySegment = false;
  let imageSegment = false;
  t.after(async () => {
    try { await mcp?.stop(); }
    finally {
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await rm(root,{recursive:true,force:true,maxRetries:5});
    }
  });
  const ffmpegArgs = ['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10'];
  execFileSync(ffmpeg,[...ffmpegArgs,'-f','lavfi','-i','sine=frequency=440','-t','3','-c:v','libx264',
    '-g','10','-sc_threshold','0','-c:a','aac','-hls_time','1','-hls_list_size','0','reference.m3u8'],
    {cwd:root,windowsHide:true});
  execFileSync(ffmpeg,[...ffmpegArgs,'-frames:v','1','preview.png'],{cwd:root,windowsHide:true});
  const image = await readFile(path.join(root,'preview.png'));
  const original = await readFile(path.join(root,'reference.m3u8'),'utf8');
  const playlist = original.replaceAll(/reference(\d+)\.ts/g,(_,index) => files[index].slice(1));
  const bytes = await Promise.all(files.map((_,index) => readFile(path.join(root,`reference${index}.ts`))));
  server = createServer((req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    const matched = Object.entries(headers).every(([name,value]) => req.headers[name.toLowerCase()] === value);
    requests.push({pathname,matched});
    if (!matched || denySegment && pathname === files[2]) return res.writeHead(403).end();
    if (pathname === '/master.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=180000,RESOLUTION=160x90\nmedia.m3u8\n');
    }
    if (pathname === '/media.m3u8') return res.end(playlist);
    if (pathname === '/short.m3u8') {
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.jpeg\n#EXT-X-ENDLIST\n');
    }
    const index = files.indexOf(pathname);
    if (index < 0) return res.writeHead(404).end();
    res.writeHead(200,{'content-type':index === 0 ? 'image/jpeg' : index === 1 ? 'image/png' : 'application/octet-stream'});
    res.end(imageSegment && index === 1 ? image : bytes[index]);
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  mcp = await startMcp(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const download = async (pathname, options = {}) => {
    const {id} = await mcp.tool('start_download',{
      items:[{kind:'stream',sourceKind:'m3u8',url:base + pathname,title:'HLS headers fixture'}],
      headers,prefetch:true,connections:12,...options,
    });
    return (await mcp.tool('wait_for_download',{id,timeoutMs:7000})).items[0];
  };
  const decodedHash = file => execFileSync(ffmpeg,['-v','error','-i',file,'-map','0:v','-map','0:a','-f','streamhash','-'],
    {encoding:'utf8',windowsHide:true});
  const full = await download('/master.m3u8');
  assert.equal(full.status,'done',JSON.stringify({full,requests}));
  assert.equal(full.prefetch,true);
  assert.ok(Math.abs(full.info.duration - 3) < 0.15);
  assert.equal(path.dirname(full.file),out);
  assert.equal(decodedHash(full.file),decodedHash(path.join(root,'reference.m3u8')));
  assert.deepEqual(requests.map(({pathname}) => pathname).sort(), [...files,'/master.m3u8','/media.m3u8'].sort());
  assert.ok(requests.every(({matched}) => matched));

  denySegment = true;
  const denied = await download('/master.m3u8?denied=true');
  assert.equal(denied.errorCode,'MEDIA_ACCESS_RESTRICTED');
  assert.equal(denied.detail.status,403);
  assert.equal(denied.detail.hlsPhase,'segment');
  assert.equal(denied.prefetchFallback,undefined);
  denySegment = false;
  imageSegment = true;
  assert.equal((await download('/master.m3u8?image=true')).errorCode,'INVALID_HLS_SEGMENT');

  const single = await download('/short.m3u8');
  assert.equal(single.status,'done',JSON.stringify(single));
  assert.equal(single.prefetch,true);
  assert.ok(Math.abs(single.info.duration - 1) < 0.15);
});

test('MCP validates nonstandard HLS parts and resumes a transient failure without repeating committed parts', {timeout:40_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'videosave-hls-parts-'));
  const env = {...process.env,OUT_DIR:path.join(root,'saved'),MEDIA_TOOLKIT_SETTINGS:path.join(root,'state.sqlite'),MEDIA_TOOLKIT_URL:'',
    VIDEOSAVE_TEST_SANDBOX:root,VIDEOSAVE_NO_USER_SETTINGS:'1'};
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10','-c:v','libx264','-g','10','-sc_threshold','0',
    '-t','8','-hls_time','1','-hls_list_size','0','film.m3u8'],{cwd:root,windowsHide:true});
  const manifest = await readFile(path.join(root,'film.m3u8'),'utf8');
  const segments = await Promise.all(Array.from({length:8},(_,idx) => readFile(path.join(root,`film${idx}.ts`))));
  const counts = Array(8).fill(0);
  const manifests = [];
  const cliHeaders = [];
  let refreshVisits = 0;
  let rotatingVisits = 0;
  let highStatus = 404;
  let unavailable = true;
  let corrupt = false;
  const server = createServer((req,res) => {
    if (req.headers.cookie || req.headers['user-agent'] === 'VideoSave-Test') {
      cliHeaders.push([req.headers.cookie,req.headers['user-agent']]);
    }
    if (req.url === '/watch/fixture' || req.url === '/watch/TEST-100') {
      refreshVisits++;
      return res.writeHead(200,{'content-type':'text/html'}).end(
        '<title>Recovery fixture</title><video controls preload="none" src="/film.m3u8"></video>');
    }
    if (req.url === '/watch/rotating') {
      const stream = ++rotatingVisits === 1 ? 'gone' : 'film';
      return res.writeHead(200,{'content-type':'text/html'}).end(
        `<title>Rotating stream fixture</title><video controls preload="none" src="/${stream}.m3u8"></video>`);
    }
    if (req.url === '/gone.m3u8') return res.end(manifest.replaceAll(/film(\d+)\.ts/g,'gone$1.jpeg'));
    if (/^\/gone\d+\.jpeg$/.test(req.url)) return res.writeHead(410).end();
    if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=1920x1080\nhigh.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=1280x720\nfilm.m3u8\n');
    if (req.url === '/huge.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000000000000,RESOLUTION=1280x720\nfilm.m3u8\n');
    if (req.url === '/high.m3u8') {
      manifests.push('high');
      return res.writeHead(highStatus).end();
    }
    if (req.url === '/film.m3u8') {
      manifests.push('film');
      return res.end(manifest.replaceAll('.ts','.jpeg'));
    }
    const idx = Number(/^\/film(\d+)\.jpeg$/.exec(req.url)?.[1]);
    if (!Number.isInteger(idx)) return res.writeHead(404).end();
    counts[idx]++;
    if (unavailable && idx === 7) return res.writeHead(503).end();
    res.writeHead(200,{'content-type':'image/jpeg'}).end(corrupt && idx === 7 ? Buffer.alloc(1400) : segments[idx]);
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  let mcp = await startMcp(env);
  t.after(async () => {
    await mcp.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root,{recursive:true,force:true,maxRetries:5});
  });
  const request = {items:[{kind:'stream',url:`http://127.0.0.1:${server.address().port}/film.m3u8`,title:'Recovery fixture'}],
    concurrency:1,connections:4};
  const wait = id => mcp.tool('wait_for_download',{id,timeoutMs:5000});
  const {id} = await mcp.tool('start_download',request);
  const failed = await wait(id);
  assert.equal(failed.items[0].errorCode,'HLS_TRANSFER_INTERRUPTED');
  assert.equal(failed.resumable,true);
  assert.deepEqual(counts,[1,1,1,1,1,1,1,3]);
  assert.equal(failed.items[0].segments.completed,7);
  const recovery = path.join(env.OUT_DIR,`.media-toolkit-${id}-0`);
  const checkpoint = (await readdir(recovery)).find(name => name.startsWith('segments-'));
  assert.deepEqual(JSON.parse(await readFile(path.join(recovery,checkpoint,'failed.json'),'utf8')),
    {total:8,missing:[7]});
  await mcp.stop();
  mcp = await startMcp(env);
  unavailable = false;
  assert.equal((await mcp.tool('start_download',request)).id,id);
  const done = await wait(id);
  assert.equal(done.status,'done');
  assert.equal(done.items[0].prefetch,true);
  assert.equal(done.items[0].info.duration,8);
  assert.deepEqual(counts,[1,1,1,1,1,1,1,4]);
  const target = new URL(request.items[0].url);
  const item = (name,title) => ({kind:'stream',url:new URL(name,target).href,title,quality:'max'});
  const replay = await mcp.tool('start_batch',request);
  assert.deepEqual(replay,{id,total:1,alreadySaved:true});
  assert.deepEqual(counts,[1,1,1,1,1,1,1,4]);
  const {id:serial} = await mcp.tool('start_batch',{items:[
    request.items[0],item('/master.m3u8','First'),item('/huge.m3u8','Second'),item('/film.m3u8','Third'),
  ],connections:4});
  const completed = await wait(serial);
  assert.equal(completed.status,'partial');
  assert.deepEqual(completed.items.map(item => [item.status,item.errorCode]),
    [['done',undefined],['done',undefined],['error','NO_SPACE'],['done',undefined]]);
  assert.equal(completed.items[0].file,done.items[0].file);
  assert.equal(completed.items[0].alreadySaved,true);
  assert.deepEqual(manifests.slice(-4),['high','film','film','film']);
  highStatus = 403;
  const refresh = {pageUrl:new URL('/watch/fixture',target).href};
  const {id:denied} = await mcp.tool('start_download',{items:[item('/master.m3u8','Denied')],refresh});
  assert.equal((await wait(denied)).items[0].errorCode,'MEDIA_ACCESS_RESTRICTED');
  assert.equal(manifests.at(-1),'high');
  assert.equal(refreshVisits,0);
  const {id:expiredId} = await mcp.tool('start_download',{items:[item('/gone.m3u8','Gone')]});
  assert.equal((await wait(expiredId)).items[0].errorCode,'STREAM_EXPIRED');
  const {id:refreshedId} = await mcp.tool('start_download',{items:[item('/gone.m3u8','Refreshed')],refresh,keepSegments:true});
  const refreshed = await mcp.tool('wait_for_download',{id:refreshedId,timeoutMs:15_000});
  assert.equal(refreshed.status,'done',JSON.stringify(refreshed));
  assert.equal(refreshed.items[0].info.duration,8);
  assert.equal((await readdir(refreshed.items[0].segmentDirectory)).filter(name => name.endsWith('.ts')).length,8);
  assert.equal(refreshVisits,1);
  const queuedCode = await mcp.tool('start_batch',{items:[{kind:'code',code:'TEST-100'}],
    codeUrlTemplate:`${target.origin}/watch/{code}`,perItem:{quality:'max'}});
  const coded = await mcp.tool('wait_for_download',{id:queuedCode.id,timeoutMs:15_000});
  assert.equal(coded.status,'done',JSON.stringify(coded));
  assert.equal(coded.items[0].info.duration,8);
  assert.equal(refreshVisits,2);
  const queuedPage = await mcp.tool('start_batch',{items:[{kind:'page',url:new URL('/watch/rotating',target).href}]});
  const rotated = await mcp.tool('wait_for_download',{id:queuedPage.id,timeoutMs:20_000});
  assert.equal(rotated.status,'done',JSON.stringify(rotated));
  assert.equal(rotated.items[0].info.duration,8);
  assert.equal(rotatingVisits,2);
  const cli = fileURLToPath(new URL('../tools/media-cli.mjs',import.meta.url));
  const cookieFile = path.join(root,'cookies.txt');
  const cliArgs = [cli,'--cookie-file',cookieFile,'--ua','VideoSave-Test','--connections','4',target.href];
  const exec = promisify(execFile);
  await writeFile(cookieFile,'fixture=not-in-output');
  const cliResult = await exec(process.execPath,cliArgs,{env,windowsHide:true});
  assert.doesNotMatch(cliResult.stdout,/not-in-output/);
  const cliDone = JSON.parse(cliResult.stdout.trim().split('\n').at(-1));
  assert.equal(cliDone.status,'done');
  assert.equal(cliDone.items[0].segments.completed,8);
  assert.ok(cliHeaders.length >= 9);
  assert.ok(cliHeaders.every(([cookie,ua]) => cookie === 'fixture=not-in-output' && ua === 'VideoSave-Test'));
  await writeFile(cookieFile,'cf_clearance=not-in-output');
  await assert.rejects(exec(process.execPath,cliArgs,{env,windowsHide:true}),error =>
    JSON.parse(error.stdout).code === 'INVALID_COOKIE' && !error.stdout.includes('not-in-output'));
  corrupt = true;
  const invalid = await mcp.tool('start_download',request);
  assert.equal((await wait(invalid.id)).items[0].errorCode,'INVALID_HLS_SEGMENT');
});

async function startMcp(env) {
  const args = env.VIDEOSAVE_TEST_SANDBOX ? [entry, `--sandbox=${env.VIDEOSAVE_TEST_SANDBOX}`] : [entry, '--sandbox'];
  const child = spawn(process.execPath, args, {env,windowsHide:true,stdio:['pipe','pipe','inherit']});
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
  const env = {...process.env, OUT_DIR:out, MEDIA_TOOLKIT_SETTINGS:settings, MEDIA_TOOLKIT_URL:'',
    VIDEOSAVE_TEST_SANDBOX:root, VIDEOSAVE_NO_USER_SETTINGS:'1'};
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
    MEDIA_TOOLKIT_URL:'', VIDEOSAVE_TEST_SANDBOX:root, VIDEOSAVE_NO_USER_SETTINGS:'1'};
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
