import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { ApiError } from './media-source.mjs';
import { hasManagedCdnProxy } from './media-proxy.mjs';

const nonPublic = new BlockList();
for (const [address,bits] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',3],
]) nonPublic.addSubnet(address,bits,'ipv4');
for (const [address,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) {
  nonPublic.addSubnet(address,bits,'ipv6');
}
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::',3,'ipv6');
const redirects = new Set([301,302,303,307,308]);
const denied = new Set([401,402,403,407,429,451]);
const scopeError = () => new ApiError('MCP_MEDIA_SCOPE','The media resource is outside the approved playback scope',403);
const redirectError = () => new ApiError('MCP_MEDIA_REDIRECT','The media redirect was not observed in the approved player',403);

export function publicMediaAddress(address) {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address,'ipv4');
  return family === 6 && globalIPv6.check(address,'ipv6') && !nonPublic.check(address,'ipv6');
}

export function publicMediaLookup(resolve = lookup) {
  return (hostname,options,callback) => {
    resolve(hostname,{all:true,family:options.family || 0,hints:options.hints || 0}).then(records => {
      if (!records.length || records.some(({address}) => !publicMediaAddress(address))) return callback(scopeError());
      const [{address,family}] = records;
      if (options.all) callback(null,records);
      else callback(null,address,family);
    },callback);
  };
}

const cdnAgent = new https.Agent({keepAlive:true,maxSockets:8,maxTotalSockets:48,maxFreeSockets:8,lookup:publicMediaLookup()});

export function scopeManagedMedia(entry,pageOrigin,allowRelatedMedia,observed = []) {
  const observations = new Set(observed);
  function assertUrl(url,{redirect = false} = {}) {
    const exact = url.href === entry.href || observations.has(url.href);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash) throw scopeError();
    if (redirect && (!allowRelatedMedia || !exact)) throw redirectError();
    if (url.origin !== entry.origin && (!allowRelatedMedia || !exact)) throw scopeError();
    if (url.origin === pageOrigin && entry.origin === pageOrigin) return;
    const host = url.hostname;
    const ip = host.replace(/^\[|\]$/g,'');
    if (!allowRelatedMedia || url.protocol !== 'https:' || url.port ||
        !(isIP(ip) ? publicMediaAddress(ip) : host.includes('.') && !/\.(?:localhost|local|internal|home\.arpa)\.?$/i.test(host))) {
      throw scopeError();
    }
  }
  return {assertUrl};
}

export function managedMediaTransport(entry,{pageOrigin,allowRelatedMedia,observed,context}) {
  const {assertUrl} = scopeManagedMedia(entry,pageOrigin,allowRelatedMedia,observed);
  async function request(target,headers,signal) {
    let url = target;
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      const {headersFor,cookiesFor} = context();
      assertUrl(url,{redirect:hop > 0});
      const cdn = url.origin !== pageOrigin || entry.origin !== pageOrigin;
      if (cdn && hasManagedCdnProxy()) {
        throw new ApiError('MCP_CDN_PROXY_UNSUPPORTED','This proxy does not support the companion’s CDN address validation',422);
      }
      const client = url.protocol === 'https:' ? https : http;
      const cookies = url.href === entry.href && url.origin === pageOrigin ? cookiesFor(url) : [];
      // Only headers describing the range can cross from the transfer engine into the request.
      const range = {};
      for (const name of ['range','if-range']) if (headers[name]) range[name] = headers[name];
      const result = await new Promise((resolve,reject) => {
        const options = {signal,headers:{...headersFor(url),...range,'accept-encoding':'identity',
          ...(cookies.length && {cookie:cookies.map(({name,value}) => name+'='+value).join('; ')})}};
        if (cdn) options.agent = cdnAgent;
        const req = client.get(url,options,body => {
          body.on('error',() => {});
          resolve({url,status:body.statusCode,headers:new Headers(body.headers),body});
        });
        req.once('error',reject);
      });
      if (denied.has(result.status) || result.headers.get('cf-mitigated') === 'challenge') {
        result.body.destroy();
        throw new ApiError('MCP_MEDIA_ACCESS_RESTRICTED','The media server denied access. Confirm playback in the browser.',403);
      }
      if (result.status === 410) {
        result.body.destroy();
        throw new ApiError('STREAM_EXPIRED','The approved media URL expired. Play the media again and request a fresh approval.',410);
      }
      if (!redirects.has(result.status)) return result;
      result.body.destroy();
      const location = result.headers.get('location');
      const next = location && URL.parse(location,url);
      if (!next || hop === 3) throw redirectError();
      assertUrl(next,{redirect:true});
      url = next;
    }
  }
  async function fetchResource(url,{signal,range} = {}) {
    const headers = range ? {range:`bytes=${range.start}-${range.end}`,...(range.etag && {'if-range':range.etag})} : {};
    const result = await request(url,headers,signal);
    const hasBody = ![204,205,304].includes(result.status);
    if (!hasBody) result.body.destroy();
    return {url:result.url,response:new Response(hasBody ? Readable.toWeb(result.body) : null,
      {status:result.status,headers:result.headers})};
  }
  return {assertUrl,request,fetchResource};
}
