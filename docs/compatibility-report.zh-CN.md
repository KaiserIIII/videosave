# VideoSave 0.9.0 兼容性实测

2026 年 11 月 27 日在 Windows、Node.js 24.19.0 上运行。对照版本为 v0.8.1（`f7d830a2501b9c6d673716ce3a421a9850534b07`）与 v0.9.0 候选版。场景由 [测试矩阵](../tests/compatibility-fixtures.mjs) 定义，涵盖自生成媒体、本地模拟播放器和七个合法公网样本。[逐场景记录](compatibility-data/)保留每轮候选文件名、通过情况、失败代码和可采集的用量指标。

| 渠道 | 探测命中 | 正片选择正确 | 通过 ffprobe 的落盘 | 含误报的场景 | 首次探测中位数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Edge 扩展 | 38/45 → 44/45 | 0/1 → 1/1 | 5/6 → 6/6 | 4/54 → 0/54 | 463 → 222.5 ms |
| Chrome 扩展 | 37/45 → 42/45 | 0/1 → 1/1 | 5/6 → 6/6 | 3/54 → 0/54 | 401 → 204.5 ms |
| Firefox 扩展 | 35/45 → 44/45 | 0/1 → 1/1 | 5/6 → 6/6 | 3/54 → 0/54 | 683 → 281 ms |
| MCP（Edge） | 34/44 → 44/44 | 1/2 → 2/2 | 6/9 → 9/9 | 3/53 → 1/53 | 5,902 → 4,957.5 ms |

Edge 扩展基线版本为 158.0.4370.33，候选轮为 158.0.4370.45。Chrome 为 158.0.8127.38，Firefox 为 136.0.1。MCP 矩阵记录了浏览器类型，未采集具体浏览器版本。MCP 缺少人工滚动场景，扩展端到端下载矩阵和 MCP 下载矩阵选择了不同数量的样本。

MCP 基线整轮为 33/44。原 `dynamic-json` 模拟页仅调用 `fetch()`，未消费响应体。修正为 `response.json()` 后，两版 MCP 都找到了清单，三款扩展基线及候选轮均未找到。表中的探测数纳入基线单场景复测，时延采用各自原整轮返回候选的样本。扩展记录首个候选出现的时间，MCP 记录整次调用返回的时间。

| 实测场景 | 扩展候选版 | MCP 候选版 |
| --- | --- | --- |
| MP4、WebM、音频、HLS、fMP4 | 探测并验证落盘 | 探测并验证落盘 |
| DASH、独立音视频轨道 | 探测通过 | 探测并验证落盘 |
| iframe、嵌套 iframe、`srcdoc`、开放 Shadow DOM | 探测通过。Chrome 的延迟 Shadow DOM 整轮超时，单跑通过 | 探测通过 |
| MSE 和 blob | 找到清单，并确认测试播放器向 SourceBuffer 写入数据 | 找到清单 |
| 动态 JSON 配置 | DOM 公开配置通过。仅在 XHR 响应中出现的地址未命中 | 两者均命中 |
| 延迟加载、SPA、播放后加载 | 可识别。Chrome 两个延迟项整轮超时，复测通过 | 可识别 |
| 无扩展名媒体、广告与正片、宣传片与正片 | 指定结果通过 | 指定结果通过 |
| 登录、支付、403、Cloudflare 挑战、DRM 模拟页 | 无受限资源请求 | 无受限资源请求，返回相应的诊断或状态 |
| Windows、Linux、Android | Windows 实测。其余平台不在本矩阵覆盖范围内 | Windows 实测。其余平台不在本矩阵覆盖范围内 |

候选轮的七个公网样本均命中，涵盖 MDN、W3C、HLS.js、dash.js、Apple 和 Mux。公网样本分别承担探测和落盘验证，具体覆盖见逐场景记录。下载校验使用 `ffprobe` 确认轨道类型与时长。本地测试预期 3 秒。登录、付费墙、Cloudflare 挑战和 DRM 使用本地模拟响应，未验证真实第三方账号会话。YouTube、Bilibili、Android 和商店安装不在此矩阵中。

## 失败与限制

- 扩展无法提取仅存在于 XHR JSON 响应中、播放器从未发起请求的媒体地址。三款浏览器都复现。
- Chrome 的 `shadow-delayed` 与 `delay-late` 在全量轮未命中，分别在约 4.12 秒耗尽观察窗口。单场景复测均命中，原整轮仍计为失败。
- MCP 在 dash.js 公网页面命中主清单，同时把两条 `.m4v` 分片列成候选。该场景计为命中并记一次误报。
- MCP 的 `only-fragments` 场景未返回独立下载候选，但诊断未给出预期的 `unsupported-format`。MCP 在旧版 `protected-hls` 场景触发 1 次测试保留资源请求，候选轮为 0。
- v0.8.1 的三款扩展都因未探测到音频元素而少完成 1 个下载。旧版 MCP 的音频场景未探测到文件，MDN 兔子样片及 Apple fMP4 下载均返回 `MEDIA_FAILED`。候选轮对三项完成落盘验证。
- 选片评分覆盖的正片判断样本只有每扩展 1 个、MCP 2 个。矩阵涉及的干扰项和浏览器行为无法代表所有网站。

## 资源采样

| 渠道 | 页面 JS 堆中位数（MiB） | 本地响应请求数 | 本地响应体（MiB） |
| --- | ---: | ---: | ---: |
| Edge 扩展 | 3.37 → 6.43 | 190 → 171 | 2.30 → 2.33 |
| Chrome 扩展 | 4.37 → 6.44 | 190 → 171 | 2.28 → 2.33 |
| Firefox 扩展 | 未采集 | 154 → 138 | 1.60 → 1.45 |
| MCP（Edge） | 未采集 | 297 → 325 | 4.49 → 4.96 |

CDP 的 JS 堆采样来自测试网页，适合查看页面内存变化。浏览器总内存、扩展后台内存、CPU 和长时间运行内存未采集。本地请求与字节含探测、页面播放及落盘，候选版完成的下载数不同。公网请求量未纳入这项统计。

## 复现

准备 Windows、Node.js 24、FFmpeg、ffprobe 和待测浏览器。在源码根目录运行以下命令。其他通道分别用 `chrome`、`firefox`、`mcp-edge`。用 `--source` 指向干净的 v0.8.1 源码以生成基线。路径含空格时对整项参数加引号。基线采样去掉 `--strict`，以保留旧版失败。`--strict` 校验核心场景、样本是否完整执行及受保护资源请求数，并将其他场景结果记入报告。

```powershell
node tests/compatibility.mjs --browser=edge --public --strict --output=edge-0.9.0.json
node tests/compatibility.mjs --browser=edge --public --source=C:/work/videosave-v0.8.1 --output=edge-0.8.1.json
node tests/compatibility.mjs --browser=chrome '--only=shadow-delayed|delay-late|spa-route' --output=chrome-delayed.json
```
