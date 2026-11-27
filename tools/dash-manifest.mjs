import { ApiError } from './media-source.mjs';

const maxParts = 10_000;
const maxOriginsPerResource = 4;
const localName = value => value.split(':').at(-1);
const children = (node,name) => node.children.filter(child => child.name === name);
const only = (node,name) => {
  const matches = children(node,name);
  if (matches.length > 1) invalid();
  return matches[0];
};

function invalid() {
  throw new ApiError('DASH_INVALID_MANIFEST','The DASH playlist contains invalid or unsupported media addressing',422);
}

function unsupported(legacyCompatible = false) {
  throw new ApiError('DASH_UNSUPPORTED','The DASH playlist uses a format or timeline outside the static download engine',422,
    legacyCompatible && {legacyCompatible:true});
}

function entities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});|&/g, ref => {
    if (ref === '&') invalid();
    const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[ref.slice(1,-1)];
    if (named) return named;
    const hex = ref.startsWith('&#x');
    const number = Number.parseInt(ref.slice(hex ? 3 : 2,-1),hex ? 16 : 10);
    if (number < 32 && ![9,10,13].includes(number) || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) invalid();
    return String.fromCodePoint(number);
  });
}

function parseXml(text) {
  const wrapper = {children:[],text:''};
  const stack = [wrapper];
  const tokens = /<!--[\s\S]*?-->|<\?xml\s+[^?]*\?>|<\/[a-zA-Z_][\w.:-]*\s*>|<[a-zA-Z_][\w.:-]*(?:[^<>'"]|"[^"<]*"|'[^'<]*')*>|[^<]+/gy;
  let cursor = 0;
  let elements = 0;
  while (cursor < text.length) {
    const match = tokens.exec(text);
    if (!match) invalid();
    cursor = tokens.lastIndex;
    const token = match[0];
    const current = stack.at(-1);
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('<?')) {
      if (match.index !== 0) invalid();
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length === 1 || token.slice(2,-1).trim() !== current.tag) invalid();
      stack.pop();
      continue;
    }
    if (!token.startsWith('<')) {
      if (current.name === 'BaseURL' || current === wrapper) current.text += entities(token);
      continue;
    }
    if (++elements > 25_000 || stack.length >= 32) invalid();
    const tag = /^<([\w.:-]+)/.exec(token)[1];
    const closed = token.endsWith('/>');
    const attributes = token.slice(tag.length + 1,closed ? -2 : -1);
    const attrs = Object.create(null);
    const next = /\s+([a-zA-Z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let position = 0;
    let seenAttributes = 0;
    while (position < attributes.length) {
      const item = next.exec(attributes);
      if (!item && !attributes.slice(position).trim()) break;
      if (!item || ++seenAttributes > 128 || Object.hasOwn(attrs,item[1])) invalid();
      position = next.lastIndex;
      attrs[item[1]] = entities(item[2] ?? item[3]);
    }
    const name = localName(tag);
    if (['ContentProtection','pssh','pro'].includes(name) || Object.keys(attrs).some(key => localName(key) === 'default_KID')) {
      throw new ApiError('DRM','The DASH playlist declares protected media',422);
    }
    if (Object.keys(attrs).some(key => key.includes(':') && localName(key) === 'href')) unsupported();
    const element = {name,tag,attrs,children:[],text:''};
    current.children.push(element);
    if (!closed) stack.push(element);
  }
  if (stack.length !== 1 || wrapper.text.trim() || wrapper.children.length !== 1 || wrapper.children[0].name !== 'MPD') invalid();
  return wrapper.children[0];
}

function integer(value, defaultValue, min = 0) {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!/^-?\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < min) invalid();
  return Number(value);
}

function duration(value) {
  if (value === undefined) return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) invalid();
  const seconds = (Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0));
  if (!Number.isFinite(seconds) || seconds > 86400) unsupported();
  return seconds;
}

function range(value) {
  if (value === undefined) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) invalid();
  const start = integer(match[1]);
  const end = integer(match[2],undefined,start);
  if (!Number.isSafeInteger(end + 1)) invalid();
  return {start,end};
}

function urls(value,bases) {
  if (value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) invalid();
  const results = new Map();
  for (const base of bases) {
    const url = URL.parse(value,base);
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) invalid();
    results.set(url.href,url);
    if (results.size > maxOriginsPerResource) unsupported();
  }
  return [...results.values()];
}

