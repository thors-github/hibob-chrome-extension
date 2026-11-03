import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the packaged API-first MV3 extension starts with narrow permissions and a schema6 connection', async () => {
  const expectedManifest = JSON.parse(await readFile(resolve('public/manifest.json'), 'utf8')) as { version: string; version_name?: string };
  const profile = await mkdtemp(join(tmpdir(), 'hibob-extension-test-'));
  const extension = resolve('dist');
  expect(await readdir(extension)).not.toContain('content.js');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const requests: string[] = [];
    context.on('request', request => { if (new URL(request.url()).origin === 'https://app.hibob.com') requests.push(request.url()); });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    // The renderer locale can differ from the worker. Use the page's Chrome API,
    // exactly as the UI does, rather than the Playwright emulation preference.
    const german = /^de(?:[-_]|$)/i.test(await page.evaluate(() => chrome.i18n.getUILanguage()));
    const labels = german
      ? { heading: 'Monatsbuchung', start: 'Arbeitsbeginn', disconnected: 'Mit HiBob verbinden', connected: 'Mit HiBob verbunden', read: 'Monat eingelesen', login: 'Mit HiBob anmelden' }
      : { heading: 'Monthly attendance', start: 'Work starts', disconnected: 'Connect to HiBob', connected: 'Connected to HiBob', read: 'Month read', login: 'Sign in to HiBob' };
    await expect(page.getByRole('heading', { name: labels.heading, exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.start, { exact: true })).toHaveValue('08:00');
    await expect(page.locator('html')).toHaveAttribute('lang', german ? 'de' : 'en');
    const nativeName = await worker.evaluate(() => chrome.i18n.getMessage('appName'));
    expect(['HiBob Monatsbuchung', 'HiBob Monthly Attendance']).toContain(nativeName);
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.name).toBe(nativeName);
    expect(manifest.icons?.['128']).toBe('icons/icon-128.png');
    expect(manifest.version).toBe(expectedManifest.version);
    expect(manifest.version_name).toBe(expectedManifest.version_name);
    expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'activeTab', 'scripting']);
    expect(manifest.host_permissions).toEqual(['https://app.hibob.com/*']);
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self'; object-src 'none'; connect-src https://app.hibob.com" });
    expect(await page.locator('.app-mark img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.locator('#demo-banner')).not.toBeVisible();
    await expect(page.locator('#connection-title')).toHaveText(labels.disconnected);
    await expect(page.locator('#connect')).toHaveText(labels.login);
    await expect(page.locator('#scan')).toBeDisabled();
    await expect(page.locator('#apply')).toBeDisabled();
    const readSession = () => worker.evaluate(async () => (await chrome.storage.session.get('sessionState')).sessionState as Record<string, unknown> | undefined);
    await expect.poll(async () => (await readSession())?.schemaVersion).toBe(6);
    const initial = await readSession();
    expect(initial).toBeDefined();
    expect(initial?.tabId).toBeUndefined();
    expect(initial?.connection).toBeUndefined();
    expect(initial?.job).toBeUndefined();
    expect(requests).toEqual([]);

    // A top-level extension tab is not the native side panel. Its RPC sender
    // includes a tab and must remain rejected even after synthetic storage events.
    // These fixture events exercise rendering only, never an authenticated API.
    const onlyPanel = german ? 'Diese Aktion ist nur im Extension-Seitenpanel verfügbar.' : 'This action is only available in the extension’s side panel.';
    await expect(page.locator('#main-error')).toHaveText(onlyPanel);
    await expect(page.locator('#retry-connection')).toBeVisible();
    await worker.evaluate(async () => { await chrome.storage.session.set({ sessionState: { schemaVersion: 6, revision: 100, planRevision: 100, tabId: 9 } }); });
    await expect(page.locator('#connection-title')).toHaveText(labels.disconnected);
    await expect(page.locator('#scan')).toBeDisabled();
    const month = await page.locator('#month').inputValue();
    await worker.evaluate(async currentMonth => {
      await chrome.storage.session.set({ sessionState: {
        schemaVersion: 6, revision: 101, planRevision: 101,
        connection: { status: 'connected', generation: 'isolated-fixture-session', employeeId: 'fixture-employee', companyId: 'fixture-company', employeeLabel: 'Local API fixture', companyLabel: 'Local company', transport: 'direct', capabilities: { read: true, write: false, overwrite: false } },
        snapshot: { month: currentMonth, employeeLabel: 'Local API fixture', periodLabel: currentMonth, scannedAt: '2026-11-02T09:00:00Z', source: 'hibob', context: { mode: 'api-session', connectionId: 'isolated-fixture-session', employeeKey: 'fixture-employee', tenantKey: 'fixture-company' }, days: [] },
      } });
    }, month);
    await expect(page.locator('#connection-title')).toHaveText('Local API fixture · Local company');
    await expect(page.locator('#scan')).toBeDisabled();
    await expect(page.locator('#apply')).toBeDisabled();
    await page.locator('#retry-connection').click();
    await expect(page.locator('#main-error')).toHaveText(onlyPanel);
    await expect(page.locator('#scan')).toBeDisabled();
    await expect(page.locator('#apply')).toBeDisabled();
    await worker.evaluate(async () => { await chrome.storage.session.set({ sessionState: { schemaVersion: 6, revision: 102, planRevision: 102 } }); });
    await expect(page.locator('#connection-title')).toHaveText(labels.disconnected);
    await page.reload();
    await expect(page.locator('#connection-title')).toHaveText(labels.disconnected);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
