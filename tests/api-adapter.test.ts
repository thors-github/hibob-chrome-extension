import { describe, expect, it } from 'vitest';
import { ATTENDANCE_API_RULES, HiBobApiAdapter } from '../src/hibob/api-adapter';
import { SessionClientError, type ApiHttpRequest, type SessionConnection } from '../src/hibob/session-client';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain';
import { BookingController, type ControllerBridge } from '../src/controller';
import { contextFingerprint } from '../src/shared/context';
import { netMinutes, parseTime } from '../src/shared/entries';
import type { ApplyAuthorization, BookingPlan, ConflictChoices, SessionState } from '../src/shared/types';
import type { ApiEntry } from '../src/hibob/api-model';

const clone = <T>(value: T): T => structuredClone(value);
const target = '2026-11-03';
const mutation = (request: ApiHttpRequest) => request.path.includes('/attendance/entries?');
const reportSearch = (request: ApiHttpRequest) => request.path === '/api/company/views/search?idsOnly=false';

/** Independent server state: POST responses never stand in for persisted readback. */
class Server {
  readonly calls: Array<{ request: ApiHttpRequest; aborted: boolean }> = [];
  readonly lifecycle: string[] = [];
  readonly user = { id: 'employee-fixture', companyId: 123, companyName: 'Fixture company', displayName: 'Fixture employee', timezone: 'Europe/Berlin', mockedRole: false, sessionType: 'employee', state: 'active' };
  readonly company = { id: 123, name: 'Fixture company' };
  readonly policy = { timesheetReportingMethod: 'startEnd', timeFormatterType: 'time', enforceComment: false, allowFutureEntries: false, breakDeductionSettings: { breakDeductionType: 'manual' } };
  readonly timesheet = { id: 0, cycleStartDate: '', cycleEndDate: '', timesheetState: { timeSheetStatus: 'Open', locked: false, lockAt: 1_800_000_000 } };
  editable = true;
  beforeRequest?: (request: ApiHttpRequest) => void | Promise<void>;
  accepted?: () => void | Promise<void>;
  writeError?: SessionClientError;
  writeErrorAfterAccept = false;
  mismatch = false;
  readonly report;
  constructor(readonly month = '2026-11') {
    const dates = getMonthDates(month);
    this.timesheet.cycleStartDate = dates[0]; this.timesheet.cycleEndDate = dates.at(-1)!;
    this.report = { employees: dates.map(dateKey => ({ isSummary: false, dateKey, rowId: `unstable-${dateKey}`, time_attendance_employee_timesheet: { entries: [] as ApiEntry[], hoursWorked: '0h 00m', timeOff: null as unknown, timeOffEntries: null as unknown, calendarEventsEntry: null as unknown, holidayOrNonWorkingDay: '', comments: '', entryReasons: '', projects: '', entryStatus: 'NoEntries', hasHistory: false, alerts: [] as unknown[] } })) };
  }
  data(date = target) { return this.report.employees.find(row => row.dateKey === date)!.time_attendance_employee_timesheet; }
  setEntries(date: string, entries: ApiEntry[]) {
    const data = this.data(date); data.entries = clone(entries); data.entryStatus = entries.length ? 'Completed' : 'NoEntries';
    const minutes = entries.filter(entry => entry.entryType === 'work').reduce((total, entry) => total + parseTime(String(entry.end).slice(-5))! - parseTime(String(entry.start).slice(-5))!, 0);
    data.hoursWorked = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  }
  get mutations() { return this.calls.filter(call => mutation(call.request)); }
  async connect(): Promise<SessionConnection> { this.lifecycle.push('connect'); return { mode: 'direct', id: 'transport-fixture' }; }
  async disconnect() { this.lifecycle.push('disconnect'); }
  async openOperation(signal?: AbortSignal): Promise<SessionConnection> { if (signal?.aborted) throw new SessionClientError('CANCELLED'); this.lifecycle.push('open'); return { mode: 'direct', id: 'transport-fixture' }; }
  async closeOperation() { this.lifecycle.push('close'); }
  cancel() { this.lifecycle.push('cancel'); }
  async request<T = unknown>(request: ApiHttpRequest, signal?: AbortSignal): Promise<T> {
    this.calls.push({ request: clone(request), aborted: signal?.aborted ?? false });
    if (signal?.aborted) throw new SessionClientError('CANCELLED');
    await this.beforeRequest?.(request);
    let value: unknown;
    if (request.path === '/api/user') value = this.user;
    else if (request.path === '/api/company') value = this.company;
    else if (request.path === '/api/permissions/authorizations/domains/timeAttendance') value = { permissions: { timeAttendance: this.editable ? [{ resource: 'timeAttendance', filter: 'self', action: 'editSheet' }] : [] } };
    else if (request.path.endsWith('/timesheets')) value = { employeeTimesheets: [this.timesheet] };
    else if (request.path.endsWith('/details')) {
      // Observed browser contract: this policy lookup is a read-only POST.
      if (request.method !== 'POST' || JSON.stringify(request.body) !== JSON.stringify({ fields: ['policyDetails'] })) throw new Error('Policy details require POST with exactly fields: [policyDetails].');
      value = { policyDetails: this.policy };
    }
    else if (reportSearch(request)) value = this.report;
    else if (mutation(request)) {
      if (this.writeError && !this.writeErrorAfterAccept) throw this.writeError;
      const date = new URL(request.path, 'https://app.hibob.com').searchParams.get('forDate')!;
      const entries: ApiEntry[] = clone(request.body as ApiEntry[]).map((entry, index) => ({ ...entry, id: entry.id ?? `stored-${date}-${index}` }));
      if (this.mismatch) entries[0].end = `${date}T11:59`;
      this.setEntries(date, entries);
      await this.accepted?.();
      if (this.writeError) throw this.writeError;
      // Deliberately unrelated to attendance. Only the report can prove success.
      value = { acknowledged: true, notAttendance: 'do not trust this as readback' };
    } else throw new Error(`Unexpected fixture request: ${request.method} ${request.path}`);
    return clone(value) as T;
  }
}

