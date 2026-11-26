export const browserApi = globalThis.browser ?? globalThis.chrome;

const agent = globalThis.navigator?.userAgent ?? '';
export const isFirefox = /Firefox\//.test(agent);
const browserPage = /Edg\//.test(agent) ? 'edge' : /OPR\//.test(agent) ? 'opera' : /Vivaldi\//.test(agent) ? 'vivaldi' : 'chrome';
export const downloadsPage = isFirefox ? null : browserPage + '://downloads/';
export const downloadSettingsPage = isFirefox ? null : browserPage + '://settings/downloads';
