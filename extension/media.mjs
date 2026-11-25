
const adaptive = new Set(['m3u8', 'mpd']);
const formats = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv', 'avi', 'm3u8', 'mpd']);

export function classify(value, contentType = '', mediaElement = false) {
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const pathname = url.pathname.toLowerCase();
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || /\.(?:ts|m4s|cmfv|cmfa|m4a)$/.test(pathname) ||
      /\/(?:init|segment|chunk|fragment)(?:[-_\d][^/]*)?\.mp4$/.test(pathname)) return null;
  if (/^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/.test(mime)) return 'm3u8';
  if (mime === 'application/dash+xml') return 'mpd';
  const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1];
  if (formats.has(extension)) return extension;
  const subtype = { 'video/webm':'webm', 'video/quicktime':'mov', 'video/x-matroska':'mkv', 'video/ogg':'ogv' }[mime];
  if (subtype || mime.startsWith('video/') || mediaElement) return subtype || 'mp4';
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
  const observed = frames.flatMap(({ frameId, result }) => {
    const { candidates, opaquePlayer } = result;
    if (!opaquePlayer) return candidates;
    // An opaque player has no HTTP source URL. Only join an unambiguous
    // playlist from its own frame so ads and sibling players stay separate.
    const sameFrame = requests.filter(request => request.frameId === frameId);
    const playlists = pickStreams([...sameFrame, ...candidates]).filter(stream => adaptive.has(stream.kind));
    return playlists.length === 1
      ? [...candidates, { ...playlists[0], ...opaquePlayer }]
      : candidates;
  });
  return pickStreams([...requests, ...observed]);
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
  const videos = [...document.querySelectorAll('video')];
  const structured = [];
  if (videos.length) {
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
  }
  const playing = videos.filter(video => !video.paused && !video.ended);
  const primary = videos.length === 1 ? videos[0] : playing.length === 1 ? playing[0] : null;
  const sessionTitle = clean(navigator.mediaSession?.metadata?.title);
  const fallbackTitle = videos.length === 1
    ? meta('property', 'og:title') || meta('name', 'twitter:title') || clean(document.title)
    : '';
  let opaquePlayer = null;
  const candidates = [
    ...videos.flatMap(video => {
      if (video.mediaKeys) return [];
      const source = video.currentSrc || video.src;
      const sources = [...video.querySelectorAll('source')].map(node => ({ url: node.src, mime: node.type || undefined }));
      const urls = new Set([source, video.src, ...sources.map(item => item.url)].filter(Boolean).map(normalizeUrl));
      const opaque = source.startsWith('blob:');
      const matching = structured.find(entry => [entry.contentUrl].flat().some(url => urls.has(normalizeUrl(url))));
      const only = videos.length === 1 && structured.length === 1 ? structured[0] : null;
      const info = matching || (only && (!only.contentUrl || opaque) ? only : null);
      const title = clean(video.getAttribute('title')) || clean(info?.name) ||
        (video === primary ? sessionTitle : '') || clean(video.getAttribute('aria-label')) || fallbackTitle || null;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds(clean(info?.duration));
      const metadata = { title, duration, width: video.videoWidth || null, height: video.videoHeight || null,
        poster: normalizeUrl(video.poster || (video === primary ? meta('property', 'og:image') : '')) || null };
      if (opaque && videos.length === 1) opaquePlayer = metadata;
      return [...new Map([{ url: video.src }, { url: source }, ...sources]
        .filter(item => item.url).map(item => [item.url, item])).values()]
        .map(item => ({ ...item, mediaElement: true, ...metadata }));
    }),
    ...performance.getEntriesByType('resource').map(resource => ({url: resource.name})),
  ];
  const pages = [...new Map([...document.querySelectorAll('a[href]')]
    .filter(a => /^https?:/.test(a.href) && a.href !== location.href && /\/(?:watch|videos?|clip)(?:[/?#]|$)/i.test(a.href))
    .map(a => [a.href, {url: a.href, title: (a.title || a.textContent.trim()).slice(0, 120)}])).values()].slice(0, 80);
  return { pageTitle:document.title, candidates, pages, opaquePlayer, encrypted:videos.some(video => video.mediaKeys),
    opaque:videos.some(video => (video.currentSrc || video.src).startsWith('blob:')), ready:document.readyState === 'complete' };
}
