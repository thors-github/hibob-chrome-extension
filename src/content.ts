import { t } from './i18n/index';
import { makeUiContextReader } from './hibob/context-reader';
import { assertApplyAuthorization } from './shared/context';
import { AdapterError, HiBobDomAdapter, isAttendanceLocation } from './hibob/adapter';
import type { AdapterCommand, AdapterProgress, AdapterResponse } from './shared/types';

const scope = globalThis as typeof globalThis & { __hibobMonthlyAdapterInstalled?: boolean };
if (!scope.__hibobMonthlyAdapterInstalled && isAttendanceLocation(window.location.href)) {
  scope.__hibobMonthlyAdapterInstalled = true;
  const manifest = chrome.runtime.getManifest();
  const extensionVersion = manifest.version_name ?? manifest.version;
  const adapter = new HiBobDomAdapter({ documentId: crypto.randomUUID(), readContext: makeUiContextReader(document, () => window.location.href) });
  let operation: { id: string; kind: 'scan' | 'apply'; controller: AbortController } | undefined;
  chrome.runtime.onMessage.addListener((message: AdapterCommand, sender, sendResponse: (response: AdapterResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
    if (!['PING', 'CANCEL', 'SCAN_MONTH', 'APPLY_DAY'].includes(message.type)) return false;
    if (!isAttendanceLocation(window.location.href)) { sendResponse({ ok: false, error: t('Bitte zuerst die eigene HiBob-Anwesenheitsseite öffnen.') }); return false; }
    if (message.type === 'PING') { sendResponse({ ok: true, protocolVersion: 3, extensionVersion, activeJob: operation ? { id: operation.id, kind: operation.kind } : undefined }); return false; }
    if (typeof message.jobId !== 'string' || !message.jobId) { sendResponse({ ok: false, error: t('Der laufende Vorgang wurde geändert. Bitte den aktuellen Status prüfen.') }); return false; }
    if (message.type === 'CANCEL') {
      if (operation && operation.id !== message.jobId) sendResponse({ ok: false, error: t('Der laufende Vorgang wurde geändert. Bitte den aktuellen Status prüfen.') });
      else { operation?.controller.abort(); sendResponse({ ok: true }); }
      return false;
    }
    if (message.type === 'APPLY_DAY') {
      try { assertApplyAuthorization(message.context, message.authorization); }
      catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : t('HiBob konnte nicht sicher bedient werden.') }); return false; }
    }
    if (operation) { sendResponse({ ok: false, error: t('Ein HiBob-Vorgang läuft bereits. Bitte dessen Abschluss abwarten.') }); return false; }
    const active = { id: message.jobId, kind: message.type === 'SCAN_MONTH' ? 'scan' as const : 'apply' as const, controller: new AbortController() };
    operation = active;
    const progress = (value: AdapterProgress) => { chrome.runtime.sendMessage({ type: 'ADAPTER_PROGRESS', progress: { ...value, jobId: active.id } }).catch(() => {}); };
    (async () => {
      try {
        if (message.type === 'SCAN_MONTH') sendResponse({ ok: true, snapshot: await adapter.scanMonth(message.month, progress, active.controller.signal) });
        else sendResponse({ ok: true, day: await adapter.applyDay(message.day, progress, active.controller.signal, message.context, message.authorization) });
      } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : t('HiBob konnte nicht sicher bedient werden.'), uncertain: error instanceof AdapterError && error.uncertain }); }
      finally { if (operation === active) operation = undefined; }
    })();
    return true;
  });
}
