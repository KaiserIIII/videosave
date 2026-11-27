#!/usr/bin/env node
import {open} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {platformVideo} from '../extension/media.mjs';
import * as downloads from './media-downloads.mjs';
import {mediaUrl,parseCookies} from './media-source.mjs';
import {isChallengeCookie} from './approved-cookies.mjs';
import {configureMediaProxy} from './media-proxy.mjs';

const options = {
  help:{type:'boolean'},
  page:{type:'boolean'},
  'cookie-file':{type:'string'},
  ua:{type:'string'},
  connections:{type:'string'},
  quality:{type:'string'},
};
const emit = result => process.stdout.write(JSON.stringify(result)+'\n');

async function readCookieFile(filename,urls) {
  if (new Set(urls.map(url => url.origin)).size !== 1) {
    throw new downloads.ApiError('INVALID_COOKIE','Use one origin per invocation when supplying a cookie file.');
  }
  const file = await open(filename,'r').catch(() => null);
  if (!file) throw new downloads.ApiError('INVALID_COOKIE','Could not open the cookie file.');
  try {
    const buffer = Buffer.alloc(16_385);
    const {bytesRead} = await file.read(buffer);
    if (bytesRead === buffer.length) throw new downloads.ApiError('INVALID_COOKIE','The cookie file exceeds 16 KiB.');
    const cookies = parseCookies(buffer.subarray(0,bytesRead).toString('utf8').trim());
    if (cookies.some(({name}) => isChallengeCookie(name))) {
      throw new downloads.ApiError('INVALID_COOKIE','Challenge cookies are not accepted.');
    }
    return cookies.map(({name,value}) => name+'='+value).join('; ');
  } finally {
    await file.close();
  }
}

try {
  const {values,positionals} = parseArgs({options,allowPositionals:true});
  if (values.help) {
    process.stdout.write('Usage: node tools/media-cli.mjs [--page] [--cookie-file PATH] [--ua USER_AGENT] [--quality max|HEIGHT] [--connections 4|8|12] URL...\n');
  } else {
    configureMediaProxy();
    if (!positionals.length) throw new downloads.ApiError('INVALID_ITEMS','Provide at least one HTTP(S) media or page URL.');
    const urls = positionals.map(mediaUrl);
    const cookie = values['cookie-file'] ? await readCookieFile(values['cookie-file'],urls) : undefined;
    const quality = values.quality && (values.quality === 'max' ? 'max' : Number(values.quality));
    const {id} = downloads.queueBatch({
      items:urls.map(url => ({kind:values.page || platformVideo(url) ? 'page' : 'stream',url:url.href,quality})),
      cookie,headers:values.ua ? {'User-Agent':values.ua} : undefined,
      connections:values.connections === undefined ? undefined : Number(values.connections),
    });
    const observer = new AbortController();
    const interrupt = () => observer.abort(new downloads.ApiError(
      'DOWNLOAD_INTERRUPTED','Interrupted. Submit the same request to resume.',409));
    process.once('SIGINT',interrupt);
    let result;
    do {
      result = await downloads.waitForBatch({id,timeoutMs:1000},observer.signal);
      emit({id,status:result.status,...(result.resumable && {resumable:true}),items:result.items.map(item => ({
        index:item.idx,status:item.status,percent:item.percent,speed:item.speed,segments:item.segments,file:item.file,errorCode:item.errorCode,
      }))});
    } while (result.timedOut);
    process.removeListener('SIGINT',interrupt);
    process.exitCode = result.status === 'done' ? 0 : 1;
  }
} catch (error) {
  emit({status:'failed',...downloads.errorDetails(error)});
  process.exitCode = 1;
} finally {
  downloads.shutdown();
}
