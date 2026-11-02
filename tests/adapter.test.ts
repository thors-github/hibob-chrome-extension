// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, HiBobDomAdapter, isAttendanceLocation, localDateFromUi, snapshotFingerprint } from '../src/hibob/adapter';
import type { AttendanceEntry, DayPlan } from '../src/shared/types';

const prefix = 'time_attendance_employee_timesheet.';
const uiDate = (day: number) => `${String(day).padStart(2, '0')}/02/2026`;
const work = (start = '08:00', end = '16:00'): AttendanceEntry => ({ type: 'work', start, end });
const planned: AttendanceEntry[] = [work('08:00', '12:00'), { type: 'break', start: '12:00', end: '12:30' }, work('12:30', '16:30')];

/** A real-style split AG Grid with virtual rows and the native staged editor. */
function fixture(options: { entries?: AttendanceEntry[]; save?: 'ok' | 'timeout' | 'wrong'; absence?: string; manual?: boolean; onInput?: () => void } = {}) {
  let persisted = structuredClone(options.entries ?? []);
  let staged: AttendanceEntry[] = [];
  let saves = 0;
  let opens = 0;
  let deletes = 0;
  document.body.innerHTML = `<div role="button" aria-haspopup="true">01/02/2026–28/02/2026 (Running)</div>
    <div class="ag-root-wrapper"><div class="ag-pinned-left-cols-container"></div><div class="ag-body-viewport"><div class="ag-center-cols-container"></div></div></div>
    <sidebar id="attendance-right-panel" aria-hidden="${options.manual ? 'false' : 'true'}"></sidebar>`;
  const viewport = document.querySelector<HTMLElement>('.ag-body-viewport')!;
  const pinned = document.querySelector('.ag-pinned-left-cols-container')!;
  const center = document.querySelector('.ag-center-cols-container')!;
  const panel = document.querySelector('#attendance-right-panel')!;
  let position = 0;
  Object.defineProperties(viewport, {
    clientHeight: { value: 144 }, scrollHeight: { value: 28 * 48 },
    scrollTop: { get: () => position, set: (value: number) => { position = Math.max(0, Math.min(28 * 48 - 144, value)); } },
  });

  function renderRows() {
    const start = Math.max(1, Math.floor(position / 48) + 1);
    const indexes = Array.from({ length: Math.min(5, 29 - start) }, (_, i) => start + i);
    pinned.innerHTML = indexes.map(day => `<div class="ag-row" row-id="day-${day}" row-index="${day - 1}"><div col-id="${prefix}date">${uiDate(day)}</div></div>`).join('');
    // Reverse body DOM order: pairing by array index would associate the wrong day.
    center.innerHTML = [...indexes].reverse().map(day => {
      const entries = day === 2 ? persisted : [];
      const minutes = entries.filter(e => e.type === 'work').reduce((n, e) => n + toMinutes(e.end) - toMinutes(e.start), 0);
      return `<div class="ag-row row-clickable" row-id="day-${day}" row-index="${day - 1}">
        <div col-id="${prefix}holidayOrNonWorkingDay">${day === 2 ? '' : 'Non working day'}</div>
        <div col-id="${prefix}timeOff">${day === 2 ? options.absence ?? '<span class="empty-state-component"><span role="button">Request time off</span></span>' : ''}</div>
        <div col-id="${prefix}entryDisplay">${entries.length ? entries.map(e => `${e.start}-${e.end}`).join(', ') : '<span class="empty-state-component"><span role="button">Add entry</span></span>'}</div>
        <div col-id="${prefix}hoursWorked">${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m</div>
        <div col-id="${prefix}entryReasons"></div><div col-id="${prefix}comments"></div><div col-id="${prefix}projects"></div>
      </div>`;
    }).join('');
    for (const row of center.querySelectorAll<HTMLElement>('[row-id]')) {
      Object.defineProperty(row, 'offsetHeight', { value: 48 });
      row.querySelector(`[col-id="${prefix}hoursWorked"]`)!.addEventListener('click', () => open(Number(row.getAttribute('row-id')!.slice(4))));
    }
  }

  function editor() {
    panel.innerHTML = `<div class="sticky-header"><p class="b-display-3">Mon, 02/02/2026</p></div>
      <app-attendance-entries-panel><button data-icon-before="clock-add">Add work</button><button data-icon-before="break-add">Add break</button><div class="forms"></div></app-attendance-entries-panel>
      <button>Cancel</button><button>Save</button>`;
    const forms = panel.querySelector('.forms')!;
    staged.forEach((entry, index) => {
      const element = document.createElement('div');
      element.className = `entry-panel${!entry.start && !entry.end ? ' new-entry-border' : ''}`;
      element.innerHTML = `<div class="blv-label">${entry.type === 'work' ? 'Work' : 'Break'}</div>
        <b-timepicker data-time-format="24h"><input type="tel" class="btmpckr-input-hours"><input type="tel" class="btmpckr-input-minutes"></b-timepicker>
        <b-timepicker data-time-format="24h"><input type="tel" class="btmpckr-input-hours"><input type="tel" class="btmpckr-input-minutes"></b-timepicker>
        <details><summary>Add a reason or note</summary><div class="reason-code-list"><span class="trigger-input">${entry.reason ?? ''}</span></div><textarea></textarea></details><button data-icon-before="delete">Delete</button>`;
      forms.append(element);
      const fields = [...element.querySelectorAll('input')];
      const values = [...(entry.start ? entry.start.split(':') : ['', '']), ...(entry.end ? entry.end.split(':') : ['', ''])];
      fields.forEach((input, i) => {
        input.value = values[i];
        input.addEventListener('input', () => {
          staged[index].start = `${fields[0].value}:${fields[1].value}`;
          staged[index].end = `${fields[2].value}:${fields[3].value}`;
          options.onInput?.();
        });
      });
      element.querySelector('textarea')!.value = entry.note ?? '';
      element.querySelector('textarea')!.addEventListener('input', event => { staged[index].note = (event.target as HTMLTextAreaElement).value; });
      element.querySelector('[data-icon-before="delete"]')!.addEventListener('click', () => { if (staged[index].start || staged[index].end) deletes++; staged.splice(index, 1); editor(); });
    });
    panel.querySelector('[data-icon-before="clock-add"]')!.addEventListener('click', () => { staged.push({ type: 'work', start: '', end: '' }); appendEntry('work'); });
    panel.querySelector('[data-icon-before="break-add"]')!.addEventListener('click', () => { staged.push({ type: 'break', start: '', end: '' }); appendEntry('break'); });
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.addEventListener('click', () => panel.setAttribute('aria-hidden', 'true'));
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Save')!.addEventListener('click', () => {
      saves++;
      if (options.save === 'timeout') return;
      persisted = options.save === 'wrong' ? [work('09:00', '17:00')] : structuredClone(staged);
      panel.setAttribute('aria-hidden', 'true');
      renderRows();
    });
  }

  function appendEntry(type: 'work' | 'break') {
    // Native Angular preserves existing nodes when appending a new entry.
    const old = [...panel.querySelectorAll('.entry-panel')];
    const holders = old.map(node => ({ node, holder: node.parentElement! }));
    editor();
    const current = [...panel.querySelectorAll('.entry-panel')];
    holders.forEach(({ node }, index) => current[index].replaceWith(node));
    void type;
  }
  function open(day: number) {
    if (day !== 2) throw new Error('Nonworking days must never be opened');
    opens++;
    staged = structuredClone(persisted);
    panel.setAttribute('aria-hidden', 'false');
    panel.innerHTML = `<button id="rpp-close-btn">Close</button><div class="sticky-header"><p class="b-display-3">Mon, 02/02/2026</p></div><app-attendance-entries-panel><button>Add entry</button><div>${persisted.map(entry => `${entry.type} ${entry.start}-${entry.end}`).join('; ')}</div></app-attendance-entries-panel>`;
    panel.querySelector('#rpp-close-btn')!.addEventListener('click', () => panel.setAttribute('aria-hidden', 'true'));
    panel.querySelector('app-attendance-entries-panel button')!.addEventListener('click', () => { staged.push({ type: 'work', start: '', end: '' }); editor(); });
  }
  viewport.addEventListener('scroll', renderRows);
  renderRows();
  return { adapter: new HiBobDomAdapter({ document, location: () => 'https://app.hibob.com/attendance/my-attendance', settleMs: 1, timeoutMs: 60 }), saves: () => saves, opens: () => opens, deletes: () => deletes, entries: () => persisted, panel };
}

