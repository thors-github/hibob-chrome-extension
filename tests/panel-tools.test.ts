// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/domain/index';
import { serializeSettingsBackup } from '../src/shared/settings-backup';
import type { SessionState, Settings } from '../src/shared/types';

const preferences = defaultSettings('2026-11');
type Message = { type: string; expectedPlanRevision?: number; changeId?: string };
type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

function chromeMock(initial: SessionState = {}, failPreferences = false) {
  const listeners = new Set<Listener>();
  let state: SessionState = { schemaVersion: 3, revision: 1, planRevision: 0, update: { installedVersion: '1.2.0', pendingVersion: '1.2.1' }, ...initial };
  const setSettings = vi.fn(async () => { if (failPreferences) throw new Error('Storage unavailable'); });
  const sendMessage = vi.fn(async (message: Message) => {
    if (message.type === 'PANEL_INVALIDATE_PLAN') {
      state = { ...state, revision: state.revision! + 1, planRevision: state.planRevision! + 1, plan: undefined, editLease: { planRevision: state.planRevision! + 1, changeId: message.changeId! } };
    }
    if (message.type === 'PANEL_ACTIVATE_UPDATE') state = { ...state, revision: state.revision! + 1, updateApplying: true };
    return { ok: true, state: structuredClone(state) };
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'panel-tools', sendMessage },
    storage: {
      local: { get: vi.fn(async () => ({ settings: structuredClone(preferences) })), set: setSettings },
      onChanged: { addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn) },
    },
  });
  return { sendMessage, setSettings, emit(value: Partial<SessionState>) {
    state = { ...state, ...value, revision: state.revision! + 1 };
    for (const fn of listeners) fn({ sessionState: { newValue: structuredClone(state) } }, 'session');
  } };
}

const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const dialog = () => document.getElementById('import-dialog') as HTMLDialogElement;
async function mount() {
  await import('../src/panel/main');
  await vi.waitFor(() => expect(button('import-settings').disabled).toBe(false));
}
function chooseFile(text: string) {
  const file = new File([text], 'settings.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  Object.defineProperty(input('settings-file'), 'files', { configurable: true, value: [file] });
  input('settings-file').dispatchEvent(new Event('change'));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); document.body.innerHTML = ''; });

describe('panel migration and native update controls', () => {
  it('reviews an import without changing settings, then applies only after confirmation', async () => {
    const chrome = chromeMock();
    await mount();
    const imported: Settings = { ...preferences, start: '07:45', end: '16:15', excludedDates: ['2026-11-05'] };
    chooseFile(serializeSettingsBackup(imported));
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    expect(document.getElementById('import-details')?.textContent).toContain('07:45–16:15');
    expect(input('start').value).toBe('08:00');
    expect(chrome.setSettings).not.toHaveBeenCalled();
    button('confirm-import').click();
    await vi.waitFor(() => expect(chrome.setSettings).toHaveBeenCalledWith({ settings: imported }));
    expect(dialog().open).toBe(false);
    expect(input('start').value).toBe('07:45');
    expect(chrome.sendMessage.mock.calls.some(([m]) => m.type === 'PANEL_INVALIDATE_PLAN')).toBe(true);
    expect(chrome.sendMessage.mock.calls.some(([m]) => m.type === 'PANEL_SCAN' || m.type === 'PANEL_APPLY')).toBe(false);
  });

  it('cancels an import and rejects malformed files without persisting changes', async () => {
    const chrome = chromeMock();
    await mount();
    chooseFile(serializeSettingsBackup({ ...preferences, variable: true }));
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    button('cancel-import').click();
    chooseFile('{broken');
    await vi.waitFor(() => expect(document.getElementById('main-error')?.textContent).toContain('JSON'));
    expect(dialog().open).toBe(false);
    expect(chrome.setSettings).not.toHaveBeenCalled();
    expect(input('variable').checked).toBe(false);
  });

  it('retains the existing storage-failure gate after confirming an import', async () => {
    const chrome = chromeMock({}, true);
    await mount();
    chooseFile(serializeSettingsBackup({ ...preferences, variable: true }));
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    button('confirm-import').click();
    await vi.waitFor(() => expect(document.getElementById('main-error')?.textContent).toContain('Storage unavailable'));
    expect(button('apply').disabled).toBe(true);
    expect(button('retry-plan').hidden).toBe(false);
    expect(chrome.sendMessage.mock.calls.some(([m]) => m.type === 'PANEL_APPLY')).toBe(false);
  });

  it('disables update and transfer controls during a job, then sends only an explicit activation command', async () => {
    const chrome = chromeMock();
    await mount();
    expect(document.getElementById('installed-version')?.textContent).toContain('Version 1.2.0');
    expect(document.getElementById('update-notice')?.textContent).toContain('1.2.1');
    chrome.emit({ job: { id: 'scan', kind: 'scan', status: 'running', tabId: 1, month: '2026-11', startedAt: 'now', updatedAt: 'now' } });
    expect(button('activate-update').disabled).toBe(true);
    expect(button('import-settings').disabled).toBe(true);
    expect(button('export-settings').disabled).toBe(true);
    button('activate-update').click();
    expect(chrome.sendMessage.mock.calls.some(([m]) => m.type === 'PANEL_ACTIVATE_UPDATE')).toBe(false);
    chrome.emit({ job: { id: 'scan', kind: 'scan', status: 'interrupted', tabId: 1, month: '2026-11', startedAt: 'now', updatedAt: 'now' } });
    expect(button('activate-update').disabled).toBe(true);
    expect(document.getElementById('update-notice')?.textContent).toContain('erneutes Einlesen');
    chrome.emit({ job: undefined });
    button('activate-update').click();
    await vi.waitFor(() => expect(chrome.sendMessage).toHaveBeenCalledWith({ type: 'PANEL_ACTIVATE_UPDATE' }));
    expect(button('activate-update').disabled).toBe(true);
    expect(document.getElementById('update-notice')?.textContent).toContain('neu geladen');
  });

  it('closes a pending import review when another panel starts a scan', async () => {
    const chrome = chromeMock();
    await mount();
    chooseFile(serializeSettingsBackup({ ...preferences, variable: true }));
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    chrome.emit({ job: { id: 'scan', kind: 'scan', status: 'running', tabId: 1, month: '2026-11', startedAt: 'now', updatedAt: 'now' } });
    expect(dialog().open).toBe(false);
    button('confirm-import').click();
    expect(chrome.setSettings).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before reading it', async () => {
    const chrome = chromeMock();
    await mount();
    const read = vi.fn(async () => '{}');
    Object.defineProperty(input('settings-file'), 'files', { configurable: true, value: [{ size: 65537, text: read }] });
    input('settings-file').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.getElementById('main-error')?.textContent).toContain('64 KB'));
    expect(read).not.toHaveBeenCalled();
    expect(chrome.setSettings).not.toHaveBeenCalled();
  });
});
