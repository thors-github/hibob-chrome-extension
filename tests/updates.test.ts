import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import { isExtensionVersion, isNewerExtensionVersion } from '../src/shared/updates';
import { contextFingerprint } from '../src/shared/context';
import type { ApiConnection, BookingPlan, DayPlan, MonthSnapshot, SessionState } from '../src/shared/types';

const connection = (): ApiConnection => ({ status: 'connected', generation: 'fixture-session', employeeId: 'fixture-employee', companyId: 'fixture-tenant', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } });
const approval = (controller: BookingController, plan: BookingPlan) => ({ planId: plan.id, planRevision: controller.state.planRevision!, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmed: true as const });
const sample = (): MonthSnapshot => ({
  month: '2026-11', employeeLabel: 'Local fixture', periodLabel: 'November', scannedAt: '2026-11-02', source: 'hibob',
  context: { connectionId: 'fixture-session', employeeKey: 'fixture-employee', tenantKey: 'fixture-tenant', mode: 'api-session' },
  days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })),
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(initial?: SessionState) {
  let stored = initial;
  const reload = vi.fn();
  const probe = vi.fn(async () => {});
  const bridge: ControllerBridge = {
    load: async () => stored,
    save: vi.fn(async state => { stored = structuredClone(state); }),
    scan: vi.fn(async () => sample()),
    applyDay: vi.fn(async (_tabId, day) => ({ date: day.date, editable: true, entries: day.proposed, fingerprint: 'saved' })),
    preflightDay: vi.fn(async (_tabId, day) => ({ date: day.date, checked: true as const, netMinutes: day.netMinutes!, saved: false as const, serverValidated: false as const })),
    cancel: vi.fn(async () => {}), checkUpdateIdle: probe, reload,
  };
  const controller = new BookingController(bridge);
  await controller.init();
  await controller.configureUpdates('1.2.0', '1.2.1');
  return { controller, bridge, reload, probe, stored: () => stored };
}
async function reviewed(controller: BookingController) {
  await controller.bindConnection(connection()); await controller.scan('2026-11');
  const settings = { ...defaultSettings('2026-11'), excludedDates: getMonthDates('2026-11').filter(date => date !== '2026-11-02') };
  const plan = buildMonthPlan(settings, controller.state.snapshot!, {}, 1);
  const invalid = await controller.invalidatePlan(controller.state.planRevision!, 'fixture-review');
  await controller.savePlan(plan, invalid.editLease!);
  return controller.state.plan!;
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('../src/hibob/api-adapter'); });

