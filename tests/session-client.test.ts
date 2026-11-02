import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_RULES, SessionClient, SessionClientError, type ApiEndpointRule, type ApiHttpRequest, type SessionRequest } from '../src/hibob/session-client';

const ORIGIN = 'https://app.hibob.com';
const rules: ApiEndpointRule[] = [...DEFAULT_SESSION_RULES, { method: 'POST', path: '/api/fixture/search', mutation: false }, { method: 'POST', path: '/api/fixture/entries', mutation: true }];
const user = { id: 'self-fixture' }; const company = { id: 'company-fixture' };
const probe = async (request: SessionRequest) => {
  if ((await request<typeof user>({ method: 'GET', path: '/api/user' })).id !== user.id || (await request<typeof company>({ method: 'GET', path: '/api/company' })).id !== company.id) throw new Error('Fixture identity mismatch');
};
function response(value: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); }
function browserFixture() {
  let next = 10;
  type Page = { id: number; url: string; status: string; documentId: string };
  const pages = new Map<number, Page>();
  let wireHandler: (request: ApiHttpRequest, page: Page) => Promise<unknown> = async request => request.path === '/api/user' ? user : request.path === '/api/company' ? company : { accepted: true };
  let onWindowGet: (() => void) | undefined;
  let windowClosed = false;
  const create = vi.fn(async (options: { url: string; active?: boolean }) => {
    const page = { id: next++, url: options.url, status: 'complete', documentId: `document-${next}` }; pages.set(page.id, page); return { ...page };
  });
  const get = vi.fn(async (id: number) => { const page = pages.get(id); if (!page) throw new Error('Tab closed'); return { ...page }; });
  const remove = vi.fn(async (id: number) => { pages.delete(id); });
  const executeScript = vi.fn(async (options: { target: { tabId: number; documentIds?: string[] }; world: string; func: Function; args?: [{ request: ApiHttpRequest }] }) => {
    const page = pages.get(options.target.tabId);
    if (!page || options.target.documentIds && !options.target.documentIds.includes(page.documentId)) throw new Error('Target document disappeared');
    const documentId = page.documentId;
    const result = options.func.name === 'performWireRequest'
      ? { ok: true, value: await wireHandler(options.args![0].request, page), dispatched: true }
      : { url: page.url };
    return [{ frameId: 0, documentId, result }];
  });
  const createWindow = vi.fn(async (options: { url: string }) => { const page = await create({ url: options.url }); return { id: 100, tabs: [page] }; });
  const getWindow = vi.fn(async (_id: number, _options?: object) => { onWindowGet?.(); if (windowClosed) throw new Error('Login closed'); return { id: 100, tabs: [...pages.values()].filter(page => page.url.includes('/login')) }; });
  const browser = { tabs: { create, get, remove }, scripting: { executeScript }, windows: { create: createWindow, get: getWindow }, storage: { get: () => { throw new Error('Storage access prohibited'); } }, cookies: { get: () => { throw new Error('Cookie access prohibited'); } } } as unknown as typeof chrome;
  return { browser, pages, create, get, remove, executeScript, createWindow, getWindow, setWire: (handler: typeof wireHandler) => { wireHandler = handler; }, onWindowGet: (callback: () => void) => { onWindowGet = callback; }, closeWindow: () => { windowClosed = true; } };
}
const healthyFetch = () => vi.fn(async (url: string | URL | Request) => response(String(url).endsWith('/api/user') ? user : String(url).endsWith('/api/company') ? company : { accepted: true })) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
function clientFixture(options: { allowBackgroundTab?: boolean; fetch?: typeof fetch; requestTimeoutMs?: number; maxResponseBytes?: number } = {}) {
  const browser = browserFixture(); const fetcher = options.fetch ?? healthyFetch();
  const client = new SessionClient({ rules, probe, chrome: browser.browser, fetch: fetcher, pollMs: 1, timeoutMs: 50, ...options });
  return { ...browser, client, fetcher };
}

