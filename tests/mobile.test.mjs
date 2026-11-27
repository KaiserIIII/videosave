import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectCdp, withEdge } from '../tools/edge-session.mjs';

const directory = fileURLToPath(new URL('../extension/', import.meta.url));
const mobileApis = `
  const storage = {onChanged:{addListener() {}},
    get:async () => ({downloadSettings:JSON.parse(localStorage.getItem('settings'))}),
    set:async ({downloadSettings}) => localStorage.setItem('settings', JSON.stringify(downloadSettings)),
  };
  globalThis.browser = {
    storage:{local:storage, session:storage},
    i18n:{getUILanguage:() => new URLSearchParams(location.search).get('locale') || 'zh-TW'},
    tabs:{
      query:async () => [{id:7, url:'https://media.example/film'}],
      create:async ({url}) => { globalThis.openedMedia = url; },
    },
    scripting:{executeScript:async () => [{frameId:0, result:{pageTitle:'Mobile test', candidates:[
      {url:'https://media.example/film.mp4', title:'Direct video', mediaElement:true, duration:52},
      {url:'https://media.example/master.m3u8', title:'Segmented stream'},
    ]}}]},
  };
`;

test('mobile panel opens a direct video when browser download APIs are unavailable', async () => {
  const fixture = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    const type = /^([a-z-]+)\.(html|mjs|css)$/.exec(name)?.[2];
    const data = type && await readFile(path.join(directory, name), 'utf8').catch(() => '');
    if (!data) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', {html:'text/html', mjs:'text/javascript', css:'text/css'}[type] + '; charset=utf-8');
    res.end(type === 'html' ? data.replace('<head>', '<head><script>' + mobileApis + '</script>') : data);
  }).listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const signal = AbortSignal.timeout(20_000);
  try {
    await withEdge([], async ({list,profile}) => {
      const preferences = JSON.parse(await readFile(path.join(profile,'Default','Preferences'),'utf8'));
      assert.equal(path.normalize(preferences.download.default_directory),path.join(profile,'Downloads'));
      const target = (await list()).find(entry => entry.type === 'page');
      const page = await connectCdp(target.webSocketDebuggerUrl, signal);
      try {
        await page.send('Emulation.setDeviceMetricsOverride', {width:320, height:640, deviceScaleFactor:1, mobile:true});
        const url = `http://127.0.0.1:${fixture.address().port}/popup.html`;
        const waitForPanel = async () => {
          for (let i = 0; i < 40; i++) {
            if (await page.evaluate('Boolean(document.querySelector(".download-button"))').catch(() => false)) return;
            await sleep(100, undefined, {signal});
          }
          assert.fail('Mobile media panel did not render');
        };
        await page.send('Page.navigate', {url});
        await waitForPanel();
        const state = await page.evaluate(`({
          rows:document.querySelectorAll('#media li').length,
          label:document.querySelector('.download-button')?.textContent,
          queueHidden:document.querySelector('#downloads-toggle').hidden,
          width:document.documentElement.scrollWidth,
          viewport:innerWidth,
        })`);
        assert.deepEqual(state, {rows:1, label:'打开视频', queueHidden:true, width:320, viewport:320});
        await page.evaluate('document.querySelector(".download-button").click()');
        assert.equal(await page.evaluate('globalThis.openedMedia'), 'https://media.example/film.mp4');

        const settings = `(() => {
          document.querySelector('#settings-toggle').click();
          document.querySelector('#appearance-settings').open = true;
          return document.querySelector('[data-option=language]')?.value;
        })()`;
        const select = value => page.evaluate(`(() => {
          const menu = document.querySelector('[data-option=language]');
          menu.value = ${JSON.stringify(value)};
          menu.dispatchEvent(new Event('change'));
        })()`);
        assert.equal(await page.evaluate(settings), 'system');
        await select('en');
        assert.deepEqual(await page.evaluate(`({
          lang:document.documentElement.lang,
          label:document.querySelector('#settings-toggle').textContent.trim(),
          open:document.querySelector('#appearance-settings').open,
          control:document.querySelector('[data-option=language]').getBoundingClientRect().right <= innerWidth,
          title:document.querySelector('.media-title').textContent,
        })`), {lang:'en',label:'Settings',open:true,control:true,title:'Direct video'});
        await page.send('Page.reload');
        await waitForPanel();
        assert.equal(await page.evaluate(settings), 'en');
        assert.equal(await page.evaluate('document.querySelector(".download-button").textContent'), 'Open video');
        await select('zh-CN');
        assert.equal(await page.evaluate('document.querySelector("#settings-toggle").textContent'), '设置');
        await select('system');
        assert.equal(await page.evaluate('document.documentElement.lang'), 'zh-CN');
        for (const locale of ['en-GB', 'fr-FR']) {
          await page.send('Page.navigate', {url:url + '?locale=' + locale});
          await waitForPanel();
          assert.equal(await page.evaluate('document.documentElement.lang'), 'en');
        }
        assert.equal(await page.evaluate(settings), 'system');
        await select('zh-CN');
        assert.equal(await page.evaluate('document.documentElement.lang'), 'zh-CN');
      } finally { page.close(); }
    }, signal);
  } finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
});
