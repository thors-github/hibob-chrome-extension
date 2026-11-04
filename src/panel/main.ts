import './styles.css';
import { renderMonthCalendar } from './calendar';
import { buildMonthPlan, defaultSettings, formatMinutes, GERMAN_STATES, netMinutes } from '../domain/index';
import type { AccountConfirmation, AttendanceEntry, BookingPlan, ConflictChoices, DayPlan, ExecutionProfile, PreflightResult, MonthSnapshot, PlanEditLease, RunOptions, SessionState, Settings, SubmissionConsent, SubmissionReview, TimesheetStatus } from '../shared/types';
import { sameJsonValue } from '../shared/json';
import { contextFingerprint, executionFingerprint } from '../shared/context';
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
let redistributeAll = false;
let executionProfile: ExecutionProfile = 'fast-serial';
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
let confirmed: { plan: BookingPlan; planRevision: number; contextFingerprint: string; executionFingerprint: string; options: RunOptions; preflightDate: string; resumeJobId?: string; checkpointId?: string } | undefined;
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
type PanelView = 'month' | 'settings' | 'tools' | 'day' | 'run-details';
let panelView: PanelView = 'month';
let toolPage: 'booking' | 'transfer' | 'connection' = 'booking';
let selectedDate = '';
let calendarFocusDate = '';
let reviewChecksOpen = false;
let checkingSubmission = false;
let submittingMonth = false;
let approvedSubmission: { review: SubmissionReview; revision: number; planRevision: number } | undefined;
let submissionRequestVersion = 0;

interface Draft {
  version: number;
  changeId: string;
  settings: Settings;
  choices: ConflictChoices;
  seed: number;
  redistributeAll: boolean;
  lease?: PlanEditLease;
  preferencesSaved: boolean;
}

