import { expect, test, type Page } from '@playwright/test';
import type { BookingPlan, DayPlan, MonthSnapshot, SessionState, Settings } from '../../src/shared/types';
import { day, home, settings, tools } from './ui';

function calendarFixture(month = '2026-11') {
  const settings: Settings = { month, state: 'HE', start: '08:00', end: '16:30', useBreak: true, breakStart: '12:00', breakEnd: '12:30', variable: true, variationMinutes: 15, excludedDates: [], localHolidays: { augsburg: null, assumption: null, corpusChristi: null } };
  const count = new Date(`${month}-01T12:00:00Z`); count.setUTCMonth(count.getUTCMonth() + 1, 0);
  const snapshot: MonthSnapshot = {
    source: 'hibob', month, employeeLabel: 'Local Employee', periodLabel: month, scannedAt: '2026-11-02T10:00:00Z',
    context: { mode: 'api-session', connectionId: 'calendar-session', employeeKey: 'calendar-self', tenantKey: 'calendar-company' },
    days: Array.from({ length: count.getUTCDate() }, (_, index) => ({ date: `${month}-${String(index + 1).padStart(2, '0')}`, entries: [], editable: true, reportedMinutes: 0, fingerprint: `empty-${index}` })),
  };
  const days: DayPlan[] = snapshot.days.map(date => {
    const weekday = new Date(`${date.date}T12:00:00Z`).getUTCDay(); const eligible = weekday !== 0 && weekday !== 6;
    return { date: date.date, existing: [], proposed: eligible ? [{ type: 'work', start: '08:00', end: '12:00' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }] : [], action: eligible ? 'create' : 'skip', reason: eligible ? undefined : 'Weekend', fingerprint: date.fingerprint, eligible, netMinutes: eligible ? 480 : 0, existingNetMinutes: 0 };
  });
  const weeks = new Map<string, DayPlan[]>();
  for (const date of days) { const start = new Date(`${date.date}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7); const week = start.toISOString().slice(0, 10); weeks.set(week, [...(weeks.get(week) ?? []), date]); }
  const plan: BookingPlan = { id: `calendar-plan-${month}`, seed: 123, settings, snapshot, choices: {}, days, canReview: true, errors: [], weeks: [...weeks].map(([week, dates]) => ({ week, dates: dates.map(day => day.date), plannedMinutes: dates.reduce((sum, day) => sum + day.netMinutes!, 0), targetMinutes: dates.reduce((sum, day) => sum + day.netMinutes!, 0), errors: [] })) };
  const state: SessionState = { schemaVersion: 7, revision: 1, planRevision: 1, connection: { status: 'connected', generation: 'calendar-session', employeeId: 'calendar-self', companyId: 'calendar-company', employeeLabel: 'Local Employee', companyLabel: 'Local Company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } }, snapshot, plan };
  const retainedSnapshot = structuredClone(snapshot);
  for (const date of retainedSnapshot.days) {
    const planned = plan.days.find(item => item.date === date.date)!;
    date.entries = structuredClone(planned.proposed);
    date.reportedMinutes = planned.netMinutes;
    date.fingerprint = `retained-${date.date}`;
  }
  const matching: SessionState = { ...structuredClone(state), revision: 2, planRevision: 2, snapshot: retainedSnapshot, plan: { ...structuredClone(plan), snapshot: retainedSnapshot, days: plan.days.map(day => ({ ...structuredClone(day), existing: structuredClone(day.proposed), action: day.eligible ? 'unchanged' : 'skip', existingNetMinutes: day.netMinutes })) } };
  return { settings, state, matching };
}

type CalendarFixture = { state: SessionState; commands: Array<{ type: string }>; preferences: unknown[]; replace(state: SessionState): void };

async function installFixture(page: Page, language: string, state?: SessionState, month?: string) {
  const fixture = calendarFixture(month);
  await page.addInitScript(({ settings, initial, language }) => {
    const listeners = new Set<(changes: unknown, area: string) => void>();
    const fixture: CalendarFixture = {
      state: structuredClone(initial), commands: [], preferences: [],
      replace(next) { this.state = structuredClone(next); for (const listener of listeners) listener({ sessionState: { newValue: structuredClone(next) } }, 'session'); },
    };
    Object.defineProperty(window, '__calendarFixture', { value: fixture });
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      i18n: { getUILanguage: () => language },
      runtime: { id: 'isolated-calendar-fixture', sendMessage: async (command: { type: string }) => { fixture.commands.push(command); return { ok: true, state: structuredClone(fixture.state) }; } },
      storage: { local: { get: async () => ({ settings }), set: async (value: unknown) => { fixture.preferences.push(value); } }, onChanged: { addListener: (listener: (changes: unknown, area: string) => void) => listeners.add(listener), removeListener: (listener: (changes: unknown, area: string) => void) => listeners.delete(listener) } },
    } });
  }, { settings: state?.plan?.settings ?? fixture.settings, initial: state ?? fixture.state, language });
  await page.goto('/sidepanel.html');
  await expect(page.locator('#month-view')).toBeVisible();
  return fixture;
}

async function replaceState(page: Page, state: SessionState) {
  await page.evaluate(next => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture.replace(next), state);
}

async function expectCompactHome(page: Page) {
  await expect(page.locator('#month-view')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const element = document.scrollingElement!;
    return { horizontal: element.scrollWidth <= innerWidth + 1, vertical: element.scrollHeight <= innerHeight + 1 };
  })).toEqual({ horizontal: true, vertical: true });
  for (const element of ['#month', '#schedule-summary', '#preview-summary']) if (await page.locator(element).isVisible()) await expect(page.locator(element)).toBeInViewport();
}

for (const language of ['de-DE', 'en-GB']) for (const viewport of [{ width: 360, height: 640 }, { width: 380, height: 720 }]) {
  test(`standard monthly states fit without scrollbars (${language}, ${viewport.width}x${viewport.height})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const fixture = calendarFixture();
    const unread = { ...structuredClone(fixture.state), snapshot: undefined, plan: undefined };
    await installFixture(page, language, unread);
    await expect(page.locator('#scan')).toBeInViewport();
    await expectCompactHome(page);
    await replaceState(page, { ...fixture.state, revision: 3, planRevision: 3 });
    await expect(page.locator('#apply')).toBeEnabled();
    await expect(page.locator('#apply')).toBeInViewport();
    await expectCompactHome(page);
    await expect(page.locator('#calendar [role="gridcell"]')).toHaveCount(42);
    await expect(page.locator('#calendar button[data-date]')).toHaveCount(30);
    await page.screenshot({ path: testInfo.outputPath(`calendar-${language}-${viewport.width}.png`), fullPage: false });
    await replaceState(page, { ...fixture.matching, revision: 4, planRevision: 4 });
    await expect(page.locator('#preview-summary')).toContainText(language.startsWith('de') ? 'Alles passt' : 'Everything matches');
    await expect(page.locator('#apply')).toBeDisabled();
    await expectCompactHome(page);
    const results = fixture.state.plan!.days.map(date => ({ date: date.date, status: date.eligible ? 'pending' as const : 'skipped' as const, message: date.eligible ? 'Pending' : 'Weekend' }));
    const running: SessionState = { ...structuredClone(fixture.state), revision: 5, planRevision: 5, job: { id: 'calendar-run', kind: 'apply', status: 'running', connectionId: 'calendar-session', month: '2026-11', startedAt: 'now', updatedAt: 'now' }, run: { runId: 'calendar-run', planId: fixture.state.plan!.id, status: 'running', executionProfile: 'fast-serial', results, startedAt: 'now', updatedAt: 'now' }, progress: { phase: 'apply', stage: 'verify', completed: 0, total: 21, message: 'Verification' } };
    await replaceState(page, running);
    await expect(page.locator('#cancel-run')).toBeInViewport();
    await expectCompactHome(page);
    const complete = structuredClone(running); complete.revision = 6; complete.job = undefined; complete.progress = undefined; complete.snapshot = undefined; complete.plan!.canReview = false; complete.run!.status = 'complete';
    for (const result of complete.run!.results) if (result.status !== 'skipped') result.status = 'verified';
    await replaceState(page, complete);
    await expect(page.locator('#run-status')).toContainText('21');
    await expectCompactHome(page);
    const evidence = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture);
    expect(evidence.commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
    expect(evidence.preferences).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('calendar navigation, full day/week details and flat tools never change an approved allocation', async ({ page }) => {
  const fixture = await installFixture(page, 'en-GB');
  await expect(page.locator('#apply')).toBeEnabled();
  const date = page.locator('#calendar-2026-11-18');
  await date.focus();
  await page.keyboard.press('ArrowDown'); await expect(page.locator('#calendar-2026-11-25')).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(date).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.locator('#calendar-2026-11-16')).toBeFocused();
  await page.keyboard.press('End'); await expect(page.locator('#calendar-2026-11-22')).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.locator('#day-view')).toBeVisible();
  await expect(page.locator('#day-content')).toContainText('Weekend');
  await expect(page.locator('#include-2026-11-22')).toBeDisabled();
  await home(page); await expect(page.locator('#calendar-2026-11-22')).toBeFocused();
  await day(page, '2026-11-18');
  const expected = fixture.state.plan!.days.find(item => item.date === '2026-11-18')!;
  for (const segment of expected.proposed) await expect(page.locator('#day-content')).toContainText(`${segment.start}–${segment.end}`);
  await expect(page.locator('#day-week')).toContainText('40 h 00 min');
  await expect(page.locator('#day-week .week-days li')).toHaveCount(7);
  await settings(page); await expect(page.locator('#settings-view')).toBeVisible();
  for (const section of ['booking', 'transfer', 'connection'] as const) { await tools(page, section); await page.locator('#tools-back').click(); }
  await home(page);
  const evidence = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture);
  expect(evidence.state.plan).toEqual(fixture.state.plan);
  expect(evidence.state.planRevision).toBe(fixture.state.planRevision);
  expect(evidence.commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
  expect(evidence.preferences).toEqual([]);
});

test('all six calendar rows and outside-month cells remain readable in a short narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await installFixture(page, 'de-DE', undefined, '2026-08');
  await expect(page.locator('#calendar [role="gridcell"]')).toHaveCount(42);
  await expect(page.locator('#calendar button[data-date]')).toHaveCount(31);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#apply').scrollIntoViewIfNeeded();
  await expect(page.locator('#apply')).toBeInViewport();
  await day(page, '2026-08-31');
  await expect(page.locator('#day-back')).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
});

