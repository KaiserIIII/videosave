const uploadOrigin = 'https://upload.wikimedia.org';
const originalPath = /^\/wikipedia\/commons\/([0-9a-f])\/\1[0-9a-f]\/([^/]+)$/;
const formats = {
  webm: { types: ['video/webm', 'audio/webm'], signature: [0x1a, 0x45, 0xdf, 0xa3] },
  ogg: { types: ['application/ogg', 'audio/ogg', 'video/ogg'], signature: [0x4f, 0x67, 0x67, 0x53] },
  oga: { types: ['application/ogg', 'audio/ogg'], signature: [0x4f, 0x67, 0x67, 0x53] },
  ogv: { types: ['application/ogg', 'video/ogg'], signature: [0x4f, 0x67, 0x67, 0x53] },
};

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function parseCommonsMedia(input) {
  let url;
  let filename;
  try {
    url = new URL(input);
    const pathMatch = originalPath.exec(url.pathname);
    if (url.origin !== uploadOrigin || url.username || url.password || !pathMatch) {
      throw new Error('invalid-url');
    }
    filename = decodeURIComponent(pathMatch[2]);
  } catch {
    throw new Error('invalid-url');
  }

  const extension = /\.([a-z]+)$/i.exec(filename)?.[1].toLowerCase();
  if (!Object.hasOwn(formats, extension) || /[/\\\u0000-\u001f\u007f]/u.test(filename)) {
    throw new Error('invalid-url');
  }

  filename = filename.replace(/[<>:"|?*]/g, '_');
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\./i.test(filename)) filename = `_${filename}`;
  url.search = '';
  url.hash = '';
  return { url: url.href, filename, extension };
}

export async function fetchCommonsMedia(input, { request = fetch, maxBytes = MAX_FILE_BYTES, signal } = {}) {
  const { url, filename, extension } = parseCommonsMedia(input);
  const response = await request(url, {
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal,
  });
  const format = formats[extension];
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let error;
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
    error = 'fetch-failed';
  } else if (!response.body || !format.types.includes(mediaType)) {
    error = 'media-type';
  } else if (Number(response.headers.get('content-length')) > maxBytes) {
    error = 'too-large';
  }
  if (error) {
    await response.body?.cancel().catch(() => {});
    throw new Error(error);
  }

  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error('too-large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const blob = new Blob(chunks, { type: mediaType });
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (!format.signature.every((byte, index) => signature[index] === byte)) throw new Error('media-type');
  return { blob, filename };
}
