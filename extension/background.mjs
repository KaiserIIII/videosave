import { browserApi, nativeDownloads } from './browser.mjs';

import { classify, isMediaFragment, mediaResponseSize } from './media.mjs';
import { documentBlockers } from './detection.mjs';
import { registerDownloads } from './downloads.mjs';

if (nativeDownloads) registerDownloads();

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
browserApi.webRequest.onBeforeRequest.addListener(
  ({tabId,frameId,type}) => {
    if (tabId >= 0) update(tabId, rows => type === 'main_frame' ? [] : rows.filter(row => row.frameId !== frameId));
  },
  {...all, types:['main_frame','sub_frame']},
);
browserApi.tabs.onRemoved.addListener(tabId => update(tabId, () => []));
browserApi.webRequest.onHeadersReceived.addListener(details => {
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
  const kind = classify(details.url, mime);
  if (!kind && isMediaFragment(new URL(details.url).pathname.toLowerCase(),mime.split(';')[0].trim().toLowerCase())) {
    update(details.tabId, rows => rows.some(row => row.fragment && row.frameId === details.frameId)
      ? rows : [...rows,{fragment:true,frameId:details.frameId,documentId:details.documentId,
        documentUrl:details.documentUrl,timeStamp:details.timeStamp}].slice(-120));
    return;
  }
  if ((!kind && !classify(details.url)) || ['image','stylesheet','font','script','ping'].includes(details.type)) return;
  const disposition = header('content-disposition') ?? '';
  const filename = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1] ||
    /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean);
  const size = mediaResponseSize(kind, details.statusCode, header);
  const same = row => row.frameId === details.frameId && row.url === details.url && row.documentId === details.documentId;
  update(details.tabId, rows => {
    const prior = rows.find(same);
    const next = {url:details.url, mime, filename, size:size ?? prior?.size, type:details.type, frameId:details.frameId, documentId:details.documentId, documentUrl:details.documentUrl,
      timeStamp:details.timeStamp};
    if (prior && prior.mime === mime && prior.size === next.size && prior.filename === filename) return rows;
    return [...rows.filter(row => !same(row)), next].slice(-120);
  });
}, all, ['responseHeaders']);
