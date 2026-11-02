import { expect, test } from '@playwright/test';

test.describe('automatic English extension UI', () => {
  test.use({ locale: 'en-GB' });

  test('localises preview, conflicts, validation and local booking without altering user notes', async ({ page }, testInfo) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:5173/')) external.push(request.url()); });
    await page.goto('/sidepanel.html?demo=1');
    await expect(page).toHaveTitle('HiBob · Monthly attendance');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Monthly attendance', exact: true })).toBeVisible();
    await expect(page.getByLabel('Federal state', { exact: true })).toHaveValue('HE');
    await expect(page.locator('#state option:checked')).toHaveText('Hesse');
    expect(await page.locator('.app-mark img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.getByLabel('Month', { exact: true }).fill('2026-11');
    await page.locator('#settings-toggle').click();
    await page.getByLabel('Variable times', { exact: true }).check();
    await expect(page.locator('#variation-value')).toHaveText('±5 min');
    await page.locator('#scan').click();
    await expect(page.locator('#weeks article.day')).toHaveCount(30);
    await expect(page.locator('#connection-title')).toHaveText('Month read');
    await expect(page.locator('#preview-subtitle')).toContainText('November 2026');
    await expect(page.locator('#weeks [data-date="2026-11-06"]')).toContainText('Annual leave');
    await expect(page.locator('#conflicts')).toHaveText('Review 2 existing entries');
    await page.locator('#conflicts').click();
    await expect(page.getByRole('heading', { name: 'Review existing entries', exact: true })).toBeVisible();
    await expect(page.locator('#conflict-items')).toContainText('Example note from the test interface');
    await page.getByRole('button', { name: 'Skip all', exact: true }).click();
    await page.getByRole('button', { name: 'Apply decisions', exact: true }).click();
    await expect(page.locator('#apply')).toBeEnabled();
    await expect(page.locator('.week-header .totals').filter({ hasText: '40 h 00 min target' })).toHaveCount(3);
    await page.getByLabel('Work ends', { exact: true }).fill('15:30');
    await expect(page.locator('#plan-errors')).toContainText('cannot be reached');
    await expect(page.locator('#apply')).toBeDisabled();
    await page.getByLabel('Work ends', { exact: true }).fill('16:30');
    await expect(page.locator('#apply')).toBeEnabled();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('preview-en.png'), fullPage: false });
    await page.locator('#apply').click();
    await expect(page.locator('#apply-dialog')).toContainText('local simulation');
    await page.locator('#confirm-apply').click();
    await expect(page.locator('#run-status')).toContainText('Run complete');
    await expect(page.locator('#apply')).toBeDisabled();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('shows English holiday names and regional settings', async ({ page }) => {
    await page.goto('/sidepanel.html?demo=1');
    await page.getByLabel('Month', { exact: true }).fill('2026-12');
    await page.locator('#scan').click();
    await expect(page.locator('#weeks [data-date="2026-12-25"]')).toContainText('Christmas Day');
    await page.locator('#settings-toggle').click();
    await page.getByLabel('Federal state', { exact: true }).selectOption('BY');
    await expect(page.getByLabel('Is your workplace in the city of Augsburg?', { exact: true })).toBeVisible();
  });
});

test.describe('English fallback for other browser languages', () => {
  test.use({ locale: 'fr-FR' });
  test('uses English automatically without a language switch', async ({ page }) => {
    await page.goto('/sidepanel.html?demo=1');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Monthly attendance', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create preview', exact: true })).toBeEnabled();
  });
});
