
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectCdp, withEdge } from '../tools/edge-session.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const out = await mkdtemp(path.join(project, '.smoke-'));
const browserOut = await mkdtemp(path.join(project, '.browser-smoke-'));
const env = {...process.env, PORT:'0', MEDIA_TOOLKIT_TOKEN:'local-smoke-test', OUT_DIR:out};
const start = file => spawn(process.execPath, [path.join(project, 'tools', file)], {
  env, windowsHide:true, stdio:['pipe','pipe','inherit'],
});
const token = env.MEDIA_TOOLKIT_TOKEN;
const pageUrl = 'https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html';
const browserPage = 'https://www.w3.org/2010/05/video/mediaevents.html';
const hls = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const dash = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const signal = AbortSignal.timeout(360_000);

async function until(get, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const value = await get();
    if (value) return value;
    await sleep(250, undefined, {signal});
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for smoke test condition');
}

function inspectFile(filename) {
  const raw = execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v','error','-of','json','-show_entries',
    'format=duration:stream=width,height',filename], {encoding:'utf8',windowsHide:true});
  const data = JSON.parse(raw);
  const video = data.streams.find(row => row.width > 0 && row.height > 0);
  assert.ok(video && Number(data.format.duration) > 0, JSON.stringify(data));
  return {...video,duration:Number(data.format.duration)};
}

async function testMcp() {
  const proc = start('mcp-server.mjs');
  const exited = once(proc, 'close');
  const lines = createInterface({input:proc.stdout})[Symbol.asyncIterator]();
  const send = (method, params, id) => proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params,id})+'\n');
  const call = async (method,params,id) => {
    send(method,params,id);
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.id,id);
    assert.ok(reply.result,JSON.stringify(reply));
    return reply.result;
  };
  try {
    await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'smoke',version:'1'}},1);
    send('notifications/initialized');
    const result = await call('tools/list',{},2);
    assert.deepEqual(result.tools.map(tool=>tool.name),['probe_page','start_download','get_progress','list_downloads','open_file']);
    assert.deepEqual(result.tools[1].inputSchema.properties.concurrency, {type:'integer',minimum:1,maximum:24,default:10});
    const listing = await call('tools/call',{name:'list_downloads'},3);
    assert.equal(listing.structuredContent.items.length,2);
    console.log('MCP',result.tools.map(tool=>tool.name).join(', '));
  } finally { proc.stdin.end(); await exited; }
}

async function checkPopupLayout(popup) {
  const metrics = {width: 300, height: 360, deviceScaleFactor: 1, mobile: false};
  await popup.send('Emulation.setDeviceMetricsOverride', metrics);
  try {
    const layout = await popup.evaluate(`(() => {
      const list = document.querySelector('#media');
      const footer = document.querySelector('footer');
      const button = list.querySelector('li .actions button:last-child');
      const title = list.querySelector('.media-title');
      title.textContent = '这是一条很长的视频标题'.repeat(8);
      for (let i = 0; i < 15; i++) list.append(list.firstElementChild.cloneNode(true));
      const main = document.querySelector('main');
      return {width: document.documentElement.scrollWidth, buttonRight: button.getBoundingClientRect().right,
        footerBottom: footer.getBoundingClientRect().bottom, scrolls: main.scrollHeight > main.clientHeight,
        titleWraps: title.getBoundingClientRect().height > parseFloat(getComputedStyle(title).lineHeight)};
    })()`);
    assert.ok(layout.width <= metrics.width && layout.buttonRight <= metrics.width, JSON.stringify(layout));
    assert.ok(layout.footerBottom <= metrics.height && layout.scrolls && layout.titleWraps, JSON.stringify(layout));
    console.log('Edge popup narrow viewport', layout);
  } finally {
    await popup.send('Emulation.clearDeviceMetricsOverride');
  }
}