test('uncertain and failed results remain prominent without opening run details', async ({ page }) => {
  const fixture = calendarFixture();
  const failed: SessionState = { ...structuredClone(fixture.state), snapshot: undefined, error: 'A saved entry could not be independently verified.', run: { planId: fixture.state.plan!.id, status: 'failed', startedAt: 'now', updatedAt: 'now', results: [{ date: '2026-11-02', status: 'uncertain', message: 'Readback unavailable' }, { date: '2026-11-03', status: 'pending', message: 'Not attempted' }] } };
  failed.plan!.canReview = false;
  await installFixture(page, 'en-GB', failed);
  await expect(page.locator('#main-error')).toBeVisible();
  await expect(page.locator('#run-uncertain')).toBeVisible();
  await expect(page.locator('#run-details-view')).not.toBeVisible();
  await page.locator('#run-details').click();
  await expect(page.locator('#run-results [data-status="uncertain"]')).toContainText('Readback unavailable');
  await expect(page.locator('#run-results [data-status="pending"]')).toContainText('Not attempted');
  await home(page);
  await expect(page.locator('#run-uncertain')).toBeVisible();
  const commands = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture.commands);
  expect(commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
});

test('monthly plan hours are distinct from the hours being written', async ({ page }) => {
  const fixture = calendarFixture();
  const retained = fixture.state.plan!.days.find(date => date.date === '2026-11-02')!;
  retained.existing = structuredClone(retained.proposed);
  retained.existing[0].note = 'Private existing note';
  retained.action = 'unchanged'; retained.existingNetMinutes = 480;
  const source = fixture.state.snapshot!.days.find(date => date.date === retained.date)!;
  source.entries = structuredClone(retained.existing); source.reportedMinutes = 480;
  fixture.state.plan!.snapshot = structuredClone(fixture.state.snapshot!);
  await installFixture(page, 'en-GB', fixture.state);
  await expect(page.locator('#preview-summary')).toContainText('168 h 00 min');
  await expect(page.locator('#preview-summary')).toContainText('21 included days');
  await expect(page.locator('#preview-summary')).toContainText('20 new');
  await expect(page.locator('#preview-summary')).toContainText('1 already fit');
  await day(page, retained.date);
  await expect(page.locator('#day-content')).toContainText('Private existing note');
  await home(page);
  await page.locator('#apply').click();
  const details = page.locator('#apply-details');
  await expect(details).toContainText('Net time to save');
  await expect(details).toContainText('160 h 00 min');
  await expect(page.locator('#confirm-apply')).toHaveText('Book 20 days');
  await expect(page.locator('#confirm-apply')).toBeDisabled();
  const evidence = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture);
  expect(evidence.commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
  expect(evidence.state.plan).toEqual(fixture.state.plan);
});

