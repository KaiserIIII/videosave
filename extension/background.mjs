
import { classify } from './media.mjs';
import { registerDownloads } from './downloads.mjs';

registerDownloads();

const storage = chrome.storage.session;
const writes = new Map();
const tabKey = id => 'media:' + id;

function update(tab, fn) {
  const key = tabKey(tab);
  const task = (writes.get(tab) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const rows = (await storage.get(key))[key] ?? [];
    const next = fn(rows);
    if (next.length) await storage.set({[key]:next});
    else await storage.remove(key);
  });
  writes.set(tab, task);
  const cleanup = () => { if (writes.get(tab) === task) writes.delete(tab); };
  void task.then(cleanup, cleanup);
}

const all = {urls:['http://*/*','https://*/*']};
chrome.webRequest.onBeforeRequest.addListener(
  ({tabId}) => { if (tabId >= 0) update(tabId, () => []); },
  {...all, types:['main_frame']},
);
chrome.tabs.onRemoved.addListener(tabId => update(tabId, () => []));
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
  const mime = details.responseHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value ?? '';
  if ((!classify(details.url, mime) && !classify(details.url)) || ['image','stylesheet','font','script','ping'].includes(details.type)) return;
  const disposition = details.responseHeaders.find(header => header.name.toLowerCase() === 'content-disposition')?.value ?? '';
  const filename = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1] ||
    /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean);
  update(details.tabId, rows => [...rows.filter(row => row.url !== details.url),
    {url:details.url, mime, filename, type:details.type, frameId:details.frameId}].slice(-120));
}, all, ['responseHeaders']);
