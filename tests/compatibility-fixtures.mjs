import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const video = (src = 'film.mp4', other = '') => '<video controls src="' + src + '" ' + other + '></video>';
const script = content => '<script>' + content + '</script>';
const request = source => 'fetch(' + JSON.stringify(source) + ').then(r => r.arrayBuffer()).catch(() => {});';
const config = value => '<script type="application/json">' + JSON.stringify(value) + '</script>';
const jsonLd = value => '<script type="application/ld+json">' + JSON.stringify(value) + '</script>';
const playAction = "document.querySelector('#play-fixture')?.click()";
const delayed = (markup, ms) => script('setTimeout(() => document.body.insertAdjacentHTML("beforeend",' +
  JSON.stringify(markup) + '),' + ms + ');');
const formats = [
  ['mp4','film.mp4','video/mp4'],['webm','film.webm','video/webm'],['mov','film.mov','video/quicktime'],
  ['mkv','film.mkv','video/x-matroska'],['flv','film.flv','video/x-flv'],
  ['hls','film.m3u8','application/vnd.apple.mpegurl'],['dash','film.mpd','application/dash+xml'],
];
const structures = [
  ['typed-source',(src,mime) => `<video controls><source src="${src}" type="${mime}"></video>`],
  ['late-dom',src => delayed(video(src),1100)],
  ['open-shadow',src => '<section id="root"></section>' + script(
    'document.getElementById("root").attachShadow({mode:"open"}).innerHTML=' + JSON.stringify(video(src)))],
  ['nested-frame',src => `<iframe src="/nested/${src}"></iframe>`],
  ['network-signed',src => script(request(src + '?ticket=fixture'))],
  ['network-no-suffix',(_src,_mime,kind) => script(request('body-' + kind))],
  ['schema-video',src => jsonLd({'@type':'VideoObject',name:'The test film',contentUrl:src})],
  ['public-player-config',(src,mime) => config({playlist:[{sources:[{file:src,type:mime}]}]})],
];
const formatScenarios = formats.flatMap(([kind,src,mime]) => structures.map(([name,html]) => ({
  id:`${kind}-${name}`,expected:[name === 'network-no-suffix' ? 'body-' + kind : src],html:html(src,mime,kind),
  ...(name === 'network-signed' && ['mov','mkv','flv'].includes(kind) && {download:true,browserDownload:false}),
})));
const msePlayback = video('', 'autoplay muted') + script(`
  const element = document.querySelector('video');
  const type = 'video/mp4; codecs="avc1.64001F,mp4a.40.2"';
  if (self.MediaSource?.isTypeSupported(type)) {
    const source = new MediaSource();
    element.src = URL.createObjectURL(source);
    source.addEventListener('sourceopen', async () => {
      const playlist = await fetch('fmp4.m3u8').then(result => result.text());
      const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)[1];
      const fragments = playlist.split(/\\r?\\n/).filter(line => /\\.m4s$/.test(line));
      const buffer = source.addSourceBuffer(type);
      for (const address of [init,...fragments]) {
        const bytes = await fetch(address).then(result => result.arrayBuffer());
        await new Promise(resolve => {
          buffer.addEventListener('updateend',resolve,{once:true});
          buffer.appendBuffer(bytes);
        });
      }
      source.endOfStream();
    },{once:true});
  }
`);

