import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const contentScript = await readFile(path.join(projectRoot, 'content.js'), 'utf8');
const urlPolicyScript = await readFile(path.join(projectRoot, 'url_policy.js'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    process.platform === 'win32' && 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.platform !== 'win32' && '/usr/bin/google-chrome',
    process.platform !== 'win32' && '/usr/bin/google-chrome-stable',
    process.platform !== 'win32' && '/usr/bin/chromium'
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return process.getBuiltinModule('node:fs').existsSync(candidate);
    } catch {
      return false;
    }
  });
}

async function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function withBrowser(run) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome or Chromium is required for browser tests');

  const profile = await mkdtemp(path.join(os.tmpdir(), 'csr-offer-adder-'));
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const [portText] = (await waitForFile(path.join(profile, 'DevToolsActivePort'))).trim().split(/\r?\n/);
    const targets = await fetch(`http://127.0.0.1:${portText}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === 'page');
    assert.ok(page?.webSocketDebuggerUrl, 'Chrome did not expose a page debugging target');

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });

    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      const response = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    };

    await command('Runtime.enable');
    await run({ evaluate });
    socket.close();
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(profile, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

function pageSetup(body, config = {}) {
  return `
    document.body.innerHTML = ${JSON.stringify(body)};
    globalThis.__CSR_OFFER_ADDER_TEST_CONFIG__ = ${JSON.stringify(config)};
    const runtimeListeners = [];
    globalThis.__runtimeMessages = [];
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
        sendMessage(message) { globalThis.__runtimeMessages.push(message); return Promise.resolve(); }
      }
    };
    globalThis.__sendRuntimeMessage = (message) => new Promise((resolve) => {
      const listener = runtimeListeners[0];
      const asyncResponse = listener(message, {}, resolve);
      if (!asyncResponse) queueMicrotask(() => resolve(globalThis.__runtimeMessages.at(-1)));
    });
    ${contentScript}
  `;
}

const realCardShape = `
  <a href="/#" role="button" tabindex="0"
     data-testid="commerce-tile" data-cy="commerce-tile"
     aria-label="1 of 126 Example Merchant 10% cash back Add Offer"
     style="display:block;width:240px;height:180px">
    <span>Example Merchant</span>
    <svg aria-hidden="true" data-testid="commerce-tile-button" data-cy="commerce-tile-button"></svg>
  </a>
`;

test('keeps the extension permission surface limited to Chase automation', () => {
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.manifest_version, 3);
});

test('accepts only HTTPS Chase domains, not lookalike suffix domains', async () => {
  await withBrowser(async ({ evaluate }) => {
    await evaluate(urlPolicyScript);
    const results = await evaluate(`[
      CSROfferAdderURLPolicy.isChaseUrl('https://chase.com/offers'),
      CSROfferAdderURLPolicy.isChaseUrl('https://secure.chase.com/offers'),
      CSROfferAdderURLPolicy.isChaseUrl('https://evilchase.com/offers'),
      CSROfferAdderURLPolicy.isChaseUrl('http://chase.com/offers'),
      CSROfferAdderURLPolicy.isChaseUrl('not a url')
    ]`);
    assert.deepEqual(results, [true, true, false, false, false]);
  });
});

test('detects the clickable root of a real Chase commerce-tile shape', async () => {
  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(realCardShape));
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_GET_STATUS' })`);
    assert.equal(response.status.detected, 1);
  });
});

test('detects all 35 captured commerce-tile shapes without merchant selectors', async () => {
  const body = Array.from({ length: 35 }, (_, index) => `
    <a href="/#" role="button" tabindex="0"
       data-testid="commerce-tile" data-cy="commerce-tile"
       aria-label="${index + 1} of 126 Example Merchant ${index + 1} Add Offer"
       style="display:block;width:240px;height:180px">
      <span>Example Merchant</span>
      <svg aria-hidden="true" data-testid="commerce-tile-button" data-cy="commerce-tile-button"></svg>
    </a>
  `).join('');
  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body));
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_GET_STATUS' })`);
    assert.equal(response.status.detected, 35);
  });
});

