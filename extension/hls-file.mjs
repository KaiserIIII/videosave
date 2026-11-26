import { browserApi } from './browser.mjs';
import { hlsFileUrl } from './hls-download.mjs';

browserApi.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.scope !== 'hls-file-url' || sender.id !== browserApi.runtime.id || sender.tab ||
      !['create','revoke'].includes(message.action) || !/^[0-9a-f-]{36}$/.test(message.key)) return;
  if (message.action === 'create' && (!Number.isSafeInteger(message.segmentCount) || message.segmentCount < 1)) return;
  hlsFileUrl(message.action, message.key, message.url, message.extension, message.segmentCount)
    .then(url => reply({url}), error => reply({error:error.message}));
  return true;
});
