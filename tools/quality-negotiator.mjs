import { ApiError } from './media-source.mjs';

const VALID_STRING_MODES = new Set(['max', 'best', 'auto', 'lowest']);
const VALID_OBJECT_MODES = new Set(['max', 'best', 'cap', 'exact', 'lowest', 'auto', 'budget']);
const VALID_FALLBACKS = new Set(['lower', 'higher', 'closest', 'fail']);
const VALID_CODECS = new Set(['av1', 'hevc', 'h264', 'vp9']);
const VALID_NETWORK_PROFILES = new Set(['auto', 'high', 'medium', 'low']);

const NETWORK_LIMITS = {
  low: { height: 480, maxBitrate: 1_500_000 },
  medium: { height: 720, maxBitrate: 4_000_000 },
  high: { height: null, maxBitrate: null },
  auto: { height: null, maxBitrate: null },
};

function codecFamily(codecs) {
  const value = String(codecs || '').toLowerCase();
  if (/(?:^|,|\s)(?:av01|av1)\b/.test(value)) return 'av1';
  if (/(?:^|,|\s)(?:hvc1|hev1|hevc|h265)\b/.test(value)) return 'hevc';
  if (/(?:^|,|\s)(?:vp0?9)\b/.test(value)) return 'vp9';
  if (/(?:^|,|\s)(?:avc1|avc3|h264)\b/.test(value)) return 'h264';
  return null;
}

export function normalizeQualitySpec(value) {
  if (value === undefined || value === null) {
    return { mode: 'best', height: null, maxBitrate: null, maxBytes: null, preferHdr: null, preferCodec: null, networkProfile: 'auto', fallback: 'lower', raw: value ?? null };
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 144 || value > 4320) {
      throw new ApiError('INVALID_QUALITY', '画质应为 144 至 4320 之间的整数');
    }
    return { mode: 'cap', height: value, maxBitrate: null, maxBytes: null, preferHdr: null, preferCodec: null, networkProfile: 'auto', fallback: 'lower', raw: value };
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (VALID_STRING_MODES.has(normalized)) {
      return { mode: normalized, height: null, maxBitrate: null, maxBytes: null, preferHdr: null, preferCodec: null, networkProfile: 'auto', fallback: 'lower', raw: normalized };
    }
    const exactMatch = /^exact:(\d{3,4})$/.exec(normalized);
    if (exactMatch) {
      const height = Number(exactMatch[1]);
      if (height >= 144 && height <= 4320) {
        return { mode: 'exact', height, maxBitrate: null, maxBytes: null, preferHdr: null, preferCodec: null, networkProfile: 'auto', fallback: 'fail', raw: normalized };
      }
    }
    const capMatch = /^(\d{3,4})p?$/.exec(normalized);
    if (capMatch) {
      const height = Number(capMatch[1]);
      if (height >= 144 && height <= 4320) {
        return { mode: 'cap', height, maxBitrate: null, maxBytes: null, preferHdr: null, preferCodec: null, networkProfile: 'auto', fallback: 'lower', raw: height };
      }
    }
    throw new ApiError('INVALID_QUALITY', '画质应为 144–4320 整数、max、best、auto、lowest 或结构化画质策略');
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const allowed = new Set(['mode', 'height', 'maxBitrate', 'maxBytes', 'preferHdr', 'preferCodec', 'networkProfile', 'fallback']);
    if (Object.keys(value).some(key => !allowed.has(key))) {
      throw new ApiError('INVALID_QUALITY', '画质策略包含不支持的字段');
    }
    const mode = value.mode ?? (value.height != null ? 'cap' : (value.maxBitrate || value.maxBytes ? 'budget' : 'best'));
    if (!VALID_OBJECT_MODES.has(mode)) throw new ApiError('INVALID_QUALITY', '不支持的画质选择模式');
    const height = value.height ?? null;
    if (height !== null && (!Number.isInteger(height) || height < 144 || height > 4320)) {
      throw new ApiError('INVALID_QUALITY', '画质高度应为 144 至 4320 之间的整数');
    }
    if (mode === 'exact' && height === null) {
      throw new ApiError('INVALID_QUALITY', 'exact 画质模式需要指定目标高度 height');
    }
    const maxBitrate = value.maxBitrate ?? null;
    if (maxBitrate !== null && (!Number.isSafeInteger(maxBitrate) || maxBitrate < 10_000)) {
      throw new ApiError('INVALID_QUALITY', 'maxBitrate 必须为不小于 10000 的整数');
    }
    const maxBytes = value.maxBytes ?? null;
    if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 65_536)) {
      throw new ApiError('INVALID_QUALITY', 'maxBytes 必须为不小于 65536 的整数');
    }
    const fallback = value.fallback ?? (mode === 'exact' ? 'fail' : 'lower');
    if (!VALID_FALLBACKS.has(fallback)) throw new ApiError('INVALID_QUALITY', '不支持的画质回退策略');
    if (value.preferHdr !== undefined && typeof value.preferHdr !== 'boolean') {
      throw new ApiError('INVALID_QUALITY', 'preferHdr 必须为布尔值');
    }
    const preferCodec = value.preferCodec ? String(value.preferCodec).trim().toLowerCase() : null;
    if (preferCodec && !VALID_CODECS.has(preferCodec)) {
      throw new ApiError('INVALID_QUALITY', 'preferCodec 应为 av1、hevc、h264 或 vp9');
    }
    const networkProfile = value.networkProfile ? String(value.networkProfile).trim().toLowerCase() : 'auto';
    if (!VALID_NETWORK_PROFILES.has(networkProfile)) {
      throw new ApiError('INVALID_QUALITY', 'networkProfile 应为 auto、high、medium 或 low');
    }
    return {
      mode,
      height,
      maxBitrate,
      maxBytes,
      preferHdr: value.preferHdr === undefined ? null : value.preferHdr === true,
      preferCodec,
      networkProfile,
      fallback,
      raw: value,
    };
  }
  throw new ApiError('INVALID_QUALITY', '画质参数格式无效');
}

