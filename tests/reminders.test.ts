import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMINDER_ALARM, REMINDER_STORAGE_KEY, ReminderCoordinator, reminderCalendar } from '../src/reminders';
import type { ReminderState, SubmissionStatusRead, TimesheetStatus } from '../src/shared/types';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(initial?: unknown, initialTime = '2026-11-04T12:00:00Z') {
  let now = new Date(initialTime), busy = false, stored = structuredClone(initial);
  const changes: ReminderState[] = [];
  const alarms = new Map<string, chrome.alarms.Alarm>();
  const local = {
    get: vi.fn(async () => ({ [REMINDER_STORAGE_KEY]: structuredClone(stored) })),
    set: vi.fn(async (value: Record<string, unknown>) => { stored = structuredClone(value[REMINDER_STORAGE_KEY]); }),
  };
  const action = { setBadgeText: vi.fn(async (_value: object) => {}), setBadgeBackgroundColor: vi.fn(async (_value: object) => {}), setBadgeTextColor: vi.fn(async (_value: object) => {}), setTitle: vi.fn(async (_value: object) => {}) };
  const alarmApi = {
    get: vi.fn(async (name: string) => alarms.get(name)),
    create: vi.fn(async (name: string, value: chrome.alarms.AlarmCreateInfo) => { alarms.set(name, { name, scheduledTime: now.getTime() + 60 * 60_000, periodInMinutes: value.periodInMinutes }); }),
  };
  const readStatuses = vi.fn(async (key: string): Promise<SubmissionStatusRead> => ({ accountKey: key, periods: [{ month: reminderCalendar(now).month, status: 'Open' }], checkedAt: now.toISOString() }));
  const browser = { storage: { local }, action, alarms: alarmApi } as unknown as typeof chrome;
  const create = () => new ReminderCoordinator({ chrome: browser, now: () => new Date(now), isBusy: () => busy, readStatuses, onChange: value => { changes.push(structuredClone(value)); } });
  return { create, local, action, alarmApi, alarms, readStatuses, changes, stored: () => stored as Record<string, unknown>, time: (value: string) => { now = new Date(value); }, busy: (value: boolean) => { busy = value; } };
}

beforeEach(() => vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'de-DE' } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('submission reminder calendar', () => {
  it.each([
    ['2026-11-23T22:59:59Z', '2026-11', 23, 30, false],
    ['2026-11-23T23:00:00Z', '2026-11', 24, 30, true],
    ['2028-02-22T23:00:00Z', '2028-02', 23, 29, true],
    ['2027-02-21T23:00:00Z', '2027-02', 22, 28, true],
    ['2026-07-24T22:00:00Z', '2026-07', 25, 31, true],
    ['2026-03-24T23:00:00Z', '2026-03', 25, 31, true],
  ])('uses the Berlin last-seven-day window at %s', async (instant, month, day, lastDay, due) => {
    expect(reminderCalendar(new Date(instant))).toEqual({ month, day, lastDay });
    const f = fixture(undefined, instant); const reminder = f.create(); await reminder.connect(A);
    expect(reminder.current.due.length > 0).toBe(due);
    expect(f.readStatuses).toHaveBeenCalledTimes(due ? 1 : 0);
  });
});

