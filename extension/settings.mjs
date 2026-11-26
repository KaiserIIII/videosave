export const defaultConcurrency = 24;
export const maxConcurrency = 64;

export const defaults = {mode:'combined', quality:'', format:'auto', audioFormat:'m4a', subtitles:false,
  concurrency:defaultConcurrency, concurrencyVersion:2, connections:8, accelerate:true, saveAs:false,
  downloadFolder:'', fastStart:true, naming:'title', theme:'system', accent:'', density:'comfortable',
  autoScan:true, showHost:false, showSize:true, sizeLookup:true, preview:'click', previewSeconds:6,
  showThumbnails:true, startPanel:'videos', conflictAction:'uniquify'};

export function validConcurrency(value) {
  return Number.isInteger(value) && value >= 1 && value <= maxConcurrency;
}

export function downloadFolder(value) {
  const fieldError = '请输入 Edge 下载目录下的文件夹，例如 视频/教程';
  if (typeof value !== 'string') throw new Error(fieldError);
  const folder = value.trim().replace(/\\/g, '/');
  if (!folder) return '';
  if (folder.length > 100 || folder.split('/').some(part => !part || part.startsWith(' ') ||
    /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?=\.|$)/i.test(part))) {
    throw new Error(fieldError);
  }
  return folder;
}

export function readDownloadSettings(saved) {
  const settings = {...defaults, ...saved};
  const oldDefault = !saved?.concurrencyVersion && settings.concurrency === 2 ||
    saved?.concurrencyVersion === 1 && settings.concurrency === 10;
  if (!validConcurrency(settings.concurrency) || oldDefault) {
    settings.concurrency = defaultConcurrency;
  }
  settings.concurrencyVersion = defaults.concurrencyVersion;
  return settings;
}
