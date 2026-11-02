import { afterEach, expect, it, vi } from 'vitest';
import type { AdapterResponse } from '../src/shared/types';
const mock = vi.hoisted(() => ({ construct: vi.fn(), scan: vi.fn(), apply: vi.fn() }));
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
  vi.stubGlobal('window', { location: { href: 'https://app.hibob.com/attendance/my-attendance' } });
  vi.stubGlobal('chrome', { runtime: { id: 'test', onMessage: { addListener }, sendMessage } });
  let release!: (value: unknown) => void;
  let signal!: AbortSignal;
  mock.scan.mockImplementation((_month, progress, suppliedSignal) => { signal = suppliedSignal; progress({ phase: 'scan', completed: 0, total: 30, message: 'reading' }); return new Promise(resolve => { release = resolve; }); });
  await import('../src/content');
  const ping = () => { let value!: AdapterResponse; receiver({ type: 'PING' }, { id: 'test' }, response => { value = response; }); return value; };
  expect(ping()).toEqual({ ok: true, protocolVersion: 2, activeJob: undefined });
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
  expect(ping()).toEqual({ ok: true, protocolVersion: 2, activeJob: undefined });
  vi.resetModules(); await import('../src/content');
  expect(addListener).toHaveBeenCalledTimes(1);
  expect(mock.construct).toHaveBeenCalledWith({ documentId: expect.any(String) });
});