const entries = (): ApiEntry[] => [
  { id: 'original-work-a', entryType: 'work', start: `${target}T08:00`, end: `${target}T12:00`, comment: 'Original private fixture note' },
  { id: 'original-break', entryType: 'break', start: `${target}T12:00`, end: `${target}T12:30` },
  { id: 'original-work-b', entryType: 'work', start: `${target}T12:30`, end: `${target}T16:30` },
];
function authorization(plan: BookingPlan, revision = 7): ApplyAuthorization {
  const fingerprint = contextFingerprint(plan.snapshot.context);
  return { planId: plan.id, planRevision: revision, contextFingerprint: fingerprint, confirmation: { planId: plan.id, planRevision: revision, contextFingerprint: fingerprint, confirmed: true } };
}
async function setup(server = new Server(), choices: ConflictChoices = {}) {
  const adapter = new HiBobApiAdapter({ client: server, now: () => new Date('2026-12-01T12:00:00Z') });
  const connection = await adapter.connect();
  const snapshot = await adapter.scanMonth(connection, server.month);
  const plan = buildMonthPlan(defaultSettings(server.month), snapshot, choices, 1234);
  const day = plan.days.find(item => item.date === (server.month === '2026-11' ? target : `${server.month}-03`))!;
  const consent = authorization(plan);
  server.calls.length = 0;
  return { server, adapter, connection, snapshot, plan, day, consent };
}
const apply = (app: Awaited<ReturnType<typeof setup>>, signal?: AbortSignal) => app.adapter.applyDay(app.connection, app.day, app.snapshot.context, app.consent, undefined, signal);
const preflight = (app: Awaited<ReturnType<typeof setup>>, signal?: AbortSignal) => app.adapter.preflightDay(app.connection, app.day, app.snapshot.context, app.consent, undefined, signal);