export const compatibilityCases = [
  {id:'mp4', expected:['film.mp4'], download:true, html:video()},
  {id:'webm', expected:['film.webm'], download:true, html:video('film.webm')},
  {id:'audio-element', expected:['sound.m4a'], download:true, audio:true,
    html:'<audio controls src="sound.m4a"></audio>'},
  {id:'audio-source', expected:['sound.m4a'], html:'<audio controls><source src="sound.m4a" type="audio/mp4"></audio>'},
  {id:'source-elements', expected:['film.mp4'], alternatives:['film.webm'],
    html:'<video controls><source src="film.mp4" type="video/mp4"><source src="film.webm" type="video/webm"></video>'},
  {id:'extensionless-dom', expected:['raw'], html:video('raw')},
  {id:'extensionless-network', expected:['raw'], html:script(request('raw'))},
  {id:'network-webm', expected:['raw-webm'], html:script(request('raw-webm'))},
  {id:'native-hls-url', expected:['film.m3u8'], download:true, html:video('film.m3u8')},
  {id:'network-hls', expected:['film.m3u8'], html:script(request('film.m3u8'))},
  {id:'network-hls-mime', expected:['manifest'], html:script(request('manifest'))},
  {id:'network-dash', expected:['film.mpd'], download:true, browserDownload:false, html:script(request('film.mpd'))},
  {id:'network-dash-mime', expected:['dashmanifest'], html:script(request('dashmanifest'))},
  {id:'external-audio-hls', expected:['separate.m3u8'], download:true, browserDownload:false,
    html:script(request('separate.m3u8'))},
  {id:'mse-hls-blob', expected:['film.m3u8'], html:video('') + script(
    'const element=document.querySelector("video"); if (self.MediaSource) { element.src=URL.createObjectURL(new MediaSource()); ' +
    request('film.m3u8') + '}')},
  {id:'mse-dash-blob', expected:['film.mpd'], html:video('') + script(
    'const element=document.querySelector("video"); if (self.MediaSource) { element.src=URL.createObjectURL(new MediaSource()); ' +
    request('film.mpd') + '}')},
  {id:'mse-sourcebuffer', expected:['fmp4.m3u8'], html:msePlayback},
  {id:'fmp4-hls', expected:['fmp4.m3u8'], download:true, html:script(request('fmp4.m3u8'))},
  {id:'only-fragments', expected:[], diagnostic:'unsupported-format', html:script(request('init.mp4') + request('chunk-0.m4s'))},
  {id:'same-origin-iframe', expected:['film.mp4'], html:'<iframe src="/embed"></iframe>'},
  {id:'cross-origin-iframe', expected:['film.mp4'], html:({port}) => '<iframe src="http://localhost:' + port + '/embed"></iframe>'},
  {id:'nested-iframe', expected:['film.mp4'], html:'<iframe src="/nested"></iframe>'},
  {id:'srcdoc-player', expected:['film.mp4'], html:"<iframe srcdoc='<video controls src=\"film.mp4\"></video>'></iframe>"},
  {id:'open-shadow', expected:['film.mp4'], html:'<div id="host"></div>' + script(
    'document.getElementById("host").attachShadow({mode:"open"}).innerHTML=' + JSON.stringify(video()) + ';')},
  {id:'nested-shadow', expected:['film.mp4'], html:'<div id="host"></div>' + script(
    'const root=document.getElementById("host").attachShadow({mode:"open"}); root.innerHTML="<section></section>";' +
    'root.querySelector("section").attachShadow({mode:"open"}).innerHTML=' + JSON.stringify(video()) + ';')},
  {id:'shadow-delayed', expected:['film.mp4'], html:'<div id="host"></div>' + script(
    'const sh=document.getElementById("host").attachShadow({mode:"open"}); setTimeout(() => sh.innerHTML=' +
    JSON.stringify(video()) + ',2600);')},
  {id:'shadow-attach-late', expected:['film.mp4'], html:'<div id="host"></div>' + script(
    'setTimeout(() => { document.querySelector("#host").attachShadow({mode:"open"}).innerHTML=' +
    JSON.stringify(video('film.mp4','preload="none"')) + '; },1400);')},
  {id:'structured-video', expected:['film.mp4'],
    html:jsonLd({'@context':'https://schema.org','@type':'VideoObject',name:'The test film',contentUrl:'film.mp4'})},
  {id:'structured-graph', expected:['film.webm'],
    html:jsonLd({'@graph':[{'@type':'VideoObject',name:'The test film',contentUrl:'film.webm'}]})},
  {id:'open-graph-video', expected:['film.mp4'],
    html:'<meta property="og:video" content="film.mp4"><meta property="og:video:type" content="video/mp4">'},
  {id:'player-json', expected:['film.m3u8'], html:config({playlist:[{sources:[{file:'film.m3u8',type:'application/vnd.apple.mpegurl'}]}]})},
  {id:'dynamic-json', expected:['film.m3u8'], html:script('fetch("sources.json").then(response => response.json());')},
  {id:'delay-early', expected:['film.mp4'], html:delayed(video(),350)},
  {id:'delay-late', expected:['film.mp4'], html:delayed(video(),2600)},
  {id:'spa-route', expected:['film.mp4'], html:script(
    'setTimeout(() => { history.pushState({}, "", "/route/watch/feature"); document.body.innerHTML=' +
    JSON.stringify(video('/film.mp4')) + ';},2600);')},
  {id:'play-event', expected:['film.mp4'], browserAction:playAction,
    html:'<div class="video-js">' + video('', 'style="width:300px;height:150px"') +
    '<button id="play-fixture" class="vjs-big-play-button">Play Video</button></div>' + script(
    'document.getElementById("play-fixture").addEventListener("click",() => { const element=document.querySelector("video");' +
    'element.src="film.mp4"; element.muted=true; element.play().catch(() => {}); });')},
  {id:'user-scroll', expected:['film.mp4'], mcp:false, browserAction:'window.scrollTo(0,document.body.scrollHeight)',
    html:'<div style="height:1600px"></div><div id="target"></div>' + script(
    'new IntersectionObserver(([entry],observer) => { if (!entry.isIntersecting) return; observer.disconnect();' +
    'entry.target.innerHTML=' + JSON.stringify(video()) + '; }).observe(document.getElementById("target"));')},
  {id:'preroll', expected:['film.mp4'], forbidden:['ad.mp4'],
    html:'<section class="preroll">' + video('ad.mp4', 'autoplay muted') + '</section>' + video()},
  {id:'long-trailer', expected:['film.mp4','trailer.mp4'], selected:'film.mp4',
    html:'<article><h2>Official trailer</h2>' + video('trailer.mp4', 'title="Official trailer"') +
    '</article><article><h2>The test film</h2>' + video('film.mp4', 'title="The test film"') + '</article>'},
  {id:'multi-ambiguous', expected:['film.mp4','other.mp4'], ambiguous:true,
    html:'<article>' + video('film.mp4', 'title="Program One"') + '</article><article>' +
    video('other.mp4', 'title="Program Two"') + '</article>'},
  {id:'html-fake-mp4', expected:[], html:script(request('fake.mp4'))},
  {id:'empty', expected:[], reason:'no-player', html:'<p>No media</p>'},
  {id:'player-empty', expected:[], reason:'no-playlist-request', html:video('')},
  {id:'http-login', expected:[], reason:'blocked', blocker:'login-required', status:401, html:'<h1>Login required</h1>'},
  {id:'http-paywall', expected:[], reason:'blocked', blocker:'paywall', status:402, html:'<h1>Payment Required</h1>'},
  {id:'http-restricted', expected:[], reason:'blocked', status:403, html:'<h1>Restricted</h1>'},
  {id:'http-legal-451', expected:[], reason:'blocked', status:451, html:'<h1>Unavailable For Legal Reasons</h1>'},
  {id:'challenge-header', expected:[], reason:'blocked', blocker:'cloudflare-challenge', status:403, html:'<p>Challenge</p>'},
  {id:'protected-hls', expected:[], blocker:'drm', html:script(request('protected.m3u8'))},
  {id:'protected-dash', expected:[], blocker:'drm', html:script(request('protected.mpd'))},
  {id:'json-fake-mp4', expected:[], html:script(request('json-error.mp4'))},
  {id:'disguised-jpeg-hls', expected:['jpeg-hls.m3u8'], download:true, browserDownload:false, html:script(request('jpeg-hls.m3u8'))},
  {id:'disguised-png-hls', expected:['png-hls.m3u8'], html:script(request('png-hls.m3u8'))},
  {id:'extensionless-hls-segs', expected:['extless-hls.m3u8'], html:script(request('extless-hls.m3u8'))},
  {id:'subtitled-hls', expected:['sub-master.m3u8'], html:script(request('sub-master.m3u8'))},
  {id:'variant-404-fallback-hls', expected:['fallback-master.m3u8'], download:true, browserDownload:false, html:script(request('fallback-master.m3u8'))},
  {id:'webm-dash', expected:['film-webm.mpd'], download:true, browserDownload:false, html:script(request('film-webm.mpd'))},
  {id:'audio-mp3', expected:['sound.mp3'], html:'<audio controls src="sound.mp3"></audio>'},
  {id:'audio-flac', expected:['sound.flac'], html:'<audio controls src="sound.flac"></audio>'},
  {id:'custom-jwplayer-json', expected:['film.m3u8'], html:config({file:'film.m3u8',type:'hls'})},
  {id:'complete-transport-stream',expected:['film.ts'],download:true,browserDownload:false,
    html:'<video controls><source src="film.ts" type="video/mp2t"></video>'},
  ...formatScenarios,
];

