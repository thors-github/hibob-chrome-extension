import { describe, expect, it } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings } from '../src/domain';
import { HiBobApiAdapter } from '../src/hibob/api-adapter';
import { SessionClientError, type ApiHttpRequest, type SessionConnection } from '../src/hibob/session-client';
import { contextFingerprint } from '../src/shared/context';
import type { AccountConfirmation, AttendanceEntry, BookingPlan, SessionState } from '../src/shared/types';

const copy = <T>(value: T): T => structuredClone(value);
const days = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
const weekday = (date: string) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const minute = (time: string): number => {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Invalid fixture wall clock: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
};
const local = (raw: unknown) => String(raw).slice(-5);
const workMinutes = (entries: Array<{ entryType: unknown; start: unknown; end: unknown }>) => entries.reduce((sum, entry) => sum + (entry.entryType === 'work' ? minute(local(entry.end)) - minute(local(entry.start)) : 0), 0);
const weekStart = (date: string) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
};
type RowEntry = { id?: string; employeeId?: string; entryType: 'work' | 'break'; start: string; end: string; comment?: string; offset?: number; duration?: number; reason?: null; projectTracking?: null; isManuallyEdited?: boolean; reportingMethod?: 'startEnd'; source?: 'employeeManuallyEdit' };
type DayData = { entries: RowEntry[]; hoursWorked: string; timeOff: unknown; timeOffEntries: unknown; calendarEventsEntry: unknown; holidayOrNonWorkingDay: string; comments: string; entryReasons: string; projects: string; entryStatus: string; alerts: unknown[] };

/** Only a fixture. No fetch implementation or browser session is provided. */
class LedgerApi {
  readonly requests: ApiHttpRequest[] = [];
  readonly user = { id: 'independent-fixture', companyId: 55, companyName: 'Ledger company', displayName: 'Ledger employee', timezone: 'Europe/Berlin', mockedRole: false, sessionType: 'employee', state: 'active' };
  readonly company = { name: 'Ledger company' };
  readonly period = { id: 0, cycleStartDate: '2026-11-01', cycleEndDate: '2026-11-30', timesheetState: { timeSheetStatus: 'Open', locked: false } };
  readonly policy = { timesheetReportingMethod: 'startEnd', timeFormatterType: 'time', enforceComment: false, allowFutureEntries: true, breakDeductionSettings: { breakDeductionType: 'manual' } };
  editable = true;
  readonly ledger = new Map<string, DayData>(days.map(date => [date, { entries: [], hoursWorked: '0h 00m', timeOff: null, timeOffEntries: null, calendarEventsEntry: null, holidayOrNonWorkingDay: weekday(date) ? '' : 'Non working day', comments: '', entryReasons: '', projects: '', entryStatus: weekday(date) ? 'NoEntries' : 'WeekendEvent', alerts: [] }]));
  before?: (request: ApiHttpRequest) => void;
  get writes() { return this.requests.filter(request => request.path.includes('/attendance/entries?')); }
  set(date: string, entries: RowEntry[]) {
    const record = this.ledger.get(date)!;
    const total = workMinutes(entries);
    record.entries = copy(entries); record.hoursWorked = `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`; record.entryStatus = entries.length ? 'Completed' : 'NoEntries';
  }
  async connect(): Promise<SessionConnection> { return { mode: 'direct', id: 'fixture-transport' }; }
  async openOperation(): Promise<SessionConnection> { return { mode: 'direct', id: 'fixture-transport' }; }
  async closeOperation() {}
  async disconnect() {}
  cancel() {}
  async request<T = unknown>(request: ApiHttpRequest): Promise<T> {
    this.requests.push(copy(request)); this.before?.(request);
    let answer: unknown;
    if (request.method === 'GET' && request.path === '/api/user') answer = this.user;
    else if (request.method === 'GET' && request.path === '/api/company') answer = this.company;
    else if (request.method === 'GET' && request.path === '/api/permissions/authorizations/domains/timeAttendance') answer = { permissions: { timeAttendance: this.editable ? [{ resource: 'timeAttendance', filter: 'self', action: 'editSheet' }] : [] } };
    else if (request.method === 'GET' && request.path.endsWith('/timesheets')) answer = { employeeTimesheets: [this.period] };
    else if (request.method === 'POST' && request.path.endsWith('/details') && JSON.stringify(request.body) === '{"fields":["policyDetails"]}') answer = { policyDetails: this.policy };
    else if (request.method === 'POST' && request.path === '/api/company/views/search?idsOnly=false') {
      expect((request.body as Record<string, unknown>).employeeId).toBe(this.user.id);
      answer = { employees: days.map(date => ({ isSummary: false, dateKey: date, rowId: crypto.randomUUID(), time_attendance_employee_timesheet: this.ledger.get(date) })) };
    } else if (request.method === 'POST' && /^\/api\/attendance\/employees\/independent-fixture\/attendance\/entries\?forDate=2026-11-\d{2}$/.test(request.path)) {
      const date = request.path.slice(-10);
      const entries = request.body as RowEntry[];
      expect(weekday(date)).toBe(true);
      expect(entries).toHaveLength(3);
      // Real native report DTO: the posted offset is not returned, while ownership,
      // provenance and exact duration seconds are supplied by HiBob.
      this.set(date, entries.map(({ offset: _offset, ...entry }, index) => ({ ...entry, id: entry.id ?? `fixture-${date}-${index}`, employeeId: this.user.id, duration: (minute(local(entry.end)) - minute(local(entry.start))) * 60, reason: null, isManuallyEdited: true, projectTracking: null, reportingMethod: 'startEnd', source: 'employeeManuallyEdit' })));
      // The response intentionally contains no entries or duration evidence.
      answer = { acknowledged: true };
    } else throw new Error(`Forbidden fixture operation: ${request.method} ${request.path}`);
    return copy(answer) as T;
  }
}

