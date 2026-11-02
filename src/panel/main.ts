import './styles.css';
import { buildMonthPlan, defaultSettings, formatMinutes, GERMAN_STATES, netMinutes } from '../domain/index';
import type { AccountConfirmation, AttendanceEntry, BookingPlan, ConflictChoices, DayPlan, PreflightResult, MonthSnapshot, PlanEditLease, SessionState, Settings } from '../shared/types';
import { sameJsonValue } from '../shared/json';
import { contextFingerprint } from '../shared/context';
import { createDemoSnapshot, demoFingerprint } from './demo';
import { language, locale, localizeText, t } from '../i18n/index';
import { MAX_SETTINGS_BACKUP_BYTES, parseSettingsBackup, serializeSettingsBackup } from '../shared/settings-backup';
import { version as packageVersion } from '../../package.json';
import extensionManifest from '../../public/manifest.json';

document.documentElement.lang = language();
document.title = t('HiBob · Monatsbuchung');

const isDemo = new URLSearchParams(location.search).get('demo') === '1';
const hasExtension = !isDemo && typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
let settings = defaultSettings();
let state: SessionState = {};
let plan: BookingPlan | undefined;
let choices: ConflictChoices = {};
let seed = freshSeed();
let busy = false;
let applying = false;
let connecting = false;
let checkingPreflight = false;
let preflightResult: PreflightResult | undefined;
let preflightNeedsScan = false;
let rebuilding = false;
let demoCancelled = false;
let localError = '';
let demoSnapshot: MonthSnapshot | undefined;
let demoCheckpointDates: string[] = [];
let buildVersion = 0;
let sessionRevision = 0;
let initializing = true;
let initializationFailed = false;
let preferencesLoaded = !hasExtension;
let connectionRetryAvailable = false;
let approvedPlanRevision: number | undefined;
let confirmed: { plan: BookingPlan; planRevision: number; contextFingerprint: string; preflightDate: string; resumeJobId?: string; checkpointId?: string } | undefined;
let pendingDraft: Draft | undefined;
let invalidations: Promise<void> = Promise.resolve();
let preferenceWrites: Promise<void> = Promise.resolve();
let refreshScheduled = false;
let importCandidate: Settings | undefined;
let importGeneration = 0;
let updateRequested = false;
let announcedCheckpointId: string | undefined;
let statePollTimer: ReturnType<typeof setTimeout> | undefined;
let statePollInFlight = false;
let statePollError = '';
let panelClosed = false;

interface Draft {
  version: number;
  changeId: string;
  settings: Settings;
  choices: ConflictChoices;
  seed: number;
  lease?: PlanEditLease;
  preferencesSaved: boolean;
}

type PanelMessage = { type: string; month?: string; date?: string; plan?: BookingPlan; planId?: string; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; jobId?: string; confirmation?: AccountConfirmation; options?: { checkpointDates: string[] } };
type PanelResponse = { ok: boolean; state?: SessionState; error?: string; preflight?: PreflightResult };

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <header class="app-header">
      <div class="app-mark" aria-hidden="true"><img src="/icons/app-icon.svg" alt="" width="40" height="40" /></div>
      <div><h1>${t("Monatsbuchung")}</h1><p>${t("Deine Anwesenheit in HiBob")}</p></div>
      <button id="settings-toggle" class="icon-button" type="button" aria-label="${t('Zeiten und Feiertage anpassen')}" aria-controls="settings-options" aria-expanded="false"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9.5 3-.7 2.2-2 .9-2.1-.5-2.1 3.7 1.5 1.7v2l-1.5 1.7 2.1 3.7 2.2-.5 2 .9.6 2.2h4.3l.7-2.2 1.9-.9 2.2.5 2.1-3.7-1.5-1.7v-2l1.5-1.7-2.1-3.7-2.2.5-1.9-.9-.7-2.2z"/><circle cx="11.7" cy="12" r="3.2"/></svg></button>
    </header>
    <div id="update-notice" class="notice" role="status" hidden></div>
    <div id="demo-banner" class="demo-banner" hidden><strong>${t("Lokaler Testmodus")}</strong>${t("Diese Vorschau verwendet Beispieldaten. Es werden keine Daten an HiBob gesendet.")}</div>
    <div id="connection" class="connection"><span class="connection-dot" aria-hidden="true"></span><div><p id="connection-title">${t("Mit HiBob verbinden")}</p><p id="connection-detail" class="muted">${t("Melde dich über HiBob an, um deine Anwesenheiten einzulesen.")}</p></div></div>
    <div class="connection-actions"><button id="connect" class="button primary wide">${t("Mit HiBob anmelden")}</button><button id="disconnect" class="button subtle" hidden>${t("Verbindung trennen")}</button></div>
    <div id="api-capability-notice" class="notice" role="status" hidden></div>
    <div id="account-context-notice" class="notice" role="status" hidden>${t('Prüfe vor dem Speichern das angezeigte HiBob-Konto und die Firma. Die Zuordnung bestätigst du für diesen Plan im nächsten Schritt.')}</div>
    <div id="main-error" class="notice error" role="alert" hidden></div>
    <button id="retry-plan" class="button wide" hidden>${t('Vorschau erneut prüfen')}</button>
    <button id="retry-connection" class="button wide" hidden>${t('Verbindung erneut prüfen')}</button>
    <section aria-labelledby="settings-title">
      <h2 id="settings-title" class="visually-hidden">${t("Zeiten festlegen")}</h2>
      <form id="settings-form">
        <fieldset id="settings-fieldset">
          <div class="field month-field"><label for="month">${t("Monat")}</label><input id="month" name="month" type="month" required /></div>
          <button id="schedule-summary" class="schedule-summary" type="button" aria-controls="settings-options" aria-expanded="false"><strong id="schedule-hours"></strong><span id="schedule-details"></span><span class="summary-edit">${t('Anpassen')}</span></button>
          <div id="settings-options" hidden>
          <div class="section-title"><h2>${t('Zeiten und Feiertage')}</h2><small>${t("Montag bis Freitag")}</small></div>
          <div class="fields">
            <div class="field state-field"><label for="state">${t("Bundesland")}</label><select id="state" name="state" required></select></div>
            <div class="field"><label for="start">${t("Arbeitsbeginn")}</label><input id="start" name="start" type="time" required /></div>
            <div class="field"><label for="end">${t("Arbeitsende")}</label><input id="end" name="end" type="time" required /></div>
          </div>
          <div class="toggle-row"><label for="useBreak"><input id="useBreak" name="useBreak" type="checkbox" />${t("Pause berücksichtigen")}</label><small>${t("unbezahlt")}</small></div>
          <div id="break-fields" class="fields subfields">
            <div class="field"><label for="breakStart">${t("Pause von")}</label><input id="breakStart" name="breakStart" type="time" /></div>
            <div class="field"><label for="breakEnd">${t("Pause bis")}</label><input id="breakEnd" name="breakEnd" type="time" /></div>
          </div>
          <div class="variation-box">
            <div class="toggle-row"><label for="variable"><input id="variable" name="variable" type="checkbox" />${t("Variable Zeiten")}</label></div>
            <p id="variation-summary" class="hint" style="margin-top:6px">${t("Jeden Tag die angegebenen Uhrzeiten verwenden.")}</p>
            <div id="variation-controls" class="range-field" hidden>
              <div class="range-label"><label for="variationMinutes">${t("Spielraum für Beginn und Ende")}</label><output id="variation-value" for="variationMinutes">${t('±{minutes} Min.', { minutes: 5 })}</output></div>
              <input id="variationMinutes" name="variationMinutes" type="range" min="0" max="30" step="1" />
              <p class="hint">${t("Die Pause bleibt fest. Fünf Arbeitstage ergeben genau 40 Netto-Stunden; Teilwochen werden anteilig berechnet.")}</p>
            </div>
          </div>
          <div id="local-holidays" class="local-holidays" hidden>
            <p class="hint">${t("Für diesen Arbeitsort gelten teilweise örtliche Feiertage. Bitte die zutreffenden Angaben wählen.")}</p>
            <div id="augsburg-field" class="field" hidden><label for="augsburg">${t("Arbeitsort in der Stadt Augsburg?")}</label><select id="augsburg"><option value="">${t("Bitte auswählen")}</option><option value="yes">${t("Ja")}</option><option value="no">${t("Nein")}</option></select></div>
            <div id="assumption-field" class="field" hidden><label for="assumption">${t("Mariä Himmelfahrt am Arbeitsort Feiertag?")}</label><select id="assumption"><option value="">${t("Bitte auswählen")}</option><option value="yes">${t("Ja")}</option><option value="no">${t("Nein")}</option></select></div>
            <div id="corpus-field" class="field" hidden><label for="corpusChristi">${t("Fronleichnam am Arbeitsort Feiertag?")}</label><select id="corpusChristi"><option value="">${t("Bitte auswählen")}</option><option value="yes">${t("Ja")}</option><option value="no">${t("Nein")}</option></select></div>
          </div>
          <details><summary>${t("Zusätzliche Tage ausschließen")}</summary><div class="field"><label for="excludedDates">${t("Datumsangaben")}</label><textarea id="excludedDates" rows="2" placeholder="2026-11-05&#10;2026-11-18"></textarea><p class="hint">${t("Ein Datum pro Zeile im Format JJJJ-MM-TT. Tage lassen sich auch direkt in der Vorschau abwählen.")}</p></div></details>
          </div>
        </fieldset>
      </form>
      <details id="more-options" class="more-options"><summary>${t('Weitere Optionen')}</summary><button id="refresh-month" class="button wide" hidden>${t('Monat erneut einlesen')}</button><button id="redistribute" class="button wide" hidden>${t("Neu verteilen")}</button><details class="settings-transfer"><summary>${t('Einstellungen übertragen')}</summary><p class="hint">${t('Übertrage deine Vorgaben zwischen Installationen. HiBob-Daten und Buchungsverläufe werden nicht exportiert.')}</p><div class="transfer-actions"><button id="export-settings" class="button">${t('Einstellungen exportieren')}</button><button id="import-settings" class="button">${t('Einstellungen importieren')}</button></div><input id="settings-file" type="file" accept="application/json,.json" hidden /><p id="transfer-status" class="hint" role="status" hidden></p></details><div class="version-bar"><span id="installed-version"></span><button id="activate-update" class="button subtle" hidden>${t('Jetzt aktualisieren')}</button></div><p id="connection-technical" class="hint"></p></details>
      <div id="scan-toolbar" class="scan-toolbar"><button id="scan" class="button primary wide" disabled>${t("Monat einlesen")}</button></div>
    </section>
    <section id="scan-progress" class="notice" role="status" hidden></section>
    <section id="draft-check-result" class="notice draft-check-result" role="status" aria-labelledby="draft-check-result-title" hidden><h2 id="draft-check-result-title">${t('Plan geprüft – nicht gespeichert')}</h2><dl id="draft-check-details" class="confirm-details"></dl><p class="hint">${t('Kontozuordnung und Tagesdaten wurden lesend geprüft. Die Speicherung wurde nicht getestet. Lies den Monat erneut ein, um weiterzuarbeiten.')}</p></section>
    <section class="preview" aria-labelledby="preview-title">
      <div class="section-title"><div><h2 id="preview-title">${t("Monatsvorschau")}</h2><p id="preview-subtitle" class="preview-subtitle">${t("Vor dem Buchen alle Änderungen prüfen.")}</p></div></div>
      <div id="preview-empty" class="empty-preview"><strong>${t("Dein Monat auf einen Blick")}</strong><p>${t("Lies zuerst den Monat aus HiBob ein. Feiertage, Abwesenheiten und bestehende Einträge werden berücksichtigt.")}</p></div>
      <button id="build-preview" class="button wide" hidden>${t('Vorschau erstellen')}</button>
      <div id="preview-summary" class="preview-summary" hidden></div>
      <button id="conflicts" class="button wide conflict-button" hidden></button>
      <div id="plan-errors" class="notice error" role="alert" hidden></div>
      <div id="weeks"></div>
    </section>
    <section id="paused-card" class="notice paused-card" hidden aria-labelledby="paused-title"><h2 id="paused-title">${t('Für Kontrolle pausiert')}</h2><p id="paused-description"></p><button id="continue-run" class="button primary wide">${t('Restliche Tage fortsetzen')}</button></section>
    <section id="run-panel" class="run-panel" aria-labelledby="run-title" hidden><h2 id="run-title">${t("Buchungsverlauf")}</h2><div id="run-status" class="run-summary" aria-live="polite"></div><div id="run-uncertain" class="notice error" role="alert" hidden></div><details id="run-history"><summary>${t('Einzelne Ergebnisse')}</summary><ul id="run-results" class="run-results"></ul></details></section>
    <footer id="booking-footer" class="footer"><div class="footer-buttons"><button id="cancel-run" class="button danger" hidden>${t('Restliche Tage stoppen')}</button><button id="apply" class="button primary" disabled>${t("Jetzt buchen")}</button></div><p id="footer-hint" class="hint">${t("Es wird erst nach deiner Bestätigung gespeichert.")}</p></footer>
  </div>
  <dialog id="conflict-dialog" aria-labelledby="conflict-title"><div class="dialog-body"><h2 id="conflict-title">${t("Vorhandene Buchungen prüfen")}</h2><p class="hint">${t("Entscheide für jeden Tag. Beim Überschreiben werden die bisherigen Arbeits- und Pauseneinträge durch die Vorschau ersetzt.")}</p><div class="dialog-toolbar"><button id="overwrite-all" class="button">${t("Alle überschreiben")}</button><button id="skip-all" class="button">${t("Alle überspringen")}</button></div><div id="conflict-error" class="notice error" role="alert" style="margin-top:12px" hidden></div><div id="conflict-items"></div></div><div class="dialog-footer"><button id="close-conflicts" class="button">${t("Zurück")}</button><button id="save-conflicts" class="button primary">${t("Entscheidungen übernehmen")}</button></div></dialog>
  <dialog id="apply-dialog" aria-labelledby="apply-title"><div class="dialog-body"><h2 id="apply-title">${t("Buchungen jetzt speichern?")}</h2><p id="apply-description" class="hint"></p><dl id="apply-details" class="confirm-details"></dl><div id="account-confirmation-field" class="notice account-confirmation" hidden><label class="ack-label" for="account-confirmation"><input id="account-confirmation" type="checkbox" /><span id="account-confirmation-label"></span></label></div><details id="additional-checks" class="additional-checks"><summary>${t('Zusätzliche Prüfungen')}</summary><div id="checkpoint-field" class="checkpoint-field"><label class="ack-label" for="pause-verification"><input id="pause-verification" type="checkbox" /><span>${t('Für Kontrolle pausieren')}</span></label><p id="checkpoint-description" class="hint"></p></div><div id="preflight-controls" class="draft-check-controls field"><label for="draft-check-date">${t('Tag für Planprüfung')}</label><select id="draft-check-date" disabled></select><p class="hint">${t('Der ausgewählte Tag und die geplanten Daten werden ohne Änderungen geprüft. Das bestätigt keine serverseitige Speicherung. Danach den Monat erneut einlesen.')}</p><button id="check-draft" class="button wide" disabled>${t('Plan prüfen – ohne Speichern')}</button></div></details><p class="hint">${t("Die Extension kontrolliert jeden gespeicherten Tag. Bei einer Abweichung stoppt der Lauf.")}</p></div><div class="dialog-footer"><button id="close-apply" class="button">${t("Zurück")}</button><button id="confirm-apply" class="button primary" disabled>${t("Buchungen starten")}</button></div></dialog>
  <dialog id="import-dialog" aria-labelledby="import-title"><div class="dialog-body"><h2 id="import-title">${t('Einstellungen importieren?')}</h2><p class="hint">${t('Diese Vorgaben ersetzen deine aktuellen Einstellungen. Der Import startet keine Buchungen; prüfe danach die Monatsvorschau.')}</p><dl id="import-details" class="confirm-details"></dl></div><div class="dialog-footer"><button id="cancel-import" class="button">${t('Abbrechen')}</button><button id="confirm-import" class="button primary">${t('Einstellungen übernehmen')}</button></div></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const conflictDialog = $<HTMLDialogElement>('conflict-dialog');