export const publicCases = [
  {id:'public-mdn-rabbit', expected:['rabbit320.mp4','rabbit320.webm'], any:true, download:true,
    url:'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/simple-video.html'},
  {id:'public-mdn-inline-video', expected:['flower.webm','flower.mp4'], any:true,
    url:'https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html'},
  {id:'public-w3c-sintel', expected:['trailer.mp4', 'trailer.webm'], alternatives:['trailer.ogv'], any:true,
    url:'https://www.w3.org/2010/05/video/mediaevents.html'},
  {id:'public-hlsjs-demo', expected:['x36xhzz.m3u8'], alternatives:['193039199_mp4_h264_aac_7.m3u8',
    '193039199_mp4_h264_aac_hd_7.m3u8','193039199_mp4_h264_aac_hq_7.m3u8','193039199_mp4_h264_aac_ld_7.m3u8',
    '193039199_mp4_h264_aac_uhd_7.m3u8'],
    url:'https://hlsjs.video-dev.org/demo/basic-usage.html'},
  {id:'public-dashjs-demo', expected:['bbb_30fps.mpd'],
    url:'https://reference.dashif.org/dash.js/latest/samples/getting-started/auto-load-single-video.html'},
  {id:'public-apple-fmp4', expected:['prog_index.m3u8'], download:true, browserDownload:false, html:script(request(
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v3/prog_index.m3u8'))},
  {id:'public-mux-hls', expected:['193039199_mp4_h264_aac_7.m3u8'], browserDownload:false, html:script(request(
    'https://test-streams.mux.dev/x36xhzz/url_4/193039199_mp4_h264_aac_7.m3u8'))},
];

function encode(directory, args) {
  execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner','-loglevel','error','-y',...args],
    {cwd:directory, windowsHide:true});
}

function buildMedia(directory) {
  const picture = ['-f','lavfi','-i','testsrc2=size=192x108:rate=15'];
  const sound = ['-f','lavfi','-i','sine=frequency=720'];
  const h264 = ['-c:v','libx264','-pix_fmt','yuv420p','-g','15','-sc_threshold','0'];
  encode(directory, [...picture,...sound,'-t','3',...h264,'-c:a','aac','-movflags','+faststart','film.mp4']);
  encode(directory, [...picture,...sound,'-t','3','-c:v','libvpx-vp9','-c:a','libopus','film.webm']);
  encode(directory, [...picture,'-t','6',...h264,'-movflags','+faststart','trailer.mp4']);
  encode(directory, [...sound,'-t','3','-c:a','aac','sound.m4a']);
  encode(directory, [...sound,'-t','2','-c:a','libmp3lame','sound.mp3']);
  encode(directory, [...sound,'-t','2','-c:a','flac','sound.flac']);
  const hls = ['-hls_time','1','-hls_list_size','0'];
  encode(directory, ['-i','film.mp4','-c','copy',...hls,'film.m3u8']);
  encode(directory, ['-i','film.mp4','-c','copy',...hls,'-hls_segment_type','fmp4',
    '-hls_fmp4_init_filename','fixture-init.mp4','fmp4.m3u8']);
  encode(directory, ['-i','film.mp4','-map','0:v','-c','copy',...hls,'video.m3u8']);
  encode(directory, ['-i','film.mp4','-map','0:a','-c','copy',...hls,'audio.m3u8']);
  encode(directory, ['-i','film.mp4','-c','copy','-f','dash','-seg_duration','1','film.mpd']);
  encode(directory, ['-i','film.webm','-c','copy','-f','dash','-seg_duration','1','film-webm.mpd']);
  for (const extension of ['mov','mkv','flv','ts']) encode(directory,['-i','film.mp4','-c','copy','film.' + extension]);
}

const types = {m3u8:'application/vnd.apple.mpegurl',mpd:'application/dash+xml',
  m4s:'video/iso.segment',ts:'video/mp2t',mp4:'video/mp4',m4a:'audio/mp4',mp3:'audio/mpeg',flac:'audio/flac',webm:'video/webm',
  mov:'video/quicktime',mkv:'video/x-matroska',flv:'video/x-flv',vtt:'text/vtt'};
const aliases = {'raw':'film.mp4','raw-webm':'film.webm','manifest':'film.m3u8','dashmanifest':'film.mpd',
  'ad.mp4':'film.mp4','other.mp4':'film.mp4','init.mp4':'film.mp4','chunk-0.m4s':'film.mp4',
  'seg0.jpeg':'film0.ts','seg1.jpeg':'film1.ts','seg2.jpeg':'film2.ts',
  'seg0.png':'film0.ts','seg1.png':'film1.ts','seg2.png':'film2.ts',
  'seg0':'film0.ts','seg1':'film1.ts','seg2':'film2.ts',
  ...Object.fromEntries(formats.map(([kind,src]) => ['body-' + kind,src]))};

export async function serveFixtures(directory, cases) {
  buildMedia(directory);
  await writeFile(path.join(directory,'separate.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=192x108,AUDIO="main"\nvideo.m3u8\n');
  await writeFile(path.join(directory,'jpeg-hls.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n' +
    '#EXTINF:1.0,\nseg0.jpeg\n#EXTINF:1.0,\nseg1.jpeg\n#EXTINF:1.0,\nseg2.jpeg\n#EXT-X-ENDLIST\n');
  await writeFile(path.join(directory,'png-hls.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n' +
    '#EXTINF:1.0,\nseg0.png\n#EXTINF:1.0,\nseg1.png\n#EXTINF:1.0,\nseg2.png\n#EXT-X-ENDLIST\n');
  await writeFile(path.join(directory,'extless-hls.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n' +
    '#EXTINF:1.0,\nseg0\n#EXTINF:1.0,\nseg1\n#EXTINF:1.0,\nseg2\n#EXT-X-ENDLIST\n');
  await writeFile(path.join(directory,'sub-track.vtt'), 'WEBVTT\n\n00:00.100 --> 00:02.000\nFixture subtitle\n');
  await writeFile(path.join(directory,'sub-pl.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3.0,\nsub-track.vtt\n#EXT-X-ENDLIST\n');
  await writeFile(path.join(directory,'sub-master.m3u8'), '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="sub-pl.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=192x108,SUBTITLES="subs"\nfilm.m3u8\n');
  await writeFile(path.join(directory,'fallback-master.m3u8'), '#EXTM3U\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nmissing-1080.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=192x108\nfilm.m3u8\n');
  const casesByPath = new Map(cases.filter(test => !test.url).map(test => ['/case/' + test.id, test]));
  let requests = 0;
  let bytes = 0;
  let reservedRequests = 0;
  const server = createServer(async (req,res) => {
    requests++;
    const url = new URL(req.url,'http://localhost');
    const test = casesByPath.get(url.pathname);
    const common = {'cache-control':'no-store'};
    if (test) {
      const body = typeof test.html === 'function' ? test.html({port:server.address().port}) : test.html;
      return res.writeHead(test.status ?? 200,{
        ...common, 'content-type':'text/html; charset=utf-8',
        ...(test.id === 'challenge-header' && {'cf-mitigated':'challenge'}),
      }).end('<!doctype html><html><head><meta charset="utf-8"><title>The test film</title></head><body>' + body + '</body></html>');
    }
    if (url.pathname === '/embed' || url.pathname === '/nested') {
      return res.writeHead(200,{...common,'content-type':'text/html'}).end(url.pathname === '/embed'
        ? video('/film.mp4') : '<iframe src="/embed"></iframe>');
    }
    const embedded = /^\/(nested|embed)\/(film\.(?:mp4|webm|mov|mkv|flv|m3u8|mpd))$/.exec(url.pathname);
    if (embedded) return res.writeHead(200,{...common,'content-type':'text/html'}).end(embedded[1] === 'nested'
      ? `<iframe src="/embed/${embedded[2]}"></iframe>` : video('/' + embedded[2]));
    const name = path.posix.basename(url.pathname);
    if (name === 'sources.json') return res.writeHead(200,{...common,'content-type':'application/json'})
      .end('{"playlist":[{"sources":[{"file":"film.m3u8"}]}]}');
    if (name === 'fake.mp4') return res.writeHead(200,{...common,'content-type':'text/html'}).end('<p>Text</p>');
    if (name === 'json-error.mp4') return res.writeHead(200,{...common,'content-type':'application/json'}).end('{"error":"not-found"}');
    if (name === 'protected.m3u8') return res.writeHead(200,{...common,'content-type':types.m3u8}).end(
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="reserved-key"\n' +
      '#EXTINF:1.0,\nreserved-segment.ts\n#EXT-X-ENDLIST\n');
    if (name === 'protected.mpd') return res.writeHead(200,{...common,'content-type':types.mpd}).end(
      '<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="1"/></AdaptationSet></Period></MPD>');
    if (name === 'reserved-key' || name === 'reserved-segment.ts') {
      reservedRequests++;
      return res.writeHead(403).end();
    }
    if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
    const file = aliases[name] ?? name;
    const data = await readFile(path.join(directory,file)).catch(() => null);
    if (!data) return res.writeHead(404).end();
    const type = types[name.split('.').at(-1)] ?? types[file.split('.').at(-1)] ?? 'application/octet-stream';
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    if (start > end) return res.writeHead(416,{'content-range':'bytes */' + data.length}).end();
    const part = data.subarray(start,end + 1);
    res.writeHead(range ? 206 : 200,{
      ...common, 'content-type':type, 'content-length':part.length,
      'accept-ranges':'bytes', etag:'"fixture-' + file + '"',
      ...(range && {'content-range':'bytes ' + start + '-' + end + '/' + data.length}),
    });
    if (req.method === 'HEAD') return res.end();
    bytes += part.length;
    return res.end(part);
  });
  let port;
  try {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    port = server.address().port;
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    stats:() => ({requests,bytes,reservedRequests}),
    page:test => test.url ?? 'http://127.0.0.1:' + port + '/case/' + test.id,
    close:async () => {
      const stopped = once(server,'close');
      server.close();
      server.closeAllConnections();
      await stopped;
    },
  };
}
