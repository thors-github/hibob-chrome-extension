import { test, expect, type Page } from '@playwright/test';
import { checks, day, home, settings, tools } from './ui';

async function openDemo(page: Page) {
  await page.goto('/sidepanel.html?demo=1');
  await expect(page.getByRole('heading', { name: 'Monatsbuchung', exact: true })).toBeVisible();
  await page.getByLabel('Monat', { exact: true }).fill('2026-11');
}

async function scan(page: Page) {
  await home(page);
  await page.locator(await page.locator('#scan').isVisible() ? '#scan' : '#refresh-month').click();
  await expect(page.locator('#preview-summary')).toBeVisible();
  await expect(page.locator('#calendar button[data-date]')).toHaveCount(30);
}

async function skipConflicts(page: Page) {
  await home(page);
  await page.locator('#conflicts').click();
  await page.getByRole('button', { name: 'Alle überspringen', exact: true }).click();
  await page.getByRole('button', { name: 'Entscheidungen übernehmen', exact: true }).click();
}

async function demoPlan(page: Page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('hibob-demo-session')!).plan);
}

test('complete calendar, conflict decisions, weekly variation and stable reload', async ({ page }) => {
  const errors: string[] = [];
  const destinations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => destinations.push(request.url()));
  await openDemo(page);
  await settings(page);
  await page.getByLabel('Variable Zeiten', { exact: true }).check();
  await expect(page.locator('#variation-value')).toHaveText('±5 Min.');
  await scan(page);
  await expect(page.locator('#apply')).toBeDisabled();
  await day(page, '2026-11-06');
  await expect(page.locator('#day-content')).toContainText('Urlaub');
  await skipConflicts(page);
  await expect(page.locator('#apply')).toBeEnabled();
  await day(page, '2026-11-09');
  await expect(page.locator('#day-week')).toContainText('40 h 00 min');
  await home(page);
  const before = await demoPlan(page);
  expect(before.weeks.filter((week: { targetMinutes: number }) => week.targetMinutes === 2400)).toHaveLength(3);
  const calendar = await page.locator('#calendar').innerText();
  await page.reload();
  await expect(page.locator('#calendar')).toHaveText(calendar.replace(/\s+/g, ' ').trim(), { useInnerText: true });
  expect(await demoPlan(page)).toEqual(before);
  expect(destinations.every(url => url.startsWith('http://127.0.0.1:5173/') || url.startsWith('ws://127.0.0.1:5173/'))).toBe(true);
  expect(errors).toEqual([]);
});

test('overwrite requires explicit metadata removal acknowledgement', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await page.locator('#conflicts').click();
  await page.getByRole('button', { name: 'Alle überschreiben', exact: true }).click();
  await page.getByRole('button', { name: 'Entscheidungen übernehmen', exact: true }).click();
  await expect(page.locator('#conflict-dialog')).toBeVisible();
  await expect(page.locator('#conflict-error')).toContainText('Entfernung');
  await page.locator('[data-metadata-ack]').check();
  await page.getByRole('button', { name: 'Entscheidungen übernehmen', exact: true }).click();
  await expect(page.locator('#conflict-dialog')).not.toBeVisible();
  await day(page, '2026-11-02');
  await expect(page.locator('#day-content')).toContainText('Ersetzen');
  await home(page);
  await expect(page.locator('#apply')).toBeEnabled();
});

test('local writes complete only after confirmation and require a fresh scan', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  await page.locator('#apply').click();
  await expect(page.locator('#apply-dialog')).toBeVisible();
  await expect(page.locator('#run-panel')).not.toBeVisible();
  await page.locator('#confirm-apply').click();
  await expect(page.locator('#run-status')).toContainText('Lauf abgeschlossen');
  await page.locator('#run-details').click();
  await expect(page.locator('#run-results [data-status="verified"]')).toHaveCount(18);
  await home(page);
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#footer-hint')).toContainText('Testmodus');
  await scan(page);
  await expect(page.locator('#conflicts')).toContainText('2 Buchungen prüfen');
});

test('cancellation stops the local queue and cannot blindly resume', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  await page.locator('#apply').click();
  await page.locator('#confirm-apply').click();
  await page.locator('#cancel-run').click();
  await expect(page.locator('#run-status')).toContainText('Lauf angehalten');
  await expect(page.locator('#apply')).toBeDisabled();
});

