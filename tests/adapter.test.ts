// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, HiBobDomAdapter, isAttendanceLocation, localDateFromUi, snapshotFingerprint } from '../src/hibob/adapter';
import type { AdapterProgress, AttendanceContext, AttendanceEntry, DayPlan } from '../src/shared/types';

const prefix = 'time_attendance_employee_timesheet.';
const uiDate = (day: number) => `${String(day).padStart(2, '0')}/02/2026`;
const work = (start = '08:00', end = '16:00'): AttendanceEntry => ({ type: 'work', start, end });
const planned: AttendanceEntry[] = [work('08:00', '12:00'), { type: 'break', start: '12:00', end: '12:30' }, work('12:30', '16:30')];

/** A real-style split AG Grid with virtual rows and the native staged editor. */
function fixture(options: {
  entries?: AttendanceEntry[]; save?: 'ok' | 'timeout' | 'wrong'; absence?: string; manual?: boolean; onInput?: () => void;
  reported?: string; rowHeights?: number[]; monthDelayMs?: number; neverLoad?: boolean; unverifiedContext?: boolean;
  timing?: { settleMs?: number; timeoutMs?: number; pollMs?: number; stabilityMs?: number; readinessTimeoutMs?: number; rowSeekTimeoutMs?: number };
} = {}) {
  const identity: AttendanceContext = { documentId: crypto.randomUUID(), employeeKey: 'fixture-profile-A', tenantKey: 'fixture-tenant-A', verified: !options.unverifiedContext };
  let gridMonth = options.monthDelayMs !== undefined || options.neverLoad ? '01' : '02';
  const heights = options.rowHeights ?? Array.from({ length: 28 }, () => 48);
  const offsets = heights.map((_, index) => heights.slice(0, index).reduce((sum, height) => sum + height, 0));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  let persisted = structuredClone(options.entries ?? []);
  let staged: AttendanceEntry[] = [];
  let saves = 0;
  let opens = 0;
  let deletes = 0;
  document.body.innerHTML = `<div role="button" aria-haspopup="true">01/02/2026–28/02/2026 (Running)</div>
    <div class="ag-root-wrapper"><div class="ag-pinned-left-cols-container"></div><div class="ag-body-viewport"><div class="ag-center-cols-container"></div></div></div>
    <sidebar id="attendance-right-panel" aria-hidden="${options.manual ? 'false' : 'true'}"></sidebar>`;
  let viewport = document.querySelector<HTMLElement>('.ag-body-viewport')!;
  const pinned = document.querySelector('.ag-pinned-left-cols-container')!;
  let center = document.querySelector('.ag-center-cols-container')!;
  const panel = document.querySelector('#attendance-right-panel')!;
  let position = 0;
  const viewportBounds = () => ({ top: 0, bottom: 144, height: 144, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON() {} });
  function installViewport(target: HTMLElement) {
    Object.defineProperties(target, {
    clientHeight: { value: 144, configurable: true }, scrollHeight: { value: totalHeight },
    scrollTop: { get: () => position, set: (value: number) => { position = Math.max(0, Math.min(totalHeight - 144, value)); } },
    });
    target.getBoundingClientRect = viewportBounds;
    target.addEventListener('scroll', renderRows);
  }
  installViewport(viewport);

  function renderRows() {
    const indexes = Array.from({ length: 28 }, (_, index) => index + 1).filter(day => offsets[day - 1] < position + 240 && offsets[day - 1] + heights[day - 1] > position);
    pinned.innerHTML = indexes.map(day => `<div class="ag-row" row-id="day-${day}" row-index="${day - 1}"><div col-id="${prefix}date">${uiDate(day).replace('/02/', `/${gridMonth}/`)}</div></div>`).join('');
    // Reverse body DOM order: pairing by array index would associate the wrong day.
    center.innerHTML = [...indexes].reverse().map(day => {
      const entries = day === 2 ? persisted : [];
      const minutes = entries.filter(e => e.type === 'work').reduce((n, e) => n + toMinutes(e.end) - toMinutes(e.start), 0);
      return `<div class="ag-row row-clickable" row-id="day-${day}" row-index="${day - 1}">
        <div col-id="${prefix}holidayOrNonWorkingDay">${day === 2 ? '' : 'Non working day'}</div>
        <div col-id="${prefix}timeOff">${day === 2 ? options.absence ?? '<span class="empty-state-component"><span role="button">Request time off</span></span>' : ''}</div>
        <div col-id="${prefix}entryDisplay">${entries.length ? entries.map(e => `${e.start}-${e.end}`).join(', ') : '<span class="empty-state-component"><span role="button">Add entry</span></span>'}</div>
        <div col-id="${prefix}hoursWorked">${options.reported && day === 2 ? options.reported : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`}</div>
        <div col-id="${prefix}entryReasons"></div><div col-id="${prefix}comments"></div><div col-id="${prefix}projects"></div>
      </div>`;
    }).join('');
    for (const row of center.querySelectorAll<HTMLElement>('[row-id]')) {
      const day = Number(row.getAttribute('row-id')!.slice(4));
      Object.defineProperty(row, 'offsetHeight', { value: heights[day - 1] });
      row.getBoundingClientRect = () => ({ top: offsets[day - 1] - position, bottom: offsets[day - 1] - position + heights[day - 1], height: heights[day - 1], left: 0, right: 200, width: 200, x: 0, y: offsets[day - 1] - position, toJSON() {} });
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
  function replaceViewport() {
    const next = document.createElement('div');
    next.className = 'ag-body-viewport';
    next.innerHTML = '<div class="ag-center-cols-container"></div>';
    viewport.replaceWith(next);
    viewport = next;
    center = next.querySelector('.ag-center-cols-container')!;
    installViewport(next);
    renderRows();
  }
  const period = document.querySelector<HTMLElement>('[role="button"][aria-haspopup="true"]')!;
  if (gridMonth === '01') {
    period.textContent = '01/01/2026–31/01/2026 (Past)';
    period.addEventListener('click', () => {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = '01/02/2026–28/02/2026 (Running)';
      option.addEventListener('click', () => {
        period.textContent = option.textContent;
        option.remove();
        if (!options.neverLoad) setTimeout(() => { gridMonth = '02'; renderRows(); }, options.monthDelayMs);
      });
      document.body.append(option);
    });
  }
  renderRows();
  return { replaceViewport, get viewport() { return viewport; }, identity, reviewedContext: undefined as AttendanceContext | undefined, adapter: new HiBobDomAdapter({ document, location: () => 'https://app.hibob.com/attendance/my-attendance', settleMs: 1, timeoutMs: 60, pollMs: 1, stabilityMs: 1, readinessTimeoutMs: 3000, rowSeekTimeoutMs: 1000, documentId: identity.documentId, readContext: () => identity, ...options.timing }), saves: () => saves, opens: () => opens, deletes: () => deletes, entries: () => persisted, panel };
}

function toMinutes(time: string) { return +time.slice(0, 2) * 60 + +time.slice(3); }
async function planFor(app: ReturnType<typeof fixture>): Promise<DayPlan> {
  const snapshot = await app.adapter.scanMonth('2026-02');
  app.reviewedContext = snapshot.context;
  const day = snapshot.days.find(d => d.date === '2026-02-02')!;
  return { date: day.date, existing: day.entries, proposed: planned, action: day.entries.length ? 'overwrite' : 'create', fingerprint: day.fingerprint, eligible: true, netMinutes: 480, existingNetMinutes: null };
}

function applyPlan(app: ReturnType<typeof fixture>, day: DayPlan, progress?: (value: AdapterProgress) => void, signal?: AbortSignal) {
  return app.adapter.applyDay(day, progress, signal, app.reviewedContext);
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
    const result = await applyPlan(app, await planFor(app));
    expect(result.entries).toEqual(planned.map(e => ({ ...e, note: undefined, reason: undefined })));
    expect(app.saves()).toBe(1);
    expect(app.deletes()).toBe(0);
  });
  it('overwrites by reusing an existing work form and removes the previewed old note', async () => {
    const app = fixture({ entries: [{ ...work('08:00', '16:30'), note: 'Replace' }] });
    const result = await applyPlan(app, await planFor(app));
    expect(result.entries.find(e => e.start === '08:00')).toMatchObject({ end: '12:00', note: undefined, reason: undefined });
    expect(app.saves()).toBe(1);
    expect(app.deletes()).toBe(0);
  });
  it('refuses an existing reason when its removal control has not been verified', async () => {
    const app = fixture({ entries: [{ ...work(), reason: 'Remote' }] });
    const plan = await planFor(app);
    await expect(applyPlan(app, plan)).rejects.toThrow('nicht vollständig bearbeitbar');
    expect(app.saves()).toBe(0);
  });
  it('refuses surplus persisted segments rather than issuing individual deletes', async () => {
    const app = fixture({ entries: [work('08:00', '09:00'), work('09:00', '10:00'), work('10:00', '11:00')] });
    await expect(applyPlan(app, await planFor(app))).rejects.toThrow('einzeln löschen');
    expect(app.saves()).toBe(0);
    expect(app.deletes()).toBe(0);
  });
  it('rejects stale fingerprints before modifying the draft', async () => {
    const app = fixture();
    const plan = await planFor(app);
    plan.fingerprint = 'stale';
    await expect(applyPlan(app, plan)).rejects.toThrow('seit der Vorschau');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('honours cancellation while staging and discards its own unsaved draft', async () => {
    const controller = new AbortController();
    const app = fixture({ onInput: () => controller.abort() });
    await expect(applyPlan(app, await planFor(app), undefined, controller.signal)).rejects.toThrow('abgebrochen');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('does not save or cancel a different day the user opened during staging', async () => {
    const app = fixture({ onInput: () => { document.querySelector('#attendance-right-panel .b-display-3')!.textContent = 'Tue, 03/02/2026'; } });
    await expect(applyPlan(app, await planFor(app))).rejects.toThrow('während des Vorgangs geändert');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
  it('marks an unacknowledged Save uncertain and never retries', async () => {
    const app = fixture({ save: 'timeout' });
    await expect(applyPlan(app, await planFor(app))).rejects.toMatchObject({ uncertain: true });
    expect(app.saves()).toBe(1);
  });
  it('does not report success when readback differs from the approved plan', async () => {
    const app = fixture({ save: 'wrong' });
    try { await applyPlan(app, await planFor(app)); throw new Error('Expected verification failure'); }
    catch (error) { expect(error).toBeInstanceOf(AdapterError); expect((error as AdapterError).uncertain).toBe(true); }
    expect(app.saves()).toBe(1);
  });
});

describe('reported-hour consistency before mutation', () => {
  it('blocks a partial entry read that disagrees with reported hours', async () => {
    const app = fixture({ entries: [work('08:00', '12:00')], reported: '8h 00m' });
    const plan = await planFor(app);
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ reportedMinutes: 480, unsupportedReason: expect.stringContaining('stimmen nicht') });
    await expect(applyPlan(app, plan)).rejects.toThrow('nicht vollständig bearbeitbar');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([work('08:00', '12:00')]);
  });

  it.each(['08:00', '0h 60m', 'unknown'])('rejects unreadable reported hours %s before Save', async reported => {
    const app = fixture({ reported });
    const plan = await planFor(app);
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ reportedMinutes: null, unsupportedReason: expect.stringContaining('nicht lesbar') });
    await expect(applyPlan(app, plan)).rejects.toThrow('nicht vollständig bearbeitbar');
    expect(app.saves()).toBe(0);
  });

  it('includes reported minutes in the reviewed day fingerprint', () => {
    const base = { date: '2026-02-02', editable: true, entries: [work()], reportedMinutes: 480 };
    expect(snapshotFingerprint(base)).not.toBe(snapshotFingerprint({ ...base, reportedMinutes: 479 }));
  });
});

describe('month readiness and measured virtual row reveal', () => {
  it('waits for an asynchronously mounted month with production readiness defaults', async () => {
    const app = fixture({ monthDelayMs: 400, timing: { settleMs: 150, timeoutMs: 8000, pollMs: 100, stabilityMs: 300, readinessTimeoutMs: 30000, rowSeekTimeoutMs: 10000 } });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days).toHaveLength(28);
    expect(snapshot.days.every(day => day.date.startsWith('2026-02-'))).toBe(true);
    expect(app.saves()).toBe(0);
  }, 15000);

  it('requires a stable interval between complete traversals', async () => {
    const app = fixture({ timing: { stabilityMs: 300 } });
    const start = Date.now();
    await app.adapter.scanMonth('2026-02');
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });

  it('waits through a detached grid rather than treating it as missing configuration', async () => {
    const app = fixture();
    const root = document.querySelector('.ag-root-wrapper')!;
    root.remove();
    setTimeout(() => document.body.insertBefore(root, app.panel), 30);
    expect((await app.adapter.scanMonth('2026-02')).days).toHaveLength(28);
  });

  it('restarts if the grid viewport is replaced during traversal', async () => {
    const app = fixture();
    setTimeout(() => app.replaceViewport(), 5);
    expect((await app.adapter.scanMonth('2026-02')).days).toHaveLength(28);
    expect(app.saves()).toBe(0);
  });

  it('waits through briefly overlapping old and new grids', async () => {
    const app = fixture();
    const copy = document.querySelector('.ag-root-wrapper')!.cloneNode(true) as Element;
    document.body.append(copy);
    setTimeout(() => copy.remove(), 30);
    expect((await app.adapter.scanMonth('2026-02')).days).toHaveLength(28);
  });

  it('fails with a loading-specific message when the requested month never arrives', async () => {
    const app = fixture({ neverLoad: true, timing: { readinessTimeoutMs: 80 } });
    await expect(app.adapter.scanMonth('2026-02')).rejects.toThrow('nicht vollständig und stabil geladen');
    expect(app.opens()).toBe(0);
    expect(app.saves()).toBe(0);
  });

  it('honours cancellation while waiting for the requested month', async () => {
    const app = fixture({ neverLoad: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 10);
    await expect(app.adapter.scanMonth('2026-02', undefined, abort.signal)).rejects.toThrow('abgebrochen');
    expect(app.saves()).toBe(0);
  });

  it('reveals variable-height rows and restores the original scroll after scanning', async () => {
    const app = fixture({ rowHeights: [500, ...Array.from({ length: 27 }, () => 48)] });
    app.viewport.scrollTop = 96;
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days).toHaveLength(28);
    expect(snapshot.days[1].editable).toBe(true);
    expect(app.viewport.scrollTop).toBe(96);
    expect(app.saves()).toBe(0);
  });
});

describe('interactive absence values and unknown markers', () => {
  it.each([
    '<button>Vacation · 2h</button>',
    '<span role="button">Vacation · 2h</span>',
    '<a href="#absence">Vacation · 2h</a>',
    '<span class="chip"><svg aria-hidden="true"></svg>Vacation · 2h</span>',
    '<button aria-label="Vacation · 2h"><svg aria-hidden="true"></svg></button>',
  ])('preserves a meaningful absence label %s', async absence => {
    const app = fixture({ absence });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ absence: 'Vacation · 2h', editable: false });
    expect(app.opens()).toBe(0);
    expect(app.saves()).toBe(0);
  });

  it('removes only the identified empty request action', async () => {
    const app = fixture({ absence: '<button>Request time off</button>' });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ absence: undefined, unsupportedReason: undefined, editable: true });
  });

  it('does not interpret a hidden absence value as displayed data', async () => {
    const app = fixture({ absence: '<span hidden>Vacation · 2h</span><button>Request time off</button>' });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1].absence).toBeUndefined();
    expect(snapshot.days[1].editable).toBe(true);
  });

  it('blocks an unexplained icon marker without opening or saving that day', async () => {
    const app = fixture({ absence: '<button><svg></svg></button>' });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ absence: undefined, editable: false, unsupportedReason: expect.stringContaining('nicht eindeutig lesbar') });
    expect(app.opens()).toBe(0);
    expect(app.saves()).toBe(0);
  });
});

describe('reviewed account and document binding', () => {
  it('keeps unknown native identity read-only', async () => {
    const app = fixture({ unverifiedContext: true });
    const plan = await planFor(app);
    expect(app.reviewedContext).toMatchObject({ verified: false, reason: expect.stringContaining('schreibgeschützt') });
    await expect(applyPlan(app, plan)).rejects.toThrow('keinem verifizierten HiBob-Konto');
    expect(app.saves()).toBe(0);
  });

  it('rejects a write command without its reviewed context', async () => {
    const app = fixture();
    const plan = await planFor(app);
    await expect(app.adapter.applyDay(plan)).rejects.toThrow('keinem verifizierten HiBob-Konto');
    expect(app.saves()).toBe(0);
  });

  it.each(['employeeKey', 'tenantKey'] as const)('rejects a changed %s before staging', async field => {
    const app = fixture();
    const plan = await planFor(app);
    app.identity[field] = 'different-context';
    await expect(applyPlan(app, plan)).rejects.toThrow('seit der Vorschau geändert');
    expect(app.saves()).toBe(0);
  });

  it('rejects the same employee and tenant in a replacement browser document', async () => {
    const old = fixture();
    const plan = await planFor(old);
    const replacement = fixture();
    await expect(replacement.adapter.applyDay(plan, undefined, undefined, old.reviewedContext)).rejects.toThrow('Browserdokument');
    expect(replacement.opens()).toBe(0);
    expect(replacement.saves()).toBe(0);
  });

  it('checks account context again immediately before Save', async () => {
    let app: ReturnType<typeof fixture>;
    app = fixture({ onInput: () => { app.identity.employeeKey = 'other-employee'; } });
    const plan = await planFor(app);
    await expect(applyPlan(app, plan)).rejects.toThrow('seit der Vorschau geändert');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });

  it('invalidates a scan if the account changes while reading', async () => {
    const app = fixture();
    await expect(app.adapter.scanMonth('2026-02', progress => {
      if (progress.total === 0) app.identity.employeeKey = 'other-employee';
    })).rejects.toThrow('während des Einlesens geändert');
    expect(app.saves()).toBe(0);
  });
});

describe('visually rendered decorative marker boundaries', () => {
  it.each([
    '<svg aria-hidden="true"></svg>',
    '<span aria-hidden="true" data-icon-before="calendar"></span>',
    '<b-icon aria-hidden="true"></b-icon>',
    '<span aria-hidden="true">\uF123</span>',
  ])('blocks a visible icon-only time-off cell %s', async absence => {
    const app = fixture({ absence });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ absence: undefined, editable: false, unsupportedReason: expect.stringContaining('nicht eindeutig lesbar') });
    expect(app.opens()).toBe(0);
    expect(app.saves()).toBe(0);
  });

  it.each([
    '<svg style="display:none"></svg>',
    '<span hidden data-icon-before="calendar"></span>',
    '<span style="visibility:hidden"><b-icon></b-icon></span>',
  ])('ignores a genuinely hidden time-off marker %s', async absence => {
    const app = fixture({ absence });
    const snapshot = await app.adapter.scanMonth('2026-02');
    expect(snapshot.days[1]).toMatchObject({ absence: undefined, unsupportedReason: undefined, editable: true });
  });
});

describe('final readiness and cleanup boundaries', () => {
  it('waits for a busy grid root even if the old rows already look complete', async () => {
    const app = fixture();
    const root = document.querySelector('.ag-root-wrapper')!;
    root.setAttribute('aria-busy', 'true');
    const start = Date.now();
    setTimeout(() => root.removeAttribute('aria-busy'), 60);
    expect((await app.adapter.scanMonth('2026-02')).days).toHaveLength(28);
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
    expect(app.saves()).toBe(0);
  });

  it('waits for viewport layout during initial mount', async () => {
    const app = fixture();
    Object.defineProperty(app.viewport, 'clientHeight', { value: 0, configurable: true });
    setTimeout(() => Object.defineProperty(app.viewport, 'clientHeight', { value: 144, configurable: true }), 30);
    expect((await app.adapter.scanMonth('2026-02')).days).toHaveLength(28);
  });

  it('leaves a changed account context untouched by scroll restoration', async () => {
    const app = fixture();
    app.viewport.scrollTop = 96;
    await expect(app.adapter.scanMonth('2026-02', progress => {
      if (progress.date === '2026-02-28') app.identity.employeeKey = 'other-employee';
    })).rejects.toThrow('während des Einlesens geändert');
    expect(app.viewport.scrollTop).not.toBe(96);
    expect(app.saves()).toBe(0);
  });

  it('keeps the real default identity reader unverified without invented selectors', async () => {
    const app = fixture();
    document.body.insertAdjacentHTML('afterbegin', '<header data-employee-id="not-trusted">Example employee<img alt="Account avatar" src="https://media.example.test/avatar.png?token=must-not-persist"></header>');
    const native = new HiBobDomAdapter({ document, location: () => 'https://app.hibob.com/attendance/my-attendance', documentId: 'native-document', settleMs: 1, pollMs: 1, stabilityMs: 1 });
    const snapshot = await native.scanMonth('2026-02');
    expect(snapshot.context).toMatchObject({ documentId: 'native-document', verified: false });
    expect(JSON.stringify(snapshot.context)).not.toContain('must-not-persist');
    const day = snapshot.days[1];
    const proposed: DayPlan = { date: day.date, existing: day.entries, proposed: planned, action: 'create', fingerprint: day.fingerprint, eligible: true, netMinutes: 480, existingNetMinutes: 0 };
    await expect(native.applyDay(proposed, undefined, undefined, snapshot.context)).rejects.toThrow('keinem verifizierten HiBob-Konto');
    expect(app.saves()).toBe(0);
  });
});
