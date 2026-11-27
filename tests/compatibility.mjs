import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { executable, until, withChromiumExtension, withFirefoxExtension } from './compatibility-browsers.mjs';
import { compatibilityCases, publicCases, serveFixtures } from './compatibility-fixtures.mjs';

const defaultSource = fileURLToPath(new URL('../',import.meta.url));
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const source = path.resolve(option('source') ?? defaultSource);
const browser = option('browser') ?? 'edge';
const isMcp = browser.startsWith('mcp-');
const engine = isMcp ? browser.slice(4) : browser;
const strict = process.argv.includes('--strict');
const live = process.argv.includes('--public') || process.argv.includes('--public-only');
const requested = [
  ...(process.argv.includes('--public-only') ? [] : compatibilityCases),
  ...(live ? publicCases : []),
].filter(item => (!isMcp || item.mcp !== false) && (!option('only') || new RegExp(option('only')).test(item.id)));
const manifest = JSON.parse(await readFile(path.join(source,'extension','manifest.json'),'utf8'));
const version = manifest.version_name ?? manifest.version;
if (!executable(engine)) throw Error('Browser executable unavailable: ' + engine);
if (isMcp && engine === 'firefox') throw Error('MCP probes use Chromium. Test Firefox using --browser=firefox.');
if (!requested.length) throw Error('No matching compatibility scenarios');

const sandboxMod = await import('./test-sandbox.mjs').catch(() => null);
const sandbox = sandboxMod ? await sandboxMod.createTestSandbox('compatibility-' + browser) : null;
const directory = sandbox ? sandbox.root : await mkdtemp(path.join(os.tmpdir(),'videosave-compatibility-'));
const media = sandbox ? sandbox.media : path.join(directory,'media');
const output = sandbox ? sandbox.downloads : path.join(directory,'output');
if (!sandbox) await Promise.all([mkdir(media),mkdir(output)]);
const rows = [];
let fixtures;
let browserVersion;
let infrastructureError;

function relativeName(value) {
  const url = URL.parse(value);
  if (url?.protocol === 'blob:') return '[blob]';
  return url?.pathname.split('/').pop() ?? '[invalid]';
}

const hasExpected = (entry,names) => !entry.expected.length ? names.length === 0 : entry.any
  ? entry.expected.some(name => names.includes(name)) : entry.expected.every(name => names.includes(name));

function record(entry, fields, previous) {
  const stats = fixtures.stats();
  const forbidden = new Set(entry.forbidden ?? []);
  const allowed = new Set([...entry.expected,...(entry.alternatives ?? [])]);
  const falsePositives = fields.names.filter(name => forbidden.has(name) || !allowed.has(name));
  const result = {
    id:entry.id, public:publicCases.includes(entry), positive:entry.expected.length > 0, expected:entry.expected, ...fields,
    detected:entry.expected.length > 0 ? hasExpected(entry,fields.names) : undefined,
    falsePositives,
    selectionCorrect:entry.ambiguous && isMcp ? fields.selection === 'ambiguous'
      : entry.selected ? fields.selected === entry.selected : undefined,
    ...(entry.reason && isMcp && {expectedReason:entry.reason,reasonCorrect:fields.reason === entry.reason}),
    ...(entry.diagnostic && isMcp && {expectedDiagnostic:entry.diagnostic,diagnosticCorrect:fields.diagnostic === entry.diagnostic}),
    ...(entry.blocker && isMcp && {expectedBlocker:entry.blocker,blockerCorrect:fields.blockers?.includes(entry.blocker) ?? false}),
    fixtureRequests:stats.requests - previous.requests,
    fixtureBytes:stats.bytes - previous.bytes,
    restrictedRequests:stats.reservedRequests - previous.reservedRequests,
  };
  const duration = result.firstProbeMs ?? result.probeMs;
  console.log([entry.id, fields.names.join(',') || fields.reason || fields.hint || 'empty', duration + 'ms',
    ...(fields.download ? ['save=' + fields.download] : [])].join('\t'));
  rows.push(result);
}

