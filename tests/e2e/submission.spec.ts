import { expect, test, type Page } from '@playwright/test';
import type { BookingPlan, DayPlan, MonthSnapshot, SessionState, Settings, SubmissionReview, TimesheetStatus } from '../../src/shared/types';
import { home, settings, tools } from './ui';

function submissionFixture(status: TimesheetStatus = 'Open', pending = false): SessionState {
  const settings: Settings = { month: '2026-11', state: 'HE', start: '08:00', end: '16:30', useBreak: true, breakStart: '12:00', breakEnd: '12:30', variable: true, variationMinutes: 15, excludedDates: [], localHolidays: { augsburg: null, assumption: null, corpusChristi: null } };
  const segments = [{ type: 'work' as const, start: '08:00', end: '12:00' }, { type: 'break' as const, start: '12:00', end: '12:30' }, { type: 'work' as const, start: '12:30', end: '16:30' }];
  const snapshot: MonthSnapshot = { source: 'hibob', month: settings.month, employeeLabel: 'Local Employee', periodLabel: 'November 2026', scannedAt: '2026-11-25T10:00:00Z', context: { mode: 'api-session', connectionId: 'submission-session', employeeKey: 'self', tenantKey: 'company' }, submission: { id: 'sheet', start: '2026-11-01', end: '2026-11-30', status, locked: status === 'Approved' }, days: Array.from({ length: 30 }, (_, n) => { const date = `2026-11-${String(n + 1).padStart(2, '0')}`; const eligible = ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()); return { date, entries: eligible ? structuredClone(segments) : [], editable: status === 'Open', reportedMinutes: eligible ? 480 : 0, fingerprint: `saved-${date}` }; }) };
  const days: DayPlan[] = snapshot.days.map(day => { const eligible = day.entries.length > 0; return { date: day.date, existing: structuredClone(day.entries), proposed: eligible ? structuredClone(segments) : [], eligible, action: eligible ? pending ? 'overwrite' : 'unchanged' : 'skip', reason: eligible ? undefined : 'Weekend', fingerprint: day.fingerprint, netMinutes: eligible ? 480 : 0, existingNetMinutes: eligible ? 480 : 0 }; });
  const weeks = new Map<string, DayPlan[]>();
  for (const day of days) { const start = new Date(`${day.date}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7); const key = start.toISOString().slice(0, 10); weeks.set(key, [...(weeks.get(key) ?? []), day]); }
  const plan: BookingPlan = { id: 'submission-plan', seed: 123, settings, snapshot, choices: pending ? Object.fromEntries(days.filter(day => day.eligible).map(day => [day.date, 'overwrite' as const])) : {}, days, errors: [], canReview: true, weeks: [...weeks].map(([week, days]) => ({ week, dates: days.map(day => day.date), plannedMinutes: days.reduce((sum, day) => sum + day.netMinutes!, 0), targetMinutes: days.reduce((sum, day) => sum + day.netMinutes!, 0), errors: [] })) };
  return { schemaVersion: 7, revision: 1, planRevision: 1, submissionRevision: 0, connection: { status: 'connected', generation: 'submission-session', employeeId: 'self', companyId: 'company', employeeLabel: 'Local Employee', companyLabel: 'Local Company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } }, plan, snapshot, reminder: { enabled: true, due: status === 'Open' ? [{ month: '2026-11', status: 'Open', needsCheck: false }] : [] } };
}

type Command = { type: string; month?: string; reviewId?: string; enabled?: boolean; submissionConsent?: unknown; expectedSubmissionRevision?: number };
type Fixture = { state: SessionState; commands: Command[]; preferences: unknown[]; delayed: boolean; release?: () => void; replace(next: SessionState): void };
async function install(page: Page, initial = submissionFixture(), language = 'en-GB', delayed = false) {
  await page.addInitScript(({ initial, language, delayed }) => {
    const listeners = new Set<(changes: unknown, area: string) => void>();
    const fixture: Fixture = { state: structuredClone(initial), commands: [], preferences: [], delayed, replace(next) { this.state = structuredClone(next); for (const listener of listeners) listener({ sessionState: { newValue: structuredClone(next) } }, 'session'); } };
    Object.defineProperty(window, '__submissionFixture', { value: fixture });
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      i18n: { getUILanguage: () => language },
      runtime: { id: 'isolated-submission-fixture', sendMessage: async (command: Command) => {
        fixture.commands.push(structuredClone(command));
        const state = fixture.state;
        if (command.type === 'PANEL_REVIEW_SUBMISSION') {
          if (fixture.delayed) await new Promise<void>(resolve => { fixture.release = resolve; });
          state.revision!++; state.submissionRevision = (state.submissionRevision ?? 0) + 1;
          state.submissionReview = { id: `review-${state.submissionRevision}`, month: command.month!, connectionId: state.connection!.generation!, accountKey: 'account', employeeLabel: 'Local Employee', companyLabel: 'Local Company', period: state.snapshot!.submission!, contentFingerprint: 'content', eligibilityFingerprint: 'eligibility', netMinutes: 10080, issues: [], canSubmit: !['Approved', 'Submitted', 'PendingProjectApproval'].includes(state.snapshot!.submission!.status), early: false, checkedAt: '2026-11-25T11:00:00Z' } satisfies SubmissionReview;
        } else if (command.type === 'PANEL_DISMISS_SUBMISSION' && state.submissionReview?.id === command.reviewId) {
          state.revision!++; state.submissionRevision!++; state.submissionReview = undefined;
        } else if (command.type === 'PANEL_SET_REMINDERS') {
          state.revision!++; state.reminder!.enabled = command.enabled!;
        } else if (command.type === 'PANEL_SUBMIT_MONTH') {
          state.revision!++; state.submissionRevision!++; state.submissionReview = undefined;
          // Production invalidates the scan and leaves the pre-Submit plan unchanged.
          state.snapshot = undefined; state.plan!.canReview = false;
          state.reminder!.due = []; state.submissionResult = { month: '2026-11', status: 'verified', periodStatus: 'Submitted', message: 'Submission verified' };
        }
        return { ok: true, state: structuredClone(state) };
      } },
      storage: { local: { get: async () => ({ settings: initial.plan?.settings ?? { month: '2026-11', state: 'HE', start: '08:00', end: '16:30', useBreak: true, breakStart: '12:00', breakEnd: '12:30', variable: true, variationMinutes: 15, excludedDates: [], localHolidays: { augsburg: null, assumption: null, corpusChristi: null } } }), set: async (value: unknown) => fixture.preferences.push(value) }, onChanged: { addListener: (listener: (changes: unknown, area: string) => void) => listeners.add(listener), removeListener: (listener: (changes: unknown, area: string) => void) => listeners.delete(listener) } },
    } });
  }, { initial, language, delayed });
  await page.goto('/sidepanel.html');
  await expect(page.locator('#month-view')).toBeVisible();
}
async function evidence(page: Page) { return page.evaluate(() => { const f = (window as unknown as { __submissionFixture: Fixture }).__submissionFixture; return { state: f.state, commands: f.commands, preferences: f.preferences }; }); }
async function replace(page: Page, state: SessionState) { await page.evaluate(state => (window as unknown as { __submissionFixture: Fixture }).__submissionFixture.replace(state), state); }
async function compact(page: Page) { await expect.poll(() => page.evaluate(() => { const node = document.scrollingElement!; return node.scrollWidth <= innerWidth + 1 && node.scrollHeight <= innerHeight + 1; })).toBe(true); }

for (const language of ['de-DE', 'en-GB']) for (const viewport of [{ width: 360, height: 640 }, { width: 380, height: 720 }]) {
  test(`due reminder stays compact without a second primary action (${language}, ${viewport.width})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); await install(page, submissionFixture(), language);
    await expect(page.locator('#submission-notice')).toContainText('November');
    await expect(page.locator('#review-submission')).toBeInViewport();
    await expect(page.locator('#month-view .button.primary:visible')).toHaveCount(1);
    await compact(page);
    const mark = await page.locator('.app-mark').boundingBox(); const title = await page.locator('#view-title').boundingBox();
    expect(title!.x).toBeGreaterThanOrEqual(mark!.x + mark!.width + 6);
    await page.screenshot({ path: testInfo.outputPath('due-matching.png') });
    const pending = submissionFixture('Open', true); pending.revision = 3; pending.planRevision = 2;
    await replace(page, pending);
    await expect(page.locator('#apply')).toBeVisible();
    await expect(page.locator('#review-submission')).toHaveClass('text-button');
    await expect(page.locator('#month-view .button.primary:visible')).toHaveCount(1);
    await compact(page);
    await page.screenshot({ path: testInfo.outputPath('due-booking.png') });
    expect((await evidence(page)).commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
  });
}

