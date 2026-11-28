const I18N = {
  'zh-CN': {
    authTitle: 'VideoSave 本机管理中心',
    authSubtitle: '仅限本机 127.0.0.1 认证访问，请输入终端显示的配对码。',
    pairingLabel: '本机配对码',
    authSubmit: '解锁管理中心',
    navOverview: '总览',
    navNewTask: '解析与新建',
    navQueue: '下载队列',
    navHistory: '已完成文件',
    navMcp: 'MCP 与 AI',
    navSessions: '会话与兼容库',
    navSettings: '引擎与设置',
    themeToggle: '切换主题',
    logout: '锁定',
    refresh: '刷新',
    quickDownload: '快速解析或下载',
    checkUpdates: '检查更新',
    repairRuntime: '一键修复组件',
    exportDiag: '导出脱敏诊断',
    probeNow: '探测可用画质',
    runtimeComponents: '运行组件与平台就绪度',
    telemetryTitle: '实时资源与主机遥测',
    probeHeading: '媒体链接探测与画质验证',
    formatLabel: '封装格式',
    modeLabel: '保存模式',
    conflictLabel: '重名策略',
    qualityLabel: '画质策略',
    templateLabel: '命名模板（可选）',
    startDirect: '直接加入下载队列',
    activeBatches: '下载队列与任务批次',
    diagnosticDetail: '任务诊断与校验报告',
    recentOutputs: '最近保存的媒体文件',
    mcpGenerator: 'AI 客户端 MCP 配置生成器',
    copyConfig: '复制配置',
    registeredClients: '已注册受管客户端',
    activityLog: '最近 MCP 审计记录',
    dedicatedSessions: '专用隔离浏览器会话',
    sessionsNotice: '绝不读取系统浏览器全部 Cookie 或密码，同一会话自动串行加锁。',
    compatRulesTitle: '本地网站兼容性知识库',
    resetRules: '清空学习记录',
    compatPrivacy: '仅记录源站级探测策略与引擎成功率，不存储私人标题或 Cookie。',
    downloadDefaults: '下载默认设置',
    outDirLabel: '默认下载目录',
    concurrencyLabel: '批量并发数',
    connectionsLabel: '单任务连接数',
    saveSettings: '保存设置',
    networkDiag: '网络代理与连通性',
    testNetwork: '检测网络',
    empty: '暂无记录',
  },
  en: {
    authTitle: 'VideoSave Control Center',
    authSubtitle: 'Loopback-only 127.0.0.1 authenticated console. Enter the pairing code shown in your terminal.',
    pairingLabel: 'Local Pairing Code',
    authSubmit: 'Unlock Console',
    navOverview: 'Overview',
    navNewTask: 'Probe & New Task',
    navQueue: 'Download Queue',
    navHistory: 'Saved Files',
    navMcp: 'MCP & AI',
    navSessions: 'Sessions & Rules',
    navSettings: 'Engines & Settings',
    themeToggle: 'Theme',
    logout: 'Lock',
    refresh: 'Refresh',
    quickDownload: 'Quick Probe or Download',
    checkUpdates: 'Check Updates',
    repairRuntime: 'Repair Components',
    exportDiag: 'Export Diagnostics',
    probeNow: 'Probe Qualities',
    runtimeComponents: 'Runtime Components & Platforms',
    telemetryTitle: 'Live Telemetry & Host Windows',
    probeHeading: 'Media URL Probe & Quality Verification',
    formatLabel: 'Container',
    modeLabel: 'Mode',
    conflictLabel: 'Conflict Policy',
    qualityLabel: 'Quality Policy',
    templateLabel: 'Filename Template (optional)',
    startDirect: 'Queue Direct Download',
    activeBatches: 'Download Queue & Batches',
    diagnosticDetail: 'Task Diagnostics & Verification',
    recentOutputs: 'Recently Saved Media',
    mcpGenerator: 'AI Client MCP Config Generator',
    copyConfig: 'Copy Config',
    registeredClients: 'Registered Managed Clients',
    activityLog: 'Recent MCP Audit Activity',
    dedicatedSessions: 'Dedicated Isolated Browser Sessions',
    sessionsNotice: 'Never accesses system browser cookies or passwords. Concurrent tasks per session are serialized.',
    compatRulesTitle: 'Local Site Compatibility Knowledge Base',
    resetRules: 'Reset Rules',
    compatPrivacy: 'Stores origin-level probe strategies and engine metrics only—never private titles or cookies.',
    downloadDefaults: 'Download Defaults',
    outDirLabel: 'Output Directory',
    concurrencyLabel: 'Batch Concurrency',
    connectionsLabel: 'Connections per Item',
    saveSettings: 'Save Settings',
    networkDiag: 'Network Proxy & Connectivity',
    testNetwork: 'Test Network',
    empty: 'No items yet.',
  },
};

