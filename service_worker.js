chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#0b5cab' });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'CSR_OFFER_STATUS') {
    return;
  }

  const tabId = sender.tab?.id;
  if (!tabId) {
    return;
  }

  const status = message.payload || {};
  const text = status.running
    ? String(status.remaining ?? status.detected ?? '')
    : status.added
      ? 'Done'
      : '';

  chrome.action.setBadgeText({ tabId, text: text.slice(0, 4) });
});
