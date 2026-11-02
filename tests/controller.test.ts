import { describe, expect, it, vi } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { BookingPlan, DayPlan, DaySnapshot, MonthSnapshot, SessionState } from '../src/shared/types';
import { isHiBobAttendance, isHiBobOrigin } from '../src/shared/validation';

function snapshot(): MonthSnapshot {
  return {
    month: '2026-11', employeeLabel: 'Testperson', periodLabel: '01/11/2026–30/11/2026', scannedAt: '2026-11-02T10:00:00Z', source: 'hibob',
    days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, fingerprint: `empty-${date}` })),
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
    source.days[1].absence = undefined;
    const settings = { ...defaultSettings('2026-11'), variable: true };
    const input = buildMonthPlan(settings, chromeStored(source), { '2026-11-02': 'skip' }, 1234);
    expect(JSON.stringify(input.snapshot)).not.toBe(JSON.stringify(source));
    await controller.savePlan(input);
    const reviewed = chromeStored(controller.state.plan!);
    expect(JSON.stringify(reviewed)).not.toBe(JSON.stringify(controller.state.plan));
    await controller.apply(reviewed);
    expect(controller.state.run?.status).toBe('complete');
    expect(bridge.applyDay).toHaveBeenCalledTimes(20);
  });

  it('still rejects modified nested times and reordered day arrays after storage roundtrip', async () => {
    const { controller, bridge } = await setup();
    await controller.savePlan(chromeStored(planFor(controller)));
    const changed = chromeStored(controller.state.plan!);
    changed.days.find(day => day.action === 'create')!.proposed[0].start = '00:00';
    await expect(controller.apply(changed)).rejects.toThrow('Vorschau');
    const reordered = chromeStored(controller.state.plan!);
    reordered.days.reverse();
    await expect(controller.apply(reordered)).rejects.toThrow('Vorschau');
    const stale = chromeStored(planFor(controller));
    stale.snapshot.days[1].fingerprint = 'changed';
    await expect(controller.savePlan(stale)).rejects.toThrow('Lesestand');
    expect(bridge.applyDay).not.toHaveBeenCalled();
  });

  it('clears a previous scan and reviewed plan when the tab is unbound or changed', async () => {
    const { controller, bridge, stored } = await setup();
    await controller.savePlan(planFor(controller));
    const original = structuredClone(controller.state.plan!);
    await controller.bindTab(undefined, 'Bitte HiBob öffnen.');
    expect(stored()).toEqual({ error: 'Bitte HiBob öffnen.' });
    await expect(controller.scan('2026-11')).rejects.toThrow('Extension-Symbol');
    await expect(controller.apply(original)).rejects.toThrow('Vorschau');
    expect(bridge.applyDay).not.toHaveBeenCalled();
    await controller.bindTab(99);
    expect(controller.state).toEqual({ tabId: 99, error: undefined });
    await controller.scan('2026-11');
    await controller.savePlan(planFor(controller));
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
    await controller.savePlan(forged);
    expect(controller.state.plan!.days.find(d => d.date === day.date)!.proposed).not.toEqual(day.proposed);
    expect(controller.state.plan).toEqual(plan);
  });

  it('rejects a plan from a different scan or tab', async () => {
    const { controller } = await setup();
    const plan = structuredClone(planFor(controller));
    plan.snapshot.scannedAt = 'different-scan';
    await expect(controller.savePlan(plan)).rejects.toThrow('Lesestand');
  });

  it('stops after an uncertain write and requires a new scan before any retry', async () => {
    const { controller, bridge } = await setup();
    const plan = planFor(controller);
    await controller.savePlan(plan);
    vi.mocked(bridge.applyDay).mockRejectedValueOnce(Object.assign(new Error('Verbindung unterbrochen'), { uncertain: true }));
    await controller.apply(controller.state.plan!);
    expect(bridge.applyDay).toHaveBeenCalledTimes(1);
    expect(controller.state.run?.status).toBe('failed');
    expect(controller.state.run?.results.filter(r => r.status === 'uncertain')).toHaveLength(1);
    expect(controller.state.snapshot).toBeUndefined();
    expect(controller.state.plan?.canApply).toBe(false);
    await expect(controller.apply(plan)).rejects.toThrow();
    await expect(controller.savePlan(plan)).rejects.toThrow('Lesestand');
    expect(bridge.applyDay).toHaveBeenCalledTimes(1);
  });

  it('serializes writes, rejects duplicate starts and cancels between days', async () => {
    const { controller, bridge } = await setup();
    await controller.savePlan(planFor(controller));
    const plan = structuredClone(controller.state.plan!);
    let resolveFirst!: (day: DaySnapshot) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(bridge.applyDay).mockImplementationOnce(async (_tabId, day) => {
      started();
      return new Promise<DaySnapshot>(resolve => { resolveFirst = resolve; });
    });
    const running = controller.apply(plan);
    await entered;
    await expect(controller.apply(plan)).rejects.toThrow('bereits');
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
    expect(restored.state.plan?.canApply).toBe(false);
  });

  it('completes once and will not apply the same scan twice', async () => {
    const { controller, bridge } = await setup();
    await controller.savePlan(planFor(controller));
    const plan = structuredClone(controller.state.plan!);
    await controller.apply(plan);
    expect(controller.state.run?.status).toBe('complete');
    expect(bridge.applyDay).toHaveBeenCalledTimes(plan.days.filter(d => d.action === 'create').length);
    await expect(controller.apply(plan)).rejects.toThrow();
  });

  it('honours cancellation while waiting for the pre-write journal', async () => {
    const { controller, bridge } = await setup();
    await controller.savePlan(planFor(controller));
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
    const active = controller.apply(structuredClone(controller.state.plan!));
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
    await controller.savePlan(planFor(controller));
    vi.mocked(bridge.save).mockRejectedValueOnce(new Error('Journal nicht verfügbar'));
    await expect(controller.apply(structuredClone(controller.state.plan!))).rejects.toThrow('Journal');
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
