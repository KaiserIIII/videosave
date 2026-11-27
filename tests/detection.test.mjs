import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, pageStreams, scanDocument, selectPageStream } from '../extension/media.mjs';
import { assessCandidates, detectionDiagnostic, diagnosticReport } from '../extension/detection.mjs';
import { publicMediaSources } from '../extension/media-adapters.mjs';
import { manifestEvidence } from '../extension/manifest-evidence.mjs';
import { restoreSettingsBackup, settingsBackup } from '../extension/settings.mjs';

const base = new URL('https://example.org/watch/film');
const movie = 'https://example.org/media/film.m3u8';

test('adapters only read explicit source fields and keep a deterministic fallback', () => {
  const data = {Player:{sources:[{file:'/media/film.m3u8',label:'720p'},{src:'/media/film.mp4'},
    {file:'https://cdn.example.com/film.m3u8'},{file:'https://user:pw@example.org/film.mp4'}]},
    tracking:{url:'/ad.mp4'}, source:'https://example.org/not-a-source.mp4'};
  const sources = publicMediaSources(data,base,{strategy:'page-config'});
  assert.deepEqual(sources.map(row => [row.url,row.height??null,row.strategy]),[
    [movie,720,'page-config'], ['https://example.org/media/film.mp4',null,'page-config'],
    ['https://cdn.example.com/film.m3u8',null,'page-config'],
  ]);
  assert.equal(publicMediaSources(data,base,{strategy:'xhr-json',sameOrigin:true}).length,2);
});

test('prefers confirmed media formats and suppresses normal fMP4 segment names', () => {
  assert.equal(classify('https://example.org/watch.m3u8','video/mp4'),'mp4');
  assert.equal(classify('https://example.org/segment_002.mp4','video/mp4'),null);
  assert.equal(classify('https://example.org/media-id','video/mp2t',true),'ts');
  assert.equal(classify('https://example.org/media-id','video/mp2t'),null);
  assert.equal(classify('https://example.org/audio-id','audio/mpeg',true),'mp3');
});

test('an explicit trailer is never picked when there is a plausible full candidate', () => {
  const rows = [
    {url:'https://example.org/preview.mp4',kind:'mp4',discoveredBy:'player',title:'Official teaser',duration:120,playing:true},
    {url:movie,kind:'m3u8',discoveredBy:'player-playlist',title:'Full film',duration:80},
  ];
  assert.equal(selectPageStream(rows).url,movie);
  assert.ok(assessCandidates(rows)[0].evidence.includes('preview-label'));
  assert.equal(selectPageStream(rows.slice(0,1)).status,'ambiguous');
});

test('a content declaration complements observation without creating a second candidate', () => {
  const observation = {playerCount:0,candidates:[],publicConfigs:[
    {strategy:'page-config',base:base.href,json:'{"sources":[{"file":"/media/film.m3u8","height":720}]}'},
  ]};
  const rows = pageStreams([{frameId:0,result:observation}],[
    {url:movie,frameId:0,mime:'application/x-mpegurl',type:'fetch'},
  ]);
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].strategies,['network','page-config']);
  assert.equal(rows[0].height,720);
  assert.equal(rows[0].observed,true);
});

test('diagnostics distinguish a lack of playback from DRM and strip all raw content on export', () => {
  assert.equal(detectionDiagnostic({players:1,unloaded:1}).code,'media-not-loaded');
  assert.equal(detectionDiagnostic({players:1,opaque:1}).code,'no-playlist-request');
  assert.equal(detectionDiagnostic({blockers:['login-required']}).code,'login-required');
  assert.equal(detectionDiagnostic({blockers:['drm']}).code,'drm');
  assert.equal(detectionDiagnostic({blockedFrames:1}).code,'frame-access');
  const result = diagnosticReport({diagnostic:{code:'drm',players:2,unknown:'SECRET_COOKIE'}, streams:[
    {url:movie+'?signature=SECRET_QUERY',kind:'m3u8',title:'PRIVATE_PERSON',width:1280,headers:{Cookie:'SECRET_COOKIE'}},
  ],pageContext:{description:'PRIVATE_PERSON'}});
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].kind,'m3u8');
  assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE|example\.org/);
});

test('HLS initialization files and segments do not compete with an observed playlist', () => {
  const init = new URL('fixture-init.mp4',movie).href;
  const evidence = manifestEvidence('#EXTM3U\n#EXT-X-MAP:URI="fixture-init.mp4"\n#EXTINF:1,\npart-1.mp4\n',movie,'m3u8');
  const rows = pageStreams([], [
    {url:init, mime:'video/mp4', frameId:0},
    {url:movie, mime:'application/x-mpegurl', frameId:0,...evidence},
  ]);
  assert.deepEqual(rows.map(row => row.url),[movie]);
});

test('settings backup is versioned, excludes credentials, and rejects invalid imports', () => {
  const backup = settingsBackup({theme:'jade',language:'en',concurrency:8,token:'private',connection:{token:'private'}});
  const restored = restoreSettingsBackup(backup,{theme:['jade','system']});
  assert.equal(restored.theme,'jade');
  assert.equal(restored.concurrency,8);
  assert.doesNotMatch(JSON.stringify(backup),/private|token|connection"/);
  assert.throws(() => restoreSettingsBackup({schema:1,settings:{downloadFolder:'../outside'}}));
  assert.throws(() => restoreSettingsBackup({schema:1,settings:{theme:'arbitrary'}},{theme:['system']}));
});
