import { afterEach, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { MonthSnapshot, SessionState } from '../src/shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('unbinds and discards the preview when opened outside HiBob without scanning automatically', async () => {
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Test', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02', context: { documentId: 'doc-review', employeeKey: 'employee-review', tenantKey: 'tenant-review', verified: true }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  let stored: SessionState = { tabId: 9, snapshot, plan: buildMonthPlan(defaultSettings('2026-11'), snapshot, {}, 1) };
  let clicked!: (tab: { id?: number; windowId: number; url?: string }) => void;
  const sendMessage = vi.fn();
  const executeScript = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: async () => {} },
    action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: () => {} } },
    tabs: { sendMessage }, scripting: { executeScript },
  });
  await import('../src/background');
  clicked({ id: 12, windowId: 1, url: 'https://example.org/' });
  await vi.waitFor(() => expect(stored.tabId).toBeUndefined());
  expect(stored.snapshot).toBeUndefined();
  expect(stored.plan).toBeUndefined();
  expect(stored.error).toContain('HiBob öffnen');
  clicked({ id: 13, windowId: 1, url: 'https://app.hibob.com/attendance/my-attendance' });
  await vi.waitFor(() => expect(stored.tabId).toBe(13));
  expect(stored.snapshot).toBeUndefined();
  expect(stored.error).toBeUndefined();
  clicked({ id: 14, windowId: 1, url: 'https://app.hibob.com/home' });
  await vi.waitFor(() => expect(stored.tabId).toBe(14));
  clicked({ windowId: 1 });
  await vi.waitFor(() => expect(stored.tabId).toBeUndefined());
  expect(sendMessage).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
});

it('cancels a pending transport preparation before APPLY_DAY is dispatched', async () => {
  let stored: SessionState = {};
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  let clicked!: (tab: { id: number; windowId: number; url: string }) => void;
  let holdPing = false;
  let entered!: () => void;
  let release!: () => void;
  const pingEntered = new Promise<void>(resolve => { entered = resolve; });
  const writes: unknown[] = [];
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Test', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02', context: { documentId: 'doc-review', employeeKey: 'employee-review', tenantKey: 'tenant-review', verified: true }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: async () => {} },
    action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: {
      get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }),
      sendMessage: async (_tabId: number, message: { type: string }) => {
        if (message.type === 'PING' && holdPing) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
        if (message.type === 'SCAN_MONTH') return { ok: true, snapshot };
        if (message.type === 'APPLY_DAY') writes.push(message);
        return { ok: true, protocolVersion: 2 };
      },
    },
    scripting: { executeScript: async () => {} },
  });
  await import('../src/background');
  clicked({ id: 9, windowId: 1, url: 'https://app.hibob.com/attendance/my-attendance' });
  await vi.waitFor(() => expect(stored.tabId).toBe(9));
  const rpc = (message: object, sender: object = { id: 'test', url: 'chrome-extension://test/sidepanel.html' }) => new Promise<{ ok: boolean; state?: SessionState; error?: string }>(resolve => { receiver(message, sender, resolve); });
  expect((await rpc({ type: 'PANEL_GET_STATE' }, { id: 'test', tab: { id: 9 }, url: 'https://app.hibob.com/attendance/my-attendance' })).ok).toBe(false);
  expect((await rpc({ type: 'PANEL_SCAN', month: '2026-11' })).ok).toBe(true);
  const preview = buildMonthPlan(defaultSettings('2026-11'), snapshot, {}, 2);
  const invalidated = await rpc({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: stored.planRevision, changeId: 'review-edit' });
  const saved = await rpc({ type: 'PANEL_SAVE_PLAN', plan: preview, lease: invalidated.state!.editLease });
  expect(saved.ok).toBe(true);
  holdPing = true;
  const applying = rpc({ type: 'PANEL_APPLY', plan: saved.state!.plan, expectedPlanRevision: saved.state!.planRevision });
  await pingEntered;
  expect((await rpc({ type: 'PANEL_CANCEL', jobId: stored.job!.id })).ok).toBe(true);
  release();
  await applying;
  expect(writes).toEqual([]);
  expect(stored.run?.status).toBe('stopped');
});

it('retries a failed session read and shares each initialization attempt across concurrent requests', async () => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  let clicked!: (tab: { id: number; windowId: number; url: string }) => void;
  let rejectInitial!: (error: Error) => void;
  let reads = 0;
  const firstRead = new Promise<never>((_resolve, reject) => { rejectInitial = reject; });
  let stored: SessionState = {};
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => { reads++; return reads === 1 ? firstRead : { sessionState: stored }; }, set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { sendMessage: vi.fn() }, scripting: { executeScript: vi.fn() },
  });
  await import('../src/background');
  const rpc = () => new Promise<{ ok: boolean; state?: SessionState; error?: string }>(resolve => receiver({ type: 'PANEL_GET_STATE' }, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  const first = rpc(); const concurrent = rpc();
  rejectInitial(new Error('temporary read failure'));
  expect((await first).ok).toBe(false); expect((await concurrent).ok).toBe(false);
  expect(reads).toBe(1);
  expect((await rpc()).ok).toBe(true);
  expect(reads).toBe(2);
  clicked({ id: 9, windowId: 1, url: 'https://app.hibob.com/attendance/my-attendance' });
  await vi.waitFor(() => expect(stored.tabId).toBe(9));
  expect(reads).toBe(2);
});

