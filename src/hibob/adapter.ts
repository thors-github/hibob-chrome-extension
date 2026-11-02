import { t } from '../i18n/index';
import { netMinutes } from '../shared/entries';
import type { AdapterProgress, AttendanceContext, AttendanceEntry, DayPlan, DaySnapshot, MonthSnapshot } from '../shared/types';

const PREFIX = 'time_attendance_employee_timesheet.';
const PANEL = '#attendance-right-panel';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
class GridChangedError extends Error {}

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
  return JSON.stringify({ date: day.date, editable: day.editable, reportedMinutes: day.reportedMinutes ?? null, absence: day.absence ?? '', nonWorking: day.nonWorking ?? '', unsupportedReason: day.unsupportedReason ?? '', entries: day.entries.map(entry => ({ type: entry.type, start: entry.start, end: entry.end, note: entry.note ?? '', reason: entry.reason ?? '', metadata: entry.metadata ?? [] })) });
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
  unsupportedReason?: string;
}

interface AdapterOptions {
  document?: Document;
  location?: () => string;
  timeoutMs?: number;
  settleMs?: number;
  readinessTimeoutMs?: number;
  rowSeekTimeoutMs?: number;
  pollMs?: number;
  stabilityMs?: number;
  documentId?: string;
  readContext?: () => AttendanceContext | Promise<AttendanceContext>;
}

export class HiBobDomAdapter {
  private readonly doc: Document;
  private readonly location: () => string;
  private readonly timeout: number;
  private readonly settle: number;
  private readonly readinessTimeout: number;
  private readonly rowSeekTimeout: number;
  private readonly poll: number;
  private readonly stability: number;
  private readonly documentId: string;
  private readonly contextReader?: AdapterOptions['readContext'];
  private ownedPanel: Element | null = null;
  private ownedDate: string | null = null;
  private ownedContext: string | null = null;

  constructor(options: AdapterOptions = {}) {
    this.doc = options.document ?? document;
    this.location = options.location ?? (() => window.location.href);
    this.timeout = options.timeoutMs ?? 8000;
    this.settle = options.settleMs ?? 150;
    this.readinessTimeout = options.readinessTimeoutMs ?? 30000;
    this.rowSeekTimeout = options.rowSeekTimeoutMs ?? 10000;
    this.poll = options.pollMs ?? 100;
    this.stability = options.stabilityMs ?? 300;
    this.documentId = options.documentId ?? this.doc.defaultView!.crypto.randomUUID();
    this.contextReader = options.readContext;
  }

  private async context(): Promise<AttendanceContext> {
    this.assertPage();
    // No stable employee key is exposed by the inspected native attendance UI.
    // Avatar resources and display names are not employee identifiers. Until a
    // supported visible identity reader exists, native scans remain read-only.
    const value = await this.contextReader?.();
    if (!value?.verified || !value.employeeKey?.trim() || !value.tenantKey?.trim()) return {
      documentId: this.documentId, verified: false,
      reason: t('Die stabile HiBob-Mitarbeiteridentität ist in dieser Ansicht nicht nachweisbar. Die Vorschau bleibt schreibgeschützt.'),
    };
    return { documentId: this.documentId, verified: true, employeeKey: value.employeeKey, tenantKey: value.tenantKey };
  }

  private contextSignature(value: AttendanceContext): string {
    return JSON.stringify([value.documentId, value.verified, value.employeeKey ?? '', value.tenantKey ?? '']);
  }

  private async assertContext(expected: AttendanceContext | undefined) {
    if (!expected?.verified || !expected.documentId || !expected.employeeKey || !expected.tenantKey) throw new AdapterError(t('Die Vorschau ist keinem verifizierten HiBob-Konto zugeordnet. Bitte neu einlesen; ohne stabile Identität wird nicht gebucht.'));
    const current = await this.context();
    if (!current.verified || this.contextSignature(current) !== this.contextSignature(expected)) throw new AdapterError(t('Das HiBob-Konto oder das Browserdokument hat sich seit der Vorschau geändert. Bitte neu einlesen.'));
  }

