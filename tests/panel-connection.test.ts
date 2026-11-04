// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { buildMonthPlan, defaultSettings, formatMinutes, getMonthDates } from '../src/domain/index';
import { contextFingerprint, executionFingerprint } from '../src/shared/context';
import type { AccountConfirmation, BookingPlan, PreflightResult, MonthSnapshot, PlanEditLease, RunOptions, SessionState, Settings } from '../src/shared/types';

const settings = defaultSettings('2026-11');
function connection(generation = 'test-connection') { return { status: 'connected' as const, generation, employeeId: 'test-employee', companyId: 'test-company', employeeLabel: 'Thorsten Test', companyLabel: 'Test Company', transport: 'direct' as const, capabilities: { read: true, write: true, overwrite: true } }; }
type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function snapshot(mode: 'stable-identity' | 'user-confirmed-ui' | 'api-session' = 'stable-identity'): MonthSnapshot {
  return {
    month: '2026-11', source: 'hibob', employeeLabel: 'Thorsten Test',
    periodLabel: '01/11/2026–30/11/2026 (Running)', scannedAt: '2026-11-02T08:30:00.000Z',
    context: mode === 'api-session' ? { mode, connectionId: 'test-connection', employeeKey: 'test-employee', tenantKey: 'test-company' } : mode === 'stable-identity'
      ? { mode, documentId: 'test-document', employeeKey: 'test-employee', tenantKey: 'test-tenant' }
      : { mode, documentId: 'test-document', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'own-attendance-markers' },
    days: getMonthDates('2026-11').map(date => ({ date, editable: true, entries: [], fingerprint: `empty:${date}`, reportedMinutes: 0 })),
  };
}

function reviewedState(mode: 'stable-identity' | 'user-confirmed-ui' | 'api-session' = 'stable-identity'): SessionState {
  const scanned = snapshot(mode);
  scanned.days.find(day => day.date === '2026-11-02')!.entries = [{ type: 'work', start: '08:00', end: '16:00' }];
  scanned.days.find(day => day.date === '2026-11-02')!.reportedMinutes = 480;
  const plan = buildMonthPlan(settings, scanned, { '2026-11-02': 'skip' }, 123);
  expect(plan.canReview).toBe(true);
  return { schemaVersion: 7, revision: 1, planRevision: 1, connection: connection(), snapshot: scanned, plan };
}

function matchingState(): SessionState {
  const scanned = snapshot('api-session');
  const variable = { ...settings, variable: true, variationMinutes: 15 };
  for (const day of scanned.days) {
    if ([0, 6].includes(new Date(`${day.date}T12:00:00Z`).getUTCDay())) continue;
    day.entries = [{ type: 'work', start: '08:07', end: '12:00' }, { type: 'break', start: '12:00', end: '12:30' }, { type: 'work', start: '12:30', end: '16:37' }];
    day.reportedMinutes = 480; day.fingerprint = `retained:${day.date}`;
  }
  return { schemaVersion: 7, revision: 1, planRevision: 1, connection: connection(), snapshot: scanned, plan: buildMonthPlan(variable, scanned, {}, 73191) };
}

type Message = { type: string; date?: string; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; plan?: BookingPlan; planId?: string; jobId?: string; confirmation?: AccountConfirmation; options?: RunOptions };
type Reply = { ok: boolean; state?: SessionState; error?: string; preflight?: PreflightResult };

function mockChrome(options: {
  state?: SessionState;
  getState?: () => Promise<SessionState>;
  getSettings?: () => Promise<{ settings?: Settings }>;
  setSettings?: (value: { settings: Settings }) => Promise<void>;
  onMessage?: (message: Message, state: SessionState) => Promise<Reply | undefined>;
} = {}) {
  const listeners = new Set<StorageListener>();
  let backend: SessionState = { schemaVersion: 7, revision: 0, planRevision: 0, ...structuredClone(options.state ?? {}) };
  const sendMessage = vi.fn(async (message: Message): Promise<Reply> => {
    const custom = await options.onMessage?.(message, structuredClone(backend));
    if (custom) return custom;
    if (message.type === 'PANEL_GET_STATE') return { ok: true, state: await (options.getState?.() ?? Promise.resolve(structuredClone(backend))) };
    if (message.type === 'PANEL_CONNECT' || message.type === 'PANEL_DISCONNECT') backend = { ...backend, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, connection: message.type === 'PANEL_CONNECT' ? connection() : { status: 'disconnected', generation: 'disconnected' }, snapshot: undefined, plan: undefined };
    if (message.type === 'PANEL_INVALIDATE_PLAN') {
      if (message.expectedPlanRevision !== backend.planRevision) return { ok: false, state: structuredClone(backend), error: 'Stale plan revision' };
      backend = { ...backend, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, plan: undefined };
      backend.editLease = { planRevision: backend.planRevision!, changeId: message.changeId! };
    }
    if (message.type === 'PANEL_SAVE_PLAN') {
      if (JSON.stringify(message.lease) !== JSON.stringify(backend.editLease)) return { ok: false, state: structuredClone(backend), error: 'Stale edit lease' };
      backend = { ...backend, revision: (backend.revision ?? 0) + 1, plan: structuredClone(message.plan) };
    }
    if (message.type === 'PANEL_PREFLIGHT') {
      const day = message.plan!.days.find(day => day.date === message.date)!;
      backend = { ...backend, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, snapshot: undefined, plan: undefined, job: undefined };
      return { ok: true, state: structuredClone(backend), preflight: { date: day.date, checked: true, netMinutes: day.netMinutes!, saved: false, serverValidated: false } };
    }
    return { ok: true, state: structuredClone(backend) };
  });
  const addListener = vi.fn((listener: StorageListener) => listeners.add(listener));
  const setSettings = vi.fn((value: { settings: Settings }) => options.setSettings?.(value) ?? Promise.resolve());
  vi.stubGlobal('chrome', {
    runtime: { id: 'hibob-panel-test', sendMessage },
    storage: {
      local: {
        get: vi.fn(() => options.getSettings?.() ?? Promise.resolve({ settings })),
        set: setSettings,
      },
      onChanged: {
        addListener,
        removeListener: vi.fn((listener: StorageListener) => listeners.delete(listener)),
      },
    },
  });
  return {
    sendMessage, addListener, setSettings,
    get state() { return structuredClone(backend); },
    emit(state: SessionState) {
      backend = { schemaVersion: 7, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, ...structuredClone(state) };
      for (const listener of listeners) listener({ sessionState: { newValue: structuredClone(backend) } }, 'session');
    },
  };
}

const title = () => document.getElementById('connection-title')?.textContent;
const detail = () => document.getElementById('connection-detail')?.textContent;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const dialog = (id: string) => document.getElementById(id) as HTMLDialogElement;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
function change(id: string, value: string) { field(id).value = value; field(id).dispatchEvent(new Event('input', { bubbles: true })); }
async function mount() { await import('../src/panel/main'); }
const settleStartup = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  const storage = (): Storage => {
    const values = new Map<string, string>();
    return { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
  };
  // Explicit stubs avoid Node 24's optional localStorage global shadowing jsdom's Storage.
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
  // jsdom does not implement the browser's top-layer dialog presentation.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.innerHTML = '';
});