describe('session transport boundaries', () => {
  it('uses browser-managed credentials and fixed headers without any credential or storage access', async () => {
    const f = clientFixture();
    expect((await f.client.connect()).mode).toBe('direct');
    const connection = await f.client.openOperation(); expect(connection.mode).toBe('direct');
    expect(await f.client.request({ method: 'POST', path: '/api/fixture/entries', body: { work: 480 } })).toEqual({ acknowledged: true });
    for (const [url, options] of vi.mocked(f.fetcher).mock.calls) {
      expect(String(url).startsWith(`${ORIGIN}/api/`)).toBe(true);
      expect(options).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
      expect(options!.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Bob-TimeZoneOffset': new Date().getTimezoneOffset().toString() });
      expect(options!.headers).not.toHaveProperty('Cookie'); expect(options!.headers).not.toHaveProperty('Authorization');
    }
    expect(f.create).not.toHaveBeenCalled(); expect(f.createWindow).not.toHaveBeenCalled();
    await f.client.closeOperation(); await f.client.disconnect();
    expect(await f.client.request({ method: 'GET', path: '/api/user' }).catch(error => error.code)).toBe('NO_OPERATION');
  });

  it.each([
    { method: 'GET', path: 'https://other.example/api/user' },
    { method: 'GET', path: '//other.example/api/user' },
    { method: 'GET', path: '/api/../user' },
    { method: 'GET', path: '/api/user#secret' },
    { method: 'GET', path: '/api/user?token=do-not-send' },
    { method: 'GET', path: '/api/user\\other' },
    { method: 'DELETE', path: '/api/user' },
  ] as ApiHttpRequest[])('rejects requests outside the exact allowlist: $path', async request => {
    const f = clientFixture(); await f.client.openOperation(); vi.mocked(f.fetcher).mockClear();
    await expect(f.client.request(request)).rejects.toMatchObject({ code: 'REQUEST_DENIED', uncertain: false });
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.client.closeOperation();
  });

  it('rejects broad stateful expressions and conflicting classifications', async () => {
    expect(() => new SessionClient({ probe, chrome: {} as typeof chrome, rules: [{ method: 'GET', path: /api/, mutation: false }] })).toThrow(SessionClientError);
    const f = browserFixture();
    const client = new SessionClient({ probe, chrome: f.browser, fetch: healthyFetch(), rules: [...rules, { method: 'GET', path: '/api/user', mutation: true }] });
    await expect(client.openOperation()).rejects.toMatchObject({ code: 'REQUEST_DENIED' });
  });

  it('allows a read-only POST probe but never permits mutations in a connection probe', async () => {
    const f = clientFixture();
    const allowed = new SessionClient({ probe: async request => { await request({ method: 'POST', path: '/api/fixture/search', body: { self: true } }); }, rules, chrome: f.browser, fetch: f.fetcher });
    await expect(allowed.connect()).resolves.toMatchObject({ mode: 'direct' });
    const denied = new SessionClient({ probe: async request => { await request({ method: 'POST', path: '/api/fixture/entries', body: {} }); }, rules, chrome: f.browser, fetch: f.fetcher });
    vi.mocked(f.fetcher).mockClear();
    await expect(denied.connect()).rejects.toMatchObject({ code: 'REQUEST_DENIED', uncertain: false }); expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('safe response handling', () => {
  it.each([
    () => new Response(null, { status: 204 }),
    () => new Response('', { headers: { 'content-type': 'text/plain' } }),
    () => new Response('private server acknowledgement', { headers: { 'content-type': 'text/plain' } }),
  ])('accepts only a redacted mutation acknowledgement, which is never readback verification', async makeResponse => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher }); await f.client.openOperation();
    fetcher.mockImplementation(async () => makeResponse());
    expect(await f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).toEqual({ acknowledged: true });
    await expect(f.client.request({ method: 'GET', path: '/api/user' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await f.client.closeOperation();
  });

  it('still rejects an HTML login document disguised as a mutation acknowledgement', async () => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher }); await f.client.openOperation();
    fetcher.mockImplementation(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/plain' } }));
    await expect(f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).rejects.toMatchObject({ code: 'AUTH_REQUIRED', uncertain: true }); await f.client.closeOperation();
  });

  it.each([
    ['INVALID_RESPONSE', () => new Response('{broken', { headers: { 'content-type': 'application/json' } })],
    ['INVALID_RESPONSE', () => response(null)],
    ['INVALID_RESPONSE', () => new Response('secret response', { headers: { 'content-type': 'text/plain' } })],
    ['AUTH_REQUIRED', () => new Response('<html>secret login information</html>', { headers: { 'content-type': 'text/html' } })],
    ['AUTH_REQUIRED', () => response({ private: 'secret' }, 401)],
    ['FORBIDDEN', () => response({ private: 'secret' }, 403)],
    ['HTTP_ERROR', () => response({ private: 'secret' }, 500)],
  ] as const)('redacts %s responses and does not retry', async (code, makeResponse) => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher }); await f.client.openOperation();
    fetcher.mockClear(); fetcher.mockImplementation(async () => makeResponse());
    const error = await f.client.request({ method: 'GET', path: '/api/user' }).catch(error => error) as SessionClientError;
    expect(error).toMatchObject({ code, uncertain: false }); expect(error.message).not.toContain('secret'); expect(error.message).not.toContain('<html>'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.createWindow).not.toHaveBeenCalled(); await f.client.closeOperation();
  });

  it('bounds both advertised and streamed response sizes', async () => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher, maxResponseBytes: 50 }); await f.client.openOperation();
    for (const headers of [{}, { 'content-length': '99999999' }] as Record<string, string>[]) {
      fetcher.mockImplementation(async () => response({ payload: 'x'.repeat(100) }, 200, headers));
      await expect(f.client.request({ method: 'GET', path: '/api/user' })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    }
    await f.client.closeOperation();
  });

  it('rejects redirects and never follows response URLs', async () => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher }); await f.client.openOperation();
    fetcher.mockImplementation(async () => { const r = response(user); Object.defineProperty(r, 'url', { value: 'https://other.example/secret' }); return r; });
    await expect(f.client.request({ method: 'GET', path: '/api/user' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); await f.client.closeOperation();
  });

  it('times out even when fetch ignores AbortSignal; a dispatched mutation becomes uncertain', async () => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher, requestTimeoutMs: 5 }); await f.client.openOperation();
    fetcher.mockClear(); fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    await expect(f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).rejects.toMatchObject({ code: 'TIMEOUT', uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled(); await f.client.closeOperation();
  });

  it('does not fall back or prompt login after any mutation dispatch, including 401 and network failure', async () => {
    for (const failure of [async () => response({}, 401), async () => response({}, 403), async () => { throw new TypeError('Failed to fetch secret'); }]) {
      const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher, allowBackgroundTab: true }); await f.client.openOperation();
      fetcher.mockClear(); fetcher.mockImplementation(failure);
      const error = await f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} }).catch(error => error) as SessionClientError;
      expect(error.uncertain).toBe(true); expect(error.message).not.toContain('secret'); expect(fetcher).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled(); expect(f.createWindow).not.toHaveBeenCalled(); await f.client.closeOperation();
    }
  });
});

