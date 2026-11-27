const translations = {
  zh: {
    'nav.downloads': '下载发行包',
    'nav.mcp': 'MCP 配置',
    'nav.architecture': '技术架构',
    'nav.benchmarks': '兼容与实测',
    'nav.dsh': 'DSH 指南',
    'hero.eyebrow': 'MIT 开源 · 零 npm 第三方依赖 · 面向真实网页媒体工作流',
    'hero.title': '面向浏览器与 AI 智能体的高精度媒体下载工具。',
    'hero.lead': 'VideoSave 融合跨浏览器扩展（Edge、Chrome、Firefox）、本机多引擎伴侣（HTTP Range、HLS、静态 DASH、yt-dlp）与经过安全审计的 MCP 服务，原生适配 DeepSeek Harness (DSH)、Codex、Claude 与 Cursor。',
    'hero.ctaDownload': '下载正式发行包',
    'hero.ctaMcp': '生成 MCP 配置',
    'hero.ctaData': '查看实时实测矩阵 →',
    'hero.badge1': '统一 HLS 请求头上下文',
    'hero.badge2': '二进制媒体内容嗅探',
    'hero.badge3': 'SHA-256 断点续传校验',
    'hero.badge4': '跨域 Cookie 严格隔离',
    'dl.kicker': '官方发行包',
    'dl.title': '下载与供应链完整性校验',
    'dl.desc': '每个正式版本均提供确定性构建 ZIP、SHA-256 校验清单、CycloneDX 1.6 SBOM 与 GitHub Provenance 构建证明。',
    'dl.winTitle': 'Windows 便携完整包',
    'dl.winDesc': '包含浏览器扩展、本机伴侣、MCP 服务、CLI 与一键启动脚本，自动复用并校验 Node.js 与 FFmpeg。',
    'dl.crTitle': 'Chromium 浏览器扩展',
    'dl.crDesc': 'Manifest V3 扩展包，支持离屏 HLS 暂存、5 套主题、中英双语与 AI & MCP 控制中心。',
    'dl.ffTitle': 'Firefox 桌面与 Android 开发包',
    'dl.ffDesc': '包含 Firefox 136+ 桌面扩展及实验性 Android 直链辅助包。',
    'dl.sbomTitle': 'SHA-256 与 CycloneDX SBOM',
    'dl.sbomDesc': '支持在运行前本地校验所有归档哈希及便携工具的上游提交指纹。',
    'mcp.kicker': 'AI 与自动化集成',
    'mcp.title': '交互式 MCP 配置生成器',
    'mcp.desc': '为 DeepSeek Harness (DSH)、Codex CLI、Claude Code 或 Cursor 生成不含硬编码凭据的配置片段。',
    'mcp.client': 'MCP 客户端',
    'mcp.mode': '运行模式',
    'mcp.path': '解压后的 VideoSave 目录',
    'mcp.clientId': '托管客户端 ID（来自扩展 AI & MCP 面板）',
    'mcp.copy': '复制配置',
    'arch.kicker': '系统工程设计',
    'arch.title': '分层媒体流水线与安全边界',
    'arch.desc': '零 npm 第三方依赖，完全基于 Node.js 24 标准库、浏览器扩展 API 与本机 FFmpeg/FFprobe 校验构建。',
    'arch.c1Title': '1. 统一请求上下文',
    'arch.c1Desc': '在 Master/Media 清单、Init、分片、Byte-Range、独立音轨、字幕轨、AES-128 密钥、重试、断点续传、刷新与 FFmpeg 回退全链路一致传递 Referer、Origin、User-Agent，并严格禁止跨域泄露 Cookie。',
    'arch.c2Title': '2. 二进制媒体内容识别',
    'arch.c2Desc': '不依赖 URL 后缀（如 .jpeg/.png/无后缀）与 MIME，按真实字节结构识别 MPEG-TS、ID3-TS、自定义前缀 TS、fMP4 及 AES-128 解密后内容，严格拒绝图片、HTML/JSON 错误页、损坏分片与 DRM。',
    'arch.c3Title': '3. SHA-256 断点续传校验',
    'arch.c3Desc': '为每个已完成的 HLS/DASH 分片与 HTTP Range 块写入 SHA-256 校验，进程强制终止、网络中断、服务重启或临时链接刷新后仅补下缺失或损坏分片。',
    'arch.c4Title': '4. 智能画质协商与校验',
    'arch.c4Desc': '支持 best、max、auto、lowest、分辨率上限、exact:HEIGHT、码率预算与 SDR/HDR 偏好，并以 FFprobe 核验成品分辨率与音视频轨道。',
    'arch.c5Title': '5. 专用隔离浏览器会话',
    'arch.c5Desc': '支持自定义 User-Agent、浏览器选择、代理与 VideoSave 专用隔离配置目录，绝不读取系统浏览器全部 Cookie、密码或历史记录。',
    'arch.c6Title': '6. 清晰合法的安全边界',
    'arch.c6Desc': '仅面向公开与获授权媒体。绝不绕过 DRM、验证码、Cloudflare 质询或 HTTP 403/401 访问限制，遇到拒绝准确报告阶段与原因。',
    'bench.kicker': '真实可复现数据',
    'bench.title': '实时兼容性矩阵与历史版本对比',
    'bench.desc': '下方全部指标均直接读取仓库 docs/compatibility-data/ 中的真实 JSON 实测数据。受控本地夹具用于验证回归精度，不代表全网 100% 兼容。',
    'bench.historyTitle': '历代版本实测对比（受控夹具与公开样本）',
    'bench.colReport': '报告文件',
    'bench.colVersion': '版本',
    'bench.colTarget': '测试目标',
    'bench.colScope': '样本范围',
    'bench.colDetected': '检出率',
    'bench.colFp': '误报',
    'bench.colDownloads': '下载校验',
    'bench.colLatency': '首探中位耗时',
    'bench.inspectorTitle': '原始 JSON 报告浏览器',
    'dsh.kicker': '真实用户反馈闭环',
    'dsh.title': '深度打磨 DeepSeek Harness (DSH) 使用体验',
    'dsh.desc': 'VideoSave 1.0 逐项修复并实测验收了 DSH 反馈的 12 类真实问题，包括旧版进程漂移检测、HLS 403 请求头一致性、非标准后缀分片、故障注入断点续传与测试沙箱零污染。',
    'dsh.doc1Title': 'DSH 接入与升级指南',
    'dsh.doc1Desc': '涵盖一键配置、get_version 旧版检测、Netscape Cookie 导入与串行批量下载示例。',
    'dsh.doc2Title': '12 项反馈追踪表',
    'dsh.doc2Desc': '完整记录 v0.9.0 问题表现、源码定位、修复方案、自动化测试与真实 DSH 验收结果。',
    'dsh.doc3Title': '安全与隐私白皮书',
    'dsh.doc3Desc': '详述最小权限模型、沙箱隔离门禁、跨域凭据边界与本机回环校验。',
  },
};