export function legacyQualityCap(value) {
  const spec = normalizeQualitySpec(value);
  if (spec.mode === 'max' || spec.mode === 'best') return NETWORK_LIMITS[spec.networkProfile]?.height ?? null;
  if (spec.mode === 'auto') return NETWORK_LIMITS[spec.networkProfile]?.height ?? 1080;
  if (spec.mode === 'lowest') return 144;
  return spec.height;
}

function availabilityRank(candidate) {
  const state = candidate.availability ?? (candidate.available === true ? 'available' : candidate.available === false ? 'unavailable' : 'unknown');
  if (state === 'available') return 2;
  if (state === 'unknown') return 1;
  return 0;
}

function isUnavailable(candidate) {
  if (candidate.availability === 'unavailable') return true;
  if (candidate.available === false && candidate.availability !== 'restricted') return true;
  return false;
}

function isRestricted(candidate) {
  return candidate.availability === 'restricted';
}

function compareCandidates(a, b, { preferHdr = null, preferCodec = null } = {}) {
  const availDiff = availabilityRank(b) - availabilityRank(a);
  if (availDiff) return availDiff;
  const heightDiff = (b.height || 0) - (a.height || 0);
  if (heightDiff) return heightDiff;
  if (preferCodec) {
    const codecDiff = Number(codecFamily(b.codecs ?? b.codec) === preferCodec) - Number(codecFamily(a.codecs ?? a.codec) === preferCodec);
    if (codecDiff) return codecDiff;
  }
  if (preferHdr === true) {
    const hdrDiff = Number(Boolean(b.hdr)) - Number(Boolean(a.hdr));
    if (hdrDiff) return hdrDiff;
  } else if (preferHdr === false) {
    const sdrDiff = Number(Boolean(a.hdr)) - Number(Boolean(b.hdr));
    if (sdrDiff) return sdrDiff;
  }
  const bitrateDiff = (b.bandwidth || b.bitrate || 0) - (a.bandwidth || a.bitrate || 0);
  if (bitrateDiff) return bitrateDiff;
  return (b.frameRate || 0) - (a.frameRate || 0);
}

