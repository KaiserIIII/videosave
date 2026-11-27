import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectCdp, withChromium } from './edge-session.mjs';
import { classify, isMediaFragment, isPlaylist, mediaResponseSize, pageStreams, scanDocument, sourceTitle } from '../extension/media.mjs';
import { assessCandidates, detectionDiagnostic, documentBlockers } from '../extension/detection.mjs';
import { publicMediaSources } from '../extension/media-adapters.mjs';
import { manifestEvidence } from '../extension/manifest-evidence.mjs';

export class ApiError extends Error {
  constructor(code, message, status = 400, detail) {
    super(message);
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
}

export function mediaUrl(value) {
  if (typeof value === 'string' && value.length <= 8192) {
    const url = URL.parse(value);
    if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      url.hash = '';
      return url;
    }
  }
  throw new ApiError('INVALID_URL', '需要一个不含登录信息的 HTTP(S) 链接');
}

export function parseCookies(header = '') {
  if (typeof header !== 'string' || header.length > 16384 || /[^\x20-\x7e]/.test(header)) {
    throw new ApiError('INVALID_COOKIE', 'Cookie 必须是有效的单行请求头');
  }
  return header.split(';').map(pair => pair.trim()).filter(Boolean).map(pair => {
    const match = /^([!#$%&'*+.\x60^_|~\w-]+)=(.*)$/.exec(pair);
    if (!match) throw new ApiError('INVALID_COOKIE', 'Cookie 格式应为 name=value');
    return { name: match[1], value: match[2] };
  });
}

export const allowedMediaHeaders = ['Referer','Origin','User-Agent'];

export function parseMediaHeaders(value) {
  if (value === undefined) return {};
  const invalid = () => new ApiError('INVALID_HEADERS','仅支持有效的 Referer、Origin 和 User-Agent 请求头');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const parsed = {};
  for (const [name, header] of Object.entries(value)) {
    const canonical = allowedMediaHeaders.find(allowed => allowed.toLowerCase() === name.toLowerCase());
    if (!canonical || Object.hasOwn(parsed,canonical) || typeof header !== 'string' ||
        !header.trim() || header.length > 2048 || /[^\x20-\x7e]/.test(header)) throw invalid();
    const text = header.trim();
    if (canonical !== 'User-Agent') {
      const url = URL.parse(text);
      if (!url || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash ||
          canonical === 'Origin' && text !== url.origin) throw invalid();
    }
    parsed[canonical] = text;
  }
  return Object.fromEntries(allowedMediaHeaders.filter(name => Object.hasOwn(parsed,name)).map(name => [name,parsed[name]]));
}

export function streamExpiry(url) {
  const values = [...url.searchParams].filter(([key]) => key.toLowerCase() === 'expires');
  if (values.length !== 1 || !/^\d{10}$/.test(values[0][1])) return undefined;
  return new Date(Number(values[0][1]) * 1000).toISOString();
}

function observedHeaders(rawHeaders, frameUrl) {
  const origin = URL.parse(frameUrl)?.origin;
  if (!origin) return {};
  const headers = {};
  for (const [name,text] of Object.entries(rawHeaders ?? {})) {
    if (!allowedMediaHeaders.some(allowed => allowed.toLowerCase() === name.toLowerCase())) continue;
    if (name.toLowerCase() === 'referer') {
      const referer = URL.parse(text);
      if (referer?.origin !== origin || referer.search) continue;
    } else if (name.toLowerCase() === 'origin' && text !== origin) continue;
    try { Object.assign(headers, parseMediaHeaders({[name]:text})); }
    catch {}
  }
  return headers;
}

function visiblePageBlocker() {
  const visible = selector => [...document.querySelectorAll(selector)].some(element => {
    const rect = element.getBoundingClientRect();
    return getComputedStyle(element).visibility === 'visible' && rect.width > 0 && rect.height > 0;
  });
  if (visible('#challenge-form, #cf-challenge-running, #cf-challenge-stage')) return 'cloudflare-challenge';
  if (visible('iframe[src*="challenges.cloudflare.com"], .cf-turnstile') &&
      !document.querySelector('video[src], video source[src]')) return 'cf-turnstile';
  if (visible('#captcha-form, form[action*="captcha"]')) return 'captcha';
  return null;
}

function startVisiblePlayback() {
  const visible = element => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.visibility === 'visible' && style.display !== 'none';
  };
  const videos = [...document.querySelectorAll('video')].filter(visible);
  if (videos.length !== 1) return false;
  const [video] = videos;
  if (video.mediaKeys || !video.paused) return false;
  const player = video.closest('.video-js, .jwplayer, [data-player]') ?? video.parentElement;
  const selector = 'button.vjs-big-play-button, .jw-icon-display, button[aria-label="Play" i], button[aria-label="Play Video" i]';
  const button = [...(player?.querySelectorAll(selector) ?? [])].filter(element =>
    visible(element) && !element.matches(':disabled') &&
    !element.closest('[role="dialog"], dialog, [class*="consent" i], [class*="verify" i]'));
  if (button.length === 1) { button[0].click(); return true; }
  if (video.getAttribute('src') || video.querySelector('source[src]') || video.srcObject) {
    video.muted = true;
    void video.play().catch(() => {});
    return true;
  }
  video.click();
  return true;
}

function jsonPlaybackSources(value, base) {
  const keys = new Set();
  const pending = [value];
  let visited = 0;
  while (pending.length && visited++ < 400) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (!Array.isArray(current)) for (const key of Object.keys(current).slice(0,40)) {
      if (keys.size < 32 && /^[a-z][\w.-]{0,63}$/i.test(key)) keys.add(key);
    }
    pending.push(...Object.values(current).filter(child => child && typeof child === 'object').slice(0,40));
  }
  const media = publicMediaSources(value,base,{strategy:'xhr-json',sameOrigin:true})
    .filter(row => classify(row.url,row.mime));
  return {media,keys:[...keys].sort()};
}

