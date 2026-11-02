import { describe, expect, it, vi } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain';
import { contextFingerprint, executionFingerprint } from '../src/shared/context';
import type { AccountConfirmation, ApiConnection, BookingPlan, MonthApplyResult, MonthSnapshot, SessionState } from '../src/shared/types';

const clone = <T>(value: T): T => structuredClone(value);
const connection: ApiConnection = { status: 'connected', generation: 'fast', employeeId: 'self', companyId: 'company', capabilities: { read: true, write: true, overwrite: true } };
const snapshot = (): MonthSnapshot => ({ month: '2026-11', employeeLabel: 'Fixture', periodLabel: 'November', scannedAt: '2026-11-02T12:00:00Z', source: 'hibob', context: { mode: 'api-session', connectionId: 'fast', employeeKey: 'self', tenantKey: 'company' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) });
const consent = (plan: BookingPlan, revision: number): AccountConfirmation => ({ planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), executionFingerprint: executionFingerprint({ executionProfile: 'fast-serial' }), confirmed: true });
const timings = { preparationMs: 1, writingMs: 1, journalingMs: 1, verificationMs: 1, totalMs: 4, requests: 34, writes: 21 };

async function app() {
  let stored: SessionState | undefined;
  const writes: string[] = [];
  const bridge: ControllerBridge = {
    load: async () => clone(stored),
    save: vi.fn(async value => { stored = clone(value); }),
    scan: vi.fn(async () => snapshot()),
    applyDay: vi.fn(async (_connection, day) => ({ date: day.date, entries: day.proposed, editable: true, fingerprint: 'saved' })),
    preflightDay: vi.fn(), cancel: vi.fn(async () => {}),
    applyMonth: vi.fn(async (_connection, plan, authorization, _job, hooks): Promise<MonthApplyResult> => {
      expect(authorization.executionFingerprint).toBe(executionFingerprint({ executionProfile: 'fast-serial' }));
      const days: MonthApplyResult['days'] = [];
      for (const day of (plan as BookingPlan).days.filter(item => item.action === 'create' || item.action === 'overwrite')) {
        await hooks.beforeDispatch(day.date);
        expect(stored?.run?.results.find(item => item.date === day.date)?.status).toBe('running');
        writes.push(day.date);
        await hooks.acknowledged(day.date);
        expect(stored?.run?.results.find(item => item.date === day.date)?.status).toBe('awaiting-verification');
        days.push({ date: day.date, status: 'verified', message: 'Read back' });
      }
      return { days, complete: true, stopped: false, timings };
    }),
  };
  const controller = new BookingController(bridge);
  await controller.init(); await controller.bindConnection(connection); await controller.scan('2026-11');
  const plan = buildMonthPlan(defaultSettings('2026-11'), controller.state.snapshot!, {}, 1);
  const lease = await controller.invalidatePlan(controller.state.planRevision!, 'fast-review');
  await controller.savePlan(plan, lease.editLease!);
  const revision = controller.state.planRevision!;
  return { controller, bridge, plan: clone(controller.state.plan!), revision, writes, stored: () => clone(stored) };
}

