export function manifestEvidence(body, base, kind) {
  if (kind === 'mpd') {
    if (!/<(?:\w+:)?MPD[\s>]/i.test(body)) return null;
    const drm = /<(?:\w+:)?ContentProtection\b[^>]*(?:mp4protection:2011|urn:uuid:|cenc:default_KID)/i.test(body);
    return {manifestRole:'master', ...(drm && {drm:true})};
  }
  if (kind !== 'm3u8' || !/^#EXTM3U\s/.test(body.trimStart())) return null;
  const variants = [];
  const children = new Set();
  const parts = new Set();
  let nextVariant;
  let drm = false;
  const addChild = (value, target = children) => {
    const url = URL.parse(value,base);
    if (!url || !['https:','http:'].includes(url.protocol) || url.username || url.password || target.size >= 48) return;
    url.hash = '';
    target.add(url.href);
    return url.href;
  };
  for (const line of body.trim().split(/\r?\n/)) {
    const row = line.trim();
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(row) &&
        (/\bMETHOD=SAMPLE-AES/i.test(row) || /\bKEYFORMAT="(?!identity")/i.test(row))) drm = true;
    if (row.startsWith('#EXT-X-STREAM-INF:')) {
      nextVariant = {height:Number(/\bRESOLUTION=\d+x(\d+)/.exec(row)?.[1]) || null,
        bitrate:Number(/\bBANDWIDTH=(\d+)/.exec(row)?.[1]) || null};
    } else if (row.startsWith('#EXT-X-MEDIA:')) {
      const uri = /\bURI="([^"]+)"/.exec(row)?.[1];
      if (uri) addChild(uri);
    } else if (row.startsWith('#EXT-X-MAP:')) {
      const uri = /\bURI="([^"]+)"/.exec(row)?.[1];
      if (uri) addChild(uri,parts);
    } else if (nextVariant && row && !row.startsWith('#')) {
      const url = addChild(row);
      if (url) variants.push({...nextVariant,url});
      nextVariant = undefined;
    } else if (row && !row.startsWith('#')) addChild(row,parts);
  }
  return {manifestRole:variants.length ? 'master' : 'media', ...(drm && {drm:true}),
    ...(children.size && {manifestChildren:[...children]}), ...(parts.size && {manifestParts:[...parts]}), ...(variants.length && {quality:variants})};
}
