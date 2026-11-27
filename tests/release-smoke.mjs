import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createTestSandbox } from './test-sandbox.mjs';

const [entry, version] = process.argv.slice(2);
const sandbox = await createTestSandbox('release-smoke');
try {
  await verifyPackage(sandbox);
} finally {
  await sandbox.cleanup();
}

async function verifyPackage(sandbox) {
  const workspace = sandbox.root;
  const fixture = path.join(sandbox.media,'fixture.mp4');
  const outputDirectory = sandbox.downloads;
  const env = sandbox.env();
  execFileSync(process.env.FFMPEG_BIN, ['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2',
    '-c:v','libx264','-c:a','aac','-movflags','+faststart',fixture], {windowsHide:true,timeout:15_000});
  const bytes = await readFile(fixture);
  const origin = createServer((req,res) => {
    if (req.url === '/watch') {
      return res.writeHead(200,{'content-type':'text/html; charset=utf-8'})
        .end('<h1>Packaged fixture</h1><video controls src="/fixture.mp4"></video>');
    }
    if (req.url !== '/fixture.mp4') return res.writeHead(404).end();
    const requested = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = Number(requested?.[1] ?? 0);
    const end = requested?.[2] ? Math.min(Number(requested[2]),bytes.length - 1) : bytes.length - 1;
    if (start > end) return res.writeHead(416,{'content-range':'bytes */' + bytes.length}).end();
    res.writeHead(requested ? 206 : 200,{'content-type':'video/mp4','content-length':end-start+1,
      'accept-ranges':'bytes',etag:'"release-fixture"',
      ...(requested && {'content-range':'bytes ' + start + '-' + end + '/' + bytes.length})})
      .end(bytes.subarray(start,end + 1));
  });
  origin.listen(0,'127.0.0.1');
  await once(origin,'listening');

  const base = 'http://127.0.0.1:' + origin.address().port;
  const child = spawn(process.execPath,[path.resolve(entry)],{env,windowsHide:true,stdio:['pipe','pipe','inherit']});
  child.stdin.on('error',() => {});
  const finished = once(child,'close');
  const replies = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id = 0;
  async function call(method,params) {
    const request = ++id;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:request,method,params}) + '\n');
    const {value} = await replies.next();
    assert.ok(value,'MCP stopped before replying');
    const reply = JSON.parse(value);
    assert.equal(reply.id,request);
    assert.ok(reply.result && !reply.result.isError,JSON.stringify(reply));
    return reply.result.structuredContent ?? reply.result;
  }
  const tool = (name,args) => call('tools/call',{name,arguments:args});
  const deadline = setTimeout(() => child.kill(),75_000);
  try {
    const {protocolVersion,serverInfo} = await call('initialize',{protocolVersion:'2025-11-25'});
    assert.equal(protocolVersion,'2025-11-25');
    assert.equal(serverInfo.version,version);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const {tools} = await call('tools/list');
    for (const name of ['get_version','get_capabilities','get_engine_capabilities','probe_page','start_download','start_batch','wait_for_download','verify_download','diagnose_download']) {
      assert.ok(tools.some(tool => tool.name === name),'Missing packaged MCP tool ' + name);
    }
    const verInfo = await tool('get_version',{});
    assert.equal(verInfo.version, version);
    assert.equal(verInfo.mismatch, false);
    const probe = await tool('probe_page',{url:base + '/watch',waitForMediaMs:4000});
    assert.equal(probe.selection?.url,base + '/fixture.mp4');
    const request = {items:[{kind:'stream',url:probe.selection.url,title:'Packaged fixture'}],concurrency:1};
    const {id:batch} = await tool('start_download',request);
    const {status,items} = await tool('wait_for_download',{id:batch,timeoutMs:15_000});
    const [item] = items;
    assert.equal(status,'done',JSON.stringify(items));
    const output = await realpath(outputDirectory);
    const file = await realpath(item.file);
    assert.equal(path.dirname(file),output);
    assert.ok((await stat(file)).size > 0);
    const {streams,format} = JSON.parse(execFileSync(process.env.FFPROBE_BIN,
      ['-v','error','-show_entries','stream=codec_type,width,height:format=duration','-of','json',file],
      {windowsHide:true,encoding:'utf8',timeout:10_000}));
    const video = streams.find(stream => stream.codec_type === 'video');
    assert.deepEqual([video.width,video.height],[160,90]);
    assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(Math.abs(Number(format.duration) - 2) < 0.2);
    assert.deepEqual(await tool('start_batch',request),{id:batch,total:1,alreadySaved:true});
    const cli = path.join(path.dirname(entry),'media-cli.mjs');
    assert.match(execFileSync(process.execPath,[cli,'--help'],{windowsHide:true,encoding:'utf8',timeout:5000}),/--cookie-file/);
    console.log('Verified packaged MCP discovery, complete audio/video output, batch reuse, and CLI help');
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    const force = setTimeout(() => child.kill(),3000);
    await finished.finally(() => clearTimeout(force));
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  }
}
