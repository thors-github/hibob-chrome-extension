import { t } from '../i18n';
import { assertApplyAuthorization, contextFingerprint, executionFingerprint } from '../shared/context';
import { netMinutes, parseTime } from '../shared/entries';
import { canonicalJson } from '../shared/json';
import type { AdapterProgress, ApiConnection, ApplyAuthorization, AttendanceContext, AttendanceEntry, BookingPlan, DayPlan, DaySnapshot, ExecutionProfile, MonthApplyHooks, MonthApplyResult, MonthSnapshot, PreflightResult, RunTimings } from '../shared/types';
import { assertWritablePlan } from '../shared/validation';
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
  openOperation(signal?: AbortSignal, profile?: ExecutionProfile): Promise<SessionConnection>;
  closeOperation(): Promise<void>;
  request<T = unknown>(request: ApiHttpRequest, signal?: AbortSignal): Promise<T>;
  cancel(): void;
  requestCounts?(): { requests: number; writes: number };
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
  private softWriting = false;
  private softCancelled = false;
  private readonly fallbackCounts = { requests: 0, writes: 0 };
  private generation?: string;
  /** Successful transport probe identity, usable once inside this opening only. */
  private openingIdentity?: ApiIdentity;
  constructor(options: Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.client = options.client ?? new SessionClient({ rules: ATTENDANCE_API_RULES, allowBackgroundTab: true, probe: async (request, signal) => {
      // Each transport attempt must establish its own identity, including fallback.
      this.openingIdentity = undefined;
      this.openingIdentity = await this.identity(request, signal);
    } });
  }
  private check(signal?: AbortSignal) { if (signal?.aborted) throw new ApiAdapterError(t('Vorgang vor dem Schreiben abgebrochen.')); }
  private async request<T = unknown>(request: ApiHttpRequest, signal?: AbortSignal): Promise<T> {
    this.fallbackCounts.requests++;
    if (ATTENDANCE_API_RULES.some(rule => rule.mutation && rule.method === request.method && (typeof rule.path === 'string' ? rule.path === request.path : rule.path.test(request.path)))) this.fallbackCounts.writes++;
    return this.client.request<T>(request, signal);
  }
  private counts() { return this.client.requestCounts?.() ?? { ...this.fallbackCounts }; }
  private async identity(request: SessionRequest = (r, s) => this.request(r, s), signal?: AbortSignal): Promise<ApiIdentity> {
    this.check(signal);
    const user = await request({ method: 'GET', path: '/api/user' }, signal);
    const company = await request({ method: 'GET', path: '/api/company' }, signal);
    this.check(signal);
    return parseIdentity(user, company);
  }
  private async openOperation(signal?: AbortSignal, profile: ExecutionProfile = 'strict'): Promise<SessionConnection> {
    this.openingIdentity = undefined;
    try {
      const connection = await this.client.openOperation(signal, profile);
      this.check(signal);
      return connection;
    } catch (error) {
      this.openingIdentity = undefined;
      throw error;
    }
  }
  private async openingOrFreshIdentity(signal?: AbortSignal): Promise<ApiIdentity> {
    const identity = this.openingIdentity;
    this.openingIdentity = undefined;
    this.check(signal);
    // Injected clients need not invoke a transport probe; never infer identity.
    return identity ?? this.identity(undefined, signal);
  }
  private async permissions(signal?: AbortSignal): Promise<boolean> {
    const result = await this.request({ method: 'GET', path: '/api/permissions/authorizations/domains/timeAttendance' }, signal);
    if (!obj(result) || !obj(result.permissions) || !Array.isArray(result.permissions.timeAttendance)) throw new ApiAdapterError(t('HiBob hat nicht vollständig lesbare Attendance-Berechtigungen zurückgegeben.'));
    return result.permissions.timeAttendance.some(p => obj(p) && p.resource === 'timeAttendance' && p.filter === 'self' && p.action === 'editSheet');
  }
  private verifyIdentity(connection: ApiConnection, identity: ApiIdentity) {
    if (connection.status !== 'connected' || !connection.capabilities?.read || !connection.generation || connection.employeeId !== identity.employeeId || connection.companyId !== identity.companyId || this.generation && this.generation !== connection.generation) throw accountChanged();
    this.generation = connection.generation;
  }
  private async operation<T>(signal: AbortSignal | undefined, action: () => Promise<T>, profile: ExecutionProfile = 'strict'): Promise<T> {
    if (this.busy) throw new ApiAdapterError(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    this.busy = true;
    try { const connection = await this.openOperation(signal, profile); this.transportMode = connection.mode === 'tab' ? 'temporary-tab' : 'direct'; return await action(); }
    catch (error) { throw this.localized(error); }
    finally { this.openingIdentity = undefined; try { await this.client.closeOperation(); } finally { this.openingIdentity = undefined; this.busy = false; this.verifying = false; this.softWriting = false; this.softCancelled = false; } }
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
    } catch (error) { this.openingIdentity = undefined; throw this.localized(error); }
  }
  private transportMode: 'direct' | 'temporary-tab' = 'direct';
  async disconnect() { if (this.busy) throw new ApiAdapterError(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.')); this.openingIdentity = undefined; await this.client.disconnect(); this.generation = undefined; }
  cancel() { if (this.softWriting) this.softCancelled = true; else if (!this.verifying) this.client.cancel(); }
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
    const identity = await this.openingOrFreshIdentity(signal); this.verifyIdentity(connection, identity);
    const periods = parsePeriods(await this.request({ method: 'GET', path: `${this.path(identity)}/timesheets` }, signal));
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    const candidates = periods.filter(p => p.start === `${month}-01` && p.end === `${month}-${last}`);
    if (candidates.length !== 1) throw new ApiAdapterError(t('HiBob bietet keinen eindeutig zugeordneten Monatszeitraum an.'));
    const period = candidates[0];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(period.id))) throw new ApiAdapterError(t('Der HiBob-Monatszeitraum ist nicht unterstützt.'));
    const details = await this.request({ method: 'POST', path: `${this.path(identity)}/timesheets/${period.id}/details`, body: { fields: ['policyDetails'] } }, signal);
    if (!obj(details) || !obj(details.policyDetails)) throw new ApiAdapterError(t('Die HiBob-Anwesenheitsrichtlinie ist nicht vollständig lesbar.'));
    const policy = { ...details.policyDetails, __timezone: identity.timezone };
    const raw = await this.request(reportRequest(identity.employeeId, period.id), signal);
    this.check(signal);
    return { days: parseReport(month, raw, period, policy, identity.employeeId), policy, period, identity };
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
      if (!connection.capabilities?.write || day.action === 'overwrite' && !connection.capabilities.overwrite) throw new ApiAdapterError(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
      const read = await this.read(connection, day.date.slice(0, 7), signal);
      const current = this.validateDay(connection, day, context, authorization, read, signal);
      const body = this.payload(day, current, read.identity.timezone);
      // The payload comes from this fresh validated day; recheck authorization and
      // account immediately before the single save request, with no write retry.
      if (!await this.permissions(signal)) throw new ApiAdapterError(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
      this.verifyIdentity(connection, await this.identity(undefined, signal));
      this.check(signal);
      try {
        await this.request({ method: 'POST', path: `${this.path(read.identity)}/attendance/entries?forDate=${day.date}`, body }, signal);
        // Acknowledged writes get a new, strictly read-only verification lifetime.
        // The previous operation may be cancelled; it must not poison readback.
        this.verifying = true;
        await this.client.closeOperation();
        await this.openOperation();
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
  /** A bounded month write window: serial day requests, then independent full readback. */
  async applyMonth(connection: ApiConnection, input: BookingPlan, authorization: ApplyAuthorization, hooks: MonthApplyHooks, progress?: (p: AdapterProgress) => void, signal?: AbortSignal): Promise<MonthApplyResult> {
    const plan = structuredClone(input), consent = structuredClone(authorization);
    assertWritablePlan(plan);
    if (consent.planId !== plan.id || consent.executionFingerprint !== executionFingerprint({ executionProfile: 'fast-serial' })) throw new ApiAdapterError(t('Die Freigabe gehört nicht zum schnellen Monatslauf. Bitte erneut bestätigen.'));
    assertApplyAuthorization(plan.snapshot.context, consent);
    this.check(signal);
    const started = Date.now(), initialCounts = this.counts();
    const timings: RunTimings = { preparationMs: 0, writingMs: 0, journalingMs: 0, verificationMs: 0, totalMs: 0, requests: 0, writes: 0 };
    const changes = plan.days.filter(day => day.action === 'create' || day.action === 'overwrite');
    const dispatched = new Map<string, DayPlan>();
    let result: MonthApplyResult | undefined;
    const cancelled = () => signal?.aborted === true || this.softCancelled;
    const journal = async (hook: (date: string) => Promise<void>, date: string) => {
      const at = Date.now();
      try { await hook(date); } finally { timings.journalingMs += Math.max(0, Date.now() - at); }
    };
    const normalize = (entries: AttendanceEntry[]) => canonicalJson(entries.map(entry => ({ type: entry.type, start: entry.start, end: entry.end, note: entry.note ?? '', reason: entry.reason ?? '', metadata: [...(entry.metadata ?? [])].sort() })).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.type.localeCompare(b.type)));
    try {
      result = await this.operation(undefined, async () => {
        progress?.({ phase: 'apply', stage: 'prepare', completed: 0, total: changes.length, message: t('Monat und Kontofreigabe vor dem Speichern prüfen …') });
        if (!connection.capabilities?.write || changes.some(day => day.action === 'overwrite') && !connection.capabilities.overwrite) throw new ApiAdapterError(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
        const before = await this.read(connection, plan.settings.month, signal);
        const baseline = new Map(plan.snapshot.days.map(day => [day.date, day]));
        if (plan.snapshot.month !== plan.settings.month || baseline.size !== before.days.length || baseline.size !== plan.snapshot.days.length || plan.days.length !== before.days.length
          || before.days.some(day => baseline.get(day.snapshot.date)?.fingerprint !== day.snapshot.fingerprint)
          || plan.days.some(day => baseline.get(day.date)?.fingerprint !== day.fingerprint)) throw new ApiAdapterError(t('Der Monatsstand hat sich seit der Vorschau geändert. Bitte erneut einlesen.'));
        const payloads = new Map(changes.map(day => {
          const current = this.validateDay(connection, day, plan.snapshot.context, consent, before, signal);
          if (netMinutes(day.proposed) !== day.netMinutes) throw new ApiAdapterError(t('Die geplante Nettozeit stimmt nicht mit den Tagessegmenten überein.'));
          return [day.date, this.payload(day, current, before.identity.timezone)];
        }));
        if (!await this.permissions(signal)) throw new ApiAdapterError(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
        this.verifyIdentity(connection, await this.identity(undefined, signal));
        this.check(signal);
        timings.preparationMs = Math.max(0, Date.now() - started);
        const writeStarted = Date.now(), journalBefore = timings.journalingMs;
        let failure: ApiAdapterError | undefined;
        this.softWriting = true;
        try {
          for (const day of changes) {
            if (cancelled()) break;
            await journal(date => hooks.beforeDispatch(date), day.date);
            if (cancelled()) break;
            progress?.({ phase: 'apply', stage: 'write', date: day.date, completed: dispatched.size, total: changes.length, message: t('Tagesbuchungen nacheinander senden …') });
            // The caller can cancel the next write, but never abort an in-flight
            // mutation. Its own timeout still applies; ambiguous writes are not retried.
            dispatched.set(day.date, day);
            await this.request({ method: 'POST', path: `${this.path(before.identity)}/attendance/entries?forDate=${day.date}`, body: payloads.get(day.date) });
            await journal(date => hooks.acknowledged(date), day.date);
          }
        } catch (error) {
          failure = this.localized(error);
          if (!dispatched.size) throw failure;
        } finally {
          timings.writingMs = Math.max(0, Date.now() - writeStarted - (timings.journalingMs - journalBefore));
          this.softWriting = false;
          this.verifying = true;
        }
        const stopped = cancelled();
        let message = failure?.message ?? (stopped ? t('Lauf abgebrochen. Bereits gesendete Tage werden jetzt geprüft.') : undefined);
        let connectionStatus = failure?.connectionStatus;
        const days: MonthApplyResult['days'] = [];
        if (dispatched.size) {
          const verificationStarted = Date.now();
          try {
            progress?.({ phase: 'apply', stage: 'verify', completed: 0, total: dispatched.size, message: t('Gesendete Buchungen unabhängig aus HiBob zurücklesen …') });
            await this.client.closeOperation();
            await this.openOperation(undefined, 'fast-serial');
            const after = await this.read(connection, plan.settings.month);
            if (canonicalJson(before.period) !== canonicalJson(after.period) || canonicalJson(before.policy) !== canonicalJson(after.policy)) throw new ApiAdapterError(t('Der HiBob-Zeitraum oder die Anwesenheitsrichtlinie hat sich während des Laufs geändert.'), true);
            const actual = new Map(after.days.map(day => [day.snapshot.date, day.snapshot]));
            for (const [date, day] of dispatched) {
              const saved = actual.get(date);
              if (saved && !saved.unsupportedReason && !saved.absence && !saved.nonWorking && normalize(saved.entries) === normalize(day.proposed) && saved.reportedMinutes === day.netMinutes && netMinutes(saved.entries) === day.netMinutes) {
                days.push({ date, status: 'verified', message: t('Gespeichert und erneut aus HiBob gelesen.') });
              } else if (saved?.fingerprint === baseline.get(date)?.fingerprint) {
                days.push({ date, status: 'failed', message: t('HiBob zeigt weiterhin den unveränderten Ausgangszustand. Der Tag wurde nicht erneut gesendet.') });
              } else {
                days.push({ date, status: 'uncertain', message: t('Die gespeicherten HiBob-Segmente, Zusatzdaten oder die Nettozeit weichen von der Vorschau ab. Bitte den Tag manuell prüfen.') });
              }
            }
            if (after.days.some(day => !dispatched.has(day.snapshot.date) && day.snapshot.fingerprint !== baseline.get(day.snapshot.date)?.fingerprint)) message ??= t('Ein beibehaltener oder nicht gesendeter Tag hat sich geändert. Bitte den Monat erneut prüfen.');
            if (dispatched.size === changes.length) {
              for (const week of plan.weeks) {
                const included = plan.days.filter(day => day.eligible && week.dates.includes(day.date));
                const total = included.reduce<number | null>((sum, day) => {
                  const saved = actual.get(day.date);
                  return sum === null || !saved || saved.absence || saved.nonWorking || saved.unsupportedReason || saved.reportedMinutes !== netMinutes(saved.entries) ? null : sum + saved.reportedMinutes!;
                }, 0);
                if (total !== week.plannedMinutes || plan.settings.variable && total !== week.targetMinutes) message ??= t('Die zurückgelesene Wochensumme stimmt nicht mit dem freigegebenen Ziel überein. Bitte den Monat prüfen.');
              }
            }
            if (days.some(day => day.status !== 'verified')) message ??= t('Nicht alle gesendeten Tage konnten bestätigt werden. Bitte die Ergebnisse prüfen.');
            progress?.({ phase: 'apply', stage: 'verify', completed: days.filter(day => day.status === 'verified').length, total: dispatched.size, message: t('Monatsbuchungen und Wochensummen zurückgelesen') });
          } catch (error) {
            const localized = this.localized(error);
            message = localized.message; connectionStatus = localized.connectionStatus;
            days.splice(0, days.length, ...[...dispatched.keys()].map(date => ({ date, status: 'uncertain' as const, message: localized.message })));
          } finally { timings.verificationMs = Math.max(0, Date.now() - verificationStarted); }
        }
        return result = { days, complete: !message && !stopped && dispatched.size === changes.length && days.every(day => day.status === 'verified'), stopped, ...(message ? { error: message } : {}), ...(connectionStatus ? { connectionStatus } : {}), timings };
      }, 'fast-serial');
    } catch (error) {
      if (!dispatched.size) throw this.localized(error);
      // Cleanup failures after dispatch must not erase already reconciled outcomes.
      const localized = this.localized(error);
      result ??= { days: [...dispatched.keys()].map(date => ({ date, status: 'uncertain', message: localized.message })), complete: false, stopped: cancelled(), timings };
      result.complete = false; result.error = localized.message;
      if (localized.connectionStatus) result.connectionStatus = localized.connectionStatus;
    }
    const counts = this.counts();
    timings.totalMs = Math.max(0, Date.now() - started);
    timings.requests = counts.requests - initialCounts.requests;
    timings.writes = counts.writes - initialCounts.writes;
    return result!;
  }
  private localized(error: unknown): ApiAdapterError {
    if (error instanceof ApiAdapterError) return error;
    if (error instanceof ApiModelError) return new ApiAdapterError(error.message, false, error.code === 'IDENTITY' ? 'unsupported' : undefined);
    if (!(error instanceof SessionClientError)) return new ApiAdapterError(error instanceof Error ? error.message : t('HiBob hat nicht geantwortet.'));
    const messages = {
      AUTH_REQUIRED: t('Bitte zuerst bei HiBob anmelden und die Verbindung prüfen.'), FORBIDDEN: t('HiBob hat den API-Zugriff verweigert. Bitte die Berechtigungen prüfen.'),
      RATE_LIMITED: t('HiBob begrenzt API-Anfragen. Bitte mindestens {seconds} Sekunden warten, dann den Monat erneut einlesen. Unbestätigte Buchungen nicht wiederholen.', { seconds: Math.max(1, Math.ceil((error.retryAfterMs ?? 300_000) / 1000)) }),
      HTTP_ERROR: t('HiBob hat die API-Anfrage abgelehnt.'), NETWORK_UNAVAILABLE: t('Die HiBob-API-Verbindung ist nicht verfügbar.'), TIMEOUT: t('Die HiBob-API-Anfrage hat zu lange gedauert.'),
      CANCELLED: t('Vorgang vor dem Schreiben abgebrochen.'), INVALID_RESPONSE: t('HiBob hat eine nicht unterstützte API-Antwort zurückgegeben.'), RESPONSE_TOO_LARGE: t('Die HiBob-API-Antwort ist zu groß.'),
      DOCUMENT_CHANGED: t('Die temporäre HiBob-Seite wurde geändert. Bitte erneut verbinden.'), REQUEST_DENIED: t('Dieser HiBob-API-Aufruf ist nicht freigegeben.'), BUSY: t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'), NO_OPERATION: t('Bitte zuerst bei HiBob anmelden und die Verbindung prüfen.'),
    };
    return new ApiAdapterError(messages[error.code], error.uncertain, error.code === 'AUTH_REQUIRED' ? 'expired' : undefined);
  }
}
