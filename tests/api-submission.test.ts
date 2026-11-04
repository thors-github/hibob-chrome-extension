import { describe, expect, it, vi } from 'vitest';
import { getMonthDates } from '../src/domain/calendar';
import { ATTENDANCE_API_RULES, HiBobApiAdapter } from '../src/hibob/api-adapter';
import { SessionClient, SessionClientError, type ApiHttpRequest, type SessionConnection } from '../src/hibob/session-client';
import { parseSubmissionPeriods } from '../src/hibob/submission-model';
import { submissionAccountKey } from '../src/shared/submission';
import type { SubmissionConsent, SubmissionHooks, SubmissionReview, TimesheetStatus } from '../src/shared/types';

const clone = <T>(value: T): T => structuredClone(value);
const submit = (request: ApiHttpRequest) => request.method === 'PUT';
const reportPath = '/api/company/views/search?idsOnly=false';
class Server {
  readonly requests: ApiHttpRequest[] = [];
  readonly opens: Array<{ directOnly?: boolean }> = [];
  readonly user = { id: 'self-fixture', companyId: 123, companyName: 'Fixture company', displayName: 'Fixture employee', timezone: 'Europe/Berlin', mockedRole: false, sessionType: 'employee', state: 'active' };
  readonly company = { id: 123, name: 'Fixture company' };
  readonly period = { id: 71, cycleStartDate: '2026-11-01', cycleEndDate: '2026-11-30', timesheetState: { timeSheetStatus: 'WaitingForSubmission' as string, locked: false } };
  readonly policy = { timesheetReportingMethod: 'startEnd', timeFormatterType: 'time', enforceComment: false, allowFutureEntries: true, allowEarlySubmission: false, breakDeductionSettings: { breakDeductionType: 'manual' } };
  readonly summary: Record<string, unknown> = { isSubmittable: true, hasMissingEntries: false, hasMissingFutureEntries: false, hasPendingTimeOffRequests: false, hasOverlappingApprovedPaidTimeOffRequestsAndAttendance: false, hasInvalidProjectOrTask: false, isAutoSubmitTimesheet: false, breakViolationCounter: 0 };
  readonly report = { employees: getMonthDates('2026-11').map(dateKey => {
    const weekend = [0, 6].includes(new Date(`${dateKey}T12:00:00Z`).getUTCDay());
    return { isSummary: false, dateKey, rowId: `unstable-${dateKey}`, time_attendance_employee_timesheet: { entries: weekend ? [] : [
      { id: `${dateKey}-a`, entryType: 'work', start: `${dateKey}T08:00`, end: `${dateKey}T12:00`, comment: '' },
      { id: `${dateKey}-b`, entryType: 'break', start: `${dateKey}T12:00`, end: `${dateKey}T12:30`, comment: '' },
      { id: `${dateKey}-c`, entryType: 'work', start: `${dateKey}T12:30`, end: `${dateKey}T16:30`, comment: '' },
    ], hoursWorked: weekend ? '0h 00m' : '8h 00m', timeOff: null, timeOffEntries: null, calendarEventsEntry: null, holidayOrNonWorkingDay: weekend ? 'Weekend' : '', comments: '', entryReasons: '', projects: '', entryStatus: weekend ? 'WeekendEvent' : 'Completed', hasHistory: false, alerts: [] as unknown[] } };
  }) };
  editable = true;
  finalStatus: TimesheetStatus = 'Submitted';
  ignore = false;
  before?: (request: ApiHttpRequest) => void | Promise<void>;
  onSubmit?: () => void | Promise<void>;
  writeError?: SessionClientError;
  acceptBeforeError = false;
  cancel = vi.fn();
  verificationError = false;
  submitted = false;
  connect = async (): Promise<SessionConnection> => ({ mode: 'direct', id: 'transport' });
  disconnect = async () => {};
  openOperation = async (signal?: AbortSignal, _profile?: unknown, options: { directOnly?: boolean } = {}): Promise<SessionConnection> => {
    if (signal?.aborted) throw new SessionClientError('CANCELLED');
    this.opens.push(options); if (this.verificationError && this.submitted) throw new SessionClientError('NETWORK_UNAVAILABLE');
    return { mode: 'direct', id: 'transport' };
  };
  closeOperation = vi.fn(async () => {});
  get writes() { return this.requests.filter(submit); }
  async request<T = unknown>(request: ApiHttpRequest, signal?: AbortSignal): Promise<T> {
    this.requests.push(clone(request)); if (signal?.aborted) throw new SessionClientError('CANCELLED'); await this.before?.(request);
    let value: unknown;
    if (request.path === '/api/user') value = this.user;
    else if (request.path === '/api/company') value = this.company;
    else if (request.path.endsWith('/timeAttendance')) value = { permissions: { timeAttendance: this.editable ? [{ resource: 'timeAttendance', filter: 'self', action: 'editSheet' }] : [] } };
    else if (request.path.endsWith('/timesheets')) value = { employeeTimesheets: [this.period] };
    else if (request.path.endsWith('/details')) value = { policyDetails: this.policy };
    else if (request.path.endsWith('/summary')) value = this.summary;
    else if (request.path === reportPath) value = this.report;
    else if (submit(request)) {
      if (this.writeError && !this.acceptBeforeError) throw this.writeError;
      this.submitted = true;
      if (!this.ignore) { this.period.timesheetState.timeSheetStatus = this.finalStatus; this.period.timesheetState.locked = true; }
      await this.onSubmit?.(); if (this.writeError) throw this.writeError;
      value = { acknowledged: true, isAutoApproved: this.finalStatus === 'Approved' };
    } else throw new Error(`Unexpected fixture request ${request.method} ${request.path}`);
    return clone(value) as T;
  }
}
const hooks = (): SubmissionHooks => ({ beforeDispatch: vi.fn(async () => {}), acknowledged: vi.fn(async () => {}) });
const consent = (review: SubmissionReview): SubmissionConsent => ({ reviewId: review.id, reviewRevision: 1, connectionId: review.connectionId, accountKey: review.accountKey, contentFingerprint: review.contentFingerprint, eligibilityFingerprint: review.eligibilityFingerprint, confirmed: true });
async function fixture(server = new Server()) {
  const adapter = new HiBobApiAdapter({ client: server, now: () => new Date('2026-12-01T12:00:00Z') });
  const connection = await adapter.connect(); const review = await adapter.reviewSubmission(connection, '2026-11'); server.requests.length = 0; server.opens.length = 0;
  return { server, adapter, connection, review };
}

