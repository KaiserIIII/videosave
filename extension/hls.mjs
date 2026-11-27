const manifestByteLimit = 256 * 1024;
const supportedTag = /^#EXT(?:M3U|INF:[\d.]+,.*|-X-(?:VERSION:\d+|TARGETDURATION:\d+|MEDIA-SEQUENCE:\d+|DISCONTINUITY(?:-SEQUENCE:\d+)?|PLAYLIST-TYPE:(?:VOD|EVENT)|INDEPENDENT-SEGMENTS|ALLOW-CACHE:(?:YES|NO)|PROGRAM-DATE-TIME:.*|START:.*|ENDLIST))$/;

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

function attribute(attributes, key) {
  return new RegExp(`(?:^|,)${key}="([^"]+)"`).exec(attributes)?.[1];
}

function unquotedAttribute(attributes, key) {
  return new RegExp(`(?:^|,)${key}=([^,\\s]+)`).exec(attributes)?.[1];
}

export function parseMasterVariants(text, source) {
  const [header, ...lines] = manifestLines(text);
  if (header !== '#EXTM3U') return { variants: [], audioTracks: [], subtitleTracks: [] };
  const variants = [];
  const audioTracks = [];
  const subtitleTracks = [];
  let pending = null;
  for (const line of lines) {
    if (pending) {
      const url = !line.startsWith('#') && httpUrl(line, source);
      if (!url) return { variants: [], audioTracks: [], subtitleTracks: [] };
      variants.push({ ...pending, url });
      pending = null;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = line.slice(line.indexOf(':') + 1);
      if (/(?:^|,)VIDEO=(?!NONE(?:,|$))/.test(attributes)) {
        return { variants: [], audioTracks: [], subtitleTracks: [] };
      }
      const bandwidth = Number(unquotedAttribute(attributes, 'BANDWIDTH') ?? unquotedAttribute(attributes, 'AVERAGE-BANDWIDTH'));
      const averageBandwidth = Number(unquotedAttribute(attributes, 'AVERAGE-BANDWIDTH')) || null;
      const resolution = /(?:^|,)RESOLUTION=(\d+)x(\d+)/.exec(attributes);
      const width = resolution ? Number(resolution[1]) : null;
      const height = resolution ? Number(resolution[2]) : null;
      const frameRate = Number(unquotedAttribute(attributes, 'FRAME-RATE')) || null;
      const codecs = attribute(attributes, 'CODECS') ?? null;
      const videoRange = unquotedAttribute(attributes, 'VIDEO-RANGE') ?? null;
      const hdr = Boolean(videoRange && /^(?:PQ|HLG)$/i.test(videoRange)) ||
        Boolean(codecs && /(?:hev1\.2|hvc1\.2|dvh1|dvhe|vp09\.02|av01\.0\.(?:0[89]|1\d)M\.10)/i.test(codecs));
      if (!bandwidth) return { variants: [], audioTracks: [], subtitleTracks: [] };
      pending = {
        width,
        height,
        bandwidth,
        bitrate: bandwidth,
        ...(averageBandwidth && { averageBandwidth }),
        ...(frameRate && { frameRate }),
        ...(codecs && { codecs }),
        ...(videoRange && { videoRange }),
        hdr,
        audioGroup: attribute(attributes, 'AUDIO') ?? null,
        subtitleGroup: attribute(attributes, 'SUBTITLES') ?? null,
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = line.slice(line.indexOf(':') + 1);
      const type = unquotedAttribute(attributes, 'TYPE');
      const group = attribute(attributes, 'GROUP-ID');
      const uri = attribute(attributes, 'URI');
      const name = attribute(attributes, 'NAME') ?? null;
      const language = attribute(attributes, 'LANGUAGE') ?? null;
      const preferred = /(?:^|,)DEFAULT=YES(?:,|$)/.test(attributes);
      const autoSelect = /(?:^|,)AUTOSELECT=YES(?:,|$)/.test(attributes);
      const channels = attribute(attributes, 'CHANNELS') ?? null;
      if (type === 'AUDIO') {
        if (!group) return { variants: [], audioTracks: [], subtitleTracks: [] };
        if (uri) {
          const url = httpUrl(uri, source);
          if (!url) return { variants: [], audioTracks: [], subtitleTracks: [] };
          audioTracks.push({ url, group, name, language, channels, preferred, autoSelect });
        }
      } else if (type === 'SUBTITLES') {
        if (group && uri) {
          const url = httpUrl(uri, source);
          if (url) subtitleTracks.push({ url, group, name, language, preferred, autoSelect });
        }
      } else if (type === 'CLOSED-CAPTIONS') {
        // Inline closed captions do not require separate playlist fetching.
      } else {
        return { variants: [], audioTracks: [], subtitleTracks: [] };
      }
    } else if (
      /^#EXT-X-(?:VERSION:\d+|INDEPENDENT-SEGMENTS|I-FRAME-STREAM-INF:|SESSION-DATA:|SESSION-KEY:|START:|DEFINE:|CONTENT-STEERING:)/.test(line)
    ) {
      // Allowed master-playlist metadata tags that do not alter primary VOD rendition staging.
    } else {
      return { variants: [], audioTracks: [], subtitleTracks: [] };
    }
  }
  if (pending || !variants.length) return { variants: [], audioTracks: [], subtitleTracks: [] };
  const resolvedVariants = variants.map(variant => {
    const aGroup = variant.audioGroup ? audioTracks.filter(track => track.group === variant.audioGroup) : [];
    const sound = aGroup.find(track => track.preferred) ?? aGroup.find(track => track.autoSelect) ?? aGroup[0] ?? null;
    const sGroup = variant.subtitleGroup ? subtitleTracks.filter(track => track.group === variant.subtitleGroup) : [];
    const sub = sGroup.find(track => track.preferred) ?? sGroup.find(track => track.autoSelect) ?? sGroup[0] ?? null;
    return {
      ...variant,
      video: variant.url,
      audio: sound?.url,
      audioTracks: aGroup,
      subtitle: sub?.url,
      subtitleTracks: sGroup,
      missingAudioGroup: Boolean(variant.audioGroup && !sound && audioTracks.some(t => t.group === variant.audioGroup)),
    };
  });
  return { variants: resolvedVariants, audioTracks, subtitleTracks };
}

export function selectRendition(text, source, quality) {
  return rankRenditions(text, source, quality)[0] ?? null;
}

export function rankRenditions(text, source, quality) {
  const { variants } = parseMasterVariants(text, source);
  if (!variants.length) return [];
  const sorted = [...variants].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
  const numericQuality = typeof quality === 'number' && Number.isFinite(quality) ? quality : null;
  const eligible = sorted.filter(variant => !numericQuality || (variant.height && variant.height <= numericQuality));
  const lowestHeight = sorted.at(-1)?.height;
  const chosen = eligible.length ? eligible : sorted.filter(variant => variant.height === lowestHeight);
  return chosen.map(variant =>
    variant.missingAudioGroup ? null : {
      video: variant.video,
      audio: variant.audio,
      subtitle: variant.subtitle,
      subtitleTracks: variant.subtitleTracks,
      audioTracks: variant.audioTracks,
      bandwidth: variant.bandwidth,
      height: variant.height,
      width: variant.width,
      codecs: variant.codecs,
      frameRate: variant.frameRate,
      hdr: variant.hdr,
    },
  );
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

export function detectLlHls(text) {
  return /^#EXT-X-(?:PART|PART-INF|PRELOAD-HINT|SERVER-CONTROL):/m.test(text);
}

export function parseManifest(text, source, prefix, {
  byteRanges = false, aes128 = false, sniffTransport = false, subtitle = false,
} = {}) {
  const lines = manifestLines(text);
  if (lines[0] !== '#EXTM3U' || lines.at(-1) !== '#EXT-X-ENDLIST') return null;
  const segments = [];
  const playlist = [];
  const keys = new Map();
  let currentKey = null;
  let mediaSequence = 0;
  let needsSegment = false;
  let initFilename;
  let mediaCount = 0;
  let pendingRange;
  let previousRange;
  for (const line of lines) {
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const seq = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
        if (Number.isSafeInteger(seq) && seq >= 0) mediaSequence = seq;
      }
      if (aes128 && line.startsWith('#EXT-X-KEY:')) {
        const key = segmentKey(line.slice('#EXT-X-KEY:'.length), source);
        if (!key) return null;
        if (key.method === 'AES-128') {
          let local = keys.get(key.url.href);
          if (!local) {
            local = {url:key.url, filename:`${prefix}-key-${keys.size}.key`};
            keys.set(key.url.href, local);
          }
          currentKey = { filename: local.filename, iv: key.iv ?? null };
          playlist.push(`#EXT-X-KEY:METHOD=AES-128,URI="${local.filename}"${key.iv ? ',IV=' + key.iv : ''}`);
        } else {
          currentKey = null;
          playlist.push(line);
        }
        continue;
      }
      const map = /^#EXT-X-MAP:URI="([^"]+)"(?:,BYTERANGE="([^"]+)")?$/.exec(line);
      if (map) {
        const url = httpUrl(map[1], source);
        const range = map[2] && byteRanges && byteRange(map[2]);
        if (!url || needsSegment || currentKey || (map[2] && !range)) return null;
        initFilename = `${prefix}-init-${segments.length}.mp4`;
        segments.push({
          url,
          filename: initFilename,
          isInit: true,
          expectedKind: 'fmp4-init',
          ...(range && { range }),
          ...(sniffTransport && { verifyContent: true }),
        });
        playlist.push(`#EXT-X-MAP:URI="${initFilename}"`);
        continue;
      }
      if (byteRanges && needsSegment && line.startsWith('#EXT-X-BYTERANGE:')) {
        if (pendingRange) return null;
        pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);
        if (!pendingRange) return null;
        continue;
      }
      if (/^#EXT-X-(?:BITRATE|PART-INF|SERVER-CONTROL|PRELOAD-HINT|RENDITION-REPORT|SKIP|PART):/.test(line)) {
        // LL-HLS auxiliary tags in a finalized VOD (#EXT-X-ENDLIST) can be ignored safely while staging full segments.
        continue;
      }
      if (!supportedTag.test(line) || needsSegment) return null;
      needsSegment = line.startsWith('#EXTINF:');
      playlist.push(line);
      continue;
    }
    const url = httpUrl(line, source);
    if (!needsSegment || !url) return null;
    const isEncrypted = Boolean(currentKey);
    const nonStandardExt = subtitle ? !/\.vtt$/i.test(url.pathname)
      : initFilename ? !/\.(?:m4s|mp4|m4v|m4a)$/i.test(url.pathname) : !/\.ts$/i.test(url.pathname);
    if (nonStandardExt && !sniffTransport) return null;
    const range = pendingRange && byteRange(pendingRange, previousRange?.url === url.href ? previousRange.end + 1 : undefined);
    // Encrypted byte-range or encrypted fMP4 init remains outside discrete local TS decryption.
    if (pendingRange && !range || isEncrypted && (range || initFilename)) return null;
    const extension = subtitle ? 'vtt' : initFilename ? 'm4s' : 'ts';
    const filename = `${prefix}-${segments.length}.${extension}`;
    const sequenceNumber = mediaSequence + mediaCount;
    segments.push({
      url,
      filename,
      sequenceNumber,
      expectedKind: subtitle ? 'webvtt' : initFilename ? 'fmp4' : 'mpegts',
      ...(range && { range }),
      ...(nonStandardExt && { verifyTransport: true }),
      ...(sniffTransport && { verifyContent: true }),
      ...(currentKey && { encryption: { keyFilename: currentKey.filename, iv: currentKey.iv, sequenceNumber } }),
    });
    previousRange = range ? {url:url.href, end:range.end} : undefined;
    pendingRange = undefined;
    playlist.push(filename);
    mediaCount++;
    needsSegment = false;
  }
  if (!mediaCount || needsSegment) return null;
  return {
    segments,
    playlist: playlist.join('\n') + '\n',
    mediaSequence,
    ...(aes128 && {keys:[...keys.values()]}),
  };
}
