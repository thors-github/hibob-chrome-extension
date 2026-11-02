import './styles.css';
import { buildMonthPlan, defaultSettings, formatMinutes, GERMAN_STATES } from '../domain/index';
import type { AttendanceEntry, BookingPlan, ConflictChoices, DayPlan, MonthSnapshot, SessionState, Settings } from '../shared/types';
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

type PanelMessage = { type: string; month?: string; plan?: BookingPlan };
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

function isRunning(): boolean { return busy || applying || state.run?.status === 'running'; }

function showError(message: string): void {
  localError = message;
  renderState();
}

async function message(command: PanelMessage): Promise<SessionState> {
  if (!hasExtension) throw new Error(t('Die Erweiterung ist hier nicht aktiv. Lade den Extension-Ordner in Chrome und öffne sie über einem HiBob-Tab.'));
  const response = await chrome.runtime.sendMessage(command) as PanelResponse;
  if (!response?.ok) throw new Error(response?.error || t('Die HiBob-Verbindung hat nicht geantwortet. Bitte den Tab prüfen.'));
  return response.state ?? state;
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

async function persistSettings(): Promise<void> {
  if (hasExtension) await chrome.storage.local.set({ settings });
  else if (isDemo) localStorage.setItem('hibob-demo-settings', JSON.stringify(settings));
}

function persistDemo(): void {
  if (isDemo) sessionStorage.setItem('hibob-demo-session', JSON.stringify({ ...state, plan, demoSnapshot }));
}

async function rebuild(newSeed = false): Promise<void> {
  const version = ++buildVersion;
  if (newSeed) seed = freshSeed();
  localError = '';
  if (!state.snapshot || state.snapshot.month !== settings.month) {
    rebuilding = false;
    plan = undefined;
    state.plan = undefined;
    renderState();
    return;
  }
  rebuilding = true;
  try {
    plan = buildMonthPlan(settings, state.snapshot, choices, seed);
    state.plan = plan;
    renderState();
    if (hasExtension) {
      const saved = await message({ type: 'PANEL_SAVE_PLAN', plan });
      if (version === buildVersion) {
        state = saved;
        plan = saved.plan;
        renderState();
      }
    }
    persistDemo();
  } catch (error) {
    if (version === buildVersion) localError = errorText(error);
  } finally {
    if (version === buildVersion) { rebuilding = false; renderState(); }
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
  const running = isRunning();
  $('demo-banner').hidden = !isDemo;
  const bound = state.tabId !== undefined;
  const scanned = Boolean(state.snapshot);
  $('connection').classList.toggle('connected', scanned);
  $('connection').classList.toggle('selected', bound && !scanned);
  if (state.snapshot) {
    $('connection-title').textContent = t('Monat eingelesen');
    const time = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(state.snapshot.scannedAt));
    $('connection-detail').textContent = t('{employee} · Eingelesen: {time} Uhr · {period}', { employee: state.snapshot.employeeLabel, time, period: state.snapshot.periodLabel });
  } else if (isDemo) {
    $('connection-title').textContent = t('Lokale Testoberfläche');
    $('connection-detail').textContent = t('Alle Funktionen können ohne echte Buchungen geprüft werden.');
  } else if (bound) {
    $('connection-title').textContent = t('HiBob-Tab ausgewählt');
    $('connection-detail').textContent = state.run ? t('Monat erneut einlesen, um weitere Buchungen vorzubereiten.') : t('Noch kein Monat eingelesen. Klicke auf „Monat einlesen“.');
  } else {
    $('connection-title').textContent = t('HiBob-Tab auswählen');
    $('connection-detail').textContent = t('HiBob öffnen und dort auf das Extension-Symbol klicken.');
  }
  const error = localError || state.error || '';
  $('main-error').hidden = !error;
  $('main-error').textContent = localizeText(error);
  $<HTMLFieldSetElement>('settings-fieldset').disabled = running;
  $<HTMLButtonElement>('scan').disabled = running || (!isDemo && !bound);
  $('scan').textContent = busy ? t('Monat wird eingelesen …') : state.snapshot ? t('Monat erneut einlesen') : t('Monat einlesen');
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
  const finished = state.run?.status === 'complete' && state.run.planId === plan?.id;
  $<HTMLButtonElement>('apply').disabled = !plan?.canApply || running || rebuilding || finished;
  $('apply').textContent = rebuilding ? t('Vorschau wird geprüft …') : running ? t('Bitte warten …') : finished ? t('Buchungen abgeschlossen') : t('Jetzt buchen');
  $('footer-hint').textContent = isDemo ? t('Testmodus: Auch „Jetzt buchen“ verändert nur lokale Beispieldaten.') : running ? t('Bitte den HiBob-Tab während des Laufs unverändert lassen.') : state.run && !state.snapshot ? t('Für einen weiteren Lauf den Monat erneut einlesen.') : t('Es wird erst nach deiner Bestätigung gespeichert.');
}

function renderPreview(): void {
  const running = isRunning();
  $('preview-empty').hidden = Boolean(plan);
  $('preview-summary').hidden = !plan;
  $('redistribute').hidden = !plan || !settings.variable;
  $<HTMLButtonElement>('redistribute').disabled = running;
  $('weeks').replaceChildren();
  $('plan-errors').replaceChildren();
  $('plan-errors').hidden = !plan?.errors.length;
  $('conflicts').hidden = true;
  $('preview-subtitle').textContent = plan ? `${monthLabel(settings.month)} · ${settings.variable ? t('variable Zeiten ±{minutes} Min.', { minutes: settings.variationMinutes }) : t('feste Zeiten')}` : t('Vor dem Buchen alle Änderungen prüfen.');
  if (!plan) return;
  const changed = plan.days.filter((day) => day.action === 'create' || day.action === 'overwrite');
  const excluded = plan.days.filter((day) => !day.eligible);
  const conflictDays = plan.days.filter((day) => day.eligible && day.existing.length > 0);
  const total = plan.weeks.reduce((minutes, week) => minutes + (week.plannedMinutes ?? 0), 0);
  const summaryItems = [[String(changed.length), t('Tage zum Buchen')], [formatMinutes(total), t('Netto im Plan')], [String(excluded.length), t('ausgelassene Tage')]];
  $('preview-summary').replaceChildren(...summaryItems.map(([value, label]) => {
    const item = node('div'); item.append(node('strong', value), node('span', label)); return item;
  }));
  if (conflictDays.length) {
    $('conflicts').hidden = false;
    const unresolved = conflictDays.filter((day) => !choices[day.date]).length;
    $('conflicts').textContent = unresolved ? unresolved === 1 ? t('1 vorhandene Buchung prüfen') : t('{count} vorhandene Buchungen prüfen', { count: unresolved }) : t('Entscheidungen zu vorhandenen Buchungen ändern');
    $<HTMLButtonElement>('conflicts').disabled = running;
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
  const labels: Record<DayPlan['action'], string> = { create: t('Neu'), overwrite: t('Ersetzen'), skip: t('Ausgelassen'), conflict: t('Entscheidung offen'), unchanged: t('Unverändert') };
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
  // Close the gap between the native change event and asynchronous local storage.
  rebuilding = true;
  renderState();
  void persistSettings().then(() => rebuild(true)).catch((error) => {
    rebuilding = false;
    showError(errorText(error));
  });
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
  if (!$<HTMLFormElement>('settings-form').reportValidity()) return;
  settings = readSettings();
  busy = true; demoCancelled = false; localError = ''; state.error = undefined; plan = undefined; choices = {};
  state.run = undefined;
  state.progress = { phase: 'scan', completed: 0, total: 1, message: t('HiBob-Monat wird geprüft …') };
  renderState();
  try {
    await persistSettings();
    if (isDemo) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (demoCancelled) throw new Error(t('Einlesen abgebrochen.'));
      if (!demoSnapshot || demoSnapshot.month !== settings.month) demoSnapshot = createDemoSnapshot(settings);
      state.snapshot = structuredClone(demoSnapshot);
      state.progress = undefined;
    } else state = await message({ type: 'PANEL_SCAN', month: settings.month });
    seed = freshSeed();
    await rebuild();
  } catch (error) { localError = errorText(error); }
  finally { busy = false; state.progress = undefined; renderState(); persistDemo(); }
}

function openApply(): void {
  if (!plan?.canApply || isRunning() || rebuilding) return;
  const days = plan.days.filter((day) => day.action === 'create' || day.action === 'overwrite');
  const overwriteCount = days.filter((day) => day.action === 'overwrite').length;
  $('apply-description').textContent = isDemo ? t('Du startest eine lokale Simulation. Dein echtes HiBob-Konto wird nicht verändert.') : t('Die folgenden Änderungen werden in deinem HiBob-Konto „{employee}“ gespeichert.', { employee: plan.snapshot.employeeLabel });
  const list = $('apply-details'); list.replaceChildren();
  detailsLine(list, t('Monat'), monthLabel(settings.month));
  detailsLine(list, t('Tage zum Buchen'), String(days.length));
  detailsLine(list, t('Davon überschreiben'), String(overwriteCount));
  detailsLine(list, t('Bundesland'), t(GERMAN_STATES.find((item) => item.code === settings.state)?.name || settings.state));
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
  applyDialog.close();
  if (!plan?.canApply || isRunning() || rebuilding) return;
  const activePlan = plan;
  applying = true; localError = ''; renderState();
  try {
    if (isDemo) await demoApply(activePlan);
    else {
      state = await message({ type: 'PANEL_APPLY', plan: activePlan });
      plan = state.plan;
    }
  } catch (error) { localError = errorText(error); }
  finally { applying = false; renderState(); persistDemo(); }
}

async function cancelRun(): Promise<void> {
  try {
    if (isDemo) demoCancelled = true;
    else state = await message({ type: 'PANEL_CANCEL' });
    renderState();
  } catch (error) { showError(errorText(error)); }
}

async function initialize(): Promise<void> {
  // The action opens the panel before its tab binding finishes. Subscribe first so
  // neither that binding nor a later reset can be lost during asynchronous boot.
  if (hasExtension) chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.sessionState) return;
    sessionRevision++;
    state = changes.sessionState.newValue as SessionState ?? {};
    if (state.plan && !rebuilding && state.plan.id === plan?.id) {
      plan = state.plan; choices = plan.choices; seed = plan.seed;
    } else if (!state.plan && !busy && !rebuilding) {
      plan = undefined;
      choices = {};
      if (applyDialog.open) applyDialog.close();
      if (conflictDialog.open) conflictDialog.close();
    }
    renderState();
  });
  for (const state of GERMAN_STATES) { const option = node('option', t(state.name)); option.value = state.code; select('state').append(option); }
  renderState();
  try {
    if (hasExtension) {
      const stored = await chrome.storage.local.get('settings') as { settings?: unknown };
      settings = storedSettings(stored.settings);
      const requestedAtRevision = sessionRevision;
      const initialState = await message({ type: 'PANEL_GET_STATE' });
      if (requestedAtRevision === sessionRevision) state = initialState;
    } else if (isDemo) {
      const savedSettings = localStorage.getItem('hibob-demo-settings');
      if (savedSettings) settings = storedSettings(JSON.parse(savedSettings));
      const savedState = sessionStorage.getItem('hibob-demo-session');
      if (savedState) { const parsed = JSON.parse(savedState); demoSnapshot = parsed.demoSnapshot; state = parsed; }
    }
    if (state.plan && state.plan.settings.month === settings.month) { plan = state.plan; settings = plan.settings; choices = plan.choices; seed = plan.seed; }
    if (isDemo && state.run?.status === 'running') {
      state.run.status = 'stopped';
      state.snapshot = undefined;
      if (plan) { plan = { ...plan, canApply: false }; state.plan = plan; }
    }
  } catch (error) { localError = errorText(error); }
  fillSettings(); renderState();
}

$<HTMLFormElement>('settings-form').addEventListener('submit', (event) => event.preventDefault());
$('settings-form').addEventListener('change', () => {
  settings = readSettings(); updateConditionalFields();
  settingsChanged();
});
input('variationMinutes').addEventListener('input', () => { $('variation-value').textContent = t('±{minutes} Min.', { minutes: input('variationMinutes').value }); });
$('scan').addEventListener('click', () => { void scanMonth(); });
$('redistribute').addEventListener('click', () => { void rebuild(true); });
$('conflicts').addEventListener('click', openConflicts);
$('close-conflicts').addEventListener('click', () => conflictDialog.close());
$('overwrite-all').addEventListener('click', () => chooseAll('overwrite'));
$('skip-all').addEventListener('click', () => chooseAll('skip'));
$('save-conflicts').addEventListener('click', () => { void saveChoices(); });
$('apply').addEventListener('click', openApply);
$('close-apply').addEventListener('click', () => applyDialog.close());
$('confirm-apply').addEventListener('click', () => { void applyPlan(); });
$('cancel-run').addEventListener('click', () => { void cancelRun(); });

void initialize();