test('local read-only preflight preserves attendance and never persists its result', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('hibob-demo-session')!));
  await page.locator('#apply').click();
  await checks(page);
  await page.locator('#check-draft').click();
  await expect(page.locator('#draft-check-result')).toBeVisible();
  await expect(page.locator('#draft-check-result-title')).toContainText('nicht gespeichert');
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#scan')).toBeEnabled();
  const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem('hibob-demo-session')!));
  expect(after.demoSnapshot).toEqual(before.demoSnapshot);
  expect(after.run).toEqual(before.run);
  expect(after.snapshot).toBeUndefined();
  expect(after.plan).toBeUndefined();
  expect(JSON.stringify(after)).not.toContain('preflight');
  await page.reload();
  await expect(page.locator('#draft-check-result')).not.toBeVisible();
  await expect(page.locator('#apply')).toBeDisabled();
});

test('regional requirements, manual exclusions and impossible weekly target', async ({ page }) => {
  await openDemo(page);
  await settings(page);
  await page.getByLabel('Bundesland', { exact: true }).selectOption('BY');
  await expect(page.getByLabel('Arbeitsort in der Stadt Augsburg?')).toBeVisible();
  await page.getByLabel('Arbeitsort in der Stadt Augsburg?').selectOption('yes');
  await expect(page.getByLabel('Mariä Himmelfahrt am Arbeitsort Feiertag?')).not.toBeVisible();
  await page.getByLabel('Bundesland', { exact: true }).selectOption('HE');
  await page.getByLabel('Variable Zeiten', { exact: true }).check();
  await page.getByLabel('Arbeitsende', { exact: true }).fill('15:30');
  await scan(page);
  await skipConflicts(page);
  await expect(page.locator('#plan-errors')).toContainText('nicht erreichbar');
  await expect(page.locator('#apply')).toBeDisabled();
  await settings(page);
  await page.getByLabel('Arbeitsende', { exact: true }).fill('16:30');
  await home(page);
  await expect(page.locator('#apply')).toBeEnabled();
  await day(page, '2026-11-04');
  await page.locator('#include-2026-11-04').uncheck();
  await expect(page.locator('#day-content')).toContainText('Manuell ausgeschlossen');
});

test('keyboard calendar and day exclusion preserve focus through asynchronous rebuilds', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  const date = page.locator('#calendar-2026-11-18');
  await date.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#calendar-2026-11-19')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.locator('#day-view')).toBeVisible();
  const included = page.locator('#include-2026-11-18');
  await included.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#day-content')).toContainText('Manuell ausgeschlossen');
  await expect(included).toBeFocused();
  await page.locator('#day-back').click();
  await expect(date).toBeFocused();
  await expect(page.locator('#apply')).toBeEnabled();
});

for (const width of [320, 700]) {
  test(`readable responsive views at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await openDemo(page);
    await expect(page).toHaveTitle('HiBob · Monatsbuchung');
    await expect(page.locator('#settings-view')).not.toBeVisible();
    await expect(page.locator('#scan')).toBeInViewport();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`initial-${width}.png`), fullPage: false });
    await settings(page);
    await page.getByLabel('Variable Zeiten', { exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`), fullPage: false });
    await scan(page);
    await page.locator('#conflicts').click();
    expect(await page.locator('#conflict-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('#close-conflicts').click();
    await skipConflicts(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#apply')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`preview-${width}.png`), fullPage: false });
    expect(errors).toEqual([]);
  });
}

test('repeated scanning preserves compatible varying times; redistribution remains explicit', async ({ page }) => {
  await openDemo(page);
  await settings(page);
  await page.locator('#variable').check();
  await page.locator('#variationMinutes').fill('15');
  await scan(page);
  await expect(page.locator('#conflicts')).not.toBeVisible();
  await day(page, '2026-11-02');
  await expect(page.locator('#day-content')).toContainText('Passt bereits');
  await home(page);
  await page.locator('#apply').click();
  await expect(page.locator('#execution-disclosure')).toContainText('keine gemeinsame Transaktion');
  await page.locator('#confirm-apply').click();
  await expect(page.locator('#run-status')).toContainText('Lauf abgeschlossen');
  await expect(page.locator('#run-timing')).toContainText('Tatsächliche Laufzeit');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('hibob-demo-session')!).demoSnapshot.days);
  await scan(page);
  await expect(page.locator('#preview-summary')).toContainText('Alles passt');
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#conflicts')).not.toBeVisible();
  const retained = await demoPlan(page);
  expect(retained.snapshot.days).toEqual(saved);
  expect(retained.days.filter((day: { action: string }) => day.action === 'unchanged')).toHaveLength(20);
  expect(retained.redistributeAll).toBeUndefined();
  await tools(page, 'booking');
  await page.locator('#redistribute').click();
  await home(page);
  await expect(page.locator('#conflicts')).toBeVisible();
  const redistributed = await demoPlan(page);
  expect(redistributed.redistributeAll).toBe(true);
  expect(redistributed.days.some((day: { action: string }) => day.action === 'conflict')).toBe(true);
});
