# VideoSave 网页媒体探测调研

调研日期为 2026 年 11 月 26 日。资料来自项目维护者发布的源码、接口文档、产品说明和许可证。本文的实现建议来自对公开机制的分析，兼容性和识别准确率由实测报告提供。

## 下载工具的媒体发现策略

### yt-dlp

`GenericIE` 从输入 URL 和响应类型判断直接媒体与流清单，对无法直接分类的响应检查有限的正文，并从 HTML5 元素和嵌入提取器寻找候选。专用提取器利用站点提供的结构化信息，把候选整理进统一的格式列表。视频和音频轨道可以独立出现，配置或清单中声明的格式也可能有多种画质。VideoSave 可采用相同的分层验证思路，从 URL、响应类型和有限的清单内容获取互补证据，并允许一个播放器提出多个候选。yt-dlp 的独立 HTTP 请求和浏览器中真实发生的播放请求覆盖不同场景。 [GenericIE 源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/generic.py) · [格式选择文档](https://github.com/yt-dlp/yt-dlp#format-selection)

仓库、PyPI 源码包和 wheel 使用 Unlicense。官方 README 说明 PyInstaller 封装的可执行文件包含 GPLv3+ 组件，组合发行物适用 GPLv3+。引用思路与再分发二进制适用各自的检查。 [仓库许可](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE) · [发行物许可说明](https://github.com/yt-dlp/yt-dlp#licensing)

### Video DownloadHelper

产品隐私政策说明，扩展在本地使用 `webRequest` 和 `webNavigation` 观察请求与导航。在需要定位媒体元素的特定受支持网站上，扩展运行辅助脚本。其公开产品能力包括 HLS、DASH 和渐进式音视频。对 VideoSave 来说，可比较的交互是播放触发请求后自动刷新候选，同时按标签页和导航隔离结果。媒体归组、广告判断、排序阈值及节流细节缺少公开实现证据，竞争对照以相同浏览器、页面和播放步骤的实测为准。Firefox 商店标记其为自定义许可。 [隐私与权限说明](https://www.downloadhelper.net/privacy) · [Mozilla 商店许可](https://addons.mozilla.org/en-US/firefox/addon/video-downloadhelper/license/)

### cobalt

cobalt 把给定 URL 交给受支持平台的处理流程，公开 API 使用 `redirect`、`tunnel`、`local-processing`、`picker`、`error` 等状态，表达直接结果、后续处理、用户选择和失败。VideoSave 可复用这类接口语义，为 MCP 提供候选和可执行的下一步，并把选择多个合法候选和探测失败分别暴露为机器可读状态。cobalt 的公开 API 主要接受媒体页面链接，浏览器端实时观察能力需单独对照。仓库许可为 AGPL-3.0。 [API 响应模型](https://github.com/imputnet/cobalt/blob/main/docs/api.md) · [仓库许可](https://github.com/imputnet/cobalt/blob/main/LICENSE)

### Streamlink

Streamlink 的 `pluginmatcher` 为 URL 模式定义优先级，插件返回按名称标识的流对象，调用方通过共同接口处理 HLS、DASH、HTTP 等流。VideoSave 可让适配器声明匹配证据和优先级，并输出统一候选。适配器缺少证据或执行失败时，DOM、网络和通用配置解析继续工作。页面使用的库或站点发生更新时，适配器测试可以单独覆盖这一变化。仓库许可为 BSD-2-Clause。 [插件接口](https://streamlink.github.io/api/plugin.html) · [流类型](https://streamlink.github.io/api/stream.html) · [仓库许可](https://github.com/streamlink/streamlink/blob/master/LICENSE)

## 播放器与媒体加载

### HLS.js

HLS.js 将清单解析、画质级别清单和分片加载暴露为不同阶段的事件，例如 `MANIFEST_PARSED`、`LEVEL_LOADED` 和 `FRAG_LOADED`。级别、替代音轨、字幕和分片分别有对应数据结构。VideoSave 观察到主清单时可从声明关系组织画质和音轨。只观察到分片时，可以报告播放已发生且清单有待发现。浏览器使用 MSE 时，媒体元素可以显示 `blob:`，原始候选则来自页面配置或对应的网络清单。项目主许可为 Apache-2.0，许可文件另列衍生代码及第三方声明。 [HLS.js API](https://github.com/video-dev/hls.js/blob/master/docs/API.md) · [事件与类型源码](https://github.com/video-dev/hls.js/tree/master/src) · [许可文件](https://github.com/video-dev/hls.js/blob/master/LICENSE)

### Shaka Player

Shaka 的 `NetworkingEngine` 将清单、分片、许可证等请求标为不同类型，并提供请求与响应过滤器。`Player.getVariantTracks()` 可返回可选变体。VideoSave 可参考其分类，独立记录类型、轨道和播放限制。发现明确的加密媒体或许可证迹象时，应在候选上报告限制并停止下载流程。页面同时存在明文候选时，判断应尽量限于有对应证据的播放器或候选。仓库许可为 Apache-2.0。 [网络接口](https://shaka-player-demo.appspot.com/docs/api/shaka.net.NetworkingEngine.html) · [播放器接口](https://shaka-player-demo.appspot.com/docs/api/shaka.Player.html) · [仓库许可](https://github.com/shaka-project/shaka-player/blob/main/LICENSE)

### Video.js

Video.js 8 的 `currentSources()` 返回播放器配置的源列表，而 `currentSource()` 返回当前源。该代播放器通过 source handler 选择可处理的媒体类型，VHS 提供 HLS 和 DASH 支持。Video.js 10 的文档展示了原生媒体与 HLS.js 等不同媒体组件。VideoSave 可把声明源、当前在用源和实际网络响应保留为独立证据，并允许多代播放器经相同的 DOM 与网络路径输出结果。仓库许可为 Apache-2.0。 [8.x 播放器源码](https://github.com/videojs/video.js/blob/8.x/src/js/player.js) · [VHS 项目](https://github.com/videojs/http-streaming) · [10.x 媒体源指南](https://videojs.org/docs/framework/react/guides/media-sources) · [仓库许可](https://github.com/videojs/video.js/blob/main/LICENSE)

### Plyr

Plyr 可包装标准 HTML5 音视频及 YouTube、Vimeo iframe，并发布与 HLS.js、Shaka、dash.js 配合的示例。相同的控件外观可对应完全不同的媒体传输机制。VideoSave 可通过外层容器关联标题、可见性和交互状态，同时从实际媒体元素、获授权的 frame 或网络观察提取候选。嵌入式后端超出当前可观测范围时，报告相应的 frame 限制。仓库许可为 MIT。 [原生媒体、iframe 和流媒体集成](https://github.com/sampotts/plyr#readme) · [仓库许可](https://github.com/sampotts/plyr/blob/master/LICENSE.md)

### dash.js

dash.js 通过 `MANIFEST_LOADED`、`STREAM_INITIALIZED`、`FRAGMENT_LOADING_STARTED` 和 `QUALITY_CHANGE_RENDERED` 等事件区分 MPD 获取、流初始化、分片传输和实际画质切换。DASH 的 Period、AdaptationSet 和 Representation 可分别表达播放时段、轨道及多种编码配置。VideoSave 应保留 MPD 内的明确关系，将不同分辨率与独立音轨组织到同一媒体候选，并保留 Period 或替代音轨的边界。仓库许可证包含 BSD 三条款，并对第三方权利另作说明。 [播放器事件源码](https://github.com/Dash-Industry-Forum/dash.js/blob/development/src/streaming/MediaPlayerEvents.js) · [项目文档](https://dashif.org/dash.js/) · [仓库许可](https://github.com/Dash-Industry-Forum/dash.js/blob/development/LICENSE.md)

## VideoSave 的设计推论

- 用同一候选结构保留每条证据的来源、页面或 frame、媒体类型及观察时刻。原生媒体优先读取 `currentSrc`、`loadedmetadata` 和实际播放状态，静态 `<source>`、公开 JSON 和结构化数据补充可能的地址。网络观察通过响应类型识别无扩展名资源。只在明确的用户授权播放操作后触发播放器交互，保持现有权限边界。 [HTMLMediaElement.currentSrc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentSrc) · [扩展响应头事件](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/onHeadersReceived)
- 对 MSE，将 `blob:` 记为播放证据。可访问的 MPD、HLS 清单或直链进入候选列表，媒体分片与初始化段用于佐证。根据清单关系和播放器上下文确定候选归属，避免仅按域名、后缀、路径相似度或长度猜测。同一播放器里的多个独立节目若缺少归组证据，应保留多项并报告依据。 [MediaSource 文档](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource) · [HLS.js 清单与级别 API](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
- 排序使用来源、实际播放、可见性、题名匹配、广告或预告的明确标记、时长、画质和轨道完整性。用户可查看备选和证据。缺少证据的直链仍可列出，是否能直接下载和是否需要本机合并应各自说明。 [cobalt 候选选择响应](https://github.com/imputnet/cobalt/blob/main/docs/api.md) · [yt-dlp 轨道和格式选择](https://github.com/yt-dlp/yt-dlp#format-selection)
- 持续探测限于用户授权范围内的标签页与 frame。监听 DOM 变动、媒体事件和实际网络响应，合并短时间内的更新并清理上一页面的状态。扩展面板可以随播放增量刷新，MCP 可在同一截止时间内等待稳定候选或返回明确诊断。 [HTML 媒体规范](https://html.spec.whatwg.org/multipage/media.html) · [Video DownloadHelper 权限说明](https://www.downloadhelper.net/privacy)
- 诊断导出由用户触发。使用允许字段清单写出状态码、证据类型、候选和 frame 数、阶段耗时及浏览器类别。提交公开 Issue 的报告省去网址和路径、网页正文、Cookie、认证头、签名参数及页面标题。访问限制、授权失败和 DRM 均进入结构化诊断。 [Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/)

## 实测对照

对照应覆盖原生媒体与动态 `<source>`、原生 HLS 与 JavaScript HLS、HLS 和 DASH 独立音视频轨道、MSE `blob:`、广告与正片并存、跨源嵌入和公开 JSON。每个场景记录预期可访问源、预期正片或限制、允许的播放步骤和观察窗口。对多画质场景核对媒体分组及标题，对无法许可访问的场景核对原因及安全退出。旧版和新版使用相同样本以及浏览器、操作和网络条件，未覆盖的平台和波动的公网失败保留在报告中。
