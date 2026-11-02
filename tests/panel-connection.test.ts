// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { BookingPlan, MonthSnapshot, PlanEditLease, SessionState, Settings } from '../src/shared/types';

const settings = defaultSettings('2026-11');
type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function snapshot(): MonthSnapshot {
  return {
    month: '2026-11', source: 'hibob', employeeLabel: 'Thorsten Test',
    periodLabel: '01/11/2026–30/11/2026 (Running)', scannedAt: '2026-11-02T08:30:00.000Z',
    context: { documentId: 'test-document', employeeKey: 'test-employee', tenantKey: 'test-tenant', verified: true },
    days: getMonthDates('2026-11').map(date => ({ date, editable: true, entries: [], fingerprint: `empty:${date}`, reportedMinutes: 0 })),
  };
}

function reviewedState(): SessionState {
  const scanned = snapshot();
  scanned.days.find(day => day.date === '2026-11-02')!.entries = [{ type: 'work', start: '08:00', end: '16:00' }];
  scanned.days.find(day => day.date === '2026-11-02')!.reportedMinutes = 480;
  const plan = buildMonthPlan(settings, scanned, { '2026-11-02': 'skip' }, 123);
  expect(plan.canApply).toBe(true);
  return { schemaVersion: 2, revision: 1, planRevision: 1, tabId: 9, snapshot: scanned, plan };
}

type Message = { type: string; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; plan?: BookingPlan; jobId?: string };
type Reply = { ok: boolean; state?: SessionState; error?: string };

function mockChrome(options: {
  state?: SessionState;
  getState?: () => Promise<SessionState>;
  getSettings?: () => Promise<{ settings?: Settings }>;
  setSettings?: (value: { settings: Settings }) => Promise<void>;
  onMessage?: (message: Message, state: SessionState) => Promise<Reply | undefined>;
} = {}) {
  const listeners = new Set<StorageListener>();
  let backend: SessionState = { schemaVersion: 2, revision: 0, planRevision: 0, ...structuredClone(options.state ?? {}) };
  const sendMessage = vi.fn(async (message: Message): Promise<Reply> => {
    const custom = await options.onMessage?.(message, structuredClone(backend));
    if (custom) return custom;
    if (message.type === 'PANEL_GET_STATE') return { ok: true, state: await (options.getState?.() ?? Promise.resolve(structuredClone(backend))) };
    if (message.type === 'PANEL_INVALIDATE_PLAN') {
      if (message.expectedPlanRevision !== backend.planRevision) return { ok: false, state: structuredClone(backend), error: 'Stale plan revision' };
      backend = { ...backend, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, plan: undefined };
      backend.editLease = { planRevision: backend.planRevision!, changeId: message.changeId! };
    }
    if (message.type === 'PANEL_SAVE_PLAN') {
      if (JSON.stringify(message.lease) !== JSON.stringify(backend.editLease)) return { ok: false, state: structuredClone(backend), error: 'Stale edit lease' };
      backend = { ...backend, revision: (backend.revision ?? 0) + 1, plan: structuredClone(message.plan) };
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
      backend = { schemaVersion: 2, revision: (backend.revision ?? 0) + 1, planRevision: (backend.planRevision ?? 0) + 1, ...structuredClone(state) };
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
  it('asks for a HiBob tab and disables scanning before any tab is bound', async () => {
    const chrome = mockChrome();
    await mount();
    await vi.waitFor(() => expect(title()).toBe('HiBob-Tab auswählen'));
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    button('scan').click();
    expect(chrome.sendMessage.mock.calls.some(([message]) => message.type === 'PANEL_SCAN')).toBe(false);
  });

  it('shows a selected tab before a month is read and enables only scanning', async () => {
    mockChrome({ state: { tabId: 9 } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('HiBob-Tab ausgewählt'));
    expect(button('scan').disabled).toBe(false);
    expect(button('apply').disabled).toBe(true);
    expect(document.getElementById('preview-empty')?.hidden).toBe(false);
  });

  it('shows employee, local scan time, and period only after a snapshot exists', async () => {
    mockChrome({ state: { tabId: 9, snapshot: snapshot() } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('Monat eingelesen'));
    expect(detail()).toContain('Thorsten Test');
    expect(detail()).toContain('Eingelesen: 09:30 Uhr');
    expect(detail()).toContain('01/11/2026–30/11/2026 (Running)');
    expect(button('scan').disabled).toBe(false);
  });

  it('receives tab binding while local settings are still loading', async () => {
    const loading = deferred<{ settings?: Settings }>();
    const chrome = mockChrome({ state: { tabId: 9 }, getSettings: () => loading.promise });
    await mount();
    expect(chrome.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.sendMessage).not.toHaveBeenCalled();
    chrome.emit({ tabId: 9 });
    expect(title()).toBe('HiBob-Tab ausgewählt');
    loading.resolve({ settings });
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    await settleStartup();
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(title()).toBe('HiBob-Tab ausgewählt');
  });

  it('does not let an older deferred GET_STATE erase a newer tab-binding event', async () => {
    const loading = deferred<SessionState>();
    const chrome = mockChrome({ getState: () => loading.promise });
    await mount();
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_GET_STATE' }));
    chrome.emit({ tabId: 9 });
    expect(title()).toBe('HiBob-Tab ausgewählt');
    loading.resolve({});
    // Flush the entire response/initialize microtask chain, rather than asserting an intermediate event render.
    await settleStartup();
    expect(title()).toBe('HiBob-Tab ausgewählt');
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
    await vi.waitFor(() => expect(title()).toBe('HiBob-Tab auswählen'));
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
    expect(title()).toBe('HiBob-Tab auswählen');
    expect(button('scan').disabled).toBe(true);
    expect(button('apply').disabled).toBe(true);
    expect(dialog('apply-dialog').open).toBe(false);
    expect(dialog('conflict-dialog').open).toBe(false);
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(0);
  });

  it('restores an existing cold binding when the side panel is reopened', async () => {
    mockChrome({ state: { tabId: 9 } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('HiBob-Tab ausgewählt'));
    // A new side-panel document has no prior listener or local module state.
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    const reopened = mockChrome({ state: { tabId: 9 } });
    await mount();
    await vi.waitFor(() => expect(title()).toBe('HiBob-Tab ausgewählt'));
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
    const state: SessionState = { schemaVersion: 2, revision: 2, planRevision: 2, tabId: 9,
      job: { id: `${kind}-job-7`, kind, status: 'running', tabId: 9, month: '2026-11', startedAt: '2026-11-02T09:00:00Z', updatedAt: '2026-11-02T09:00:01Z' },
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
    expect(title()).toBe('HiBob-Tab ausgewählt');
    expect(detail()).toContain('Dezember 2026');
    expect(document.querySelectorAll('#weeks article.day')).toHaveLength(0);
    expect(button('apply').disabled).toBe(true);
    await vi.waitFor(() => expect(button('scan').disabled).toBe(false));
    expect(button('scan').textContent).toBe('Monat einlesen');
  });

  it('creates a preview explicitly from a completed scan restored without a plan', async () => {
    const chrome = mockChrome({ state: { tabId: 9, snapshot: snapshot() } });
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
    const chrome = mockChrome({ state: { tabId: 9 }, getSettings: async () => {
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
    const chrome = mockChrome({ state: { tabId: 9 }, getSettings: async () => ({ settings: { ...settings, start: '09:00' } }), onMessage: async (message, state) => {
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
});