let lang = localStorage.getItem('videosave-console-lang') || 'zh-CN';
let theme = localStorage.getItem('videosave-console-theme') || 'dark';
let activeView = 'overview';
let mcpConfigsCache = null;
let pollTimer = null;

const $ = id => document.getElementById(id);

function t(key) {
  return I18N[lang]?.[key] ?? I18N['zh-CN'][key] ?? key;
}

function applyLocaleAndTheme() {
  document.documentElement.lang = lang;
  document.documentElement.dataset.theme = theme;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  const activeNav = document.querySelector(`.nav-item[data-view="${activeView}"]`);
  if (activeNav) $('view-title').textContent = activeNav.textContent;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function api(url, body = null) {
  const res = await fetch(url, body !== null ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : {});
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showAuth();
    throw new Error(data.error?.message || 'Unauthorized');
  }
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

function showAuth() {
  clearInterval(pollTimer);
  $('app').classList.add('hidden');
  $('auth-overlay').classList.remove('hidden');
  $('pairing-input').focus();
}

function showApp() {
  $('auth-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  void refreshAll();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (activeView === 'queue' || activeView === 'overview') void refreshQueueAndOverview();
  }, 3000);
}

function switchView(view) {
  activeView = view;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  for (const sec of document.querySelectorAll('.view')) {
    sec.classList.toggle('active', sec.id === `view-${view}`);
  }
  applyLocaleAndTheme();
  if (view === 'mcp') void loadMcp();
  if (view === 'sessions') void loadSessionsAndCompat();
  if (view === 'settings') void loadSettings();
  if (view === 'history') void loadRecent();
  if (view === 'queue') void loadBatches();
}

