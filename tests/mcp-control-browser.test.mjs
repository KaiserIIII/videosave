import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, withEdge } from '../tools/edge-session.mjs';

test('Edge approves an MCP tab grant and saves a verified file through stdio', {timeout:90_000}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'videosave-mcp-edge-'));
  const signal = AbortSignal.timeout(85_000);
  const token = 'test-only-video-save-pairing';
  const login = 'fixture=local-test-login';
  const env = {...process.env,PORT:'0',MEDIA_TOOLKIT_TOKEN:token,MEDIA_TOOLKIT_SETTINGS:path.join(dir,'settings.sqlite'),
    OUT_DIR:path.join(dir,'downloads')};
  const children = [];
  const launch = (file,extra = {}) => {
    const child = spawn(process.execPath,[file],{env:{...env,...extra},stdio:['pipe','pipe','inherit'],windowsHide:true});
    children.push({child,closed:once(child,'close')});
    return createInterface({input:child.stdout})[Symbol.asyncIterator]();
  };
  const nativeCookies = [];
  let mediaUrl;
  let bytes;
  const origin = createServer((req,res) => {
    if (req.url === '/film.mp4') {
      if (req.headers['user-agent']?.startsWith('VideoSave') || !req.headers['sec-fetch-mode']) nativeCookies.push(req.headers.cookie);
      return res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length}).end(bytes);
    }
    if (req.url === '/login') return res.writeHead(302,{'set-cookie':login + '; Path=/; HttpOnly; SameSite=Strict',location:'/watch'}).end();
    if (req.url === '/watch' && req.headers.cookie === login) {
      return res.writeHead(200,{'content-type':'text/html'}).end('<title>VideoSave QA film</title><video width="640" controls muted autoplay preload="auto" src="/film.mp4"></video>');
    }
    if (req.url === '/watch') return res.writeHead(401).end('Sign in');
    return res.writeHead(404).end();
  });
  async function until(fn) {
    while (!signal.aborted) {
      const result = await fn();
      if (result) return result;
      await sleep(160,null,{signal});
    }
    signal.throwIfAborted();
  }
  try {
    const film = path.join(dir,'film.mp4');
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=15',
      '-f','lavfi','-i','sine=frequency=500','-t','2','-c:v','libx264','-c:a','aac','-movflags','+faststart',film],{windowsHide:true,timeout:15000});
    bytes = await readFile(film);
    origin.listen(0,'127.0.0.1');
    await once(origin,'listening');
    mediaUrl = 'http://127.0.0.1:' + origin.address().port;
    const ready = await launch('tools/server.mjs').next();
    const endpoint = ready.value.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const admin = async (route,data) => {
      const response = await fetch(endpoint + '/api/ai/' + route,{method:data ? 'POST' : 'GET',
        headers:{authorization:'Bearer ' + token,...(data && {'content-type':'application/json'})},
        ...(data && {body:JSON.stringify(data)})});
      const result = await response.json();
      assert.ok(response.ok,JSON.stringify(result));
      return result;
    };
    const profile = await admin('clients',{name:'VideoSave QA',preset:'standard'});
    const lines = launch('tools/mcp-server.mjs',{MEDIA_TOOLKIT_URL:endpoint,MEDIA_TOOLKIT_MCP_CLIENT:profile.id});
    const mcp = children.at(-1).child;
    let callId = 0;
    async function rpc(method,params) {
      const id = ++callId;
      mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      const reply = JSON.parse((await lines.next()).value);
      assert.equal(reply.id,id);
      assert.ok(!reply.error,JSON.stringify(reply));
      return reply.result;
    }
    const call = async (name,args = {}) => (await rpc('tools/call',{name,arguments:args})).structuredContent;
    await rpc('initialize',{protocolVersion:'2025-11-25'});
    assert.ok((await rpc('tools/list',{})).tools.some(tool => tool.name === 'probe_active_tab'));
    const grant = await call('request_site_authorization',{origin:mediaUrl});

    await withEdge(['--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--autoplay-policy=no-user-gesture-required','--load-extension=' + path.resolve('extension')],
    async ({list,browserUrl}) => {
      const workerTarget = await until(async () => (await list()).find(row => row.type === 'service_worker' && row.url.endsWith('/background.mjs')));
      const pageTarget = (await list()).find(row => row.url === 'about:blank');
      const browser = await connectCdp(browserUrl,signal);
      const worker = await connectCdp(workerTarget.webSocketDebuggerUrl,signal);
      const page = await connectCdp(pageTarget.webSocketDebuggerUrl,signal);
      let popup;
      try {
        await until(() => worker.evaluate('Boolean(globalThis.chrome?.storage?.local)'));
        await worker.evaluate('chrome.storage.local.set(' + JSON.stringify({connection:{endpoint,token}}) + ')');
        await page.send('Page.navigate',{url:mediaUrl + '/login'});
        await until(() => page.evaluate('Boolean(document.querySelector("video")?.currentTime > 0.1)').catch(() => false));
        const {targetId} = await browser.send('Target.createTarget',{url:new URL('/popup.html',workerTarget.url).href,background:true});
        const target = await until(async () => (await list()).find(row => row.id === targetId));
        popup = await connectCdp(target.webSocketDebuggerUrl,signal);
        await page.send('Page.bringToFront');
        await popup.send('Page.reload');
        await until(() => popup.evaluate('document.querySelectorAll("#media li").length > 0').catch(() => false));
        await popup.evaluate('document.querySelector("#settings-toggle").click(); document.querySelector("#mcp-center").open = true; true');
        await until(() => popup.evaluate('document.querySelector("#mcp-grants button")?.textContent.includes("授权当前页") || document.querySelector("#mcp-grants button")?.textContent.includes("Approve")'));
        await popup.evaluate('document.querySelector("[data-mcp-policy=download]").click(); document.querySelector("#mcp-save-policy").click(); true');
        await until(async () => (await admin('site?origin=' + encodeURIComponent(mediaUrl))).settings.download);
        await until(() => popup.evaluate('!document.querySelector("#mcp-save-policy").disabled'));
        await popup.evaluate('document.querySelector("#mcp-grants button").click(); true');
        await until(async () => (await call('get_authorization_status',{id:grant.id})).status === 'approved');

        const result = await call('probe_active_tab',{authorizationId:grant.id});
        assert.equal(result.tab.title,'VideoSave QA film');
        assert.equal(result.streams.length,1);
        assert.ok(!JSON.stringify(result).includes(login));
        const batch = await call('start_download',{authorizationId:grant.id,items:[{candidateId:result.streams[0].candidateId}]});
        const saved = await call('wait_for_download',{id:batch.id,timeoutMs:20_000});
        assert.equal(saved.status,'done',JSON.stringify(saved));
        const verified = await call('verify_download',{id:batch.id});
        const output = verified.items[0].file;
        const inspect = JSON.parse(execFileSync(process.env.FFPROBE_BIN || 'ffprobe',
          ['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',output],{encoding:'utf8',windowsHide:true}));
        assert.deepEqual(inspect.streams.map(row => row.codec_type).sort(),['audio','video']);
        assert.ok(Math.abs(Number(inspect.format.duration)-2)<0.15);
        assert.ok(nativeCookies.length > 0, 'companion fetched the media independently');
        assert.deepEqual([...new Set(nativeCookies)],[undefined]);
        assert.ok(!(JSON.stringify(await admin('activity'))).includes(login));
        if (process.env.VIDEOSAVE_MCP_SCREENSHOT) {
          await popup.send('Emulation.setDeviceMetricsOverride',{width:472,height:560,deviceScaleFactor:1,mobile:false});
          await popup.evaluate('document.querySelector("#mcp-center").scrollIntoView()');
          const image = await popup.send('Page.captureScreenshot',{format:'png'});
          await writeFile(process.env.VIDEOSAVE_MCP_SCREENSHOT,Buffer.from(image.data,'base64'));
        }
        await page.send('Page.navigate',{url:mediaUrl + '/other'});
        await until(async () => (await call('get_authorization_status',{id:grant.id})).status === 'revoked');
        assert.equal((await call('probe_active_tab',{authorizationId:grant.id})).code,'MCP_TAB_REQUIRED');
      } finally {
        popup?.close();
        page.close();
        worker.close();
        browser.close();
      }
    },signal);
  } finally {
    origin.close();
    origin.closeAllConnections();
    for (const {child,closed} of children.reverse()) {
      child.kill();
      await closed;
    }
    await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:150});
  }
});
