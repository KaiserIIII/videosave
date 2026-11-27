# VideoSave 0.9.0 HLS 下载性能对照

2026 年 11 月 27 日，Windows x64，Intel Core i7-14650HX，Node.js 24.19.0，FFmpeg 8.1.2。测试用 FFmpeg 生成 640×360、24 秒的音视频，共 24 个 MPEG-TS 分片，由回环 HTTP 测试服务提供。每个工具最多同时获取八个分片，实际峰值均为八个。VideoSave 开启预取，停用 `fastStart`。yt-dlp 使用原生 HLS 下载器和 `--concurrent-fragments 8`。

每个条件下各完成三轮，并轮换工具的执行顺序。每轮创建独立的输出和状态目录，从进程启动计时到完整 MP4 写完，截止时间为 30 秒。计时包含 Node.js 或 yt-dlp 启动和合并写盘。`ffprobe` 检查和轨道哈希在计时结束后执行。

| 网络模拟条件 | VideoSave 0.8.1 | VideoSave 0.9.0 | yt-dlp 2026.11.23 |
| --- | --- | --- | --- |
| 每个分片响应延迟 160 ms | 1.148、1.056、0.992 秒，中位 1.056 | 1.114、1.124、1.012 秒，中位 1.114 | 2.619、2.567、2.590 秒，中位 2.590 |
| 末片首个请求只发送 1,024 字节，余量等待 4.2 秒 | 3.019、3.012、3.038 秒，中位 3.019 | 3.038、3.121、3.050 秒，中位 3.050 | 6.573、28.214、6.390 秒，中位 6.573 |

18 次均成功落盘。每个文件的分辨率为 640×360，时长为 24.032653 秒，对应视频轨道和解码后的音频轨道 SHA-256 均一致。稳态轮次每次发送媒体正文 2,739,348 字节，三个工具均只请求每片一次。慢尾条件下，两个版本的 VideoSave 都补发一次末片请求，每轮多发送 1,024 字节。yt-dlp 每轮只发送 24 个分片请求。28.214 秒样本保留在统计内，原因未定位。

样本内两个 VideoSave 版本耗时接近，且均早于同期的 yt-dlp。结果适用于这个受控 HLS 样片和工具入口。公网路由、较大文件、CPU 和下载进程内存未在这组实验中采集。与 Video DownloadHelper、IDM、Streamlink、cobalt 的同条件下载耗时未测。[逐轮原始记录](compatibility-data/hls-comparison.json) · [兼容性与页面堆采样](compatibility-report.zh-CN.md)

## 复现

准备 Node.js 24、FFmpeg、ffprobe、yt-dlp 和解压后的 VideoSave 0.8.1 源码。在候选版源码根目录执行。

```powershell
node tests/benchmark-hls.mjs --baseline=C:/work/videosave-v0.8.1 --yt-dlp=C:/tools/yt-dlp.exe --output=hls-comparison.json
```

## 两个公网样片复测

VideoSave 0.9.0 和 yt-dlp 2026.11.23 在同一主机及系统网络配置下交替运行。两边均使用八分片并发，单轮上限为 60 秒。VideoSave 从已启动的本机队列提交任务开始计时，设置 `prefetch: true`、`fastStart: false`。yt-dlp 从启动命令开始计时，使用 `--ignore-config --downloader m3u8:native --concurrent-fragments 8 --abort-on-unavailable-fragments --remux-video mp4`。所有样本均计至成品落盘，随后用 ffprobe 检查轨道和容器时长，以 FFmpeg `streamhash` 比较轨道。

| 公网样片 | VideoSave 0.9.0 | yt-dlp 2026.11.23 |
| --- | --- | --- |
| Apple 360p 字节范围 fMP4 | 3.412、1.636、2.173 秒，3/3，中位 2.173 秒 | 18.890、3.543、3.887 秒，3/3，中位 3.887 秒 |
| Mux 288p MPEG-TS HLS | 20.104、11.364、11.635 秒，3/3，中位 11.635 秒 | 16.473、8.454、15.552 秒，3/3，中位 15.552 秒 |

每个样片内，成品对应轨道的 SHA-256 均一致。Apple 文件在 VideoSave 和 yt-dlp 输出中的容器时长分别为 600 秒和 610 秒。Mux 两者均为 634.633333 秒，yt-dlp 的前两轮更快。完整数据保留了 Apple 的 18.890 秒和 Mux 的 20.104 秒样本。此轮未采集公网流量、CPU 或下载进程内存。 [逐轮记录](compatibility-data/public-hls-0.9.0.json) · [样片来源和 v0.8.1 公网记录](competitive-review.zh-CN.md)

## Video DownloadHelper 探测核对

在隔离 Edge 中分别加载 VideoSave 0.9.0 和 Video DownloadHelper 10.7.9.2，打开同一 W3C Sintel 预告片页面，触发正常播放并确认 `currentTime` 开始增加。两款扩展均发现同一 `trailer.mp4`。此单样本只对照检测，扩展商店安装体验和完整落盘速度未在本轮测试。 [逐工具记录](compatibility-data/vdh-w3c-0.9.0.json)
