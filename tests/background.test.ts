import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { AccountConfirmation, AdapterProgress, ApiConnection, ApplyAuthorization, AttendanceContext, BookingPlan, DayPlan, DaySnapshot, MonthSnapshot, PreflightResult, SessionState, MonthApplyHooks, MonthApplyResult, SubmissionConsent, SubmissionHooks, SubmissionJournal, SubmissionResult, SubmissionReview, SubmissionStatusRead } from '../src/shared/types';
import { contextFingerprint, executionFingerprint } from '../src/shared/context';
import { submissionAccountKey } from '../src/shared/submission';
import { REMINDER_ALARM, REMINDER_STORAGE_KEY } from '../src/reminders';

const connection = (write = true): ApiConnection => ({ status: 'connected', generation: 'session-fixture', employeeId: 'employee-fixture', companyId: 'company-fixture', employeeLabel: 'Local fixture', companyLabel: 'Local company', transport: 'direct', capabilities: { read: true, write, overwrite: write } });
const snapshot = (): MonthSnapshot => ({ month: '2026-11', employeeLabel: 'Local fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', context: { mode: 'api-session', connectionId: 'session-fixture', employeeKey: 'employee-fixture', tenantKey: 'company-fixture' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) });
type Reply = { ok: boolean; state?: SessionState; error?: string; preflight?: PreflightResult };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../src/hibob/api-adapter'); });

