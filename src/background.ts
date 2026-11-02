import { t } from './i18n/index';
import { BookingController } from './controller';
import { HiBobApiAdapter } from './hibob/api-adapter';
import { isNewerExtensionVersion } from './shared/updates';
import type { AccountConfirmation, AdapterProgress, BookingPlan, PlanEditLease, SessionState } from './shared/types';

const manifest = chrome.runtime.getManifest();
const installedVersion = manifest.version;
const adapter = new HiBobApiAdapter();
const activeJobs = new Map<string, AbortController>();

async function operation<T>(jobId: string, run: (signal: AbortSignal, progress: (value: AdapterProgress) => void) => Promise<T>): Promise<T> {
  if (activeJobs.size) throw new Error(t('Ein HiBob-Vorgang läuft bereits. Bitte dessen Abschluss abwarten.'));
  const abort = new AbortController(); activeJobs.set(jobId, abort);
  const progress = (value: AdapterProgress) => { void controller.reportProgress({ ...value, jobId }).catch(() => {}); };
  try { return await run(abort.signal, progress); }
  finally { if (activeJobs.get(jobId) === abort) activeJobs.delete(jobId); }
}

const controller = new BookingController({
  load: async () => (await chrome.storage.session.get('sessionState')).sessionState as SessionState | undefined,
  save: async state => { await chrome.storage.session.set({ sessionState: state }); },
  connect: () => adapter.connect(),
  disconnect: () => adapter.disconnect(),
  scan: (connection, month, jobId) => operation(jobId, (signal, progress) => adapter.scanMonth(connection, month, progress, signal)),
  applyDay: (connection, day, context, jobId, authorization) => operation(jobId, (signal, progress) => adapter.applyDay(connection, day, context, authorization, progress, signal)),
  preflightDay: (connection, day, context, jobId, authorization) => operation(jobId, (signal, progress) => adapter.preflightDay(connection, day, context, authorization, progress, signal)),
  cancel: async (_connection, jobId) => { const abort = activeJobs.get(jobId); if (abort) { abort.abort(); adapter.cancel(); } },
  recover: (connection, jobId) => adapter.recover(connection, jobId),
  checkUpdateIdle: () => adapter.assertIdle(),
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
  // Opening the extension on another website does not change its HiBob account.
  // Keep sidePanel.open inside the browser's user gesture.
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  void ensureInitialized().catch(() => {});
});

function isPanelSender(url?: string): boolean {
  if (!url) return false;
  try { const actual = new URL(url), expected = new URL(chrome.runtime.getURL('sidepanel.html')); return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname; }
  catch { return false; }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return;
  const m = message as { type: string; month?: string; date?: string; plan?: BookingPlan; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; jobId?: string; confirmation?: AccountConfirmation };
  if (!m.type.startsWith('PANEL_')) return;
  if (sender.id !== chrome.runtime.id || sender.tab || !isPanelSender(sender.url)) { sendResponse({ ok: false, error: t('Diese Aktion ist nur im Extension-Seitenpanel verfügbar.') }); return; }
  void (async () => {
    await ensureInitialized();
    if (m.type === 'PANEL_PREFLIGHT') {
      if (!m.plan) throw new Error(t('Vorschau fehlt.'));
      return { ok: true, ...await controller.preflight(m.plan, m.expectedPlanRevision ?? -1, m.date ?? '', m.confirmation) };
    }
    const state = await (async () => { switch (m.type) {
      case 'PANEL_GET_STATE': return controller.state;
      case 'PANEL_CONNECT': return controller.connect();
      case 'PANEL_DISCONNECT': return controller.disconnect();
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