type PanelMessage = { type: string; month?: string; date?: string; plan?: BookingPlan; planId?: string; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; jobId?: string; confirmation?: AccountConfirmation; options?: RunOptions; reviewId?: string; expectedSubmissionRevision?: number; submissionConsent?: SubmissionConsent; enabled?: boolean };
type PanelResponse = { ok: boolean; state?: SessionState; error?: string; preflight?: PreflightResult };

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <header class="app-header">
      <button id="view-back" class="icon-button" type="button" aria-label="${t('Zurück')}" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h13"/></svg></button>
      <div class="app-mark" aria-hidden="true"><img src="/icons/app-icon.svg" alt="" width="30" height="30" /></div>
      <h1 id="view-title">${t('Monatsbuchung')}</h1>
      <button id="settings-toggle" class="icon-button settings-button" type="button" aria-controls="settings-view" aria-label="${t('Einstellungen')}"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9.5 3-.7 2.2-2 .9-2.1-.5-2.1 3.7 1.5 1.7v2l-1.5 1.7 2.1 3.7 2.2-.5 2 .9.6 2.2h4.3l.7-2.2 1.9-.9 2.2.5 2.1-3.7-1.5-1.7v-2l1.5-1.7-2.1-3.7-2.2.5-1.9-.9-.7-2.2z"/><circle cx="11.7" cy="12" r="3.2"/></svg><span>${t('Einstellungen')}</span></button>
    </header>
    <div id="update-notice" class="notice" role="status" hidden></div>
    <div id="demo-banner" class="demo-banner" hidden>${t('Testmodus · keine echten Buchungen')}</div>
    <div id="operation-controls" hidden><button id="return-to-run" class="text-button" type="button">${t('Zur Buchung')}</button><button id="cancel-run" class="button danger" hidden>${t('Restliche Tage stoppen')}</button></div>
    <div id="main-error" class="notice error" role="alert" hidden></div>
    <div id="submission-result" class="notice" role="status" hidden></div>
    <button id="retry-plan" class="button wide" hidden>${t('Vorschau erneut prüfen')}</button>
    <button id="retry-connection" class="button wide" hidden>${t('Verbindung erneut prüfen')}</button>
    <main id="month-view">
      <div id="connection" class="connection"><span class="connection-dot" aria-hidden="true"></span><div><p id="connection-title">${t('Mit HiBob verbinden')}</p><p id="connection-detail" class="muted"></p></div></div>
      <div id="api-capability-notice" class="notice" role="status" hidden></div>
      <div id="account-context-notice" hidden></div>
      <div id="submission-notice" class="submission-notice" role="status" hidden><span id="submission-notice-text"></span></div>
      <div class="field month-field"><label for="month" class="visually-hidden">${t('Monat')}</label><input id="month" name="month" type="month" required /></div>
      <div id="schedule-summary" class="schedule-summary"><strong id="schedule-hours"></strong><span id="schedule-details"></span></div>
      <section class="preview" aria-label="${t('Monatsvorschau')}">
        <h2 id="preview-title" class="visually-hidden">${t('Monatsvorschau')}</h2><p id="preview-subtitle" class="visually-hidden"></p>
        <p id="preview-empty" class="hint">${t('Vorschau erstellen, dann die Buchungen bestätigen.')}</p>
        <div id="preview-summary" class="preview-summary" hidden></div>
        <div id="plan-errors" class="notice error" role="alert" hidden></div>
        <div id="calendar"></div><div id="calendar-legend" class="calendar-legend"></div>
      </section>
      <section id="scan-progress" class="notice" role="status" hidden></section>
      <section id="draft-check-result" class="notice draft-check-result" role="status" aria-labelledby="draft-check-result-title" hidden><h2 id="draft-check-result-title">${t('Plan geprüft – nicht gespeichert')}</h2><dl id="draft-check-details" class="confirm-details"></dl><p class="hint">${t('Zum Fortfahren den Monat erneut einlesen.')}</p></section>
      <section id="paused-card" class="notice paused-card" hidden aria-labelledby="paused-title"><h2 id="paused-title">${t('Für Kontrolle pausiert')}</h2><p id="paused-description"></p><button id="continue-run" class="button primary wide">${t('Restliche Tage fortsetzen')}</button></section>
      <section id="run-panel" class="run-panel" aria-labelledby="run-title" hidden><h2 id="run-title" class="visually-hidden">${t('Buchungsverlauf')}</h2><div id="run-status" class="run-summary" aria-live="polite"></div><p id="run-timing" class="hint" hidden></p><div id="run-uncertain" class="notice error" role="alert" hidden></div><p id="run-impact" class="hint" hidden></p><button id="run-details" class="text-button" type="button">${t('Ergebnisse ansehen')}</button></section>
      <footer id="booking-footer" class="footer month-actions"><div class="footer-buttons">
        <button id="connect" class="button primary wide">${t('Mit HiBob anmelden')}</button>
        <button id="scan" class="button primary wide" disabled>${t('Vorschau erstellen')}</button>
        <button id="build-preview" class="button primary wide" hidden>${t('Vorschau erstellen')}</button>
        <button id="conflicts" class="button primary wide" hidden></button>
        <button id="apply" class="button primary wide" disabled hidden>${t('Jetzt buchen')}</button>
        <button id="review-submission" class="button primary wide" type="button" hidden>${t('Monatsabschluss prüfen')}</button>
      </div><p id="footer-hint" class="hint">${t('Es wird erst nach deiner Bestätigung gespeichert.')}</p></footer>
      <button id="refresh-month" class="text-button refresh-month" type="button" hidden>${t('Monat neu einlesen')}</button>
    </main>
    <section id="settings-view" class="view-body" hidden>
      <form id="settings-form"><fieldset id="settings-fieldset">
        <div id="settings-options">
          <div class="fields">
            <div class="field"><label for="start">${t('Arbeitsbeginn')}</label><input id="start" name="start" type="time" required /></div>
            <div class="field"><label for="end">${t('Arbeitsende')}</label><input id="end" name="end" type="time" required /></div>
          </div>
          <div class="toggle-row"><label for="useBreak"><input id="useBreak" name="useBreak" type="checkbox" />${t('Pause berücksichtigen')}</label><small>${t('unbezahlt')}</small></div>
          <div id="break-fields" class="fields subfields"><div class="field"><label for="breakStart">${t('Pause von')}</label><input id="breakStart" name="breakStart" type="time" /></div><div class="field"><label for="breakEnd">${t('Pause bis')}</label><input id="breakEnd" name="breakEnd" type="time" /></div></div>
          <div class="variation-box"><div class="toggle-row"><label for="variable"><input id="variable" name="variable" type="checkbox" />${t('Variable Zeiten')}</label></div><p id="variation-summary" class="hint"></p><div id="variation-controls" class="range-field" hidden><div class="range-label"><label for="variationMinutes">${t('Spielraum für Beginn und Ende')}</label><output id="variation-value" for="variationMinutes"></output></div><input id="variationMinutes" name="variationMinutes" type="range" min="0" max="30" step="1" /><p class="hint">${t('Die Pause bleibt fest. Fünf Arbeitstage ergeben genau 40 Netto-Stunden; Teilwochen werden anteilig berechnet.')}</p></div></div>
          <div class="field state-field"><label for="state">${t('Bundesland')}</label><select id="state" name="state" required></select></div>
          <div id="local-holidays" class="local-holidays" hidden><p class="hint">${t('Für diesen Arbeitsort gelten teilweise örtliche Feiertage. Bitte die zutreffenden Angaben wählen.')}</p><div id="augsburg-field" class="field" hidden><label for="augsburg">${t('Arbeitsort in der Stadt Augsburg?')}</label><select id="augsburg"><option value="">${t('Bitte auswählen')}</option><option value="yes">${t('Ja')}</option><option value="no">${t('Nein')}</option></select></div><div id="assumption-field" class="field" hidden><label for="assumption">${t('Mariä Himmelfahrt am Arbeitsort Feiertag?')}</label><select id="assumption"><option value="">${t('Bitte auswählen')}</option><option value="yes">${t('Ja')}</option><option value="no">${t('Nein')}</option></select></div><div id="corpus-field" class="field" hidden><label for="corpusChristi">${t('Fronleichnam am Arbeitsort Feiertag?')}</label><select id="corpusChristi"><option value="">${t('Bitte auswählen')}</option><option value="yes">${t('Ja')}</option><option value="no">${t('Nein')}</option></select></div></div>
          <div class="field excluded-field"><label for="excludedDates">${t('Zusätzliche Tage ausschließen')}</label><textarea id="excludedDates" rows="2" placeholder="2026-11-05&#10;2026-11-18"></textarea><p class="hint">${t('Ein Datum pro Zeile im Format JJJJ-MM-TT. Tage lassen sich auch in den Tagesdetails abwählen.')}</p></div>
        </div>
      </fieldset></form>
      <nav class="settings-links" aria-label="${t('Weitere Einstellungen')}"><button id="booking-options-link" type="button">${t('Buchung und Prüfungen')}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button><button id="transfer-link" type="button">${t('Import und Export')}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button><button id="connection-link" type="button">${t('Verbindung und Version')}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></nav>
      <button id="settings-back" class="button primary wide view-return" type="button">${t('Zur Monatsübersicht')}</button>
    </section>
    <section id="tools-view" class="view-body" hidden>
      <div id="booking-options"><div class="reminder-preference toggle-row"><label for="reminders-enabled"><input id="reminders-enabled" type="checkbox" />${t('An Monatsabschluss erinnern')}</label></div><p class="hint reminder-description">${t('Rote Zahl ab den letzten sieben Monatstagen, bis der Abschluss bestätigt ist.')}</p><button id="submit-month" class="button wide" type="button" disabled>${t('Monat einreichen (Submit)')}</button><div id="profile-field" class="field"><label for="execution-profile">${t('Buchungsmodus')}</label><select id="execution-profile"><option value="fast-serial">${t('Schnell – monatlich prüfen')}</option><option value="strict">${t('Streng – jeden Tag einzeln prüfen')}</option></select><p class="hint">${t('Im schnellen Modus werden nur nötige Änderungen nacheinander gespeichert. Für eine Prüfung nach jedem Tag den strengen Modus wählen.')}</p></div><button id="redistribute" class="button wide" hidden>${t('Alles neu verteilen')}</button><button id="tool-check-plan" class="button wide" disabled>${t('Plan prüfen – ohne Speichern')}</button><button id="edit-conflicts" class="button wide" hidden>${t('Entscheidungen zu vorhandenen Buchungen ändern')}</button><button id="view-history" class="button wide" hidden>${t('Buchungsverlauf ansehen')}</button></div>
      <div id="transfer-options" hidden><p class="hint">${t('Übertrage deine Vorgaben zwischen Installationen. HiBob-Daten und Buchungsverläufe werden nicht exportiert.')}</p><div class="transfer-actions"><button id="export-settings" class="button">${t('Einstellungen exportieren')}</button><button id="import-settings" class="button">${t('Einstellungen importieren')}</button></div><input id="settings-file" type="file" accept="application/json,.json" hidden /><p id="transfer-status" class="hint" role="status" hidden></p><button id="export-plan" class="button wide" hidden>${t('Buchungsplan herunterladen')}</button><p id="export-plan-hint" class="hint" hidden>${t('Enthält private Anwesenheitsdaten. Nur lokal und vertraulich verwenden.')}</p><p id="export-plan-status" class="hint" role="status" hidden></p></div>
      <div id="connection-options" hidden><div class="version-bar"><span id="installed-version"></span><button id="activate-update" class="button subtle" hidden>${t('Jetzt aktualisieren')}</button></div><p id="connection-technical" class="hint"></p><p id="connection-account" class="hint"></p><p id="connection-scan-detail" class="hint"></p><button id="disconnect" class="button wide" hidden>${t('Verbindung trennen')}</button></div>
      <button id="tools-back" class="button wide view-return" type="button">${t('Zurück zu Einstellungen')}</button>
    </section>
    <section id="day-view" class="view-body" hidden><div id="day-navigation" class="day-navigation"><button id="previous-day" class="button" type="button" aria-label="${t('Vorheriger Tag')}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h13"/></svg></button><h2 id="day-title"></h2><button id="next-day" class="button" type="button" aria-label="${t('Nächster Tag')}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m10 6 6 6-6 6M16 12H3"/></svg></button></div><div id="day-content"></div><div id="day-week"></div><button id="day-back" class="button wide view-return" type="button">${t('Zur Monatsübersicht')}</button></section>
    <section id="run-details-view" class="view-body" hidden><ul id="run-results" class="run-results"></ul><button id="run-details-back" class="button wide view-return" type="button">${t('Zur Monatsübersicht')}</button></section>
  </div>
  <dialog id="conflict-dialog" aria-labelledby="conflict-title"><div class="dialog-body"><h2 id="conflict-title">${t('Vorhandene Buchungen prüfen')}</h2><p class="hint">${t('Entscheide für jeden Tag. Beim Überschreiben werden die bisherigen Arbeits- und Pauseneinträge durch die Vorschau ersetzt.')}</p><div class="dialog-toolbar"><button id="overwrite-all" class="button">${t('Alle überschreiben')}</button><button id="skip-all" class="button">${t('Alle überspringen')}</button></div><div id="conflict-error" class="notice error" role="alert" hidden></div><div id="conflict-items"></div></div><div class="dialog-footer"><button id="close-conflicts" class="button">${t('Zurück')}</button><button id="save-conflicts" class="button primary">${t('Entscheidungen übernehmen')}</button></div></dialog>
  <dialog id="apply-dialog" aria-labelledby="apply-title"><div class="dialog-body"><h2 id="apply-title">${t('Buchung bestätigen')}</h2><p id="apply-description" class="hint"></p><dl id="apply-details" class="confirm-details"></dl><button id="review-days" class="text-button" type="button">${t('Tage ansehen')}</button><div id="account-confirmation-field" class="notice account-confirmation" hidden><label class="ack-label" for="account-confirmation"><input id="account-confirmation" type="checkbox" /><span id="account-confirmation-label"></span></label></div><button id="review-checks" class="text-button" type="button">${t('Zusätzliche Prüfungen')}</button><section id="additional-checks" class="additional-checks" hidden><div id="checkpoint-field" class="checkpoint-field"><label class="ack-label" for="pause-verification"><input id="pause-verification" type="checkbox" /><span>${t('Für Kontrolle pausieren')}</span></label><p id="checkpoint-description" class="hint"></p></div><div id="preflight-controls" class="draft-check-controls field"><label for="draft-check-date">${t('Tag für Planprüfung')}</label><select id="draft-check-date" disabled></select><p class="hint">${t('Der ausgewählte Tag und die geplanten Daten werden ohne Änderungen geprüft. Das bestätigt keine serverseitige Speicherung. Danach den Monat erneut einlesen.')}</p><button id="check-draft" class="button wide" disabled>${t('Plan prüfen – ohne Speichern')}</button></div></section><p id="execution-disclosure" class="hint"></p><p id="execution-consent-reset" class="hint" role="status" hidden></p></div><div class="dialog-footer"><button id="close-apply" class="button">${t('Zurück')}</button><button id="confirm-apply" class="button primary" disabled>${t('Buchungen starten')}</button></div></dialog>
  <dialog id="submission-dialog" aria-labelledby="submission-title"><div class="dialog-body"><h2 id="submission-title">${t('Monatsabschluss prüfen')}</h2><p id="submission-description" class="hint"></p><dl id="submission-details" class="confirm-details"></dl><div id="submission-issues" class="notice error" role="alert" hidden></div><p id="submission-early" class="notice" hidden>${t('Du reichst den Monat vor seinem Ende ein. Es zählen nur die bereits gespeicherten Zeiten.')}</p><p class="hint">${t('Nach dem Einreichen können Änderungen eine Wiederöffnung oder Freigabe in HiBob benötigen.')}</p><label id="submission-confirmation-field" class="ack-label" for="submission-confirmation"><input id="submission-confirmation" type="checkbox" /><span id="submission-confirmation-label"></span></label></div><div class="dialog-footer"><button id="close-submission" class="button" type="button">${t('Zurück')}</button><button id="confirm-submission" class="button primary" type="button" disabled>${t('Monat jetzt einreichen')}</button></div></dialog>
  <dialog id="import-dialog" aria-labelledby="import-title"><div class="dialog-body"><h2 id="import-title">${t('Einstellungen importieren?')}</h2><p class="hint">${t('Diese Vorgaben ersetzen deine aktuellen Einstellungen. Der Import startet keine Buchungen; prüfe danach die Monatsvorschau.')}</p><dl id="import-details" class="confirm-details"></dl></div><div class="dialog-footer"><button id="cancel-import" class="button">${t('Abbrechen')}</button><button id="confirm-import" class="button primary">${t('Einstellungen übernehmen')}</button></div></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const conflictDialog = $<HTMLDialogElement>('conflict-dialog');