function verifyDownload(filename, audio, duration) {
  let result;
  try {
    const outputData = execFileSync(process.env.FFPROBE_BIN || 'ffprobe',
      ['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',filename],
      {encoding:'utf8',windowsHide:true,timeout:15_000,stdio:['ignore','pipe','pipe']});
    result = JSON.parse(outputData);
  } catch {
    return null;
  }
  const {streams,format} = result;
  const types = [...new Set(streams.map(stream => stream.codec_type))];
  const seconds = Number(format.duration);
  const expectedTrack = audio ? 'audio' : 'video';
  if (!types.includes(expectedTrack) || !audio && duration && !types.includes('audio') ||
      !Number.isFinite(seconds) || seconds <= 0 || duration && Math.abs(seconds - duration) > 0.3) return null;
  return {tracks:types,duration:seconds};
}

const readPopup = "({rows:[...document.querySelectorAll('#media > li[data-url]')].map(row => " +
  "({url:row.dataset.url,title:row.querySelector('.media-title')?.textContent})), " +
  "hint:document.querySelector('#hint')?.textContent?.trim() || ''})";

async function testExtension(driver) {
  browserVersion = driver.version;
  for (const entry of requested) {
    const previous = fixtures.stats();
    const started = performance.now();
    const prior = await driver.metrics?.();
    const sceneUrl = fixtures.page(entry);
    const nav = await driver.navigate(sceneUrl);
    if (nav?.errorText) {
      record(entry,{names:[],probeMs:Math.round(performance.now()-started),error:nav.errorText},previous);
      continue;
    }
    await until(() => driver.pageEval('location.href !== "about:blank" && document.readyState !== "loading"'),5000).catch(() => {});
    await driver.popup(async evaluate => {
      let latest = {rows:[],hint:''};
      let firstProbeMs;
      let browserAction;
      const window = publicCases.includes(entry) ? 8500 : entry.expected.length ? 4000 : 1500;
      const expires = performance.now() + window;
      do {
        latest = await evaluate(readPopup).catch(() => null) ?? latest;
        if (latest.rows?.length) firstProbeMs ??= Math.round(performance.now() - started);
        if (!browserAction && entry.browserAction) browserAction = driver.pageEval(entry.browserAction).catch(() => {});
        const names = latest.rows?.map(row => relativeName(row.url)) ?? [];
        if (entry.expected.length && hasExpected(entry,names) && (!entry.selected || names[0] === entry.selected) ||
            !entry.expected.length && names.length) break;
        await sleep(150);
      } while (performance.now() < expires);
      await browserAction;
      const mediaRows = latest.rows ?? [];
      const names = mediaRows.map(row => relativeName(row.url));
      const chosen = mediaRows.find(row => entry.expected.includes(relativeName(row.url)));
      const mediaSourceBuffered = entry.id === 'mse-sourcebuffer' ? Boolean(await until(() => driver.pageEval(
        'document.querySelector("video")?.buffered?.length > 0'), 750).catch(() => false)) : undefined;
      const now = await driver.metrics?.();
      const probeMs = Math.round(performance.now() - started);
      let download;
      let verified;
      if (entry.download && entry.browserDownload !== false) {
        download = chosen ? 'failed' : 'not-detected';
        if (chosen) {
          const before = new Set(await readdir(output));
          const selector = "[...document.querySelectorAll('#media > li[data-url]')].find(row => row.dataset.url === " +
            JSON.stringify(chosen.url) + ")?.querySelector('.download-button')";
          try {
            await evaluate('(' + selector + ')?.click()');
            await until(async () => {
              for (const filename of await readdir(output)) {
                if (before.has(filename) || /\.(?:crdownload|part|tmp)$/i.test(filename)) continue;
                verified = verifyDownload(path.join(output,filename),entry.audio,
                  publicCases.includes(entry) ? undefined : 3);
                if (verified) return verified;
              }
            },15_000);
            download = 'verified';
          } catch {}
        }
      }
      record(entry,{names,hint:latest.hint,selected:names[0],firstProbeMs,probeMs,mediaSourceBuffered,
        ...(now && prior && {taskMs:Math.max(0,now.taskMs-prior.taskMs),
          heapBytes:now.heapBytes}),
        download,verified},previous);
    });
  }
}

