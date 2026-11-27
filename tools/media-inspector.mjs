import { createDecipheriv } from 'node:crypto';
import { open, rename, writeFile } from 'node:fs/promises';
import { ApiError } from './media-source.mjs';

const FMP4_INIT_BOXES = new Set(['ftyp', 'moov']);
const FMP4_MEDIA_BOXES = new Set(['styp', 'moof', 'sidx', 'emsg', 'prft', 'mdat', 'free', 'skip', 'uuid']);
const FMP4_ALL_BOXES = new Set([...FMP4_INIT_BOXES, ...FMP4_MEDIA_BOXES, 'pdin', 'meta', 'mfra', 'pssh']);
const DRM_TAGS = ['pssh', 'sinf', 'encv', 'enca', 'tenc'];

function startsWithBytes(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function parseId3Length(buffer, offset = 0) {
  if (buffer.length < offset + 10) return 0;
  if (buffer[offset] !== 0x49 || buffer[offset + 1] !== 0x44 || buffer[offset + 2] !== 0x33) return 0;
  const b0 = buffer[offset + 6], b1 = buffer[offset + 7], b2 = buffer[offset + 8], b3 = buffer[offset + 9];
  if ((b0 | b1 | b2 | b3) & 0x80) return 0;
  const bodySize = (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
  const hasFooter = (buffer[offset + 5] & 0x10) !== 0;
  return 10 + bodySize + (hasFooter ? 10 : 0);
}

function validTsPacketHeader(buffer, pos) {
  if (pos + 4 > buffer.length || buffer[pos] !== 0x47) return false;
  // Transport error indicator (bit 7 of byte 1) should normally be 0; adaptation_field_control != 00
  const afc = (buffer[pos + 3] >> 4) & 0x03;
  return afc !== 0;
}

function detectMpegTs(buffer, totalSize = buffer.length) {
  // Check standard 188-byte TS at offset 0 or after an RFC 8216 ID3v2 prefix.
  const id3 = parseId3Length(buffer, 0);
  const candidates = id3 > 0 && id3 < buffer.length ? [id3, 0] : [0];
  for (const start of candidates) {
    if (!validTsPacketHeader(buffer, start)) continue;
    const remaining = buffer.length - start;
    if (remaining < 188) continue;
    const checks = Math.min(5, Math.floor(remaining / 188));
    let allValid = true;
    for (let i = 0; i < checks; i++) {
      if (!validTsPacketHeader(buffer, start + i * 188)) {
        allValid = false;
        break;
      }
    }
    if (allValid && (checks >= 2 || (totalSize >= 188 && (totalSize - start) % 188 === 0))) {
      return {
        kind: 'mpegts',
        extension: 'ts',
        packetSize: 188,
        syncOffset: start,
        hasId3Prefix: start > 0 && start === id3,
        needsStrip: false,
      };
    }
  }

  // Check 192-byte M2TS/BDAV packets (4-byte timestamp + 0x47 sync).
  if (buffer.length >= 388 && validTsPacketHeader(buffer, 4) && validTsPacketHeader(buffer, 196)) {
    const checks = Math.min(5, Math.floor((buffer.length - 4) / 192));
    let allValid = true;
    for (let i = 0; i < checks; i++) {
      if (!validTsPacketHeader(buffer, 4 + i * 192)) {
        allValid = false;
        break;
      }
    }
    if (allValid) {
      return { kind: 'mpegts', extension: 'ts', packetSize: 192, syncOffset: 4, hasId3Prefix: false, needsStrip: false };
    }
  }

  // Detect legitimate custom-wrapped MPEG-TS (e.g., short non-TS wrapper prefix <= 512 bytes
  // followed by at least 5 consecutive valid 188-byte TS packets). Pure images/HTML will never pass this.
  const maxScan = Math.min(512, buffer.length - 188 * 5);
  for (let offset = 1; offset <= maxScan; offset++) {
    if (!validTsPacketHeader(buffer, offset)) continue;
    let validPackets = 0;
    const maxPackets = Math.min(10, Math.floor((buffer.length - offset) / 188));
    for (let i = 0; i < maxPackets; i++) {
      if (validTsPacketHeader(buffer, offset + i * 188)) validPackets++;
      else break;
    }
    if (validPackets >= 5 && validPackets === maxPackets) {
      return {
        kind: 'mpegts',
        extension: 'ts',
        packetSize: 188,
        syncOffset: offset,
        hasId3Prefix: false,
        needsStrip: true,
      };
    }
  }
  return null;
}

function detectIsoBmff(buffer, totalSize = buffer.length) {
  if (buffer.length < 8) return null;
  let offset = 0;
  let boxes = 0;
  let hasInit = false;
  let hasMedia = false;
  let drm = false;
  let cmaf = false;
  while (offset + 8 <= buffer.length && boxes < 16) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[a-zA-Z0-9 _-]{4}$/.test(type)) break;
    if (boxes === 0 && !FMP4_ALL_BOXES.has(type)) return null;
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > buffer.length) break;
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = totalSize - offset;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > totalSize) {
      if (boxes === 0) return null;
      break;
    }
    if (type === 'pssh') drm = true;
    if (type === 'moov') {
      const end = Math.min(buffer.length, offset + boxSize);
      const slice = buffer.subarray(offset, end);
      for (const tag of DRM_TAGS) {
        const at = slice.indexOf(tag, 4);
        if (at >= 4 && at + 4 <= slice.length) {
          const innerSize = slice.readUInt32BE(at - 4);
          if (innerSize >= 8 && at - 4 + innerSize <= boxSize) drm = true;
        }
      }
    }
    if (type === 'ftyp' && boxSize >= 16) {
      const brandSlice = buffer.subarray(offset + 8, Math.min(buffer.length, offset + boxSize)).toString('ascii');
      if (/(?:cmfc|cmf2|iso6|dash)/i.test(brandSlice)) cmaf = true;
    }
    if (FMP4_INIT_BOXES.has(type)) hasInit = true;
    if (FMP4_MEDIA_BOXES.has(type)) hasMedia = true;
    boxes++;
    offset += boxSize;
    if (offset >= buffer.length) break;
  }
  if (drm) {
    return { kind: 'drm', rejected: true, reason: 'drm-isobmff', errorCode: 'DRM' };
  }
  if (!boxes || (!hasInit && !hasMedia)) return null;
  return {
    kind: hasInit ? 'mp4' : 'fmp4',
    extension: hasInit ? 'mp4' : 'm4s',
    hasInit,
    hasMedia,
    ...(cmaf && { cmaf: true }),
    syncOffset: 0,
    needsStrip: false,
  };
}