test('does not treat an unrelated nested control as an add action', async () => {
  const body = `
    <div data-testid="commerce-tile" style="display:block;width:240px;height:180px">
      <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      <button type="button" aria-label="View offer terms" style="width:100px;height:30px">Terms</button>
    </div>
  `;

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body));
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_GET_STATUS' })`);
    assert.equal(response.status.detected, 0);
  });
});

test('does not inject the page overlay before the user starts a run', async () => {
  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(realCardShape));
    const overlayExists = await evaluate(`Boolean(document.getElementById('csr-offer-adder-overlay'))`);
    assert.equal(overlayExists, false);
  });
});

test('skips an already-added commerce tile', async () => {
  const body = `
    <a href="/#" role="button" tabindex="0"
       data-testid="commerce-tile" aria-label="1 of 2 Example Merchant Offer Added"
       style="display:block;width:240px;height:180px">
      <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
    </a>
  `;

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body));
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_GET_STATUS' })`);
    assert.equal(response.status.detected, 0);
  });
});

test('continues after an unresolved offer and completes a later offer', async () => {
  const body = `
    <a id="unresolved" href="/#" role="button" tabindex="0"
       data-testid="commerce-tile" aria-label="1 of 2 Example Merchant 10% cash back Add Offer"
       style="display:block;width:240px;height:180px">
      <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
    </a>
    <a id="resolved" href="/#" role="button" tabindex="0"
       data-testid="commerce-tile" aria-label="2 of 2 Example Merchant 5% cash back Add Offer"
       style="display:block;width:240px;height:180px">
      <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
    </a>
  `;
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxScrollPasses: 1,
    maxNoProgressPasses: 1
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body, fastConfig));
    await evaluate(`
      globalThis.__clicks = [];
      document.getElementById('unresolved').addEventListener('click', (event) => {
        event.preventDefault();
        globalThis.__clicks.push('unresolved');
      });
      document.getElementById('resolved').addEventListener('click', (event) => {
        event.preventDefault();
        globalThis.__clicks.push('resolved');
        event.currentTarget.setAttribute('aria-label', '2 of 2 Example Merchant Offer Added');
        event.currentTarget.querySelector('[data-testid="commerce-tile-button"]').remove();
      });
    `);
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);
    const clicks = await evaluate(`globalThis.__clicks`);

    assert.deepEqual(clicks, ['unresolved', 'resolved']);
    assert.equal(response.status.added, 1);
    assert.equal(response.status.skipped, 1);
    assert.equal(response.status.running, false);
    assert.match(response.status.message, /^Complete\./);
  });
});

test('does not report a temporarily disabled tile as added', async () => {
  const body = `
    <a id="temporary" href="/#" role="button" tabindex="0"
       data-testid="commerce-tile" aria-label="1 of 1 Example Merchant 10% cash back Add Offer"
       style="display:block;width:240px;height:180px">
      <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
    </a>
  `;
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxNoProgressPasses: 1
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body, fastConfig));
    await evaluate(`
      document.getElementById('temporary').addEventListener('click', (event) => {
        event.preventDefault();
        event.currentTarget.setAttribute('aria-disabled', 'true');
      });
    `);
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);

    assert.equal(response.status.added, 0);
    assert.equal(response.status.skipped, 1);
  });
});