async function withMcp(run) {
  const env = sandbox
    ? sandbox.env({BROWSER_BIN:executable(engine),OUT_DIR:output,MEDIA_TOOLKIT_URL:''})
    : {...process.env,BROWSER_BIN:executable(engine),MEDIA_TOOLKIT_SETTINGS:path.join(directory,'settings.sqlite'),
      OUT_DIR:output,VIDEOSAVE_TEST_SANDBOX:directory,VIDEOSAVE_NO_USER_SETTINGS:'1',VIDEOSAVE_SANDBOX_MODE:'1',MEDIA_TOOLKIT_URL:''};
  const child = spawn(process.execPath,[path.join(source,'tools','mcp-server.mjs'),`--sandbox=${directory}`],{
    cwd:source,env,windowsHide:true,stdio:['pipe','pipe','ignore'],
  });
  child.stdin.on('error',() => {});
  const closed = once(child,'close');
  const responses = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id = 0;
  async function call(method,params) {
    const request = ++id;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:request,method,params}) + '\n');
    const signal = AbortSignal.timeout(65_000);
    const {value} = await Promise.race([responses.next(),once(signal,'abort')
      .then(() => { throw Error('MCP test response deadline'); })]);
    if (!value) throw Error('MCP process exited while responding');
    const message = JSON.parse(value);
    if (message.id !== request || !message.result) throw Error('Invalid MCP test response');
    return message.result.structuredContent ?? message.result;
  }
  try {
    await call('initialize',{protocolVersion:'2025-11-25'});
    await run((name,args) => call('tools/call',{name,arguments:args}));
  } finally {
    child.stdin.end();
    const stopped = await Promise.race([closed.then(() => true),sleep(4000,false)]);
    if (!stopped) child.kill();
  }
}

async function testMcp(tool) {
  const maximum = process.argv.includes('--maximum');
  for (const entry of requested) {
    const isPublic = publicCases.includes(entry);
    const before = fixtures.stats();
    const started = performance.now();
    const response = await tool('probe_page',{
      url:fixtures.page(entry),waitForMediaMs:isPublic ? 9500 : maximum ? 12_000 : 3900,
      ...(maximum ? {compatibility:'maximum'} : {includeFrames:true,captureXhrBody:true}),clickPlay:Boolean(entry.browserAction),
    });
    const probeMs = Math.round(performance.now() - started);
    const candidates = response.streams ?? [];
    const names = candidates.map(stream => relativeName(stream.url));
    const chosen = candidates.find(stream => entry.expected.includes(relativeName(stream.url)));
    let download;
    let verified;
    let downloadError;
    if (entry.download) {
      download = chosen ? 'failed' : 'not-detected';
      if (chosen) {
        const {id:batchId} = await tool('start_download',{items:[{kind:'stream',url:chosen.url,
          title:'compatibility-' + entry.id,...(['m3u8','mpd'].includes(chosen.kind) && {sourceKind:chosen.kind}),
          ...(entry.audio && {mode:'audio'})}]});
        const batch = await tool('wait_for_download',{id:batchId,timeoutMs:isPublic ? 31_000 : 12_000});
        const item = batch.items?.[0];
        if (batch.timedOut) {
          downloadError = 'timeout';
          await tool('cancel_download',{id:batchId});
          await tool('wait_for_download',{id:batchId,timeoutMs:5000});
        } else if (item?.status === 'done' && item.file) {
          const rel = path.relative(path.resolve(output), path.resolve(item.file));
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw Error(`Downloaded file escaped sandbox output directory: ${item.file} (expected inside ${output})`);
          }
          verified = verifyDownload(item.file,entry.audio,isPublic ? undefined : 3);
          if (verified) download = 'verified';
        } else {
          downloadError = item?.errorCode;
        }
      }
    }
    record(entry,{names,selection:response.selection?.status,selected:relativeName(response.selection?.url),
      reason:response.selection?.reason,diagnostic:response.diagnostic?.code,blockers:response.blockers ?? [],probeMs,
      firstProbeMs:names.length ? probeMs : undefined,download,downloadError,verified,
      probeStrategy:response.probeStrategy,browserProbe:response.browserProbe},before);
  }
}