function toMinutes(time: string) { return +time.slice(0, 2) * 60 + +time.slice(3); }
async function planFor(app: ReturnType<typeof fixture>): Promise<DayPlan> {
  const day = (await app.adapter.scanMonth('2026-02')).days.find(d => d.date === '2026-02-02')!;
  return { date: day.date, existing: day.entries, proposed: planned, action: day.entries.length ? 'overwrite' : 'create', fingerprint: day.fingerprint, eligible: true, netMinutes: 480, existingNetMinutes: null };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('strict HiBob DOM boundary', () => {
  it.each(['https://app.hibob.com.evil.test/attendance/my-attendance', 'http://app.hibob.com/attendance/my-attendance', 'https://app.hibob.com/attendance/others', 'https://user:pass@app.hibob.com/attendance/my-attendance'])('rejects %s', url => expect(isAttendanceLocation(url)).toBe(false));
  it('accepts only the own attendance page and validates local dates', () => {
    expect(isAttendanceLocation('https://app.hibob.com/attendance/my-attendance?view=month')).toBe(true);
    expect(localDateFromUi('Mon, 02/02/2026 (Today)')).toBe('2026-02-02');
    expect(localDateFromUi('31/02/2026')).toBeNull();
  });
  it('does not touch an existing manual editor', async () => {
    const app = fixture({ manual: true });
    await expect(app.adapter.scanMonth('2026-02')).rejects.toThrow('bereits offen');
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
});

describe('month scanning and conflict snapshots', () => {
  it('joins split rows by id, scans all virtual pages, and never saves a preview', async () => {
    const app = fixture({ entries: [{ ...work(), note: 'Behalten', reason: 'Home office' }] });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days).toHaveLength(28);
    expect(snapshot.days[0].nonWorking).toBe('Non working day');
    expect(snapshot.days[1].entries[0]).toMatchObject({ start: '08:00', end: '16:00', note: 'Behalten', reason: 'Home office' });
    expect(snapshot.days[1].editable).toBe(true);
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('skips partial absences as whole days without opening an edit dialog', async () => {
    const app = fixture({ absence: 'Vacation · 2h' });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ absence: 'Vacation · 2h', editable: false, entries: [] });
    expect(app.opens()).toBe(0);
  });
  it('includes reasons and notes in the conflict fingerprint', () => {
    const base = { date: '2026-02-02', editable: true, entries: [work()] };
    expect(snapshotFingerprint(base)).not.toBe(snapshotFingerprint({ ...base, entries: [{ ...work(), note: 'Changed' }] }));
  });
  it.each(['timeOff', 'entryReasons', 'comments', 'projects'])('fails closed when the %s column is hidden', (column) => {
    const app = fixture();
    document.querySelectorAll(`[col-id="${prefix}${column}"]`).forEach(e => e.remove());
    expect(() => app.adapter.readRenderedDays()).toThrow('Spalte');
  });
});

describe('verified native edits', () => {
  it('creates two work segments and a break with one Save, then reads persisted segments', async () => {
    const app = fixture();
    const result = await app.adapter.applyDay(await planFor(app));
    expect(result.entries).toEqual(planned.map(e => ({ ...e, note: undefined, reason: undefined })));
    expect(app.saves()).toBe(1);
    expect(app.deletes()).toBe(0);
  });
  it('overwrites by reusing an existing work form and removes the previewed old note', async () => {
    const app = fixture({ entries: [{ ...work('08:00', '16:30'), note: 'Replace' }] });
    const result = await app.adapter.applyDay(await planFor(app));
    expect(result.entries.find(e => e.start === '08:00')).toMatchObject({ end: '12:00', note: undefined, reason: undefined });
    expect(app.saves()).toBe(1);
    expect(app.deletes()).toBe(0);
  });
  it('refuses an existing reason when its removal control has not been verified', async () => {
    const app = fixture({ entries: [{ ...work(), reason: 'Remote' }] });
    const plan = await planFor(app);
    await expect(app.adapter.applyDay(plan)).rejects.toThrow('nicht vollständig bearbeitbar');
    expect(app.saves()).toBe(0);
  });
  it('refuses surplus persisted segments rather than issuing individual deletes', async () => {
    const app = fixture({ entries: [work('08:00', '09:00'), work('09:00', '10:00'), work('10:00', '11:00')] });
    await expect(app.adapter.applyDay(await planFor(app))).rejects.toThrow('einzeln löschen');
    expect(app.saves()).toBe(0);
    expect(app.deletes()).toBe(0);
  });
  it('rejects stale fingerprints before modifying the draft', async () => {
    const app = fixture();
    const plan = await planFor(app);
    plan.fingerprint = 'stale';
    await expect(app.adapter.applyDay(plan)).rejects.toThrow('seit der Vorschau');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('honours cancellation while staging and discards its own unsaved draft', async () => {
    const controller = new AbortController();
    const app = fixture({ onInput: () => controller.abort() });
    await expect(app.adapter.applyDay(await planFor(app), undefined, controller.signal)).rejects.toThrow('abgebrochen');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('does not save or cancel a different day the user opened during staging', async () => {
    const app = fixture({ onInput: () => { document.querySelector('#attendance-right-panel .b-display-3')!.textContent = 'Tue, 03/02/2026'; } });
    await expect(app.adapter.applyDay(await planFor(app))).rejects.toThrow('während des Vorgangs geändert');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
  it('marks an unacknowledged Save uncertain and never retries', async () => {
    const app = fixture({ save: 'timeout' });
    await expect(app.adapter.applyDay(await planFor(app))).rejects.toMatchObject({ uncertain: true });
    expect(app.saves()).toBe(1);
  });
  it('does not report success when readback differs from the approved plan', async () => {
    const app = fixture({ save: 'wrong' });
    try { await app.adapter.applyDay(await planFor(app)); throw new Error('Expected verification failure'); }
    catch (error) { expect(error).toBeInstanceOf(AdapterError); expect((error as AdapterError).uncertain).toBe(true); }
    expect(app.saves()).toBe(1);
  });
});
