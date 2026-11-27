import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prefetchDash } from '../tools/dash-prefetch.mjs';
import { FFMPEG, probeStream } from '../tools/media-source.mjs';

const template = (base, media = 'chunk-stream$RepresentationID$-$Number%05d$.m4s?part=public') =>
  `<BaseURL>${base}</BaseURL><SegmentTemplate timescale="1" initialization="init-stream$RepresentationID$.m4s" media="${media}">
    <SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline>
  </SegmentTemplate>`;

const manifest = (video, audio) => `<?xml version="1.0"?>
  <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S">
    <Period><AdaptationSet mimeType="video/mp4">${video}<Representation id="0" height="90" bandwidth="120000"/></AdaptationSet>
      <AdaptationSet mimeType="audio/mp4" lang="en">${audio}<Representation id="1" bandwidth="64000"/></AdaptationSet>
    </Period>
  </MPD>`;

test('static DASH stages signed cross-origin resources through its supplied request policy and muxes both tracks', {timeout:18000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-dash-'));
  t.after(() => rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const encode = args => execFileSync(FFMPEG,['-v','error','-nostdin','-y',...args],{cwd:root,timeout:10000,windowsHide:true});
  encode(['-f','lavfi','-i','testsrc2=s=160x90:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t','2','-c:v','libx264','-g','10','-sc_threshold','0','-c:a','aac','-f','dash','-seg_duration','1','seed.mpd']);
  const names = await readdir(root);
  assert.ok(names.includes('init-stream0.m4s') && names.includes('chunk-stream0-00002.m4s'));
  const hits = [];
  const cdn = createServer(async (req,res) => {
    hits.push(req.url);
    const name = /^\/(init-stream[01]\.m4s|chunk-stream[01]-0000[12]\.m4s\?part=public&token=fixture)$/.exec(req.url)?.[1].split('?')[0];
    if (!name || !names.includes(name)) return res.writeHead(404).end();
    res.end(await readFile(path.join(root,name)));
  }).listen(0,'127.0.0.1');
  t.after(() => { cdn.closeAllConnections(); cdn.close(); });
  await once(cdn,'listening');
  const cdnUrl = `http://127.0.0.1:${cdn.address().port}/`;
  const document = manifest(template(cdnUrl),template(cdnUrl)).replaceAll('?part=public','?part=public&amp;token=fixture');
  const site = createServer((_req,res) => res.end(document)).listen(0,'127.0.0.1');
  t.after(() => { site.closeAllConnections(); site.close(); });
  await once(site,'listening');
  const source = new URL(`http://127.0.0.1:${site.address().port}/manifest?entry=signed`);
  const signal = AbortSignal.timeout(10000);
  const work = await mkdtemp(path.join(root,'stage-'));
  const staged = await prefetchDash(source,work,signal,() => {},{
    fetchResource:async (url,{signal:requestSignal}) => {
      assert.ok([source.origin,new URL(cdnUrl).origin].includes(url.origin));
      return fetch(url,{signal:requestSignal,redirect:'error'});
    },
  });
  assert.ok(staged.endsWith('.mkv'));
  const result = await probeStream(staged,[],signal,true);
  assert.equal(result.width,160);
  assert.ok(Math.abs(result.duration-2) < 0.12);
  assert.deepEqual(result.tracks.map(track => track.codec_type),['video','audio']);
  assert.deepEqual(hits.sort(),['/chunk-stream0-00001.m4s?part=public&token=fixture','/chunk-stream0-00002.m4s?part=public&token=fixture',
    '/chunk-stream1-00001.m4s?part=public&token=fixture','/chunk-stream1-00002.m4s?part=public&token=fixture',
    '/init-stream0.m4s','/init-stream1.m4s']);
});

test('DASH stops before any media request if an MPD declares protected content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-dash-drm-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const source = new URL('https://media.example/film.mpd');
  const calls = [];
  await assert.rejects(() => prefetchDash(source,root,AbortSignal.timeout(3000),() => {},{
    fetchResource:async url => {
      calls.push(url.href);
      return new Response(manifest(template('https://cdn.example/'),template('https://cdn.example/')).replace(
        '<Representation id="0"', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/><Representation id="0"'));
    },
  }),{code:'DRM'});
  assert.deepEqual(calls,[source.href]);
});

test('DASH checks initialization for protected content before requesting media segments', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-dash-init-'));
  t.after(() => rm(root,{recursive:true,force:true,maxRetries:5}));
  const source = new URL('https://media.example/film.mpd');
  const calls = [];
  const xml = manifest(template('https://media.example/'),'').replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/,'');
  const init = Buffer.from([0,0,0,8,0x70,0x73,0x73,0x68]);
  await assert.rejects(() => prefetchDash(source,root,AbortSignal.timeout(3000),() => {},{
    fetchResource:async (url,{kind}) => {
      calls.push(kind);
      return new Response(url.href === source.href ? xml : init);
    },
  }),{code:'DRM'});
  assert.deepEqual(calls,['manifest','init']);
});