async function checkSettings(popup, worker) {
  assert.equal(await popup.evaluate('document.querySelector("[data-option=concurrency]").value'), '10');
  await worker.evaluate('chrome.storage.local.set({downloadSettings:{concurrency:2}})');
  await popup.send('Page.reload');
  await until(() => popup.evaluate('document.querySelector("[data-option=concurrency]")?.value === "10"').catch(() => false));
  await popup.evaluate('document.querySelector("#settings-toggle").click()');

  const colors = new Set();
  for (const theme of ['system','light','dark','jade','amber']) {
    await popup.evaluate('document.querySelector("#themes input[value=' + theme + ']").click()');
    await until(() => popup.evaluate('document.documentElement.dataset.theme === ' + JSON.stringify(theme)));
    if (theme !== 'system') colors.add(await popup.evaluate('getComputedStyle(document.body).backgroundColor'));
  }
  assert.equal(colors.size, 4);
  await popup.evaluate(String.raw`(() => {
    const folder = document.querySelector('#download-folder');
    folder.value = '视频\\教程';
    folder.dispatchEvent(new Event('change'));
    const accent = document.querySelector('#theme-accent');
    accent.value = '#dd8352';
    accent.dispatchEvent(new Event('change'));
  })()`);
  await until(() => worker.evaluate(`chrome.storage.local.get('downloadSettings').then(({downloadSettings:s}) =>
    s?.theme==='amber' && s?.accent==='#dd8352' && s?.downloadFolder==='视频/教程' && s?.concurrency===10)`));
  await popup.send('Page.reload');
  await until(() => popup.evaluate(`document.documentElement.dataset.theme === 'amber' &&
    document.querySelector('#theme-accent').value === '#dd8352' &&
    document.querySelector('#download-folder').value === '视频/教程'`).catch(() => false));
  await popup.evaluate('document.querySelector("#settings-toggle").click()');
  const measure = 'getComputedStyle(document.body).backgroundColor';
  await popup.evaluate('document.querySelector("#themes input[value=system]").click()');
  await popup.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'dark'}]});
  const dark = await popup.evaluate(measure);
  await popup.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'light'}]});
  assert.notEqual(await popup.evaluate(measure), dark);
  await popup.send('Emulation.setEmulatedMedia', {features:[]});

  const metrics = {width:300,height:450,deviceScaleFactor:1,mobile:false};
  await popup.send('Emulation.setDeviceMetricsOverride', metrics);
  try {
    await popup.evaluate('document.querySelector("#themes input[value=amber]").click()');
    assert.equal(await popup.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const tiles = await popup.evaluate(`[...document.querySelectorAll('.theme-choice')].map(el => ({
      theme:el.dataset.preview, right:el.getBoundingClientRect().right, viewport:innerWidth,
      content:el.scrollWidth, width:el.clientWidth
    }))`);
    assert.ok(tiles.every(tile => tile.right <= tile.viewport && tile.content <= tile.width), JSON.stringify(tiles));
    if (process.env.SMOKE_SETTINGS_SCREENSHOT) {
      const shot = await popup.send('Page.captureScreenshot',{format:'png'});
      await writeFile(process.env.SMOKE_SETTINGS_SCREENSHOT, Buffer.from(shot.data,'base64'));
    }
  } finally {
    await popup.send('Emulation.clearDeviceMetricsOverride');
  }
  await popup.evaluate('document.querySelector("#reset-accent").click()');
  await until(() => worker.evaluate(`chrome.storage.local.get('downloadSettings').then(({downloadSettings:s}) => s?.accent==='')`));
  console.log('Edge settings: 5 themes, follows system color scheme, Chinese folder and custom accent persist, no overflow at 300 px');
}

