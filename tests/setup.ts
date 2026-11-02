import { beforeEach } from 'vitest';

// Existing German workflows remain explicit. Locale-specific tests override the
// browser language through chrome.i18n or navigator within their own test cases.
beforeEach(() => {
  if (typeof navigator !== 'undefined') Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true });
});
