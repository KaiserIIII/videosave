import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, withChromium, withEdge } from '../tools/edge-session.mjs';
import { executable } from './compatibility-browsers.mjs';

test('Edge shares a login only after approval and saves a verified file through MCP', {timeout:90_000},
  context => verifyBrowserAuthorization(context, 'edge', withEdge));

test('Chrome shares a login only after approval and saves a verified file through MCP', {timeout:90_000}, context => {
  const chrome = executable('chrome');
  assert.ok(chrome, 'Chrome is required for this test. Set CHROME_BIN to its executable path.');
  return verifyBrowserAuthorization(context, 'chrome',
    (args, run, signal) => withChromium(args, run, signal, {executable:chrome}));
});

async function verifyBrowserAuthorization(context, browserName, launchBrowser) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'videosave-mcp-' + browserName + '-'));
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
  const companionMedia = [];
  let mediaRedirect;
  let receivedRedirect = 0;
  const destination = createServer((_req,res) => {
    receivedRedirect++;
    res.writeHead(200,{'content-type':'video/mp4'}).end(bytes);
  });
  let mediaUrl;
  let bytes;
  const hls = new Map();
  const origin = createServer((req,res) => {
    if (hls.has(req.url)) return res.writeHead(200,{'content-type':req.url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'}).end(hls.get(req.url));
    if (req.url === '/film.mp4' || req.url === '/film.mp4?ticket=fixture-session') {
      if (req.headers['user-agent']?.startsWith('VideoSave') || !req.headers['sec-fetch-mode']) {
        nativeCookies.push(req.headers.cookie);
        companionMedia.push(req.url);
      }
      if (req.headers.cookie !== login) return res.writeHead(401).end('Sign in');
      if (req.url.includes('ticket=') && (req.headers.referer !== mediaUrl+'/watch' || !/Edg\//.test(req.headers['user-agent'] ?? ''))) {
        return res.writeHead(403).end('Expected the same approved playback context');
      }
      if (mediaRedirect) return res.writeHead(302,{location:mediaRedirect}).end();
      return res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length}).end(bytes);
    }
    if (req.url === '/login') return res.writeHead(302,{'set-cookie':login + '; Path=/; HttpOnly; SameSite=Strict',location:'/watch'}).end();
    if (req.url === '/watch' && req.headers.cookie === login) {
      return res.writeHead(200,{'content-type':'text/html'}).end('<title>VideoSave QA film</title><video width="640" controls muted autoplay preload="auto" src="/film.mp4"></video>');
    }
    if (req.url === '/empty') return res.writeHead(200,{'content-type':'text/html'}).end('<title>Waiting for player</title>');
    if (req.url === '/watch') return res.writeHead(401).end('Sign in');
    return res.writeHead(404).end();
  });
  async function until(fn, describe = () => 'waiting for browser state') {
    const deadline = Date.now() + 12_000;
    while (!signal.aborted && Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await sleep(160,null,{signal});
    }
    throw new Error(await describe());
  }
  try {
    const film = path.join(dir,'film.mp4');
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=15',
      '-f','lavfi','-i','sine=frequency=500','-t','2','-c:v','libx264','-g','15','-sc_threshold','0','-c:a','aac','-movflags','+faststart',film],{windowsHide:true,timeout:15000});
    bytes = await readFile(film);
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg',['-v','error','-i',film,'-c','copy',
      '-hls_time','1','-hls_list_size','0','public.m3u8'],{cwd:dir,windowsHide:true,timeout:15000});
    for (const file of ['public.m3u8','public0.ts','public1.ts']) hls.set('/'+file,await readFile(path.join(dir,file)));
    const key = Buffer.alloc(16,1);
    const iv = Buffer.alloc(16,2);
    hls.set('/local-aes.key',key);
    const encryptedPlaylist = hls.get('/public.m3u8').toString().replace('#EXTINF:',
      `#EXT-X-KEY:METHOD=AES-128,URI="local-aes.key",IV=0x${iv.toString('hex')}\n#EXTINF:`).replaceAll('public','encrypted');
    hls.set('/encrypted.m3u8',Buffer.from(encryptedPlaylist));
    for (const i of [0,1]) {
      const cipher = createCipheriv('aes-128-cbc',key,iv);
      hls.set(`/encrypted${i}.ts`,Buffer.concat([cipher.update(hls.get(`/public${i}.ts`)),cipher.final()]));
    }
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
    const {tools} = await rpc('tools/list',{});
    assert.ok(tools.some(tool => tool.name === 'probe_active_tab'));
    assert.ok(tools.every(tool => tool.outputSchema?.type === 'object'));
    const grant = await call('request_site_authorization',{origin:mediaUrl});

    const extension = path.resolve('extension');
    await launchBrowser(['--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--autoplay-policy=no-user-gesture-required','--load-extension=' + extension],
    async ({list,browserUrl}) => {
      const browser = await connectCdp(browserUrl,signal);
      let worker, page, popup;
      try {
        const {product, userAgent} = await browser.send('Browser.getVersion');
        context.diagnostic(product);
        assert.equal(/\bEdg\//.test(userAgent), browserName === 'edge', userAgent);
        const findWorker = async () => (await list()).find(row => row.type === 'service_worker' &&
          row.url.startsWith('chrome-extension:') && row.url.endsWith('/background.mjs'));
        if (browserName === 'chrome' && !(await findWorker())) {
          // Chrome stable may ignore --load-extension.
          await browser.send('Extensions.loadUnpacked',{path:extension}).catch(() => {});
        }
        const workerTarget = await until(findWorker, () => 'waiting for VideoSave extension');
        const pageTarget = await until(async () => (await list()).find(row => row.url === 'about:blank'));
        worker = await connectCdp(workerTarget.webSocketDebuggerUrl,signal);
        page = await connectCdp(pageTarget.webSocketDebuggerUrl,signal);
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
        await until(async () => (await call('get_authorization_status',{id:grant.id})).status === 'approved',
          () => popup.evaluate('document.querySelector("#mcp-message").textContent || "waiting for approval"'));

        const result = await call('probe_active_tab',{authorizationId:grant.id});
        assert.equal(result.tab.title,'VideoSave QA film');
        assert.equal(result.streams.length,1);
        assert.equal(result.tab.sessionShared,false);
        assert.ok(!JSON.stringify(result).includes(login));
        const deniedBatch = await call('start_download',{authorizationId:grant.id,items:[{candidateId:result.streams[0].candidateId}]});
        const denied = await call('wait_for_download',{id:deniedBatch.id,timeoutMs:20_000});
        assert.equal(denied.items[0].errorCode,'MCP_MEDIA_ACCESS_RESTRICTED');
        assert.deepEqual([...new Set(nativeCookies)],[undefined]);

        const grantWithLogin = await call('request_site_authorization',{origin:mediaUrl});
        await popup.evaluate('document.querySelector("#mcp-refresh").click(); true');
        const approveButton = 'Array.from(document.querySelectorAll("#mcp-grants button")).find(button => /授权当前页|Approve/.test(button.textContent))';
        await until(() => popup.evaluate('Boolean(' + approveButton + ')'));
        await popup.send('Runtime.evaluate',{expression:'document.querySelector("#mcp-share-session").click(); (' + approveButton + ').click();',
          userGesture:true,awaitPromise:true});
        await until(async () => (await call('get_authorization_status',{id:grantWithLogin.id})).status === 'approved',
          () => popup.evaluate('document.querySelector("#mcp-message").textContent || "waiting for browser cookie permission"'));
        const shared = await call('probe_active_tab',{authorizationId:grantWithLogin.id});
        assert.equal(shared.tab.sessionShared,true);
        assert.ok(!JSON.stringify(shared).includes(login));

        const batch = await call('start_download',{authorizationId:grantWithLogin.id,items:[{candidateId:shared.streams[0].candidateId}]});
        const saved = await call('wait_for_download',{id:batch.id,timeoutMs:20_000});
        assert.equal(saved.status,'done',JSON.stringify(saved));
        const verified = await call('verify_download',{id:batch.id});
        assert.equal(verified.items[0].verification[0].status,'verified');
        const output = verified.items[0].file;
        const inspect = JSON.parse(execFileSync(process.env.FFPROBE_BIN || 'ffprobe',
          ['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',output],{encoding:'utf8',windowsHide:true}));
        assert.deepEqual(inspect.streams.map(row => row.codec_type).sort(),['audio','video']);
        assert.ok(Math.abs(Number(inspect.format.duration)-2)<0.15);
        assert.ok(nativeCookies.length > 0, 'companion fetched the media independently');
        assert.deepEqual([...new Set(nativeCookies)],[undefined,login]);
        assert.ok(!(JSON.stringify(await admin('activity'))).includes(login));

        const otherProfile = await admin('clients',{name:'No activity yet',preset:'read-only'});
        const error = await call('get_progress');
        assert.equal(error.code,'MCP_INVALID_ARGUMENTS');
        await popup.evaluate('document.querySelector("#mcp-refresh").click(); true');
        const failedActivity = 'document.querySelector("#mcp-activity").textContent.includes("MCP_INVALID_ARGUMENTS")';
        await until(() => popup.evaluate(failedActivity),
          () => 'waiting for audit refresh after a failed tool call');
        assert.ok(await popup.evaluate('document.querySelector("#mcp-activity").textContent.includes(' + JSON.stringify(batch.id) + ')'));
        await until(() => popup.evaluate('Boolean(document.querySelector("#mcp-clients time"))'),
          () => 'waiting for the client’s latest recorded activity');
        const filter = async (id,value) => popup.evaluate(
          '((control) => {control.value = ' + JSON.stringify(value) + '; control.dispatchEvent(new Event("change")); true})(document.querySelector(' +
          JSON.stringify(id) + '))');
        await filter('#mcp-audit-result','failure');
        assert.match(await popup.evaluate('document.querySelector("#mcp-activity").textContent'),/get_progress.*MCP_INVALID_ARGUMENTS/);
        assert.doesNotMatch(await popup.evaluate('document.querySelector("#mcp-activity").textContent'),/start_download/);
        await filter('#mcp-audit-client',otherProfile.id);
        assert.equal(await popup.evaluate('document.querySelector("#mcp-activity").childElementCount'),0);
        await filter('#mcp-audit-client',profile.id);
        assert.ok(await popup.evaluate(failedActivity));
        await filter('#mcp-audit-result','success');
        assert.equal(await popup.evaluate(failedActivity),false);

        if (browserName === 'edge' && process.env.VIDEOSAVE_MCP_SCREENSHOT) {
          await popup.send('Emulation.setDeviceMetricsOverride',{width:472,height:560,deviceScaleFactor:1,mobile:false});
          await popup.evaluate('document.querySelector("#mcp-center").scrollIntoView()');
          const image = await popup.send('Page.captureScreenshot',{format:'png'});
          await writeFile(process.env.VIDEOSAVE_MCP_SCREENSHOT,Buffer.from(image.data,'base64'));
        }
        destination.listen(0,'127.0.0.1');
        await once(destination,'listening');
        mediaRedirect = 'http://127.0.0.1:' + destination.address().port + '/film.mp4';
        const redirectedBatch = await call('start_download',{authorizationId:grantWithLogin.id,items:[{candidateId:shared.streams[0].candidateId}]});
        const redirected = await call('wait_for_download',{id:redirectedBatch.id,timeoutMs:20_000});
        assert.equal(redirected.items[0].errorCode,'MCP_MEDIA_REDIRECT');
        assert.equal(receivedRedirect,0);
        mediaRedirect = undefined;
        await rm(output);
        const missing = await call('verify_download',{id:batch.id});
        assert.equal(missing.items[0].verification[0].errorCode,'FILE_NOT_FOUND');
        await page.send('Page.reload');
        await until(async () => (await call('get_authorization_status',{id:grantWithLogin.id})).status === 'revoked',
          () => 'waiting for revocation after reloading the same URL');
        assert.equal((await call('probe_active_tab',{authorizationId:grantWithLogin.id})).code,'MCP_TAB_REQUIRED');
        const publicGrant = await call('request_site_authorization',{origin:mediaUrl});
        await admin('approve',{id:publicGrant.id,singleTask:true,tab:{url:mediaUrl,streams:[{url:mediaUrl+'/public.m3u8',kind:'m3u8'}]}});
        const publicTab = await call('probe_active_tab',{authorizationId:publicGrant.id});
        const hlsBatch = await call('start_download',{authorizationId:publicGrant.id,items:[{candidateId:publicTab.streams[0].candidateId}]});
        const savedHls = await call('wait_for_download',{id:hlsBatch.id,timeoutMs:20_000});
        assert.equal(savedHls.status,'done',JSON.stringify(savedHls));
        assert.ok(savedHls.items[0].prefetch);
        assert.ok(savedHls.items[0].info.audioCodec);
        assert.equal((await call('start_download',{authorizationId:publicGrant.id,items:[{candidateId:publicTab.streams[0].candidateId}]})).code,'MCP_AUTHORIZATION_USED');

        if (browserName === 'edge') {
          await admin('revoke',{id:publicGrant.id});
          const aesGrant = await call('request_site_authorization',{origin:mediaUrl});
          await admin('approve',{id:aesGrant.id,singleTask:true,tab:{url:mediaUrl,streams:[{url:mediaUrl+'/encrypted.m3u8',kind:'m3u8'}]}});
          const aesTab = await call('probe_active_tab',{authorizationId:aesGrant.id});
          const aesBatch = await call('start_download',{authorizationId:aesGrant.id,items:[{candidateId:aesTab.streams[0].candidateId}]});
          const aes = await call('wait_for_download',{id:aesBatch.id,timeoutMs:20_000});
          assert.equal(aes.status,'done',JSON.stringify(aes));
          assert.ok(aes.items[0].info.audioCodec && aes.items[0].info.codec);
          assert.equal(aes.items[0].info.duration,savedHls.items[0].info.duration);
          await admin('revoke',{id:aesGrant.id});
          await popup.evaluate('window.confirm = () => true; document.querySelector("#mcp-refresh").click(); true');
          const edit = 'Array.from(document.querySelectorAll("#mcp-clients li")).find(row => row.querySelector("strong").textContent === "VideoSave QA").querySelector("button")';
          await popup.evaluate(edit + '.click(); true');
          await until(() => popup.evaluate('document.querySelector("#mcp-client-name").value === "VideoSave QA"'));
          await popup.evaluate('document.querySelector("#mcp-full-access").click(); true');
          await until(() => popup.evaluate('!document.querySelector("#mcp-trust").hidden'));
          await popup.send('Runtime.evaluate',{expression:`
            document.querySelector('#mcp-trusted-origins').value = ${JSON.stringify(mediaUrl)};
            document.querySelector('#mcp-trust-session').checked = true;
            document.querySelector('#mcp-trust-download').checked = true;
            document.querySelector('#mcp-privacy').checked = true;
            document.querySelector('#mcp-save-trust').click();
          `,userGesture:true});
          await until(async () => (await admin('access?id=' + profile.id)).privacy,
            () => popup.evaluate('document.querySelector("#mcp-message").textContent'));
          await until(() => worker.evaluate('chrome.storage.local.get("standingMcp").then(state => state.standingMcp)'));
          const standing = await call('request_site_authorization',{origin:mediaUrl});
          assert.equal(standing.automatic,true);
          await popup.evaluate('chrome.runtime.sendMessage({type:"videosave-standing-mcp"}).catch(() => {})');
          await until(async () => (await call('get_authorization_status',{id:standing.id})).status === 'approved');
          const before = await call('probe_active_tab',{authorizationId:standing.id});
          const originalId = before.streams[0]?.candidateId;
          await page.evaluate('document.querySelector("video").src = "/film.mp4?ticket=fixture-session"; true');
          const signedUrl = mediaUrl + '/film.mp4?ticket=fixture-session';
          await until(() => worker.evaluate('chrome.storage.session.get(null).then(rows => Object.values(rows).flat().some(row => row?.url === ' + JSON.stringify(signedUrl) + '))'));
          await popup.evaluate('chrome.runtime.sendMessage({type:"videosave-standing-mcp"}).catch(() => {})');
          const next = await until(async () => {
            const current = await call('probe_active_tab',{authorizationId:standing.id});
            if (!current.streams.length || !current.tab.sessionShared) return false;
            const selected = await call('select_media',{authorizationId:standing.id});
            return selected.status === 'selected' && selected.candidateId !== originalId ? selected : false;
          },async () => JSON.stringify({tab:await call('probe_active_tab',{authorizationId:standing.id}),
            selected:await call('select_media',{authorizationId:standing.id})}));
          assert.ok(next.candidateId);
          const automatic = await call('start_auto_download',{authorizationId:standing.id});
          assert.ok(automatic.id,JSON.stringify(automatic));
          assert.equal((await call('wait_for_download',{id:automatic.id,timeoutMs:20_000})).status,'done');
          assert.equal(companionMedia.at(-1),'/film.mp4?ticket=fixture-session');
          assert.equal((await admin('activity')).items.some(row => row.client === profile.id),false);
          const state = new DatabaseSync(env.MEDIA_TOOLKIT_SETTINGS,{readOnly:true});
          try {
            assert.equal(state.prepare('SELECT id FROM download_batches WHERE id = ?').get(automatic.id),undefined);
          } finally { state.close(); }
          await browser.send('Storage.clearCookies');
          await until(async () => (await call('get_authorization_status',{id:standing.id})).status === 'revoked');
          await page.send('Page.navigate',{url:mediaUrl+'/empty'});
          await until(() => page.evaluate('location.pathname === "/empty" && document.readyState === "complete"'));
          await page.send('Network.setCookie',{name:'fixture',value:'local-test-login',url:mediaUrl,path:'/',httpOnly:true});
          const empty = await call('request_site_authorization',{origin:mediaUrl});
          await popup.evaluate('chrome.runtime.sendMessage({type:"videosave-standing-mcp"}).catch(() => {})');
          await until(async () => (await call('get_authorization_status',{id:empty.id})).status === 'approved');
          assert.equal((await call('probe_active_tab',{authorizationId:empty.id})).streams.length,0);
          await browser.send('Storage.clearCookies');
          await until(async () => (await call('get_authorization_status',{id:empty.id})).status === 'revoked',
            () => 'waiting for revocation after logout before media is observed');
        }
      } finally {
        popup?.close();
        page?.close();
        worker?.close();
        browser.close();
      }
    },signal);
  } finally {
    destination.close();
    destination.closeAllConnections();
    origin.close();
    origin.closeAllConnections();
    for (const {child,closed} of children.reverse()) {
      child.kill();
      await closed;
    }
    await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:150});
  }
}