async function inspectChildFrames(page, embedded, expression, blockedFrames, signal) {
  const children = new Map();
  function collect(target, tree, includeRoot) {
    if (!tree || children.size >= 24) return;
    if (includeRoot) children.set(tree.frame.id,{frame:tree.frame,target});
    for (const child of tree.childFrames ?? []) collect(target,child,true);
  }
  const trees = await Promise.all([page,...embedded.values()].map(async target => {
    const result = await target.send('Page.getFrameTree').catch(() => null);
    return [target,result?.frameTree];
  }));
  signal.throwIfAborted();
  for (const [target,tree] of trees) collect(target,tree,target !== page);
  const urls = new Map();
  let skippedFrames = 0;
  let inaccessibleFrames = 0;
  const frames = await Promise.all([...children.values()].map(async ({frame,target}) => {
    const frameId = frame.id;
    const url = URL.parse(frame.url);
    const inline = frame.url === 'about:blank' || frame.url === 'about:srcdoc';
    const web = ['http:','https:'].includes(url?.protocol) && !url.username && !url.password;
    if ((!web && !inline) || blockedFrames.has(frameId)) {
      skippedFrames++;
      return;
    }
    if (web) urls.set(frameId,url.href);
    try {
      const {executionContextId} = await target.send('Page.createIsolatedWorld',{frameId,worldName:'VideoSave'});
      const result = await target.evaluate(expression,executionContextId);
      if (result?.encrypted || result?.blocker) {
        urls.delete(frameId);
        skippedFrames++;
        return {frameId,result};
      }
      if (result && (web || result.playerCount)) {
        if (inline) urls.set(frameId,frame.url);
        return {frameId,result,target,executionContextId};
      }
    } catch {
      signal.throwIfAborted();
      if (web) inaccessibleFrames++;
    }
    if (inline) skippedFrames++;
  }));
  return {urls,frames:frames.filter(Boolean),skippedFrames,inaccessibleFrames};
}

async function observeEmbedded(page, target, embedded, observe, networkOptions) {
  target.on('Target.attachedToTarget', ({sessionId,targetInfo}) => {
    const child = page.session(sessionId);
    const resume = () => child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    if (targetInfo.type !== 'iframe' || embedded.size >= 24) {
      void resume();
      return;
    }
    embedded.set(sessionId,child);
    observe(child);
    void Promise.all([child.send('Network.enable',networkOptions),observeEmbedded(page,child,embedded,observe,networkOptions)])
      .catch(() => {}).finally(resume);
  });
  target.on('Target.detachedFromTarget', ({sessionId}) => embedded.delete(sessionId));
  await target.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
}

