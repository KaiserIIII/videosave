import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectCdp, withChromium, withEdge } from '../tools/edge-session.mjs';
import { createTestSandbox } from './test-sandbox.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));

const browser = process.env.VIDEOSAVE_HLS_BROWSER;
const launch = browser ? withChromium : withEdge;
const fragmented = process.env.VIDEOSAVE_HLS_FMP4 === '1';
const segmentExtension = fragmented ? 'm4s' : 'ts';
const publicSource = process.env.VIDEOSAVE_BROWSER_HLS_URL;
const publicPage = process.env.VIDEOSAVE_BROWSER_HLS_PAGE;
const expectedPublicMedia = JSON.parse(process.env.VIDEOSAVE_BROWSER_HLS_EXPECTED ??
  '{"width":320,"height":184,"duration":634.633,"audio":true}');
const endpoint = process.env.VIDEOSAVE_HLS_BENCH_ENDPOINT;
const token = process.env.VIDEOSAVE_HLS_BENCH_TOKEN;

test(endpoint ? 'Chromium saves complete HLS video through the paired panel'
  : 'Chromium saves complete HLS video through the panel without a companion', async t => {
  const sandbox = await createTestSandbox('browser-hls');
  const restoreEnv = sandbox.applyProcessEnv();
  const directory = sandbox.downloads;
  t.after(async () => { restoreEnv(); await sandbox.cleanup(); });
  const requests = new Map();
  let holdSegments = false;
  let holdLastSegment = false;
  let laterRequestBeforeFirstResponse = false;
  let firstResponseStarted = false;
  let firstResponseSent = false;
  let releaseFirstSegment;
  const firstSegmentBarrier = new Promise(resolve => { releaseFirstSegment = resolve; });
  let stalledAt;
  let retriedAt;
  let resumedRange;
  let resumeValidator;
  const sharedFileRanges = [];
  const server = createServer(async (req, res) => {
    const filename = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[a-z0-9.-]+$/i.test(filename)) return res.writeHead(404).end();
    const data = await readFile(path.join(directory, filename)).catch(() => null);
    if (!data) return res.writeHead(404).end();
    const count = (requests.get(filename) ?? 0) + 1;
    requests.set(filename, count);
    res.setHeader('cache-control', 'no-store');
    if (filename === 'shared.m4s') {
      sharedFileRanges.push(req.headers.range);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!range) return res.writeHead(400).end();
      const [,start,end] = range.map(Number);
      const part = data.subarray(start, end + 1);
      return res.writeHead(206, {'content-range':`bytes ${start}-${end}/${data.length}`,
        'content-length':part.length, etag:'"shared"'}).end(part);
    }
    if (holdSegments && filename.endsWith('.' + segmentExtension)) return;
    if (holdLastSegment && filename === 'film9.' + segmentExtension) return;
    if (filename === 'film0.' + segmentExtension && count === 1) {
      firstResponseStarted = true;
      // Hold segment 0 at an explicit synchronization barrier until a later segment arrives
      // (with a bounded safety timeout so broken serial scheduling still fails the assertion).
      await Promise.race([firstSegmentBarrier, sleep(8000, undefined, { signal }).catch(() => {})]);
      firstResponseSent = true;
    }
    if (filename === 'film8.' + segmentExtension && firstResponseStarted && !firstResponseSent) {
      laterRequestBeforeFirstResponse = true;
      releaseFirstSegment?.();
    }
    if (filename === 'film1.' + segmentExtension && count === 1) return res.writeHead(503).end();
    if (filename === 'film2.' + segmentExtension) {
      if (count === 1) {
        stalledAt = performance.now();
        res.writeHead(200, {'content-length':data.length, 'accept-ranges':'bytes', etag:'"segment2"'});
        res.write(data.subarray(0, 512));
        return;
      }
      retriedAt ??= performance.now();
      resumedRange = req.headers.range;
      resumeValidator = req.headers['if-range'];
      if (resumedRange === `bytes=512-${data.length - 1}` && resumeValidator === '"segment2"') {
        res.writeHead(206, {'content-range':`bytes 512-${data.length - 1}/${data.length}`,
          'content-length':data.length - 512, etag:'"segment2"'});
        return res.end(data.subarray(512));
      }
    }
    res.end(data);
  });
  const signal = AbortSignal.timeout(60_000);
  async function until(get) {
    while (!signal.aborted) {
      const result = await get();
      if (result) return result;
      await sleep(150, undefined, {signal});
    }
    signal.throwIfAborted();
  }
  try {
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=s=320x240:r=24',
      '-f','lavfi','-i','sine=frequency=800','-t','10','-c:v','libx264','-pix_fmt','yuv420p',
      '-g','24','-sc_threshold','0','-c:a','aac','-hls_time','1','-hls_list_size','0',
      ...(fragmented ? ['-hls_segment_type','fmp4'] : []),'film.m3u8'],
    {cwd:directory,windowsHide:true});
    await writeFile(path.join(directory, 'master.m3u8'), [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080',
      'high.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x240',
      'film.m3u8',
      '',
    ].join('\n'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    if (endpoint) assert.ok(publicSource && publicPage && token && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
    const url = publicSource || `http://127.0.0.1:${server.address().port}/film.m3u8`;
    await launch(['--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--autoplay-policy=no-user-gesture-required','--load-extension=' + path.join(project,'extension')], async ({list,browserUrl}) => {
      if (browser && !(await list()).some(row => row.type === 'service_worker' && row.url.endsWith('/background.mjs'))) {
        const inspector = await connectCdp(browserUrl, signal);
        try { await inspector.send('Extensions.loadUnpacked', {path:path.join(project,'extension')}); }
        finally { inspector.close(); }
      }
      const findServiceWorker = async (excludeId = null) => (await list()).find(
        row => row.type === 'service_worker' && row.url.endsWith('/background.mjs') && row.id !== excludeId,
      );
      let worker = await until(() => findServiceWorker());
      const tab = (await list()).find(row => row.url === 'about:blank');
      const page = await connectCdp(tab.webSocketDebuggerUrl, signal);
      let service = await connectCdp(worker.webSocketDebuggerUrl, signal);
      const ensureServiceReady = async () => until(async () => {
        try {
          const ready = await service.evaluate(
            'Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.downloads && globalThis.chrome?.runtime)',
          );
          if (ready) return true;
        } catch (error) {
          if (signal.aborted) throw error;
          // MV3 worker may restart or expose a transient pre-binding context; rediscover the same extension worker.
          const current = await findServiceWorker().catch(() => null);
          if (current?.webSocketDebuggerUrl && current.id !== worker.id) {
            worker = current;
            service.close();
            service = await connectCdp(worker.webSocketDebuggerUrl, signal);
          }
        }
        return false;
      });
      const evalService = async expression => {
        await ensureServiceReady();
        try {
          return await service.evaluate(expression);
        } catch (error) {
          if (signal.aborted || !/chrome is not defined|Execution context|调试连接已关闭/i.test(error?.message ?? '')) {
            throw error;
          }
          await ensureServiceReady();
          return service.evaluate(expression);
        }
      };
      const popupUrl = new URL('/popup.html', worker.url).href;
      let popup = page;
      let cdp;
      let phase = 'discover';
      let lastJob;
      try {
        await ensureServiceReady();
        if (endpoint) {
          await evalService(`chrome.storage.local.set(${JSON.stringify({connection:{endpoint,token}})})`);
        }
        if (publicPage) {
          await page.send('Page.navigate', {url:publicPage});
          await page.send('Page.bringToFront');
          await until(() => page.evaluate('document.querySelector("video")?.currentTime > 0.1').catch(() => false));
          phase = 'find media row';
          cdp = await connectCdp(browserUrl, signal);
          const {targetId} = await cdp.send('Target.createTarget', {url:popupUrl,background:true});
          const target = await until(async () => (await list()).find(row => row.id === targetId));
          popup = await connectCdp(target.webSocketDebuggerUrl, signal);
          await page.send('Page.bringToFront');
          await popup.send('Page.reload');
        } else {
          await popup.send('Page.navigate', {url:popupUrl});
        }
        await until(() => popup.evaluate('document.readyState === "complete" && Boolean(document.querySelector("#manual-url"))').catch(() => false));
        const mediaButton = `([...document.querySelectorAll('#media li')].find(row=>row.dataset.url===${JSON.stringify(url)})?.querySelector('.download-button'))`;
        if (publicPage) await until(() => popup.evaluate(`Boolean(${mediaButton})`));
        const started = performance.now();
        phase = 'queue and save';
        if (publicPage) await popup.evaluate(`${mediaButton}.click()`);
        else await popup.evaluate(`document.querySelector('#manual-url').value = ${JSON.stringify(url)};
          document.querySelector('#manual').requestSubmit();`);
        await until(async () => {
          const state = await popup.evaluate('document.querySelector("#status")?.innerText');
          const jobs = await evalService('chrome.storage.local.get("downloadJobs").then(s => s.downloadJobs ?? [])');
          assert.doesNotMatch(state, /需要连接本机服务|requires the local service|Connect the local service/i);
          assert.ok(jobs[0]?.state !== 'failed', jobs[0]?.note);
          if (jobs[0]) {
            const {state,percent,bytes} = jobs[0];
            lastJob = {state,percent,bytes};
          }
          return jobs[0]?.state === 'done';
        });
        const files = await evalService('chrome.downloads.search({state:"complete"})');
        assert.equal(files.length, 1);
        assert.match(files[0].filename, /\.(?:ts|mp4)$/i);
        const output = JSON.parse(execFileSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v','error','-of','json',
          '-show_entries','format=duration:stream=codec_type,width,height',files[0].filename], {encoding:'utf8',windowsHide:true}));
        assert.equal(output.streams.some(stream => stream.codec_type === 'audio'), publicSource ? expectedPublicMedia.audio : true);
        const video = output.streams.find(stream => stream.codec_type === 'video');
        assert.ok(video?.width && video?.height);
        if (publicSource) {
          assert.deepEqual([video.width,video.height],[expectedPublicMedia.width,expectedPublicMedia.height]);
          assert.ok(Math.abs(Number(output.format.duration) - expectedPublicMedia.duration) < 0.1);
        } else {
          assert.equal(path.extname(files[0].filename), fragmented ? '.mp4' : '.ts');
          assert.deepEqual([video.width,video.height],[320,240]);
          assert.ok(Math.abs(Number(output.format.duration) - 10) < 0.2);
          assert.deepEqual(Object.fromEntries(requests), {'film.m3u8':1, ...(fragmented && {'init.mp4':1}),
            ...Object.fromEntries(Array.from({length:10}, (_, index) => ['film' + index + '.' + segmentExtension, [1,2].includes(index) ? 2 : 1]))});
          assert.ok(laterRequestBeforeFirstResponse, 'a slow first segment should not leave available connections idle');
          assert.ok(retriedAt - stalledAt < 15_000, 'retry a stalled body within 15 seconds');
          const stalledFragment = await readFile(path.join(directory, 'film2.' + segmentExtension));
          assert.equal(resumedRange, `bytes=512-${stalledFragment.length - 1}`);
          assert.equal(resumeValidator, '"segment2"');
          const names = [
            ...(fragmented ? ['init.mp4'] : []),
            ...Array.from({length:10}, (_, index) => 'film' + index + '.' + segmentExtension),
          ];
          const expected = Buffer.concat(await Promise.all(names.map(name => readFile(path.join(directory, name)))));
          assert.ok((await readFile(files[0].filename)).equals(expected), 'download preserves exact fragment bytes');
        }
        const elapsed = Math.round(performance.now() - started);
        console.log(`Browser HLS saved in ${elapsed} ms`, video, output.format);
        if (publicSource) {
          const data = await readFile(files[0].filename);
          console.log(JSON.stringify({tool:'VideoSave',paired:Boolean(endpoint),ms:elapsed,bytes:data.length,
            sha256:createHash('sha256').update(data).digest('hex')}));
        }
        if (!publicSource) {
          const segment = 'film0.' + segmentExtension;
          const previous = requests.get(segment);
          holdSegments = true;
          await popup.evaluate('document.querySelector("#manual").requestSubmit()');
          await until(() => requests.get(segment) > previous);
          const id = await evalService('chrome.storage.local.get("downloadJobs").then(s => s.downloadJobs[0].id)');
          const result = await popup.evaluate(`chrome.runtime.sendMessage({scope:'media-downloads', action:'cancel',id:${JSON.stringify(id)}})`);
          assert.equal(result.jobs[0].state, 'cancelled', result.error);
          assert.equal((await evalService('chrome.downloads.search({})')).length, 1);
          assert.deepEqual(await evalService(`(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('hls-downloads');
            return Array.fromAsync(dir.keys());
          })()`), []);
          holdSegments = false;
          const master = new URL('master.m3u8', url).href;
          const selected = await popup.evaluate(`chrome.runtime.sendMessage({
            scope:'media-downloads', action:'enqueue', streams:[{url:${JSON.stringify(master)},
              kind:'m3u8', title:'240p', options:{quality:'360'}}]
          })`);
          assert.ifError(selected.error);
          await until(async () => {
            const jobs = await evalService('chrome.storage.local.get("downloadJobs").then(s => s.downloadJobs)');
            const job = jobs.find(entry => entry.title === '240p');
            assert.notEqual(job?.state, 'failed', job?.note);
            return job?.state === 'done';
          });
          const completed = await evalService('chrome.downloads.search({state:"complete"})');
          assert.equal(completed.length, 2);
          assert.ok(completed.some(file => path.basename(file.filename) === '240p.' + (fragmented ? 'mp4' : 'ts')));
          assert.equal(requests.get('master.m3u8'), 1);
          assert.ok(!requests.has('high.m3u8'));

          holdLastSegment = true;
          const lastPart = 'film9.' + segmentExtension;
          const beforeLast = requests.get(lastPart);
          await popup.evaluate('document.querySelector("#manual").requestSubmit()');
          await until(() => requests.get(lastPart) > beforeLast);
          const unfinished = await until(() => evalService(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) => {
            const job = downloadJobs[0];
            return job.state === 'processing' && job.percent >= ${fragmented ? 90 : 89} && job.id;
          })`));
          const savedRequests = new Map(requests);
          await evalService('setTimeout(() => chrome.runtime.reload(), 100); true');
          holdLastSegment = false;
          await until(async () => !(await list()).some(row => row.id === worker.id));
          cdp ??= await connectCdp(browserUrl, signal);
          await cdp.send('Target.createTarget', {url:popupUrl});
          const newWorker = await until(() => findServiceWorker(worker.id));
          worker = newWorker;
          service.close();
          service = await connectCdp(newWorker.webSocketDebuggerUrl, signal);
          await ensureServiceReady();
          await until(async () => {
            const job = await evalService(`globalThis.chrome?.storage?.local?.get("downloadJobs").then(({downloadJobs}) =>
              downloadJobs.find(item=>item.id===${JSON.stringify(unfinished)}))`);
            assert.notEqual(job?.state, 'failed', job?.note);
            return job?.state === 'done';
          });
          for (let index = 0; index < 9; index++) {
            const filename = 'film' + index + '.' + segmentExtension;
            assert.equal(requests.get(filename), savedRequests.get(filename), filename + ' was downloaded again');
          }
          if (fragmented) assert.equal(requests.get('init.mp4'), savedRequests.get('init.mp4'));
          assert.equal(requests.get(lastPart), savedRequests.get(lastPart) + 1);
          const restored = await evalService(`chrome.storage.local.get("downloadJobs").then(({downloadJobs}) =>
            chrome.downloads.search({id:downloadJobs.find(item=>item.id===${JSON.stringify(unfinished)}).files[0].id}))`);
          assert.ok((await readFile(restored[0].filename)).equals(await readFile(files[0].filename)));

          execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v','error','-i','film.m3u8','-c','copy',
            ...(!fragmented ? ['-bsf:a','aac_adtstoasc'] : []),
            '-hls_flags','single_file','-hls_segment_type','fmp4','-hls_time','1','-hls_list_size','0','shared.m3u8'],
          {cwd:directory,windowsHide:true});
          const sharedUrl = new URL('shared.m3u8', url).href;
          const sharedPopup = (await list()).find(target => target.url === popupUrl && target.id !== tab.id);
          const sharedPanel = await connectCdp(sharedPopup.webSocketDebuggerUrl, signal);
          try {
            const result = await sharedPanel.evaluate(`chrome.runtime.sendMessage({
              scope:'media-downloads', action:'enqueue', streams:[{url:${JSON.stringify(sharedUrl)},
                kind:'m3u8', title:'Shared file'}]
            })`);
            assert.ifError(result.error);
          } finally { sharedPanel.close(); }
          const sharedJob = await until(async () => {
            const job = await evalService(`chrome.storage.local.get('downloadJobs').then(({downloadJobs}) =>
              downloadJobs.find(item => item.title === 'Shared file'))`);
            assert.notEqual(job?.state, 'failed', job?.note);
            return job?.state === 'done' && job;
          });
          const [saved] = await evalService(`chrome.downloads.search({id:${sharedJob.files[0].id}})`);
          const masterText = await readFile(path.join(directory,'shared.m3u8'),'utf8');
          const expectedRanges = [...masterText.matchAll(/(?:BYTERANGE="|#EXT-X-BYTERANGE:)(\d+)@(\d+)/g)]
            .map(([,length,start]) => `bytes=${start}-${Number(start) + Number(length) - 1}`);
          assert.deepEqual(sharedFileRanges.sort(), expectedRanges.sort());
          assert.ok((await readFile(saved.filename)).equals(await readFile(path.join(directory,'shared.m4s'))));
        }
      } catch (error) {
        if (publicSource) console.error(JSON.stringify({paired:Boolean(endpoint),phase,lastJob}));
        throw error;
      } finally {
        if (popup !== page) popup.close();
        page.close();
        service.close();
        cdp?.close();
      }
    }, signal, {downloadsDirectory:directory, ...(browser && {executable:browser})});
  } finally {
    releaseFirstSegment?.();
    server.closeAllConnections();
    server.close();
  }
});