test('submission is explicit, uses actual saved hours, and requires its own scoped consent', async ({ page }) => {
  await install(page);
  expect((await evidence(page)).commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
  await page.locator('#review-submission').click();
  await expect(page.locator('#submission-dialog')).toBeVisible();
  await expect(page.locator('#submission-details')).toContainText('168 h 00 min');
  await expect(page.locator('#submission-details')).toContainText('Local Employee · Local Company');
  await expect(page.locator('#confirm-submission')).toBeDisabled();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
  await page.locator('#submission-confirmation').check();
  await expect(page.locator('#confirm-submission')).toBeEnabled();
  await page.locator('#confirm-submission').click();
  await expect(page.locator('#submission-dialog')).not.toBeVisible();
  await expect(page.locator('#preview-summary')).toContainText('Submitted');
  await expect(page.locator('#submission-notice')).not.toContainText('Submit November');
  await expect(page.locator('#apply')).not.toBeVisible();
  await expect(page.locator('#refresh-month')).toBeVisible();
  const result = await evidence(page); const calls = result.commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ type: 'PANEL_SUBMIT_MONTH', reviewId: 'review-1', expectedSubmissionRevision: 1, submissionConsent: { reviewId: 'review-1', reviewRevision: 1, connectionId: 'submission-session', accountKey: 'account', contentFingerprint: 'content', eligibilityFingerprint: 'eligibility', confirmed: true } });
  expect(result.commands.some(command => command.type === 'PANEL_APPLY')).toBe(false);
});