async function checkBrowserDelivery(popup, worker, endpoint) {
  await checkSettings(popup, worker);
  const customOut = path.join(browserOut, '视频', '教程');
  const fixture = path.join(out, 'fixture.mp4');
  const caption = path.join(out, 'caption.srt');
  await writeFile(caption,'1\n00:00:00,100 --> 00:00:01,800\nA sample subtitle.\n');
  execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=640x480:rate=25','-f','lavfi','-i','sine=frequency=800','-i',caption,
    '-t','2','-c:v','libx264','-c:a','aac','-c:s','mov_text','-movflags','+faststart',fixture], {windowsHide:true});
  const media = await readFile(fixture);
  const padding = Buffer.alloc(8 * 1024 * 1024);
  padding.writeUInt32BE(padding.length);
  padding.write('free', 4);
  const rangeMedia = Buffer.concat([media, padding]);
  const requestedParts = [];
  let fullRequests = 0;
  let responses = 0;
  let maximum = 0;
  const serve = (req, res) => {
    if (req.url.startsWith('/range')) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!range) {
        fullRequests++;
        res.writeHead(200, {'content-type':'video/mp4', 'content-length':rangeMedia.length});
        return res.end(rangeMedia);
      }
      const [, first, last] = range.map(Number);
      if (last > 0) requestedParts.push(req.headers['if-range']);
      res.writeHead(206, {'content-type':'video/mp4', 'content-length':last-first+1, etag:'"large-mp4"',
        'content-range':`bytes ${first}-${last}/${rangeMedia.length}`});
      return res.end(rangeMedia.subarray(first, last+1));
    }
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
    res.writeHead(req.headers.range ? 206 : 200, {'content-type':'video/mp4', 'accept-ranges':'bytes',
      'content-length':media.length-start, ...(req.headers.range &&
        {'content-range':`bytes ${start}-${media.length-1}/${media.length}`})});
    if (!req.url.startsWith('/slow')) {
      setTimeout(() => res.end(media.subarray(start)), 500);
      return;
    }
    responses++;
    maximum = Math.max(maximum, responses);
    let offset = start;
    const timer = setInterval(() => {
      const next = Math.min(media.length, offset + Math.ceil(media.length / 12));
      res.write(media.subarray(offset, next));
      offset = next;
      if (offset === media.length) res.end();
    }, 150);
    res.once('close', () => { responses--; clearInterval(timer); });
  };
  const servers = [createServer(serve), createServer(serve)];
  await Promise.all(servers.map(server => {
    server.listen(0, '127.0.0.1');
    return once(server, 'listening');
  }));
  try {
    const [source] = servers;
    const url = `http://127.0.0.1:${source.address().port}/separate.mp4`;
    const urls = Array.from({length:10}, (_, index) =>
      `http://127.0.0.1:${servers[index % 2].address().port}/slow-burst-${index}.mp4`);
    await popup.evaluate(`chrome.runtime.sendMessage({scope:'media-downloads',action:'enqueue',streams:
      ${JSON.stringify(urls)}.map((url,index)=>({url,title:'十项并发 '+index,kind:'mp4',
        options:{accelerate:false,downloadFolder:'并发验证'}}))})`);
    await until(() => worker.evaluate(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) =>
      downloadJobs.filter(job=>job.title.startsWith('十项并发') && job.state==='done').length===10)`));
    assert.equal(maximum, 10);
    assert.equal((await readdir(path.join(browserOut,'并发验证'))).length, 10);
    maximum = 0;
    console.log('Edge started and saved 10 concurrent downloads');
    await popup.evaluate(`(() => {
      for (const [key, value] of Object.entries({mode:'separate',quality:'360',concurrency:'1',audioFormat:'mp3',subtitles:'true'})) {
        const option = document.querySelector('#settings [data-option="'+key+'"]');
        option.value = value;
        option.dispatchEvent(new Event('change'));
      }
    })()`);
    await until(() => worker.evaluate(`chrome.storage.local.get('downloadSettings')
      .then(({downloadSettings:s})=>s?.quality==='360' && s?.mode==='separate' && s?.concurrency===1 && s?.audioFormat==='mp3' && s?.subtitles)`, 15000));
    await popup.evaluate(`(() => {
      document.querySelector('#themes input[value=light]').click();
      for (const [key, value] of Object.entries({density:'compact',connections:'12',showHost:'true'})) {
        const option = document.querySelector('#settings [data-option="'+key+'"]');
        option.value = value;
        option.dispatchEvent(new Event('change'));
      }
    })()`);
    await until(() => worker.evaluate(`chrome.storage.local.get('downloadSettings')
      .then(({downloadSettings:s})=>s?.theme==='light' && s?.density==='compact' && s?.connections===12 && s?.showHost)`));
    assert.equal(await popup.evaluate('document.documentElement.dataset.theme'), 'light');
    const saveStarted = performance.now();
    await popup.evaluate(`(() => {
      document.querySelector('#videos-toggle').click();
      document.querySelector('#manual-url').value = ${JSON.stringify(url)};
      document.querySelector('#manual').requestSubmit();
    })()`);
    await until(() => worker.evaluate(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) =>
      downloadJobs?.[0]?.title.includes('separate') && downloadJobs[0].state === 'processing')`));
    // The popup normally polls while its Downloads page is visible. Reload into
    // the Videos page so that only the background worker can finish the save.
    await popup.send('Page.reload');
    try {
      await until(() => worker.evaluate(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) =>
        downloadJobs?.[0]?.title.includes('separate') && downloadJobs[0].state === 'done')`), 35000);
    } catch (error) {
      const state = await popup.evaluate('document.body.innerText');
      throw new Error('Browser delivery failed: ' + state, {cause:error});
    }
    const saveTime = Math.round(performance.now() - saveStarted);
    console.log('Edge processed download and save:', saveTime, 'ms');
    if (process.argv.includes('--delivery-only')) {
      assert.ok(saveTime < 10000, `Processed files took ${saveTime} ms to reach Edge downloads`);
    }
    const listing = await readdir(customOut);
    const files = listing.filter(file => file.startsWith('separate'));
    assert.equal(files.length,2,JSON.stringify(listing));
    assert.ok(!(await readdir(out)).some(file=>file.startsWith('separate')));
    for (const name of files) {
      const result = execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v','error','-of','json','-show_entries',
        'stream=codec_type,height',path.join(customOut,name)], {encoding:'utf8',windowsHide:true});
      assert.deepEqual(JSON.parse(result).streams, name.endsWith('.mp3')
        ? [{codec_type:'audio'}] : [{codec_type:'video',height:360},{codec_type:'subtitle'}]);
    }
    console.log('Edge browser delivery in custom subfolder', files);
    await popup.evaluate('document.querySelector("#downloads-toggle").click()');
    await popup.evaluate(`chrome.runtime.sendMessage({scope:'media-downloads',action:'enqueue',streams:[1,2].map(i=>({
      title:'队列测试 '+i,kind:'mp4',url:${JSON.stringify(new URL('.',url).href)}+'slow'+i+'.mp4',
      options:{mode:'combined',quality:'',format:'auto',subtitles:false,accelerate:false}
    }))})`);
    await until(() => popup.evaluate(`document.querySelector('#queue li[data-state="queued"]') &&
      document.querySelector('#queue li[data-state="downloading"] progress') !== null`));
    await until(() => popup.evaluate(`[...document.querySelectorAll('#queue li[data-state="done"]')]
      .filter(row=>row.textContent.includes('队列测试')).length===2`));
    assert.equal(maximum,1);
    console.log('Edge queue showed progress and held the second download until the first completed');

    const rangeUrl = new URL('range.mp4', url).href;
    await popup.evaluate(`chrome.runtime.sendMessage({scope:'media-downloads',action:'enqueue',streams:[{
      title:'Parallel MP4',kind:'mp4',url:${JSON.stringify(rangeUrl)},
      options:{mode:'combined',quality:'',format:'auto',subtitles:false}
    }]})`);
    await until(() => worker.evaluate(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) =>
      downloadJobs?.[0]?.title === 'Parallel MP4' && downloadJobs[0].state === 'done' && !!downloadJobs[0].batch)`));
    const downloaded = path.join(customOut, 'Parallel MP4.mp4');
    assert.deepEqual(await readFile(downloaded), rangeMedia);
    assert.deepEqual(inspectFile(downloaded), {width:640,height:480,duration:2});
    assert.deepEqual(requestedParts, Array(12).fill('"large-mp4"'));
    assert.equal(fullRequests, 0);
    console.log('Edge saved original Range MP4 byte-for-byte in the configured browser download folder');

    const headers = {authorization:'Bearer '+token, 'content-type':'application/json'};
    const {id} = await (await fetch(endpoint+'/api/queue', {method:'POST', headers,
      body:JSON.stringify({items:[{kind:'stream', url:rangeUrl, title:'Parallel API', mode:'video'}]})})).json();
    const result = await until(async () => {
      const batch = await (await fetch(endpoint+'/api/batch/'+id, {headers})).json();
      return batch.status === 'done' && batch.items[0];
    });
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.deepEqual(inspectFile(result.file), {width:640,height:480,duration:2});
    assert.deepEqual(requestedParts, Array(20).fill('"large-mp4"'));
    assert.equal(fullRequests, 0);
    console.log('HTTP queue processed staged Range MP4 without fetching the full upstream file again');

    await popup.evaluate(`chrome.runtime.sendMessage({scope:'media-downloads',action:'enqueue',streams:[{
      title:'Native fallback',kind:'mp4',url:${JSON.stringify(url)},
      options:{mode:'combined',quality:'',format:'auto',subtitles:false}
    }]})`);
    await until(() => worker.evaluate(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) =>
      downloadJobs?.[0]?.title === 'Native fallback' && downloadJobs[0].state === 'done' && !downloadJobs[0].batch)`));
    assert.deepEqual(await readFile(path.join(customOut, 'Native fallback.mp4')), media);
    console.log('Edge native fallback saved the original when the server did not support validated ranges');
  } finally {
    for (const source of servers) {
      source.closeAllConnections();
      source.close();
    }
    await rm(fixture, {force:true});
    await rm(caption, {force:true});
  }
}

async function pairPopup(popup, endpoint) {
  await until(() => popup.evaluate('!!document.querySelector("#settings-options [data-option]")').catch(() => false));
  await popup.evaluate('document.querySelector("#settings-toggle").click()');
  await popup.evaluate('document.querySelector("#endpoint").value = '+JSON.stringify(endpoint));
  await popup.evaluate('document.querySelector("#token").value = '+JSON.stringify(token));
  await popup.evaluate('document.querySelector("#pair").requestSubmit()');
  await until(() => popup.evaluate('document.querySelector("#connection-status").dataset.connected === "true"'));
  console.log('Edge popup companion pairing ok');
}

async function testPopup(endpoint) {
  const extension = path.join(project,'extension');
  await withEdge(['--disable-features=DisableLoadExtensionCommandLineSwitch','--autoplay-policy=no-user-gesture-required',
    '--window-size=460,620','--load-extension='+extension], async ({list,browserUrl}) => {
    const target = await until(async () => (await list()).find(row => row.type==='service_worker' && row.url.endsWith('/background.mjs')));
    const edge = await connectCdp(browserUrl,signal);
    const sw = await connectCdp(target.webSocketDebuggerUrl,signal);
    const tab = (await list()).find(row => row.type==='page' && row.url==='about:blank');
    const page = await connectCdp(tab.webSocketDebuggerUrl,signal);
    const popupUrl = new URL('/popup.html',target.url).href;
    if (process.argv.includes('--delivery-only')) {
      try {
        await page.send('Page.navigate',{url:popupUrl});
        await pairPopup(page, endpoint);
        await checkBrowserDelivery(page, sw, endpoint);
      } finally { page.close(); sw.close(); edge.close(); }
      return;
    }
    const nav = await page.send('Page.navigate',{url:browserPage});
    assert.ok(!nav.errorText,nav.errorText);
    await page.send('Page.bringToFront');
    try {
      await until(() => page.evaluate('!!document.querySelector("video")').catch(() => false), 45_000);
    } catch (error) {
      const state = await page.evaluate('({url:location.href,title:document.title,state:document.readyState})').catch(() => null);
      throw new Error('Public video did not load: ' + JSON.stringify(state), {cause:error});
    }
    await page.send('Runtime.evaluate',{userGesture:true,expression:'void document.querySelector("video").play().catch(()=>{})'});
    try {
      await until(() => page.evaluate('Number.isFinite(document.querySelector("video").duration)'), 65_000);
    } catch (error) {
      const state = await page.evaluate(`(() => {
        const video = document.querySelector('video');
        return {source:video.currentSrc, ready:video.readyState, error:video.error?.message};
      })()`);
      throw new Error('Public video duration did not load: ' + JSON.stringify(state), {cause:error});
    }
    const {targetId} = await edge.send('Target.createTarget',{url:popupUrl,background:true});
    const popupTarget = await until(async () => (await list()).find(row=>row.id===targetId));
    const popup = await connectCdp(popupTarget.webSocketDebuggerUrl,signal);
    try {
      await page.send('Page.bringToFront');
      await popup.send('Page.reload');
      try {
        await until(() => popup.evaluate('[...document.querySelectorAll("#media li")].some(row=>row.innerText.includes("MP4"))').catch(() => false));
      } catch (error) {
        const state = await popup.evaluate('document.body.innerText');
        throw new Error('Popup did not discover MP4: ' + state, {cause:error});
      }
      const videoTitle = 'Sintel 官方预告片';
      await page.evaluate(`document.querySelector('video').title = ${JSON.stringify(videoTitle)}`);
      await popup.evaluate('document.querySelector("#refresh").click()');
      await until(() => popup.evaluate('!document.querySelector("#refresh").disabled'));
      const mediaRow = '([...document.querySelectorAll("#media li")].find(row=>row.innerText.includes("MP4")))';
      const displayed = await popup.evaluate(`({title:${mediaRow}.querySelector('.media-title').textContent,details:${mediaRow}.innerText})`);
      assert.equal(displayed.title, videoTitle);
      assert.match(displayed.details, /0:52/);
      assert.equal(await popup.evaluate(`Array.from(document.querySelectorAll('#media .media-title'))
        .filter(title => title.textContent === ${JSON.stringify(videoTitle)}).length`), 1);
      await popup.evaluate(`${mediaRow}.querySelector('.actions button:last-child').click()`);
      let downloaded;
      try {
        downloaded = await until(async () => {
          const rows = await sw.evaluate("chrome.downloads.search({}).then(rows => rows.map(({url,state,error,filename}) => ({url,state,error,filename})))");
          return rows.find(row => row.state === 'complete' && row.url.includes('/sintel/trailer.mp4'));
        }, 95_000);
      } catch (error) {
        const rows = await sw.evaluate("chrome.downloads.search({}).then(rows => rows.map(({url,state,error}) => ({url,state,error})))");
        const status = await popup.evaluate('document.querySelector("#status").textContent');
        throw new Error('Popup download did not complete: ' + JSON.stringify({rows,status}), {cause:error});
      }
      console.log('Edge popup real page', displayed.title, '0:52', inspectFile(downloaded.filename));
      await pairPopup(popup, endpoint);
      await checkBrowserDelivery(popup, sw, endpoint);
      await popup.evaluate('document.querySelector("#videos-toggle").click()');
      await page.evaluate(`(() => {
        const other = document.createElement('video');
        other.preload = 'none';
        other.src = '/recording.mp4';
        document.body.append(other);
        const json = document.createElement('script');
        json.type = 'application/ld+json';
        json.textContent = JSON.stringify({'@graph':[{ '@type':'VideoObject',
          contentUrl:other.src, name:'独立的节目', duration:'PT1H2M3S' }]});
        document.head.append(json);
      })()`);
      await popup.evaluate('document.querySelector("#refresh").click()');
      const other = await until(() => popup.evaluate(`[...document.querySelectorAll('#media li')]
        .find(row => row.dataset.url.endsWith('/recording.mp4'))?.innerText`));
      assert.match(other, /独立的节目[\s\S]*1:02:03/);
      await popup.evaluate('document.querySelector("#media .options-button").click()');
      assert.equal(await popup.evaluate('getComputedStyle(document.querySelector("#media .card-options:not([hidden])")).animationName'), 'enter');
      await popup.evaluate('document.querySelector("#media .options-button").click()');
      await checkPopupLayout(popup);
      await page.send('Page.bringToFront');
      await sw.evaluate('chrome.action.openPopup()');
      const toolbarTarget = await until(async () => (await list()).find(row => row.url === popupUrl && row.id !== targetId));
      const toolbar = await connectCdp(toolbarTarget.webSocketDebuggerUrl, signal);
      try {
        await until(() => toolbar.evaluate('document.querySelector("#media")?.innerText.includes("Sintel 官方预告片")'));
        await until(() => toolbar.evaluate('document.documentElement.scrollWidth <= innerWidth'), 5000);
        const size = await toolbar.evaluate(`({width: innerWidth, height: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          footer: document.querySelector('footer').getBoundingClientRect().bottom,
          right: Math.max(...[...document.querySelectorAll('.masthead button, #refresh, .media li > .actions, #history')]
            .map(node=>node.getBoundingClientRect().right)),
          listHeight: document.querySelector('#media').getBoundingClientRect().height})`);
        assert.ok(size.width >= 400 && size.right <= size.width && size.documentWidth <= size.width &&
          size.height <= 560 && size.footer - size.height < 1 && size.listHeight > 50,
          JSON.stringify(size));
        console.log('Edge toolbar popup', size);
        if (process.env.SMOKE_SCREENSHOT) {
          const shot = await toolbar.send('Page.captureScreenshot',{format:'png'});
          await writeFile(process.env.SMOKE_SCREENSHOT,Buffer.from(shot.data,'base64'));
        }
      } finally { toolbar.close(); }
    } finally { popup.close(); page.close(); sw.close(); edge.close(); }
  },signal,{downloadsDirectory:browserOut});
}

const server = start('server.mjs');
const exited = once(server,'close');
const lines = createInterface({input:server.stdout})[Symbol.asyncIterator]();
try {
  const {value} = await lines.next();
  const endpoint = value.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(endpoint,value);
  const api = async (route,body) => {
    const response = await fetch(endpoint+route,{
      headers:{authorization:'Bearer '+token,...(body && {'content-type':'application/json'})},
      ...(body && {method:'POST',body:JSON.stringify(body)}),signal,
    });
    const data = await response.json();
    assert.ok(response.ok,JSON.stringify(data));
    return data;
  };
  if (process.argv.includes('--popup-only') || process.argv.includes('--delivery-only')) {
    await testPopup(endpoint);
  } else {
    assert.equal((await fetch(endpoint+'/api/health')).status,401);
    assert.equal((await fetch(endpoint+'/api/health',{headers:{origin:'https://example.org'}})).status,403);
    assert.equal((await api('/api/health')).ok,true);
    const probed = await api('/api/probe',{url:pageUrl});
    assert.ok(probed.streams.some(row=>row.kind==='webm' && row.width>0),JSON.stringify(probed));
    const batch = await api('/api/queue',{items:[{kind:'stream',url:hls,title:'HLS'},{kind:'stream',url:dash,title:'DASH',format:'mkv'}],maxSec:3});
    const sse = await fetch(endpoint+'/api/batch/'+batch.id+'/events',{headers:{authorization:'Bearer '+token},signal});
    assert.ok(sse.headers.get('content-type').startsWith('text/event-stream'));
    const events = (await sse.text()).trim().split('\n\n').map(frame=>JSON.parse(frame.slice(6)));
    assert.equal(events.at(-1).status,'done');
    const results = await api('/api/batch/'+batch.id);
    for (const item of results.items) {
      assert.equal(item.status,'done',JSON.stringify(item));
      console.log(item.title,inspectFile(item.file));
    }
    assert.equal((await api('/api/recent')).items.length,2);
    await testMcp();
    await testPopup(endpoint);
    assert.equal((await readdir(out)).length,3);
    assert.equal((await readdir(path.join(browserOut,'视频','教程'))).length,6);
    assert.equal((await readdir(browserOut)).length,3);
  }
} finally {
  if (server.exitCode === null) server.kill();
  await exited;
  await rm(out,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  await rm(browserOut,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
