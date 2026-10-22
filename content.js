(() => {
  if (window.__csrOfferAdderLoaded) {
    return;
  }
  window.__csrOfferAdderLoaded = true;

  const CONFIG = Object.freeze({
    clickDelayMinMs: 1200,
    clickDelayMaxMs: 2400,
    settleDelayMs: 1500,
    scrollDelayMs: 900,
    clickTimeoutMs: 9000,
    idleMutationMs: 700,
    maxNoProgressPasses: 3,
    maxClicks: 500,
    maxRuntimeMs: 15 * 60 * 1000,
    viewportPadding: 120,
    ...(globalThis.__CSR_OFFER_ADDER_TEST_CONFIG__ || {})
  });

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
  const handledOfferKeys = new Set();
  const discoveredOfferKeys = new Set();
  const addedOfferKeys = new Set();
  const skippedOfferKeys = new Set();
  let anonymousOfferKeys = new WeakMap();
  let nextAnonymousOfferKey = 0;

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

  function trackingKey(el) {
    const stableKey = offerKey(el);
    if (stableKey) return `stable:${stableKey}`;
    if (!anonymousOfferKeys.has(el)) {
      nextAnonymousOfferKey += 1;
      anonymousOfferKeys.set(el, `element:${nextAnonymousOfferKey}`);
    }
    return anonymousOfferKeys.get(el);
  }

  function resetTracking() {
    handledOfferKeys.clear();
    discoveredOfferKeys.clear();
    addedOfferKeys.clear();
    skippedOfferKeys.clear();
    anonymousOfferKeys = new WeakMap();
    nextAnonymousOfferKey = 0;
  }

  function registerCandidates(candidates) {
    for (const candidate of candidates) discoveredOfferKeys.add(trackingKey(candidate));
  }

  function trackedStatus(patch = {}) {
    return {
      detected: discoveredOfferKeys.size,
      added: addedOfferKeys.size,
      skipped: skippedOfferKeys.size,
      remaining: Math.max(0, discoveredOfferKeys.size - addedOfferKeys.size - skippedOfferKeys.size),
      ...patch
    };
  }

  function recordOutcome(el, outcome) {
    const key = trackingKey(el);
    discoveredOfferKeys.add(key);
    handledOfferKeys.add(key);
    if (outcome === 'added') addedOfferKeys.add(key);
    else skippedOfferKeys.add(key);
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

  function offerHasConfirmedAddedState(card, key) {
    if (cardLooksAlreadyAdded(card)) return true;
    if (!key) return false;

    return Array.from(document.querySelectorAll(commerceTileSelector))
      .some((candidate) => offerKey(candidate) === key && cardLooksAlreadyAdded(candidate));
  }

  function elementLooksAddable(el) {
    const label = textOf(el);
    const card = nearestOfferCard(el);
    const commerceCard = isCommerceTile(el) ? el : card?.closest?.(commerceTileSelector);
    const tileAddAffordance = hasCommerceTileAddAffordance(commerceCard);
    const explicitAddIntent = addIntentPattern.test(label);

    if (!isVisible(el) || isDisabled(el)) return false;
    if (!el.matches('button, input[type="button"], input[type="submit"], a, [role="button"], [tabindex]')) return false;
    if (cardLooksAlreadyAdded(card)) return false;
    if (commerceCard) {
      return el === commerceCard && tileAddAffordance && explicitAddIntent;
    }
    if (invalidPattern.test(label)) return false;
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
      const key = trackingKey(el);
      if (handledOfferKeys.has(key) || seenOfferKeys.has(key)) continue;
      if (!ignoredControls.has(el) && elementLooksAddable(el)) {
        seenOfferKeys.add(key);
        results.push(el);
      }
    }

    return results.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function updateStatus(patch = {}) {
    Object.assign(state, patch);
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
    const existingOverlay = document.getElementById('csr-offer-adder-overlay');
    if (!state.running && !existingOverlay) return;
    const overlay = existingOverlay || ensureOverlay();
    overlay.querySelector('.csr-offer-adder-message').textContent = state.message;
    const stopButton = overlay.querySelector('.csr-offer-adder-stop');
    stopButton.disabled = !state.running;
    stopButton.textContent = state.running ? 'Stop' : 'Finished';
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

  async function restartFromTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(CONFIG.scrollDelayMs);
    await waitForDomIdle(2500);
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
      if (!button.isConnected || !card?.isConnected) {
        updateStatus(trackedStatus({ message: 'An offer left the page before it could be clicked. Rechecking for it…' }));
        return;
      }
      ignoredControls.add(button);
      const confirmedAdded = offerHasConfirmedAddedState(card, key);
      recordOutcome(button, confirmedAdded ? 'added' : 'skipped');
      updateStatus(trackedStatus({
        message: confirmedAdded
          ? 'Offer add state was already confirmed. Continuing…'
          : 'Skipped an offer that changed before clicking.'
      }));
      return;
    }

    try {
      button.click();
      updateStatus({ message: 'Clicked an addable offer. Waiting for Chase to update…' });
      await Promise.race([waitForDomIdle(), sleep(CONFIG.clickTimeoutMs)]);
      await sleep(CONFIG.settleDelayMs);
      await dismissPossibleModal();

      const confirmedAdded = offerHasConfirmedAddedState(card, key);
      const disappearedBeforeConfirmation = !confirmedAdded && (!button.isConnected || !card?.isConnected);
      if (!confirmedAdded && !disappearedBeforeConfirmation) ignoredControls.add(button);
      if (!disappearedBeforeConfirmation) recordOutcome(button, confirmedAdded ? 'added' : 'skipped');
      updateStatus(trackedStatus({
        message: confirmedAdded
          ? 'Offer add action confirmed. Continuing…'
          : disappearedBeforeConfirmation
            ? 'The clicked offer left the page before Chase confirmed it. Rechecking for it…'
          : 'Skipped one offer because Chase did not show a confirmed added state.'
      }));
      await sleep(humanDelay());
    } catch (error) {
      if (!button.isConnected || !card?.isConnected) {
        updateStatus(trackedStatus({
          lastError: error.message,
          message: 'The offer left the page during the click attempt. Rechecking for it…'
        }));
        await sleep(500);
        return;
      }
      ignoredControls.add(button);
      recordOutcome(button, 'skipped');
      updateStatus(trackedStatus({ lastError: error.message, message: 'Skipped one offer after a click error.' }));
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

    let bottomStalls = 0;
    let clicks = 0;
    let verificationSweepStarted = false;
    let progressAtSweepStart = 0;
    const runStartedAt = Date.now();
    resetTracking();

    while (
      !state.stopRequested &&
      clicks < CONFIG.maxClicks &&
      Date.now() - runStartedAt < CONFIG.maxRuntimeMs
    ) {
      const candidates = findCandidates();
      registerCandidates(candidates);
      const previousProgress = state.added + state.skipped;
      updateStatus(trackedStatus({ message: `Found ${candidates.length} unique addable offer(s).` }));

      if (candidates.length > 0) {
        await clickOffer(candidates[0]);
        clicks += 1;
        bottomStalls = state.added + state.skipped > previousProgress ? 0 : bottomStalls + 1;
        continue;
      }

      updateStatus({ message: 'No visible addable offers. Scrolling to reveal more…' });
      const moved = await scrollToRevealMore();
      if (moved) {
        bottomStalls = 0;
        continue;
      }

      bottomStalls += 1;
      if (bottomStalls < CONFIG.maxNoProgressPasses) continue;

      const currentProgress = state.added + state.skipped;
      if (!verificationSweepStarted || currentProgress > progressAtSweepStart) {
        updateStatus({ message: 'Reached the bottom. Rechecking from the top for virtualized offers…' });
        await restartFromTop();
        verificationSweepStarted = true;
        progressAtSweepStart = currentProgress;
        bottomStalls = 0;
        continue;
      }

      break;
    }

    const stopped = state.stopRequested;
    const safetyLimitReached = clicks >= CONFIG.maxClicks || Date.now() - runStartedAt >= CONFIG.maxRuntimeMs;
    const unresolved = Math.max(0, discoveredOfferKeys.size - addedOfferKeys.size - skippedOfferKeys.size);
    updateStatus(trackedStatus({
      running: false,
      stopRequested: false,
      completedAt: new Date().toISOString(),
      message: stopped
        ? `Stopped. Added ${state.added} offer(s), skipped ${state.skipped}.`
        : safetyLimitReached
          ? `Stopped at the safety limit. Added ${state.added} offer(s), skipped ${state.skipped}. Review the page before continuing.`
          : unresolved > 0
            ? `Incomplete. Added ${state.added} offer(s), skipped ${state.skipped}. ${unresolved} previously detected offer(s) are no longer visible; reload the page and run again.`
            : `Complete. Added ${state.added} offer(s), skipped ${state.skipped}. No addable offers remain after a full-page recheck.`
    }));
    return snapshot();
  }

  function stop() {
    updateStatus({ stopRequested: true, running: state.running, message: 'Stop requested. Finishing current wait safely…' });
    return snapshot();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CSR_OFFER_GET_STATUS') {
      if (!state.running && !state.completedAt) {
        const candidates = findCandidates();
        updateStatus({
          detected: candidates.length,
          added: 0,
          skipped: 0,
          remaining: candidates.length,
          message: state.message || 'Ready.'
        });
      }
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

  const initialCandidates = findCandidates();
  updateStatus({
    detected: initialCandidates.length,
    remaining: initialCandidates.length,
    message: 'Ready. Click the extension icon to start.'
  });
})();