test('a 200 percent zoom-equivalent viewport keeps inspection and confirmation reachable through scrolling', async ({ page }) => {
  // This is the CSS viewport area of a 640x640 panel at 200% browser zoom.
  // It checks responsive reflow, without changing the user's native Chrome zoom.
  await page.setViewportSize({ width: 320, height: 320 });
  await installFixture(page, 'en-GB');
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('#apply').scrollIntoViewIfNeeded();
  await expect(page.locator('#apply')).toBeInViewport();
  await page.locator('#apply').click();
  await page.locator('#account-confirmation').scrollIntoViewIfNeeded();
  await expect(page.locator('#account-confirmation')).toBeInViewport();
  await page.locator('#close-apply').scrollIntoViewIfNeeded();
  await page.locator('#close-apply').click();
  await settings(page);
  await page.locator('#settings-back').scrollIntoViewIfNeeded();
  await expect(page.locator('#settings-back')).toBeInViewport();
  await home(page);
  const commands = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture.commands);
  expect(commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
});

test('explicitly skipped incompatible entries and an empty selection never claim everything matches', async ({ page }) => {
  const fixture = calendarFixture();
  const skipped = structuredClone(fixture.state);
  skipped.plan!.settings.variable = false;
  for (const date of skipped.plan!.days.filter(date => date.eligible)) {
    date.action = 'skip'; date.proposed = []; date.existing = [{ type: 'work', start: '08:00', end: '15:00' }];
    date.netMinutes = 420; date.existingNetMinutes = 420;
    skipped.plan!.choices[date.date] = 'skip';
    const source = skipped.snapshot!.days.find(item => item.date === date.date)!;
    source.entries = structuredClone(date.existing); source.reportedMinutes = 420;
  }
  for (const week of skipped.plan!.weeks) week.plannedMinutes = skipped.plan!.days.filter(date => week.dates.includes(date.date)).reduce((sum, date) => sum + date.netMinutes!, 0);
  skipped.plan!.snapshot = structuredClone(skipped.snapshot!);
  await installFixture(page, 'en-GB', skipped);
  await expect(page.locator('#preview-summary')).toContainText('No changes selected');
  await expect(page.locator('#preview-summary')).not.toContainText('Everything matches');
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#conflicts')).not.toBeVisible();
  const empty = structuredClone(skipped);
  empty.revision = 3; empty.planRevision = 3;
  empty.plan!.settings.excludedDates = empty.plan!.days.filter(date => date.eligible).map(date => date.date);
  for (const date of empty.plan!.days) { date.eligible = false; date.netMinutes = 0; }
  for (const week of empty.plan!.weeks) { week.plannedMinutes = 0; week.targetMinutes = 0; }
  await replaceState(page, empty);
  await expect(page.locator('#preview-summary')).toContainText('No working days selected');
  await expect(page.locator('#preview-summary')).not.toContainText('Everything matches');
  await expect(page.locator('#apply')).toBeDisabled();
  const evidence = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture);
  expect(evidence.commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
});

