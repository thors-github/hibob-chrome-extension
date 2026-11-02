import { afterEach, expect, it, vi } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates } from '../src/domain/index';
import type { AdapterCommand, DraftCheckResult, MonthSnapshot, SessionState } from '../src/shared/types';
import { contextFingerprint } from '../src/shared/context';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(['success', 'missing-result', 'legacy-protocol', 'cancel-before-dispatch'] as const)('routes a draft check exclusively through protocol4 CHECK_DAY_DRAFT: %s', async scenario => {
  type Reply = { ok: boolean; state?: SessionState; error?: string; draftCheck?: DraftCheckResult };
  let receiver!: (message: unknown, sender: object, respond: (response: Reply) => void) => unknown;
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Draft fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', context: { mode: 'user-confirmed-ui', documentId: 'draft-doc', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'self-page' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  const settings = { ...defaultSettings('2026-11'), excludedDates: getMonthDates('2026-11').filter(date => date !== '2026-11-03') };
  const plan = buildMonthPlan(settings, snapshot, {}, 1);
  const history = { planId: 'previous-failed-run', status: 'failed' as const, startedAt: '2026-11-02', updatedAt: '2026-11-02', results: [{ date: '2026-11-03', status: 'failed' as const, message: 'No real booking saved' }] };
  let stored: SessionState = { schemaVersion: 3, revision: 5, planRevision: 1, editLease: { planRevision: 1, changeId: 'draft-review' }, tabId: 9, snapshot, plan, run: history, update: { installedVersion: '1.2.3' } };
  const publications: SessionState[] = []; const sent: AdapterCommand[] = [];
  let entered!: () => void; let release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); publications.push(stored); } } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.3' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: AdapterCommand) => {
      sent.push(structuredClone(message));
      if (message.type === 'PING') {
        if (scenario === 'cancel-before-dispatch') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
        return { ok: true, protocolVersion: scenario === 'legacy-protocol' ? 3 : 4, extensionVersion: '1.2.3' };
      }
      if (message.type === 'CHECK_DAY_DRAFT') return scenario === 'missing-result' ? { ok: true } : { ok: true, draftCheck: { date: message.day.date, entries: message.day.proposed, netMinutes: message.day.netMinutes, saved: false, unchanged: true } };
      if (message.type === 'CANCEL') return { ok: true };
      throw new Error('Unexpected Save or scan route');
    } }, scripting: { executeScript: vi.fn() },
  });
  await import('../src/background');
  const rpc = (message: object) => new Promise<Reply>(resolve => receiver(message, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  await rpc({ type: 'PANEL_GET_STATE' });
  const command = { type: 'PANEL_CHECK_DRAFT', plan, expectedPlanRevision: 1, date: '2026-11-03' };
  expect((await rpc(command)).ok).toBe(false); expect(sent).toEqual([]);
  const confirmation = { planId: plan.id, planRevision: 1, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmed: true };
  const checking = rpc({ ...command, confirmation });
  if (scenario === 'cancel-before-dispatch') { await held; await rpc({ type: 'PANEL_CANCEL', jobId: stored.job!.id }); release(); }
  const response = await checking;
  expect(response.ok).toBe(scenario === 'success');
  expect(sent.filter(message => message.type === 'APPLY_DAY')).toEqual([]);
  const checks = sent.filter(message => message.type === 'CHECK_DAY_DRAFT');
  expect(checks).toHaveLength(scenario === 'legacy-protocol' || scenario === 'cancel-before-dispatch' ? 0 : 1);
  if (scenario === 'success') {
    expect(response.draftCheck).toMatchObject({ date: '2026-11-03', netMinutes: 480, saved: false, unchanged: true });
    expect(checks[0]).toMatchObject({ authorization: { planId: plan.id, planRevision: 1, contextFingerprint: confirmation.contextFingerprint, confirmation } });
  } else expect(response.draftCheck).toBeUndefined();
  expect(response.state?.run).toEqual(history); expect(response.state?.snapshot).toBeUndefined(); expect(response.state?.plan?.canReview).toBe(false);
  for (const state of publications) { expect(state.run).toEqual(history); expect((state as SessionState & { draftCheck?: unknown }).draftCheck).toBeUndefined(); }
});

