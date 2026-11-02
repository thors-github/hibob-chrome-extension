import { describe, expect, it, vi } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { ApiConnection, BookingPlan, DayPlan, DaySnapshot, PreflightResult, MonthSnapshot, SessionState } from '../src/shared/types';
import { isHiBobAttendance, isHiBobOrigin } from '../src/shared/validation';
import { contextFingerprint } from '../src/shared/context';
import type { AccountConfirmation } from '../src/shared/types';

const connection = (generation = 'connection-42'): ApiConnection => ({ status: 'connected', generation, employeeId: 'employee-review', companyId: 'tenant-review', employeeLabel: 'Testperson', companyLabel: 'Fixture company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } });
const consentFor = (plan: BookingPlan, revision: number): AccountConfirmation => ({ planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmed: true });
function snapshot(current = connection()): MonthSnapshot {
  return {
    month: '2026-11', employeeLabel: 'Testperson', periodLabel: '01/11/2026–30/11/2026', scannedAt: '2026-11-02T10:00:00Z', source: 'hibob', context: { mode: 'api-session', connectionId: current.generation, employeeKey: current.employeeId!, tenantKey: current.companyId! },
    days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: `empty-${date}` })),
  };
}

async function setup(initial?: SessionState) {
  let stored = initial;
  const bridge: ControllerBridge = {
    load: async () => stored,
    save: vi.fn(async state => { stored = structuredClone(state); }),
    scan: vi.fn(async current => snapshot(current)),
    connect: vi.fn(async () => connection()), disconnect: vi.fn(async () => {}),
    applyDay: vi.fn(async (_connection: ApiConnection, day: DayPlan) => ({ date: day.date, editable: true, entries: day.proposed, fingerprint: 'saved' })),
    preflightDay: vi.fn(async (_connection: ApiConnection, day: DayPlan) => ({ date: day.date, checked: true as const, saved: false as const, serverValidated: false as const, netMinutes: day.netMinutes! })),
    cancel: vi.fn(async () => {}),
  };
  const controller = new BookingController(bridge);
  await controller.init();
  if (!initial) { await controller.bindConnection(connection()); await controller.scan('2026-11'); }
  return { controller, bridge, stored: () => stored };
}

async function review(controller: BookingController, input: BookingPlan) {
  const state = await controller.invalidatePlan(controller.state.planRevision ?? 0, crypto.randomUUID());
  return controller.savePlan(input, state.editLease!);
}

function applyReviewed(controller: BookingController, input: BookingPlan) { return controller.apply(input, controller.state.planRevision!, consentFor(input, controller.state.planRevision!)); }

function planFor(controller: BookingController): BookingPlan {
  return buildMonthPlan(defaultSettings('2026-11'), controller.state.snapshot!, {}, 1234);
}

// Matches the observed Chrome storage behaviour: recursively reorder dictionary
// keys and omit undefined object properties, without rearranging arrays.
function chromeStored<T>(input: T): T {
  const value = JSON.parse(JSON.stringify(input));
  const reorder = (item: unknown): unknown => Array.isArray(item) ? item.map(reorder) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).reverse().map(([key, child]) => [key, reorder(child)])) : item;
  return reorder(value) as T;
}

