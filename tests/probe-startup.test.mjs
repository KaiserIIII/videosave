import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { discover } from '../tools/media-source.mjs';
import { executable } from './compatibility-browsers.mjs';

const browser = process.env.BROWSER_BIN || process.env.EDGE_BIN || executable('edge') || executable('chrome');
if (browser) process.env.BROWSER_BIN = browser;

async function pageFixture(t) {
  let requests = 0;
  const server = createServer((req,res) => {
    if (req.url === '/') {
      requests++;
      res.setHeader('content-type','text/html');
      res.end('<!doctype html><title>Probe startup fixture</title><video preload="none" src="/film.mp4"></video>');
      return;
    }
    res.writeHead(404).end();
  }).listen(0,'127.0.0.1');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await once(server,'listening');
  return {url:new URL(`http://127.0.0.1:${server.address().port}/`),requests:() => requests};
}

function observeCdp(t, interrupt) {
  let connections = 0;
  const RealWebSocket = globalThis.WebSocket;
  class ObservedSocket extends RealWebSocket {
    #connection = ++connections;
    send(payload) {
      if (interrupt(JSON.parse(payload).method,this.#connection)) this.close();
      else super.send(payload);
    }
  }
  globalThis.WebSocket = ObservedSocket;
  t.after(() => { globalThis.WebSocket = RealWebSocket; });
  return () => connections;
}

test('a live Chromium target list can be empty before its first blank tab is registered', {skip:!browser}, async t => {
  const page = await pageFixture(t);
  const fetch = globalThis.fetch;
  let listings = 0;
  globalThis.fetch = (url,...args) => new URL(url).pathname === '/json/list' && ++listings === 1
    ? Promise.resolve(Response.json([])) : fetch(url,...args);
  t.after(() => { globalThis.fetch = fetch; });
  const result = await discover(page.url,[],AbortSignal.timeout(30_000),{waitMs:2400});
  assert.equal(result.streams[0]?.url,new URL('/film.mp4',page.url).href);
  assert.equal(page.requests(),1);
  assert.equal(result.browserProbe,undefined);
  assert.ok(listings >= 2);
});

test('an early CDP disconnect retries once with a fresh probe and navigates only once', {skip:!browser}, async t => {
  const page = await pageFixture(t);
  const connections = observeCdp(t,(method,number) => method === 'Network.enable' && number === 1);
  const result = await discover(page.url,[],AbortSignal.timeout(40_000),{waitMs:600});
  assert.equal(connections(),2);
  assert.equal(page.requests(),1);
  assert.equal(result.streams[0]?.url,new URL('/film.mp4',page.url).href);
  assert.deepEqual(result.browserProbe,{stage:'observe',attempts:2});
});

test('two early disconnects return a bounded diagnostic without requesting the page', {skip:!browser}, async t => {
  const page = await pageFixture(t);
  const connections = observeCdp(t,method => method === 'Network.enable');
  const result = await discover(page.url,[],AbortSignal.timeout(40_000),{waitMs:600});
  assert.equal(connections(),2);
  assert.equal(page.requests(),0);
  assert.deepEqual(result.streams,[]);
  assert.equal(result.reason,'timeout');
  assert.deepEqual(result.browserProbe,{stage:'setup',attempts:2});
});

test('losing CDP while sending navigation does not replay a potentially submitted request', {skip:!browser}, async t => {
  const page = await pageFixture(t);
  const connections = observeCdp(t,method => method === 'Page.navigate');
  const result = await discover(page.url,[],AbortSignal.timeout(30_000),{waitMs:600});
  assert.equal(connections(),1);
  assert.equal(result.reason,'timeout');
  assert.deepEqual(result.browserProbe,{stage:'navigate',attempts:1});
});

test('cancelling a probe during browser setup never launches a retry', {skip:!browser}, async t => {
  const page = await pageFixture(t);
  const abort = new AbortController();
  const cancelled = new Error('test probe cancelled');
  const connections = observeCdp(t,method => {
    if (method !== 'Network.enable') return false;
    abort.abort(cancelled);
    return true;
  });
  await assert.rejects(discover(page.url,[],abort.signal,{waitMs:600}),error => error === cancelled);
  assert.equal(connections(),1);
  assert.equal(page.requests(),0);
});