function descend(state,node) {
  const declared = children(node,'BaseURL');
  const bases = declared.length ? [...new Map(declared.flatMap(url =>
    urls(url.text.trim(),state.bases)).map(url => [url.href,url])).values()] : state.bases;
  if (bases.length > maxOriginsPerResource) unsupported();
  const address = node.children.filter(child => ['SegmentTemplate','SegmentList','SegmentBase'].includes(child.name));
  if (address.length > 1) invalid();
  const choice = address[0];
  const parent = choice?.name === state.address?.name ? state.address : null;
  return {bases,attrs:{...state.attrs,...node.attrs},budget:state.budget,explicitBase:Boolean(declared.length || state.explicitBase),
    address:choice ? {name:choice.name,attrs:{...parent?.attrs,...choice.attrs},
      children:choice.children.concat((parent?.children ?? []).filter(child => !choice.children.some(own => own.name === child.name)))} : state.address};
}

function template(value, {id,bandwidth}, number, time) {
  if (!value) invalid();
  return value.replace(/\$\$|\$([^$]+)\$|\$/g,(token,name) => {
    if (token === '$$') return '$';
    if (name === 'RepresentationID' && id && /^[a-zA-Z0-9._~-]{1,200}$/.test(id)) return id;
    const field = /^(Number|Bandwidth|Time)(?:%0([1-9]|1\d|20)d)?$/.exec(name ?? '');
    const result = field && {Number:number,Bandwidth:bandwidth,Time:time}[field[1]];
    if (!Number.isSafeInteger(result)) invalid();
    return String(result).padStart(Number(field[2] ?? 0),'0');
  });
}

function units(address,periodDuration) {
  const scale = integer(address.attrs.timescale,1,1);
  const offset = integer(address.attrs.presentationTimeOffset,0);
  const timeline = only(address,'SegmentTimeline');
  const end = periodDuration === undefined ? undefined : offset + Math.round(periodDuration * scale);
  if (end !== undefined && !Number.isSafeInteger(end)) invalid();
  if (!timeline) {
    const step = integer(address.attrs.duration,undefined,1);
    const delta = integer(address.attrs.eptDelta,0,Number.MIN_SAFE_INTEGER);
    const count = Math.ceil((end - offset - delta) / step);
    if (!Number.isSafeInteger(count) || count < 1 || count > maxParts) unsupported();
    return Array.from({length:count},(_,index) => offset + index * step);
  }
  const entries = children(timeline,'S');
  const result = [];
  let time = 0;
  for (const [index,entry] of entries.entries()) {
    const start = integer(entry.attrs.t,time);
    const step = integer(entry.attrs.d,undefined,1);
    const repetitions = integer(entry.attrs.r,0,-1);
    const boundary = entries[index+1]?.attrs.t === undefined ? end : integer(entries[index+1].attrs.t);
    const count = repetitions < 0 ? Math.ceil((boundary-start)/step) : repetitions + 1;
    if (index && start !== time) unsupported();
    time = start + count * step;
    if (!Number.isSafeInteger(count) || count < 1 || count > maxParts - result.length || !Number.isSafeInteger(time) ||
        start < (result.at(-1) ?? -1)) invalid();
    for (let part = 0; part < count; part++) result.push(start + part * step);
  }
  if (!result.length) invalid();
  return result;
}

function withAddress(state,representation,periodDuration) {
  const {address,bases,budget,explicitBase} = state;
  const resource = (value,kind,span) => {
    const targets = value === undefined ? bases : urls(value,bases);
    budget.urls += targets.reduce((total,url) => total + url.href.length,0);
    if (++budget.parts > maxParts || budget.urls > 8 * 1024 * 1024) unsupported();
    return {urls:targets,kind,range:span};
  };
  if (!address) {
    if (!explicitBase || bases.some(base => base.pathname.endsWith('/'))) unsupported();
    return {parts:[resource(undefined,'segment')]};
  }
  if (address.name === 'SegmentTemplate') {
    const {initialization,media} = address.attrs;
    const first = integer(address.attrs.startNumber,1);
    const times = units(address,periodDuration);
    if (!Number.isSafeInteger(first + times.length - 1)) invalid();
    const init = resource(template(initialization,representation),'init');
    const parts = times.map((time,index) => resource(template(media,representation,first+index,time),'segment'));
    return {init,parts};
  }
  const initial = only(address,'Initialization');
  const init = initial && resource(initial.attrs.sourceURL,'init',range(initial.attrs.range));
  if (address.name === 'SegmentList') {
    const segments = children(address,'SegmentURL');
    if (!segments.length || segments.length > maxParts) invalid();
    return {init,parts:segments.map(segment => resource(segment.attrs.media,'segment',range(segment.attrs.mediaRange)))};
  }
  const index = range(address.attrs.indexRange);
  if (!index && explicitBase && !init) return {parts:[resource(undefined,'segment')]};
  if (!index || !init || !explicitBase) unsupported();
  return {init,index:resource(undefined,'index',index)};
}