describe('fast month controller and durable dispatch boundaries', () => {
  it('defaults to the month runner, journals every dispatch and only verifies after readback', async () => {
    const a = await app();
    const state = await a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision));
    expect(a.bridge.applyMonth).toHaveBeenCalledOnce(); expect(a.bridge.applyDay).not.toHaveBeenCalled();
    expect(a.writes).toHaveLength(21); expect(new Set(a.writes).size).toBe(21);
    expect(state.run?.status).toBe('complete'); expect(state.run?.results.filter(day => day.status === 'verified')).toHaveLength(21);
    expect(state.schemaVersion).toBe(6); expect(state.run?.executionProfile).toBe('fast-serial');
    expect(state.snapshot).toBeUndefined(); expect(state.job).toBeUndefined();
    expect(state.run?.timings?.requests).toBe(34);
  });

  it('rejects missing or changed execution consent before any dispatch', async () => {
    const a = await app(); const approval = consent(a.plan, a.revision);
    delete approval.executionFingerprint;
    await expect(a.controller.apply(a.plan, a.revision, approval)).rejects.toThrow('ausdrücklich');
    await expect(a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision), { executionProfile: 'strict' })).rejects.toThrow('ausdrücklich');
    expect(a.bridge.applyMonth).not.toHaveBeenCalled(); expect(a.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('binds strict checkpoint selection to the reviewed execution options', async () => {
    const a = await app();
    const approval = { ...consent(a.plan, a.revision), executionFingerprint: executionFingerprint({ executionProfile: 'strict', checkpointDates: ['2026-11-02'] }) };
    await expect(a.controller.apply(a.plan, a.revision, approval, { executionProfile: 'strict', checkpointDates: ['2026-11-03'] })).rejects.toThrow('ausdrücklich');
    expect(a.bridge.applyMonth).not.toHaveBeenCalled(); expect(a.bridge.applyDay).not.toHaveBeenCalled();
  });

  it('does not claim completion for acknowledged dates missing from final results', async () => {
    const a = await app();
    vi.mocked(a.bridge.applyMonth!).mockImplementationOnce(async (_c, plan, _a, _j, hooks) => {
      await hooks.beforeDispatch(plan.days.find(day => day.action === 'create')!.date);
      await hooks.acknowledged('2026-11-02');
      return { days: [], complete: true, stopped: false, timings };
    });
    const state = await a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision));
    expect(state.run?.status).toBe('failed'); expect(state.run?.results.find(day => day.date === '2026-11-02')?.status).toBe('uncertain');
  });

  it('stops before the network if the durable about-to-dispatch journal fails', async () => {
    const a = await app();
    vi.mocked(a.bridge.save).mockImplementation(async state => {
      if (state.run?.results.some(day => day.status === 'running')) throw new Error('Storage unavailable');
    });
    const state = await a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision));
    expect(a.writes).toHaveLength(0); expect(state.run?.status).toBe('failed'); expect(state.run?.journalError).toBe('Storage unavailable');
  });

  it('rejects claimed verified outcomes without a preceding durable dispatch journal', async () => {
    const a = await app();
    vi.mocked(a.bridge.applyMonth!).mockImplementationOnce(async (_c, plan) => ({ days: (plan as BookingPlan).days.filter(day => day.action === 'create').map(day => ({ date: day.date, status: 'verified' as const, message: 'Unjournaled claim' })), complete: true, stopped: false, timings }));
    const state = await a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision));
    expect(a.writes).toHaveLength(0); expect(state.run?.status).toBe('failed');
    expect(state.run?.results.some(day => day.status === 'verified')).toBe(false);
  });

  it('retains reconciled outcomes and revokes an expired connection', async () => {
    const a = await app();
    vi.mocked(a.bridge.applyMonth!).mockImplementationOnce(async (_c, _p, _a, _j, hooks) => {
      await hooks.beforeDispatch('2026-11-02'); await hooks.acknowledged('2026-11-02');
      return { days: [{ date: '2026-11-02', status: 'uncertain', message: 'Account changed' }], complete: false, stopped: false, error: 'Account changed', connectionStatus: 'expired', timings };
    });
    const state = await a.controller.apply(a.plan, a.revision, consent(a.plan, a.revision));
    expect(state.connection?.status).toBe('expired'); expect(state.run?.status).toBe('failed');
    expect(state.run?.results.find(day => day.date === '2026-11-02')?.status).toBe('uncertain');
  });

  it('restores awaiting-verification as uncertain without resuming', async () => {
    const a = await app();
    const saved = a.stored()!;
    saved.run = { planId: a.plan.id, status: 'running', startedAt: 'now', updatedAt: 'now', results: [{ date: '2026-11-02', status: 'awaiting-verification', message: 'Acknowledged' }] };
    const restored = new BookingController({ ...a.bridge, load: async () => saved });
    await restored.init();
    expect(restored.state.run?.results[0].status).toBe('uncertain'); expect(restored.state.run?.status).toBe('stopped');
    expect(restored.state.snapshot).toBeUndefined(); expect(a.bridge.applyMonth).not.toHaveBeenCalled();
  });

  it('discards schema-five plans while preserving completed history', async () => {
    const a = await app(); const saved = a.stored()!;
    saved.schemaVersion = 5; saved.run = { planId: 'old', status: 'complete', startedAt: 'now', updatedAt: 'now', results: [{ date: '2026-11-02', status: 'verified', message: 'Read back' }] };
    const restored = new BookingController({ ...a.bridge, load: async () => saved }); await restored.init();
    expect(restored.state.run).toEqual(saved.run); expect(restored.state.schemaVersion).toBe(6);
    expect(restored.state.plan).toBeUndefined(); expect(restored.state.snapshot).toBeUndefined();
  });
});
