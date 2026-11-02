import { t } from '../i18n';
import { assertApplyAuthorization, contextFingerprint } from '../shared/context';
import { netMinutes, parseTime } from '../shared/entries';
import { canonicalJson } from '../shared/json';
import type { AdapterProgress, ApiConnection, ApplyAuthorization, AttendanceContext, AttendanceEntry, DayPlan, DaySnapshot, MonthSnapshot, PreflightResult } from '../shared/types';
import { SessionClient, SessionClientError, type ApiEndpointRule, type ApiHttpRequest, type SessionConnection, type SessionRequest } from './session-client';
import { ApiModelError, parseIdentity, parsePeriods, parseReport, type ApiIdentity, type ApiPeriod, type ApiDay } from './api-model';

/** Exact routes observed in HiBob's shipped client; POST report searches are read-only. */
export const ATTENDANCE_API_RULES: readonly ApiEndpointRule[] = [
  { method: 'GET', path: '/api/user', mutation: false },
  { method: 'GET', path: '/api/company', mutation: false },
  { method: 'GET', path: '/api/permissions/authorizations/domains/timeAttendance', mutation: false },
  { method: 'GET', path: /^\/api\/attendance\/employees\/[A-Za-z0-9_-]{1,128}\/timesheets$/, mutation: false },
  { method: 'POST', path: /^\/api\/attendance\/employees\/[A-Za-z0-9_-]{1,128}\/timesheets\/[A-Za-z0-9_-]{1,128}\/details$/, mutation: false },
  { method: 'POST', path: '/api/company/views/search?idsOnly=false', mutation: false },
  { method: 'POST', path: /^\/api\/attendance\/employees\/[A-Za-z0-9_-]{1,128}\/attendance\/entries\?forDate=\d{4}-\d{2}-\d{2}$/, mutation: true },
];
const fields = ['alerts', 'date', 'holidayOrNonWorkingDay', 'timeOff', 'hoursWorked', 'entryDisplay', 'entryStatus', 'entries', 'timeOffEntries', 'calendarEventsEntry', 'hasHistory', 'paidHours', 'unpaidBreak', 'paidTimeoff', 'eligibleHolidayPremiumPay', 'nonWorkingDayPremiumPay', 'eligibleNonWorkingDayPremiumPay', 'entryReasons', 'comments', 'projects'];
export const reportRequest = (employeeId: string, timesheetId: string | number): ApiHttpRequest => ({
  method: 'POST', path: '/api/company/views/search?idsOnly=false', body: {
    instructions: [{ values: ['Active'], operator: 'text_equals', fieldPath: '/internal/status' }],
    fields: fields.map(field => `/time_attendance_employee_timesheet/${field}`), sortBy: '/root/displayName', changes: null,
    displayPreferences: { columnsProperties: [], dateFormat: null, includeFlatJson: false, includeHumanReadable: false, supportErrorWrapping: true, exportConfiguration: null, columnWidths: {} },
    employeeId, timesheetId, type: 'time_attendance_employee_timesheet',
  },
});
interface Client {
  connect(signal?: AbortSignal): Promise<SessionConnection>;
  disconnect(): Promise<void>;
  openOperation(signal?: AbortSignal): Promise<SessionConnection>;
  closeOperation(): Promise<void>;
  request<T = unknown>(request: ApiHttpRequest, signal?: AbortSignal): Promise<T>;
  cancel(): void;
}
interface Options { client?: Client; now?: () => Date }
interface MonthRead { days: ApiDay[]; period: ApiPeriod; policy: Record<string, unknown>; identity: ApiIdentity }
export class ApiAdapterError extends Error { constructor(message: string, public readonly uncertain = false, public readonly connectionStatus?: 'expired' | 'unsupported') { super(message); } }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const accountChanged = () => new ApiAdapterError(t('Das HiBob-Konto oder die Sitzung hat sich geändert. Bitte erneut verbinden und den Monat einlesen.'), false, 'expired');

