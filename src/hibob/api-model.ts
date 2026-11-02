import { t } from '../i18n';
import { getMonthDates } from '../domain/calendar';
import { netMinutes, parseTime } from '../shared/entries';
import { canonicalJson } from '../shared/json';
import type { AttendanceEntry, DaySnapshot } from '../shared/types';

export interface ApiIdentity { employeeId: string; companyId: string; employeeLabel: string; companyLabel: string; timezone: string }
export interface ApiPeriod { id: string | number; start: string; end: string; locked: boolean; status: string; lockAt?: number }
/** Complete received DTO. Unknown nonempty fields make its day unsupported. */
export type ApiEntry = Record<string, unknown>;
export interface ApiDay { snapshot: DaySnapshot; entries: ApiEntry[] }
export class ApiModelError extends Error {
  constructor(public readonly code: 'IDENTITY' | 'PERIODS' | 'REPORT', message: string) { super(message); this.name = 'ApiModelError'; }
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function id(value: unknown): value is string | number { return text(value) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function empty(value: unknown): boolean { return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0; }
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export function parseIdentity(rawUser: unknown, rawCompany: unknown): ApiIdentity {
  if (!object(rawUser) || !object(rawCompany) || !text(rawUser.id) || !id(rawUser.companyId) || !text(rawUser.displayName) || !text(rawUser.companyName) || !text(rawCompany.name) || rawUser.companyName.trim() !== rawCompany.name.trim() || rawUser.mockedRole !== false || rawUser.sessionType !== 'employee' || rawUser.state !== 'active' || rawUser.timezone !== 'Europe/Berlin') throw new ApiModelError('IDENTITY', t("Das angemeldete HiBob-Konto und die Firma können nicht eindeutig geprüft werden."));
  if (rawCompany.id !== undefined && String(rawCompany.id) !== String(rawUser.companyId)) throw new ApiModelError('IDENTITY', t("Die HiBob-Firmenangaben widersprechen sich."));
  return { employeeId: rawUser.id, companyId: String(rawUser.companyId), employeeLabel: rawUser.displayName, companyLabel: rawCompany.name, timezone: rawUser.timezone };
}

export function parsePeriods(raw: unknown): ApiPeriod[] {
  if (!object(raw) || !Array.isArray(raw.employeeTimesheets) || !raw.employeeTimesheets.length) throw new ApiModelError('PERIODS', t("HiBob hat keine lesbaren Anwesenheitszeiträume zurückgegeben."));
  const seen = new Set<string>();
  return raw.employeeTimesheets.map(period => {
    if (!object(period) || !id(period.id) || !date(period.cycleStartDate) || !date(period.cycleEndDate) || period.cycleStartDate > period.cycleEndDate || !object(period.timesheetState) || typeof period.timesheetState.locked !== 'boolean' || !text(period.timesheetState.timeSheetStatus) || seen.has(String(period.id))) throw new ApiModelError('PERIODS', t("HiBob hat einen mehrdeutigen oder unvollständigen Anwesenheitszeitraum zurückgegeben."));
    seen.add(String(period.id));
    const lockAt = period.timesheetState.lockAt;
    if (lockAt !== undefined && lockAt !== null && (typeof lockAt !== 'number' || !Number.isFinite(lockAt))) throw new ApiModelError('PERIODS', t("HiBob hat eine nicht unterstützte Anwesenheitssperre zurückgegeben."));
    return { id: period.id, start: period.cycleStartDate, end: period.cycleEndDate, locked: period.timesheetState.locked || period.timesheetState.timeSheetStatus !== 'Open', status: period.timesheetState.timeSheetStatus, ...(typeof lockAt === 'number' ? { lockAt } : {}) };
  });
}

function localTime(value: unknown, forDate: string): string | undefined {
  if (typeof value !== 'string') return;
  if (parseTime(value) !== null) return value;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00(?:\.000)?)?$/.exec(value);
  return match && match[1] === forDate && parseTime(match[2]) !== null ? match[2] : undefined;
}
function marker(value: unknown, fallback: string): string | undefined {
  if (empty(value)) return;
  if (text(value)) return value;
  if (Array.isArray(value)) return value.length ? marker(value[0], fallback) ?? fallback : undefined;
  if (object(value)) for (const field of ['name', 'displayName', 'label', 'description', 'policyTypeDisplayName']) if (text(value[field])) return value[field];
  return fallback;
}
const entryFields = new Set(['id', 'start', 'end', 'entryType', 'comment', 'reason', 'projectId', 'taskId', 'projectTracking', 'reportingMethod', 'duration', 'durationInMinutes', 'isManuallyEdited', 'offset']);
function parseEntry(entry: ApiEntry, forDate: string): { value: AttendanceEntry; problem?: string } {
  const start = localTime(entry.start, forDate); const end = localTime(entry.end, forDate);
  let problem: string | undefined;
  if ((entry.entryType !== 'work' && entry.entryType !== 'break') || !start || !end) problem = t("Ein HiBob-Eintrag enthält einen unbekannten Typ, ein abweichendes Datum oder eine unvollständige Uhrzeit.");
  if (!id(entry.id)) problem ??= t("Ein gespeicherter HiBob-Eintrag hat keine eindeutige Eintragskennung.");
  if (!empty(entry.comment) && typeof entry.comment !== 'string') problem ??= t("Ein HiBob-Eintrag hat eine nicht lesbare Notiz.");
  if (!empty(entry.reason) && !id(entry.reason)) problem ??= t("Ein HiBob-Eintrag hat einen nicht lesbaren Grund.");
  if (!empty(entry.reportingMethod) && entry.reportingMethod !== 'startEnd') problem ??= t("HiBob-Einträge mit reiner Dauer werden nicht unterstützt.");
  const metadata: string[] = [];
  for (const key of ['projectId', 'taskId', 'projectTracking']) if (!empty(entry[key])) { metadata.push(key); problem ??= t("Projekt- und Aufgabenzuordnungen müssen manuell geprüft werden."); }
  for (const key of Object.keys(entry)) if (!entryFields.has(key) && !empty(entry[key])) { metadata.push(key); problem ??= t("Ein HiBob-Eintrag enthält nicht unterstützte Zusatzdaten."); }
  if (start && end) {
    const minutes = parseTime(end)! - parseTime(start)!;
    if (minutes <= 0) problem ??= t("Ein HiBob-Eintrag überschreitet Mitternacht oder hat eine ungültige Dauer.");
    if (!empty(entry.duration) && entry.duration !== minutes * 60) problem ??= t("Die Dauer eines HiBob-Eintrags weicht von seinen Uhrzeiten ab.");
    if (!empty(entry.durationInMinutes) && entry.durationInMinutes !== minutes) problem ??= t("Die Dauer eines HiBob-Eintrags weicht von seinen Uhrzeiten ab.");
  }
  if (!empty(entry.isManuallyEdited) && typeof entry.isManuallyEdited !== 'boolean') problem ??= t("Ein HiBob-Eintrag hat nicht unterstützte Bearbeitungsangaben.");
  if (!empty(entry.offset) && (typeof entry.offset !== 'number' || !Number.isInteger(entry.offset) || Math.abs(entry.offset) > 14 * 60)) problem ??= t("Ein HiBob-Eintrag hat eine nicht unterstützte Zeitverschiebung.");
  return { value: { type: entry.entryType === 'break' ? 'break' : 'work', start: start ?? '', end: end ?? '', ...(typeof entry.comment === 'string' && entry.comment ? { note: entry.comment } : {}), ...(id(entry.reason) ? { reason: String(entry.reason) } : {}), ...(metadata.length ? { metadata: metadata.sort() } : {}) }, problem };
}
function reportedMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)h\s+(\d{2})m$/.exec(value.trim());
  const minutes = match && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
  return minutes !== null && Number.isSafeInteger(minutes) ? minutes : null;
}

