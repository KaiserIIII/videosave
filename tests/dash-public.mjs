import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prefetchDash } from '../tools/dash-prefetch.mjs';
import { probeStream } from '../tools/media-source.mjs';

const sources = [
  {id:'dashjs-envivio',url:'https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd',
    publishedBy:'https://github.com/Dash-Industry-Forum/dash.js'},
  {id:'shaka-angel-one',url:'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    publishedBy:'https://github.com/shaka-project/shaka-player/blob/main/docs/tutorials/basic-usage.md'},
];
const results = [];
const settings = {quality:240,subtitles:true,connections:8,deadlineMs:95000};
for (const sample of sources) {
  const source = new URL(sample.url);
  const root = await mkdtemp(path.join(os.tmpdir(),'videosave-public-dash-'));
  const signal = AbortSignal.timeout(settings.deadlineMs);
  const started = performance.now();
  let requests = 0;
  let downloaded = 0;
  try {
    const staged = await prefetchDash(source,root,signal,(_fraction,bytes) => { downloaded = bytes; },{
      ...settings,
      async fetchResource(url,{signal,range}) {
        if (url.origin !== source.origin) throw Error('Origin outside the public test scope');
        requests++;
        return fetch(url,{signal,redirect:'error',headers:{'accept-encoding':'identity',
          ...(range && {range:`bytes=${range.start}-${range.end}`})}});
      },
    });
    const result = await probeStream(staged,[],signal,true);
    const complete = result.duration > 0 && result.tracks?.some(track => track.codec_type === 'video') &&
      result.tracks.some(track => track.codec_type === 'audio');
    results.push({...sample,ms:Math.round(performance.now()-started),requests,downloaded,
      fileSize:(await stat(staged)).size,duration:result.duration,width:result.width,height:result.height,
      tracks:result.tracks?.map(track => track.codec_type) ?? [],complete:Boolean(complete)});
  } catch (error) {
    results.push({...sample,ms:Math.round(performance.now()-started),requests,downloaded,
      code:error.code ?? error.name,complete:false});
  } finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
}
const report = {recordedAt:new Date().toISOString(),platform:process.platform,node:process.version,
  scope:'standalone DASH engine staging and local FFprobe verification',settings,results};
const json = JSON.stringify(report,null,2) + '\n';
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
if (output) await writeFile(output,json,{encoding:'utf8',flag:'wx'});
process.stdout.write(json);
if (results.some(result => !result.complete)) process.exitCode = 1;
