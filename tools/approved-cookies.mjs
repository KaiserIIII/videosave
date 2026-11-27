const validName = /^[!#$%&'*+.\x60^_|~\w-]{1,128}$/;
const validValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,4096}$/;
const securityCookie = /^(?:cf_clearance|__cf_bm|__cflb|cf_chl_|__cf_chl_|_px|datadome|ak_bmsc|bm_sv|bm_sz)/i;

export function approvedCookies(entries) {
  let remaining = 8192;
  const cookies = (Array.isArray(entries) ? entries.slice(0,50) : []).flatMap(cookie => {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
        typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' ||
        !validName.test(cookie.name) || !validValue.test(cookie.value) || securityCookie.test(cookie.name) ||
        !cookie.path.startsWith('/') || cookie.partitionKey || cookie.firstPartyDomain ||
        typeof cookie.secure !== 'boolean' || cookie.expirationDate !== undefined && !Number.isFinite(cookie.expirationDate)) return [];
    const cost = cookie.name.length+cookie.value.length+2;
    if (cost > remaining) return [];
    remaining -= cost;
    return [{name:cookie.name,value:cookie.value,domain:cookie.domain.replace(/^\./,'').toLowerCase(),
      path:cookie.path,secure:cookie.secure,expirationDate:cookie.expirationDate}];
  });
  cookies.sort((left,right) => right.path.length-left.path.length);
  return url => cookies.filter(cookie => {
    if (cookie.domain !== url.hostname || cookie.secure && url.protocol !== 'https:' ||
        cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now()/1000) return false;
    return url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/');
  }).map(({name,value}) => ({name,value}));
}
