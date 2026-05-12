# CSR Offer Adder

A local-only Chrome Extension that helps add available Chase Sapphire Reserve offers from a saved or live Chase Offers page.

## Privacy and safety

- Runs only in the active browser tab on `https://*.chase.com/*`.
- Does not collect, transmit, or store usernames, passwords, cookies, account numbers, or offer data.
- Uses Manifest V3 and local content-script automation only.
- Requires manual Chase login by the user.
- Includes a Stop button in both the popup and the injected page overlay.

## DOM analysis notes

The originally referenced file, `/Users/hitesh.patwari/Desktop/csr-offers.html`, was not available inside this repository/container, so this package is designed around resilient DOM patterns rather than one brittle snapshot. When testing against a saved Chase Offers HTML page, confirm these assumptions and adjust selectors only if needed:

- Individual offers are treated as card-like containers discovered from semantic and stable attributes: `article`, `li`, `[role="listitem"]`, IDs/data attributes containing `offer`, and card-like containers.
- Add controls are detected from stable interaction semantics: `button`, `input[type="button"]`, `input[type="submit"]`, anchors or elements with `role="button"`, and controls whose accessible labels or data attributes indicate add/activate/save/clip intent.
- Already-added offers are skipped when the control or nearby card/status region indicates an added, activated, saved, clipped, enrolled, selected, success, or complete state; disabled and `aria-disabled="true"` controls are also skipped.
- Offers may be loaded all at once, lazily as the user scrolls, or through dynamic DOM updates. The content script re-scans after every click, watches for DOM mutations, scrolls through the page, and stops after repeated no-progress passes.
- Merchant names, offer titles, and fixed offer copy are intentionally not used.

## Files

- `manifest.json` — Manifest V3 extension definition, popup, content script, service worker, and minimum Chase host permission.
- `content.js` — DOM scanning, resilient selector strategies, one-at-a-time clicking, scrolling, timeout handling, modal dismissal, cancellation, and injected status overlay.
- `service_worker.js` — Badge feedback based on tab status messages.
- `popup.html` / `popup.js` — Toolbar popup UI with Start/Stop controls and progress counters.
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

### Saved HTML file

1. Open the saved Chase Offers HTML file in Chrome.
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
