import { expect, test } from '@playwright/test';
import { checks, day, home, tools } from './ui';
import { readFile } from 'node:fs/promises';
import type { BookingPlan, DayPlan, MonthSnapshot, SessionState, Settings } from '../../src/shared/types';

test.use({ viewport: { width: 320, height: 900 } });

for (const language of ['de-DE', 'en-GB']) {
  test(`checkpoint pause keeps the allocation frozen and requires new consent (${language}, local RPC fixture)`, async ({ page }, testInfo) => {
    const settings: Settings = { month: '2026-11', state: 'HE', start: '08:00', end: '16:30', useBreak: true, breakStart: '12:00', breakEnd: '12:30', variable: true, variationMinutes: 15, excludedDates: [], localHolidays: { augsburg: null, assumption: null, corpusChristi: null } };
    const dates = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
    const snapshot: MonthSnapshot = { source: 'hibob', month: settings.month, employeeLabel: 'Local Employee', periodLabel: '2026-11-01–2026-11-30', scannedAt: '2026-11-02T08:00:00Z', context: { mode: 'api-session', connectionId: 'local-session', employeeKey: 'local-employee', tenantKey: 'local-company' }, days: dates.map(date => ({ date, editable: true, entries: [], reportedMinutes: 0, fingerprint: `empty:${date}` })) };
    const days: DayPlan[] = snapshot.days.map(day => { const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay(); const eligible = weekday !== 0 && weekday !== 6; return { date: day.date, existing: [], proposed: eligible ? [{ type: 'work', start: '08:00', end: '12:00' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }] : [], action: eligible ? 'create' : 'skip', fingerprint: day.fingerprint, eligible, netMinutes: eligible ? 480 : 0, existingNetMinutes: 0 }; });
    const plan: BookingPlan = { id: 'checkpoint-month', seed: 123, settings, snapshot, choices: {}, days, errors: [], canReview: true, weeks: ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map(week => { const start = new Date(`${week}T12:00:00Z`).getTime(); const included = days.filter(day => { const instant = new Date(`${day.date}T12:00:00Z`).getTime(); return instant >= start && instant < start + 7 * 86400000; }); const minutes = included.reduce((total, day) => total + (day.netMinutes ?? 0), 0); return { week, dates: included.map(day => day.date), targetMinutes: minutes, plannedMinutes: minutes, errors: [] }; }) };
    const initial: SessionState = { schemaVersion: 6, revision: 1, planRevision: 7, connection: { status: 'connected', generation: 'local-session', employeeId: 'local-employee', companyId: 'local-company', employeeLabel: 'Local Employee', companyLabel: 'Local Company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } }, snapshot, plan };
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const destinations: string[] = []; page.on('request', request => destinations.push(request.url()));
    await page.clock.install({ time: new Date('2026-11-02T08:00:00Z') });
    await page.addInitScript(({ settings, initial, language }) => {
      const state = structuredClone(initial); const commands: Array<Record<string, unknown>> = []; const preferences: unknown[] = []; let checkpoint = 0;
      const result = () => ({ ok: true, state: structuredClone(state) });
      Object.defineProperty(window, '__checkpointFixture', { value: { commands, preferences, state } });
      Object.defineProperty(window, 'chrome', { configurable: true, value: {
        i18n: { getUILanguage: () => language },
        runtime: { id: 'local-checkpoint-fixture', sendMessage: async (command: Record<string, unknown>) => {
          commands.push(command);
          if (command.type === 'PANEL_APPLY' || command.type === 'PANEL_CONTINUE') {
            if (command.type === 'PANEL_CONTINUE' && ((command.confirmation as { checkpointId?: string })?.checkpointId !== state.job?.checkpointId || (command.confirmation as { executionFingerprint?: string })?.executionFingerprint !== state.run?.executionFingerprint)) return { ok: false, state: structuredClone(state), error: 'Stale checkpoint consent' };
            checkpoint++; state.revision!++;
            const now = '2026-11-02T10:00:00Z';
            if (!state.run) state.run = { runId: 'local-run', planId: state.plan!.id, executionProfile: 'strict', executionFingerprint: (command.confirmation as { executionFingerprint: string }).executionFingerprint, status: 'running', startedAt: now, updatedAt: now, results: state.plan!.days.map(day => ({ date: day.date, status: day.eligible ? 'pending' : 'skipped', message: day.eligible ? 'Pending' : 'Skipped' })) };
            const work = state.run.results.filter(day => day.status !== 'skipped');
            if (checkpoint <= 2) {
              work[checkpoint - 1].status = 'verified'; work[checkpoint - 1].message = 'Saved and verified';
              state.run.status = 'paused'; state.run.checkpointDate = work[checkpoint - 1].date;
              state.job = { id: 'local-run', kind: 'apply', status: 'paused', connectionId: 'local-session', checkpointId: `checkpoint-${checkpoint}`, month: '2026-11', startedAt: now, updatedAt: now };
            } else {
              for (const day of work) { day.status = 'verified'; day.message = 'Saved and verified'; }
              state.run.status = 'complete'; state.job = undefined; state.snapshot = undefined; state.plan!.canReview = false;
            }
          }
          return result();
        } },
        storage: { local: { get: async () => ({ settings }), set: async (value: unknown) => { preferences.push(value); } }, onChanged: { addListener: () => {}, removeListener: () => {} } },
      } });
    }, { settings, initial, language });
    await page.goto('/sidepanel.html');
    await expect(page.locator('#apply')).toBeEnabled();
    await tools(page, 'transfer');
    await expect(page.locator('#export-plan-hint')).toBeVisible();
    const firstDownload = page.waitForEvent('download');
    await page.locator('#export-plan').click();
    const firstFile = await firstDownload;
    expect(firstFile.suggestedFilename()).toBe('hibob-booking-plan-2026-11.json');
    const exported = JSON.parse(await readFile((await firstFile.path())!, 'utf8'));
    expect(exported).toMatchObject({ format: 'hibob-attendance-review', version: 1, planRevision: initial.planRevision });
    expect(exported.plan.snapshot.context).toBeUndefined();
    expect(exported.plan.days).toEqual(plan.days);
    expect(exported.plan.days.find((day: { date: string }) => day.date === '2026-11-03').proposed).toHaveLength(3);
    expect(JSON.stringify(exported)).not.toMatch(/local-employee|local-company|local-session|connectionId|employeeKey|tenantKey/);
    const downloadState = await page.evaluate(() => (window as unknown as { __checkpointFixture: { commands: Array<{ type: string }>; preferences: unknown[]; state: SessionState } }).__checkpointFixture);
    expect(downloadState.state.plan).toEqual(plan); expect(downloadState.preferences).toEqual([]);
    expect(downloadState.commands.every(command => command.type === 'PANEL_GET_STATE')).toBe(true);
    await home(page);
    await page.locator('#apply').click();
    expect(await page.locator('#apply-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.locator('#additional-checks')).not.toBeVisible();
    await checks(page);
    await page.locator('#account-confirmation').check();
    await page.locator('#pause-verification').check();
    await expect(page.locator('#account-confirmation')).not.toBeChecked();
    await expect(page.locator('#execution-profile')).toHaveValue('strict');
    await expect(page.locator('#execution-consent-reset')).toContainText(language.startsWith('en') ? 'Checkpoints use strict mode' : 'Kontrollpausen verwenden den strengen Modus');
    await page.locator('#account-confirmation').check();
    await page.locator('#confirm-apply').click();
    await expect(page.locator('#paused-card')).toBeVisible();
    await expect(page.locator('#preview-summary')).toContainText(language.startsWith('en') ? 'included days' : 'berücksichtigte Tage');
    await page.screenshot({ path: testInfo.outputPath(`paused-${language}.png`), fullPage: false });
    await expect(page.locator('#paused-description')).toContainText(language.startsWith('en') ? '20 remaining' : '20 noch offen');
    await expect(page.locator('#continue-run')).toBeFocused();
    await expect(page.locator('#month')).toBeDisabled();
    await expect(page.locator('#settings-toggle')).toBeEnabled();
    await day(page, '2026-11-07');
    await expect(page.locator('#include-2026-11-07')).not.toBeChecked();
    await home(page);
    await expect(page.locator('#apply')).not.toBeVisible();
    await tools(page, 'transfer');
    await expect(page.locator('#export-plan')).toBeEnabled();
    const pausedDownload = page.waitForEvent('download'); await page.locator('#export-plan').click();
    const pausedExport = JSON.parse(await readFile((await (await pausedDownload).path())!, 'utf8'));
    expect(pausedExport.run).toMatchObject({ status: 'paused', checkpointDate: '2026-11-02', planId: plan.id });
    expect(pausedExport.plan.snapshot.context).toBeUndefined(); expect(pausedExport.plan.days).toEqual(plan.days);
    await home(page);
    await page.locator('#continue-run').click();
    await expect(page.locator('#account-confirmation')).not.toBeChecked();
    await expect(page.locator('#confirm-apply')).toBeDisabled();
    await expect(page.locator('#confirm-apply')).toHaveText(language.startsWith('en') ? 'Book 20 remaining days' : '20 restliche Tage buchen');
    expect(await page.locator('#apply-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`resume-${language}.png`), fullPage: false });
    await expect(page.locator('#additional-checks')).not.toBeVisible();
    await page.locator('#close-apply').click();
    await page.locator('#continue-run').click();
    await expect(page.locator('#account-confirmation')).not.toBeChecked();
    await page.locator('#confirm-apply').dispatchEvent('click');
    expect(await page.evaluate(() => (window as unknown as { __checkpointFixture: { commands: Array<{ type: string }> } }).__checkpointFixture.commands.some(command => command.type === 'PANEL_CONTINUE'))).toBe(false);
    await page.locator('#account-confirmation').check();
    await page.locator('#confirm-apply').click();
    await expect(page.locator('#paused-description')).toContainText(language.startsWith('en') ? '19 remaining' : '19 noch offen');
    await page.locator('#continue-run').click();
    await expect(page.locator('#account-confirmation')).not.toBeChecked();
    await page.locator('#account-confirmation').check();
    await page.locator('#confirm-apply').click();
    await expect(page.locator('#run-status')).toContainText(language.startsWith('en') ? '21 of 21' : '21 von 21');
    await expect(page.locator('#scan')).toBeEnabled();
    const evidence = await page.evaluate(() => (window as unknown as { __checkpointFixture: { commands: Array<{ type: string; options?: { checkpointDates: string[] }; confirmation?: { checkpointId?: string }; plan?: unknown }>; preferences: unknown[]; state: SessionState } }).__checkpointFixture);
    const starts = evidence.commands.filter(command => command.type === 'PANEL_APPLY');
    expect(starts).toHaveLength(1); expect(starts[0].options).toEqual({ executionProfile: 'strict', checkpointDates: ['2026-11-02', '2026-11-03'] });
    expect(starts[0].plan).toEqual(plan);
    expect(evidence.commands.filter(command => command.type === 'PANEL_CONTINUE').map(command => command.confirmation?.checkpointId)).toEqual(['checkpoint-1', 'checkpoint-2']);
    expect(evidence.preferences).toEqual([]);
    expect(evidence.state.plan!.seed).toBe(plan.seed);
    expect(evidence.state.plan!.days).toEqual(plan.days);
    expect(destinations.every(url => url.startsWith('http://127.0.0.1:5173/') || url.startsWith('ws://127.0.0.1:5173/') || url.startsWith('blob:http://127.0.0.1:5173/'))).toBe(true);
    expect(errors).toEqual([]);
  });
}
