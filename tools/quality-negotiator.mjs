import { ApiError } from './media-source.mjs';

const VALID_STRING_MODES = new Set(['max', 'best', 'auto', 'lowest']);
const VALID_OBJECT_MODES = new Set(['max', 'best', 'cap', 'exact', 'lowest', 'auto', 'budget']);
const VALID_FALLBACKS = new Set(['lower', 'higher', 'closest', 'fail']);

export function normalizeQualitySpec(value) {
  if (value === undefined || value === null) {
    return { mode: 'best', height: null, maxBitrate: null, maxBytes: null, preferHdr: null, fallback: 'lower', raw: value ?? null };
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 144 || value > 4320) {
      throw new ApiError('INVALID_QUALITY', '画质应为 144 至 4320 之间的整数');
    }
    return { mode: 'cap', height: value, maxBitrate: null, maxBytes: null, preferHdr: null, fallback: 'lower', raw: value };
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (VALID_STRING_MODES.has(normalized)) {
      return { mode: normalized, height: null, maxBitrate: null, maxBytes: null, preferHdr: null, fallback: 'lower', raw: normalized };
    }
    const exactMatch = /^exact:(\d{3,4})$/.exec(normalized);
    if (exactMatch) {
      const height = Number(exactMatch[1]);
      if (height >= 144 && height <= 4320) {
        return { mode: 'exact', height, maxBitrate: null, maxBytes: null, preferHdr: null, fallback: 'fail', raw: normalized };
      }
    }
    const capMatch = /^(\d{3,4})p?$/.exec(normalized);
    if (capMatch) {
      const height = Number(capMatch[1]);
      if (height >= 144 && height <= 4320) {
        return { mode: 'cap', height, maxBitrate: null, maxBytes: null, preferHdr: null, fallback: 'lower', raw: height };
      }
    }
    throw new ApiError('INVALID_QUALITY', '画质应为 144–4320 整数、max、best、auto、lowest 或结构化画质策略');
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const allowed = new Set(['mode', 'height', 'maxBitrate', 'maxBytes', 'preferHdr', 'fallback']);
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
    return {
      mode,
      height,
      maxBitrate,
      maxBytes,
      preferHdr: value.preferHdr === undefined ? null : value.preferHdr === true,
      fallback,
      raw: value,
    };
  }
  throw new ApiError('INVALID_QUALITY', '画质参数格式无效');
}

export function legacyQualityCap(value) {
  const spec = normalizeQualitySpec(value);
  if (spec.mode === 'max' || spec.mode === 'best') return null;
  if (spec.mode === 'auto') return 1080;
  if (spec.mode === 'lowest') return 144;
  return spec.height;
}

function compareCandidates(a, b, preferHdr = null) {
  const heightDiff = (b.height || 0) - (a.height || 0);
  if (heightDiff) return heightDiff;
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

/**
 * Negotiate the best candidate from real observed media variants (HLS/DASH/player).
 * Never synthesizes or guesses unverified URLs.
 */
export function negotiateQuality(candidates, qualityInput, { durationSec = null } = {}) {
  const spec = normalizeQualitySpec(qualityInput);
  if (!Array.isArray(candidates) || !candidates.length) {
    return { selected: null, ranked: [], requested: spec, fallbackApplied: false, reason: 'no-variants' };
  }
  const sorted = [...candidates].sort((a, b) => compareCandidates(a, b, spec.preferHdr));

  const withinBudget = candidate => {
    const bps = candidate.bandwidth || candidate.bitrate || 0;
    if (spec.maxBitrate && bps > spec.maxBitrate) return false;
    if (spec.maxBytes && durationSec > 0 && bps > 0) {
      const est = Math.ceil((bps * durationSec) / 8);
      if (est > spec.maxBytes) return false;
    }
    return true;
  };

  if (spec.mode === 'max' || spec.mode === 'best') {
    const budgeted = sorted.filter(withinBudget);
    const ranked = budgeted.length ? budgeted : sorted;
    return {
      selected: ranked[0],
      ranked,
      requested: spec,
      fallbackApplied: budgeted.length === 0 && Boolean(spec.maxBitrate || spec.maxBytes),
      reason: budgeted.length ? 'highest-available' : 'budget-fallback-lowest',
    };
  }

  if (spec.mode === 'lowest') {
    const asc = [...sorted].reverse();
    return { selected: asc[0], ranked: asc, requested: spec, fallbackApplied: false, reason: 'lowest-available' };
  }

  if (spec.mode === 'auto') {
    const budgeted = sorted.filter(withinBudget);
    const pool = budgeted.length ? budgeted : sorted;
    const preferred = pool.filter(c => (c.height || 0) <= 1080);
    const ranked = preferred.length ? [...preferred, ...pool.filter(c => (c.height || 0) > 1080)] : pool;
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
      });
    }
  }

  // Cap mode (or exact mode with fallback)
  const targetHeight = spec.height;
  const lower = sorted.filter(c => c.height && c.height <= targetHeight && withinBudget(c));
  const higher = [...sorted].filter(c => c.height && c.height > targetHeight && withinBudget(c)).reverse();
  const closest = [...sorted].filter(c => c.height).sort((a, b) =>
    Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight) || compareCandidates(a, b, spec.preferHdr));

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