test('keeps scrolling past eight advancing passes to find a later offer', async () => {
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxNoProgressPasses: 1,
    maxRuntimeMs: 10_000
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup('<main id="offers"></main>', fastConfig));
    await evaluate(`
      let syntheticScrollY = 0;
      globalThis.__scrollPasses = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => syntheticScrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 20_000 });
      window.scrollBy = () => {
        syntheticScrollY = Math.min(syntheticScrollY + 1_000, 20_000);
        globalThis.__scrollPasses += 1;
        if (globalThis.__scrollPasses === 9) {
          const offer = document.createElement('a');
          offer.id = 'late-offer';
          offer.href = '/#';
          offer.setAttribute('role', 'button');
          offer.setAttribute('data-testid', 'commerce-tile');
          offer.setAttribute('aria-label', '126 of 126 Example Merchant 10% cash back Add Offer');
          offer.style.cssText = 'display:block;width:240px;height:180px';
          offer.innerHTML = '<svg aria-hidden="true" data-testid="commerce-tile-button"></svg>';
          offer.addEventListener('click', (event) => {
            event.preventDefault();
            offer.setAttribute('aria-label', '126 of 126 Example Merchant Offer Added');
            offer.querySelector('[data-testid="commerce-tile-button"]').remove();
          });
          document.getElementById('offers').appendChild(offer);
        }
      };
    `);
    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);
    const scrollPasses = await evaluate(`globalThis.__scrollPasses`);

    assert.ok(scrollPasses >= 9);
    assert.equal(response.status.added, 1);
    assert.match(response.status.message, /^Complete\./);
  });
});

test('restarts from the top before completing when virtualization removes pending offers', async () => {
  const body = `
    <main id="offers">
      <a id="first" href="/#" role="button" tabindex="0"
         data-testid="commerce-tile" aria-label="1 of 2 Example Merchant 10% cash back Add Offer"
         style="display:block;width:240px;height:180px">
        <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      </a>
      <a id="second" href="/#" role="button" tabindex="0"
         data-testid="commerce-tile" aria-label="2 of 2 Example Merchant 5% cash back Add Offer"
         style="display:block;width:240px;height:180px">
        <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      </a>
    </main>
  `;
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxNoProgressPasses: 1,
    maxRuntimeMs: 10_000
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body, fastConfig));
    await evaluate(`
      let syntheticScrollY = 0;
      const secondOffer = document.getElementById('second');
      globalThis.__clickedOffers = [];
      globalThis.__topRestarts = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => syntheticScrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 2_000 });
      window.scrollBy = () => { syntheticScrollY = 2_000; };
      window.scrollTo = () => {
        syntheticScrollY = 0;
        globalThis.__topRestarts += 1;
        if (!secondOffer.isConnected) document.getElementById('offers').appendChild(secondOffer);
      };
      document.getElementById('first').addEventListener('click', (event) => {
        event.preventDefault();
        globalThis.__clickedOffers.push('first');
        event.currentTarget.setAttribute('aria-label', '1 of 2 Example Merchant Offer Added');
        event.currentTarget.querySelector('[data-testid="commerce-tile-button"]').remove();
        secondOffer.remove();
      });
      secondOffer.addEventListener('click', (event) => {
        event.preventDefault();
        globalThis.__clickedOffers.push('second');
        event.currentTarget.setAttribute('aria-label', '2 of 2 Example Merchant Offer Added');
        event.currentTarget.querySelector('[data-testid="commerce-tile-button"]').remove();
      });
    `);

    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);
    const clickedOffers = await evaluate(`globalThis.__clickedOffers`);
    const topRestarts = await evaluate(`globalThis.__topRestarts`);

    assert.deepEqual(clickedOffers, ['first', 'second']);
    assert.ok(topRestarts >= 1);
    assert.equal(response.status.detected, 2);
    assert.equal(response.status.added, 2);
    assert.equal(response.status.skipped, 0);
    assert.equal(response.status.remaining, 0);
    assert.match(response.status.message, /^Complete\./);
  });
});

