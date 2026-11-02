import { t } from './i18n/index';
import { BookingController } from './controller';
import { HIBOB_ATTENDANCE_PATH, HIBOB_ORIGIN, isHiBobAttendance, isHiBobOrigin } from './shared/validation';
import type { AdapterCommand, AdapterProgress, AdapterResponse, BookingPlan, SessionState } from './shared/types';

class TransportError extends Error {
  constructor(message: string, public readonly uncertain = false) { super(message); }
}
let cancellationGeneration = 0;

async function loaded(tabId: number): Promise<void> {
  if ((await chrome.tabs.get(tabId)).status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error(t('HiBob lädt noch. Bitte erneut versuchen.'))); }, 15000);
    const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => { if (id === tabId && change.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureAdapter(tabId: number, allowHomeNavigation = false): Promise<void> {
  let tab = await chrome.tabs.get(tabId);
  if (allowHomeNavigation && tab.url && new URL(tab.url).origin === HIBOB_ORIGIN && new URL(tab.url).pathname === '/home') {
    await chrome.tabs.update(tabId, { url: `${HIBOB_ORIGIN}${HIBOB_ATTENDANCE_PATH}` });
    await loaded(tabId);
    tab = await chrome.tabs.get(tabId);
  }
  if (!isHiBobAttendance(tab.url)) throw new Error(t('Bitte im verbundenen HiBob-Tab „Time → My attendance“ öffnen und dort erneut einlesen.'));
  try {
    const ping: AdapterResponse = await chrome.tabs.sendMessage(tabId, { type: 'PING' } satisfies AdapterCommand);
    if (ping.ok) return;
  } catch { /* A new page requires explicit injection under the user's activeTab grant. */ }
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
  catch { throw new Error(t('Der Zugriff auf den HiBob-Tab ist abgelaufen. Bitte dort erneut auf das Extension-Symbol klicken.')); }
}

async function request(tabId: number, command: AdapterCommand): Promise<AdapterResponse & { ok: true }> {
  const generation = cancellationGeneration;
  await ensureAdapter(tabId, command.type === 'SCAN_MONTH');
  if (generation !== cancellationGeneration) throw new TransportError(t('Vorgang vor dem Schreiben abgebrochen.'));
  let response: AdapterResponse;
  try { response = await chrome.tabs.sendMessage(tabId, command); }
  catch {
    throw new TransportError(command.type === 'APPLY_DAY' ? t('Verbindung zu HiBob unterbrochen. Den Tag erneut einlesen; nicht ungeprüft wiederholen.') : t('Verbindung zu HiBob unterbrochen. Bitte erneut einlesen.'), command.type === 'APPLY_DAY');
  }
  if (!response || !response.ok) throw new TransportError(response && !response.ok ? response.error : t('HiBob hat nicht geantwortet.'), response && !response.ok ? response.uncertain : command.type === 'APPLY_DAY');
  return response;
}

const controller = new BookingController({
  load: async () => (await chrome.storage.session.get('sessionState')).sessionState as SessionState | undefined,
  save: async state => { await chrome.storage.session.set({ sessionState: state }); },
  scan: async (tabId, month) => { const response = await request(tabId, { type: 'SCAN_MONTH', month }); if (!response.snapshot) throw new Error(t('Kein Monatsstand empfangen.')); return response.snapshot; },
  applyDay: async (tabId, day) => { const response = await request(tabId, { type: 'APPLY_DAY', day }); if (!response.day) throw new TransportError(t('Keine Lesebestätigung nach dem Speichern empfangen.'), true); return response.day; },
  cancel: async tabId => { cancellationGeneration++; await chrome.tabs.sendMessage(tabId, { type: 'CANCEL' } satisfies AdapterCommand); },
});
const ready = controller.init();

chrome.action.onClicked.addListener(tab => {
  // Must happen synchronously within the browser's user gesture.
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  void ready.then(async () => {
    const supported = tab.id !== undefined && isHiBobOrigin(tab.url);
    await controller.bindTab(supported ? tab.id : undefined, supported ? undefined : t('Bitte HiBob öffnen und dort auf das Extension-Symbol klicken.'));
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return;
  const m = message as { type: string; month?: string; plan?: BookingPlan; progress?: AdapterProgress };
  if (m.type === 'ADAPTER_PROGRESS') {
    void ready.then(async () => { if (sender.id === chrome.runtime.id && sender.tab?.id === controller.state.tabId && m.progress) await controller.reportProgress(m.progress); });
    return;
  }
  if (!m.type.startsWith('PANEL_')) return;
  // Web content and content scripts cannot initiate bookings through the controller.
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(chrome.runtime.getURL('sidepanel.html'))) {
    sendResponse({ ok: false, error: t('Diese Aktion ist nur im Extension-Seitenpanel verfügbar.') });
    return;
  }
  void (async () => {
    await ready;
    switch (m.type) {
      case 'PANEL_GET_STATE': return controller.state;
      case 'PANEL_SCAN': return controller.scan(m.month ?? '');
      case 'PANEL_SAVE_PLAN': if (!m.plan) throw new Error(t('Vorschau fehlt.')); return controller.savePlan(m.plan);
      case 'PANEL_APPLY': if (!m.plan) throw new Error(t('Vorschau fehlt.')); return controller.apply(m.plan);
      case 'PANEL_CANCEL': await controller.cancel(); return controller.state;
      default: throw new Error(t('Unbekannte Aktion.'));
    }
  })().then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, state: controller.state, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