function detectImageOrText(buffer) {
  // Real image formats
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
    return { kind: 'image-png', rejected: true, reason: 'image-payload' };
  }
  if (startsWithBytes(buffer, [0xFF, 0xD8, 0xFF]) && buffer.length >= 4 &&
      [0xE0, 0xE1, 0xE2, 0xDB, 0xEE, 0xFE, 0xC0, 0xC2].includes(buffer[3])) {
    return { kind: 'image-jpeg', rejected: true, reason: 'image-payload' };
  }
  if (startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { kind: 'image-gif', rejected: true, reason: 'image-payload' };
  }
  if (startsWithBytes(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.length >= 12 &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'image-webp', rejected: true, reason: 'image-payload' };
  }

  // Text / HTML / JSON / XML error responses
  const head = buffer.subarray(0, Math.min(512, buffer.length)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT(?:[\t \r\n]|$)/.test(head)) {
    return { kind: 'webvtt', extension: 'vtt', rejected: false, syncOffset: 0, needsStrip: false };
  }
  if (/^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(head)) {
    return { kind: 'srt', extension: 'srt', rejected: false, syncOffset: 0, needsStrip: false };
  }
  if (/^<!doctype\s+html|^<html\b|^<head\b|^<body\b|^<title\b|^<script\b/i.test(head)) {
    return { kind: 'html', rejected: true, reason: 'html-error-page' };
  }
  if (/^<\?xml\b|^<Error\b|^<svg\b/i.test(head)) {
    return { kind: 'xml', rejected: true, reason: 'xml-response' };
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    const fullText = buffer.length <= 65536 ? buffer.toString('utf8').trim() : null;
    if (fullText) {
      try {
        JSON.parse(fullText);
        return { kind: 'json', rejected: true, reason: 'json-error-response' };
      } catch {}
    } else if (/^[\{\[]\s*"[a-zA-Z0-9_-]+"\s*:/.test(head)) {
      return { kind: 'json', rejected: true, reason: 'json-error-response' };
    }
  }
  return null;
}

function detectAdtsAac(buffer) {
  const start = parseId3Length(buffer, 0);
  if (buffer.length < start + 7) return null;
  if (buffer[start] !== 0xFF || (buffer[start + 1] & 0xF6) !== 0xF0) return null;
  const frameLen = ((buffer[start + 3] & 0x03) << 11) | (buffer[start + 4] << 3) | ((buffer[start + 5] & 0xE0) >> 5);
  if (frameLen < 7) return null;
  if (start + frameLen + 2 <= buffer.length) {
    if (buffer[start + frameLen] !== 0xFF || (buffer[start + frameLen + 1] & 0xF6) !== 0xF0) return null;
  }
  return { kind: 'aac', extension: 'aac', syncOffset: start, needsStrip: false };
}

function detectOtherContainer(buffer) {
  if (startsWithBytes(buffer, [0x1A, 0x45, 0xDF, 0xA3])) {
    return { kind: 'matroska', extension: 'mkv', syncOffset: 0, needsStrip: false };
  }
  if (startsWithBytes(buffer, [0x46, 0x4C, 0x56, 0x01]) && buffer.length >= 9 && buffer.readUInt32BE(5) >= 9) {
    return { kind: 'flv', extension: 'flv', syncOffset: 0, needsStrip: false };
  }
  if (startsWithBytes(buffer, [0x4F, 0x67, 0x67, 0x53])) {
    return { kind: 'ogg', extension: 'ogg', syncOffset: 0, needsStrip: false };
  }
  if (startsWithBytes(buffer, [0x66, 0x4C, 0x61, 0x43])) {
    return { kind: 'flac', extension: 'flac', syncOffset: 0, needsStrip: false };
  }
  if (startsWithBytes(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.length >= 12) {
    const fourcc = buffer.toString('ascii', 8, 12);
    if (fourcc === 'AVI ') return { kind: 'avi', extension: 'avi', syncOffset: 0, needsStrip: false };
    if (fourcc === 'WAVE') return { kind: 'wav', extension: 'wav', syncOffset: 0, needsStrip: false };
  }
  const adts = detectAdtsAac(buffer);
  if (adts) return adts;
  // MP3 with ID3 tag
  const id3 = parseId3Length(buffer, 0);
  if (id3 > 0 && id3 + 2 <= buffer.length && buffer[id3] === 0xFF && (buffer[id3 + 1] & 0xE0) === 0xE0) {
    return { kind: 'mp3', extension: 'mp3', syncOffset: 0, needsStrip: false };
  }
  return null;
}

/**
 * Sniff real media format purely from binary structure, ignoring URL extensions and MIME types.
 */
export function inspectMediaBuffer(buffer, { totalSize = buffer.length, expected = null } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { valid: false, kind: 'empty', rejected: true, reason: 'empty-payload' };
  }

  // 1. Check MPEG-TS first (includes standard TS, ID3-prefixed TS, M2TS, and verified custom-prefixed TS).
  const ts = detectMpegTs(buffer, totalSize);
  if (ts) {
    if (expected === 'fmp4-init' || expected === 'webvtt') {
      return { valid: false, kind: ts.kind, rejected: true, reason: `unexpected-${ts.kind}-for-${expected}` };
    }
    return { valid: true, rejected: false, ...ts };
  }

  // 2. Check ISO-BMFF / fMP4 (init or media segments, rejecting DRM boxes).
  const mp4 = detectIsoBmff(buffer, totalSize);
  if (mp4) {
    if (mp4.rejected) return { valid: false, ...mp4 };
    if (expected === 'fmp4-init' && !mp4.hasInit) {
      return { valid: false, kind: mp4.kind, rejected: true, reason: 'missing-init-box' };
    }
    if (expected === 'mpegts') {
      // An fMP4 segment in an unmapped HLS playlist is valid media, report its true container.
      return { valid: true, rejected: false, ...mp4 };
    }
    return { valid: true, rejected: false, ...mp4 };
  }

  // 3. Check explicit non-media formats (real images, HTML error pages, JSON error responses, WebVTT).
  const nonMedia = detectImageOrText(buffer);
  if (nonMedia) {
    if (!nonMedia.rejected) {
      if (expected && expected !== 'webvtt' && expected !== 'subtitle') {
        return { valid: false, kind: nonMedia.kind, rejected: true, reason: 'unexpected-subtitle-for-media' };
      }
      return { valid: true, ...nonMedia };
    }
    return { valid: false, ...nonMedia };
  }

  // 4. Check other supported containers (Matroska/WebM, FLV, Ogg, FLAC, AVI, WAV, ADTS AAC, MP3).
  const other = detectOtherContainer(buffer);
  if (other) {
    if (expected === 'fmp4-init' || expected === 'webvtt') {
      return { valid: false, kind: other.kind, rejected: true, reason: `unexpected-${other.kind}-for-${expected}` };
    }
    return { valid: true, rejected: false, ...other };
  }

  return { valid: false, kind: 'unknown', rejected: true, reason: 'unrecognized-media-bytes' };
}

export async function inspectMediaFile(filePath, { expected = null, maxBytes = 8192 } = {}) {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return { valid: false, kind: 'empty', rejected: true, reason: 'empty-payload', size: 0 };
    const toRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    return { ...inspectMediaBuffer(buffer.subarray(0, bytesRead), { totalSize: size, expected }), size };
  } finally {
    await handle.close();
  }
}

