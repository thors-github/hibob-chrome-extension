import { formatMinutes } from '../domain/index';
import { locale, localizeText, t } from '../i18n';
import type { DayPlan, DayResult, RunState } from '../shared/types';

export interface MonthCalendarOptions {
  month: string;
  days?: DayPlan[];
  run?: RunState;
  focusDate?: string;
  onOpenDate(date: string): void;
  onFocusDate?(date: string): void;
}

type CalendarState = DayPlan['action'] | 'neutral' | 'running' | 'awaiting-verification' | 'verified' | 'failed' | 'uncertain';

/** Proposed changes and server-verified results deliberately have different labels. */
function stateDescription(state: CalendarState): { label: string; marker: string } {
  switch (state) {
    case 'create': return { label: t('Geplant'), marker: '+' };
    case 'unchanged': return { label: t('Bereits passend'), marker: '✓' };
    case 'overwrite': return { label: t('Ersetzen'), marker: '↻' };
    case 'conflict': return { label: t('Klärung nötig'), marker: '!' };
    case 'blocked': return { label: t('Nicht buchbar'), marker: '!' };
    case 'skip': return { label: t('Ausgelassen'), marker: '−' };
    case 'running': return { label: t('Wird übertragen'), marker: '…' };
    case 'awaiting-verification': return { label: t('Übertragen – Prüfung ausstehend'), marker: '…' };
    case 'verified': return { label: t('Gespeichert und geprüft'), marker: '✓' };
    case 'failed': return { label: t('Fehlgeschlagen'), marker: '!' };
    case 'uncertain': return { label: t('Speicherstatus unklar'), marker: '?' };
    default: return { label: t('Noch nicht eingelesen'), marker: '' };
  }
}

function dayState(day: DayPlan | undefined, result: DayResult | undefined): CalendarState {
  if (result && result.status !== 'pending' && result.status !== 'skipped') return result.status;
  return day?.action ?? 'neutral';
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

/** A bounded, Monday-first six-week grid. Inspecting a date never edits the plan. */
export function renderMonthCalendar(container: HTMLElement, options: MonthCalendarOptions): void {
  const match = /^(\d{4})-(\d{2})$/.exec(options.month);
  container.replaceChildren();
  if (!match) return;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return;
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const count = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const dates = Array.from({ length: count }, (_, index) => `${options.month}-${String(index + 1).padStart(2, '0')}`);
  const days = new Map(options.days?.map(day => [day.date, day]));
  const results = new Map(options.run?.results.map(result => [result.date, result]));
  const focusDate = dates.includes(options.focusDate ?? '') ? options.focusDate! : dates[0];
  const monthLabel = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }).format(first);
  const fullDate = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
  const grid = element('div', 'calendar-grid');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', t('Kalender für {month}', { month: monthLabel }));
  grid.setAttribute('aria-rowcount', '7');
  grid.setAttribute('aria-colcount', '7');
  const header = element('div', 'calendar-row calendar-weekdays');
  header.setAttribute('role', 'row');
  const weekdayShort = new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' });
  const weekdayLong = new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' });
  for (let index = 0; index < 7; index++) {
    // 2026-11-02 is a Monday; headers are independent of the selected month.
    const date = new Date(Date.UTC(2026, 10, 2 + index, 12));
    const column = element('span', 'calendar-weekday', weekdayShort.format(date).replace(/\.$/, ''));
    column.setAttribute('role', 'columnheader');
    column.setAttribute('aria-label', weekdayLong.format(date));
    header.append(column);
  }
  grid.append(header);
  const buttons = new Map<string, HTMLButtonElement>();
  const legendStates = new Set<CalendarState>();
  for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
    const row = element('div', 'calendar-row');
    row.setAttribute('role', 'row');
    for (let columnIndex = 0; columnIndex < 7; columnIndex++) {
      const dateIndex = rowIndex * 7 + columnIndex - offset;
      const cell = element('div', 'calendar-cell');
      cell.setAttribute('role', 'gridcell');
      if (dateIndex < 0 || dateIndex >= count) {
        cell.classList.add('calendar-blank');
        cell.setAttribute('aria-disabled', 'true');
        row.append(cell);
        continue;
      }
      const date = dates[dateIndex];
      const day = days.get(date);
      const result = results.get(date);
      const state = dayState(day, result);
      const description = stateDescription(state);
      const button = element('button', 'calendar-day');
      button.type = 'button';
      button.id = `calendar-${date}`;
      button.dataset.date = date;
      button.dataset.calendarState = state;
      button.dataset.state = state === 'neutral' ? 'unread' : state;
      button.tabIndex = date === focusDate ? 0 : -1;
      const reason = day?.holiday || day?.reason;
      const net = day ? day.netMinutes === null ? t('Nettozeit noch nicht berechenbar') : t('{time} netto', { time: formatMinutes(day.netMinutes) }) : '';
      button.setAttribute('aria-label', [fullDate.format(new Date(`${date}T12:00:00Z`)), description.label, net, reason ? localizeText(reason) : ''].filter(Boolean).join(' · '));
      if (columnIndex > 4) button.classList.add('weekend');
      button.append(element('span', 'calendar-date', String(dateIndex + 1)));
      const marker = element('span', 'calendar-marker', description.marker);
      marker.setAttribute('aria-hidden', 'true');
      button.append(marker);
      button.addEventListener('click', () => options.onOpenDate(date));
      button.addEventListener('focus', () => {
        for (const other of buttons.values()) other.tabIndex = other === button ? 0 : -1;
        options.onFocusDate?.(date);
      });
      button.addEventListener('keydown', event => {
        let next = dateIndex;
        switch (event.key) {
          case 'ArrowLeft': next--; break;
          case 'ArrowRight': next++; break;
          case 'ArrowUp': next -= 7; break;
          case 'ArrowDown': next += 7; break;
          case 'Home': next = Math.max(0, dateIndex - columnIndex); break;
          case 'End': next = Math.min(count - 1, dateIndex + 6 - columnIndex); break;
          default: return;
        }
        event.preventDefault();
        if (next >= 0 && next < count) buttons.get(dates[next])?.focus({ preventScroll: true });
      });
      buttons.set(date, button);
      if (state !== 'neutral') legendStates.add(state);
      cell.append(button);
      row.append(cell);
    }
    grid.append(row);
  }
  container.append(grid);
  if (legendStates.size) {
    const legend = element('div', 'calendar-legend');
    for (const state of legendStates) {
      const description = stateDescription(state);
      const item = element('span', 'calendar-legend-item');
      item.dataset.calendarState = state;
      const marker = element('span', 'calendar-marker', description.marker);
      marker.setAttribute('aria-hidden', 'true');
      item.append(marker, document.createTextNode(description.label));
      legend.append(item);
    }
    container.append(legend);
  }
}