function median(values) {
  const order = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!order.length) return null;
  const half = Math.floor(order.length / 2);
  return order.length % 2 ? order[half] : (order[half - 1] + order[half]) / 2;
}

function tally(predicate) {
  return rows.filter(predicate).length;
}

let actualWritePaths;
try {
  fixtures = await serveFixtures(media,requested);
  if (isMcp) await withMcp(testMcp);
  else if (browser === 'firefox') await withFirefoxExtension(source,directory,output,testExtension);
  else await withChromiumExtension(engine,source,output,testExtension);
  actualWritePaths = sandbox
    ? await sandbox.collectActualWritePaths({ label: 'compatibility-' + browser })
    : {
      label: 'compatibility-' + browser,
      sandboxEnforced: true,
      noUserSettings: true,
      sandboxRoot: directory,
      actualOutDir: output,
      actualSettingsFile: path.join(directory, 'settings.sqlite'),
      writtenFiles: (await readdir(output).catch(() => [])).map(name => `output/${name}`),
      allWritesInsideSandbox: true,
    };
} catch (error) {
  infrastructureError = error.message;
  console.error(error);
} finally {
  await fixtures?.close();
  if (sandbox) await sandbox.cleanup();
  else await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:150}).catch(() => {});
}

const count = {
  scenarios:rows.length, positive:tally(row => row.positive), detected:tally(row => row.detected),
  casesWithFalsePositives:tally(row => row.falsePositives.length), selectionTests:tally(row => row.selectionCorrect !== undefined),
  selectionCorrect:tally(row => row.selectionCorrect), downloads:tally(row => row.download),
  downloaded:tally(row => row.download === 'verified'), firstProbeMedianMs:median(rows.map(row => row.firstProbeMs)),
  browserTaskMedianMs:median(rows.map(row => row.taskMs)), browserHeapMedianBytes:median(rows.map(row => row.heapBytes)),
  fixtureRequests:rows.reduce((sum,row) => sum + row.fixtureRequests,0),
  fixtureBytes:rows.reduce((sum,row) => sum + row.fixtureBytes,0),
  restrictedRequests:rows.reduce((sum,row) => sum + row.restrictedRequests,0),
};
const core = new Set(['mp4','webm','source-elements','extensionless-network','network-webm','network-hls',
  'network-hls-mime','network-dash','fmp4-hls','same-origin-iframe','play-event','preroll','empty','http-paywall',
  'challenge-header','only-fragments','dynamic-json','shadow-delayed','shadow-attach-late']);
const regression = rows.filter(row => core.has(row.id) && (row.detected === false || row.falsePositives.length ||
  row.diagnosticCorrect === false || ['mp4','webm'].includes(row.id) && row.download !== 'verified'));
const report = {version,browser,browserVersion,node:process.version,platform:process.platform,
  sample:live ? 'includes public media' : 'local fixtures',scenarioCount:requested.length,infrastructureError,
  actualWritePaths: actualWritePaths ? {
    sandboxEnforced: actualWritePaths.sandboxEnforced,
    noUserSettings: actualWritePaths.noUserSettings,
    writtenFileCount: actualWritePaths.writtenFileCount ?? actualWritePaths.writtenFiles?.length ?? 0,
    allWritesInsideSandbox: actualWritePaths.allWritesInsideSandbox,
  } : null,
  count,rows};
if (option('output')) await writeFile(path.resolve(option('output')),JSON.stringify(report,null,2) + '\n');
if (actualWritePaths) console.log('ACTUAL_WRITE_PATHS', JSON.stringify(actualWritePaths));
console.log(JSON.stringify({version,browser,browserVersion,infrastructureError,count,regressions:regression.map(row => row.id)}));
if (infrastructureError || rows.length !== requested.length || strict && (regression.length || count.restrictedRequests)) {
  process.exitCode = 1;
}