function summarizeStatuses(candidates) {
  return candidates.map(c => ({
    candidateId: c.candidateId ?? null,
    height: c.height ?? 0,
    bandwidth: c.bandwidth || c.bitrate || 0,
    availability: c.availability ?? (c.available === true ? 'available' : c.available === false ? 'unavailable' : 'unknown'),
    probeStatus: c.probeStatus ?? null,
  }));
}

/**
 * Negotiate the best candidate from real observed media variants (HLS/DASH/player).
 * - Respects verified availability ('available' | 'unavailable' | 'restricted' | 'unknown').
 * - Never synthesizes unverified URLs and never treats access-control rejections as bypassable.
 */
export function negotiateQuality(candidates, qualityInput, { durationSec = null } = {}) {
  const spec = normalizeQualitySpec(qualityInput);
  if (!Array.isArray(candidates) || !candidates.length) {
    return { selected: null, ranked: [], requested: spec, fallbackApplied: false, reason: 'no-variants' };
  }

  const allRestricted = candidates.every(isRestricted);
  if (allRestricted) {
    throw new ApiError('MEDIA_ACCESS_RESTRICTED', '所有探测到的画质候选均返回访问拒绝，请先确认授权会话', 403, {
      requested: spec,
      candidates: summarizeStatuses(candidates),
    });
  }

  // Filter out verified unavailable (e.g. 404/410) and restricted (401/403/451) variants from selectable pool.
  const eligible = candidates.filter(c => !isUnavailable(c) && !isRestricted(c));
  if (!eligible.length) {
    const hasRestricted = candidates.some(isRestricted);
    throw new ApiError(
      hasRestricted ? 'MEDIA_ACCESS_RESTRICTED' : 'QUALITY_UNAVAILABLE',
      hasRestricted ? '无可用授权画质候选，高画质或全部候选受到访问控制限制' : '全部画质候选均不可用',
      hasRestricted ? 403 : 422,
      { requested: spec, candidates: summarizeStatuses(candidates) },
    );
  }

  // If caller asked for exact height and that exact height is strictly restricted, surface MEDIA_ACCESS_RESTRICTED.
  if (spec.mode === 'exact' && spec.fallback === 'fail') {
    const exactAll = candidates.filter(c => c.height === spec.height);
    if (exactAll.length && exactAll.every(isRestricted)) {
      throw new ApiError('MEDIA_ACCESS_RESTRICTED', `请求的 ${spec.height}p 画质受访问控制限制`, 403, {
        requestedHeight: spec.height,
        candidates: summarizeStatuses(candidates),
      });
    }
  }

  const sorted = [...eligible].sort((a, b) => compareCandidates(a, b, spec));
  const netLimit = NETWORK_LIMITS[spec.networkProfile] ?? NETWORK_LIMITS.auto;
  const effectiveMaxBitrate = spec.maxBitrate ?? netLimit.maxBitrate;
  const effectiveNetHeight = spec.height ?? netLimit.height;

  const withinBudget = candidate => {
    const bps = candidate.bandwidth || candidate.bitrate || 0;
    if (effectiveMaxBitrate && bps > effectiveMaxBitrate) return false;
    if (spec.maxBytes && durationSec > 0 && bps > 0) {
      const est = Math.ceil((bps * durationSec) / 8);
      if (est > spec.maxBytes) return false;
    }
    return true;
  };

  if (spec.mode === 'max' || spec.mode === 'best') {
    const budgeted = sorted.filter(c => withinBudget(c) && (!effectiveNetHeight || (c.height || 0) <= effectiveNetHeight));
    const ranked = budgeted.length ? budgeted : sorted;
    const droppedUnavailable = candidates.some(isUnavailable);
    return {
      selected: ranked[0],
      ranked,
      requested: spec,
      fallbackApplied: droppedUnavailable || (budgeted.length === 0 && Boolean(effectiveMaxBitrate || spec.maxBytes || effectiveNetHeight)),
      reason: droppedUnavailable ? 'highest-verified-available' : budgeted.length ? 'highest-available' : 'budget-fallback-lowest',
    };
  }

  if (spec.mode === 'lowest') {
    const asc = [...sorted].reverse();
    return { selected: asc[0], ranked: asc, requested: spec, fallbackApplied: false, reason: 'lowest-available' };
  }

  if (spec.mode === 'auto') {
    const cap = effectiveNetHeight ?? 1080;
    const budgeted = sorted.filter(withinBudget);
    const pool = budgeted.length ? budgeted : sorted;
    const preferred = pool.filter(c => (c.height || 0) <= cap);
    const ranked = preferred.length ? [...preferred, ...pool.filter(c => (c.height || 0) > cap)] : pool;
    return { selected: ranked[0], ranked, requested: spec, fallbackApplied: false, reason: 'auto-balanced' };
  }

  if (spec.mode === 'budget') {
    const budgeted = sorted.filter(c => withinBudget(c) && (!spec.height || (c.height || 0) <= spec.height));
    if (budgeted.length) {
      return { selected: budgeted[0], ranked: budgeted, requested: spec, fallbackApplied: false, reason: 'within-budget' };
    }
    if (spec.fallback === 'fail') {
      throw new ApiError('QUALITY_UNAVAILABLE', '没有满足带宽或体积预算的可用画质', 422, {
        requested: spec,
        availableHeights: [...new Set(sorted.map(c => c.height).filter(Boolean))],
        candidates: summarizeStatuses(candidates),
      });
    }
    const asc = [...sorted].reverse();
    return { selected: asc[0], ranked: asc, requested: spec, fallbackApplied: true, reason: 'budget-exceeded-fallback-lowest' };
  }

  if (spec.mode === 'exact') {
    const exact = sorted.filter(c => c.height === spec.height && withinBudget(c));
    if (exact.length) {
      return { selected: exact[0], ranked: exact, requested: spec, fallbackApplied: false, reason: 'exact-match' };
    }
    if (spec.fallback === 'fail') {
      throw new ApiError('QUALITY_UNAVAILABLE', `未找到精确画质 ${spec.height}p`, 422, {
        requestedHeight: spec.height,
        availableHeights: [...new Set(sorted.map(c => c.height).filter(Boolean))],
        candidates: summarizeStatuses(candidates),
      });
    }
  }

  // Cap mode (or exact mode with fallback)
  const targetHeight = spec.height;
  const lower = sorted.filter(c => c.height && c.height <= targetHeight && withinBudget(c));
  const higher = [...sorted].filter(c => c.height && c.height > targetHeight && withinBudget(c)).reverse();
  const closest = [...sorted].filter(c => c.height).sort((a, b) =>
    Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight) || compareCandidates(a, b, spec));

  if (spec.mode === 'cap' && lower.length) {
    return {
      selected: lower[0],
      ranked: lower,
      requested: spec,
      fallbackApplied: lower[0].height < targetHeight,
      reason: lower[0].height === targetHeight ? 'exact-cap-match' : 'highest-within-cap',
    };
  }

  if (spec.fallback === 'fail') {
    throw new ApiError('QUALITY_UNAVAILABLE', `没有符合 ${targetHeight}p 上限的可用画质`, 422, {
      requestedHeight: targetHeight,
      availableHeights: [...new Set(sorted.map(c => c.height).filter(Boolean))],
      candidates: summarizeStatuses(candidates),
    });
  }
  if (spec.fallback === 'higher' && higher.length) {
    return { selected: higher[0], ranked: higher, requested: spec, fallbackApplied: true, reason: 'fallback-higher' };
  }
  if (spec.fallback === 'closest' && closest.length) {
    return { selected: closest[0], ranked: closest, requested: spec, fallbackApplied: true, reason: 'fallback-closest' };
  }
  const lowest = sorted.filter(c => c.height === sorted.at(-1)?.height);
  const ranked = lowest.length ? lowest : sorted;
  return { selected: ranked[0], ranked, requested: spec, fallbackApplied: true, reason: 'fallback-lowest-available' };
}

