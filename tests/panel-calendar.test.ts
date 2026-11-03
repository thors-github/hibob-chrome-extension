// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMonthCalendar } from '../src/panel/calendar';
import type { DayPlan, DayResult, RunState } from '../src/shared/types';

let host: HTMLDivElement;
const day = (date: string, action: DayPlan['action'], extra: Partial<DayPlan> = {}): DayPlan => ({ date, action, existing: [], proposed: [], netMinutes: 480, existingNetMinutes: null, fingerprint: date, eligible: action !== 'skip', ...extra });
const run = (...results: DayResult[]): RunState => ({ planId: 'test', status: 'running', results, startedAt: '', updatedAt: '' });
const button = (date: string) => document.getElementById(`calendar-${date}`) as HTMLButtonElement;
function key(date: string, value: string) { button(date).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); }

beforeEach(() => { host = document.createElement('div'); document.body.append(host); });
afterEach(() => { host.remove(); vi.unstubAllGlobals(); });

describe('compact month calendar', () => {
  it('places a Sunday-starting November in six complete Monday-first rows', () => {
    renderMonthCalendar(host, { month: '2026-11', onOpenDate: vi.fn() });
    const rows = [...host.querySelectorAll('[role="row"]')];
    expect(rows).toHaveLength(7);
    expect(host.querySelectorAll('[role="gridcell"]')).toHaveLength(42);
    expect(rows[1].querySelectorAll('.calendar-blank')).toHaveLength(6);
    expect(rows[1].lastElementChild?.textContent).toBe('1');
    expect(rows[6].firstElementChild?.textContent).toBe('30');
    expect(host.querySelectorAll('button')).toHaveLength(30);
    expect([...host.querySelectorAll('button')].filter(item => item.tabIndex === 0)).toEqual([button('2026-11-01')]);
    expect(host.querySelector('[role="columnheader"]')?.getAttribute('aria-label')).toBe('Montag');
  });

  it('keeps a fixed six-row calendar for leap February and rejects invalid months', () => {
    renderMonthCalendar(host, { month: '2028-02', onOpenDate: vi.fn() });
    expect(host.querySelectorAll('[role="gridcell"]')).toHaveLength(42);
    expect(host.querySelectorAll('button')).toHaveLength(29);
    renderMonthCalendar(host, { month: '2026-13', onOpenDate: vi.fn() });
    expect(host.childElementCount).toBe(0);
  });

  it('moves one roving tab stop by arrows and week boundaries without leaving the month', () => {
    const focus = vi.fn();
    renderMonthCalendar(host, { month: '2026-11', focusDate: '2026-11-04', onOpenDate: vi.fn(), onFocusDate: focus });
    button('2026-11-04').focus();
    key('2026-11-04', 'ArrowDown'); expect(button('2026-11-11')).toBe(document.activeElement);
    key('2026-11-11', 'Home'); expect(button('2026-11-09')).toBe(document.activeElement);
    key('2026-11-09', 'End'); expect(button('2026-11-15')).toBe(document.activeElement);
    key('2026-11-15', 'ArrowRight'); expect(button('2026-11-16')).toBe(document.activeElement);
    key('2026-11-16', 'ArrowUp'); expect(button('2026-11-09')).toBe(document.activeElement);
    button('2026-11-01').focus(); key('2026-11-01', 'ArrowLeft'); expect(button('2026-11-01')).toBe(document.activeElement);
    button('2026-11-30').focus(); key('2026-11-30', 'ArrowDown'); expect(button('2026-11-30')).toBe(document.activeElement);
    expect([...host.querySelectorAll('button')].filter(item => item.tabIndex === 0)).toEqual([button('2026-11-30')]);
    expect(focus).toHaveBeenLastCalledWith('2026-11-30');
  });

  it('opens excluded days for inspection without changing their inclusion or exposing note texts', () => {
    const open = vi.fn();
    const skipped = day('2026-11-01', 'skip', { reason: 'Wochenende', existing: [{ type: 'work', start: '08:00', end: '16:00', note: 'Private note' }] });
    const before = structuredClone(skipped);
    renderMonthCalendar(host, { month: '2026-11', days: [skipped], onOpenDate: open });
    button('2026-11-01').click();
    expect(open).toHaveBeenCalledExactlyOnceWith('2026-11-01');
    expect(button('2026-11-01').disabled).toBe(false);
    expect(button('2026-11-01').getAttribute('aria-label')).toContain('Wochenende');
    expect(host.textContent).not.toContain('Private note');
    expect(skipped).toEqual(before);
  });

  it('labels proposed, retained and verified days distinctly while keeping acknowledgements pending', () => {
    const days = [day('2026-11-02', 'create'), day('2026-11-03', 'unchanged'), day('2026-11-04', 'overwrite'), day('2026-11-05', 'blocked', { netMinutes: null })];
    renderMonthCalendar(host, { month: '2026-11', days, run: run({ date: '2026-11-02', status: 'awaiting-verification', message: '' }, { date: '2026-11-04', status: 'verified', message: '' }), onOpenDate: vi.fn() });
    expect(button('2026-11-02').dataset.calendarState).toBe('awaiting-verification');
    expect(button('2026-11-02').getAttribute('aria-label')).toContain('Prüfung ausstehend');
    expect(button('2026-11-03').getAttribute('aria-label')).toContain('Bereits passend');
    expect(button('2026-11-03').getAttribute('aria-label')).not.toContain('Gespeichert');
    expect(button('2026-11-04').getAttribute('aria-label')).toContain('Gespeichert und geprüft');
    expect(button('2026-11-05').getAttribute('aria-label')).toContain('noch nicht berechenbar');
    expect(button('2026-11-06').getAttribute('aria-label')).toContain('Noch nicht eingelesen');
    expect(button('2026-11-06').getAttribute('aria-label')).not.toContain('0 h');
  });

  it('restores the active date after rebuilding and keeps failure or uncertainty explicit', () => {
    const options = { month: '2026-11', focusDate: '2026-11-17', onOpenDate: vi.fn(), run: run({ date: '2026-11-17', status: 'uncertain', message: 'secret note' }, { date: '2026-11-18', status: 'failed', message: 'secret note' }) };
    renderMonthCalendar(host, options);
    renderMonthCalendar(host, options);
    expect(button('2026-11-17').tabIndex).toBe(0);
    expect(button('2026-11-17').getAttribute('aria-label')).toContain('Speicherstatus unklar');
    expect(button('2026-11-18').getAttribute('aria-label')).toContain('Fehlgeschlagen');
    expect(host.innerHTML).not.toContain('secret note');
  });
});
