import { browserApi } from './browser.mjs';
import { companion } from './downloads.mjs';
import { importedCookies, maxCredentialFileBytes } from './session-credentials.mjs';

const grantPrefix = 'mcp-grant:';
const grantAlarm = 'mcp-tab-authorizations';
const cleanUrl = value => {
  const url = URL.parse(value ?? '');
  return url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
};

async function getTabCookies(tabId, candidates) {
  const stores = await browserApi.cookies.getAllCookieStores();
  const store = stores.find(entry => entry.tabIds.includes(tabId));
  if (!store) throw new Error('The current tab’s cookie store is unavailable.');
  const cookies = new Map();
  await Promise.all(candidates.filter(stream => !['m3u8','mpd'].includes(stream.kind)).map(async stream => {
    const hostname = new URL(stream.url).hostname;
    const entries = await browserApi.cookies.getAll({url:stream.url,storeId:store.id});
    cookies.set(stream.url,entries.filter(item => item.domain.replace(/^\./,'') === hostname).slice(0,20));
  }));
  return cookies;
}

async function cookieState(tabId, candidates) {
  const cookies = await getTabCookies(tabId,candidates);
  const bytes = new TextEncoder().encode(JSON.stringify([...cookies].sort(([left],[right]) => left.localeCompare(right))));
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  return {cookies,digest:Array.from(new Uint8Array(digest)).join(',')};
}

async function tabDocument(tabId) {
  const [result] = await browserApi.scripting.executeScript({
    target:{tabId},func:() => ({url:location.href,timeOrigin:performance.timeOrigin}),
  });
  return result?.result && {...result.result,id:result.documentId ?? null};
}

function sameDocument(left,right) {
  return left && right && left.url === right.url && left.timeOrigin === right.timeOrigin && left.id === right.id;
}

export function startTabGrantCleanup() {
  async function reconcile(tabId, forceRevoke = false) {
    const [session,local] = await Promise.all([browserApi.storage.session.get(null),browserApi.storage.local.get('connection')]);
    const grants = Object.entries(session).filter(([key,value]) => key.startsWith(grantPrefix) && (tabId === undefined || tabId === value.tabId));
    await Promise.allSettled(grants.map(async ([key,{tabId,document,expiresAt,sessionScope}]) => {
      const id = key.slice(grantPrefix.length);
      if (expiresAt <= Date.now()) return browserApi.storage.session.remove(key);
      const current = forceRevoke ? null : await tabDocument(tabId).catch(() => null);
      const valid = sameDocument(current,document) && (!sessionScope ||
        (await cookieState(tabId,sessionScope.candidates).catch(() => null))?.digest === sessionScope.digest);
      try {
        const grant = await companion(local.connection,valid ? '/api/ai/renew' : '/api/ai/revoke',{id});
        if (grant.status !== 'approved') await browserApi.storage.session.remove(key);
      } catch (error) {
        if (error.status === 404) await browserApi.storage.session.remove(key);
      }
    }));
  }
  const invalidate = id => { void reconcile(id,true).catch(() => {}); };
  browserApi.tabs.onRemoved.addListener(invalidate);
  browserApi.tabs.onUpdated.addListener((id,change) => {
    if (change.url || change.status === 'loading') invalidate(id);
  });
  browserApi.alarms.onAlarm.addListener(event => {
    if (event.name === grantAlarm) void reconcile().catch(() => {});
  });
}

