// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, formatMinutes, getMonthDates } from '../src/domain/index';
import { contextFingerprint } from '../src/shared/context';
import type { AccountConfirmation, BookingPlan, PreflightResult, MonthSnapshot, PlanEditLease, SessionState, Settings } from '../src/shared/types';

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
  return { schemaVersion: 4, revision: 1, planRevision: 1, connection: connection(), snapshot: scanned, plan };
}

type Message = { type: string; date?: string; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; plan?: BookingPlan; jobId?: string; confirmation?: AccountConfirmation };
type Reply = { ok: boolean; state?: SessionState; error?: string; preflight?: PreflightResult };

function mockChrome(options: {
  state?: SessionState;
  getState?: () => Promise<SessionState>;
  getSettings?: () => Promise<{ settings?: Settings }>;
  setSettings?: (value: { settings: Settings }) => Promise<void>;
  onMessage?: (message: Message, state: SessionState) => Promise<Reply | undefined>;
} = {}) {
  const listeners = new Set<StorageListener>();
  let backend: SessionState = { schemaVersion: 4, revision: 0, planRevision: 0, ...structuredClone(options.state ?? {}) };
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
      backend = { schemaVersion: 4, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, ...structuredClone(state) };
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
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbunden'));
    expect(detail()).toContain('Thorsten Test · Test Company');
    expect(detail()).toContain('Direkte API-Verbindung');
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
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbunden'));
    expect(button('scan').disabled).toBe(false);
    expect(button('apply').disabled).toBe(true);
    expect(document.getElementById('preview-empty')?.hidden).toBe(false);
  });

  it('shows employee, local scan time, and period only after a snapshot exists', async () => {
    mockChrome({ state: { connection: connection(), snapshot: snapshot() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Monat eingelesen'));
    expect(detail()).toContain('Thorsten Test');
    expect(detail()).toContain('Eingelesen: 09:30 Uhr');
    expect(detail()).toContain('01/11/2026–30/11/2026 (Running)');
    expect(button('scan').disabled).toBe(false);
  });

  it('receives tab binding while local settings are still loading', async () => {
    const loading = deferred<{ settings?: Settings }>();
    const chrome = mockChrome({ state: { connection: connection() }, getSettings: () => loading.promise });
    await mount();
    expect(chrome.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.sendMessage).not.toHaveBeenCalled();
    chrome.emit({ connection: connection() });
    expect(title()).toBe('Mit HiBob verbunden');
    loading.resolve({ settings });
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    await settleStartup();
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(title()).toBe('Mit HiBob verbunden');
  });

  it('does not let an older deferred GET_STATE erase a newer tab-binding event', async () => {
    const loading = deferred<SessionState>();
    const chrome = mockChrome({ getState: () => loading.promise });
    await mount();
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    chrome.emit({ connection: connection() });
    expect(title()).toBe('Mit HiBob verbunden');
    loading.resolve({});
    // Flush the entire response/initialize microtask chain, rather than asserting an intermediate event render.
    await settleStartup();
    expect(title()).toBe('Mit HiBob verbunden');
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
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(0);
  });

  it.each(['apply', 'conflicts'])('clears a reviewed plan and open %s dialog when the tab binding resets', async (control) => {
    const chrome = mockChrome({ state: reviewedState() });
    await mount();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(30);
    button(control).click();
    expect(dialog(control === 'apply' ? 'apply-dialog' : 'conflict-dialog').open).toBe(true);
    chrome.emit({});
    expect(title()).toBe('Mit HiBob verbinden');
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(dialog('apply-dialog').open).toBe(false);
    expect(dialog('conflict-dialog').open).toBe(false);
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(0);
  });

  it('restores an existing cold binding when the side panel is reopened', async () => {
    mockChrome({ state: { connection: connection() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbunden'));
    // A new side-panel document has no prior listener or local module state.
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    const reopened = mockChrome({ state: { connection: connection() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Mit HiBob verbunden'));
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
    const state: SessionState = { schemaVersion: 4, revision: 2, planRevision: 2, connection: connection(),
      job: { id: `${kind}-job-7`, kind, status: 'running', connectionId: 'test-connection', month: '2026-11', startedAt: '2026-11-02T09:00:00Z', updatedAt: '2026-11-02T09:00:01Z' },
      progress: { phase: kind, completed: 7, total: 30, message: 'Local job fixture' } };
    const chrome = mockChrome({ state });
    await mount();
    await vi.waitFor(() => expect(button('cancel-run').hidden).toBe(false));
    if (kind === 'scan') expect(button('scan').textContent).toBe('Monat wird eingelesen …');
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
    expect(title()).toBe('Mit HiBob verbunden');
    expect(detail()).toContain('Dezember 2026');
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(0);
    expect(button('apply').disabled).toBe(true);
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(button('scan').textContent).toBe('Monat einlesen');
  });

  it('creates a preview explicitly from a completed scan restored without a plan', async () => {
    const chrome = mockChrome({ state: { connection: connection(), snapshot: snapshot() } });
    await mount();
    await vi.waitFor(() => expect(button('build-preview').hidden).toBe(false));
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_INVALIDATE_PLAN')).toBe(false);
    button('build-preview').click();
    await vi.waitFor(() => expect(button('apply').disabled).toBe(false));
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(30);
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
    expect(document.getElementById('account-context-notice')?.hidden).toBe(false);
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
    expect(sent.confirmation).toEqual({ planId: initial.plan!.id, planRevision: 1, contextFingerprint: contextFingerprint(initial.snapshot!.context), confirmed: true });
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
    expect(checked[0][0]).toMatchObject({ date: '2026-11-04', plan: initial.plan, expectedPlanRevision: 1, confirmation: { planId: initial.plan.id, planRevision: 1, contextFingerprint: contextFingerprint(initial.snapshot!.context), confirmed: true } });
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_APPLY')).toBe(false);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(field('variationMinutes').value).toBe('15');
    expect((document.getElementById('excludedDates') as HTMLTextAreaElement).value).toBe('2026-11-02');
    const checkedDay = initial.plan.days.find(day => day.date === '2026-11-04')!;
    const resultText = document.getElementById('draft-check-result')!.textContent!;
    expect(resultText).toContain('nicht gespeichert');
    expect(resultText).toContain('Speicherung wurde nicht getestet');
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
    chrome.emit({ schemaVersion: 4, revision: 10, planRevision: 10, connection: connection('replacement-connection') });
    const day = initial.plan!.days.find(day => day.date === '2026-11-03')!;
    held.resolve({ ok: true, state: { schemaVersion: 4, revision: 2, planRevision: 2, connection: connection() }, preflight: { date: day.date, checked: true, netMinutes: day.netMinutes!, saved: false, serverValidated: false } });
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