test('reports incomplete instead of complete when a detected offer never returns', async () => {
  const body = `
    <main id="offers">
      <a id="first" href="/#" role="button" tabindex="0"
         data-testid="commerce-tile" aria-label="1 of 2 Example Merchant 10% cash back Add Offer"
         style="display:block;width:240px;height:180px">
        <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      </a>
      <a id="vanishing" href="/#" role="button" tabindex="0"
         data-testid="commerce-tile" aria-label="2 of 2 Example Merchant 5% cash back Add Offer"
         style="display:block;width:240px;height:180px">
        <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      </a>
    </main>
  `;
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxNoProgressPasses: 1,
    maxRuntimeMs: 10_000
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body, fastConfig));
    await evaluate(`
      let syntheticScrollY = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => syntheticScrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 2_000 });
      window.scrollBy = () => { syntheticScrollY = 2_000; };
      window.scrollTo = () => { syntheticScrollY = 0; };
      document.getElementById('first').addEventListener('click', (event) => {
        event.preventDefault();
        event.currentTarget.setAttribute('aria-label', '1 of 2 Example Merchant Offer Added');
        event.currentTarget.querySelector('[data-testid="commerce-tile-button"]').remove();
        document.getElementById('vanishing').remove();
      });
    `);

    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);
    const overlayButtonText = await evaluate(`document.querySelector('.csr-offer-adder-stop').textContent`);

    assert.equal(response.status.detected, 2);
    assert.equal(response.status.added, 1);
    assert.equal(response.status.skipped, 0);
    assert.equal(response.status.remaining, 1);
    assert.match(response.status.message, /^Incomplete\./);
    assert.equal(overlayButtonText, 'Finished');
  });
});

test('keeps an active offer unresolved when virtualization removes it before click', async () => {
  const body = `
    <main id="offers">
      <a id="vanishing" href="/#" role="button" tabindex="0"
         data-testid="commerce-tile" aria-label="1 of 1 Example Merchant 10% cash back Add Offer"
         style="display:block;width:240px;height:180px">
        <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      </a>
    </main>
  `;
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxNoProgressPasses: 1,
    maxRuntimeMs: 10_000
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body, fastConfig));
    await evaluate(`
      let syntheticScrollY = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => syntheticScrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 2_000 });
      window.scrollBy = () => { syntheticScrollY = 2_000; };
      window.scrollTo = () => { syntheticScrollY = 0; };
      document.getElementById('vanishing').scrollIntoView = function () { this.remove(); };
    `);

    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);

    assert.equal(response.status.detected, 1);
    assert.equal(response.status.added, 0);
    assert.equal(response.status.skipped, 0);
    assert.equal(response.status.remaining, 1);
    assert.match(response.status.message, /^Incomplete\./);
  });
});

test('keeps a clicked offer unresolved when it disappears before confirmation', async () => {
  const body = `
    <main id="offers">
      <a id="vanishing" href="/#" role="button" tabindex="0"
         data-testid="commerce-tile" aria-label="1 of 1 Example Merchant 10% cash back Add Offer"
         style="display:block;width:240px;height:180px">
        <svg aria-hidden="true" data-testid="commerce-tile-button"></svg>
      </a>
    </main>
  `;
  const fastConfig = {
    clickDelayMinMs: 0,
    clickDelayMaxMs: 1,
    settleDelayMs: 0,
    scrollDelayMs: 0,
    clickTimeoutMs: 50,
    idleMutationMs: 5,
    maxNoProgressPasses: 1,
    maxRuntimeMs: 10_000
  };

  await withBrowser(async ({ evaluate }) => {
    await evaluate(pageSetup(body, fastConfig));
    await evaluate(`
      let syntheticScrollY = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => syntheticScrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => 2_000 });
      window.scrollBy = () => { syntheticScrollY = 2_000; };
      window.scrollTo = () => { syntheticScrollY = 0; };
      document.getElementById('vanishing').addEventListener('click', (event) => {
        event.preventDefault();
        event.currentTarget.remove();
      });
    `);

    const response = await evaluate(`__sendRuntimeMessage({ type: 'CSR_OFFER_START' })`);

    assert.equal(response.status.detected, 1);
    assert.equal(response.status.added, 0);
    assert.equal(response.status.skipped, 0);
    assert.equal(response.status.remaining, 1);
    assert.match(response.status.message, /^Incomplete\./);
  });
});
