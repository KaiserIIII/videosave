const formats = {
  hls:'application/x-mpegurl', m3u8:'application/x-mpegurl', dash:'application/dash+xml',
  mpd:'application/dash+xml', mp4:'video/mp4', webm:'video/webm',
};

const adapters = [
  {
    name:'video-object',
    read(value) {
      const types = [value['@type']].flat();
      if (!types.some(type => typeof type === 'string' && /(?:^|\/)VideoObject$/.test(type))) return [];
      return [value.contentUrl].flat().map(url => ({url, title:value.name, type:value.encodingFormat}));
    },
  },
  {
    name:'player-sources',
    read(value) {
      if (!Array.isArray(value.sources)) return [];
      return value.sources.slice(0, 12).map(source => typeof source === 'string' ? {url:source} : {
        url:source?.file || source?.src || source?.url || source?.source,
        type:source?.type, height:source?.height ?? source?.res, label:source?.label,
        bitrate:source?.bitrate, role:source?.kind,
      });
    },
  },
];

export function publicMediaSources(value, base, {strategy, sameOrigin = false} = {}) {
  const origin = new URL(base);
  const pending = [value];
  const rows = new Map();
  for (let visited = 0; pending.length && visited < 400 && rows.size < 12; visited++) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const adapter of adapters) {
      for (const entry of adapter.read(current)) {
        if (rows.size >= 12 || typeof entry.url !== 'string' || entry.url.length > 8192 || !entry.url.trim()) continue;
        const url = URL.parse(entry.url, origin);
        if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
            sameOrigin && url.origin !== origin.origin) continue;
        url.hash = '';
        const height = Number(entry.height ?? /^(\d{3,4})p$/i.exec(entry.label)?.[1]);
        const bitrate = Number(entry.bitrate);
        const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
        const mime = (Object.hasOwn(formats,type) ? formats[type] : '') || (/^(?:application|audio|video)\/[a-z0-9.+-]+$/.test(type) ? type : undefined);
        if (!mime && !/\.(?:mp4|m4v|webm|ogv|mkv|mov|m3u8|mpd|mp3|m4a|ogg|wav|flac|ts)$/i.test(url.pathname)) continue;
        if (!rows.has(url.href)) rows.set(url.href, {
          url:url.href, strategy, adapter:adapter.name, mime,
          ...(Number.isSafeInteger(height) && height >= 144 && height <= 8640 && {height}),
          ...(Number.isFinite(bitrate) && bitrate > 0 && {bitrate}),
          ...(typeof entry.title === 'string' && {title:entry.title.trim().slice(0, 300),titleSource:'video-object'}),
          ...(['audio','video'].includes(entry.role) && {role:entry.role}),
        });
      }
    }
    if (pending.length < 400) pending.push(...Object.values(current).slice(0, 40).reverse());
  }
  return [...rows.values()];
}

export function declaredMediaSources(result) {
  return (result.publicConfigs ?? []).flatMap(({json,base,strategy}) => {
    try { return publicMediaSources(JSON.parse(json), base, {strategy}); }
    catch { return []; }
  }).slice(0, 24);
}