function node(tag,text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function bindMcpCenter({root,translate,getConnection,getTab,getSnapshot,saveJson}) {
  const byId = id => root.querySelector('#' + id);
  const label = (zh,en) => translate(zh,en);
  const message = byId('mcp-message');
  const alert = value => { message.textContent = value; };
  const call = (name,data) => companion(getConnection(),'/api/ai/' + name,data);
  const ownOrigin = () => cleanUrl(getTab()?.url)?.origin;
  const preset = byId('mcp-preset');
  const profileName = byId('mcp-client-name');
  let selectedId;
  let selectedClient;
  let configText;
  let epoch = 0;
  const scopes = [...root.querySelectorAll('[data-mcp-scope]')];

  function safeClick(button,work) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await work(); }
      catch (error) { alert(error.message); }
      finally { button.disabled = false; }
    });
  }
  function inlineButton(zh,en,work) {
    const button = node('button',label(zh,en));
    button.type = 'button';
    button.className = 'quiet';
    safeClick(button,work);
    return button;
  }
  async function loadClient(client) {
    selectedId = client.id;
    selectedClient = client;
    configText = undefined;
    profileName.value = client.name;
    preset.value = client.preset;
    for (const scope of scopes) scope.checked = client.scopes.includes(scope.value);
    byId('mcp-scopes').hidden = client.preset !== 'custom';
    byId('mcp-editing').textContent = client.name;
    const config = await call('config?id=' + encodeURIComponent(client.id)).catch(() => null);
    if (selectedId === client.id && config) configText = JSON.stringify(config,null,2);
  }

  async function approve(grant) {
    const tab = getTab();
    if (!tab?.id) throw new Error(label('请打开申请的网站。','Open the requested site.'));
    const shareBrowser = byId('mcp-share-session').checked;
    const raw = byId('mcp-session-text').value;
    const file = byId('mcp-session-file').files[0];
    if (Number(Boolean(file)) + Number(Boolean(raw)) + Number(shareBrowser) > 1) {
      throw new Error(label('请选择一种登录会话来源。','Choose one login session source.'));
    }
    if (shareBrowser && cleanUrl(tab.url)?.origin === grant.origin) {
      const allowed = await browserApi.permissions.request({permissions:['cookies']});
      if (!allowed) throw new Error(label('浏览器未授予 Cookie 权限。','The browser did not grant cookie permission.'));
    }
    const current = await browserApi.tabs.get(tab.id);
    const document = await tabDocument(tab.id);
    const page = cleanUrl(current.url);
    const snapshot = getSnapshot();
    if (page?.origin !== grant.origin || !sameDocument(snapshot.document,document) || document?.url !== current.url || snapshot.restricted) {
      throw new Error(label('请打开申请的网站，完成正常播放并扫描后再批准。','Open the requested site, play the media normally, and scan before approving.'));
    }
    const streams = snapshot.streams.flatMap(stream => [stream,...(stream.alternates ?? [])]).filter(stream => {
      const source = cleanUrl(stream.url);
      return source?.origin === page.origin && !source.search && !source.hash && !stream.drm && !stream.restricted;
    }).slice(0,40).map(({url,kind,duration,height,observed,frameId}) => ({url,kind,duration,height,observed,frameId}));
    const sessionCandidates = streams.filter(stream => stream.observed && stream.frameId === 0)
      .map(({url,kind}) => ({url,kind}));
    if (file?.size > maxCredentialFileBytes) throw new Error(label('Cookie 文件超过 64 KB。','The cookie file exceeds 64 KB.'));
    const state = shareBrowser ? await cookieState(tab.id,sessionCandidates) : null;
    const manual = file || raw ? await (async () => {
      try { return importedCookies(file ? await file.text() : raw,page,{file:Boolean(file)}); }
      catch { throw new Error(label('本站 Cookie 格式无效或已过期。','The cookies for this site are invalid or expired.')); }
    })() : null;
    const sessionScope = state && {digest:state.digest,candidates:sessionCandidates};
    if (state) for (const stream of streams) stream.cookies = state.cookies.get(stream.url);
    if (manual) for (const stream of streams) {
      if (stream.observed && stream.frameId === 0 && !['m3u8','mpd'].includes(stream.kind)) stream.cookies = manual;
    }
    for (const stream of streams) {
      delete stream.observed;
      delete stream.frameId;
    }
    byId('mcp-share-session').checked = false;
    byId('mcp-session-text').value = '';
    byId('mcp-session-file').value = '';
    const singleTask = byId('mcp-single-task').checked;
    byId('mcp-single-task').checked = false;
    const minutes = Number(byId('mcp-duration').value);
    const key = grantPrefix + grant.id;
    await browserApi.storage.session.set({[key]:{tabId:tab.id,document,sessionScope,expiresAt:Date.now()+minutes*60_000+6500}});
    if (!await browserApi.alarms.get(grantAlarm)) await browserApi.alarms.create(grantAlarm,{periodInMinutes:0.5});
    await call('approve',{id:grant.id,minutes,shareSession:Boolean(shareBrowser || manual),singleTask,
      tab:{url:page.origin,title:snapshot.title,playing:snapshot.playing,diagnostic:snapshot.diagnostic,streams}});
    if (!sameDocument(await tabDocument(tab.id).catch(() => null),document)) {
      await call('revoke',{id:grant.id});
      throw new Error(label('页面已变化，请重新申请。','The page changed. Request authorization again.'));
    }
    await refresh();
  }

  const policyFields = [...root.querySelectorAll('[data-mcp-policy]')];
  function renderPolicy(settings) {
    const form = byId('mcp-policy');
    form.hidden = !settings;
    if (!settings) return;
    for (const field of policyFields) {
      const value = settings[field.dataset.mcpPolicy];
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value;
    }
  }

  async function refresh() {
    const turn = ++epoch;
    const origin = ownOrigin();
    const [health,clients,grants,audit,policy] = await Promise.all([
      companion(getConnection(),'/api/health'),call('clients'),call('authorizations'),call('activity'),
      origin ? call('site?origin=' + encodeURIComponent(origin)) : null,
    ]);
    if (turn !== epoch) return;
    alert(label('本机服务已连接 · ','Companion connected · ') + health.version);
    byId('mcp-clients').replaceChildren(...clients.items.map(client => {
      const row = node('li');
      row.append(node('strong',client.name),node('small',({ 'read-only':label('只读','Read only'),standard:label('标准下载','Standard downloads'),custom:label('自定义','Custom') })[client.preset]),
        inlineButton('编辑','Edit',() => loadClient(client)),
        inlineButton(client.disabled ? '启用' : '停用',client.disabled ? 'Enable' : 'Disable',
          async () => { await call('clients',{id:client.id,disabled:!client.disabled}); await refresh(); }));
      return row;
    }));
    byId('mcp-grants').replaceChildren(...grants.items.filter(item => ['pending','approved'].includes(item.status)).map(grant => {
      const row = node('li');
      row.append(node('strong',grant.origin),node('small',grant.clientName + ' · ' + (grant.status === 'approved' ? label('已授权','Approved') : label('待确认','Pending')) +
        ' · ' + new Date(grant.expiresAt).toLocaleTimeString()));
      if (grant.status === 'pending' && grant.origin === origin) row.append(inlineButton('授权当前页','Approve current tab',() => approve(grant)));
      row.append(inlineButton(grant.status === 'pending' ? '拒绝' : '撤销',grant.status === 'pending' ? 'Deny' : 'Revoke',
        async () => { await call('revoke',{id:grant.id}); await refresh(); }));
      return row;
    }));
    byId('mcp-audit-enabled').checked = audit.settings.enabled;
    byId('mcp-audit-days').value = audit.settings.days;
    byId('mcp-activity').replaceChildren(...audit.items.slice(0,20).map(item => {
      const client = clients.items.find(profile => profile.id === item.client);
      const row = node('li');
      row.append(node('strong',item.tool + ' · ' + item.result),
        node('small',new Date(item.time).toLocaleString() + ' · ' + (client?.name ?? item.client) + (item.origin ? ' · ' + item.origin : '')));
      return row;
    }));
    byId('mcp-policy-origin').textContent = origin ?? label('请打开网页','Open a web page');
    renderPolicy(policy?.settings);
  }

  safeClick(byId('mcp-refresh'),refresh);
  safeClick(byId('mcp-save-client'),async () => {
    const scopesSelected = scopes.filter(input => input.checked).map(input => input.value);
    const extendsPermissions = selectedClient && (preset.value === 'standard' && selectedClient.preset !== 'standard' ||
      preset.value === 'custom' && scopesSelected.some(scope => !selectedClient.scopes.includes(scope)));
    if (extendsPermissions && !globalThis.confirm(label('确认扩大此客户端权限？','Expand permissions for this client?'))) return;
    const client = await call('clients',{id:selectedId,name:profileName.value,preset:preset.value,
      ...(preset.value === 'custom' && {scopes:scopesSelected})});
    await refresh();
    await loadClient(client);
  });
  safeClick(byId('mcp-new-client'),() => {
    selectedId = undefined;
    selectedClient = undefined;
    configText = undefined;
    profileName.value = '';
    preset.value = 'read-only';
    byId('mcp-editing').textContent = '';
    byId('mcp-scopes').hidden = true;
    profileName.focus();
  });
  preset.addEventListener('change',() => { byId('mcp-scopes').hidden = preset.value !== 'custom'; });
  safeClick(byId('mcp-copy-command'),async () => {
    if (!selectedId) throw new Error(label('先保存或选择客户端。','Save or select a client first.'));
    const command = '& ".\\Start VideoSave.cmd" -McpConfig -SharedQueue -McpClient ' + selectedId;
    await navigator.clipboard.writeText(configText ?? command);
    alert(configText ? label('已复制 MCP 配置。','MCP configuration copied.')
      : label('已复制配置生成命令。','Configuration command copied.'));
  });
  safeClick(byId('mcp-save-policy'),async () => {
    const settings = Object.fromEntries(policyFields.map(field => [
      field.dataset.mcpPolicy,field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value,
    ]));
    settings.connections = Number(settings.connections);
    await call('site',{origin:ownOrigin(),settings});
    await refresh();
  });
  safeClick(byId('mcp-save-audit'),async () => {
    await call('activity',{enabled:byId('mcp-audit-enabled').checked,days:Number(byId('mcp-audit-days').value)});
    await refresh();
  });
  safeClick(byId('mcp-export-audit'),async () => saveJson('videosave-mcp-activity.json',await call('activity')));
  safeClick(byId('mcp-clear-audit'),async () => {
    if (!globalThis.confirm(label('清除本机 MCP 活动记录？','Clear local MCP activity records?'))) return;
    await call('activity',{clear:true});
    await refresh();
  });
  root.addEventListener('toggle',() => {
    if (root.open) void refresh().catch(error => alert(error.message));
  });
}
