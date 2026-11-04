/** Session-authenticated transport. Credentials stay with Chrome, never in extension storage. */
import type { ExecutionProfile } from '../shared/types';
export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface ApiHttpRequest { method: ApiHttpMethod; path: string; body?: unknown }
export interface ApiEndpointRule { method: ApiHttpMethod; path: string | RegExp; mutation: boolean }
export interface SessionConnection { mode: 'direct' | 'tab'; id: string }
export type SessionRequest = <T = unknown>(request: ApiHttpRequest, signal?: AbortSignal) => Promise<T>;
export type SessionErrorCode = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'NETWORK_UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'DOCUMENT_CHANGED' | 'REQUEST_DENIED' | 'BUSY' | 'NO_OPERATION';
const messages: Record<SessionErrorCode, string> = {
  AUTH_REQUIRED: 'Sign in to HiBob to continue.', FORBIDDEN: 'HiBob rejected access. Check your permissions.',
  RATE_LIMITED: 'HiBob temporarily limited API requests. Wait before reading the month again; do not repeat an unverified booking.',
  HTTP_ERROR: 'HiBob rejected the API request.', NETWORK_UNAVAILABLE: 'The HiBob session transport is unavailable.',
  TIMEOUT: 'The HiBob request timed out.', CANCELLED: 'The operation was cancelled.', INVALID_RESPONSE: 'HiBob returned an unsupported response.',
  RESPONSE_TOO_LARGE: 'The HiBob response exceeded the allowed size.', DOCUMENT_CHANGED: 'The temporary HiBob page changed. Read the month again.',
  REQUEST_DENIED: 'The requested HiBob endpoint is not allowed.', BUSY: 'A HiBob operation is already running.', NO_OPERATION: 'Open a HiBob operation before sending a request.',
};
export class SessionClientError extends Error {
  constructor(public readonly code: SessionErrorCode, public readonly uncertain = false, public readonly status?: number, public readonly retryAfterMs?: number) { super(messages[code]); this.name = 'SessionClientError'; }
}
export const DEFAULT_SESSION_RULES: readonly ApiEndpointRule[] = [
  { method: 'GET', path: '/api/user', mutation: false }, { method: 'GET', path: '/api/company', mutation: false },
];
export interface SessionClientOptions {
  rules?: readonly ApiEndpointRule[];
  probe: (request: SessionRequest, signal?: AbortSignal) => Promise<void>;
  allowBackgroundTab?: boolean;
  fetch?: typeof fetch;
  chrome?: typeof chrome;
  timeoutMs?: number;
  pollMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Minimum spacing between all API dispatches, including setup probes. */
  minRequestIntervalMs?: number;
}
interface SerializedRule { method: ApiHttpMethod; source: string; flags: string; mutation: boolean }
interface OwnedTab { id: number; url: string; documentId: string }
interface Operation { connection: SessionConnection; controller: AbortController; tab?: OwnedTab; closing: boolean; pending: Set<Promise<unknown>>; detachSignal: () => void }
interface WireInput { request: ApiHttpRequest; rules: SerializedRule[]; maxBytes: number; timeoutMs: number; expectedUrl?: string }
type WireResult = { ok: true; value: unknown; dispatched: true } | { ok: false; code: SessionErrorCode; status?: number; retryAfterMs?: number; dispatched: boolean };
const ORIGIN = 'https://app.hibob.com';
const HOME = `${ORIGIN}/home`;
const LOGIN = `${ORIGIN}/login`;

