const ids = ['detected', 'added', 'skipped', 'remaining'];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const statusEl = document.getElementById('status');
const connectionEl = document.getElementById('connection');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isChaseTab(tab) {
  return CSROfferAdderURLPolicy.isChaseUrl(tab?.url || '');
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!isChaseTab(tab)) {
    throw new Error('This extension only runs on chase.com tabs.');
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      throw firstError;
    }
  }
}

function render(snapshot = {}) {
  ids.forEach((id) => {
    els[id].textContent = Number(snapshot[id] || 0).toString();
  });

  statusEl.textContent = snapshot.message || 'Ready.';
  startButton.disabled = Boolean(snapshot.running);
  stopButton.disabled = !snapshot.running;
}

async function refresh() {
  const tab = await getActiveTab();
  if (!isChaseTab(tab)) {
    connectionEl.textContent = 'Not a Chase tab.';
    render({ message: 'Navigate to a Chase Offers page to use this extension.' });
    return;
  }

  connectionEl.textContent = 'Connected to this Chase tab.';
  const response = await sendToActiveTab({ type: 'CSR_OFFER_GET_STATUS' });
  render(response?.status);
}

startButton.addEventListener('click', async () => {
  render({ message: 'Starting…' });
  try {
    const response = await sendToActiveTab({ type: 'CSR_OFFER_START' });
    render(response?.status);
  } catch (error) {
    render({ message: error.message });
  }
});

stopButton.addEventListener('click', async () => {
  try {
    const response = await sendToActiveTab({ type: 'CSR_OFFER_STOP' });
    render(response?.status);
  } catch (error) {
    render({ message: error.message });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CSR_OFFER_STATUS') {
    render(message.payload);
  }
});

refresh().catch((error) => render({ message: error.message }));