test('DASH SegmentList and SegmentBase stage exact ranges from a single fragmented media file', {timeout:18000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-dash-ranges-'));
  t.after(() => rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  execFileSync(FFMPEG,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=160x90:r=10',
    '-t','2','-c:v','libx264','-g','10','-sc_threshold','0','-f','dash','-seg_duration','1',
    '-single_file','1','-global_sidx','1','seed.mpd'],{cwd:root,timeout:10000,windowsHide:true});
  const media = await readFile(path.join(root,'seed-stream0.mp4'));
  const list = await readFile(path.join(root,'seed.mpd'),'utf8');
  const indexTag = media.indexOf('sidx','ascii');
  assert.ok(indexTag >= 4);
  const indexStart = indexTag - 4;
  const indexEnd = indexStart + media.readUInt32BE(indexStart) - 1;
  const base = list.replace(/<SegmentList[^>]*>[\s\S]*?<\/SegmentList>/,
    `<SegmentBase indexRange="${indexStart}-${indexEnd}"><Initialization range="0-${indexStart-1}"/></SegmentBase>`);
  const source = new URL('https://media.example/film.mpd');
  const signal = AbortSignal.timeout(10000);
  for (const [kind,xml] of [['list',list],['base',base]]) {
    const requests = [];
    const work = await mkdtemp(path.join(root,kind + '-'));
    const staged = await prefetchDash(source,work,signal,() => {},{
      fetchResource:async (url,{range,kind}) => {
        requests.push({kind,range,url:url.href});
        if (url.href === source.href) return new Response(xml);
        assert.equal(url.pathname,'/seed-stream0.mp4');
        assert.ok(range && range.end < media.length);
        return new Response(media.subarray(range.start,range.end+1),{status:206,
          headers:{'content-range':`bytes ${range.start}-${range.end}/${media.length}`}});
      },
    });
    const result = await probeStream(staged,[],signal,true);
    assert.equal(result.duration,2);
    assert.deepEqual(result.tracks.map(track => track.codec_type),['video']);
    assert.equal(requests.filter(request => request.kind === 'index').length,kind === 'base' ? 1 : 0);
    assert.equal(requests.filter(request => request.kind === 'segment').length,2);
  }
});

test('DASH that receives explicit denial never tries another CDN', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-dash-access-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const source = new URL('https://media.example/film.mpd');
  const urls = [];
  const video = template('https://first.example/').replace('</BaseURL>','</BaseURL><BaseURL>https://second.example/</BaseURL>');
  const xml = manifest(video,'').replace(/<AdaptationSet mimeType="audio\/mp4"[\s\S]*?<\/AdaptationSet>/,'');
  await assert.rejects(() => prefetchDash(source,root,AbortSignal.timeout(3000),() => {},{
    connections:1,
    fetchResource:async url => {
      urls.push(url.origin);
      return url.href === source.href ? new Response(xml) : new Response(null,{status:403});
    },
  }),{code:'MEDIA_ACCESS_RESTRICTED'});
  assert.deepEqual(urls,[source.origin,'https://first.example']);
  assert.deepEqual(await readdir(root),[]);
});

test('DASH merges contiguous periods with the same tracks and retains the selected text subtitle', {timeout:18000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-dash-periods-'));
  t.after(() => rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  execFileSync(FFMPEG,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=160x90:r=10',
    '-t','2','-c:v','libx264','-g','10','-sc_threshold','0','-f','dash','-seg_duration','1','seed.mpd'],
  {cwd:root,timeout:10000,windowsHide:true});
  const xml = `<MPD type="static" mediaPresentationDuration="PT4S">${[0,2].map(start => `
    <Period start="PT${start}S" duration="PT2S">
      <AdaptationSet mimeType="video/mp4">${template('https://media.example/','chunk-stream$RepresentationID$-$Number%05d$.m4s')}
        <Representation id="0" height="90" bandwidth="120000"/>
      </AdaptationSet>
      <AdaptationSet mimeType="text/vtt" lang="en"><Representation><BaseURL>captions.vtt</BaseURL></Representation></AdaptationSet>
    </Period>`).join('')}</MPD>`;
  const work = await mkdtemp(path.join(root,'stage-'));
  const signal = AbortSignal.timeout(10000);
  const source = new URL('https://media.example/film.mpd');
  const staged = await prefetchDash(source,work,signal,() => {},{
    subtitles:true,
    fetchResource:async url => {
      if (url.href === source.href) return new Response(xml);
      if (url.pathname === '/captions.vtt') return new Response('WEBVTT\n\n00:00.100 --> 00:01.000\nTest caption\n');
      const file = /^\/(init-stream0\.m4s|chunk-stream0-0000[12]\.m4s)$/.exec(url.pathname)?.[1];
      assert.ok(file);
      return new Response(await readFile(path.join(root,file)));
    },
  });
  const result = await probeStream(staged,[],signal,true);
  assert.equal(result.duration,4);
  assert.deepEqual(result.tracks.map(track => track.codec_type),['video','subtitle']);
});