describe('explicit own-account month submission', () => {
  it('uses the real serialized transport with an empty PUT entity and query-free allowlist', async () => {
    const server = new Server();
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const parsed = new URL(String(url));
      const value = await server.request({ method: (options?.method ?? 'GET') as ApiHttpRequest['method'], path: parsed.pathname + parsed.search, ...(options?.body === undefined ? {} : { body: JSON.parse(String(options.body)) }) });
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    });
    const browser = { tabs: { create: vi.fn() }, windows: { create: vi.fn() } } as unknown as typeof chrome;
    const client = new SessionClient({ rules: ATTENDANCE_API_RULES, allowBackgroundTab: true, fetch: fetcher as typeof fetch, chrome: browser, minRequestIntervalMs: 0, probe: async request => { await request({ method: 'GET', path: '/api/user' }); await request({ method: 'GET', path: '/api/company' }); } });
    const adapter = new HiBobApiAdapter({ client, now: () => new Date('2026-12-01T12:00:00Z') });
    const connection = await adapter.connect(); const review = await adapter.reviewSubmission(connection, '2026-11');
    await expect(adapter.submitMonth(connection, review, consent(review), hooks())).resolves.toHaveProperty('status', 'verified');
    const writes = fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT');
    expect(writes).toHaveLength(1); expect(writes[0][1]).not.toHaveProperty('body'); expect(writes[0][1]).toMatchObject({ credentials: 'include', redirect: 'error' });
    expect(browser.tabs.create).not.toHaveBeenCalled(); expect(browser.windows.create).not.toHaveBeenCalled();
    await client.openOperation(); fetcher.mockClear();
    for (const request of [
      { method: 'PUT', path: '/api/attendance/employees/self-fixture/sheets/71/submit?onBehalf=true' },
      { method: 'PUT', path: '/api/attendance/employees/self-fixture/sheets/71/approve' },
      { method: 'PUT', path: '/api/attendance/employees/self-fixture/sheets/71/reopen' },
      { method: 'POST', path: '/api/attendance/employees/self-fixture/sheets/71/submit' },
    ] as ApiHttpRequest[]) await expect(client.request(request)).rejects.toMatchObject({ code: 'REQUEST_DENIED' });
    expect(fetcher).not.toHaveBeenCalled(); await client.closeOperation();
  });
  it.each(['Submitted', 'Approved', 'PendingProjectApproval'] as const)('journals once, submits without an entity, then independently verifies %s and unchanged 168 hours', async status => {
    const f = await fixture(); const journal = hooks(); f.server.finalStatus = status;
    expect(f.review).toMatchObject({ canSubmit: true, netMinutes: 168 * 60, period: { status: 'WaitingForSubmission', locked: false } });
    const result = await f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal);
    expect(result).toMatchObject({ status: 'verified', periodStatus: status });
    expect(f.server.writes).toEqual([{ method: 'PUT', path: '/api/attendance/employees/self-fixture/sheets/71/submit' }]);
    expect(journal.beforeDispatch).toHaveBeenCalledTimes(1); expect(journal.acknowledged).toHaveBeenCalledTimes(1);
    expect(f.server.opens).toHaveLength(2);
    expect(f.server.requests.filter(request => request.path === reportPath)).toHaveLength(2);
    expect(f.server.requests.some(request => /onBehalf|approve|reopen|reject/.test(request.path))).toBe(false);
  });
  it('keeps notes and tolerates reordered rows/entries and a legitimate period-lock transition', async () => {
    const server = new Server(); const data = server.report.employees[1].time_attendance_employee_timesheet;
    data.entries[0].comment = 'Private fixture note'; data.comments = 'Private fixture note';
    const f = await fixture(server);
    server.onSubmit = () => { server.report.employees.reverse(); for (const row of server.report.employees) { row.rowId = 'new-row-id'; row.time_attendance_employee_timesheet.entries.reverse(); row.time_attendance_employee_timesheet.hasHistory = true; } };
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).resolves.toMatchObject({ status: 'verified' });
    expect(JSON.stringify(server.report)).toContain('Private fixture note'); expect(server.writes).toHaveLength(1);
  });
  it.each(['reviewId', 'connectionId', 'accountKey', 'contentFingerprint', 'eligibilityFingerprint', 'confirmed'] as const)('refuses a missing or mismatched consent %s without dispatch', async field => {
    const f = await fixture(); const approval = { ...consent(f.review), [field]: field === 'confirmed' ? false : 'stale' } as SubmissionConsent;
    await expect(f.adapter.submitMonth(f.connection, f.review, approval, hooks())).rejects.toThrow('ausdrücklich'); expect(f.server.writes).toHaveLength(0);
  });
  it.each(['hasMissingEntries', 'hasMissingFutureEntries', 'hasPendingTimeOffRequests', 'hasOverlappingApprovedPaidTimeOffRequestsAndAttendance', 'hasInvalidProjectOrTask', 'isAutoSubmitTimesheet'] as const)('blocks %s, and never silently overrides it', async key => {
    const server = new Server(); server.summary[key] = true; const f = await fixture(server);
    expect(f.review.canSubmit).toBe(false); expect(f.review.issues.length).toBeGreaterThan(0);
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).rejects.toThrow(); expect(server.writes).toHaveLength(0);
  });
  it.each([['breakViolationCounter', 1], ['isSubmittable', false], ['isSubmittable', undefined], ['hasMissingEntries', null], ['breakViolationCounter', '0']])('fails closed on eligibility %s=%s', async (key, value) => {
    const server = new Server(); server.summary[String(key)] = value; const f = await fixture(server);
    expect(f.review.canSubmit).toBe(false); expect(f.review.issues.length).toBeGreaterThan(0); expect(server.writes).toHaveLength(0);
  });
  it.each([false, true])('identifies an empty ordinary workday even when hasMissingEntries=%s', async missing => {
    const server = new Server(); const data = server.report.employees[2].time_attendance_employee_timesheet;
    data.entries = []; data.hoursWorked = '0h 00m'; data.entryStatus = 'NoEntries'; server.summary.hasMissingEntries = missing;
    const f = await fixture(server);
    expect(f.review).toMatchObject({ canSubmit: false, netMinutes: 160 * 60 });
    expect(f.review.issues.join('\n')).toContain('2026-11-03');
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).rejects.toThrow(); expect(server.writes).toHaveLength(0);
  });
  it('does not invent missing-day locations when only the server summary reports an issue', async () => {
    const server = new Server(); server.summary.hasMissingFutureEntries = true; const f = await fixture(server);
    expect(f.review.canSubmit).toBe(false);
    expect(f.review.issues.join('\n')).toContain('ohne die betroffenen Tage eindeutig zu nennen');
    expect(f.review.issues.join('\n')).not.toMatch(/2026-11-\d{2}/); expect(server.writes).toHaveLength(0);
  });
  it('shows the exact unreadable day and safe parser reason without disclosing a note or inventing zero hours', async () => {
    const server = new Server(); const data = server.report.employees[2].time_attendance_employee_timesheet;
    data.hoursWorked = 'unknown'; data.entries[0].comment = 'Private fixture note must stay out of issues';
    const f = await fixture(server);
    expect(f.review).toMatchObject({ canSubmit: false, netMinutes: null });
    const issues = f.review.issues.join('\n');
    expect(issues).toContain('2026-11-03'); expect(issues).toContain('nicht lesbare Arbeitsstunden');
    expect(issues).not.toContain('Private fixture');
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).rejects.toThrow(); expect(server.writes).toHaveLength(0);
  });
  it.each(['absence', 'holiday'] as const)('accepts empty weekdays explicitly excluded by the HiBob %s calendar', async exclusion => {
    const server = new Server(); const data = server.report.employees[2].time_attendance_employee_timesheet;
    data.entries = []; data.hoursWorked = '0h 00m';
    if (exclusion === 'absence') Object.assign(data, { entryStatus: 'ApproveTimeoffRequest', timeOff: 'Fixture leave' });
    else { data.entryStatus = 'HolidayEvent'; data.holidayOrNonWorkingDay = 'Fixture holiday'; }
    const f = await fixture(server);
    expect(f.review).toMatchObject({ canSubmit: true, netMinutes: 160 * 60, issues: [] });
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).resolves.toHaveProperty('status', 'verified'); expect(server.writes).toHaveLength(1);
  });
  it.each(['Open', 'Locked', 'unknown', 'Submitted', 'Approved', 'PendingProjectApproval'])('does not submit an unavailable or completed %s period', async status => {
    const server = new Server(); server.period.timesheetState.timeSheetStatus = status; server.policy.allowEarlySubmission = true;
    const f = await fixture(server); expect(f.review.canSubmit).toBe(false); expect(server.writes).toHaveLength(0);
  });
  it('allows a normal rejected sheet only after a fresh complete review', async () => {
    const server = new Server(); server.period.timesheetState.timeSheetStatus = 'Rejected'; const f = await fixture(server);
    expect(f.review.canSubmit).toBe(true); await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).resolves.toHaveProperty('status', 'verified');
  });
  it('compares fresh content and eligibility before dispatch', async () => {
    const f = await fixture(); f.server.summary.hasPendingTimeOffRequests = true;
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).rejects.toThrow('Bedingungen'); expect(f.server.writes).toHaveLength(0);
    const g = await fixture(); g.server.report.employees[1].time_attendance_employee_timesheet.entries[0].comment = 'Changed fixture';
    await expect(g.adapter.submitMonth(g.connection, g.review, consent(g.review), hooks())).rejects.toThrow('Monatsstand'); expect(g.server.writes).toHaveLength(0);
  });
  it('fails before PUT when durable dispatch journaling fails', async () => {
    const f = await fixture(); const journal = hooks(); vi.mocked(journal.beforeDispatch).mockRejectedValue(new Error('Local journal unavailable'));
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal)).rejects.toThrow('journal'); expect(f.server.writes).toHaveLength(0);
  });
  it('still reconciles an accepted submission if acknowledgement journaling fails', async () => {
    const f = await fixture(); const journal = hooks(); vi.mocked(journal.acknowledged).mockRejectedValue(new Error('Local journal unavailable'));
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal)).resolves.toMatchObject({ status: 'verified' }); expect(f.server.writes).toHaveLength(1);
  });
  it('does not dispatch if account identity changes while journaling', async () => {
    const f = await fixture(); const journal = hooks(); vi.mocked(journal.beforeDispatch).mockImplementation(async () => { f.server.user.id = 'different-self'; });
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal)).resolves.toHaveProperty('status', 'failed'); expect(f.server.writes).toHaveLength(0);
  });
  it('cancels before dispatch and lets an already-sent PUT settle before readback', async () => {
    const f = await fixture(); const before = new AbortController(); const journal = hooks(); vi.mocked(journal.beforeDispatch).mockImplementation(async () => { before.abort(); f.adapter.cancel(); });
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal, undefined, before.signal)).resolves.toHaveProperty('status', 'failed'); expect(f.server.writes).toHaveLength(0);
    const g = await fixture(); const during = new AbortController(); g.server.onSubmit = () => { during.abort(); g.adapter.cancel(); };
    await expect(g.adapter.submitMonth(g.connection, g.review, consent(g.review), hooks(), undefined, during.signal)).resolves.toHaveProperty('status', 'verified');
    expect(g.server.cancel).not.toHaveBeenCalled(); expect(g.server.writes).toHaveLength(1);
  });
  it.each(['TIMEOUT', 'AUTH_REQUIRED', 'FORBIDDEN', 'RATE_LIMITED'] as const)('never retries after a dispatched %s; reads the actual outcome', async code => {
    const f = await fixture(); f.server.writeError = new SessionClientError(code, true); f.server.acceptBeforeError = true;
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).resolves.toHaveProperty('status', 'verified'); expect(f.server.writes).toHaveLength(1);
  });
  it.each(['TIMEOUT', 'NETWORK_UNAVAILABLE'] as const)('keeps dispatched %s uncertain when immediate readback is still nonterminal', async code => {
    const f = await fixture(); const journal = hooks(); f.server.writeError = new SessionClientError(code, true);
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal)).resolves.toMatchObject({ status: 'uncertain', periodStatus: 'WaitingForSubmission' });
    expect(f.server.writes).toHaveLength(1); expect(f.server.requests.filter(request => request.path === reportPath)).toHaveLength(2);
    expect(journal.beforeDispatch).toHaveBeenCalledOnce(); expect(journal.acknowledged).not.toHaveBeenCalled(); expect(f.server.opens).toHaveLength(2);
  });
  it('leaves a lost-response outcome uncertain until a later explicit review observes the late server commit', async () => {
    const f = await fixture(); f.server.writeError = new SessionClientError('TIMEOUT', true);
    // The server completes only after the first independent readback, rather
    // than treating a browser timeout as cancellation of server-side work.
    const commitLater = () => { f.server.submitted = true; f.server.period.timesheetState.timeSheetStatus = 'Submitted'; f.server.period.timesheetState.locked = true; };
    const result = await f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks());
    expect(result).toMatchObject({ status: 'uncertain', periodStatus: 'WaitingForSubmission' });
    expect(f.server.writes).toHaveLength(1);
    commitLater();
    const checked = await f.adapter.reviewSubmission(f.connection, '2026-11');
    expect(checked).toMatchObject({ period: { status: 'Submitted' }, netMinutes: 168 * 60, canSubmit: false });
    expect(result.status).toBe('uncertain'); expect(f.server.writes).toHaveLength(1);
  });
  it('marks failed, unchanged, mismatched and unreadable outcomes correctly without retries', async () => {
    const f = await fixture(); f.server.ignore = true;
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).resolves.toHaveProperty('status', 'failed'); expect(f.server.writes).toHaveLength(1);
    const g = await fixture(); g.server.onSubmit = () => { g.server.report.employees[1].time_attendance_employee_timesheet.entries[0].comment = 'Unplanned change'; };
    await expect(g.adapter.submitMonth(g.connection, g.review, consent(g.review), hooks())).resolves.toHaveProperty('status', 'uncertain'); expect(g.server.writes).toHaveLength(1);
    const h = await fixture(); h.server.verificationError = true;
    await expect(h.adapter.submitMonth(h.connection, h.review, consent(h.review), hooks())).resolves.toHaveProperty('status', 'uncertain'); expect(h.server.writes).toHaveLength(1);
  });
  it('rechecks an externally submitted month without submitting it again', async () => {
    const f = await fixture(); f.server.period.timesheetState.timeSheetStatus = 'Submitted'; f.server.period.timesheetState.locked = true;
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), hooks())).resolves.toMatchObject({ status: 'verified', periodStatus: 'Submitted' }); expect(f.server.writes).toHaveLength(0);
  });
  it('preserves an independently observed external submission if transport cleanup then fails', async () => {
    const f = await fixture(); const journal = hooks();
    f.server.period.timesheetState.timeSheetStatus = 'Approved'; f.server.period.timesheetState.locked = true;
    f.server.closeOperation.mockRejectedValueOnce(new Error('Fixture cleanup failed after a verified read'));
    await expect(f.adapter.submitMonth(f.connection, f.review, consent(f.review), journal)).resolves.toMatchObject({ status: 'verified', periodStatus: 'Approved' });
    expect(f.server.writes).toHaveLength(0); expect(journal.beforeDispatch).not.toHaveBeenCalled(); expect(journal.acknowledged).not.toHaveBeenCalled();
    await expect(f.adapter.assertIdle()).resolves.toBeUndefined();
  });
});

