import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the packaged MV3 extension starts with its declared permissions and CSP', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'hibob-extension-test-'));
  const extension = resolve('dist');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    // Playwright emulates the renderer locale independently of the service worker.
    // Assert UI strings against the same Chrome language API used by that page.
    const browserLanguage = await page.evaluate(() => chrome.i18n.getUILanguage());
    const german = /^de(?:[-_]|$)/i.test(browserLanguage);
    const labels = german
      ? { heading: 'Monatsbuchung', start: 'Arbeitsbeginn', unbound: 'HiBob-Tab auswählen', bound: 'HiBob-Tab ausgewählt', read: 'Monat eingelesen', scan: 'Monat einlesen', appName: 'HiBob Monatsbuchung' }
      : { heading: 'Monthly attendance', start: 'Work starts', unbound: 'Select a HiBob tab', bound: 'HiBob tab selected', read: 'Month read', scan: 'Read month', appName: 'HiBob Monthly Attendance' };
    await expect(page.getByRole('heading', { name: labels.heading, exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.start, { exact: true })).toHaveValue('08:00');
    await expect(page.locator('html')).toHaveAttribute('lang', german ? 'de' : 'en');
    // Chrome chooses native manifest/catalog strings when loading the extension;
    // CDP locale emulation can change getUILanguage later without reloading them.
    const nativeName = await worker.evaluate(() => chrome.i18n.getMessage('appName'));
    expect(['HiBob Monatsbuchung', 'HiBob Monthly Attendance']).toContain(nativeName);
    expect(await worker.evaluate(() => chrome.runtime.getManifest().name)).toBe(nativeName);
    expect(await worker.evaluate(() => chrome.runtime.getManifest().icons?.['128'])).toBe('icons/icon-128.png');
    expect(await page.locator('.app-mark img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.locator('#apply')).toBeDisabled();
    await expect(page.locator('#demo-banner')).not.toBeVisible();
    const info = await worker.evaluate(() => ({ permissions: chrome.runtime.getManifest().permissions, csp: chrome.runtime.getManifest().content_security_policy, state: chrome.storage.session.get('sessionState') }));
    expect(info.permissions).toEqual(['sidePanel', 'storage', 'activeTab', 'scripting']);
    expect(info.csp).toEqual({ extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'" });
    expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('1.2.0');
    await expect(page.locator('#connection-title')).toHaveText(labels.unbound);
    await expect(page.locator('#scan')).toBeDisabled();
    // A top-level extension tab is not the native side panel. The production
    // sender guard deliberately rejects its initialization RPC. That failure
    // must remain visible and must not enable scan/write controls via events.
    const onlyPanel = german ? 'Diese Aktion ist nur im Extension-Seitenpanel verfügbar.' : 'This action is only available in the extension’s side panel.';
    await expect(page.locator('#main-error')).toHaveText(onlyPanel);
    await expect(page.locator('#retry-connection')).toBeVisible();
    await worker.evaluate(async () => { await chrome.storage.session.set({ sessionState: { tabId: 9 } }); });
    await expect(page.locator('#connection-title')).toHaveText(labels.bound);
    await expect(page.locator('#connection-detail')).toContainText(labels.scan);
    await expect(page.locator('#scan')).toBeDisabled();
    await expect(page.locator('#apply')).toBeDisabled();
    await page.locator('#retry-connection').click();
    await expect(page.locator('#main-error')).toHaveText(onlyPanel);
    await expect(page.locator('#scan')).toBeDisabled();
    // These fixture events exercise the packaged UI, not the controller's action
    // handler. A selected-tab cold reopen is tested with a consistent backend in
    // panel-connection.test.ts; directly seeding storage does not bind its writer.
    await page.locator('#connection').screenshot({ path: '/tmp/hibob-connection-1.2.0.png' });
    await worker.evaluate(async () => {
      await chrome.storage.session.set({ sessionState: {
        tabId: 9,
        snapshot: { month: '2026-11', employeeLabel: 'Lokales Testkonto', periodLabel: 'November 2026', scannedAt: '2026-11-02T09:00:00Z', source: 'hibob', days: [] },
      } });
    });
    await expect(page.locator('#connection-title')).toHaveText(labels.read);
    await expect(page.locator('#connection-detail')).toContainText('Lokales Testkonto');
    await worker.evaluate(async () => { await chrome.storage.session.set({ sessionState: {} }); });
    await expect(page.locator('#connection-title')).toHaveText(labels.unbound);
    await expect(page.locator('#scan')).toBeDisabled();
    await page.reload();
    await expect(page.locator('#connection-title')).toHaveText(labels.unbound);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