const applyDialog = $<HTMLDialogElement>('apply-dialog');
const importDialog = $<HTMLDialogElement>('import-dialog');
const submissionDialog = $<HTMLDialogElement>('submission-dialog');
const exclusionField = document.querySelector<HTMLElement>('.excluded-field')!;
$('booking-options').prepend(exclusionField);
$('main-error').after($('run-uncertain'), $('run-impact'));
$<HTMLTextAreaElement>('excludedDates').setAttribute('form', 'settings-form');
function setSettingsOpen(open: boolean): void { navigate(open ? 'settings' : 'month'); }

function navigate(view: PanelView, focusId?: string): void {
  if (applyDialog.open) closeConfirmation();
  if (submissionDialog.open || checkingSubmission) closeSubmissionReview();
  panelView = view;
  renderState();
  const scrolling = document.scrollingElement ?? document.documentElement; scrolling.scrollTop = 0; scrolling.scrollLeft = 0;
  const target = focusId ?? (view === 'month' ? `calendar-${calendarFocusDate}` : view === 'settings' ? 'start' : view === 'day' ? 'day-title' : 'view-title');
  const element = document.getElementById(target) ?? $('view-title');
  if (!element.hasAttribute('tabindex') && !element.matches('button, input, select, textarea')) element.tabIndex = -1;
  element.focus({ preventScroll: true });
}

function openTool(page: typeof toolPage): void { toolPage = page; navigate('tools'); }
function openDay(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(settings.month + '-')) return;
  selectedDate = date; calendarFocusDate = date; navigate('day');
}

function renderViews(): void {
  for (const view of ['month', 'settings', 'tools', 'day', 'run-details'] as const) $(`${view}-view`).hidden = panelView !== view;
  const title = panelView === 'month' ? t('Monatsbuchung') : panelView === 'settings' ? t('Einstellungen') : panelView === 'day' ? t('Tagesdetails') : panelView === 'run-details' ? t('Buchungsverlauf') : toolPage === 'booking' ? t('Buchung und Prüfungen') : toolPage === 'transfer' ? t('Import und Export') : t('Verbindung und Version');
  $('view-title').textContent = title;
  $('view-back').hidden = panelView === 'month';
  $('settings-toggle').hidden = panelView !== 'month';
  for (const page of ['booking', 'transfer', 'connection'] as const) $(page === 'booking' ? 'booking-options' : `${page}-options`).hidden = toolPage !== page;
  renderDayView();
}