describe('API connection, complete month and read-only preflight', () => {
  it('permits the observed read-only policy POST and rejects the obsolete GET contract', async () => {
    const path = '/api/attendance/employees/employee-fixture/timesheets/0/details';
    const rules = ATTENDANCE_API_RULES.filter(rule => typeof rule.path === 'string' ? rule.path === path : rule.path.test(path));
    expect(rules).toHaveLength(1); expect(rules[0]).toMatchObject({ method: 'POST', mutation: false });
    const server = new Server();
    await expect(server.request({ method: 'GET', path })).rejects.toThrow('Policy details require POST');
    await expect(server.request({ method: 'POST', path, body: { fields: ['unexpected'] } })).rejects.toThrow('exactly fields');
    const app = await setup(server); await preflight(app);
    expect(server.calls.filter(call => call.request.path.endsWith('/details')).map(call => call.request)).toEqual([{ method: 'POST', path, body: { fields: ['policyDetails'] } }]);
    expect(server.mutations).toHaveLength(0);
  });

  it('reads all dates, builds the actual weekly plan, requires explicit consent and preflights with zero mutations', async () => {
    const app = await setup();
    expect(app.connection).toMatchObject({ status: 'connected', employeeId: 'employee-fixture', companyId: '123', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } });
    expect(app.snapshot.days).toHaveLength(30); expect(app.snapshot.context).toEqual({ mode: 'api-session', connectionId: app.connection.generation, employeeKey: 'employee-fixture', tenantKey: '123' });
    expect(app.plan.canReview).toBe(true); expect(app.plan.days.filter(day => day.action === 'create')).toHaveLength(21);
    expect(app.plan.weeks.map(week => week.plannedMinutes)).toEqual([0, 2400, 2400, 2400, 2400, 480]);
    const before = clone(app.server.report);
    await expect(preflight({ ...app, consent: { ...app.consent, confirmation: undefined } })).rejects.toThrow('bestätigen');
    await expect(preflight(app)).resolves.toEqual({ date: target, checked: true, saved: false, serverValidated: false, netMinutes: 480 });
    expect(app.server.mutations).toHaveLength(0); expect(app.server.report).toEqual(before);
    expect(app.server.calls.some(call => reportSearch(call.request) && call.request.method === 'POST')).toBe(true);
    expect(app.server.lifecycle.filter(event => event === 'open')).toHaveLength(app.server.lifecycle.filter(event => event === 'close').length);
  });

  it('keeps read-only accounts useful without allowing mutations', async () => {
    const server = new Server(); server.editable = false;
    const app = await setup(server);
    expect(app.connection.capabilities).toEqual({ read: true, write: false, overwrite: false });
    expect(app.plan.canReview).toBe(true);
    await expect(preflight(app)).resolves.toHaveProperty('saved', false);
    await expect(apply(app)).rejects.toThrow('Vorprüfung'); expect(server.mutations).toHaveLength(0);
  });

  it('rejects an incomplete month rather than silently creating a partial plan', async () => {
    const app = await setup(); app.server.report.employees.pop();
    await expect(app.adapter.scanMonth(app.connection, app.server.month)).rejects.toThrow('jeden Tag');
    expect(app.server.mutations).toHaveLength(0);
  });

  it.each(['HolidayEvent', 'PendingTimeoffRequset', 'ApproveTimeoffRequest'].flatMap(status => ['null', 'empty', 'missing'].map(markers => ({ status, markers }))))('excludes status-only $status with $markers markers and rejects stale or forged proposals without mutations', async ({ status, markers }) => {
    const app = await setup(); expect(app.day.action).toBe('create');
    const data = app.server.data(); data.entryStatus = status;
    for (const key of ['timeOff', 'timeOffEntries', 'calendarEventsEntry', 'holidayOrNonWorkingDay'] as const) {
      if (markers === 'missing') delete (data as Partial<typeof data>)[key];
      else Object.assign(data, { [key]: markers === 'empty' ? [] : null });
    }

    // A day that became unavailable after review must stop both API paths.
    await expect(preflight(app)).rejects.toThrow(); await expect(apply(app)).rejects.toThrow();
    const fresh = await app.adapter.scanMonth(app.connection, app.server.month);
    const current = fresh.days.find(day => day.date === target)!;
    expect(status === 'HolidayEvent' ? current.nonWorking : current.absence).toEqual(expect.any(String));
    expect(status === 'HolidayEvent' ? current.nonWorking : current.absence).not.toBe('');
    const replanned = buildMonthPlan(defaultSettings(app.server.month), fresh, {}, 1234);
    expect(replanned.days.find(day => day.date === target)).toMatchObject({ action: 'skip', eligible: false, proposed: [], netMinutes: 0 });
    expect(replanned.weeks.reduce((minutes, week) => minutes + week.targetMinutes, 0)).toBe(20 * 480);

    // A matching fresh fingerprint alone must never override the server status.
    const forged = { ...app, day: { ...app.day, fingerprint: current.fingerprint }, snapshot: fresh, consent: authorization(replanned) };
    await expect(preflight(forged)).rejects.toThrow(); await expect(apply(forged)).rejects.toThrow();
    expect(app.server.mutations).toHaveLength(0); expect(app.server.data().entries).toHaveLength(0);
  });
});