export function parseReport(month: string, raw: unknown, period: ApiPeriod, policy: unknown): ApiDay[] {
  let dates: string[];
  try { dates = getMonthDates(month); } catch { throw new ApiModelError('REPORT', t("Der angeforderte Monat ist ungültig.")); }
  if (!dates.length || !object(raw) || !Array.isArray(raw.employees) || !object(policy) || dates[0] < period.start || dates.at(-1)! > period.end) throw new ApiModelError('REPORT', t("HiBob hat keinen vollständigen Bericht für den gewählten Zeitraum zurückgegeben."));
  const map = new Map<string, ApiDay>(); const entryIds = new Set<string>();
  for (const row of raw.employees) {
    if (!object(row) || typeof row.isSummary !== 'boolean') throw new ApiModelError('REPORT', t("HiBob hat eine nicht unterstützte Berichtszeile zurückgegeben."));
    if (row.isSummary) continue;
    if (!date(row.dateKey) || !dates.includes(row.dateKey) || map.has(row.dateKey) || !object(row.time_attendance_employee_timesheet)) throw new ApiModelError('REPORT', t("Im HiBob-Bericht fehlen Tage oder es gibt doppelte beziehungsweise unerwartete Datumsangaben."));
    const data = row.time_attendance_employee_timesheet;
    if (!Array.isArray(data.entries) || data.entries.some(entry => !object(entry))) throw new ApiModelError('REPORT', t("HiBob hat nicht lesbare Anwesenheitseinträge zurückgegeben."));
    const entries = clone(data.entries as ApiEntry[]);
    let problem: string | undefined;
    const parsed = entries.map(entry => {
      const result = parseEntry(entry, row.dateKey as string);
      problem ??= result.problem;
      if (id(entry.id)) { if (entryIds.has(String(entry.id))) throw new ApiModelError('REPORT', t("HiBob hat doppelte Eintragskennungen zurückgegeben.")); entryIds.add(String(entry.id)); }
      return result.value;
    }).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.type.localeCompare(b.type));
    if (policy.timesheetReportingMethod !== 'startEnd' || policy.timeFormatterType !== 'time' || policy.enforceComment === true || !object(policy.breakDeductionSettings) || policy.breakDeductionSettings.breakDeductionType !== 'manual') problem ??= t("Die aktuelle HiBob-Anwesenheitsrichtlinie wird nicht unterstützt.");
    const reported = reportedMinutes(data.hoursWorked);
    if (reported === null) problem ??= t("HiBob hat nicht lesbare Arbeitsstunden zurückgegeben.");
    if (netMinutes(parsed) === null || reported !== netMinutes(parsed)) problem ??= t("HiBob-Einträge und gemeldete Arbeitsstunden stimmen nicht überein.");
    // The native empty-cell action is not an absence. Explicit event statuses,
    // however, remain exclusion evidence even if their display labels are absent.
    const timeOffAction = typeof data.timeOff === 'string' && /^request time off$/i.test(data.timeOff.trim());
    const absence = (timeOffAction ? undefined : marker(data.timeOff, t("HiBob-Abwesenheit")))
      ?? marker(data.timeOffEntries, t("HiBob-Abwesenheit"))
      ?? (['PendingTimeoffRequset', 'ApproveTimeoffRequest'].includes(String(data.entryStatus)) ? t("HiBob-Abwesenheit") : undefined);
    const nonWorking = marker(data.holidayOrNonWorkingDay, t("Arbeitsfreier HiBob-Tag")) ?? marker(data.calendarEventsEntry, t("HiBob-Kalendereintrag"))
      ?? (['HolidayEvent', 'WeekendEvent'].includes(String(data.entryStatus)) ? t("Arbeitsfreier HiBob-Tag") : undefined);
    if (!empty(data.comments) && data.comments !== parsed.map(entry => entry.note).filter(Boolean).join('\n')) problem ??= t("HiBob hat zusätzliche Tagesnotizen, die nicht vollständig in den Einträgen enthalten sind.");
    if (!empty(data.entryReasons) && data.entryReasons !== parsed.map(entry => entry.reason).filter(Boolean).join('\n')) problem ??= t("HiBob hat zusätzliche Tagesgründe, die nicht vollständig in den Einträgen enthalten sind.");
    if (!empty(data.projects)) problem ??= t("Projekt- und Aufgabenzuordnungen müssen manuell geprüft werden.");
    if (!empty(data.alerts)) problem ??= t("HiBob meldet Anwesenheitshinweise für diesen Tag.");
    if (!['NoEntries', 'Completed', 'WeekendEvent', 'HolidayEvent', 'PendingTimeoffRequset', 'ApproveTimeoffRequest'].includes(String(data.entryStatus))) problem ??= t("HiBob hat einen nicht unterstützten Anwesenheitsstatus zurückgegeben.");
    if (data.entryStatus === 'NoEntries' && parsed.length || data.entryStatus === 'Completed' && !parsed.length) problem ??= t("Der HiBob-Anwesenheitsstatus stimmt nicht mit seinen Einträgen überein.");
    const canonicalEntries = entries.map(entry => canonicalJson(entry)!).sort();
    const fingerprint = canonicalJson({ date: row.dateKey, period, policy, entries: canonicalEntries, hoursWorked: data.hoursWorked, timeOff: data.timeOff, timeOffEntries: data.timeOffEntries, holidayOrNonWorkingDay: data.holidayOrNonWorkingDay, calendarEventsEntry: data.calendarEventsEntry, comments: data.comments, entryReasons: data.entryReasons, projects: data.projects, entryStatus: data.entryStatus, alerts: data.alerts })!;
    map.set(row.dateKey, { entries, snapshot: { date: row.dateKey, entries: parsed, editable: !period.locked && period.status === 'Open' && !problem, ...(absence ? { absence } : {}), ...(nonWorking ? { nonWorking } : {}), ...(problem ? { unsupportedReason: problem } : {}), reportedMinutes: reported, fingerprint } });
  }
  if (map.size !== dates.length || dates.some(day => !map.has(day))) throw new ApiModelError('REPORT', t("HiBob hat nicht jeden Tag des gewählten Monats zurückgegeben."));
  return dates.map(day => map.get(day)!);
}