describe('durable local reminders', () => {
  it('defaults on, uses one hourly alarm and does not enrol or request data until connected', async () => {
    const f = fixture(); const reminder = f.create(); await reminder.init(); await reminder.init();
    expect(reminder.current).toEqual({ enabled: true, due: [] });
    expect(f.alarmApi.create).toHaveBeenCalledExactlyOnceWith(REMINDER_ALARM, { periodInMinutes: 60 });
    expect(f.readStatuses).not.toHaveBeenCalled();
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    await reminder.handleAlarm('some-other-extension-alarm'); expect(f.readStatuses).not.toHaveBeenCalled();
  });

  it('sets a global red badge and retains it when the panel merely refreshes', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    expect(reminder.current.due).toEqual([{ month: '2026-11', status: 'Open', needsCheck: false }]);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
    expect(f.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color: '#b42318' });
    expect(f.action.setBadgeTextColor).toHaveBeenLastCalledWith({ color: '#ffffff' });
    for (let i = 0; i < 3; i++) await reminder.refresh();
    expect(f.readStatuses).toHaveBeenCalledOnce(); expect(reminder.current.due).toHaveLength(1);
    expect(f.action.setBadgeText.mock.calls.every(([value]) => !('tabId' in value))).toBe(true);
  });

  it('keeps an overdue month at rollover without enrolling older manually inspected periods', async () => {
    const f = fixture(); const reminder = f.create(); await reminder.connect(A);
    await reminder.recordPeriods(A, [{ month: '2026-10', status: 'Open' }], '2026-11-04T12:00:00Z');
    expect(reminder.current.due).toEqual([]);
    f.time('2026-12-02T12:00:00Z'); await reminder.refresh();
    expect(reminder.current.due.map(day => day.month)).toEqual(['2026-11']);
    expect(reminder.current.due[0].needsCheck).toBe(true);
    f.time('2026-12-27T12:00:00Z'); await reminder.refresh();
    expect(reminder.current.due.map(day => day.month)).toEqual(['2026-11', '2026-12']);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' });
  });

  it.each(['Submitted', 'PendingProjectApproval', 'Approved'] as const)('clears only independently recorded completion: %s', async status => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    await reminder.recordPeriods(A, [{ month: '2026-11', status }]);
    expect(reminder.current.due).toEqual([]); expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    f.time('2026-11-25T13:00:00Z'); f.readStatuses.mockResolvedValueOnce({ accountKey: A, periods: [{ month: '2026-11', status: 'Rejected' }], checkedAt: '2026-11-25T13:00:00Z' });
    await reminder.refresh();
    expect(reminder.current.due).toEqual([{ month: '2026-11', status: 'Rejected', needsCheck: false }]);
  });

  it('recreates a lost alarm on startup and throttles requests across worker restarts', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); await f.create().connect(A);
    f.alarms.clear(); const restarted = f.create(); await restarted.startup();
    expect(f.alarmApi.create).toHaveBeenCalledTimes(2); expect(f.readStatuses).toHaveBeenCalledOnce();
    f.time('2026-11-25T13:00:00Z'); await restarted.handleAlarm(REMINDER_ALARM);
    expect(f.readStatuses).toHaveBeenCalledTimes(2);
  });

  it('leaves cached reminders as unverified after offline failure without storing server text', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    f.time('2026-11-25T13:00:00Z'); f.readStatuses.mockRejectedValueOnce(new Error('private-account/token-secret'));
    await reminder.refresh();
    expect(reminder.current.due).toEqual([{ month: '2026-11', status: 'Open', needsCheck: true }]);
    expect(reminder.current.error).toBeDefined(); expect(JSON.stringify(f.stored())).not.toMatch(/private-account|token-secret|error/);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
  });

  it('persists Retry-After and a manual refresh cannot bypass the server cooldown', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); f.readStatuses.mockRejectedValueOnce({ retryAfterMs: 2 * 60 * 60_000 });
    const reminder = f.create(); await reminder.connect(A);
    f.time('2026-11-25T13:01:00Z'); const restarted = f.create(); await restarted.startup(); await restarted.refresh(true);
    expect(f.readStatuses).toHaveBeenCalledOnce(); expect(restarted.current.due[0].needsCheck).toBe(true);
    f.time('2026-11-25T14:00:00Z'); await restarted.refresh(true); expect(f.readStatuses).toHaveBeenCalledTimes(2);
  });

  it('disables badge and background requests while retaining account cache', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.init(); await reminder.setEnabled(false); await reminder.connect(A);
    await reminder.refresh(true); expect(f.readStatuses).not.toHaveBeenCalled(); expect(reminder.current.due).toEqual([]);
    await reminder.setEnabled(true); expect(f.readStatuses).toHaveBeenCalledOnce(); expect(reminder.current.due).toHaveLength(1);
    await reminder.disconnect(); expect(reminder.current.accountKey).toBeUndefined(); expect(reminder.current.due).toEqual([]);
    expect((f.stored().accounts as object)).toHaveProperty(A);
  });

  it('suspends the active account and badge even if disconnect persistence fails', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    f.local.set.mockRejectedValueOnce(new Error('disconnect disk unavailable'));
    await expect(reminder.disconnect()).rejects.toThrow('gespeichert');
    expect(reminder.current.accountKey).toBeUndefined(); expect(reminder.current.due).toEqual([]);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    f.time('2026-11-25T14:00:00Z'); await reminder.refresh(true);
    expect(f.readStatuses).toHaveBeenCalledOnce();
  });

  it('does not start even a status request during a booking or another exclusive operation', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); f.busy(true); const reminder = f.create(); await reminder.connect(A);
    expect(f.readStatuses).not.toHaveBeenCalled(); expect(reminder.current.due[0].status).toBe('unknown');
    f.busy(false); await reminder.refresh(); expect(f.readStatuses).toHaveBeenCalledOnce();
  });

  it('suspends automatic account use when a probe observes a different authenticated user', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); f.readStatuses.mockResolvedValueOnce({ accountKey: B, periods: [{ month: '2026-11', status: 'Submitted' }], checkedAt: '2026-11-25T12:00:00Z' });
    const reminder = f.create(); await reminder.connect(A);
    expect(reminder.current.accountKey).toBeUndefined(); expect(reminder.current.due).toEqual([]); expect(reminder.current.error).toContain('geändert');
    await reminder.refresh(true); expect(f.readStatuses).toHaveBeenCalledOnce();
    expect((f.stored().accounts as Record<string, unknown>)[B]).toBeUndefined();
    await reminder.connect(B); expect(reminder.current.accountKey).toBe(B); expect(f.readStatuses).toHaveBeenCalledTimes(2);
  });

  it('a failed new account enrolment cannot restore the previous account badge', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    f.local.set.mockRejectedValueOnce(new Error('account persistence unavailable'));
    await expect(reminder.connect(B)).rejects.toThrow('gespeichert');
    expect(reminder.current.accountKey).toBeUndefined(); expect(reminder.current.due).toEqual([]);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    await reminder.refresh(true); expect(f.readStatuses).toHaveBeenCalledOnce();
  });

  it('a late response from a previous account cannot update a newly connected account', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const entered = deferred<void>(), old = deferred<SubmissionStatusRead>();
    f.readStatuses.mockImplementationOnce(async () => { entered.resolve(); return old.promise; });
    const reminder = f.create(), first = reminder.connect(A); await entered.promise;
    const second = reminder.connect(B); await vi.waitFor(() => expect(reminder.current.accountKey).toBe(B));
    old.resolve({ accountKey: A, periods: [{ month: '2026-11', status: 'Submitted' }], checkedAt: '2026-11-25T12:00:00Z' }); await Promise.all([first, second]);
    expect(reminder.current.accountKey).toBe(B); expect(reminder.current.due[0].status).toBe('Open');
    const accounts = f.stored().accounts as Record<string, { statuses: object }>;
    expect(accounts[A].statuses).toEqual({}); expect(f.readStatuses).toHaveBeenCalledTimes(2);
  });

  it('a newer explicit scan/submission result wins over an older in-flight status read', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const entered = deferred<void>(), old = deferred<SubmissionStatusRead>();
    f.readStatuses.mockImplementationOnce(async () => { entered.resolve(); return old.promise; });
    const reminder = f.create(), connecting = reminder.connect(A); await entered.promise;
    await reminder.recordPeriods(A, [{ month: '2026-11', status: 'Submitted' }]);
    old.resolve({ accountKey: A, periods: [{ month: '2026-11', status: 'Open' }], checkedAt: '2026-11-25T12:00:01Z' }); await connecting;
    expect(reminder.current.due).toEqual([]);
  });

  it('requires a durable throttle journal before requesting status', async () => {
    const f = fixture(undefined, '2026-11-25T12:00:00Z'); const reminder = f.create(); await reminder.init();
    f.local.set.mockImplementationOnce(async value => { /* connection itself succeeds */ (f as unknown as { ignored?: unknown }).ignored = value; });
    f.local.set.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(reminder.connect(A)).rejects.toThrow('gespeichert'); expect(f.readStatuses).not.toHaveBeenCalled();
    expect(reminder.current.due[0].needsCheck).toBe(true);
  });

  it('compacts completed old months without forgetting pending months or inventing archived reminders', async () => {
    const f = fixture(undefined, '2025-11-04T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    f.time('2027-05-27T12:00:00Z');
    const periods: SubmissionStatusRead['periods'] = Array.from({ length: 19 }, (_, index) => ({ month: new Date(Date.UTC(2025, 10 + index, 1, 12)).toISOString().slice(0, 7), status: index === 0 ? 'Open' : 'Submitted' }));
    await reminder.recordPeriods(A, periods);
    expect(reminder.current.due.map(item => item.month)).toEqual(['2025-11']);
    const account = (f.stored().accounts as Record<string, { statuses: object; archiveBeforeMonth: string }>)[A];
    expect(Object.keys(account.statuses)).toHaveLength(13); expect(account.archiveBeforeMonth).toBe('2026-06');
    const restarted = f.create(); await restarted.init(); expect(restarted.current.due.map(item => item.month)).toEqual(['2025-11']);
  });

  it('retains gaps as unknown while compacting completed historical periods', async () => {
    const f = fixture(undefined, '2025-11-04T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    f.time('2027-05-27T12:00:00Z'); await reminder.recordPeriods(A, [{ month: '2025-11', status: 'Submitted' }, { month: '2027-05', status: 'Submitted' }]);
    expect(reminder.current.due[0].month).toBe('2025-12'); expect(reminder.current.due).toHaveLength(17);
    const cache = (f.stored().accounts as Record<string, { statuses: Record<string, { status: string }> }>)[A];
    expect(cache.statuses['2025-11']).toBeUndefined(); expect(cache.statuses['2025-12'].status).toBe('unknown');
    const restarted = f.create(); await restarted.init(); expect(restarted.current.due).toHaveLength(17);
  });

  it('caps the toolbar count without discarding a large pending backlog', async () => {
    const f = fixture(undefined, '2018-01-04T12:00:00Z'); const reminder = f.create(); await reminder.connect(A);
    f.time('2026-11-25T12:00:00Z'); await reminder.refresh();
    expect(reminder.current.due.length).toBeGreaterThan(99);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: '99+' });
  });

  it('sanitizes durable state and never restores labels, tokens, consent or arbitrary statuses', async () => {
    const f = fixture({ schemaVersion: 1, enabled: true, activeAccountKey: A, accounts: { [A]: { trackedSinceMonth: '2026-11', token: 'secret-token', statuses: { '2026-11': { status: 'Submitted', checkedAt: 'not-a-time' }, '2026-10': { status: 'MadeUp', checkedAt: '2026-11-25T12:00:00Z' } } } }, employeeLabel: 'Private Employee', confirmation: true }, '2026-11-25T12:00:00Z');
    const reminder = f.create(); await reminder.init(); expect(reminder.current.due[0].status).toBe('unknown');
    await reminder.setEnabled(false);
    expect(JSON.stringify(f.stored())).not.toMatch(/secret-token|Private Employee|confirmation|MadeUp/);
    const current = reminder.current; current.enabled = true; current.due.push({ month: '1900-01', status: 'Open', needsCheck: false });
    expect(reminder.current.enabled).toBe(false); expect(reminder.current.due).toEqual([]);
  });
});