async function fixture(options: { initial?: SessionState; failLoads?: number; beforeSave?: (state: SessionState) => Promise<void>; initialLocal?: Record<string, unknown>; beforeLocalSave?: (value: Record<string, unknown>) => Promise<void> } = {}) {
  let receiver!: (message: unknown, sender: object, respond: (response: Reply) => void) => unknown;
  let clicked!: (tab: { windowId: number; id?: number; url?: string }) => void;
  let stored = options.initial && structuredClone(options.initial);
  const publications: SessionState[] = [];
  const savedDays = new Map<string, DaySnapshot>();
  let localData: Record<string, unknown> = structuredClone(options.initialLocal ?? {});
  const localWrites: Record<string, unknown>[] = [];
  const submitWrites: SubmissionReview[] = [];
  const accountKey = await submissionAccountKey(connection().employeeId!, connection().companyId!);
  const api = {
    connect: vi.fn(async (): Promise<ApiConnection> => connection()), disconnect: vi.fn(async () => {}),
    scanMonth: vi.fn(async (_connection: ApiConnection, _month: string, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<MonthSnapshot> => { const value = snapshot(); value.days = value.days.map(day => structuredClone(savedDays.get(day.date) ?? day)); return value; }),
    applyDay: vi.fn(async (_connection: ApiConnection, day: DayPlan, _context?: AttendanceContext, _authorization?: ApplyAuthorization, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<DaySnapshot> => { const value: DaySnapshot = { date: day.date, entries: structuredClone(day.proposed), reportedMinutes: day.netMinutes, editable: true, fingerprint: 'saved-fixture' }; savedDays.set(day.date, value); return structuredClone(value); }),
    preflightDay: vi.fn(async (_connection: ApiConnection, day: DayPlan, _context?: AttendanceContext, _authorization?: ApplyAuthorization, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<PreflightResult> => ({ date: day.date, checked: true, saved: false, serverValidated: false, netMinutes: day.netMinutes! })),
    reviewSubmission: vi.fn(async (value: ApiConnection, month: string, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<SubmissionReview> => ({
      id: `review-${crypto.randomUUID()}`, month, connectionId: value.generation, accountKey: await submissionAccountKey(value.employeeId!, value.companyId!), employeeLabel: value.employeeLabel!, companyLabel: value.companyLabel!,
      period: { id: 0, start: `${month}-01`, end: `${month}-30`, status: 'WaitingForSubmission', locked: false },
      contentFingerprint: 'c'.repeat(64), eligibilityFingerprint: 'd'.repeat(64), netMinutes: 10080, issues: [], canSubmit: true, early: false, checkedAt: new Date().toISOString(),
    })),
    submitMonth: vi.fn(async (_connection: ApiConnection, review: SubmissionReview, _consent: SubmissionConsent, hooks: SubmissionHooks, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<SubmissionResult> => {
      await hooks.beforeDispatch();
      const journal = (localData.submissionJournals as Record<string, SubmissionJournal> | undefined)?.[review.accountKey];
      expect(journal?.status).toBe('dispatching'); expect(journal?.accountKey).toBe(review.accountKey);
      submitWrites.push(structuredClone(review)); await hooks.acknowledged();
      return { month: review.month, status: 'verified', periodStatus: 'Submitted', submittedAt: new Date().toISOString(), message: 'Independent submit readback' };
    }),
    listSubmissionStatuses: vi.fn(async (expectedKey: string): Promise<SubmissionStatusRead> => ({ accountKey: expectedKey, periods: [{ month: '2026-11', status: 'WaitingForSubmission' }], checkedAt: new Date().toISOString() })),
    cancel: vi.fn(), assertIdle: vi.fn(async () => {}), recover: vi.fn(async (_connection: ApiConnection, _jobId: string) => {}),
  };
  const applyMonth = vi.fn(async (_connection: ApiConnection, plan: BookingPlan, _authorization: ApplyAuthorization, hooks: MonthApplyHooks): Promise<MonthApplyResult> => {
    const days: MonthApplyResult['days'] = [];
    for (const day of plan.days.filter(item => item.action === 'create' || item.action === 'overwrite')) {
      await hooks.beforeDispatch(day.date);
      await api.applyDay(_connection, day);
      await hooks.acknowledged(day.date);
      days.push({ date: day.date, status: 'verified', message: 'Independent readback' });
    }
    return { days, complete: true, stopped: false, timings: { preparationMs: 1, writingMs: 1, journalingMs: 1, verificationMs: 1, totalMs: 4, requests: days.length + 13, writes: days.length } };
  });
  vi.doMock('../src/hibob/api-adapter' , () => ({ HiBobApiAdapter: class { connect = api.connect; disconnect = api.disconnect; scanMonth = api.scanMonth; applyDay = api.applyDay; applyMonth = applyMonth; preflightDay = api.preflightDay; reviewSubmission = api.reviewSubmission; submitMonth = api.submitMonth; listSubmissionStatuses = api.listSubmissionStatuses; cancel = api.cancel; assertIdle = api.assertIdle; recover = api.recover; } }));
  let failures = options.failLoads ?? 0;
  const get = vi.fn(async () => { if (failures-- > 0) throw new Error('Fixture session storage unavailable'); return { sessionState: stored }; });
  const set = vi.fn(async ({ sessionState }: { sessionState: SessionState }) => { await options.beforeSave?.(sessionState); stored = structuredClone(sessionState); publications.push(stored); });
  const localGet = vi.fn(async (key: string) => ({ [key]: structuredClone(localData[key]) }));
  const localSet = vi.fn(async (value: Record<string, unknown>) => { await options.beforeLocalSave?.(value); localData = { ...localData, ...structuredClone(value) }; localWrites.push(structuredClone(value)); });
  const badge = { text: vi.fn(async (_value: object) => {}), background: vi.fn(async (_value: object) => {}), color: vi.fn(async (_value: object) => {}), title: vi.fn(async (_value: object) => {}) };
  let onAlarm!: (alarm: { name: string }) => void; let startup!: () => void; let installed!: () => void;
  const alarmValues = new Map<string, { name: string; periodInMinutes: number }>();
  const alarmGet = vi.fn(async (name: string) => alarmValues.get(name));
  const alarmCreate = vi.fn(async (name: string, value: { periodInMinutes: number }) => { alarmValues.set(name, { name, periodInMinutes: value.periodInMinutes }); });
  const open = vi.fn(async () => {}), reload = vi.fn(), sendMessage = vi.fn(), executeScript = vi.fn();
  const getPlatformInfo = vi.fn(async () => ({ os: 'mac', arch: 'arm64', nacl_arch: 'arm' }));
  vi.stubGlobal('chrome', {
    storage: { session: { get, set }, local: { get: localGet, set: localSet } }, sidePanel: { open }, action: { setBadgeText: badge.text, setBadgeBackgroundColor: badge.background, setBadgeTextColor: badge.color, setTitle: badge.title, onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    alarms: { get: alarmGet, create: alarmCreate, onAlarm: { addListener: (listener: typeof onAlarm) => { onAlarm = listener; } } },
    runtime: { onStartup: { addListener: (listener: typeof startup) => { startup = listener; } }, onInstalled: { addListener: (listener: typeof installed) => { installed = listener; } }, id: 'test', getManifest: () => ({ version: '1.2.3' }), getPlatformInfo, reload, onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { sendMessage }, scripting: { executeScript },
  });
  await import('../src/background');
  const rpc = (message: object, sender: object = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) => {
    const command = message as { type?: string; options?: object };
    const strictCommand = command.type === 'PANEL_APPLY' ? { ...message, options: { executionProfile: 'strict', ...command.options } } : message;
    return new Promise<Reply>(resolve => receiver(strictCommand, sender, resolve));
  };
  const connect = () => rpc({ type: 'PANEL_CONNECT' });
  async function review(dates = ['2026-11-03'], checkpointDates: string[] = []) {
    const scan = await rpc({ type: 'PANEL_SCAN', month: '2026-11' }); expect(scan.ok).toBe(true);
    const settings = { ...defaultSettings('2026-11'), excludedDates: getMonthDates('2026-11').filter(date => !dates.includes(date)) };
    const candidate = buildMonthPlan(settings, scan.state!.snapshot!, {}, 1);
    const invalidation = await rpc({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: scan.state!.planRevision, changeId: 'review-fixture' });
    const result = await rpc({ type: 'PANEL_SAVE_PLAN', plan: candidate, lease: invalidation.state!.editLease });
    expect(result.ok).toBe(true);
    const plan = result.state!.plan!, revision = result.state!.planRevision!;
    const confirmation: AccountConfirmation = { planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), executionFingerprint: executionFingerprint({ executionProfile: 'strict', checkpointDates }), confirmed: true };
    return { plan, revision, confirmation };
  }
  const settledRun = async () => {
    await vi.waitFor(() => { expect(stored?.run).toBeDefined(); expect(stored?.run?.status).not.toBe('running'); });
    return structuredClone(stored!);
  };
  const settledSubmission = async () => { await vi.waitFor(() => { expect(stored?.submissionResult).toBeDefined(); expect(stored?.job).toBeUndefined(); }); return structuredClone(stored!); };
  return { accountKey, localGet, localSet, localData: () => localData, localWrites, submitWrites, badge, alarmValues, alarmGet, alarmCreate, onAlarm: (name: string) => onAlarm({ name }), startup: () => startup(), installed: () => installed(), settledSubmission, api: { ...api, applyMonth }, rpc, receiver, clicked, stored: () => stored, publications, connect, review, settledRun, get, set, open, reload, sendMessage, executeScript, getPlatformInfo };
}

describe('direct API background transport', () => {
  it('routes a consent-bound fast profile to the exclusive monthly writer and publishes verification', async () => {
    const app = await fixture(); await app.connect();
    const { plan, revision, confirmation } = await app.review();
    const approval = { ...confirmation, executionFingerprint: executionFingerprint({ executionProfile: 'fast-serial' }) };
    const response = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation: approval, options: { executionProfile: 'fast-serial' } });
    expect(response.ok).toBe(true);
    const final = await app.settledRun();
    expect(app.api.applyMonth).toHaveBeenCalledOnce(); expect(final.run?.status).toBe('complete');
    expect(final.run?.executionProfile).toBe('fast-serial'); expect(final.run?.timings?.requests).toBe(14);
    expect(app.publications.some(state => state.run?.results.some(day => day.status === 'awaiting-verification'))).toBe(true);
    expect(final.run?.results.find(day => day.date === '2026-11-03')?.status).toBe('verified');
    expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('opens from any website without implicit sign-in, scans, content injection or account reset', async () => {
    const app = await fixture();
    app.clicked({ id: 22, windowId: 1, url: 'https://example.org' });
    await app.rpc({ type: 'PANEL_GET_STATE' });
    expect(app.api.connect).not.toHaveBeenCalled(); expect(app.api.scanMonth).not.toHaveBeenCalled();
    await app.connect(); const review = await app.review(); const before = structuredClone(app.stored());
    app.clicked({ id: 23, windowId: 2, url: 'https://another.example' });
    const state = (await app.rpc({ type: 'PANEL_GET_STATE' })).state;
    expect(state).toEqual(before); expect(state?.plan?.id).toBe(review.plan.id); expect(state?.tabId).toBeUndefined();
    expect(app.open).toHaveBeenLastCalledWith({ windowId: 2 });
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it.each(['success', 'missing-result', 'server-validated', 'error'] as const)('uses only the read-only API preflight route: %s', async scenario => {
    const history = { planId: 'past', status: 'failed' as const, startedAt: 'x', updatedAt: 'x', results: [{ date: '2026-10-30', status: 'failed' as const, message: 'Past result' }] };
    const app = await fixture({ initial: { schemaVersion: 5, run: history } });
    await app.connect(); const { plan, revision, confirmation } = await app.review();
    if (scenario === 'missing-result') app.api.preflightDay.mockResolvedValueOnce(undefined as unknown as PreflightResult);
    if (scenario === 'server-validated') app.api.preflightDay.mockResolvedValueOnce({ date: '2026-11-03', checked: true, saved: false, serverValidated: true, netMinutes: 480 } as unknown as PreflightResult);
    if (scenario === 'error') app.api.preflightDay.mockRejectedValueOnce(new Error('Local preflight failure'));
    const command = { type: 'PANEL_PREFLIGHT', plan, expectedPlanRevision: revision, date: '2026-11-03' };
    expect((await app.rpc(command)).ok).toBe(false); expect(app.api.preflightDay).not.toHaveBeenCalled();
    const result = await app.rpc({ ...command, confirmation });
    expect(result.ok).toBe(scenario === 'success');
    expect(app.api.preflightDay).toHaveBeenCalledOnce(); expect(app.api.applyDay).not.toHaveBeenCalled();
    if (scenario === 'success') expect(result.preflight).toEqual({ date: '2026-11-03', checked: true, saved: false, serverValidated: false, netMinutes: 480 });
    else expect(result.preflight).toBeUndefined();
    expect(result.state?.run).toEqual(history); expect(result.state?.snapshot).toBeUndefined(); expect(result.state?.plan?.canReview).toBe(false);
    expect(app.publications.some(state => 'preflight' in state)).toBe(false);
  });

  it('correlates cancellation with the active job and aborts without invoking a write', async () => {
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review();
    const entered = deferred(); let signal!: AbortSignal;
    app.api.preflightDay.mockImplementationOnce(async (_connection, _day, _context, _authorization, _progress, currentSignal) => {
      signal = currentSignal!; entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Preflight aborted')), { once: true }));
    });
    const running = app.rpc({ type: 'PANEL_PREFLIGHT', plan, expectedPlanRevision: revision, date: '2026-11-03', confirmation });
    await entered.promise;
    expect((await app.rpc({ type: 'PANEL_CANCEL', jobId: 'stale-job' })).ok).toBe(false); expect(signal.aborted).toBe(false);
    const job = app.stored()!.job!; expect(job.connectionId).toBe(connection().generation); expect(job.tabId).toBeUndefined();
    await app.rpc({ type: 'PANEL_CANCEL', jobId: job.id });
    expect(signal.aborted).toBe(true); expect(app.api.cancel).toHaveBeenCalledOnce();
    expect((await running).ok).toBe(false); expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('does not dispatch a write cancelled while its durable journal is pending', async () => {
    const entered = deferred(), release = deferred(); let hold = false;
    const app = await fixture({ beforeSave: async state => { if (hold && state.run?.results.some(item => item.status === 'running')) { entered.resolve(); await release.promise; } } });
    await app.connect(); const { plan, revision, confirmation } = await app.review(); hold = true;
    const running = app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    await entered.promise; await app.rpc({ type: 'PANEL_CANCEL', jobId: app.stored()!.job!.id }); release.resolve();
    expect((await running).ok).toBe(true);
    expect((await app.settledRun()).run?.status).toBe('stopped'); expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('shares a fresh initialization attempt after a storage read failure', async () => {
    const app = await fixture({ failLoads: 1 });
    await vi.waitFor(() => expect(app.get).toHaveBeenCalledOnce());
    const responses = await Promise.all([app.rpc({ type: 'PANEL_GET_STATE' }), app.rpc({ type: 'PANEL_GET_STATE' })]);
    expect(responses.every(result => result.ok)).toBe(true); expect(app.get).toHaveBeenCalledTimes(2);
  });

  it('recovers interrupted state through a fresh read without replaying the write', async () => {
    const initial: SessionState = { schemaVersion: 5, connection: connection(), job: { id: 'old-job', connectionId: connection().generation, kind: 'apply', status: 'running', month: '2026-11', startedAt: 'x', updatedAt: 'x' }, run: { planId: 'old', status: 'running', results: [{ date: '2026-11-03', status: 'running', message: 'Interrupted' }], startedAt: 'x', updatedAt: 'x' } };
    const app = await fixture({ initial });
    const restored = await app.rpc({ type: 'PANEL_GET_STATE' });
    expect(restored.state?.run?.results[0].status).toBe('uncertain'); expect(restored.state?.job?.status).toBe('interrupted');
    expect(app.api.applyDay).not.toHaveBeenCalled();
    expect((await app.rpc({ type: 'PANEL_SCAN', month: '2026-11' })).ok).toBe(true);
    expect(app.api.recover).toHaveBeenCalledWith(connection(), 'old-job'); expect(app.api.scanMonth).toHaveBeenCalledOnce(); expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('returns a newer blocked state if canonical plan persistence fails', async () => {
    let rejectPlan = false;
    const app = await fixture({ beforeSave: async state => { if (rejectPlan && state.plan) throw new Error('Local plan storage failed'); } });
    await app.connect(); const scan = await app.rpc({ type: 'PANEL_SCAN', month: '2026-11' });
    const plan = buildMonthPlan(defaultSettings('2026-11'), scan.state!.snapshot!, {}, 1);
    const invalid = await app.rpc({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: scan.state!.planRevision, changeId: 'failed-plan' });
    rejectPlan = true;
    const response = await app.rpc({ type: 'PANEL_SAVE_PLAN', plan, lease: invalid.state!.editLease });
    expect(response.ok).toBe(false); expect(response.error).toContain('storage'); expect(response.state?.plan?.canReview).toBe(false);
    expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('requires canonical manual consent and passes the approved API account context to the writer', async () => {
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review();
    const command = { type: 'PANEL_APPLY', plan, expectedPlanRevision: revision };
    expect((await app.rpc(command)).ok).toBe(false); expect(app.api.applyDay).not.toHaveBeenCalled();
    const result = await app.rpc({ ...command, confirmation });
    expect(result.ok).toBe(true); expect((await app.settledRun()).run?.status).toBe('complete'); expect(app.api.applyDay).toHaveBeenCalledOnce();
    expect(app.api.applyDay.mock.calls[0].slice(0, 4)).toEqual([connection(), plan.days.find(day => day.action === 'create'), plan.snapshot.context, { planId: plan.id, planRevision: revision, contextFingerprint: confirmation.contextFingerprint, confirmation, executionFingerprint: confirmation.executionFingerprint }]);
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('stops after an uncertain HTTP write and never retries or falls back to the DOM', async () => {
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review();
    app.api.applyDay.mockRejectedValueOnce(Object.assign(new Error('Response lost after request'), { uncertain: true }));
    const result = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    expect(result.ok).toBe(true);
    expect((await app.settledRun()).run?.results.find(item => item.date === '2026-11-03')?.status).toBe('uncertain'); expect(app.api.applyDay).toHaveBeenCalledOnce();
    expect((await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation })).ok).toBe(false); expect(app.api.applyDay).toHaveBeenCalledOnce();
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('routes explicit checkpoints and consent-bound continuation without rebooking verified days', async () => {
    const app = await fixture(); await app.connect();
    const { plan, revision, confirmation } = await app.review(['2026-11-02', '2026-11-03'], ['2026-11-02']);
    const started = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation, options: { checkpointDates: ['2026-11-02'] } });
    expect(started.ok).toBe(true); const paused = await app.settledRun(); expect(paused.run?.status).toBe('paused'); expect(app.api.applyDay).toHaveBeenCalledOnce();
    const jobId = paused.job!.id;
    const command = { type: 'PANEL_CONTINUE', jobId, planId: plan.id, expectedPlanRevision: revision };
    expect((await app.rpc(command)).ok).toBe(false);
    expect((await app.rpc({ ...command, confirmation })).ok).toBe(false);
    expect((await app.rpc({ ...command, confirmation, jobId: 'stale' })).ok).toBe(false);
    expect(app.api.applyDay).toHaveBeenCalledOnce();
    const result = await app.rpc({ ...command, confirmation: { ...confirmation, checkpointId: paused.job!.checkpointId } });
    expect(result.ok).toBe(true); expect((await app.settledRun()).run?.status).toBe('complete');
    expect(app.api.applyDay.mock.calls.map(call => call[1].date)).toEqual(['2026-11-02', '2026-11-03']);
    expect(app.api.scanMonth).toHaveBeenCalledTimes(2);
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('acknowledges the canonical locked job before a long day finishes and bounds the lifetime pulse to that run', async () => {
    vi.useFakeTimers();
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review();
    const entered = deferred(), release = deferred();
    const save = app.api.applyDay.getMockImplementation()!;
    app.api.applyDay.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return save(...args); });
    const accepted = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    expect(accepted.ok).toBe(true); expect(accepted.state?.job?.status).toBe('running');
    expect(accepted.state?.run?.status).toBe('running'); expect(accepted.state!.revision).toBeGreaterThan(revision);
    await entered.promise;
    expect(app.stored()?.run?.status).toBe('running');
    expect((await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation })).ok).toBe(false);
    expect((await app.rpc({ type: 'PANEL_GET_STATE' })).state?.job?.id).toBe(accepted.state?.job?.id);
    await vi.advanceTimersByTimeAsync(360_000);
    expect(app.getPlatformInfo).toHaveBeenCalledTimes(18); expect(app.api.applyDay).toHaveBeenCalledOnce();
    release.resolve();
    expect((await app.settledRun()).run?.status).toBe('complete');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(app.getPlatformInfo).toHaveBeenCalledTimes(18);
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('returns immediate authorization errors without starting a lifetime pulse or writing', async () => {
    vi.useFakeTimers();
    const app = await fixture(); await app.connect(); const { plan, revision } = await app.review();
    const result = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision });
    expect(result.ok).toBe(false); expect(result.state?.job).toBeUndefined();
    await vi.advanceTimersByTimeAsync(360_000);
    expect(app.getPlatformInfo).not.toHaveBeenCalled(); expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('publishes a late asynchronous failure and stops its lifetime pulse without retrying', async () => {
    vi.useFakeTimers();
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review();
    const entered = deferred(), release = deferred();
    app.api.applyDay.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('Late uncertain response'), { uncertain: true }); });
    const accepted = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    expect(accepted.ok).toBe(true); await entered.promise;
    // A platform-information failure is not an attendance retry or an unhandled rejection.
    app.getPlatformInfo.mockRejectedValueOnce(new Error('Platform information unavailable'));
    await vi.advanceTimersByTimeAsync(40_000);
    release.resolve();
    const finished = await app.settledRun();
    expect(finished.error).toContain('Late uncertain response'); expect(finished.run?.status).toBe('failed');
    expect(finished.run?.results.find(item => item.date === '2026-11-03')?.status).toBe('uncertain');
    expect(finished.snapshot).toBeUndefined(); expect(finished.job).toBeUndefined();
    const pulseCount = app.getPlatformInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(app.getPlatformInfo).toHaveBeenCalledTimes(pulseCount); expect(app.api.applyDay).toHaveBeenCalledOnce();
  });

  it.each(['initial', 'final'] as const)('exposes a post-ACK %s journal failure through the canonical state RPC when storage cannot publish', async phase => {
    vi.useFakeTimers();
    const entered = deferred(), release = deferred(); let rejectJournal = false;
    const app = await fixture({ beforeSave: async state => {
      if (rejectJournal && state.run && (phase === 'initial' || state.run.results.some(result => result.status === 'verified'))) {
        entered.resolve(); await release.promise; throw new Error(`Fixture ${phase} journal unavailable`);
      }
    } });
    await app.connect(); const { plan, revision, confirmation } = await app.review();
    const publicationStart = app.publications.length; rejectJournal = true;
    const accepted = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    expect(accepted.ok).toBe(true); expect(accepted.state?.run?.status).toBe('running');
    await entered.promise; await vi.advanceTimersByTimeAsync(20_000);
    release.resolve();
    let current!: Reply;
    await vi.waitFor(async () => {
      current = await app.rpc({ type: 'PANEL_GET_STATE' });
      expect(current.state?.run?.status).toBe('failed'); expect(current.state?.job).toBeUndefined();
    });
    expect(current.ok).toBe(true); expect(current.state!.revision).toBeGreaterThan(accepted.state!.revision!);
    expect(current.state?.error).toContain(`Fixture ${phase} journal unavailable`);
    expect(current.state?.run?.journalError).toContain(`Fixture ${phase} journal unavailable`);
    expect(current.state?.snapshot).toBeUndefined(); expect(current.state?.plan?.canReview).toBe(false);
    expect(app.publications.slice(publicationStart).some(state => state.run?.status === 'failed' || state.run?.status === 'complete')).toBe(false);
    if (phase === 'initial') {
      expect(app.api.applyDay).not.toHaveBeenCalled();
      expect(current.state?.run?.results.find(result => result.date === '2026-11-03')?.status).toBe('pending');
    } else {
      expect(app.api.applyDay).toHaveBeenCalledOnce();
      expect(current.state?.run?.results.find(result => result.date === '2026-11-03')?.status).toBe('verified');
      expect(app.publications.slice(publicationStart).some(state => state.run?.results.some(result => result.status === 'verified'))).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(120_000); expect(app.getPlatformInfo).toHaveBeenCalledOnce();
    expect((await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation })).ok).toBe(false);
  });

  it('releases the lifetime pulse at a checkpoint and acknowledges continuation before reconciliation finishes', async () => {
    vi.useFakeTimers();
    const app = await fixture(); await app.connect();
    const { plan, revision, confirmation } = await app.review(['2026-11-02', '2026-11-03'], ['2026-11-02']);
    const started = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation, options: { checkpointDates: ['2026-11-02'] } });
    expect(started.ok).toBe(true);
    const paused = await app.settledRun(); expect(paused.run?.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(120_000); expect(app.getPlatformInfo).not.toHaveBeenCalled();
    const entered = deferred(), release = deferred();
    const scan = app.api.scanMonth.getMockImplementation()!;
    app.api.scanMonth.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return scan(...args); });
    const resumed = await app.rpc({ type: 'PANEL_CONTINUE', jobId: paused.job!.id, planId: plan.id, expectedPlanRevision: revision, confirmation: { ...confirmation, checkpointId: paused.job!.checkpointId } });
    expect(resumed.ok).toBe(true); expect(resumed.state?.job?.status).toBe('running');
    expect(resumed.state?.run?.status).toBe('running'); expect(resumed.state?.plan).toEqual(plan);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(40_000); expect(app.getPlatformInfo).toHaveBeenCalledTimes(2);
    expect(app.api.applyDay.mock.calls.map(call => call[1].date)).toEqual(['2026-11-02']);
    release.resolve();
    expect((await app.settledRun()).run?.status).toBe('complete');
    await vi.advanceTimersByTimeAsync(120_000); expect(app.getPlatformInfo).toHaveBeenCalledTimes(2);
    expect(app.api.applyDay.mock.calls.map(call => call[1].date)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('journals a late rejected continuation after its acknowledgement and makes no next write', async () => {
    vi.useFakeTimers();
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review(['2026-11-02', '2026-11-03'], ['2026-11-02']);
    await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation, options: { checkpointDates: ['2026-11-02'] } });
    const paused = await app.settledRun();
    const entered = deferred(), release = deferred();
    app.api.scanMonth.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('Reconciliation unavailable'); });
    const resumed = await app.rpc({ type: 'PANEL_CONTINUE', jobId: paused.job!.id, planId: plan.id, expectedPlanRevision: revision, confirmation: { ...confirmation, checkpointId: paused.job!.checkpointId } });
    expect(resumed.ok).toBe(true); await entered.promise; await vi.advanceTimersByTimeAsync(20_000);
    release.resolve();
    const failed = await app.settledRun();
    expect(failed.run?.status).toBe('failed'); expect(failed.error).toBe('Reconciliation unavailable');
    expect(failed.run?.results.find(item => item.date === '2026-11-02')?.status).toBe('verified');
    expect(failed.job).toBeUndefined(); expect(failed.snapshot).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000); expect(app.getPlatformInfo).toHaveBeenCalledOnce(); expect(app.api.applyDay).toHaveBeenCalledOnce();
  });

  it('stops the active lifetime pulse after cancellation without dispatching another day', async () => {
    vi.useFakeTimers();
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review(['2026-11-02', '2026-11-03']);
    const entered = deferred();
    app.api.applyDay.mockImplementationOnce(async (_connection, _day, _context, _authorization, _progress, signal) => {
      entered.resolve(); return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('Operation cancelled')), { once: true }));
    });
    const accepted = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    await entered.promise; await vi.advanceTimersByTimeAsync(40_000);
    expect((await app.rpc({ type: 'PANEL_CANCEL', jobId: accepted.state!.job!.id })).ok).toBe(true);
    expect((await app.settledRun()).run?.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(120_000); expect(app.getPlatformInfo).toHaveBeenCalledTimes(2); expect(app.api.applyDay).toHaveBeenCalledOnce();
  });

  it('rejects web pages, content scripts, foreign extensions and similar-looking panel paths', async () => {
    const app = await fixture();
    for (const sender of [
      { id: 'test', url: 'https://app.hibob.com/attendance/my-attendance' },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html', tab: { id: 1 } },
      { id: 'other', url: 'chrome-extension://test/sidepanel.html' },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html.evil' },
      { id: 'test', url: 'chrome-extension://evil/sidepanel.html' },
    ]) {
      expect((await app.rpc({ type: 'PANEL_CONNECT' }, sender)).ok).toBe(false);
      expect((await app.rpc({ type: 'PANEL_CONTINUE', jobId: 'fixture', planId: 'fixture', expectedPlanRevision: 0 }, sender)).ok).toBe(false);
    }
    expect(app.api.connect).not.toHaveBeenCalled();
    expect(app.receiver({ type: 'ADAPTER_PROGRESS', progress: { phase: 'apply', completed: 1, total: 1 } }, { id: 'test', tab: { id: 1 } }, () => {})).toBeUndefined();
  });
});

async function submissionReview(app: Awaited<ReturnType<typeof fixture>>) {
  const result = await app.rpc({ type: 'PANEL_REVIEW_SUBMISSION', month: '2026-11' });
  expect(result.ok).toBe(true);
  const review = result.state!.submissionReview!, revision = result.state!.submissionRevision!;
  const consent: SubmissionConsent = { reviewId: review.id, reviewRevision: revision, connectionId: review.connectionId, accountKey: review.accountKey, contentFingerprint: review.contentFingerprint, eligibilityFingerprint: review.eligibilityFingerprint, confirmed: true };
  return { review, revision, consent, command: { type: 'PANEL_SUBMIT_MONTH', reviewId: review.id, expectedSubmissionRevision: revision, submissionConsent: consent } };
}

describe('explicit month submission and passive reminder routing', () => {
  it('routes a fresh review and separate exact consent through one journalled Submit', async () => {
    const app = await fixture(); await app.connect();
    const review = await submissionReview(app);
    expect(app.api.reviewSubmission).toHaveBeenCalledOnce(); expect(app.api.submitMonth).not.toHaveBeenCalled();
    expect((await app.rpc({ ...review.command, submissionConsent: undefined })).ok).toBe(false);
    expect((await app.rpc({ ...review.command, submissionConsent: { ...review.consent, contentFingerprint: 'wrong' } })).ok).toBe(false);
    const response = await app.rpc(review.command);
    expect(response.ok).toBe(true); expect(response.state?.job?.kind).toBe('submit');
    const final = await app.settledSubmission();
    expect(final.submissionResult?.status).toBe('verified'); expect(app.submitWrites).toHaveLength(1);
    expect(app.api.submitMonth).toHaveBeenCalledOnce(); expect(app.api.applyDay).not.toHaveBeenCalled();
    expect(app.api.applyMonth).not.toHaveBeenCalled(); expect(app.api.preflightDay).not.toHaveBeenCalled();
    const journals = app.localWrites.flatMap(value => Object.values((value.submissionJournals ?? {}) as Record<string, SubmissionJournal>));
    expect(journals.map(journal => journal.status)).toEqual(['dispatching', 'awaiting-verification', 'verified']);
    expect(app.publications.some(state => state.submissionJournal?.status === 'awaiting-verification' && !state.submissionResult)).toBe(true);
    expect((await app.rpc(review.command)).ok).toBe(false); expect(app.submitWrites).toHaveLength(1);
  });

  it('an external Submit discovered before dispatch clears the reminder without another mutation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const app = await fixture(); await app.connect(); const review = await submissionReview(app);
    expect(app.badge.text).toHaveBeenLastCalledWith({ text: '1' });
    app.api.submitMonth.mockResolvedValueOnce({ month: '2026-11', status: 'verified', periodStatus: 'Submitted', message: 'Already submitted by the native application' });
    expect((await app.rpc(review.command)).ok).toBe(true);
    expect((await app.settledSubmission()).submissionResult?.status).toBe('verified');
    await vi.waitFor(() => expect(app.badge.text).toHaveBeenLastCalledWith({ text: '' }));
    expect(app.submitWrites).toEqual([]);
    expect(app.localWrites.some(value => value.submissionJournals)).toBe(false);
  });

  it('closing review revokes submission consent but does not alter existing bookings', async () => {
    const app = await fixture(); await app.connect(); const review = await submissionReview(app);
    expect((await app.rpc({ type: 'PANEL_DISMISS_SUBMISSION' })).ok).toBe(true);
    expect((await app.rpc(review.command)).ok).toBe(false);
    expect(app.api.submitMonth).not.toHaveBeenCalled(); expect(app.submitWrites).toEqual([]);
    expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('a failed durable pre-dispatch journal produces zero Submit requests', async () => {
    const app = await fixture({ beforeLocalSave: async value => { if (Object.values((value.submissionJournals ?? {}) as Record<string, SubmissionJournal>).some(journal => journal.status === 'dispatching')) throw new Error('Fixture durable submit journal unavailable'); } });
    await app.connect(); const review = await submissionReview(app); expect((await app.rpc(review.command)).ok).toBe(true);
    const final = await app.settledSubmission(); expect(final.submissionResult?.status).toBe('failed');
    expect(app.submitWrites).toHaveLength(0); expect(app.api.submitMonth).toHaveBeenCalledOnce();
    expect(final.error).toContain('durable submit journal unavailable');
  });

  it('an acknowledged Submit stays unverified until its independent readback finishes', async () => {
    const app = await fixture(); await app.connect(); const review = await submissionReview(app);
    const entered = deferred(), release = deferred();
    app.api.submitMonth.mockImplementationOnce(async (_connection, value, _consent, hooks) => {
      await hooks.beforeDispatch(); app.submitWrites.push(structuredClone(value)); await hooks.acknowledged(); entered.resolve(); await release.promise;
      return { month: value.month, status: 'verified', periodStatus: 'Submitted', submittedAt: new Date().toISOString(), message: 'Independent readback' };
    });
    expect((await app.rpc(review.command)).ok).toBe(true); await entered.promise;
    const pending = (await app.rpc({ type: 'PANEL_GET_STATE' })).state!;
    expect(pending.submissionResult).toBeUndefined(); expect(pending.submissionJournal?.status).toBe('awaiting-verification');
    expect((await app.rpc({ type: 'PANEL_CONNECT' })).ok).toBe(false);
    expect((await app.rpc({ type: 'PANEL_REVIEW_SUBMISSION', month: '2026-11' })).ok).toBe(false);
    release.resolve(); expect((await app.settledSubmission()).submissionResult?.status).toBe('verified');
    expect(app.submitWrites).toHaveLength(1);
  });

  it('an uncertain dispatched Submit is never repeated by panel opening or an alarm', async () => {
    const app = await fixture(); await app.connect(); const review = await submissionReview(app);
    app.api.submitMonth.mockImplementationOnce(async (_connection, value, _consent, hooks) => {
      await hooks.beforeDispatch(); app.submitWrites.push(structuredClone(value)); throw new Error('Fixture response lost after Submit');
    });
    await app.rpc(review.command); expect((await app.settledSubmission()).submissionResult?.status).toBe('uncertain');
    app.clicked({ windowId: 1, url: 'https://example.org' }); app.onAlarm(REMINDER_ALARM);
    await app.rpc({ type: 'PANEL_GET_STATE' });
    expect((await app.rpc(review.command)).ok).toBe(false); expect(app.submitWrites).toHaveLength(1);
    expect((app.localData().submissionJournals as Record<string, SubmissionJournal>)[app.accountKey].status).toBe('uncertain');
    expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('preserves another account’s uncertain journal when a different company submits', async () => {
    const app = await fixture(); await app.connect(); const first = await submissionReview(app);
    app.api.submitMonth.mockImplementationOnce(async (_connection, value, _consent, hooks) => {
      await hooks.beforeDispatch(); app.submitWrites.push(structuredClone(value)); throw new Error('Account A response lost');
    });
    await app.rpc(first.command); expect((await app.settledSubmission()).submissionResult?.status).toBe('uncertain');
    const other = { ...connection(), generation: 'other-company-scope', employeeId: 'employee-B', companyId: 'company-B', employeeLabel: 'Employee B', companyLabel: 'Company B' };
    const otherKey = await submissionAccountKey(other.employeeId, other.companyId);
    app.api.connect.mockResolvedValueOnce(other);
    expect((await app.connect()).ok).toBe(true);
    const second = await submissionReview(app); expect(second.review.accountKey).toBe(otherKey);
    await app.rpc(second.command); expect((await app.settledSubmission()).submissionResult?.status).toBe('verified');
    const journals = app.localData().submissionJournals as Record<string, SubmissionJournal>;
    expect(journals[app.accountKey].status).toBe('uncertain'); expect(journals[otherKey].status).toBe('verified');
    app.api.connect.mockResolvedValueOnce(connection());
    const reconnected = await app.connect(); expect(reconnected.ok).toBe(true);
    expect(reconnected.state?.submissionResult?.status).toBe('uncertain'); expect(reconnected.state?.submissionJournal?.accountKey).toBe(app.accountKey);
    expect(app.submitWrites).toHaveLength(2);
  });

  it('last-week alarms update badge hourly without opening login windows or sending a mutation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const app = await fixture(); await app.connect();
    expect(app.api.listSubmissionStatuses).toHaveBeenCalledOnce();
    expect(app.badge.text).toHaveBeenLastCalledWith({ text: '1' });
    const connectCount = app.api.connect.mock.calls.length;
    app.clicked({ windowId: 3, url: 'https://example.org' }); app.onAlarm(REMINDER_ALARM);
    await vi.waitFor(() => expect(app.open).toHaveBeenCalled());
    expect(app.api.listSubmissionStatuses).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60_000); app.onAlarm(REMINDER_ALARM);
    await vi.waitFor(() => expect(app.api.listSubmissionStatuses).toHaveBeenCalledTimes(2));
    expect(app.api.connect).toHaveBeenCalledTimes(connectCount); expect(app.api.scanMonth).not.toHaveBeenCalled();
    expect(app.api.submitMonth).not.toHaveBeenCalled(); expect(app.api.applyDay).not.toHaveBeenCalled();
    expect(app.executeScript).not.toHaveBeenCalled(); expect(app.sendMessage).not.toHaveBeenCalled();
    expect(app.badge.text.mock.calls.every(([value]) => !('tabId' in value))).toBe(true);
  });

  it('starts from durable reminder scope without restoring a credential or connecting implicitly', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const accountKey = await submissionAccountKey(connection().employeeId!, connection().companyId!);
    const app = await fixture({ initialLocal: { [REMINDER_STORAGE_KEY]: { schemaVersion: 1, enabled: true, activeAccountKey: accountKey, accounts: { [accountKey]: { trackedSinceMonth: '2026-11', statuses: {} } } } } });
    await app.rpc({ type: 'PANEL_GET_STATE' });
    expect(app.api.listSubmissionStatuses).not.toHaveBeenCalled(); expect(app.api.connect).not.toHaveBeenCalled();
    app.alarmValues.clear(); app.startup();
    await vi.waitFor(() => expect(app.api.listSubmissionStatuses).toHaveBeenCalledOnce());
    expect(app.alarmCreate).toHaveBeenCalledTimes(2); expect(app.api.connect).not.toHaveBeenCalled();
    expect(app.api.submitMonth).not.toHaveBeenCalled(); expect(app.api.scanMonth).not.toHaveBeenCalled();
  });

  it('an explicit disconnected session suppresses an older durable reminder scope on startup', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const accountKey = await submissionAccountKey(connection().employeeId!, connection().companyId!);
    const app = await fixture({ initial: { schemaVersion: 7, connection: { status: 'disconnected', generation: 'explicit-disconnect' } }, initialLocal: { [REMINDER_STORAGE_KEY]: { schemaVersion: 1, enabled: true, activeAccountKey: accountKey, accounts: { [accountKey]: { trackedSinceMonth: '2026-11', statuses: {} } } } } });
    await app.rpc({ type: 'PANEL_GET_STATE' }); app.startup(); await app.rpc({ type: 'PANEL_GET_STATE' });
    expect(app.api.listSubmissionStatuses).not.toHaveBeenCalled(); expect(app.badge.text).toHaveBeenLastCalledWith({ text: '' });
    expect((app.localData()[REMINDER_STORAGE_KEY] as { activeAccountKey?: string }).activeAccountKey).toBeUndefined();
  });

  it('disabling reminders suppresses badge and future alarm reads without granting submission authority', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const app = await fixture(); await app.connect();
    expect((await app.rpc({ type: 'PANEL_SET_REMINDERS', enabled: 'yes' })).ok).toBe(false);
    expect((await app.rpc({ type: 'PANEL_SET_REMINDERS', enabled: false })).ok).toBe(true);
    expect(app.badge.text).toHaveBeenLastCalledWith({ text: '' });
    await vi.advanceTimersByTimeAsync(60 * 60_000); app.onAlarm(REMINDER_ALARM);
    await vi.waitFor(() => expect(app.stored()?.reminder?.enabled).toBe(false));
    expect(app.api.listSubmissionStatuses).toHaveBeenCalledOnce(); expect(app.api.submitMonth).not.toHaveBeenCalled();
  });

  it('reminder storage failure does not send status or submission requests', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    const app = await fixture({ beforeLocalSave: async value => { if (value[REMINDER_STORAGE_KEY]) throw new Error('Fixture reminder storage unavailable'); } });
    const response = await app.connect(); expect(response.ok).toBe(false);
    expect(app.api.listSubmissionStatuses).not.toHaveBeenCalled(); expect(app.api.submitMonth).not.toHaveBeenCalled();
    expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('rejects reminder preference and Submit commands from every unsafe sender', async () => {
    const app = await fixture();
    for (const sender of [
      { id: 'test', url: 'https://app.hibob.com/attendance/my-attendance' },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html', tab: { id: 1 } },
      { id: 'other', url: 'chrome-extension://test/sidepanel.html' },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html.evil' },
    ]) {
      for (const command of [{ type: 'PANEL_REVIEW_SUBMISSION', month: '2026-11' }, { type: 'PANEL_SUBMIT_MONTH', reviewId: 'unsafe', expectedSubmissionRevision: 1 }, { type: 'PANEL_SET_REMINDERS', enabled: false }]) expect((await app.rpc(command, sender)).ok).toBe(false);
    }
    expect(app.api.reviewSubmission).not.toHaveBeenCalled(); expect(app.api.submitMonth).not.toHaveBeenCalled();
  });
});