/** HTTP-only adapter. No path to HiBob's DOM writer, Save, Submit, or attendance deletion. */
export class HiBobApiAdapter {
  private readonly client: Client;
  private readonly now: () => Date;
  private busy = false;
  private verifying = false;
  private generation?: string;
  constructor(options: Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.client = options.client ?? new SessionClient({ rules: ATTENDANCE_API_RULES, allowBackgroundTab: true, probe: async (request, signal) => { await this.identity(request, signal); } });
  }
  private check(signal?: AbortSignal) { if (signal?.aborted) throw new ApiAdapterError(t('Vorgang vor dem Schreiben abgebrochen.')); }
  private async identity(request: SessionRequest = (r, s) => this.client.request(r, s), signal?: AbortSignal): Promise<ApiIdentity> {
    this.check(signal);
    const user = await request({ method: 'GET', path: '/api/user' }, signal);
    const company = await request({ method: 'GET', path: '/api/company' }, signal);
    this.check(signal);
    return parseIdentity(user, company);
  }
  private async permissions(signal?: AbortSignal): Promise<boolean> {
    const result = await this.client.request({ method: 'GET', path: '/api/permissions/authorizations/domains/timeAttendance' }, signal);
    if (!obj(result) || !obj(result.permissions) || !Array.isArray(result.permissions.timeAttendance)) throw new ApiAdapterError(t('HiBob hat nicht vollständig lesbare Attendance-Berechtigungen zurückgegeben.'));
    return result.permissions.timeAttendance.some(p => obj(p) && p.resource === 'timeAttendance' && p.filter === 'self' && p.action === 'editSheet');
  }
  private verifyIdentity(connection: ApiConnection, identity: ApiIdentity) {
    if (connection.status !== 'connected' || !connection.capabilities?.read || !connection.generation || connection.employeeId !== identity.employeeId || connection.companyId !== identity.companyId || this.generation && this.generation !== connection.generation) throw accountChanged();
    this.generation = connection.generation;
  }
  private async operation<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ApiAdapterError(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    this.busy = true;
    try { const connection = await this.client.openOperation(signal); this.transportMode = connection.mode === 'tab' ? 'temporary-tab' : 'direct'; this.check(signal); return await action(); }
    catch (error) { throw this.localized(error); }
    finally { try { await this.client.closeOperation(); } finally { this.busy = false; this.verifying = false; } }
  }
  async connect(signal?: AbortSignal): Promise<ApiConnection> {
    if (this.busy) throw new ApiAdapterError(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    try {
      await this.client.disconnect(); this.generation = undefined;
      await this.client.connect(signal);
      return await this.operation(signal, async () => {
        const identity = await this.identity(undefined, signal);
        const editable = await this.permissions(signal);
        this.generation = crypto.randomUUID();
        return { status: 'connected', generation: this.generation, employeeId: identity.employeeId, companyId: identity.companyId, employeeLabel: identity.employeeLabel, companyLabel: identity.companyLabel, transport: this.transportMode, capabilities: { read: true, write: editable, overwrite: editable } };
      });
    } catch (error) { throw this.localized(error); }
  }
  private transportMode: 'direct' | 'temporary-tab' = 'direct';
  async disconnect() { if (this.busy) throw new ApiAdapterError(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.')); await this.client.disconnect(); this.generation = undefined; }
  cancel() { if (!this.verifying) this.client.cancel(); }
  async assertIdle() { if (this.busy) throw new ApiAdapterError(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.')); }
  async recover(_connection: ApiConnection, _jobId: string) { await this.assertIdle(); }
  private path(identity: ApiIdentity) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.employeeId)) throw new ApiAdapterError(t('Die HiBob-Kontozuordnung ist nicht unterstützt.'));
    return `/api/attendance/employees/${identity.employeeId}`;
  }
  private context(connection: ApiConnection): AttendanceContext {
    return { mode: 'api-session', connectionId: connection.generation, employeeKey: connection.employeeId!, tenantKey: connection.companyId! };
  }
  private async read(connection: ApiConnection, month: string, signal?: AbortSignal): Promise<MonthRead> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiAdapterError(t('Ungültiger Monat.'));
    const identity = await this.identity(undefined, signal); this.verifyIdentity(connection, identity);
    const periods = parsePeriods(await this.client.request({ method: 'GET', path: `${this.path(identity)}/timesheets` }, signal));
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    const candidates = periods.filter(p => p.start === `${month}-01` && p.end === `${month}-${last}`);
    if (candidates.length !== 1) throw new ApiAdapterError(t('HiBob bietet keinen eindeutig zugeordneten Monatszeitraum an.'));
    const period = candidates[0];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(period.id))) throw new ApiAdapterError(t('Der HiBob-Monatszeitraum ist nicht unterstützt.'));
    const details = await this.client.request({ method: 'POST', path: `${this.path(identity)}/timesheets/${period.id}/details`, body: { fields: ['policyDetails'] } }, signal);
    if (!obj(details) || !obj(details.policyDetails)) throw new ApiAdapterError(t('Die HiBob-Anwesenheitsrichtlinie ist nicht vollständig lesbar.'));
    const policy = { ...details.policyDetails, __timezone: identity.timezone };
    const raw = await this.client.request(reportRequest(identity.employeeId, period.id), signal);
    this.check(signal);
    return { days: parseReport(month, raw, period, policy), policy, period, identity };
  }
  async scanMonth(connection: ApiConnection, month: string, progress?: (p: AdapterProgress) => void, signal?: AbortSignal): Promise<MonthSnapshot> {
    return this.operation(signal, async () => {
      progress?.({ phase: 'scan', completed: 0, total: 1, message: t('Lese HiBob-Monatsdaten über die API …') });
      const read = await this.read(connection, month, signal);
      this.verifyIdentity(connection, await this.identity(undefined, signal));
      progress?.({ phase: 'scan', completed: 1, total: 1, message: t('HiBob-Monat über die API eingelesen') });
      return { month, employeeLabel: read.identity.employeeLabel, periodLabel: `${read.period.start}–${read.period.end}`, scannedAt: this.now().toISOString(), source: 'hibob', context: this.context(connection), days: read.days.map(d => d.snapshot) };
    });
  }
  private validateDay(connection: ApiConnection, day: DayPlan, context: AttendanceContext | undefined, authorization: ApplyAuthorization, read: MonthRead, signal?: AbortSignal): ApiDay {
    this.check(signal); this.verifyIdentity(connection, read.identity);
    if (contextFingerprint(context) !== contextFingerprint(this.context(connection))) throw accountChanged();
    assertApplyAuthorization(context, authorization);
    if (!day.eligible || !['create', 'overwrite'].includes(day.action) || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new ApiAdapterError(t('Dieser Tag ist nicht zum Schreiben freigegeben.'));
    const current = read.days.find(d => d.snapshot.date === day.date);
    if (!current || current.snapshot.fingerprint !== day.fingerprint || !current.snapshot.editable || current.snapshot.absence || current.snapshot.nonWorking || current.snapshot.unsupportedReason) throw new ApiAdapterError(t('Der Tag hat sich seit der Vorschau geändert oder ist nicht vollständig bearbeitbar. Bitte neu einlesen.'));
    if (day.action === 'create' && current.entries.length) throw new ApiAdapterError(t('Der Tag enthält inzwischen Einträge.'));
    if (read.policy.allowFutureEntries !== true && day.date > this.dateInZone(this.now(), read.identity.timezone)) throw new ApiAdapterError(t('HiBob erlaubt für diesen Tag keine zukünftigen Einträge.'));
    const intervals = day.proposed.map(entry => ({ start: parseTime(entry.start), end: parseTime(entry.end) })).sort((a, b) => a.start! - b.start!);
    if (!day.proposed.length || netMinutes(day.proposed) === null || intervals.some((entry, index) => entry.start === null || entry.end === null || entry.start >= entry.end || index > 0 && entry.start < intervals[index - 1].end!) || day.proposed.some(entry => entry.reason || entry.metadata?.length)) throw new ApiAdapterError(t('Die geplanten Einträge sind unvollständig, überlappend oder nicht chronologisch.'));
    return current;
  }
  private dateInZone(date: Date, timezone: string) { const f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); const parts = f.formatToParts(date); return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-'); }
  /** Keep wall-clock values intact, with an offset derived for the selected date. */
  private offset(date: string, timezone: string): number {
    const noon = new Date(`${date}T12:00:00Z`);
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(noon).find(p => p.type === 'timeZoneName')?.value;
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(zone ?? '');
    if (!m) throw new ApiAdapterError(t('Die HiBob-Zeitzone ist nicht unterstützt.'));
    return m[1] ? -(m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  }
  private payload(day: DayPlan, before: ApiDay, timezone: string): unknown[] {
    const available = [...before.entries];
    const payload = day.proposed.map(entry => {
      const index = available.findIndex(old => old.entryType === entry.type);
      const old = index < 0 ? undefined : available.splice(index, 1)[0];
      const nonempty = (value: unknown) => value !== undefined && value !== null && value !== '';
      if (old && (old.id === undefined || old.id === null || nonempty(old.reason) || nonempty(old.projectId) || nonempty(old.taskId) || nonempty(old.projectTracking))) throw new ApiAdapterError(t('Diese bestehenden HiBob-Einträge können nicht sicher über die API ersetzt werden.'));
      return { ...(old ? { id: old.id } : {}), start: `${day.date}T${entry.start}`, end: `${day.date}T${entry.end}`, entryType: entry.type, comment: entry.note ?? '', offset: this.offset(day.date, timezone) };
    });
    if (available.length) throw new ApiAdapterError(t('Der Austausch würde bestehende Segmente löschen. Bitte den Tag manuell bereinigen und neu einlesen.'));
    return payload;
  }
  async preflightDay(connection: ApiConnection, day: DayPlan, context: AttendanceContext | undefined, authorization: ApplyAuthorization, progress?: (p: AdapterProgress) => void, signal?: AbortSignal): Promise<PreflightResult> {
    return this.operation(signal, async () => {
      const read = await this.read(connection, day.date.slice(0, 7), signal);
      const current = this.validateDay(connection, day, context, authorization, read, signal);
      this.payload(day, current, read.identity.timezone);
      this.verifyIdentity(connection, await this.identity(undefined, signal));
      progress?.({ phase: 'apply', date: day.date, completed: 1, total: 1, message: t('Tagesdaten und API-Plan ohne Speichern geprüft') });
      return { date: day.date, checked: true, saved: false, serverValidated: false, netMinutes: netMinutes(day.proposed)! };
    });
  }
  async applyDay(connection: ApiConnection, day: DayPlan, context: AttendanceContext | undefined, authorization: ApplyAuthorization, progress?: (p: AdapterProgress) => void, signal?: AbortSignal): Promise<DaySnapshot> {
    return this.operation(signal, async () => {
      if (!connection.capabilities?.write || day.action === 'overwrite' && !connection.capabilities.overwrite || !await this.permissions(signal)) throw new ApiAdapterError(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
      const read = await this.read(connection, day.date.slice(0, 7), signal);
      const current = this.validateDay(connection, day, context, authorization, read, signal);
      const body = this.payload(day, current, read.identity.timezone);
      // Revalidate account then day immediately before the single save request.
      this.verifyIdentity(connection, await this.identity(undefined, signal));
      const latest = await this.read(connection, day.date.slice(0, 7), signal);
      this.validateDay(connection, day, context, authorization, latest, signal);
      if (!await this.permissions(signal)) throw new ApiAdapterError(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
      this.verifyIdentity(connection, await this.identity(undefined, signal));
      this.check(signal);
      try {
        await this.client.request({ method: 'POST', path: `${this.path(read.identity)}/attendance/entries?forDate=${day.date}`, body }, signal);
        // Acknowledged writes get a new, strictly read-only verification lifetime.
        // The previous operation may be cancelled; it must not poison readback.
        this.verifying = true;
        await this.client.closeOperation();
        await this.client.openOperation();
        const after = await this.read(connection, day.date.slice(0, 7));
        const actual = after.days.find(d => d.snapshot.date === day.date)?.snapshot;
        const normalize = (entries: AttendanceEntry[]) => entries.map(e => ({ type: e.type, start: e.start, end: e.end, note: e.note ?? '', reason: e.reason ?? '', metadata: e.metadata ?? [] })).sort((a, b) => a.start.localeCompare(b.start) || a.type.localeCompare(b.type));
        if (!actual || actual.unsupportedReason || canonicalJson(normalize(actual.entries)) !== canonicalJson(normalize(day.proposed)) || actual.reportedMinutes !== netMinutes(day.proposed)) throw new ApiAdapterError(t('Die gespeicherten HiBob-Segmente, Zusatzdaten oder die Nettozeit weichen von der Vorschau ab. Bitte den Tag manuell prüfen.'), true);
        progress?.({ phase: 'apply', date: day.date, completed: 1, total: 1, message: t('Gespeicherte Segmente und Nettozeit geprüft') });
        return actual;
      } catch (error) {
        const localized = this.localized(error);
        throw new ApiAdapterError(localized.message, true, localized.connectionStatus);
      }
    });
  }
  private localized(error: unknown): ApiAdapterError {
    if (error instanceof ApiAdapterError) return error;
    if (error instanceof ApiModelError) return new ApiAdapterError(error.message, false, error.code === 'IDENTITY' ? 'unsupported' : undefined);
    if (!(error instanceof SessionClientError)) return new ApiAdapterError(error instanceof Error ? error.message : t('HiBob hat nicht geantwortet.'));
    const messages = {
      AUTH_REQUIRED: t('Bitte zuerst bei HiBob anmelden und die Verbindung prüfen.'), FORBIDDEN: t('HiBob hat den API-Zugriff verweigert. Bitte die Berechtigungen prüfen.'),
      HTTP_ERROR: t('HiBob hat die API-Anfrage abgelehnt.'), NETWORK_UNAVAILABLE: t('Die HiBob-API-Verbindung ist nicht verfügbar.'), TIMEOUT: t('Die HiBob-API-Anfrage hat zu lange gedauert.'),
      CANCELLED: t('Vorgang vor dem Schreiben abgebrochen.'), INVALID_RESPONSE: t('HiBob hat eine nicht unterstützte API-Antwort zurückgegeben.'), RESPONSE_TOO_LARGE: t('Die HiBob-API-Antwort ist zu groß.'),
      DOCUMENT_CHANGED: t('Die temporäre HiBob-Seite wurde geändert. Bitte erneut verbinden.'), REQUEST_DENIED: t('Dieser HiBob-API-Aufruf ist nicht freigegeben.'), BUSY: t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'), NO_OPERATION: t('Bitte zuerst bei HiBob anmelden und die Verbindung prüfen.'),
    };
    return new ApiAdapterError(messages[error.code], error.uncertain, error.code === 'AUTH_REQUIRED' ? 'expired' : undefined);
  }
}