const applyDialog = $<HTMLDialogElement>('apply-dialog');
const importDialog = $<HTMLDialogElement>('import-dialog');
$('more-options').append($('disconnect'));
const exportPlanButton = node('button', t('Buchungsplan herunterladen'), 'button wide');
exportPlanButton.id = 'export-plan'; exportPlanButton.type = 'button'; exportPlanButton.hidden = true;
const exportPlanHint = node('p', t('Enthält private Anwesenheitsdaten. Nur lokal und vertraulich verwenden.'), 'hint');
exportPlanHint.id = 'export-plan-hint'; exportPlanHint.hidden = true;
const exportPlanStatus = node('p', undefined, 'hint'); exportPlanStatus.id = 'export-plan-status'; exportPlanStatus.hidden = true; exportPlanStatus.setAttribute('role', 'status');
$('more-options').append(exportPlanButton, exportPlanHint, exportPlanStatus);
document.querySelector('.preview')!.before($('paused-card'));

function setSettingsOpen(open: boolean): void {
  $('settings-options').hidden = !open;
  for (const id of ['settings-toggle', 'schedule-summary']) $(id).setAttribute('aria-expanded', String(open));
}

function revealInvalidSettings(): boolean {
  const form = $<HTMLFormElement>('settings-form');
  const invalid = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid, select:invalid, textarea:invalid');
  if (invalid) {
    setSettingsOpen(true);
    for (let parent = invalid.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    invalid.focus();
  }
  return form.reportValidity();
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function freshSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function dateLabel(date: string, weekday = true): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(locale(), { day: '2-digit', month: '2-digit', ...(weekday ? { weekday: 'short' } : {}), timeZone: 'Europe/Berlin' }).format(parsed);
}

function monthLabel(month: string): string {
  const parsed = new Date(`${month}-01T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return month;
  return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(parsed);
}

function entriesElement(entries: AttendanceEntry[], showType = false): HTMLElement {
  const wrapper = node('span', undefined, 'entry-list');
  if (!entries.length) return node('span', '—', 'muted');
  for (const entry of entries) {
    const interval = `${entry.start || t('offen')}–${entry.end || t('offen')}`;
    wrapper.append(node('span', entry.type === 'break' ? t('Pause {interval}', { interval }) : showType ? `${t('Arbeit')} ${interval}` : interval, `entry ${entry.type}`));
  }
  return wrapper;
}

function detailsLine(list: HTMLElement, title: string, content: string | HTMLElement): void {
  list.append(node('dt', title));
  const description = node('dd');
  description.append(content);
  list.append(description);
}

function metadata(entries: AttendanceEntry[]): string[] {
  return entries.flatMap((entry) => [entry.note ? t('Notiz: {note}', { note: entry.note }) : '', entry.reason ? t('Grund: {reason}', { reason: entry.reason }) : '', ...(entry.metadata ?? [])]).filter(Boolean);
}

function activeJob(): SessionState['job'] | undefined {
  return state.job && (state.job.status === 'running' || state.job.status === 'cancelling') ? state.job : undefined;
}

function pausedJob(): SessionState['job'] | undefined { return state.job?.status === 'paused' && state.run?.status === 'paused' ? state.job : undefined; }
function isPaused(): boolean { return Boolean(pausedJob()); }

function isRunning(): boolean { return busy || applying || checkingPreflight || connecting || Boolean(activeJob()) || (!state.job && state.run?.status === 'running'); }

function shouldPollState(): boolean {
  return hasExtension && !panelClosed && app.isConnected && document.visibilityState !== 'hidden' && !initializing && !initializationFailed
    && connected() && !updating() && Boolean(activeJob() || state.run?.status === 'running');
}

function synchronizeStatePolling(immediate = false): void {
  if (!shouldPollState()) {
    if (statePollTimer !== undefined) clearTimeout(statePollTimer);
    statePollTimer = undefined;
    return;
  }
  if (statePollTimer !== undefined || statePollInFlight) return;
  statePollTimer = setTimeout(() => {
    statePollTimer = undefined;
    if (!shouldPollState()) return;
    statePollInFlight = true;
    // Session storage may fail after an early booking acknowledgement. Read
    // the worker's newer in-memory journal; never replay a booking command.
    void message({ type: 'PANEL_GET_STATE' }).then(() => {
      statePollError = '';
    }).catch(() => {
      statePollError = t('Der aktuelle Buchungsstatus konnte nicht gelesen werden. Keine Buchung erneut starten; bitte die Verbindung prüfen.');
    }).finally(() => {
      statePollInFlight = false;
      renderState();
    });
  }, immediate ? 0 : 5000);
}

const statePollingVisibility = () => synchronizeStatePolling(true);
document.addEventListener('visibilitychange', statePollingVisibility);
window.addEventListener('pagehide', () => {
  panelClosed = true;
  synchronizeStatePolling();
  document.removeEventListener('visibilitychange', statePollingVisibility);
}, { once: true });

function updating(): boolean { return updateRequested || state.updateApplying === true; }

function transferBlocked(): boolean { return isRunning() || isPaused() || updating() || initializing || initializationFailed || !preferencesLoaded || rebuilding || Boolean(pendingDraft); }

function planRevision(): number { return state.planRevision ?? 0; }

function closeConfirmation(): void {
  confirmed = undefined;
  input('account-confirmation').checked = false;
  input('account-confirmation').required = false;
  input('account-confirmation').disabled = true;
  $<HTMLButtonElement>('confirm-apply').disabled = true;
  $<HTMLButtonElement>('check-draft').disabled = true;
  select('draft-check-date').disabled = true;
  select('draft-check-date').replaceChildren();
  input('pause-verification').checked = false;
  if (applyDialog.open) applyDialog.close();
}

function revokeApproval(): void {
  approvedPlanRevision = undefined;
  closeConfirmation();
}

function approved(): boolean {
  return Boolean(connected() && !updating() && !initializing && !initializationFailed && preferencesLoaded && !preflightNeedsScan && plan?.canReview && !pendingDraft && approvedPlanRevision === planRevision() && sameJsonValue(plan, state.plan));
}

function canExportPlan(): boolean {
  const frozen = isPaused() && plan?.id === state.run?.planId && state.job?.connectionId === state.connection?.generation;
  return Boolean(!isRunning() && !updating() && !initializing && !initializationFailed && preferencesLoaded && !rebuilding && !pendingDraft && connected()
    && plan && state.snapshot && sameJsonValue(plan, state.plan) && sameJsonValue(plan.snapshot, state.snapshot) && (frozen || approved()));
}

function needsAccountConfirmation(reviewed: BookingPlan): boolean {
  return reviewed.snapshot.source === 'hibob' && (reviewed.snapshot.context?.mode === 'api-session' || reviewed.snapshot.context?.mode === 'user-confirmed-ui');
}

function connected(): boolean {
  return isDemo || Boolean(state.connection?.status === 'connected' && state.connection.capabilities?.read);
}

function canWrite(): boolean {
  return isDemo || Boolean(connected() && state.connection?.capabilities?.write
    && (!plan?.days.some(day => day.action === 'overwrite') || state.connection.capabilities.overwrite));
}

function accountLabel(): string {
  if (isDemo) return state.snapshot?.employeeLabel ?? t('Lokales Testkonto');
  return [state.connection?.employeeLabel, state.connection?.companyLabel].filter(Boolean).join(' · ');
}

function writableDays(reviewed: BookingPlan): DayPlan[] {
  return reviewed.days.filter(day => day.eligible && !reviewed.settings.excludedDates.includes(day.date) && (day.action === 'create' || day.action === 'overwrite'));
}

function currentConfirmation(): boolean {
  return Boolean(confirmed && approved() && !isRunning() && !rebuilding
    && (confirmed.resumeJobId ? pausedJob()?.id === confirmed.resumeJobId && pausedJob()?.checkpointId === confirmed.checkpointId : !isPaused())
    && confirmed.planRevision === planRevision() && sameJsonValue(confirmed.plan, plan)
    && sameJsonValue(confirmed.plan, state.plan) && sameJsonValue(confirmed.plan.snapshot, state.snapshot)
    && confirmed.contextFingerprint === contextFingerprint(state.snapshot?.context));
}

function updateConfirmationButton(): void {
  const review = confirmed;
  const ready = applyDialog.open && currentConfirmation();
  const consent = !review || !needsAccountConfirmation(review.plan) || input('account-confirmation').checked;
  $<HTMLButtonElement>('confirm-apply').disabled = !ready || !consent || !canWrite();
  select('draft-check-date').disabled = !ready || isPaused();
  $<HTMLButtonElement>('check-draft').disabled = !ready || !consent || !review || isPaused()
    || select('draft-check-date').value !== review.preflightDate || !writableDays(review.plan).some(day => day.date === review.preflightDate);
}

function showError(message: string): void {
  localError = message;
  renderState();
}

async function request(command: PanelMessage): Promise<PanelResponse> {
  if (!hasExtension) throw new Error(t('Die Erweiterung ist hier nicht aktiv. Lade den Extension-Ordner in Chrome und öffne sie über das Extension-Symbol.'));
  const requestedAtRevision = sessionRevision;
  const response = await chrome.runtime.sendMessage(command) as PanelResponse;
  if (!panelClosed && response?.state && (typeof response.state.revision === 'number' || requestedAtRevision === sessionRevision)) receiveState(response.state);
  if (!response?.ok) throw new Error(response?.error || t('Die HiBob-Verbindung hat nicht geantwortet. Bitte erneut verbinden.'));
  return response;
}

async function message(command: PanelMessage): Promise<SessionState> {
  return (await request(command)).state ?? state;
}

function renderablePlan(value: unknown): value is BookingPlan {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as BookingPlan;
  const entryList = (entries: unknown): entries is AttendanceEntry[] => Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object' && typeof entry.start === 'string' && typeof entry.end === 'string' && (entry.type === 'work' || entry.type === 'break') && (entry.metadata === undefined || Array.isArray(entry.metadata)));
  return typeof candidate.id === 'string' && typeof candidate.seed === 'number' && typeof candidate.canReview === 'boolean' && Boolean(candidate.settings && typeof candidate.settings.month === 'string')
    && Boolean(candidate.snapshot && typeof candidate.snapshot.month === 'string' && Array.isArray(candidate.snapshot.days))
    && Boolean(candidate.choices && typeof candidate.choices === 'object') && Array.isArray(candidate.errors) && candidate.errors.every(error => typeof error === 'string')
    && Array.isArray(candidate.days) && candidate.days.every(day => day && typeof day.date === 'string' && entryList(day.existing) && entryList(day.proposed))
    && Array.isArray(candidate.weeks) && candidate.weeks.every(week => week && typeof week.week === 'string' && Array.isArray(week.dates) && Array.isArray(week.errors));
}

function receiveState(incoming: SessionState): void {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;
  if (typeof incoming.revision === 'number' && incoming.revision <= (state.revision ?? -1)) return;
  const previous = state;
  state = structuredClone(incoming);
  if (preflightResult && (!sameJsonValue(previous.connection, state.connection) || previous.planRevision !== state.planRevision || state.snapshot || activeJob())) preflightResult = undefined;
  if (state.snapshot && !activeJob()) preflightNeedsScan = false;
  if (state.plan && !renderablePlan(state.plan)) {
    state.plan = undefined;
    localError = t('Der gespeicherte Plan ist ungültig. Bitte den Monat erneut einlesen.');
  }
  if (state.snapshot && (!Array.isArray(state.snapshot.days) || typeof state.snapshot.month !== 'string' || !Number.isFinite(Date.parse(state.snapshot.scannedAt)))) state.snapshot = undefined;
  if (conflictDialog.open && (previous.planRevision !== state.planRevision || !sameJsonValue(previous.plan, state.plan) || !sameJsonValue(previous.snapshot, state.snapshot) || activeJob())) {
    conflictDialog.close();
    // Metadata acknowledgement belongs only to the exact data displayed in
    // this dialog. A replacement event may arrive without an invalidation event.
    $('conflict-items').replaceChildren();
  }
  if (confirmed && (!sameJsonValue(previous.connection, state.connection) || confirmed.planRevision !== planRevision() || !sameJsonValue(confirmed.plan, state.plan) || !sameJsonValue(confirmed.plan.snapshot, state.snapshot) || confirmed.contextFingerprint !== contextFingerprint(state.snapshot?.context) || activeJob() || (confirmed.resumeJobId ? pausedJob()?.id !== confirmed.resumeJobId || pausedJob()?.checkpointId !== confirmed.checkpointId : isPaused()))) closeConfirmation();
  if (approvedPlanRevision !== undefined && (approvedPlanRevision !== planRevision() || !sameJsonValue(plan, state.plan))) approvedPlanRevision = undefined;
  if (!initializing && !pendingDraft) {
    if (state.plan && state.snapshot && state.plan.settings.month === settings.month) {
      plan = state.plan;
      if (!sameJsonValue(settings, plan.settings)) { settings = storedSettings(plan.settings); fillSettings(); }
      choices = structuredClone(plan.choices);
      seed = plan.seed;
    } else {
      plan = undefined;
      choices = {};
      revokeApproval();
      if (conflictDialog.open) conflictDialog.close();
    }
  }
  // A reset or a job starting in another panel invalidates every local draft.
  if (pendingDraft && (!sameJsonValue(previous.connection, state.connection) || activeJob())) {
    pendingDraft = undefined;
    buildVersion++;
    rebuilding = false;
    plan = undefined;
    revokeApproval();
    if (conflictDialog.open) conflictDialog.close();
  }
  renderState();
}

async function refreshApproval(): Promise<void> {
  const version = buildVersion;
  try {
    const response = await message({ type: 'PANEL_GET_STATE' });
    if (version === buildVersion && sameJsonValue(response, state) && !pendingDraft) {
      localError = '';
      connectionRetryAvailable = false;
      if (state.plan && state.snapshot?.month === settings.month && renderablePlan(state.plan) && !activeJob() && state.job?.status !== 'interrupted') {
        plan = state.plan;
        choices = structuredClone(plan.choices);
        seed = plan.seed;
        approvedPlanRevision = planRevision();
      }
      renderState();
    }
  } catch (error) {
    if (version === buildVersion && !pendingDraft) { connectionRetryAvailable = true; showError(errorText(error)); }
  }
}

async function changeConnection(disconnect = false): Promise<void> {
  if (isDemo || !hasExtension || transferBlocked()) return;
  revokeApproval();
  preflightResult = undefined;
  preflightNeedsScan = false;
  connecting = true;
  localError = '';
  renderState();
  try {
    await message({ type: disconnect ? 'PANEL_DISCONNECT' : 'PANEL_CONNECT' });
  } catch (error) { localError = errorText(error); }
  finally { connecting = false; renderState(); }
}

function updateConditionalFields(): void {
  $('break-fields').hidden = !settings.useBreak;
  input('breakStart').required = settings.useBreak;
  input('breakEnd').required = settings.useBreak;
  $('variation-controls').hidden = !settings.variable;
  $('variation-summary').textContent = settings.variable ? t('Längere und kürzere Tage gleichen sich wochenweise aus.') : t('Jeden Tag die angegebenen Uhrzeiten verwenden.');
  $('variation-value').textContent = t('±{minutes} Min.', { minutes: settings.variationMinutes });
  const bavaria = settings.state === 'BY';
  const corpus = settings.state === 'SN' || settings.state === 'TH';
  $('local-holidays').hidden = !bavaria && !corpus;
  $('augsburg-field').hidden = !bavaria;
  $('assumption-field').hidden = !bavaria || settings.localHolidays.augsburg === true;
  $('corpus-field').hidden = !corpus;
  select('augsburg').required = bavaria;
  select('assumption').required = bavaria && settings.localHolidays.augsburg !== true;
  if ((bavaria || corpus) && $('local-holidays').querySelector(':invalid')) setSettingsOpen(true);
  select('corpusChristi').required = corpus;
}

function fillSettings(): void {
  for (const key of ['month', 'start', 'end', 'breakStart', 'breakEnd'] as const) input(key).value = settings[key];
  select('state').value = settings.state;
  input('useBreak').checked = settings.useBreak;
  input('variable').checked = settings.variable;
  input('variationMinutes').value = String(settings.variationMinutes);
  $<HTMLTextAreaElement>('excludedDates').value = settings.excludedDates.join('\n');
  for (const key of ['augsburg', 'assumption', 'corpusChristi'] as const) select(key).value = settings.localHolidays[key] === null ? '' : settings.localHolidays[key] ? 'yes' : 'no';
  updateConditionalFields();
}

function readSettings(): Settings {
  const local = (key: string): boolean | null => select(key).value === '' ? null : select(key).value === 'yes';
  return {
    month: input('month').value,
    state: select('state').value,
    start: input('start').value,
    end: input('end').value,
    useBreak: input('useBreak').checked,
    breakStart: input('breakStart').value,
    breakEnd: input('breakEnd').value,
    variable: input('variable').checked,
    variationMinutes: Number(input('variationMinutes').value),
    excludedDates: [...new Set($<HTMLTextAreaElement>('excludedDates').value.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean))],
    localHolidays: { augsburg: local('augsburg'), assumption: local('assumption'), corpusChristi: local('corpusChristi') },
  };
}

async function persistSettings(value = settings): Promise<void> {
  if (hasExtension) await chrome.storage.local.set({ settings: structuredClone(value) });
  else if (isDemo) localStorage.setItem('hibob-demo-settings', JSON.stringify(value));
}

function persistDemo(): void {
  if (isDemo) sessionStorage.setItem('hibob-demo-session', JSON.stringify({ ...state, plan, demoSnapshot }));
}

async function rebuild(newSeed = false): Promise<void> {
  if (updating() || isPaused()) return;
  const draft = beginDraft(newSeed);
  await processDraft(draft);
}

function beginDraft(newSeed = false): Draft {
  preflightResult = undefined;
  if (newSeed) seed = freshSeed();
  const draft: Draft = {
    version: ++buildVersion, changeId: crypto.randomUUID(), settings: structuredClone(settings),
    choices: structuredClone(choices), seed, preferencesSaved: false,
  };
  pendingDraft = draft;
  revokeApproval();
  if (conflictDialog.open) conflictDialog.close();
  rebuilding = true;
  localError = '';
  plan = state.snapshot?.month === settings.month ? buildMonthPlan(draft.settings, state.snapshot, draft.choices, draft.seed) : undefined;
  renderState();
  return draft;
}

function currentDraft(draft: Draft): boolean { return pendingDraft === draft && draft.version === buildVersion; }

async function processDraft(draft: Draft, prepareOnly = false): Promise<void> {
  if (!currentDraft(draft)) return;
  rebuilding = true;
  localError = '';
  renderState();
  try {
    if (hasExtension) {
      if (!draft.lease || draft.lease.planRevision !== planRevision() || !sameJsonValue(draft.lease, state.editLease)) {
        // Only invalidations are serialized. A new edit can revoke an older
        // in-flight SAVE without waiting for its preferences or acknowledgement.
        const invalidation = invalidations.catch(() => {}).then(async () => {
          if (!currentDraft(draft)) return;
          const response = await message({ type: 'PANEL_INVALIDATE_PLAN', expectedPlanRevision: planRevision(), changeId: draft.changeId });
          if (!currentDraft(draft)) return;
          if (!response.editLease || !sameJsonValue(response.editLease, state.editLease)) throw new Error(t('Die Vorschau wurde inzwischen geändert. Bitte erneut prüfen.'));
          draft.lease = structuredClone(response.editLease);
        });
        invalidations = invalidation;
        await invalidation;
      }
    } else {
      state.planRevision = planRevision() + 1;
      state.plan = undefined;
    }
    if (!currentDraft(draft)) return;
    if (!draft.preferencesSaved) {
      const preferences = preferenceWrites.catch(() => {}).then(async () => {
        if (!currentDraft(draft)) return;
        await persistSettings(draft.settings);
        draft.preferencesSaved = true;
      });
      preferenceWrites = preferences;
      await preferences;
    }
    if (!currentDraft(draft)) return;
    if (prepareOnly) {
      pendingDraft = undefined;
      return;
    }
    if (!state.snapshot || state.snapshot.month !== draft.settings.month) {
      plan = undefined;
      persistDemo();
      pendingDraft = undefined;
      rebuilding = false;
      return;
    }
    const next = buildMonthPlan(draft.settings, state.snapshot, draft.choices, draft.seed);
    plan = next;
    renderState();
    if (hasExtension) {
      const saved = await message({ type: 'PANEL_SAVE_PLAN', plan: next, lease: draft.lease });
      if (!currentDraft(draft)) return;
      if (!sameJsonValue(saved.plan, next) || !sameJsonValue(saved.editLease, draft.lease) || saved.planRevision !== planRevision()) throw new Error(t('Die Vorschau wurde inzwischen geändert. Bitte erneut prüfen.'));
      plan = saved.plan;
    } else state.plan = next;
    persistDemo();
    pendingDraft = undefined;
    approvedPlanRevision = planRevision();
  } catch (error) {
    if (currentDraft(draft)) {
      localError = t('Die Änderungen sind noch nicht bestätigt. {error}', { error: errorText(error) });
      revokeApproval();
    }
  } finally {
    if (draft.version === buildVersion) { rebuilding = false; renderState(); }
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function storedSettings(value: unknown): Settings {
  const restored = defaultSettings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return restored;
  const saved = value as Record<string, unknown>;
  for (const key of ['month', 'state', 'start', 'end', 'breakStart', 'breakEnd'] as const) {
    if (typeof saved[key] === 'string') restored[key] = saved[key];
  }
  for (const key of ['useBreak', 'variable'] as const) {
    if (typeof saved[key] === 'boolean') restored[key] = saved[key];
  }
  if (typeof saved.variationMinutes === 'number' && Number.isInteger(saved.variationMinutes) && saved.variationMinutes >= 0 && saved.variationMinutes <= 30) restored.variationMinutes = saved.variationMinutes;
  if (Array.isArray(saved.excludedDates)) restored.excludedDates = saved.excludedDates.filter((date): date is string => typeof date === 'string');
  if (saved.localHolidays && typeof saved.localHolidays === 'object' && !Array.isArray(saved.localHolidays)) {
    const local = saved.localHolidays as Record<string, unknown>;
    for (const key of ['augsburg', 'assumption', 'corpusChristi'] as const) {
      if (typeof local[key] === 'boolean' || local[key] === null) restored.localHolidays[key] = local[key];
    }
  }
  return restored;
}

function renderState(): void {
  if (!app.isConnected || panelClosed) return;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const focusId = focused?.id;
  const scrolling = document.scrollingElement ?? document.documentElement;
  const scrollTop = scrolling.scrollTop;
  const scrollLeft = scrolling.scrollLeft;
  const running = isRunning();
  const paused = isPaused();
  if (!activeJob() && state.run?.status !== 'running') statePollError = '';
  const locked = running || paused || updating();
  const installedVersion = state.update?.installedVersion ?? packageVersion;
  const versionLabel = installedVersion === packageVersion ? (extensionManifest as { version_name?: string }).version_name ?? installedVersion : installedVersion;
  $('installed-version').textContent = t('Version {version}', { version: versionLabel });
  $('activate-update').hidden = !hasExtension || !state.update?.pendingVersion;
  $<HTMLButtonElement>('activate-update').disabled = transferBlocked() || Boolean(state.job);
  $('activate-update').textContent = updating() ? t('Aktualisierung wird aktiviert …') : t('Jetzt aktualisieren');
  $('update-notice').hidden = !state.update?.pendingVersion && !updating();
  $('update-notice').textContent = updating() ? t('Die Erweiterung wird neu geladen. Verbinde dich danach mit HiBob und lies den Monat erneut ein.')
    : state.job?.status === 'interrupted' ? t('Version {version} ist bereit. Kläre zuerst den unterbrochenen Vorgang durch erneutes Einlesen.', { version: state.update?.pendingVersion ?? '' })
    : running ? t('Version {version} ist verfügbar. Die Aktualisierung wartet auf das Ende des laufenden Vorgangs.', { version: state.update?.pendingVersion ?? '' })
    : t('Version {version} ist bereit. Verbinde dich nach der Aktualisierung erneut mit HiBob und lies den Monat erneut ein.', { version: state.update?.pendingVersion ?? '' });
  $<HTMLButtonElement>('export-settings').disabled = transferBlocked();
  $<HTMLButtonElement>('import-settings').disabled = transferBlocked();
  $<HTMLInputElement>('settings-file').disabled = transferBlocked();
  $<HTMLButtonElement>('confirm-import').disabled = transferBlocked();
  $('export-plan').hidden = !plan;
  $('export-plan-hint').hidden = !plan;
  $<HTMLButtonElement>('export-plan').disabled = !canExportPlan();
  if ((running || updating()) && importDialog.open) { importCandidate = undefined; importDialog.close(); }
  $('demo-banner').hidden = !isDemo;
  const bound = connected();
  const scanned = bound && state.snapshot?.month === settings.month;
  $('connection').classList.toggle('connected', scanned);
  $('connection').classList.toggle('selected', bound && !scanned);
  $('account-context-notice').hidden = isDemo || !scanned || (state.snapshot?.context?.mode !== 'api-session' && state.snapshot?.context?.mode !== 'user-confirmed-ui');
  $('connect').hidden = isDemo || bound;
  $('disconnect').hidden = isDemo || !bound;
  document.querySelector<HTMLElement>('.connection-actions')!.hidden = isDemo || bound;
  $<HTMLButtonElement>('connect').disabled = transferBlocked();
  $<HTMLButtonElement>('disconnect').disabled = transferBlocked();
  $('connect').textContent = connecting ? t('Verbindung wird hergestellt …') : t('Mit HiBob anmelden');
  $('api-capability-notice').hidden = isDemo || !bound || canWrite();
  $('api-capability-notice').textContent = state.connection?.reason || (state.connection?.capabilities?.write ? t('Das Überschreiben vorhandener Einträge ist für diese API-Verbindung nicht freigegeben.') : t('Lesende API-Verbindung. Vorschau und Planprüfung sind verfügbar; Speichern ist noch nicht freigegeben.'));
  $('connection-technical').textContent = state.connection?.transport === 'temporary-tab' ? t('API über temporären Hintergrund-Tab') : bound && !isDemo ? t('Direkte API-Verbindung') : '';
  if (state.snapshot && scanned) {
    $('connection-title').textContent = t('Monat eingelesen');
    const time = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(state.snapshot.scannedAt));
    $('connection-detail').textContent = t('{employee} · Eingelesen: {time} Uhr · {period}', { employee: accountLabel() || state.snapshot.employeeLabel, time, period: state.snapshot.periodLabel });
  } else if (isDemo) {
    $('connection-title').textContent = t('Lokale Testoberfläche');
    $('connection-detail').textContent = t('Alle Funktionen können ohne echte Buchungen geprüft werden.');
  } else if (bound) {
    $('connection-title').textContent = t('Mit HiBob verbunden');
    $('connection-detail').textContent = accountLabel();
  } else {
    $('connection-title').textContent = connecting ? t('Verbindung wird hergestellt …') : state.connection?.status === 'expired' ? t('HiBob-Anmeldung abgelaufen') : state.connection?.status === 'unsupported' ? t('HiBob-Verbindung nicht verfügbar') : t('Mit HiBob verbinden');
    $('connection-detail').textContent = state.connection?.reason || t('Melde dich über HiBob an, um deine Anwesenheiten einzulesen.');
  }
  const error = localError || state.error || statePollError || (state.job?.status === 'interrupted' ? t('Der letzte Vorgang wurde unterbrochen. Bitte den Monat erneut einlesen.') : '');
  $('main-error').hidden = !error;
  $('main-error').textContent = localizeText(error);
  $('retry-plan').hidden = !pendingDraft || rebuilding || locked;
  $('retry-connection').hidden = !hasExtension || (!initializationFailed && !connectionRetryAvailable) || initializing || locked;
  $<HTMLFieldSetElement>('settings-fieldset').disabled = locked || initializing || initializationFailed;
  $<HTMLButtonElement>('settings-toggle').disabled = locked || initializing || initializationFailed;
  $('schedule-hours').textContent = `${settings.start || '—'}–${settings.end || '—'}`;
  $('schedule-details').textContent = [settings.useBreak ? `${t('Pause')} ${settings.breakStart}–${settings.breakEnd}` : t('Ohne Pause'), settings.variable ? t('±{minutes} Min.', { minutes: settings.variationMinutes }) : t('feste Zeiten'), t(GERMAN_STATES.find(item => item.code === settings.state)?.name || settings.state), settings.excludedDates.length ? t('{count} manuell ausgeschlossene Tage', { count: settings.excludedDates.length }) : ''].filter(Boolean).join(' · ');
  $<HTMLButtonElement>('scan').disabled = locked || initializing || initializationFailed || rebuilding || (!isDemo && !bound);
  $<HTMLButtonElement>('refresh-month').disabled = $<HTMLButtonElement>('scan').disabled;
  $('refresh-month').hidden = !state.snapshot;
  $('scan-toolbar').hidden = !bound || scanned;
  $('scan').textContent = busy || activeJob()?.kind === 'scan' ? t('Vorschau wird geprüft …') : scanned ? t('Monat erneut einlesen') : t('Vorschau erstellen');
  const progress = state.progress;
  $('scan-progress').hidden = !running || !progress;
  if (progress && running) {
    const label = node('div', undefined, 'progress-header');
    label.append(node('span', localizeText(progress.message)), node('span', `${progress.completed}/${progress.total}`));
    const bar = node('progress');
    bar.max = progress.total || 1;
    bar.value = progress.completed;
    bar.setAttribute('aria-label', progress.phase === 'scan' ? t('Monat einlesen') : checkingPreflight ? t('Planprüfung') : t('Buchungsfortschritt'));
    $('scan-progress').replaceChildren(label, bar);
  }
  renderPreview();
  renderRun();
  renderPreflight();
  $('cancel-run').hidden = (!running && !paused) || connecting;
  $('cancel-run').textContent = paused || state.run?.status === 'running' ? t('Restliche Tage stoppen') : t('Abbrechen');
  $<HTMLButtonElement>('cancel-run').disabled = hasExtension && (!activeJob() && !pausedJob() || activeJob()?.status === 'cancelling');
  $('booking-footer').hidden = (!plan || !state.snapshot) && !running && !paused;
  $('apply').hidden = paused;
  const finished = state.run?.status === 'complete' && state.run.planId === plan?.id;
  $<HTMLButtonElement>('apply').disabled = !approved() || locked || rebuilding || finished;
  $('apply').textContent = rebuilding ? t('Vorschau wird geprüft …') : running ? t('Bitte warten …') : finished ? t('Buchungen abgeschlossen') : canWrite() ? t('{count} Tage prüfen', { count: plan ? writableDays(plan).length : 0 }) : t('Plan prüfen');
  $('paused-card').hidden = !paused;
  $('paused-description').textContent = paused ? t('{date} ist gespeichert und geprüft. {verified} Tage geprüft, {remaining} noch offen. Prüfe die Buchung und bestätige anschließend das Fortsetzen.', { date: dateLabel(state.run?.checkpointDate ?? ''), verified: state.run?.results.filter(item => item.status === 'verified').length ?? 0, remaining: state.run?.results.filter(item => item.status !== 'verified' && item.status !== 'skipped').length ?? 0 }) : '';
  $<HTMLButtonElement>('continue-run').disabled = !paused || running || updating() || rebuilding;
  $('footer-hint').textContent = running ? t('Bitte das HiBob-Konto während des Laufs nicht wechseln.') : paused ? t('Bereits geprüfte Buchungen bleiben gespeichert. Fortsetzen benötigt eine neue Bestätigung.') : preflightNeedsScan ? t('Nach der Planprüfung den Monat erneut einlesen.') : isDemo ? t('Testmodus: Auch „Jetzt buchen“ verändert nur lokale Beispieldaten.') : state.run && !state.snapshot ? t('Für einen weiteren Lauf den Monat erneut einlesen.') : t('Es wird erst nach deiner Bestätigung gespeichert.');
  updateConfirmationButton();
  if (focusId && focused && !focused.isConnected) document.getElementById(focusId)?.focus({ preventScroll: true });
  scrolling.scrollTop = scrollTop;
  scrolling.scrollLeft = scrollLeft;
  const checkpointId = pausedJob()?.checkpointId;
  if (paused && !running && !updating() && checkpointId && checkpointId !== announcedCheckpointId) {
    announcedCheckpointId = checkpointId;
    $('paused-card').scrollIntoView?.({ block: 'center' });
    $('continue-run').focus({ preventScroll: true });
  }
  synchronizeStatePolling();
}

function renderPreview(): void {
  const running = isRunning();
  const locked = running || isPaused() || updating();
  const expanded = new Set([...document.querySelectorAll<HTMLDetailsElement>('details[data-day-details]')].filter(item => item.open).map(item => item.dataset.dayDetails));
  const skippedOpen = document.querySelector<HTMLDetailsElement>('#skipped-days')?.open ?? false;
  document.querySelector<HTMLElement>('.preview')!.hidden = !plan && !state.snapshot;
  $('preview-empty').hidden = Boolean(plan);
  $('preview-empty').querySelector('p')!.textContent = !plan && state.snapshot?.month === settings.month ? t('Der Monat ist eingelesen. Erstelle jetzt die prüfbare Vorschau.') : t('Lies zuerst den Monat aus HiBob ein. Feiertage, Abwesenheiten und bestehende Einträge werden berücksichtigt.');
  $('build-preview').hidden = Boolean(plan || pendingDraft || running || updating() || initializing || initializationFailed || state.snapshot?.month !== settings.month);
  $('preview-summary').hidden = !plan;
  $('redistribute').hidden = !plan || !settings.variable;
  $<HTMLButtonElement>('redistribute').disabled = locked;
  $('weeks').replaceChildren();
  $('plan-errors').replaceChildren();
  $('plan-errors').hidden = !plan?.errors.length;
  $('conflicts').hidden = true;
  $('preview-subtitle').textContent = plan ? `${monthLabel(plan.settings.month)} · ${plan.settings.variable ? t('variable Zeiten ±{minutes} Min.', { minutes: plan.settings.variationMinutes }) : t('feste Zeiten')}` : t('Vor dem Buchen alle Änderungen prüfen.');
  if (!plan) return;
  const changed = plan.days.filter((day) => day.action === 'create' || day.action === 'overwrite');
  const excluded = plan.days.filter((day) => !day.eligible);
  const conflictDays = plan.days.filter((day) => day.eligible && day.existing.length > 0);
  const total = plan.weeks.some(week => week.plannedMinutes === null) ? null : plan.weeks.reduce((minutes, week) => minutes + (week.plannedMinutes ?? 0), 0);
  const summaryItems = [[String(changed.length), isPaused() ? t('Tage im Monatsplan') : t('Tage zum Buchen')], [formatMinutes(total), t('Netto im Plan')], [String(excluded.length), t('ausgelassene Tage')]];
  $('preview-summary').replaceChildren(...summaryItems.map(([value, label]) => {
    const item = node('div'); item.append(node('strong', value), node('span', label)); return item;
  }));
  if (conflictDays.length) {
    $('conflicts').hidden = false;
    const unresolved = conflictDays.filter((day) => !choices[day.date]).length;
    $('conflicts').textContent = unresolved ? unresolved === 1 ? t('1 vorhandene Buchung prüfen') : t('{count} vorhandene Buchungen prüfen', { count: unresolved }) : t('Entscheidungen zu vorhandenen Buchungen ändern');
    $('conflicts').classList.toggle('primary', unresolved > 0);
    if (unresolved) $('preview-summary').after($('conflicts'));
    else $('more-options').append($('conflicts'));
    $<HTMLButtonElement>('conflicts').disabled = locked || rebuilding || Boolean(pendingDraft);
  }
  if (plan.errors.length) {
    const list = node('ul');
    for (const error of [...new Set(plan.errors)]) list.append(node('li', localizeText(error)));
    $('plan-errors').append(node('div', t('Der Plan kann noch nicht gebucht werden.'), 'error-heading'), list);
  }
  const shown = new Set<string>();
  const skipped: DayPlan[] = [];
  for (const week of plan.weeks) {
    const section = node('section', undefined, 'week');
    const header = node('div', undefined, 'week-header');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(week.week) ? dateLabel(week.week, false) : week.week;
    header.append(node('h3', t('Woche {date}', { date })));
    const totals = node('div', undefined, 'totals');
    totals.append(node('strong', t('{time} geplant', { time: formatMinutes(week.plannedMinutes) })), node('div', t('{time} Ziel', { time: formatMinutes(week.targetMinutes) })));
    header.append(totals);
    section.append(header);
    for (const day of plan.days.filter((item) => week.dates.includes(item.date))) {
      if (!day.eligible && !settings.excludedDates.includes(day.date)) skipped.push(day);
      else section.append(renderDay(day, expanded.has(day.date)));
      shown.add(day.date);
    }
    for (const error of week.errors) section.append(node('p', localizeText(error), 'weekly-error'));
    if (section.querySelector('article') || week.errors.length) $('weeks').append(section);
  }
  // Include every date even if a planner only groups eligible dates into weeks.
  const remaining = plan.days.filter((day) => !shown.has(day.date));
  if (remaining.length) {
    const section = node('section', undefined, 'week');
    section.append(node('h3', t('Weitere Tage')));
    for (const day of remaining) section.append(renderDay(day, expanded.has(day.date)));
    $('weeks').append(section);
  }
  if (skipped.length) {
    const disclosure = node('details', undefined, 'skipped-days'); disclosure.id = 'skipped-days'; disclosure.open = skippedOpen;
    disclosure.append(node('summary', t('{count} arbeitsfreie Tage', { count: skipped.length })));
    for (const day of skipped) disclosure.append(renderDay(day, expanded.has(day.date)));
    $('weeks').append(disclosure);
  }
}

function renderDay(day: DayPlan, expanded = false): HTMLElement {
  const article = node('article', undefined, `day${!day.eligible ? ' inactive' : ''}`);
  article.dataset.date = day.date;
  const head = node('div', undefined, 'day-head');
  const label = node('label', undefined, 'day-check');
  const checkbox = node('input');
  checkbox.id = `include-${day.date}`;
  checkbox.type = 'checkbox';
  const snapshot = (state.snapshot ?? plan?.snapshot)?.days.find((item) => item.date === day.date);
  const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
  const unavailable = weekday === 0 || weekday === 6 || Boolean(day.holiday || snapshot?.absence || snapshot?.nonWorking || (!snapshot?.editable && !snapshot?.unsupportedReason && day.action !== 'blocked'));
  checkbox.checked = !unavailable && !settings.excludedDates.includes(day.date);
  checkbox.disabled = isRunning() || isPaused() || updating() || unavailable;
  checkbox.setAttribute('aria-label', t('{date} berücksichtigen', { date: dateLabel(day.date) }));
  checkbox.addEventListener('change', () => {
    if (isRunning() || isPaused() || updating()) return;
    settings.excludedDates = checkbox.checked ? settings.excludedDates.filter((date) => date !== day.date) : [...new Set([...settings.excludedDates, day.date])].sort();
    $<HTMLTextAreaElement>('excludedDates').value = settings.excludedDates.join('\n');
    settingsChanged();
  });
  const dateText = node('span', undefined, 'day-date'); dateText.append(node('span', dateLabel(day.date)));
  const labels: Record<DayPlan['action'], string> = { create: t('Neu'), overwrite: t('Ersetzen'), skip: t('Ausgelassen'), conflict: t('Entscheidung offen'), unchanged: t('Unverändert'), blocked: t('Prüfung erforderlich') };
  if (day.action !== 'create') dateText.append(node('small', labels[day.action], `day-state ${day.action}`));
  label.append(checkbox, dateText);
  const entries = (day.action === 'skip' || day.action === 'unchanged' ? day.existing : day.proposed).filter(entry => entry.type === 'work').sort((a, b) => a.start.localeCompare(b.start));
  head.append(label, node('span', entries.length ? `${entries[0].start}–${entries[entries.length - 1].end}` : '—', 'day-time'), node('span', day.eligible ? formatMinutes(day.netMinutes) : '', 'day-net'));
  article.append(head);
  const disclosure = node('details', undefined, 'day-details'); disclosure.dataset.dayDetails = day.date; disclosure.open = expanded;
  const toggle = node('summary', '⌄'); toggle.setAttribute('aria-label', t('Einträge für {date} anzeigen', { date: dateLabel(day.date) })); disclosure.append(toggle);
  const list = node('dl', undefined, 'day-lines');
  if (day.existing.length) detailsLine(list, t('Bisher'), entriesElement(day.existing));
  if (day.proposed.length && (day.action === 'create' || day.action === 'overwrite' || day.action === 'conflict')) detailsLine(list, t('Geplant'), entriesElement(day.proposed));
  if (day.eligible) detailsLine(list, t('Netto'), formatMinutes(day.netMinutes));
  if (list.childElementCount) disclosure.append(list);
  const extra = metadata(day.existing);
  if (extra.length) disclosure.append(node('div', extra.join('\n'), 'metadata'));
  if (list.childElementCount || extra.length) article.append(disclosure);
  const reason = [day.holiday, day.reason].filter((value, index, array) => value && array.indexOf(value) === index).map((value) => localizeText(value!)).join(' · ');
  if (reason) article.append(node('p', reason, 'day-reason'));
  return article;
}

function renderRun(): void {
  const run = state.run;
  $('run-panel').hidden = !run;
  if (!run) return;
  const verified = run.results.filter((item) => item.status === 'verified').length;
  const status = { running: t('Buchungen laufen'), paused: t('Für Kontrolle pausiert'), complete: t('Lauf abgeschlossen'), stopped: t('Lauf angehalten'), failed: t('Lauf mit Fehler angehalten') }[run.status];
  $('run-status').textContent = t('{status} · {verified} von {total} Tagen verifiziert', { status, verified, total: run.results.filter((item) => item.status !== 'skipped').length });
  $('run-uncertain').hidden = !run.results.some(result => result.status === 'uncertain');
  const uncertainNotice = t('Als unklar markierte Buchungen können bereits in HiBob gespeichert sein. Vor einem neuen Lauf den Monat einlesen und die betroffenen Tage prüfen.');
  if ($('run-uncertain').textContent !== uncertainNotice) $('run-uncertain').textContent = uncertainNotice;
  if (run.status === 'failed') $<HTMLDetailsElement>('run-history').open = true;
  $('run-results').replaceChildren(...run.results.map((result) => {
    const item = node('li'); item.dataset.status = result.status;
    const description = node('div');
    if (result.status === 'uncertain') description.append(node('strong', t('Speicherstatus unklar'), 'run-outcome'));
    if (result.status === 'pending') description.append(node('strong', t('Noch nicht ausgeführt'), 'run-outcome'));
    const message = localizeText(result.message);
    if (result.status !== 'pending' || message !== t('Keine Änderung.')) description.append(node('span', message));
    item.append(node('span', dateLabel(result.date, false)), description); return item;
  }));
}

function renderPreflight(): void {
  $('draft-check-result').hidden = !preflightResult;
  const list = $('draft-check-details');
  list.replaceChildren();
  if (!preflightResult) return;
  detailsLine(list, t('Geprüfter Tag'), dateLabel(preflightResult.date));
  detailsLine(list, t('Prüfung'), t('Kontozuordnung, Tagesdaten und lokale Planvalidierung; keine serverseitige Speicherbestätigung.'));
  detailsLine(list, t('Netto'), formatMinutes(preflightResult.netMinutes));
}

function settingsChanged(): void {
  void rebuild(true);
}

function openConflicts(): void {
  if (!plan || isPaused() || updating()) return;
  $('conflict-error').hidden = true;
  $('conflict-items').replaceChildren();
  for (const day of plan.days.filter((item) => item.eligible && item.existing.length > 0)) {
    const article = node('section', undefined, 'conflict-item');
    article.dataset.date = day.date;
    article.append(node('h3', dateLabel(day.date)));
    const list = node('dl', undefined, 'day-lines');
    detailsLine(list, t('Bisher'), entriesElement(day.existing));
    detailsLine(list, t('Geplant'), entriesElement(day.proposed));
    article.append(list);
    const extra = metadata(day.existing);
    if (extra.length) article.append(node('div', extra.join('\n'), 'metadata'));
    const label = node('label', t('Aktion'), 'visually-hidden');
    label.htmlFor = `choice-${day.date}`;
    const action = node('select'); action.id = `choice-${day.date}`; action.dataset.conflictChoice = day.date;
    action.setAttribute('aria-label', t('Aktion für {date}', { date: dateLabel(day.date) }));
    for (const [value, text] of [['', t('Bitte entscheiden')], ['skip', t('Überspringen · Bestehendes behalten')], ['overwrite', t('Überschreiben · Vorschau übernehmen')]]) {
      const option = node('option', text); option.value = value; action.append(option);
    }
    action.value = choices[day.date] || '';
    article.append(label, action);
    if (extra.length) {
      const ack = node('label', undefined, 'ack-label');
      const check = node('input'); check.type = 'checkbox'; check.dataset.metadataAck = day.date;
      ack.append(check, node('span', t('Ich bestätige, dass die oben angezeigten zusätzlichen Angaben beim Ersetzen entfernt werden.')));
      ack.hidden = action.value !== 'overwrite';
      action.addEventListener('change', () => { ack.hidden = action.value !== 'overwrite'; });
      article.append(ack);
    }
    $('conflict-items').append(article);
  }
  conflictDialog.showModal();
}

function chooseAll(value: string): void {
  for (const element of document.querySelectorAll<HTMLSelectElement>('[data-conflict-choice]')) {
    element.value = value;
    element.dispatchEvent(new Event('change'));
  }
}

async function saveChoices(): Promise<void> {
  if (!conflictDialog.open || !plan || isRunning() || isPaused() || updating()) return;
  const next: ConflictChoices = { ...choices };
  for (const element of document.querySelectorAll<HTMLSelectElement>('[data-conflict-choice]')) {
    const date = element.dataset.conflictChoice!;
    if (element.value !== 'skip' && element.value !== 'overwrite') {
      $('conflict-error').textContent = t('Bitte für jeden angezeigten Tag eine Entscheidung treffen.');
      $('conflict-error').hidden = false; element.focus(); return;
    }
    const ack = document.querySelector<HTMLInputElement>(`[data-metadata-ack="${date}"]`);
    if (element.value === 'overwrite' && ack && !ack.checked) {
      $('conflict-error').textContent = t('Bitte die Entfernung der zusätzlichen Angaben für jeden betroffenen Tag bestätigen.');
      $('conflict-error').hidden = false; ack.focus(); return;
    }
    next[date] = element.value;
  }
  choices = next;
  conflictDialog.close();
  await rebuild(true);
}

async function scanMonth(): Promise<void> {
  if (!connected() || isRunning() || isPaused() || updating() || rebuilding) return;
  if (!revealInvalidSettings()) return;
  settings = readSettings();
  busy = true; demoCancelled = false; localError = ''; plan = undefined; choices = {}; preflightResult = undefined;
  if (isDemo) {
    state.run = undefined;
    state.progress = { phase: 'scan', completed: 0, total: 1, message: t('HiBob-Monat wird geprüft …') };
  }
  const month = settings.month;
  const connectionGeneration = state.connection?.generation;
  const draft = beginDraft(true);
  plan = undefined;
  renderState();
  try {
    await processDraft(draft, true);
    if (draft.version !== buildVersion || pendingDraft || activeJob()) return;
    if (isDemo) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (demoCancelled) throw new Error(t('Einlesen abgebrochen.'));
      if (!demoSnapshot || demoSnapshot.month !== month) demoSnapshot = createDemoSnapshot(settings);
      state.snapshot = structuredClone(demoSnapshot);
      preflightNeedsScan = false;
      state.progress = undefined;
    } else {
      const scanned = await message({ type: 'PANEL_SCAN', month });
      if (!sameJsonValue(scanned, state) || state.connection?.generation !== connectionGeneration || state.snapshot?.month !== month || activeJob()) return;
    }
    await rebuild();
  } catch (error) { localError = errorText(error); }
  finally { busy = false; if (isDemo) state.progress = undefined; renderState(); persistDemo(); }
}

function remainingDays(reviewed: BookingPlan): DayPlan[] {
  const verified = state.run?.planId === reviewed.id && isPaused() ? new Set(state.run.results.filter(item => item.status === 'verified').map(item => item.date)) : new Set<string>();
  return writableDays(reviewed).filter(day => !verified.has(day.date));
}

function verificationDates(reviewed: BookingPlan): string[] {
  const days = writableDays(reviewed).map(day => day.date).sort();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  return [...new Set([days[0], days.find(date => date > today)].filter((date): date is string => Boolean(date)))];
}

function openApply(resume = false): void {
  if (!approved() || !plan || isRunning() || rebuilding || (resume ? !pausedJob() : isPaused())) return;
  preflightResult = undefined;
  const days = resume ? remainingDays(plan) : writableDays(plan);
  confirmed = { plan: structuredClone(plan), planRevision: planRevision(), contextFingerprint: contextFingerprint(plan.snapshot.context), preflightDate: days[0]?.date ?? '', ...(resume ? { resumeJobId: pausedJob()!.id, checkpointId: pausedJob()!.checkpointId } : {}) };
  const reviewed = confirmed.plan;
  $('apply-title').textContent = resume ? t('Restliche Buchungen fortsetzen?') : canWrite() ? t('Buchungen jetzt speichern?') : t('Plan prüfen');
  const manual = needsAccountConfirmation(reviewed);
  $('account-confirmation-field').hidden = !manual;
  input('account-confirmation').checked = false;
  input('account-confirmation').required = manual;
  input('account-confirmation').disabled = !manual;
  $('account-confirmation-label').textContent = t('Ich bestätige, dass die Anwesenheiten für {month} zu meinem angezeigten HiBob-Konto im richtigen Firmenkonto gehören.', { month: monthLabel(reviewed.settings.month) });
  const dateSelect = select('draft-check-date');
  dateSelect.replaceChildren(...days.map(day => { const option = node('option', `${dateLabel(day.date)} · ${formatMinutes(day.netMinutes)}`); option.value = day.date; return option; }));
  dateSelect.value = confirmed.preflightDate;
  input('pause-verification').checked = false;
  $('checkpoint-field').hidden = resume || !canWrite();
  $('preflight-controls').hidden = resume;
  $('additional-checks').hidden = resume;
  $<HTMLDetailsElement>('additional-checks').open = !canWrite();
  $('checkpoint-description').textContent = t('Nach dem ersten gebuchten Tag und dem ersten zukünftigen Tag anhalten. Danach nur mit neuer Bestätigung fortsetzen.');
  $('confirm-apply').hidden = !canWrite();
  $('confirm-apply').textContent = resume ? t('{count} restliche Tage buchen', { count: days.length }) : t('{count} Tage buchen', { count: days.length });
  const overwriteCount = days.filter((day) => day.action === 'overwrite').length;
  $('apply-description').textContent = isDemo ? t('Du startest eine lokale Simulation. Dein echtes HiBob-Konto wird nicht verändert.') : manual ? t('Prüfe das angezeigte Mitarbeiter- und Firmenkonto. Diese Bestätigung gilt nur für diesen Plan.') : t('Die folgenden Änderungen werden in deinem HiBob-Konto „{employee}“ gespeichert.', { employee: reviewed.snapshot.employeeLabel });
  const list = $('apply-details'); list.replaceChildren();
  detailsLine(list, t('Monat'), monthLabel(reviewed.settings.month));
  if (!isDemo) detailsLine(list, t('HiBob-Konto'), accountLabel());
  detailsLine(list, t('Tage zum Buchen'), String(days.length));
  detailsLine(list, t('Netto'), formatMinutes(days.reduce((total, day) => total + (day.netMinutes ?? 0), 0)));
  detailsLine(list, t('Geplant'), [reviewed.settings.start + '–' + reviewed.settings.end, reviewed.settings.useBreak ? `${t('Pause')} ${reviewed.settings.breakStart}–${reviewed.settings.breakEnd}` : t('Ohne Pause'), reviewed.settings.variable ? t('±{minutes} Min.', { minutes: reviewed.settings.variationMinutes }) : t('feste Zeiten')].join(' · '));
  if (resume) detailsLine(list, t('Bereits gespeichert und geprüft'), String(writableDays(reviewed).length - days.length));
  detailsLine(list, t('Davon überschreiben'), String(overwriteCount));
  detailsLine(list, t('Bundesland'), t(GERMAN_STATES.find((item) => item.code === reviewed.settings.state)?.name || reviewed.settings.state));
  applyDialog.showModal();
  updateConfirmationButton();
}

function accountConfirmation(review: NonNullable<typeof confirmed>): AccountConfirmation | undefined {
  return needsAccountConfirmation(review.plan) ? {
    planId: review.plan.id, planRevision: review.planRevision, contextFingerprint: review.contextFingerprint, confirmed: true,
    ...(review.resumeJobId ? { checkpointId: review.checkpointId } : {}),
  } : undefined;
}

function validPreflight(result: PreflightResult | undefined, day: DayPlan): result is PreflightResult {
  return Boolean(result && result.date === day.date && result.saved === false && result.checked === true && result.serverValidated === false
    && Number.isSafeInteger(result.netMinutes) && result.netMinutes === day.netMinutes && result.netMinutes === netMinutes(day.proposed));
}

async function demoPreflight(day: DayPlan): Promise<PreflightResult> {
  demoCancelled = false;
  state.progress = { phase: 'apply', completed: 0, total: 1, date: day.date, message: t('Tagesdaten und Plan werden ohne Speichern geprüft …') };
  renderState();
  await new Promise(resolve => setTimeout(resolve, 160));
  if (demoCancelled) throw new Error(t('Planprüfung abgebrochen. Es wurde nicht gespeichert.'));
  return { date: day.date, checked: true, netMinutes: netMinutes(day.proposed)!, saved: false, serverValidated: false };
}

async function checkPreflight(): Promise<void> {
  const review = confirmed;
  if (isPaused() || !connected() || !review || !applyDialog.open || !currentConfirmation() || select('draft-check-date').value !== review.preflightDate || (needsAccountConfirmation(review.plan) && !input('account-confirmation').checked)) return;
  const day = writableDays(review.plan).find(day => day.date === review.preflightDate);
  if (!day) return;
  const confirmation = accountConfirmation(review);
  const connectionGeneration = state.connection?.generation;
  const reviewedConnection = structuredClone(state.connection);
  const revision = state.revision ?? 0;
  const version = buildVersion;
  closeConfirmation();
  approvedPlanRevision = undefined;
  checkingPreflight = true; preflightNeedsScan = true; preflightResult = undefined; localError = ''; renderState();
  try {
    const response = isDemo ? undefined : await request({ type: 'PANEL_PREFLIGHT', plan: review.plan, expectedPlanRevision: review.planRevision, date: day.date, ...(confirmation ? { confirmation } : {}) });
    const result = isDemo ? await demoPreflight(day) : response?.preflight;
    const completedState = response?.state;
    const invalidated = isDemo || Boolean(completedState && completedState.schemaVersion === 5 && completedState.connection?.generation === connectionGeneration
      && sameJsonValue(completedState.connection, reviewedConnection)
      && typeof completedState.revision === 'number' && completedState.revision > revision
      && typeof completedState.planRevision === 'number' && completedState.planRevision > review.planRevision
      && completedState.snapshot === undefined && completedState.job === undefined && (!completedState.plan || completedState.plan.canReview === false));
    if (!validPreflight(result, day) || !invalidated) throw new Error(t('Die Planprüfung hat kein eindeutiges Ergebnis geliefert. Bitte den Tag prüfen und den Monat erneut einlesen.'));
    // A late result cannot describe a replaced account connection as checked.
    if (buildVersion === version && state.connection?.generation === connectionGeneration && !activeJob() && (isDemo || sameJsonValue(completedState, state))) preflightResult = structuredClone(result);
  } catch (error) { localError = errorText(error); }
  finally {
    checkingPreflight = false;
    preflightNeedsScan = true;
    revokeApproval();
    if (isDemo) {
      state.snapshot = undefined; state.plan = undefined; state.progress = undefined; plan = undefined;
      state.planRevision = planRevision() + 1;
      state.revision = (state.revision ?? 0) + 1;
    }
    renderState(); persistDemo();
  }
}

async function demoApply(activePlan: BookingPlan, checkpointDates?: string[], continuing = false): Promise<void> {
  demoCancelled = false;
  const before = state.run?.planId === activePlan.id ? state.run : undefined;
  if (!continuing) demoCheckpointDates = checkpointDates ?? [];
  const checkpoints = demoCheckpointDates;
  const jobId = continuing ? pausedJob()?.id : crypto.randomUUID();
  state.job = undefined;
  state.run = {
    planId: activePlan.id, status: 'running', startedAt: before?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    results: activePlan.days.map((day) => before?.results.find((result) => result.date === day.date) ?? ({ date: day.date, status: day.action === 'create' || day.action === 'overwrite' ? 'pending' : 'skipped', message: day.action === 'create' || day.action === 'overwrite' ? t('Wartet auf Buchung') : day.reason || t('Keine Änderung') })),
  };
  for (const result of state.run.results) {
    if (result.status === 'verified' || result.status === 'skipped') continue;
    if (demoCancelled) break;
    result.status = 'running'; result.message = t('Lokale Buchung wird geprüft …'); renderState();
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (demoCancelled) { result.status = 'pending'; result.message = t('Noch nicht gebucht'); break; }
    const day = activePlan.days.find((item) => item.date === result.date)!;
    const stored = demoSnapshot?.days.find((item) => item.date === result.date);
    if (stored) { stored.entries = structuredClone(day.proposed); stored.fingerprint = demoFingerprint(stored.date, stored.entries); }
    result.status = 'verified'; result.message = t('Lokal gespeichert und verifiziert (Testdaten)'); state.run.updatedAt = new Date().toISOString();
    if (checkpoints.includes(day.date) && state.run.results.some(item => item.status === 'pending')) {
      state.run.status = 'paused'; state.run.checkpointDate = day.date;
      state.job = { id: jobId!, kind: 'apply', status: 'paused', connectionId: state.connection?.generation ?? 'demo', month: activePlan.settings.month, startedAt: state.run.startedAt, updatedAt: state.run.updatedAt, checkpointId: crypto.randomUUID() };
      state.plan = plan = activePlan; persistDemo(); renderState(); return;
    }
    persistDemo(); renderState();
  }
  state.run.status = demoCancelled ? 'stopped' : 'complete';
  state.run.updatedAt = new Date().toISOString();
  state.snapshot = undefined;
  state.job = undefined;
  plan = { ...activePlan, canReview: false };
  state.plan = plan;
}

async function applyPlan(): Promise<void> {
  const review = confirmed;
  if (!canWrite() || !review || !applyDialog.open || !currentConfirmation() || (needsAccountConfirmation(review.plan) && !input('account-confirmation').checked)) return;
  const confirmation = accountConfirmation(review);
  const checkpointDates = !review.resumeJobId && input('pause-verification').checked ? verificationDates(review.plan) : undefined;
  closeConfirmation();
  const activePlan = review.plan;
  approvedPlanRevision = undefined;
  applying = true; localError = ''; renderState();
  try {
    if (isDemo) await demoApply(activePlan, checkpointDates, Boolean(review.resumeJobId));
    else {
      await message(review.resumeJobId
        ? { type: 'PANEL_CONTINUE', jobId: review.resumeJobId, planId: activePlan.id, expectedPlanRevision: review.planRevision, ...(confirmation ? { confirmation } : {}) }
        : { type: 'PANEL_APPLY', plan: activePlan, expectedPlanRevision: review.planRevision, ...(confirmation ? { confirmation } : {}), ...(checkpointDates ? { options: { checkpointDates } } : {}) });
    }
  } catch (error) { localError = errorText(error); }
  finally { applying = false; renderState(); persistDemo(); if (isPaused()) void refreshApproval(); }
}

async function cancelRun(): Promise<void> {
  try {
    if (isDemo) {
      demoCancelled = true;
      if (isPaused()) {
        if (state.run) state.run.status = 'stopped';
        state.job = undefined; state.snapshot = undefined;
        if (plan) state.plan = plan = { ...plan, canReview: false };
        revokeApproval(); persistDemo();
      }
    }
    else {
      const job = activeJob() ?? pausedJob();
      if (!job) return;
      await message({ type: 'PANEL_CANCEL', jobId: job.id });
    }
    renderState();
  } catch (error) { showError(errorText(error)); }
}

function transferStatus(text: string): void {
  $('transfer-status').textContent = text;
  $('transfer-status').hidden = !text;
}

function exportSettings(): void {
  if (transferBlocked()) return;
  try {
    const contents = serializeSettingsBackup(readSettings());
    downloadJson(contents, `hibob-settings-${settings.month}.json`);
    transferStatus(t('Die Einstellungssicherung wurde zum Download vorbereitet.'));
  } catch (error) { showError(errorText(error)); }
}

function downloadJson(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  // Keep the URL alive long enough for Chrome to begin the local download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBookingPlan(): void {
  if (!canExportPlan() || !plan) return;
  try {
    const reviewed = structuredClone(plan);
    delete reviewed.snapshot.context;
    const exported = { format: 'hibob-attendance-review', version: 1, planRevision: planRevision(), plan: reviewed, ...(state.run?.planId === plan.id ? { run: structuredClone(state.run) } : {}) };
    downloadJson(JSON.stringify(exported, null, 2) + '\n', `hibob-booking-plan-${reviewed.settings.month}.json`);
    $('export-plan-status').textContent = t('Download vorbereitet.'); $('export-plan-status').hidden = false;
  } catch (error) { showError(errorText(error)); }
}

async function reviewSettingsFile(file: File): Promise<void> {
  if (transferBlocked()) return;
  const generation = ++importGeneration;
  transferStatus('');
  try {
    if (file.size > MAX_SETTINGS_BACKUP_BYTES) throw new Error(t('Die Einstellungsdatei darf höchstens 64 KB groß sein.'));
    const candidate = parseSettingsBackup(await file.text());
    if (generation !== importGeneration) return;
    if (transferBlocked()) throw new Error(t('Während eines Vorgangs können keine Einstellungen importiert werden.'));
    importCandidate = candidate;
    const list = $('import-details');
    list.replaceChildren();
    detailsLine(list, t('Monat'), monthLabel(candidate.month));
    detailsLine(list, t('Bundesland'), t(GERMAN_STATES.find(item => item.code === candidate.state)!.name));
    detailsLine(list, t('Arbeitszeit'), `${candidate.start}–${candidate.end}`);
    detailsLine(list, t('Pause'), candidate.useBreak ? `${candidate.breakStart}–${candidate.breakEnd}` : t('Keine Pause'));
    detailsLine(list, t('Variable Zeiten'), candidate.variable ? t('±{minutes} Min.', { minutes: candidate.variationMinutes }) : t('Nein'));
    detailsLine(list, t('Zusätzliche Tage ausschließen'), candidate.excludedDates.length ? candidate.excludedDates.join(', ') : t('Keine'));
    const holidayAnswer = (value: boolean | null) => value === null ? t('Nicht festgelegt') : value ? t('Ja') : t('Nein');
    detailsLine(list, t('Arbeitsort in der Stadt Augsburg?'), holidayAnswer(candidate.localHolidays.augsburg));
    detailsLine(list, t('Mariä Himmelfahrt am Arbeitsort Feiertag?'), holidayAnswer(candidate.localHolidays.assumption));
    detailsLine(list, t('Fronleichnam am Arbeitsort Feiertag?'), holidayAnswer(candidate.localHolidays.corpusChristi));
    importDialog.showModal();
  } catch (error) {
    if (generation === importGeneration) { importCandidate = undefined; showError(errorText(error)); }
  }
}

async function importSettings(): Promise<void> {
  if (!importCandidate || !importDialog.open || transferBlocked()) return;
  const next = importCandidate;
  importCandidate = undefined;
  importGeneration++;
  importDialog.close();
  settings = structuredClone(next);
  choices = {};
  fillSettings();
  // Use the same invalidation, storage and acknowledged-plan path as any
  // ordinary settings edit. Importing can never initiate a scan or a booking.
  await rebuild(true);
  if (!pendingDraft) transferStatus(t('Einstellungen übernommen. Prüfe vor dem Buchen die Monatsvorschau.'));
}

async function activateUpdate(): Promise<void> {
  if (!hasExtension || !state.update?.pendingVersion || transferBlocked() || state.job) return;
  updateRequested = true;
  revokeApproval();
  renderState();
  try { await message({ type: 'PANEL_ACTIVATE_UPDATE' }); }
  catch (error) { updateRequested = false; showError(errorText(error)); }
}

async function initialize(retry = false): Promise<void> {
  // The action opens the panel before its tab binding finishes. Subscribe first so
  // neither that binding nor a later reset can be lost during asynchronous boot.
  if (hasExtension && !retry) chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.sessionState) return;
    sessionRevision++;
    receiveState(changes.sessionState.newValue as SessionState ?? {});
    if (!initializing && !initializationFailed && !pendingDraft && !busy && !applying && !checkingPreflight && !activeJob() && !updating()) {
      if (state.plan && approvedPlanRevision === undefined && !refreshScheduled) {
        // A storage event alone never grants approval. Verify the newest
        // canonical record through an acknowledged controller request first.
        refreshScheduled = true;
        void refreshApproval().finally(() => { refreshScheduled = false; });
      }
    }
  });
  if (!retry) for (const state of GERMAN_STATES) { const option = node('option', t(state.name)); option.value = state.code; select('state').append(option); }
  initializing = true;
  initializationFailed = false;
  connectionRetryAvailable = false;
  localError = '';
  revokeApproval();
  renderState();
  let initialResponse: SessionState | undefined;
  try {
    if (hasExtension) {
      if (!preferencesLoaded) {
        const stored = await chrome.storage.local.get('settings') as { settings?: unknown };
        settings = storedSettings(stored.settings);
        preferencesLoaded = true;
      }
      initialResponse = await message({ type: 'PANEL_GET_STATE' });
    } else if (isDemo) {
      const savedSettings = localStorage.getItem('hibob-demo-settings');
      if (savedSettings) settings = storedSettings(JSON.parse(savedSettings));
      const savedState = sessionStorage.getItem('hibob-demo-session');
      if (savedState) { const parsed = JSON.parse(savedState); demoSnapshot = parsed.demoSnapshot; receiveState(parsed); }
    }
    if (state.plan && state.plan.settings.month === settings.month && renderablePlan(state.plan)) {
      plan = state.plan; settings = storedSettings(plan.settings); choices = structuredClone(plan.choices); seed = plan.seed;
      if (isDemo || sameJsonValue(initialResponse, state)) approvedPlanRevision = planRevision();
    }
    if (isDemo && (state.run?.status === 'running' || state.run?.status === 'paused')) {
      state.run.status = 'stopped';
      state.job = undefined;
      state.snapshot = undefined;
      if (plan) { plan = { ...plan, canReview: false }; state.plan = plan; }
    }
  } catch (error) { localError = errorText(error); initializationFailed = true; }
  initializing = false;
  fillSettings(); renderState();
  if (hasExtension && !initializationFailed && plan && approvedPlanRevision === undefined && !activeJob()) void refreshApproval();
}

$<HTMLFormElement>('settings-form').addEventListener('submit', (event) => event.preventDefault());
function settingsInput(): void {
  if (isRunning() || isPaused() || updating()) return;
  const next = readSettings();
  if (sameJsonValue(next, settings)) return;
  settings = next; updateConditionalFields();
  settingsChanged();
}
$('settings-form').addEventListener('input', settingsInput);
$('settings-form').addEventListener('change', settingsInput);
$('scan').addEventListener('click', () => { void scanMonth(); });
$('refresh-month').addEventListener('click', () => { void scanMonth(); });
$('settings-toggle').addEventListener('click', () => setSettingsOpen($('settings-options').hidden));
$('schedule-summary').addEventListener('click', () => setSettingsOpen($('settings-options').hidden));
$('redistribute').addEventListener('click', () => { void rebuild(true); });
$('conflicts').addEventListener('click', openConflicts);
$('close-conflicts').addEventListener('click', () => conflictDialog.close());
$('overwrite-all').addEventListener('click', () => chooseAll('overwrite'));
$('skip-all').addEventListener('click', () => chooseAll('skip'));
$('save-conflicts').addEventListener('click', () => { void saveChoices(); });
$('apply').addEventListener('click', () => openApply());
$('continue-run').addEventListener('click', () => { void (async () => { if (!isPaused() || isRunning()) return; if (hasExtension) await refreshApproval(); else approvedPlanRevision = planRevision(); openApply(true); })(); });
$('close-apply').addEventListener('click', closeConfirmation);
applyDialog.addEventListener('cancel', closeConfirmation);
input('account-confirmation').addEventListener('change', updateConfirmationButton);
input('pause-verification').addEventListener('change', () => { input('account-confirmation').checked = false; updateConfirmationButton(); });
select('draft-check-date').addEventListener('change', () => {
  if (!confirmed || !currentConfirmation()) return;
  const date = select('draft-check-date').value;
  confirmed.preflightDate = writableDays(confirmed.plan).some(day => day.date === date) ? date : '';
  input('account-confirmation').checked = false;
  updateConfirmationButton();
});
$('check-draft').addEventListener('click', () => { void checkPreflight(); });
$('confirm-apply').addEventListener('click', () => { void applyPlan(); });
$('cancel-run').addEventListener('click', () => { void cancelRun(); });
$('retry-plan').addEventListener('click', () => { if (pendingDraft && !rebuilding && !isRunning() && !updating()) void processDraft(pendingDraft); });
$('retry-connection').addEventListener('click', () => { if (updating()) return; if (initializationFailed) void initialize(true); else { connectionRetryAvailable = false; void refreshApproval(); } });
$('connect').addEventListener('click', () => { void changeConnection(); });
$('disconnect').addEventListener('click', () => { void changeConnection(true); });
$('build-preview').addEventListener('click', () => { if (!isRunning() && !updating() && !pendingDraft && state.snapshot?.month === settings.month) void rebuild(); });
$('export-settings').addEventListener('click', exportSettings);
$('export-plan').addEventListener('click', exportBookingPlan);
$('import-settings').addEventListener('click', () => {
  if (transferBlocked()) return;
  input('settings-file').value = '';
  input('settings-file').click();
});
$('settings-file').addEventListener('change', () => {
  const file = input('settings-file').files?.[0];
  if (file) void reviewSettingsFile(file);
});
$('cancel-import').addEventListener('click', () => { importCandidate = undefined; importGeneration++; importDialog.close(); });
importDialog.addEventListener('cancel', () => { importCandidate = undefined; importGeneration++; });
$('confirm-import').addEventListener('click', () => { void importSettings(); });
$('activate-update').addEventListener('click', () => { void activateUpdate(); });

void initialize();
