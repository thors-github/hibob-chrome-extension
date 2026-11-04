import { expect, test, type Page } from '@playwright/test';
import { checks as showChecks } from './ui';
import type { BookingPlan, DayPlan, MonthSnapshot, SessionState, Settings } from '../../src/shared/types';

function fixtureState() {
  const settings: Settings = { month: '2026-11', state: 'HE', start: '08:00', end: '16:30', useBreak: true, breakStart: '12:00', breakEnd: '12:30', variable: false, variationMinutes: 15, excludedDates: ['2026-11-02'], localHolidays: { augsburg: null, assumption: null, corpusChristi: null } };
  const dates = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
  const snapshot: MonthSnapshot = {
    source: 'hibob', month: settings.month, employeeLabel: 'Local draft fixture', periodLabel: '01/11/2026–30/11/2026', scannedAt: '2026-11-02T08:30:00Z',
    context: { mode: 'api-session', connectionId: 'local-session', employeeKey: 'local-employee', tenantKey: 'local-company' },
    days: dates.map(date => ({ date, editable: true, entries: [], reportedMinutes: 0, fingerprint: `empty:${date}` })),
  };
  const days: DayPlan[] = snapshot.days.map(day => {
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    const eligible = weekday !== 0 && weekday !== 6 && !settings.excludedDates.includes(day.date);
    return { date: day.date, existing: [], proposed: eligible ? [{ type: 'work', start: '08:00', end: '12:00' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }] : [], action: eligible ? 'create' : 'skip', fingerprint: day.fingerprint, eligible, netMinutes: eligible ? 480 : 0, existingNetMinutes: 0 };
  });
  const plan: BookingPlan = { id: 'local-draft-preview', seed: 123, settings, snapshot, choices: {}, days, errors: [], canReview: true,
    weeks: ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map(week => {
      const start = new Date(`${week}T12:00:00Z`).getTime();
      const included = days.filter(day => { const instant = new Date(`${day.date}T12:00:00Z`).getTime(); return instant >= start && instant < start + 7 * 86400000; });
      const minutes = included.reduce((total, day) => total + (day.netMinutes ?? 0), 0);
      return { week, dates: included.map(day => day.date), targetMinutes: minutes, plannedMinutes: minutes, errors: [] };
    }),
  };
  const state: SessionState = { schemaVersion: 7, revision: 1, planRevision: 7, connection: { status: 'connected', generation: 'local-session', employeeId: 'local-employee', companyId: 'local-company', employeeLabel: 'Local Employee', companyLabel: 'Local Company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } }, snapshot, plan,
    run: { planId: 'earlier-plan', status: 'complete', startedAt: 'earlier', updatedAt: 'earlier', results: [{ date: '2026-10-30', status: 'verified', message: 'Earlier verified result' }] },
  };
  return { settings, state };
}

async function installFixture(page: Page, language: string, cancel = false, readOnly = false) {
  const { settings, state } = fixtureState();
  if (readOnly) state.connection!.capabilities = { read: true, write: false, overwrite: false };
  // These RPCs are served by this isolated local page. No installed extension
  // or HiBob tab receives PREFLIGHT, CANCEL or APPLY commands.
  await page.addInitScript(({ settings, initial, language, cancel }) => {
    let state = structuredClone(initial);
    const commands: Array<{ type: string }> = [];
    const writes: unknown[] = [];
    const listeners = new Set<(changes: unknown, area: string) => void>();
    let cancelled: (() => void) | undefined;
    const emit = () => { for (const listener of listeners) listener({ sessionState: { newValue: structuredClone(state) } }, 'session'); };
    const finish = () => {
      state = { ...state, revision: state.revision! + 1, planRevision: state.planRevision! + 1, snapshot: undefined, plan: state.plan ? { ...state.plan, canReview: false } : undefined, job: undefined, progress: undefined };
      emit();
    };
    Object.defineProperty(window, '__draftFixture', { value: { commands, writes, get state() { return structuredClone(state); }, replacePlan() {
      state = { ...state, revision: state.revision! + 1, planRevision: state.planRevision! + 1, plan: { ...state.plan!, id: 'replacement-draft-preview' } };
      emit();
    } } });
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      i18n: { getUILanguage: () => language },
      runtime: { id: 'local-draft-rpc-fixture', sendMessage: async (command: { type: string; date?: string; plan?: BookingPlan }) => {
        commands.push(structuredClone(command));
        if (command.type === 'PANEL_PREFLIGHT') {
          const day = command.plan!.days.find(day => day.date === command.date)!;
          state = { ...state, revision: state.revision! + 1, job: { id: 'local-draft-job', kind: 'apply', status: 'running', connectionId: 'local-session', month: '2026-11', startedAt: 'now', updatedAt: 'now' } };
          emit();
          if (cancel) return new Promise(resolve => { cancelled = () => { finish(); resolve({ ok: false, state: structuredClone(state), error: 'Preflight cancelled without saving' }); }; });
          await new Promise(resolve => setTimeout(resolve, 30));
          finish();
          return { ok: true, state: structuredClone(state), preflight: { date: day.date, checked: true, netMinutes: day.netMinutes, saved: false, serverValidated: false } };
        }
        if (command.type === 'PANEL_CANCEL') cancelled?.();
        return { ok: true, state: structuredClone(state) };
      } },
      storage: { local: { get: async () => ({ settings: structuredClone(settings) }), set: async (value: unknown) => { writes.push(value); } }, onChanged: { addListener: (listener: (changes: unknown, area: string) => void) => listeners.add(listener), removeListener: (listener: (changes: unknown, area: string) => void) => listeners.delete(listener) } },
    } });
  }, { settings, initial: state, language, cancel });
  return { settings, state };
}

