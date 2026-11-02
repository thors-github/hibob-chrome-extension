import { test, expect, type Page } from '@playwright/test';

async function openDemo(page: Page) {
  await page.goto('/sidepanel.html?demo=1');
  await expect(page.getByRole('heading', { name: 'Monatsbuchung', exact: true })).toBeVisible();
  await page.getByLabel('Monat', { exact: true }).fill('2026-11');
}

async function scan(page: Page) {
  await page.getByRole('button', { name: 'Monat einlesen', exact: true }).click();
  await expect(page.locator('#weeks article.day')).toHaveCount(30);
}

async function skipConflicts(page: Page) {
  await page.locator('#conflicts').click();
  await page.getByRole('button', { name: 'Alle überspringen', exact: true }).click();
  await page.getByRole('button', { name: 'Entscheidungen übernehmen', exact: true }).click();
}

test('complete preview, conflict decisions, weekly variation and stable reload', async ({ page }) => {
  const errors: string[] = [];
  const destinations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => destinations.push(request.url()));
  await openDemo(page);
  await page.getByLabel('Variable Zeiten', { exact: true }).check();
  await expect(page.locator('#variation-value')).toHaveText('±5 Min.');
  await scan(page);
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('[data-date="2026-11-06"]')).toContainText('Urlaub');
  await skipConflicts(page);
  await expect(page.locator('#apply')).toBeEnabled();
  await expect(page.locator('.week-header .totals').filter({ hasText: '40 h 00 min Ziel' })).toHaveCount(3);
  const before = await page.locator('#weeks').innerText();
  await page.reload();
  await expect(page.locator('#weeks')).toHaveText(before.replace(/\s+/g, ' ').trim(), { useInnerText: true });
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
  await expect(page.locator('#weeks [data-date="2026-11-02"]')).toContainText('Ersetzen');
  await expect(page.locator('#apply')).toBeEnabled();
});

test('local writes complete only after confirmation and require a fresh scan', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  await page.locator('#apply').click();
  await expect(page.locator('#apply-dialog')).toBeVisible();
  await expect(page.locator('#run-panel')).not.toBeVisible();
  await page.getByRole('button', { name: 'Buchungen starten', exact: true }).click();
  await expect(page.locator('#run-status')).toContainText('Lauf abgeschlossen');
  await expect(page.locator('#run-results [data-status="verified"]')).toHaveCount(18);
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#footer-hint')).toContainText('Testmodus');
  await page.getByRole('button', { name: 'Monat einlesen', exact: true }).click();
  await expect(page.locator('#conflicts')).toContainText('20 vorhandene Buchungen');
});

test('cancellation stops the local queue and cannot blindly resume', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  await page.locator('#apply').click();
  await page.getByRole('button', { name: 'Buchungen starten', exact: true }).click();
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(page.locator('#run-status')).toContainText('Lauf angehalten');
  await expect(page.locator('#apply')).toBeDisabled();
});

test('local draft-only checking preserves example attendance and never persists its result', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('hibob-demo-session')!));
  await page.locator('#apply').click();
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
  expect(JSON.stringify(after)).not.toContain('draftCheck');
  await page.reload();
  await expect(page.locator('#draft-check-result')).not.toBeVisible();
  await expect(page.locator('#apply')).toBeDisabled();
});

test('regional requirements, manual exclusions and impossible weekly target', async ({ page }) => {
  await openDemo(page);
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
  await page.getByLabel('Arbeitsende', { exact: true }).fill('16:30');
  await expect(page.locator('#apply')).toBeEnabled();
  await page.locator('[data-date="2026-11-04"] input[type="checkbox"]').uncheck();
  await expect(page.locator('[data-date="2026-11-04"]')).toContainText('Manuell ausgeschlossen');
});

test('keyboard day selection keeps focus and the viewport through asynchronous preview rebuilds', async ({ page }) => {
  await openDemo(page);
  await scan(page);
  await skipConflicts(page);
  const day = page.locator('#include-2026-11-18');
  await day.scrollIntoViewIfNeeded();
  await day.focus();
  const scrollBefore = await page.evaluate(() => document.scrollingElement!.scrollTop);
  await page.keyboard.press('Space');
  await expect(page.locator('[data-date="2026-11-18"]')).toContainText('Manuell ausgeschlossen');
  await expect(page.locator('#apply')).toBeEnabled();
  await expect(page.locator('#include-2026-11-18')).toBeFocused();
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBeCloseTo(scrollBefore, 0);
  await page.keyboard.press('Tab');
  await expect(page.locator('#include-2026-11-19')).toBeFocused();
});

for (const width of [320, 700]) {
  test(`readable responsive panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDemo(page);
    await page.getByLabel('Variable Zeiten', { exact: true }).check();
    await scan(page);
    await skipConflicts(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#apply')).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/hibob-panel-${width}.png`, fullPage: false });
    await page.locator('#conflicts').click();
    expect(await page.locator('#conflict-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
