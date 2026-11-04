import { t } from './i18n';
import { isSubmittedStatus, TIMESHEET_STATUSES } from './shared/submission';
import type { ReminderState, SubmissionStatusRead, TimesheetStatus } from './shared/types';

export const REMINDER_ALARM = 'hibob-monthly-submission-reminder';
export const REMINDER_STORAGE_KEY = 'reminderState';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
interface CachedStatus { status: TimesheetStatus; checkedAt: string }
interface AccountCache {
  trackedSinceMonth: string;
  statuses: Record<string, CachedStatus>;
  /** Older absent records were independently confirmed complete before pruning. */
  archiveBeforeMonth?: string;
  lastAttemptAt?: string;
  lastCheckedAt?: string;
  retryNotBeforeAt?: string;
}
interface StoredReminders { schemaVersion: 1; enabled: boolean; activeAccountKey?: string; accounts: Record<string, AccountCache> }
export interface ReminderCoordinatorOptions {
  chrome: typeof chrome;
  now?: () => Date;
  isBusy: () => boolean;
  readStatuses: (expectedAccountKey: string) => Promise<SubmissionStatusRead>;
  onChange: (state: ReminderState) => void | Promise<void>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validMonth = (value: unknown): value is string => typeof value === 'string' && /^(19\d\d|20\d\d|2100)-(0[1-9]|1[0-2])$/.test(value);
const validInstant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validStatus = (value: unknown): value is TimesheetStatus => TIMESHEET_STATUSES.includes(value as TimesheetStatus);
const emptyStorage = (): StoredReminders => ({ schemaVersion: 1, enabled: true, accounts: {} });
function nextMonth(month: string, offset = 1): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + offset, 1, 12));
  return date.toISOString().slice(0, 7);
}
/** Scheduling uses Berlin calendar dates, independent of machine timezone or DST. */
export function reminderCalendar(now: Date): { month: string; day: number; lastDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const month = `${value('year')}-${value('month')}`;
  return { month, day: Number(value('day')), lastDay: new Date(Date.UTC(Number(value('year')), Number(value('month')), 0, 12)).getUTCDate() };
}
function candidates(cache: AccountCache, now: Date): string[] {
  const calendar = reminderCalendar(now), result: string[] = [];
  for (let month = cache.trackedSinceMonth; month <= calendar.month; month = nextMonth(month)) {
    if (month < calendar.month || calendar.day >= calendar.lastDay - 6) result.push(month);
  }
  return result;
}
function loadStorage(value: unknown, now: Date): StoredReminders {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !object(value.accounts)) return emptyStorage();
  const result = emptyStorage(); result.enabled = value.enabled;
  const current = reminderCalendar(now).month;
  for (const [key, raw] of Object.entries(value.accounts)) {
    if (!validKey(key) || !object(raw) || !validMonth(raw.trackedSinceMonth) || raw.trackedSinceMonth > current || !object(raw.statuses)) continue;
    const cache: AccountCache = { trackedSinceMonth: raw.trackedSinceMonth, statuses: {} };
    for (const [month, record] of Object.entries(raw.statuses)) if (validMonth(month) && object(record) && validStatus(record.status) && validInstant(record.checkedAt) && Date.parse(record.checkedAt) <= now.getTime() + 60_000) cache.statuses[month] = { status: record.status, checkedAt: new Date(record.checkedAt).toISOString() };
    if (validMonth(raw.archiveBeforeMonth) && raw.archiveBeforeMonth >= cache.trackedSinceMonth && raw.archiveBeforeMonth <= current) cache.archiveBeforeMonth = raw.archiveBeforeMonth;
    for (const field of ['lastAttemptAt', 'lastCheckedAt', 'retryNotBeforeAt'] as const) if (validInstant(raw[field]) && Date.parse(raw[field]) <= now.getTime() + (field === 'retryNotBeforeAt' ? DAY : 60_000)) cache[field] = new Date(raw[field]).toISOString();
    result.accounts[key] = cache;
  }
  if (validKey(value.activeAccountKey) && result.accounts[value.activeAccountKey]) result.activeAccountKey = value.activeAccountKey;
  return result;
}

