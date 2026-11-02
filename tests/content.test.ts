import { afterEach, expect, it, vi } from 'vitest';
import type { AdapterResponse } from '../src/shared/types';
const mock = vi.hoisted(() => ({ construct: vi.fn(), scan: vi.fn(), apply: vi.fn() }));
vi.mock('../src/hibob/context-reader', () => ({ makeUiContextReader: vi.fn(() => () => ({ mode: 'unavailable', reason: 'fixture' })) }));
vi.mock('../src/hibob/adapter', () => ({
  AdapterError: class extends Error { uncertain = false; },
  isAttendanceLocation: () => true,
  HiBobDomAdapter: class { constructor(options: unknown) { mock.construct(options); } scanMonth(...args: unknown[]) { return mock.scan(...args); } applyDay(...args: unknown[]) { return mock.apply(...args); } },
}));
afterEach(() => { delete (globalThis as { __hibobMonthlyAdapterInstalled?: boolean }).__hibobMonthlyAdapterInstalled; vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

it('handshakes, correlates progress and ignores a cancellation from another job', async () => {
  let receiver!: (message: unknown, sender: object, respond: (value: AdapterResponse) => void) => boolean;
  const addListener = vi.fn((listener: typeof receiver) => { receiver = listener; });
  const sendMessage = vi.fn(async () => {});
  let installedVersion = '1.2.0';
  vi.stubGlobal('document', {});
  vi.stubGlobal('window', { location: { href: 'https://app.hibob.com/attendance/my-attendance' } });
  vi.stubGlobal('chrome', { runtime: { id: 'test', getManifest: () => ({ version: installedVersion }), onUpdateAvailable: { addListener: () => {} }, onMessage: { addListener }, sendMessage } });
  let release!: (value: unknown) => void;
  let signal!: AbortSignal;
  mock.scan.mockImplementation((_month, progress, suppliedSignal) => { signal = suppliedSignal; progress({ phase: 'scan', completed: 0, total: 30, message: 'reading' }); return new Promise(resolve => { release = resolve; }); });
  await import('../src/content');
  const ping = () => { let value!: AdapterResponse; receiver({ type: 'PING' }, { id: 'test' }, response => { value = response; }); return value; };
  expect(ping()).toEqual({ ok: true, protocolVersion: 3, extensionVersion: '1.2.0', activeJob: undefined });
  installedVersion = '1.2.1';
  // An old listener must identify the build that actually installed it, even
  // if a browser API subsequently exposes the replacement package manifest.
  expect(ping()).toMatchObject({ extensionVersion: '1.2.0' });
  const responses: AdapterResponse[] = [];
  receiver({ type: 'SCAN_MONTH', month: '2026-11', jobId: 'current-job' }, { id: 'test' }, response => responses.push(response));
  expect(ping()).toMatchObject({ activeJob: { id: 'current-job', kind: 'scan' } });
  expect(sendMessage).toHaveBeenCalledWith({ type: 'ADAPTER_PROGRESS', progress: { phase: 'scan', completed: 0, total: 30, message: 'reading', jobId: 'current-job' } });
  let stale!: AdapterResponse;
  receiver({ type: 'CANCEL', jobId: 'old-job' }, { id: 'test' }, response => { stale = response; });
  expect(stale.ok).toBe(false); expect(signal.aborted).toBe(false);
  receiver({ type: 'CANCEL', jobId: 'current-job' }, { id: 'test' }, () => {});
  expect(signal.aborted).toBe(true);
  release({ month: '2026-11' });
  await vi.waitFor(() => expect(responses).toHaveLength(1));
  expect(ping()).toEqual({ ok: true, protocolVersion: 3, extensionVersion: '1.2.0', activeJob: undefined });
  vi.resetModules(); await import('../src/content');
  expect(addListener).toHaveBeenCalledTimes(1);
  expect(mock.construct).toHaveBeenCalledWith({ documentId: expect.any(String), readContext: expect.any(Function) });
});

it('rejects missing or stale manual authorization before calling the adapter and forwards valid consent', async () => {
  let receiver!: (message: unknown, sender: object, respond: (value: AdapterResponse) => void) => boolean;
  vi.stubGlobal('document', {});
  vi.stubGlobal('window', { location: { href: 'https://app.hibob.com/attendance/my-attendance' } });
  vi.stubGlobal('chrome', { runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } }, sendMessage: vi.fn(async () => {}) } });
  mock.apply.mockResolvedValue({ date: '2026-11-02', entries: [], editable: true, fingerprint: 'saved' });
  await import('../src/content');
  const { contextFingerprint } = await import('../src/shared/context');
  const context = { mode: 'user-confirmed-ui' as const, documentId: 'manual-doc', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'self-page' };
  const day = { date: '2026-11-02' };
  const base = { type: 'APPLY_DAY', jobId: 'job', day, context };
  const send = (message: unknown) => new Promise<AdapterResponse>(resolve => receiver(message, { id: 'test' }, resolve));
  expect((await send(base)).ok).toBe(false);
  const authorization = { planId: 'canonical-plan', planRevision: 4, contextFingerprint: contextFingerprint(context) };
  expect((await send({ ...base, authorization })).ok).toBe(false);
  const stale = { ...authorization, confirmation: { ...authorization, planRevision: 3, confirmed: true } };
  expect((await send({ ...base, authorization: stale })).ok).toBe(false);
  expect(mock.apply).not.toHaveBeenCalled();
  const valid = { ...authorization, confirmation: { ...authorization, confirmed: true } };
  expect((await send({ ...base, authorization: valid })).ok).toBe(true);
  expect(mock.apply).toHaveBeenCalledWith(day, expect.any(Function), expect.any(AbortSignal), context, valid);
});
