import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiBobApiAdapter } from '../src/hibob/api-adapter';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain';
import { contextFingerprint, executionFingerprint } from '../src/shared/context';
import type { ApplyAuthorization, BookingPlan, ConflictChoices, MonthApplyHooks, SessionState } from '../src/shared/types';

const month = '2026-11';
const target = '2026-11-03';
const clone = <T>(value: T): T => structuredClone(value);
const weekdays = (date: string) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const minute = (value: string) => Number(value.slice(-5, -3)) * 60 + Number(value.slice(-2));
const pause = (duration: number) => new Promise<void>(resolve => { setTimeout(resolve, duration); });
type Entry = { id?: string; employeeId?: string; entryType: 'work' | 'break'; start: string; end: string; comment?: string; source?: string; duration?: number; reportingMethod?: string; isManuallyEdited?: boolean; [key: string]: unknown };
type Row = { entries: Entry[]; hoursWorked: string; timeOff: unknown; timeOffEntries: unknown; calendarEventsEntry: unknown; holidayOrNonWorkingDay: string; comments: string; entryReasons: string; projects: string; entryStatus: string; alerts: unknown[] };
type Call = { path: string; method: string; body?: unknown; at: number; signal?: AbortSignal | null };
const writes = (call: Call) => call.path.includes('/attendance/entries?forDate=');
const report = (call: Call) => call.path === '/api/company/views/search?idsOnly=false';
const net = (entries: Entry[]) => entries.filter(entry => entry.entryType === 'work').reduce((total, entry) => total + minute(entry.end) - minute(entry.start), 0);