describe('temporary background transport ownership', () => {
  const unavailable = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  it('requires explicit fallback permission and closes only its own unchanged document', async () => {
    const denied = clientFixture({ fetch: unavailable });
    await expect(denied.client.openOperation()).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' }); expect(denied.create).not.toHaveBeenCalled();
    const f = clientFixture({ fetch: unavailable, allowBackgroundTab: true });
    expect((await f.client.openOperation()).mode).toBe('tab');
    expect(f.create).toHaveBeenCalledWith({ url: `${ORIGIN}/home`, active: false });
    expect(await f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).toEqual({ accepted: true });
    const scripts = f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest');
    expect(scripts).toHaveLength(3);
    for (const [options] of scripts) { expect(options.world).toBe('MAIN'); expect(options.target.documentIds).toHaveLength(1); }
    await f.client.closeOperation(); expect(f.remove).toHaveBeenCalledTimes(1); expect(f.pages.size).toBe(0);
  });

  it('can recover a direct-origin 403 only through the approved read-only same-origin setup probe', async () => {
    const direct403 = vi.fn(async () => response({}, 403)) as unknown as typeof fetch;
    const denied = clientFixture({ fetch: direct403 });
    await expect(denied.client.connect()).rejects.toMatchObject({ code: 'FORBIDDEN', uncertain: false });
    expect(denied.create).not.toHaveBeenCalled(); expect(denied.createWindow).not.toHaveBeenCalled();
    const f = clientFixture({ fetch: direct403, allowBackgroundTab: true });
    expect((await f.client.connect()).mode).toBe('tab');
    expect(f.create).toHaveBeenCalledWith({ url: `${ORIGIN}/home`, active: false });
    const probes = f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest');
    expect(probes.map(([options]) => options.args![0].request)).toEqual([{ method: 'GET', path: '/api/user' }, { method: 'GET', path: '/api/company' }]);
    expect(f.createWindow).not.toHaveBeenCalled(); expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it('does not retry a forbidden same-origin setup probe or prompt login', async () => {
    const f = clientFixture({ fetch: vi.fn(async () => response({}, 403)) as unknown as typeof fetch, allowBackgroundTab: true });
    const ordinary = f.executeScript.getMockImplementation()!;
    f.executeScript.mockImplementation(async options => options.func.name === 'performWireRequest'
      ? [{ frameId: 0, documentId: f.pages.get(options.target.tabId)!.documentId, result: { ok: false, code: 'FORBIDDEN', status: 403, dispatched: true, value: undefined } }]
      : ordinary(options));
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, uncertain: false });
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.createWindow).not.toHaveBeenCalled(); expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest')).toHaveLength(1);
  });

  it.each(['navigation', 'reload'] as const)('does not send or close the owned tab after user %s', async kind => {
    const f = clientFixture({ fetch: unavailable, allowBackgroundTab: true }); await f.client.openOperation();
    const page = [...f.pages.values()][0]; if (kind === 'navigation') page.url = `${ORIGIN}/people`; else page.documentId = 'replacement-document';
    const before = f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest').length;
    await expect(f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).rejects.toMatchObject({ uncertain: false });
    expect(f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest')).toHaveLength(before);
    await f.client.closeOperation(); expect(f.remove).not.toHaveBeenCalled(); expect(f.pages.has(page.id)).toBe(true);
  });

  it('checks document ownership again after an awaited mutation and reports an uncertain result', async () => {
    const f = clientFixture({ fetch: unavailable, allowBackgroundTab: true }); await f.client.openOperation();
    f.setWire(async (_request, page) => { page.documentId = 'new-document-after-send'; return { accepted: true }; });
    await expect(f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).rejects.toMatchObject({ uncertain: true });
    await f.client.closeOperation(); expect(f.remove).not.toHaveBeenCalled(); expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('does not replay a MAIN-world mutation after a lost result', async () => {
    const f = clientFixture({ fetch: unavailable, allowBackgroundTab: true }); await f.client.openOperation();
    f.setWire(async () => { throw new Error('Lost result, secret account token'); });
    const before = f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest').length;
    const error = await f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} }).catch(error => error) as SessionClientError;
    expect(error).toMatchObject({ code: 'NETWORK_UNAVAILABLE', uncertain: true }); expect(error.message).not.toContain('secret');
    expect(f.executeScript.mock.calls.filter(([options]) => options.func.name === 'performWireRequest')).toHaveLength(before + 1); await f.client.closeOperation();
  });
});

