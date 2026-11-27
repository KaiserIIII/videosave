import {execFile, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../',import.meta.url));
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = option('baseline');
if (!baseline) throw new Error('Set --baseline to the unpacked v0.8.1 source root.');
const ytDlp = option('yt-dlp') || process.env.YTDLP_BIN || 'yt-dlp';
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const directory = await mkdtemp(path.join(os.tmpdir(),'videosave-hls-benchmark-'));
const connections = 8;
const timeoutMs = 30_000;
const segmentCount = 24;
const mediaFolder = path.join(directory,'media');
const videoVersions = await Promise.all([baseline,root].map(async source => ({
  source,
  version:JSON.parse(await readFile(path.join(source,'extension','manifest.json'),'utf8')).version,
})));
const worker = `
  const media = await import(process.argv[1]);
  try {
    const {id} = media.queue({items:[{kind:'stream',url:process.argv[2],sourceKind:'m3u8',title:'fixture',fastStart:false}],
      concurrency:1,connections:8,prefetch:true});
    const batch = await media.waitForBatch({id,timeoutMs:29_000});
    if (batch.timedOut) media.cancel(id);
    const item = batch.items[0];
    console.log(JSON.stringify({file:item.file, status:batch.timedOut ? 'timeout' : item.status, code:item.errorCode,
      prefetch:item.prefetch}));
  } finally { media.shutdown(); }
`;

function command(bin,args) {
  return execFileSync(bin,args,{windowsHide:true,encoding:'utf8',timeout:timeoutMs});
}

function verification(file) {
  const {format,streams} = JSON.parse(command(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file]));
  const tracks = streams.map(stream => stream.codec_type);
  const duration = Number(format.duration);
  const hashes = command(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-map','0:a:0',
    '-c:v','copy','-c:a','pcm_s16le','-f','streamhash','-hash','SHA256','-']).trim().split(/\r?\n/);
  return {duration,tracks,hashes,width:streams[0].width,height:streams[0].height};
}

await mkdir(mediaFolder);
let server;
try {
  command(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=720',
    '-t',String(segmentCount),'-c:v','libx264','-preset','fast','-pix_fmt','yuv420p','-g','24','-sc_threshold','0',
    '-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0','-hls_segment_filename',
    path.join(mediaFolder,'segment-%02d.ts'),path.join(mediaFolder,'fixture.m3u8')]);
  const manifest = await readFile(path.join(mediaFolder,'fixture.m3u8'));
  const segments = new Map(await Promise.all(Array.from({length:segmentCount},async (_,index) => {
    const name = `segment-${String(index).padStart(2,'0')}.ts`;
    return [name,await readFile(path.join(mediaFolder,name))];
  })));
  const fixtureBytes = [...segments.values()].reduce((sum,bytes) => sum + bytes.length,0);
  const rows = [];
  let measurement;
  server = createServer((req,res) => {
    const current = measurement;
    current.requests++;
    const name = req.url.split('/').at(-1);
    if (name === 'fixture.m3u8') return res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end(manifest);
    const segment = segments.get(name);
    if (!segment) return res.writeHead(404).end();
    current.segmentRequests++;
    const state = current.parts.get(name) ?? {sent:0, attempts:0};
    current.parts.set(name,state);
    state.attempts++;
    current.peak = Math.max(current.peak,++current.active);
    let delay = 160;
    let offset = 0;
    res.writeHead(200,{'content-type':'video/mp2t','content-length':segment.length});
    if (current.scenario === 'slow-tail' && name === 'segment-23.ts' && state.attempts === 1) {
      offset = 1024;
      res.write(segment.subarray(0,offset));
      state.sent += offset;
      delay = 4_200;
    }
    const timer = setTimeout(() => {
      if (res.destroyed) return;
      state.sent += segment.length - offset;
      res.end(segment.subarray(offset));
    },delay);
    res.once('close',() => { clearTimeout(timer); current.active--; });
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const url = `http://127.0.0.1:${server.address().port}/fixture.m3u8`;
  const ytVersion = command(ytDlp,['--version']).trim();
  const products = [...videoVersions.map(video => ({label:`VideoSave ${video.version}`,source:video.source})),
    {label:`yt-dlp ${ytVersion}`}];
  for (const scenario of ['steady','slow-tail']) {
    for (let index = 0; index < products.length; index++) {
      const order = [...products.slice(index),...products.slice(0,index)];
      for (const product of order) {
        const output = path.join(directory,`output-${rows.length}`);
        await mkdir(output);
        const file = path.join(output,'fixture.mp4');
        const env = {...process.env,OUT_DIR:output,MEDIA_TOOLKIT_SETTINGS:path.join(output,'settings.sqlite'),
          NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'};
        const child = product.source ? process.execPath : ytDlp;
        const args = product.source
          ? ['--input-type=module','-e',worker,pathToFileURL(path.join(product.source,'tools','media-downloads.mjs')).href,url]
          : ['--ignore-config','--no-playlist','--proxy','','--downloader','m3u8:native','--concurrent-fragments',String(connections),
            '--abort-on-unavailable-fragments','--no-progress','--no-mtime','--output',file,url];
        measurement = {scenario,requests:0,segmentRequests:0,active:0,peak:0,parts:new Map()};
        const started = performance.now();
        const row = {scenario,round:index + 1,product:product.label};
        let outputFile = file;
        try {
          const {stdout} = await run(child,args,{cwd:root,env,windowsHide:true,timeout:timeoutMs});
          if (product.source) {
            const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
            outputFile = result.file;
            row.status = result.status;
            row.prefetch = result.prefetch;
            row.error = result.code;
          } else row.status = 'done';
        } catch (error) {
          row.status = error.killed ? 'timeout' : 'error';
          row.error = error.code;
        }
        row.elapsedMs = Math.round(performance.now() - started);
        row.requests = measurement.requests;
        row.segmentRequests = measurement.segmentRequests;
        row.peakSegmentRequests = measurement.peak;
        row.mediaBytes = [...measurement.parts.values()].reduce((sum,segment) => sum + segment.sent,0);
        row.repeatedMediaBytes = [...measurement.parts.entries()].reduce((sum,[name,segment]) =>
          sum + Math.max(0,segment.sent - segments.get(name).length),0);
        if (row.status === 'done') {
          try {
            row.fileBytes = (await stat(outputFile)).size;
            row.verified = verification(outputFile);
            if (!row.verified.tracks.includes('video') || !row.verified.tracks.includes('audio') ||
                Math.abs(row.verified.duration - segmentCount) > 0.1) row.status = 'invalid';
          } catch (error) {
            row.status = 'invalid';
            row.error = error.code;
          }
        }
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  const data = {system:process.platform,cpu:os.cpus()[0]?.model,node:process.version,connections,timeoutMs,segmentCount,fixtureBytes,rows};
  const destination = option('output');
  if (destination) await writeFile(path.resolve(destination),JSON.stringify(data,null,2) + '\n');
  if (rows.some(row => row.status !== 'done')) process.exitCode = 1;
} finally {
  if (server) {
    const closed = once(server,'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:200});
}
