export const maxCredentialFileBytes = 64 * 1024;
const invalid = () => new Error('Invalid site credentials');

export function importedCookies(text, origin, {file = false} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > maxCredentialFileBytes) throw invalid();
  const domain = origin.hostname;
  if (!file) {
    if (/[^\x20-\x7e]/.test(text)) throw invalid();
    return text.split(';').filter(pair => pair.trim()).slice(0,20).map(pair => {
      const match = /^([!#$%&'*+.\x60^_|~\w-]{1,128})=([^;]*)$/.exec(pair.trim());
      if (!match) throw invalid();
      return {name:match[1],value:match[2],domain,path:'/',secure:origin.protocol === 'https:'};
    });
  }
  const cookies = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#HttpOnly_/,'');
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    const [host,subdomains,path,secure,expires,name,value] = parts;
    if (host?.replace(/^\./,'').toLowerCase() !== domain) continue;
    if (parts.length !== 7 || !['TRUE','FALSE'].includes(subdomains) || !['TRUE','FALSE'].includes(secure) ||
        !path.startsWith('/') || !/^\d+$/.test(expires) || !Number.isSafeInteger(Number(expires))) throw invalid();
    if (expires !== '0' && Number(expires) <= Date.now()/1000) continue;
    cookies.push({domain,path,secure:secure === 'TRUE',name,value,...(expires !== '0' && {expirationDate:Number(expires)})});
    if (cookies.length === 20) break;
  }
  if (!cookies.length) throw invalid();
  return cookies;
}
