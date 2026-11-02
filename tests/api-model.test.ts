import { describe, expect, it } from 'vitest';
import { getMonthDates } from '../src/domain/calendar';
import { buildMonthPlan, defaultSettings } from '../src/domain';
import type { MonthSnapshot } from '../src/shared/types';
import { parseIdentity, parsePeriods, parseReport, type ApiEntry, type ApiPeriod } from '../src/hibob/api-model';

const period: ApiPeriod = { id: 0, start: '2026-11-01', end: '2026-11-30', locked: false, status: 'Open', lockAt: 1_800_000_000 };
const policy = { timesheetReportingMethod: 'startEnd', timeFormatterType: 'time', enforceComment: false, breakDeductionSettings: { breakDeductionType: 'manual' }, __timezone: 'Europe/Berlin' };
const self = { id: 'employee-fixture', companyId: 123, companyName: 'Fixture company', displayName: 'Fixture employee', timezone: 'Europe/Berlin', mockedRole: false, sessionType: 'employee', state: 'active' };
function report(month = '2026-11') {
  return { employees: getMonthDates(month).map(dateKey => ({ isSummary: false, dateKey, rowId: `random-row-${dateKey}`, time_attendance_employee_timesheet: { entries: [] as ApiEntry[], hoursWorked: '0h 00m', potentialWorkingHours: '8h 00m', timeOff: null as unknown, timeOffEntries: null as unknown, calendarEventsEntry: null as unknown, holidayOrNonWorkingDay: '', comments: '', entryReasons: '', projects: '', entryStatus: 'NoEntries', hasHistory: false, alerts: [] as unknown[] } })) };
}
function withEntries(entries: ApiEntry[]) { const raw = report(); const row = raw.employees.find(row => row.dateKey === '2026-11-03')!; row.time_attendance_employee_timesheet.entries = entries; row.time_attendance_employee_timesheet.entryStatus = 'Completed'; row.time_attendance_employee_timesheet.hoursWorked = '8h 00m'; return raw; }
const segments = (): ApiEntry[] => [
  { id: 'entry-one', entryType: 'work', start: '2026-11-03T08:00', end: '2026-11-03T12:00', duration: 14400, comment: 'Original note', reason: 'reason-fixture', reportingMethod: 'startEnd', isManuallyEdited: true },
  { id: 'entry-break', entryType: 'break', start: '12:00', end: '12:30', duration: 1800 },
  { id: 'entry-two', entryType: 'work', start: '2026-11-03T12:30:00', end: '2026-11-03T16:30:00.000', duration: 14400 },
];
const nativeReadback = (): ApiEntry[] => [
  { id: 501, entryType: 'work', start: '2026-11-03T08:00', end: '2026-11-03T12:00', duration: 14400 },
  { id: 502, entryType: 'break', start: '2026-11-03T12:00', end: '2026-11-03T12:30', duration: 1800 },
  { id: 503, entryType: 'work', start: '2026-11-03T12:30', end: '2026-11-03T16:30', duration: 14400 },
].map(entry => ({ ...entry, employeeId: self.id, source: 'employeeManuallyEdit', reportingMethod: 'startEnd', isManuallyEdited: true, projectTracking: null, comment: '', reason: null }));
const day = (raw: unknown, alternatePolicy: unknown = policy, alternatePeriod = period) => parseReport('2026-11', raw, alternatePeriod, alternatePolicy).find(day => day.snapshot.date === '2026-11-03')!;

describe('authenticated own identity and periods', () => {
  it('checks the own employee session and company without inventing company.id', () => {
    expect(parseIdentity(self, { name: 'Fixture company' })).toEqual({ employeeId: self.id, companyId: '123', employeeLabel: self.displayName, companyLabel: self.companyName, timezone: 'Europe/Berlin' });
    expect(parseIdentity({ ...self, companyId: 'company-string-id' }, { id: 'company-string-id', name: self.companyName }).companyId).toBe('company-string-id');
  });
  it.each([
    { mockedRole: true }, { mockedRole: undefined }, { sessionType: 'supporter' }, { state: 'inactive' }, { timezone: 'UTC' }, { id: '' }, { companyId: null }, { displayName: '' }, { companyName: 'Another company' },
  ])('blocks incomplete, delegated or mismatched identity: %j', change => {
    expect(() => parseIdentity({ ...self, ...change }, { name: self.companyName })).toThrow();
  });
  it('rejects a contradictory supplied company ID', () => { expect(() => parseIdentity(self, { name: self.companyName, id: 999 })).toThrow(); });
  it('accepts timesheet ID zero and locks non-open cycles', () => {
    const raw = { employeeTimesheets: [{ id: 0, cycleStartDate: period.start, cycleEndDate: period.end, timesheetState: { timeSheetStatus: 'Open', locked: false, lockAt: period.lockAt } }, { id: 1, cycleStartDate: '2026-10-01', cycleEndDate: '2026-10-31', timesheetState: { timeSheetStatus: 'Submitted', locked: false } }] };
    expect(parsePeriods(raw)).toEqual([period, { id: 1, start: '2026-10-01', end: '2026-10-31', locked: true, status: 'Submitted' }]);
    expect(() => parsePeriods({ employeeTimesheets: [raw.employeeTimesheets[0], raw.employeeTimesheets[0]] })).toThrow();
    expect(() => parsePeriods({ employeeTimesheets: [{ ...raw.employeeTimesheets[0], cycleEndDate: '2026-11-31' }] })).toThrow();
  });
});

