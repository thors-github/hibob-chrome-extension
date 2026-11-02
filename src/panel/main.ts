import './styles.css';
import { buildMonthPlan, defaultSettings, formatMinutes, GERMAN_STATES } from '../domain/index';
import type { AttendanceEntry, BookingPlan, ConflictChoices, DayPlan, MonthSnapshot, PlanEditLease, SessionState, Settings } from '../shared/types';
import { sameJsonValue } from '../shared/json';
import { createDemoSnapshot, demoFingerprint } from './demo';
import { language, locale, localizeText, t } from '../i18n/index';

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
let rebuilding = false;
let demoCancelled = false;
let localError = '';
let demoSnapshot: MonthSnapshot | undefined;
let buildVersion = 0;
let sessionRevision = 0;
let initializing = true;
let initializationFailed = false;
let preferencesLoaded = !hasExtension;
let connectionRetryAvailable = false;
let approvedPlanRevision: number | undefined;
let confirmed: { plan: BookingPlan; planRevision: number } | undefined;
let pendingDraft: Draft | undefined;
let invalidations: Promise<void> = Promise.resolve();
let preferenceWrites: Promise<void> = Promise.resolve();
let refreshScheduled = false;

interface Draft {
  version: number;
  changeId: string;
  settings: Settings;
  choices: ConflictChoices;
  seed: number;
  lease?: PlanEditLease;
  preferencesSaved: boolean;
}

type PanelMessage = { type: string; month?: string; plan?: BookingPlan; expectedPlanRevision?: number; changeId?: string; lease?: PlanEditLease; jobId?: string };
type PanelResponse = { ok: boolean; state?: SessionState; error?: string };

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="shell">
    <header class="app-header">
      <div class="app-mark" aria-hidden="true"><img src="/icons/app-icon.svg" alt="" width="40" height="40" /></div>
      <div><h1>${t("Monatsbuchung")}</h1><p>${t("Deine Anwesenheit in HiBob")}</p></div>
    </header>
    <div id="demo-banner" class="demo-banner" hidden><strong>${t("Lokaler Testmodus")}</strong>${t("Diese Vorschau verwendet Beispieldaten. Es werden keine Daten an HiBob gesendet.")}</div>
    <div id="connection" class="connection"><span class="connection-dot" aria-hidden="true"></span><div><p id="connection-title">${t("HiBob-Tab auswählen")}</p><p id="connection-detail" class="muted">${t("HiBob öffnen und dort auf das Extension-Symbol klicken.")}</p></div></div>
    <div id="main-error" class="notice error" role="alert" hidden></div>
    <button id="retry-plan" class="button wide" hidden>${t('Vorschau erneut prüfen')}</button>
    <button id="retry-connection" class="button wide" hidden>${t('Verbindung erneut prüfen')}</button>
    <section aria-labelledby="settings-title">
      <div class="section-title"><h2 id="settings-title">${t("Zeiten festlegen")}</h2><small>${t("Montag bis Freitag")}</small></div>
      <form id="settings-form">
        <fieldset id="settings-fieldset">
          <div class="fields">
            <div class="field"><label for="month">${t("Monat")}</label><input id="month" name="month" type="month" required /></div>
            <div class="field"><label for="state">${t("Bundesland")}</label><select id="state" name="state" required></select></div>
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
        </fieldset>
      </form>
      <div class="scan-toolbar"><button id="scan" class="button wide" disabled>${t("Monat einlesen")}</button></div>
    </section>
    <section id="scan-progress" class="notice" role="status" hidden></section>
    <section class="preview" aria-labelledby="preview-title">
      <div class="section-title"><div><h2 id="preview-title">${t("Monatsvorschau")}</h2><p id="preview-subtitle" class="preview-subtitle">${t("Vor dem Buchen alle Änderungen prüfen.")}</p></div><button id="redistribute" class="button subtle" hidden>${t("Neu verteilen")}</button></div>
      <div id="preview-empty" class="empty-preview"><strong>${t("Dein Monat auf einen Blick")}</strong><p>${t("Lies zuerst den Monat aus HiBob ein. Feiertage, Abwesenheiten und bestehende Einträge werden berücksichtigt.")}</p></div>
      <button id="build-preview" class="button wide" hidden>${t('Vorschau erstellen')}</button>
      <div id="preview-summary" class="preview-summary" hidden></div>
      <button id="conflicts" class="button wide conflict-button" hidden></button>
      <div id="plan-errors" class="notice error" role="alert" hidden></div>
      <div id="weeks"></div>
    </section>
    <section id="run-panel" class="run-panel" aria-labelledby="run-title" hidden><h2 id="run-title">${t("Buchungsverlauf")}</h2><div id="run-status" class="run-summary" aria-live="polite"></div><ul id="run-results" class="run-results"></ul></section>
    <footer class="footer"><div class="footer-buttons"><button id="cancel-run" class="button danger" hidden>${t("Abbrechen")}</button><button id="apply" class="button primary" disabled>${t("Jetzt buchen")}</button></div><p id="footer-hint" class="hint">${t("Es wird erst nach deiner Bestätigung gespeichert.")}</p></footer>
  </div>
  <dialog id="conflict-dialog" aria-labelledby="conflict-title"><div class="dialog-body"><h2 id="conflict-title">${t("Vorhandene Buchungen prüfen")}</h2><p class="hint">${t("Entscheide für jeden Tag. Beim Überschreiben werden die bisherigen Arbeits- und Pauseneinträge durch die Vorschau ersetzt.")}</p><div class="dialog-toolbar"><button id="overwrite-all" class="button">${t("Alle überschreiben")}</button><button id="skip-all" class="button">${t("Alle überspringen")}</button></div><div id="conflict-error" class="notice error" role="alert" style="margin-top:12px" hidden></div><div id="conflict-items"></div></div><div class="dialog-footer"><button id="close-conflicts" class="button">${t("Zurück")}</button><button id="save-conflicts" class="button primary">${t("Entscheidungen übernehmen")}</button></div></dialog>
  <dialog id="apply-dialog" aria-labelledby="apply-title"><div class="dialog-body"><h2 id="apply-title">${t("Buchungen jetzt speichern?")}</h2><p id="apply-description" class="hint"></p><dl id="apply-details" class="confirm-details"></dl><p class="hint">${t("Die Extension kontrolliert jeden gespeicherten Tag. Bei einer Abweichung stoppt der Lauf.")}</p></div><div class="dialog-footer"><button id="close-apply" class="button">${t("Zurück")}</button><button id="confirm-apply" class="button primary">${t("Buchungen starten")}</button></div></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const conflictDialog = $<HTMLDialogElement>('conflict-dialog');
