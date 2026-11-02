import { expect, test } from '@playwright/test';
import type { BookingPlan, DayPlan, MonthSnapshot, SessionState, Settings } from '../../src/shared/types';

for (const language of ['de-DE', 'en-GB']) {
  test(`manual account consent is fresh and bound to the reviewed plan (${language}, local RPC fixture)`, async ({ page }) => {
    const settings: Settings = { month: '2026-11', state: 'HE', start: '08:00', end: '16:30', useBreak: true, breakStart: '12:00', breakEnd: '12:30', variable: false, variationMinutes: 5, excludedDates: [], localHolidays: { augsburg: null, assumption: null, corpusChristi: null } };
    const dates = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
    const snapshot: MonthSnapshot = {
      source: 'hibob', month: settings.month, employeeLabel: 'Local attendance fixture', periodLabel: '01/11/2026–30/11/2026', scannedAt: '2026-11-02T08:30:00Z',
      context: { mode: 'api-session', connectionId: 'local-session', employeeKey: 'local-employee', tenantKey: 'local-company' },
      days: dates.map(date => ({ date, editable: true, entries: [], reportedMinutes: 0, fingerprint: `empty:${date}` })),
    };
    const days: DayPlan[] = snapshot.days.map(day => {
      const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      const eligible = weekday !== 0 && weekday !== 6;
      return { date: day.date, existing: [], proposed: eligible ? [{ type: 'work', start: '08:00', end: '12:00' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }] : [], action: eligible ? 'create' : 'skip', fingerprint: day.fingerprint, eligible, netMinutes: eligible ? 480 : 0, existingNetMinutes: 0 };
    });
    const plan: BookingPlan = { id: 'local-manual-preview', seed: 123, settings, snapshot, choices: {}, days, errors: [], canReview: true,
      weeks: ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map(week => {
        const start = new Date(`${week}T12:00:00Z`).getTime();
        const included = days.filter(day => { const instant = new Date(`${day.date}T12:00:00Z`).getTime(); return instant >= start && instant < start + 7 * 86400000; });
        const minutes = included.reduce((total, day) => total + (day.netMinutes ?? 0), 0);
        return { week, dates: included.map(day => day.date), targetMinutes: minutes, plannedMinutes: minutes, errors: [] };
      }),
    };
    const state: SessionState = { schemaVersion: 6, revision: 1, planRevision: 7, connection: { status: 'connected', generation: 'local-session', employeeId: 'local-employee', companyId: 'local-company', employeeLabel: 'Local Employee', companyLabel: 'Local Company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } }, snapshot, plan };
    const destinations: string[] = [];
    page.on('request', request => destinations.push(request.url()));
    // This isolated page owns a local RPC fixture. No real extension runtime or
    // HiBob tab receives these requests, including the simulated APPLY request.
    await page.addInitScript(({ settings, state, language }) => {
      const commands: Array<{ type: string }> = [];
      const writes: unknown[] = [];
      Object.defineProperty(window, '__accountFixture', { value: { commands, writes } });
      Object.defineProperty(window, 'chrome', { configurable: true, value: {
        i18n: { getUILanguage: () => language },
        runtime: { id: 'local-account-rpc-fixture', sendMessage: async (command: { type: string }) => { commands.push(command); return { ok: true, state: structuredClone(state) }; } },
        storage: { local: { get: async () => ({ settings }), set: async (value: unknown) => { writes.push(value); } }, onChanged: { addListener: () => {}, removeListener: () => {} } },
      } });
    }, { settings, state, language });
    await page.goto('/sidepanel.html');
    await expect(page.locator('html')).toHaveAttribute('lang', language.startsWith('de') ? 'de' : 'en');
    await expect(page.locator('#apply')).toBeEnabled();
    await expect(page.locator('#account-context-notice')).toBeVisible();
    await expect(page.locator('#main-error')).not.toBeVisible();
    await expect(page.locator('#execution-profile')).toHaveValue('fast-serial');
    await page.locator('#apply').click();
    await expect(page.locator('#execution-disclosure')).toContainText(language.startsWith('en') ? 'not one transaction' : 'keine gemeinsame Transaktion');
    const checkbox = page.getByRole('checkbox', { name: /November 2026/ });
    await expect(checkbox).not.toBeChecked();
    if (language.startsWith('en')) await expect(checkbox).toHaveAccessibleName(/I confirm/);
    await expect(checkbox).toHaveAttribute('required', '');
    await expect(page.locator('#confirm-apply')).toBeDisabled();
    await page.locator('#confirm-apply').dispatchEvent('click');
    expect(await page.evaluate(() => (window as unknown as { __accountFixture: { commands: Array<{ type: string }> } }).__accountFixture.commands.some(command => command.type === 'PANEL_APPLY'))).toBe(false);
    await checkbox.check();
    await expect(page.locator('#confirm-apply')).toBeEnabled();
    await page.locator('#close-apply').click();
    await page.locator('#more-options > summary').click();
    await page.locator('#execution-profile').selectOption('strict');
    await page.locator('#apply').click();
    await expect(page.locator('#apply-execution-mode')).toContainText(language.startsWith('en') ? 'Strict' : 'Streng');
    await expect(page.locator('#execution-disclosure')).toContainText(language.startsWith('en') ? 'each saved day' : 'jeden gespeicherten Tag');
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('#confirm-apply')).toBeDisabled();
    await checkbox.check();
    await page.locator('#confirm-apply').click();
    const requests = await page.evaluate(() => (window as unknown as { __accountFixture: { commands: Array<{ type: string; confirmation?: { planId: string; planRevision: number; contextFingerprint: string; confirmed: boolean } }>; writes: unknown[] } }).__accountFixture);
    const applied = requests.commands.filter(command => command.type === 'PANEL_APPLY');
    expect(applied).toHaveLength(1);
    expect(applied[0].confirmation).toEqual({ planId: plan.id, planRevision: 7, contextFingerprint: expect.any(String), executionFingerprint: JSON.stringify({ checkpointDates: [], executionProfile: 'strict' }), confirmed: true });
    expect(JSON.parse(applied[0].confirmation!.contextFingerprint)).toEqual(snapshot.context);
    expect(requests.writes).toEqual([]);
    expect(destinations.every(url => url.startsWith('http://127.0.0.1:5173/') || url.startsWith('ws://127.0.0.1:5173/'))).toBe(true);
  });
}
