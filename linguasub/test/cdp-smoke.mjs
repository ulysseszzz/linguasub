/*
 * LinguaSub end-to-end smoke test (no manual browser needed):
 *   1. Serves the extension directory over a random http://127.0.0.1 port (Node)
 *   2. Launches headless Chrome on a random CDP port with --load-extension
 *   3. Verifies the MV3 service worker is alive and chrome.* APIs are usable
 *   4. Opens a normal page and verifies the content script injected (lsBoot marker)
 *   5. Loads the vendored Transformers.js bundle and downloads the real NLLB
 *      tokenizer from HuggingFace (local-model stack connectivity check).
 *
 * Run: node --experimental-websocket test/cdp-smoke.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// Set LS_CHROME_BIN to a Chrome for Testing / Chromium binary when the managed
// Google Chrome blocks --load-extension via ExtensionInstallBlocklist policy.
function detectChrome() {
  if (process.env.LS_CHROME_BIN) return process.env.LS_CHROME_BIN;
  // Auto-detect a puppeteer-installed Chrome for Testing (macOS arm64/x64).
  const cfTBase = '/tmp/linguasub-browser/chrome';
  try {
    const versions = readdirSync(cfTBase, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    for (const ver of versions) {
      const macDirs = readdirSync(path.join(cfTBase, ver), { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
      for (const macDir of macDirs) {
        const cand = path.join(
          cfTBase, ver, macDir,
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        );
        if (existsSync(cand)) return cand;
      }
    }
  } catch (_) { /* no CfT install */ }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const CHROME = detectChrome();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function startStaticServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(rootDir, urlPath);
      if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
      if (!filePath.startsWith(rootDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.contexts = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.executionContextCreated') {
        this.contexts.set(msg.params.context.id, msg.params.context);
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        this.contexts.delete(msg.params.executionContextId);
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, contextId) {
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true
    };
    if (contextId) params.contextId = contextId;
    const res = await this.send('Runtime.evaluate', params);
    if (res.exceptionDetails) {
      const e = res.exceptionDetails.exception
        ? JSON.stringify(res.exceptionDetails.exception.value)
        : res.exceptionDetails.text;
      throw new Error(`evaluate threw: ${e}`);
    }
    return res.result.value;
  }

  // The content script lives in a non-default isolated execution world.
  async isolatedContextId({ timeout = 10000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const ctx of this.contexts.values()) {
        if (ctx.auxData && ctx.auxData.isDefault === false) return ctx.id;
      }
      await sleep(200);
    }
    throw new Error('no isolated (content-script) execution context found');
  }

  async poll(expression, { timeout = 20000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const v = await this.evaluate(expression);
        if (v) return v;
      } catch (e) { lastErr = e; }
      await sleep(interval);
    }
    throw new Error(`poll timeout for: ${expression.slice(0, 80)} ${lastErr ? '(' + lastErr.message + ')' : ''}`);
  }

  close() { try { this.ws.close(); } catch (_) { /* noop */ } }
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${options?.method || 'GET'} ${url} -> ${res.status}`);
  return res.json();
}

// Newer Chrome builds expose the DevTools endpoint on IPv6 ([::1]) only.
async function cdpGet(cdpPort, path, options) {
  const hosts = ['127.0.0.1', '[::1]'];
  let lastErr;
  for (const host of hosts) {
    try {
      return await getJson(`http://${host}:${cdpPort}${path}`, options);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function waitForTargets(predicate, { timeout = 25000, label = '' }, cdpPort) {
  const deadline = Date.now() + timeout;
  let lastErr;
  let probes = 0;
  let probeWarned = false;
  while (Date.now() < deadline) {
    try {
      const list = await cdpGet(cdpPort, '/json/list');
      probes += 1;
      const found = list.filter(predicate);
      if (found.length) return found;
    } catch (err) {
      lastErr = err;
      if (!probeWarned && probes === 0) {
        probeWarned = true;
        const cause = err.cause ? ` [${err.cause.code || ''} ${err.cause.message || ''}]` : '';
        log(`waiting for devtools endpoint… ${err.message}${cause}`);
      }
    }
    await sleep(400);
  }
  throw new Error(`timed out waiting for targets: ${label}${lastErr ? ' (' + lastErr.message + ')' : ''}`);
}

