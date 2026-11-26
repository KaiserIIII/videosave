export const browserApi = globalThis.browser ?? globalThis.chrome;

const agent = globalThis.navigator?.userAgent ?? '';
export const isFirefox = /Firefox\//.test(agent);
export const isAndroid = /Android/.test(agent);
export const nativeDownloads = Boolean(browserApi?.downloads?.download && browserApi.downloads.onChanged);
const browserPage = /Edg\//.test(agent) ? 'edge' : /OPR\//.test(agent) ? 'opera' : /Vivaldi\//.test(agent) ? 'vivaldi' : 'chrome';
export const downloadsPage = isFirefox || isAndroid ? null : browserPage + '://downloads/';
export const downloadSettingsPage = isFirefox || isAndroid ? null : browserPage + '://settings/downloads';