test('closing and reopening clears consent, and external account or revision changes close review', async ({ page }) => {
  await install(page); await page.locator('#review-submission').click(); await page.locator('#submission-confirmation').check();
  await page.locator('#close-submission').click();
  await expect.poll(async () => (await evidence(page)).commands.filter(command => command.type === 'PANEL_DISMISS_SUBMISSION').length).toBe(1);
  await page.locator('#review-submission').click();
  await expect(page.locator('#submission-confirmation')).not.toBeChecked();
  await expect(page.locator('#confirm-submission')).toBeDisabled();
  await page.locator('#submission-confirmation').check();
  const changed = (await evidence(page)).state; changed.revision!++; changed.submissionRevision!++;
  await replace(page, changed);
  await expect(page.locator('#submission-dialog')).not.toBeVisible();
  await page.locator('#review-submission').click();
  const accountChanged = (await evidence(page)).state; accountChanged.revision!++; accountChanged.connection!.generation = 'another-session';
  await replace(page, accountChanged);
  await expect(page.locator('#submission-dialog')).not.toBeVisible();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
});

test('pending plan changes block submission while showing concrete review guidance', async ({ page }) => {
  await install(page, submissionFixture('Open', true));
  await page.locator('#review-submission').click();
  await expect(page.locator('#submission-dialog')).toBeVisible();
  await expect(page.locator('#submission-issues')).toContainText('Complete your bookings first');
  await expect(page.locator('#submission-confirmation')).toBeDisabled();
  await expect(page.locator('#confirm-submission')).toBeDisabled();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
});

test('reminder preference has a separate command and manual submission remains available when reminders are off', async ({ page }) => {
  await install(page); await tools(page, 'booking');
  await expect(page.locator('#reminders-enabled')).toBeChecked();
  await page.locator('#reminders-enabled').uncheck();
  await expect(page.locator('#reminders-enabled')).not.toBeChecked();
  await page.locator('#submit-month').click();
  await expect(page.locator('#submission-dialog')).toBeVisible();
  const result = await evidence(page);
  expect(result.commands.filter(command => command.type === 'PANEL_SET_REMINDERS')).toEqual([{ type: 'PANEL_SET_REMINDERS', enabled: false }]);
  expect(result.preferences).toEqual([]);
  expect(result.state.plan!.settings).not.toHaveProperty('reminders');
});

for (const [status, label] of [['Submitted', 'Submitted'], ['Approved', 'Approved'], ['PendingProjectApproval', 'Awaiting project approval']] as const) {
  test(`${status} has a read-only calendar and distinct status`, async ({ page }) => {
    await install(page, submissionFixture(status));
    await expect(page.locator('#preview-summary')).toContainText(label);
    await expect(page.locator('#preview-summary')).not.toContainText('No working days');
    await expect(page.locator('#apply')).not.toBeVisible();
    await expect(page.locator('#calendar button[data-date]')).toHaveCount(30);
    await page.locator('#review-submission').click();
    await expect(page.locator('#submission-dialog')).toBeVisible();
    await expect(page.locator('#submission-details')).toContainText(label);
    await expect(page.locator('#confirm-submission')).not.toBeVisible();
    await expect(page.locator('#submission-confirmation')).not.toBeVisible();
  });
}

test('uncertain submission stays visible in settings and only offers a fresh review', async ({ page }) => {
  const state = submissionFixture(); state.submissionResult = { month: '2026-11', status: 'uncertain', message: 'Independent status read unavailable' };
  await install(page, state); await settings(page);
  await expect(page.locator('#submission-result')).toBeVisible();
  await expect(page.locator('#submission-result')).toContainText('Submission status unclear');
  await expect(page.locator('#review-uncertain-submission')).toBeVisible();
  await page.locator('#review-uncertain-submission').click();
  await expect(page.locator('#submission-confirmation')).toBeDisabled();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
});

