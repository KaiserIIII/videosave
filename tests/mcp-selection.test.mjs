import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('..', import.meta.url));

test('MCP gives a client evidence to choose the full film over the autoplay teaser', {timeout: 90_000}, async t => {
  const out = await mkdtemp(path.join(project, '.mcp-selection-'));
  t.after(() => rm(out, {recursive:true, force:true, maxRetries:5}));
  const media = new Map();
  for (const [name, dimensions, duration] of [['101','160x90','2'], ['102','320x180','5'], ['103','480x270','5']]) {
    const file = path.join(out, `${name}.mp4`);
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-f','lavfi','-i',`testsrc2=size=${dimensions}:rate=10`,
      '-t',duration,'-c:v','libx264','-movflags','+faststart',file], {windowsHide:true});
    media.set(`/${name}.mp4`, await readFile(file));
  }
  media.set('/104.mp4', media.get('/101.mp4'));
  media.set('/105.mp4', media.get('/101.mp4'));

  const server = createServer((req, res) => {
    const bytes = media.get(req.url);
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
          <a href="/watch/other">Another film</a>
        </main><script>fetch('/105.mp4').then(res => res.arrayBuffer())</script>`);
    } else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/watch/film`;
  const proc = spawn(process.execPath, [path.join(project, 'tools', 'mcp-server.mjs')], {
    env:{...process.env, OUT_DIR:out}, stdio:['pipe','pipe','inherit'], windowsHide:true, signal:t.signal,
  });
  const exited = once(proc, 'close');
  t.after(async () => { proc.stdin.end(); await exited; });
  const replies = createInterface({input:proc.stdout})[Symbol.asyncIterator]();
  let nextId = 0;
  const send = request => proc.stdin.write(JSON.stringify({jsonrpc:'2.0', ...request}) + '\n');
  const call = async (method, params) => {
    const id = ++nextId;
    send({id, method, params});
    const {value} = await replies.next();
    assert.ok(value, 'MCP closed before replying');
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    assert.ok(reply.result && !reply.result.isError, value);
    return reply.result;
  };
  const tool = async (name, args) => (await call('tools/call', {name, arguments:args})).structuredContent;

  await call('initialize', {protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'selection-test',version:'1'}});
  send({method:'notifications/initialized'});
  const {tools} = await call('tools/list', {});
  assert.equal(tools.length, 5);
  const {pageTitle, pageContext, streams, pages} = await tool('probe_page', {url});
  assert.equal(pageTitle, 'Festival screenings');
  assert.deepEqual(pageContext, {url, heading:'Festival screenings', description:'Festival screenings and extras',
    titleSource:'heading', playerCount:2});
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
  assert.equal(movie.discoveredBy, 'player');
  assert.equal(movie.player.visible, true);
  assert.equal(movie.player.playing, false);
  assert.notEqual(movie.player.id, teaser.player.id);
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

  const {id} = await tool('start_download', {items:[{kind:'stream', url:movie.url, title:movie.title}]});
  let progress = await tool('get_progress', {id});
  while (progress.status === 'running') {
    await sleep(150, undefined, {signal:t.signal});
    progress = await tool('get_progress', {id});
  }
  const [item] = progress.items;
  assert.equal(item.status, 'done', JSON.stringify(progress));
  assert.equal(item.percent, 100);
  const output = JSON.parse(execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v','error','-of','json','-show_entries',
    'format=duration:stream=width,height',item.file], {encoding:'utf8',windowsHide:true}));
  assert.deepEqual(output.streams[0], {width:320,height:180});
  assert.equal(Number(output.format.duration), 5);
});