/** Serialized as one fixed MAIN-world function; no DOM, cookie or credential access. */
async function performWireRequest(input: WireInput, fetcher: typeof fetch = fetch, external?: AbortSignal): Promise<WireResult> {
  let dispatched = false;
  let timeout = false;
  const controller = new AbortController();
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new Error('aborted');
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('aborted')); controller.signal.addEventListener('abort', onAbort, { once: true }); });
    try { return await Promise.race([promise, aborted]); }
    finally { controller.signal.removeEventListener('abort', onAbort); }
  };
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, input.timeoutMs);
  try {
    const request = input.request;
    const url = new URL(request.path, 'https://app.hibob.com');
    if (!request.path.startsWith('/api/') || request.path.includes('\\') || request.path.includes('#') || url.origin !== 'https://app.hibob.com' || `${url.pathname}${url.search}` !== request.path) return { ok: false, code: 'REQUEST_DENIED', dispatched };
    const rules = input.rules.filter(rule => rule.method === request.method && new RegExp(rule.source, rule.flags).test(request.path));
    if (!rules.length || rules.some(rule => rule.mutation !== rules[0].mutation)) return { ok: false, code: 'REQUEST_DENIED', dispatched };
    const mutation = rules[0].mutation;
    if (external?.aborted) return { ok: false, code: 'CANCELLED', dispatched };
    if (input.expectedUrl && location.href !== input.expectedUrl) return { ok: false, code: 'DOCUMENT_CHANGED', dispatched };
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if ((request.method === 'GET' && body !== undefined) || (body !== undefined && new TextEncoder().encode(body).byteLength > 1_000_000)) return { ok: false, code: 'REQUEST_DENIED', dispatched };
    dispatched = true;
    const response = await bounded(fetcher(url.href, {
      method: request.method, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Bob-TimeZoneOffset': new Date().getTimezoneOffset().toString() },
      ...(body === undefined ? {} : { body }),
    }));
    if (input.expectedUrl && location.href !== input.expectedUrl) return { ok: false, code: 'DOCUMENT_CHANGED', dispatched };
    if (response.redirected || (response.url && response.url !== url.href)) return { ok: false, code: 'INVALID_RESPONSE', dispatched };
    if (response.status === 401 || response.status === 419) return { ok: false, code: 'AUTH_REQUIRED', status: response.status, dispatched };
    if (response.status === 403) return { ok: false, code: 'FORBIDDEN', status: response.status, dispatched };
    if (response.status === 429) {
      // This function is serialized into the tab: keep parsing self-contained,
      // return only a bounded duration, never the raw header or response body.
      const value = response.headers.get('retry-after')?.trim() ?? '';
      let duration = 300_000;
      if (value.length <= 128 && /^\d+$/.test(value)) duration = Number(value) * 1000;
      else if (value.length <= 128 && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
        const date = Date.parse(value);
        if (Number.isFinite(date)) duration = date - Date.now();
      }
      const retryAfterMs = Math.max(1000, Math.min(86_400_000, Number.isNaN(duration) ? 300_000 : duration));
      return { ok: false, code: 'RATE_LIMITED', status: 429, retryAfterMs, dispatched };
    }
    if (!response.ok) return { ok: false, code: 'HTTP_ERROR', status: response.status, dispatched };
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (contentType === 'text/html') return { ok: false, code: 'AUTH_REQUIRED', dispatched };
    const isJson = contentType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(contentType);
    if (!mutation && !isJson) return { ok: false, code: 'INVALID_RESPONSE', dispatched };
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > input.maxBytes) { await response.body?.cancel(); return { ok: false, code: 'RESPONSE_TOO_LARGE', dispatched }; }
    if (!response.body) return mutation ? { ok: true, value: { acknowledged: true }, dispatched: true } : { ok: false, code: 'INVALID_RESPONSE', dispatched };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await bounded(reader.read());
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > input.maxBytes) { await reader.cancel(); return { ok: false, code: 'RESPONSE_TOO_LARGE', dispatched }; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(text)) return { ok: false, code: 'AUTH_REQUIRED', dispatched };
    // A transport acknowledgement is never a verified save; callers must reread.
    if (mutation) return { ok: true, value: { acknowledged: true }, dispatched: true };
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') return { ok: false, code: 'INVALID_RESPONSE', dispatched };
    if (input.expectedUrl && location.href !== input.expectedUrl) return { ok: false, code: 'DOCUMENT_CHANGED', dispatched };
    return { ok: true, value, dispatched: true };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, code: timeout ? 'TIMEOUT' : 'CANCELLED', dispatched };
    return { ok: false, code: error instanceof SyntaxError || error instanceof TypeError && !(error.message.includes('fetch') || error.message.includes('network') || error.message.includes('Network')) ? 'INVALID_RESPONSE' : 'NETWORK_UNAVAILABLE', dispatched };
  } finally { clearTimeout(timer); external?.removeEventListener('abort', abort); }
}

