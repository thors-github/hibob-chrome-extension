import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ locale: 'en-GB', viewport: { width: 320, height: 900 } });

test('exports only settings and reviews a file before applying it in the narrow panel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/sidepanel.html?demo=1');
  await expect(page.locator('#installed-version')).toContainText('Version ');
  await page.getByLabel('Month', { exact: true }).fill('2026-11');
  await page.locator('#settings-toggle').click();
  await page.locator('#more-options > summary').click();
  await page.getByLabel('Work starts', { exact: true }).fill('07:45');
  await page.getByLabel('Work ends', { exact: true }).fill('16:15');
  await page.getByText('Transfer settings', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export settings', exact: true })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export settings', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('hibob-settings-2026-11.json');
  const text = await readFile((await download.path())!, 'utf8');
  const backup = JSON.parse(text);
  expect(backup.settings.start).toBe('07:45');
  expect(Object.keys(backup).sort()).toEqual(['app', 'schemaVersion', 'settings']);
  expect(text).not.toMatch(/employeeLabel|fingerprint|snapshot|run/);

  await page.getByLabel('Work starts', { exact: true }).fill('08:00');
  await page.getByLabel('Work ends', { exact: true }).fill('16:30');
  await expect(page.getByRole('button', { name: 'Import settings', exact: true })).toBeEnabled();
  await page.locator('#settings-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByRole('heading', { name: 'Import settings?', exact: true })).toBeVisible();
  await expect(page.locator('#import-details')).toContainText('07:45–16:15');
  await expect(page.getByLabel('Work starts', { exact: true })).toHaveValue('08:00');
  await page.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.getByLabel('Work starts', { exact: true })).toHaveValue('07:45');
  await expect(page.locator('#connection-title')).toHaveText('Local test interface');
  await expect(page.locator('#apply')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