describe('passive submission status reads', () => {
  it('reads the exact account with a direct-only operation and closing identity check', async () => {
    const server = new Server(); const adapter = new HiBobApiAdapter({ client: server });
    const key = await submissionAccountKey(server.user.id, String(server.company.id));
    expect(await adapter.listSubmissionStatuses(key)).toMatchObject({ accountKey: key, periods: [{ month: '2026-11', status: 'WaitingForSubmission' }] });
    expect(server.requests).toHaveLength(5); expect(server.opens).toEqual([{ directOnly: true }]); expect(server.writes).toHaveLength(0);
  });
  it('reports an account mismatch without reading or retaining its periods', async () => {
    const server = new Server(); const adapter = new HiBobApiAdapter({ client: server });
    const originalKey = await submissionAccountKey(server.user.id, String(server.company.id));
    await expect(adapter.listSubmissionStatuses('other-account-key')).resolves.toMatchObject({ accountKey: originalKey, periods: [] }); expect(server.requests.some(request => request.path.endsWith('/timesheets'))).toBe(false);
    server.requests.length = 0; server.before = request => { if (request.path.endsWith('/timesheets')) server.user.id = 'different-self'; };
    const result = await adapter.listSubmissionStatuses(originalKey);
    expect(result.accountKey).not.toBe(originalKey); expect(result.periods).toEqual([]); expect(server.writes).toHaveLength(0);
  });
  it('does not reuse the booking effective-lock status for submit eligibility', () => {
    const raw = { employeeTimesheets: [{ id: 0, cycleStartDate: '2026-11-01', cycleEndDate: '2026-11-30', timesheetState: { timeSheetStatus: 'WaitingForSubmission', locked: false } }] };
    expect(parseSubmissionPeriods(raw)[0]).toMatchObject({ id: 0, locked: false, status: 'WaitingForSubmission' });
  });
  it('uses the production transport without tabs or a login window on expired sessions', async () => {
    const browser = { tabs: { create: vi.fn() }, windows: { create: vi.fn() } } as unknown as typeof chrome;
    const fetcher = vi.fn(async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    const client = new SessionClient({ rules: ATTENDANCE_API_RULES, allowBackgroundTab: true, fetch: fetcher as typeof fetch, chrome: browser, minRequestIntervalMs: 0, probe: async request => { await request({ method: 'GET', path: '/api/user' }); } });
    const adapter = new HiBobApiAdapter({ client });
    await expect(adapter.listSubmissionStatuses()).rejects.toThrow('anmelden');
    expect(browser.tabs.create).not.toHaveBeenCalled(); expect(browser.windows.create).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
