// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { MonthSnapshot, SessionState, Settings } from '../src/shared/types';

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
    days: getMonthDates('2026-11').map(date => ({ date, editable: true, entries: [], fingerprint: `empty:${date}` })),
  };
}

function reviewedState(): SessionState {
  const scanned = snapshot();
  scanned.days.find(day => day.date === '2026-11-02')!.entries = [{ type: 'work', start: '08:00', end: '16:00' }];
  const plan = buildMonthPlan(settings, scanned, { '2026-11-02': 'skip' }, 123);
  expect(plan.canApply).toBe(true);
  return { tabId: 9, snapshot: scanned, plan };
}

function mockChrome(options: {
  state?: SessionState;
  getState?: () => Promise<SessionState>;
  getSettings?: () => Promise<{ settings?: Settings }>;
} = {}) {
  const listeners = new Set<StorageListener>();
  const backend = options.state ?? {};
  const sendMessage = vi.fn(async (message: { type: string }) => {
    if (message.type === 'PANEL_GET_STATE') return { ok: true, state: await (options.getState?.() ?? Promise.resolve(backend)) };
    return { ok: true, state: backend };
  });
  const addListener = vi.fn((listener: StorageListener) => listeners.add(listener));
  vi.stubGlobal('chrome', {
    runtime: { id: 'hibob-panel-test', sendMessage },
    storage: {
      local: {
        get: vi.fn(() => options.getSettings?.() ?? Promise.resolve({ settings })),
        set: vi.fn(async () => {}),
      },
      onChanged: {
        addListener,
        removeListener: vi.fn((listener: StorageListener) => listeners.delete(listener)),
      },
    },
  });
  return {
    sendMessage, addListener,
    emit(state: SessionState) {
      for (const listener of listeners) listener({ sessionState: { newValue: structuredClone(state) } }, 'session');
    },
  };
}

const title = () => document.getElementById('connection-title')?.textContent;
const detail = () => document.getElementById('connection-detail')?.textContent;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const dialog = (id: string) => document.getElementById(id) as HTMLDialogElement;
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
});