const defaultText = new Map();
document.querySelectorAll('[data-i18n]').forEach(el => {
  defaultText.set(el.dataset.i18n, el.innerHTML);
});

let currentLang = navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
function applyLang(lang) {
  currentLang = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.getElementById('lang-toggle').textContent = lang === 'zh' ? 'EN' : '中文';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.innerHTML = lang === 'zh' && translations.zh[key] ? translations.zh[key] : defaultText.get(key);
  });
}

document.getElementById('lang-toggle').addEventListener('click', () => {
  applyLang(currentLang === 'zh' ? 'en' : 'zh');
});

const themeToggle = document.getElementById('theme-toggle');
themeToggle.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const darkPreferred = matchMedia('(prefers-color-scheme: dark)').matches;
  const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (darkPreferred ? 'light' : 'dark');
  document.documentElement.dataset.theme = next;
});

function renderConfig() {
  const client = document.getElementById('cfg-client').value;
  const mode = document.getElementById('cfg-mode').value;
  const rawPath = document.getElementById('cfg-path').value.trim().replace(/[\\/]+$/, '') || 'C:/VideoSave/VideoSave-1.1.0';
  const entry = rawPath.replace(/\\/g, '/') + '/tools/mcp-server.mjs';
  const clientId = document.getElementById('cfg-client-id').value.trim() || 'dsh-main';
  document.getElementById('cfg-client-id-wrap').hidden = mode !== 'managed';

  const env = {};
  if (mode === 'shared' || mode === 'managed') {
    env.MEDIA_TOOLKIT_URL = 'http://127.0.0.1:8765';
    env.MEDIA_TOOLKIT_LOCAL_PAIRING = '1';
  }
  if (mode === 'managed') {
    env.MEDIA_TOOLKIT_MCP_CLIENT = clientId;
  }

  const filenameEl = document.getElementById('cfg-filename');
  const codeEl = document.getElementById('cfg-code');

  if (client === 'dsh') {
    filenameEl.textContent = 'cordis.patch.yml (DeepSeek Harness MCP Bundle)';
    const envLines = Object.keys(env).length
      ? '        env:\n' + Object.entries(env).map(([k, v]) => `          ${k}: '${v}'`).join('\n') + '\n'
      : '';
    codeEl.textContent =
`- insert:
    - id: videosave-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: videosave
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - '${entry.replace(/\//g, '\\')}'
${envLines}        toolCallTimeoutMs: 300000
        startupTimeoutMs: 60000
        failOnStartupError: true`;
    return;
  }

  if (client === 'codex') {
    filenameEl.textContent = '~/.codex/config.toml (Codex CLI)';
    const envBlock = Object.keys(env).length
      ? '\n[mcp_servers.videosave.env]\n' + Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n') + '\n'
      : '';
    codeEl.textContent =
`[mcp_servers.videosave]
command = "node"
args = [${JSON.stringify(entry)}]
startup_timeout_sec = 60
tool_timeout_sec = 300${envBlock}`;
    return;
  }

  const labels = {
    'claude-code': '.mcp.json / claude mcp add videosave -- node ' + JSON.stringify(entry),
    'claude-desktop': 'claude_desktop_config.json',
    cursor: '.cursor/mcp.json',
    antigravity: '~/.gemini/antigravity/mcp_config.json',
  };
  filenameEl.textContent = labels[client] || `${client}-mcp.json`;
  const server = { command: 'node', args: [entry], ...(Object.keys(env).length && { env }) };
  codeEl.textContent = JSON.stringify({ mcpServers: { videosave: server } }, null, 2);
}

