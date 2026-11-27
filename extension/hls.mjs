const manifestByteLimit = 128 * 1024;
const supportedTag = /^#EXT(?:M3U|INF:[\d.]+,.*|-X-(?:VERSION:\d+|TARGETDURATION:\d+|MEDIA-SEQUENCE:\d+|PLAYLIST-TYPE:VOD|INDEPENDENT-SEGMENTS|ENDLIST))$/;

export function httpUrl(value, base) {
  const url = URL.parse(value, base);
  return url && /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
}

export async function readManifest(body) {
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  // Leaving a for-await loop early cancels the response body.
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > manifestByteLimit) return '';
    text += decoder.decode(chunk, {stream:true});
  }
  return text + decoder.decode();
}

function manifestLines(text) {
  return text.trim().split(/\r?\n/).map(line => line.trim()).filter(line => line && (!line.startsWith('#') || line.startsWith('#EXT')));
}

export function selectRendition(text, source, quality) {
  return rankRenditions(text,source,quality)[0] ?? null;
}

export function rankRenditions(text, source, quality) {
  const [header, ...lines] = manifestLines(text);
  if (header !== '#EXTM3U') return [];
  const variants = [];
  const audio = [];
  let pending;
  for (const line of lines) {
    if (pending) {
      const url = !line.startsWith('#') && httpUrl(line, source);
      if (!url) return [];
      variants.push({...pending, url});
      pending = null;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = line.slice(line.indexOf(':') + 1);
      if (/(?:^|,)(?:VIDEO|SUBTITLES|CLOSED-CAPTIONS)=(?!NONE(?:,|$))/.test(attributes)) return [];
      const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attributes)?.[1]);
      const height = Number(/(?:^|,)RESOLUTION=\d+x(\d+)/.exec(attributes)?.[1]);
      if (!bandwidth || !height) return [];
      pending = {height, bandwidth, audioGroup:attribute(attributes,'AUDIO')};
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = line.slice(line.indexOf(':') + 1);
      const group = attribute(attributes, 'GROUP-ID');
      const uri = attribute(attributes, 'URI');
      if (!/(?:^|,)TYPE=AUDIO(?:,|$)/.test(attributes) || !group || !uri) return [];
      const url = httpUrl(uri, source);
      if (!url) return [];
      audio.push({url,group,preferred:/(?:^|,)DEFAULT=YES(?:,|$)/.test(attributes)});
    } else if (!/^#EXT-X-(?:VERSION:\d+|INDEPENDENT-SEGMENTS)$/.test(line)) {
      return [];
    }
  }
  if (pending || !variants.length) return [];
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const eligible = variants.filter(variant => !quality || variant.height <= quality);
  return (eligible.length ? eligible : variants.filter(variant => variant.height === variants.at(-1).height)).map(variant => {
    const group = audio.filter(track => track.group === variant.audioGroup);
    const sound = group.find(track => track.preferred) ?? group[0];
    return variant.audioGroup && !sound ? null
      : {video:variant.url, audio:sound?.url, bandwidth:variant.bandwidth, height:variant.height};
  });
}

function attribute(attributes, key) {
  return new RegExp(`(?:^|,)${key}="([^"]+)"`).exec(attributes)?.[1];
}

function byteRange(value, defaultStart) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) return null;
  const start = match[2] === undefined ? defaultStart : Number(match[2]);
  const length = Number(match[1]);
  const end = start + length - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && length > 0 ? {start,end} : null;
}

