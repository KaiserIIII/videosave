// A playback request can contribute only these noncredential headers.
export function playbackHeaders(headers, origin) {
  const safe = {};
  for (const [name,value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[^\x20-\x7e]/.test(value)) continue;
    switch (name.toLowerCase()) {
      case 'user-agent': safe['User-Agent'] = value; break;
      case 'origin':
        if (value === origin) safe.Origin = value;
        break;
      case 'referer': {
        const url = URL.parse(value);
        if (url?.origin === origin && !url.username && !url.password && !url.search && !url.hash) safe.Referer = url.href;
        break;
      }
    }
  }
  return safe;
}
