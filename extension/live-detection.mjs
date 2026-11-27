import { manifestEvidence } from './manifest-evidence.mjs';

export function observeMediaChanges(enabled) {
  // Executed in the extension's isolated world for this document.
  globalThis.videoSaveMediaWatch?.stop();
  if (!enabled || !document.documentElement) return;
  let pending;
  let expiry;
  let updates = 0;
  let href = location.href;
  const events = ['play','loadedmetadata','durationchange','emptied','encrypted','videosave-route'];
  const selector = 'video,audio,source,iframe,frame,script[type="application/json"],script[type="application/ld+json"]';
  const stop = () => {
    observer.disconnect();
    events.forEach(event => document.removeEventListener(event, changed, true));
    window.removeEventListener('popstate', changed);
    window.removeEventListener('hashchange', changed);
    window.removeEventListener('pagehide', stop);
    clearTimeout(pending);
    clearTimeout(expiry);
    delete globalThis.videoSaveMediaWatch;
  };
  function changed() {
    if (href !== location.href) {
      href = location.href;
      globalThis.videoSaveRouteStart = performance.now();
    }
    if (pending) return;
    pending = setTimeout(async () => {
      pending = undefined;
      const runtime = (globalThis.browser ?? globalThis.chrome)?.runtime;
      try { await runtime?.sendMessage({action:'videosave-media-changed'}); } catch { stop(); }
      if (++updates >= 48) stop();
    }, 300);
  }
  const observer = new MutationObserver(records => {
    for (const record of records.slice(0,64)) {
      if (record.target.matches?.(selector) || [...record.addedNodes,...record.removedNodes].slice(0,16)
        .some(node => node.matches?.(selector) || node.querySelector?.(selector) || node.shadowRoot)) {
        changed();
        break;
      }
    }
  });
  const options = {subtree:true,childList:true,attributes:true,attributeFilter:['src','data-src','type']};
  observer.observe(document.documentElement,options);
  const walker = document.createTreeWalker(document,NodeFilter.SHOW_ELEMENT);
  for (let i = 0, node; i < 1000 && (node = walker.nextNode()); i++) {
    if (node.shadowRoot) observer.observe(node.shadowRoot,options);
  }
  events.forEach(event => document.addEventListener(event, changed, true));
  window.addEventListener('popstate', changed);
  window.addEventListener('hashchange', changed);
  window.addEventListener('pagehide', stop, {once:true});
  expiry = setTimeout(stop,60_000);
  globalThis.videoSaveMediaWatch = {stop};
}

export async function inspectPublicManifest(stream) {
  try {
    const response = await fetch(stream.url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(1500)});
    const max = 128 * 1024;
    if (!response.ok || Number(response.headers.get('content-length')) > max || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) return manifestEvidence(text + decoder.decode(),stream.url,stream.kind);
        size += value.byteLength;
        if (size > max) return null;
        text += decoder.decode(value,{stream:true});
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch { return null; }
}
