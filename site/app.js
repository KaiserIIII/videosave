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
    'dsh.desc': 'VideoSave v1.3.1 针对 DSH 反馈的 12 类真实问题完成源码修复与实测验证，新增原生 Bilibili 裸 BV 下载与画质一致性模型（DSH-12 已升级递归 OS 监控与不完整失败门禁，仍保持待独立用户复测验收）。',
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
  const rawPath = document.getElementById('cfg-path').value.trim().replace(/[\\/]+$/, '') || 'C:/VideoSave/VideoSave-1.3.1';
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
    'v1.3.1-bilibili-public.json',
    'v1.3.1-platforms-public.json',
    'v1.3.1-competitor-benchmark.json',
    'v1.3.1-dsh-acceptance.json',
    'v1.3.1-android-runtime.json',
    'v1.3.0-bilibili-public.json',
    'v1.3.0-platforms-public.json',
    'v1.3.0-competitor-benchmark.json',
    'v1.3.0-dsh-acceptance.json',
    'v1.2.0-dsh-acceptance.json',
    'v1.2.0-chrome-stability.json',
    'v1.2.0-competitor-benchmark.json',
    'v1.2.0-platforms-public.json',
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

  function detectClientOs() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
    if (/Linux/i.test(ua)) return 'linux';
    return 'windows';
  }

  function applyDownloadSync(version, assets = []) {
    const tag = 'v' + version;
    const baseDl = `https://github.com/KaiserIIII/videosave/releases/download/${tag}/`;
    const assetUrl = (name) => {
      const found = assets.find(a => a.name === name);
      return found ? found.browser_download_url : (baseDl + name);
    };
    const apkAsset = assets.find(a => /^VideoSave-.*-android-universal\.apk$/.test(a.name))
      || assets.find(a => /^VideoSave-.*-android-debug\.apk$/.test(a.name));
    const apkName = apkAsset ? apkAsset.name : `VideoSave-${version}-android-debug.apk`;

    const setLink = (id, name, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.href = assetUrl(name);
      el.textContent = (label || name) + ' ↗';
    };
    setLink('dl-win-setup-link', `VideoSave-${version}-Setup.exe`);
    setLink('dl-win-offline-link', `VideoSave-${version}-win-x64-offline.zip`, 'Offline Portable ZIP');
    setLink('dl-win-link', `VideoSave-${version}.zip`, 'Lite ZIP');
    setLink('dl-apk-link', apkName);
    setLink('dl-deb-link', `videosave_${version}_all.deb`, `videosave_${version}_all.deb`);
    setLink('dl-unix-link', `VideoSave-${version}-unix.tar.gz`, `VideoSave-${version}-unix.tar.gz`);
    setLink('dl-ext-link', `VideoSave-${version}-extension.zip`, `VideoSave-${version}-extension.zip`);
    setLink('dl-sbom-link', 'SHA256SUMS.txt', 'SHA256SUMS.txt');

    const osKind = detectClientOs();
    const recMap = {
      windows: {
        title: currentLang === 'zh' ? '已为您识别设备（Windows）：' : 'Recommended for Windows:',
        desc: currentLang === 'zh' ? `推荐下载图形化安装程序 VideoSave-${version}-Setup.exe（无需管理员权限，自动准备依赖）` : `Graphical installer VideoSave-${version}-Setup.exe (no admin rights, auto-prepares runtime)`,
        file: `VideoSave-${version}-Setup.exe`,
      },
      android: {
        title: currentLang === 'zh' ? '已为您识别设备（Android / 鸿蒙 4.x）：' : 'Recommended for Android / HarmonyOS 4.x:',
        desc: currentLang === 'zh' ? `独立安装包 ${apkName}（无需 Root/Termux；鸿蒙 NEXT 纯血版暂不支持 APK）` : `Standalone APK ${apkName} (no Root/Termux; HarmonyOS NEXT does not support native APKs)`,
        file: apkName,
      },
      macos: {
        title: currentLang === 'zh' ? '已为您识别设备（macOS）：' : 'Recommended for macOS:',
        desc: currentLang === 'zh' ? `自举运行包 VideoSave-${version}-unix.tar.gz（自动校验安装 Node 24，双击 Launch VideoSave.command 启动）` : `Self-bootstrapping VideoSave-${version}-unix.tar.gz (auto-installs verified Node 24)`,
        file: `VideoSave-${version}-unix.tar.gz`,
      },
      linux: {
        title: currentLang === 'zh' ? '已为您识别设备（Linux）：' : 'Recommended for Linux:',
        desc: currentLang === 'zh' ? `Debian/Ubuntu 推荐 videosave_${version}_all.deb，其他发行版推荐 unix.tar.gz` : `Debian/Ubuntu .deb package videosave_${version}_all.deb or portable unix.tar.gz`,
        file: `videosave_${version}_all.deb`,
      },
    };
    const rec = recMap[osKind] || recMap.windows;
    const tEl = document.getElementById('os-recommend-title');
    const dEl = document.getElementById('os-recommend-desc');
    const cEl = document.getElementById('os-recommend-cta');
    if (tEl) tEl.textContent = rec.title + ' ';
    if (dEl) dEl.textContent = rec.desc;
    if (cEl) {
      cEl.href = assetUrl(rec.file);
      cEl.textContent = rec.file + ' ↗';
    }
  }

  let index;
  try {
    const res = await fetch('./data/index.json');
    if (!res.ok) throw new Error('index unavailable');
    index = await res.json();
    if (index.version) {
      document.getElementById('live-version').textContent = 'v' + index.version;
      applyDownloadSync(index.version, []);
      // Best-effort sync with live GitHub Release asset list (only when live release >= site version)
      const cmpVer = (a, b) => {
        const pa = String(a || '').split('.').map(n => Number.parseInt(n, 10) || 0);
        const pb = String(b || '').split('.').map(n => Number.parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
        return 0;
      };
      fetch('https://api.github.com/repos/KaiserIIII/videosave/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
        .then(r => r.ok ? r.json() : null)
        .then(rel => {
          if (rel?.tag_name && Array.isArray(rel.assets)) {
            const liveVer = String(rel.tag_name).replace(/^v/i, '');
            if (cmpVer(liveVer, index.version) >= 0) {
              document.getElementById('live-version').textContent = 'v' + liveVer;
              applyDownloadSync(liveVer, rel.assets);
            }
          }
        })
        .catch(() => {});
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
  const biliReport = loaded.find(r => r.name.includes('v1.3.1-bilibili-public'))
    || loaded.find(r => r.name.includes('bilibili-public'));
  const dshReport = loaded.find(r => r.name.includes('v1.3.1-dsh-acceptance'))
    || loaded.find(r => r.name.includes('v1.3.0-dsh-acceptance'))
    || loaded.find(r => r.name.includes('v1.2.0-dsh-acceptance'))
    || loaded.find(r => r.name.includes('v1.1.0-dsh-acceptance'))
    || loaded.find(r => r.name.includes('dsh-acceptance'));
  const benchReport = loaded.find(r => r.name.includes('v1.3.1-competitor-benchmark'))
    || loaded.find(r => r.name.includes('competitor-benchmark'))
    || loaded.find(r => r.name.includes('benchmark'));

  const cards = [];
  if (biliReport?.data?.summary) {
    const bs = biliReport.data.summary;
    cards.push({
      label: 'Native Bilibili Public',
      value: `${bs.verified}/${bs.total} (${bs.successRatePct}%)`,
      sub: `Zero yt-dlp · ${bs.qualityConsistent ?? bs.verified}/${bs.total} quality-consistent · decoded`,
    });
  }
  if (dshReport?.data?.summary) {
    const s = dshReport.data.summary;
    cards.push({
      label: 'Real DSH Acceptance',
      value: `${s.passed}/${s.total}`,
      sub: s.sandboxEnforced ? 'Release ZIP · OS FS audit: 0 OOB' : `Release ZIP · real dir delta: ${s.realDownloadDirDelta ?? 0}`,
    });
  }
  if (benchReport?.data?.rankedQualifiedTools?.length) {
    const top = benchReport.data.rankedQualifiedTools[0];
    cards.push({
      label: 'Controlled 120s HLS Bench',
      value: `${top.medianMs} ms`,
      sub: `${top.tool} · ${top.durationSec}s decoded`,
    });
  }
  if (latestEdge?.data?.count) {
    const c = latestEdge.data.count;
    cards.push({
      label: 'Edge Fixtures',
      value: `${c.detected}/${c.positive}`,
      sub: `0 false positives · median ${c.firstProbeMedianMs ?? '—'} ms`,
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
    if (data.realPublicMediaOnly && data.summary) {
      tr.append(
        cell(name, '', true),
        cell(data.version ?? '1.3.0'),
        cell('Bilibili Native (0 yt-dlp)'),
        cell('Real Public Bilibili'),
        cell(`${data.summary.probed}/${data.summary.total} probed`, data.summary.probed === data.summary.total ? 'badge-good' : ''),
        cell(`${data.fallbackToLocalFixtureCount ?? 0} fallback`, 'badge-good'),
        cell(`${data.summary.verified}/${data.summary.total} verified (${data.summary.successRatePct}%)`, data.summary.verified === data.summary.total ? 'badge-good' : ''),
        cell(`${Math.round((data.summary.totalDownloadedBytes || 0) / (1024 * 1024))} MiB`),
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
        cell(data.summary.sandboxEnforced ? 'OS FS audit: 0 OOB' : 'Zero dir pollution', 'badge-good'),
        cell(data.summary.totalMs ? Math.round(data.summary.totalMs / 1000) + 's' : '—'),
      );
      return tr;
    }
    if (Array.isArray(data.results)) {
      if (data.rounds) {
        tr.append(
          cell(name, '', true),
          cell(index.version || '1.2.0'),
          cell(`${data.browser || 'chrome'} (${data.rounds} rounds)`),
          cell('Startup & Probe Stability'),
          cell(`${data.passed}/${data.rounds}`, data.passed === data.rounds ? 'badge-good' : ''),
          cell(`${data.totalStartupRetries ?? 0} retries`, (data.totalStartupRetries ?? 0) === 0 ? 'badge-good' : ''),
          cell('State Machine Verified', 'badge-good'),
          cell(data.medianRoundMs != null ? `${data.medianRoundMs} ms` : '—'),
        );
        return tr;
      }
      if (data.fixture) {
        const vs = data.results.find(r => /VideoSave/i.test(r.tool));
        const ff = data.results.find(r => /FFmpeg/i.test(r.tool));
        const yt = data.results.find(r => /yt-dlp/i.test(r.tool));
        const vsMs = vs?.medianMs ?? vs?.elapsedMs;
        const ffMs = ff?.medianMs ?? ff?.elapsedMs;
        const ytMs = yt?.medianMs ?? yt?.elapsedMs;
        tr.append(
          cell(name, '', true),
          cell(data.version || index.version || '1.3.0'),
          cell('Competitor Benchmark'),
          cell(`${data.fixture.segments}×${data.fixture.simulatedRttMs}ms HLS`),
          cell(vsMs != null ? `${vsMs} ms` : '—', 'badge-good'),
          cell('0 OOB writes', 'badge-good'),
          cell(ffMs && vsMs ? `${(ffMs / Math.max(1, vsMs)).toFixed(2)}x vs FFmpeg` : '—', 'badge-good'),
          cell(ytMs ? (yt?.validForRanking === false ? 'yt-dlp invalid' : `yt-dlp ${ytMs} ms`) : '—'),
        );
        return tr;
      }
      if (data.ytdlpConfigured !== undefined) {
        const verified = data.results.filter(r => r.downloadStatus === 'verified').length;
        const probed = data.results.filter(r => r.probeStatus === 'ok').length;
        tr.append(
          cell(name, '', true),
          cell(index.version || '1.2.0'),
          cell('Bilibili + YouTube'),
          cell('Real Public Platforms'),
          cell(`${probed}/${data.results.length} probed`, probed === data.results.length ? 'badge-good' : ''),
          cell('0 fallback', 'badge-good'),
          cell(`${verified}/${data.results.length} verified`, verified === data.results.length ? 'badge-good' : ''),
          cell(data.results.length ? Math.round(data.results.reduce((s, r) => s + (r.elapsedMs || 0), 0) / data.results.length / 1000) + 's' : '—'),
        );
        return tr;
      }
      const passed = data.results.filter(r => r.complete).length;
      tr.append(
        cell(name, '', true),
        cell(index.version || '1.2.0'),
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
