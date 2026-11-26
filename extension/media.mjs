
const adaptive = new Set(['m3u8', 'mpd']);
const formats = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv', 'avi', 'm3u8', 'mpd']);

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

export function classify(value, contentType = '', mediaElement = false) {
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const pathname = url.pathname.toLowerCase();
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (/^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/.test(mime)) return 'm3u8';
  if (mime === 'application/dash+xml') return 'mpd';
  if (/^(?:text\/|image\/|audio\/|font\/)|(?:json|xml|javascript|iso\.segment)$/.test(mime) ||
      /\.(?:ts|m4s|cmfv|cmfa|m4a|aac|vtt)$/.test(pathname) ||
      /\/(?:init|segment|chunk|fragment)(?:[-_\d][^/]*)?\.(?:mp4|m4v|mov|webm)$/.test(pathname)) return null;
  const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1];
  if (formats.has(extension)) return extension;
  const subtype = { 'video/webm':'webm', 'video/quicktime':'mov', 'video/x-matroska':'mkv', 'video/ogg':'ogv' }[mime];
  if (subtype || mime.startsWith('video/') || (mediaElement && !mime)) return subtype || 'mp4';
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
    const fields = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value != null));
    streams.set(url.href, { ...previous, ...fields, url: url.href,
      kind: previous && adaptive.has(previous.kind) ? previous.kind : kind });
  }
  return [...streams.values()].sort((a, b) => Number(adaptive.has(b.kind)) - Number(adaptive.has(a.kind)));
}