describe('login and cancellation', () => {
  it('retains the connection ID across operations and rotates it on reconnect', async () => {
    const f = clientFixture(); const connected = await f.client.connect();
    expect((await f.client.openOperation()).id).toBe(connected.id); await f.client.closeOperation();
    expect((await f.client.openOperation()).id).toBe(connected.id); await f.client.closeOperation();
    expect((await f.client.connect()).id).not.toBe(connected.id); await f.client.disconnect();
  });

  it('opens only the normal login popup after auth is missing and polls the authenticated probe', async () => {
    let authorized = false;
    const fetcher = vi.fn(async (url: string | URL | Request) => authorized ? response(String(url).endsWith('/api/user') ? user : company) : response({}, 401)) as unknown as typeof fetch;
    const f = clientFixture({ fetch: fetcher }); f.onWindowGet(() => { authorized = true; });
    expect((await f.client.connect()).mode).toBe('direct');
    expect(f.createWindow).toHaveBeenCalledWith({ url: `${ORIGIN}/login`, type: 'popup', width: 900, height: 800, focused: true });
    expect(f.getWindow).toHaveBeenCalled(); expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it('treats closing login as cancellation and never loops on forbidden access', async () => {
    const f = clientFixture({ fetch: vi.fn(async () => response({}, 401)) as unknown as typeof fetch }); f.onWindowGet(() => { f.closeWindow(); });
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'CANCELLED', uncertain: false });
    const forbidden = clientFixture({ fetch: vi.fn(async () => response({}, 403)) as unknown as typeof fetch });
    await expect(forbidden.client.connect()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(forbidden.createWindow).not.toHaveBeenCalled(); expect(forbidden.create).not.toHaveBeenCalled();
  });

  it('does not repeatedly open fallback tabs while the normal login popup is unfinished', async () => {
    let reads = 0;
    const fetcher = vi.fn(async () => response({}, 401)) as unknown as typeof fetch;
    const f = clientFixture({ fetch: fetcher, allowBackgroundTab: true });
    f.onWindowGet(() => { reads++; if (reads === 3) f.closeWindow(); });
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.createWindow).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1); // Only the popup's own page; no background home tabs.
    expect(f.create.mock.calls[0][0].url).toBe(`${ORIGIN}/login`);
  });

  it('keeps an exclusive operation lock and preserves its caller cancellation signal after opening', async () => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher }); const cancellation = new AbortController();
    await f.client.openOperation(cancellation.signal);
    await expect(f.client.openOperation()).rejects.toMatchObject({ code: 'BUSY' }); await expect(f.client.connect()).rejects.toMatchObject({ code: 'BUSY' });
    cancellation.abort(); fetcher.mockClear();
    await expect(f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} })).rejects.toMatchObject({ code: 'CANCELLED', uncertain: false }); expect(fetcher).not.toHaveBeenCalled();
    await f.client.closeOperation(); await expect(f.client.openOperation()).resolves.toMatchObject({ mode: 'direct' }); await f.client.closeOperation();
  });

  it('cancels an in-flight direct write once and does not claim that it was rolled back', async () => {
    const fetcher = healthyFetch(); const f = clientFixture({ fetch: fetcher }); await f.client.openOperation();
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    fetcher.mockClear(); fetcher.mockImplementation(() => { entered(); return new Promise<Response>(() => {}); });
    const result = f.client.request({ method: 'POST', path: '/api/fixture/entries', body: {} }); await started;
    f.client.cancel(); await expect(result).rejects.toMatchObject({ code: 'CANCELLED', uncertain: true }); expect(fetcher).toHaveBeenCalledTimes(1); await f.client.closeOperation();
  });
});