test('an uncertainty arriving while inspecting settings remains visible and links back to the run', async ({ page }) => {
  const fixture = calendarFixture();
  const running: SessionState = { ...structuredClone(fixture.state), job: { id: 'calendar-run', kind: 'apply', status: 'running', connectionId: 'calendar-session', month: '2026-11', startedAt: 'now', updatedAt: 'now' }, run: { runId: 'calendar-run', planId: fixture.state.plan!.id, status: 'running', executionProfile: 'fast-serial', startedAt: 'now', updatedAt: 'now', results: [{ date: '2026-11-02', status: 'verified', message: 'Saved and verified' }, { date: '2026-11-03', status: 'awaiting-verification', message: 'Pending verification' }, { date: '2026-11-04', status: 'pending', message: 'Not attempted' }] } };
  await installFixture(page, 'en-GB', running);
  await settings(page);
  await expect(page.locator('#settings-view')).toBeVisible();
  await expect(page.locator('#start')).toBeDisabled();
  await expect(page.locator('#cancel-run')).toBeVisible();
  const failed = structuredClone(running); failed.revision = 3; failed.planRevision = 2; failed.job = undefined; failed.snapshot = undefined; failed.plan!.canReview = false; failed.run!.status = 'failed';
  failed.run!.results[1].status = 'uncertain'; failed.run!.results[1].message = 'Readback unavailable';
  await replaceState(page, failed);
  await expect(page.locator('#settings-view')).toBeVisible();
  await expect(page.locator('#run-uncertain')).toBeVisible();
  await expect(page.locator('#run-impact')).toBeVisible();
  await expect(page.locator('#run-impact')).toContainText('03/11');
  await expect(page.locator('#run-impact')).toContainText('1 verified');
  await expect(page.locator('#run-impact')).toContainText('2 remaining');
  await expect(page.locator('#run-impact')).toContainText('Readback unavailable');
  await expect(page.locator('#return-to-run')).toBeVisible();
  await expect(page.locator('#cancel-run')).not.toBeVisible();
  await page.locator('#return-to-run').click();
  await expect(page.locator('#month-view')).toBeVisible();
  await expect(page.locator('#run-uncertain')).toBeVisible();
  await expect(page.locator('#run-status')).toContainText('1 of 3');
  const commands = await page.evaluate(() => (window as unknown as { __calendarFixture: CalendarFixture }).__calendarFixture.commands);
  expect(commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
});