function summarizeRequestedQuality(requested) {
  if (requested === undefined || requested === null) return 'best';
  if (typeof requested === 'object' && 'raw' in requested) {
    return requested.raw ?? (requested.mode === 'exact' && requested.height ? `exact:${requested.height}` : requested.height ?? requested.mode ?? 'best');
  }
  return requested;
}

/**
 * Build or reconcile the unified authoritative quality negotiation model (v1.3.1).
 * Strictly distinguishes requestedQuality, availableQualities, declaredQuality,
 * selectedQuality, and post-FFprobe actualQuality so reports can never contradict outputs.
 */
export function buildQualityNegotiationReport({
  requestedQuality,
  availableQualities = [],
  declaredQuality = null,
  selectedQuality = null,
  actualQuality = null,
  scaledByFfmpeg = false,
  fallbackApplied = false,
  fallbackReason = null,
  reason = null,
  verificationLevel = 'standard',
  verificationStatus = 'verified',
} = {}) {
  const reqSummary = summarizeRequestedQuality(requestedQuality);
  const avail = [...new Set((Array.isArray(availableQualities) ? availableQualities : [])
    .map(v => (typeof v === 'object' && v ? Number(v.height) : Number(v)))
    .filter(h => Number.isFinite(h) && h > 0))].sort((a, b) => b - a);

  const selected = selectedQuality ? {
    height: selectedQuality.height ?? null,
    width: selectedQuality.width ?? null,
    codec: selectedQuality.codec ?? null,
    formatKind: selectedQuality.formatKind ?? null,
  } : null;

  const declared = declaredQuality ? {
    height: declaredQuality.height ?? selected?.height ?? null,
    width: declaredQuality.width ?? selected?.width ?? null,
    codec: declaredQuality.codec ?? selected?.codec ?? null,
    formatKind: declaredQuality.formatKind ?? selected?.formatKind ?? null,
  } : selected ? { ...selected } : null;

  const actual = actualQuality ? {
    height: actualQuality.height ?? null,
    width: actualQuality.width ?? null,
    videoCodec: actualQuality.videoCodec ?? actualQuality.codec ?? null,
    audioCodec: actualQuality.audioCodec ?? null,
    duration: actualQuality.duration ?? null,
  } : null;

  let finalFallback = Boolean(fallbackApplied);
  let finalFallbackReason = fallbackReason ?? (finalFallback ? reason : null);
  let finalReason = reason || 'verified-output';

  if (scaledByFfmpeg) {
    finalFallback = true;
    finalFallbackReason = finalFallbackReason || 'downscaled-by-ffmpeg';
    finalReason = `downscaled-to-${actual?.height ?? 'target'}p`;
  } else if (selected?.height && actual?.height && selected.height !== actual.height) {
    finalFallback = true;
    finalFallbackReason = `actual-stream-height-${actual.height}p-differs-from-declared-${selected.height}p`;
    finalReason = `${finalReason}:actual-${actual.height}p`;
  }

  return {
    requestedQuality: reqSummary,
    availableQualities: avail,
    declaredQuality: declared,
    selectedQuality: selected,
    actualQuality: actual,
    // Consistent back-compat flat fields
    requested: reqSummary,
    available: avail,
    selectedHeight: selected?.height ?? actual?.height ?? null,
    selectedWidth: selected?.width ?? actual?.width ?? null,
    selectedCodec: selected?.codec ?? actual?.videoCodec ?? null,
    formatKind: selected?.formatKind ?? declared?.formatKind ?? null,
    actualHeight: actual?.height ?? null,
    actualWidth: actual?.width ?? null,
    scaledByFfmpeg: Boolean(scaledByFfmpeg),
    fallbackApplied: finalFallback,
    fallbackReason: finalFallback ? (finalFallbackReason || finalReason) : null,
    reason: finalReason,
    verificationLevel,
    verificationStatus,
  };
}
