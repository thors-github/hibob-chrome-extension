import { t } from '../i18n/index';
import type { AdapterProgress, AttendanceEntry, DayPlan, DaySnapshot, MonthSnapshot } from '../shared/types';

const PREFIX = 'time_attendance_employee_timesheet.';
const PANEL = '#attendance-right-panel';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

export class AdapterError extends Error {
  constructor(message: string, public readonly uncertain = false) { super(message); this.name = 'AdapterError'; }
}

export function isAttendanceLocation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://app.hibob.com' && url.pathname === '/attendance/my-attendance' && !url.username && !url.password;
  } catch { return false; }
}

export function localDateFromUi(value: string): string | null {
  const match = value.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!match) return null;
  const [, d, m, y] = match;
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d) return null;
  return `${y}-${m}-${d}`;
}

export function snapshotFingerprint(day: Omit<DaySnapshot, 'fingerprint'>): string {
  // Preserve every value shown in the preview, including notes/reasons and blocked-day context.
  return JSON.stringify({ date: day.date, editable: day.editable, absence: day.absence ?? '', nonWorking: day.nonWorking ?? '', unsupportedReason: day.unsupportedReason ?? '', entries: day.entries.map(entry => ({ type: entry.type, start: entry.start, end: entry.end, note: entry.note ?? '', reason: entry.reason ?? '', metadata: entry.metadata ?? [] })) });
}

interface GridDay {
  date: string;
  rowId: string;
  index: number;
  absence?: string;
  nonWorking?: string;
  reasons: string;
  notes: string;
  projects: string;
  workedMinutes: number | null;
  entryDisplay: string;
}

interface AdapterOptions {
  document?: Document;
  location?: () => string;
  timeoutMs?: number;
  settleMs?: number;
}

export class HiBobDomAdapter {
  private readonly doc: Document;
  private readonly location: () => string;
  private readonly timeout: number;
  private readonly settle: number;
  private ownedPanel: Element | null = null;
  private ownedDate: string | null = null;

  constructor(options: AdapterOptions = {}) {
    this.doc = options.document ?? document;
    this.location = options.location ?? (() => window.location.href);
    this.timeout = options.timeoutMs ?? 8000;
    this.settle = options.settleMs ?? 150;
  }

  private assertPage(signal?: AbortSignal) {
    if (!isAttendanceLocation(this.location())) throw new AdapterError(t('Bitte „My attendance“ unter https://app.hibob.com/attendance/my-attendance öffnen.'));
    if (signal?.aborted) throw new AdapterError(t('Vorgang abgebrochen.'));
  }