function clearAndAppend(container, nodes) {
  container.replaceChildren();
  if (!nodes.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('empty');
    container.appendChild(p);
    return;
  }
  for (const n of nodes) container.appendChild(n);
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function refreshQueueAndOverview() {
  try {
    const [health, runtime, telemetry, batches, storage] = await Promise.all([
      api('/api/health'),
      api('/api/runtime/health'),
      api('/api/telemetry'),
      api('/api/batches?limit=25'),
      api('/api/system/storage').catch(() => null),
    ]);
    $('version-badge').textContent = `v${health.version}`;
    $('health-pill').textContent = runtime.ready ? `Ready · v${health.version}` : 'Setup Required';
    $('health-pill').className = `pill ${runtime.ready ? 'ok' : 'warn'}`;

    const activeCount = batches.items.filter(b => b.status === 'running' || b.status === 'paused').length;
    const resumableCount = batches.items.filter(b => b.resumable).length;
    const freeText = storage?.freeBytes != null ? fmtBytes(storage.freeBytes) : '—';
    const statsData = [
      [lang === 'en' ? 'Active / Resumable' : '进行中 / 可续传', `${activeCount} / ${resumableCount}`],
      [lang === 'en' ? 'Disk Free Space' : '下载盘剩余空间', freeText],
      [lang === 'en' ? 'Companion RSS' : '服务内存占用', fmtBytes(telemetry.memory.rssBytes)],
      [lang === 'en' ? 'Browsers Ready' : '可用浏览器', String(runtime.browsers.length)],
    ];
    clearAndAppend($('overview-stats'), statsData.map(([label, val]) => {
      const card = makeEl('div', 'stat-card');
      card.append(makeEl('div', 'stat-label', label), makeEl('div', 'stat-value', val));
      return card;
    }));

    const compRows = Object.entries(runtime.components).map(([name, info]) => {
      const row = makeEl('div', 'item-row');
      const meta = makeEl('div', 'item-meta');
      meta.append(
        makeEl('div', 'item-title', `${name} (${info.version || info.pinnedVersion || 'n/a'})`),
        makeEl('div', 'muted', `${info.source || 'not installed'}${info.license ? ' · ' + info.license : ''}`),
      );
      const pill = makeEl('span', `pill ${info.status === 'ready' ? 'ok' : info.status === 'optional-not-installed' ? '' : 'warn'}`, info.status);
      row.append(meta, pill);
      return row;
    });
    for (const [plat, info] of Object.entries(runtime.platforms)) {
      const row = makeEl('div', 'item-row');
      const meta = makeEl('div', 'item-meta');
      meta.append(makeEl('div', 'item-title', `Platform: ${plat}`), makeEl('div', 'muted', info.hint));
      row.append(meta, makeEl('span', `pill ${info.status === 'ready' ? 'ok' : 'warn'}`, info.status));
      compRows.push(row);
    }
    clearAndAppend($('runtime-list'), compRows);

    const teleRows = [
      (() => {
        const r = makeEl('div', 'item-row');
        r.append(makeEl('div', 'item-title', 'Heap Used / RSS'), makeEl('span', 'mono', `${fmtBytes(telemetry.memory.heapUsedBytes)} / ${fmtBytes(telemetry.memory.rssBytes)}`));
        return r;
      })(),
      ...telemetry.hosts.map(h => {
        const r = makeEl('div', 'item-row');
        const m = makeEl('div', 'item-meta');
        m.append(makeEl('div', 'item-title mono', h.host), makeEl('div', 'muted', `cwnd ${h.effectiveConcurrency}/${h.maxConcurrency} · avg ${h.avgLatencyMs}ms · ${fmtBytes(h.totalBytes)}`));
        r.append(m, makeEl('span', `pill ${h.throttles ? 'warn' : 'ok'}`, h.throttles ? `429×${h.throttles}` : `${h.successes} ok`));
        return r;
      }),
    ];
    clearAndAppend($('telemetry-panel'), teleRows);

    if (activeView === 'queue') renderBatches(batches.items);
  } catch {}
}

function renderBatches(items) {
  const rows = items.map(b => {
    const row = makeEl('div', 'item-row');
    const meta = makeEl('div', 'item-meta');
    meta.append(
      makeEl('div', 'item-title mono', `${b.id.slice(0, 8)}… · ${b.completed}/${b.total} done${b.resumable ? ' · resumable' : ''}`),
      makeEl('div', 'muted', `${b.createdAt} · delivery=${b.delivery}`),
    );
    const controls = makeEl('div', 'row');
    const statusCls = b.status === 'done' ? 'ok' : b.status === 'failed' ? 'err' : 'warn';
    controls.append(makeEl('span', `pill ${statusCls}`, b.status));

    const addBtn = (label, fn) => {
      const btn = makeEl('button', 'btn small', label);
      btn.addEventListener('click', fn);
      controls.append(btn);
    };
    if (b.status === 'running') addBtn('Pause', () => api(`/api/batch/${b.id}/pause`, {}).then(loadBatches));
    if (b.status === 'paused') addBtn('Resume', () => api(`/api/batch/${b.id}/resume`, {}).then(loadBatches));
    if (b.status === 'running' || b.status === 'paused' || b.resumable) {
      addBtn('Cancel', () => api('/api/cancel', { id: b.id }).then(loadBatches));
    }
    if (b.status === 'done' || b.status === 'partial') {
      addBtn('Verify', () => showDiagnostic(() => api(`/api/batch/${b.id}/verify`, { durationToleranceSec: 1.0 })));
    }
    addBtn('Report', () => showDiagnostic(() => api(`/api/batch/${b.id}/report`)));
    addBtn('Diagnose', () => showDiagnostic(() => api(`/api/batch/${b.id}/diagnose`)));
    if (b.resumable) addBtn('Checkpoints', () => showDiagnostic(() => api(`/api/batch/${b.id}/recover`)));
    row.append(meta, controls);
    return row;
  });
  $('queue-summary').textContent = `${items.length} batches`;
  clearAndAppend($('batch-list'), rows);
}

async function showDiagnostic(loader) {
  $('diag-card').classList.remove('hidden');
  $('diag-json').textContent = 'Loading...';
  try {
    const data = await loader();
    $('diag-json').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $('diag-json').textContent = `Error: ${err.message}`;
  }
}

async function loadBatches() {
  const batches = await api('/api/batches?limit=30');
  renderBatches(batches.items);
}

async function loadRecent() {
  const data = await api('/api/recent');
  $('out-dir-label').textContent = data.dir;
  clearAndAppend($('recent-list'), data.items.map(f => {
    const row = makeEl('div', 'item-row');
    const meta = makeEl('div', 'item-meta');
    meta.append(makeEl('div', 'item-title', f.name), makeEl('div', 'muted', `${fmtBytes(f.size)} · ${new Date(f.mtime).toLocaleString()}`));
    const openBtn = makeEl('button', 'btn small', 'Explorer');
    openBtn.addEventListener('click', () => api('/api/open', { file: f.name }).catch(() => {}));
    row.append(meta, openBtn);
    return row;
  }));
}

async function loadMcp() {
  const [cfgs, clients, acts] = await Promise.all([
    api(`/api/mcp/configs?mode=${encodeURIComponent($('mcp-mode-select').value)}`),
    api('/api/ai/clients'),
    api('/api/ai/activity'),
  ]);
  mcpConfigsCache = cfgs.configs;
  renderSelectedMcpConfig();

  clearAndAppend($('clients-list'), clients.items.map(c => {
    const row = makeEl('div', 'item-row');
    const meta = makeEl('div', 'item-meta');
    meta.append(makeEl('div', 'item-title', c.name), makeEl('div', 'muted', `preset=${c.preset} · scopes=${(c.scopes || []).join(', ')}`));
    row.append(meta, makeEl('span', `pill ${c.disabled ? 'err' : 'ok'}`, c.disabled ? 'disabled' : 'active'));
    return row;
  }));

  clearAndAppend($('activity-list'), (acts.items || []).slice(0, 15).map(a => {
    const row = makeEl('div', 'item-row');
    const meta = makeEl('div', 'item-meta');
    meta.append(makeEl('div', 'item-title mono', `${a.tool} · ${a.result}`), makeEl('div', 'muted', `${a.at || ''} ${a.origin || ''}`));
    row.append(meta);
    return row;
  }));
}

function renderSelectedMcpConfig() {
  if (!mcpConfigsCache) return;
  const key = $('mcp-client-select').value;
  const entry = mcpConfigsCache[key];
  if (!entry) return;
  $('mcp-target-path').textContent = `${entry.format.toUpperCase()} · ${entry.suggestedPath}${entry.cliCommand ? ' · CLI: ' + entry.cliCommand : ''}`;
  $('mcp-config-code').textContent = entry.content;
}

async function loadSessionsAndCompat() {
  const [sess, compat] = await Promise.all([
    api('/api/browser-sessions', { action: 'status' }),
    api('/api/ai/compatibility'),
  ]);
  clearAndAppend($('sessions-list'), (sess.sessions || []).map(s => {
    const row = makeEl('div', 'item-row');
    const meta = makeEl('div', 'item-meta');
    meta.append(
      makeEl('div', 'item-title', `${s.id} (${s.diagnosticState})`),
      makeEl('div', 'muted', `cookies=${s.hasCookies} · origins=${(s.authorizedOrigins || []).join(', ') || 'none'}`),
    );
    const resetBtn = makeEl('button', 'btn small', 'Reset');
    resetBtn.addEventListener('click', () => api('/api/browser-sessions', { browserSessionId: s.id, action: 'reset' }).then(loadSessionsAndCompat));
    row.append(meta, makeEl('span', `pill ${s.usable ? 'ok' : 'warn'}`, s.usable ? 'usable' : s.diagnosticState), resetBtn);
    return row;
  }));
  clearAndAppend($('compat-list'), (compat.items || []).map(r => {
    const row = makeEl('div', 'item-row');
    const meta = makeEl('div', 'item-meta');
    meta.append(
      makeEl('div', 'item-title mono', r.origin),
      makeEl('div', 'muted', `probe=${r.preferred} · engine=${r.bestEngine || 'auto'} · ${r.successes}/${r.samples} ok · avg ${r.averageMs ?? '-'}ms`),
    );
    row.append(meta);
    return row;
  }));
}

async function loadSettings() {
  const [s, net] = await Promise.all([api('/api/settings'), api('/api/ai/network')]);
  $('set-outdir').value = s.settings.outDir || '';
  $('set-concurrency').value = s.settings.concurrency || 2;
  $('set-connections').value = String(s.settings.connections || 8);
  clearAndAppend($('network-info'), [
    (() => {
      const r = makeEl('div', 'item-row');
      r.append(makeEl('div', 'item-title', 'Configured / Effective Mode'), makeEl('span', 'pill ok', `${net.configured.mode} → ${net.effective.mode}`));
      return r;
    })(),
  ]);
}

async function runProbe(url) {
  const out = $('probe-output');
  out.classList.remove('hidden');
  out.textContent = 'Probing & verifying candidate qualities...';
  try {
    const res = await api('/api/probe', { url, compatibility: $('probe-compat').value, includeFrames: true, captureXhrBody: true });
    out.replaceChildren();
    const head = makeEl('div', 'row');
    head.append(
      makeEl('span', `pill ${res.selection?.status === 'selected' ? 'ok' : 'warn'}`, `selection: ${res.selection?.status || 'unknown'}`),
      makeEl('span', 'muted', res.pageTitle || url),
    );
    out.append(head);

    const qualities = res.qualities || [];
    if (qualities.length) {
      const qList = makeEl('div', 'list');
      for (const q of qualities) {
        const row = makeEl('div', 'item-row');
        const meta = makeEl('div', 'item-meta');
        meta.append(
          makeEl('div', 'item-title', `${q.height}p ${q.codec || ''} · ${Math.round((q.bandwidth || 0) / 1000)} kbps`),
          makeEl('div', 'muted', `method=${q.verificationMethod || 'manifest'} · HTTP ${q.probeStatus ?? '-'}`),
        );
        const cls = q.availability === 'available' ? 'ok' : q.availability === 'restricted' ? 'warn' : 'err';
        row.append(meta, makeEl('span', `pill ${cls}`, q.availability || (q.available ? 'available' : 'unavailable')));
        qList.append(row);
      }
      out.append(qList);
    }

    if (res.selection?.url) {
      const dlBtn = makeEl('button', 'btn primary', `Download Selected (${$('dl-quality').value})`);
      dlBtn.addEventListener('click', async () => {
        const rawQ = $('dl-quality').value;
        const quality = /^\d+$/.test(rawQ) ? Number(rawQ) : rawQ;
        const targetKind = res.downloadTargets?.length ? 'page' : 'stream';
        await api('/api/queue', {
          items: [{
            kind: targetKind,
            url: res.selection.url,
            title: res.pageTitle || undefined,
            format: $('dl-format').value,
            mode: $('dl-mode').value,
            quality,
            conflictAction: $('dl-conflict').value,
            ...($('dl-template').value.trim() && { filenameTemplate: $('dl-template').value.trim() }),
          }],
        });
        switchView('queue');
      });
      out.append(dlBtn);
    }
  } catch (err) {
    out.textContent = `Probe failed: ${err.message}`;
  }
}

async function refreshAll() {
  await refreshQueueAndOverview();
  if (activeView === 'queue') await loadBatches();
  if (activeView === 'history') await loadRecent();
  if (activeView === 'mcp') await loadMcp();
  if (activeView === 'sessions') await loadSessionsAndCompat();
  if (activeView === 'settings') await loadSettings();
}

$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('auth-error').classList.add('hidden');
  try {
    await api('/api/console/auth', { pairingCode: $('pairing-input').value.trim() });
    $('pairing-input').value = '';
    showApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/console/logout', { method: 'POST' }).catch(() => {});
  showAuth();
});
$('refresh-btn').addEventListener('click', () => void refreshAll());
$('lang-toggle').addEventListener('click', () => {
  lang = lang === 'zh-CN' ? 'en' : 'zh-CN';
  localStorage.setItem('videosave-console-lang', lang);
  applyLocaleAndTheme();
});
$('theme-toggle').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('videosave-console-theme', theme);
  applyLocaleAndTheme();
});
for (const btn of document.querySelectorAll('.nav-item')) {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
}
$('quick-form').addEventListener('submit', e => {
  e.preventDefault();
  const url = $('quick-url').value.trim();
  if (!url) return;
  $('probe-url').value = url;
  switchView('new-task');
  void runProbe(url);
});
$('probe-form').addEventListener('submit', e => {
  e.preventDefault();
  void runProbe($('probe-url').value.trim());
});
$('start-direct-btn').addEventListener('click', async () => {
  const url = $('probe-url').value.trim();
  if (!url) return;
  const rawQ = $('dl-quality').value;
  const quality = /^\d+$/.test(rawQ) ? Number(rawQ) : rawQ;
  await api('/api/queue', {
    items: [{
      kind: /\.(?:m3u8|mpd|mp4|mkv|webm|mov|flv|m4a|mp3)(?:$|\?)/i.test(url) ? 'stream' : 'page',
      url,
      format: $('dl-format').value,
      mode: $('dl-mode').value,
      quality,
      conflictAction: $('dl-conflict').value,
      ...($('dl-template').value.trim() && { filenameTemplate: $('dl-template').value.trim() }),
    }],
  });
  switchView('queue');
});
$('close-diag').addEventListener('click', () => $('diag-card').classList.add('hidden'));
$('mcp-client-select').addEventListener('change', renderSelectedMcpConfig);
$('mcp-mode-select').addEventListener('change', () => void loadMcp());
$('copy-mcp-btn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('mcp-config-code').textContent).catch(() => {});
});
$('reset-compat-btn').addEventListener('click', async () => {
  await api('/api/ai/compatibility', { action: 'reset' });
  await loadSessionsAndCompat();
});
$('settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  await api('/api/settings', {
    settings: {
      outDir: $('set-outdir').value.trim(),
      concurrency: Number($('set-concurrency').value),
      connections: Number($('set-connections').value),
    },
  });
  $('settings-msg').textContent = lang === 'en' ? 'Saved.' : '已保存。';
});
$('check-net-btn').addEventListener('click', async () => {
  const res = await api('/api/ai/network/check');
  clearAndAppend($('network-info'), [
    (() => {
      const r = makeEl('div', 'item-row');
      r.append(makeEl('div', 'item-title', 'Connectivity Check'), makeEl('span', `pill ${res.ok ? 'ok' : 'err'}`, res.ok ? `${res.elapsedMs} ms` : res.code || 'failed'));
      return r;
    })(),
  ]);
});