describe('native update coordination', () => {
  it('compares Chrome numeric versions without accepting malformed notifications', () => {
    expect(isNewerExtensionVersion('1.10', '1.9.9')).toBe(true);
    expect(isNewerExtensionVersion('1.2.0.1', '1.2')).toBe(true);
    expect(isNewerExtensionVersion('1.2.0.0', '1.2')).toBe(false);
    for (const invalid of ['1.02.0', '1.2-beta', '65536', '1.2.3.4.5', '', '<script>']) expect(isExtensionVersion(invalid)).toBe(false);
  });

  it('invalidates and durably saves a reviewed preview before deliberate activation', async () => {
    const { controller, bridge, reload, stored } = await fixture();
    const old = await reviewed(controller);
    const revision = controller.state.planRevision!;
    reload.mockImplementation(() => {
      expect(stored()?.snapshot).toBeUndefined(); expect(stored()?.plan).toBeUndefined();
      expect(stored()?.updateApplying).toBe(true);
    });
    await controller.activateUpdate();
    expect(reload).toHaveBeenCalledOnce();
    await expect(controller.apply(old, revision)).rejects.toThrow('Vorgang');
    await expect(controller.preflight(old, revision, '2026-11-02', approval(controller, old))).rejects.toThrow('Vorgang');
    await expect(controller.scan('2026-11')).rejects.toThrow('Vorgang');
    expect(bridge.applyDay).not.toHaveBeenCalled();
  });

  it('keeps the newest pending version across tab changes and clears it after installation', async () => {
    const { controller } = await fixture();
    await reviewed(controller);
    await controller.configureUpdates('1.2.0', '1.3.0');
    await controller.configureUpdates('1.2.0', '1.2.2');
    await controller.bindConnection(undefined);
    expect(controller.state.update).toEqual({ installedVersion: '1.2.0', pendingVersion: '1.3.0' });
    await reviewed(controller);
    await controller.configureUpdates('1.3.0');
    expect(controller.state.update).toEqual({ installedVersion: '1.3.0' });
    expect(controller.state.snapshot).toBeUndefined(); expect(controller.state.plan).toBeUndefined();
    await expect(controller.activateUpdate()).rejects.toThrow('noch kein Update');
  });

  it('holds the update lock while checking the adapter and rejects competing panels and jobs', async () => {
    const { controller, probe, reload, bridge } = await fixture();
    const plan = await reviewed(controller);
    const held = deferred(); probe.mockImplementation(async () => { await held.promise; });
    const updating = controller.activateUpdate();
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    await expect(controller.scan('2026-11')).rejects.toThrow('Vorgang');
    await expect(controller.apply(plan, controller.state.planRevision!, approval(controller, plan))).rejects.toThrow('Vorgang');
    await expect(controller.preflight(plan, controller.state.planRevision!, '2026-11-02', approval(controller, plan))).rejects.toThrow('Vorgang');
    expect(bridge.preflightDay).not.toHaveBeenCalled();
    expect(bridge.applyDay).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
    held.resolve(); await updating; expect(reload).toHaveBeenCalledOnce();
  });

  it('does not activate during a scan or its final storage acknowledgement', async () => {
    const { controller, bridge, reload } = await fixture();
    await controller.bindConnection(connection());
    const scanHold = deferred(), finalSave = deferred(), finalEntered = deferred();
    bridge.scan = vi.fn(async () => { await scanHold.promise; return sample(); });
    const original = bridge.save;
    bridge.save = vi.fn(async state => {
      if (state.snapshot && !state.job) { finalEntered.resolve(); await finalSave.promise; }
      await original(state);
    });
    const scanning = controller.scan('2026-11');
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    scanHold.resolve(); await finalEntered.promise;
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    expect(reload).not.toHaveBeenCalled();
    finalSave.resolve(); await scanning;
    await controller.activateUpdate(); expect(reload).toHaveBeenCalledOnce();
  });

  it('holds a pending update through draft cancellation, unchanged reread and final storage acknowledgement', async () => {
    const { controller, bridge, reload } = await fixture();
    const plan = await reviewed(controller);
    const checkEntered = deferred(), checkHold = deferred(), finalEntered = deferred(), finalHold = deferred();
    bridge.preflightDay = vi.fn(async (_connection: ApiConnection, day: DayPlan) => { checkEntered.resolve(); await checkHold.promise; return { date: day.date, checked: true as const, netMinutes: day.netMinutes!, saved: false as const, serverValidated: false as const }; });
    const original = bridge.save;
    bridge.save = vi.fn(async state => {
      if (!state.job && !state.snapshot && !state.updateApplying) { finalEntered.resolve(); await finalHold.promise; }
      await original(state);
    });
    const checking = controller.preflight(plan, controller.state.planRevision!, '2026-11-02', approval(controller, plan));
    // Attach the rejection immediately; cleanup remains held below.
    const outcome = expect(checking).rejects.toThrow('abgebrochen');
    await checkEntered.promise; await controller.cancel(controller.state.job!.id);
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    checkHold.resolve(); await finalEntered.promise;
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    expect(reload).not.toHaveBeenCalled(); expect(bridge.applyDay).not.toHaveBeenCalled();
    finalHold.resolve(); await outcome;
    await controller.activateUpdate(); expect(reload).toHaveBeenCalledOnce();
  });

  it('waits for a cancelled write readback and final journal before allowing an update', async () => {
    const { controller, bridge, reload } = await fixture();
    const plan = await reviewed(controller);
    const writeEntered = deferred(), writeHold = deferred(), journalEntered = deferred(), journalHold = deferred();
    bridge.applyDay = vi.fn(async (_tabId, day: DayPlan) => { writeEntered.resolve(); await writeHold.promise; return { date: day.date, editable: true, entries: day.proposed, fingerprint: 'saved' }; });
    const original = bridge.save;
    bridge.save = vi.fn(async state => {
      if (state.run && state.run.status !== 'running' && !state.job && !state.updateApplying) { journalEntered.resolve(); await journalHold.promise; }
      await original(state);
    });
    const applying = controller.apply(plan, controller.state.planRevision!, approval(controller, plan)); await writeEntered.promise;
    await controller.cancel(controller.state.job!.id);
    expect(controller.state.job?.status).toBe('cancelling');
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    writeHold.resolve(); await journalEntered.promise;
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    expect(reload).not.toHaveBeenCalled();
    journalHold.resolve(); await applying;
    expect(controller.state.run?.results.find(result => result.date === '2026-11-02')?.status).toBe('verified');
    await controller.activateUpdate(); expect(reload).toHaveBeenCalledOnce();
  });

  it('rejects an interrupted orphan job without trying to reload or cancel it', async () => {
    const { controller, reload, probe, bridge } = await fixture({ schemaVersion: 4, connection: connection(), job: { id: 'orphan', kind: 'apply', status: 'running', connectionId: 'fixture-session', month: '2026-11', startedAt: 'x', updatedAt: 'x' } });
    expect(controller.state.job?.status).toBe('interrupted');
    await expect(controller.activateUpdate()).rejects.toThrow('Abschluss');
    expect(probe).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('does not reload after a failed update invalidation journal, and leaves booking revoked', async () => {
    const { controller, bridge, reload } = await fixture();
    await reviewed(controller);
    bridge.save = vi.fn(async state => { if (state.updateApplying) throw new Error('update journal unavailable'); });
    await expect(controller.activateUpdate()).rejects.toThrow('update journal unavailable');
    expect(reload).not.toHaveBeenCalled(); expect(controller.state.updateApplying).toBe(false);
    expect(controller.state.snapshot).toBeUndefined(); expect(controller.state.plan).toBeUndefined();
  });

  it('discards a preview left by an interrupted activation without resuming writes', async () => {
    const previous = await fixture(); await reviewed(previous.controller);
    const stored = structuredClone(previous.controller.state); stored.updateApplying = true;
    const next = await fixture(stored);
    expect(next.controller.state.snapshot).toBeUndefined(); expect(next.controller.state.plan).toBeUndefined();
    expect(next.controller.state.updateApplying).toBe(false); expect(next.reload).not.toHaveBeenCalled();
    expect(next.bridge.scan).not.toHaveBeenCalled(); expect(next.bridge.applyDay).not.toHaveBeenCalled();
  });
});

async function backgroundFixture(options: { initial?: SessionState; heldInitial?: Promise<void>; idleError?: string } = {}) {
  let receiver!: (message: unknown, sender: object, response: (result: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  let update!: (details: { version: string }) => void;
  const reload = vi.fn(), idle = vi.fn(async () => { if (options.idleError) throw new Error(options.idleError); });
  const api = { connect: vi.fn(async () => connection()), disconnect: vi.fn(async () => {}), scanMonth: vi.fn(async () => sample()), applyDay: vi.fn(), preflightDay: vi.fn(), cancel: vi.fn(), recover: vi.fn(async () => {}), assertIdle: idle };
  vi.doMock('../src/hibob/api-adapter', () => ({ HiBobApiAdapter: class { connect = api.connect; disconnect = api.disconnect; scanMonth = api.scanMonth; applyDay = api.applyDay; preflightDay = api.preflightDay; cancel = api.cancel; recover = api.recover; assertIdle = api.assertIdle; } }));
  let stored = options.initial;
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), getURL: (path: string) => `chrome-extension://test/${path}`, reload,
      onUpdateAvailable: { addListener: (listener: typeof update) => { update = listener; } }, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    storage: { session: { get: async () => { await options.heldInitial; return { sessionState: stored }; }, set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    action: { onClicked: { addListener: () => {} } }, sidePanel: { open: async () => {} },
  });
  await import('../src/background');
  const rpc = (message: object, sender = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) => new Promise<{ ok: boolean; state?: SessionState; error?: string }>(resolve => receiver(message, sender, resolve));
  return { update, rpc, reload, idle, api };
}

describe('API background update transport', () => {
  it('captures an update announced while initial session loading is still pending', async () => {
    const loading = deferred(); const background = await backgroundFixture({ heldInitial: loading.promise });
    background.update({ version: '1.2.1' }); loading.resolve();
    await vi.waitFor(async () => expect((await background.rpc({ type: 'PANEL_GET_STATE' })).state?.update).toEqual({ installedVersion: '1.2.0', pendingVersion: '1.2.1' }));
    expect(background.reload).not.toHaveBeenCalled();
    const denied = await background.rpc({ type: 'PANEL_ACTIVATE_UPDATE' }, { id: 'test', url: 'https://app.hibob.com/attendance/my-attendance' });
    expect(denied.ok).toBe(false); expect(background.reload).not.toHaveBeenCalled();
  });

  it('checks API idleness before activation without requiring a browser tab', async () => {
    const background = await backgroundFixture();
    background.update({ version: '1.2.1' });
    await vi.waitFor(async () => expect((await background.rpc({ type: 'PANEL_GET_STATE' })).state?.update?.pendingVersion).toBe('1.2.1'));
    const result = await background.rpc({ type: 'PANEL_ACTIVATE_UPDATE' });
    expect(result.ok).toBe(true); expect(background.idle).toHaveBeenCalledOnce(); expect(background.reload).toHaveBeenCalledOnce();
    expect(result.state?.snapshot).toBeUndefined(); expect(result.state?.updateApplying).toBe(true);
    expect(background.api.connect).not.toHaveBeenCalled(); expect(background.api.applyDay).not.toHaveBeenCalled();
  });

  it('does not treat a failed API idle probe as permission to reload', async () => {
    const background = await backgroundFixture({ idleError: 'API operation still active' });
    background.update({ version: '1.2.1' });
    await vi.waitFor(async () => expect((await background.rpc({ type: 'PANEL_GET_STATE' })).state?.update?.pendingVersion).toBe('1.2.1'));
    const result = await background.rpc({ type: 'PANEL_ACTIVATE_UPDATE' });
    expect(result.ok).toBe(false); expect(result.error).toContain('still active');
    expect(background.idle).toHaveBeenCalledOnce(); expect(background.reload).not.toHaveBeenCalled(); expect(background.api.cancel).not.toHaveBeenCalled();
  });
});