const applyDialog = $<HTMLDialogElement>('apply-dialog');

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

function entriesElement(entries: AttendanceEntry[]): HTMLElement {
  const wrapper = node('span', undefined, 'entry-list');
  if (!entries.length) return node('span', '—', 'muted');
  for (const entry of entries) {
    const interval = `${entry.start || t('offen')}–${entry.end || t('offen')}`;
    wrapper.append(node('span', entry.type === 'break' ? t('Pause {interval}', { interval }) : interval, `entry ${entry.type}`));
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

function isRunning(): boolean { return busy || applying || Boolean(activeJob()) || (!state.job && state.run?.status === 'running'); }

function planRevision(): number { return state.planRevision ?? 0; }

function closeConfirmation(): void {
  confirmed = undefined;
  if (applyDialog.open) applyDialog.close();
}

function revokeApproval(): void {
  approvedPlanRevision = undefined;
  closeConfirmation();
}

function approved(): boolean {
  return Boolean(!initializing && !initializationFailed && preferencesLoaded && plan?.canApply && !pendingDraft && approvedPlanRevision === planRevision() && sameJsonValue(plan, state.plan));
}

function showError(message: string): void {
  localError = message;
  renderState();
}

async function message(command: PanelMessage): Promise<SessionState> {
  if (!hasExtension) throw new Error(t('Die Erweiterung ist hier nicht aktiv. Lade den Extension-Ordner in Chrome und öffne sie über einem HiBob-Tab.'));
  const requestedAtRevision = sessionRevision;
  const response = await chrome.runtime.sendMessage(command) as PanelResponse;
  if (response?.state && (typeof response.state.revision === 'number' || requestedAtRevision === sessionRevision)) receiveState(response.state);
  if (!response?.ok) throw new Error(response?.error || t('Die HiBob-Verbindung hat nicht geantwortet. Bitte den Tab prüfen.'));
  return response.state ?? state;
}

function renderablePlan(value: unknown): value is BookingPlan {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as BookingPlan;
  const entryList = (entries: unknown): entries is AttendanceEntry[] => Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object' && typeof entry.start === 'string' && typeof entry.end === 'string' && (entry.type === 'work' || entry.type === 'break') && (entry.metadata === undefined || Array.isArray(entry.metadata)));
  return typeof candidate.id === 'string' && typeof candidate.seed === 'number' && Boolean(candidate.settings && typeof candidate.settings.month === 'string')
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
  if (confirmed && (confirmed.planRevision !== planRevision() || !sameJsonValue(confirmed.plan, state.plan) || activeJob())) closeConfirmation();
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
  if (pendingDraft && (previous.tabId !== state.tabId || activeJob())) {
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
  const draft = beginDraft(newSeed);
  await processDraft(draft);
}

function beginDraft(newSeed = false): Draft {
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
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const focusId = focused?.id;
  const scrolling = document.scrollingElement ?? document.documentElement;
  const scrollTop = scrolling.scrollTop;
  const scrollLeft = scrolling.scrollLeft;
  const running = isRunning();
  $('demo-banner').hidden = !isDemo;
  const bound = state.tabId !== undefined;
  const scanned = state.snapshot?.month === settings.month;
  $('connection').classList.toggle('connected', scanned);
  $('connection').classList.toggle('selected', bound && !scanned);
  if (state.snapshot && scanned) {
    $('connection-title').textContent = t('Monat eingelesen');
    const time = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(state.snapshot.scannedAt));
    $('connection-detail').textContent = t('{employee} · Eingelesen: {time} Uhr · {period}', { employee: state.snapshot.employeeLabel, time, period: state.snapshot.periodLabel });
  } else if (isDemo) {
    $('connection-title').textContent = t('Lokale Testoberfläche');
    $('connection-detail').textContent = t('Alle Funktionen können ohne echte Buchungen geprüft werden.');
  } else if (bound) {
    $('connection-title').textContent = t('HiBob-Tab ausgewählt');
    $('connection-detail').textContent = state.snapshot ? t('Für {month} ist noch kein Monat eingelesen. Bitte „Monat einlesen“ wählen.', { month: monthLabel(settings.month) }) : state.run ? t('Monat erneut einlesen, um weitere Buchungen vorzubereiten.') : t('Noch kein Monat eingelesen. Klicke auf „Monat einlesen“.');
  } else {
    $('connection-title').textContent = t('HiBob-Tab auswählen');
    $('connection-detail').textContent = t('HiBob öffnen und dort auf das Extension-Symbol klicken.');
  }
  const error = localError || state.error || (state.job?.status === 'interrupted' ? t('Der letzte Vorgang wurde unterbrochen. Bitte den Monat erneut einlesen.') : '');
  $('main-error').hidden = !error;
  $('main-error').textContent = localizeText(error);
  $('retry-plan').hidden = !pendingDraft || rebuilding || running;
  $('retry-connection').hidden = !hasExtension || (!initializationFailed && !connectionRetryAvailable) || initializing || running;
  $<HTMLFieldSetElement>('settings-fieldset').disabled = running || initializing || initializationFailed;
  $<HTMLButtonElement>('scan').disabled = running || initializing || initializationFailed || rebuilding || (!isDemo && !bound);
  $('scan').textContent = busy || activeJob()?.kind === 'scan' ? t('Monat wird eingelesen …') : scanned ? t('Monat erneut einlesen') : t('Monat einlesen');
  const progress = state.progress;
  $('scan-progress').hidden = !running || !progress;
  if (progress && running) {
    const label = node('div', undefined, 'progress-header');
    label.append(node('span', localizeText(progress.message)), node('span', `${progress.completed}/${progress.total}`));
    const bar = node('progress');
    bar.max = progress.total || 1;
    bar.value = progress.completed;
    bar.setAttribute('aria-label', progress.phase === 'scan' ? t('Monat einlesen') : t('Buchungsfortschritt'));
    $('scan-progress').replaceChildren(label, bar);
  }
  renderPreview();
  renderRun();
  $('cancel-run').hidden = !running;
  $<HTMLButtonElement>('cancel-run').disabled = hasExtension && (!activeJob() || activeJob()?.status === 'cancelling');
  const finished = state.run?.status === 'complete' && state.run.planId === plan?.id;
  $<HTMLButtonElement>('apply').disabled = !approved() || running || rebuilding || finished;
  $('apply').textContent = rebuilding ? t('Vorschau wird geprüft …') : running ? t('Bitte warten …') : finished ? t('Buchungen abgeschlossen') : t('Jetzt buchen');
  $('footer-hint').textContent = isDemo ? t('Testmodus: Auch „Jetzt buchen“ verändert nur lokale Beispieldaten.') : running ? t('Bitte den HiBob-Tab während des Laufs unverändert lassen.') : state.run && !state.snapshot ? t('Für einen weiteren Lauf den Monat erneut einlesen.') : t('Es wird erst nach deiner Bestätigung gespeichert.');
  if (focusId && focused && !focused.isConnected) document.getElementById(focusId)?.focus({ preventScroll: true });
  scrolling.scrollTop = scrollTop;
  scrolling.scrollLeft = scrollLeft;
}

function renderPreview(): void {
  const running = isRunning();
  $('preview-empty').hidden = Boolean(plan);
  $('preview-empty').querySelector('p')!.textContent = !plan && state.snapshot?.month === settings.month ? t('Der Monat ist eingelesen. Erstelle jetzt die prüfbare Vorschau.') : t('Lies zuerst den Monat aus HiBob ein. Feiertage, Abwesenheiten und bestehende Einträge werden berücksichtigt.');
  $('build-preview').hidden = Boolean(plan || pendingDraft || running || initializing || initializationFailed || state.snapshot?.month !== settings.month);
  $('preview-summary').hidden = !plan;
  $('redistribute').hidden = !plan || !settings.variable;
  $<HTMLButtonElement>('redistribute').disabled = running;
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
  const summaryItems = [[String(changed.length), t('Tage zum Buchen')], [formatMinutes(total), t('Netto im Plan')], [String(excluded.length), t('ausgelassene Tage')]];
  $('preview-summary').replaceChildren(...summaryItems.map(([value, label]) => {
    const item = node('div'); item.append(node('strong', value), node('span', label)); return item;
  }));
  if (conflictDays.length) {
    $('conflicts').hidden = false;
    const unresolved = conflictDays.filter((day) => !choices[day.date]).length;
    $('conflicts').textContent = unresolved ? unresolved === 1 ? t('1 vorhandene Buchung prüfen') : t('{count} vorhandene Buchungen prüfen', { count: unresolved }) : t('Entscheidungen zu vorhandenen Buchungen ändern');
    $<HTMLButtonElement>('conflicts').disabled = running || rebuilding || Boolean(pendingDraft);
  }
  if (plan.errors.length) {
    const list = node('ul');
    for (const error of [...new Set(plan.errors)]) list.append(node('li', localizeText(error)));
    $('plan-errors').append(node('div', t('Der Plan kann noch nicht gebucht werden.'), 'error-heading'), list);
  }
  const shown = new Set<string>();
  for (const week of plan.weeks) {
    const section = node('section', undefined, 'week');
    const header = node('div', undefined, 'week-header');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(week.week) ? dateLabel(week.week, false) : week.week;
    header.append(node('h3', t('Woche {date}', { date })));
    const totals = node('div', undefined, 'totals');
    totals.append(node('strong', t('{time} geplant', { time: formatMinutes(week.plannedMinutes) })), node('div', t('{time} Ziel', { time: formatMinutes(week.targetMinutes) })));
    header.append(totals);
    section.append(header);
    for (const day of plan.days.filter((item) => week.dates.includes(item.date))) { section.append(renderDay(day)); shown.add(day.date); }
    for (const error of week.errors) section.append(node('p', localizeText(error), 'weekly-error'));
    $('weeks').append(section);
  }
  // Include every date even if a planner only groups eligible dates into weeks.
  const remaining = plan.days.filter((day) => !shown.has(day.date));
  if (remaining.length) {
    const section = node('section', undefined, 'week');
    section.append(node('h3', t('Weitere Tage')));
    for (const day of remaining) section.append(renderDay(day));
    $('weeks').append(section);
  }
}

function renderDay(day: DayPlan): HTMLElement {
  const article = node('article', undefined, `day${!day.eligible ? ' inactive' : ''}`);
  article.dataset.date = day.date;
  const head = node('div', undefined, 'day-head');
  const label = node('label', undefined, 'day-check');
  const checkbox = node('input');
  checkbox.id = `include-${day.date}`;
  checkbox.type = 'checkbox';
  checkbox.checked = !settings.excludedDates.includes(day.date);
  const snapshot = (state.snapshot ?? plan?.snapshot)?.days.find((item) => item.date === day.date);
  const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
  checkbox.disabled = isRunning() || weekday === 0 || weekday === 6 || Boolean(day.holiday || snapshot?.absence || snapshot?.nonWorking || !snapshot?.editable);
  if (checkbox.disabled && !isRunning() && !settings.excludedDates.includes(day.date)) checkbox.checked = false;
  checkbox.setAttribute('aria-label', t('{date} berücksichtigen', { date: dateLabel(day.date) }));
  checkbox.addEventListener('change', () => {
    settings.excludedDates = checkbox.checked ? settings.excludedDates.filter((date) => date !== day.date) : [...new Set([...settings.excludedDates, day.date])].sort();
    $<HTMLTextAreaElement>('excludedDates').value = settings.excludedDates.join('\n');
    settingsChanged();
  });
  label.append(checkbox, node('span', dateLabel(day.date), 'day-date'));
  const labels: Record<DayPlan['action'], string> = { create: t('Neu'), overwrite: t('Ersetzen'), skip: t('Ausgelassen'), conflict: t('Entscheidung offen'), unchanged: t('Unverändert'), blocked: t('Prüfung erforderlich') };
  head.append(label, node('span', labels[day.action], `status ${day.action}`));
  article.append(head);
  const list = node('dl', undefined, 'day-lines');
  if (day.existing.length) detailsLine(list, t('Bisher'), entriesElement(day.existing));
  if (day.proposed.length && (day.action === 'create' || day.action === 'overwrite' || day.action === 'conflict')) detailsLine(list, t('Geplant'), entriesElement(day.proposed));
  if (day.eligible) detailsLine(list, t('Netto'), formatMinutes(day.netMinutes));
  if (list.childElementCount) article.append(list);
  const reason = [day.holiday, day.reason].filter((value, index, array) => value && array.indexOf(value) === index).map((value) => localizeText(value!)).join(' · ');
  if (reason) article.append(node('p', reason, 'day-reason'));
  return article;
}

function renderRun(): void {
  const run = state.run;
  $('run-panel').hidden = !run;
  if (!run) return;
  const verified = run.results.filter((item) => item.status === 'verified').length;
  const status = { running: t('Buchungen laufen'), complete: t('Lauf abgeschlossen'), stopped: t('Lauf angehalten'), failed: t('Lauf mit Fehler angehalten') }[run.status];
  $('run-status').textContent = t('{status} · {verified} von {total} Tagen verifiziert', { status, verified, total: run.results.filter((item) => item.status !== 'skipped').length });
  $('run-results').replaceChildren(...run.results.map((result) => {
    const item = node('li'); item.dataset.status = result.status;
    item.append(node('span', dateLabel(result.date, false)), node('span', localizeText(result.message))); return item;
  }));
}

function settingsChanged(): void {
  void rebuild(true);
}

function openConflicts(): void {
  if (!plan) return;
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
  if (!conflictDialog.open || !plan || isRunning()) return;
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
  if (isRunning() || rebuilding) return;
  if (!$<HTMLFormElement>('settings-form').reportValidity()) return;
  settings = readSettings();
  busy = true; demoCancelled = false; localError = ''; plan = undefined; choices = {};
  if (isDemo) {
    state.run = undefined;
    state.progress = { phase: 'scan', completed: 0, total: 1, message: t('HiBob-Monat wird geprüft …') };
  }
  const month = settings.month;
  const tabId = state.tabId;
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
      state.progress = undefined;
    } else {
      const scanned = await message({ type: 'PANEL_SCAN', month });
      if (!sameJsonValue(scanned, state) || state.tabId !== tabId || state.snapshot?.month !== month || activeJob()) return;
    }
    await rebuild();
  } catch (error) { localError = errorText(error); }
  finally { busy = false; if (isDemo) state.progress = undefined; renderState(); persistDemo(); }
}