function segmentKey(value, source) {
  if (value === 'METHOD=NONE') return {method:'NONE'};
  const fields = value.match(/(?:^|,)[A-Z0-9-]+=(?:"[^"]*"|[^",\s]+)(?=,|$)/g);
  if (!fields || fields.join('') !== value) return null;
  const attributes = new Map();
  for (const field of fields) {
    const start = field.startsWith(',') ? 1 : 0;
    const separator = field.indexOf('=');
    const name = field.slice(start, separator);
    if (!['METHOD','URI','IV','KEYFORMAT','KEYFORMATVERSIONS'].includes(name) || attributes.has(name)) return null;
    attributes.set(name, field.slice(separator + 1));
  }
  if (attributes.get('METHOD') !== 'AES-128' ||
    (attributes.get('KEYFORMAT') ?? '"identity"') !== '"identity"' ||
    (attributes.get('KEYFORMATVERSIONS') ?? '"1"') !== '"1"') return null;
  const uri = /^"([^"]+)"$/.exec(attributes.get('URI'))?.[1];
  const url = uri && httpUrl(uri, source);
  const iv = attributes.get('IV');
  if (!url || iv !== undefined && !/^0x[0-9a-f]{1,32}$/i.test(iv)) return null;
  return {method:'AES-128', url, iv:iv && '0x' + iv.slice(2).padStart(32, '0')};
}

export function parseManifest(text, source, prefix, {byteRanges = false, aes128 = false, sniffTransport = false} = {}) {
  const lines = manifestLines(text);
  if (lines[0] !== '#EXTM3U' || lines.at(-1) !== '#EXT-X-ENDLIST') return null;
  const segments = [];
  const playlist = [];
  const keys = new Map();
  let encrypted = false;
  let needsSegment = false;
  let initFilename;
  let mediaCount = 0;
  let pendingRange;
  let previousRange;
  for (const line of lines) {
    if (line.startsWith('#')) {
      if (aes128 && line.startsWith('#EXT-X-KEY:')) {
        const key = segmentKey(line.slice('#EXT-X-KEY:'.length), source);
        if (!key) return null;
        encrypted = key.method === 'AES-128';
        if (encrypted) {
          let local = keys.get(key.url.href);
          if (!local) {
            local = {url:key.url, filename:`${prefix}-key-${keys.size}.key`};
            keys.set(key.url.href, local);
          }
          playlist.push(`#EXT-X-KEY:METHOD=AES-128,URI="${local.filename}"${key.iv ? ',IV=' + key.iv : ''}`);
        } else {
          playlist.push(line);
        }
        continue;
      }
      const map = /^#EXT-X-MAP:URI="([^"]+)"(?:,BYTERANGE="([^"]+)")?$/.exec(line);
      if (map) {
        const url = httpUrl(map[1], source);
        const range = map[2] && byteRanges && byteRange(map[2]);
        if (!url || needsSegment || encrypted || (map[2] && !range)) return null;
        initFilename = `${prefix}-init-${segments.length}.mp4`;
        segments.push({url, filename:initFilename, ...(range && {range})});
        playlist.push(`#EXT-X-MAP:URI="${initFilename}"`);
        continue;
      }
      if (byteRanges && needsSegment && line.startsWith('#EXT-X-BYTERANGE:')) {
        if (pendingRange) return null;
        pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);
        if (!pendingRange) return null;
        continue;
      }
      if (/^#EXT-X-BITRATE:\d+$/.test(line)) continue;
      if (!supportedTag.test(line) || needsSegment) return null;
      needsSegment = line.startsWith('#EXTINF:');
      playlist.push(line);
      continue;
    }
    const url = httpUrl(line, source);
    if (!needsSegment || !url) return null;
    const verifyTransport = !initFilename && !/\.ts$/i.test(url.pathname);
    if (verifyTransport && (!sniffTransport || encrypted)) return null;
    const range = pendingRange && byteRange(pendingRange, previousRange?.url === url.href ? previousRange.end + 1 : undefined);
    // Full MPEG-TS segments can be staged unchanged for local FFmpeg decryption.
    if (pendingRange && !range || encrypted && (range || initFilename)) return null;
    const filename = `${prefix}-${segments.length}.${initFilename ? 'm4s' : 'ts'}`;
    segments.push({url, filename, ...(range && {range}), ...(verifyTransport && {verifyTransport})});
    previousRange = range ? {url:url.href, end:range.end} : undefined;
    pendingRange = undefined;
    playlist.push(filename);
    mediaCount++;
    needsSegment = false;
  }
  if (!mediaCount || needsSegment) return null;
  return { segments, playlist: playlist.join('\n') + '\n', ...(aes128 && {keys:[...keys.values()]}) };
}
