import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiBobApiAdapter } from '../src/hibob/api-adapter';
import { buildMonthPlan, defaultSettings } from '../src/domain';
import { contextFingerprint } from '../src/shared/context';
import type { ApplyAuthorization, BookingPlan, ConflictChoices, DayPlan } from '../src/shared/types';

const origin = 'https://app.hibob.com';
const dates = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);
const clone = <T>(value: T): T => structuredClone(value);
const isWeekday = (date: string) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const minutes = (value: unknown) => {
  const match = /(?:^|T)(\d{2}):(\d{2})$/.exec(String(value));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Invalid fixture time');
  return Number(match[1]) * 60 + Number(match[2]);
};
type Entry = { id?: string; employeeId?: string; entryType: 'work' | 'break'; start: string; end: string; comment?: string; offset?: number; source?: string; reportingMethod?: string; isManuallyEdited?: boolean; duration?: number };
type Day = { entries: Entry[]; hoursWorked: string; timeOff: unknown; timeOffEntries: unknown; calendarEventsEntry: unknown; holidayOrNonWorkingDay: string; comments: string; entryReasons: string; projects: string; entryStatus: string; alerts: unknown[] };
type Dispatch = { at: number; method: string; path: string; body?: unknown; credentials: RequestCredentials | undefined; signal: AbortSignal | null | undefined };
const workMinutes = (entries: Entry[]) => entries.reduce((sum, entry) => sum + (entry.entryType === 'work' ? minutes(entry.end) - minutes(entry.start) : 0), 0);
const isWrite = (call: Dispatch) => /\/attendance\/entries\?forDate=/.test(call.path);
const category = (call: Dispatch) => isWrite(call) ? 'write' : call.path === '/api/user' ? 'user' : call.path === '/api/company' ? 'company' : call.path.includes('/permissions/') ? 'permission' : call.path.endsWith('/timesheets') ? 'period' : call.path.endsWith('/details') ? 'policy' : 'report';

/** Independent HTTP ledger. Only this fetch stub can answer production requests. */
class HttpLedger {
  readonly calls: Dispatch[] = [];
  readonly user = { id: 'performance-self', companyId: 'performance-company', companyName: 'Performance fixture', displayName: 'Fixture user', timezone: 'Europe/Berlin', mockedRole: false, sessionType: 'employee', state: 'active' };
  readonly company = { id: 'performance-company', name: 'Performance fixture' };
  readonly period = { id: 'november', cycleStartDate: '2026-11-01', cycleEndDate: '2026-11-30', timesheetState: { timeSheetStatus: 'Open', locked: false } };
  readonly policy = { timesheetReportingMethod: 'startEnd', timeFormatterType: 'time', enforceComment: false, allowFutureEntries: true, breakDeductionSettings: { breakDeductionType: 'manual' } };
  readonly days = new Map<string, Day>(dates.map(date => [date, { entries: [], hoursWorked: '0h 00m', timeOff: null, timeOffEntries: null, calendarEventsEntry: null, holidayOrNonWorkingDay: isWeekday(date) ? '' : 'Non working day', comments: '', entryReasons: '', projects: '', entryStatus: isWeekday(date) ? 'NoEntries' : 'WeekendEvent', alerts: [] }]));
  editable = true;
  before?: (call: Dispatch) => void;
  afterWrite?: (date: string) => void;
  writeStatus = 200;
  get writes() { return this.calls.filter(isWrite); }
  set(date: string, entries: Entry[]) {
    const row = this.days.get(date)!;
    row.entries = clone(entries);
    const total = workMinutes(entries);
    row.hoursWorked = `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
    row.entryStatus = entries.length ? 'Completed' : 'NoEntries';
    row.comments = entries.map(entry => entry.comment).filter(Boolean).join('\n');
  }
  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error('Fixture forbids other origins');
    const call: Dispatch = { at: Date.now(), method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`, credentials: init?.credentials, signal: init?.signal, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) };
    this.calls.push(call); this.before?.(call);
    let result: unknown;
    if (call.method === 'GET' && call.path === '/api/user') result = this.user;
    else if (call.method === 'GET' && call.path === '/api/company') result = this.company;
    else if (call.method === 'GET' && call.path === '/api/permissions/authorizations/domains/timeAttendance') result = { permissions: { timeAttendance: this.editable ? [{ resource: 'timeAttendance', filter: 'self', action: 'editSheet' }] : [] } };
    else if (call.method === 'GET' && call.path === '/api/attendance/employees/performance-self/timesheets') result = { employeeTimesheets: [this.period] };
    else if (call.method === 'POST' && call.path === '/api/attendance/employees/performance-self/timesheets/november/details' && JSON.stringify(call.body) === '{"fields":["policyDetails"]}') result = { policyDetails: this.policy };
    else if (call.method === 'POST' && call.path === '/api/company/views/search?idsOnly=false') {
      const request = call.body as Record<string, unknown>;
      if (request.employeeId !== 'performance-self' || request.timesheetId !== 'november' || request.type !== 'time_attendance_employee_timesheet') throw new Error('Unexpected report scope');
      result = { employees: dates.map(dateKey => ({ dateKey, isSummary: false, rowId: `irrelevant-${dateKey}`, time_attendance_employee_timesheet: this.days.get(dateKey) })) };
    } else if (call.method === 'POST' && /^\/api\/attendance\/employees\/performance-self\/attendance\/entries\?forDate=2026-11-\d{2}$/.test(call.path)) {
      if (this.writeStatus !== 200) return new Response('{}', { status: this.writeStatus, headers: { 'content-type': 'application/json' } });
      const date = url.searchParams.get('forDate')!;
      const payload = call.body as Entry[];
      this.set(date, payload.map((entry, index) => ({ id: entry.id ?? `persisted-${date}-${index}`, employeeId: 'performance-self', entryType: entry.entryType, start: entry.start, end: entry.end, comment: entry.comment ?? '', source: 'employeeManuallyEdit', reportingMethod: 'startEnd', isManuallyEdited: true, duration: (minutes(entry.end) - minutes(entry.start)) * 60 })));
      this.afterWrite?.(date);
      // No attendance data in the acknowledgement: only the later report proves it.
      result = { acknowledged: true };
    } else throw new Error(`Unexpected fixture endpoint: ${call.method} ${call.path}`);
    return new Response(JSON.stringify(clone(result)), { headers: { 'content-type': 'application/json' } });
  });
}