describe('complete, strict attendance reports', () => {
  it('accepts the observed manual readback provenance only with independently verified entry ownership', () => {
    const entries = nativeReadback();
    const parsed = parseReport('2026-11', withEntries(entries), period, policy, self.id)[2];
    expect(parsed.snapshot.editable).toBe(true); expect(parsed.snapshot.unsupportedReason).toBeUndefined();
    expect(parsed.snapshot.reportedMinutes).toBe(480);
    expect(parsed.snapshot.entries).toEqual([{ type: 'work', start: '08:00', end: '12:00' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }]);
    expect(parsed.snapshot.entries.every(entry => !entry.metadata)).toBe(true);
    expect(parsed.entries).toEqual(entries);
    expect(parsed.snapshot.fingerprint).toContain(self.id); expect(parsed.snapshot.fingerprint).toContain('employeeManuallyEdit');
    const withoutMarkers = nativeReadback(); withoutMarkers.forEach(entry => { delete entry.employeeId; delete entry.source; });
    const old = parseReport('2026-11', withEntries(withoutMarkers), period, policy)[2];
    expect(old.snapshot.entries).toEqual(parsed.snapshot.entries);
    expect(old.snapshot.fingerprint).not.toBe(parsed.snapshot.fingerprint);
  });
  it.each([undefined, '', 'other-authenticated-employee'])('rejects employee ownership when expected identity is missing or different: %s', expected => {
    expect(() => parseReport('2026-11', withEntries(nativeReadback()), period, policy, expected)).toThrow('Konto');
  });
  it.each(['another-employee', null, '', 123, false, { id: self.id }])('rejects a present entry employeeId that is not exactly self: %j', employeeId => {
    const entries = nativeReadback(); entries[0].employeeId = employeeId;
    expect(() => parseReport('2026-11', withEntries(entries), period, policy, self.id)).toThrow('Konto');
  });
  it.each(['otherSource', 'EmployeeManuallyEdit', 'employeeManuallyEdit ', null, '', 0, false, [], { type: 'employeeManuallyEdit' }])('does not treat an unknown provenance value as harmless metadata: %j', source => {
    const entries = nativeReadback(); entries[0].source = source;
    const parsed = parseReport('2026-11', withEntries(entries), period, policy, self.id)[2];
    expect(parsed.snapshot.editable).toBe(false); expect(parsed.snapshot.unsupportedReason).toBeTruthy();
    expect(parsed.snapshot.entries[0].metadata).toContain('source'); expect(parsed.entries[0].source).toEqual(source);
  });
  it.each([{ isManuallyEdited: false }, { isManuallyEdited: undefined }, { isManuallyEdited: null }, { isManuallyEdited: 'true' }, { reportingMethod: undefined }, { reportingMethod: null }, { reportingMethod: '' }, { reportingMethod: 'duration' }])('rejects manual provenance inconsistent with its observed edit/reporting markers: %j', change => {
    const entries = nativeReadback(); Object.assign(entries[0], change);
    const parsed = parseReport('2026-11', withEntries(entries), period, policy, self.id)[2];
    expect(parsed.snapshot.editable).toBe(false); expect(parsed.snapshot.unsupportedReason).toBeTruthy();
    expect(parsed.snapshot.entries[0].metadata).toContain('source');
  });
  it('keeps rejecting additional server data even with the known ownership and provenance fields', () => {
    const entries = nativeReadback(); entries[0].unknownServerData = { value: 'synthetic' };
    const parsed = parseReport('2026-11', withEntries(entries), period, policy, self.id)[2];
    expect(parsed.snapshot.editable).toBe(false); expect(parsed.snapshot.entries[0].metadata).toEqual(['unknownServerData']);
    expect(parsed.entries).toEqual(entries);
  });
  it('reads every date, skips explicit summaries and retains raw DTOs without random row IDs', () => {
    const raw = report(); const summary = { isSummary: true, dateKey: null }; (raw.employees as unknown[]).push(summary);
    const parsed = parseReport('2026-11', raw, period, policy);
    expect(parsed).toHaveLength(30); expect(parsed.every(day => day.snapshot.editable && day.snapshot.reportedMinutes === 0 && !day.snapshot.unsupportedReason)).toBe(true);
    expect(parsed[0].snapshot.fingerprint).not.toContain('random-row');
  });
  it('preserves stable entry IDs, notes and reasons, with eight net hours', () => {
    const entries = segments(); const parsed = day(withEntries(entries));
    expect(parsed.snapshot.editable).toBe(true); expect(parsed.snapshot.unsupportedReason).toBeUndefined(); expect(parsed.snapshot.reportedMinutes).toBe(480);
    expect(parsed.snapshot.entries).toEqual([{ type: 'work', start: '08:00', end: '12:00', note: 'Original note', reason: 'reason-fixture' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }]);
    expect(parsed.entries).toEqual(entries); expect(parsed.entries).not.toBe(entries);
  });
  it('keeps fingerprint stable on entry reordering and row recreation, but changes it for entry IDs, metadata, policy and lock state', () => {
    const raw = withEntries(segments()); const baseline = day(raw).snapshot.fingerprint;
    raw.employees.forEach(row => { row.rowId = 'new-random-UUID'; }); raw.employees[2].time_attendance_employee_timesheet.entries.reverse();
    expect(day(raw).snapshot.fingerprint).toBe(baseline);
    raw.employees[2].time_attendance_employee_timesheet.entries[0].id = 'new-stable-entry-id'; expect(day(raw).snapshot.fingerprint).not.toBe(baseline);
    expect(day(withEntries(segments()), { ...policy, addedRule: true }).snapshot.fingerprint).not.toBe(baseline);
    expect(day(withEntries(segments()), { ...policy, __timezone: 'UTC' }).snapshot.fingerprint).not.toBe(baseline);
    expect(day(withEntries(segments()), policy, { ...period, locked: true }).snapshot.fingerprint).not.toBe(baseline);
  });
  it.each(['missing', 'duplicate', 'unexpected', 'unreadable', 'unlabelled'] as const)('rejects an incomplete/ambiguous month: %s', kind => {
    const raw = report();
    if (kind === 'missing') raw.employees.pop();
    if (kind === 'duplicate') raw.employees.push(raw.employees[0]);
    if (kind === 'unexpected') raw.employees[0].dateKey = '2026-12-01';
    if (kind === 'unreadable') (raw.employees[0].time_attendance_employee_timesheet.entries as unknown[]) = [null];
    if (kind === 'unlabelled') (raw.employees[0] as unknown as Record<string, unknown>).isSummary = undefined;
    expect(() => parseReport('2026-11', raw, period, policy)).toThrow();
  });
  it.each([
    { entryType: 'unknown' }, { start: null }, { start: '8:00' }, { start: '2026-11-02T08:00' }, { start: '2026-11-03T08:00:01' }, { start: '2026-11-03T08:00Z' }, { end: '2026-11-04T12:00' }, { end: '07:00' }, { id: null }, { duration: 480 }, { reportingMethod: 'duration' }, { durationInMinutes: 239 }, { comment: { private: true } }, { reason: { id: 'reason-fixture' } }, { unknownServerProperty: 'preserved' }, { projectId: 4 }, { taskId: 5 }, { projectTracking: { projectId: 4 } }, { offset: 9999 },
  ])('preserves but blocks an unsupported entry: %j', change => {
    const entries = segments(); entries[0] = { ...entries[0], ...change };
    const parsed = day(withEntries(entries)); expect(parsed.snapshot.editable).toBe(false); expect(parsed.snapshot.unsupportedReason).toBeTruthy(); expect(parsed.entries[0]).toEqual(entries[0]);
  });
  it('rejects globally duplicated stable entry identifiers rather than allowing the first occurrence', () => {
    const raw = withEntries(segments()); raw.employees[3].time_attendance_employee_timesheet.entries = [{ ...segments()[0], start: '08:00', end: '12:00' }];
    expect(() => parseReport('2026-11', raw, period, policy)).toThrow();
  });
  it.each(['7h 59m', '8.0', '', null])('blocks reported hours that are unreadable or inconsistent: %s', hours => {
    const raw = withEntries(segments()); raw.employees[2].time_attendance_employee_timesheet.hoursWorked = hours as string;
    expect(day(raw).snapshot.editable).toBe(false);
  });
  it('blocks overlapping work and changes in record completeness', () => {
    const entries = segments(); entries[2].start = '11:30'; entries[2].duration = 18000;
    expect(day(withEntries(entries)).snapshot.editable).toBe(false);
    const raw = withEntries(segments()); raw.employees[2].time_attendance_employee_timesheet.entryStatus = 'NoEntries'; expect(day(raw).snapshot.editable).toBe(false);
  });
  it('detects full or partial absences and non-working calendar events', () => {
    const raw = report(); const value = raw.employees[2].time_attendance_employee_timesheet;
    value.timeOffEntries = [{ name: 'Partial leave', hours: 2 }]; expect(day(raw).snapshot.absence).toBe('Partial leave');
    value.timeOff = 'Holiday leave'; expect(day(raw).snapshot.absence).toBe('Holiday leave');
    value.calendarEventsEntry = { name: 'Office closure' }; expect(day(raw).snapshot.nonWorking).toBe('Office closure');
    value.holidayOrNonWorkingDay = 'Non working day'; expect(day(raw).snapshot.nonWorking).toBe('Non working day');
  });
  it.each(['HolidayEvent', 'WeekendEvent', 'PendingTimeoffRequset', 'ApproveTimeoffRequest'])('never plans a booking for an explicit %s with missing display details', status => {
    const raw = report(); raw.employees[2].time_attendance_employee_timesheet.entryStatus = status;
    const parsed = parseReport('2026-11', raw, period, policy);
    const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Fixture', periodLabel: 'November', scannedAt: '2026-11-02', source: 'hibob', context: { mode: 'api-session', connectionId: 'fixture-connection', employeeKey: 'fixture-employee', tenantKey: 'fixture-company' }, days: parsed.map(day => day.snapshot) };
    const candidate = buildMonthPlan(defaultSettings('2026-11'), snapshot, {}, 1).days.find(day => day.date === '2026-11-03')!;
    expect(candidate.action).toBe('skip'); expect(candidate.eligible).toBe(false); expect(candidate.proposed).toEqual([]);
    const marker = status.includes('Timeoff') ? parsed[2].snapshot.absence : parsed[2].snapshot.nonWorking;
    expect(marker).toBeTruthy(); expect(candidate.reason).toContain(marker);
  });
  it('does not mistake the normal Request time off action for leave, while retaining explicit status evidence', () => {
    const raw = report(); const value = raw.employees[2].time_attendance_employee_timesheet;
    value.timeOff = 'Request time off'; expect(day(raw).snapshot.absence).toBeUndefined(); expect(day(raw).snapshot.editable).toBe(true);
    value.entryStatus = 'PendingTimeoffRequset'; expect(day(raw).snapshot.absence).toBeTruthy();
    value.entryStatus = 'NoEntries'; value.timeOffEntries = [{ name: 'Partial leave' }]; expect(day(raw).snapshot.absence).toBe('Partial leave');
  });
  it.each([
    { timesheetReportingMethod: 'duration' }, { timeFormatterType: 'decimal' }, { enforceComment: true }, { breakDeductionSettings: { breakDeductionType: 'automatic' } },
  ])('blocks incompatible attendance policies: %j', change => { expect(day(report(), { ...policy, ...change }).snapshot.editable).toBe(false); });
  it('marks alerts and additional day notes/reasons/projects unsupported instead of silently dropping them', () => {
    for (const change of [{ alerts: [{ warning: true }] }, { comments: 'Additional day note' }, { entryReasons: 'Extra reason' }, { projects: 'Project one' }, { entryStatus: 'NewUnknownStatus' }]) {
      const raw = report(); Object.assign(raw.employees[2].time_attendance_employee_timesheet, change); expect(day(raw).snapshot.editable).toBe(false); expect(day(raw).snapshot.unsupportedReason).toBeTruthy();
    }
  });
  it('does not hide extra aggregate notes or reasons behind a different known entry value', () => {
    const raw = withEntries(segments()); const value = raw.employees[2].time_attendance_employee_timesheet;
    value.comments = 'Original note'; value.entryReasons = 'reason-fixture';
    expect(day(raw).snapshot.editable).toBe(true);
    value.comments = 'A different extra note'; expect(day(raw).snapshot.editable).toBe(false);
    value.comments = 'Original note'; value.entryReasons = 'unrepresented reason'; expect(day(raw).snapshot.editable).toBe(false);
  });
  it('keeps locked cycles read-only and supports leap-month date completeness', () => {
    expect(day(report(), policy, { ...period, locked: true }).snapshot.editable).toBe(false);
    expect(parseReport('2028-02', report('2028-02'), { ...period, start: '2028-02-01', end: '2028-02-29' }, policy)).toHaveLength(29);
  });
});