function tracksForPeriod(state,period,seconds,quality,subtitles) {
  const groups = children(period,'AdaptationSet').flatMap(adaptation => {
    const adaptationState = descend(state,adaptation);
    const group = children(adaptation,'Representation').map(representation => {
      const context = descend(adaptationState,representation);
      const {mimeType,contentType,codecs,lang,id,height,bandwidth} = context.attrs;
      const type = contentType ?? mimeType?.split('/')[0] ?? (/^avc|^hev|^hvc|^av01|^vp/.test(codecs ?? '') ? 'video'
        : /^(mp4a|ac-3|ec-3|opus)/i.test(codecs ?? '') ? 'audio' : undefined);
      return {type,mimeType,lang,id,height:integer(height,0),bandwidth:integer(bandwidth,0),context};
    }).filter(track => (track.type === 'audio' || track.type === 'video') &&
      (!track.mimeType || ['video/mp4','audio/mp4'].includes(track.mimeType)) ||
      subtitles && (track.mimeType === 'text/vtt' || track.mimeType === 'application/x-subrip'));
    return group.length ? [group] : [];
  });
  const video = groups.flat().filter(track => track.type === 'video').sort((left,right) =>
    right.height - left.height || right.bandwidth - left.bandwidth);
  const selected = video.find(track => !quality || track.height <= quality) ?? video.at(-1);
  const others = groups.map(group => group.filter(track => track.type !== 'video')
    .sort((left,right) => right.bandwidth - left.bandwidth)[0]).filter(Boolean);
  const tracks = [selected,...others].filter(Boolean);
  if (!tracks.some(track => ['audio','video'].includes(track.type))) unsupported(true);
  if (tracks.length > 12) unsupported();
  return tracks.map(track => {
    const addressing = withAddress(track.context,track,seconds);
    const text = !['audio','video'].includes(track.type);
    if (text && (addressing.init || addressing.index || addressing.parts?.length !== 1)) unsupported();
    const timing = track.context.address?.attrs;
    const offset = text || !timing ? 0 : integer(timing.presentationTimeOffset,0) / integer(timing.timescale,1,1);
    if (offset > 86400) unsupported();
    return {type:text ? 'subtitle' : track.type,
      extension:text ? track.mimeType === 'text/vtt' ? 'vtt' : 'srt' : 'mp4',offset,
      language:/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/.test(track.lang ?? '') ? track.lang : undefined,
      ...addressing};
  });
}

export function dashPlan(xml,source,{quality,subtitles} = {}) {
  const mpd = parseXml(xml);
  if (mpd.attrs.type && mpd.attrs.type !== 'static') unsupported(mpd.attrs.type === 'dynamic');
  const mediaDuration = duration(mpd.attrs.mediaPresentationDuration);
  const state = descend({bases:[source],attrs:{},budget:{parts:0,urls:0}},mpd);
  const periods = children(mpd,'Period');
  if (!periods.length || periods.length > 24) unsupported();
  let previousEnd = 0;
  return periods.map((period,index) => {
    const start = duration(period.attrs.start) ?? previousEnd;
    const end = duration(periods[index+1]?.attrs.start) ?? (index === periods.length-1 ? mediaDuration : undefined);
    const seconds = duration(period.attrs.duration) ?? (end === undefined ? undefined : end-start);
    if (previousEnd === undefined || start === undefined || Math.abs(start-previousEnd) > 0.001 || seconds !== undefined && seconds <= 0 ||
        end !== undefined && Math.abs(start+seconds-end) > 0.001) unsupported();
    previousEnd = seconds === undefined ? undefined : start+seconds;
    return {tracks:tracksForPeriod(descend(state,period),period,seconds,quality,subtitles),duration:seconds};
  });
}