function openApply(): void {
  if (!approved() || !plan || isRunning() || rebuilding) return;
  confirmed = { plan: structuredClone(plan), planRevision: planRevision() };
  const reviewed = confirmed.plan;
  const days = reviewed.days.filter((day) => day.action === 'create' || day.action === 'overwrite');
  const overwriteCount = days.filter((day) => day.action === 'overwrite').length;
  $('apply-description').textContent = isDemo ? t('Du startest eine lokale Simulation. Dein echtes HiBob-Konto wird nicht verändert.') : t('Die folgenden Änderungen werden in deinem HiBob-Konto „{employee}“ gespeichert.', { employee: reviewed.snapshot.employeeLabel });
  const list = $('apply-details'); list.replaceChildren();
  detailsLine(list, t('Monat'), monthLabel(reviewed.settings.month));
  detailsLine(list, t('Tage zum Buchen'), String(days.length));
  detailsLine(list, t('Davon überschreiben'), String(overwriteCount));
  detailsLine(list, t('Bundesland'), t(GERMAN_STATES.find((item) => item.code === reviewed.settings.state)?.name || reviewed.settings.state));
  applyDialog.showModal();
}

async function demoApply(activePlan: BookingPlan): Promise<void> {
  demoCancelled = false;
  const before = state.run?.planId === activePlan.id ? state.run : undefined;
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
    persistDemo(); renderState();
  }
  state.run.status = demoCancelled ? 'stopped' : 'complete';
  state.run.updatedAt = new Date().toISOString();
  state.snapshot = undefined;
  plan = { ...activePlan, canApply: false };
  state.plan = plan;
}

