
import { assessCandidates } from './detection.mjs';
import { declaredMediaSources } from './media-adapters.mjs';

const adaptive = new Set(['m3u8', 'mpd']);
const formats = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv', 'avi', 'm3u8', 'mpd']);
export const audioFormats = new Set(['mp3','m4a','ogg','wav','flac']);
const mediaMimes = {
  'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov', 'video/x-matroska':'mkv', 'video/ogg':'ogv',
  'video/x-msvideo':'avi', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/ogg':'ogg', 'audio/wav':'wav',
  'audio/x-wav':'wav', 'audio/flac':'flac',
};

export function platformVideo(value) {
  const url = URL.parse(value);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)) {
    const match = /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;
    const part = url.searchParams.get('p');
    return {platform:'bilibili', url:'https://www.bilibili.com/video/' + match[1] + '/' +
      (/^[1-9]\d{0,5}$/.test(part) ? '?p=' + part : '')};
  }
  const youtube = ['www.youtube.com', 'm.youtube.com', 'youtube.com'].includes(url.hostname);
  const id = youtube && url.pathname === '/watch' ? url.searchParams.get('v')
    : youtube ? /^\/(?:shorts|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
    : url.hostname === 'youtu.be' ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] : undefined;
  return /^[\w-]{11}$/.test(id) ? {platform:'youtube',url:'https://www.youtube.com/watch?v=' + id} : null;
}

export function mediaResponseSize(kind, status, header) {
  if (!kind || adaptive.has(kind)) return undefined;
  const encoding = header('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return undefined;
  const length = status === 206
    ? /^bytes \d+-\d+\/(\d+)$/i.exec(header('content-range')?.trim())?.[1]
    : status === 200 ? /^\d+$/.exec(header('content-length')?.trim())?.[0] : undefined;
  const size = Number(length);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

export function isPlaylist(kind) {
  return adaptive.has(kind);
}

export function isMediaFragment(pathname, mime) {
  return /^(?:video|audio)\/iso\.segment$/.test(mime) ||
    /\.(?:m4s|cmfv|cmfa)$/.test(pathname) ||
    /\/(?:init|seg(?:ment)?|chunk|fragment)(?:[-_\d][^/]*)?\.(?:mp4|m4v|mov|webm|m4a|ts)$/.test(pathname);
}

export function classify(value, contentType = '', mediaElement = false) {
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const pathname = url.pathname.toLowerCase();
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (/^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/.test(mime)) return 'm3u8';
  if (mime === 'application/dash+xml') return 'mpd';
  if (/^(?:text\/|image\/|font\/)|(?:json|xml|javascript|iso\.segment)$/.test(mime) ||
      /\.(?:aac|vtt)$/.test(pathname) || isMediaFragment(pathname,mime)) return null;
  const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === 'ts' || mime === 'video/mp2t') return mediaElement ? 'ts' : null;
  if (mime.startsWith('audio/') || audioFormats.has(extension)) {
    return mediaElement ? mediaMimes[mime] || (audioFormats.has(extension) ? extension : null) : null;
  }
  if (Object.hasOwn(mediaMimes,mime)) return mediaMimes[mime];
  if (formats.has(extension)) return extension;
  if (mime.startsWith('video/') || (mediaElement && !mime)) return 'mp4';
  return null;
}

export function pickStreams(candidates) {
  const streams = new Map();
  for (const candidate of candidates) {
    const kind = classify(candidate.url, candidate.mime, candidate.mediaElement);
    if (!kind || candidate.encrypted) continue;
    const url = new URL(candidate.url);
    url.hash = '';
    const previous = streams.get(url.href);
    const fields = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value != null && value !== ''));
    const strategies = [...new Set([...(previous?.strategies ?? []),
      candidate.strategy || (candidate.mediaElement ? 'player' : candidate.xhrJson ? 'xhr-json' : 'network')])];
    streams.set(url.href, { ...previous, ...fields, url: url.href, strategies,
      kind: previous && adaptive.has(previous.kind) ? previous.kind : kind });
  }
  return [...streams.values()].sort((a, b) => Number(adaptive.has(b.kind)) - Number(adaptive.has(a.kind)));
}