/**
 * Validate a standard AES-128-CBC encrypted HLS segment by decrypting its leading blocks
 * and verifying the plaintext matches a valid media container (rejecting HTML/JSON/images/corrupt bytes).
 */
export async function inspectEncryptedHlsSegment(filePath, key, iv, { expected = null } = {}) {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return { valid: false, kind: 'empty', rejected: true, reason: 'empty-payload', size: 0 };
    // First reject obvious plaintext error payloads (HTML/JSON/PNG/JPEG) even if their size happens to be a multiple of 16.
    const headLen = Math.min(size, 512);
    const head = Buffer.alloc(headLen);
    await handle.read(head, 0, headLen, 0);
    const plaintextCheck = detectImageOrText(head);
    if (plaintextCheck?.rejected) {
      return { valid: false, ...plaintextCheck, size };
    }
    if (size < 16 || size % 16 !== 0) {
      return { valid: false, kind: 'corrupt-ciphertext', rejected: true, reason: 'invalid-aes128-block-size', size };
    }
    const sampleSize = Math.min(size, 4096);
    const aligned = sampleSize - (sampleSize % 16);
    const cipherBuf = Buffer.alloc(aligned);
    const { bytesRead } = await handle.read(cipherBuf, 0, aligned, 0);
    const full = bytesRead === size;
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    if (!full) decipher.setAutoPadding(false);
    let decrypted;
    try {
      decrypted = Buffer.concat([decipher.update(cipherBuf.subarray(0, bytesRead)), decipher.final()]);
    } catch {
      return { valid: false, kind: 'corrupt-ciphertext', rejected: true, reason: 'aes128-decrypt-failed', size };
    }
    return { ...inspectMediaBuffer(decrypted, { totalSize: full ? decrypted.length : size, expected }), size, encrypted: true };
  } finally {
    await handle.close();
  }
}