// On macOS, spawning Chrome from this multi-threaded Node parent trips
// ObjC's `_objc_initializeAfterForkError` guard ("may have been in progress
// in another thread when fork() was called") and crashes the helper with
// exit 134. Re-launching via `open -na` (which uses launchd) sidesteps the
// inherited fork state. On other platforms we spawn directly.
function launchChrome(args) {
  const isMac = process.platform === 'darwin';
  if (isMac) {
    // open resolves the .app bundle and re-execs through launchd.
    // CHROME = <bundle>.app/Contents/MacOS/<executable>; strip the suffix.
    const appBundle = CHROME.replace(/\/Contents\/MacOS\/.*$/, '');
    execFileSync('open', ['-na', appBundle, '--args', ...args], { stdio: 'ignore' });
    return { detached: true };
  }
  return spawn(CHROME, args, { stdio: 'ignore', detached: true });
}

function killChromeByProfile(profileDir) {
  // Find every process whose command line carries our unique user-data-dir.
  const dirFlag = `user-data-dir=${profileDir}`;
  let pids = [];
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    pids = out.split('\n')
      .filter((line) => line.includes(dirFlag))
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid));
  } catch (_) { /* noop */ }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ }
  }
  return pids.length;
}

async function main() {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'linguasub-cdp-'));
  const cdpPort = await freePort();
  const httpPort = await freePort();
  let httpServer;
  let chromeHandle;

  const cleanup = () => {
    try { killChromeByProfile(profileDir); } catch (_) { /* noop */ }
    try { httpServer?.close(); } catch (_) { /* noop */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  };
  process.on('exit', cleanup);

  try {
    httpServer = await startStaticServer(ROOT, httpPort);
    log(`static server  : http://127.0.0.1:${httpPort}`);

    const chromeArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      'about:blank'
    ];
    chromeHandle = launchChrome(chromeArgs);
    log(`chrome binary  : ${CHROME}`);
    log(`chrome cdp     : http://127.0.0.1:${cdpPort} (macOS launched via open -na)`);

    // 3. Service worker target ------------------------------------------------
    const swTargets = await waitForTargets(
      (t) => t.type === 'service_worker' && t.url.includes('service-worker.js'),
      { label: 'extension service worker' },
      cdpPort
    );
    check('extension service worker registered', true, swTargets[0].url);

    const swCdp = new CDP(swTargets[0].webSocketDebuggerUrl);
    await swCdp.ready();
    await swCdp.send('Runtime.enable');
    const swErrors = [];
    swCdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        swErrors.push(JSON.stringify(m.params.exceptionDetails.exception?.value || m.params.exceptionDetails.text));
      }
    });

    const swInfo = await swCdp.evaluate(`({
      id: chrome.runtime.id,
      manifestName: chrome.runtime.getManifest().name,
      hasTabCapture: !!(chrome.tabCapture && chrome.tabCapture.getMediaStreamId),
      hasOffscreen: !!(chrome.offscreen && chrome.offscreen.createDocument),
      hasStorage: !!(chrome.storage && chrome.storage.sync)
    })`);
    check('service worker: chrome.* APIs available',
      !!swInfo.id && swInfo.hasTabCapture && swInfo.hasOffscreen && swInfo.hasStorage,
      JSON.stringify(swInfo));
    await sleep(1500);
    check('service worker: no uncaught exceptions', swErrors.length === 0, swErrors.join('; '));

    // 4. Content script injection ---------------------------------------------
    // Reuse the initial about:blank target and navigate over CDP.
    // (/json/new?<url> kills the browser under headless=new CfT.)
    // Note: headless=new also exposes odd targets (browser_ui, omnibox popups),
    // so match the exact about:blank page instead of taking "the first page".
    const listAll = await cdpGet(cdpPort, '/json/list');
    log('targets:', listAll.map((t) => `${t.type}:${t.url}`).join(' | '));
    const blankTargets = await waitForTargets(
      (t) => t.type === 'page' && /^about:blank/.test(t.url),
      { label: 'initial about:blank page target', timeout: 15000 },
      cdpPort
    );
    const fixtureUrl = `http://127.0.0.1:${httpPort}/test/fixture/fixture.html`;

    // The initial target can churn during startup; retry connect/enable once.
    let pageCdp;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = attempt === 0
        ? blankTargets[0]
        : (await cdpGet(cdpPort, '/json/list'))
          .filter((t) => t.type === 'page' && /^about:blank/.test(t.url))[0];
      if (!target) { await sleep(500); continue; } //eslint-disable-line no-await-in-loop
      const cdp = new CDP(target.webSocketDebuggerUrl);
      try {
        //eslint-disable-next-line no-await-in-loop
        await cdp.ready();
        //eslint-disable-next-line no-await-in-loop
        await cdp.send('Runtime.enable', {}, 10000);
        pageCdp = cdp;
        break;
      } catch (err) {
        log(`page connect attempt ${attempt + 1} failed: ${err.message}`);
        cdp.close();
        await sleep(500); //eslint-disable-line no-await-in-loop
      }
    }
    if (!pageCdp) throw new Error('could not attach to the about:blank page target');
    await pageCdp.send('Page.enable');
    await pageCdp.send('Log.enable');
    const pageErrors = [];
    pageCdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(JSON.stringify(m.params.exceptionDetails.exception?.value || m.params.exceptionDetails.text));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        pageErrors.push(`${m.params.entry.source}: ${m.params.entry.text}`);
      }
    });

    await pageCdp.send('Page.navigate', { url: fixtureUrl });
    await pageCdp.poll(
      `location.href.indexOf('fixture.html') !== -1 && document.readyState === 'complete' ? '1' : ''`,
      { timeout: 15000 }
    );
    const boot = await pageCdp.poll('document.documentElement.dataset.lsBoot === "1" ? "1" : ""', { timeout: 15000 });
    check('content script booted on http page (lsBoot marker)', boot === '1');

    // Everything needing the extension APIs runs in the content-script isolated world.
    const isolated = await pageCdp.isolatedContextId();

    // End-to-end message route: content script -> service worker -> reply.
    const stateReply = await pageCdp.evaluate(
      `new Promise((res) => {
         const t = setTimeout(() => res('{"error":"reply timeout"}'), 10000);
         chrome.runtime.sendMessage({type:'LS_GET_STATE'}, (r) => {
           clearTimeout(t);
           res(JSON.stringify(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : r));
         });
       })`,
      isolated
    );
    let routed = null;
    try { routed = JSON.parse(stateReply); } catch (_) { /* keep null */ }
    check('message routing: content script -> service worker (LS_GET_STATE)',
      routed && routed.activeTabId === null, stateReply);

    const overlayState = await pageCdp.evaluate(`(function(){
      const host = document.getElementById('linguasub-host');
      if (!host) return { present: false };
      const stage = host.shadowRoot && host.shadowRoot.querySelector('.ls-stage');
      return {
        present: true,
        shadow: !!host.shadowRoot,
        parent: host.parentNode.tagName,
        hiddenBeforeCaptions: stage ? !stage.classList.contains('show') : null
      };
    })()`);
    check('subtitle overlay host injected (shadow DOM, hidden until captions)',
      overlayState.present && overlayState.shadow && overlayState.hiddenBeforeCaptions === true,
      JSON.stringify(overlayState));

    // Live caption render through the real overlay API (isolated world).
    const captionRender = await pageCdp.evaluate(`(function(){
      const C = window.LSContent;
      C.renderLine({ original: 'Benvenuti', translation: 'Welcome', iso: 'it' });
      const root = document.getElementById('linguasub-host').shadowRoot;
      const tr = root.querySelector('[data-role=translation]').textContent;
      const visible = root.querySelector('.ls-stage').classList.contains('show');
      return JSON.stringify({ tr, visible });
    })()`, isolated);
    const caption = JSON.parse(captionRender);
    check('overlay renders translated captions via LSContent API',
      caption.tr === 'Welcome' && caption.visible === true, captionRender);

    await sleep(800);
    const fatal = pageErrors.filter((e) =>
      !/favicon|SharedWorker|Permissions-Policy|GCM|registration|404 \(Not Found\)|Failed to load resource/i.test(e));
    check('page: no content-script errors', fatal.length === 0, fatal.join('; '));

    // 5. Vendored Transformers.js + real HuggingFace tokenizer ---------------
    await pageCdp.send('Page.navigate', {
      url: `http://127.0.0.1:${httpPort}/test/engine-online.html`
    });
    const engine = await pageCdp.poll(
      `(window.__lsEngineResult && window.__lsEngineResult.state !== 'working') ? JSON.stringify(window.__lsEngineResult) : ''`,
      { timeout: 90000, interval: 1000 }
    );
    const engineResult = JSON.parse(engine);
    check('vendored Transformers.js runs and pulls NLLB tokenizer from HuggingFace',
      engineResult.state === 'done' && engineResult.tokens > 0, JSON.stringify(engineResult));

    swCdp.close();
    pageCdp.close();
  } catch (err) {
    check('smoke harness ran without fatal errors', false, err.stack || String(err));
  } finally {
    cleanup();
  }

  console.log(`\n${failures.length ? failures.length + ' FAILURES' : 'ALL SMOKE CHECKS PASSED'}`);
  process.exit(failures.length ? 1 : 0);
}

main();
