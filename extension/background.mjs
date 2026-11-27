import { browserApi, isFirefox, nativeDownloads } from './browser.mjs';

import { classify, isMediaFragment, mediaResponseSize } from './media.mjs';
import { documentBlockers } from './detection.mjs';
import { isPublicPlayerJson } from './live-detection.mjs';
import { startTabGrantCleanup } from './mcp-center.mjs';
import { registerDownloads } from './downloads.mjs';
import { playbackHeaders } from './request-context.mjs';

if (nativeDownloads) {
  registerDownloads();
  startTabGrantCleanup();
}

const storage = browserApi.storage.session;
const writes = new Map();
const tabKey = id => 'media:' + id;

function update(tab, fn) {
  const key = tabKey(tab);
  const task = (writes.get(tab) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const rows = (await storage.get(key))[key] ?? [];
    const next = fn(rows);
    if (next === rows) return;
    if (next.length) await storage.set({[key]:next});
    else await storage.remove(key);
  });
  writes.set(tab, task);
  const cleanup = () => { if (writes.get(tab) === task) writes.delete(tab); };
  void task.then(cleanup, cleanup);
}

const all = {urls:['http://*/*','https://*/*']};
const requestContexts = new Map();
if (nativeDownloads) {
  const mediaRequests = {...all,types:['media','xmlhttprequest','other']};
  browserApi.webRequest.onSendHeaders.addListener(details => {
    requestContexts.delete(details.requestId);
    const initiator = URL.parse(details.documentUrl ?? details.initiator ?? details.originUrl ?? '');
    if (details.tabId < 0 || details.method !== 'GET' || !['http:','https:'].includes(initiator?.protocol)) return;
    const headers = playbackHeaders(Object.fromEntries((details.requestHeaders ?? []).map(({name,value}) => [name,value])),initiator.origin);
    if (requestContexts.size >= 256) requestContexts.delete(requestContexts.keys().next().value);
    requestContexts.set(details.requestId,{url:details.url,headers,playerOrigin:initiator.origin});
  },mediaRequests,['requestHeaders',...(!isFirefox ? ['extraHeaders'] : [])]);
  const clearContext = ({requestId}) => { requestContexts.delete(requestId); };
  browserApi.webRequest.onCompleted.addListener(clearContext,mediaRequests);
  browserApi.webRequest.onErrorOccurred.addListener(clearContext,mediaRequests);
}
browserApi.webRequest.onBeforeRequest.addListener(
  ({tabId,frameId,type}) => {
    if (tabId >= 0) update(tabId, rows => type === 'main_frame' ? [] : rows.filter(row => row.frameId !== frameId));
  },
  {...all, types:['main_frame','sub_frame']},
);
browserApi.tabs.onRemoved.addListener(tabId => update(tabId, () => []));
browserApi.webRequest.onHeadersReceived.addListener(details => {
  const context = requestContexts.get(details.requestId);
  requestContexts.delete(details.requestId);
  if (details.tabId < 0) return;
  const header = name => details.responseHeaders?.find(entry => entry.name.toLowerCase() === name)?.value;
  if (details.type === 'main_frame' || details.type === 'sub_frame') {
    const [blocker] = documentBlockers(details.statusCode, header('cf-mitigated') === 'challenge');
    if (blocker && details.frameId === 0) update(details.tabId, rows => [
      ...rows.filter(row => !row.blocker), {frameId:0,blocker},
    ]);
    return;
  }
  if (details.statusCode < 200 || details.statusCode >= 300) return;
  const mime = header('content-type') ?? '';
  if (details.type === 'xmlhttprequest' && details.frameId === 0 && isPublicPlayerJson(details.url,mime,details.method)) {
    update(details.tabId,rows => rows.some(row => row.playerJson && row.url === details.url)
      ? rows : [...rows,{playerJson:true,url:details.url,frameId:0,documentId:details.documentId,
        documentUrl:details.documentUrl,timeStamp:details.timeStamp}].slice(-120));
    return;
  }
  const kind = classify(details.url, mime);
  if (!kind && isMediaFragment(new URL(details.url).pathname.toLowerCase(),mime.split(';')[0].trim().toLowerCase())) {
    const observed = context?.url === details.url && details.url.length <= 2048 && context.playerOrigin;
    const fragment = {fragment:true,frameId:details.frameId,documentId:details.documentId,
      documentUrl:details.documentUrl,timeStamp:details.timeStamp,
      ...(observed && {url:details.url,playerOrigin:context.playerOrigin,requestHeaders:context.headers})};
    update(details.tabId,rows => {
      if (rows.some(row => row.fragment && row.frameId === fragment.frameId &&
          row.documentId === fragment.documentId && row.url === fragment.url)) return rows;
      let remaining = 47;
      const recent = [...rows].reverse().filter(row => !row.fragment || remaining-- > 0);
      return [...recent.reverse(),fragment].slice(-120);
    });
    return;
  }
  if ((!kind && !classify(details.url)) || ['image','stylesheet','font','script','ping'].includes(details.type)) return;
  const disposition = header('content-disposition') ?? '';
  const filename = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1] ||
    /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean);
  const size = mediaResponseSize(kind, details.statusCode, header);
  const requestContext = context?.url === details.url ? context : null;
  const same = row => row.frameId === details.frameId && row.url === details.url && row.documentId === details.documentId;
  update(details.tabId, rows => {
    const prior = rows.find(same);
    const next = {url:details.url, mime, filename, size:size ?? prior?.size, type:details.type, frameId:details.frameId, documentId:details.documentId, documentUrl:details.documentUrl,
      timeStamp:details.timeStamp, ...(requestContext && {requestHeaders:requestContext.headers,playerOrigin:requestContext.playerOrigin})};
    if (prior && prior.mime === mime && prior.size === next.size && prior.filename === filename &&
        prior.playerOrigin === next.playerOrigin && JSON.stringify(prior.requestHeaders) === JSON.stringify(next.requestHeaders)) return rows;
    return [...rows.filter(row => !same(row)), next].slice(-120);
  });
}, all, ['responseHeaders']);
