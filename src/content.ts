import { t } from './i18n/index';
import { AdapterError, HiBobDomAdapter, isAttendanceLocation } from './hibob/adapter';
import type { AdapterCommand, AdapterProgress, AdapterResponse } from './shared/types';

// Re-injection after a lost PING must not install a second writer.
const scope = globalThis as typeof globalThis & { __hibobMonthlyAdapterInstalled?: boolean };
if (!scope.__hibobMonthlyAdapterInstalled && isAttendanceLocation(window.location.href)) {
  scope.__hibobMonthlyAdapterInstalled = true;
  const adapter = new HiBobDomAdapter();
  let operation: AbortController | undefined;
  const progress = (value: AdapterProgress) => {
    chrome.runtime.sendMessage({ type: 'ADAPTER_PROGRESS', progress: value }).catch(() => {});
  };

  chrome.runtime.onMessage.addListener((message: AdapterCommand, sender, sendResponse: (response: AdapterResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
    if (!['PING', 'CANCEL', 'SCAN_MONTH', 'APPLY_DAY'].includes(message.type)) return false;
    if (!isAttendanceLocation(window.location.href)) { sendResponse({ ok: false, error: t('Bitte zuerst die eigene HiBob-Anwesenheitsseite öffnen.') }); return false; }
    if (message.type === 'PING') { sendResponse({ ok: true }); return false; }
    if (message.type === 'CANCEL') { operation?.abort(); sendResponse({ ok: true }); return false; }
    if (operation) { sendResponse({ ok: false, error: t('Ein HiBob-Vorgang läuft bereits. Bitte dessen Abschluss abwarten.') }); return false; }
    const controller = new AbortController();
    operation = controller;
    (async () => {
      try {
        if (message.type === 'SCAN_MONTH') sendResponse({ ok: true, snapshot: await adapter.scanMonth(message.month, progress, controller.signal) });
        else if (message.type === 'APPLY_DAY') sendResponse({ ok: true, day: await adapter.applyDay(message.day, progress, controller.signal) });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : t('HiBob konnte nicht sicher bedient werden.'), uncertain: error instanceof AdapterError && error.uncertain });
      } finally { operation = undefined; }
    })();
    return true;
  });
}