describe('actual extension panel connection states', () => {
  it('connects from any browser tab and disconnects without scanning or writing', async () => {
    const chrome = mockChrome();
    await mount();
    await vi.waitFor(() => expect(button('connect').disabled).toBe(false));
    button('connect').click();
    await vi.waitFor(() => expect(title()).toBe('Thorsten Test · Test Company'));
    expect(document.getElementById('connection-account')!.textContent).toContain('Thorsten Test · Test Company');
    expect(document.getElementById('connection-technical')?.textContent).toContain('Direkte API-Verbindung');
    expect(button('scan').disabled).toBe(false);
    button('disconnect').click();
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbinden'));
    expect(button('scan').disabled).toBe(true);
    expect(chrome.sendMessage.mock.calls.some(([message]) => ['PANEL_SCAN', 'PANEL_APPLY'].includes(message.type))).toBe(false);
  });

  it('allows a read-only API plan check while blocking the save action', async () => {
    const initial = reviewedState('api-session');
    initial.connection!.capabilities = { read: true, write: false, overwrite: false };
    const chrome = mockChrome({ state: initial });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(button('apply').textContent).toBe('Plan prüfen');
    expect(document.getElementById('api-capability-notice')?.hidden).toBe(false);
    button('apply').click();
    expect(document.getElementById('apply-details')?.textContent).toContain('Thorsten Test · Test Company');
    field('account-confirmation').checked = true;
    field('account-confirmation').dispatchEvent(new Event('change'));
    expect(button('check-draft').disabled).toBe(false);
    expect(button('confirm-apply').disabled).toBe(true);
    button('confirm-apply').dispatchEvent(new Event('click'));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    button('check-draft').click();
    await vi.waitFor(() => expect(document.getElementById('draft-check-result')?.hidden).toBe(false));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_PREFLIGHT')).toBe(true);
  });

  it.each(['expired', 'unsupported'] as const)('reports a %s API session and blocks scan and confirmation', async status => {
    mockChrome({ state: { connection: { ...connection(), status, reason: 'Reconnect required' } } });
    await mount();
    await vi.waitFor(() => expect(detail()).toContain('Reconnect required'));
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(button('connect').hidden).toBe(false);
  });

  it('asks for a HiBob tab and disables scanning before any tab is bound', async () => {
    const chrome = mockChrome();
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbinden'));
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    button('scan').click();
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_SCAN')).toBe(false);
  });

  it('shows a selected tab before a month is read and enables only scanning', async () => {
    mockChrome({ state: { connection: connection() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Thorsten Test · Test Company'));
    expect(button('scan').disabled).toBe(false);
    expect(button('apply').disabled).toBe(true);
    expect(document.getElementById('preview-empty')?.hidden).toBe(false);
  });

  it('shows employee, local scan time, and period only after a snapshot exists', async () => {
    mockChrome({ state: { connection: connection(), snapshot: snapshot() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Thorsten Test · Test Company'));
    button('settings-toggle').click(); button('connection-link').click();
    expect(document.getElementById('connection-account')!.textContent).toContain('Thorsten Test');
    expect(document.getElementById('connection-scan-detail')!.textContent).toContain('Eingelesen: 09:30 Uhr');
    expect(document.getElementById('connection-scan-detail')!.textContent).toContain('01/11/2026–30/11/2026 (Running)');
    expect(button('scan').disabled).toBe(false);
  });

  it('receives tab binding while local settings are still loading', async () => {
    const loading = deferred<{ settings?: Settings }>();
    const chrome = mockChrome({ state: { connection: connection() }, getSettings: () => loading.promise });
    await mount();
    expect(chrome.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.sendMessage).not.toHaveBeenCalled();
    chrome.emit({ connection: connection() });
    expect(title()).toBe('Thorsten Test · Test Company');
    loading.resolve({ settings });
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    await settleStartup();
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(title()).toBe('Thorsten Test · Test Company');
  });

  it('does not let an older deferred GET_STATE erase a newer tab-binding event', async () => {
    const loading = deferred<SessionState>();
    const chrome = mockChrome({ getState: () => loading.promise });
    await mount();
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    chrome.emit({ connection: connection() });
    expect(title()).toBe('Thorsten Test · Test Company');
    loading.resolve({});
    // Flush the entire response/initialize microtask chain, rather than asserting an intermediate event render.
    await settleStartup();
    expect(title()).toBe('Thorsten Test · Test Company');
    expect(button('scan').disabled).toBe(false);
  });

  it('does not restore an older bound plan after a newer unbound reset', async () => {
    const loading = deferred<SessionState>();
    const chrome = mockChrome({ getState: () => loading.promise });
    await mount();
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    chrome.emit({});
    loading.resolve(reviewedState());
    await settleStartup();
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbinden'));
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(document.querySelectorAll('#calendar button[data-date]:not([data-state="unread"])')).toHaveLength(0);
  });

  it.each(['apply', 'conflicts'])('clears a reviewed plan and open %s dialog when the tab binding resets', async (control) => {
    const chrome = mockChrome({ state: reviewedState() });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(document.querySelectorAll('#calendar button[data-date]:not([data-state="unread"])')).toHaveLength(30);
    button(control).click();
    expect(dialog(control === 'apply' ? 'apply-dialog' : 'conflict-dialog').open).toBe(true);
    chrome.emit({});
    expect(title()).toBe('Mit HiBob verbinden');
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(dialog('apply-dialog').open).toBe(false);
    expect(dialog('conflict-dialog').open).toBe(false);
    expect(document.querySelectorAll('#calendar button[data-date]:not([data-state="unread"])')).toHaveLength(0);
  });

  it('restores an existing cold binding when the side panel is reopened', async () => {
    mockChrome({ state: { connection: connection() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Thorsten Test · Test Company'));
    // A new side-panel document has no prior listener or local module state.
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    const reopened = mockChrome({ state: { connection: connection() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Thorsten Test · Test Company'));
    expect(reopened.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' });
    expect(button('scan').disabled).toBe(false);
    expect(button('apply').disabled).toBe(true);
  });

  it('revokes confirmation on input and invalidates the canonical plan before writing preferences', async () => {
    const invalidating = deferred<void>();
    const chrome = mockChrome({ state: reviewedState(), onMessage: async message => {
      if (message.type === 'PANEL_INVALIDATE_PLAN') await invalidating.promise;
      return undefined;
    } });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    expect(dialog('apply-dialog').open).toBe(true);
    change('start', '09:00');
    expect(dialog('apply-dialog').open).toBe(false);
    expect(button('apply').disabled).toBe(true);
    button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_INVALIDATE_PLAN')).toBe(true));
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    invalidating.resolve();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(chrome.setSettings).toHaveBeenCalledWith({ settings: expect.objectContaining({ start: '09:00' }) });
  });

  it('keeps approval revoked after a preference failure and retries the same settings, choices and seed', async () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    let writes = 0;
    const chrome = mockChrome({ state: reviewedState(), setSettings: async () => { if (++writes === 1) throw new Error('Preferences write failed'); } });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    change('start', '09:00');
    await vi.waitFor(() => expect(button('retry-plan').hidden).toBe(false));
    expect(document.getElementById('main-error')?.textContent).toContain('Preferences write failed');
    expect(button('apply').disabled).toBe(true);
    expect(chrome.state.plan).toBeUndefined();
    const randomCalls = random.mock.calls.length;
    button('retry-plan').click();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(field('start').value).toBe('09:00');
    expect(random.mock.calls).toHaveLength(randomCalls);
    const saved = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_SAVE_PLAN')![0];
    expect(saved.plan?.settings.start).toBe('09:00');
    expect(saved.plan?.choices).toEqual({ '2026-11-02': 'skip' });
    expect(chrome.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_INVALIDATE_PLAN')).toHaveLength(1);
  });

  it('retries a failed plan acknowledgement without rerandomizing or re-saving preferences', async () => {
    let saves = 0;
    const chrome = mockChrome({ state: reviewedState(), onMessage: async (message, state) => {
      if (message.type === 'PANEL_SAVE_PLAN' && ++saves === 1) return { ok: false, state, error: 'Plan write failed' };
      return undefined;
    } });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    field('variable').checked = true;
    field('variable').dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(button('retry-plan').hidden).toBe(false));
    expect(button('apply').disabled).toBe(true);
    const first = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_SAVE_PLAN')![0];
    button('retry-plan').click();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    const saved = chrome.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_SAVE_PLAN');
    expect(saved).toHaveLength(2);
    expect(saved[1][0]).toEqual(first);
    expect(chrome.setSettings).toHaveBeenCalledTimes(1);
  });

  it('ignores a late older SAVE response after a newer edit has already been acknowledged', async () => {
    const oldSave = deferred<Reply>();
    let oldState: SessionState | undefined;
    let oldPlan: BookingPlan | undefined;
    const chrome = mockChrome({ state: reviewedState(), onMessage: async (message, state) => {
      if (message.type === 'PANEL_SAVE_PLAN' && message.plan?.settings.start === '09:00') {
        oldState = state; oldPlan = message.plan;
        return oldSave.promise;
      }
      return undefined;
    } });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    change('start', '09:00');
    await vi.waitFor(() => expect(oldPlan).toBeDefined());
    change('start', '10:00');
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    expect(dialog('apply-dialog').open).toBe(true);
    oldSave.resolve({ ok: true, state: { ...oldState, revision: (oldState!.revision ?? 0) + 1, plan: oldPlan } });
    await settleStartup();
    expect(field('start').value).toBe('10:00');
    expect(dialog('apply-dialog').open).toBe(true);
    button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(true));
    const applied = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_APPLY')![0];
    expect(applied.plan?.settings.start).toBe('10:00');
    expect(applied.expectedPlanRevision).toBe(3);
  });

  it('does not approve an incoming replacement plan from its storage event before a fresh GET succeeds', async () => {
    const loading = deferred<Reply>();
    let gets = 0;
    const chrome = mockChrome({ state: reviewedState(), onMessage: async message => {
      if (message.type === 'PANEL_GET_STATE' && ++gets > 1) return loading.promise;
      return undefined;
    } });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    const replacement = reviewedState();
    replacement.revision = 10; replacement.planRevision = 10;
    replacement.plan = buildMonthPlan({ ...settings, start: '09:00' }, replacement.snapshot!, { '2026-11-02': 'skip' }, 99);
    chrome.emit(replacement);
    expect(dialog('apply-dialog').open).toBe(false);
    expect(button('apply').disabled).toBe(true);
    button('confirm-apply').click();
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    loading.resolve({ ok: true, state: chrome.state });
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(field('start').value).toBe('09:00');
  });

  it('discards old metadata consent when a replacement snapshot and plan arrive without an intermediate invalidation', async () => {
    const initial = reviewedState();
    initial.snapshot!.days.find(day => day.date === '2026-11-02')!.entries[0].note = 'Metadata A';
    initial.plan = buildMonthPlan(settings, initial.snapshot!, { '2026-11-02': 'skip' }, 123);
    const chrome = mockChrome({ state: initial });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('conflicts').click();
    const choice = document.querySelector<HTMLSelectElement>('[data-conflict-choice="2026-11-02"]')!;
    choice.value = 'overwrite'; choice.dispatchEvent(new Event('change'));
    const oldAcknowledgement = document.querySelector<HTMLInputElement>('[data-metadata-ack="2026-11-02"]')!;
    oldAcknowledgement.checked = true;
    expect(dialog('conflict-dialog').open).toBe(true);
    expect(document.getElementById('conflict-items')?.textContent).toContain('Metadata A');

    const replacement = structuredClone(initial);
    replacement.revision = 10; replacement.planRevision = 10;
    const changedDay = replacement.snapshot!.days.find(day => day.date === '2026-11-02')!;
    changedDay.entries[0].note = 'Metadata B'; changedDay.fingerprint = 'new-metadata-B';
    replacement.plan = buildMonthPlan(settings, replacement.snapshot!, { '2026-11-02': 'skip' }, 456);
    chrome.emit(replacement);
    expect(dialog('conflict-dialog').open).toBe(false);
    expect(oldAcknowledgement.isConnected).toBe(false);
    button('save-conflicts').click();
    await settleStartup();
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_INVALIDATE_PLAN' || message.type === 'PANEL_SAVE_PLAN')).toBe(false);

    await vi.waitFor(() => expect(button('conflicts').disabled).toBe(false));
    button('conflicts').click();
    expect(document.getElementById('conflict-items')?.textContent).toContain('Metadata B');
    expect(document.querySelector<HTMLInputElement>('[data-metadata-ack="2026-11-02"]')?.checked).toBe(false);
  });

  it.each(['scan', 'apply'] as const)('restores an active %s job and cancels only its canonical job id', async kind => {
    const state: SessionState = { schemaVersion: 7, revision: 2, planRevision: 2, connection: connection(),
      job: { id: `${kind}-job-7`, kind, status: 'running', connectionId: 'test-connection', month: '2026-11', startedAt: '2026-11-02T09:00:00Z', updatedAt: '2026-11-02T09:00:01Z' },
      progress: { phase: kind, completed: 7, total: 30, message: 'Local job fixture' } };
    const chrome = mockChrome({ state });
    await mount();
    await vi.waitFor(() => expect(button('cancel-run').hidden).toBe(false));
    if (kind === 'scan') expect(button('scan').hidden).toBe(true);
    expect(button('scan').disabled).toBe(true);
    expect((document.getElementById('settings-fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(document.getElementById('scan-progress')?.hidden).toBe(false);
    expect(button('cancel-run').hidden).toBe(false);
    button('cancel-run').click();
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_CANCEL', jobId: `${kind}-job-7` }));
  });

  it('marks a newly selected month unread and removes the previous month preview immediately', async () => {
    mockChrome({ state: reviewedState() });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    change('month', '2026-12');
    expect(title()).toBe('Thorsten Test · Test Company');
    expect(field('month').value).toBe('2026-12');
    expect(document.querySelectorAll('#calendar button[data-date]:not([data-state="unread"])')).toHaveLength(0);
    expect(button('apply').disabled).toBe(true);
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(button('scan').textContent).toBe('Vorschau erstellen');
  });

  it('creates a preview explicitly from a completed scan restored without a plan', async () => {
    const chrome = mockChrome({ state: { connection: connection(), snapshot: snapshot() } });
    await mount();
    await vi.waitFor(() => expect(button('build-preview').hidden).toBe(false));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_INVALIDATE_PLAN')).toBe(false);
    button('build-preview').click();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(document.querySelectorAll('#calendar button[data-date]:not([data-state="unread"])')).toHaveLength(30);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_SCAN')).toBe(false);
  });

  it('offers an explicit startup retry and does not write default preferences after storage read fails', async () => {
    let reads = 0;
    const chrome = mockChrome({ state: { connection: connection() }, getSettings: async () => {
      if (++reads === 1) throw new Error('Preferences unavailable');
      return { settings: { ...settings, start: '09:00' } };
    } });
    await mount();
    await vi.waitFor(() => expect(button('retry-connection').hidden).toBe(false));
    expect(button('apply').disabled).toBe(true);
    expect(button('scan').disabled).toBe(true);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    button('retry-connection').click();
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(field('start').value).toBe('09:00');
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(chrome.addListener).toHaveBeenCalledTimes(1);
  });

  it('retries a failed controller initialization without discarding loaded preferences or adding listeners', async () => {
    let gets = 0;
    const chrome = mockChrome({ state: { connection: connection() }, getSettings: async () => ({ settings: { ...settings, start: '09:00' } }), onMessage: async (message, state) => {
      if (message.type === 'PANEL_GET_STATE' && ++gets === 1) return { ok: false, state, error: 'Controller unavailable' };
      return undefined;
    } });
    await mount();
    await vi.waitFor(() => expect(button('retry-connection').hidden).toBe(false));
    expect(field('start').value).toBe('09:00');
    expect(button('scan').disabled).toBe(true);
    button('retry-connection').click();
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(field('start').value).toBe('09:00');
    expect(document.getElementById('main-error')?.hidden).toBe(true);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(chrome.addListener).toHaveBeenCalledTimes(1);
  });

  it('allows reviewing a manual UI context but requires fresh account consent before sending APPLY', async () => {
    const initial = reviewedState('user-confirmed-ui');
    const chrome = mockChrome({ state: initial });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(title()).toContain('Thorsten Test');
    expect(document.getElementById('account-context-notice')?.classList.contains('error')).toBe(false);
    expect(document.getElementById('main-error')?.hidden).toBe(true);
    expect(document.getElementById('plan-errors')?.hidden).toBe(true);
    button('apply').click();
    expect(dialog('apply-dialog').open).toBe(true);
    expect(field('account-confirmation').required).toBe(true);
    expect(field('account-confirmation').checked).toBe(false);
    expect(button('confirm-apply').disabled).toBe(true);
    expect(document.getElementById('account-confirmation-label')?.textContent).toContain('November 2026');
    expect(document.getElementById('apply-description')?.textContent).not.toContain('Thorsten Test');
    button('confirm-apply').dispatchEvent(new Event('click'));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    field('account-confirmation').checked = true;
    field('account-confirmation').dispatchEvent(new Event('change'));
    expect(button('confirm-apply').disabled).toBe(false);
    button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(true));
    const sent = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_APPLY')![0];
    expect(sent.confirmation).toEqual({ planId: initial.plan!.id, planRevision: 1, contextFingerprint: contextFingerprint(initial.snapshot!.context), executionFingerprint: executionFingerprint({ executionProfile: 'fast-serial' }), confirmed: true });
    expect(sent.plan?.snapshot.context).toEqual(initial.snapshot!.context);
    expect(field('account-confirmation').checked).toBe(false);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(chrome.state)).not.toContain('"confirmation"');
  });

  it('clears manual account consent on Back, Escape, every reopen, and settings edits', async () => {
    const chrome = mockChrome({ state: reviewedState('user-confirmed-ui') });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    const consent = () => { field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change')); };
    button('apply').click(); consent();
    button('close-apply').click();
    expect(field('account-confirmation').checked).toBe(false);
    button('apply').click();
    expect(field('account-confirmation').checked).toBe(false);
    expect(button('confirm-apply').disabled).toBe(true);
    consent(); dialog('apply-dialog').dispatchEvent(new Event('cancel'));
    expect(dialog('apply-dialog').open).toBe(false);
    expect(field('account-confirmation').checked).toBe(false);
    button('apply').click(); consent();
    change('start', '09:00');
    expect(dialog('apply-dialog').open).toBe(false);
    expect(field('account-confirmation').checked).toBe(false);
    button('confirm-apply').dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    expect(field('account-confirmation').checked).toBe(false);
    expect(button('confirm-apply').disabled).toBe(true);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it.each(['revision', 'plan', 'snapshot', 'context', 'job'] as const)('discards manual consent after a %s replacement event', async changed => {
    const initial = reviewedState('user-confirmed-ui');
    const chrome = mockChrome({ state: initial });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    field('account-confirmation').checked = true;
    field('account-confirmation').dispatchEvent(new Event('change'));
    expect(button('confirm-apply').disabled).toBe(false);
    const replacement = structuredClone(initial);
    replacement.revision = 10;
    if (changed === 'revision') replacement.planRevision = 10;
    if (changed === 'plan') replacement.plan = buildMonthPlan({ ...settings, start: '09:00' }, replacement.snapshot!, { '2026-11-02': 'skip' }, 124);
    if (changed === 'snapshot') replacement.snapshot!.scannedAt = '2026-11-02T10:30:00.000Z';
    if (changed === 'context') replacement.snapshot!.context = { mode: 'user-confirmed-ui', documentId: 'different-document', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'different-markers' };
    if (changed === 'job') replacement.job = { id: 'other-job', kind: 'scan', status: 'running', connectionId: 'test-connection', month: '2026-11', startedAt: 'now', updatedAt: 'now' };
    chrome.emit(replacement);
    expect(dialog('apply-dialog').open).toBe(false);
    expect(field('account-confirmation').checked).toBe(false);
    button('confirm-apply').dispatchEvent(new Event('click'));
    button('check-draft').dispatchEvent(new Event('click'));
    await settleStartup();
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_PREFLIGHT')).toBe(false);
  });

  it('does not require manual account confirmation for a stable identity context', async () => {
    const chrome = mockChrome({ state: reviewedState() });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(document.getElementById('account-context-notice')?.hidden).toBe(true);
    button('apply').click();
    expect(document.getElementById('account-confirmation-field')?.hidden).toBe(true);
    expect(field('account-confirmation').required).toBe(false);
    expect(button('confirm-apply').disabled).toBe(false);
    button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(true));
    expect(chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_APPLY')![0].confirmation).toBeUndefined();
  });

  it('checks only a selected writable day with fresh account consent and preserves preferences and history', async () => {
    const initial = reviewedState('user-confirmed-ui');
    const preferences = { ...settings, variable: true, variationMinutes: 15, excludedDates: ['2026-11-02'] };
    initial.plan = buildMonthPlan(preferences, initial.snapshot!, {}, 123);
    const chrome = mockChrome({ state: initial, getSettings: async () => ({ settings: preferences }) });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    const dates = document.getElementById('draft-check-date') as HTMLSelectElement;
    expect(dates.value).toBe('2026-11-03');
    expect([...dates.options].map(option => option.value)).toHaveLength(20);
    expect([...dates.options].some(option => option.value === '2026-11-02' || option.value === '2026-11-07')).toBe(false);
    expect(button('check-draft').disabled).toBe(true);
    button('check-draft').dispatchEvent(new Event('click'));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_PREFLIGHT')).toBe(false);
    field('account-confirmation').checked = true;
    field('account-confirmation').dispatchEvent(new Event('change'));
    expect(button('check-draft').disabled).toBe(false);
    dates.value = '2026-11-04'; dates.dispatchEvent(new Event('change'));
    expect(field('account-confirmation').checked).toBe(false);
    expect(button('check-draft').disabled).toBe(true);
    expect(button('confirm-apply').disabled).toBe(true);
    field('account-confirmation').checked = true;
    field('account-confirmation').dispatchEvent(new Event('change'));
    button('check-draft').click();
    await vi.waitFor(() => expect(document.getElementById('draft-check-result')?.hidden).toBe(false));
    const checked = chrome.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_PREFLIGHT');
    expect(checked).toHaveLength(1);
    expect(checked[0][0]).toMatchObject({ date: '2026-11-04', plan: initial.plan, expectedPlanRevision: 1, confirmation: { planId: initial.plan.id, planRevision: 1, contextFingerprint: contextFingerprint(initial.snapshot!.context), executionFingerprint: executionFingerprint({ executionProfile: 'fast-serial' }), confirmed: true } });
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(field('variationMinutes').value).toBe('15');
    expect((document.getElementById('excludedDates') as HTMLTextAreaElement).value).toBe('2026-11-02');
    const checkedDay = initial.plan.days.find(day => day.date === '2026-11-04')!;
    const resultText = document.getElementById('draft-check-result')!.textContent!;
    expect(resultText).toContain('nicht gespeichert');
    expect(resultText).toContain('keine serverseitige Speicherbestätigung');
    expect(resultText).toContain('04.11.');
    expect(resultText).toContain(formatMinutes(checkedDay.netMinutes));
    expect(resultText).toContain('keine serverseitige Speicherbestätigung');
    expect(field('account-confirmation').checked).toBe(false);
    expect(button('apply').disabled).toBe(true);
    expect(button('scan').disabled).toBe(false);
    expect(document.getElementById('footer-hint')!.textContent).toContain('Monat erneut einlesen');
    expect(chrome.state.snapshot).toBeUndefined();
    expect(chrome.state.plan).toBeUndefined();
    expect(chrome.state.run).toBeUndefined();
    expect(JSON.stringify(chrome.state)).not.toContain('preflight');
    expect(JSON.stringify(sessionStorage)).not.toContain('preflight');
  });

  it('cancels the active draft-check job and never reports a successful check after cancellation', async () => {
    const initial = reviewedState('user-confirmed-ui');
    initial.run = { planId: 'old-plan', status: 'complete', startedAt: 'earlier', updatedAt: 'earlier', results: [{ date: '2026-10-30', status: 'verified', message: 'Old verified result' }] };
    const held = deferred<Reply>();
    const chrome = mockChrome({ state: initial, onMessage: async message => message.type === 'PANEL_PREFLIGHT' ? held.promise : undefined });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click();
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change'));
    button('check-draft').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_PREFLIGHT')).toBe(true));
    chrome.emit({ ...initial, revision: 2, job: { id: 'draft-check-job', kind: 'apply', status: 'running', connectionId: 'test-connection', month: '2026-11', startedAt: 'now', updatedAt: 'now' } });
    expect(button('apply').disabled).toBe(true);
    expect(button('scan').disabled).toBe(true);
    expect(button('export-settings').disabled).toBe(true);
    expect(button('cancel-run').hidden).toBe(false);
    button('cancel-run').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_CANCEL' && message.jobId === 'draft-check-job')).toBe(true));
    held.resolve({ ok: false, error: 'Draft check cancelled without saving', state: { ...initial, revision: 3, planRevision: 2, snapshot: undefined, plan: undefined, job: undefined } });
    await vi.waitFor(() => expect(document.getElementById('main-error')!.textContent).toContain('cancelled without saving'));
    expect(document.getElementById('draft-check-result')?.hidden).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(button('scan').disabled).toBe(false);
    expect(field('account-confirmation').checked).toBe(false);
    expect(document.getElementById('run-results')!.textContent).toContain('Old verified result');
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it('discards a late draft-check result after another tab replaces the reviewed page', async () => {
    const initial = reviewedState();
    const held = deferred<Reply>();
    const chrome = mockChrome({ state: initial, onMessage: async message => message.type === 'PANEL_PREFLIGHT' ? held.promise : undefined });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click(); button('check-draft').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_PREFLIGHT')).toBe(true));
    chrome.emit({ schemaVersion: 7, revision: 10, planRevision: 10, connection: connection('replacement-connection') });
    const day = initial.plan!.days.find(day => day.date === '2026-11-03')!;
    held.resolve({ ok: true, state: { schemaVersion: 7, revision: 2, planRevision: 2, connection: connection() }, preflight: { date: day.date, checked: true, netMinutes: day.netMinutes!, saved: false, serverValidated: false } });
    await settleStartup();
    expect(document.getElementById('draft-check-result')?.hidden).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(button('scan').disabled).toBe(false);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it.each(['wrong-date', 'wrong-net', 'unchecked', 'server-validated', 'saved', 'missing-state', 'unchanged-state'] as const)('rejects a malformed successful draft-check response with %s', async malformed => {
    const initial = reviewedState();
    const day = initial.plan!.days.find(day => day.date === '2026-11-03')!;
    const preflight = { date: malformed === 'wrong-date' ? '2026-11-04' : day.date, checked: malformed !== 'unchecked', netMinutes: day.netMinutes! + (malformed === 'wrong-net' ? 1 : 0), saved: malformed === 'saved', serverValidated: malformed === 'server-validated' } as PreflightResult;
    const terminal = { ...initial, revision: 2, planRevision: 2, snapshot: undefined, plan: undefined };
    const chrome = mockChrome({ state: initial, onMessage: async message => message.type === 'PANEL_PREFLIGHT'
      ? { ok: true, ...(malformed === 'missing-state' ? {} : { state: malformed === 'unchanged-state' ? initial : terminal }), preflight }
      : undefined });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('apply').click(); button('check-draft').click();
    await vi.waitFor(() => expect(document.getElementById('main-error')!.textContent).toContain('kein eindeutiges Ergebnis'));
    expect(document.getElementById('draft-check-result')?.hidden).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(button('scan').disabled).toBe(false);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });
});

function checkpointState(checkpointId = 'checkpoint-one'): SessionState {
  const scanned = snapshot('api-session');
  const plan = buildMonthPlan(settings, scanned, {}, 123);
  const now = '2026-11-02T10:00:00Z';
  return { schemaVersion: 7, revision: 2, planRevision: 1, connection: connection(), snapshot: scanned, plan,
    job: { id: 'paused-job', kind: 'apply', status: 'paused', connectionId: 'test-connection', checkpointId, month: settings.month, startedAt: now, updatedAt: now },
    run: { runId: 'paused-job', planId: plan.id, status: 'paused', executionProfile: 'strict', executionFingerprint: executionFingerprint({ executionProfile: 'strict', checkpointDates: ['2026-11-02', '2026-11-03'] }), checkpointDate: '2026-11-02', startedAt: now, updatedAt: now,
      results: plan.days.map(day => ({ date: day.date, status: day.date === '2026-11-02' ? 'verified' : day.eligible ? 'pending' : 'skipped', message: day.date === '2026-11-02' ? 'Saved and verified' : 'Pending' })) } };
}

describe('compact monthly flow and verification checkpoints', () => {
  it.each([false, true])('polls the worker journal after an early ACK when terminal storage publication fails (alreadyVerified=%s)', async alreadyVerified => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const initial = checkpointState(); delete initial.job; delete initial.run;
    const active = checkpointState(); active.revision = 3; active.job!.status = 'running'; active.run!.status = 'running';
    active.run!.results.find(result => result.date === '2026-11-02')!.status = 'running';
    let rpcState = structuredClone(initial);
    const chrome = mockChrome({ state: initial, onMessage: async command => {
      if (command.type === 'PANEL_GET_STATE') return { ok: true, state: structuredClone(rpcState) };
      if (command.type === 'PANEL_APPLY') { rpcState = structuredClone(active); return { ok: true, state: structuredClone(active) }; }
    } });
    await mount(); await vi.advanceTimersByTimeAsync(0);
    expect(button('apply').disabled).toBe(false); button('apply').click();
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change')); button('confirm-apply').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button('scan').disabled).toBe(true); expect(button('cancel-run').hidden).toBe(false);
    const failed = structuredClone(active); failed.revision = 4; failed.planRevision = 2; failed.job = undefined; failed.snapshot = undefined; failed.plan!.canReview = false; failed.run!.status = 'failed';
    failed.error = 'Local journal could not be saved. Read the month again.';
    const first = failed.run!.results.find(result => result.date === '2026-11-02')!;
    first.status = alreadyVerified ? 'verified' : 'pending'; first.message = alreadyVerified ? 'Saved and verified before journal failure.' : 'Not written: initial journal failed.';
    rpcState = failed; // Deliberately no chrome.storage.onChanged notification.
    const gets = () => chrome.sendMessage.mock.calls.filter(([command]) => command.type === 'PANEL_GET_STATE').length;
    expect(gets()).toBe(1); await vi.advanceTimersByTimeAsync(4999); expect(gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gets()).toBe(2); expect(document.getElementById('main-error')?.textContent).toBe(failed.error);
    expect(document.getElementById('run-status')?.textContent).toContain(`Lauf mit Fehler angehalten · ${alreadyVerified ? 1 : 0} von 21 Tagen verifiziert`);
    expect(document.getElementById('run-status')?.textContent).not.toContain('Lauf abgeschlossen');
    expect(document.querySelector(`[data-status="${alreadyVerified ? 'verified' : 'pending'}"]`)?.textContent).toContain(first.message);
    expect(button('cancel-run').hidden).toBe(true); expect(button('scan').disabled).toBe(false); expect(button('apply').disabled).toBe(true);
    expect((document.getElementById('settings-fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000); expect(gets()).toBe(2);
    expect(chrome.sendMessage.mock.calls.filter(([command]) => command.type === 'PANEL_APPLY')).toHaveLength(1);
    expect(chrome.sendMessage.mock.calls.every(([command]) => ['PANEL_GET_STATE', 'PANEL_APPLY'].includes(command.type))).toBe(true);
  });

  it('bounds polling to one in-flight read and stops when hidden or closed, then reads immediately when shown', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let visibility: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const active = checkpointState(); active.job!.status = 'running'; active.run!.status = 'running';
    const held = deferred<Reply>(); let gets = 0;
    const chrome = mockChrome({ state: active, onMessage: async command => {
      if (command.type === 'PANEL_GET_STATE' && ++gets === 2) return held.promise;
    } });
    await mount(); await vi.advanceTimersByTimeAsync(0); expect(gets).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); expect(gets).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000); expect(gets).toBe(2);
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    held.resolve({ ok: true, state: active }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000); expect(gets).toBe(2);
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); expect(gets).toBe(3);
    window.dispatchEvent(new Event('pagehide')); await vi.advanceTimersByTimeAsync(15_000); expect(gets).toBe(3);
    expect(chrome.sendMessage.mock.calls.every(([command]) => command.type === 'PANEL_GET_STATE')).toBe(true);
  });

  it('keeps an active booking locked if a status poll fails and stops polling at a later canonical pause', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const active = checkpointState(); active.job!.status = 'running'; active.run!.status = 'running'; let gets = 0;
    const paused = checkpointState('later-checkpoint'); paused.revision = 4;
    mockChrome({ state: active, onMessage: async command => {
      if (command.type !== 'PANEL_GET_STATE') return;
      if (++gets === 2) throw new Error('Worker status temporarily unavailable');
      if (gets >= 3) return { ok: true, state: structuredClone(paused) };
    } });
    await mount(); await vi.advanceTimersByTimeAsync(5000);
    expect(gets).toBe(2); expect(document.getElementById('main-error')?.textContent).toContain('Buchungsstatus konnte nicht gelesen werden');
    expect(button('scan').disabled).toBe(true); expect(button('apply').disabled).toBe(true); expect(button('cancel-run').hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); expect(gets).toBe(3);
    expect(document.getElementById('paused-card')?.hidden).toBe(false); expect(document.getElementById('main-error')?.hidden).toBe(true);
    expect(button('continue-run').disabled).toBe(false); expect(button('scan').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); expect(gets).toBe(3);
  });

  it.each([false, true])('keeps controls locked after an early booking acknowledgement until canonical storage completion (continue=%s)', async resume => {
    const initial = checkpointState();
    if (!resume) { delete initial.job; delete initial.run; }
    const running = checkpointState(); running.revision = 3; running.job!.status = 'running'; running.run!.status = 'running';
    if (!resume) for (const result of running.run!.results) if (result.status === 'verified') result.status = 'pending';
    const commandType = resume ? 'PANEL_CONTINUE' : 'PANEL_APPLY';
    const chrome = mockChrome({ state: initial, onMessage: async command => {
      if (command.type === commandType) { chrome.emit(running); return { ok: true, state: structuredClone(running) }; }
    } });
    await mount();
    await vi.waitFor(() => expect(button(resume ? 'continue-run' : 'apply').disabled).toBe(false));
    button(resume ? 'continue-run' : 'apply').click();
    await vi.waitFor(() => expect(dialog('apply-dialog').open).toBe(true));
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change'));
    button('confirm-apply').click();
    await vi.waitFor(() => expect(button('apply').textContent).toBe('Bitte warten …'));
    await settleStartup();
    expect(dialog('apply-dialog').open).toBe(false);
    expect(button('scan').disabled).toBe(true); expect(button('disconnect').disabled).toBe(true); expect(button('export-plan').disabled).toBe(true);
    expect((document.getElementById('settings-fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(button('cancel-run').hidden).toBe(false); expect(button('cancel-run').disabled).toBe(false);
    expect(document.getElementById('run-status')?.textContent).toContain('Buchungen laufen');
    expect(document.getElementById('run-status')?.textContent).not.toContain('Lauf abgeschlossen');
    expect(chrome.sendMessage.mock.calls.filter(([message]) => message.type === commandType)).toHaveLength(1);
    if (resume) {
      const paused = checkpointState('checkpoint-next'); paused.revision = 4; paused.run!.checkpointDate = '2026-11-03';
      paused.run!.results.find(result => result.date === '2026-11-03')!.status = 'verified';
      chrome.emit(paused);
      await vi.waitFor(() => expect(button('continue-run').disabled).toBe(false)); button('continue-run').click();
      await vi.waitFor(() => expect(dialog('apply-dialog').open).toBe(true));
      expect(field('account-confirmation').checked).toBe(false); expect(button('confirm-apply').disabled).toBe(true);
      expect(document.getElementById('apply-details')?.textContent).toContain('Bereits gespeichert und geprüft2');
    } else {
      const failed = structuredClone(running); failed.revision = 4; failed.job = undefined; failed.snapshot = undefined; failed.plan!.canReview = false;
      failed.run!.status = 'failed'; failed.run!.results.find(result => result.date === '2026-11-02')!.status = 'uncertain';
      failed.error = 'Readback failed after the acknowledged write.'; chrome.emit(failed);
      await vi.waitFor(() => expect(document.getElementById('main-error')?.textContent).toBe(failed.error));
      expect(document.getElementById('run-uncertain')?.hidden).toBe(false); expect(button('cancel-run').hidden).toBe(true);
      expect(button('scan').disabled).toBe(false); expect(button('apply').disabled).toBe(true);
    }
  });

  it('ignores an older early acknowledgement after newer completion storage arrived', async () => {
    const initial = checkpointState(); delete initial.job; delete initial.run;
    const reply = deferred<Reply>();
    const chrome = mockChrome({ state: initial, onMessage: async command => command.type === 'PANEL_APPLY' ? reply.promise : undefined });
    await mount(); await vi.waitFor(() => expect(button('apply').disabled).toBe(false)); button('apply').click();
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change')); button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([command]) => command.type === 'PANEL_APPLY')).toBe(true));
    const active = checkpointState(); active.revision = 3; active.job!.status = 'running'; active.run!.status = 'running'; chrome.emit(active);
    const completed = structuredClone(active); completed.revision = 4; completed.planRevision = 2; completed.job = undefined; completed.snapshot = undefined; completed.plan!.canReview = false;
    completed.run!.status = 'complete'; for (const result of completed.run!.results) if (result.status !== 'skipped') result.status = 'verified'; chrome.emit(completed);
    reply.resolve({ ok: true, state: active });
    await vi.waitFor(() => expect(button('cancel-run').hidden).toBe(true));
    expect(document.getElementById('run-status')?.textContent).toContain('Lauf abgeschlossen · 21 von 21 Tagen verifiziert');
    expect(button('scan').disabled).toBe(false); expect(button('apply').disabled).toBe(true);
    expect(chrome.sendMessage.mock.calls.filter(([command]) => command.type === 'PANEL_APPLY')).toHaveLength(1);
  });

  it('distinguishes an uncertain saved outcome from remaining days never attempted', async () => {
    const initial = checkpointState(); initial.run!.status = 'failed'; initial.job = undefined; initial.snapshot = undefined; initial.plan!.canReview = false;
    const first = initial.run!.results.find(result => result.date === '2026-11-02')!;
    first.status = 'uncertain'; first.message = 'Saved entries could not be verified: unexpected metadata.';
    const next = initial.run!.results.find(result => result.date === '2026-11-03')!; next.message = 'Keine Änderung.';
    const before = structuredClone(initial); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(document.getElementById('run-uncertain')?.hidden).toBe(false));
    expect(document.getElementById('run-uncertain')?.textContent).toContain('können bereits in HiBob gespeichert sein');
    expect(document.getElementById('run-status')?.textContent).toContain('0 von 21 Tagen verifiziert');
    expect(document.getElementById('run-details-view')!.hidden).toBe(true);
    button('run-details').click();
    expect(document.getElementById('run-details-view')!.hidden).toBe(false);
    expect(document.querySelector('[data-status="uncertain"] .run-outcome')?.textContent).toBe('Speicherstatus unklar');
    expect(document.querySelector('[data-status="uncertain"]')?.textContent).toContain(first.message);
    expect(document.querySelector('[data-status="pending"]')?.textContent).toContain('Noch nicht ausgeführt');
    expect(document.querySelector('[data-status="pending"]')?.textContent).not.toContain('Keine Änderung.');
    expect(chrome.state.run).toEqual(before.run);
    expect(chrome.sendMessage.mock.calls.every(([message]) => message.type === 'PANEL_GET_STATE')).toBe(true);
    expect(chrome.setSettings).not.toHaveBeenCalled();
  });

  it.each([false, true])('downloads a private context-free review without changing the plan or consent (paused=%s)', async paused => {
    const initial = paused ? checkpointState() : reviewedState('api-session');
    const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(button('export-plan').disabled).toBe(false));
    const blobs: NodeBlob[] = []; const filenames: string[] = [];
    vi.stubGlobal('Blob', NodeBlob);
    const NativeUrl = URL;
    vi.stubGlobal('URL', class extends NativeUrl { static createObjectURL(blob: Blob | MediaSource) { blobs.push(blob as unknown as NodeBlob); return 'blob:local-review'; } static revokeObjectURL() {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { filenames.push(this.download); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    if (!paused) { button('apply').click(); field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change')); }
    const before = structuredClone(chrome.state); const calls = chrome.sendMessage.mock.calls.length;
    button('export-plan').click();
    const exported = JSON.parse(await blobs[0].text());
    expect(filenames).toEqual(['hibob-booking-plan-2026-11.json']);
    expect(exported).toMatchObject({ format: 'hibob-attendance-review', version: 1, planRevision: initial.planRevision });
    expect(exported.plan.snapshot.context).toBeUndefined();
    expect(JSON.stringify(exported)).not.toMatch(/test-employee|test-company|test-connection|connectionId|employeeKey|tenantKey/);
    expect(exported.plan.days.find((day: { date: string }) => day.date === '2026-11-03').proposed).toHaveLength(3);
    expect(exported.plan.seed).toBe(initial.plan!.seed);
    expect(exported.run).toEqual(paused ? initial.run : undefined);
    expect(chrome.state).toEqual(before); expect(chrome.sendMessage.mock.calls).toHaveLength(calls); expect(chrome.setSettings).not.toHaveBeenCalled();
    if (!paused) { expect(dialog('apply-dialog').open).toBe(true); expect(field('account-confirmation').checked).toBe(true); }
    vi.runAllTimers(); vi.useRealTimers();
  });

  it('refuses a forced download click while the current operation is busy', async () => {
    const initial = reviewedState('api-session'); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(button('export-plan').disabled).toBe(false));
    chrome.emit({ ...initial, revision: 3, job: { id: 'busy', kind: 'apply', status: 'running', connectionId: 'test-connection', month: settings.month, startedAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z' } });
    expect(button('export-plan').disabled).toBe(true);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const before = structuredClone(chrome.state); const calls = chrome.sendMessage.mock.calls.length;
    button('export-plan').dispatchEvent(new Event('click'));
    expect(clicked).not.toHaveBeenCalled(); expect(chrome.state).toEqual(before); expect(chrome.sendMessage.mock.calls).toHaveLength(calls); expect(chrome.setSettings).not.toHaveBeenCalled();
  });

  it('opens configuration and details without changing settings, plan or allocation', async () => {
    const initial = reviewedState('api-session'); const chrome = mockChrome({ state: initial });
    await mount(); await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(document.getElementById('settings-view')?.hidden).toBe(true);
    expect(button('schedule-summary').textContent).toContain('08:00–16:30');
    const before = structuredClone(chrome.state.plan);
    button('settings-toggle').click();
    expect(document.getElementById('settings-view')?.hidden).toBe(false);
    expect(document.getElementById('month-view')!.hidden).toBe(true);
    button('settings-back').click();
    expect(document.getElementById('settings-view')?.hidden).toBe(true);
    button('calendar-2026-11-03').click();
    expect(document.getElementById('day-view')!.hidden).toBe(false);
    button('day-back').click();
    button('settings-toggle').click();
    button('booking-options-link').click();
    button('tools-back').click();
    button('settings-back').click();
    expect(chrome.state.plan).toEqual(before);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(chrome.sendMessage.mock.calls.every(([message]) => message.type === 'PANEL_GET_STATE')).toBe(true);
  });

  it('reveals and focuses an invalid collapsed setting before any month read', async () => {
    const chrome = mockChrome({ state: { connection: connection() } });
    await mount(); await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    change('start', '');
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    button('scan').click();
    expect(document.getElementById('settings-view')?.hidden).toBe(false);
    expect(document.activeElement).toBe(field('start'));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_SCAN')).toBe(false);
  });

  it('applies flat booking-tool exclusions once and keeps them locked during a run', async () => {
    const chrome = mockChrome({ state: reviewedState('api-session') });
    await mount(); await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('settings-toggle').click(); button('booking-options-link').click();
    const exclusions = document.getElementById('excludedDates') as HTMLTextAreaElement;
    expect(document.getElementById('booking-options')!.contains(exclusions)).toBe(true);
    expect(exclusions.form?.id).toBe('settings-form');
    const before = chrome.state.planRevision!;
    change('excludedDates', '2026-11-03');
    await vi.waitFor(() => expect(chrome.state.plan?.settings.excludedDates).toEqual(['2026-11-03']));
    expect(chrome.state.planRevision).toBe(before + 1);
    expect(chrome.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_INVALIDATE_PLAN')).toHaveLength(1);
    expect(chrome.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_SAVE_PLAN')).toHaveLength(1);
    expect(chrome.state.plan!.days.find(day => day.date === '2026-11-03')!.action).toBe('skip');
    expect(chrome.state.plan!.weeks.find(week => week.week === '2026-11-02')!.targetMinutes).toBe(1920);
    const current = structuredClone(chrome.state);
    chrome.emit({ ...current, revision: current.revision! + 1, job: { id: 'running-job', kind: 'apply', status: 'running', connectionId: 'test-connection', month: settings.month, startedAt: 'now', updatedAt: 'now' } });
    expect(exclusions.disabled).toBe(true);
    change('excludedDates', '2026-11-04');
    expect(chrome.state.plan!.settings.excludedDates).toEqual(['2026-11-03']);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it('keeps automatic skipped dates unchecked while progress disables every control', async () => {
    const initial = reviewedState('api-session'); const chrome = mockChrome({ state: initial });
    await mount(); await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    button('calendar-2026-11-07').click();
    expect(field('include-2026-11-07').checked).toBe(false);
    chrome.emit({ ...initial, revision: 3, job: { id: 'running-job', kind: 'apply', status: 'running', connectionId: 'test-connection', month: settings.month, startedAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z' } });
    button('calendar-2026-11-07').click();
    expect(field('include-2026-11-07').checked).toBe(false);
    expect(field('include-2026-11-07').disabled).toBe(true);
    button('calendar-2026-11-03').click();
    expect(field('include-2026-11-03').checked).toBe(true);
    expect(field('include-2026-11-03').disabled).toBe(true);
  });

  it('lets an explicitly selected unreadable workday be excluded without silently dropping its target', async () => {
    const scanned = snapshot('api-session'); const broken = scanned.days.find(day => day.date === '2026-11-03')!;
    broken.editable = false; broken.unsupportedReason = 'Unsupported local fixture entry';
    const initial: SessionState = { schemaVersion: 7, revision: 1, planRevision: 1, connection: connection(), snapshot: scanned, plan: buildMonthPlan(settings, scanned, {}, 123) };
    const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(document.querySelector('[data-date="2026-11-03"]')).not.toBeNull());
    button('calendar-2026-11-03').click();
    expect(field('include-2026-11-03').checked).toBe(true);
    expect(field('include-2026-11-03').disabled).toBe(false);
    expect(chrome.state.plan!.weeks.find(week => week.week === '2026-11-02')!.targetMinutes).toBe(2400);
    field('include-2026-11-03').click();
    await vi.waitFor(() => expect(chrome.state.plan!.days.find(day => day.date === '2026-11-03')!.action).toBe('skip'));
    expect(chrome.state.plan!.settings.excludedDates).toContain('2026-11-03');
    expect(chrome.state.plan!.weeks.find(week => week.week === '2026-11-02')!.targetMinutes).toBe(1920);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it('keeps verification pauses transient and binds initial options to the reviewed dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    const initial = checkpointState(); delete initial.job; delete initial.run;
    const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false)); button('apply').click();
    expect(field('pause-verification').checked).toBe(false);
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change'));
    field('pause-verification').checked = true; field('pause-verification').dispatchEvent(new Event('change'));
    expect(field('account-confirmation').checked).toBe(false);
    expect(button('confirm-apply').disabled).toBe(true);
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change'));
    button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(true));
    const command = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_APPLY')![0];
    expect(command.options).toEqual({ executionProfile: 'strict', checkpointDates: ['2026-11-02', '2026-11-03'] });
    expect(command.confirmation?.checkpointId).toBeUndefined();
    expect(field('pause-verification').checked).toBe(false);
    expect(chrome.setSettings).not.toHaveBeenCalled(); vi.useRealTimers();
  });

  it('requires new checkpoint-bound consent to continue only the remaining frozen days', async () => {
    const initial = checkpointState(); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(document.getElementById('paused-card')?.hidden).toBe(false));
    expect(button('apply').hidden).toBe(true);
    expect(document.getElementById('preview-summary')?.textContent).toContain('21 berücksichtigte Tage');
    expect((document.getElementById('settings-fieldset') as HTMLFieldSetElement).disabled).toBe(true); expect(button('scan').disabled).toBe(true); expect(button('disconnect').disabled).toBe(true);
    button('calendar-2026-11-07').click();
    expect(field('include-2026-11-07').checked).toBe(false);
    button('continue-run').click(); await vi.waitFor(() => expect(dialog('apply-dialog').open).toBe(true));
    expect(field('account-confirmation').checked).toBe(false); expect(button('confirm-apply').disabled).toBe(true);
    expect(button('confirm-apply').textContent).toContain('20');
    expect(document.getElementById('apply-details')?.textContent).toContain('Bereits gespeichert und geprüft1');
    button('confirm-apply').dispatchEvent(new Event('click'));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_CONTINUE')).toBe(false);
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change'));
    button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_CONTINUE')).toBe(true));
    const command = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_CONTINUE')![0];
    expect(command).toMatchObject({ jobId: 'paused-job', planId: initial.plan!.id, expectedPlanRevision: 1, confirmation: { confirmed: true, checkpointId: 'checkpoint-one' } });
    expect(chrome.state.plan).toEqual(initial.plan);
    expect(chrome.sendMessage.mock.calls.some(([message]) => ['PANEL_APPLY', 'PANEL_SCAN', 'PANEL_SAVE_PLAN'].includes(message.type))).toBe(false);
  });

  it('closes an old pause confirmation when only the checkpoint nonce changes', async () => {
    const initial = checkpointState(); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(button('continue-run').disabled).toBe(false)); button('continue-run').click();
    await vi.waitFor(() => expect(dialog('apply-dialog').open).toBe(true));
    field('account-confirmation').checked = true; field('account-confirmation').dispatchEvent(new Event('change'));
    const replacement = structuredClone(initial); replacement.job!.checkpointId = 'checkpoint-two';
    chrome.emit({ ...replacement, revision: 3, planRevision: 1 });
    expect(dialog('apply-dialog').open).toBe(false); expect(field('account-confirmation').checked).toBe(false);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_CONTINUE')).toBe(false);
  });
});

describe('monthly execution profiles and idempotent preview', () => {
  it('requires the exact canonical execution scope when resuming a checkpoint', async () => {
    const initial = checkpointState(); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(document.getElementById('paused-card')!.hidden).toBe(false));
    button('continue-run').click(); await vi.waitFor(() => expect(dialog('apply-dialog').open).toBe(true));
    field('account-confirmation').click(); button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_CONTINUE')).toBe(true));
    const sent = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_CONTINUE')![0];
    expect(sent.confirmation?.executionFingerprint).toBe(initial.run!.executionFingerprint);
    expect(JSON.parse(sent.confirmation!.executionFingerprint!).checkpointDates).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('blocks continuation if the canonical execution scope is missing', async () => {
    const missing = checkpointState(); delete missing.run!.executionFingerprint;
    const chrome = mockChrome({ state: missing }); await mount();
    await vi.waitFor(() => expect(document.getElementById('paused-card')!.hidden).toBe(false));
    button('continue-run').click();
    await vi.waitFor(() => expect(document.getElementById('main-error')!.textContent).toContain('Lauf stoppen'));
    expect(dialog('apply-dialog').open).toBe(false);
    expect(chrome.sendMessage.mock.calls.filter(([message]) => message.type === 'PANEL_CONTINUE')).toHaveLength(0);
  });

  it('defaults to fast serial and binds consent to the exact execution profile', async () => {
    const initial = reviewedState('api-session'); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(field('execution-profile').value).toBe('fast-serial');
    expect(document.getElementById('booking-options')!.contains(field('execution-profile'))).toBe(true);
    button('apply').click();
    expect(document.getElementById('execution-disclosure')!.textContent).toContain('keine gemeinsame Transaktion');
    field('account-confirmation').click();
    expect(button('confirm-apply').disabled).toBe(false);
    field('execution-profile').value = 'strict'; field('execution-profile').dispatchEvent(new Event('change'));
    expect(field('account-confirmation').checked).toBe(false); expect(button('confirm-apply').disabled).toBe(true);
    expect(document.getElementById('execution-consent-reset')!.textContent).toContain('erneut bestätigen');
    expect(document.getElementById('apply-execution-mode')!.textContent).toContain('Streng');
    field('account-confirmation').click(); button('confirm-apply').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(true));
    const sent = chrome.sendMessage.mock.calls.find(([message]) => message.type === 'PANEL_APPLY')![0];
    expect(sent.options).toEqual({ executionProfile: 'strict' });
    expect(sent.confirmation?.executionFingerprint).toBe(executionFingerprint(sent.options));
    expect(chrome.setSettings).not.toHaveBeenCalled();
  });

  it('rejects a silently changed profile even if the earlier account checkbox stays checked', async () => {
    const chrome = mockChrome({ state: reviewedState('api-session') }); await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false)); button('apply').click(); field('account-confirmation').click();
    field('execution-profile').value = 'strict';
    // No change event: the final action still compares the captured fingerprint.
    button('confirm-apply').dispatchEvent(new Event('click'));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it('shows no work needed and preserves compatible variable times across a repeated scan', async () => {
    const initial = matchingState(); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(document.getElementById('preview-summary')!.textContent).toContain('Alles passt'));
    expect(initial.plan!.days.filter(day => day.action === 'unchanged')).toHaveLength(21);
    expect(document.getElementById('conflicts')!.hidden).toBe(true); expect(button('apply').disabled).toBe(true);
    expect(button('apply').textContent).toBe('Keine Buchung nötig');
    expect(document.getElementById('calendar-2026-11-03')!.getAttribute('aria-label')).toContain('Bereits passend');
    button('refresh-month').click();
    await vi.waitFor(() => expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_SCAN')).toBe(true));
    await vi.waitFor(() => expect(chrome.state.plan?.days.filter(day => day.action === 'unchanged')).toHaveLength(21));
    expect(chrome.state.plan?.redistributeAll).toBeUndefined();
    expect(chrome.state.plan!.snapshot.days).toEqual(initial.snapshot!.days);
    expect(document.getElementById('conflicts')!.hidden).toBe(true);
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
  });

  it('redistributes compatible entries only through the explicit advanced action, then resets on a settings edit', async () => {
    const initial = matchingState(); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(document.getElementById('preview-summary')!.textContent).toContain('Alles passt'));
    expect(document.getElementById('booking-options')!.contains(button('redistribute'))).toBe(true);
    expect(button('redistribute').textContent).toBe('Alles neu verteilen'); button('redistribute').click();
    await vi.waitFor(() => expect(chrome.state.plan?.redistributeAll).toBe(true));
    expect(chrome.state.plan!.days.filter(day => day.action === 'conflict')).toHaveLength(21);
    expect(document.getElementById('conflicts')!.textContent).toContain('21 Buchungen prüfen');
    change('variationMinutes', '14');
    await vi.waitFor(() => expect(chrome.state.plan?.redistributeAll).toBeUndefined());
    expect(chrome.state.plan!.days.filter(day => day.action === 'unchanged')).toHaveLength(21);
  });

  it('does not count acknowledged days as verified and shows the actual duration above ten seconds', async () => {
    const initial = reviewedState('api-session'); const chrome = mockChrome({ state: initial }); await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    const base = { runId: 'stage-test', planId: initial.plan!.id, status: 'running' as const, executionProfile: 'fast-serial' as const, startedAt: '2026-11-02T08:00:00Z', updatedAt: '2026-11-02T08:00:01Z', results: [{ date: '2026-11-03', status: 'awaiting-verification' as const, message: 'Übertragen – Abschlussprüfung steht aus.' }] };
    chrome.emit({ ...initial, revision: 3, run: base, progress: { phase: 'apply', stage: 'verify', completed: 0, total: 1, message: 'Gesendete Buchungen unabhängig aus HiBob zurücklesen …' } });
    expect(document.getElementById('run-status')!.textContent).toContain('0 von 1');
    expect(document.getElementById('scan-progress')!.textContent).toContain('Kontrollieren');
    expect(document.querySelector('[data-status="awaiting-verification"]')!.textContent).toContain('Prüfung ausstehend');
    chrome.emit({ ...initial, revision: 4, run: { ...base, status: 'complete', results: [{ date: '2026-11-03', status: 'verified', message: 'Geprüft' }], timings: { preparationMs: 1000, writingMs: 10000, journalingMs: 50, verificationMs: 1295, totalMs: 12345, requests: 8, writes: 1 } } });
    expect(document.getElementById('run-timing')!.hidden).toBe(false);
    expect(document.getElementById('run-timing')!.textContent).toContain('12,3 s');
    expect(document.getElementById('run-status')!.textContent).toContain('1 von 1');
  });
});
