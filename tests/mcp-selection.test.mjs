import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('..', import.meta.url));

test('MCP gives a client evidence to choose the full film over the autoplay teaser', {timeout: 90_000}, async t => {
  const out = await mkdtemp(path.join(project, '.mcp-selection-'));
  t.after(() => rm(out, {recursive:true, force:true, maxRetries:5}));
  const media = new Map();
  let allowRetry = false;
  for (const [name, dimensions, duration] of [['101','160x90','2'], ['102','320x180','5'], ['103','480x270','5']]) {
    const file = path.join(out, `${name}.mp4`);
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-f','lavfi','-i',`testsrc2=size=${dimensions}:rate=10`,
      '-t',duration,'-c:v','libx264','-movflags','+faststart',
      ...(name === '102' ? ['-metadata','title=Across the lake (festival cut)'] : []),file], {windowsHide:true});
    media.set(`/${name}.mp4`, await readFile(file));
  }
  media.set('/104.mp4', media.get('/101.mp4'));
  media.set('/105.mp4', media.get('/101.mp4'));

  let delayedNavigations = 0;
  let playbackClicks = 0;
  let drmMediaRequests = 0;
  let limitedRequests = 0;
  const description = 'Video fixture. '.repeat(30).trim();
  const headerRequests = [];
  const server = createServer((req, res) => {
    if (req.url === '/observed.mp4') {
      const expected = 'http://127.0.0.1:' + server.address().port + '/watch/request-headers';
      if (![expected,'https://override.example/player'].includes(req.headers.referer)) return res.writeHead(403).end();
      const bytes = media.get('/102.mp4');
      return res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length}).end(bytes);
    }
    if (req.url === '/header-protected.mp4') {
      const headers = ['referer','origin','user-agent'].map(name => req.headers[name]);
      headerRequests.push(headers);
      if (headers.join('|') !== 'https://example.test/player|https://example.test|VideoSave fixture') {
        return res.writeHead(403).end();
      }
      const bytes = media.get('/102.mp4');
      return res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length}).end(bytes);
    }
    const bytes = req.url === '/retry.mp4' && allowRetry && req.headers.cookie === 'session=test' ? media.get('/102.mp4') : media.get(req.url);
    if (bytes) {
      res.writeHead(200, {'content-type':'video/mp4','content-length':bytes.length}).end(bytes);
    } else if (req.url === '/watch/film') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(`<!doctype html>
        <title>Festival programme</title><meta name="description" content="Festival screenings and extras">
        <main><h1>Festival screenings</h1>
          <article><h2>Festival teaser</h2><p>A short preview of this year's programme.</p>
            <video src="/101.mp4" autoplay muted loop playsinline></video>
          </article>
          <article><h2>Across the lake</h2><p hidden>Hidden decoy description</p>
            <p>Full film, including the credits.</p>
            <video controls><source src="/102.mp4" type="video/mp4"><source src="/103.mp4" type="video/mp4">
              <source src="/missing.mp4" type="video/mp4"></video>
          </article>
          <aside class="video-ad"><video src="/104.mp4" autoplay muted loop></video></aside>
          <a href="/watch/other">Another film</a><a href="/videos/hot">Popular videos</a>
        </main><script>fetch('/105.mp4').then(res => res.arrayBuffer())</script>`);
    } else if (req.url === '/watch/untitled-player') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(`<!doctype html>
        <title>Video player test</title><video controls src="/102.mp4"></video>`);
    } else if (req.url === '/watch/delayed') {
      const reveal = ++delayedNavigations % 2 === 0;
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(`<!doctype html>
        <title>Delayed player</title><meta name="description" content="${description}">
        <video controls></video>${reveal ? '<script>setTimeout(() => document.querySelector("video").src = "/102.mp4", 650)</script>' : ''}`);
    } else if (req.url === '/watch/list') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(`<!doctype html>
        <title>Film collection</title><nav><a href="/watch/listing">Navigation</a></nav>
        <main><a href="/videos/hot">Popular</a><a href="/watch/untitled-player">
        <img alt="Film" src="/poster.png"><time datetime="PT5S"></time></a></main>`);
    } else if (req.url === '/watch/blocked') {
      res.writeHead(403, {'content-type':'text/html'}).end('<title>Blocked</title>');
    } else if (req.url === '/watch/challenge') {
      res.writeHead(403, {'content-type':'text/html','cf-mitigated':'challenge'}).end(
        '<title>Just a moment...</title><button aria-label="Play" onclick="fetch(\'/played\')">Play</button>');
    } else if (req.url === '/watch/json-player') {
      res.writeHead(200, {'content-type':'text/html'}).end(`<title>JSON player</title>
        <video controls width="320" height="180"></video>
        <script>fetch("/playback.json").then(response => response.json());</script>`);
    } else if (req.url === '/watch/json-summary') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(`<title>JSON diagnostics</title>
        <video controls width="320" height="180"></video>
        <script>fetch('/opaque.json'); fetch('/large.json');</script>`);
    } else if (req.url === '/opaque.json' || req.url === '/large.json') {
      const body = req.url === '/opaque.json'
        ? {player:{sources:[{file:'ciphertext-value'}]}, poster:'poster-value'}
        : {oversizedKey:'x'.repeat(512 * 1024)};
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));
    } else if (req.url === '/playback.json') {
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({
        sources:[{file:'/102.mp4'},{file:'http://127.0.0.1:1/other-origin.mp4'}],
        unrelated:{url:'/104.mp4', session:'do-not-include-in-result'},
      }));
    } else if (req.url === '/watch/framed') {
      res.writeHead(200, {'content-type':'text/html'}).end(`<title>Framed player</title>
        <iframe src="http://localhost:${server.address().port}/embedded-player"></iframe><iframe srcdoc="<p>Empty frame</p>"></iframe>`);
    } else if (req.url === '/embedded-player') {
      res.writeHead(200, {'content-type':'text/html'}).end('<title>Embedded player</title><video controls src="/102.mp4"></video>');
    } else if (req.url === '/watch/inline-frame') {
      res.writeHead(200, {'content-type':'text/html'}).end(`<title>Inline player</title>
        <iframe srcdoc='<video controls src="/102.mp4"></video>'></iframe><iframe></iframe>`);
    } else if (req.url === '/watch/request-headers') {
      res.writeHead(200, {'content-type':'text/html'}).end('<title>Request headers</title><video controls src="/observed.mp4"></video>');
    } else if (req.url === '/watch/expiring') {
      res.writeHead(200, {'content-type':'text/html'}).end('<title>Expiring URL</title><video controls src="/102.mp4?Expires=1893456000"></video>');
    } else if (req.url === '/limited.m3u8') {
      limitedRequests++;
      res.writeHead(429,{'Retry-After':'20'}).end();
    } else if (req.url === '/watch/click-to-play') {
      res.writeHead(200, {'content-type':'text/html'}).end(`<title>Explicit playback</title>
        <video controls width="320" height="180"></video>
        <button class="vjs-big-play-button" aria-label="Play Video">Play</button>
        <script>document.querySelector("button").onclick = () => {
          fetch("/played");
          const player = document.querySelector("video");
          player.src = "/102.mp4";
          void player.play();
        };</script>`);
    } else if (req.url === '/played') {
      playbackClicks++;
      res.writeHead(204).end();
    } else if (req.url === '/encrypted.m3u8') {
      res.writeHead(200, {'content-type':'application/vnd.apple.mpegurl'}).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="file:///nonexistent-key"\n#EXTINF:5,\n/102.mp4\n#EXT-X-ENDLIST\n');
    } else if (req.url === '/master.m3u8') {
      res.writeHead(200, {'content-type':'application/vnd.apple.mpegurl'}).end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=480x270\n/high.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\n/low.m3u8\n');
    } else if (req.url === '/drm.m3u8') {
      res.writeHead(200, {'content-type':'application/vnd.apple.mpegurl'}).end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/must-not-fetch"\n#EXTINF:5,\n/must-not-fetch\n#EXT-X-ENDLIST\n');
    } else if (req.url === '/drm.mpd') {
      res.writeHead(200, {'content-type':'application/dash+xml'}).end(
        '<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>' +
        '<Representation><BaseURL>/must-not-fetch</BaseURL></Representation></AdaptationSet></Period></MPD>');
    } else if (req.url === '/must-not-fetch') {
      drmMediaRequests++;
      res.writeHead(404).end();
    } else if (req.url === '/watch/adaptive') {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(
        '<title>Adaptive player</title><video src="/master.m3u8" preload="none"></video>');
    } else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  media.set('/extensionless',media.get('/102.mp4'));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/watch/film`;
  const downloadDir = path.join(out, 'saved');
  const env = {...process.env, OUT_DIR:out, MEDIA_TOOLKIT_SETTINGS:path.join(out, 'settings.sqlite'),
    MEDIA_TOOLKIT_TOKEN:'selection-test', MEDIA_TOOLKIT_URL:'', PORT:'0'};
  const proc = spawn(process.execPath, [path.join(project, 'tools', 'mcp-server.mjs')], {
    env, stdio:['pipe','pipe','inherit'], windowsHide:true, signal:t.signal,
  });
  const exited = once(proc, 'close');
  t.after(async () => { proc.stdin.end(); await exited; });
  const replies = createInterface({input:proc.stdout})[Symbol.asyncIterator]();
  let nextId = 0;
  const send = request => proc.stdin.write(JSON.stringify({jsonrpc:'2.0', ...request}) + '\n');
  const call = async (method, params, expectError = false) => {
    const id = ++nextId;
    send({id, method, params});
    const {value} = await replies.next();
    assert.ok(value, 'MCP closed before replying');
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    assert.ok(reply.result && Boolean(reply.result.isError) === expectError, value);
    return reply.result;
  };
  const tool = async (name, args) => (await call('tools/call', {name, arguments:args})).structuredContent;

  await call('initialize', {protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'selection-test',version:'1'}});
  send({method:'notifications/initialized'});
  const {tools} = await call('tools/list', {});
  for (const name of ['get_settings','update_settings','list_batches','cancel_download','wait_for_download','retry_download']) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
  const base = await tool('get_settings');
  assert.equal(base.settings.outDir, out);
  assert.equal(base.settings.concurrency, 24);
  await tool('update_settings', {settings:{outDir:downloadDir, format:'mkv', concurrency:3, connections:4}});
  await tool('update_settings', {scope:'browser',settings:{theme:'jade',downloadFolder:'Video\\Courses',language:'en'}});
  const http = spawn(process.execPath, [path.join(project, 'tools', 'server.mjs')], {
    env, stdio:['ignore','pipe','inherit'], windowsHide:true, signal:t.signal,
  });
  const httpClosed = once(http, 'close');
  t.after(async () => { http.kill(); await httpClosed; });
  const httpLines = createInterface({input:http.stdout})[Symbol.asyncIterator]();
  const {value:startup} = await httpLines.next();
  assert.ok(startup, 'HTTP service exited before listening');
  const endpoint = startup.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const headers = {authorization:'Bearer ' + env.MEDIA_TOOLKIT_TOKEN};
  const get = async route => (await fetch(endpoint + route, {headers, signal:t.signal})).json();
  assert.equal((await fetch(endpoint + '/api/settings', {signal:t.signal})).status, 401);
  assert.equal((await get('/api/health')).outDir, downloadDir);
  assert.equal((await get('/api/settings')).settings.format, 'mkv');
  assert.deepEqual((await get('/api/browser-settings')).settings, {theme:'jade',downloadFolder:'Video/Courses',language:'en'});
  const patch = settings => fetch(endpoint + '/api/settings', {method:'POST', headers:{...headers,
    'content-type':'application/json'}, body:JSON.stringify({settings}), signal:t.signal});
  assert.equal((await patch({format:'mp4', concurrency:0})).status, 400);
  assert.equal((await tool('get_settings')).settings.format, 'mkv');
  assert.equal((await patch({connections:null})).status, 200);
  assert.equal((await tool('get_settings')).settings.connections, 8);
  assert.ok(tools.find(x => x.name === 'probe_page').inputSchema.properties.retries);
  assert.ok(tools.find(x => x.name === 'probe_page').inputSchema.properties.mode.enum.includes('headed'));
  const {pageTitle, pageContext, streams, pages, candidates, selection} = await tool('probe_page', {url});
  assert.equal(pageTitle, 'Festival screenings');
  assert.deepEqual(pageContext, {url, heading:'Festival screenings', description:'Festival screenings and extras',
    titleSource:'heading', playerCount:2, untrusted:true});
  assert.equal(pages[0].title, 'Another film');
  assert.equal(streams.some(stream => stream.url.endsWith('/104.mp4')), false);
  assert.deepEqual(streams.map(stream => stream.duration), [5, 5, 2, 2, null]);
  const teaser = streams.find(stream => stream.recommended);
  assert.equal(teaser.player.heading, 'Festival teaser');
  assert.equal(teaser.player.playing, true);
  assert.equal(teaser.duration, 2);
  const movie = streams.find(stream => stream.currentSource && stream.player?.description === 'Full film, including the credits.');
  assert.ok(movie);
  assert.equal(streams[0], movie);
  assert.equal(movie.title, 'Across the lake');
  assert.equal(movie.titleSource, 'player-heading');
  assert.equal(movie.mediaTitle, 'Across the lake (festival cut)');
  assert.equal(movie.discoveredBy, 'player');
  assert.equal(movie.player.visible, true);
  assert.equal(movie.player.playing, false);
  assert.notEqual(movie.player.id, teaser.player.id);
  assert.deepEqual(selection, {status:'selected', url:movie.url, reason:'longest-player'});
  assert.deepEqual(candidates, [{url:new URL('/watch/other',url).href,title:'Another film',kind:'page'}]);
  assert.deepEqual(movie.quality.map(option => option.height), [270,180]);
  assert.equal(movie.duration, 5);
  assert.ok(movie.size > 0);
  const alternate = streams.find(stream => stream.player?.id === movie.player.id && stream.currentSource === false);
  assert.equal(alternate.height, 270);
  const missing = streams.find(stream => stream.url.endsWith('/missing.mp4'));
  assert.equal(missing.player.id, movie.player.id);
  assert.deepEqual([missing.duration, missing.width, missing.height], [null, null, null]);
  const observed = streams.find(stream => stream.url.endsWith('/105.mp4'));
  assert.equal(observed.discoveredBy, 'network');
  assert.equal(observed.player, null);
  assert.equal(observed.currentSource, null);
  const tagged = await tool('probe_page', {url:new URL('/watch/untitled-player',url).href});
  assert.equal(tagged.pageTitle, 'Video player test');
  assert.equal(tagged.streams[0].title, 'Across the lake (festival cut)');
  assert.equal(tagged.streams[0].titleSource, 'media-tag');
  const delayedUrl = new URL('/watch/delayed',url).href;
  for (const includeText of [false,true,false]) {
    const delayed = await tool('probe_page',{url:delayedUrl,waitMs:600,retries:2,includeText});
    assert.equal(delayed.selection.status,'selected');
    assert.equal(delayed.streams[0].duration,5);
    assert.equal(delayed.pageContext.description,includeText ? description : description.slice(0,300));
    assert.equal(delayed.pageContext.untrusted,true);
  }
  assert.equal(delayedNavigations,6);
  const absent = await tool('probe_page',{url:delayedUrl,waitMs:500,retries:0});
  assert.deepEqual(absent.selection,{status:'unavailable',reason:'no-playlist-request'});
  const blocked = await tool('probe_page',{url:new URL('/watch/blocked',url).href,waitMs:500});
  assert.deepEqual(blocked.selection,{status:'unavailable',reason:'blocked'});
  const gated = await tool('probe_page',{url:new URL('/watch/challenge',url).href,clickPlay:true,waitMs:600});
  assert.deepEqual(gated.selection,{status:'unavailable',reason:'blocked'});
  assert.deepEqual(gated.blockers,['cloudflare-challenge']);
  const gatedBatch = await tool('start_download',{items:[{kind:'page',url:new URL('/watch/challenge',url).href}]});
  const [gatedItem] = (await tool('wait_for_download',gatedBatch)).items;
  assert.equal(gatedItem.errorCode,'NO_MEDIA');
  assert.deepEqual(gatedItem.detail.blockers,['cloudflare-challenge']);
  assert.match(gatedItem.error,/Cloudflare.+未探测到媒体流/);
  const headed = await tool('probe_page',{url:new URL('/watch/challenge',url).href,
    mode:'headed',waitForMediaMs:600,retries:0,clickPlay:true});
  assert.deepEqual(headed.blockers,['cloudflare-challenge']);
  const explicit = new URL('/watch/click-to-play',url).href;
  const passive = await tool('probe_page',{url:explicit,waitMs:600,retries:0});
  assert.equal(passive.streams.length,0);
  assert.equal(playbackClicks,0);
  const played = await tool('probe_page',{url:explicit,waitMs:2500,retries:0,clickPlay:true});
  assert.equal(played.selection.status,'selected',JSON.stringify(played.selection));
  assert.ok(played.selection.url.endsWith('/102.mp4'));
  assert.equal(playbackClicks,1);
  const jsonUrl = new URL('/watch/json-player',url).href;
  const json = await tool('probe_page',{url:jsonUrl,waitMs:2000,retries:0,captureXhrBody:true});
  assert.deepEqual(json.streams.map(stream => [new URL(stream.url).pathname,stream.discoveredBy]),[['/102.mp4','xhr-json']]);
  assert.doesNotMatch(JSON.stringify(json),/do-not-include-in-result/);
  assert.equal(json.streams[0].playerId,'0:0');
  const summary = await tool('probe_page',{url:new URL('/watch/json-summary',url).href,
    waitForMediaMs:900,retries:0,captureXhrBody:true});
  assert.deepEqual(summary.xhrJson,[{keys:['file','player','poster','sources'],found:0}]);
  assert.doesNotMatch(JSON.stringify(summary),/ciphertext-value|poster-value|oversizedKey/);
  const noJson = await tool('probe_page',{url:jsonUrl,waitMs:500,retries:0});
  assert.equal(noJson.streams.length,0);
  const framed = await tool('probe_page',{url:new URL('/watch/framed',url).href,includeFrames:true,waitMs:2500,retries:0});
  assert.equal(framed.selection.status,'selected');
  assert.deepEqual(framed.streams.map(stream => [new URL(stream.url).pathname,new URL(stream.frameUrl).pathname]),[
    ['/102.mp4','/embedded-player'],
  ]);
  assert.equal(framed.skippedFrames,1);
  assert.equal(new URL(framed.streams[0].frameUrl).hostname,'localhost');
  const inlineFrame = await tool('probe_page',{url:new URL('/watch/inline-frame',url).href,includeFrames:true,waitForMediaMs:2500});
  assert.equal(inlineFrame.selection.status,'selected');
  assert.deepEqual(inlineFrame.streams.map(stream => [new URL(stream.url).pathname,stream.frameUrl]),[
    ['/102.mp4','about:srcdoc'],
  ]);
  assert.equal(inlineFrame.skippedFrames,1);
  const observedUrl = new URL('/watch/request-headers',url).href;
  const captured = await tool('probe_page',{url:observedUrl,waitForMediaMs:1500});
  assert.equal(captured.streams[0].duration,5);
  for (const options of [{prefetch:true},{prefetch:false,headers:{Referer:'https://override.example/player'}}]) {
    const request = await tool('start_download',{items:[{kind:'stream',url:captured.streams[0].url}],...options});
    const [result] = (await tool('wait_for_download',request)).items;
    assert.equal(result.status,'done',JSON.stringify(result));
  }
  const expiring = await tool('probe_page',{url:new URL('/watch/expiring',url).href,waitForMediaMs:700});
  assert.equal(expiring.streams[0].expiresAt,'2030-01-01T00:00:00.000Z');
  const list = await tool('probe_page',{url:new URL('/watch/list',url).href,waitMs:500});
  assert.deepEqual(list.selection,{status:'unavailable',reason:'no-player'});
  assert.deepEqual(list.candidates,[{url:new URL('/watch/untitled-player',url).href,title:'Film',kind:'page',duration:5}]);
  const adaptive = await tool('probe_page',{url:new URL('/watch/adaptive',url).href,waitMs:500,retries:0});
  assert.deepEqual(adaptive.streams[0].quality,[
    {height:270,bitrate:600000,url:new URL('/high.m3u8',url).href},
    {height:180,bitrate:300000,url:new URL('/low.m3u8',url).href},
  ]);

  const {id} = await tool('start_download', {items:[{kind:'stream', url:movie.url, title:movie.title}]});
  assert.equal((await tool('list_batches')).items[0].id, id);
  const {timedOut, ...progress} = await tool('wait_for_download', {id,timeoutMs:15_000});
  assert.equal(timedOut, false);
  const [item] = progress.items;
  assert.equal(item.status, 'done', JSON.stringify(progress));
  assert.equal(item.percent, 100);
  assert.equal(item.info.codec, 'h264');
  assert.equal(item.info.container, 'matroska');
  assert.equal(item.info.size, (await readFile(item.file)).length);
  assert.equal(item.prefetch, true);
  assert.equal(item.speed,0);
  assert.ok(item.bytes > 0);
  assert.equal(item.totalBytes,item.bytes);
  assert.equal(item.etaSec,null);
  assert.equal(path.dirname(item.file), downloadDir);
  assert.equal(path.extname(item.file), '.mkv');
  const output = JSON.parse(execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v','error','-of','json','-show_entries',
    'format=duration:stream=width,height',item.file], {encoding:'utf8',windowsHide:true}));
  assert.deepEqual(output.streams[0], {width:320,height:180});
  assert.ok(Math.abs(Number(output.format.duration) - 5) < 0.05);
  const extensionless = new URL('/extensionless',url).href;
  const clip = await tool('start_download',{items:[{kind:'stream',url:extensionless,subtitles:true}],maxSec:2,prefetch:true});
  const [trimmed] = (await tool('wait_for_download',clip)).items;
  assert.equal(trimmed.prefetch,true);
  assert.equal(trimmed.subtitleTracks,0);
  assert.ok(Math.abs(trimmed.info.duration - 2) <= 1, JSON.stringify(trimmed.info));
  const short = await tool('start_download',{items:[{kind:'stream',url:extensionless}],maxSec:2});
  const [shortItem] = (await tool('wait_for_download',short)).items;
  assert.equal(shortItem.prefetch,false);
  assert.equal(shortItem.prefetchFallback,undefined);
  const protectedMedia = {items:[{kind:'stream',url:new URL('/header-protected.mp4',url).href}],
    headers:{Referer:'https://example.test/player',Origin:'https://example.test','User-Agent':'VideoSave fixture'}};
  for (const prefetch of [true,false]) {
    headerRequests.length = 0;
    const download = await tool('start_download',{...protectedMedia,prefetch});
    const [result] = (await tool('wait_for_download',download)).items;
    assert.equal(result.status,'done',JSON.stringify(result));
    assert.equal(result.prefetch,prefetch);
    assert.equal(result.info.duration,5);
    assert.ok(headerRequests.length);
    assert.ok(headerRequests.every(sent => sent.join('|') === 'https://example.test/player|https://example.test|VideoSave fixture'));
  }
  for (const headers of [{Authorization:'Bearer private'},{Referer:'https://example.test/\r\nX-Example: bad'}]) {
    const rejected = await call('tools/call',{name:'start_download',arguments:{...protectedMedia,headers}},true);
    assert.equal(rejected.structuredContent.code,'INVALID_HEADERS');
  }
  for (const prefetch of [true,false]) {
    const drm = await tool('start_download',{items:[{kind:'stream',url:new URL('/drm.m3u8',url).href}],prefetch});
    const [result] = (await tool('wait_for_download',drm)).items;
    assert.equal(result.errorCode,'DRM',JSON.stringify(result));
  }
  const dashDrm = await tool('start_download',{items:[{kind:'stream',url:new URL('/drm.mpd',url).href}]});
  const [dashDrmItem] = (await tool('wait_for_download',dashDrm)).items;
  assert.equal(dashDrmItem.errorCode,'DRM',JSON.stringify(dashDrmItem));
  assert.equal(drmMediaRequests,0);
  const limitedUrl = 'http://localhost:' + server.address().port + '/limited.m3u8';
  const limited = await tool('start_download',{items:[{kind:'stream',url:limitedUrl}],prefetch:true});
  const [limitedItem] = (await tool('wait_for_download',limited)).items;
  assert.equal(limitedItem.errorCode,'RATE_LIMITED',JSON.stringify(limitedItem));
  assert.equal(limitedItem.detail.retryAfterSec,20);
  const duringCooldown = await tool('start_download',{items:[{kind:'stream',url:limitedUrl,title:'Another request'}],prefetch:true});
  assert.equal((await tool('wait_for_download',duringCooldown)).items[0].errorCode,'RATE_LIMITED');
  assert.equal(limitedRequests,1);
  const encrypted = await tool('start_download',{items:[{kind:'stream',url:new URL('/encrypted.m3u8',url).href}]});
  const encryptedResult = await tool('wait_for_download',encrypted);
  assert.equal(encryptedResult.status,'failed');
  assert.equal(encryptedResult.items[0].prefetch,false);
  assert.deepEqual(encryptedResult.items[0].prefetchFallback,{reason:'unsupported-hls-playlist'});
  assert.ok(['DECRYPT_FAILED','PROTOCOL_NOT_ALLOWED'].includes(encryptedResult.items[0].errorCode),JSON.stringify(encryptedResult));
  assert.doesNotMatch(encryptedResult.items[0].detail.stderr,/nonexistent-key/);
  assert.ok(encryptedResult.items[0].detail.stderr.length <= 200);
  const missingPlaylist = await tool('start_download',{items:[{kind:'stream',url:new URL('/missing.m3u8?token=private',url).href}],
    prefetch:true,connections:8});
  const missingResult = await tool('wait_for_download',missingPlaylist);
  assert.equal(missingResult.status,'failed');
  assert.deepEqual(missingResult.items[0].prefetchFallback,{reason:'hls-http-error',status:404});
  const automatic = await tool('start_download', {items:[{kind:'page', url}]});
  const pending = await tool('wait_for_download', {...automatic,timeoutMs:1});
  assert.equal(pending.timedOut, true);
  assert.equal(pending.status, 'running');
  const automaticProgress = await tool('wait_for_download', {...automatic,timeoutMs:30_000});
  const [automaticallySelected] = automaticProgress.items;
  assert.equal(automaticallySelected.status, 'done', JSON.stringify(automaticProgress));
  assert.equal(automaticallySelected.title, movie.title);
  assert.equal(automaticallySelected.info.duration, 5);
  const cancelled = await tool('start_download', {items:[{kind:'page', url}]});
  assert.equal((await tool('cancel_download', {id:cancelled.id})).ok, true);
  assert.equal((await tool('wait_for_download', cancelled)).status, 'cancelled');

  const unavailable = new URL('/retry.mp4', url).href;
  const queueResponse = await fetch(endpoint + '/api/queue', {method:'POST',
    headers:{...headers,'content-type':'application/json'}, signal:t.signal,
    body:JSON.stringify({cookie:'session=test',items:[{kind:'stream',url:unavailable},{kind:'stream',url:movie.url,title:'Already saved'},
      {kind:'stream',url:movie.url,title:'Also saved'}]})});
  assert.equal(queueResponse.status, 200);
  const failed = await queueResponse.json();
  const httpOutcome = await get('/api/batch/' + failed.id + '/wait?timeoutMs=15000');
  assert.equal(httpOutcome.timedOut, false);
  assert.equal(httpOutcome.items[0].status, 'error');
  assert.equal(httpOutcome.status, 'partial');
  assert.deepEqual([httpOutcome.active,httpOutcome.queued,httpOutcome.failed], [0,0,1]);
  assert.equal(httpOutcome.items[0].errorCode, 'HTTP_STATUS');
  assert.equal(httpOutcome.items[0].detail.status, 404);
  assert.ok(httpOutcome.log.length <= 5);
  assert.equal(httpOutcome.items[2].status, 'done');
  assert.equal(httpOutcome.lastError.code, 'HTTP_STATUS');
  assert.ok(httpOutcome.items[0].error);
  assert.deepEqual((await get('/api/batch/' + failed.id)).items, httpOutcome.items);
  assert.equal(httpOutcome.items[1].status, 'done');
  await patch({format:'mp4'});
  allowRetry = true;
  const retry = () => fetch(endpoint + '/api/retry', {method:'POST',
    headers:{...headers,'content-type':'application/json'}, signal:t.signal,
    body:JSON.stringify({id:failed.id})});
  const retried = await retry();
  assert.equal(retried.status, 200);
  const {id:retryId,total} = await retried.json();
  assert.notEqual(retryId, failed.id);
  assert.equal(total, 1);
  const afterRetry = await get('/api/batch/' + retryId + '/wait?timeoutMs=15000');
  assert.equal(afterRetry.items[0].status, 'done');
  assert.equal(path.extname(afterRetry.items[0].file), '.mkv');
  assert.equal((await get('/api/batch/' + failed.id)).items[0].status, 'error');
  assert.deepEqual(await (await retry()).json(), {id:retryId,total:1});
  const malformed = await tool('start_download',{items:[{kind:'stream',url:'not a URL'},{kind:'stream',url:movie.url}]});
  const malformedResult = await tool('wait_for_download',malformed);
  assert.equal(malformedResult.status,'partial');
  assert.deepEqual(malformedResult.items.map(entry => entry.errorCode ?? entry.status),['INVALID_URL','done']);
  const denied = await fetch(endpoint+'/api/open', {method:'POST',headers:{...headers,'content-type':'application/json'},
    body:JSON.stringify({file:'C:/Windows/win.ini'}),signal:t.signal});
  assert.equal((await denied.json()).error.code, 'INVALID_PATH');
});