async function applyPlan(): Promise<void> {
  const review = confirmed;
  closeConfirmation();
  if (!review || !approved() || isRunning() || rebuilding || review.planRevision !== planRevision() || !sameJsonValue(review.plan, plan) || !sameJsonValue(review.plan, state.plan)) return;
  const activePlan = review.plan;
  approvedPlanRevision = undefined;
  applying = true; localError = ''; renderState();
  try {
    if (isDemo) await demoApply(activePlan);
    else {
      await message({ type: 'PANEL_APPLY', plan: activePlan, expectedPlanRevision: review.planRevision });
    }
  } catch (error) { localError = errorText(error); }
  finally { applying = false; renderState(); persistDemo(); }
}

async function cancelRun(): Promise<void> {
  try {
    if (isDemo) demoCancelled = true;
    else {
      const job = activeJob();
      if (!job) return;
      await message({ type: 'PANEL_CANCEL', jobId: job.id });
    }
    renderState();
  } catch (error) { showError(errorText(error)); }
}

async function initialize(retry = false): Promise<void> {
  // The action opens the panel before its tab binding finishes. Subscribe first so
  // neither that binding nor a later reset can be lost during asynchronous boot.
  if (hasExtension && !retry) chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.sessionState) return;
    sessionRevision++;
    receiveState(changes.sessionState.newValue as SessionState ?? {});
    if (!initializing && !initializationFailed && !pendingDraft && !busy && !applying && !activeJob()) {
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
    if (isDemo && state.run?.status === 'running') {
      state.run.status = 'stopped';
      state.snapshot = undefined;
      if (plan) { plan = { ...plan, canApply: false }; state.plan = plan; }
    }
  } catch (error) { localError = errorText(error); initializationFailed = true; }
  initializing = false;
  fillSettings(); renderState();
  if (hasExtension && !initializationFailed && plan && approvedPlanRevision === undefined && !activeJob()) void refreshApproval();
}

