import { t } from './i18n/index';
import { BookingController } from './controller';
import { HIBOB_ATTENDANCE_PATH, HIBOB_ORIGIN, isHiBobAttendance, isHiBobOrigin } from './shared/validation';
import { isNewerExtensionVersion } from './shared/updates';
import type { AccountConfirmation, AdapterCommand, AdapterProgress, AdapterResponse, BookingPlan, PlanEditLease, SessionState } from './shared/types';

class TransportError extends Error { constructor(message: string, public readonly uncertain = false) { super(message); } }
let cancellationGeneration = 0;
const manifest = chrome.runtime.getManifest();
const installedVersion = manifest.version;
const adapterBuildVersion = manifest.version_name ?? installedVersion;

async function loaded(tabId: number): Promise<void> {
  if ((await chrome.tabs.get(tabId)).status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => { if (id === tabId && change.status === 'complete') finish(); };
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error(t('HiBob lädt noch. Bitte erneut versuchen.'))); }, 15000);
    chrome.tabs.onUpdated.addListener(listener);
    // Close the gap between the first get() and installing the update listener.
    void chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(); }).catch(error => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); reject(error); });
  });
}

async function ensureAdapter(tabId: number, allowHomeNavigation = false): Promise<AdapterResponse & { ok: true }> {
  let tab = await chrome.tabs.get(tabId);
  if (allowHomeNavigation && tab.url && new URL(tab.url).origin === HIBOB_ORIGIN && new URL(tab.url).pathname === '/home') {
    await chrome.tabs.update(tabId, { url: `${HIBOB_ORIGIN}${HIBOB_ATTENDANCE_PATH}` }); await loaded(tabId); tab = await chrome.tabs.get(tabId);
  }
  if (!isHiBobAttendance(tab.url)) throw new Error(t('Bitte im verbundenen HiBob-Tab „Time → My attendance“ öffnen und dort erneut einlesen.'));
  let ping: AdapterResponse | undefined;
  try { ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' } satisfies AdapterCommand); } catch { /* This document may need injection. */ }
  if (!ping) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
    catch { throw new Error(t('Der Zugriff auf den HiBob-Tab ist abgelaufen. Bitte dort erneut auf das Extension-Symbol klicken.')); }
    try { ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' } satisfies AdapterCommand); } catch { /* Report a protocol-safe recovery action below. */ }
  }
  if (!ping?.ok || ping.protocolVersion !== 4 || ping.extensionVersion !== adapterBuildVersion) throw new Error(t('Der HiBob-Tab verwendet eine ältere oder nicht erreichbare Verbindung. Bitte den HiBob-Tab neu laden und die Erweiterung dort erneut öffnen.'));
  return ping;
}

async function recoverAdapter(tabId: number, jobId: string): Promise<void> {
  let ping = await ensureAdapter(tabId);
  if (!ping.activeJob) return;
  if (ping.activeJob.id !== jobId) throw new Error(t('Im HiBob-Tab läuft noch ein anderer Vorgang. Bitte dessen Abschluss abwarten oder den Tab neu laden.'));
  await chrome.tabs.sendMessage(tabId, { type: 'CANCEL', jobId } satisfies AdapterCommand);
  const deadline = Date.now() + 8000;
  do {
    await new Promise(resolve => setTimeout(resolve, 100));
    ping = await ensureAdapter(tabId);
    if (!ping.activeJob) return;
  } while (Date.now() < deadline && ping.activeJob.id === jobId);
  throw new Error(t('Der unterbrochene Vorgang ist noch nicht beendet. Bitte den HiBob-Tab neu laden und den Monat erneut einlesen.'));
}

async function request(tabId: number, command: AdapterCommand): Promise<AdapterResponse & { ok: true }> {
  const generation = cancellationGeneration;
  const ping = await ensureAdapter(tabId, command.type === 'SCAN_MONTH');
  if (generation !== cancellationGeneration) throw new TransportError(t('Vorgang vor dem Schreiben abgebrochen.'));
  if (ping.activeJob) throw new TransportError(t('Ein HiBob-Vorgang läuft bereits. Bitte dessen Abschluss abwarten.'));
  let response: AdapterResponse;
  try { response = await chrome.tabs.sendMessage(tabId, command); }
  catch { throw new TransportError(command.type === 'APPLY_DAY' ? t('Verbindung zu HiBob unterbrochen. Den Tag erneut einlesen; nicht ungeprüft wiederholen.') : t('Verbindung zu HiBob unterbrochen. Bitte erneut einlesen.'), command.type === 'APPLY_DAY'); }
  if (!response || !response.ok) throw new TransportError(response && !response.ok ? response.error : t('HiBob hat nicht geantwortet.'), response && !response.ok ? response.uncertain : command.type === 'APPLY_DAY');
  return response;
}

const controller = new BookingController({
  load: async () => (await chrome.storage.session.get('sessionState')).sessionState as SessionState | undefined,
  save: async state => { await chrome.storage.session.set({ sessionState: state }); },
  scan: async (tabId, month, jobId) => { const response = await request(tabId, { type: 'SCAN_MONTH', month, jobId }); if (!response.snapshot) throw new Error(t('Kein Monatsstand empfangen.')); return response.snapshot; },
  applyDay: async (tabId, day, context, jobId, authorization) => { const response = await request(tabId, { type: 'APPLY_DAY', day, context, jobId, authorization }); if (!response.day) throw new TransportError(t('Keine Lesebestätigung nach dem Speichern empfangen.'), true); return response.day; },
  checkDayDraft: async (tabId, day, context, jobId, authorization) => { const response = await request(tabId, { type: 'CHECK_DAY_DRAFT', day, context, jobId, authorization }); if (!response.draftCheck) throw new TransportError(t('Die Entwurfsprüfung hat keine eindeutige Bestätigung für den unveränderten Tag geliefert. Bitte den Monat erneut einlesen.')); return response.draftCheck; },
  cancel: async (tabId, jobId) => { cancellationGeneration++; await chrome.tabs.sendMessage(tabId, { type: 'CANCEL', jobId } satisfies AdapterCommand); },
  recover: recoverAdapter,
  checkUpdateIdle: async tabId => {
    if (tabId === undefined) return;
    const tab = await chrome.tabs.get(tabId);
    if (!isHiBobAttendance(tab.url)) return;
    // A missing reply can be an invalidated old context, not proof of idleness.
    // A fresh document can be injected, but must acknowledge this exact build
    // before activation; an old guard/no receiver requires a user page reload.
    const ping = await ensureAdapter(tabId);
    if (ping.activeJob) throw new Error(t('Im HiBob-Tab läuft noch ein Vorgang. Bitte dessen Abschluss abwarten oder den Tab neu laden.'));
  },
  reload: () => chrome.runtime.reload(),
});
let initialization: Promise<void> | undefined;
let announcedUpdateVersion: string | undefined;
// Register synchronously, before loading session state. A notification arriving
// during startup is remembered and cannot be overwritten by the older load.
chrome.runtime.onUpdateAvailable.addListener(details => {
  if (!isNewerExtensionVersion(details.version, installedVersion)) return;
  if (!announcedUpdateVersion || isNewerExtensionVersion(details.version, announcedUpdateVersion)) announcedUpdateVersion = details.version;
  void ensureInitialized().then(() => controller.configureUpdates(installedVersion, announcedUpdateVersion)).catch(() => {});
});
function ensureInitialized(): Promise<void> {
  if (!initialization) {
    const attempt = controller.init().then(() => controller.configureUpdates(installedVersion, announcedUpdateVersion)); initialization = attempt;
    void attempt.catch(() => { if (initialization === attempt) initialization = undefined; });
  }
  return initialization;
}
void ensureInitialized().catch(() => {});

chrome.action.onClicked.addListener(tab => {
  // Keep this call within the browser's user gesture.
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  void ensureInitialized().then(async () => {
    const supported = tab.id !== undefined && isHiBobOrigin(tab.url);
    await controller.bindTab(supported ? tab.id : undefined, supported ? undefined : t('Bitte HiBob öffnen und dort auf das Extension-Symbol klicken.'));
  }).catch(error => { controller.state.error = error instanceof Error ? error.message : String(error); });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return;
  const m = message as { type: string; month?: string; date?: string; plan?: BookingPlan; progress?: AdapterProgress; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; jobId?: string; confirmation?: AccountConfirmation };
  if (m.type === 'ADAPTER_PROGRESS') {
    void ensureInitialized().then(async () => { if (sender.id === chrome.runtime.id && sender.tab?.id === controller.state.tabId && m.progress) await controller.reportProgress(m.progress); }).catch(() => {});
    return;
  }
  if (!m.type.startsWith('PANEL_')) return;
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(chrome.runtime.getURL('sidepanel.html'))) { sendResponse({ ok: false, error: t('Diese Aktion ist nur im Extension-Seitenpanel verfügbar.') }); return; }
  void (async () => {
    await ensureInitialized();
    if (m.type === 'PANEL_CHECK_DRAFT') {
      if (!m.plan) throw new Error(t('Vorschau fehlt.'));
      return { ok: true, ...await controller.checkDraft(m.plan, m.expectedPlanRevision ?? -1, m.date ?? '', m.confirmation) };
    }
    const state = await (async () => { switch (m.type) {
      case 'PANEL_GET_STATE': return controller.state;
      case 'PANEL_SCAN': return controller.scan(m.month ?? '');
      case 'PANEL_INVALIDATE_PLAN': return controller.invalidatePlan(m.expectedPlanRevision ?? -1, m.changeId ?? '');
      case 'PANEL_SAVE_PLAN': if (!m.plan || !m.lease) throw new Error(t('Vorschau fehlt.')); return controller.savePlan(m.plan, m.lease);
      case 'PANEL_APPLY': if (!m.plan) throw new Error(t('Vorschau fehlt.')); return controller.apply(m.plan, m.expectedPlanRevision ?? -1, m.confirmation);
      case 'PANEL_CANCEL': if (!m.jobId) throw new Error(t('Der laufende Vorgang wurde geändert. Bitte den aktuellen Status prüfen.')); await controller.cancel(m.jobId); return controller.state;
      case 'PANEL_ACTIVATE_UPDATE': return controller.activateUpdate();
      default: throw new Error(t('Unbekannte Aktion.'));
    } })();
    return { ok: true, state };
  })().then(response => sendResponse(response)).catch(error => sendResponse({ ok: false, state: controller.state, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