function usableDuration(stream) {
  return Number.isFinite(stream.duration) && stream.duration > 0 ? stream.duration : 0;
}

export function longestFirst(first, second) {
  return usableDuration(second) - usableDuration(first);
}

export function primaryCandidates(streams) {
  const sources = streams.filter(stream => stream.currentSource !== false);
  const players = sources.filter(stream => !['network','xhr-json'].includes(stream.discoveredBy));
  const visible = players.filter(stream => stream.player?.visible !== false);
  return visible.length ? visible : players.length ? players : sources;
}

export function selectPageStream(streams) {
  const scored = assessCandidates(streams);
  const safe = streams.filter((_, index) => !scored[index].evidence.includes('preview-label'));
  if (!safe.length) return {status:streams.length ? 'ambiguous' : 'unavailable'};
  const video = safe.filter(stream => stream.role !== 'audio' && !audioFormats.has(stream.kind));
  const candidates = primaryCandidates(video.length ? video : safe).sort(longestFirst);
  const [longest, next] = candidates;
  if (!longest) return {status:'unavailable'};
  if (!next) {
    const previous = primaryCandidates(streams).sort(longestFirst);
    const [first,second] = previous;
    const legacyLead = first === longest && second && previous.every(usableDuration) &&
      first.duration - second.duration >= Math.max(1,first.duration * 0.1);
    return {status:'selected', url:longest.url, reason:legacyLead ? 'longest-player' : 'only-candidate'};
  }
  const ranked = candidates.map(stream => ({stream, evidence:scored[streams.indexOf(stream)]}))
    .sort((a,b) => b.evidence.score - a.evidence.score);
  const [best, runnerUp] = ranked;
  const duration = usableDuration(longest);
  const clearLead = candidates.every(usableDuration) && duration - usableDuration(next) >= Math.max(1, duration * 0.1);
  if (clearLead && best.stream === longest && !['network','xhr-json'].includes(longest.discoveredBy)) {
    return {status:'selected', url:longest.url, reason:'longest-player'};
  }
  if (best.evidence.score - runnerUp.evidence.score >= 4 && best.evidence.confidence === 'high' &&
      best.evidence.evidence.some(code => ['full-content-label','audio-video','adaptive-variants'].includes(code))) {
    return {status:'selected',url:best.stream.url,reason:'candidate-evidence'};
  }
  if (!clearLead || ['network','xhr-json'].includes(longest.discoveredBy)) return {status:'ambiguous'};
  return {status:'selected', url:longest.url, reason:'longest-player'};
}

