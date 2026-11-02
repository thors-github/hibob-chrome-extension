import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { AccountConfirmation, AdapterProgress, ApiConnection, ApplyAuthorization, AttendanceContext, BookingPlan, DayPlan, DaySnapshot, MonthSnapshot, PreflightResult, SessionState } from '../src/shared/types';
import { contextFingerprint } from '../src/shared/context';

const connection = (write = true): ApiConnection => ({ status: 'connected', generation: 'session-fixture', employeeId: 'employee-fixture', companyId: 'company-fixture', employeeLabel: 'Local fixture', companyLabel: 'Local company', transport: 'direct', capabilities: { read: true, write, overwrite: write } });
const snapshot = (): MonthSnapshot => ({ month: '2026-11', employeeLabel: 'Local fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', context: { mode: 'api-session', connectionId: 'session-fixture', employeeKey: 'employee-fixture', tenantKey: 'company-fixture' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) });
type Reply = { ok: boolean; state?: SessionState; error?: string; preflight?: PreflightResult };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../src/hibob/api-adapter'); });

async function fixture(options: { initial?: SessionState; failLoads?: number; beforeSave?: (state: SessionState) => Promise<void> } = {}) {
  let receiver!: (message: unknown, sender: object, respond: (response: Reply) => void) => unknown;
  let clicked!: (tab: { windowId: number; id?: number; url?: string }) => void;
  let stored = options.initial && structuredClone(options.initial);
  const publications: SessionState[] = [];
  const api = {
    connect: vi.fn(async (): Promise<ApiConnection> => connection()), disconnect: vi.fn(async () => {}),
    scanMonth: vi.fn(async (_connection: ApiConnection, _month: string, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<MonthSnapshot> => snapshot()),
    applyDay: vi.fn(async (_connection: ApiConnection, day: DayPlan, _context?: AttendanceContext, _authorization?: ApplyAuthorization, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<DaySnapshot> => ({ date: day.date, entries: day.proposed, reportedMinutes: day.netMinutes, editable: true, fingerprint: 'saved-fixture' })),
    preflightDay: vi.fn(async (_connection: ApiConnection, day: DayPlan, _context?: AttendanceContext, _authorization?: ApplyAuthorization, _progress?: (value: AdapterProgress) => void, _signal?: AbortSignal): Promise<PreflightResult> => ({ date: day.date, checked: true, saved: false, serverValidated: false, netMinutes: day.netMinutes! })),
    cancel: vi.fn(), assertIdle: vi.fn(async () => {}), recover: vi.fn(async (_connection: ApiConnection, _jobId: string) => {}),
  };
  vi.doMock('../src/hibob/api-adapter', () => ({ HiBobApiAdapter: class { connect = api.connect; disconnect = api.disconnect; scanMonth = api.scanMonth; applyDay = api.applyDay; preflightDay = api.preflightDay; cancel = api.cancel; assertIdle = api.assertIdle; recover = api.recover; } }));
  let failures = options.failLoads ?? 0;
  const get = vi.fn(async () => { if (failures-- > 0) throw new Error('Fixture session storage unavailable'); return { sessionState: stored }; });
  const set = vi.fn(async ({ sessionState }: { sessionState: SessionState }) => { await options.beforeSave?.(sessionState); stored = structuredClone(sessionState); publications.push(stored); });
  const open = vi.fn(async () => {}), reload = vi.fn(), sendMessage = vi.fn(), executeScript = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { session: { get, set } }, sidePanel: { open }, action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.3' }), reload, onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { sendMessage }, scripting: { executeScript },
  });
  await import('../src/background');
  const rpc = (message: object, sender: object = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) => new Promise<Reply>(resolve => receiver(message, sender, resolve));
  const connect = () => rpc({ type: 'PANEL_CONNECT' });
  async function review() {
    const scan = await rpc({ type: 'PANEL_SCAN', month: '2026-11' }); expect(scan.ok).toBe(true);
    const settings = { ...defaultSettings('2026-11'), excludedDates: getMonthDates('2026-11').filter(date => date !== '2026-11-03') };
    const candidate = buildMonthPlan(settings, scan.state!.snapshot!, {}, 1);
    const invalidation = await rpc({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: scan.state!.planRevision, changeId: 'review-fixture' });
    const result = await rpc({ type: 'PANEL_SAVE_PLAN', plan: candidate, lease: invalidation.state!.editLease });
    expect(result.ok).toBe(true);
    const plan = result.state!.plan!, revision = result.state!.planRevision!;
    const confirmation: AccountConfirmation = { planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmed: true };
    return { plan, revision, confirmation };
  }
  return { api, rpc, receiver, clicked, stored: () => stored, publications, connect, review, get, set, open, reload, sendMessage, executeScript };
}