function showActionBanner(text, ok = true) {
  const banner = $('action-banner');
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove('hidden');
  banner.style.borderColor = ok ? '#10b981' : '#ef4444';
}

$('check-updates-btn')?.addEventListener('click', async () => {
  showActionBanner(lang === 'en' ? 'Checking official GitHub Releases...' : '正在检查官方 GitHub Release 更新...');
  try {
    const info = await api('/api/updates/check');
    showActionBanner(
      info.updateAvailable
        ? (lang === 'en' ? `New version v${info.latestVersion} available (current v${info.currentVersion}): ${info.releaseUrl}` : `发现官方新版本 v${info.latestVersion}（当前 v${info.currentVersion}）：${info.releaseUrl}`)
        : (lang === 'en' ? `Up to date (v${info.currentVersion}, latest v${info.latestVersion}).` : `当前已是最新正式版（v${info.currentVersion}）。`),
      true,
    );
  } catch (err) {
    showActionBanner(`Update check failed: ${err.message}`, false);
  }
});

$('repair-runtime-btn')?.addEventListener('click', async () => {
  showActionBanner(lang === 'en' ? 'Verifying/installing pinned platform extractor (yt-dlp)...' : '正在校验/安装官方固定版本平台组件（yt-dlp）...');
  try {
    const res = await api('/api/runtime/repair', {});
    showActionBanner(lang === 'en' ? `Runtime verified: ${res.detail}` : `平台组件已就绪：${res.detail}`, true);
    await refreshQueueAndOverview();
  } catch (err) {
    showActionBanner(`Repair failed: ${err.message}`, false);
  }
});

$('export-diag-btn')?.addEventListener('click', async () => {
  try {
    const bundle = await api('/api/diagnostics/export');
    const jsonText = JSON.stringify(bundle, null, 2);
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `videosave-diagnostics-${bundle.version}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showActionBanner(lang === 'en' ? 'Sanitized diagnostic report downloaded (zero credentials/paths).' : '已导出脱敏诊断报告（不含任何凭据或个人路径）。', true);
  } catch (err) {
    showActionBanner(`Diagnostic export failed: ${err.message}`, false);
  }
});

applyLocaleAndTheme();
api('/api/health').then(() => showApp()).catch(() => showAuth());
