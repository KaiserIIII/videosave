import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net, { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installation = {
  edge:[process.env.EDGE_BIN,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  chrome:[process.env.CHROME_BIN,'C:/Program Files/Google/Chrome/Application/chrome.exe'],
  firefox:[process.env.FIREFOX_BIN,'C:/Program Files/Mozilla Firefox/firefox.exe'],
};
export const executable = browser => installation[browser]?.find(file => file && existsSync(file));

export async function until(read, timeoutMs=10_000) {
  const end = performance.now() + timeoutMs;
  let error;
  do {
    try {
      const result = await read();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await sleep(80);
  } while (performance.now() < end);
  throw Error('Browser test condition timed out', {cause:error});
}

const here = fileURLToPath(new URL('../',import.meta.url));

export async function withChromiumExtension(browser, source, output, run) {
  const {connectCdp, withChromium} = await import(pathToFileURL(path.join(here,'tools/edge-session.mjs')).href);
  const signal = AbortSignal.timeout(300_000);
  const extension = path.join(source,'extension');
  return withChromium(['--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--autoplay-policy=no-user-gesture-required','--load-extension=' + extension],
  async ({list,browserUrl}) => {
    const inspector = await connectCdp(browserUrl,signal);
    try {
      const background = () => list().then(rows => rows.find(row => row.type === 'service_worker' &&
        row.url.startsWith('chrome-extension:') && row.url.endsWith('/background.mjs')));
      if (!(await background())) {
        // Chrome stable can ignore --load-extension. Continue with the explicit developer command.
        await inspector.send('Extensions.loadUnpacked',{path:extension}).catch(() => {});
      }
      const worker = await until(background);
      const tab = (await list()).find(row => row.type === 'page' && row.url === 'about:blank');
      const page = await connectCdp(tab.webSocketDebuggerUrl,signal);
      const version = (await inspector.send('Browser.getVersion')).product;
      try {
        await page.send('Performance.enable');
        await run({
          version:version.split('/').at(-1),
          async navigate(url) {
            const result = await page.send('Page.navigate',{url});
            if (!result.errorText && result.loaderId) {
              await until(async () => (await page.send('Page.getFrameTree')).frameTree.frame.loaderId ===
                result.loaderId, 10_000).catch(() => {});
            }
            return result;
          },
          pageEval:expression => page.evaluate(expression),
          metrics:async () => {
            const metrics = Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(({name,value}) => [name,value]));
            return {taskMs:Math.round(metrics.TaskDuration * 1000),heapBytes:metrics.JSHeapUsedSize};
          },
          async popup(use) {
            const {targetId} = await inspector.send('Target.createTarget',{
              url:new URL('/popup.html',worker.url).href,background:true,
            });
            const target = await until(() => list().then(rows => rows.find(row => row.id === targetId)));
            const popup = await connectCdp(target.webSocketDebuggerUrl,signal);
            try {
              await page.send('Page.bringToFront');
              await popup.send('Page.reload');
              await use(expression => popup.evaluate(expression));
            } finally {
              popup.close();
              await inspector.send('Target.closeTarget',{targetId});
            }
          },
        });
      } finally {
        page.close();
      }
    } finally {
      inspector.close();
    }
  },signal,{executable:executable(browser),downloadsDirectory:output});
}

async function openMarionette(port) {
  const socket = await new Promise((resolve,reject) => {
    const connection = net.connect(port,'127.0.0.1',() => resolve(connection));
    connection.once('error',reject);
  });
  let nextId = 0;
  let pending = Buffer.alloc(0);
  const calls = new Map();
  const ready = Promise.withResolvers();
  function fail(error) {
    ready.reject(error);
    for (const item of calls.values()) item.reject(error);
  }
  socket.on('error',fail);
  socket.on('close',() => fail(Error('Firefox Marionette connection closed')));
  socket.on('data',chunk => {
    pending = Buffer.concat([pending,chunk]);
    while (pending.length) {
      const colon = pending.indexOf(58);
      if (colon < 0) break;
      const end = colon + 1 + Number(pending.subarray(0,colon).toString());
      if (end > pending.length) break;
      const reply = JSON.parse(pending.subarray(colon + 1,end).toString());
      pending = pending.subarray(end);
      if (!Array.isArray(reply)) {
        ready.resolve(reply);
        continue;
      }
      const [,id,error,result] = reply;
      const item = calls.get(id);
      if (error) item?.reject(Error(error.error + ': ' + error.message));
      else item?.resolve(result);
    }
  });
  await ready.promise;
  return {
    close:() => socket.destroy(),
    async call(method, params={}) {
      const id = ++nextId;
      const reply = Promise.withResolvers();
      calls.set(id,reply);
      const message = Buffer.from(JSON.stringify([0,id,method,params]));
      const timer = setTimeout(() => reply.reject(Error('Firefox Marionette timeout: ' + method)),12_000);
      try {
        socket.write(Buffer.concat([Buffer.from(message.length + ':'),message]));
        return await reply.promise;
      } finally {
        clearTimeout(timer);
        calls.delete(id);
      }
    },
  };
}

async function openPort() {
  const listener = createServer().listen(0,'127.0.0.1');
  await once(listener,'listening');
  const {port} = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export async function withFirefoxExtension(source, work, output, run) {
  const profile = path.join(work,'firefox-profile');
  await mkdir(profile);
  const port = await openPort();
  await writeFile(path.join(profile,'user.js'), Object.entries({
    'marionette.port':port,
    'browser.download.folderList':2,
    'browser.download.dir':output,
    'browser.download.useDownloadDir':true,
    'browser.shell.checkDefaultBrowser':false,
    'browser.startup.page':0,
    'extensions.update.enabled':false,
  }).map(([key,value]) => 'user_pref(' + JSON.stringify(key) + ', ' + JSON.stringify(value) + ');').join('\n'));
  // Marionette needs system access to install and inspect the extension in this isolated test profile.
  const browser = spawn(executable('firefox'),['-headless','-no-remote','-profile',profile,'-marionette',
    '-remote-allow-system-access','about:blank'],{
    stdio:'ignore',windowsHide:true,env:{...process.env,MOZ_REMOTE_ALLOW_SYSTEM_ACCESS:'1'},
  });
  let launched;
  browser.on('error',error => { launched = error; });
  let driver;
  try {
    driver = await until(() => openMarionette(port));
    const {capabilities} = await driver.call('WebDriver:NewSession',{capabilities:{alwaysMatch:{pageLoadStrategy:'none'},firstMatch:[{}]}});
    const {value:id} = await driver.call('Addon:Install',{path:path.join(source,'extension'),temporary:true});
    const uuid = await until(async () => {
      const prefs = await readFile(path.join(profile,'prefs.js'),'utf8');
      const row = /^user_pref\("extensions\.webextensions\.uuids", (".*")\);$/m.exec(prefs);
      return row && JSON.parse(JSON.parse(row[1]))[id];
    },3000).catch(() => null);
    const evaluate = script => driver.call('WebDriver:ExecuteScript',{script,args:[]}).then(reply => reply.value);
    const asyncEvaluate = script => driver.call('WebDriver:ExecuteAsyncScript',{script,args:[]}).then(reply => reply.value);
    const context = value => driver.call('Marionette:SetContext',{value});
    const sourceWindow = (await driver.call('WebDriver:GetWindowHandle')).value;
    const switchTo = handle => driver.call('WebDriver:SwitchToWindow',{handle,focus:false});
    await context('chrome');
    const popupId = uuid ?? await evaluate('return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids","{}"))['
      + JSON.stringify(id) + '];');
    await context('content');
    if (!popupId) throw Error('Firefox did not register the temporary extension');
    const getHandles = async () => {
      const result = await driver.call('WebDriver:GetWindowHandles');
      return Array.isArray(result) ? result : result.value;
    };
    await run({
      version:capabilities.browserVersion,
      async navigate(url) {
        const previous = await evaluate('return location.href;');
        await context('chrome');
        try {
          await evaluate('gBrowser.selectedBrowser.fixupAndLoadURIString(' + JSON.stringify(url) +
            ', {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()}); return true;');
        } finally {
          await context('content');
        }
        await until(() => evaluate('return location.href !== ' + JSON.stringify(previous) + ';'), 10_000)
          .catch(() => {});
      },
      pageEval:expression => evaluate('return (' + expression + ');'),
      async popup(use) {
        const handles = await getHandles();
        await context('chrome');
        await evaluate('gBrowser.addTrustedTab(' + JSON.stringify('moz-extension://' + popupId + '/popup.html') +
          ',{inBackground:true}); return true;');
        await context('content');
        const handle = await until(async () => (await getHandles()).find(candidate => !handles.includes(candidate)));
        try {
          await use(async expression => {
            await switchTo(handle);
            try {
              return await asyncEvaluate('const done=arguments[arguments.length-1]; ' +
                'Promise.resolve((' + expression + ')).then(done,error=>done({marionetteError:String(error)}));');
            } finally {
              await switchTo(sourceWindow);
            }
          });
        } finally {
          await switchTo(handle);
          await driver.call('WebDriver:CloseWindow');
          await switchTo(sourceWindow);
        }
      },
    });
  } catch (error) {
    throw launched ?? error;
  } finally {
    if (driver) {
      await driver.call('Marionette:Quit',{flags:['eForceQuit']}).catch(() => {});
      driver.close();
    }
    if (browser.exitCode === null) browser.kill();
  }
}
