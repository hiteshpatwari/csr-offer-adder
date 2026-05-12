(() => {
  if (window.__csrOfferAdderLoaded) {
    return;
  }
  window.__csrOfferAdderLoaded = true;

  const CONFIG = {
    clickDelayMinMs: 1200,
    clickDelayMaxMs: 2400,
    settleDelayMs: 1500,
    scrollDelayMs: 900,
    clickTimeoutMs: 9000,
    idleMutationMs: 700,
    maxScrollPasses: 8,
    maxNoProgressPasses: 3,
    maxClicks: 500,
    viewportPadding: 120
  };

  const addIntentPattern = /(^|\b)(add|activate|clip|save)(\b|\s+(offer|deal|to card|now))/i;
  const addedPattern = /(added|activated|saved|clipped|enrolled|selected|success|complete)/i;
  const invalidPattern = /(remove|terms|detail|learn|view|shop|redeem|expired|unavailable|added|activated|saved|clipped|enrolled)/i;
  const commerceTileSelector = '[data-testid="commerce-tile"], [data-cy="commerce-tile"]';
  const commerceTileAddAffordanceSelector = [
    '[data-testid="commerce-tile-button"]',
    '[data-cy="commerce-tile-button"]'
  ].join(',');
  const addedStatusSelector = [
    '[data-testid*="alert-container-success" i]',
    '[data-cy*="alert-container-success" i]',
    '[data-testid*="success" i]',
    '[data-cy*="success" i]'
  ].join(',');
  const offerContextSelector = [
    commerceTileSelector,
    '[data-testid*="offer" i]',
    '[data-test*="offer" i]',
    '[data-cy*="offer" i]',
    '[id*="offer" i]',
    '[aria-label*="offer" i]',
    '[aria-labelledby*="offer" i]',
    '[class*="offer" i]'
  ].join(',');
  const cardSelector = [
    commerceTileSelector,
    offerContextSelector,
    'article',
    'li',
    '[role="listitem"]',
    '[class*="card" i]'
  ].join(',');

  const ignoredControls = new WeakSet();
  const completedOfferKeys = new Set();

  const state = {
    running: false,
    stopRequested: false,
    detected: 0,
    added: 0,
    skipped: 0,
    remaining: 0,
    message: 'Ready.',
    lastError: '',
    startedAt: null,
    completedAt: null
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function humanDelay() {
    const { clickDelayMinMs, clickDelayMaxMs } = CONFIG;
    return clickDelayMinMs + Math.floor(Math.random() * (clickDelayMaxMs - clickDelayMinMs));
  }

  function textOf(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test'),
      el.getAttribute('data-cy'),
      el.getAttribute('data-action'),
      el.value,
      el.innerText,
      el.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (el.closest('[hidden], [aria-hidden="true"], template')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabled(el) {
    return Boolean(
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.matches('[disabled], .disabled, [class*="disabled" i]') ||
      el.closest('[aria-disabled="true"]')
    );
  }

  function nearestOfferCard(el) {
    return el.closest(cardSelector) || el.closest('section, div, li, article') || el.parentElement;
  }

  function clickableControl(el) {
    if (!el) return null;
    if (el.matches('button, input[type="button"], input[type="submit"], a, [role="button"], [tabindex]')) {
      return el;
    }
    return el.closest('button, input[type="button"], input[type="submit"], a, [role="button"], [tabindex]');
  }

  function isCommerceTile(el) {
    return Boolean(el?.matches?.(commerceTileSelector));
  }

  function hasCommerceTileAddAffordance(card) {
    return Boolean(card && isCommerceTile(card) && card.querySelector(commerceTileAddAffordanceSelector));
  }

  function hasOfferContext(el, card) {
    const combinedText = [textOf(el), card && card !== el ? textOf(card) : ''].filter(Boolean).join(' ');
    return Boolean(
      el.closest(offerContextSelector) ||
      card?.matches?.(offerContextSelector) ||
      /\b(offer|deal|cash back|points back|to card)\b/i.test(combinedText)
    );
  }

  function offerKey(el) {
    const card = nearestOfferCard(el);
    const rawKey = [
      card?.id,
      el.id,
      card?.getAttribute?.('aria-labelledby'),
      el.getAttribute?.('aria-labelledby')
    ].find(Boolean);

    if (!rawKey) return '';
    return rawKey
      .replace(/^banner-/, '')
      .replace(/^carousel_\d+_/, '')
      .replace(/^banner-carousel_\d+_/, '');
  }

  function cardLooksAlreadyAdded(card) {
    if (!card) return false;
    if (card.matches(addedStatusSelector) || card.querySelector(addedStatusSelector)) return true;
    const statusBits = [
      card.getAttribute('aria-label'),
      card.getAttribute('data-status'),
      card.getAttribute('data-testid'),
      card.getAttribute('data-cy'),
      ...Array.from(card.querySelectorAll('[aria-live], [role="status"], [data-status], [class*="status" i], [data-testid*="success" i], [data-cy*="success" i]'))
        .slice(0, 5)
        .map(textOf)
    ].filter(Boolean).join(' ');
    return addedPattern.test(statusBits);
  }

  function elementLooksAddable(el) {
    const label = textOf(el);
    const card = nearestOfferCard(el);
    const combinedLabel = [label, card && card !== el ? textOf(card) : ''].filter(Boolean).join(' ');
    const commerceCard = isCommerceTile(el) ? el : card?.closest?.(commerceTileSelector);
    const tileAddAffordance = hasCommerceTileAddAffordance(commerceCard);
    const explicitAddIntent = addIntentPattern.test(combinedLabel);

    if (!isVisible(el) || isDisabled(el)) return false;
    if (!el.matches('button, input[type="button"], input[type="submit"], a, [role="button"], [tabindex]')) return false;
    if (cardLooksAlreadyAdded(card)) return false;
    if (tileAddAffordance) return true;
    if (invalidPattern.test(combinedLabel)) return false;
    if (!explicitAddIntent) return false;
    if (!hasOfferContext(el, card)) return false;

    return true;
  }

  function findCandidates() {
    const selector = [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'a[role="button"]',
      '[role="button"]',
      '[aria-label*="add" i]',
      '[aria-label*="activate" i]',
      '[data-testid*="add" i]',
      '[data-test*="add" i]',
      '[data-cy*="add" i]',
      '[data-action*="add" i]',
      commerceTileSelector,
      commerceTileAddAffordanceSelector
    ].join(',');

    const unique = new Set();
    const seenOfferKeys = new Set();
    const results = [];

    for (const rawEl of document.querySelectorAll(selector)) {
      const el = clickableControl(rawEl);
      if (!el) continue;
      if (unique.has(el)) continue;
      unique.add(el);
      const key = offerKey(el);
      if (key && (completedOfferKeys.has(key) || seenOfferKeys.has(key))) continue;
      if (!ignoredControls.has(el) && elementLooksAddable(el)) {
        if (key) seenOfferKeys.add(key);
        results.push(el);
      }
    }

    return results.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function updateStatus(patch = {}) {
    Object.assign(state, patch);
    state.remaining = Math.max(0, state.detected - state.added - state.skipped);
    renderOverlay();
    chrome.runtime.sendMessage({ type: 'CSR_OFFER_STATUS', payload: snapshot() }).catch(() => {});
  }

  function snapshot() {
    return {
      running: state.running,
      detected: state.detected,
      added: state.added,
      skipped: state.skipped,
      remaining: state.remaining,
      message: state.message,
      lastError: state.lastError,
      startedAt: state.startedAt,
      completedAt: state.completedAt
    };
  }

  function ensureOverlay() {
    let overlay = document.getElementById('csr-offer-adder-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('aside');
    overlay.id = 'csr-offer-adder-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="csr-offer-adder-title">CSR Offer Adder</div>
      <div class="csr-offer-adder-message"></div>
      <div class="csr-offer-adder-grid">
        <span>Detected <b data-stat="detected">0</b></span>
        <span>Added <b data-stat="added">0</b></span>
        <span>Skipped <b data-stat="skipped">0</b></span>
        <span>Remaining <b data-stat="remaining">0</b></span>
      </div>
      <button type="button" class="csr-offer-adder-stop">Stop</button>
    `;
    overlay.querySelector('button').addEventListener('click', stop);
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function renderOverlay() {
    const overlay = ensureOverlay();
    overlay.querySelector('.csr-offer-adder-message').textContent = state.message;
    overlay.querySelector('.csr-offer-adder-stop').disabled = !state.running;
    for (const key of ['detected', 'added', 'skipped', 'remaining']) {
      overlay.querySelector(`[data-stat="${key}"]`).textContent = String(state[key]);
    }
  }

  async function waitForDomIdle(timeoutMs = CONFIG.clickTimeoutMs) {
    let timer;
    let done;
    const idle = new Promise((resolve) => {
      done = resolve;
      timer = setTimeout(resolve, CONFIG.idleMutationMs);
    });
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, CONFIG.idleMutationMs);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    await Promise.race([idle, sleep(timeoutMs)]);
    observer.disconnect();
    clearTimeout(timer);
  }

  async function scrollToRevealMore() {
    const beforeHeight = document.documentElement.scrollHeight;
    const beforeY = window.scrollY;

    window.scrollBy({ top: Math.max(window.innerHeight - CONFIG.viewportPadding, 300), behavior: 'smooth' });
    await sleep(CONFIG.scrollDelayMs);
    await waitForDomIdle(2500);

    const afterHeight = document.documentElement.scrollHeight;
    const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= afterHeight - 4;
    return afterHeight > beforeHeight || window.scrollY > beforeY || !atBottom;
  }

  async function dismissPossibleModal() {
    const closeSelectors = [
      '[aria-label="Close" i]',
      '[aria-label="Dismiss" i]',
      'button[data-testid*="close" i]',
      'button[class*="close" i]'
    ];
    const closeButton = closeSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find((el) => isVisible(el) && !isDisabled(el));
    if (closeButton) {
      closeButton.click();
      await sleep(400);
    }
  }

  async function clickOffer(button) {
    const card = nearestOfferCard(button);
    const key = offerKey(button);

    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    await sleep(350);
    if (!elementLooksAddable(button)) {
      ignoredControls.add(button);
      updateStatus({ skipped: state.skipped + 1, message: 'Skipped an offer that changed before clicking.' });
      return;
    }

    try {
      button.click();
      updateStatus({ message: 'Clicked an addable offer. Waiting for Chase to update…' });
      await Promise.race([waitForDomIdle(), sleep(CONFIG.clickTimeoutMs)]);
      await sleep(CONFIG.settleDelayMs);
      await dismissPossibleModal();

      const resolved = !button.isConnected || !elementLooksAddable(button) || cardLooksAlreadyAdded(card);
      if (resolved && key) completedOfferKeys.add(key);
      if (!resolved) ignoredControls.add(button);
      updateStatus({
        added: resolved ? state.added + 1 : state.added,
        skipped: resolved ? state.skipped : state.skipped + 1,
        message: resolved
          ? 'Offer add action appears complete. Continuing…'
          : 'Skipped one offer because it still looked addable after the click.'
      });
      await sleep(humanDelay());
    } catch (error) {
      ignoredControls.add(button);
      updateStatus({ skipped: state.skipped + 1, lastError: error.message, message: 'Skipped one offer after a click error.' });
      await sleep(500);
    }
  }

  async function run() {
    if (state.running) return snapshot();

    updateStatus({
      running: true,
      stopRequested: false,
      detected: 0,
      added: 0,
      skipped: 0,
      remaining: 0,
      lastError: '',
      startedAt: new Date().toISOString(),
      completedAt: null,
      message: 'Scanning for addable Chase offers…'
    });

    let scrollPasses = 0;
    let noProgressPasses = 0;
    let clicks = 0;
    completedOfferKeys.clear();

    while (!state.stopRequested && clicks < CONFIG.maxClicks) {
      const candidates = findCandidates();
      const previousProgress = state.added + state.skipped;
      updateStatus({ detected: Math.max(state.detected, state.added + state.skipped + candidates.length), message: `Found ${candidates.length} unique addable offer(s).` });

      if (candidates.length > 0) {
        await clickOffer(candidates[0]);
        clicks += 1;
        noProgressPasses = state.added + state.skipped > previousProgress ? 0 : noProgressPasses + 1;
        continue;
      }

      if (scrollPasses >= CONFIG.maxScrollPasses || noProgressPasses >= CONFIG.maxNoProgressPasses) {
        break;
      }

      updateStatus({ message: 'No visible addable offers. Scrolling to reveal more…' });
      const moved = await scrollToRevealMore();
      scrollPasses += 1;
      if (!moved) noProgressPasses += 1;
    }

    const stopped = state.stopRequested;
    updateStatus({
      running: false,
      stopRequested: false,
      completedAt: new Date().toISOString(),
      message: stopped
        ? `Stopped. Added ${state.added} offer(s), skipped ${state.skipped}.`
        : `Complete. Added ${state.added} offer(s), skipped ${state.skipped}. No addable offers remain visible.`
    });
    return snapshot();
  }

  function stop() {
    updateStatus({ stopRequested: true, running: state.running, message: 'Stop requested. Finishing current wait safely…' });
    return snapshot();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CSR_OFFER_GET_STATUS') {
      updateStatus({ detected: Math.max(state.detected, findCandidates().length), message: state.message || 'Ready.' });
      sendResponse({ status: snapshot() });
      return false;
    }

    if (message?.type === 'CSR_OFFER_START') {
      run().then((status) => sendResponse({ status }));
      return true;
    }

    if (message?.type === 'CSR_OFFER_STOP') {
      sendResponse({ status: stop() });
      return false;
    }

    return false;
  });

  updateStatus({ detected: findCandidates().length, message: 'Ready. Click the extension icon to start.' });
})();