export function pageStreams(frames, requests) {
  const noisy = /\/(?:ad[sx]?|preroll|midroll|storyboards?|thumbnails?|sprites?|tracking|beacons?)\//i;
  const declared = new Set();
  const covered = new Set();
  const inferred = [];
  const rejected = new Set(requests.filter(row => row.mime && !classify(row.url,row.mime,true)).map(row => row.url));
  const protectedUrls = new Set(requests.filter(row => row.drm).flatMap(row => [row.url,...(row.manifestChildren ?? [])]));
  const mediaParts = new Set(requests.flatMap(row => (row.manifestParts ?? []).map(url => row.frameId + ' ' + url)));
  const templatedParts = requests.filter(row => row.manifestPartPatterns?.length).map(row => ({
    frameId:row.frameId, patterns:row.manifestPartPatterns.map(pattern => new RegExp(pattern)),
  }));
  const documents = new Map(frames.map(frame => [frame.frameId,frame.result.documentUrl]));
  const encryptedFrames = new Set(frames.filter(frame => frame.result.encrypted || frame.result.blocker).map(frame => frame.frameId));
  const excluded = new Set(frames.flatMap(({result}) => result.excludedMedia ?? []));
  const metadata = frames.find(frame => frame.frameId === 0)?.result.pageMetadata;
  const playerCount = frames.reduce((count, frame) => count + (frame.result.playerCount || 0), 0);
  const observed = frames.flatMap(({ frameId, result }) => {
    if (result.encrypted || result.blocker) return [];
    const candidates = [...declaredMediaSources(result), ...result.candidates].filter(candidate => candidate.url !== result.documentUrl)
      .map(candidate => ({...candidate, frameId}));
    for (const candidate of candidates) {
      if (candidate.mediaElement && classify(candidate.url, candidate.mime, true)) declared.add(new URL(candidate.url).href);
    }
    if (!result.opaquePlayer || result.encrypted) return candidates;
    const playlists = pickStreams([...requests.filter(row => row.frameId === frameId && !row.drm), ...candidates])
      .filter(stream => adaptive.has(stream.kind) && !protectedUrls.has(stream.url) && !noisy.test(new URL(stream.url).pathname));
    const masters = playlists.filter(stream => stream.kind === 'm3u8' &&
      (stream.manifestRole === 'master' || /\/(?:master|multivariant|main)(?:[-_][\w-]+)?\.m3u8$/i.test(new URL(stream.url).pathname)));
    const master = masters.length === 1 && masters[0];
    const base = master && new URL('.', master.url).href;
    const samePlaylistFamily = base && (result.opaqueCount ?? 1) <= 1 &&
      playlists.every(stream => stream.kind === 'm3u8' && (stream.url === master.url ||
        (master.manifestChildren ? master.manifestChildren.includes(stream.url) : stream.url.startsWith(base))));
    if (samePlaylistFamily) {
      for (const stream of playlists) if (stream.url !== master.url && !stream.mediaElement) covered.add(`${frameId} ${stream.url}`);
    }
    const playlist = playlists.length === 1 ? playlists[0] : samePlaylistFamily ? master : null;
    if (playlist) inferred.push({...playlist, ...result.opaquePlayer, frameId, fromPlayer:true});
    return candidates;
  });
  for (const row of requests) {
    if (row.drm || encryptedFrames.has(row.frameId)) continue;
    for (const url of row.manifestChildren ?? []) {
      if (!declared.has(url)) covered.add(row.frameId + ' ' + url);
    }
  }
  const eligible = url => !protectedUrls.has(url.href) &&
    !rejected.has(url.href) &&
    (!excluded.has(url.href) || declared.has(url.href));
  const isPart = (url, frameId) => !declared.has(url.href) && (mediaParts.has(frameId + ' ' + url.href) ||
    templatedParts.some(row => row.frameId === frameId && row.patterns.some(pattern => pattern.test(url.href))));
  const network = requests.filter(request => {
    const url = URL.parse(request.url);
    return url && url.href !== documents.get(request.frameId) && !isPart(url,request.frameId) &&
      !encryptedFrames.has(request.frameId) && eligible(url) && !covered.has(`${request.frameId} ${url.href}`) && (declared.has(url.href) ||
      !noisy.test(url.pathname) && request.type !== 'image');
  });
  const streams = pickStreams([...network.map(request => request.xhrJson || request.manifestOnly ? request : {...request,observed:true}), ...observed.filter(candidate => {
    const url = URL.parse(candidate.url);
    return url && !isPart(url,candidate.frameId) && eligible(url) && !covered.has(`${candidate.frameId} ${url.href}`) &&
      (candidate.mediaElement || !noisy.test(url.pathname));
  }), ...inferred]);
  const players = new Map();
  const rows = [];
  for (const stream of streams) {
    const key = stream.playerIndex == null ? null : `${stream.frameId} ${stream.playerIndex}`;
    if (!key) {
      rows.push(stream);
    } else if (players.has(key)) {
      players.get(key).push(stream);
    } else {
      const group = [stream];
      players.set(key, group);
      rows.push(group);
    }
  }
  const representatives = rows.map(row => {
    if (!Array.isArray(row)) return row;
    const current = row.find(stream => stream.currentSource) || row[0];
    if (row.length > 1) current.alternates = row.filter(stream => stream !== current);
    return current;
  });
  if (representatives.length === 1 && playerCount <= 1 && metadata) {
    const [stream] = representatives;
    if (metadata.videoTitle && (!stream.title || stream.frameId !== 0 && !stream.namedByPlayer)) {
      stream.title = metadata.videoTitle;
      stream.titleSource = metadata.titleSource;
    }
    if (!stream.title) {
      const name = sourceTitle(stream);
      stream.title = name || metadata.title;
      stream.titleSource = name ? 'media-url' : metadata.titleSource;
    }
    stream.poster ||= metadata.poster;
  }
  const verified = representatives.filter(stream => stream.mediaElement || stream.fromPlayer);
  const active = verified.filter(stream => stream.playing);
  const preferred = active.length === 1 ? active[0] : verified.length === 1 ? verified[0] : null;
  if (preferred) preferred.recommended = true;
  const priority = stream => stream.recommended ? 3 : stream.playing ? 2 : stream.mediaElement || stream.fromPlayer ? 1 : 0;
  return representatives.sort((a, b) => longestFirst(a, b) || priority(b) - priority(a));
}

