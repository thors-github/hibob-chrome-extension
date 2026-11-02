import { afterEach, expect, it, vi } from 'vitest';
import type { AdapterResponse } from '../src/shared/types';
const mock = vi.hoisted(() => ({ construct: vi.fn(), scan: vi.fn(), apply: vi.fn(), draft: vi.fn() }));
vi.mock('../src/hibob/context-reader', () => ({ makeUiContextReader: vi.fn(() => () => ({ mode: 'unavailable', reason: 'fixture' })) }));
vi.mock('../src/hibob/adapter', () => ({
  AdapterError: class extends Error { uncertain = false; },
  isAttendanceLocation: () => true,
  HiBobDomAdapter: class { constructor(options: unknown) { mock.construct(options); } scanMonth(...args: unknown[]) { return mock.scan(...args); } applyDay(...args: unknown[]) { return mock.apply(...args); } checkDayDraft(...args: unknown[]) { return mock.draft(...args); } },
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
  expect(ping()).toEqual({ ok: true, protocolVersion: 4, extensionVersion: '1.2.0', activeJob: undefined });
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
  expect(ping()).toEqual({ ok: true, protocolVersion: 4, extensionVersion: '1.2.0', activeJob: undefined });
  vi.resetModules(); await import('../src/content');
  expect(addListener).toHaveBeenCalledTimes(1);
  expect(mock.construct).toHaveBeenCalledWith({ documentId: expect.any(String), readContext: expect.any(Function) });
});

it.each(['APPLY_DAY', 'CHECK_DAY_DRAFT'] as const)('rejects missing or stale manual authorization for %s and forwards valid consent only to its route', async type => {
  let receiver!: (message: unknown, sender: object, respond: (value: AdapterResponse) => void) => boolean;
  vi.stubGlobal('document', {});
  vi.stubGlobal('window', { location: { href: 'https://app.hibob.com/attendance/my-attendance' } });
  vi.stubGlobal('chrome', { runtime: { id: 'test', getManifest: () => ({ version: '1.2.0' }), onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } }, sendMessage: vi.fn(async () => {}) } });
  mock.apply.mockResolvedValue({ date: '2026-11-02', entries: [], editable: true, fingerprint: 'saved' });
  mock.draft.mockResolvedValue({ date: '2026-11-02', entries: [], netMinutes: 0, saved: false, unchanged: true });
  await import('../src/content');
  const { contextFingerprint } = await import('../src/shared/context');
  const context = { mode: 'user-confirmed-ui' as const, documentId: 'manual-doc', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'self-page' };
  const day = { date: '2026-11-02' };
  const base = { type, jobId: 'job', day, context };
  const send = (message: unknown) => new Promise<AdapterResponse>(resolve => receiver(message, { id: 'test' }, resolve));
  expect((await send(base)).ok).toBe(false);
  const authorization = { planId: 'canonical-plan', planRevision: 4, contextFingerprint: contextFingerprint(context) };
  expect((await send({ ...base, authorization })).ok).toBe(false);
  const stale = { ...authorization, confirmation: { ...authorization, planRevision: 3, confirmed: true } };
  expect((await send({ ...base, authorization: stale })).ok).toBe(false);
  expect(mock.apply).not.toHaveBeenCalled();
  expect(mock.draft).not.toHaveBeenCalled();
  const valid = { ...authorization, confirmation: { ...authorization, confirmed: true } };
  expect((await send({ ...base, authorization: valid })).ok).toBe(true);
  expect(type === 'APPLY_DAY' ? mock.apply : mock.draft).toHaveBeenCalledWith(day, expect.any(Function), expect.any(AbortSignal), context, valid);
  expect(type === 'APPLY_DAY' ? mock.draft : mock.apply).not.toHaveBeenCalled();
});

it('keeps a draft check cancellable and exclusive without using the Save route or unknown-command fallback', async () => {
  let receiver!: (message: unknown, sender: object, respond: (value: AdapterResponse) => void) => boolean;
  vi.stubGlobal('document', {});
  vi.stubGlobal('window', { location: { href: 'https://app.hibob.com/attendance/my-attendance' } });
  const sendMessage = vi.fn(async () => {});
  vi.stubGlobal('chrome', { runtime: { id: 'test', getManifest: () => ({ version: '1.2.3' }), onMessage: { addListener: (listener: typeof receiver) => { receiver = listener; } }, sendMessage } });
  let reject!: (error: Error) => void; let signal!: AbortSignal;
  mock.draft.mockImplementationOnce((_day, progress, suppliedSignal) => { signal = suppliedSignal; progress({ phase: 'apply', completed: 0, total: 1, message: 'Checking without Save' }); return new Promise((_resolve, fail) => { reject = fail; }); });
  await import('../src/content');
  const { contextFingerprint } = await import('../src/shared/context');
  const context = { mode: 'stable-identity' as const, documentId: 'draft-doc', employeeKey: 'self', tenantKey: 'company' };
  const authorization = { planId: 'draft-plan', planRevision: 2, contextFingerprint: contextFingerprint(context) };
  const command = { type: 'CHECK_DAY_DRAFT', day: { date: '2026-11-03' }, context, authorization, jobId: 'draft-job' };
  const send = (message: unknown) => new Promise<AdapterResponse>(resolve => receiver(message, { id: 'test' }, resolve));
  expect(receiver({ ...command, type: 'UNKNOWN_DRAFT' }, { id: 'test' }, () => {})).toBe(false);
  const checking = send(command);
  expect(await send({ type: 'PING' })).toMatchObject({ protocolVersion: 4, activeJob: { id: 'draft-job', kind: 'apply' } });
  expect(sendMessage).toHaveBeenCalledWith({ type: 'ADAPTER_PROGRESS', progress: { phase: 'apply', completed: 0, total: 1, message: 'Checking without Save', jobId: 'draft-job' } });
  expect((await send({ ...command, type: 'APPLY_DAY' })).ok).toBe(false);
  expect((await send({ type: 'CANCEL', jobId: 'wrong-job' })).ok).toBe(false); expect(signal.aborted).toBe(false);
  expect((await send({ type: 'CANCEL', jobId: 'draft-job' })).ok).toBe(true); expect(signal.aborted).toBe(true);
  reject(new Error('Draft check cancelled after cleanup'));
  expect(await checking).toMatchObject({ ok: false, error: 'Draft check cancelled after cleanup' });
  expect(mock.draft).toHaveBeenCalledTimes(1); expect(mock.apply).not.toHaveBeenCalled();
});
