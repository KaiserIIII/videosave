const attribute = (tag, name) => new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(tag)?.slice(1).find(value => value !== undefined);
const escapePattern = value => value.replace(/[.*+?^$|{}()[\]\\]/g,'\\$&');

function dashSegmentPatterns(body, manifestUrl) {
  // Match observed requests against explicit MPD URIs. Leave complex BaseURL hierarchies unclassified.
  const xml = body.replace(/<!--[\s\S]*?-->/g,'');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return [];
  const bases = [...xml.matchAll(/<(?:\w+:)?BaseURL(?:\s[^>]*)?>([^<>]+)<\/(?:\w+:)?BaseURL>/g)];
  if (bases.length > 1 || bases.length && /<Period[\s>]/.test(xml.slice(0,bases[0].index))) return [];
  const decode = value => value.replace(/&amp;/g,'&');
  const base = URL.parse(decode(bases[0]?.[1].trim() || './'),manifestUrl);
  if (!base) return [];
  const patterns = new Set();
  const add = template => {
    if (!template || template.length > 512 || patterns.size >= 64 || template.includes('vs-num-placeholder-')) return;
    const widths = [];
    const value = decode(template).replace(/\$(?:Number|Time)(?:%0([1-9]\d?)d)?\$/g, (_,width) => {
      widths.push(Number(width) || 1);
      return 'vs-num-placeholder-' + (widths.length - 1);
    });
    if (value.includes('$') || widths.length > 1 || widths[0] > 20) return;
    const url = URL.parse(value,base);
    if (!url || !['http:','https:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    const source = escapePattern(url.href).replace('vs-num-placeholder-0', '\\d{' + widths[0] + ',20}');
    patterns.add('^' + source + '$');
  };
  for (const [tag] of xml.matchAll(/<(?:\w+:)?(?:SegmentURL|Initialization)\b[^<>]*>/g)) {
    add(attribute(tag,'media') ?? attribute(tag,'sourceURL'));
  }
  const groups = [...xml.matchAll(/<(?:\w+:)?AdaptationSet\b[^<>]*>([\s\S]*?)<\/(?:\w+:)?AdaptationSet\s*>/g)];
  for (const [,group] of groups.slice(0,24)) {
    const representations = [...group.matchAll(/<(?:\w+:)?Representation\b[^<>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?Representation\s*>)/g)];
    const shared = group.replace(/<(?:\w+:)?Representation\b[^<>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?Representation\s*>)/g,'');
    const inherited = /<(?:\w+:)?SegmentTemplate\b[^<>]*>/.exec(shared)?.[0];
    for (const [representation] of representations.slice(0,32)) {
      const start = representation.slice(0,representation.indexOf('>') + 1);
      const id = attribute(start,'id');
      const bandwidth = attribute(start,'bandwidth');
      const local = /<(?:\w+:)?SegmentTemplate\b[^<>]*>/.exec(representation)?.[0];
      for (const name of ['media','initialization']) {
        let template = attribute(local ?? '',name) ?? attribute(inherited ?? '',name);
        if (id && /^[\w.-]+$/.test(id)) template = template?.replaceAll('$RepresentationID$',id);
        if (bandwidth && /^\d+$/.test(bandwidth)) template = template?.replaceAll('$Bandwidth$',bandwidth);
        add(template);
      }
    }
  }
  return [...patterns];
}

export function manifestEvidence(body, base, kind) {
  if (kind === 'mpd') {
    if (!/<(?:\w+:)?MPD[\s>]/i.test(body)) return null;
    const drm = /<(?:\w+:)?ContentProtection\b[^>]*(?:mp4protection:2011|urn:uuid:|cenc:default_KID)/i.test(body);
    const patterns = drm ? [] : dashSegmentPatterns(body,base);
    return {manifestRole:'master', ...(drm && {drm:true}), ...(patterns.length && {manifestPartPatterns:patterns})};
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