/**
 * Strip a verified custom non-media wrapper prefix (only when inspectMediaFile found
 * a validated multi-packet MPEG-TS stream at syncOffset > 0 with needsStrip === true).
 */
export async function normalizeStagedSegment(filePath, inspection) {
  if (!inspection?.valid || !inspection.needsStrip || !inspection.syncOffset) return filePath;
  const handle = await open(filePath, 'r');
  let stripped;
  try {
    const { size } = await handle.stat();
    const length = size - inspection.syncOffset;
    stripped = Buffer.alloc(length);
    await handle.read(stripped, 0, length, inspection.syncOffset);
  } finally {
    await handle.close();
  }
  const tmp = filePath + '.normalized';
  await writeFile(tmp, stripped, { mode: 0o600 });
  await rename(tmp, filePath);
  return filePath;
}

export function assertValidSegment(inspection, { code = 'INVALID_HLS_SEGMENT', message } = {}) {
  if (inspection?.valid) return inspection;
  if (inspection?.errorCode === 'DRM') {
    throw new ApiError('DRM', '媒体分片包含受 DRM 保护的加密容器', 422, { reason: inspection.reason });
  }
  throw new ApiError(
    code,
    message || `媒体分片内容校验失败（${inspection?.reason ?? 'invalid-media'}）`,
    422,
    { detectedKind: inspection?.kind ?? 'unknown', reason: inspection?.reason ?? 'invalid-media' },
  );
}
