const headerWindow = 4 * 1024;
const metadataWindow = 48 * 1024;
const maxRequests = 4;

function readBox(view, offset, limit) {
  const size32 = view.getUint32(0);
  const headerSize = size32 === 1 ? 16 : 8;
  const size = size32 === 1 ? Number(view.getBigUint64(8)) : size32 || limit - offset;
  if (!Number.isSafeInteger(size) || size < headerSize || size > limit - offset) return null;
  return {type:view.getUint32(4), start:offset + headerSize, end:offset + size};
}

const boxType = text => [...text].reduce((value, letter) => value * 256 + letter.charCodeAt(0), 0);

export async function queryMp4Metadata(url) {
  const signal = AbortSignal.timeout(6500);
  let size;
  let validator;
  let requests = 0;
  let windowStart = 0;
  let windowBytes = new Uint8Array();

  async function read(offset, length) {
    if (offset < windowStart || offset + length > windowStart + windowBytes.byteLength) {
      if (requests === maxRequests) return null;
      const limit = requests++ === 0 ? headerWindow : metadataWindow;
      const end = Math.min(size === undefined ? Infinity : size - 1, offset + limit - 1);
      const response = await fetch(url, {credentials:'omit', signal, headers:{Range:'bytes=' + offset + '-' + end}});
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
      const encoding = response.headers.get('content-encoding')?.toLowerCase();
      const etag = response.headers.get('etag');
      const total = Number(range?.[3]);
      const last = Number(range?.[2]);
      if (response.status !== 206 || !response.body || encoding && encoding !== 'identity' ||
          !Number.isSafeInteger(total) || Number(range?.[1]) !== offset ||
          last !== Math.min(end, total - 1) || last < offset ||
          size !== undefined && size !== total || validator && etag && validator !== etag) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = new Uint8Array(last - offset + 1);
      let received = 0;
      for await (const chunk of response.body) {
        if (chunk.byteLength > bytes.length - received) return null;
        bytes.set(chunk, received);
        received += chunk.byteLength;
      }
      if (received !== bytes.length) return null;
      size = total;
      validator ||= etag;
      windowStart = offset;
      windowBytes = bytes;
    }
    if (offset + length > windowStart + windowBytes.byteLength) return null;
    return new DataView(windowBytes.buffer, offset - windowStart, length);
  }

  async function findBox(start, end, name) {
    const type = boxType(name);
    for (let offset = start; offset + 8 <= (end ?? size);) {
      const view = await read(offset, Math.min(16, (end ?? size) - offset));
      if (!view || view.getUint32(0) === 1 && view.byteLength < 16) return null;
      const box = readBox(view, offset, end ?? size);
      if (!box) return null;
      if (box.type === type) return box;
      offset = box.end;
    }
    return null;
  }

  try {
    if (!await read(0, 8)) return null;
    const moov = await findBox(0, size, 'moov');
    const udta = moov && await findBox(moov.start, moov.end, 'udta');
    const container = udta || moov;
    const meta = container && await findBox(container.start, container.end, 'meta');
    const ilst = meta && await findBox(meta.start + 4, meta.end, 'ilst');
    const name = ilst && await findBox(ilst.start, ilst.end, '\u00a9nam');
    const data = name && await findBox(name.start, name.end, 'data');
    const length = data && data.end - data.start;
    if (!length || length <= 8 || length > 4096) return {title:null, size};
    const view = await read(data.start, length);
    const code = view?.getUint32(0);
    if (code !== 1 && code !== 2) return {title:null, size};
    const text = new TextDecoder(code === 1 ? 'utf-8' : 'utf-16be', {fatal:true})
      .decode(new Uint8Array(view.buffer, view.byteOffset + 8, length - 8));
    const title = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 300);
    return {title:title || null, size};
  } catch {
    return size ? {title:null, size} : null;
  }
}