export function pageStreams(frames, requests) {
  const noisy = /\/(?:ad[sx]?|preroll|midroll|storyboards?|thumbnails?|sprites?|tracking|beacons?)\//i;
  const declared = new Set();
  const covered = new Set();
  const inferred = [];
  const rejected = new Set(requests.filter(row => row.mime && !classify(row.url,row.mime)).map(row => row.url));
  const excluded = new Set(frames.flatMap(({result}) => result.excludedMedia ?? []));
  const metadata = frames.find(frame => frame.frameId === 0)?.result.pageMetadata;
  const playerCount = frames.reduce((count, frame) => count + (frame.result.playerCount || 0), 0);
  const observed = frames.flatMap(({ frameId, result }) => {
    const candidates = result.candidates.map(candidate => ({...candidate, frameId}));
    for (const candidate of candidates) {
      if (candidate.mediaElement && classify(candidate.url, candidate.mime, true)) declared.add(new URL(candidate.url).href);
    }
    if (!result.opaquePlayer || result.encrypted) return candidates;
    const playlists = pickStreams([...requests.filter(row => row.frameId === frameId), ...candidates])
      .filter(stream => adaptive.has(stream.kind) && !noisy.test(new URL(stream.url).pathname));
    const masters = playlists.filter(stream => stream.kind === 'm3u8' &&
      /\/(?:master|multivariant|main)(?:[-_][\w-]+)?\.m3u8$/i.test(new URL(stream.url).pathname));
    const master = masters.length === 1 && masters[0];
    const base = master && new URL('.', master.url).href;
    const samePlaylistFamily = base && (result.opaqueCount ?? 1) <= 1 &&
      playlists.every(stream => stream.kind === 'm3u8' && stream.url.startsWith(base));
    if (samePlaylistFamily) {
      for (const stream of playlists) if (stream.url !== master.url && !stream.mediaElement) covered.add(`${frameId} ${stream.url}`);
    }
    const playlist = playlists.length === 1 ? playlists[0] : samePlaylistFamily ? master : null;
    if (playlist) inferred.push({...playlist, ...result.opaquePlayer, fromPlayer:true});
    return candidates;
  });
  const eligible = url => !rejected.has(url.href) && (!excluded.has(url.href) || declared.has(url.href));
  const network = requests.filter(request => {
    const url = URL.parse(request.url);
    return url && eligible(url) && !covered.has(`${request.frameId} ${url.href}`) && (declared.has(url.href) ||
      !noisy.test(url.pathname) && request.type !== 'image');
  });
  const streams = pickStreams([...network, ...observed.filter(candidate => {
    const url = URL.parse(candidate.url);
    return url && eligible(url) && !covered.has(`${candidate.frameId} ${url.href}`) &&
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
    if (stream.frameId !== 0 && !stream.namedByPlayer && metadata.videoTitle) stream.title = metadata.videoTitle;
    stream.title ||= metadata.videoTitle || sourceTitle(stream) || metadata.title;
    stream.poster ||= metadata.poster;
  }
  const verified = representatives.filter(stream => stream.mediaElement || stream.fromPlayer);
  const active = verified.filter(stream => stream.playing);
  const preferred = active.length === 1 ? active[0] : verified.length === 1 ? verified[0] : null;
  if (preferred) preferred.recommended = true;
  const priority = stream => stream.recommended ? 3 : stream.playing ? 2 : stream.mediaElement || stream.fromPlayer ? 1 : 0;
  return representatives.sort((a, b) => priority(b) - priority(a));
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

export function scanDocument() {
  // This function is executed inside the page with no module imports.
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const meta = (attribute, name) => clean(document.querySelector(`meta[${attribute}="${name}"]`)?.content);
  const normalizeUrl = value => {
    const url = typeof value === 'string' && URL.parse(value, document.baseURI);
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
  const videos = [];
  const excludedMedia = new Set();
  const adMarker = /^(?:(?:vjs[-_])?(?:pre|mid|post)[-_]?roll(?:[-_](?:video|player|ad|container))?|(?:video[-_]ad|ad[-_]video))$/i;
  for (const video of document.querySelectorAll('video')) {
    let element = video;
    let isAd = false;
    for (let depth = 0; element && depth < 4; depth++, element = element.parentElement) {
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
  const structured = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const json = script.textContent;
      if (!json || json.length > 512_000) continue;
      let data;
      try { data = JSON.parse(json); } catch { continue; }
      const pending = [data];
      for (let visited = 0; pending.length && visited < 2_000; visited++) {
        const entry = pending.pop();
        if (!entry || typeof entry !== 'object') continue;
        if ([entry['@type']].flat().some(type => typeof type === 'string' && /(?:^|\/)VideoObject$/.test(type))) {
          structured.push(entry);
        }
        for (const value of Object.values(entry)) {
          if (value && typeof value === 'object') pending.push(value);
        }
      }
  }
  const playing = videos.filter(video => !video.paused && !video.ended);
  const primary = videos.length === 1 ? videos[0] : playing.length === 1 ? playing[0] : null;
  const sessionTitle = clean(navigator.mediaSession?.metadata?.title);
  const pageVideo = structured.length === 1 ? structured[0] : null;
  const titleNode = document.querySelector('[itemtype$="/VideoObject"] [itemprop="name"], #viewvideo-title');
  const videoTitle = clean(pageVideo?.name) || clean(titleNode?.getAttribute('content') || titleNode?.textContent) || sessionTitle ||
    (/^video(?:\.|$)/.test(meta('property','og:type')) ? meta('property','og:title') : '');
  const pageMetadata = {
    videoTitle,
    title: videoTitle || meta('property', 'og:title') || meta('name', 'twitter:title') ||
      clean(document.querySelector('main h1, article h1, h1')?.textContent) || clean(document.title),
    poster: normalizeUrl([pageVideo?.thumbnailUrl].flat()[0] || meta('property', 'og:image')) || null,
  };
  let opaquePlayer = null;
  const candidates = [
    ...videos.flatMap((video, playerIndex) => {
      if (video.mediaKeys) return [];
      const source = video.currentSrc || video.src;
      const sources = [...video.querySelectorAll('source')].map(node => ({ url: node.src, mime: node.type || undefined }));
      const urls = new Set([source, video.src, ...sources.map(item => item.url)].filter(Boolean).map(normalizeUrl));
      const opaque = source.startsWith('blob:');
      const matching = structured.find(entry => [entry.contentUrl].flat().some(url => urls.has(normalizeUrl(url))));
      const only = video === primary ? pageVideo : null;
      const info = matching || (only && (!only.contentUrl || opaque) ? only : null);
      const label = (video.getAttribute('aria-labelledby') || '').split(/\s+/).map(id =>
        document.getElementById(id)?.textContent).filter(Boolean).join(' ');
      const generic = /^(?:player|video|media|播放器|视频)(?:[ ._-]*\d+)?$/i;
      const playerTitle = [info?.name, video.getAttribute('title'), label, video === primary ? sessionTitle : '',
        video.getAttribute('aria-label')].map(clean).find(value => value && !generic.test(value));
      const title = playerTitle || (video === primary && !generic.test(pageMetadata.title) ? pageMetadata.title : '') || null;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds(clean(info?.duration));
      const metadata = { title, duration, width: video.videoWidth || null, height: video.videoHeight || null,
        poster: normalizeUrl(video.poster || (video === primary ? pageMetadata.poster : '')) || null,
        playing: !video.paused && !video.ended, namedByPlayer:Boolean(playerTitle) };
      if (opaque && video === primary) opaquePlayer = metadata;
      return [...new Map([{ url: video.src }, { url: source }, ...sources]
        .filter(item => item.url).map(item => [item.url, item])).values()]
        .map(item => ({ ...item, mediaElement:true, playerIndex, currentSource:item.url === source, ...metadata }));
    }),
    ...performance.getEntriesByType('resource').filter(resource =>
      ['video','fetch','xmlhttprequest'].includes(resource.initiatorType)).map(resource => ({url:resource.name})),
  ];
  const pages = [...new Map([...document.querySelectorAll('a[href]')]
    .filter(a => /^https?:/.test(a.href) && a.href !== location.href && /\/(?:watch|videos?|clip)(?:[/?#]|$)/i.test(a.href))
    .map(a => [a.href, {url: a.href, title: (a.title || a.textContent.trim()).slice(0, 120)}])).values()].slice(0, 80);
  const opaqueCount = videos.filter(video => (video.currentSrc || video.src).startsWith('blob:')).length;
  return { pageTitle:document.title, pageMetadata, playerCount:videos.length, candidates, pages, opaquePlayer, excludedMedia:[...excludedMedia],
    encrypted:videos.some(video => video.mediaKeys),
    opaqueCount, opaque:opaqueCount > 0, ready:document.readyState === 'complete' };
}
