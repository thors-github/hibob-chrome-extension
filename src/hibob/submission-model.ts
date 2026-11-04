import { getMonthDates } from '../domain/calendar';
import { t } from '../i18n';
import { canonicalJson } from '../shared/json';
import { isSubmittedStatus, submissionHash, TIMESHEET_STATUSES } from '../shared/submission';
import type { SubmissionPeriod, TimesheetStatus } from '../shared/types';
import { ApiModelError, parsePeriods, type ApiDay } from './api-model';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Preserve the server lock separately from the booking adapter's effective lock. */
export function parseSubmissionPeriods(raw: unknown): SubmissionPeriod[] {
  const periods = parsePeriods(raw);
  const source = (raw as { employeeTimesheets: Array<Record<string, unknown>> }).employeeTimesheets;
  return periods.map(period => {
    const state = source.find(item => String(item.id) === String(period.id))!.timesheetState as Record<string, unknown>;
    const status: TimesheetStatus = TIMESHEET_STATUSES.includes(period.status as TimesheetStatus) ? period.status as TimesheetStatus : 'unknown';
    return { id: period.id, start: period.start, end: period.end, status, locked: state.locked === true };
  });
}

export function selectSubmissionPeriod(periods: SubmissionPeriod[], month: string): SubmissionPeriod {
  const dates = getMonthDates(month);
  const matching = periods.filter(period => period.start === dates[0] && period.end === dates.at(-1));
  if (matching.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(String(matching[0].id))) throw new ApiModelError('PERIODS', t('HiBob bietet keinen eindeutig zugeordneten Monatszeitraum an.'));
  return matching[0];
}

const flags = ['isSubmittable', 'hasMissingEntries', 'hasMissingFutureEntries', 'hasPendingTimeOffRequests', 'hasOverlappingApprovedPaidTimeOffRequestsAndAttendance', 'hasInvalidProjectOrTask', 'isAutoSubmitTimesheet'] as const;

/** Content deliberately excludes period status, row identity and display-only result flags. */
export async function submissionContentFingerprint(raw: unknown): Promise<string> {
  if (!object(raw) || !Array.isArray(raw.employees)) throw new ApiModelError('REPORT', t('HiBob hat keinen vollständigen Bericht für den gewählten Zeitraum zurückgegeben.'));
  const content = raw.employees.filter(row => object(row) && row.isSummary === false).map(row => {
    if (!object(row) || typeof row.dateKey !== 'string' || !object(row.time_attendance_employee_timesheet)) throw new ApiModelError('REPORT', t('HiBob hat eine nicht unterstützte Berichtszeile zurückgegeben.'));
    const data = { ...row.time_attendance_employee_timesheet };
    for (const key of ['entryStatus', 'alerts', 'hasHistory']) delete data[key];
    if (Array.isArray(data.entries)) data.entries = data.entries.map(entry => canonicalJson(entry)).sort();
    return { date: row.dateKey, data };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return submissionHash(content);
}

export async function submissionFacts(input: {
  period: SubmissionPeriod;
  policy: Record<string, unknown>;
  summary: unknown;
  raw: unknown;
  days: ApiDay[];
  editable: boolean;
  now: Date;
}): Promise<{ contentFingerprint: string; eligibilityFingerprint: string; issues: string[]; netMinutes: number | null; early: boolean }> {
  const { period, policy, days } = input;
  const summary = object(input.summary) ? input.summary : {};
  const issues: string[] = [];
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(input.now);
  const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  const early = today <= period.end;
  if (!input.editable) issues.push(t('Das Einreichen ist für dieses HiBob-Konto nicht freigegeben.'));
  if (period.locked) issues.push(t('Der HiBob-Monatsbogen ist gesperrt.'));
  if (isSubmittedStatus(period.status)) issues.push(t('Dieser Monat wurde bereits eingereicht.'));
  else if (period.status === 'Open') {
    issues.push(policy.allowEarlySubmission === true
      ? t('Die Freigabe für vorzeitiges Einreichen kann nicht vollständig geprüft werden. Bitte den Monat in HiBob einreichen oder die reguläre Abgabe abwarten.')
      : t('HiBob hat diesen Monat noch nicht zum Einreichen freigegeben.'));
  } else if (!['WaitingForSubmission', 'Rejected'].includes(period.status)) issues.push(t('Der HiBob-Abgabestatus wird nicht unterstützt.'));
  if (flags.some(flag => typeof summary[flag] !== 'boolean') || !Number.isSafeInteger(summary.breakViolationCounter) || Number(summary.breakViolationCounter) < 0) issues.push(t('HiBob hat keine vollständig prüfbaren Angaben zur Monatsabgabe zurückgegeben.'));
  if (summary.isSubmittable !== true) issues.push(t('HiBob erlaubt die Monatsabgabe derzeit nicht.'));
  // A permissive or incomplete summary must never turn a visibly empty regular
  // workday into a complete month. Account calendars and absences remain valid
  // exclusions; no zero hours are invented for unreadable records.
  const emptyWorkdays = days.filter(day => {
    const weekday = new Date(`${day.snapshot.date}T12:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5 && !day.entries.length && !day.snapshot.absence && !day.snapshot.nonWorking;
  });
  if (emptyWorkdays.length) issues.push(t('Vollständige Anwesenheitseinträge fehlen für {dates}.', { dates: emptyWorkdays.map(day => day.snapshot.date).join(', ') }));
  else if (summary.hasMissingEntries === true || summary.hasMissingFutureEntries === true) issues.push(t('HiBob meldet fehlende Einträge, ohne die betroffenen Tage eindeutig zu nennen. Bitte die Tageshinweise in HiBob prüfen.'));
  if (summary.hasPendingTimeOffRequests === true) issues.push(t('Es gibt noch offene Abwesenheitsanträge. Bitte diese zuerst in HiBob klären.'));
  if (summary.hasOverlappingApprovedPaidTimeOffRequestsAndAttendance === true) issues.push(t('Anwesenheit und genehmigte Abwesenheit überschneiden sich.'));
  if (summary.hasInvalidProjectOrTask === true) issues.push(t('HiBob meldet ungültige Projekt- oder Aufgabenzuordnungen.'));
  if (Number(summary.breakViolationCounter) > 0) issues.push(t('HiBob meldet Pausenverstöße. Dieser Sonderfall muss direkt in HiBob bestätigt werden.'));
  if (summary.isAutoSubmitTimesheet === true && period.status !== 'Rejected') issues.push(t('HiBob verwaltet die automatische Monatsabgabe. Bitte den Status dort prüfen.'));
  for (const day of days) if (day.snapshot.unsupportedReason) issues.push(t('Tagesdaten für {date} nicht prüfbar: {reason}', { date: day.snapshot.date, reason: day.snapshot.unsupportedReason }));
  const minutes = days.reduce<number | null>((sum, day) => sum === null || day.snapshot.reportedMinutes === null || day.snapshot.reportedMinutes === undefined ? null : sum + day.snapshot.reportedMinutes, 0);
  if (minutes === null) issues.push(t('Die gespeicherte Nettozeit ist nicht vollständig lesbar.'));
  const eligibility = Object.fromEntries(flags.map(flag => [flag, summary[flag] ?? null]));
  return {
    contentFingerprint: await submissionContentFingerprint(input.raw),
    eligibilityFingerprint: await submissionHash({ period, policy, editable: input.editable, summary: { ...eligibility, breakViolationCounter: summary.breakViolationCounter ?? null } }),
    issues: [...new Set(issues)], netMinutes: minutes, early,
  };
}