test('read-only API capabilities permit preflight but never enable saving', async ({ page }) => {
  await installFixture(page, 'en-GB', false, true);
  await page.goto('/sidepanel.html');
  await expect(page.locator('#scan')).toBeEnabled();
  await expect(page.locator('#api-capability-notice')).toBeVisible();
  await expect(page.locator('#apply')).toBeEnabled();
  await page.locator('#apply').click();
  await showChecks(page);
  await expect(page.locator('#apply-details')).toContainText('Local Employee · Local Company');
  await page.locator('#account-confirmation').check();
  await expect(page.locator('#confirm-apply')).toBeDisabled();
  await expect(page.locator('#check-draft')).toBeEnabled();
  await page.locator('#confirm-apply').dispatchEvent('click');
  await showChecks(page);
  await page.locator('#check-draft').click();
  await expect(page.locator('#draft-check-result')).toBeVisible();
  const result = await page.evaluate(() => (window as unknown as { __draftFixture: Fixture }).__draftFixture);
  expect(result.commands.filter(command => command.type === 'PANEL_PREFLIGHT')).toHaveLength(1);
  expect(result.commands.some(command => command.type === 'PANEL_APPLY')).toBe(false);
  expect(result.writes).toEqual([]);
});

type Fixture = { commands: Array<{ type: string; date?: string; expectedPlanRevision?: number; jobId?: string; confirmation?: { planId: string; planRevision: number; confirmed: boolean } }>; writes: unknown[]; state: SessionState; replacePlan(): void };

