# VideoSave Commons store listing and reviewer guide

VideoSave Commons is the standalone browser-store edition. Its own version starts at 1.0.0. The full VideoSave release on GitHub is maintained separately.

## English listing

**VideoSave Commons**

Save original audio and video files you are permitted to download from Wikimedia Commons. Copy the original file link from its Commons file page, open VideoSave Commons, and choose Load file. Once the file is ready, choose Save file to use your browser’s download settings.

Supports original WebM and Ogg media up to 100 MiB. The extension works independently and asks for site access only to the Wikimedia upload host. It does not read open tabs, use login cookies, or collect telemetry. Check the individual file page for license and attribution requirements.

## 简体中文商店介绍

**VideoSave Commons**

保存你有权下载的 Wikimedia Commons 原始音频或视频文件。先在共享资源的文件详情页查看许可和署名要求，并复制「原始文件」链接。点击浏览器工具栏中的 VideoSave Commons 图标，将链接粘贴到打开的页面，点击「读取文件」。文件就绪后点击「保存文件」，浏览器会按你的下载设置保存。

支持最大 100 MiB 的原始 WebM 和 Ogg 音视频文件。扩展只向维基媒体上传主机请求你主动填入的原始文件，不扫描打开的网页，不读取登录 Cookie，也不收集遥测。扩展可独立运行，无需注册账号或安装其他应用。文件链接中用于跟踪的参数会在请求前移除。遇到网页链接、重定向链接、超限文件或不支持的格式时，页面会提示失败。

## Reviewer steps

1. Install the candidate in a test profile. Click the VideoSave Commons toolbar icon. It opens a standalone extension tab.
2. Paste `https://upload.wikimedia.org/wikipedia/commons/5/52/En-us-hello.ogg` and select **Load file**. Select **Save file**, then confirm `En-us-hello.ogg` appears in the browser downloads list. This public-domain sample was made by Dvortygirl. [Source and license](https://commons.wikimedia.org/wiki/File:En-us-hello.ogg)
3. Optionally repeat with `https://upload.wikimedia.org/wikipedia/commons/8/8f/Example.webm`. The Commons example file can change. [Source and license](https://commons.wikimedia.org/wiki/File:Example.webm)
4. Paste the Commons description page URL, a YouTube page, or a direct URL on any other host. **Load file** must reject it without sending a request or offering a file. No account or test credentials are needed.

中文测试顺序为点击扩展图标、粘贴上面的 Ogg 原始文件链接、点击「读取文件」，再点击「保存文件」。可检查下载列表中的文件名。把普通网页地址或其他主机的媒体链接粘贴进去时，应立即提示不支持。

### Permission and data disclosures

- `https://upload.wikimedia.org/*` allows the extension tab to retrieve a selected original Commons media file. The code additionally restricts requests to the original-file path and downloads only validated Ogg or WebM bytes. No other browser permissions are declared.
- The upload host receives a standard HTTPS media request only after the user selects **Load file**. The request carries no browser credentials or referrer. Pasted query parameters and fragments are discarded. There is no extension account, analytics endpoint, local server, or externally loaded executable code. [Store edition privacy explanation](PRIVACY.md)
- For Firefox, select desktop only. The Gecko minimum is Firefox 140. The candidate ZIP is unsigned. Mozilla signs approved submissions.

## Reproduce and identify the packages

Extract `VideoSave-Commons-1.0.0-source.zip` and run these commands from the extracted root or the checkout.

```powershell
python -B packaging/stores/edition/build.py
node --test tests/store-edition.test.mjs
```

The build uses Python’s standard library. It copies the JavaScript and CSS without bundling. The source archive contains the build scripts, tests, and exact icon assets. The build writes the files below to `dist/store-edition`.

| File | Intended use |
| --- | --- |
| `VideoSave-Commons-1.0.0-chromium.zip` | Edge Add-ons and Chrome Web Store candidate |
| `VideoSave-Commons-1.0.0-firefox.zip` | Firefox AMO desktop candidate |
| `VideoSave-Commons-1.0.0-source.zip` | Reviewer source and build instructions |
| `SHA256SUMS.txt` | Package checksums |

Before upload, put the edition privacy policy at a public URL and capture actual screenshots of the candidate. Do not use screenshots of the full release’s companion, AI interface, or Android app as store-edition screenshots.