function revealInvalidSettings(): boolean {
  const form = $<HTMLFormElement>('settings-form');
  const invalid = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid, select:invalid, textarea:invalid');
  if (invalid) {
    setSettingsOpen(true);
    for (let parent = invalid.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    invalid.focus();
  }
  if (!input('month').checkValidity()) { navigate('month', 'month'); return input('month').reportValidity(); }
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

function isRunning(): boolean { return busy || applying || checkingPreflight || checkingSubmission || submittingMonth || connecting || Boolean(activeJob()) || (!state.job && state.run?.status === 'running'); }

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
  closeSubmissionReview();
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
  if (submissionDialog.open) closeSubmissionReview();
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

function selectedExecutionOptions(reviewed: BookingPlan, resume = false): RunOptions {
  if (resume) return { executionProfile: state.run?.executionProfile ?? 'strict' };
  const checkpointDates = input('pause-verification').checked ? verificationDates(reviewed) : undefined;
  const selected = select('execution-profile').value === 'strict' ? 'strict' : 'fast-serial';
  return { executionProfile: checkpointDates?.length ? 'strict' : selected, ...(checkpointDates?.length ? { checkpointDates } : {}) };
}

function executionScope(options: RunOptions, resume = false): string {
  return resume ? state.run?.executionFingerprint ?? '' : executionFingerprint(options);
}

function renderExecutionDisclosure(): void {
  const profile = confirmed?.options.executionProfile ?? executionProfile;
  if ($('apply-execution-mode')) $('apply-execution-mode').textContent = profile === 'strict' ? t('Streng – jeden Tag einzeln prüfen') : t('Schnell – monatlich prüfen');
  if ($('apply-mode-term')) { $('apply-mode-term').hidden = profile !== 'strict'; $('apply-mode-description').hidden = profile !== 'strict'; }
  $('execution-disclosure').textContent = profile === 'fast-serial'
    ? t('Der Monat wird vor und nach dem Speichern geprüft. Der Lauf ist keine gemeinsame Transaktion: Bei einem Fehler können einzelne Tage bereits gespeichert sein.')
    : t('Die Extension kontrolliert jeden gespeicherten Tag. Bei einer Abweichung stoppt der Lauf.');
}

function changeExecutionOptions(checkpoints = false): void {
  if (checkpoints && input('pause-verification').checked) {
    executionProfile = 'strict';
    select('execution-profile').value = executionProfile;
  }
  if (confirmed) {
    confirmed.options = selectedExecutionOptions(confirmed.plan, Boolean(confirmed.resumeJobId));
    confirmed.executionFingerprint = executionScope(confirmed.options, Boolean(confirmed.resumeJobId));
    input('account-confirmation').checked = false;
    $('execution-consent-reset').hidden = false;
    $('execution-consent-reset').textContent = checkpoints && input('pause-verification').checked
      ? t('Kontrollpausen verwenden den strengen Modus. Bitte das Konto für diesen Ablauf erneut bestätigen.')
      : t('Der Buchungsmodus wurde geändert. Bitte das Konto für diesen Ablauf erneut bestätigen.');
  }
  renderExecutionDisclosure();
  updateConfirmationButton();
}

function currentConfirmation(): boolean {
  return Boolean(confirmed && approved() && !isRunning() && !rebuilding
    && (confirmed.resumeJobId ? pausedJob()?.id === confirmed.resumeJobId && pausedJob()?.checkpointId === confirmed.checkpointId : !isPaused())
    && confirmed.planRevision === planRevision() && sameJsonValue(confirmed.plan, plan)
    && sameJsonValue(confirmed.plan, state.plan) && sameJsonValue(confirmed.plan.snapshot, state.snapshot)
    && confirmed.contextFingerprint === contextFingerprint(state.snapshot?.context)
    && Boolean(confirmed.executionFingerprint)
    && confirmed.executionFingerprint === executionScope(selectedExecutionOptions(confirmed.plan, Boolean(confirmed.resumeJobId)), Boolean(confirmed.resumeJobId)));
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
  if (approvedSubmission && (!sameJsonValue(previous.connection, state.connection) || approvedSubmission.revision !== state.submissionRevision || approvedSubmission.planRevision !== (state.planRevision ?? 0) || !sameJsonValue(approvedSubmission.review, state.submissionReview) || activeJob() || updating())) closeSubmissionReview(false);
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
  if (confirmed && (!sameJsonValue(previous.connection, state.connection) || confirmed.planRevision !== planRevision() || !sameJsonValue(confirmed.plan, state.plan) || !sameJsonValue(confirmed.plan.snapshot, state.snapshot) || confirmed.contextFingerprint !== contextFingerprint(state.snapshot?.context) || activeJob() || (confirmed.resumeJobId ? pausedJob()?.id !== confirmed.resumeJobId || pausedJob()?.checkpointId !== confirmed.checkpointId || confirmed.executionFingerprint !== state.run?.executionFingerprint : isPaused()))) closeConfirmation();
  if (approvedPlanRevision !== undefined && (approvedPlanRevision !== planRevision() || !sameJsonValue(plan, state.plan))) approvedPlanRevision = undefined;
  if (!initializing && !pendingDraft) {
    if (state.plan && state.snapshot && state.plan.settings.month === settings.month) {
      plan = state.plan;
      if (!sameJsonValue(settings, plan.settings)) { settings = storedSettings(plan.settings); fillSettings(); }
      choices = structuredClone(plan.choices);
      seed = plan.seed;
      redistributeAll = plan.redistributeAll === true;
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
        seed = plan.seed; redistributeAll = plan.redistributeAll === true;
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
  if (newSeed) { redistributeAll = true; seed = freshSeed(); }
  const draft = beginDraft();
  await processDraft(draft);
}

function beginDraft(newSeed = false): Draft {
  preflightResult = undefined;
  if (newSeed) seed = freshSeed();
  const draft: Draft = {
    version: ++buildVersion, changeId: crypto.randomUUID(), settings: structuredClone(settings),
    choices: structuredClone(choices), seed, redistributeAll, preferencesSaved: false,
  };
  pendingDraft = draft;
  revokeApproval();
  if (conflictDialog.open) conflictDialog.close();
  rebuilding = true;
  localError = '';
  plan = state.snapshot?.month === settings.month ? buildMonthPlan(draft.settings, state.snapshot, draft.choices, draft.seed, { redistributeAll: draft.redistributeAll }) : undefined;
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
    const next = buildMonthPlan(draft.settings, state.snapshot, draft.choices, draft.seed, { redistributeAll: draft.redistributeAll });
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

function submissionStatusLabel(status: TimesheetStatus | undefined): string {
  switch (status) {
    case 'Submitted': return t('Eingereicht');
    case 'Approved': return t('Genehmigt');
    case 'PendingProjectApproval': return t('Projektfreigabe ausstehend');
    case 'Rejected': return t('Zurückgewiesen – erneut prüfen');
    case 'WaitingForSubmission': return t('Bereit zum Einreichen');
    case 'Locked': return t('In HiBob gesperrt');
    case 'Open': return t('Noch nicht eingereicht');
    default: return t('Abschlussstatus prüfen');
  }
}

function isClosedStatus(status: TimesheetStatus | undefined): boolean {
  return status === 'Submitted' || status === 'Approved' || status === 'PendingProjectApproval';
}

function displayedSubmissionStatus(): TimesheetStatus | undefined {
  const result = state.submissionResult;
  if (result?.month === settings.month && result.status === 'verified' && isClosedStatus(result.periodStatus)) return result.periodStatus;
  const review = state.submissionReview;
  if (review?.month === settings.month && review.connectionId === state.connection?.generation) return review.period.status;
  const snapshot = state.snapshot?.month === settings.month ? state.snapshot : plan?.snapshot.month === settings.month ? plan.snapshot : undefined;
  return snapshot?.submission?.status;
}

function submissionIsClosed(): boolean { return isClosedStatus(displayedSubmissionStatus()); }

function visibleDayPlans(): DayPlan[] {
  if (!submissionIsClosed()) return plan?.days ?? [];
  const snapshot = state.snapshot?.month === settings.month ? state.snapshot : plan?.snapshot;
  if (!snapshot) return [];
  return snapshot.days.map(day => ({ date: day.date, existing: day.entries, proposed: [], action: day.entries.length ? 'unchanged' : 'skip', eligible: day.entries.length > 0, fingerprint: day.fingerprint, netMinutes: day.reportedMinutes === null ? null : day.reportedMinutes ?? netMinutes(day.entries), existingNetMinutes: day.reportedMinutes === null ? null : day.reportedMinutes ?? netMinutes(day.entries), reason: day.nonWorking ?? day.absence }));
}

function reminderMonth(): string | undefined {
  const due = state.reminder?.enabled ? state.reminder.due : [];
  return due?.find(item => item.month === settings.month)?.month ?? due?.map(item => item.month).sort()[0];
}

function submissionActionMonth(): string | undefined {
  return (state.submissionResult?.status === 'uncertain' ? state.submissionResult.month : undefined) ?? reminderMonth()
    ?? (state.run?.status === 'complete' && state.run.planId === plan?.id || submissionIsClosed() ? settings.month : undefined);
}

function submissionNoticeMonth(month: string): string {
  return month === settings.month ? new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'Europe/Berlin' }).format(new Date(`${month}-01T12:00:00Z`)) : monthLabel(month);
}

function submissionLocalIssues(month: string): string[] {
  if (pendingDraft || rebuilding) return [t('Die Vorschau wird noch geprüft. Bitte danach erneut prüfen.')];
  if (preflightNeedsScan) return [t('Lies den Monat nach der Planprüfung erneut ein.')];
  if (plan?.settings.month !== month || submissionIsClosed()) return [];
  const applied = state.run?.planId === plan.id && state.run.status === 'complete'
    && writableDays(plan).every(day => state.run!.results.some(result => result.date === day.date && result.status === 'verified'));
  if (applied) return [];
  if (writableDays(plan).length || plan.days.some(day => day.action === 'conflict') || plan.errors.length) return [t('Erst vollständig buchen: Kläre offene Änderungen und Lücken in der Monatsvorschau.')];
  return [];
}

function closeSubmissionReview(notify = true): void {
  const reviewId = approvedSubmission?.review.id;
  approvedSubmission = undefined;
  submissionRequestVersion++;
  input('submission-confirmation').checked = false;
  input('submission-confirmation').disabled = true;
  $<HTMLButtonElement>('confirm-submission').disabled = true;
  if (submissionDialog.open) submissionDialog.close();
  if (notify && hasExtension && (reviewId || checkingSubmission)) void message({ type: 'PANEL_DISMISS_SUBMISSION', ...(reviewId ? { reviewId } : { expectedSubmissionRevision: state.submissionRevision ?? 0 }) }).catch(() => {});
}

function currentSubmissionReview(): boolean {
  const approved = approvedSubmission;
  return Boolean(approved && submissionDialog.open && hasExtension && connected() && !isRunning() && !isPaused() && !updating()
    && !pendingDraft && !rebuilding && !initializing && !initializationFailed
    && approved.revision === state.submissionRevision && approved.planRevision === (state.planRevision ?? 0)
    && state.connection?.generation === approved.review.connectionId
    && sameJsonValue(approved.review, state.submissionReview)
    && !submissionLocalIssues(approved.review.month).length
    && !(state.submissionResult?.month === approved.review.month && state.submissionResult.status === 'uncertain'));
}

function updateSubmissionButton(): void {
  const review = approvedSubmission?.review;
  const ready = currentSubmissionReview() && Boolean(review?.canSubmit) && !review?.issues.length && !isClosedStatus(review?.period.status);
  input('submission-confirmation').disabled = !ready;
  $<HTMLButtonElement>('confirm-submission').disabled = !ready || !input('submission-confirmation').checked;
}

async function openSubmissionReview(month: string): Promise<void> {
  if (!hasExtension || !connected() || isRunning() || isPaused() || updating() || rebuilding || pendingDraft || initializing || initializationFailed || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
  closeConfirmation();
  closeSubmissionReview(false);
  const version = ++submissionRequestVersion;
  const generation = state.connection?.generation;
  checkingSubmission = true; localError = ''; renderState();
  try {
    await message({ type: 'PANEL_REVIEW_SUBMISSION', month });
    const review = state.submissionReview;
    if (version !== submissionRequestVersion || state.connection?.generation !== generation || !review || review.month !== month || review.connectionId !== generation || activeJob() || typeof state.submissionRevision !== 'number') return;
    approvedSubmission = { review: structuredClone(review), revision: state.submissionRevision, planRevision: state.planRevision ?? 0 };
    const list = $('submission-details'); list.replaceChildren();
    detailsLine(list, t('Monat'), monthLabel(review.month));
    detailsLine(list, t('HiBob-Konto'), `${review.employeeLabel} · ${review.companyLabel}`);
    detailsLine(list, t('Gespeicherte Nettozeit'), review.netMinutes === null ? t('Stunden noch nicht berechenbar') : formatMinutes(review.netMinutes));
    detailsLine(list, t('Status'), submissionStatusLabel(review.period.status));
    const issues = [...new Set([...review.issues, ...submissionLocalIssues(month)])];
    $('submission-issues').replaceChildren();
    if (issues.length) { const ul = node('ul'); for (const issue of issues) ul.append(node('li', localizeText(issue))); $('submission-issues').append(ul); }
    $('submission-issues').hidden = !issues.length;
    $('submission-early').hidden = !review.early || !review.canSubmit;
    $('submission-title').textContent = t('Monatsabschluss prüfen');
    $('submission-description').textContent = t('Nur bereits in HiBob gespeicherte Zeiten werden eingereicht. Es werden keine weiteren Zeiten gebucht.');
    $('submission-confirmation-label').textContent = t('Ich bestätige das angezeigte Konto, die Firma und die gespeicherten Zeiten für {month}.', { month: monthLabel(month) });
    $('submission-confirmation-field').hidden = isClosedStatus(review.period.status);
    $('confirm-submission').hidden = isClosedStatus(review.period.status);
    $('confirm-submission').textContent = t('{month} jetzt einreichen', { month: monthLabel(month) });
    input('submission-confirmation').checked = false;
    submissionDialog.showModal();
  } catch (error) { if (version === submissionRequestVersion) showError(errorText(error)); }
  finally { checkingSubmission = false; renderState(); updateSubmissionButton(); }
}

async function submitReviewedMonth(): Promise<void> {
  const approved = approvedSubmission;
  if (!approved || !currentSubmissionReview() || !approved.review.canSubmit || approved.review.issues.length || !input('submission-confirmation').checked || $<HTMLButtonElement>('confirm-submission').disabled) return;
  const review = approved.review;
  const consent: SubmissionConsent = { reviewId: review.id, reviewRevision: approved.revision, connectionId: review.connectionId, accountKey: review.accountKey, contentFingerprint: review.contentFingerprint, eligibilityFingerprint: review.eligibilityFingerprint, confirmed: true };
  closeSubmissionReview(false);
  revokeApproval();
  panelView = 'month'; submittingMonth = true; localError = ''; renderState();
  try { await message({ type: 'PANEL_SUBMIT_MONTH', reviewId: review.id, expectedSubmissionRevision: approved.revision, submissionConsent: consent }); }
  catch (error) { showError(errorText(error)); }
  finally { submittingMonth = false; renderState(); }
}

function renderSubmission(): void {
  const dueMonth = submissionActionMonth();
  const due = state.reminder?.due.find(item => item.month === dueMonth);
  const closed = submissionIsClosed();
  const locked = isRunning() || isPaused() || updating() || initializing || initializationFailed || rebuilding || Boolean(pendingDraft);
  const notice = $('submission-notice');
  notice.hidden = !dueMonth;
  document.querySelector('.shell')!.classList.toggle('has-submission-notice', !notice.hidden);
  const needsCheck = due?.needsCheck || state.submissionResult?.status === 'uncertain' && state.submissionResult.month === dueMonth;
  const periodStatus = displayedSubmissionStatus() ?? due?.status;
  $('submission-notice-text').textContent = !dueMonth ? '' : needsCheck
    ? t('{month}: Abschlussstatus prüfen', { month: submissionNoticeMonth(dueMonth) })
    : closed && dueMonth === settings.month
      ? t('{month}: {status}', { month: submissionNoticeMonth(dueMonth), status: submissionStatusLabel(periodStatus) })
      : t('{month} noch einreichen', { month: submissionNoticeMonth(dueMonth) });
  if (state.reminder?.due.length && state.reminder.due.length > 1) $('submission-notice-text').append(document.createTextNode(t(' · +{count} weitere', { count: state.reminder.due.length - 1 })));
  input('reminders-enabled').checked = state.reminder?.enabled ?? true;
  input('reminders-enabled').disabled = locked || !hasExtension;
  $<HTMLButtonElement>('submit-month').disabled = locked || !connected() || !hasExtension;
  const button = $<HTMLButtonElement>('review-submission');
  button.hidden = !dueMonth || !connected() || !hasExtension;
  button.disabled = locked;
  const hasBookingAction = [...$('booking-footer').querySelectorAll<HTMLButtonElement>('.footer-buttons > button')].some(item => item !== button && !item.hidden);
  button.className = hasBookingAction ? 'text-button' : 'button primary wide';
  (hasBookingAction ? notice : $('booking-footer').querySelector('.footer-buttons')!).append(button);
  if (dueMonth) button.setAttribute('aria-label', t('Monatsabschluss für {month} prüfen', { month: monthLabel(dueMonth) }));
  if (closed) {
    $('apply').hidden = true;
    $('build-preview').hidden = true;
    $('scan').hidden = true;
    $('conflicts').hidden = true;
    $('edit-conflicts').hidden = true;
    $('redistribute').hidden = true;
    $('tool-check-plan').hidden = true;
    $('footer-hint').hidden = true;
  } else $('tool-check-plan').hidden = false;
  const result = state.submissionResult;
  const resultBox = $('submission-result');
  resultBox.hidden = !result || result.status === 'verified' && closed && result.month === settings.month;
  resultBox.className = `notice ${result?.status === 'verified' ? 'success' : 'error'}`;
  resultBox.setAttribute('role', result?.status === 'uncertain' ? 'alert' : 'status');
  resultBox.textContent = result ? `${monthLabel(result.month)} · ${result.status === 'uncertain' ? t('Einreichungsstatus unklar – zuerst erneut lesend prüfen.') : result.status === 'verified' ? submissionStatusLabel(result.periodStatus) : t('Nicht eingereicht')} · ${localizeText(result.message)}` : '';
  if (result?.status === 'uncertain') {
    const retry = node('button', t('Abschlussstatus prüfen'), 'text-button');
    retry.id = 'review-uncertain-submission'; retry.type = 'button'; retry.disabled = locked || !connected() || !hasExtension;
    retry.addEventListener('click', () => { void openSubmissionReview(result.month); });
    resultBox.append(document.createElement('br'), retry);
  }
  updateSubmissionButton();
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
  select('execution-profile').value = executionProfile;
  select('execution-profile').disabled = locked || initializing || initializationFailed;
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
  $('connection').classList.toggle('connected', bound);
  $('connection').classList.toggle('selected', !bound);
  $('account-context-notice').hidden = true;
  $('connect').hidden = isDemo || bound;
  $('disconnect').hidden = isDemo || !bound;
  $('connection-account').textContent = accountLabel();
  const scannedSnapshot = state.snapshot ?? plan?.snapshot;
  if (scannedSnapshot?.month === settings.month) {
    const time = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(scannedSnapshot.scannedAt));
    $('connection-scan-detail').textContent = t('Eingelesen: {time} Uhr · {period}', { time, period: scannedSnapshot.periodLabel });
  } else $('connection-scan-detail').textContent = '';
  $<HTMLButtonElement>('connect').disabled = transferBlocked();
  $<HTMLButtonElement>('disconnect').disabled = transferBlocked();
  $('connect').textContent = connecting ? t('Verbindung wird hergestellt …') : t('Mit HiBob anmelden');
  $('api-capability-notice').hidden = isDemo || !bound || canWrite();
  $('api-capability-notice').textContent = state.connection?.reason || (state.connection?.capabilities?.write ? t('Das Überschreiben vorhandener Einträge ist für diese API-Verbindung nicht freigegeben.') : t('Lesende API-Verbindung. Vorschau und Planprüfung sind verfügbar; Speichern ist noch nicht freigegeben.'));
  $('connection-technical').textContent = state.connection?.transport === 'temporary-tab' ? t('API über temporären Hintergrund-Tab') : bound && !isDemo ? t('Direkte API-Verbindung') : '';
  if (bound) {
    $('connection-title').textContent = accountLabel();
    $('connection-detail').textContent = isDemo ? t('Lokale Beispieldaten') : '';
    $('connection-detail').hidden = !isDemo;
  } else {
    $('connection-title').textContent = connecting ? t('Verbindung wird hergestellt …') : state.connection?.status === 'expired' ? t('HiBob-Anmeldung abgelaufen') : state.connection?.status === 'unsupported' ? t('HiBob-Verbindung nicht verfügbar') : t('Mit HiBob verbinden');
    $('connection-detail').textContent = state.connection?.reason || t('Melde dich über HiBob an, um deine Anwesenheiten einzulesen.');
    $('connection-detail').hidden = false;
  }

  const error = localError || state.error || statePollError || (state.job?.status === 'interrupted' ? t('Der letzte Vorgang wurde unterbrochen. Bitte den Monat erneut einlesen.') : '');
  $('main-error').hidden = !error;
  $('main-error').textContent = localizeText(error);
  $('retry-plan').hidden = !pendingDraft || rebuilding || locked;
  $('retry-connection').hidden = !hasExtension || (!initializationFailed && !connectionRetryAvailable) || initializing || locked;
  $<HTMLFieldSetElement>('settings-fieldset').disabled = locked || initializing || initializationFailed;
  $<HTMLTextAreaElement>('excludedDates').disabled = locked || initializing || initializationFailed;
  $<HTMLButtonElement>('settings-toggle').disabled = initializing || initializationFailed;
  input('month').disabled = locked || initializing || initializationFailed;
  $<HTMLButtonElement>('tool-check-plan').disabled = !approved() || locked || !plan || !writableDays(plan).length;
  $('schedule-hours').textContent = `${settings.start || '—'}–${settings.end || '—'} · ${settings.variable ? t('±{minutes} Min.', { minutes: settings.variationMinutes }) : t('feste Zeiten')}`;
  $('schedule-details').textContent = [settings.useBreak ? `${t('Pause')} ${settings.breakStart}–${settings.breakEnd}` : t('Ohne Pause'), t(GERMAN_STATES.find(item => item.code === settings.state)?.name || settings.state), settings.excludedDates.length ? t('{count} manuell ausgeschlossene Tage', { count: settings.excludedDates.length }) : ''].filter(Boolean).join(' · ');
  $<HTMLButtonElement>('scan').disabled = locked || initializing || initializationFailed || rebuilding || (!isDemo && !bound);
  $<HTMLButtonElement>('refresh-month').disabled = $<HTMLButtonElement>('scan').disabled;
  $('refresh-month').hidden = !state.snapshot;
  $('scan').hidden = !bound || Boolean(plan) || Boolean(state.snapshot && scanned) || running || paused;
  $('connect').hidden = isDemo || bound;
  $('scan').textContent = t('Vorschau erstellen');
  const progress = state.progress;
  $('scan-progress').hidden = !running || !progress;
  if (progress && running) {
    const label = node('div', undefined, 'progress-header');
    const stage = progress.stage ? { prepare: t('Prüfen'), write: t('Speichern'), verify: t('Kontrollieren') }[progress.stage] : '';
    label.append(node('span', [stage, localizeText(progress.message)].filter(Boolean).join(' · ')), node('span', `${progress.completed}/${progress.total}`));
    const bar = node('progress');
    bar.max = progress.total || 1;
    bar.value = progress.completed;
    bar.setAttribute('aria-label', progress.phase === 'scan' ? t('Monat einlesen') : progress.phase === 'submission' ? t('Monatsabschluss') : checkingPreflight ? t('Planprüfung') : t('Buchungsfortschritt'));
    $('scan-progress').replaceChildren(label, bar);
  }
  renderPreview();
  renderRun();
  renderPreflight();
  $('cancel-run').hidden = (!running && !paused) || connecting;
  $('cancel-run').textContent = paused || state.run?.status === 'running' ? t('Restliche Tage stoppen') : t('Abbrechen');
  $<HTMLButtonElement>('cancel-run').disabled = hasExtension && (!activeJob() && !pausedJob() || activeJob()?.status === 'cancelling');
  $('booking-footer').hidden = false;
  $('apply').hidden = !plan || paused || running || !state.snapshot;
  const finished = state.run?.status === 'complete' && state.run.planId === plan?.id;
  const noChanges = Boolean(plan && !plan.errors.length && !writableDays(plan).length);
  const unresolved = plan?.days.some(day => day.action === 'conflict') ?? false;
  $('apply').hidden ||= noChanges || finished || unresolved || Boolean(plan?.errors.length) || submissionIsClosed();
  $<HTMLButtonElement>('apply').disabled = !approved() || locked || rebuilding || finished || noChanges;
  $('refresh-month').hidden = !bound || running || paused || (!state.snapshot && !state.run && !preflightNeedsScan && !submissionIsClosed());
  $('footer-hint').hidden = !plan || noChanges || running || paused || finished;
  renderViews();
  renderSubmission();
  const attention = state.run?.results.some(result => result.status === 'uncertain' || result.status === 'failed') && (!state.snapshot || !plan || state.run.planId === plan.id);
  $('operation-controls').hidden = connecting || (!running && !paused && (!attention || panelView === 'month'));
  $('return-to-run').hidden = panelView === 'month';
  $('booking-footer').hidden = [...$('booking-footer').querySelectorAll<HTMLButtonElement>('button')].every(button => button.hidden);
  $('apply').textContent = rebuilding ? t('Vorschau wird geprüft …') : running ? t('Bitte warten …') : finished ? t('Buchungen abgeschlossen') : noChanges ? t('Keine Buchung nötig') : canWrite() ? t('{count} Tage prüfen', { count: plan ? writableDays(plan).length : 0 }) : t('Plan prüfen');
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
  const locked = isRunning() || isPaused() || updating();
  $('preview-empty').hidden = Boolean(plan) || Boolean(state.run);
  $('build-preview').hidden = Boolean(plan || pendingDraft || isRunning() || updating() || initializing || initializationFailed || state.snapshot?.month !== settings.month);
  $('preview-summary').hidden = !plan || Boolean(isRunning() || isPaused() || state.run?.planId === plan?.id);
  $('redistribute').hidden = !plan || !settings.variable;
  $<HTMLButtonElement>('redistribute').disabled = locked;
  $('plan-errors').replaceChildren();
  $('plan-errors').hidden = !plan?.errors.length;
  $('conflicts').hidden = true;
  $('edit-conflicts').hidden = true;
  $('preview-subtitle').textContent = monthLabel(settings.month);
  const matchingRun = plan && state.run?.planId === plan.id ? state.run : undefined;
  renderMonthCalendar($('calendar'), { month: settings.month, days: visibleDayPlans(), run: matchingRun, focusDate: calendarFocusDate, onOpenDate: openDay, onFocusDate: date => { calendarFocusDate = date; } });
  if (submissionIsClosed()) {
    $('preview-empty').hidden = true;
    $('preview-summary').hidden = locked;
    const stored = (state.snapshot?.month === settings.month ? state.snapshot : plan?.snapshot)?.days;
    const knownMinutes = stored?.every(day => day.reportedMinutes !== null && (day.reportedMinutes !== undefined || netMinutes(day.entries) !== null));
    const total = knownMinutes ? stored!.reduce((sum, day) => sum + (day.reportedMinutes ?? netMinutes(day.entries) ?? 0), 0) : null;
    const totalNode = node('div', undefined, 'month-totals');
    totalNode.append(node('strong', total === null ? t('Stunden noch nicht berechenbar') : t('{time} gespeichert', { time: formatMinutes(total) })));
    $('preview-summary').replaceChildren(totalNode, node('p', submissionStatusLabel(displayedSubmissionStatus()), 'no-changes'));
    $('plan-errors').hidden = true;
    return;
  }
  if (!plan) return;
  const changed = writableDays(plan);
  const retained = plan.days.filter(day => day.action === 'unchanged');
  const considered = plan.days.filter(day => day.eligible);
  const conflictDays = plan.days.filter(day => day.eligible && day.existing.length > 0 && day.action !== 'unchanged');
  const total = plan.weeks.some(week => week.plannedMinutes === null) ? null : plan.weeks.reduce((minutes, week) => minutes + (week.plannedMinutes ?? 0), 0);
  const totals = node('div', undefined, 'month-totals');
  totals.append(node('strong', total === null ? t('Stunden noch nicht berechenbar') : t('{time} im Monatsplan', { time: formatMinutes(total) })), node('span', t('{count} berücksichtigte Tage', { count: considered.length })));
  const counts = node('div', undefined, 'month-change-counts');
  counts.append(node('span', t('{count} neu', { count: changed.filter(day => day.action === 'create').length })), node('span', t('{count} bereits passend', { count: retained.length })));
  const overwriteCount = changed.filter(day => day.action === 'overwrite').length;
  if (overwriteCount) counts.append(node('span', t('{count} ersetzen', { count: overwriteCount })));
  $('preview-summary').replaceChildren(totals, counts);
  const unresolved = conflictDays.filter(day => !choices[day.date]).length;
  if (!changed.length && !plan.errors.length && !unresolved) {
    const message = !considered.length ? t('Keine Arbeitstage ausgewählt') : considered.every(day => day.action === 'unchanged') ? t('Alles passt – keine Buchung nötig') : t('Keine Änderungen ausgewählt – vorhandene Buchungen bleiben erhalten');
    $('preview-summary').append(node('p', message, 'no-changes'));
  }
  if (conflictDays.length) {
    $('edit-conflicts').hidden = false;
    $('conflicts').hidden = !unresolved;
    $('conflicts').textContent = t('{count} Buchungen prüfen', { count: unresolved });
    $<HTMLButtonElement>('conflicts').disabled = locked || rebuilding || Boolean(pendingDraft);
    $<HTMLButtonElement>('edit-conflicts').disabled = locked || rebuilding || Boolean(pendingDraft);
  }
  if (plan.errors.length) {
    // Keep the blocking reason visible, including weekly feasibility failures.
    const list = node('ul');
    for (const error of [...new Set(plan.errors)]) list.append(node('li', localizeText(error)));
    $('plan-errors').append(node('div', t('Der Plan kann noch nicht gebucht werden.'), 'error-heading'), list);
  }
}

function renderDayView(): void {
  if (panelView !== 'day') return;
  const days = visibleDayPlans();
  const day = days.find(item => item.date === selectedDate);
  $('day-title').textContent = dateLabel(selectedDate);
  const index = days.findIndex(item => item.date === selectedDate);
  $<HTMLButtonElement>('previous-day').disabled = index <= 0;
  $<HTMLButtonElement>('next-day').disabled = index < 0 || index >= days.length - 1;
  $('day-content').replaceChildren();
  $('day-week').replaceChildren();
  if (!day) {
    $('day-content').append(node('p', t('Diesen Monat zuerst einlesen, um die Tagesdetails zu sehen.'), 'hint'));
    return;
  }
  $('day-content').append(renderDay(day, true));
  const date = new Date(`${day.date}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const monday = date.toISOString().slice(0, 10);
  const week = plan?.weeks.find(item => item.week === monday);
  if (!week) return;
  const weekSection = node('section', undefined, 'week');
  const header = node('div', undefined, 'week-header');
  header.append(node('h3', t('Woche {date}', { date: dateLabel(week.week, false) })));
  const totals = node('div', undefined, 'totals');
  totals.append(node('strong', t('{time} geplant', { time: formatMinutes(week.plannedMinutes) })), node('div', t('{time} Ziel', { time: formatMinutes(week.targetMinutes) })));
  header.append(totals); weekSection.append(header);
  const list = node('ul', undefined, 'week-days');
  for (const item of days.filter(item => week.dates.includes(item.date))) {
    const row = node('li'); const button = node('button', dateLabel(item.date), 'text-button'); button.type = 'button';
    button.addEventListener('click', () => openDay(item.date));
    row.append(button, entriesElement(item.action === 'skip' || item.action === 'unchanged' ? item.existing : item.proposed), node('span', formatMinutes(item.netMinutes), 'week-net'));
    list.append(row);
  }
  weekSection.append(list);
  for (const error of week.errors) weekSection.append(node('p', localizeText(error), 'weekly-error'));
  $('day-week').append(weekSection);
}

function renderDay(day: DayPlan, _expanded = false): HTMLElement {
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
  checkbox.disabled = isRunning() || isPaused() || updating() || unavailable || submissionIsClosed();
  checkbox.setAttribute('aria-label', t('{date} berücksichtigen', { date: dateLabel(day.date) }));
  checkbox.addEventListener('change', () => {
    if (isRunning() || isPaused() || updating() || submissionIsClosed()) return;
    settings.excludedDates = checkbox.checked ? settings.excludedDates.filter((date) => date !== day.date) : [...new Set([...settings.excludedDates, day.date])].sort();
    $<HTMLTextAreaElement>('excludedDates').value = settings.excludedDates.join('\n');
    settingsChanged();
  });
  const dateText = node('span', undefined, 'day-date'); dateText.append(node('span', dateLabel(day.date)));
  const labels: Record<DayPlan['action'], string> = { create: t('Neu'), overwrite: t('Ersetzen'), skip: t('Ausgelassen'), conflict: t('Änderung nötig'), unchanged: t('Passt bereits'), blocked: t('Prüfung erforderlich') };
  dateText.append(node('small', labels[day.action], `day-state ${day.action}`));
  label.append(checkbox, dateText);
  const entries = (day.action === 'skip' || day.action === 'unchanged' ? day.existing : day.proposed).filter(entry => entry.type === 'work').sort((a, b) => a.start.localeCompare(b.start));
  head.append(label, node('span', entries.length ? `${entries[0].start}–${entries[entries.length - 1].end}` : '—', 'day-time'), node('span', day.eligible ? formatMinutes(day.netMinutes) : '', 'day-net'));
  article.append(head);
  const disclosure = node('div', undefined, 'day-details'); disclosure.dataset.dayDetails = day.date;
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
  $('run-panel').hidden = !run || Boolean(plan && state.snapshot && run.planId !== plan.id);
  $('view-history').hidden = !run;
  if (!run) { $('run-uncertain').hidden = true; $('run-impact').hidden = true; return; }
  const relevant = !plan || !state.snapshot || run.planId === plan.id;
  const verified = run.results.filter((item) => item.status === 'verified').length;
  const status = { running: t('Buchungen laufen'), paused: t('Für Kontrolle pausiert'), complete: t('Lauf abgeschlossen'), stopped: t('Lauf angehalten'), failed: t('Lauf mit Fehler angehalten') }[run.status];
  $('run-status').textContent = t('{status} · {verified} von {total} Tagen verifiziert', { status, verified, total: run.results.filter((item) => item.status !== 'skipped').length });
  const duration = run.timings?.totalMs;
  $('run-timing').hidden = typeof duration !== 'number' || !Number.isFinite(duration) || run.status === 'running';
  $('run-timing').textContent = typeof duration === 'number' && Number.isFinite(duration) ? t('Tatsächliche Laufzeit: {seconds} s', { seconds: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(duration / 1000) }) : '';
  $('run-uncertain').hidden = !relevant || !run.results.some(result => result.status === 'uncertain');
  const uncertainNotice = t('Als unklar markierte Buchungen können bereits in HiBob gespeichert sein. Vor einem neuen Lauf den Monat einlesen und die betroffenen Tage prüfen.');
  if ($('run-uncertain').textContent !== uncertainNotice) $('run-uncertain').textContent = uncertainNotice;
  const affected = run.results.find(result => result.status === 'failed' || result.status === 'uncertain');
  $('run-impact').hidden = !affected || !relevant;
  const remaining = run.results.filter(result => result.status !== 'verified' && result.status !== 'skipped').length;
  $('run-impact').textContent = affected ? `${dateLabel(affected.date)} · ${t('{verified} geprüft · {remaining} offen', { verified, remaining })} · ${localizeText(affected.message)}` : '';
  $('view-history').hidden = false;
  $('run-results').replaceChildren(...run.results.map((result) => {
    const item = node('li'); item.dataset.status = result.status;
    const description = node('div');
    if (result.status === 'uncertain') description.append(node('strong', t('Speicherstatus unklar'), 'run-outcome'));
    if (result.status === 'pending') description.append(node('strong', t('Noch nicht ausgeführt'), 'run-outcome'));
    if (result.status === 'awaiting-verification') description.append(node('strong', t('Übertragen – Prüfung ausstehend'), 'run-outcome'));
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
  redistributeAll = false; seed = freshSeed();
  void rebuild();
}

function openConflicts(): void {
  if (!plan || isPaused() || updating()) return;
  $('conflict-error').hidden = true;
  $('conflict-items').replaceChildren();
  for (const day of plan.days.filter((item) => item.eligible && item.existing.length > 0 && item.action !== 'unchanged')) {
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
  panelView = 'month';
  seed = freshSeed(); await rebuild();
}

async function scanMonth(): Promise<void> {
  if (!connected() || isRunning() || isPaused() || updating() || rebuilding) return;
  if (!revealInvalidSettings()) return;
  settings = readSettings();
  redistributeAll = false;
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
  if (resume && !state.run?.executionFingerprint?.trim()) { showError(t('Die Freigabe des pausierten Laufs ist nicht mehr verfügbar. Bitte den Lauf stoppen und den Monat erneut einlesen.')); return; }
  preflightResult = undefined;
  const days = resume ? remainingDays(plan) : writableDays(plan);
  if (!days.length) return;
  input('pause-verification').checked = false;
  const options = selectedExecutionOptions(plan, resume);
  confirmed = { plan: structuredClone(plan), planRevision: planRevision(), contextFingerprint: contextFingerprint(plan.snapshot.context), executionFingerprint: executionScope(options, resume), options, preflightDate: days[0]?.date ?? '', ...(resume ? { resumeJobId: pausedJob()!.id, checkpointId: pausedJob()!.checkpointId } : {}) };
  const reviewed = confirmed.plan;
  $('apply-title').textContent = resume ? t('Restliche Buchungen fortsetzen?') : canWrite() ? t('Buchung bestätigen') : t('Plan prüfen');
  const manual = needsAccountConfirmation(reviewed);
  $('account-confirmation-field').hidden = !manual;
  input('account-confirmation').checked = false;
  input('account-confirmation').required = manual;
  input('account-confirmation').disabled = !manual;
  $('account-confirmation-label').textContent = t('Ich bestätige das richtige HiBob-Konto und die Firma für {month}.', { month: monthLabel(reviewed.settings.month) });
  const dateSelect = select('draft-check-date');
  dateSelect.replaceChildren(...days.map(day => { const option = node('option', `${dateLabel(day.date)} · ${formatMinutes(day.netMinutes)}`); option.value = day.date; return option; }));
  dateSelect.value = confirmed.preflightDate;
  input('pause-verification').checked = false;
  $('checkpoint-field').hidden = resume || !canWrite();
  $('preflight-controls').hidden = resume;
  reviewChecksOpen = !canWrite();
  $('additional-checks').hidden = resume || !reviewChecksOpen;
  $('review-checks').hidden = resume;
  $('review-checks').setAttribute('aria-expanded', String(reviewChecksOpen));
  $('checkpoint-description').textContent = t('Nach dem ersten gebuchten Tag und dem ersten zukünftigen Tag anhalten. Danach nur mit neuer Bestätigung fortsetzen.');
  $('execution-consent-reset').hidden = true;
  renderExecutionDisclosure();
  $('confirm-apply').hidden = !canWrite();
  $('confirm-apply').textContent = resume ? t('{count} restliche Tage buchen', { count: days.length }) : t('{count} Tage buchen', { count: days.length });
  const overwriteCount = days.filter((day) => day.action === 'overwrite').length;
  $('apply-description').textContent = isDemo ? t('Du startest eine lokale Simulation. Dein echtes HiBob-Konto wird nicht verändert.') : manual ? t('Prüfe das angezeigte Mitarbeiter- und Firmenkonto. Diese Bestätigung gilt nur für diesen Plan.') : t('Die folgenden Änderungen werden in deinem HiBob-Konto „{employee}“ gespeichert.', { employee: reviewed.snapshot.employeeLabel });
  const list = $('apply-details'); list.replaceChildren();
  detailsLine(list, t('Monat'), monthLabel(reviewed.settings.month));
  if (!isDemo) detailsLine(list, t('HiBob-Konto'), accountLabel());
  detailsLine(list, t('Neue Tage'), String(days.filter(day => day.action === 'create').length));
  detailsLine(list, t('Zu ersetzen'), String(overwriteCount));
  detailsLine(list, t('Nettozeit zum Speichern'), formatMinutes(days.reduce((total, day) => total + (day.netMinutes ?? 0), 0)));
  detailsLine(list, t('Arbeitszeit'), `${reviewed.settings.start}–${reviewed.settings.end}${reviewed.settings.variable ? ` · ${t('±{minutes} Min.', { minutes: reviewed.settings.variationMinutes })}` : ''}`);
  detailsLine(list, t('Pause'), reviewed.settings.useBreak ? `${reviewed.settings.breakStart}–${reviewed.settings.breakEnd}` : t('Ohne Pause'));
  const mode = node('span', options.executionProfile === 'strict' ? t('Streng – jeden Tag einzeln prüfen') : t('Schnell – monatlich prüfen'));
  mode.id = 'apply-execution-mode';
  detailsLine(list, t('Buchungsmodus'), mode);
  const modeDescription = mode.parentElement!; modeDescription.id = 'apply-mode-description';
  const modeTerm = modeDescription.previousElementSibling as HTMLElement; modeTerm.id = 'apply-mode-term';
  modeDescription.hidden = modeTerm.hidden = options.executionProfile !== 'strict';
  if (resume) detailsLine(list, t('Bereits gespeichert und geprüft'), String(writableDays(reviewed).length - days.length));

  applyDialog.showModal();
  updateConfirmationButton();
}

function accountConfirmation(review: NonNullable<typeof confirmed>): AccountConfirmation | undefined {
  return needsAccountConfirmation(review.plan) ? {
    planId: review.plan.id, planRevision: review.planRevision, contextFingerprint: review.contextFingerprint, executionFingerprint: review.executionFingerprint, confirmed: true,
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
  panelView = 'month';
  approvedPlanRevision = undefined;
  checkingPreflight = true; preflightNeedsScan = true; preflightResult = undefined; localError = ''; renderState();
  try {
    const response = isDemo ? undefined : await request({ type: 'PANEL_PREFLIGHT', plan: review.plan, expectedPlanRevision: review.planRevision, date: day.date, ...(confirmation ? { confirmation } : {}) });
    const result = isDemo ? await demoPreflight(day) : response?.preflight;
    const completedState = response?.state;
    const invalidated = isDemo || Boolean(completedState && completedState.schemaVersion === 7 && completedState.connection?.generation === connectionGeneration
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

async function demoApply(activePlan: BookingPlan, options: RunOptions, continuing = false): Promise<void> {
  demoCancelled = false;
  const before = state.run?.planId === activePlan.id ? state.run : undefined;
  if (!continuing) demoCheckpointDates = options.checkpointDates ?? [];
  const checkpoints = demoCheckpointDates;
  const jobId = continuing ? pausedJob()?.id : crypto.randomUUID();
  state.job = undefined;
  state.run = {
    planId: activePlan.id, status: 'running', executionProfile: options.executionProfile, executionFingerprint: continuing ? before?.executionFingerprint : executionFingerprint(options), startedAt: before?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
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
  const totalMs = Math.max(0, Date.parse(state.run.updatedAt) - Date.parse(state.run.startedAt));
  state.run.timings = { preparationMs: 0, writingMs: totalMs, journalingMs: 0, verificationMs: 0, totalMs, requests: 0, writes: state.run.results.filter(result => result.status === 'verified').length };
  state.snapshot = undefined;
  state.job = undefined;
  plan = { ...activePlan, canReview: false };
  state.plan = plan;
}

async function applyPlan(): Promise<void> {
  const review = confirmed;
  if (!canWrite() || !review || !applyDialog.open || !currentConfirmation() || (needsAccountConfirmation(review.plan) && !input('account-confirmation').checked)) return;
  const confirmation = accountConfirmation(review);
  closeConfirmation();
  const activePlan = review.plan;
  panelView = 'month';
  approvedPlanRevision = undefined;
  applying = true; localError = ''; renderState();
  try {
    if (isDemo) await demoApply(activePlan, review.options, Boolean(review.resumeJobId));
    else {
      await message(review.resumeJobId
        ? { type: 'PANEL_CONTINUE', jobId: review.resumeJobId, planId: activePlan.id, expectedPlanRevision: review.planRevision, ...(confirmation ? { confirmation } : {}) }
        : { type: 'PANEL_APPLY', plan: activePlan, expectedPlanRevision: review.planRevision, ...(confirmation ? { confirmation } : {}), options: review.options });
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
  redistributeAll = false; seed = freshSeed();
  await rebuild();
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
      plan = state.plan; settings = storedSettings(plan.settings); choices = structuredClone(plan.choices); seed = plan.seed; redistributeAll = plan.redistributeAll === true;
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
  if (submissionDialog.open) closeSubmissionReview();
  settings = next; updateConditionalFields();
  settingsChanged();
}
$('settings-form').addEventListener('input', settingsInput);
$('settings-form').addEventListener('change', settingsInput);
$('scan').addEventListener('click', () => { void scanMonth(); });
$('refresh-month').addEventListener('click', () => { void scanMonth(); });
$('settings-toggle').addEventListener('click', () => navigate('settings'));
$('return-to-run').addEventListener('click', () => navigate('month'));
$('settings-back').addEventListener('click', () => navigate('month', 'settings-toggle'));
$('view-back').addEventListener('click', () => navigate(panelView === 'tools' ? 'settings' : 'month'));
$('booking-options-link').addEventListener('click', () => openTool('booking'));
$('transfer-link').addEventListener('click', () => openTool('transfer'));
$('connection-link').addEventListener('click', () => openTool('connection'));
$('tools-back').addEventListener('click', () => navigate('settings'));
$('day-back').addEventListener('click', () => navigate('month'));
$('run-details-back').addEventListener('click', () => navigate('month', 'run-details'));
for (const id of ['run-details', 'view-history']) $(id).addEventListener('click', () => navigate('run-details'));
for (const [id, offset] of [['previous-day', -1], ['next-day', 1]] as const) $(id).addEventListener('click', () => { const days = plan?.days ?? []; const index = days.findIndex(day => day.date === selectedDate); const day = days[index + offset]; if (day) openDay(day.date); });
$('review-days').addEventListener('click', () => { const date = writableDays(plan!)[0]?.date; closeConfirmation(); if (date) openDay(date); });
$('review-checks').addEventListener('click', () => { reviewChecksOpen = !reviewChecksOpen; $('additional-checks').hidden = !reviewChecksOpen; $('review-checks').setAttribute('aria-expanded', String(reviewChecksOpen)); });
$('tool-check-plan').addEventListener('click', () => { openApply(); if (applyDialog.open) { reviewChecksOpen = true; $('additional-checks').hidden = false; $('review-checks').setAttribute('aria-expanded', 'true'); select('draft-check-date').focus(); } });
$('edit-conflicts').addEventListener('click', openConflicts);
$('excludedDates').addEventListener('input', settingsInput);
$('excludedDates').addEventListener('change', settingsInput);
input('month').addEventListener('input', settingsInput);
input('month').addEventListener('change', settingsInput);

$('redistribute').addEventListener('click', () => { void rebuild(true); });
$('conflicts').addEventListener('click', openConflicts);
$('close-conflicts').addEventListener('click', () => conflictDialog.close());
$('overwrite-all').addEventListener('click', () => chooseAll('overwrite'));
$('skip-all').addEventListener('click', () => chooseAll('skip'));
$('save-conflicts').addEventListener('click', () => { void saveChoices(); });
$('apply').addEventListener('click', () => openApply());
$('continue-run').addEventListener('click', () => { void (async () => { if (!isPaused() || isRunning()) return; if (hasExtension) await refreshApproval(); else approvedPlanRevision = planRevision(); openApply(true); })(); });
$('close-apply').addEventListener('click', closeConfirmation);
$('review-submission').addEventListener('click', () => { void openSubmissionReview(submissionActionMonth() ?? settings.month); });
$('submit-month').addEventListener('click', () => { void openSubmissionReview(settings.month); });
$('close-submission').addEventListener('click', () => closeSubmissionReview());
submissionDialog.addEventListener('cancel', () => closeSubmissionReview());
input('submission-confirmation').addEventListener('change', updateSubmissionButton);
$('confirm-submission').addEventListener('click', () => { void submitReviewedMonth(); });
input('reminders-enabled').addEventListener('change', () => {
  if (transferBlocked() || !hasExtension) { input('reminders-enabled').checked = state.reminder?.enabled ?? true; return; }
  void message({ type: 'PANEL_SET_REMINDERS', enabled: input('reminders-enabled').checked }).catch(error => { showError(errorText(error)); input('reminders-enabled').checked = state.reminder?.enabled ?? true; });
});
applyDialog.addEventListener('cancel', closeConfirmation);
input('account-confirmation').addEventListener('change', updateConfirmationButton);
input('pause-verification').addEventListener('change', () => changeExecutionOptions(true));
select('execution-profile').addEventListener('change', () => {
  if (isRunning() || isPaused() || updating()) { select('execution-profile').value = executionProfile; return; }
  executionProfile = select('execution-profile').value === 'strict' ? 'strict' : 'fast-serial';
  if (executionProfile === 'fast-serial') input('pause-verification').checked = false;
  changeExecutionOptions();
});
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