/** Drive only the fake clock; the real SessionClient keeps its default 1 s pace. */
async function finish<T>(operation: Promise<T>): Promise<T> {
  let settled = false;
  const observed = operation.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let tick = 0; !settled && tick < 1000; tick++) await vi.advanceTimersByTimeAsync(1000);
  if (!settled) throw new Error('Fixture operation did not settle');
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}
function authorization(plan: BookingPlan): ApplyAuthorization {
  const common = { planId: plan.id, planRevision: 1, contextFingerprint: contextFingerprint(plan.snapshot.context) };
  return { ...common, confirmation: { ...common, confirmed: true } };
}
async function app(server = new HttpLedger(), choices: ConflictChoices = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));
  vi.stubGlobal('fetch', server.fetch);
  // Direct-mode success must never open or inject into a real browser page.
  const unexpected = vi.fn(() => { throw new Error('Native browser use is forbidden in this test'); });
  vi.stubGlobal('chrome', { tabs: { create: unexpected, get: unexpected, remove: unexpected }, windows: { create: unexpected, get: unexpected }, scripting: { executeScript: unexpected } });
  const adapter = new HiBobApiAdapter();
  const connection = await finish(adapter.connect());
  const snapshot = await finish(adapter.scanMonth(connection, '2026-11'));
  const settings = { ...defaultSettings('2026-11'), variable: true, variationMinutes: 15, excludedDates: [] };
  const plan = buildMonthPlan(settings, snapshot, choices, 73191);
  expect(plan.canReview).toBe(true);
  server.calls.length = 0;
  // Separate setup traffic from the measured run while preserving client pacing.
  vi.setSystemTime(Date.now() + 1000);
  const run = async (selected: DayPlan[] = plan.days.filter(day => ['create', 'overwrite'].includes(day.action)), signal?: AbortSignal) => {
    const actual = [];
    for (const day of selected) actual.push(await adapter.applyDay(connection, day, snapshot.context, authorization(plan), undefined, signal));
    return actual;
  };
  return { server, adapter, connection, snapshot, plan, run, unexpected };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('production API transport request budget and unchanged safety checks', () => {
  it('dispatches 14 real HTTP calls for a day, with one fresh prewrite report and a separate fresh readback', async () => {
    const a = await app();
    const day = a.plan.days.find(item => item.date === '2026-11-03')!;
    const [actual] = await finish(a.run([day]));
    expect(a.server.calls.map(category)).toEqual(['user', 'company', 'period', 'policy', 'report', 'permission', 'user', 'company', 'write', 'user', 'company', 'period', 'policy', 'report']);
    expect(a.server.calls).toHaveLength(14);
    expect(a.server.writes).toHaveLength(1);
    expect(a.server.writes[0].body).toEqual(day.proposed.map(entry => ({ start: `${day.date}T${entry.start}`, end: `${day.date}T${entry.end}`, entryType: entry.type, comment: '', offset: -60 })));
    expect(actual.entries).toEqual(day.proposed);
    expect(actual.reportedMinutes).toBe(workMinutes(a.server.days.get(day.date)!.entries));
    expect(a.server.calls.every(call => call.credentials === 'include')).toBe(true);
    expect(a.unexpected).not.toHaveBeenCalled();
  });

  it('books 21 fixture weekdays in 294 dispatches, preserving 63 segments and 168 h, with a 293 s pacing floor', async () => {
    const a = await app();
    const actual = await finish(a.run());
    expect(actual).toHaveLength(21);
    expect(a.server.calls).toHaveLength(294);
    expect(a.server.writes).toHaveLength(21);
    expect(new Set(a.server.writes.map(call => call.path)).size).toBe(21);
    const persisted = [...a.server.days.values()].flatMap(day => day.entries);
    expect(persisted).toHaveLength(63);
    expect(workMinutes(persisted)).toBe(168 * 60);
    expect(new Set(a.server.writes.map(call => workMinutes(call.body as Entry[]))).size).toBeGreaterThan(1);
    expect(a.server.writes.every(call => isWeekday(call.path.slice(-10)))).toBe(true);
    expect(a.server.calls.at(-1)!.at - a.server.calls[0].at).toBe(293_000);
    expect(a.server.calls.slice(1).every((call, index) => call.at - a.server.calls[index].at >= 1000)).toBe(true);
    expect(a.server.calls.filter(call => category(call) === 'report')).toHaveLength(42);
    expect(a.server.calls.filter(call => category(call) === 'permission')).toHaveLength(21);
    expect(a.unexpected).not.toHaveBeenCalled();
  });

  it('preserves entry IDs and removes a reviewed note in one authorized overwrite', async () => {
    const server = new HttpLedger();
    server.set('2026-11-03', [
      { id: 'kept-work-a', employeeId: server.user.id, entryType: 'work', start: '2026-11-03T08:00', end: '2026-11-03T12:00', comment: 'Private fixture note' },
      { id: 'kept-break', employeeId: server.user.id, entryType: 'break', start: '2026-11-03T12:00', end: '2026-11-03T12:30' },
      { id: 'kept-work-b', employeeId: server.user.id, entryType: 'work', start: '2026-11-03T12:30', end: '2026-11-03T16:30' },
    ]);
    const a = await app(server, { '2026-11-03': 'overwrite' });
    const day = a.plan.days.find(item => item.date === '2026-11-03')!;
    expect(day.action).toBe('overwrite'); expect(day.existing[0].note).toBe('Private fixture note');
    const [actual] = await finish(a.run([day]));
    expect(a.server.writes).toHaveLength(1); expect(a.server.calls).toHaveLength(14);
    expect((a.server.writes[0].body as Entry[]).map(entry => entry.id)).toEqual(['kept-work-a', 'kept-break', 'kept-work-b']);
    expect((a.server.writes[0].body as Entry[]).every(entry => entry.comment === '')).toBe(true);
    expect(actual.entries).toEqual(day.proposed);
  });

  it.each(['permission', 'policy', 'ownership', 'identity'] as const)('stops before writing when fresh %s evidence changes', async failure => {
    const a = await app();
    if (failure === 'permission') a.server.editable = false;
    if (failure === 'policy') a.server.policy.enforceComment = true;
    if (failure === 'ownership') a.server.set('2026-11-03', [{ id: 'foreign-entry', employeeId: 'other-person', entryType: 'work', start: '2026-11-03T08:00', end: '2026-11-03T12:00' }]);
    if (failure === 'identity') {
      let users = 0;
      a.server.before = call => { if (call.path === '/api/user' && ++users === 2) a.server.user.id = 'other-person'; };
    }
    await expect(finish(a.run())).rejects.toMatchObject({ uncertain: false });
    expect(a.server.writes).toHaveLength(0);
    expect(a.unexpected).not.toHaveBeenCalled();
  });

  it.each(['time', 'ownership'] as const)('stops after mismatching %s readback, without retrying or advancing to another day', async failure => {
    const a = await app();
    a.server.afterWrite = date => {
      const entries = a.server.days.get(date)!.entries;
      if (failure === 'time') { entries[0].end = `${date}T11:59`; entries[0].duration = (minutes(entries[0].end) - minutes(entries[0].start)) * 60; a.server.set(date, entries); }
      else entries[0].employeeId = 'other-person';
    };
    await expect(finish(a.run())).rejects.toMatchObject({ uncertain: true });
    expect(a.server.writes).toHaveLength(1);
    expect(a.server.writes[0].path).toContain('forDate=2026-11-02');
    expect(a.server.calls.filter(call => category(call) === 'report')).toHaveLength(2);
  });

  it('does not retry a rejected mutation or attempt later days', async () => {
    const a = await app(); a.server.writeStatus = 500;
    await expect(finish(a.run())).rejects.toMatchObject({ uncertain: true });
    expect(a.server.writes).toHaveLength(1);
    expect(a.server.calls.filter(call => category(call) === 'report')).toHaveLength(1);
  });

  it.each(['after-probe', 'partial-probe'] as const)('rechecks the account after a failed %s opening without retaining earlier identity evidence', async failure => {
    const a = await app();
    if (failure === 'partial-probe') a.server.company.id = 'contradictory-company';
    await expect(finish(a.adapter.scanMonth(a.connection, failure === 'after-probe' ? 'invalid-month' : '2026-11'))).rejects.toMatchObject({ uncertain: false });
    expect(a.server.writes).toHaveLength(0);
    a.server.company.id = 'performance-company';
    a.server.user.id = 'replacement-person';
    a.server.calls.length = 0;
    await expect(finish(a.run())).rejects.toMatchObject({ uncertain: false, connectionStatus: 'expired' });
    expect(a.server.calls.map(category)).toEqual(['user', 'company']);
    expect(a.server.writes).toHaveLength(0);
    // Explicitly starting another operation with the original account must still
    // obtain both fresh probe responses, rather than reuse either failed opening.
    a.server.user.id = 'performance-self';
    a.server.calls.length = 0;
    const day = a.plan.days.find(item => item.date === '2026-11-03')!;
    await finish(a.run([day]));
    expect(a.server.calls).toHaveLength(14);
    expect(a.server.calls.slice(0, 2).map(category)).toEqual(['user', 'company']);
    expect(a.server.writes).toHaveLength(1);
    expect(a.unexpected).not.toHaveBeenCalled();
  });

  it('honors cancellation before dispatching the mutation', async () => {
    const a = await app(); const cancellation = new AbortController();
    a.server.before = call => { if (category(call) === 'permission') cancellation.abort(); };
    await expect(finish(a.run(undefined, cancellation.signal))).rejects.toMatchObject({ uncertain: false });
    expect(a.server.writes).toHaveLength(0);
    expect([...a.server.days.values()].every(day => !day.entries.length)).toBe(true);
  });

  it('finishes independent readback after cancellation following an acknowledged write, then stops later days', async () => {
    const a = await app(); const cancellation = new AbortController();
    // Cancel during the independent post-ack report; it must finish verification,
    // while the next day must not start with the already cancelled caller signal.
    a.server.before = call => { if (category(call) === 'report' && a.server.writes.length) cancellation.abort(); };
    const verified: string[] = [];
    const operation = (async () => {
      for (const day of a.plan.days.filter(item => item.action === 'create')) {
        await a.adapter.applyDay(a.connection, day, a.snapshot.context, authorization(a.plan), undefined, cancellation.signal);
        verified.push(day.date);
      }
    })();
    await expect(finish(operation)).rejects.toMatchObject({ uncertain: false });
    expect(verified).toEqual(['2026-11-02']);
    expect(a.server.writes).toHaveLength(1);
    expect(a.server.calls.filter(call => category(call) === 'report')).toHaveLength(2);
  });
});