export async function discover(url, cookies, signal, {
  waitMs = 20_000, includeText = false, clickPlay = false, captureXhrBody = false, includeFrames = false, mode = 'headless',
  onMediaHeaders,
} = {}) {
  return withChromium(['--autoplay-policy=no-user-gesture-required'], async ({ list }) => {
    const target = (await list()).find(t => t.type === 'page' && t.url === 'about:blank');
    if (!target) throw new ApiError('PAGE_FAILED', '隔离浏览器未创建页面', 502);
    const page = await connectCdp(target.webSocketDebuggerUrl, signal);
    try {
      const responses = new Map();
      const fragmentFrames = new Set();
      const blockedFrames = new Set();
      const frameBlockers = new Map();
      const frameUrls = new Map();
      const embedded = new Map();
      const jsonLimit = 512 * 1024;
      const jsonSources = new Map();
      const jsonSummaries = [];
      const pendingBodies = new Set();
      let captured = 0;
      let manifests = 0;
      const networkOptions = captureXhrBody ? {maxResourceBufferSize:jsonLimit,maxTotalBufferSize:50*jsonLimit} : {};
      function observe(target) {
        const jsonRequests = new Map();
        const requests = new Map();
        const manifestRequests = new Map();
        target.on('Network.requestWillBeSent', ({requestId,request,documentURL,type}) => {
          if (!['Media','XHR','Fetch','Other'].includes(type) && !classify(request.url)) return;
          const headers = observedHeaders(request.headers,documentURL);
          if (Object.keys(headers).length) {
            if (requests.size >= 120) requests.delete(requests.keys().next().value);
            requests.set(requestId,{url:request.url,headers});
          }
        });
        target.on('Network.responseReceived', ({ requestId, response, frameId, type }) => {
          const sent = requests.get(requestId);
          requests.delete(requestId);
          if (type === 'Document') {
            frameUrls.set(frameId,response.url);
            blockedFrames.delete(frameId);
            frameBlockers.delete(frameId);
            const challenged = Object.entries(response.headers).some(([name,value]) =>
              name.toLowerCase() === 'cf-mitigated' && value === 'challenge');
            const [blocker] = documentBlockers(response.status,challenged);
            if (blocker) {
              frameBlockers.set(frameId,blocker);
              blockedFrames.add(frameId);
            }
          }
          if (captureXhrBody && captured < 50 && ['XHR','Fetch'].includes(type) && response.status === 200 &&
              /^application\/(?:json|[\w.+-]+\+json)$/i.test(response.mimeType)) {
            const endpoint = URL.parse(response.url);
            if (endpoint?.origin === URL.parse(frameUrls.get(frameId) ?? url.href)?.origin) {
              captured++;
              jsonRequests.set(requestId,{endpoint,frameId});
            }
          }
          const kind = classify(response.url, response.mimeType);
          if (!kind && response.status >= 200 && response.status < 300 && fragmentFrames.size < 24 &&
              isMediaFragment(URL.parse(response.url)?.pathname.toLowerCase() ?? '',response.mimeType.toLowerCase())) {
            fragmentFrames.add(frameId);
          }
          if (response.status < 200 || response.status >= 300 || (!kind && !classify(response.url))) return;
          const key = frameId + ' ' + response.url;
          if (responses.size < 120 || responses.has(key)) {
            const headers = new Map(Object.entries(response.headers).map(([name,value]) => [name.toLowerCase(),String(value)]));
            const size = mediaResponseSize(kind, response.status, name => headers.get(name)) ?? responses.get(key)?.size;
            const playbackHeaders = sent?.url === response.url ? sent.headers : null;
            const entry = {url:response.url, mime:response.mimeType, size, frameId, type:type?.toLowerCase(),playbackHeaders};
            responses.set(key, entry);
            if (isPlaylist(kind) && manifests < 16) {
              manifests++;
              manifestRequests.set(requestId,{key,kind,entry});
            }
          }
        });
        target.on('Network.loadingFailed', ({requestId}) => {
          manifestRequests.delete(requestId);
          jsonRequests.delete(requestId);
        });
        target.on('Network.loadingFinished', ({requestId,encodedDataLength}) => {
          const manifest = manifestRequests.get(requestId);
          manifestRequests.delete(requestId);
          if (!manifest || encodedDataLength > 128 * 1024 || blockedFrames.has(manifest.entry.frameId)) return;
          const pending = target.send('Network.getResponseBody',{requestId}).then(({body,base64Encoded}) => {
            const max = 128 * 1024;
            if (base64Encoded) {
              if (body.length > Math.ceil(max / 3) * 4) return;
              body = Buffer.from(body,'base64').toString('utf8');
            }
            if (Buffer.byteLength(body) > max) return;
            const evidence = manifestEvidence(body,manifest.entry.url,manifest.kind);
            if (evidence) Object.assign(responses.get(manifest.key) ?? {},evidence);
          }).catch(() => {}).finally(() => pendingBodies.delete(pending));
          pendingBodies.add(pending);
        });
        if (captureXhrBody) {
          target.on('Network.loadingFinished', ({requestId,encodedDataLength}) => {
            const request = jsonRequests.get(requestId);
            jsonRequests.delete(requestId);
            if (!request || encodedDataLength > jsonLimit || blockedFrames.has(request.frameId)) return;
            const pending = target.send('Network.getResponseBody',{requestId}).then(({body,base64Encoded}) => {
              if (base64Encoded) {
                if (body.length > Math.ceil(jsonLimit / 3) * 4) return;
                body = Buffer.from(body,'base64');
              }
              if (Buffer.byteLength(body) > jsonLimit) return;
              const {media,keys} = jsonPlaybackSources(JSON.parse(body),request.endpoint);
              jsonSummaries.push({frameId:request.frameId,keys,found:media.length});
              for (const source of media) {
                if (jsonSources.size >= 24) break;
                jsonSources.set(request.frameId + ' ' + source.url,{...source,frameId:request.frameId,xhrJson:true});
              }
            }).catch(() => {}).finally(() => pendingBodies.delete(pending));
            pendingBodies.add(pending);
          });
        }
      }
      observe(page);
      await page.send('Network.enable',networkOptions);
      if (includeFrames) await observeEmbedded(page,page,embedded,observe,networkOptions);
      if (cookies.length) {
        await page.send('Network.setCookies', { cookies: cookies.map(cookie => ({ ...cookie, url: url.origin, path: '/', secure: url.protocol === 'https:' })) });
      }
      const nav = await page.send('Page.navigate', { url: url.href });
      if (nav.errorText) {
        const reason = /BLOCKED|CERT_/i.test(nav.errorText) ? 'blocked' : 'timeout';
        return {pageTitle:null,pageContext:null,streams:[],pages:[],candidates:[],reason};
      }
      const deadline = Date.now() + waitMs;
      let collectUntil = deadline;
      let lastSignal;
      let stableSince = 0;
      let found;
      let clicked = false;
      const expression = `({...(${scanDocument})(true, ${includeText}), blocker: (${visiblePageBlocker})()})`;
      do {
        await sleep(300, undefined, { signal });
        found = await page.evaluate(expression).catch(error => {
          if (signal.aborted || !/context.*(destroyed|find)/i.test(error.message) &&
              !/Cannot find context/i.test(error.message)) throw error;
        });
        if (blockedFrames.has(nav.frameId) || found?.encrypted || found?.blocker) break;
        if (clickPlay && !clicked && found?.ready) {
          const children = includeFrames ? (await inspectChildFrames(page,embedded,expression,blockedFrames,signal)).frames
            .filter(frame => frame.target) : [];
          const playerCount = (found.playerCount ?? 0) + children.reduce((total,frame) => total + frame.result.playerCount,0);
          if (playerCount === 1) {
            const frame = children.find(frame => frame.result.playerCount === 1);
            clicked = await (frame?.target ?? page).evaluate(`(${startVisiblePlayback})()`,frame?.executionContextId);
          }
        }
        const credible = found?.candidates.some(candidate => candidate.mediaElement &&
          /^(?:https?):/.test(candidate.url) && classify(candidate.url, candidate.mime, true) &&
          !assessCandidates([candidate])[0].evidence.includes('preview-label'));
        const adaptive = [...responses.values()].some(row => isPlaylist(classify(row.url,row.mime)) && !row.drm && row.frameId === nav.frameId) ||
          found?.opaqueCount === 1 && [...responses.values()].some(row =>
            isPlaylist(classify(row.url,row.mime)) && !/\/(?:ads?|preroll|midroll)\//i.test(new URL(row.url).pathname));
        const signature = JSON.stringify([found?.documentUrl,found?.candidates
          .filter(row => row.mediaElement && !assessCandidates([row])[0].evidence.includes('preview-label'))
          .map(row => row.url), [...responses.values()].filter(row => row.manifestRole === 'master').map(row => row.url),
          [...jsonSources.keys()]]);
        const now = Date.now();
        if (signature !== lastSignal) {
          lastSignal = signature;
          stableSince = now;
        }
        if (credible || adaptive && found?.opaqueCount === 1 || jsonSources.size && found?.playerCount) {
          collectUntil = Math.min(deadline,stableSince + 1800);
        } else {
          collectUntil = found?.ready && !found.playerCount && found.detailPages.length && !found.iframeCount
            ? Math.min(deadline,stableSince + 3000) : deadline;
        }
      } while (Date.now() < collectUntil);
      const blocker = frameBlockers.get(nav.frameId) || (found?.encrypted ? 'drm' : found?.blocker);
      const blocked = blockedFrames.has(nav.frameId) || Boolean(blocker);
      const childFrames = includeFrames && !blocked ? await inspectChildFrames(page,embedded,expression,blockedFrames,signal) : null;
      if (pendingBodies.size) await Promise.race([Promise.allSettled(pendingBodies),sleep(300,undefined,{signal})]);
      const allowedFrame = frameId => frameId === nav.frameId || childFrames?.urls.has(frameId);
      const observed = [...jsonSources.values(),...responses.values()]
        .filter(row => allowedFrame(row.frameId))
        .map(row => ({...row, frameId:row.frameId === nav.frameId ? 0 : row.frameId}));
      const frames = found ? [{frameId:0,result:found}] : [];
      if (childFrames) frames.push(...childFrames.frames.filter(frame => frame.target));
      const streams = blocked ? [] : pageStreams(frames, observed);
      const blockers = new Set(blocker ? [blocker] : []);
      if (!streams.length && includeFrames) {
        for (const value of frameBlockers.values()) blockers.add(value);
        for (const {result} of childFrames?.frames ?? []) {
          if (result.encrypted) blockers.add('drm');
          else if (result.blocker) blockers.add(result.blocker);
        }
      }
      if (!streams.length && observed.some(row => row.drm)) blockers.add('drm');
      const results = frames.map(frame => frame.result);
      const diagnostic = detectionDiagnostic({streams,blockers:[...blockers],players:results.reduce((n,row) => n + row.playerCount,0),
        unloaded:results.reduce((n,row) => n + row.unloaded,0),opaque:results.reduce((n,row) => n + row.opaqueCount,0),
        unsupported:results.reduce((n,row) => n + row.unsupported,0) + [...fragmentFrames].filter(allowedFrame).length,
        excluded:results.reduce((n,row) => n + row.excludedMedia.length,0),
        blockedFrames:childFrames?.inaccessibleFrames ?? 0,
        reason:blocked ? 'blocked' : !found?.ready ? 'timeout' : undefined});
      return {
        pageTitle: found?.pageMetadata?.title || found?.pageTitle || null,
        pageContext: found?.pageContext ?? null,
        streams: [...streams, ...streams.flatMap(stream => stream.alternates ?? [])].slice(0, 24).map(stream => {
          const {url,kind,duration,width,height,size,recommended,currentSource,playerContext} = stream;
          const title = stream.title || sourceTitle(stream) || undefined;
          const frame = frames.find(frame => frame.frameId === stream.frameId)?.result;
          const playerId = playerContext ? stream.frameId + ':' + stream.playerIndex
            : stream.xhrJson && frame?.playerCount === 1 ? stream.frameId + ':0' : null;
          const frameId = stream.frameId === 0 ? nav.frameId : stream.frameId;
          const headers = responses.get(frameId + ' ' + url)?.playbackHeaders;
          if (headers) onMediaHeaders?.(url,headers);
          const expiresAt = streamExpiry(new URL(url));
          return {url, kind, title, titleSource:stream.titleSource ?? (title ? 'media-url' : null),
            ...assessCandidates([stream])[0],
            ...(stream.observed && {observed:true}), ...(stream.role && {role:stream.role}),
            ...(stream.adapter && {adapter:stream.adapter}), ...(stream.manifestRole && {manifestRole:stream.manifestRole}),
            ...(stream.quality?.length && {quality:stream.quality}), ...(stream.bitrate && {bitrate:stream.bitrate}),
            duration:currentSource === false ? null : duration ?? null,
            width:currentSource === false ? null : width ?? null,
            height:currentSource === false ? null : height ?? null, size:size ?? null,
            discoveredBy:stream.mediaElement ? 'player' : stream.xhrJson ? 'xhr-json' : stream.fromPlayer ? 'player-playlist' : stream.observed ? 'network' : stream.strategy || 'network',
            currentSource:currentSource ?? null,
            ...(expiresAt && {expiresAt}),
            ...(childFrames?.urls.has(stream.frameId) && {frameUrl:childFrames.urls.get(stream.frameId)}),
            ...(stream.xhrJson && playerId && {playerId}),
            player:playerContext ? {id:playerId, ...playerContext, type:stream.playerType || 'html5', playing:stream.playing} : null,
            ...(recommended && {recommended:true})};
        }),
        pages: found?.pages || [],
        candidates: found?.detailPages || [],
        diagnostic,
        ...(includeFrames && {skippedFrames:childFrames?.skippedFrames ?? 0}),
        ...(captureXhrBody && !blocked && !streams.some(stream => stream.xhrJson) && {
          xhrJson:jsonSummaries.filter(summary => allowedFrame(summary.frameId)).map(({keys,found}) => ({keys,found})),
        }),
        ...(blockers.size && {blockers:[...blockers]}),
        reason: blocked || blockers.size ? 'blocked' : !found?.ready ? 'timeout' : found.playerCount ? 'no-playlist-request' : 'no-player',
      };
    } finally { page.close(); }
  }, signal, {headed:mode === 'headed'});
}

function inputArgs(url, cookies = [], headers = {}) {
  const fields = Object.entries(headers).map(([name,value]) => name + ': ' + value + '\r\n').join('');
  return [
    '-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-rw_timeout', '15000000',
    ...(fields ? ['-headers',fields] : []),
    ...(cookies.length ? ['-cookies', cookies.map(({ name, value }) =>
      `${name}=${value}; path=/; domain=${url.hostname};`).join('\n')] : []),
  ];
}

function safeDiagnosticUrl(value) {
  const url = URL.parse(value);
  return /^https?:$/.test(url?.protocol) ? url.origin + url.pathname : undefined;
}

export function classifyMediaError(stderr, source) {
  const lines = stderr.split(/\r?\n/);
  const httpLine = lines.findLast(line => /(?:HTTP (?:error )?|Server returned )([45]\d\d)\b/i.test(line));
  const status = Number(/(?:HTTP (?:error )?|Server returned )([45]\d\d)\b/i.exec(httpLine ?? '')?.[1]);
  const reportedUrl = httpLine?.match(/https?:\/\/[^\s'"<>]+/)?.[0] ||
    lines.findLast(line => /(?:Error (?:opening|when loading)|failed to open).*https?:\/\//i.test(line))
      ?.match(/https?:\/\/[^\s'"<>]+/)?.[0];
  const tail = stderr.replace(/https?:\/\/[^\s'"<>]+/gi, value => safeDiagnosticUrl(value) || '[url]')
    .replace(/file:[^\s'"<>]+|[a-z]:[\\/][^\r\n'"\]]+|\\\\[^\\\s]+\\[^\r\n'"\]]+|(?<![\w:/])\/(?!\/)[^\r\n'"\]]+/gi, '[path]')
    .replace(/(?:cookie|authorization|set-cookie)\s*:[^\r\n]*/gi, '[header]')
    .trim().slice(-200);
  const detail = {stderr:tail, ...(status && {status, url:safeDiagnosticUrl(reportedUrl || source) ?? null})};
  if (/not on whitelist/i.test(stderr)) return new ApiError('PROTOCOL_NOT_ALLOWED', '媒体引用了不允许的协议', 502, detail);
  if (status) return new ApiError('HTTP_STATUS', '媒体服务器返回 HTTP ' + status, 502, detail);
  if (/timed out|rw_timeout|timeout (?:occurred|expired)/i.test(stderr)) return new ApiError('TIMEOUT', '媒体读取超时', 504, detail);
  if (/matches no streams|does not contain any stream|cannot find a matching stream|invalid stream specifier/i.test(stderr)) {
    return new ApiError('NO_VIDEO_TRACK', '无法映射所需媒体轨道', 422, detail);
  }
  if (/\bcrypto\b|decrypt|invalid data found|padding/i.test(stderr)) return new ApiError('DECRYPT_FAILED', '媒体解密或输入格式校验失败', 502, detail);
  if (/failed to open segment|error when loading first fragment|segment.*(?:failed|unavailable)/i.test(stderr)) {
    return new ApiError('SEGMENT_FAILED', '媒体分片读取失败', 502, detail);
  }
  return new ApiError('MEDIA_FAILED', '媒体读取或封装失败', 502, detail);
}

// ffmpeg 在切片/续播源上会打这些无害告警（不代表失败），严格模式要忽略
const BENIGN_STDERR = [
  /non-existing (?:SPS|PPS|parameter set)/i,
  /Last message repeated \d+ times/i,
];
function hasFatalStderr(stderr) {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .filter(line => !BENIGN_STDERR.some(pattern => pattern.test(line)));
  return lines.length > 0;
}

export async function runMedia(bin, args, signal, onLine, {onFailure, strict = false} = {}) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached:grouped });
    let stopping;
    const stop = () => {
      if (!proc.pid || stopping) return;
      if (grouped) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      } else {
        const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
        stopping = new Promise(resolve => {
          killer.once('error', () => proc.kill());
          killer.once('close', code => {
            if (code !== 0 && proc.exitCode === null) proc.kill();
            resolve();
          });
        });
      }
    };
    signal.addEventListener('abort', stop, {once:true});
    if (signal.aborted) stop();
    let stdout = '', stderr = '', pending = '', failure;
    proc.stdout.setEncoding('utf8').on('data', chunk => {
      if (!onLine) { stdout = (stdout + chunk).slice(-65536); return; }
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) onLine(line.trim());
    });
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    proc.on('error', error => { failure = error; });
    proc.on('close', async code => {
      signal.removeEventListener('abort', stop);
      await stopping;
      if (signal.aborted) return reject(signal.reason);
      if ((failure || code !== 0) && onFailure) return reject(onFailure({failure,stderr}));
      if (onLine && pending.trim()) onLine(pending.trim());
      if (failure) return reject(new ApiError('TOOL_UNAVAILABLE', '无法启动本机媒体工具', 503));
      if (code !== 0 || (strict && hasFatalStderr(stderr))) {
        const inputIndex = args.indexOf('-i');
        const error = classifyMediaError(stderr, args[inputIndex < 0 ? args.length - 1 : inputIndex + 1]);
        error.transientFirstFragment = /Error when loading first fragment of playlist/i.test(stderr) &&
          /(?:HTTP error|Server returned) (?:408|429|500|502|503|504|5XX)\b|(?:\[(?:tls|tcp) @ [^\]]+\].*(?:Error|timed out)|Connection reset by peer)/i.test(stderr);
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

function mediaTool(name, override) {
  if (override) return override;
  if (process.platform === 'win32') {
    const portable = new URL('../.local-tools/ffmpeg-8.1.2-essentials_build/bin/' + name + '.exe', import.meta.url);
    if (existsSync(portable)) return fileURLToPath(portable);
  }
  return name;
}

const FFPROBE = mediaTool('ffprobe', process.env.FFPROBE_BIN);
export const FFMPEG = mediaTool('ffmpeg', process.env.FFMPEG_BIN);

export async function probeStream(url, cookies, signal, tracks = false, kind, headers) {
  try {
    const entries = tracks
      ? 'format=duration:format_tags=title:stream=index,codec_type,codec_name,width,height,bit_rate:stream_disposition=attached_pic,default'
      : 'format=duration,size,format_name:format_tags=title:stream=codec_type,width,height,bit_rate:stream_tags=variant_bitrate';
    const raw = await runMedia(FFPROBE, ['-v', 'error', '-show_entries', entries,
      '-of', 'json', ...mediaInput(url, cookies, headers)], AbortSignal.any([signal, AbortSignal.timeout(25000)]));
    const parsed = JSON.parse(raw);
    const video = parsed.streams?.find(s => s.width);
    const duration = Number(parsed.format?.duration) || null;
    const adaptive = isPlaylist(kind) || /^(?:hls|dash)(?:,|$)/.test(parsed.format?.format_name ?? '');
    const bytes = Number(parsed.format?.size);
    const bitRate = Number(video?.tags?.variant_bitrate || video?.bit_rate);
    const estimate = adaptive && duration > 0 && bitRate > 0 ? Math.round(duration * bitRate / 8) : null;
    const size = !adaptive && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
    const mediaTitle = parsed.format?.tags?.title?.replace(/[\s\x00-\x1f]+/g,' ').trim().slice(0,300);
    return { duration, width: video?.width ?? null, height: video?.height ?? null,
      ...(mediaTitle && {mediaTitle}),
      ...(!tracks && {size, trackSummary:{video:parsed.streams?.some(row => row.codec_type === 'video') ?? false,
        audio:parsed.streams?.some(row => row.codec_type === 'audio') ?? false}, ...(bitRate > 0 && {bitrate:bitRate}),
        ...(estimate > 0 && Number.isSafeInteger(estimate) && {size:estimate, sizeEstimated:true})}),
      ...(tracks && {tracks:parsed.streams ?? []}) };
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'TOOL_UNAVAILABLE') throw error;
    return { duration: null, width: null, height: null };
  }
}

export async function inspectOutput(file, signal, expectedTrack, expectedDuration) {
  const extension = file.split('.').at(-1).toLowerCase();
  const container = {mp4:'mov',m4a:'mov',mkv:'matroska',mp3:'mp3'}[extension];
  const raw = await runMedia(FFPROBE, ['-v','error','-count_packets','-show_entries',
    'format=duration,size,format_name:stream=codec_type,codec_name,width,height,nb_read_packets',
    '-of','json',...(container ? ['-f',container] : []),...mediaInput(file, [])], signal, undefined, {strict:true});
  const {format,streams = []} = JSON.parse(raw);
  const video = streams.find(track => track.codec_type === 'video');
  const audio = streams.find(track => track.codec_type === 'audio');
  const duration = Number(format?.duration);
  const size = Number(format?.size);
  const formats = (format?.format_name ?? '').split(',');
  if (!streams.some(track => track.codec_type === expectedTrack && Number(track.nb_read_packets) > 0) ||
      !(duration > 0 && Number.isSafeInteger(size) && size > 0) ||
      expectedDuration > 0 && duration + Math.max(1, expectedDuration * 0.02) < expectedDuration) {
    throw new ApiError('INCOMPLETE_OUTPUT', '落盘文件缺少所需轨道、数据或时长不足', 502);
  }
  return {duration,size,width:video?.width ?? null,height:video?.height ?? null,codec:video?.codec_name ?? audio?.codec_name ?? null,
    audioCodec:audio?.codec_name ?? null,container:formats.includes(extension) ? extension : formats[0] || null,
    subtitleTracks:streams.filter(track => track.codec_type === 'subtitle').length};
}

export function mediaInput(source, cookies, headers, ...beforeSource) {
  // Only the locally generated HLS playlist can reference other files.
  if (typeof source === 'string') {
    const localHls = source.endsWith('.m3u8');
    return ['-protocol_whitelist', localHls ? 'file,crypto' : 'file',
      ...(localHls ? ['-allowed_extensions', 'm3u8,mp4,m4s,ts,key'] : []),
      ...(source.endsWith('.bin') ? ['-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,avi,mpegts,mpeg'] : []),
      ...beforeSource, source];
  }
  return [...inputArgs(source, cookies, headers), ...beforeSource, source.href];
}