$<HTMLFormElement>('settings-form').addEventListener('submit', (event) => event.preventDefault());
function settingsInput(): void {
  const next = readSettings();
  if (sameJsonValue(next, settings)) return;
  settings = next; updateConditionalFields();
  settingsChanged();
}
$('settings-form').addEventListener('input', settingsInput);
$('settings-form').addEventListener('change', settingsInput);
$('scan').addEventListener('click', () => { void scanMonth(); });
$('redistribute').addEventListener('click', () => { void rebuild(true); });
$('conflicts').addEventListener('click', openConflicts);
$('close-conflicts').addEventListener('click', () => conflictDialog.close());
$('overwrite-all').addEventListener('click', () => chooseAll('overwrite'));
$('skip-all').addEventListener('click', () => chooseAll('skip'));
$('save-conflicts').addEventListener('click', () => { void saveChoices(); });
$('apply').addEventListener('click', openApply);
$('close-apply').addEventListener('click', closeConfirmation);
applyDialog.addEventListener('cancel', () => { confirmed = undefined; });
$('confirm-apply').addEventListener('click', () => { void applyPlan(); });
$('cancel-run').addEventListener('click', () => { void cancelRun(); });
$('retry-plan').addEventListener('click', () => { if (pendingDraft && !rebuilding && !isRunning()) void processDraft(pendingDraft); });
$('retry-connection').addEventListener('click', () => { if (initializationFailed) void initialize(true); else { connectionRetryAvailable = false; void refreshApproval(); } });
$('build-preview').addEventListener('click', () => { if (!isRunning() && !pendingDraft && state.snapshot?.month === settings.month) void rebuild(); });

void initialize();