  private async waitFor<T>(read: () => T | null | false | undefined, message: string, signal?: AbortSignal): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < this.timeout) {
      this.assertPage(signal);
      const value = read();
      if (value) return value;
      await sleep(Math.max(10, this.settle));
    }
    throw new AdapterError(message);
  }

  private async tick(signal?: AbortSignal) { await sleep(this.settle); this.assertPage(signal); }
  private panel(): Element | null { return this.doc.querySelector(`${PANEL}[aria-hidden="false"]`); }

  private assertOwnedPanel() {
    const panel = this.panel();
    if (!panel || panel !== this.ownedPanel || localDateFromUi(text(panel.querySelector('.sticky-header p.b-display-3'))) !== this.ownedDate) throw new AdapterError(t('Der HiBob-Tagesdialog wurde während des Vorgangs geändert. Bitte den geöffneten Dialog manuell prüfen.'));
  }

  private assertNoManualForm() {
    if (this.panel()) throw new AdapterError(t('Ein HiBob-Tagesdialog ist bereits offen. Bitte eigene Änderungen zuerst speichern oder abbrechen.'));
    if (this.doc.querySelector('[role="dialog"], .cdk-overlay-pane [role="alertdialog"]')) throw new AdapterError(t('Bitte den geöffneten HiBob-Dialog zuerst schließen.'));
  }

  private unique<T extends Element>(elements: T[], message: string): T {
    if (elements.length !== 1) throw new AdapterError(message);
    return elements[0];
  }

  private button(root: ParentNode, labels: string[]): HTMLElement {
    return this.unique([...root.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(e => labels.includes(text(e))), t('HiBob-Schaltfläche „{label}“ nicht eindeutig gefunden.', { label: labels[0] }));
  }

  private click(element: Element) {
    this.assertPage();
    if (!(element instanceof this.doc.defaultView!.HTMLElement) || !element.isConnected || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled') || element.closest('[data-disabled="true"]')) throw new AdapterError(t('Das HiBob-Steuerelement ist nicht verfügbar.'));
    element.click();
  }

  private periodControl(): HTMLElement {
    return this.unique([...this.doc.querySelectorAll<HTMLElement>('[role="button"][aria-haspopup="true"]')].filter(e => /\d{2}\/\d{2}\/\d{4}\s*[–-]\s*\d{2}\/\d{2}\/\d{4}/.test(text(e)) && !e.closest(PANEL)), t('Der HiBob-Abrechnungszeitraum ist nicht eindeutig erkennbar.'));
  }

  private periodContainsMonth(label: string, month: string): boolean {
    const dates = label.match(/\d{2}\/\d{2}\/\d{4}/g) ?? [];
    if (dates.length !== 2) return false;
    const first = localDateFromUi(dates[0]);
    const last = localDateFromUi(dates[1]);
    const count = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    return first === `${month}-01` && last === `${month}-${String(count).padStart(2, '0')}`;
  }

  private async selectMonth(month: string, signal?: AbortSignal): Promise<string> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AdapterError(t('Ungültiger Monat.'));
    const control = this.periodControl();
    if (!this.periodContainsMonth(text(control), month)) {
      this.click(control);
      const options = await this.waitFor(() => {
        const found = [...this.doc.querySelectorAll<HTMLElement>('[role="treeitem"], [role="option"]')];
        return found.length ? found : null;
      }, t('Die verfügbaren HiBob-Zeiträume konnten nicht gelesen werden.'), signal);
      const candidates = options.filter(option => this.periodContainsMonth(text(option), month));
      if (candidates.length !== 1) {
        // Close only our period picker. Never invent a period or bypass HiBob restrictions.
        control.dispatchEvent(new this.doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        throw new AdapterError(t('HiBob stellt den Monat {month} nicht als auswählbaren Monatszeitraum bereit.', { month }));
      }
      this.click(candidates[0]);
      await this.waitFor(() => this.periodContainsMonth(text(this.periodControl()), month), t('HiBob hat den gewählten Monat nicht geöffnet.'), signal);
      await this.tick(signal);
    }
    return text(this.periodControl());
  }

  private viewport(): HTMLElement {
    return this.unique([...this.doc.querySelectorAll<HTMLElement>('.ag-body-viewport')].filter(viewport => viewport.querySelector('.ag-center-cols-container')), t('HiBob-Anwesenheitstabelle nicht eindeutig gefunden.'));
  }

  private cell(row: Element, suffix: string): Element | null { return row.querySelector(`[col-id="${PREFIX}${suffix}"]`); }

  private valueWithoutActions(cell: Element | null): string {
    if (!cell) return '';
    const clone = cell.cloneNode(true) as Element;
    clone.querySelectorAll('.empty-state-component, button, [role="button"]').forEach(e => e.remove());
    return text(clone);
  }

  /** Pinned dates and body cells are joined by AG Grid row-id, never by DOM order. */
  readRenderedDays(): GridDay[] {
    const viewport = this.viewport();
    const grid = viewport.closest('.ag-root-wrapper, .ag-root') ?? viewport.parentElement!;
    const result: GridDay[] = [];
    for (const pinned of grid.querySelectorAll('.ag-pinned-left-cols-container [row-id]')) {
      const dateCell = this.cell(pinned, 'date');
      if (!dateCell || /^Week\b/i.test(text(dateCell))) continue;
      const date = localDateFromUi(text(dateCell));
      if (!date) continue;
      const rowId = pinned.getAttribute('row-id');
      const index = Number(pinned.getAttribute('row-index'));
      if (!rowId || !Number.isInteger(index)) throw new AdapterError(t('HiBob-Zeilenkennung fehlt.'));
      const bodies = [...viewport.querySelectorAll('.ag-center-cols-container [row-id]')].filter(e => e.getAttribute('row-id') === rowId && Number(e.getAttribute('row-index')) === index);
      if (!bodies.length) continue;
      const body = this.unique(bodies, t('Mehrdeutige HiBob-Tageszeile.'));
      const requiredColumns: Record<string, string> = { timeOff: 'Time off', holidayOrNonWorkingDay: 'Holidays and non-working days', entryDisplay: 'Start/end', hoursWorked: 'Hours worked', entryReasons: 'Reasons', comments: 'Notes', projects: 'Projects' };
      for (const [suffix, label] of Object.entries(requiredColumns)) {
        if (!this.cell(body, suffix)) throw new AdapterError(t('HiBob-Spalte „{label}“ fehlt. Bitte die erforderlichen Spalten einblenden und gegebenenfalls die Tabelle horizontal verschieben oder das Browserfenster vergrößern, damit auch Gründe, Notizen und Projekte zuverlässig gelesen werden können.', { label }));
      }
      const workedText = text(this.cell(body, 'hoursWorked'));
      const worked = workedText.match(/^(\d+)h\s*(\d{1,2})m$/);
      result.push({ date, rowId, index, absence: this.valueWithoutActions(this.cell(body, 'timeOff')) || undefined, nonWorking: this.valueWithoutActions(this.cell(body, 'holidayOrNonWorkingDay')) || undefined, reasons: this.valueWithoutActions(this.cell(body, 'entryReasons')), notes: this.valueWithoutActions(this.cell(body, 'comments')), projects: this.valueWithoutActions(this.cell(body, 'projects')), workedMinutes: worked ? +worked[1] * 60 + +worked[2] : null, entryDisplay: this.valueWithoutActions(this.cell(body, 'entryDisplay')) });
    }
    return result;
  }

  private async walkGrid(visit: (days: GridDay[]) => void, signal?: AbortSignal) {
    const viewport = this.viewport();
    const originalScroll = viewport.scrollTop;
    try {
      let top = 0;
      for (let pass = 0; pass < 150; pass++) {
        this.assertPage(signal);
        viewport.scrollTop = top;
        viewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
        await this.tick(signal);
        visit(this.readRenderedDays());
        const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        if (top >= maximum) return;
        if (viewport.clientHeight <= 0) throw new AdapterError(t('Die HiBob-Tabelle ist ausgeblendet.'));
        top = Math.min(maximum, top + Math.max(48, Math.floor(viewport.clientHeight * .75)));
      }
      throw new AdapterError(t('HiBob-Tabelle konnte nicht vollständig gelesen werden.'));
    } finally {
      viewport.scrollTop = originalScroll;
      viewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
      await sleep(this.settle);
    }
  }

  private async findDay(date: string, signal?: AbortSignal): Promise<GridDay> {
    let found: GridDay | undefined;
    await this.walkGrid(days => { found ??= days.find(day => day.date === date); }, signal);
    if (!found) throw new AdapterError(t('Der {date} wurde in HiBob nicht gefunden.', { date }));
    // Virtual rows may have disappeared while scanning: bring this precise row back into view.
    const viewport = this.viewport();
    const rows = [...viewport.querySelectorAll<HTMLElement>('.ag-center-cols-container [row-index]')];
    const sample = rows.find(row => row.offsetHeight > 0);
    const rowHeight = sample?.offsetHeight || 48;
    viewport.scrollTop = found.index * rowHeight;
    viewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
    await this.tick(signal);
    return await this.waitFor(() => this.readRenderedDays().find(day => day.date === date), t('Der {date} konnte nicht sichtbar gemacht werden.', { date }), signal);
  }

  private bodyRow(day: GridDay): Element {
    return this.unique([...this.viewport().querySelectorAll('.ag-center-cols-container [row-id]')].filter(e => e.getAttribute('row-id') === day.rowId && Number(e.getAttribute('row-index')) === day.index), t('Die Tageszeile hat sich geändert. Bitte erneut einlesen.'));
  }

  private async openDay(day: GridDay, signal?: AbortSignal): Promise<Element> {
    this.assertNoManualForm();
    const row = this.bodyRow(day);
    const safeCell = this.cell(row, 'hoursWorked');
    if (!safeCell || !row.classList.contains('row-clickable')) throw new AdapterError(t('Der {date} bietet keinen unterstützten Tagesdialog.', { date: day.date }));
    // Start/end contains an Add entry action. A plain Hours worked cell opens only the read view.
    this.click(safeCell);
    const panel = await this.waitFor(() => this.panel(), t('HiBob hat den Tagesdialog nicht geöffnet.'), signal);
    this.ownedPanel = panel;
    this.ownedDate = day.date;
    await this.waitFor(() => {
      const heading = panel.querySelector('.sticky-header p.b-display-3');
      return localDateFromUi(text(heading)) === day.date && panel.querySelector('app-attendance-entries-panel');
    }, t('Der HiBob-Tagesdialog zeigt ein anderes oder unbekanntes Datum.'), signal);
    await this.tick(signal);
    return panel;
  }

  private hasSave(panel: Element) { return [...panel.querySelectorAll('button')].some(button => text(button) === 'Save'); }

  private async enterEdit(panel: Element, signal?: AbortSignal) {
    this.assertOwnedPanel();
    if (this.hasSave(panel)) return;
    const add = panel.querySelector<HTMLElement>('button[data-icon-before="clock-add"]') ?? this.button(panel, ['Add entry']);
    this.click(add);
    await this.waitFor(() => this.hasSave(panel) && panel.querySelector('.entry-panel input[type="tel"]'), t('Der native HiBob-Bearbeitungsmodus konnte nicht geöffnet werden.'), signal);
    await this.tick(signal);
  }

  private async inspectDay(day: GridDay, panel: Element, signal?: AbortSignal): Promise<DaySnapshot> {
    // A populated read view need not expose form controls. Open the native editor without saving;
    // the automatically added empty draft is excluded from the snapshot and cancelled afterwards.
    if ((day.workedMinutes || day.entryDisplay) && !panel.querySelector('.entry-panel input[type="tel"]')) await this.enterEdit(panel, signal);
    return this.readSnapshot(day, panel);
  }

  private readTime(inputs: HTMLInputElement[], offset: number): string {
    const h = inputs[offset].value.trim();
    const m = inputs[offset + 1].value.trim();
    if (!h && !m) return '';
    if (!/^\d{1,2}$/.test(h) || !/^\d{1,2}$/.test(m) || +h > 23 || +m > 59) throw new AdapterError(t('Ein bestehender HiBob-Eintrag enthält eine unbekannte Uhrzeit.'));
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }

  readPanelEntries(panel: Element): AttendanceEntry[] {
    return [...panel.querySelectorAll<HTMLElement>('.entry-panel')].flatMap(entry => {
      const inputs = [...entry.querySelectorAll<HTMLInputElement>('input[type="tel"]')];
      if (inputs.length !== 4 || entry.querySelector('[data-time-format="12h"]')) throw new AdapterError(t('HiBob nutzt ein nicht unterstütztes Zeitformat. Erwartet wird 24-Stunden-Start/Ende.'));
      const start = this.readTime(inputs, 0);
      const end = this.readTime(inputs, 2);
      if (!start && !end && entry.classList.contains('new-entry-border')) return [];
      const kind = text(entry.querySelector('.blv-label')).toLowerCase();
      if (kind !== 'work' && kind !== 'break') throw new AdapterError(t('Unbekannter HiBob-Eintragstyp.'));
      const note = entry.querySelector<HTMLTextAreaElement>('textarea')?.value || undefined;
      const reason = text(entry.querySelector('.reason-code-list .trigger-input')) || undefined;
      const metadata = [...entry.querySelectorAll<HTMLElement>('[data-project], .project-name, .task-name')].map(text).filter(Boolean);
      return [{ type: kind, start, end, note, reason, ...(metadata.length ? { metadata } : {}) }];
    });
  }

  private snapshot(day: GridDay, entries: AttendanceEntry[], editable: boolean, unsupportedReason?: string): DaySnapshot {
    const result = { date: day.date, entries, editable, absence: day.absence, nonWorking: day.nonWorking, unsupportedReason };
    return { ...result, fingerprint: snapshotFingerprint(result) };
  }

  private readSnapshot(day: GridDay, panel: Element): DaySnapshot {
    const entries = this.readPanelEntries(panel);
    const addControls = [...panel.querySelectorAll<HTMLButtonElement>('button[data-icon-before="clock-add"], app-attendance-entries-panel button')];
    const editable = addControls.some(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    const issues: string[] = [];
    if (entries.some(entry => !entry.start || !entry.end)) issues.push(t('Offener oder unvollständiger Eintrag'));
    if (entries.some(entry => entry.reason)) issues.push(t('Vorhandener Grund kann in dieser HiBob-Ansicht nicht sicher automatisch entfernt werden'));
    if (entries.some(entry => entry.metadata?.length)) issues.push(t('Zusätzliche Eintragsdaten können nicht sicher automatisch entfernt werden'));
    if (day.projects) issues.push(t('Projektzuordnung: {project}', { project: day.projects }));
    if (day.notes && !entries.some(entry => entry.note)) issues.push(t('Nicht vollständig lesbare Notiz: {note}', { note: day.notes }));
    if (day.reasons && !entries.some(entry => entry.reason)) issues.push(t('Nicht vollständig lesbarer Grund: {reason}', { reason: day.reasons }));
    if (day.workedMinutes && !entries.length) issues.push(t('Bestehende Stunden ohne lesbare Start-/Endeinträge'));
    return this.snapshot(day, entries, editable, issues.length ? issues.join('; ') : undefined);
  }

  private async cancelOwned() {
    const panel = this.panel();
    if (!panel || panel !== this.ownedPanel || localDateFromUi(text(panel.querySelector('.sticky-header p.b-display-3'))) !== this.ownedDate) { this.ownedPanel = null; this.ownedDate = null; return; }
    const cancel = [...panel.querySelectorAll<HTMLElement>('button')].find(button => text(button) === 'Cancel');
    const close = cancel ?? panel.querySelector<HTMLElement>('#rpp-close-btn');
    if (!close) throw new AdapterError(t('Eigener HiBob-Dialog hat keine unterstützte Schließen-Funktion.'));
    this.click(close);
    await this.waitFor(() => !this.panel(), t('Der eigene HiBob-Entwurf konnte nicht geschlossen werden.'));
    this.ownedPanel = null;
    this.ownedDate = null;
  }

  async scanMonth(month: string, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal): Promise<MonthSnapshot> {
    this.assertPage(signal);
    this.assertNoManualForm();
    const periodLabel = await this.selectMonth(month, signal);
    const days = new Map<string, GridDay>();
    await this.walkGrid(rendered => { for (const day of rendered) if (day.date.startsWith(month + '-')) days.set(day.date, day); }, signal);
    const expected = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    if (days.size !== expected) throw new AdapterError(t('HiBob lieferte nur {actual} von {expected} Kalendertagen. Bitte den Monatszeitraum und die eingeblendeten Spalten prüfen.', { actual: days.size, expected }));
    const result: DaySnapshot[] = [];
    try {
      for (const date of [...days.keys()].sort()) {
        this.assertPage(signal);
        onProgress?.({ phase: 'scan', date, completed: result.length, total: expected, message: t('Lese {date}', { date }) });
        const day = await this.findDay(date, signal);
        if (day.absence || day.nonWorking) result.push(this.snapshot(day, [], false));
        else {
          const panel = await this.openDay(day, signal);
          result.push(await this.inspectDay(day, panel, signal));
          await this.cancelOwned();
        }
      }
    } finally { await this.cancelOwned(); }
    onProgress?.({ phase: 'scan', completed: expected, total: expected, message: t('Monat vollständig gelesen') });
    return { month, employeeLabel: t('Angemeldetes HiBob-Konto · My attendance'), periodLabel, scannedAt: new Date().toISOString(), source: 'hibob', days: result };
  }

  private setInput(input: HTMLInputElement, value: string) {
    this.assertPage();
    this.assertOwnedPanel();
    if (!input.isConnected || input.disabled || input.readOnly) throw new AdapterError(t('HiBob-Zeitfeld ist nicht bearbeitbar.'));
    const win = this.doc.defaultView!;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    input.dispatchEvent(new win.FocusEvent('blur', { bubbles: true }));
  }

  private clearNote(entry: Element) {
    this.assertOwnedPanel();
    const note = entry.querySelector<HTMLTextAreaElement>('textarea');
    if (!note?.value) return;
    if (note.disabled || note.readOnly) throw new AdapterError(t('Eine bestehende Notiz kann nicht sicher entfernt werden.'));
    const win = this.doc.defaultView!;
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '');
    note.dispatchEvent(new win.Event('input', { bubbles: true }));
    note.dispatchEvent(new win.Event('change', { bubbles: true }));
    note.dispatchEvent(new win.FocusEvent('blur', { bubbles: true }));
  }

  private async addEntry(panel: Element, type: 'work' | 'break', signal?: AbortSignal): Promise<HTMLElement> {
    this.assertOwnedPanel();
    const before = new Set(panel.querySelectorAll<HTMLElement>('.entry-panel'));
    let control = panel.querySelector<HTMLElement>(`button[data-icon-before="${type === 'work' ? 'clock-add' : 'break-add'}"]`);
    if (!control && type === 'work' && !before.size) control = this.button(panel, ['Add entry']);
    if (!control) throw new AdapterError(type === 'work' ? t('HiBob bietet das Hinzufügen eines Arbeitseintrags nicht an.') : t('HiBob bietet das Hinzufügen eines Pauseneintrags nicht an.'));
    this.click(control);
    return await this.waitFor(() => {
      const added = [...panel.querySelectorAll<HTMLElement>('.entry-panel')].filter(entry => !before.has(entry));
      return added.length === 1 ? added[0] : null;
    }, t('HiBob hat keinen eindeutigen neuen Eintrag angelegt.'), signal);
  }

  private validationError(panel: Element): string | null {
    const errors = [...panel.querySelectorAll('[role="alert"], [aria-invalid="true"], b-input-message [data-type="error"], .error-message, .bfe-error, .error-text')].filter(e => e.getAttribute('aria-hidden') !== 'true');
    if (errors.length) return errors.map(text).filter(Boolean).join('; ') || t('HiBob meldet ungültige Eingaben.');
    return null;
  }

  private validateProposed(entries: AttendanceEntry[]) {
    if (!entries.length || entries.length > 12) throw new AdapterError(t('Unzulässige Anzahl neuer Zeiteinträge.'));
    let previousEnd = '';
    for (const entry of entries) {
      if (!['work', 'break'].includes(entry.type) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.end) || entry.start >= entry.end || entry.start < previousEnd) throw new AdapterError(t('Die geplanten Einträge sind unvollständig, überlappend oder nicht chronologisch.'));
      if (entry.note || entry.reason || entry.metadata?.length) throw new AdapterError(t('Neue Notizen, Gründe und Projektzuordnungen werden nicht automatisch geschrieben.'));
      previousEnd = entry.end;
    }
  }

  private sameEntries(a: AttendanceEntry[], b: AttendanceEntry[]) {
    const shape = (entries: AttendanceEntry[]) => JSON.stringify(entries.map(({ type, start, end, note, reason, metadata }) => ({ type, start, end, note: note ?? '', reason: reason ?? '', metadata: metadata ?? [] })).sort((x, y) => x.start.localeCompare(y.start) || x.type.localeCompare(y.type)));
    return shape(a) === shape(b);
  }

  async applyDay(day: DayPlan, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal): Promise<DaySnapshot> {
    this.assertPage(signal);
    this.assertNoManualForm();
    if (!['create', 'overwrite'].includes(day.action) || !day.eligible || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new AdapterError(t('Dieser Tag ist nicht zum Schreiben freigegeben.'));
    this.validateProposed(day.proposed);
    await this.selectMonth(day.date.slice(0, 7), signal);
    let saveClicked = false;
    let verificationOpened = false;
    try {
      const current = await this.findDay(day.date, signal);
      if (current.absence || current.nonWorking) throw new AdapterError(t('In HiBob ist inzwischen eine Abwesenheit oder ein arbeitsfreier Tag eingetragen.'));
      const panel = await this.openDay(current, signal);
      const before = await this.inspectDay(current, panel, signal);
      if (before.fingerprint !== day.fingerprint || !before.editable || before.unsupportedReason) throw new AdapterError(t('Der Tag hat sich seit der Vorschau geändert oder ist nicht vollständig bearbeitbar. Bitte neu einlesen.'));
      if (day.action === 'create' && before.entries.length) throw new AdapterError(t('Der Tag enthält inzwischen Einträge.'));
      await this.enterEdit(panel, signal);
      // Only empty drafts created by opening the editor may be removed. Saved segments are never deleted.
      if (before.entries.length) {
        const emptyDrafts = [...panel.querySelectorAll<HTMLElement>('.entry-panel.new-entry-border')].filter(entry => [...entry.querySelectorAll<HTMLInputElement>('input[type="tel"]')].length === 4 && [...entry.querySelectorAll<HTMLInputElement>('input[type="tel"]')].every(input => !input.value));
        for (const draft of emptyDrafts) {
          this.assertPage(signal);
          const remove = draft.querySelector<HTMLElement>('button[data-icon-before="delete"]');
          if (!remove) throw new AdapterError(t('Leerer HiBob-Entwurf kann nicht sicher entfernt werden.'));
          this.click(remove);
          await this.tick(signal);
        }
      }
      const available = [...panel.querySelectorAll<HTMLElement>('.entry-panel')];
      for (const type of ['work', 'break'] as const) {
        const existingCount = available.filter(entry => text(entry.querySelector('.blv-label')).toLowerCase() === type).length;
        if (existingCount > day.proposed.filter(entry => entry.type === type).length) throw new AdapterError(t('Der Austausch würde gespeicherte Segmente einzeln löschen. Diese HiBob-Variante wird vorsichtshalber nicht automatisch überschrieben; bitte den Tag manuell bereinigen und neu einlesen.'));
      }
      onProgress?.({ phase: 'apply', date: day.date, completed: 0, total: 1, message: t('Prüfe und fülle Tagesentwurf') });
      for (const proposed of day.proposed) {
        this.assertPage(signal);
        let entry = available.find(candidate => text(candidate.querySelector('.blv-label')).toLowerCase() === proposed.type);
        if (entry) available.splice(available.indexOf(entry), 1);
        else entry = await this.addEntry(panel, proposed.type, signal);
        const inputs = [...entry.querySelectorAll<HTMLInputElement>('input[type="tel"]')];
        if (inputs.length !== 4) throw new AdapterError(t('HiBob-Zeitfelder haben sich geändert.'));
        const values = [...proposed.start.split(':'), ...proposed.end.split(':')];
        for (let i = 0; i < 4; i++) { this.assertPage(signal); this.setInput(inputs[i], values[i]); }
        this.clearNote(entry);
        await this.tick(signal);
      }
      const draft = this.readPanelEntries(panel);
      if (!this.sameEntries(draft, day.proposed)) throw new AdapterError(t('Der HiBob-Entwurf einschließlich Notizen und Gründen stimmt nicht mit der Vorschau überein.'));
      const error = this.validationError(panel);
      if (error) throw new AdapterError(t('HiBob lehnt den Entwurf ab: {error}', { error }));
      const save = this.button(panel, ['Save']);
      this.assertPage(signal); // Cancellation is honoured until this exact boundary.
      this.assertOwnedPanel();
      saveClicked = true;
      this.click(save);
      await this.waitFor(() => !this.panel(), t('HiBob hat den Speichervorgang nicht eindeutig abgeschlossen.'));
      this.ownedPanel = null;
      this.ownedDate = null;
      await this.tick();
      // Never repeat Save on a timeout. Reopen and compare persisted segments, independently of cancellation.
      const afterRow = await this.findDay(day.date);
      const verifyPanel = await this.openDay(afterRow);
      verificationOpened = true;
      const after = await this.inspectDay(afterRow, verifyPanel);
      const netMinutes = day.proposed.filter(entry => entry.type === 'work').reduce((sum, entry) => {
        const minutes = (value: string) => +value.slice(0, 2) * 60 + +value.slice(3);
        return sum + minutes(entry.end) - minutes(entry.start);
      }, 0);
      if (!this.sameEntries(after.entries, day.proposed) || afterRow.workedMinutes !== netMinutes) throw new AdapterError(t('Die gespeicherten HiBob-Segmente, Zusatzdaten oder die Nettozeit weichen von der Vorschau ab. Bitte den Tag manuell prüfen.'), true);
      await this.cancelOwned();
      onProgress?.({ phase: 'apply', date: day.date, completed: 1, total: 1, message: t('Gespeicherte Segmente und Nettozeit geprüft') });
      return after;
    } catch (error) {
      if (saveClicked) throw new AdapterError(error instanceof Error ? error.message : t('Unklarer HiBob-Speicherzustand.'), true);
      throw error;
    } finally {
      // Before Save we discard only our draft; after Save a remaining panel may be the unresolved save,
      // so leave it visible for manual inspection instead of issuing another mutation.
      if (!saveClicked || verificationOpened) {
        try { await this.cancelOwned(); }
        catch (cleanupError) {
          if (saveClicked) throw new AdapterError(cleanupError instanceof Error ? cleanupError.message : t('Die Lesebestätigung konnte nicht abgeschlossen werden.'), true);
          throw cleanupError;
        }
      }
    }
  }
}

export const scanMonth = (month: string, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal) => new HiBobDomAdapter().scanMonth(month, onProgress, signal);
export const applyDay = (day: DayPlan, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal) => new HiBobDomAdapter().applyDay(day, onProgress, signal);