/** Local reminders never authorize submission and never store attendance or credentials. */
export class ReminderCoordinator {
  private data = emptyStorage();
  private ready?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private refreshing?: Promise<void>;
  private epoch = 0;
  private error?: string;
  private readonly clock: () => Date;
  constructor(private readonly options: ReminderCoordinatorOptions) { this.clock = options.now ?? (() => new Date()); }
  get current(): ReminderState { return structuredClone(this.view()); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work); this.queue = operation.then(() => {}, () => {}); return operation;
  }
  async init(): Promise<void> {
    if (!this.ready) {
      const loading = this.serial(async () => {
        try {
          const stored = await this.options.chrome.storage.local.get(REMINDER_STORAGE_KEY);
          this.data = loadStorage(stored[REMINDER_STORAGE_KEY], this.clock());
          this.error = undefined;
        } catch { this.error = t('Die Erinnerung konnte nicht geladen werden. Bitte erneut versuchen.'); await this.publish(); throw new Error(this.error); }
        await this.ensureAlarm(); await this.publish();
      });
      this.ready = loading;
      void loading.catch(() => { if (this.ready === loading) this.ready = undefined; });
    }
    return this.ready;
  }
  private async ensureAlarm(): Promise<void> {
    const alarms = this.options.chrome.alarms;
    if (!alarms?.get || !alarms.create) return;
    const existing = await alarms.get(REMINDER_ALARM);
    if (!existing || existing.periodInMinutes !== 60) await alarms.create(REMINDER_ALARM, { periodInMinutes: 60 });
  }
  async handleAlarm(name: string): Promise<void> { if (name === REMINDER_ALARM) { await this.init(); await this.ensureAlarm(); await this.refresh(); } }
  /** Recheck/recreate on startup without trusting persistence of Chrome alarms. */
  async startup(): Promise<void> { await this.init(); await this.ensureAlarm(); await this.refresh(); }
  async connect(accountKey: string): Promise<void> {
    await this.init();
    if (!validKey(accountKey)) throw new Error(t('Die Kontozuordnung für die Erinnerung ist ungültig.'));
    await this.serial(async () => {
      this.epoch++;
      try {
        await this.commit(() => {
          this.data.activeAccountKey = accountKey;
          this.data.accounts[accountKey] ??= { trackedSinceMonth: reminderCalendar(this.clock()).month, statuses: {} };
          this.error = undefined;
        });
      } catch (error) {
        // A failed account change must never reactivate another account's badge.
        delete this.data.activeAccountKey;
        await this.publish();
        throw error;
      }
    });
    await this.refresh();
  }
  async disconnect(): Promise<void> {
    await this.init();
    await this.serial(async () => {
      this.epoch++; delete this.data.activeAccountKey; this.error = undefined;
      let failure: Error | undefined;
      try { await this.options.chrome.storage.local.set({ [REMINDER_STORAGE_KEY]: structuredClone(this.data) }); }
      catch { this.error = t('Die Erinnerung konnte nicht gespeichert werden. Bitte erneut versuchen.'); failure = new Error(this.error); }
      // Disconnect fails closed in memory even if disk persistence is unavailable.
      await this.publish();
      if (failure) throw failure;
    });
  }
  async setEnabled(enabled: boolean): Promise<void> {
    await this.init();
    await this.serial(async () => { this.epoch++; await this.commit(() => { this.data.enabled = enabled; this.error = undefined; }); });
    if (enabled) await this.refresh();
  }
  async recordPeriods(accountKey: string, periods: SubmissionStatusRead['periods'], checkedAt = this.clock().toISOString()): Promise<void> {
    await this.init();
    this.validateRead({ accountKey, periods, checkedAt });
    await this.serial(async () => {
      this.epoch++;
      await this.commit(() => {
        const cache = this.data.accounts[accountKey] ??= { trackedSinceMonth: reminderCalendar(this.clock()).month, statuses: {} };
        this.merge(cache, periods, checkedAt);
        if (!cache.lastAttemptAt || Date.parse(cache.lastAttemptAt) < Date.parse(checkedAt)) cache.lastAttemptAt = checkedAt;
        if (!cache.lastCheckedAt || Date.parse(cache.lastCheckedAt) < Date.parse(checkedAt)) cache.lastCheckedAt = checkedAt;
        delete cache.retryNotBeforeAt;
        if (this.data.activeAccountKey === accountKey) this.error = undefined;
      });
    });
  }
  async refresh(force = false): Promise<void> {
    await this.init();
    // A request from a previous account is allowed to finish but cannot update its replacement.
    if (this.refreshing) { await this.refreshing; return this.refresh(force); }
    const pending = this.performRefresh(force); this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }
  private async performRefresh(force: boolean): Promise<void> {
    let dispatch: { accountKey: string; epoch: number } | undefined;
    await this.serial(async () => {
      await this.publish();
      const key = this.data.activeAccountKey, cache = key ? this.data.accounts[key] : undefined, now = this.clock();
      if (!this.data.enabled || !key || !cache || !candidates(cache, now).length || this.options.isBusy()) return;
      if (cache.retryNotBeforeAt && Date.parse(cache.retryNotBeforeAt) > now.getTime() || !force && cache.lastAttemptAt && now.getTime() - Date.parse(cache.lastAttemptAt) < HOUR) return;
      await this.commit(() => { cache.lastAttemptAt = now.toISOString(); });
      dispatch = { accountKey: key, epoch: this.epoch };
    });
    if (!dispatch) return;
    const expected = dispatch;
    try {
      const read = await this.options.readStatuses(expected.accountKey);
      await this.serial(async () => {
        if (!this.active(expected)) return;
        if (read.accountKey !== expected.accountKey) {
          this.epoch++;
          await this.commit(() => { delete this.data.activeAccountKey; this.error = t('Das HiBob-Konto hat sich geändert. Bitte erneut verbinden.'); }); return;
        }
        this.validateRead(read);
        await this.commit(() => {
          const cache = this.data.accounts[expected.accountKey];
          this.merge(cache, read.periods, read.checkedAt); cache.lastCheckedAt = read.checkedAt; delete cache.retryNotBeforeAt; this.error = undefined;
        });
      });
    } catch (error) {
      await this.serial(async () => {
        if (!this.active(expected)) return;
        const retryAfterMs = object(error) && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) ? Math.min(DAY, Math.max(0, error.retryAfterMs)) : 0;
        await this.commit(() => {
          const cache = this.data.accounts[expected.accountKey];
          if (retryAfterMs) cache.retryNotBeforeAt = new Date(this.clock().getTime() + Math.max(HOUR, retryAfterMs)).toISOString();
          this.error = t('HiBob-Status konnte nicht geprüft werden. Die Erinnerung bleibt bestehen.');
        });
      });
    }
  }
  private active(expected: { accountKey: string; epoch: number }): boolean { return this.data.enabled && this.data.activeAccountKey === expected.accountKey && this.epoch === expected.epoch; }
  private validateRead(read: SubmissionStatusRead): void {
    if (!validKey(read.accountKey) || !validInstant(read.checkedAt) || Date.parse(read.checkedAt) > this.clock().getTime() + 60_000 || !Array.isArray(read.periods) || read.periods.some(period => !period || !validMonth(period.month) || !validStatus(period.status)) || new Set(read.periods.map(period => period.month)).size !== read.periods.length) throw new Error(t('HiBob hat keinen eindeutigen Monatsabschlussstatus geliefert.'));
  }
  private merge(cache: AccountCache, periods: SubmissionStatusRead['periods'], checkedAt: string): void {
    for (const period of periods) {
      if (!cache.statuses[period.month] || Date.parse(cache.statuses[period.month].checkedAt) <= Date.parse(checkedAt)) cache.statuses[period.month] = { status: period.status, checkedAt };
    }
    const cutoff = nextMonth(reminderCalendar(this.clock()).month, -11);
    // Missing old periods were already unknown reminders. Keep them as explicit
    // exceptions before compacting completed months, so absence never means success.
    let archive = cache.archiveBeforeMonth ?? cache.trackedSinceMonth;
    for (; archive < cutoff; archive = nextMonth(archive)) cache.statuses[archive] ??= { status: 'unknown', checkedAt };
    if (archive > cache.trackedSinceMonth) cache.archiveBeforeMonth = archive;
    for (const [month, record] of Object.entries(cache.statuses)) if (month < cutoff && month < (cache.archiveBeforeMonth ?? '') && isSubmittedStatus(record.status)) delete cache.statuses[month];
  }
  private view(): ReminderState {
    const key = this.data.activeAccountKey, cache = key ? this.data.accounts[key] : undefined, now = this.clock();
    const due = !this.data.enabled || !cache ? [] : candidates(cache, now).flatMap(month => {
      const record = cache.statuses[month];
      if (record && isSubmittedStatus(record.status) || !record && cache.archiveBeforeMonth && month < cache.archiveBeforeMonth) return [];
      return [{ month, status: record?.status ?? 'unknown' as const, needsCheck: !record || record.status === 'unknown' || !!this.error || now.getTime() - Date.parse(record.checkedAt) >= HOUR }];
    });
    return { enabled: this.data.enabled, due, ...(key ? { accountKey: key } : {}), ...(cache?.lastCheckedAt ? { checkedAt: cache.lastCheckedAt } : {}), ...(this.error ? { error: this.error } : {}) };
  }
  private async commit(change: () => void): Promise<void> {
    const before = structuredClone(this.data);
    change();
    try { await this.options.chrome.storage.local.set({ [REMINDER_STORAGE_KEY]: structuredClone(this.data) }); }
    catch { this.data = before; this.error = t('Die Erinnerung konnte nicht gespeichert werden. Bitte erneut versuchen.'); await this.publish(); throw new Error(this.error); }
    await this.publish();
  }
  private async publish(): Promise<void> {
    const state = this.current, count = state.due.length;
    const action = this.options.chrome.action;
    await action.setBadgeText?.({ text: count ? count > 99 ? '99+' : String(count) : '' });
    await action.setBadgeBackgroundColor?.({ color: '#b42318' });
    await action.setBadgeTextColor?.({ color: '#ffffff' });
    await action.setTitle?.({ title: count ? t('{count} Monatsabschlüsse prüfen', { count }) : t('HiBob Monthly Attendance') });
    await this.options.onChange(state);
  }
}
