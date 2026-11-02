(() => {
  'use strict';
  const configuration = window.HIBOB_DISTRIBUTION_CONFIG || {};
  const version = document.querySelector('#source-version');
  if (version && typeof configuration.sourceVersion === 'string') version.textContent = `· ${configuration.sourceVersion}`;

  const exactStoreUrl = value => {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'chromewebstore.google.com' && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/detail\/(?:[^/]+\/)?[a-p]{32}$/.test(url.pathname) ? url.href : null;
    } catch { return null; }
  };
  const storeUrl = exactStoreUrl(configuration.storeUrl);
  const storeControl = document.querySelector('#store-install');
  if (storeUrl && storeControl) {
    const link = document.createElement('a');
    link.href = storeUrl;
    link.id = 'store-install';
    link.className = 'button button-primary';
    link.textContent = 'Install from Chrome Web Store ↗';
    storeControl.replaceWith(link);
    document.querySelector('#store-status').textContent = 'Available through Chrome';
    document.querySelector('#store-explanation').textContent = 'Opens the published Store listing. Chrome will ask you to confirm installation and handles approved updates.';
  }

  const expectedProjectUrl = (value, pattern) => {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash && pattern.test(url.pathname) ? url.href : null;
    } catch { return null; }
  };
  const previewUrl = expectedProjectUrl(configuration.previewReleaseUrl, /^\/thors-github\/hibob-chrome-extension\/releases\/tag\/v\d+\.\d+\.\d+-(alpha|beta|rc)\.[1-9]\d*$/);
  if (previewUrl) document.querySelector('#preview-release')?.setAttribute('href', previewUrl);
  const releaseUrl = expectedProjectUrl(configuration.releaseUrl, /^\/thors-github\/hibob-chrome-extension\/releases(?:\/latest)?$/);
  if (releaseUrl) document.querySelector('#github-release')?.setAttribute('href', releaseUrl);
  const validationNote = document.querySelector('#validation-note');
  if (configuration.stableReleaseReady === true && validationNote) validationNote.hidden = true;
})();