describe('single-day API preflight without booking', () => {
  async function reviewedPreflight() {
    const app = await setup();
    app.controller.state.run = { planId: 'previous-real-run', status: 'failed', startedAt: '2026-11-02', updatedAt: '2026-11-02', results: [{ date: '2026-11-02', status: 'failed', message: 'Original booking failed before Save' }] };
    await review(app.controller, planFor(app.controller));
    const plan = structuredClone(app.controller.state.plan!);
    const revision = app.controller.state.planRevision!;
    const day = plan.days.find(item => item.action === 'create')!;
    const history = structuredClone(app.controller.state.run);
    const confirmation = consentFor(plan, revision);
    vi.mocked(app.bridge.save).mockClear();
    return { ...app, plan, revision, day, history, confirmation };
  }

  it('returns only read-only preflight evidence, preserves history and requires a fresh scan', async () => {
    const app = await reviewedPreflight();
    const response = await app.controller.preflight(app.plan, app.revision, app.day.date, app.confirmation);
    expect(response.preflight).toEqual({ date: app.day.date, checked: true, saved: false, serverValidated: false, netMinutes: 480 });
    expect(app.bridge.preflightDay).toHaveBeenCalledWith(connection(), app.day, app.plan.snapshot.context, expect.any(String), { planId: app.plan.id, planRevision: app.revision, contextFingerprint: app.confirmation.contextFingerprint, confirmation: app.confirmation });
    expect(app.bridge.applyDay).not.toHaveBeenCalled();
    expect(response.state.run).toEqual(app.history);
    expect(response.state.snapshot).toBeUndefined(); expect(response.state.plan?.canReview).toBe(false);
    expect(response.state.planRevision).toBeGreaterThan(app.revision);
    for (const [state] of vi.mocked(app.bridge.save).mock.calls) {
      expect(state.run).toEqual(app.history);
      expect((state as SessionState & { preflight?: unknown }).preflight).toBeUndefined();
    }
    await expect(app.controller.preflight(app.plan, app.revision, app.day.date, app.confirmation)).rejects.toThrow('Vorschau');
  });

  it('requires fresh consent and approved included dates before creating a job', async () => {
    const app = await reviewedPreflight();
    await expect(app.controller.preflight(app.plan, app.revision, app.day.date)).rejects.toThrow('bestätigen');
    await expect(app.controller.preflight(app.plan, app.revision, app.day.date, { ...app.confirmation, planRevision: app.revision - 1 })).rejects.toThrow('bestätigen');
    await expect(app.controller.preflight(app.plan, app.revision - 1, app.day.date, app.confirmation)).rejects.toThrow('Vorschau');
    for (const date of ['2026-12-03', '2026-11-01', 'not-a-date']) await expect(app.controller.preflight(app.plan, app.revision, date, app.confirmation)).rejects.toThrow('nicht zum Schreiben');
    expect(app.bridge.preflightDay).not.toHaveBeenCalled(); expect(app.bridge.applyDay).not.toHaveBeenCalled();
    expect(app.controller.state.job).toBeUndefined();
  });

  it.each(['date', 'netMinutes', 'saved', 'checked', 'serverValidated', 'missing'] as const)('rejects invalid %s evidence without writes', async field => {
    const app = await reviewedPreflight();
    const result: PreflightResult = { date: app.day.date, checked: true, saved: false, serverValidated: false, netMinutes: app.day.netMinutes! };
    const wrong = field === 'missing' ? undefined : { ...result, [field]: field === 'date' ? '2026-12-03' : field === 'netMinutes' ? 481 : field === 'saved' || field === 'serverValidated' ? true : false };
    vi.mocked(app.bridge.preflightDay).mockResolvedValueOnce(wrong as PreflightResult);
    await expect(app.controller.preflight(app.plan, app.revision, app.day.date, app.confirmation)).rejects.toThrow('Vorprüfung');
    expect(app.controller.state.run).toEqual(app.history); expect(app.controller.state.snapshot).toBeUndefined();
    expect(app.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('holds the exclusive lock and cancels using the connection generation', async () => {
    const app = await reviewedPreflight();
    let entered!: () => void; let release!: (result: PreflightResult) => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(app.bridge.preflightDay).mockImplementationOnce(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const checking = app.controller.preflight(app.plan, app.revision, app.day.date, app.confirmation);
    await held;
    const job = structuredClone(app.controller.state.job!);
    expect(job.connectionId).toBe(connection().generation); expect(job.tabId).toBeUndefined();
    await expect(app.controller.activateUpdate()).rejects.toThrow('laufenden Vorgangs');
    await expect(app.controller.connect()).rejects.toThrow('läuft bereits');
    await expect(app.controller.disconnect()).rejects.toThrow('läuft bereits');
    await expect(app.controller.scan('2026-11')).rejects.toThrow('läuft bereits');
    await expect(app.controller.cancel('stale-job')).rejects.toThrow('geändert');
    await app.controller.cancel(job.id);
    expect(app.bridge.cancel).toHaveBeenCalledWith(connection(), job.id);
    release({ date: app.day.date, checked: true, saved: false, serverValidated: false, netMinutes: 480 });
    await expect(checking).rejects.toThrow('abgebrochen');
    expect(app.controller.state.run).toEqual(app.history); expect(app.controller.state.job).toBeUndefined();
    expect(app.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('allows preflight on a read-only connection while preventing booking', async () => {
    const app = await setup();
    await app.controller.bindConnection({ ...connection(), capabilities: { read: true, write: false, overwrite: false } });
    await app.controller.scan('2026-11'); await review(app.controller, planFor(app.controller));
    const plan = app.controller.state.plan!; const rev = app.controller.state.planRevision!; const approval = consentFor(plan, rev);
    await expect(app.controller.apply(plan, rev, approval)).rejects.toThrow('Vorprüfung');
    expect(app.controller.state.plan?.canReview).toBe(true);
    await expect(app.controller.preflight(plan, rev, '2026-11-02', approval)).resolves.toHaveProperty('preflight.checked', true);
    expect(app.bridge.applyDay).not.toHaveBeenCalled();
  });

  it.each(['initial', 'final'] as const)('fails closed on %s storage failure without altering history', async phase => {
    const app = await reviewedPreflight();
    if (phase === 'initial') vi.mocked(app.bridge.save).mockRejectedValueOnce(new Error('CHECK_INITIAL_STORAGE'));
    else { const save = app.bridge.save; app.bridge.save = vi.fn(async state => { if (!state.job && !state.snapshot) throw new Error('CHECK_FINAL_STORAGE'); await save(state); }); }
    await expect(app.controller.preflight(app.plan, app.revision, app.day.date, app.confirmation)).rejects.toThrow(phase === 'initial' ? 'CHECK_INITIAL_STORAGE' : 'CHECK_FINAL_STORAGE');
    expect(app.bridge.preflightDay).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
    expect(app.bridge.applyDay).not.toHaveBeenCalled(); expect(app.controller.state.run).toEqual(app.history);
  });
});

describe('write queue and recovery', () => {
  it('accepts reviewed snapshots and plans after Chrome storage reorders nested object keys', async () => {
    const { controller, bridge } = await setup();
    const source = controller.state.snapshot!;
    source.days[1].entries = [{ type: 'work', start: '08:00', end: '16:00', note: undefined }];
    source.days[1].absence = undefined; source.days[1].reportedMinutes = 480;
    const settings = { ...defaultSettings('2026-11'), variable: true };
    const input = buildMonthPlan(settings, chromeStored(source), { '2026-11-02': 'skip' }, 1234);
    expect(JSON.stringify(input.snapshot)).not.toBe(JSON.stringify(source));
    await review(controller, input);
    const reviewed = chromeStored(controller.state.plan!);
    expect(JSON.stringify(reviewed)).not.toBe(JSON.stringify(controller.state.plan));
    await applyReviewed(controller, reviewed);
    expect(controller.state.run?.status).toBe('complete');
    expect(bridge.applyDay).toHaveBeenCalledTimes(20);
  });

  it('still rejects modified nested times and reordered day arrays after storage roundtrip', async () => {
    const { controller, bridge } = await setup();
    await review(controller, chromeStored(planFor(controller)));
    const changed = chromeStored(controller.state.plan!);
    changed.days.find(day => day.action === 'create')!.proposed[0].start = '00:00';
    await expect(applyReviewed(controller, changed)).rejects.toThrow('Vorschau');
    const reordered = chromeStored(controller.state.plan!);
    reordered.days.reverse();
    await expect(applyReviewed(controller, reordered)).rejects.toThrow('Vorschau');
    const stale = chromeStored(planFor(controller));
    stale.snapshot.days[1].fingerprint = 'changed';
    await expect(review(controller, stale)).rejects.toThrow('Lesestand');
    expect(bridge.applyDay).not.toHaveBeenCalled();
  });

  it('clears a previous scan and reviewed plan when the tab is unbound or changed', async () => {
    const { controller, bridge, stored } = await setup();
    await review(controller, planFor(controller));
    const original = structuredClone(controller.state.plan!);
    await controller.bindConnection(undefined, 'Bitte HiBob öffnen.');
    expect(stored()).toMatchObject({ error: 'Bitte HiBob öffnen.', schemaVersion: 5 });
    expect(stored()?.tabId).toBeUndefined();
    await expect(controller.scan('2026-11')).rejects.toThrow('anmelden');
    await expect(applyReviewed(controller, original)).rejects.toThrow('Vorschau');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    await controller.bindConnection(connection('connection-99'));
    expect(controller.state).toMatchObject({ connection: connection('connection-99'), error: undefined, schemaVersion: 5 });
    await controller.scan('2026-11');
    await review(controller, planFor(controller));
    await controller.bindConnection(connection('connection-100'));
    expect(controller.state.snapshot).toBeUndefined();
    expect(controller.state.plan).toBeUndefined();
    expect(controller.state.connection?.generation).toBe('connection-100');
  });

  it('recomputes proposals from the stored scan rather than trusting UI segments', async () => {
    const { controller } = await setup();
    const plan = planFor(controller);
    const forged = structuredClone(plan);
    const day = forged.days.find(d => d.action === 'create')!;
    day.proposed = [{ type: 'work', start: '00:00', end: '23:59' }];
    await review(controller, forged);
    expect(controller.state.plan!.days.find(d => d.date === day.date)!.proposed).not.toEqual(day.proposed);
    expect(controller.state.plan).toEqual(plan);
  });

  it('rejects a plan from a different scan or tab', async () => {
    const { controller } = await setup();
    const plan = structuredClone(planFor(controller));
    plan.snapshot.scannedAt = 'different-scan';
    await expect(review(controller, plan)).rejects.toThrow('Lesestand');
  });

  it('stops after an uncertain write and requires a new scan before any retry', async () => {
    const { controller, bridge } = await setup();
    const plan = planFor(controller);
    await review(controller, plan);
    vi.mocked(bridge.applyDay).mockRejectedValueOnce(Object.assign(new Error('Verbindung unterbrochen'), { uncertain: true }));
    await applyReviewed(controller, controller.state.plan!);
    expect(bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(controller.state.run?.status).toBe('failed');
    expect(controller.state.run?.results.filter(r => r.status === 'uncertain')).toHaveLength(1);
    expect(controller.state.snapshot).toBeUndefined();
    expect(controller.state.plan?.canReview).toBe(false);
    await expect(applyReviewed(controller, plan)).rejects.toThrow();
    await expect(review(controller, plan)).rejects.toThrow('Lesestand');
    expect(bridge.applyDay).toHaveBeenCalledTimes(1);
  });

  it('serializes writes, rejects duplicate starts and cancels between days', async () => {
    const { controller, bridge } = await setup();
    await review(controller, planFor(controller));
    const plan = structuredClone(controller.state.plan!);
    let resolveFirst!: (day: DaySnapshot) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(bridge.applyDay).mockImplementationOnce(async (_tabId, day) => {
      started();
      return new Promise<DaySnapshot>(resolve => { resolveFirst = resolve; });
    });
    const running = applyReviewed(controller, plan);
    await entered;
    await expect(applyReviewed(controller, plan)).rejects.toThrow('bereits');
    await expect(controller.bindConnection(connection('connection-99'))).rejects.toThrow('bereits');
    await controller.cancel();
    const first = plan.days.find(d => d.action === 'create')!;
    resolveFirst({ date: first.date, entries: first.proposed, editable: true, fingerprint: 'saved' });
    await running;
    expect(bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(controller.state.run?.status).toBe('stopped');
    expect(controller.state.run?.results.filter(r => r.status === 'verified')).toHaveLength(1);
  });

  it('marks interrupted work as uncertain when the service worker restarts', async () => {
    const { controller } = await setup();
    const plan = planFor(controller);
    const { controller: restored, stored } = await setup({
      connection: connection(), snapshot: snapshot(), plan,
      run: { planId: plan.id, status: 'running', startedAt: 'x', updatedAt: 'x', results: [{ date: '2026-11-02', status: 'running', message: 'saving' }] },
    });
    expect(restored.state.run?.status).toBe('stopped');
    expect(stored()?.run?.results[0].status).toBe('uncertain');
    expect(restored.state.snapshot).toBeUndefined();
    expect(restored.state.plan).toBeUndefined();
  });

  it('completes once and will not apply the same scan twice', async () => {
    const { controller, bridge } = await setup();
    await review(controller, planFor(controller));
    const plan = structuredClone(controller.state.plan!);
    await applyReviewed(controller, plan);
    expect(controller.state.run?.status).toBe('complete');
    expect(bridge.applyDay).toHaveBeenCalledTimes(plan.days.filter(d => d.action === 'create').length);
    await expect(applyReviewed(controller, plan)).rejects.toThrow();
  });

  it('honours cancellation while waiting for the pre-write journal', async () => {
    const { controller, bridge } = await setup();
    await review(controller, planFor(controller));
    let release!: () => void;
    let entered!: () => void;
    const journalEntered = new Promise<void>(resolve => { entered = resolve; });
    const originalSave = bridge.save;
    bridge.save = vi.fn(async (state: SessionState) => {
      if (state.run?.results.some(r => r.status === 'running')) {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
      }
      await originalSave(state);
    });
    const active = applyReviewed(controller, structuredClone(controller.state.plan!));
    await journalEntered;
    await controller.cancel();
    release();
    await active;
    expect(bridge.applyDay).not.toHaveBeenCalled();
    expect(controller.state.run?.status).toBe('stopped');
  });

  it('releases its queue when session storage rejects before a scan or write', async () => {
    const { controller, bridge } = await setup();
    vi.mocked(bridge.save).mockRejectedValueOnce(new Error('Speicher nicht verfügbar'));
    await expect(controller.scan('2026-11')).rejects.toThrow('Speicher');
    await expect(controller.scan('2026-11')).resolves.toHaveProperty('snapshot');
    await review(controller, planFor(controller));
    vi.mocked(bridge.save).mockRejectedValueOnce(new Error('Journal nicht verfügbar'));
    await expect(applyReviewed(controller, structuredClone(controller.state.plan!))).rejects.toThrow('Journal');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    await expect(controller.scan('2026-11')).resolves.toHaveProperty('snapshot');
  });
});

describe('origin boundaries', () => {
  it('accepts only the exact HiBob host and attendance path', () => {
    expect(isHiBobAttendance('https://app.hibob.com/attendance/my-attendance?x=1')).toBe(true);
    for (const url of ['https://app.hibob.com.evil.test/attendance/my-attendance', 'http://app.hibob.com/attendance/my-attendance', 'https://app.hibob.com/attendance/people', 'https://evil.test', 'not a url']) expect(isHiBobAttendance(url)).toBe(false);
    expect(isHiBobOrigin('https://app.hibob.com/home')).toBe(true);
    expect(isHiBobOrigin('https://app.hibob.com:444/home')).toBe(false);
  });
});

describe('canonical edit leases, journaling, and job recovery', () => {
  it('globally revokes another panel approval and treats only the current change id as idempotent', async () => {
    const { controller, bridge } = await setup();
    await review(controller, planFor(controller));
    const previousPlan = structuredClone(controller.state.plan!);
    const previousRevision = controller.state.planRevision!;
    const invalid = await controller.invalidatePlan(previousRevision, 'new-settings');
    expect(invalid.plan).toBeUndefined();
    await expect(controller.apply(previousPlan, previousRevision)).rejects.toThrow('Vorschau');
    const idempotent = await controller.invalidatePlan(previousRevision, 'new-settings');
    expect(idempotent.planRevision).toBe(invalid.planRevision);
    await expect(controller.invalidatePlan(previousRevision, 'late-other-settings')).rejects.toThrow('Vorschau');
    expect(bridge.applyDay).not.toHaveBeenCalled();
  });

  it('does not approve an older save that completes after a newer invalidation', async () => {
    const { controller, bridge } = await setup();
    const input = planFor(controller);
    const first = await controller.invalidatePlan(controller.state.planRevision!, 'first-edit');
    let entered!: () => void; let release!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const original = bridge.save;
    vi.mocked(bridge.save).mockImplementationOnce(async state => { entered(); await new Promise<void>(resolve => { release = resolve; }); await original(state); });
    const oldSave = controller.savePlan(input, first.editLease!).then(() => undefined, error => error as Error);
    await saving;
    const newerInvalidation = controller.invalidatePlan(first.planRevision!, 'newer-edit');
    release();
    expect(await oldSave).toBeInstanceOf(Error);
    const newer = await newerInvalidation;
    expect(controller.state.plan).toBeUndefined();
    await expect(controller.apply(input, first.planRevision!)).rejects.toThrow('Vorschau');
    const next = buildMonthPlan({ ...defaultSettings('2026-11'), start: '09:00', end: '17:30' }, controller.state.snapshot!, {}, 1234);
    await controller.savePlan(next, newer.editLease!);
    expect(controller.state.plan?.settings.start).toBe('09:00');
  });

  it('requires successful canonical persistence and permits the same proposal and seed to be retried', async () => {
    const { controller, bridge } = await setup();
    const input = planFor(controller);
    const invalid = await controller.invalidatePlan(controller.state.planRevision!, 'retry-edit');
    vi.mocked(bridge.save).mockRejectedValueOnce(new Error('canonical storage failed'));
    await expect(controller.savePlan(input, invalid.editLease!)).rejects.toThrow('storage');
    const failedPublication = vi.mocked(bridge.save).mock.calls.at(-1)![0];
    expect(controller.state.revision).toBeGreaterThan(failedPublication.revision!);
    expect(controller.state.error).toBe('canonical storage failed');
    await expect(controller.apply(input, invalid.planRevision!)).rejects.toThrow('Vorschau');
    await controller.savePlan(input, invalid.editLease!);
    expect(controller.state.plan?.seed).toBe(input.seed);
    expect(controller.state.plan?.canReview).toBe(true);
    await controller.apply(controller.state.plan!, invalid.planRevision!, consentFor(controller.state.plan!, invalid.planRevision!));
    expect(bridge.applyDay).toHaveBeenCalledTimes(21);
  });

  it('retains verified remote outcomes when the following local journal update fails', async () => {
    const { controller, bridge, stored } = await setup();
    await review(controller, planFor(controller));
    let failed = false;
    const original = bridge.save;
    bridge.save = vi.fn(async (state: SessionState) => {
      if (!failed && state.run?.results.some(result => result.status === 'verified')) { failed = true; throw new Error('post-verification storage failed'); }
      await original(state);
    });
    await applyReviewed(controller, structuredClone(controller.state.plan!));
    expect(bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(controller.state.run?.status).toBe('failed');
    expect(controller.state.run?.results.filter(result => result.status === 'verified')).toHaveLength(1);
    expect(controller.state.run?.results.some(result => result.status === 'failed')).toBe(false);
    expect(stored()?.run?.journalError).toContain('post-verification');
    expect(controller.state.snapshot).toBeUndefined();
  });

  it('preserves the primary remote error if final journal persistence also fails', async () => {
    const { controller, bridge } = await setup();
    await review(controller, planFor(controller));
    vi.mocked(bridge.applyDay).mockRejectedValueOnce(Object.assign(new Error('REMOTE_PRIMARY'), { uncertain: true }));
    const original = bridge.save;
    bridge.save = vi.fn(async (state: SessionState) => { if (state.run?.status === 'failed') throw new Error('JOURNAL_SECONDARY'); await original(state); });
    await expect(applyReviewed(controller, structuredClone(controller.state.plan!))).rejects.toThrow('REMOTE_PRIMARY');
    expect(controller.state.error).toContain('JOURNAL_SECONDARY');
    expect(controller.state.run?.results.find(result => result.status === 'uncertain')?.message).toBe('REMOTE_PRIMARY');
  });

  it('migrates a legacy interrupted scan to explicit recovery and checks adapter idleness before a new scan', async () => {
    const { controller, bridge } = await setup({ schemaVersion: 5, connection: connection(), progress: { phase: 'scan', completed: 12, total: 30, message: 'Reading' } });
    const oldJob = controller.state.job!;
    expect(oldJob.status).toBe('interrupted');
    expect(controller.state.progress).toBeUndefined();
    bridge.recover = vi.fn(async () => {});
    await controller.scan('2026-11');
    expect(bridge.recover).toHaveBeenCalledWith(connection(), oldJob.id);
    expect(controller.state.job).toBeUndefined();
    expect(controller.state.schemaVersion).toBe(5);
  });

  it('persists an active scan, rejects stale progress and cancellation, and ignores progress after completion', async () => {
    const { controller, bridge, stored } = await setup();
    let entered!: () => void; let release!: (value: MonthSnapshot) => void;
    const scanning = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(bridge.scan).mockImplementationOnce(async () => { entered(); return new Promise<MonthSnapshot>(resolve => { release = resolve; }); });
    const running = controller.scan('2026-11'); await scanning;
    const job = controller.state.job!;
    expect(stored()?.job).toMatchObject({ id: job.id, kind: 'scan', status: 'running' });
    await expect(controller.bindConnection(connection())).resolves.toBeUndefined();
    await expect(controller.bindConnection(connection('connection-99'))).rejects.toThrow('bereits');
    await expect(controller.bindConnection(undefined)).rejects.toThrow('bereits');
    expect(controller.state.job?.id).toBe(job.id);
    await controller.reportProgress({ jobId: 'old-job', phase: 'scan', completed: 12, total: 30, message: 'stale' });
    expect(controller.state.progress?.completed).toBe(0);
    await controller.reportProgress({ jobId: job.id, phase: 'scan', completed: 12, total: 30, message: 'current' });
    expect(stored()?.progress?.completed).toBe(12);
    await expect(controller.cancel('old-job')).rejects.toThrow('geändert');
    expect(bridge.cancel).not.toHaveBeenCalled();
    release(snapshot()); await running;
    await controller.reportProgress({ jobId: job.id, phase: 'scan', completed: 29, total: 30, message: 'late' });
    expect(controller.state.progress).toBeUndefined();
  });

  it('keeps publication revisions increasing across binding resets and rejects malformed stored jobs', async () => {
    const { controller } = await setup();
    const prior = controller.state.revision!;
    await controller.bindConnection(undefined);
    expect(controller.state.revision).toBeGreaterThan(prior);
    await controller.bindConnection(connection('connection-99'));
    expect(controller.state.revision).toBeGreaterThan(prior + 1);
    await expect(setup({ schemaVersion: 5, job: { id: 'bad', kind: 'other' } as never })).rejects.toThrow('ungültig');
    await expect(setup({ run: { status: 'unknown', results: [] } as never })).rejects.toThrow('ungültig');
  });
});

describe('recovery publication and cold canonical state', () => {
  it('publishes a running scan while recovering an old adapter and allows cancellation before scanning', async () => {
    const { controller, bridge, stored } = await setup({ schemaVersion: 5, connection: connection(), progress: { phase: 'scan', completed: 12, total: 30, message: 'old' } });
    const oldJobId = controller.state.job!.id;
    let entered!: () => void; let release!: () => void;
    const recovering = new Promise<void>(resolve => { entered = resolve; });
    bridge.recover = vi.fn(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const scan = controller.scan('2026-11').then(() => undefined, error => error as Error);
    await recovering;
    const current = stored()?.job!;
    expect(current).toMatchObject({ kind: 'scan', status: 'running' });
    expect(current.id).not.toBe(oldJobId);
    await controller.cancel(current.id);
    release();
    expect(await scan).toBeInstanceOf(Error);
    expect(bridge.scan).not.toHaveBeenCalled();
    expect(controller.state.job).toBeUndefined();
  });

  it('restores only a durable canonical proposal and rejects modified persisted plan contents', async () => {
    const { controller } = await setup();
    const varied = buildMonthPlan({ ...defaultSettings('2026-11'), variable: true }, controller.state.snapshot!, {}, 1234);
    await review(controller, varied);
    const durable = chromeStored(controller.state);
    const restored = await setup(durable);
    expect(restored.controller.state.plan?.id).toBe(varied.id);
    expect(restored.controller.state.plan?.seed).toBe(varied.seed);
    expect(restored.controller.state.plan?.days.map(day => day.proposed)).toEqual(varied.days.map(day => day.proposed));
    await restored.controller.apply(restored.controller.state.plan!, durable.planRevision!, consentFor(restored.controller.state.plan!, durable.planRevision!));
    expect(restored.bridge.applyDay).toHaveBeenCalledTimes(21);
    const corrupted = structuredClone(durable);
    corrupted.plan!.days.find(day => day.action === 'create')!.proposed[0].start = '00:00';
    const rejected = await setup(corrupted);
    expect(rejected.controller.state.plan?.canReview).toBe(false);
    await expect(rejected.controller.apply(corrupted.plan!, corrupted.planRevision!)).rejects.toThrow('Vorschau');
    expect(rejected.bridge.applyDay).not.toHaveBeenCalled();
  });
});

describe('per-plan API account confirmation and schema 5', () => {
  async function manualPlan() {
    const fixture = await setup();
    await review(fixture.controller, planFor(fixture.controller));
    return fixture;
  }
  const consent = (controller: BookingController): AccountConfirmation => ({
    planId: controller.state.plan!.id, planRevision: controller.state.planRevision!,
    contextFingerprint: contextFingerprint(controller.state.snapshot!.context), confirmed: true,
  });

  it('blocks an API-context run without consent and passes only canonical ephemeral authorization after consent', async () => {
    const { controller, bridge } = await manualPlan();
    const plan = structuredClone(controller.state.plan!);
    const revision = controller.state.planRevision!;
    expect(plan.canReview).toBe(true);
    await expect(controller.apply(plan, revision)).rejects.toThrow('ausdrücklich');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    expect(controller.state.job).toBeUndefined();
    const confirmation = consent(controller);
    await controller.apply(plan, revision, confirmation);
    expect(bridge.applyDay).toHaveBeenCalledTimes(21);
    expect(vi.mocked(bridge.applyDay).mock.calls[0][4]).toEqual({ planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmation });
    for (const [state] of vi.mocked(bridge.save).mock.calls) {
      expect((state as SessionState & { confirmation?: unknown }).confirmation).toBeUndefined();
      expect((state as SessionState & { authorization?: unknown }).authorization).toBeUndefined();
      expect((state.plan as BookingPlan & { confirmation?: unknown } | undefined)?.confirmation).toBeUndefined();
    }
  });

  it.each(['planId', 'planRevision', 'contextFingerprint', 'confirmed'] as const)('rejects a missing or stale manual %s before writing', async key => {
    const { controller, bridge } = await manualPlan();
    const invalid = { ...consent(controller), [key]: key === 'planRevision' ? controller.state.planRevision! - 1 : key === 'confirmed' ? false : 'stale' } as AccountConfirmation;
    await expect(controller.apply(controller.state.plan!, controller.state.planRevision!, invalid)).rejects.toThrow('ausdrücklich');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    expect(controller.state.run).toBeUndefined();
  });

  it('requires fresh consent after settings create a new canonical revision and plan', async () => {
    const { controller, bridge } = await manualPlan();
    const previous = consent(controller);
    const changed = buildMonthPlan({ ...defaultSettings('2026-11'), start: '09:00', end: '17:30' }, controller.state.snapshot!, {}, 1234);
    await review(controller, changed);
    await expect(controller.apply(controller.state.plan!, controller.state.planRevision!, previous)).rejects.toThrow('ausdrücklich');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    await controller.apply(controller.state.plan!, controller.state.planRevision!, consent(controller));
    expect(bridge.applyDay).toHaveBeenCalledTimes(21);
  });

  it('rejects legacy UI identity for a new API run even with matching consent', async () => {
    const { controller, bridge } = await setup();
    controller.state.snapshot!.context = { mode: 'stable-identity', documentId: 'old-document', employeeKey: 'employee-review', tenantKey: 'tenant-review' };
    await review(controller, planFor(controller));
    const plan = controller.state.plan!, revision = controller.state.planRevision!;
    await expect(controller.apply(plan, revision, consentFor(plan, revision))).rejects.toThrow('Sitzung');
    expect(bridge.applyDay).not.toHaveBeenCalled();
  });

  it('never restores reusable consent even when unknown consent fields are injected into a schema-5 session', async () => {
    const { controller } = await manualPlan();
    const inherited = structuredClone(controller.state) as SessionState & { confirmation?: unknown; authorization?: unknown };
    inherited.confirmation = consent(controller);
    inherited.authorization = { planId: inherited.plan!.id, confirmation: inherited.confirmation };
    (inherited.plan as BookingPlan & { confirmation?: unknown }).confirmation = inherited.confirmation;
    const restored = await setup(inherited);
    expect(restored.controller.state.plan?.canReview).toBe(true);
    expect((restored.controller.state as typeof inherited).confirmation).toBeUndefined();
    expect((restored.controller.state as typeof inherited).authorization).toBeUndefined();
    expect((restored.controller.state.plan as BookingPlan & { confirmation?: unknown }).confirmation).toBeUndefined();
    await expect(restored.controller.apply(restored.controller.state.plan!, restored.controller.state.planRevision!)).rejects.toThrow('ausdrücklich');
    expect(restored.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('migrates schema-2 plans without restoring approvals, while preserving run history and update metadata', async () => {
    const { controller } = await setup();
    await review(controller, planFor(controller));
    const legacy = structuredClone(controller.state) as SessionState & { confirmation?: unknown };
    legacy.schemaVersion = 2;
    legacy.update = { installedVersion: '1.2.0', pendingVersion: '1.2.1' };
    legacy.confirmation = { planId: legacy.plan!.id, confirmed: true };
    legacy.run = { planId: legacy.plan!.id, status: 'complete', startedAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:01:00Z', results: [{ date: '2026-11-02', status: 'verified', message: 'Historical verified day' }] };
    const restored = await setup(legacy);
    expect(restored.controller.state.schemaVersion).toBe(5);
    expect(restored.controller.state.snapshot).toBeUndefined(); expect(restored.controller.state.plan).toBeUndefined(); expect(restored.controller.state.editLease).toBeUndefined();
    expect(restored.controller.state.run).toEqual(legacy.run);
    expect(restored.controller.state.update).toEqual(legacy.update);
    expect(restored.controller.state.revision).toBeGreaterThan(legacy.revision!);
    expect(restored.controller.state.planRevision).toBeGreaterThan(legacy.planRevision!);
    expect((restored.controller.state as typeof legacy).confirmation).toBeUndefined();
    expect(restored.bridge.applyDay).not.toHaveBeenCalled();
  });
});

describe('tabless API connection lifecycle and capabilities', () => {
  it('connects and disconnects without a tab, preserving history while revoking previews', async () => {
    const app = await setup();
    await review(app.controller, planFor(app.controller));
    const history = { planId: 'old', status: 'complete' as const, startedAt: 'x', updatedAt: 'x', results: [{ date: '2026-10-30', status: 'verified' as const, message: 'Historical verified result' }] };
    app.controller.state.run = history;
    const revision = app.controller.state.planRevision!;
    const connected = await app.controller.connect();
    expect(app.bridge.connect).toHaveBeenCalledOnce();
    expect(connected).toMatchObject({ schemaVersion: 5, connection: connection(), run: history });
    expect(connected.tabId).toBeUndefined(); expect(connected.snapshot).toBeUndefined(); expect(connected.plan).toBeUndefined();
    expect(connected.planRevision).toBeGreaterThan(revision);
    await app.controller.scan('2026-11');
    expect(app.controller.state.run).toEqual(history);
    const disconnected = await app.controller.disconnect();
    expect(app.bridge.disconnect).toHaveBeenCalledOnce();
    expect(disconnected.connection?.status).toBe('disconnected');
    expect(disconnected.run).toEqual(history); expect(disconnected.snapshot).toBeUndefined();
    await expect(app.controller.scan('2026-11')).rejects.toThrow('anmelden');
  });

  it('does not persist extra connection fields or reuse a connection after sign-in failure', async () => {
    const app = await setup();
    const raw = { ...connection(), token: 'LOCAL_ONLY_SYNTHETIC_SECRET', cookies: ['synthetic-cookie'] };
    vi.mocked(app.bridge.connect!).mockResolvedValueOnce(raw);
    await app.controller.connect();
    expect(app.stored()?.connection).not.toHaveProperty('token');
    expect(app.stored()?.connection).not.toHaveProperty('cookies');
    vi.mocked(app.bridge.connect!).mockRejectedValueOnce(new Error('Local sign-in cancelled'));
    await expect(app.controller.connect()).rejects.toThrow('cancelled');
    expect(app.controller.state.connection).toBeUndefined();
    await expect(app.controller.scan('2026-11')).rejects.toThrow('anmelden');
  });

  it('invalidates a plan when session generation, account, capabilities or status changes', async () => {
    for (const changed of [
      { ...connection(), generation: 'another-session' },
      { ...connection(), companyId: 'another-company' },
      { ...connection(), employeeId: 'another-employee' },
      { ...connection(), capabilities: { read: true, write: false, overwrite: false } },
      { status: 'expired' as const, generation: 'expired-session' },
    ]) {
      const app = await setup(); await review(app.controller, planFor(app.controller));
      const plan = app.controller.state.plan!, revision = app.controller.state.planRevision!;
      await app.controller.bindConnection(changed);
      expect(app.controller.state.snapshot).toBeUndefined(); expect(app.controller.state.plan).toBeUndefined();
      await expect(app.controller.apply(plan, revision, consentFor(plan, revision))).rejects.toThrow('Vorschau');
      expect(app.bridge.applyDay).not.toHaveBeenCalled();
    }
  });

  it('rejects a snapshot from another account or generation before exposing it', async () => {
    for (const context of [
      { mode: 'api-session' as const, connectionId: 'other-session', employeeKey: 'employee-review', tenantKey: 'tenant-review' },
      { mode: 'api-session' as const, connectionId: 'connection-42', employeeKey: 'other-employee', tenantKey: 'tenant-review' },
      { mode: 'api-session' as const, connectionId: 'connection-42', employeeKey: 'employee-review', tenantKey: 'other-company' },
    ]) {
      const app = await setup(); vi.mocked(app.bridge.scan).mockResolvedValueOnce({ ...snapshot(), context });
      await expect(app.controller.scan('2026-11')).rejects.toThrow('Sitzung');
      expect(app.controller.state.snapshot).toBeUndefined(); expect(app.bridge.applyDay).not.toHaveBeenCalled();
    }
  });

  it('blocks unsupported overwrites before creating a run or mutating attendance', async () => {
    const app = await setup();
    await app.controller.bindConnection({ ...connection(), capabilities: { read: true, write: true, overwrite: false } });
    await app.controller.scan('2026-11');
    app.controller.state.snapshot!.days[1].entries = [{ type: 'work', start: '07:00', end: '15:00' }];
    app.controller.state.snapshot!.days[1].reportedMinutes = 480;
    const plan = buildMonthPlan(defaultSettings('2026-11'), app.controller.state.snapshot!, { '2026-11-02': 'overwrite' }, 1);
    await review(app.controller, plan);
    const revision = app.controller.state.planRevision!;
    await expect(app.controller.apply(app.controller.state.plan!, revision, consentFor(app.controller.state.plan!, revision))).rejects.toThrow('Überschreiben');
    expect(app.controller.state.job).toBeUndefined(); expect(app.controller.state.run).toBeUndefined(); expect(app.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('migrates old schema3 snapshots without restoring tab approval or changing historical results', async () => {
    const app = await setup(); await review(app.controller, planFor(app.controller));
    const legacy = structuredClone(app.controller.state); legacy.schemaVersion = 3; legacy.tabId = 42;
    legacy.run = { planId: 'past', status: 'complete', results: [{ date: '2026-10-30', status: 'verified', message: 'Previously verified' }], startedAt: 'x', updatedAt: 'x' };
    const restored = await setup(legacy);
    expect(restored.controller.state.schemaVersion).toBe(5);
    expect(restored.controller.state.connection).toBeUndefined(); expect(restored.controller.state.tabId).toBeUndefined();
    expect(restored.controller.state.snapshot).toBeUndefined(); expect(restored.controller.state.plan).toBeUndefined();
    expect(restored.controller.state.run).toEqual(legacy.run);
    expect(restored.bridge.applyDay).not.toHaveBeenCalled();
  });
});

describe('explicit API connection failure markers', () => {
  const expired = () => Object.assign(new Error('Fixture authentication changed'), { connectionStatus: 'expired' as const });
  const history = () => ({ planId: 'past', status: 'complete' as const, results: [{ date: '2026-10-30', status: 'verified' as const, message: 'Historical verification' }], startedAt: 'x', updatedAt: 'x' });

  it.each(['expired', 'unsupported'] as const)('revokes a %s scan connection and preserves historical results', async status => {
    const app = await setup(); app.controller.state.run = history();
    const previous = structuredClone(app.controller.state.connection!);
    vi.mocked(app.bridge.scan).mockRejectedValueOnce(Object.assign(new Error('Fixture connection problem'), { connectionStatus: status }));
    await expect(app.controller.scan('2026-11')).rejects.toThrow('connection problem');
    expect(app.controller.state.connection).toMatchObject({ status, capabilities: { read: false, write: false, overwrite: false } });
    expect(app.controller.state.connection?.generation).not.toBe(previous.generation);
    expect(app.controller.state.connection?.reason).not.toContain('Fixture');
    expect(app.controller.state.run).toEqual(history()); expect(app.controller.state.snapshot).toBeUndefined();
    expect(app.stored()?.connection?.status).toBe(status);
    const reads = vi.mocked(app.bridge.scan).mock.calls.length;
    await expect(app.controller.scan('2026-11')).rejects.toThrow('anmelden'); expect(app.bridge.scan).toHaveBeenCalledTimes(reads);
    expect(app.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('revokes a preflight connection without altering booking history or permitting a write', async () => {
    const app = await setup(); app.controller.state.run = history(); await review(app.controller, planFor(app.controller));
    const plan = app.controller.state.plan!, revision = app.controller.state.planRevision!, confirmation = consentFor(plan, revision);
    vi.mocked(app.bridge.preflightDay).mockRejectedValueOnce(expired());
    await expect(app.controller.preflight(plan, revision, '2026-11-03', confirmation)).rejects.toThrow('authentication changed');
    expect(app.controller.state.connection?.status).toBe('expired'); expect(app.controller.state.run).toEqual(history());
    expect(app.controller.state.snapshot).toBeUndefined(); expect(app.controller.state.plan?.canReview).toBe(false);
    await expect(app.controller.apply(plan, revision, confirmation)).rejects.toThrow('Vorschau'); expect(app.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('keeps already verified days when an API write reports session expiry', async () => {
    const app = await setup(); await review(app.controller, planFor(app.controller));
    const plan = app.controller.state.plan!, revision = app.controller.state.planRevision!, confirmation = consentFor(plan, revision);
    vi.mocked(app.bridge.applyDay).mockImplementationOnce(async (_connection, day) => ({ date: day.date, entries: day.proposed, reportedMinutes: day.netMinutes, editable: true, fingerprint: 'verified-first' }));
    vi.mocked(app.bridge.applyDay).mockRejectedValueOnce(Object.assign(expired(), { uncertain: true }));
    await app.controller.apply(plan, revision, confirmation);
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(2);
    expect(app.controller.state.connection?.status).toBe('expired');
    expect(app.controller.state.run?.results.filter(result => result.status === 'verified')).toHaveLength(1);
    expect(app.controller.state.run?.results.filter(result => result.status === 'uncertain')).toHaveLength(1);
    expect(app.stored()?.run).toEqual(app.controller.state.run);
    await expect(app.controller.apply(plan, revision, confirmation)).rejects.toThrow('Vorschau'); expect(app.bridge.applyDay).toHaveBeenCalledTimes(2);
  });

  it('does not infer expiry from localized strings, generic codes or unknown marker values', async () => {
    for (const error of [new Error('Sign in to HiBob. AUTH_REQUIRED expired'), Object.assign(new Error('Fixture rejection'), { code: 'AUTH_REQUIRED' }), Object.assign(new Error('Fixture rejection'), { connectionStatus: 'connected' })]) {
      const app = await setup(); const original = structuredClone(app.controller.state.connection);
      vi.mocked(app.bridge.scan).mockRejectedValueOnce(error);
      await expect(app.controller.scan('2026-11')).rejects.toThrow();
      expect(app.controller.state.connection).toEqual(original); expect(app.controller.state.snapshot).toBeUndefined();
    }
  });
});

describe('frozen monthly queue checkpoints', () => {
  async function checkpointFixture(dates = ['2026-11-02', '2026-11-03'], retainedDates: string[] = []) {
    const app = await setup();
    let actual = structuredClone(app.controller.state.snapshot!);
    for (const date of retainedDates) {
      const retained = actual.days.find(day => day.date === date)!;
      retained.entries = [{ type: 'work', start: '08:00', end: '12:00', note: 'Retained fixture note' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:30' }];
      retained.reportedMinutes = 480; retained.fingerprint = `retained-${date}`;
    }
    app.controller.state.snapshot = structuredClone(actual);
    vi.mocked(app.bridge.scan).mockImplementation(async () => structuredClone(actual));
    vi.mocked(app.bridge.applyDay).mockImplementation(async (_connection, day) => {
      const saved: DaySnapshot = { date: day.date, entries: structuredClone(day.proposed), reportedMinutes: day.netMinutes, editable: true, fingerprint: `saved-${day.date}` };
      actual.days[actual.days.findIndex(item => item.date === day.date)] = saved;
      return structuredClone(saved);
    });
    const proposed = buildMonthPlan({ ...defaultSettings('2026-11'), variable: true, variationMinutes: 15 }, app.controller.state.snapshot!, Object.fromEntries(retainedDates.map(date => [date, 'skip' as const])), 81723);
    await review(app.controller, proposed);
    const plan = structuredClone(app.controller.state.plan!), revision = app.controller.state.planRevision!;
    const start = () => app.controller.apply(plan, revision, consentFor(plan, revision), { checkpointDates: dates });
    const consent = () => ({ ...consentFor(plan, revision), checkpointId: app.controller.state.job?.checkpointId });
    const resume = (confirmation = consent()) => app.controller.continueRun(app.controller.state.job!.id, plan.id, revision, confirmation);
    return { ...app, plan, revision, start, resume, consent, actual: () => actual, changeActual: (next: MonthSnapshot) => { actual = next; } };
  }

  it('pauses once after each requested verified day and preserves every original segment through completion', async () => {
    const app = await checkpointFixture();
    const first = await app.start();
    expect(first.schemaVersion).toBe(5);
    expect(first.run).toMatchObject({ runId: first.job!.id, planId: app.plan.id, status: 'paused', checkpointDate: '2026-11-02' });
    expect(first.job).toMatchObject({ kind: 'apply', status: 'paused', checkpointId: expect.any(String) });
    expect(first.plan).toEqual(app.plan); expect(first.planRevision).toBe(app.revision); expect(first.snapshot).toEqual(app.plan.snapshot);
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    const firstNonce = first.job!.checkpointId;
    const second = await app.resume();
    expect(second.run).toMatchObject({ status: 'paused', checkpointDate: '2026-11-03' });
    expect(second.job!.id).toBe(first.job!.id); expect(second.job!.checkpointId).not.toBe(firstNonce);
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(2); expect(second.plan).toEqual(app.plan);
    const complete = await app.resume();
    expect(complete.run?.status).toBe('complete'); expect(complete.job).toBeUndefined(); expect(complete.snapshot).toBeUndefined();
    const days = app.plan.days.filter(day => day.action === 'create');
    expect(vi.mocked(app.bridge.applyDay).mock.calls.map(call => call[1])).toEqual(days);
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(21);
    expect(complete.run!.results.filter(item => item.status === 'verified')).toHaveLength(21);
    expect(app.controller.state.plan!.seed).toBe(app.plan.seed);
    expect(app.actual().days.flatMap(day => day.entries)).toHaveLength(63);
  });

  it('locks plan edits, scans, connections, preflight, new runs and update activation while paused', async () => {
    const app = await checkpointFixture(); await app.start();
    await expect(app.controller.invalidatePlan(app.revision, 'changed')).rejects.toThrow('Vorgangs');
    await expect(app.controller.savePlan(app.plan, { planRevision: app.revision, changeId: 'changed' })).rejects.toThrow('Vorgangs');
    await expect(app.controller.scan('2026-11')).rejects.toThrow('läuft');
    await expect(app.controller.connect()).rejects.toThrow('läuft');
    await expect(app.controller.disconnect()).rejects.toThrow('läuft');
    await expect(app.controller.bindConnection(connection())).rejects.toThrow('läuft');
    await expect(app.start()).rejects.toThrow('läuft');
    await expect(app.controller.preflight(app.plan, app.revision, '2026-11-03', app.consent())).rejects.toThrow('läuft');
    await expect(app.controller.activateUpdate()).rejects.toThrow('laufenden Vorgangs');
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    expect((app.stored() as SessionState & { confirmation?: unknown }).confirmation).toBeUndefined();
    expect((app.stored()!.run as object)).not.toHaveProperty('authorization');
  });

  it('rejects missing, initial and previous-checkpoint consent before even re-reading', async () => {
    const app = await checkpointFixture(); await app.start();
    const reads = vi.mocked(app.bridge.scan).mock.calls.length;
    const job = app.controller.state.job!;
    await expect(app.controller.continueRun(job.id, app.plan.id, app.revision)).rejects.toThrow('bestätigen');
    await expect(app.controller.continueRun(job.id, app.plan.id, app.revision, consentFor(app.plan, app.revision))).rejects.toThrow('bestätigen');
    const firstConsent = app.consent();
    await expect(app.resume({ ...firstConsent, confirmed: false } as never)).rejects.toThrow('bestätigen');
    expect(app.bridge.scan).toHaveBeenCalledTimes(reads); expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    await app.resume(firstConsent);
    const secondReads = vi.mocked(app.bridge.scan).mock.calls.length;
    await expect(app.resume(firstConsent)).rejects.toThrow('bestätigen');
    expect(app.bridge.scan).toHaveBeenCalledTimes(secondReads); expect(app.bridge.applyDay).toHaveBeenCalledTimes(2);
  });

  it.each(['job', 'plan', 'revision', 'state-plan', 'state-run', 'connection'] as const)('rejects forged or stale %s continuation without another read or write', async field => {
    const app = await checkpointFixture(); await app.start();
    const jobId = app.controller.state.job!.id, consent = app.consent();
    const reads = vi.mocked(app.bridge.scan).mock.calls.length;
    if (field === 'state-plan') app.controller.state.plan!.days[2].proposed[0].start = '00:00';
    if (field === 'state-run') app.controller.state.run!.results.find(item => item.status === 'verified')!.status = 'pending';
    if (field === 'connection') app.controller.state.connection!.generation = 'changed-session';
    await expect(app.controller.continueRun(field === 'job' ? 'forged' : jobId, field === 'plan' ? 'forged' : app.plan.id, field === 'revision' ? app.revision - 1 : app.revision, consent)).rejects.toThrow('Vorschau');
    expect(app.bridge.scan).toHaveBeenCalledTimes(reads); expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
  });

  it('checks the last remaining day before writing the next day', async () => {
    const app = await checkpointFixture(); await app.start();
    app.actual().days.find(day => day.date === '2026-11-30')!.fingerprint = 'changed-last-day';
    await expect(app.resume()).rejects.toThrow('2026-11-30');
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(app.controller.state.run?.status).toBe('failed'); expect(app.controller.state.job).toBeUndefined();
    expect(app.controller.state.snapshot).toBeUndefined(); expect(app.controller.state.plan?.canReview).toBe(false);
  });

  it('preserves unchanged retained entries and includes their actual hours in the frozen month after checkpoints', async () => {
    const app = await checkpointFixture(undefined, ['2026-11-30']);
    const retained = structuredClone(app.actual().days.find(day => day.date === '2026-11-30')!);
    expect(app.plan.weeks.reduce((sum, week) => sum + week.plannedMinutes!, 0)).toBe(168 * 60);
    expect(app.plan.days.find(day => day.date === retained.date)).toMatchObject({ action: 'skip', eligible: true, existingNetMinutes: 480 });
    await app.start(); await app.resume();
    expect((await app.resume()).run?.status).toBe('complete');
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(20);
    expect(vi.mocked(app.bridge.applyDay).mock.calls.some(call => call[1].date === retained.date)).toBe(false);
    expect(app.actual().days.find(day => day.date === retained.date)).toEqual(retained);
  });

  it.each(['entries', 'hours', 'metadata', 'policy', 'context'] as const)('checks retained %s before any further write at a checkpoint', async field => {
    const app = await checkpointFixture(undefined, ['2026-11-30']); await app.start();
    const retained = app.actual().days.find(day => day.date === '2026-11-30')!;
    if (field === 'entries') { retained.entries[0].start = '07:59'; retained.reportedMinutes = 481; retained.fingerprint = 'changed-retained-entries'; }
    if (field === 'hours') retained.reportedMinutes = 481;
    if (field === 'metadata') retained.entries[0].note = 'Private changed retained note';
    if (field === 'policy') retained.fingerprint = 'changed-retained-policy';
    if (field === 'context') app.actual().context = { mode: 'api-session', connectionId: 'changed-account-session', employeeKey: connection().employeeId!, tenantKey: connection().companyId! };
    await expect(app.resume()).rejects.toThrow(field === 'context' ? 'Sitzung' : '2026-11-30');
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(app.controller.state.run?.status).toBe('failed'); expect(app.controller.state.job).toBeUndefined();
    expect(app.controller.state.run!.results.filter(result => result.status === 'verified')).toHaveLength(1);
    expect(app.controller.state.run!.results.find(result => result.date === retained.date)?.status).toBe('skipped');
    expect(app.controller.state.snapshot).toBeUndefined(); expect(app.controller.state.plan?.canReview).toBe(false);
    expect(app.controller.state.error).not.toContain('Private changed retained note');
  });

  it.each(['time', 'reported', 'note', 'reason', 'metadata', 'absence'] as const)('checks already verified %s before writing any remaining day', async field => {
    const app = await checkpointFixture(); await app.start();
    const day = app.actual().days.find(item => item.date === '2026-11-02')!;
    if (field === 'time') day.entries[0].start = '07:00';
    if (field === 'reported') day.reportedMinutes!++;
    if (field === 'note') day.entries[0].note = 'Private note that must not be logged';
    if (field === 'reason') day.entries[0].reason = 'changed';
    if (field === 'metadata') day.entries[0].metadata = ['changed'];
    if (field === 'absence') day.absence = 'changed';
    await expect(app.resume()).rejects.toThrow('2026-11-02');
    expect(app.controller.state.error).not.toContain('Private note');
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(app.controller.state.run!.results.filter(item => item.status === 'verified')).toHaveLength(1);
  });

  it.each(['missing', 'duplicate', 'context'] as const)('rejects an incomplete or changed %s month at the checkpoint', async field => {
    const app = await checkpointFixture(); await app.start();
    if (field === 'missing') app.actual().days.pop();
    if (field === 'duplicate') app.actual().days[29] = structuredClone(app.actual().days[28]);
    if (field === 'context') app.actual().context = { mode: 'api-session', connectionId: connection().generation, employeeKey: 'other-employee', tenantKey: connection().companyId! };
    await expect(app.resume()).rejects.toThrow(); expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
  });

  it('marks a restarted paused run interrupted, preserves verified history and rejects old consent', async () => {
    const app = await checkpointFixture(); await app.start();
    const old = structuredClone(app.controller.state), consent = app.consent();
    const restarted = await setup(old);
    expect(restarted.controller.state.job?.status).toBe('interrupted');
    expect(restarted.controller.state.run?.status).toBe('stopped');
    expect(restarted.controller.state.run!.results.filter(item => item.status === 'verified')).toHaveLength(1);
    expect(restarted.controller.state.snapshot).toBeUndefined(); expect(restarted.controller.state.plan?.canReview).toBe(false);
    await expect(restarted.controller.continueRun(old.job!.id, app.plan.id, app.revision, consent)).rejects.toThrow('Vorschau');
    expect(restarted.bridge.applyDay).not.toHaveBeenCalled(); expect(restarted.bridge.scan).not.toHaveBeenCalled();
  });

  it('cancels a paused queue without holding or cancelling a transport operation', async () => {
    const app = await checkpointFixture(); await app.start();
    const jobId = app.controller.state.job!.id;
    await expect(app.controller.cancel('forged')).rejects.toThrow('geändert');
    await app.controller.cancel(jobId);
    expect(app.bridge.cancel).not.toHaveBeenCalled(); expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(app.controller.state.run?.status).toBe('stopped'); expect(app.controller.state.job).toBeUndefined();
    expect(app.controller.state.snapshot).toBeUndefined(); expect(app.actual().days.flatMap(day => day.entries)).toHaveLength(3);
    await expect(app.controller.continueRun(jobId, app.plan.id, app.revision, app.consent())).rejects.toThrow('Vorschau');
    await app.controller.scan('2026-11');
  });

  it('stops if cancelling while checkpoint reconciliation is reading, without writing another day', async () => {
    const app = await checkpointFixture(); await app.start();
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(app.bridge.scan).mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return structuredClone(app.actual()); });
    const resuming = app.resume(); await ready;
    await app.controller.cancel(app.controller.state.job!.id); release();
    await expect(resuming).rejects.toThrow('abgebrochen');
    expect(app.bridge.applyDay).toHaveBeenCalledTimes(1); expect(app.controller.state.run?.status).toBe('stopped');
  });

  it('retains a verified day if checkpoint journaling fails and never exposes a resumable pause', async () => {
    const app = await checkpointFixture();
    vi.mocked(app.bridge.save).mockImplementation(async state => { if (state.run?.status === 'paused') throw new Error('Fixture checkpoint journal unavailable'); });
    const result = await app.start();
    expect(result.run?.status).toBe('failed'); expect(result.run?.journalError).toContain('checkpoint journal');
    expect(result.run!.results.filter(item => item.status === 'verified')).toHaveLength(1);
    expect(result.job).toBeUndefined(); expect(result.snapshot).toBeUndefined(); expect(app.bridge.applyDay).toHaveBeenCalledTimes(1);
    await expect(app.controller.continueRun('old-job', app.plan.id, app.revision, app.consent())).rejects.toThrow('Vorschau');
  });

  it('does not pause after the final day, and rejects non-booking checkpoints before writing', async () => {
    const last = await checkpointFixture(['2026-11-30']);
    expect((await last.start()).run?.status).toBe('complete'); expect(last.controller.state.job).toBeUndefined();
    for (const dates of [['2026-11-01'], ['2026-12-01'], ['2026-11-02', '2026-11-02']]) {
      const app = await checkpointFixture(dates);
      await expect(app.start()).rejects.toThrow('Kontrollpunkte'); expect(app.bridge.applyDay).not.toHaveBeenCalled(); expect(app.controller.state.job).toBeUndefined();
    }
  });

  it('migrates schema-4 previews without losing historical results or the API connection', async () => {
    const app = await setup(); await review(app.controller, planFor(app.controller));
    const old = structuredClone(app.controller.state); old.schemaVersion = 4;
    old.run = { planId: 'old-plan', status: 'complete', startedAt: 'x', updatedAt: 'x', results: [{ date: '2026-10-30', status: 'verified', message: 'Historical outcome' }] };
    const restored = await setup(old);
    expect(restored.controller.state.schemaVersion).toBe(5);
    expect(restored.controller.state.run).toEqual(old.run); expect(restored.controller.state.connection).toEqual(old.connection);
    expect(restored.controller.state.plan).toBeUndefined(); expect(restored.controller.state.snapshot).toBeUndefined(); expect(restored.controller.state.editLease).toBeUndefined();
    expect(restored.bridge.applyDay).not.toHaveBeenCalled();
  });
});
