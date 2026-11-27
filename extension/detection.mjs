const allowedKinds = new Set(['mp4','m4v','mkv','mov','webm','ogv','avi','m3u8','mpd','ts','mp3','m4a','ogg','wav','flac','page']);
const strategyNames = new Set(['player','network','player-playlist','xhr-json','page-config','structured-data','performance','platform']);
const blockersKnown = new Set(['cloudflare-challenge','cf-turnstile','captcha','drm','paywall','login-required','forbidden','rate-limited']);
const preview = /(?:\b(?:teaser|trailer|preview|preroll|midroll)\b|预告|预览|试看|广告)/i;
const full = /(?:\b(?:full (?:film|movie|video|episode)|feature film)\b|正片|完整版)/i;

export function assessCandidates(streams) {
  return streams.map(stream => {
    const strategy = stream.discoveredBy || (stream.fromPlayer ? 'player-playlist' : stream.mediaElement ? 'player' : stream.strategy || 'network');
    const strategies = [...new Set([...(stream.strategies ?? []), strategy])].filter(name => strategyNames.has(name));
    const context = stream.player ?? stream.playerContext;
    const text = [stream.title, context?.heading, context?.description].filter(Boolean).join(' ');
    const path = URL.parse(stream.url)?.pathname.replace(/[-_]/g,' ') || '';
    const evidence = [
      [(stream.mediaElement || stream.fromPlayer || ['player','player-playlist'].includes(strategy)), 'player-source', 4],
      [stream.observed, 'network-response', 2],
      [strategies.some(name => ['page-config','structured-data','xhr-json'].includes(name)), 'published-source', 1],
      [stream.playing || stream.player?.playing || stream.recommended, 'playback', 1],
      [context?.visible === true, 'visible-player', 1],
      [context?.visible === false, 'hidden-player', -3],
      [context?.large === true, 'large-player', 1],
      [stream.width >= 640 || stream.height >= 360 || stream.bitrate >= 500_000, 'video-quality', 1],
      [stream.trackSummary?.video && stream.trackSummary?.audio, 'audio-video', 2],
      [stream.manifestRole === 'master' || stream.quality?.length > 1, 'adaptive-variants', 1],
      [full.test(text), 'full-content-label', 4],
      [preview.test(text) || (!stream.mediaElement && preview.test(path)), 'preview-label', -8],
    ].filter(([present]) => present);
    const score = evidence.reduce((sum, [, , weight]) => sum + weight, 0);
    const delivery = stream.kind === 'm3u8' ? 'browser-or-companion'
      : ['mpd','page'].includes(stream.kind) ? 'companion' : 'direct';
    return {strategies, evidence:evidence.map(([,name]) => name), confidence:score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low',
      delivery, canDownloadDirect:delivery === 'direct', requiresCompanion:delivery === 'companion', score};
  });
}

export function documentBlockers(status, challenged) {
  if (challenged) return ['cloudflare-challenge'];
  const blocker = {401:'login-required', 402:'paywall', 403:'forbidden', 407:'login-required',
    429:'rate-limited', 451:'forbidden'}[status];
  return blocker ? [blocker] : [];
}

export function detectionDiagnostic({selection, blockers = [], players = 0, unloaded = 0, opaque = 0, blockedFrames = 0,
  unsupported = 0, streams = [], excluded = 0, reason} = {}) {
  if (blockers.includes('drm')) blockers = ['drm',...blockers.filter(code => code !== 'drm')];
  const code = streams.length && selection?.status === 'ambiguous' ? 'multiple-candidates'
    : streams.length ? 'media-found'
    : blockers[0] ?? (reason === 'blocked' ? 'forbidden'
      : reason === 'timeout' ? 'timeout'
      : blockedFrames ? 'frame-access'
      : unsupported ? 'unsupported-format'
      : opaque ? 'no-playlist-request'
      : unloaded ? 'media-not-loaded'
      : players ? 'no-playlist-request'
      : excluded ? 'only-ads'
      : 'no-player');
  const nextAction = ({
    'multiple-candidates':'choose-candidate', 'media-not-loaded':'play-in-browser',
    'no-playlist-request':'play-in-browser', 'frame-access':'open-embedded-player',
    'login-required':'sign-in-with-browser', timeout:'allow-more-observation-time',
  })[code] ?? (code === 'media-found' ? 'download' : 'review-page');
  return {code,nextAction,players,unloaded,opaque,blockedFrames,unsupported,excluded,candidateCount:streams.length,
    ...(blockers.length && {blockers})};
}

const diagnosticCodes = new Set(['multiple-candidates','media-found','timeout','frame-access','unsupported-format',
  'no-playlist-request','media-not-loaded','only-ads','no-player',...blockersKnown]);

export function diagnosticReport({diagnostic = {}, streams = []} = {}) {
  const count = key => Number.isSafeInteger(diagnostic[key]) && diagnostic[key] >= 0 ? diagnostic[key] : 0;
  return {
    schema:1,
    diagnostic:{
      code:diagnosticCodes.has(diagnostic.code) ? diagnostic.code : 'no-player',
      players:count('players'), unloaded:count('unloaded'), opaque:count('opaque'), blockedFrames:count('blockedFrames'),
      unsupported:count('unsupported'), excluded:count('excluded'), candidateCount:count('candidateCount'),
      blockers:(Array.isArray(diagnostic.blockers) ? diagnostic.blockers : []).filter(code => blockersKnown.has(code)),
    },
    candidates:streams.slice(0,24).filter(stream => allowedKinds.has(stream.kind)).map((stream) => ({
      kind:stream.kind,
      strategies:(stream.strategies ?? []).filter(name => strategyNames.has(name)),
      ...(Number.isSafeInteger(stream.height) && stream.height >= 1 && stream.height <= 8640 && {height:stream.height}),
    })),
  };
}