describe('single-request API writes with independent readback', () => {
  it.each([['2026-11', -60], ['2026-07', -120]] as const)('preserves wall-clock values and the %s timezone offset, then verifies all three persisted segments', async (month, offset) => {
    const app = await setup(new Server(month));
    const actual = await apply(app);
    expect(actual.entries).toEqual(app.day.proposed); expect(actual.reportedMinutes).toBe(480);
    expect(app.server.mutations).toHaveLength(1);
    expect(app.server.mutations[0].request).toEqual({ method: 'POST', path: `/api/attendance/employees/employee-fixture/attendance/entries?forDate=${app.day.date}`, body: [
      { start: `${app.day.date}T08:00`, end: `${app.day.date}T12:00`, entryType: 'work', comment: '', offset },
      { start: `${app.day.date}T12:00`, end: `${app.day.date}T12:30`, entryType: 'break', comment: '', offset },
      { start: `${app.day.date}T12:30`, end: `${app.day.date}T16:30`, entryType: 'work', comment: '', offset },
    ] });
    const writeIndex = app.server.calls.findIndex(call => mutation(call.request));
    expect(app.server.calls.slice(writeIndex + 1).some(call => reportSearch(call.request))).toBe(true);
    expect(app.server.calls.every(call => !['DELETE', 'PUT', 'PATCH'].includes(call.request.method))).toBe(true);
    expect(actual.fingerprint).not.toBe(app.day.fingerprint);
  });

  it('only replaces explicitly selected conflicts, reusing every stable ID and confirming note removal through readback', async () => {
    const server = new Server(); server.setEntries(target, entries());
    const app = await setup(server, { [target]: 'overwrite' });
    expect(app.day.action).toBe('overwrite'); expect(app.day.existing[0].note).toBe('Original private fixture note');
    await expect(apply(app)).resolves.toHaveProperty('reportedMinutes', 480);
    const payload = server.mutations[0].request.body as ApiEntry[];
    expect(payload.map(entry => entry.id)).toEqual(['original-work-a', 'original-break', 'original-work-b']);
    expect(payload.map(entry => entry.comment)).toEqual(['', '', '']); expect(server.mutations).toHaveLength(1);
    expect(server.data().entries.map(entry => entry.comment)).toEqual(['', '', '']);
  });

  it('does not write unresolved overwrite conflicts', async () => {
    const server = new Server(); server.setEntries(target, entries()); const app = await setup(server);
    expect(app.day.action).toBe('conflict'); await expect(apply(app)).rejects.toThrow(); expect(server.mutations).toHaveLength(0);
  });

  it.each(['deletion', 'reason', 'project', 'unknown-field'] as const)('blocks unsupported %s replacement with zero mutation requests', async kind => {
    const server = new Server(); const original = entries();
    if (kind === 'deletion') original.push({ id: 'extra-work', entryType: 'work', start: `${target}T17:00`, end: `${target}T18:00` });
    if (kind === 'reason') original[0].reason = 'reason-fixture';
    if (kind === 'project') original[0].projectId = 'project-fixture';
    if (kind === 'unknown-field') original[0].unknownMetadata = 'fixture';
    server.setEntries(target, original); const app = await setup(server, { [target]: 'overwrite' });
    await expect(apply(app)).rejects.toThrow(); expect(server.mutations).toHaveLength(0);
  });

  it.each(['consent', 'revision', 'context', 'generation', 'account', 'company', 'concurrent-day', 'policy', 'lock', 'permission', 'absence'] as const)('rejects stale or unsafe %s before mutation', async change => {
    const app = await setup();
    if (change === 'consent') app.consent.confirmation = undefined;
    if (change === 'revision') app.consent.confirmation!.planRevision--;
    if (change === 'context') app.consent.contextFingerprint = 'stale-context';
    if (change === 'generation') app.connection.generation = 'different-session-generation';
    if (change === 'account') app.server.user.id = 'another-employee';
    if (change === 'company') { app.server.user.companyId = 999; app.server.company.id = 999; }
    if (change === 'concurrent-day') app.server.setEntries(target, [{ id: 'other-entry', entryType: 'work', start: '08:00', end: '09:00' }]);
    if (change === 'policy') app.server.policy.enforceComment = true;
    if (change === 'lock') app.server.timesheet.timesheetState.locked = true;
    if (change === 'permission') app.server.editable = false;
    if (change === 'absence') app.server.data().timeOffEntries = [{ name: 'Partial leave', hours: 2 }];
    await expect(apply(app)).rejects.toThrow(); expect(app.server.mutations).toHaveLength(0);
  });

  it('honours server policy on future dates without attempting a write', async () => {
    const app = await setup();
    const adapter = new HiBobApiAdapter({ client: app.server, now: () => new Date('2026-11-02T12:00:00Z') });
    await expect(adapter.applyDay(app.connection, app.day, app.snapshot.context, app.consent)).rejects.toThrow('zukünftigen');
    expect(app.server.mutations).toHaveLength(0);
  });

  it('rechecks day content immediately before the mutation, including changes after the first report', async () => {
    const app = await setup(); let reports = 0;
    app.server.beforeRequest = request => { if (reportSearch(request) && ++reports === 2) app.server.data().alerts = [{ warning: true }]; };
    await expect(apply(app)).rejects.toThrow('geändert'); expect(reports).toBe(2); expect(app.server.mutations).toHaveLength(0);
  });

  it('detects an account switch during the final day recheck before dispatching a mutation', async () => {
    const app = await setup(); let reports = 0;
    app.server.beforeRequest = request => { if (reportSearch(request) && ++reports === 2) app.server.user.id = 'different-employee'; };
    await expect(apply(app)).rejects.toThrow('Konto'); expect(app.server.mutations).toHaveLength(0);
  });

  it.each([false, true])('never retries an unknown mutation result, including acceptance=%s before connection loss', async accepted => {
    const app = await setup(); app.server.writeError = new SessionClientError('TIMEOUT', true); app.server.writeErrorAfterAccept = accepted;
    await expect(apply(app)).rejects.toMatchObject({ uncertain: true }); expect(app.server.mutations).toHaveLength(1);
    expect(app.server.data().entries).toHaveLength(accepted ? 3 : 0);
  });

  it('marks a mismatched persisted result uncertain and never resends it', async () => {
    const app = await setup(); app.server.mismatch = true;
    await expect(apply(app)).rejects.toMatchObject({ uncertain: true }); expect(app.server.mutations).toHaveLength(1);
    expect(app.server.data().hoursWorked).toBe('7h 59m');
  });

  it('rejects pre-dispatch cancellation with zero mutations and releases the exclusive operation', async () => {
    const app = await setup(); const abort = new AbortController(); abort.abort();
    await expect(apply(app, abort.signal)).rejects.toThrow('abgebrochen'); expect(app.server.mutations).toHaveLength(0);
    await expect(preflight(app)).resolves.toHaveProperty('checked', true);
  });

  it('finishes independent readback after cancellation following an accepted POST', async () => {
    const app = await setup(); const abort = new AbortController();
    app.server.accepted = () => { abort.abort(); app.adapter.cancel(); };
    await expect(apply(app, abort.signal)).resolves.toMatchObject({ date: target, reportedMinutes: 480 });
    expect(app.server.mutations).toHaveLength(1);
    const after = app.server.calls.slice(app.server.calls.findIndex(call => mutation(call.request)) + 1);
    expect(after.some(call => reportSearch(call.request))).toBe(true); expect(after.every(call => !call.aborted)).toBe(true);
  });

  it('marks an account switch after acceptance uncertain without writing again', async () => {
    const app = await setup(); app.server.accepted = () => { app.server.user.id = 'different-employee'; };
    await expect(apply(app)).rejects.toMatchObject({ uncertain: true }); expect(app.server.mutations).toHaveLength(1);
  });

  it('preserves expired connection status when acknowledged-write verification requires authentication', async () => {
    const app = await setup();
    app.server.accepted = () => { app.server.beforeRequest = request => { if (request.path === '/api/user') throw new SessionClientError('AUTH_REQUIRED', false, 401); }; };
    await expect(apply(app)).rejects.toMatchObject({ uncertain: true, connectionStatus: 'expired' });
    expect(app.server.mutations).toHaveLength(1); expect(app.server.data().entries).toHaveLength(3);
    const readback = app.server.calls.slice(app.server.calls.findIndex(call => mutation(call.request)) + 1);
    expect(readback.some(call => call.request.path === '/api/user')).toBe(true);
  });

  it('holds the operation lock through preflight and releases it after cancellation', async () => {
    const app = await setup(); const abort = new AbortController(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    app.server.beforeRequest = async request => { if (reportSearch(request)) { entered(); await wait; } };
    const checking = preflight(app, abort.signal); await started;
    await expect(apply(app)).rejects.toThrow('läuft bereits');
    await expect(app.adapter.disconnect()).rejects.toThrow('läuft bereits');
    abort.abort(); app.adapter.cancel(); release();
    await expect(checking).rejects.toThrow('abgebrochen'); expect(app.server.mutations).toHaveLength(0);
    app.server.beforeRequest = undefined; await expect(preflight(app)).resolves.toHaveProperty('checked', true);
  });
});

describe('controller queue with actual API adapter', () => {
  it('keeps an accepted day verified after cancel and does not start the next day', async () => {
    const server = new Server(); const adapter = new HiBobApiAdapter({ client: server, now: () => new Date('2026-12-01T12:00:00Z') });
    let stored: SessionState | undefined; let abort: AbortController | undefined;
    const bridge: ControllerBridge = {
      load: async () => stored,
      save: async state => { stored = clone(state); },
      connect: () => adapter.connect(), disconnect: () => adapter.disconnect(),
      scan: (connection, month) => adapter.scanMonth(connection, month),
      applyDay: async (connection, day, context, _jobId, authorization) => { abort = new AbortController(); return adapter.applyDay(connection, day, context, authorization, undefined, abort.signal); },
      preflightDay: (connection, day, context, _jobId, authorization) => adapter.preflightDay(connection, day, context, authorization),
      cancel: async () => { abort?.abort(); adapter.cancel(); },
    };
    const controller = new BookingController(bridge); await controller.init(); await controller.connect(); await controller.scan('2026-11');
    const input = buildMonthPlan(defaultSettings('2026-11'), controller.state.snapshot!, {}, 1234);
    const invalidated = await controller.invalidatePlan(controller.state.planRevision!, 'review-fixture');
    await controller.savePlan(input, invalidated.editLease!);
    const plan = controller.state.plan!, revision = controller.state.planRevision!, consent = authorization(plan, revision).confirmation!;
    server.calls.length = 0; server.accepted = async () => { await controller.cancel(controller.state.job!.id); };
    const finished = await controller.apply(plan, revision, consent);
    expect(finished.run?.status).toBe('stopped'); expect(finished.run?.results.filter(result => result.status === 'verified')).toHaveLength(1);
    expect(finished.run?.results.find(result => result.date === '2026-11-02')?.status).toBe('verified');
    expect(finished.run?.results.find(result => result.date === target)?.status).toBe('pending');
    expect(server.mutations).toHaveLength(1); expect(netMinutes(server.data('2026-11-02').entries.map(entry => ({ type: entry.entryType as 'work' | 'break', start: String(entry.start).slice(-5), end: String(entry.end).slice(-5) })))).toBe(480);
    expect(finished.snapshot).toBeUndefined(); expect(finished.plan?.canReview).toBe(false); expect(finished.job).toBeUndefined();
  });
});