/** A separate persisted server model: acknowledgements contain no saved entries. */
class MonthServer {
  readonly user = { id: 'fast-self', companyId: 'fast-company', companyName: 'Fixture company', displayName: 'Fixture employee', timezone: 'Europe/Berlin', mockedRole: false, sessionType: 'employee', state: 'active' };
  readonly company = { id: 'fast-company', name: 'Fixture company' };
  readonly period = { id: 'november', cycleStartDate: '2026-11-01', cycleEndDate: '2026-11-30', timesheetState: { timeSheetStatus: 'Open', locked: false } };
  readonly policy = { timesheetReportingMethod: 'startEnd', timeFormatterType: 'time', enforceComment: false, allowFutureEntries: true, breakDeductionSettings: { breakDeductionType: 'manual' } };
  readonly rows = new Map<string, Row>(getMonthDates(month).map(date => [date, { entries: [], hoursWorked: '0h 00m', timeOff: null, timeOffEntries: null, calendarEventsEntry: null, holidayOrNonWorkingDay: weekdays(date) ? '' : 'Non working day', comments: '', entryReasons: '', projects: '', entryStatus: weekdays(date) ? 'NoEntries' : 'WeekendEvent', alerts: [] }]));
  readonly calls: Call[] = [];
  latencyMs = 100;
  editable = true;
  concurrentWrites = 0;
  maxConcurrentWrites = 0;
  before?: (call: Call) => void;
  afterWrite?: (date: string, ordinal: number) => void;
  failure?: { ordinal: number; status?: number; accept?: boolean; network?: boolean };
  get mutations() { return this.calls.filter(writes); }
  set(date: string, entries: Entry[]) {
    const row = this.rows.get(date)!;
    row.entries = clone(entries);
    const total = net(entries);
    row.hoursWorked = `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
    row.entryStatus = entries.length ? 'Completed' : 'NoEntries';
    row.comments = entries.map(entry => entry.comment).filter(Boolean).join('\n');
  }
  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== 'https://app.hibob.com') throw new Error('Other origins are forbidden');
    const call: Call = { path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', at: Date.now(), signal: init?.signal, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) };
    this.calls.push(call);
    const write = writes(call);
    if (write) { this.concurrentWrites++; this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.concurrentWrites); }
    this.before?.(call);
    try {
      await pause(this.latencyMs);
      if (call.signal?.aborted) throw new DOMException('Aborted fixture request', 'AbortError');
      let value: unknown;
      if (call.path === '/api/user') value = this.user;
      else if (call.path === '/api/company') value = this.company;
      else if (call.path === '/api/permissions/authorizations/domains/timeAttendance') value = { permissions: { timeAttendance: this.editable ? [{ resource: 'timeAttendance', filter: 'self', action: 'editSheet' }] : [] } };
      else if (call.path === '/api/attendance/employees/fast-self/timesheets') value = { employeeTimesheets: [this.period] };
      else if (call.path === '/api/attendance/employees/fast-self/timesheets/november/details') {
        if (call.method !== 'POST' || JSON.stringify(call.body) !== '{"fields":["policyDetails"]}') throw new Error('Unexpected policy contract');
        value = { policyDetails: this.policy };
      } else if (report(call)) {
        const request = call.body as Record<string, unknown>;
        if (request.employeeId !== 'fast-self' || request.timesheetId !== 'november') throw new Error('Wrong report ownership');
        value = { employees: [...this.rows].map(([dateKey, row]) => ({ dateKey, isSummary: false, rowId: `unstable-${dateKey}`, time_attendance_employee_timesheet: row })) };
      } else if (write && call.method === 'POST' && call.path.startsWith('/api/attendance/employees/fast-self/')) {
        const ordinal = this.mutations.length;
        const failure = this.failure?.ordinal === ordinal ? this.failure : undefined;
        if (!failure || failure.accept) {
          const date = url.searchParams.get('forDate')!;
          this.set(date, (call.body as Entry[]).map((entry, index) => ({ id: entry.id ?? `saved-${date}-${index}`, employeeId: 'fast-self', entryType: entry.entryType, start: entry.start, end: entry.end, comment: entry.comment ?? '', source: 'employeeManuallyEdit', duration: (minute(entry.end) - minute(entry.start)) * 60, reportingMethod: 'startEnd', isManuallyEdited: true })));
          this.afterWrite?.(date, ordinal);
        }
        if (failure?.network) throw new TypeError('Network unavailable');
        if (failure?.status) return new Response('{}', { status: failure.status, headers: { 'content-type': 'application/json', ...(failure.status === 429 ? { 'retry-after': '60' } : {}) } });
        value = { acknowledged: true };
      } else throw new Error(`Unexpected fixture endpoint ${call.method} ${call.path}`);
      return new Response(JSON.stringify(clone(value)), { headers: { 'content-type': 'application/json' } });
    } finally { if (write) this.concurrentWrites--; }
  });
}

async function finish<T>(operation: Promise<T>): Promise<T> {
  let settled = false;
  const observed = operation.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  for (let tick = 0; !settled && tick < 2000; tick++) await vi.advanceTimersByTimeAsync(250);
  if (!settled) throw new Error('Fixture did not settle');
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}
function authorize(plan: BookingPlan): ApplyAuthorization {
  const common = { planId: plan.id, planRevision: 1, contextFingerprint: contextFingerprint(plan.snapshot.context), executionFingerprint: executionFingerprint({ executionProfile: 'fast-serial' }) };
  return { ...common, confirmation: { ...common, confirmed: true } };
}
async function app(server = new MonthServer(), choices: ConflictChoices = {}, redistributeAll = false) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));
  vi.stubGlobal('fetch', server.fetch);
  const unexpected = vi.fn(() => { throw new Error('Native browser access is forbidden'); });
  vi.stubGlobal('chrome', { tabs: { create: unexpected, get: unexpected, remove: unexpected }, windows: { create: unexpected, get: unexpected }, scripting: { executeScript: unexpected } });
  const adapter = new HiBobApiAdapter();
  const connection = await finish(adapter.connect());
  const snapshot = await finish(adapter.scanMonth(connection, month));
  const plan = buildMonthPlan({ ...defaultSettings(month), variable: true, variationMinutes: 15, excludedDates: [] }, snapshot, choices, 761, { redistributeAll });
  expect(plan.canReview).toBe(true);
  server.calls.length = 0; server.maxConcurrentWrites = 0;
  const journals: Array<{ date: string; type: 'before' | 'ack'; at: number }> = [];
  const hooks: MonthApplyHooks = {
    beforeDispatch: async date => { await pause(5); journals.push({ date, type: 'before', at: Date.now() }); },
    acknowledged: async date => { await pause(5); journals.push({ date, type: 'ack', at: Date.now() }); },
  };
  const run = (signal?: AbortSignal, custom = hooks, authorization = authorize(plan)) => adapter.applyMonth(connection, plan, authorization, custom, undefined, signal);
  return { server, adapter, connection, snapshot, plan, journals, hooks, run, unexpected };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('fast serial month runner through the real session transport', () => {
  it('finishes the complete controller workflow below 10 s with 200 ms HTTP and actual durable journaling', async () => {
    const server = new MonthServer(); server.latencyMs = 200;
    const a = await app(server);
    let stored: SessionState | undefined;
    const journal: Array<{ at: number; state: SessionState }> = [];
    const bridge: ControllerBridge = {
      load: async () => stored,
      save: async state => { await pause(5); stored = clone(state); journal.push({ at: Date.now(), state: clone(state) }); },
      connect: () => a.adapter.connect(), disconnect: () => a.adapter.disconnect(),
      scan: (connection, selectedMonth) => a.adapter.scanMonth(connection, selectedMonth),
      applyMonth: (connection, plan, authorization, _jobId, hooks) => a.adapter.applyMonth(connection, plan, authorization, hooks),
      applyDay: (connection, day, context, _jobId, authorization) => a.adapter.applyDay(connection, day, context, authorization),
      preflightDay: (connection, day, context, _jobId, authorization) => a.adapter.preflightDay(connection, day, context, authorization),
      cancel: async () => { a.adapter.cancel(); },
    };
    const controller = new BookingController(bridge);
    await finish(controller.init());
    await finish(controller.connect());
    await finish(controller.scan(month));
    const candidate = buildMonthPlan({ ...defaultSettings(month), variable: true, variationMinutes: 15, excludedDates: [] }, controller.state.snapshot!, {}, 761);
    const invalidated = await finish(controller.invalidatePlan(controller.state.planRevision!, 'full-workflow-review'));
    await finish(controller.savePlan(candidate, invalidated.editLease!));
    const plan = controller.state.plan!, revision = controller.state.planRevision!;
    const common = { planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), executionFingerprint: executionFingerprint({ executionProfile: 'fast-serial' }) };
    server.calls.length = 0; journal.length = 0;
    const started = Date.now(); let elapsed = 0;
    const final = await finish(controller.apply(plan, revision, { ...common, confirmed: true }, { executionProfile: 'fast-serial' }).then(state => { elapsed = Date.now() - started; return state; }));
    expect(final.run).toMatchObject({ status: 'complete', executionProfile: 'fast-serial', timings: { requests: 34, writes: 21 } });
    expect(final.run!.results.filter(day => day.status === 'verified')).toHaveLength(21);
    expect(final.run!.results.every(day => day.status === 'verified' || day.status === 'skipped')).toBe(true);
    expect(server.calls).toHaveLength(34); expect(server.mutations).toHaveLength(21); expect(server.maxConcurrentWrites).toBe(1);
    const persisted = [...server.rows.values()].flatMap(day => day.entries);
    expect(persisted).toHaveLength(63); expect(net(persisted)).toBe(168 * 60);
    expect(elapsed).toBeLessThan(10_000);
    expect(elapsed).toBe(7020);
    expect(journal).toHaveLength(44);
    for (const call of server.mutations) {
      const date = call.path.slice(-10);
      expect(journal.some(entry => entry.at <= call.at && entry.state.run?.results.find(day => day.date === date)?.status === 'running')).toBe(true);
      expect(journal.some(entry => entry.at > call.at && entry.state.run?.results.find(day => day.date === date)?.status === 'awaiting-verification')).toBe(true);
    }
    expect(journal.at(-1)!.state.run?.status).toBe('complete');
    expect(stored?.run?.results.filter(day => day.status === 'verified')).toHaveLength(21);
    expect(a.unexpected).not.toHaveBeenCalled();
  });

  it.each([100, 200, 250, 500])('uses 34 requests for 21 days with %i ms server latency and measured journaling', async latency => {
    const server = new MonthServer(); server.latencyMs = latency;
    const a = await app(server); const result = await finish(a.run());
    expect(result).toMatchObject({ complete: true, stopped: false });
    expect(result.days).toHaveLength(21); expect(result.days.every(day => day.status === 'verified')).toBe(true);
    expect(server.calls).toHaveLength(34); expect(server.mutations).toHaveLength(21); expect(server.maxConcurrentWrites).toBe(1);
    expect(server.calls.filter(report)).toHaveLength(2);
    const saved = [...server.rows.values()].flatMap(row => row.entries);
    expect(saved).toHaveLength(63); expect(net(saved)).toBe(168 * 60);
    expect(new Set(server.mutations.map(call => net(call.body as Entry[]))).size).toBeGreaterThan(1);
    expect(result.timings).toMatchObject({ requests: 34, writes: 21, journalingMs: 210 });
    expect(result.timings.totalMs).toBe(34 * latency + 210);
    expect(result.timings.preparationMs + result.timings.writingMs + result.timings.journalingMs + result.timings.verificationMs).toBe(result.timings.totalMs);
    if (latency === 200) expect(result.timings.totalMs).toBeLessThan(10_000);
    for (const call of server.mutations) {
      const date = call.path.slice(-10);
      expect(a.journals.find(event => event.date === date && event.type === 'before')!.at).toBeLessThanOrEqual(call.at);
      expect(a.journals.find(event => event.date === date && event.type === 'ack')!.at).toBeGreaterThan(call.at);
    }
    expect(a.unexpected).not.toHaveBeenCalled();
  });

  it('preserves every overwrite ID and verifies explicit note removal', async () => {
    const server = new MonthServer();
    server.set(target, [
      { id: 'work-first', entryType: 'work', start: `${target}T08:00`, end: `${target}T12:00`, comment: 'Private fixture note' },
      { id: 'break', entryType: 'break', start: `${target}T12:00`, end: `${target}T12:30` },
      { id: 'work-second', entryType: 'work', start: `${target}T12:30`, end: `${target}T16:30` },
    ]);
    const a = await app(server, { [target]: 'overwrite' }, true);
    expect(a.plan.days.find(day => day.date === target)?.action).toBe('overwrite');
    const result = await finish(a.run());
    expect(result.error).toBeUndefined();
    const payload = server.mutations.find(call => call.path.endsWith(target))!.body as Entry[];
    expect(payload.map(entry => entry.id)).toEqual(['work-first', 'break', 'work-second']);
    expect(payload.every(entry => entry.comment === '')).toBe(true);
    expect(result.complete).toBe(true); expect(result.days.find(day => day.date === target)?.status).toBe('verified');
  });

  it.each(['consent', 'execution', 'account', 'day', 'permission', 'policy'] as const)('rejects stale %s before any mutation', async failure => {
    const a = await app(); const authorization = authorize(a.plan);
    if (failure === 'consent') authorization.confirmation = undefined;
    if (failure === 'execution') authorization.confirmation!.executionFingerprint = executionFingerprint({ executionProfile: 'strict' });
    if (failure === 'account') a.server.user.id = 'another-employee';
    if (failure === 'day') a.server.rows.get(target)!.alerts = [{ warning: true }];
    if (failure === 'permission') a.server.editable = false;
    if (failure === 'policy') a.server.policy.enforceComment = true;
    await expect(finish(a.run(undefined, a.hooks, authorization))).rejects.toThrow();
    expect(a.server.mutations).toHaveLength(0);
  });

  it('checks unselected days in the complete reviewed month before any write', async () => {
    const a = await app();
    a.server.rows.get('2026-11-01')!.alerts = [{ changed: true }];
    await expect(finish(a.run())).rejects.toThrow();
    expect(a.server.mutations).toHaveLength(0);
  });

  it('rejects completion when retained entries change and the reviewed weekly target no longer holds', async () => {
    const server = new MonthServer();
    server.set(target, [
      { id: 'retained-first', entryType: 'work', start: `${target}T08:00`, end: `${target}T12:00` },
      { id: 'retained-break', entryType: 'break', start: `${target}T12:00`, end: `${target}T12:30` },
      { id: 'retained-second', entryType: 'work', start: `${target}T12:30`, end: `${target}T16:30` },
    ]);
    const a = await app(server, { [target]: 'skip' });
    expect(a.plan.days.find(day => day.date === target)?.action).toBe('skip');
    server.afterWrite = (_date, ordinal) => {
      if (ordinal === 20) {
        const entries = clone(server.rows.get(target)!.entries);
        entries[0].end = `${target}T11:00`; server.set(target, entries);
      }
    };
    const result = await finish(a.run());
    expect(server.mutations).toHaveLength(20);
    expect(server.mutations.some(call => call.path.endsWith(target))).toBe(false);
    expect(result.complete).toBe(false); expect(result.error).toEqual(expect.any(String));
  });

  it('accepts a fixed-time week with an explicitly retained seven-hour day and its reviewed 39-hour sum', async () => {
    const server = new MonthServer();
    server.set(target, [
      { id: 'retained-first', entryType: 'work', start: `${target}T08:00`, end: `${target}T12:00`, comment: 'Retained private fixture note' },
      { id: 'retained-break', entryType: 'break', start: `${target}T12:00`, end: `${target}T12:30` },
      { id: 'retained-second', entryType: 'work', start: `${target}T12:30`, end: `${target}T15:30` },
    ]);
    const a = await app(server, { [target]: 'skip' });
    const plan = buildMonthPlan({ ...defaultSettings(month), variable: false, excludedDates: [] }, a.snapshot, { [target]: 'skip' }, 761);
    const week = plan.weeks.find(item => item.dates.includes(target))!;
    expect(plan.canReview).toBe(true);
    expect(week).toMatchObject({ plannedMinutes: 39 * 60, targetMinutes: 40 * 60 });
    const retained = clone(server.rows.get(target)!);
    const result = await finish(a.adapter.applyMonth(a.connection, plan, authorize(plan), a.hooks));
    expect(result).toMatchObject({ complete: true, stopped: false });
    expect(server.mutations).toHaveLength(20);
    expect(server.mutations.some(call => call.path.endsWith(target))).toBe(false);
    expect(server.rows.get(target)).toEqual(retained);
    expect(week.dates.reduce((total, date) => total + net(server.rows.get(date)!.entries), 0)).toBe(39 * 60);
  });

  it.each([false, true])('reconciles a lost response with persisted=%s without repeating or advancing writes', async accept => {
    const a = await app(); a.server.failure = { ordinal: 1, accept, network: true };
    const result = await finish(a.run());
    expect(result.complete).toBe(false); expect(a.server.mutations).toHaveLength(1);
    expect(result.timings).toMatchObject({ requests: a.server.calls.length, writes: 1 });
    expect(result.days.find(day => day.date === '2026-11-02')?.status).toBe(accept ? 'verified' : 'failed');
    expect(a.server.calls.filter(report)).toHaveLength(2);
  });

  it('lets a cancelled in-flight POST settle and verifies it before stopping', async () => {
    const a = await app(); const cancel = new AbortController();
    a.server.before = call => { if (writes(call)) { cancel.abort(); a.adapter.cancel(); } };
    const result = await finish(a.run(cancel.signal));
    expect(result).toMatchObject({ complete: false, stopped: true });
    expect(a.server.mutations).toHaveLength(1);
    expect(a.server.mutations[0].signal?.aborted).toBe(false);
    expect(result.days.find(day => day.date === '2026-11-02')?.status).toBe('verified');
    expect(a.server.rows.get('2026-11-02')!.entries).toHaveLength(3);
    expect(a.server.calls.filter(report)).toHaveLength(2);
  });

  it.each(['before', 'ack'] as const)('stops and reconciles an accepted day after a %s journal failure', async phase => {
    const a = await app(); let prepared = 0;
    const hooks: MonthApplyHooks = {
      beforeDispatch: async date => { if (phase === 'before' && ++prepared === 2) throw new Error('Fixture journal unavailable'); await a.hooks.beforeDispatch(date); },
      acknowledged: async date => { if (phase === 'ack') throw new Error('Fixture journal unavailable'); await a.hooks.acknowledged(date); },
    };
    const result = await finish(a.run(undefined, hooks));
    expect(result.complete).toBe(false); expect(a.server.mutations).toHaveLength(1);
    expect(result.days.find(day => day.date === '2026-11-02')?.status).toBe('verified');
    expect(a.server.calls.filter(report)).toHaveLength(2);
  });

  it('retains server cooldown across the fast profile and never repeats a rate-limited POST', async () => {
    const a = await app(); a.server.failure = { ordinal: 1, status: 429 };
    const result = await finish(a.run());
    expect(result.complete).toBe(false); expect(a.server.mutations).toHaveLength(1);
    expect(result.days.find(day => day.date === '2026-11-02')?.status).toBe('uncertain');
    expect(result.timings).toMatchObject({ requests: a.server.calls.length, writes: 1 });
    const calls = a.server.calls.length;
    await expect(finish(a.adapter.scanMonth(a.connection, month))).rejects.toThrow();
    expect(a.server.calls).toHaveLength(calls);
  });

  it('restores conservative spacing for the next independent scan after a fast run', async () => {
    const a = await app(); await finish(a.run());
    a.server.calls.length = 0;
    await finish(a.adapter.scanMonth(a.connection, month));
    expect(a.server.calls).toHaveLength(7);
    expect(a.server.calls.slice(1).every((call, index) => call.at - a.server.calls[index].at >= 1000)).toBe(true);
  });

  it.each(['metadata', 'policy', 'identity', 'net'] as const)('does not report completion after changed %s in independent readback', async failure => {
    const a = await app();
    a.server.afterWrite = (_date, ordinal) => {
      if (ordinal !== 21) return;
      if (failure === 'metadata') a.server.rows.get(target)!.entries[0].unexpectedServerData = true;
      if (failure === 'policy') a.server.policy.enforceComment = true;
      if (failure === 'identity') a.server.user.id = 'replacement-person';
      if (failure === 'net') a.server.rows.get(target)!.hoursWorked = '7h 59m';
    };
    const result = await finish(a.run());
    expect(result.complete).toBe(false); expect(a.server.mutations).toHaveLength(21);
    expect(result.days.some(day => day.status !== 'verified')).toBe(true);
  });
});
