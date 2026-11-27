import { browserApi } from './browser.mjs';
import { companion } from './downloads.mjs';

const keyFor = id => 'mcp-tab:' + id;
const cleanUrl = value => {
  const url = URL.parse(value ?? '');
  return url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
};

export function startTabGrantCleanup() {
  const revoke = async tabId => {
    const key = keyFor(tabId);
    const [session,local] = await Promise.all([browserApi.storage.session.get(key),browserApi.storage.local.get('connection')]);
    const ids = session[key] ?? [];
    if (!ids.length) return;
    await browserApi.storage.session.remove(key);
    await Promise.allSettled(ids.map(id => companion(local.connection,'/api/ai/revoke',{id})));
  };
  const invalidate = id => { void revoke(id).catch(() => {}); };
  browserApi.tabs.onRemoved.addListener(invalidate);
  browserApi.tabs.onUpdated.addListener((id,change) => {
    if (change.url || change.status === 'loading') invalidate(id);
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
    const current = await browserApi.tabs.get(tab.id);
    const page = cleanUrl(current.url);
    const snapshot = getSnapshot();
    if (page?.origin !== grant.origin || snapshot.url !== current.url || snapshot.restricted) {
      throw new Error(label('请打开申请的网站，完成正常播放并扫描后再批准。','Open the requested site, play the media normally, and scan before approving.'));
    }
    const streams = snapshot.streams.flatMap(stream => [stream,...(stream.alternates ?? [])]).filter(stream => {
      const source = cleanUrl(stream.url);
      return source?.origin === page.origin && !source.search && !source.hash && !stream.drm && !stream.restricted;
    }).slice(0,40).map(({url,kind,duration,height}) => ({url,kind,duration,height}));
    const key = keyFor(tab.id);
    const previous = (await browserApi.storage.session.get(key))[key] ?? [];
    await browserApi.storage.session.set({[key]:[...new Set([...previous.slice(-49),grant.id])]});
    await call('approve',{id:grant.id,minutes:Number(byId('mcp-duration').value),
      tab:{url:page.origin,title:snapshot.title,playing:snapshot.playing,streams}});
    const after = await browserApi.tabs.get(tab.id).catch(() => null);
    if (after?.url !== current.url) {
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