function consent(plan: BookingPlan, revision: number, checkpointId?: string): AccountConfirmation {
  return { planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmed: true, ...(checkpointId ? { checkpointId } : {}) };
}
async function app(retainFirstDay = false) {
  const server = new LedgerApi();
  if (retainFirstDay) server.set('2026-11-02', [
    { id: 'retained-first-work', employeeId: server.user.id, entryType: 'work', start: '2026-11-02T08:00', end: '2026-11-02T12:00', comment: 'Keep this fixture note', duration: 14_400, reason: null, isManuallyEdited: true, projectTracking: null, reportingMethod: 'startEnd', source: 'employeeManuallyEdit' },
    { id: 'retained-first-break', employeeId: server.user.id, entryType: 'break', start: '2026-11-02T12:00', end: '2026-11-02T12:30', comment: '', duration: 1_800, reason: null, isManuallyEdited: true, projectTracking: null, reportingMethod: 'startEnd', source: 'employeeManuallyEdit' },
    { id: 'retained-last-work', employeeId: server.user.id, entryType: 'work', start: '2026-11-02T12:30', end: '2026-11-02T16:30', comment: '', duration: 14_400, reason: null, isManuallyEdited: true, projectTracking: null, reportingMethod: 'startEnd', source: 'employeeManuallyEdit' },
  ]);
  const adapter = new HiBobApiAdapter({ client: server, now: () => new Date('2026-11-02T18:00:00Z') });
  let stored: SessionState | undefined;
  const bridge: ControllerBridge = {
    load: async () => copy(stored), save: async state => { stored = copy(state); },
    connect: () => adapter.connect(), disconnect: () => adapter.disconnect(),
    scan: (connection, month) => adapter.scanMonth(connection, month),
    applyDay: (connection, day, context, _job, authorization) => adapter.applyDay(connection, day, context, authorization),
    preflightDay: (connection, day, context, _job, authorization) => adapter.preflightDay(connection, day, context, authorization),
    cancel: async () => { adapter.cancel(); },
  };
  const controller = new BookingController(bridge);
  await controller.init(); await controller.connect(); await controller.scan('2026-11');
  const settings = { ...defaultSettings('2026-11'), variable: true, variationMinutes: 15, excludedDates: [] };
  const generated = buildMonthPlan(settings, controller.state.snapshot!, retainFirstDay ? { '2026-11-02': 'skip' } : {}, 98273);
  const lease = await controller.invalidatePlan(controller.state.planRevision!, 'independent-review');
  await controller.savePlan(generated, lease.editLease!);
  const plan = copy(controller.state.plan!); const revision = controller.state.planRevision!;
  server.requests.length = 0;
  return { server, adapter, bridge, controller, plan, revision, stored: () => copy(stored) };
}
const start = (a: Awaited<ReturnType<typeof app>>) => a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision), { checkpointDates: ['2026-11-02', '2026-11-03'] });
const resume = (a: Awaited<ReturnType<typeof app>>) => a.controller.continueRun(a.controller.state.job!.id, a.plan.id, a.revision, consent(a.plan, a.revision, a.controller.state.job!.checkpointId));
function expectedPayload(date: string, entries: AttendanceEntry[]) { return entries.map(entry => ({ start: `${date}T${entry.start}`, end: `${date}T${entry.end}`, entryType: entry.type, comment: entry.note ?? '', offset: -60 })); }