test('navigation while a review request is pending cannot open a stale dialog', async ({ page }) => {
  await install(page, submissionFixture(), 'en-GB', true);
  await page.locator('#review-submission').click();
  await expect.poll(async () => (await evidence(page)).commands.filter(command => command.type === 'PANEL_REVIEW_SUBMISSION').length).toBe(1);
  await page.locator('#settings-toggle').click();
  await page.evaluate(() => (window as unknown as { __submissionFixture: Fixture }).__submissionFixture.release!());
  await expect(page.locator('#settings-view')).toBeVisible();
  await expect(page.locator('#submission-dialog')).not.toBeVisible();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
});

test('submission review remains reachable at 200 percent zoom-equivalent viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 320 }); await install(page);
  await page.locator('#review-submission').scrollIntoViewIfNeeded(); await page.locator('#review-submission').click();
  await page.locator('#submission-confirmation').scrollIntoViewIfNeeded(); await expect(page.locator('#submission-confirmation')).toBeInViewport();
  await page.locator('#close-submission').scrollIntoViewIfNeeded(); await page.locator('#close-submission').click();
  await home(page);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1)).toBe(true);
});


test('closed snapshots without a plan retain saved details and never substitute zero for unknown hours', async ({ page }) => {
  const state = submissionFixture('Submitted'); state.plan = undefined;
  state.snapshot!.days[1].reportedMinutes = null;
  await install(page, state);
  await expect(page.locator('#preview-summary')).toContainText('Hours cannot be calculated yet');
  await expect(page.locator('#preview-summary')).toContainText('Submitted');
  await page.locator('#calendar-2026-11-02').click();
  await expect(page.locator('#day-content')).toContainText('08:00–12:00');
  await expect(page.locator('#include-2026-11-02')).toBeDisabled();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
});

test('a passive reminder check blocks submission without opening a dialog', async ({ page }) => {
  const state = submissionFixture();
  state.job = { id: 'reminder-read', kind: 'reminder-check', month: '', status: 'running', connectionId: 'submission-session', startedAt: 'now', updatedAt: 'now' };
  state.progress = { phase: 'submission', completed: 0, total: 1, message: 'Check submission status' };
  await install(page, state);
  await expect(page.locator('#review-submission')).toBeDisabled();
  await expect(page.locator('#scan-progress')).toContainText('Check submission status');
  await tools(page, 'booking'); await expect(page.locator('#submit-month')).toBeDisabled();
  await expect(page.locator('#submission-dialog')).not.toBeVisible();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_REVIEW_SUBMISSION')).toHaveLength(0);
});

test('multiple overdue reminders target the selected month before the oldest without changing booking settings', async ({ page }) => {
  const state = submissionFixture(); state.reminder!.due.unshift({ month: '2026-10', status: 'Open', needsCheck: false });
  await install(page, state);
  await expect(page.locator('#submission-notice')).toContainText('+1 more');
  await page.locator('#review-submission').click();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_REVIEW_SUBMISSION')).toEqual([{ type: 'PANEL_REVIEW_SUBMISSION', month: '2026-11' }]);
  await page.locator('#close-submission').click();
  const changed = (await evidence(page)).state; changed.revision!++; changed.reminder!.due = [{ month: '2026-10', status: 'unknown', needsCheck: true }];
  await replace(page, changed);
  await expect(page.locator('#submission-notice')).toContainText('October 2026');
  await page.locator('#review-submission').click();
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_REVIEW_SUBMISSION').at(-1)).toEqual({ type: 'PANEL_REVIEW_SUBMISSION', month: '2026-10' });
  await expect(page.locator('#month')).toHaveValue('2026-11');
  expect((await evidence(page)).preferences).toEqual([]);
});


test('closing the panel sends only a scoped dismissal and never retains consent on reopen', async ({ page }) => {
  await install(page); await page.locator('#review-submission').click(); await page.locator('#submission-confirmation').check();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(async () => (await evidence(page)).commands.filter(command => command.type === 'PANEL_DISMISS_SUBMISSION')).toEqual([{ type: 'PANEL_DISMISS_SUBMISSION', reviewId: 'review-1' }]);
  expect((await evidence(page)).commands.filter(command => command.type === 'PANEL_SUBMIT_MONTH')).toHaveLength(0);
  await page.reload();
  await expect(page.locator('#submission-dialog')).not.toBeVisible();
  await page.locator('#review-submission').click();
  await expect(page.locator('#submission-confirmation')).not.toBeChecked();
  await expect(page.locator('#confirm-submission')).toBeDisabled();
});
