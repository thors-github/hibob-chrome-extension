import { describe, expect, it, vi } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { BookingPlan, DayPlan, DaySnapshot, MonthSnapshot, SessionState } from '../src/shared/types';
import { isHiBobAttendance, isHiBobOrigin } from '../src/shared/validation';
import { contextFingerprint } from '../src/shared/context';
import type { AccountConfirmation } from '../src/shared/types';

function snapshot(): MonthSnapshot {
  return {
    month: '2026-11', employeeLabel: 'Testperson', periodLabel: '01/11/2026–30/11/2026', scannedAt: '2026-11-02T10:00:00Z', source: 'hibob', context: { documentId: 'doc-review', employeeKey: 'employee-review', tenantKey: 'tenant-review', mode: 'stable-identity' },
    days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: `empty-${date}` })),
  };
}

async function setup(initial?: SessionState) {
  let stored = initial;
  const bridge: ControllerBridge = {
    load: async () => stored,
    save: vi.fn(async state => { stored = structuredClone(state); }),
    scan: vi.fn(async () => snapshot()),
    applyDay: vi.fn(async (_tabId: number, day: DayPlan) => ({ date: day.date, editable: true, entries: day.proposed, fingerprint: 'saved' })),
    cancel: vi.fn(async () => {}),
  };
  const controller = new BookingController(bridge);
  await controller.init();
  if (!initial) { await controller.bindTab(42); await controller.scan('2026-11'); }
  return { controller, bridge, stored: () => stored };
}

async function review(controller: BookingController, input: BookingPlan) {
  const state = await controller.invalidatePlan(controller.state.planRevision ?? 0, crypto.randomUUID());
  return controller.savePlan(input, state.editLease!);
}

function applyReviewed(controller: BookingController, input: BookingPlan) { return controller.apply(input, controller.state.planRevision!); }

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
    await controller.bindTab(undefined, 'Bitte HiBob öffnen.');
    expect(stored()).toMatchObject({ error: 'Bitte HiBob öffnen.', schemaVersion: 3 });
    expect(stored()?.tabId).toBeUndefined();
    await expect(controller.scan('2026-11')).rejects.toThrow('Extension-Symbol');
    await expect(applyReviewed(controller, original)).rejects.toThrow('Vorschau');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    await controller.bindTab(99);
    expect(controller.state).toMatchObject({ tabId: 99, error: undefined, schemaVersion: 3 });
    await controller.scan('2026-11');
    await review(controller, planFor(controller));
    await controller.bindTab(100);
    expect(controller.state.snapshot).toBeUndefined();
    expect(controller.state.plan).toBeUndefined();
    expect(controller.state.tabId).toBe(100);
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
    await expect(controller.bindTab(99)).rejects.toThrow('bereits');
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
      tabId: 42, snapshot: snapshot(), plan,
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
    await controller.apply(controller.state.plan!, invalid.planRevision!);
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
    const { controller, bridge } = await setup({ tabId: 42, progress: { phase: 'scan', completed: 12, total: 30, message: 'Reading' } });
    const oldJob = controller.state.job!;
    expect(oldJob.status).toBe('interrupted');
    expect(controller.state.progress).toBeUndefined();
    bridge.recover = vi.fn(async () => {});
    await controller.scan('2026-11');
    expect(bridge.recover).toHaveBeenCalledWith(42, oldJob.id);
    expect(controller.state.job).toBeUndefined();
    expect(controller.state.schemaVersion).toBe(3);
  });

  it('persists an active scan, rejects stale progress and cancellation, and ignores progress after completion', async () => {
    const { controller, bridge, stored } = await setup();
    let entered!: () => void; let release!: (value: MonthSnapshot) => void;
    const scanning = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(bridge.scan).mockImplementationOnce(async () => { entered(); return new Promise<MonthSnapshot>(resolve => { release = resolve; }); });
    const running = controller.scan('2026-11'); await scanning;
    const job = controller.state.job!;
    expect(stored()?.job).toMatchObject({ id: job.id, kind: 'scan', status: 'running' });
    await expect(controller.bindTab(42)).resolves.toBeUndefined();
    await expect(controller.bindTab(99)).rejects.toThrow('bereits');
    await expect(controller.bindTab(undefined)).rejects.toThrow('bereits');
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
    await controller.bindTab(undefined);
    expect(controller.state.revision).toBeGreaterThan(prior);
    await controller.bindTab(99);
    expect(controller.state.revision).toBeGreaterThan(prior + 1);
    await expect(setup({ schemaVersion: 3, job: { id: 'bad', kind: 'other' } as never })).rejects.toThrow('ungültig');
    await expect(setup({ run: { status: 'unknown', results: [] } as never })).rejects.toThrow('ungültig');
  });
});

describe('recovery publication and cold canonical state', () => {
  it('publishes a running scan while recovering an old adapter and allows cancellation before scanning', async () => {
    const { controller, bridge, stored } = await setup({ tabId: 42, progress: { phase: 'scan', completed: 12, total: 30, message: 'old' } });
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
    await restored.controller.apply(restored.controller.state.plan!, durable.planRevision!);
    expect(restored.bridge.applyDay).toHaveBeenCalledTimes(21);
    const corrupted = structuredClone(durable);
    corrupted.plan!.days.find(day => day.action === 'create')!.proposed[0].start = '00:00';
    const rejected = await setup(corrupted);
    expect(rejected.controller.state.plan?.canReview).toBe(false);
    await expect(rejected.controller.apply(corrupted.plan!, corrupted.planRevision!)).rejects.toThrow('Vorschau');
    expect(rejected.bridge.applyDay).not.toHaveBeenCalled();
  });
});

describe('per-plan manual account confirmation and schema 3', () => {
  async function manualPlan() {
    const fixture = await setup();
    fixture.controller.state.snapshot!.context = {
      mode: 'user-confirmed-ui', documentId: 'manual-document',
      pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'self-page-marker',
    };
    await review(fixture.controller, planFor(fixture.controller));
    return fixture;
  }
  const consent = (controller: BookingController): AccountConfirmation => ({
    planId: controller.state.plan!.id, planRevision: controller.state.planRevision!,
    contextFingerprint: contextFingerprint(controller.state.snapshot!.context), confirmed: true,
  });

  it('blocks a UI-context run without consent and passes only canonical ephemeral authorization after consent', async () => {
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

  it('keeps stable-identity runs independent of manual consent while still passing canonical authorization', async () => {
    const { controller, bridge } = await setup();
    await review(controller, planFor(controller));
    const plan = structuredClone(controller.state.plan!);
    const revision = controller.state.planRevision!;
    await controller.apply(plan, revision);
    expect(vi.mocked(bridge.applyDay).mock.calls[0][4]).toEqual({ planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context) });
  });

  it('never restores reusable consent even when unknown consent fields are injected into a schema-3 session', async () => {
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
    expect(restored.controller.state.schemaVersion).toBe(3);
    expect(restored.controller.state.snapshot).toBeUndefined(); expect(restored.controller.state.plan).toBeUndefined(); expect(restored.controller.state.editLease).toBeUndefined();
    expect(restored.controller.state.run).toEqual(legacy.run);
    expect(restored.controller.state.update).toEqual(legacy.update);
    expect(restored.controller.state.revision).toBeGreaterThan(legacy.revision!);
    expect(restored.controller.state.planRevision).toBeGreaterThan(legacy.planRevision!);
    expect((restored.controller.state as typeof legacy).confirmation).toBeUndefined();
    expect(restored.bridge.applyDay).not.toHaveBeenCalled();
  });
});
