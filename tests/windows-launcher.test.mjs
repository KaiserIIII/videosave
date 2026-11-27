import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('..', import.meta.url));

test('the Windows launcher configures MCP downloads and keeps shared pairing after restart', {
  skip:process.platform !== 'win32', timeout:25_000,
}, async t => {
  const setupEnv = {...process.env};
  for (const name of Object.keys(setupEnv)) if (/^ytdlp_bin$/i.test(name)) delete setupEnv[name];
  const json = execFileSync(process.env.ComSpec,
    ['/d','/s','/c','"call "Start VideoSave.cmd" -SetupOnly -McpConfig -SkipPlatform"'], {
      cwd:project, env:setupEnv, encoding:'utf8', input:'', windowsHide:true, windowsVerbatimArguments:true, timeout:15_000,
    });
  const { mcpServers:{videosave:config} } = JSON.parse(json);
  assert.ok(path.isAbsolute(config.command));
  assert.deepEqual(config.args, [path.join(project, 'tools', 'mcp-server.mjs')]);
  assert.deepEqual(Object.keys(config.env).sort(), ['FFMPEG_BIN','FFPROBE_BIN']);
  assert.ok(Object.values(config.env).every(file => path.isAbsolute(file)));

  const folder = await mkdtemp(path.join(tmpdir(), 'videosave-mcp-config-'));
  let server;
  let child;
  let closed;
  t.after(async () => {
    try {
      if (child) {
        child.stdin.end();
        await closed;
      }
    } finally {
      if (server) {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
      await rm(folder, {recursive:true, force:true, maxRetries:5});
    }
  });
  const fixture = path.join(folder, 'fixture.mp4');
  execFileSync(config.env.FFMPEG_BIN, ['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10',
    '-t','2','-c:v','libx264','-movflags','+faststart',fixture], {windowsHide:true});
  const bytes = await readFile(fixture);
  server = createServer((req,res) => res.writeHead(200, {
    'content-type':'video/mp4','content-length':bytes.length,
  }).end(bytes)).listen(0, '127.0.0.1');
  await once(server, 'listening');

  const env = {...process.env, ...config.env, MEDIA_TOOLKIT_URL:'', OUT_DIR:path.join(folder, 'output'),
    MEDIA_TOOLKIT_SETTINGS:path.join(folder, 'settings.sqlite')};
  for (const name of Object.keys(env)) if (/^path$/i.test(name)) delete env[name];
  env.Path = path.join(process.env.SystemRoot, 'System32');
  child = spawn(config.command, config.args, {cwd:folder, env, windowsHide:true, stdio:['pipe','pipe','inherit'], signal:t.signal});
  closed = once(child, 'close');
  const replies = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({id,jsonrpc:'2.0',method,params}) + '\n');
    const reply = JSON.parse((await replies.next()).value);
    assert.equal(reply.id,id);
    assert.ok(reply.result && !reply.result.isError,JSON.stringify(reply));
    return reply.result.structuredContent ?? reply.result;
  }
  await call('initialize',{protocolVersion:'2025-11-25'});
  const tool = (name,args) => call('tools/call',{name,arguments:args});
  const url = `http://127.0.0.1:${server.address().port}/fixture.mp4`;
  const {id} = await tool('start_download',{items:[{kind:'stream',url,title:'First download'}]});
  const [item] = (await tool('wait_for_download',{id,timeoutMs:10_000})).items;
  assert.equal(item.status,'done',JSON.stringify(item));
  assert.deepEqual([item.info.duration,item.info.width,item.info.height],[2,160,90]);
  assert.ok((await readFile(item.file)).length > 0);

  if (process.arch === 'x64') {
    const appData = path.join(folder,'Windows user');
    const cache = path.join(appData,'VideoSave','tools');
    const nodeDir = path.join(cache,'node-v24.22.3-win-x64');
    const ffmpegDir = path.join(cache,'ffmpeg-8.1.2-essentials_build','bin');
    await Promise.all([mkdir(nodeDir,{recursive:true}),mkdir(ffmpegDir,{recursive:true})]);
    const ffmpeg = path.join(ffmpegDir,'ffmpeg.exe');
    const ffprobe = path.join(ffmpegDir,'ffprobe.exe');
    await Promise.all([copyFile(config.command,path.join(nodeDir,'node.exe')),copyFile(config.env.FFMPEG_BIN,ffmpeg),
      copyFile(config.env.FFPROBE_BIN,ffprobe)]);
    const isolated = {...setupEnv, LOCALAPPDATA:appData, HTTP_PROXY:'http://127.0.0.1:1', HTTPS_PROXY:'http://127.0.0.1:1'};
    for (const name of Object.keys(isolated)) if (/^(path|ffmpeg_bin|ffprobe_bin|no_proxy)$/i.test(name)) delete isolated[name];
    isolated.Path = env.Path;
    for (const version of ['previous','next']) {
      const unpacked = path.join(folder,version);
      await mkdir(path.join(unpacked,'tools'),{recursive:true});
      await Promise.all(['Start VideoSave.cmd','tools/start-windows.ps1'].map(file =>
        copyFile(path.join(project,file),path.join(unpacked,file))));
      const launch = spawnSync(process.env.ComSpec,
        ['/d','/s','/c','"call "Start VideoSave.cmd" -McpConfig -SkipPlatform"'], {
          cwd:unpacked,env:isolated,encoding:'utf8',input:'',windowsHide:true,windowsVerbatimArguments:true,timeout:12_000,
        });
      assert.equal(launch.status,0,launch.stderr);
      const cached = JSON.parse(launch.stdout).mcpServers.videosave;
      assert.equal(await realpath(cached.command),await realpath(path.join(nodeDir,'node.exe')));
      assert.deepEqual(Object.keys(cached.env).sort(),['FFMPEG_BIN','FFPROBE_BIN']);
      assert.equal(await realpath(cached.env.FFMPEG_BIN),await realpath(ffmpeg));
      assert.equal(await realpath(cached.env.FFPROBE_BIN),await realpath(ffprobe));
      assert.doesNotMatch(launch.stderr,/Downloading/);
    }

    await mkdir(path.join(folder,'tools'));
    await copyFile(path.join(project,'Start VideoSave.cmd'),path.join(folder,'Start VideoSave.cmd'));
    await copyFile(path.join(project,'tools','start-windows.ps1'),path.join(folder,'tools','start-windows.ps1'));
    await writeFile(path.join(folder,'tools','setup-platform-downloads.mjs'),'process.exitCode = 1;\n');
    const setup = spawnSync(process.env.ComSpec,
      ['/d','/s','/c','"call "Start VideoSave.cmd" -McpConfig"'], {
        cwd:folder,env:{...setupEnv,...config.env,PROCESSOR_ARCHITECTURE:'AMD64'},encoding:'utf8',input:'',
        windowsHide:true,windowsVerbatimArguments:true,timeout:15_000,
      });
    assert.equal(setup.status,0,setup.stderr);
    const degraded = JSON.parse(setup.stdout).mcpServers.videosave;
    assert.deepEqual(degraded.args,[path.join(await realpath(folder),'tools','mcp-server.mjs')]);
    assert.deepEqual(degraded.env,config.env);
    assert.match(setup.stderr,/platform downloads are unavailable/i);
  }

  const sharedOutput = execFileSync(process.env.ComSpec,
    ['/d','/s','/c','"call "Start VideoSave.cmd" -SetupOnly -McpConfig -SharedQueue -SkipPlatform"'], {
      cwd:project, env:{...setupEnv,PORT:'8766',MEDIA_TOOLKIT_SETTINGS:env.MEDIA_TOOLKIT_SETTINGS},
      encoding:'utf8', input:'', windowsHide:true, windowsVerbatimArguments:true, timeout:15_000,
    });
  const shared = JSON.parse(sharedOutput).mcpServers.videosave;
  assert.equal(shared.env.MEDIA_TOOLKIT_URL,'http://127.0.0.1:8766');
  assert.equal(shared.env.MEDIA_TOOLKIT_LOCAL_PAIRING,'1');
  assert.equal(shared.env.MEDIA_TOOLKIT_SETTINGS,env.MEDIA_TOOLKIT_SETTINGS);
  assert.equal(shared.env.MEDIA_TOOLKIT_TOKEN,undefined);

  async function runCompanion(expectedCode) {
    const cmp = spawn(process.env.ComSpec,['/d','/s','/c','"call "Start VideoSave.cmd" -SkipPlatform"'],{
      cwd:project,env:{...setupEnv,PORT:'0',MEDIA_TOOLKIT_SETTINGS:env.MEDIA_TOOLKIT_SETTINGS,MEDIA_TOOLKIT_TOKEN:'',
        OUT_DIR:env.OUT_DIR},windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','inherit'],
    });
    const stopped = once(cmp,'close');
    try {
      const lines = createInterface({input:cmp.stdout})[Symbol.asyncIterator]();
      const first = (await lines.next()).value;
      const second = (await lines.next()).value;
      const endpoint = first?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      const code = second?.match(/ [A-Za-z0-9_-]{32}$/)?.[0].slice(1);
      assert.ok(endpoint && code);
      if (expectedCode) assert.ok(code === expectedCode, 'Pairing changed on companion restart');
      const response = await fetch(endpoint+'/api/health',{headers:{Authorization:'Bearer '+code},signal:t.signal});
      assert.equal(response.status,200);
      const sharedMcp = spawn(shared.command,shared.args,{cwd:folder,windowsHide:true,
        env:{...env,...shared.env,MEDIA_TOOLKIT_URL:endpoint,MEDIA_TOOLKIT_TOKEN:''},stdio:['pipe','pipe','inherit']});
      const sharedClosed = once(sharedMcp,'close');
      try {
        const sharedReplies = createInterface({input:sharedMcp.stdout})[Symbol.asyncIterator]();
        const request = (id,method,params) => JSON.stringify({id,jsonrpc:'2.0',method,params}) + '\n';
        sharedMcp.stdin.write(request(1,'initialize',{protocolVersion:'2025-11-25'}));
        assert.equal(JSON.parse((await sharedReplies.next()).value).id,1);
        sharedMcp.stdin.write(request(2,'tools/call',{name:'list_batches',arguments:{}}));
        const response = JSON.parse((await sharedReplies.next()).value).result;
        assert.ok(!response.isError,JSON.stringify(response));
        assert.equal(response.structuredContent.items[0].id,id);
        assert.equal(response.structuredContent.items[0].status,'done');
      } finally {
        sharedMcp.stdin.end();
        await sharedClosed;
      }
      return code;
    } finally {
      if (cmp.exitCode === null) execFileSync('taskkill.exe',['/PID',String(cmp.pid),'/T','/F'],{windowsHide:true});
      await stopped;
    }
  }
  await runCompanion(await runCompanion());
});