/** Narrow browser-session client. No token, cookie or HR response is persisted or logged. */
export class SessionClient {
  private readonly browser: typeof chrome;
  private readonly fetcher: typeof fetch;
  private readonly rules: SerializedRule[];
  private connection?: SessionConnection;
  private operation?: Operation;
  private opening?: AbortController;
  private requestQueue: Promise<void> = Promise.resolve();
  private lastDispatchAt = -Infinity;
  private cooldownUntil = 0;
  private profile: ExecutionProfile = 'strict';
  private dispatches = 0;
  private mutationDispatches = 0;
  /** Aggregate counters only; no request bodies, paths or account data. */
  requestCounts(): { requests: number; writes: number } { return { requests: this.dispatches, writes: this.mutationDispatches }; }
  constructor(private readonly options: SessionClientOptions) {
    this.browser = options.chrome ?? chrome;
    this.fetcher = options.fetch ?? fetch;
    this.rules = (options.rules ?? DEFAULT_SESSION_RULES).map(rule => {
      if (typeof rule.path !== 'string' && (!rule.path.source.startsWith('^') || !rule.path.source.endsWith('$') || /[gy]/.test(rule.path.flags))) throw new SessionClientError('REQUEST_DENIED');
      return { method: rule.method, mutation: rule.mutation, source: typeof rule.path === 'string' ? `^${rule.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : rule.path.source, flags: typeof rule.path === 'string' ? '' : rule.path.flags };
    });
  }
  private check(signal?: AbortSignal) { if (signal?.aborted) throw new SessionClientError('CANCELLED'); }
  private checkCooldown(): void {
    const remaining = Math.ceil(this.cooldownUntil - Date.now());
    if (remaining > 0) throw new SessionClientError('RATE_LIMITED', false, 429, remaining);
  }
  private async abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.check(signal);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new SessionClientError('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([pending, cancelled]); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  private async beforeDispatch(signal?: AbortSignal): Promise<void> {
    this.check(signal); this.checkCooldown();
    const configured = this.profile === 'fast-serial' ? 0 : this.options.minRequestIntervalMs ?? 1000;
    const interval = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 60_000) : 1000;
    const delay = Math.min(interval, Math.max(0, this.lastDispatchAt + interval - Date.now()));
    if (delay > 0) {
      let timer!: ReturnType<typeof setTimeout>;
      try { await this.abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); }), signal); }
      finally { clearTimeout(timer); }
    }
    this.check(signal); this.checkCooldown();
    this.lastDispatchAt = Date.now();
  }
  private rememberRateLimit(wire: WireResult): void {
    if (!wire.ok && wire.code === 'RATE_LIMITED') {
      const duration = Number.isFinite(wire.retryAfterMs) ? wire.retryAfterMs! : 300_000;
      wire.retryAfterMs = Math.max(1000, Math.min(86_400_000, duration));
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + wire.retryAfterMs);
    }
  }
  private link(signal: AbortSignal | undefined, controller: AbortController): () => void {
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    return () => signal?.removeEventListener('abort', cancel);
  }
  private async pause(signal?: AbortSignal) {
    this.check(signal);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new SessionClientError('CANCELLED')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, this.options.pollMs ?? 400);
      signal?.addEventListener('abort', abort, { once: true });
    });
    this.check(signal);
  }
  private async document(tabId: number): Promise<OwnedTab> {
    try {
    const tab = await this.browser.tabs.get(tabId);
    if (!tab.url || new URL(tab.url).origin !== ORIGIN) throw new SessionClientError('DOCUMENT_CHANGED');
    const result = await this.browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({ url: location.href }) });
    const frame = result.find(item => item.frameId === 0);
    if (!frame?.documentId || !frame.result?.url || frame.result.url !== tab.url) throw new SessionClientError('DOCUMENT_CHANGED');
    return { id: tabId, url: tab.url, documentId: frame.documentId };
    } catch (error) { if (error instanceof SessionClientError) throw error; throw new SessionClientError('DOCUMENT_CHANGED'); }
  }
  private async owned(tab: OwnedTab): Promise<void> {
    try {
    const current = await this.browser.tabs.get(tab.id);
    if (current.url !== tab.url) throw new SessionClientError('DOCUMENT_CHANGED');
    const result = await this.browser.scripting.executeScript({ target: { tabId: tab.id, documentIds: [tab.documentId] }, world: 'MAIN', func: () => ({ url: location.href }) });
    const frame = result.find(item => item.frameId === 0);
    if (!frame || frame.documentId !== tab.documentId || frame.result?.url !== tab.url) throw new SessionClientError('DOCUMENT_CHANGED');
    } catch (error) { if (error instanceof SessionClientError) throw error; throw new SessionClientError('DOCUMENT_CHANGED'); }
  }
  private async closeOwned(tab?: OwnedTab) {
    if (!tab) return;
    try { await this.owned(tab); await this.browser.tabs.remove(tab.id); } catch { /* Never close a tab after user navigation or replacement. */ }
  }
  private async createOwned(signal?: AbortSignal): Promise<OwnedTab> {
    this.check(signal);
    let created: chrome.tabs.Tab;
    try { created = await this.browser.tabs.create({ url: HOME, active: false }); } catch { throw new SessionClientError('NETWORK_UNAVAILABLE'); }
    if (created.id === undefined) throw new SessionClientError('NETWORK_UNAVAILABLE');
    let tab: OwnedTab | undefined;
    try {
      const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
      while ((await this.browser.tabs.get(created.id)).status !== 'complete') {
        this.check(signal);
        if (Date.now() >= deadline) throw new SessionClientError('TIMEOUT');
        await this.pause(signal);
      }
      tab = await this.document(created.id);
      this.check(signal);
      if (tab.url !== HOME) throw new SessionClientError(new URL(tab.url).pathname.includes('login') ? 'AUTH_REQUIRED' : 'DOCUMENT_CHANGED');
      return tab;
    } catch (error) { await this.closeOwned(tab); if (error instanceof SessionClientError) throw error; throw new SessionClientError('NETWORK_UNAVAILABLE'); }
  }
  private rule(request: ApiHttpRequest): SerializedRule {
    let url: URL;
    try { url = new URL(request.path, ORIGIN); } catch { throw new SessionClientError('REQUEST_DENIED'); }
    const matching = this.rules.filter(rule => rule.method === request.method && new RegExp(rule.source, rule.flags).test(request.path));
    if (!request.path.startsWith('/api/') || request.path.includes('\\') || request.path.includes('#') || url.origin !== ORIGIN || `${url.pathname}${url.search}` !== request.path || !matching.length || matching.some(rule => rule.mutation !== matching[0].mutation)) throw new SessionClientError('REQUEST_DENIED');
    return matching[0];
  }
  private async send<T>(request: ApiHttpRequest, signal?: AbortSignal, tab?: OwnedTab): Promise<T> {
    this.rule(request); this.check(signal); this.checkCooldown();
    let stable: ApiHttpRequest;
    try { stable = JSON.parse(JSON.stringify(request)) as ApiHttpRequest; } catch { throw new SessionClientError('REQUEST_DENIED'); }
    // Keep the queue across operation reopen. A cancelled queued request releases
    // its own slot without allowing later requests to overtake an in-flight one.
    const previous = this.requestQueue;
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    this.requestQueue = previous.then(() => finished);
    try { await this.abortable(previous, signal); return await this.sendNow<T>(stable, signal, tab); }
    finally { release(); }
  }
  private async sendNow<T>(request: ApiHttpRequest, signal?: AbortSignal, tab?: OwnedTab): Promise<T> {
    const rule = this.rule(request);
    this.check(signal);
    // Clone before dispatch so caller mutation cannot alter an approved request.
    let stable: ApiHttpRequest;
    try { stable = JSON.parse(JSON.stringify(request)) as ApiHttpRequest; } catch { throw new SessionClientError('REQUEST_DENIED'); }
    const input: WireInput = { request: stable, rules: this.rules, maxBytes: this.options.maxResponseBytes ?? 5_000_000, timeoutMs: this.options.requestTimeoutMs ?? 20_000, ...(tab ? { expectedUrl: tab.url } : {}) };
    let dispatched = false;
    const count = () => { dispatched = true; this.dispatches++; if (rule.mutation) this.mutationDispatches++; };
    try {
      let wire: WireResult;
      if (tab) {
        await this.owned(tab);
        await this.beforeDispatch(signal);
        count();
        const results = await this.browser.scripting.executeScript({ target: { tabId: tab.id, documentIds: [tab.documentId] }, world: 'MAIN', func: performWireRequest, args: [input] });
        const frame = results.find(item => item.frameId === 0);
        if (!frame || frame.documentId !== tab.documentId || !frame.result) throw new SessionClientError('DOCUMENT_CHANGED', rule.mutation);
        wire = frame.result;
        this.rememberRateLimit(wire);
        await this.owned(tab);
      } else { await this.beforeDispatch(signal); count(); wire = await performWireRequest(input, this.fetcher, signal); this.rememberRateLimit(wire); }
      if (!wire.dispatched) { this.dispatches--; if (rule.mutation) this.mutationDispatches--; }
      if (!tab) dispatched = wire.dispatched;
      if (signal?.aborted) throw new SessionClientError('CANCELLED', rule.mutation && dispatched);
      if (!wire.ok) throw new SessionClientError(wire.code, rule.mutation && wire.dispatched, wire.status, wire.retryAfterMs);
      return wire.value as T;
    } catch (error) {
      if (error instanceof SessionClientError) throw new SessionClientError(error.code, error.uncertain || (rule.mutation && dispatched), error.status, error.retryAfterMs);
      throw new SessionClientError('NETWORK_UNAVAILABLE', rule.mutation && dispatched);
    }
  }
  private async probe(signal: AbortSignal, tab?: OwnedTab) {
    await this.options.probe(<T>(request: ApiHttpRequest, requestSignal?: AbortSignal) => {
      if (this.rule(request).mutation) throw new SessionClientError('REQUEST_DENIED');
      const controller = new AbortController(); const unlink = this.link(signal, controller); const other = this.link(requestSignal, controller);
      return this.send<T>(request, controller.signal, tab).finally(() => { unlink(); other(); });
    }, signal);
    this.check(signal);
  }
  // Extension-origin reads may be denied even when the ordinary same-origin
  // session is valid. This is called only while selecting a read-only probe;
  // request() never changes transport or retries after dispatch.
  private fallback(error: unknown) { return error instanceof SessionClientError && ['AUTH_REQUIRED', 'NETWORK_UNAVAILABLE', 'FORBIDDEN'].includes(error.code); }
  private connectionFor(mode: SessionConnection['mode']): SessionConnection { return { mode, id: this.connection?.id ?? crypto.randomUUID() }; }
  private async select(signal: AbortSignal, allowAuthFallback = true, directOnly = false): Promise<{ connection: SessionConnection; tab?: OwnedTab }> {
    try { await this.probe(signal); return { connection: this.connectionFor('direct') }; }
    catch (error) {
      if (directOnly || !this.options.allowBackgroundTab || !this.fallback(error) || (!allowAuthFallback && error instanceof SessionClientError && error.code === 'AUTH_REQUIRED')) throw error;
      const tab = await this.createOwned(signal);
      try { await this.probe(signal, tab); return { connection: this.connectionFor('tab'), tab }; }
      catch (failure) { await this.closeOwned(tab); throw failure; }
    }
  }
  async connect(signal?: AbortSignal): Promise<SessionConnection> {
    if (this.operation || this.opening) throw new SessionClientError('BUSY');
    this.profile = 'strict';
    this.connection = undefined;
    const controller = new AbortController(); this.opening = controller; const unlink = this.link(signal, controller);
    let selected: { connection: SessionConnection; tab?: OwnedTab } | undefined;
    let popup: chrome.windows.Window | undefined;
    let popupOwner: OwnedTab | undefined;
    try {
      try { selected = await this.select(controller.signal, false); }
      catch (error) {
        if (!(error instanceof SessionClientError) || error.code !== 'AUTH_REQUIRED') throw error;
        this.check(controller.signal);
        try { popup = await this.browser.windows.create({ url: LOGIN, type: 'popup', width: 900, height: 800, focused: true }); } catch { throw new SessionClientError('NETWORK_UNAVAILABLE'); }
        if (!popup || popup.id === undefined) throw new SessionClientError('NETWORK_UNAVAILABLE');
        const popupId = popup.id;
        if (popup.tabs?.length === 1 && popup.tabs[0].id !== undefined) {
          try { const candidate = await this.document(popup.tabs[0].id); if (candidate.url === LOGIN) popupOwner = candidate; } catch { /* Normal SSO may navigate outside our host access. */ }
        }
        const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
        while (!selected) {
          this.check(controller.signal);
          let popupHome = false;
          try { const current = await this.browser.windows.get(popupId, { populate: true }); popupHome = current.tabs?.length === 1 && current.tabs[0].url === HOME; } catch { throw new SessionClientError('CANCELLED'); }
          if (Date.now() >= deadline) throw new SessionClientError('TIMEOUT');
          try { selected = await this.select(controller.signal, popupHome); }
          catch (failure) { if (!(failure instanceof SessionClientError) || failure.code !== 'AUTH_REQUIRED') throw failure; }
          if (!selected) await this.pause(controller.signal);
        }
      }
      this.check(controller.signal);
      this.connection = selected.connection;
      return { ...selected.connection };
    } finally {
      await this.closeOwned(selected?.tab);
      // The user can navigate the login window elsewhere; close only its sole
      // original tab after it has reached a known HiBob completion page.
      if (popup?.id !== undefined && popup.tabs?.length === 1 && popup.tabs[0].id !== undefined) {
        try {
          const window = await this.browser.windows.get(popup.id, { populate: true });
          if (window.tabs?.length === 1 && window.tabs[0].id === popup.tabs[0].id) {
            if (window.tabs[0].url === HOME) await this.closeOwned(await this.document(popup.tabs[0].id));
            else await this.closeOwned(popupOwner);
          }
        } catch { /* A user-closed or navigated login window is left alone. */ }
      }
      unlink(); if (this.opening === controller) this.opening = undefined;
    }
  }
  async openOperation(signal?: AbortSignal, profile: ExecutionProfile = 'strict', options: { directOnly?: boolean } = {}): Promise<SessionConnection> {
    if (this.operation || this.opening) throw new SessionClientError('BUSY');
    if (profile !== 'strict' && profile !== 'fast-serial') throw new SessionClientError('REQUEST_DENIED');
    this.profile = profile;
    const controller = new AbortController(); this.opening = controller; const unlink = this.link(signal, controller);
    let selected: { connection: SessionConnection; tab?: OwnedTab } | undefined;
    try {
      selected = await this.select(controller.signal, true, options.directOnly === true);
      this.check(controller.signal);
      this.connection = selected.connection;
      this.operation = { ...selected, controller, closing: false, pending: new Set(), detachSignal: unlink };
      return { ...selected.connection };
    } catch (error) { await this.closeOwned(selected?.tab); throw error; }
    finally { if (this.operation?.controller !== controller) { unlink(); this.profile = 'strict'; } if (this.opening === controller) this.opening = undefined; }
  }
  request<T = unknown>(request: ApiHttpRequest, signal?: AbortSignal): Promise<T> {
    const operation = this.operation;
    if (!operation || operation.closing) return Promise.reject(new SessionClientError('NO_OPERATION'));
    const controller = new AbortController(); const unlink = this.link(operation.controller.signal, controller); const other = this.link(signal, controller);
    const pending = this.send<T>(request, controller.signal, operation.tab).finally(() => { unlink(); other(); operation.pending.delete(pending); });
    operation.pending.add(pending);
    return pending;
  }
  cancel() { this.opening?.abort(); this.operation?.controller.abort(); }
  async closeOperation(): Promise<void> {
    const operation = this.operation;
    if (!operation) { if (!this.opening) this.profile = 'strict'; return; }
    operation.closing = true;
    if (operation.pending.size) operation.controller.abort();
    await Promise.allSettled([...operation.pending]);
    await this.closeOwned(operation.tab);
    operation.detachSignal();
    if (this.operation === operation) { this.operation = undefined; this.profile = 'strict'; }
  }
  async disconnect(): Promise<void> { this.cancel(); await this.closeOperation(); this.connection = undefined; }
}