for (const language of ['de-DE', 'en-GB']) {
  test(`read-only preflight check requires date-bound consent and never dispatches APPLY (${language}, local RPC fixture)`, async ({ page }) => {
    const initial = await installFixture(page, language);
    const destinations: string[] = [];
    page.on('request', request => destinations.push(request.url()));
    await page.goto('/sidepanel.html');
    await expect(page.locator('#apply')).toBeEnabled();
    await page.locator('#apply').click();
    await showChecks(page);
    const consent = page.locator('#account-confirmation');
    const date = page.locator('#draft-check-date');
    await expect(date).toHaveValue('2026-11-03');
    await expect(date.locator('option')).toHaveCount(20);
    expect(await date.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).not.toContain('2026-11-02');
    await expect(page.locator('#check-draft')).toBeDisabled();
    await consent.check();
    await date.selectOption('2026-11-04');
    await expect(consent).not.toBeChecked();
    await expect(page.locator('#check-draft')).toBeDisabled();
    await expect(page.locator('#confirm-apply')).toBeDisabled();
    await consent.check();
    await page.evaluate(() => (window as unknown as { __draftFixture: Fixture }).__draftFixture.replacePlan());
    await expect(page.locator('#apply-dialog')).not.toBeVisible();
    await page.locator('#check-draft').dispatchEvent('click');
    expect(await page.evaluate(() => (window as unknown as { __draftFixture: Fixture }).__draftFixture.commands.some(command => command.type === 'PANEL_PREFLIGHT'))).toBe(false);
    await expect(page.locator('#apply')).toBeEnabled();
    await page.locator('#apply').click();
    await showChecks(page);
    await expect(consent).not.toBeChecked();
    await expect(date).toHaveValue('2026-11-03');
    await date.selectOption('2026-11-04');
    await consent.check();
    if (language.startsWith('en')) await expect(page.locator('#check-draft')).toHaveText('Check plan — no saving');
    await showChecks(page);
    await page.locator('#check-draft').click();
    await expect(page.locator('#draft-check-result')).toBeVisible();
    await expect(page.locator('#draft-check-result-title')).toContainText(language.startsWith('en') ? /not saved/i : /nicht gespeichert/);
    await expect(page.locator('#draft-check-details')).toContainText(language.startsWith('en') ? /04\/11/ : /04\.11\./);
    await expect(page.locator('#apply')).toBeDisabled();
    await expect(page.locator('#scan')).toBeEnabled();
    await expect(consent).not.toBeChecked();
    await expect(page.locator('#footer-hint')).toContainText(language.startsWith('en') ? /read the month again/i : /Monat erneut einlesen/);
    const result = await page.evaluate(() => (window as unknown as { __draftFixture: Fixture }).__draftFixture);
    const checks = result.commands.filter(command => command.type === 'PANEL_PREFLIGHT');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ date: '2026-11-04', expectedPlanRevision: 8, confirmation: { planId: 'replacement-draft-preview', planRevision: 8, confirmed: true } });
    expect(result.commands.some(command => command.type === 'PANEL_APPLY')).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.state.run).toEqual(initial.state.run);
    expect(JSON.stringify(result.state)).not.toContain('preflight');
    expect(destinations.every(url => url.startsWith('http://127.0.0.1:5173/') || url.startsWith('ws://127.0.0.1:5173/'))).toBe(true);
  });
}

test('read-only preflight cancellation uses the active job and leaves history intact (local RPC fixture)', async ({ page }) => {
  const initial = await installFixture(page, 'en-GB', true);
  await page.goto('/sidepanel.html');
  await expect(page.locator('#apply')).toBeEnabled();
  await page.locator('#apply').click();
  await showChecks(page);
  await page.locator('#account-confirmation').check();
  await showChecks(page);
  await page.locator('#check-draft').click();
  await expect(page.locator('#cancel-run')).toBeVisible();
  await expect(page.locator('#scan')).toBeDisabled();
  await page.locator('#cancel-run').click();
  await expect(page.locator('#main-error')).toContainText('cancelled without saving');
  await expect(page.locator('#draft-check-result')).not.toBeVisible();
  await expect(page.locator('#apply')).toBeDisabled();
  await expect(page.locator('#scan')).toBeEnabled();
  const result = await page.evaluate(() => (window as unknown as { __draftFixture: Fixture }).__draftFixture);
  expect(result.commands.find(command => command.type === 'PANEL_CANCEL')).toMatchObject({ jobId: 'local-draft-job' });
  expect(result.commands.some(command => command.type === 'PANEL_APPLY')).toBe(false);
  expect(result.state.run).toEqual(initial.state.run);
});