const genericTitleSources = new Set([null, undefined, 'document-title', 'heading', 'media-url']);

export function canUseMediaTitle(titleSource) {
  return genericTitleSources.has(titleSource);
}

export function sourceTitle(stream) {
  const url = new URL(stream.url);
  const name = stream.filename || url.searchParams.get('filename') || url.searchParams.get('fileName') ||
    url.pathname.split('/').pop() || '';
  let decoded;
  try { decoded = decodeURIComponent(name); } catch { decoded = name; }
  const title = decoded.split(/[\\/]/).pop().replace(/\.(?:mp4|mov|webm|mkv|ogv|avi|m4v|m3u8|mpd)$/i, '').trim();
  return !title || /^(?:index|master|playlist|manifest|video|media|stream|play|[a-f0-9-]{24,}|\d+)$/i.test(title)
    ? '' : title.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function scanDocument(includeContext = false, includeText = false) {
  // This function is executed inside the page with no module imports.
  const clean = (value, limit = 300) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const meta = (attribute, name, limit) => clean(document.querySelector(`meta[${attribute}="${name}"]`)?.content, limit);
  const titleFrom = values => {
    for (const [source, value] of values) {
      const title = clean(value);
      if (title) return [source, title];
    }
    return [null, ''];
  };
  const normalizeUrl = value => {
    const url = typeof value === 'string' && value.trim() && URL.parse(value, document.baseURI);
    if (!url) return '';
    url.hash = '';
    return url.href;
  };
  const seconds = value => {
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match) return null;
    const [, days = 0, hours = 0, minutes = 0, secs = 0] = match;
    const duration = days * 86400 + hours * 3600 + minutes * 60 + Number(secs);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  };
  const roots = [document];
  const mediaNodes = new Set(document.querySelectorAll('video, audio'));
  let walked = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node && walked++ < 3000 && roots.length < 32; node = walker.nextNode()) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
        for (const media of node.shadowRoot.querySelectorAll('video, audio')) mediaNodes.add(media);
      }
    }
  }
  const videos = [];
  const excludedMedia = new Set();
  const adMarker = /^(?:(?:vjs[-_])?(?:pre|mid|post)[-_]?roll(?:[-_](?:video|player|ad|container))?|(?:video[-_]ad|ad[-_]video))$/i;
  for (const video of [...mediaNodes].slice(0, 48)) {
    let element = video;
    let isAd = false;
    for (let depth = 0; element && depth < 4; depth++, element = element.parentElement ?? element.getRootNode().host) {
      if (adMarker.test(element.id) || [...element.classList].some(name => adMarker.test(name))) {
        isAd = true;
        break;
      }
    }
    if (isAd) {
      for (const address of [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(source => source.src)]) {
        const url = normalizeUrl(address);
        if (url) excludedMedia.add(url);
      }
    } else videos.push(video);
  }
  const publicConfigs = [];
  let remainingConfig = 192_000;
  for (const root of roots) {
    for (const script of root.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]')) {
      const json = script.textContent;
      if (!json || json.length > remainingConfig || json.length > 96_000 || publicConfigs.length >= 12) continue;
      publicConfigs.push({json,base:document.baseURI,
        strategy:script.type === 'application/ld+json' ? 'structured-data' : 'page-config'});
      remainingConfig -= json.length;
    }
  }
  const structured = [];
  for (const {json,strategy} of publicConfigs) {
      if (strategy !== 'structured-data') continue;
      let data;
      try { data = JSON.parse(json); } catch { continue; }
      const pending = [data];
      for (let visited = 0; pending.length && visited < 400; visited++) {
        const entry = pending.pop();
        if (!entry || typeof entry !== 'object') continue;
        if ([entry['@type']].flat().some(type => typeof type === 'string' && /(?:^|\/)VideoObject$/.test(type))) {
          structured.push(entry);
        }
        for (const value of Object.values(entry).slice(0,40)) {
          if (value && typeof value === 'object') pending.push(value);
        }
      }
  }
  const playing = videos.filter(video => !video.paused && !video.ended);
  const primary = videos.length === 1 ? videos[0] : playing.length === 1 ? playing[0] : null;
  const sessionTitle = clean(navigator.mediaSession?.metadata?.title);
  const pageVideo = structured.length === 1 ? structured[0] : null;
  const titleNode = document.querySelector('[itemtype$="/VideoObject"] [itemprop="name"], #viewvideo-title');
  const visible = node => (node.checkVisibility?.({checkOpacity:true, checkVisibilityCSS:true}) ??
    node.getClientRects().length > 0) && !node.closest('[hidden], [aria-hidden="true"]');
  const visibleText = (root, selector, limit) => {
    for (const node of root.querySelectorAll(selector)) {
      if (!visible(node) || node.closest('form, [contenteditable]')) continue;
      const text = clean(node.innerText, limit);
      if (text) return text;
    }
    return '';
  };
  const heading = includeContext ? visibleText(document, 'h1, [role="heading"][aria-level="1"]')
    : clean(document.querySelector('main h1, article h1, h1')?.textContent);
  const ogTitle = meta('property', 'og:title');
  const [videoTitleSource, videoTitle] = titleFrom([
    ['video-object', pageVideo?.name], ['video-markup', titleNode?.getAttribute('content') || titleNode?.textContent],
    ['media-session', sessionTitle], ['open-graph', /^video(?:\.|$)/.test(meta('property','og:type')) ? ogTitle : ''],
  ]);
  const [titleSource, pageTitle] = titleFrom([
    [videoTitleSource, videoTitle], ['open-graph', ogTitle], ['twitter-card', meta('name', 'twitter:title')],
    ['heading', heading], ['document-title', document.title],
  ]);
  const pageMetadata = {
    videoTitle,
    title: pageTitle,
    titleSource,
    poster: normalizeUrl([pageVideo?.thumbnailUrl].flat()[0] || meta('property', 'og:image')) || null,
  };
  const descriptionLimit = includeText ? Infinity : 300;
  const pageContext = includeContext ? {url:normalizeUrl(location.href), heading:heading || null,
    description:clean(pageVideo?.description, descriptionLimit) || meta('property', 'og:description', descriptionLimit) ||
      meta('name', 'description', descriptionLimit) ||
      visibleText(document, 'main > p, main > header p, article > header p', descriptionLimit) || null,
    titleSource, playerCount:videos.length, untrusted:true} : undefined;
  const nearbyText = video => {
    let heading = '', description = '';
    let container = video.parentElement ?? video.getRootNode().host;
    for (let depth = 0; container && depth < 4 && container !== document.body;
      depth++, container = container.parentElement ?? container.getRootNode().host) {
      if ((container.shadowRoot ?? container).querySelectorAll('video, audio').length !== 1) break;
      heading ||= visibleText(container, 'h1, h2, h3, h4, h5, h6');
      description ||= visibleText(container, 'figcaption, [itemprop="description"], p');
      if (heading && description || container.matches('article, aside, figure, section')) break;
    }
    return {heading:heading || null, description:description || null};
  };
  let opaquePlayer = null;
  let unloaded = 0, unsupported = 0;
  const roleFor = video => video.localName === 'audio' ? 'audio' : 'video';
  const candidates = [
    ...videos.flatMap((video, playerIndex) => {
      if (video.mediaKeys) return [];
      const elementSrc = video.getAttribute('src')?.trim() ? video.src : '';
      const source = video.currentSrc && video.currentSrc !== location.href ? video.currentSrc : elementSrc;
      const lazy = video.getAttribute('data-src');
      const sources = [...video.querySelectorAll('source')].slice(0, 16).map(node => ({
        url:node.getAttribute('src') ? node.src : normalizeUrl(node.getAttribute('data-src')), mime:node.type || undefined,
      }));
      if (lazy && !source) sources.push({url:normalizeUrl(lazy),strategy:'page-config'});
      if (!source && !sources.some(row => row.url)) unloaded++;
      if (source && !/^(?:https?|blob):/.test(source)) unsupported++;
      const urls = new Set([source, elementSrc, ...sources.map(item => item.url)].filter(Boolean).map(normalizeUrl));
      const opaque = source.startsWith('blob:');
      const matching = structured.find(entry => [entry.contentUrl].flat().some(url => urls.has(normalizeUrl(url))));
      const only = video === primary ? pageVideo : null;
      const info = matching || (only && (!only.contentUrl || opaque) ? only : null);
      const label = (video.getAttribute('aria-labelledby') || '').split(/\s+/).map(id =>
        document.getElementById(id)?.textContent).filter(Boolean).join(' ');
      const generic = /^(?:player|video|media|播放器|视频)(?:[ ._-]*\d+)?$/i;
      const context = includeContext ? nearbyText(video) : null;
      const [playerTitleSource, playerTitle] = titleFrom([
        ['video-object', info?.name], ['player-title', video.getAttribute('title')], ['player-label', label],
        ['media-session', video === primary ? sessionTitle : ''], ['player-label', video.getAttribute('aria-label')],
        ['player-heading', context?.heading],
      ].filter(([, value]) => !generic.test(clean(value))));
      const usePageTitle = video === primary && !generic.test(pageTitle);
      const title = playerTitle || (usePageTitle ? pageTitle : '') || null;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds(clean(info?.duration));
      const metadata = { title, titleSource:playerTitleSource || (title && titleSource),
        duration, width: video.videoWidth || null, height: video.videoHeight || null,
        poster: normalizeUrl(video.poster || (video === primary ? pageMetadata.poster : '')) || null,
        playing: !video.paused && !video.ended, namedByPlayer:Boolean(playerTitle), playerIndex,
        role:roleFor(video), playerType:video.closest('.video-js') ? 'videojs' : video.closest('.plyr') ? 'plyr'
          : video.closest('.jwplayer') ? 'jwplayer' : 'html5',
        ...(context && {playerContext:{...context, description:clean(info?.description) || context.description,
          visible:visible(video),large:video.clientWidth >= 320 && video.clientHeight >= 150}}) };
      if (opaque && video === primary) opaquePlayer = metadata;
      return [...new Map([{ url: elementSrc }, ...sources, {url:source,mime:sources.find(item => item.url === source)?.mime}]
        .filter(item => item.url).map(item => [item.url, item])).values()]
        .map(item => ({ ...metadata, ...item, mediaElement:true,
          currentSource:source ? item.url === source : undefined,
          ...(source && item.url !== source && {width:null,height:null}) }));
    }),
    ...['og:video:secure_url','og:video:url','og:video','twitter:player:stream'].flatMap(property => {
      const url = normalizeUrl(meta('property', property) || meta('name',property));
      const mime = meta('property', 'og:video:type') || meta('name','twitter:player:stream:content_type');
      return url ? [{url,mime,strategy:'structured-data'}] : [];
    }),
    ...performance.getEntriesByType('resource').slice(-150).filter(resource =>
      resource.startTime >= (globalThis.videoSaveRouteStart || 0) &&
      ['video','audio','fetch','xmlhttprequest'].includes(resource.initiatorType)).map(resource =>
      ({url:resource.name,strategy:'performance'})),
  ];
  const pages = [...new Map([...document.querySelectorAll('a[href]')]
    .filter(a => /^https?:/.test(a.href) && a.href !== location.href && /\/(?:watch|videos?|clip)(?:[/?#]|$)/i.test(a.href))
    .map(a => [a.href, {url: a.href, title: (a.title || a.textContent.trim()).slice(0, 120)}])).values()].slice(0, 80);
  const detailPages = includeContext ? new Map() : null;
  if (detailPages) for (const link of document.querySelectorAll('a[href]')) {
    if (detailPages.size >= 80) break;
    if (link.closest('nav, [role="navigation"], footer, [role="tablist"]')) continue;
    const url = URL.parse(link.href);
    if (!url || url.origin !== location.origin || url.username || url.password) continue;
    url.hash = '';
    const detailPath = /\/(?:watch|videos?|clips?|view_video)(?:\.php)?\/([^/]+)/i.exec(url.pathname)?.[1];
    const queryId = /\/(?:watch|view_video(?:\.php)?)\/?$/i.test(url.pathname) &&
      ['v','id','viewkey'].some(key => url.searchParams.get(key));
    if ((!detailPath && !queryId) || /^(?:hot|popular|latest|new|all|search|category|categories|tag|tags|trending|top|index|featured|list)$/i.test(detailPath)) continue;
    if (url.href === normalizeUrl(location.href) || detailPages.has(url.href)) continue;
    const title = clean(link.title || link.textContent || link.querySelector('img')?.alt, 120) ||
      clean(link.querySelector('img')?.alt, 120);
    if (!title) continue;
    const duration = seconds(link.querySelector('time[datetime]')?.dateTime);
    detailPages.set(url.href, {url:url.href, title, kind:'page', ...(duration && {duration})});
  }
  const opaqueCount = videos.filter(video => (video.currentSrc || video.src).startsWith('blob:')).length;
  const visibleBlocker = selector => [...document.querySelectorAll(selector)].some(visible);
  const blocker = visibleBlocker('#challenge-form, #cf-challenge-running, #cf-challenge-stage') ? 'cloudflare-challenge'
    : visibleBlocker('#captcha-form, form[action*="captcha"]') ? 'captcha'
    : !videos.length && visibleBlocker('iframe[src*="challenges.cloudflare.com"], .cf-turnstile') ? 'cf-turnstile' : null;
  return { pageTitle:document.title, pageMetadata, pageContext, playerCount:videos.length, candidates, pages,
    documentUrl:location.href, documentTimeOrigin:performance.timeOrigin, blocker,
    routeStartedAt:globalThis.videoSaveRouteStart && performance.timeOrigin + globalThis.videoSaveRouteStart,
    ...(detailPages && {detailPages:[...detailPages.values()]}), opaquePlayer, excludedMedia:[...excludedMedia],
    encrypted:videos.some(video => video.mediaKeys),
    publicConfigs, unloaded, unsupported, iframeCount:document.querySelectorAll('iframe, frame').length,
    opaqueCount, opaque:opaqueCount > 0, ready:document.readyState === 'complete' };
}
