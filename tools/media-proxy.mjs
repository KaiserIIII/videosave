import http from 'node:http';

export function configureMediaProxy() {
  if (!http.setGlobalProxyFromEnv || process.env.NODE_USE_ENV_PROXY === '0') return;
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return;
  const bypass = (process.env.no_proxy ?? process.env.NO_PROXY)?.trim();
  try {
    http.setGlobalProxyFromEnv({
      http_proxy:httpProxy,
      https_proxy:httpsProxy,
      no_proxy:bypass === '*' ? bypass : [bypass, 'localhost', '127.0.0.1', '[::1]'].filter(Boolean).join(','),
    });
  } catch (error) {
    if (error.code !== 'ERR_PROXY_INVALID_CONFIG') throw error;
    console.error('VideoSave ignored invalid proxy settings. Check HTTP_PROXY and HTTPS_PROXY.');
  }
}
