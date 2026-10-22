# CSR Offer Adder

A local-only Chrome Extension that helps add available Chase Sapphire Reserve offers from a saved or live Chase Offers page.

## Privacy and safety

- Runs only after the user clicks the toolbar action on an active `chase.com` tab.
- Uses temporary `activeTab` access and does not request persistent access to Chase or any other site.
- Does not collect, transmit, or store usernames, passwords, cookies, account numbers, or offer data.
- Uses Manifest V3 and local content-script automation only.
- Requires manual Chase login by the user.
- Includes a Stop button in both the popup and the injected page overlay.

## DOM analysis notes

A sanitized Chase Offers fragment was analyzed during the 1.0.1 selector hardening:

- It contained 35 cards whose accessible positions were 1–35 of 126. The fragment did not include the surrounding page, so it proves only that the captured DOM was partial; it cannot distinguish virtualization, infinite scrolling, or pagination.
- Every captured offer used one root `<a role="button">` with `data-testid="commerce-tile"` and `data-cy="commerce-tile"`. Its accessible label ended in `Add Offer`.
- The nested `commerce-tile-button` element was an `aria-hidden` SVG plus icon, not a clickable button. The extension resolves that marker to the root commerce-tile control and never clicks the SVG itself.
- Every captured card had exactly one interactive control. Generic fallback detection remains available for alternate Chase markup, but a nested control is never accepted merely because its card contains a commerce-tile plus icon.
- The fragment contained only unadded offers. Already-added detection is covered with a synthetic browser regression test, but its exact live Chase representation still requires supervised confirmation after an add action.
- Merchant names, offer titles, offer IDs, and generated class names are not used as selectors.

The content script re-scans after every click, watches for DOM mutations, scrolls to reveal additional offers, and stops after repeated no-progress passes.

## Files

- `manifest.json` — Manifest V3 extension definition using temporary active-tab access without persistent host permissions.
- `content.js` — DOM scanning, resilient selector strategies, one-at-a-time clicking, scrolling, timeout handling, modal dismissal, cancellation, and injected status overlay.
- `service_worker.js` — Badge feedback based on tab status messages.
- `popup.html` / `popup.js` — Toolbar popup UI with Start/Stop controls and progress counters.
- `url_policy.js` — Exact HTTPS Chase-domain boundary used before active-tab injection.
- `styles.css` — Popup and injected overlay styles.

## Installation

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer Mode**.
3. Click **Load unpacked**.
4. Select this extension folder.
5. Log in to Chase manually.
6. Navigate to the Chase Offers page for your Chase Sapphire Reserve account.
7. Click the **CSR Offer Adder** extension icon.
8. Click **Start**.
9. Monitor progress in the popup or the page overlay until completion.
10. Click **Stop** at any time to request cancellation after the current safe wait.

## Testing plan

### Automated browser checks

Run `npm test` with Node.js 22 or newer and Chrome/Chromium installed. The tests launch a real headless browser and verify:

- the captured Chase commerce-tile structure resolves to its clickable root;
- unrelated nested controls are rejected;
- already-added tiles are skipped;
- temporary disabled/loading states are not counted as successful additions;
- processing continues after an unresolved offer;
- scrolling continues while the page is still advancing, including beyond eight viewport passes;
- the page overlay remains hidden until the user starts a run.

`npm run check` also runs syntax checks for every extension script. The same command runs in GitHub Actions.

### Saved HTML file

1. Open a saved Chase Offers HTML page in Chrome. A fragment containing only cards is sufficient for selector inspection but cannot reproduce page loading behavior.
2. If Chrome blocks extension access to `file://` pages, either:
   - enable **Allow access to file URLs** for this extension on `chrome://extensions`, or
   - serve the file locally for manual inspection and temporarily add the local test host to `manifest.json` during development only.
3. Confirm offer cards are discovered without relying on merchant names or offer titles.
4. Confirm addable controls are found by accessible labels, data attributes, button semantics, or role-based selectors.
5. Confirm already-added, disabled, hidden, or invalid controls are skipped.
6. Confirm the overlay displays detected, added, skipped, and remaining counts.

### Live Chase Offers page

1. Install the extension from this folder.
2. Log in to Chase manually and navigate to the Chase Sapphire Reserve Offers page.
3. Click the extension icon and press **Start**.
4. Confirm offers are clicked one at a time with visible delays.
5. Confirm the script re-scans after each click and scrolls to reveal lazy-loaded offers.
6. Confirm errors or changed offers are skipped and processing continues.
7. Confirm the extension stops with a clear completion message when no addable offers remain.
8. Confirm **Stop** cancels the run after the current wait.

### Regression checks

- Confirm no merchant names or offer titles are hard-coded.
- Confirm no credentials or Chase data are stored in extension storage or sent to any server.
- Confirm the only host permission is `https://*.chase.com/*`.
- Confirm the extension remains usable if Chase changes temporary CSS class names.

## Important limitations

Chase can change its front-end markup, controls, confirmations, or anti-automation behavior at any time. Use this extension only for your own account, monitor it while it runs, and stop it if the page behaves unexpectedly.