it('requires a supported content protocol before dispatching a scan', async () => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  const sent: string[] = [];
  const executeScript = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: { tabId: 9 } }), set: async () => {} } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string }) => { sent.push(message.type); return { ok: true }; } },
    scripting: { executeScript },
  });
  await import('../src/background');
  const response = await new Promise<{ ok: boolean; error?: string }>(resolve => receiver({ type: 'PANEL_SCAN', month: '2026-11' }, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  expect(response.ok).toBe(false);
  expect(response.error).toContain('ältere');
  expect(sent).toEqual(['PING']);
  expect(executeScript).not.toHaveBeenCalled();
});

it('cancels only the persisted interrupted job and waits for idle before starting a new scan', async () => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  const sent: { type: string; jobId?: string }[] = [];
  let active: { id: string; kind: string } | undefined = { id: 'interrupted-scan', kind: 'scan' };
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Test', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02', days: [] };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: { schemaVersion: 2, revision: 3, planRevision: 2, tabId: 9, job: { id: 'interrupted-scan', kind: 'scan', status: 'running', tabId: 9, month: '2026-11', startedAt: 'x', updatedAt: 'x' } } }), set: async () => {} } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string; jobId?: string }) => {
      sent.push(message);
      if (message.type === 'PING') return { ok: true, protocolVersion: 2, activeJob: active };
      if (message.type === 'CANCEL') { active = undefined; return { ok: true }; }
      return { ok: true, snapshot };
    } }, scripting: { executeScript: vi.fn() },
  });
  await import('../src/background');
  const response = await new Promise<{ ok: boolean; state?: SessionState }>(resolve => receiver({ type: 'PANEL_SCAN', month: '2026-11' }, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  expect(response.ok).toBe(true);
  expect(sent.filter(message => message.type === 'CANCEL')).toEqual([{ type: 'CANCEL', jobId: 'interrupted-scan' }]);
  const scanned = sent.find(message => message.type === 'SCAN_MONTH')!;
  expect(scanned.jobId).toBeTruthy(); expect(scanned.jobId).not.toBe('interrupted-scan');
});

it('returns a newer blocked state and visible error when canonical plan persistence rejects', async () => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  let stored: SessionState = { tabId: 9 };
  let rejectedRevision = -1;
  let rejectPlan = true;
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Review fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', context: { documentId: 'doc', employeeKey: 'employee', tenantKey: 'tenant', verified: true }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => {
      if (rejectPlan && sessionState.plan?.canApply) { rejectPlan = false; rejectedRevision = sessionState.revision!; throw new Error('plan journal unavailable'); }
      stored = structuredClone(sessionState);
    } } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string }) => message.type === 'PING' ? { ok: true, protocolVersion: 2 } : { ok: true, snapshot } },
    scripting: { executeScript: vi.fn() },
  });
  await import('../src/background');
  const rpc = (message: object) => new Promise<{ ok: boolean; state?: SessionState; error?: string }>(resolve => receiver(message, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  expect((await rpc({ type: 'PANEL_SCAN', month: '2026-11' })).ok).toBe(true);
  const invalid = await rpc({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: stored.planRevision, changeId: 'save-with-error' });
  const plan = buildMonthPlan(defaultSettings('2026-11'), stored.snapshot!, {}, 123);
  const rejected = await rpc({ type: 'PANEL_SAVE_PLAN', plan, lease: invalid.state!.editLease });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toContain('plan journal unavailable');
  expect(rejected.state?.error).toContain('plan journal unavailable');
  expect(rejected.state?.revision).toBeGreaterThan(rejectedRevision);
  expect(rejected.state?.plan?.canApply).toBe(false);
});

it('reopens the same bound tab during a held scan without an error or a second scan', async () => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  let clicked!: (tab: { id: number; windowId: number; url: string }) => void;
  let stored: SessionState = { tabId: 9 };
  let entered!: () => void; let release!: () => void;
  const enteredScan = new Promise<void>(resolve => { entered = resolve; });
  const heldScan = new Promise<void>(resolve => { release = resolve; });
  let scanCalls = 0;
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Review fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', days: [] };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: vi.fn(async () => {}) }, action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string }) => {
      if (message.type === 'PING') return { ok: true, protocolVersion: 2 };
      scanCalls++; entered(); await heldScan; return { ok: true, snapshot };
    } }, scripting: { executeScript: vi.fn() },
  });
  await import('../src/background');
  const rpc = (message: object) => new Promise<{ ok: boolean; state?: SessionState; error?: string }>(resolve => receiver(message, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  const scanning = rpc({ type: 'PANEL_SCAN', month: '2026-11' });
  await enteredScan;
  const jobId = stored.job!.id;
  receiver({ type: 'ADAPTER_PROGRESS', progress: { jobId, phase: 'scan', completed: 2, total: 30, message: 'Reading' } }, { id: 'test', tab: { id: 9 } }, () => {});
  await vi.waitFor(() => expect(stored.progress?.completed).toBe(2));
  clicked({ id: 9, windowId: 1, url: 'https://app.hibob.com/attendance/my-attendance' });
  // Flush both action and state RPC continuations before inspecting the controller.
  const reopened = await rpc({ type: 'PANEL_GET_STATE' });
  expect(reopened.state?.error).toBeUndefined();
  expect(reopened.state?.job).toMatchObject({ id: jobId, kind: 'scan', status: 'running' });
  expect(reopened.state?.progress?.completed).toBe(2);
  expect(scanCalls).toBe(1);
  release();
  expect((await scanning).ok).toBe(true);
  expect((await rpc({ type: 'PANEL_GET_STATE' })).state?.error).toBeUndefined();
  expect(scanCalls).toBe(1);
});