describe('independent full-month API checkpoint integration', () => {
  it('keeps the original variable allocation through both checkpoints and saves every approved weekday exactly once', async () => {
    const a = await app(); const original = copy(a.plan);
    expect(original.days.filter(day => day.action === 'create')).toHaveLength(21);
    const durations = new Set<number>();
    for (const day of original.days.filter(day => day.action === 'create')) {
      expect(day.proposed.map(entry => entry.type)).toEqual(['work', 'break', 'work']);
      expect(minute(day.proposed[0].start)).toBeGreaterThanOrEqual(465); expect(minute(day.proposed[0].start)).toBeLessThanOrEqual(495);
      expect(minute(day.proposed[2].end)).toBeGreaterThanOrEqual(975); expect(minute(day.proposed[2].end)).toBeLessThanOrEqual(1005);
      expect(day.proposed[0].end).toBe('12:00'); expect(day.proposed[1]).toMatchObject({ start: '12:00', end: '12:30' }); expect(day.proposed[2].start).toBe('12:30');
      durations.add(minute(day.proposed[0].end) - minute(day.proposed[0].start) + minute(day.proposed[2].end) - minute(day.proposed[2].start));
    }
    expect(durations.size).toBeGreaterThan(1);
    const first = await start(a);
    expect(first.run?.status).toBe('paused'); expect(first.run?.checkpointDate).toBe('2026-11-02'); expect(first.plan).toEqual(original); expect(a.server.writes).toHaveLength(1);
    const firstJob = first.job!.id;
    await expect(a.controller.continueRun(firstJob, original.id, a.revision)).rejects.toThrow(); expect(a.server.writes).toHaveLength(1);
    const second = await resume(a);
    expect(second.run?.status).toBe('paused'); expect(second.run?.checkpointDate).toBe('2026-11-03'); expect(second.plan).toEqual(original); expect(a.server.writes).toHaveLength(2);
    const finished = await resume(a);
    expect(finished.run?.status).toBe('complete'); expect(finished.run?.results.filter(result => result.status === 'verified')).toHaveLength(21);
    expect(a.server.writes).toHaveLength(21); expect(new Set(a.server.writes.map(request => request.path)).size).toBe(21);
    const actualWeeks = new Map<string, number>();
    for (const date of days) {
      const saved = a.server.ledger.get(date)!;
      if (!weekday(date)) { expect(saved.entries).toEqual([]); continue; }
      const expected = original.days.find(day => day.date === date)!;
      const submitted = a.server.writes.find(request => request.path.endsWith(date))!;
      expect(submitted.body).toEqual(expectedPayload(date, expected.proposed));
      expect(saved.entries.map(entry => ({ start: entry.start, end: entry.end, entryType: entry.entryType, comment: entry.comment }))).toEqual(expected.proposed.map(entry => ({ start: `${date}T${entry.start}`, end: `${date}T${entry.end}`, entryType: entry.type, comment: entry.note ?? '' })));
      for (const entry of saved.entries) {
        expect(entry).toMatchObject({ employeeId: a.server.user.id, source: 'employeeManuallyEdit', isManuallyEdited: true, reportingMethod: 'startEnd', reason: null, projectTracking: null });
        expect(entry.duration).toBe((minute(local(entry.end)) - minute(local(entry.start))) * 60);
        expect(entry.offset).toBeUndefined();
      }
      actualWeeks.set(weekStart(date), (actualWeeks.get(weekStart(date)) ?? 0) + workMinutes(saved.entries));
      const writeIndex = a.server.requests.indexOf(submitted);
      expect(a.server.requests.slice(writeIndex + 1).some(request => request.path === '/api/company/views/search?idsOnly=false')).toBe(true);
    }
    expect([...actualWeeks.values()]).toEqual([2400, 2400, 2400, 2400, 480]); expect([...actualWeeks.values()].reduce((a, b) => a + b, 0)).toBe(168 * 60);
    expect(a.server.requests.some(request => /submit|delete/i.test(request.path) || request.method === 'DELETE')).toBe(false);
    expect(a.plan).toEqual(original);
  });

  it.each(['last-pending-day', 'verified-day', 'account', 'permission', 'policy', 'lock'] as const)('refuses continuation after a changed %s without another attendance request', async change => {
    const a = await app(); await start(a); const approvedFirst = copy(a.server.ledger.get('2026-11-02'));
    if (change === 'last-pending-day') a.server.set('2026-11-30', [{ id: 'concurrent-user-entry', entryType: 'work', start: '2026-11-30T08:00', end: '2026-11-30T09:00' }]);
    if (change === 'verified-day') { const entries = copy(a.server.ledger.get('2026-11-02')!.entries); entries[0].start = '2026-11-02T07:00'; entries[0].duration = (minute(local(entries[0].end)) - 420) * 60; a.server.set('2026-11-02', entries); }
    if (change === 'account') a.server.user.id = 'another-employee';
    if (change === 'permission') a.server.editable = false;
    if (change === 'policy') a.server.policy.enforceComment = true;
    if (change === 'lock') a.server.period.timesheetState.locked = true;
    try { await resume(a); } catch { /* Both a rejected continuation and a stopped run must fail closed. */ }
    expect(a.server.writes).toHaveLength(1);
    expect(a.controller.state.run?.status).not.toBe('complete');
    expect(a.server.ledger.get('2026-11-03')!.entries).toEqual([]);
    if (change !== 'verified-day') expect(a.server.ledger.get('2026-11-02')).toEqual(approvedFirst);
  });

  it.each(['unchanged', 'hours', 'note'] as const)('reconciles retained existing hours and notes before continuing (change=%s)', async change => {
    const a = await app(true); const retained = copy(a.server.ledger.get('2026-11-02'));
    expect(a.plan.days.find(day => day.date === '2026-11-02')).toMatchObject({ action: 'skip', eligible: true, netMinutes: 480 });
    await a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision), { checkpointDates: ['2026-11-03'] });
    expect(a.controller.state.run?.status).toBe('paused'); expect(a.server.writes).toHaveLength(1);
    if (change !== 'unchanged') {
      const entries = copy(a.server.ledger.get('2026-11-02')!.entries);
      if (change === 'hours') { entries[0].start = '2026-11-02T07:59'; entries[0].duration = 14_460; }
      else entries[0].comment = 'A concurrent edit changed the retained fixture note';
      a.server.set('2026-11-02', entries);
      try { await resume(a); } catch { /* A failed reconciliation must never continue writes. */ }
      expect(a.server.writes).toHaveLength(1); expect(a.controller.state.run?.status).not.toBe('complete');
      expect(a.server.ledger.get('2026-11-04')!.entries).toEqual([]);
    } else {
      const finished = await resume(a);
      expect(finished.run?.status).toBe('complete'); expect(a.server.writes).toHaveLength(20);
      expect(a.server.writes.some(request => request.path.endsWith('2026-11-02'))).toBe(false);
      expect(a.server.ledger.get('2026-11-02')).toEqual(retained);
      expect([...a.server.ledger.values()].reduce((total, day) => total + workMinutes(day.entries), 0)).toBe(168 * 60);
    }
  });

  it('rejects old job, plan and revision tokens before any continuation write', async () => {
    const a = await app(); await start(a); const job = a.controller.state.job!.id;
    for (const [jobId, planId, rev] of [['other-job', a.plan.id, a.revision], [job, 'other-plan', a.revision], [job, a.plan.id, a.revision - 1]] as const) {
      await expect(a.controller.continueRun(jobId, planId, rev, consent(a.plan, a.revision, a.controller.state.job!.checkpointId))).rejects.toThrow();
      expect(a.server.writes).toHaveLength(1);
    }
  });

  it('requires the current pause nonce and rejects initial or earlier-pause consent without another mutation', async () => {
    const a = await app(); const initialConsent = consent(a.plan, a.revision); await start(a);
    const first = copy(a.controller.state.job!); const firstConsent = consent(a.plan, a.revision, first.checkpointId);
    expect(first.checkpointId).toEqual(expect.any(String));
    await expect(a.controller.continueRun(first.id, a.plan.id, a.revision, initialConsent)).rejects.toThrow();
    expect(a.server.writes).toHaveLength(1);
    await resume(a); const second = copy(a.controller.state.job!);
    expect(second.checkpointId).not.toBe(first.checkpointId);
    await expect(a.controller.continueRun(second.id, a.plan.id, a.revision, firstConsent)).rejects.toThrow();
    expect(a.server.writes).toHaveLength(2); expect(a.controller.state.run?.status).toBe('paused');
  });

  it('never resumes a persisted paused job after a worker restart', async () => {
    const a = await app(); await start(a); const job = a.controller.state.job!.id;
    const validAtPause = consent(a.plan, a.revision, a.controller.state.job!.checkpointId);
    const restarted = new BookingController({ ...a.bridge, load: async () => a.stored() }); await restarted.init();
    await expect(restarted.continueRun(job, a.plan.id, a.revision, validAtPause)).rejects.toThrow();
    expect(a.server.writes).toHaveLength(1); expect(restarted.state.run?.status).not.toBe('complete');
  });

  it('never retries an accepted write when its independent readback hits a five-minute rate limit', async () => {
    const a = await app(); const day = a.plan.days.find(item => item.date === '2026-11-02')!;
    const confirmation = consent(a.plan, a.revision);
    a.server.before = request => {
      if (a.server.writes.length && request.method === 'GET' && request.path === '/api/user') throw new SessionClientError('RATE_LIMITED', false, 429, 300_000);
    };
    const writing = a.adapter.applyDay(a.controller.state.connection!, day, a.plan.snapshot.context, { planId: a.plan.id, planRevision: a.revision, contextFingerprint: confirmation.contextFingerprint, confirmation });
    await expect(writing).rejects.toMatchObject({ uncertain: true, message: expect.stringContaining('300') });
    expect(a.server.writes).toHaveLength(1);
    expect(a.server.ledger.get('2026-11-02')!.entries).toHaveLength(3);
    expect(a.server.ledger.get('2026-11-03')!.entries).toEqual([]);
    const afterWrite = a.server.requests.slice(a.server.requests.findIndex(request => request.path.includes('/attendance/entries?')) + 1);
    expect(afterWrite.filter(request => request.path === '/api/user')).toHaveLength(1);
    expect(afterWrite.some(request => request.path.includes('/attendance/entries?'))).toBe(false);
  });

  it('stops a paused run without deleting its confirmed day or writing the next day', async () => {
    const a = await app(); await start(a); const storedDay = copy(a.server.ledger.get('2026-11-02'));
    await a.controller.cancel(a.controller.state.job!.id);
    expect(a.controller.state.run?.status).toBe('stopped'); expect(a.controller.state.snapshot).toBeUndefined(); expect(a.controller.state.job?.status).not.toBe('paused');
    expect(a.server.writes).toHaveLength(1); expect(a.server.ledger.get('2026-11-02')).toEqual(storedDay); expect(a.server.ledger.get('2026-11-03')!.entries).toEqual([]);
    expect(a.controller.state.run?.results.find(result => result.date === '2026-11-02')?.status).toBe('verified');
  });
});