describe('direct API background transport', () => {
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
    const app = await fixture({ initial: { schemaVersion: 4, run: history } });
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
    const result = await running; expect(result.state?.run?.status).toBe('stopped'); expect(app.api.applyDay).not.toHaveBeenCalled();
  });

  it('shares a fresh initialization attempt after a storage read failure', async () => {
    const app = await fixture({ failLoads: 1 });
    await vi.waitFor(() => expect(app.get).toHaveBeenCalledOnce());
    const responses = await Promise.all([app.rpc({ type: 'PANEL_GET_STATE' }), app.rpc({ type: 'PANEL_GET_STATE' })]);
    expect(responses.every(result => result.ok)).toBe(true); expect(app.get).toHaveBeenCalledTimes(2);
  });

  it('recovers interrupted state through a fresh read without replaying the write', async () => {
    const initial: SessionState = { schemaVersion: 4, connection: connection(), job: { id: 'old-job', connectionId: connection().generation, kind: 'apply', status: 'running', month: '2026-11', startedAt: 'x', updatedAt: 'x' }, run: { planId: 'old', status: 'running', results: [{ date: '2026-11-03', status: 'running', message: 'Interrupted' }], startedAt: 'x', updatedAt: 'x' } };
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
    expect(result.ok).toBe(true); expect(result.state?.run?.status).toBe('complete'); expect(app.api.applyDay).toHaveBeenCalledOnce();
    expect(app.api.applyDay.mock.calls[0].slice(0, 4)).toEqual([connection(), plan.days.find(day => day.action === 'create'), plan.snapshot.context, { planId: plan.id, planRevision: revision, contextFingerprint: confirmation.contextFingerprint, confirmation }]);
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('stops after an uncertain HTTP write and never retries or falls back to the DOM', async () => {
    const app = await fixture(); await app.connect(); const { plan, revision, confirmation } = await app.review();
    app.api.applyDay.mockRejectedValueOnce(Object.assign(new Error('Response lost after request'), { uncertain: true }));
    const result = await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation });
    expect(result.state?.run?.results.find(item => item.date === '2026-11-03')?.status).toBe('uncertain'); expect(app.api.applyDay).toHaveBeenCalledOnce();
    expect((await app.rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation })).ok).toBe(false); expect(app.api.applyDay).toHaveBeenCalledOnce();
    expect(app.sendMessage).not.toHaveBeenCalled(); expect(app.executeScript).not.toHaveBeenCalled();
  });

  it('rejects web pages, content scripts, foreign extensions and similar-looking panel paths', async () => {
    const app = await fixture();
    for (const sender of [
      { id: 'test', url: 'https://app.hibob.com/attendance/my-attendance' },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html', tab: { id: 1 } },
      { id: 'other', url: 'chrome-extension://test/sidepanel.html' },
      { id: 'test', url: 'chrome-extension://test/sidepanel.html.evil' },
      { id: 'test', url: 'chrome-extension://evil/sidepanel.html' },
    ]) expect((await app.rpc({ type: 'PANEL_CONNECT' }, sender)).ok).toBe(false);
    expect(app.api.connect).not.toHaveBeenCalled();
    expect(app.receiver({ type: 'ADAPTER_PROGRESS', progress: { phase: 'apply', completed: 1, total: 1 } }, { id: 'test', tab: { id: 1 } }, () => {})).toBeUndefined();
  });
});