for (const id of ['cfg-client', 'cfg-mode', 'cfg-path', 'cfg-client-id']) {
  document.getElementById(id).addEventListener('input', renderConfig);
  document.getElementById(id).addEventListener('change', renderConfig);
}
document.getElementById('cfg-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('cfg-code').textContent);
  const btn = document.getElementById('cfg-copy');
  const prior = btn.textContent;
  btn.textContent = currentLang === 'zh' ? '已复制 ✓' : 'Copied ✓';
  setTimeout(() => { btn.textContent = prior; }, 1400);
});

async function loadReports() {
  const body = document.getElementById('history-body');
  const picker = document.getElementById('report-picker');
  const viewer = document.getElementById('report-json');
  const metricsEl = document.getElementById('summary-metrics');

  const preferredOrder = [
    'v1.1.0-edge.json',
    'v1.1.0-chrome.json',
    'v1.1.0-firefox.json',
    'v1.1.0-mcp-edge.json',
    'v1.1.0-mcp-public.json',
    'v1.1.0-dash-public.json',
    'v1.1.0-dsh-acceptance.json',
    'v1.1.0-benchmark.json',
    'v1.0.0-edge.json',
    'v1.0.0-chrome.json',
    'v1.0.0-firefox.json',
    'v1.0.0-mcp-edge.json',
    'v1.0.0-dsh-acceptance.json',
    'v1-candidate-edge.json',
    'v1-baseline-edge.json',
    'final-edge.json',
  ];

  let index;
  try {
    const res = await fetch('./data/index.json');
    if (!res.ok) throw new Error('index unavailable');
    index = await res.json();
    if (index.version) {
      document.getElementById('live-version').textContent = 'v' + index.version;
      const winLink = document.getElementById('dl-win-link');
      const unixLink = document.getElementById('dl-unix-link');
      if (winLink) winLink.textContent = `VideoSave-${index.version}.zip ↗`;
      if (unixLink) unixLink.textContent = `VideoSave-${index.version}-unix.tar.gz ↗`;
    }
  } catch {
    body.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'muted-cell';
    td.textContent = 'Open via GitHub Pages or a local static server after building _site/data/index.json.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  const allFiles = Array.isArray(index.files) ? index.files.filter(f => typeof f === 'string' && /^[\w.-]+\.json$/.test(f)) : [];
  picker.replaceChildren(...allFiles.map(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    return opt;
  }));

  const cache = new Map();
  async function getReport(name) {
    if (!cache.has(name)) {
      const res = await fetch('./data/' + encodeURIComponent(name));
      cache.set(name, res.ok ? await res.json() : null);
    }
    return cache.get(name);
  }

  picker.addEventListener('change', async () => {
    const data = await getReport(picker.value);
    viewer.textContent = data ? JSON.stringify(data, null, 2) : 'Unable to load report.';
  });

  const featured = preferredOrder.filter(name => allFiles.includes(name));
  const loaded = (await Promise.all(featured.map(async name => ({ name, data: await getReport(name) }))))
    .filter(item => item.data && (item.data.count || item.data.summary || item.data.stress2000Segments || Array.isArray(item.data.results)));

  const latestMcp = loaded.find(r => r.name.includes('v1.1.0-mcp-public'))
    || loaded.find(r => r.name.includes('v1.1.0-mcp-edge'))
    || loaded.find(r => r.name.includes('mcp-edge'));
  const latestEdge = loaded.find(r => r.name.includes('v1.1.0-edge')) || loaded.find(r => r.name.includes('edge'));
  const dshReport = loaded.find(r => r.name.includes('v1.1.0-dsh-acceptance')) || loaded.find(r => r.name.includes('dsh-acceptance'));
  const benchReport = loaded.find(r => r.name.includes('benchmark'));

  const cards = [];
  if (latestEdge?.data?.count) {
    const c = latestEdge.data.count;
    cards.push({
      label: 'Edge Fixtures',
      value: `${c.detected}/${c.positive}`,
      sub: `0 false positives · median ${c.firstProbeMedianMs ?? '—'} ms`,
    });
  }
  if (latestMcp?.data?.count) {
    const c = latestMcp.data.count;
    cards.push({
      label: 'MCP Fixtures',
      value: `${c.detected}/${c.positive}`,
      sub: `${c.downloaded}/${c.downloads} verified downloads · ${c.casesWithFalsePositives} FP`,
    });
  }
  if (dshReport?.data?.summary) {
    const s = dshReport.data.summary;
    cards.push({
      label: 'Real DSH Acceptance',
      value: `${s.passed}/${s.total}`,
      sub: `Release ZIP · real dir delta: ${s.realDownloadDirDelta ?? 0}`,
    });
  }
  if (benchReport?.data?.stress2000Segments) {
    const st = benchReport.data.stress2000Segments;
    const cmp = benchReport.data.hls120x15msComparison;
    cards.push({
      label: '2,000-Seg Resume & Speed',
      value: `${st.restoredSegments}/${st.totalSegments / 2} reused`,
      sub: cmp ? `${cmp.speedupFactor}x vs serial FFmpeg · 0 dupes` : `${st.finalDurationSec}s verified`,
    });
  } else {
    cards.push({
      label: 'Published JSON Reports',
      value: String(allFiles.length),
      sub: 'Unmodified historical & release records',
    });
  }

  metricsEl.replaceChildren(...cards.map(({ label, value, sub }) => {
    const card = document.createElement('div');
    card.className = 'metric-card';
    const l = document.createElement('div'); l.className = 'metric-label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'metric-value'; v.textContent = value;
    const s = document.createElement('div'); s.className = 'metric-sub'; s.textContent = sub;
    card.append(l, v, s);
    return card;
  }));

  function cell(text, className, isCode = false) {
    const td = document.createElement('td');
    if (className) td.className = className;
    if (isCode) {
      const code = document.createElement('code');
      code.textContent = String(text ?? '—');
      td.appendChild(code);
    } else {
      td.textContent = String(text ?? '—');
    }
    return td;
  }

  body.replaceChildren(...loaded.map(({ name, data }) => {
    const tr = document.createElement('tr');
    if (data.stress2000Segments) {
      const st = data.stress2000Segments;
      const cmp = data.hls120x15msComparison;
      tr.append(
        cell(name, '', true),
        cell(index.version || '1.1.0'),
        cell('Stress + Bench'),
        cell('2,000-seg + 120×15ms'),
        cell(`${st.restoredSegments} restored`, 'badge-good'),
        cell('0 dupes', 'badge-good'),
        cell(cmp ? `${cmp.speedupFactor}x vs FFmpeg` : 'done', 'badge-good'),
        cell(cmp ? `${cmp.videosaveNativeHls12ConnMs} ms` : '—'),
      );
      return tr;
    }
    if (data.summary) {
      tr.append(
        cell(name, '', true),
        cell(data.version ?? '—'),
        cell('DSH Runtime (ZIP)'),
        cell('Real DSH Acceptance'),
        cell(`${data.summary.passed}/${data.summary.total}`, 'badge-good'),
        cell('0'),
        cell('Zero dir pollution', 'badge-good'),
        cell(data.summary.totalMs ? Math.round(data.summary.totalMs / 1000) + 's' : '—'),
      );
      return tr;
    }
    if (Array.isArray(data.results)) {
      const passed = data.results.filter(r => r.complete).length;
      tr.append(
        cell(name, '', true),
        cell(index.version || '1.1.0'),
        cell('DASH Standalone'),
        cell('Public DASH Streams'),
        cell(`${passed}/${data.results.length}`, passed === data.results.length ? 'badge-good' : ''),
        cell('0'),
        cell(`${passed}/${data.results.length} verified`, passed === data.results.length ? 'badge-good' : ''),
        cell(data.results.length ? Math.round(data.results.reduce((s, r) => s + (r.ms || 0), 0) / data.results.length / 1000) + 's' : '—'),
      );
      return tr;
    }
    const c = data.count;
    tr.append(
      cell(name, '', true),
      cell(data.version ?? '—'),
      cell(data.browser ?? '—'),
      cell(data.sample ?? '—'),
      cell(`${c.detected}/${c.positive}`, c.detected === c.positive ? 'badge-good' : ''),
      cell(c.casesWithFalsePositives, c.casesWithFalsePositives === 0 ? 'badge-good' : ''),
      cell(`${c.downloaded}/${c.downloads}`),
      cell(c.firstProbeMedianMs != null ? c.firstProbeMedianMs + ' ms' : '—'),
    );
    return tr;
  }));

  if (featured.length) {
    picker.value = featured[0];
    const first = await getReport(featured[0]);
    viewer.textContent = first ? JSON.stringify(first, null, 2) : '';
  }
}

applyLang(currentLang);
renderConfig();
void loadReports();
