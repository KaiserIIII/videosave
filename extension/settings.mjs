export const defaultConcurrency = 24;
export const maxConcurrency = 64;
export const interfaceLanguages = ['system', 'zh-CN', 'en'];

export const defaults = {mode:'combined', quality:'', format:'auto', audioFormat:'m4a', subtitles:false,
  concurrency:defaultConcurrency, concurrencyVersion:2, connections:8, accelerate:true, saveAs:false,
  downloadFolder:'', fastStart:true, naming:'title', theme:'system', accent:'', density:'comfortable',
  autoScan:true, showHost:false, showSize:true, sizeLookup:true, preview:'click', previewSeconds:6,
  showThumbnails:true, startPanel:'videos', conflictAction:'uniquify', language:'system'};

export function interfaceLanguage(language, browserLanguage) {
  if (language === 'zh-CN' || language === 'en') return language;
  return /^zh(?:-|$)/i.test(browserLanguage) ? 'zh-CN' : 'en';
}

export function validConcurrency(value) {
  return Number.isInteger(value) && value >= 1 && value <= maxConcurrency;
}

export function downloadFolder(value, maxLength = 100) {
  const fieldError = '请输入浏览器下载目录下的文件夹，例如 视频/教程';
  if (typeof value !== 'string') throw new Error(fieldError);
  const folder = value.trim().replace(/\\/g, '/');
  if (!folder) return '';
  if (folder.length > maxLength || folder.split('/').some(part => !part || part.startsWith(' ') ||
    /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?=\.|$)/i.test(part))) {
    throw new Error(fieldError);
  }
  return folder;
}

export function settingsBackup(saved) {
  const current = readDownloadSettings(saved);
  return {schema:1, settings:Object.fromEntries(Object.keys(defaults).map(key => [key,current[key]]))};
}

export function restoreSettingsBackup(backup, choices = {}) {
  if (backup?.schema !== 1 || !backup.settings || typeof backup.settings !== 'object' ||
      Array.isArray(backup.settings)) throw new Error('设置文件格式不受支持');
  const settings = {...defaults};
  for (const [key,value] of Object.entries(backup.settings)) {
    if (!Object.hasOwn(defaults,key) || key === 'concurrencyVersion') continue;
    if (key === 'downloadFolder') {
      settings[key] = downloadFolder(value);
      continue;
    }
    let valid = typeof value === typeof defaults[key];
    if (key === 'concurrency') valid &&= validConcurrency(value);
    if (key === 'accent') valid &&= /^(?:#[a-f0-9]{6})?$/i.test(value);
    if (Object.hasOwn(choices,key)) valid &&= choices[key].includes(String(value));
    if (!valid) throw new Error('设置文件包含无效的选项');
    settings[key] = value;
  }
  return settings;
}

export function readDownloadSettings(saved) {
  const settings = {...defaults, ...saved};
  const oldDefault = !saved?.concurrencyVersion && settings.concurrency === 2 ||
    saved?.concurrencyVersion === 1 && settings.concurrency === 10;
  if (!validConcurrency(settings.concurrency) || oldDefault) {
    settings.concurrency = defaultConcurrency;
  }
  settings.concurrencyVersion = defaults.concurrencyVersion;
  if (!interfaceLanguages.includes(settings.language)) settings.language = defaults.language;
  return settings;
}
