globalThis.CSROfferAdderURLPolicy = Object.freeze({
  isChaseUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (url.hostname === 'chase.com' || url.hostname.endsWith('.chase.com'));
    } catch {
      return false;
    }
  }
});