it('unbinds and discards the preview when opened outside HiBob without scanning automatically', async () => {
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Test', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02', context: { documentId: 'doc-review', employeeKey: 'employee-review', tenantKey: 'tenant-review', mode: 'stable-identity' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  let stored: SessionState = { tabId: 9, snapshot, plan: buildMonthPlan(defaultSettings('2026-11'), snapshot, {}, 1) };
  let clicked!: (tab: { id?: number; windowId: number; url?: string }) => void;
  const sendMessage = vi.fn();
  const executeScript = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: async () => {} },
    action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: () => {} } },
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
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Test', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02', context: { documentId: 'doc-review', employeeKey: 'employee-review', tenantKey: 'tenant-review', mode: 'stable-identity' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: async () => {} },
    action: { onClicked: { addListener: (listener: typeof clicked) => { clicked = listener; } } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: {
      get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }),
      sendMessage: async (_tabId: number, message: { type: string }) => {
        if (message.type === 'PING' && holdPing) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
        if (message.type === 'SCAN_MONTH') return { ok: true, snapshot };
        if (message.type === 'APPLY_DAY') writes.push(message);
        return { ok: true, protocolVersion: 4, extensionVersion: '1.2.0' };
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
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
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

it.each([undefined, 2, 3])('requires protocol 4 before dispatching a scan (received %s)', async protocolVersion => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  const sent: string[] = [];
  const executeScript = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: { tabId: 9 } }), set: async () => {} } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string }) => { sent.push(message.type); return { ok: true, protocolVersion, extensionVersion: '1.2.0' }; } },
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
    storage: { session: { get: async () => ({ sessionState: { schemaVersion: 3, revision: 3, planRevision: 2, tabId: 9, job: { id: 'interrupted-scan', kind: 'scan', status: 'running', tabId: 9, month: '2026-11', startedAt: 'x', updatedAt: 'x' } } }), set: async () => {} } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string; jobId?: string }) => {
      sent.push(message);
      if (message.type === 'PING') return { ok: true, protocolVersion: 4, extensionVersion: '1.2.0', activeJob: active };
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
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Review fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', context: { documentId: 'doc', employeeKey: 'employee', tenantKey: 'tenant', mode: 'stable-identity' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => {
      if (rejectPlan && sessionState.plan?.canReview) { rejectPlan = false; rejectedRevision = sessionState.revision!; throw new Error('plan journal unavailable'); }
      stored = structuredClone(sessionState);
    } } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string }) => message.type === 'PING' ? { ok: true, protocolVersion: 4, extensionVersion: '1.2.0' } : { ok: true, snapshot } },
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
  expect(rejected.state?.plan?.canReview).toBe(false);
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
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string }) => {
      if (message.type === 'PING') return { ok: true, protocolVersion: 4, extensionVersion: '1.2.0' };
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

it('requires per-plan manual consent and carries canonical authorization through protocol 4', async () => {
  let receiver!: (message: unknown, sender: object, respond: (response: { ok: boolean; state?: SessionState; error?: string }) => void) => unknown;
  let stored: SessionState = { tabId: 9 };
  const writes: { type: string; jobId?: string; authorization?: unknown }[] = [];
  const snapshot: MonthSnapshot = { month: '2026-11', employeeLabel: 'Review fixture', periodLabel: 'November', source: 'hibob', scannedAt: '2026-11-02T10:00:00Z', context: { mode: 'user-confirmed-ui', documentId: 'manual-doc', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'self-page' }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
  vi.stubGlobal('chrome', {
    storage: { session: { get: async () => ({ sessionState: stored }), set: async ({ sessionState }: { sessionState: SessionState }) => { stored = structuredClone(sessionState); } } },
    sidePanel: { open: async () => {} }, action: { onClicked: { addListener: () => {} } },
    runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onUpdateAvailable: { addListener: () => {} }, getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } } },
    tabs: { get: async () => ({ url: 'https://app.hibob.com/attendance/my-attendance', status: 'complete' }), sendMessage: async (_id: number, message: { type: string; day?: { date: string; proposed: unknown[] }; jobId?: string; authorization?: unknown }) => {
      if (message.type === 'PING') return { ok: true, protocolVersion: 4, extensionVersion: '1.2.0' };
      if (message.type === 'SCAN_MONTH') return { ok: true, snapshot };
      writes.push(structuredClone(message)); return { ok: true, day: { date: message.day!.date, entries: message.day!.proposed, editable: true, fingerprint: 'saved' } };
    } }, scripting: { executeScript: vi.fn() },
  });
  await import('../src/background');
  const rpc = (message: object) => new Promise<{ ok: boolean; state?: SessionState; error?: string }>(resolve => receiver(message, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve));
  await rpc({ type: 'PANEL_SCAN', month: '2026-11' });
  const invalid = await rpc({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: stored.planRevision, changeId: 'manual-review' });
  const settings = { ...defaultSettings('2026-11'), excludedDates: getMonthDates('2026-11').filter(date => date !== '2026-11-02') };
  const saved = await rpc({ type: 'PANEL_SAVE_PLAN', plan: buildMonthPlan(settings, stored.snapshot!, {}, 1), lease: invalid.state!.editLease });
  const plan = structuredClone(saved.state!.plan!);
  const revision = saved.state!.planRevision!;
  const missing = await rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision });
  expect(missing.ok).toBe(false); expect(missing.error).toContain('ausdrücklich'); expect(writes).toHaveLength(0);
  const confirmation = { planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmed: true };
  expect((await rpc({ type: 'PANEL_APPLY', plan, expectedPlanRevision: revision, confirmation })).ok).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0].authorization).toEqual({ planId: plan.id, planRevision: revision, contextFingerprint: contextFingerprint(plan.snapshot.context), confirmation });
  expect((stored as SessionState & { confirmation?: unknown }).confirmation).toBeUndefined();
});