  private assertPage(signal?: AbortSignal) {
    if (!isAttendanceLocation(this.location())) throw new AdapterError(t('Bitte „My attendance“ unter https://app.hibob.com/attendance/my-attendance öffnen.'));
    if (signal?.aborted) throw new AdapterError(t('Vorgang abgebrochen.'));
  }

  private async waitFor<T>(read: () => T | null | false | undefined, message: string, signal?: AbortSignal, deadline = Infinity): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < this.timeout && Date.now() < deadline) {
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

  private selectedMonth(month: string): boolean {
    try { return this.periodContainsMonth(text(this.periodControl()), month); }
    catch (error) { if (error instanceof AdapterError) return false; throw error; }
  }

  private async selectMonth(month: string, signal?: AbortSignal, deadline = Infinity): Promise<string> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AdapterError(t('Ungültiger Monat.'));
    const control = this.periodControl();
    if (!this.periodContainsMonth(text(control), month)) {
      this.click(control);
      const options = await this.waitFor(() => {
        const found = [...this.doc.querySelectorAll<HTMLElement>('[role="treeitem"], [role="option"]')];
        return found.length ? found : null;
      }, t('Die verfügbaren HiBob-Zeiträume konnten nicht gelesen werden.'), signal, deadline);
      const candidates = options.filter(option => this.periodContainsMonth(text(option), month));
      if (candidates.length !== 1) {
        // Close only our period picker. Never invent a period or bypass HiBob restrictions.
        control.dispatchEvent(new this.doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        throw new AdapterError(t('HiBob stellt den Monat {month} nicht als auswählbaren Monatszeitraum bereit.', { month }));
      }
      this.click(candidates[0]);
      await this.waitFor(() => this.selectedMonth(month), t('HiBob hat den gewählten Monat nicht geöffnet.'), signal, deadline);
      await this.tick(signal);
    }
    return text(this.periodControl());
  }

  private viewport(): HTMLElement {
    return this.unique([...this.doc.querySelectorAll<HTMLElement>('.ag-body-viewport')].filter(viewport => viewport.querySelector('.ag-center-cols-container')), t('HiBob-Anwesenheitstabelle nicht eindeutig gefunden.'));
  }

  private availableViewport(): HTMLElement | null {
    const found = [...this.doc.querySelectorAll<HTMLElement>('.ag-body-viewport')].filter(viewport => viewport.querySelector('.ag-center-cols-container'));
    return found.length === 1 ? found[0] : null;
  }

  private cell(row: Element, suffix: string): Element | null { return row.querySelector(`[col-id="${PREFIX}${suffix}"]`); }

  private visible(element: Element): boolean {
    for (let current: Element | null = element; current; current = current.parentElement) {
      // aria-hidden hides content from assistive technology, not from sight.
      // Visually rendered icon-only markers must still prevent a false empty cell.
      if (current.hasAttribute('hidden')) return false;
      const style = this.doc.defaultView!.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  private readCell(cell: Element | null, emptyActions: string[] = []): { value: string; unknown: boolean } {
    if (!cell) return { value: '', unknown: false };
    const clone = cell.cloneNode(true) as Element;
    const originals = [...cell.querySelectorAll('*')];
    const copies = [...clone.querySelectorAll('*')];
    for (let i = originals.length - 1; i >= 0; i--) if (!this.visible(originals[i])) copies[i].remove();
    let unknown = false;
    for (const item of clone.querySelectorAll('button, [role="button"], a, img, [role="img"]')) {
      if (!clone.contains(item)) continue;
      const label = text(item).replace(/[\uE000-\uF8FF]/g, '').trim() || item.getAttribute('aria-label')?.trim() || item.getAttribute('alt')?.trim() || item.getAttribute('title')?.trim() || '';
      if (emptyActions.includes(label)) {
        const wrapper = item.closest('.empty-state-component');
        if (wrapper && text(wrapper).replace(/[\uE000-\uF8FF]/g, '').trim() === label) wrapper.remove();
        else item.remove();
      } else if (label) {
        if (!text(item)) item.textContent = label;
      } else unknown = true;
    }
    const rawValue = text(clone);
    const value = rawValue.replace(/[\uE000-\uF8FF]/g, '').trim();
    if (!value && (rawValue || clone.querySelector('button, [role="button"], img, svg, [role="img"], [data-icon], [data-icon-before], [data-icon-after], b-icon, .b-icon'))) unknown = true;
    return { value, unknown: unknown && !value };
  }

  private valueWithoutActions(cell: Element | null, emptyActions: string[] = []): string {
    return this.readCell(cell, emptyActions).value;
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
      const absence = this.readCell(this.cell(body, 'timeOff'), ['Request time off']);
      const nonWorking = this.readCell(this.cell(body, 'holidayOrNonWorkingDay'));
      const unsupportedReason = absence.unknown || nonWorking.unknown ? t('Eine HiBob-Abwesenheits- oder Kalenderkennzeichnung ist nicht eindeutig lesbar. Bitte den Tag manuell prüfen.') : undefined;
      result.push({ date, rowId, index, absence: absence.value || undefined, nonWorking: nonWorking.value || undefined, reasons: this.valueWithoutActions(this.cell(body, 'entryReasons')), notes: this.valueWithoutActions(this.cell(body, 'comments')), projects: this.valueWithoutActions(this.cell(body, 'projects')), workedMinutes: worked && +worked[2] < 60 && Number.isSafeInteger(+worked[1] * 60 + +worked[2]) ? +worked[1] * 60 + +worked[2] : null, entryDisplay: this.valueWithoutActions(this.cell(body, 'entryDisplay'), ['Add entry']), unsupportedReason });
    }
    return result;
  }

  private gridLoading(viewport: HTMLElement): boolean {
    const grid = viewport.closest('.ag-root-wrapper, .ag-root') ?? viewport;
    return grid.matches('[aria-busy="true"]') && this.visible(grid) || [...grid.querySelectorAll('[aria-busy="true"], .ag-overlay-loading-center')].some(element => this.visible(element));
  }

  private async walkGrid(visit: (days: GridDay[]) => boolean | void, signal?: AbortSignal, options: { deadline?: number; retainMatch?: boolean } = {}) {
    const viewport = this.availableViewport();
    if (!viewport) throw new GridChangedError();
    const originalScroll = viewport.scrollTop;
    const deadline = options.deadline ?? Date.now() + this.rowSeekTimeout;
    let matched = false;
    try {
      let top = 0;
      while (Date.now() < deadline) {
        this.assertPage(signal);
        if (!viewport.isConnected || this.availableViewport() !== viewport) throw new GridChangedError();
        if (viewport.clientHeight <= 0) throw new GridChangedError();
        viewport.scrollTop = top;
        viewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
        await sleep(this.poll);
        this.assertPage(signal);
        if (!viewport.isConnected || this.availableViewport() !== viewport) throw new GridChangedError();
        if (this.gridLoading(viewport)) { await sleep(this.poll); continue; }
        matched = visit(this.readRenderedDays()) === true;
        if (matched) return;
        const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const current = viewport.scrollTop;
        if (current >= maximum) return;
        const next = Math.min(maximum, current + Math.max(1, Math.floor(viewport.clientHeight * .75)));
        if (next <= current) { await sleep(this.poll); continue; }
        top = next;
      }
      throw new GridChangedError();
    } finally {
      if ((!matched || !options.retainMatch) && viewport.isConnected) {
        viewport.scrollTop = originalScroll;
        viewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
      }
    }
  }

  private async readyMonth(month: string, deadline: number, signal?: AbortSignal): Promise<Map<string, GridDay>> {
    const expected = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    let previous: string | undefined;
    while (Date.now() < deadline) {
      this.assertPage(signal);
      const viewport = this.availableViewport();
      if (!viewport || viewport.clientHeight <= 0 || this.gridLoading(viewport) || !this.selectedMonth(month)) {
        previous = undefined;
        await sleep(this.poll);
        continue;
      }
      const days = new Map<string, GridDay>();
      let foreign = false;
      try {
        await this.walkGrid(rendered => {
          for (const day of rendered) {
            if (day.date.startsWith(month + '-')) days.set(day.date, day);
            else foreign = true;
          }
        }, signal, { deadline });
      } catch (error) {
        if (!(error instanceof GridChangedError)) throw error;
        previous = undefined;
        continue;
      }
      if (!foreign && days.size === expected && this.selectedMonth(month) && this.availableViewport() && !this.gridLoading(this.viewport())) {
        const signature = JSON.stringify([...days].sort(([a], [b]) => a.localeCompare(b)));
        if (signature === previous) return days;
        previous = signature;
        await sleep(Math.min(this.stability, Math.max(0, deadline - Date.now())));
      } else { previous = undefined; await sleep(this.poll); }
    }
    throw new AdapterError(t('Die HiBob-Monatsdaten wurden nicht vollständig und stabil geladen. Bitte warten und den Monat erneut einlesen.'));
  }

  private async findDay(date: string, signal?: AbortSignal): Promise<GridDay> {
    const deadline = Date.now() + this.rowSeekTimeout;
    const findRendered = () => this.readRenderedDays().find(day => day.date === date);
    while (Date.now() < deadline) {
      this.assertPage(signal);
      const viewport = this.availableViewport();
      if (!viewport || viewport.clientHeight <= 0 || this.gridLoading(viewport)) { await sleep(this.poll); continue; }
      try {
        let found = findRendered();
        if (!found) await this.walkGrid(days => {
          found = days.find(day => day.date === date);
          return !!found;
        }, signal, { deadline, retainMatch: true });
        if (found) {
          // Overscan may render rows outside the viewport. Use measured bounds,
          // never rowIndex multiplied by an assumed uniform row height.
          const viewport = this.viewport();
          const row = this.bodyRow(found);
          const bounds = row.getBoundingClientRect();
          const visible = viewport.getBoundingClientRect();
          if (bounds.height > 0 && visible.height > 0 && (bounds.bottom <= visible.top || bounds.top >= visible.bottom)) {
            viewport.scrollTop += bounds.top - visible.top;
            viewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
            await sleep(this.poll);
            found = findRendered();
          }
          if (found) return found;
        }
      } catch (error) { if (!(error instanceof GridChangedError)) throw error; }
      await sleep(this.poll);
    }
    throw new AdapterError(t('Der {date} konnte nicht sichtbar gemacht werden.', { date }));
  }

  private bodyRow(day: GridDay): Element {
    return this.unique([...this.viewport().querySelectorAll('.ag-center-cols-container [row-id]')].filter(e => e.getAttribute('row-id') === day.rowId && Number(e.getAttribute('row-index')) === day.index), t('Die Tageszeile hat sich geändert. Bitte erneut einlesen.'));
  }

  private async openDay(day: GridDay, signal?: AbortSignal, expectedContext?: AttendanceContext): Promise<Element> {
    this.assertNoManualForm();
    const context = this.contextSignature(await this.context());
    this.assertPage(signal);
    if (expectedContext && context !== this.contextSignature(expectedContext)) throw new AdapterError(t('Das HiBob-Konto oder das Browserdokument hat sich seit der Vorschau geändert. Bitte neu einlesen.'));
    const row = this.bodyRow(day);
    const safeCell = this.cell(row, 'hoursWorked');
    if (!safeCell || !row.classList.contains('row-clickable')) throw new AdapterError(t('Der {date} bietet keinen unterstützten Tagesdialog.', { date: day.date }));
    // Start/end contains an Add entry action. A plain Hours worked cell opens only the read view.
    this.click(safeCell);
    const panel = await this.waitFor(() => this.panel(), t('HiBob hat den Tagesdialog nicht geöffnet.'), signal);
    this.ownedPanel = panel;
    this.ownedDate = day.date;
    this.ownedContext = context;
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
    const result = { date: day.date, entries, editable, reportedMinutes: day.workedMinutes, absence: day.absence, nonWorking: day.nonWorking, unsupportedReason: unsupportedReason ?? day.unsupportedReason };
    return { ...result, fingerprint: snapshotFingerprint(result) };
  }

  private readSnapshot(day: GridDay, panel: Element): DaySnapshot {
    const entries = this.readPanelEntries(panel);
    const addControls = [...panel.querySelectorAll<HTMLButtonElement>('button[data-icon-before="clock-add"], app-attendance-entries-panel button')];
    const editable = addControls.some(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    const issues: string[] = day.unsupportedReason ? [day.unsupportedReason] : [];
    if (entries.some(entry => !entry.start || !entry.end)) issues.push(t('Offener oder unvollständiger Eintrag'));
    if (entries.some(entry => entry.reason)) issues.push(t('Vorhandener Grund kann in dieser HiBob-Ansicht nicht sicher automatisch entfernt werden'));
    if (entries.some(entry => entry.metadata?.length)) issues.push(t('Zusätzliche Eintragsdaten können nicht sicher automatisch entfernt werden'));
    if (day.projects) issues.push(t('Projektzuordnung: {project}', { project: day.projects }));
    if (day.notes && !entries.some(entry => entry.note)) issues.push(t('Nicht vollständig lesbare Notiz: {note}', { note: day.notes }));
    if (day.reasons && !entries.some(entry => entry.reason)) issues.push(t('Nicht vollständig lesbarer Grund: {reason}', { reason: day.reasons }));
    if (day.workedMinutes && !entries.length) issues.push(t('Bestehende Stunden ohne lesbare Start-/Endeinträge'));
    const derived = netMinutes(entries);
    if (day.workedMinutes === null) issues.push(t('Die gemeldeten HiBob-Arbeitsstunden sind nicht lesbar. Ohne verlässlichen Stundenwert wird nicht gebucht.'));
    else if (derived === null || derived !== day.workedMinutes) issues.push(t('HiBobs gemeldete Arbeitsstunden stimmen nicht mit den gelesenen Einträgen überein. Bitte den Tag manuell prüfen.'));
    return this.snapshot(day, entries, editable, issues.length ? issues.join('; ') : undefined);
  }

  private async cancelOwned() {
    const panel = this.panel();
    if (!panel || panel !== this.ownedPanel || localDateFromUi(text(panel.querySelector('.sticky-header p.b-display-3'))) !== this.ownedDate || this.contextSignature(await this.context()) !== this.ownedContext) { this.ownedPanel = null; this.ownedDate = null; this.ownedContext = null; return; }
    const cancel = [...panel.querySelectorAll<HTMLElement>('button')].find(button => text(button) === 'Cancel');
    const close = cancel ?? panel.querySelector<HTMLElement>('#rpp-close-btn');
    if (!close) throw new AdapterError(t('Eigener HiBob-Dialog hat keine unterstützte Schließen-Funktion.'));
    this.click(close);
    await this.waitFor(() => !this.panel(), t('Der eigene HiBob-Entwurf konnte nicht geschlossen werden.'));
    this.ownedPanel = null;
    this.ownedDate = null;
    this.ownedContext = null;
  }

  async scanMonth(month: string, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal): Promise<MonthSnapshot> {
    this.assertPage(signal);
    this.assertNoManualForm();
    const context = await this.context();
    const initialViewport = this.doc.querySelector<HTMLElement>('.ag-body-viewport');
    const initialScroll = initialViewport?.scrollTop;
    const deadline = Date.now() + this.readinessTimeout;
    const periodLabel = await this.selectMonth(month, signal, deadline);
    onProgress?.({ phase: 'scan', completed: 0, total: 0, message: t('Warte auf vollständige und stabile HiBob-Monatsdaten') });
    const days = await this.readyMonth(month, deadline, signal);
    const expected = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
    const result: DaySnapshot[] = [];
    try {
      for (const date of [...days.keys()].sort()) {
        this.assertPage(signal);
        onProgress?.({ phase: 'scan', date, completed: result.length, total: expected, message: t('Lese {date}', { date }) });
        const day = await this.findDay(date, signal);
        if (day.absence || day.nonWorking || day.unsupportedReason) result.push(this.snapshot(day, [], false));
        else {
          const panel = await this.openDay(day, signal);
          result.push(await this.inspectDay(day, panel, signal));
          await this.cancelOwned();
        }
      }
      if (this.contextSignature(await this.context()) !== this.contextSignature(context)) throw new AdapterError(t('Das HiBob-Konto oder das Browserdokument hat sich während des Einlesens geändert. Bitte neu einlesen.'));
    } finally {
      await this.cancelOwned();
      if (initialViewport?.isConnected && initialScroll !== undefined && isAttendanceLocation(this.location())) {
        const currentContext = await this.context().catch(() => null);
        if (currentContext && this.contextSignature(currentContext) === this.contextSignature(context)) {
          initialViewport.scrollTop = initialScroll;
          initialViewport.dispatchEvent(new this.doc.defaultView!.Event('scroll', { bubbles: true }));
        }
      }
    }
    onProgress?.({ phase: 'scan', completed: expected, total: expected, message: t('Monat vollständig gelesen') });
    return { month, employeeLabel: context.verified ? `${context.employeeKey} · ${context.tenantKey}` : t('Nicht verifiziertes HiBob-Konto · schreibgeschützte Vorschau'), context, periodLabel, scannedAt: new Date().toISOString(), source: 'hibob', days: result };
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

  async applyDay(day: DayPlan, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal, expectedContext?: AttendanceContext): Promise<DaySnapshot> {
    this.assertPage(signal);
    this.assertNoManualForm();
    await this.assertContext(expectedContext);
    if (!['create', 'overwrite'].includes(day.action) || !day.eligible || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new AdapterError(t('Dieser Tag ist nicht zum Schreiben freigegeben.'));
    this.validateProposed(day.proposed);
    await this.selectMonth(day.date.slice(0, 7), signal);
    let saveClicked = false;
    let verificationOpened = false;
    try {
      const current = await this.findDay(day.date, signal);
      if (current.absence || current.nonWorking) throw new AdapterError(t('In HiBob ist inzwischen eine Abwesenheit oder ein arbeitsfreier Tag eingetragen.'));
      const panel = await this.openDay(current, signal, expectedContext);
      await this.assertContext(expectedContext);
      const before = await this.inspectDay(current, panel, signal);
      if (before.fingerprint !== day.fingerprint || !before.editable || before.unsupportedReason) throw new AdapterError(t('Der Tag hat sich seit der Vorschau geändert oder ist nicht vollständig bearbeitbar. Bitte neu einlesen.'));
      if (day.action === 'create' && before.entries.length) throw new AdapterError(t('Der Tag enthält inzwischen Einträge.'));
      await this.assertContext(expectedContext);
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
      await this.assertContext(expectedContext);
      this.assertPage(signal);
      this.assertOwnedPanel();
      saveClicked = true;
      this.click(save);
      await this.waitFor(() => !this.panel(), t('HiBob hat den Speichervorgang nicht eindeutig abgeschlossen.'));
      this.ownedPanel = null;
      this.ownedDate = null;
      this.ownedContext = null;
      await this.tick();
      // Never repeat Save on a timeout. Reopen and compare persisted segments, independently of cancellation.
      const afterRow = await this.findDay(day.date);
      const verifyPanel = await this.openDay(afterRow, undefined, expectedContext);
      verificationOpened = true;
      const after = await this.inspectDay(afterRow, verifyPanel);
      await this.assertContext(expectedContext);
      if (!this.sameEntries(after.entries, day.proposed) || afterRow.workedMinutes !== netMinutes(day.proposed) || after.unsupportedReason) throw new AdapterError(t('Die gespeicherten HiBob-Segmente, Zusatzdaten oder die Nettozeit weichen von der Vorschau ab. Bitte den Tag manuell prüfen.'), true);
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
export const applyDay = (day: DayPlan, onProgress?: (progress: AdapterProgress) => void, signal?: AbortSignal, expectedContext?: AttendanceContext) => new HiBobDomAdapter().applyDay(day, onProgress, signal, expectedContext);
