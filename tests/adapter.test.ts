// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, HiBobDomAdapter, isAttendanceLocation, localDateFromUi, snapshotFingerprint } from '../src/hibob/adapter';
import { makeUiContextReader, type AttendanceContextEvidence } from '../src/hibob/context-reader';
import { contextFingerprint } from '../src/shared/context';
import type { AdapterProgress, ApplyAuthorization, AttendanceContext, AttendanceEntry, DayPlan } from '../src/shared/types';
import { attendanceUrl, avatarB, installUiContextFixture, markerUrl } from './fixtures/ui-context';

const prefix = 'time_attendance_employee_timesheet.';
const uiDate = (day: number) => `${String(day).padStart(2, '0')}/02/2026`;
const work = (start = '08:00', end = '16:00'): AttendanceEntry => ({ type: 'work', start, end });
const planned: AttendanceEntry[] = [work('08:00', '12:00'), { type: 'break', start: '12:00', end: '12:30' }, work('12:30', '16:30')];

/** A real-style split AG Grid with virtual rows and the native staged editor. */
function fixture(options: {
  entries?: AttendanceEntry[]; save?: 'ok' | 'timeout' | 'wrong'; absence?: string; manual?: boolean; onInput?: () => void;
  reported?: string; rowHeights?: number[]; monthDelayMs?: number; neverLoad?: boolean; unverifiedContext?: boolean; contextMode?: 'stable-identity' | 'user-confirmed-ui';
  contextReader?: () => AttendanceContext | AttendanceContextEvidence | Promise<AttendanceContext | AttendanceContextEvidence>;
  rerenderOnEvent?: boolean; reverseTimeControls?: boolean; reorderCards?: boolean; normalizeHours?: boolean;
  initialPrefill?: AttendanceEntry; addedPrefill?: AttendanceEntry; addDelayMs?: number; transientUnmountMs?: number;
  addBehavior?: 'none' | 'multiple' | 'wrong-kind' | 'change-existing' | 'duplicate' | 'extras';
  onEditorEvent?: (name: string) => void; onAdd?: () => void; onNoteInput?: () => void; focusFailure?: boolean; cancelBehavior?: 'ok' | 'timeout' | 'changes-persisted';
  timing?: { settleMs?: number; timeoutMs?: number; pollMs?: number; stabilityMs?: number; readinessTimeoutMs?: number; rowSeekTimeoutMs?: number };
} = {}) {
  const identity: Extract<AttendanceContext, { mode: 'stable-identity' }> = { mode: 'stable-identity', documentId: crypto.randomUUID(), employeeKey: 'fixture-profile-A', tenantKey: 'fixture-tenant-A' };
  const readContext = options.contextReader ?? ((): AttendanceContext => options.unverifiedContext ? { mode: 'unavailable', documentId: identity.documentId, reason: 'Fixture context unavailable' } : options.contextMode === 'user-confirmed-ui' ? { mode: 'user-confirmed-ui', documentId: identity.documentId, pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: `${identity.employeeKey}/${identity.tenantKey}` } : identity);
  let gridMonth = options.monthDelayMs !== undefined || options.neverLoad ? '01' : '02';
  const heights = options.rowHeights ?? Array.from({ length: 28 }, () => 48);
  const offsets = heights.map((_, index) => heights.slice(0, index).reduce((sum, height) => sum + height, 0));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  let persisted = structuredClone(options.entries ?? []);
  let staged: AttendanceEntry[] = [];
  let saves = 0;
  let opens = 0;
  let deletes = 0;
  let additions = 0;
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
    const indexes = staged.map((_, index) => index);
    if (options.reorderCards) indexes.reverse();
    indexes.forEach(index => {
      const entry = staged[index];
      const element = document.createElement('div');
      element.className = `entry-panel${!entry.start && !entry.end ? ' new-entry-border' : ''}`;
      const endpoints = options.reverseTimeControls ? ['end', 'start'] : ['start', 'end'];
      element.innerHTML = `<div class="blv-label">${entry.type === 'work' ? 'Work' : 'Break'}</div>` + endpoints.map(endpoint => {
        const parts = options.reverseTimeControls ? ['minutes', 'hours'] : ['hours', 'minutes'];
        return `<div data-endpoint="${endpoint}"><label>${endpoint === 'start' ? 'Clock in:' : 'Clock out:'}</label><b-timepicker data-time-format="24h">${parts.map(part => `<input type="tel" class="btmpckr-input-${part}">`).join('')}</b-timepicker></div>`;
      }).join('') + `<details><summary>Add a reason or note</summary><div class="reason-code-list"><span class="trigger-input">${entry.reason ?? ''}</span></div><textarea></textarea></details>${(entry.metadata ?? []).map(value => `<span class="project-name">${value}</span>`).join('')}<button data-icon-before="delete">Delete</button>`;
      forms.append(element);
      const fields = ['start', 'end'].flatMap(endpoint => ['hours', 'minutes'].map(part => element.querySelector<HTMLInputElement>(`[data-endpoint="${endpoint}"] .btmpckr-input-${part}`)!));
      const values = [...(entry.start ? entry.start.split(':') : ['', '']), ...(entry.end ? entry.end.split(':') : ['', ''])];
      const rerender = () => {
        if (options.rerenderOnEvent === false) return;
        if (options.transientUnmountMs) { forms.innerHTML = ''; setTimeout(editor, options.transientUnmountMs); } else editor();
      };
      fields.forEach((input, i) => {
        input.value = options.normalizeHours && i % 2 === 0 && values[i] ? String(+values[i]) : values[i];
        if (options.focusFailure) input.focus = () => {};
        input.addEventListener('focusin', () => options.onEditorEvent?.('focus'));
        // Native HiBob stores the component values on host focusout only.
        input.addEventListener('focusout', () => {
          // Destroyed Angular components unsubscribe their native listeners.
          if (!input.isConnected) return;
          const model = [...(staged[index].start ? staged[index].start.split(':') : ['', '']), ...(staged[index].end ? staged[index].end.split(':') : ['', ''])];
          model[i] = input.value ? String(+input.value).padStart(2, '0') : '';
          staged[index].start = model[0] || model[1] ? `${model[0]}:${model[1]}` : '';
          staged[index].end = model[2] || model[3] ? `${model[2]}:${model[3]}` : '';
          rerender();
          options.onEditorEvent?.('focusout');
        });
        input.addEventListener('input', () => {
          if (!input.isConnected) return;
          // The real component advances from a two-digit hour to minutes, and
          // blurs two-digit minutes. Synthetic blur/change do not commit state.
          if (input.value.length > 1) { if (i % 2 === 0) fields[i + 1].focus(); else input.blur(); }
          options.onInput?.();
          options.onEditorEvent?.('input');
        });
      });
      const note = element.querySelector('textarea')!;
      note.value = entry.note ?? '';
      note.addEventListener('input', () => {
        staged[index].note = note.value;
        rerender();
        options.onNoteInput?.();
        options.onEditorEvent?.('note-input');
      });
      element.querySelector('[data-icon-before="delete"]')!.addEventListener('click', () => { if (staged[index].start || staged[index].end) deletes++; staged.splice(index, 1); editor(); options.onEditorEvent?.('delete'); });
    });
    panel.querySelector('[data-icon-before="clock-add"]')!.addEventListener('click', () => appendEntry('work'));
    panel.querySelector('[data-icon-before="break-add"]')!.addEventListener('click', () => appendEntry('break'));
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.addEventListener('click', () => {
      if (options.cancelBehavior === 'timeout') return;
      if (options.cancelBehavior === 'changes-persisted') { persisted = [work('09:00', '17:00')]; renderRows(); }
      panel.setAttribute('aria-hidden', 'true');
    });
    [...panel.querySelectorAll('button')].find(b => b.textContent === 'Save')!.addEventListener('click', () => {
      saves++;
      if (options.save === 'timeout') return;
      persisted = options.save === 'wrong' ? [work('09:00', '17:00')] : structuredClone(staged).map(entry => ({ ...entry, start: entry.start.split(':').map(value => value.padStart(2, '0')).join(':'), end: entry.end.split(':').map(value => value.padStart(2, '0')).join(':') }));
      panel.setAttribute('aria-hidden', 'true');
      renderRows();
    });
  }

  function appendEntry(type: 'work' | 'break') {
    additions++;
    options.onAdd?.();
    if (options.addBehavior === 'none') return;
    const append = () => {
      if (panel.getAttribute('aria-hidden') === 'true') return;
      let added = options.addedPrefill ? { ...options.addedPrefill, type } : { type, start: '', end: '' };
      if (options.addBehavior === 'wrong-kind') added.type = type === 'work' ? 'break' : 'work';
      if (options.addBehavior === 'duplicate') added = structuredClone(staged[0]);
      if (options.addBehavior === 'extras') added = { ...added, note: 'Unexpected native note' } as AttendanceEntry;
      staged.push(added);
      if (options.addBehavior === 'multiple') staged.push({ type, start: '', end: '' });
      if (options.addBehavior === 'change-existing') staged[0].note = 'Unexpected old-card mutation';
      // Angular may recreate every existing card and its input descendants.
      editor();
    };
    if (options.addDelayMs) {
      if (options.transientUnmountMs) panel.querySelector('.forms')!.innerHTML = '';
      setTimeout(append, options.addDelayMs);
    } else append();
  }
  function open(day: number) {
    if (day !== 2) throw new Error('Nonworking days must never be opened');
    opens++;
    staged = structuredClone(persisted);
    panel.setAttribute('aria-hidden', 'false');
    panel.innerHTML = `<button id="rpp-close-btn">Close</button><div class="sticky-header"><p class="b-display-3">Mon, 02/02/2026</p></div><app-attendance-entries-panel><button>Add entry</button><div>${persisted.map(entry => `${entry.type} ${entry.start}-${entry.end}`).join('; ')}</div></app-attendance-entries-panel>`;
    panel.querySelector('#rpp-close-btn')!.addEventListener('click', () => panel.setAttribute('aria-hidden', 'true'));
    panel.querySelector('app-attendance-entries-panel button')!.addEventListener('click', () => { staged.push(structuredClone((!persisted.length && options.initialPrefill) || { type: 'work', start: '', end: '' })); editor(); });
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
  return { replaceViewport, get viewport() { return viewport; }, identity, reviewedContext: undefined as AttendanceContext | undefined, reviewedAuthorization: undefined as ApplyAuthorization | undefined, adapter: new HiBobDomAdapter({ document, location: () => 'https://app.hibob.com/attendance/my-attendance', settleMs: 1, timeoutMs: 60, pollMs: 1, stabilityMs: 1, readinessTimeoutMs: 3000, rowSeekTimeoutMs: 1000, documentId: identity.documentId, readContext, ...options.timing }), saves: () => saves, opens: () => opens, deletes: () => deletes, additions: () => additions, entries: () => persisted, staged: () => structuredClone(staged), panel };
}

function toMinutes(time: string) { return +time.slice(0, 2) * 60 + +time.slice(3); }
async function planFor(app: ReturnType<typeof fixture>): Promise<DayPlan> {
  const snapshot = await app.adapter.scanMonth('2026-02');
  app.reviewedContext = snapshot.context;
  app.reviewedAuthorization = { planId: 'fixture-plan', planRevision: 1, contextFingerprint: contextFingerprint(snapshot.context) };
  const day = snapshot.days.find(d => d.date === '2026-02-02')!;
  return { date: day.date, existing: day.entries, proposed: planned, action: day.entries.length ? 'overwrite' : 'create', fingerprint: day.fingerprint, eligible: true, netMinutes: 480, existingNetMinutes: null };
}

function applyPlan(app: ReturnType<typeof fixture>, day: DayPlan, progress?: (value: AdapterProgress) => void, signal?: AbortSignal) {
  return app.adapter.applyDay(day, progress, signal, app.reviewedContext, app.reviewedAuthorization);
}

function confirmPlan(app: ReturnType<typeof fixture>) {
  const authorization = app.reviewedAuthorization!;
  authorization.confirmation = { planId: authorization.planId, planRevision: authorization.planRevision, contextFingerprint: authorization.contextFingerprint, confirmed: true };
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
    // Virtual page stability is governed by the fixture clock, not shared CI CPU
    // availability. Preserve the adapter's readiness budget and every assertion.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const app = fixture({ entries: [{ ...work(), note: 'Behalten', reason: 'Home office' }] });
      const [snapshot] = await Promise.all([app.adapter.scanMonth('2026-02'), vi.runAllTimersAsync()]);
      expect(snapshot.days).toHaveLength(28);
      expect(snapshot.days[0].nonWorking).toBe('Non working day');
      expect(snapshot.days[1].entries[0]).toMatchObject({ start: '08:00', end: '16:00', note: 'Behalten', reason: 'Home office' });
      expect(snapshot.days[1].editable).toBe(true);
      expect(app.saves()).toBe(0);
      expect(app.panel.getAttribute('aria-hidden')).toBe('true');
    } finally { vi.useRealTimers(); }
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
    expect(app.reviewedContext).toMatchObject({ mode: 'unavailable', reason: 'Fixture context unavailable' });
    await expect(applyPlan(app, plan)).rejects.toThrow('nicht zuverlässig lesbar');
    expect(app.saves()).toBe(0);
  });

  it('rejects a write command without its reviewed context', async () => {
    const app = fixture();
    const plan = await planFor(app);
    await expect(app.adapter.applyDay(plan)).rejects.toThrow('nicht zuverlässig lesbar');
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
    await expect(replacement.adapter.applyDay(plan, undefined, undefined, old.reviewedContext, old.reviewedAuthorization)).rejects.toThrow('Browserdokument');
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
    expect(snapshot.context).toMatchObject({ documentId: 'native-document', mode: 'unavailable' });
    expect(JSON.stringify(snapshot.context)).not.toContain('must-not-persist');
    const day = snapshot.days[1];
    const proposed: DayPlan = { date: day.date, existing: day.entries, proposed: planned, action: 'create', fingerprint: day.fingerprint, eligible: true, netMinutes: 480, existingNetMinutes: 0 };
    await expect(native.applyDay(proposed, undefined, undefined, snapshot.context)).rejects.toThrow('nicht zuverlässig lesbar');
    expect(app.saves()).toBe(0);
  });
});

describe('explicit approval of one visible UI context', () => {
  it('requires explicit confirmation before staging a manual UI plan', async () => {
    const app = fixture({ contextMode: 'user-confirmed-ui' });
    const plan = await planFor(app);
    const opened = app.opens();
    await expect(applyPlan(app, plan)).rejects.toThrow('ausdrücklich bestätigen');
    expect(app.opens()).toBe(opened);
    expect(app.saves()).toBe(0);
  });

  it('saves and independently verifies the explicitly confirmed UI plan', async () => {
    const app = fixture({ contextMode: 'user-confirmed-ui' });
    const plan = await planFor(app);
    confirmPlan(app);
    expect((await applyPlan(app, plan)).reportedMinutes).toBe(480);
    expect(app.saves()).toBe(1);
  });

  it.each(['planId', 'planRevision', 'contextFingerprint'] as const)('rejects an approval with stale %s', async field => {
    const app = fixture({ contextMode: 'user-confirmed-ui' });
    const plan = await planFor(app);
    confirmPlan(app);
    if (field === 'planRevision') app.reviewedAuthorization!.confirmation!.planRevision++;
    else app.reviewedAuthorization!.confirmation![field] += '-stale';
    await expect(applyPlan(app, plan)).rejects.toThrow('ausdrücklich bestätigen');
    expect(app.saves()).toBe(0);
  });

  it('rejects a confirmed context after its visible marker changes', async () => {
    const app = fixture({ contextMode: 'user-confirmed-ui' });
    const plan = await planFor(app);
    confirmPlan(app);
    app.identity.employeeKey = 'different-marker';
    await expect(applyPlan(app, plan)).rejects.toThrow('seit der Vorschau geändert');
    expect(app.saves()).toBe(0);
  });

  it('connects the actual production marker reader to the approved local form flow', async () => {
    const app = fixture({ contextReader: makeUiContextReader(document, () => attendanceUrl) });
    installUiContextFixture(document);
    const plan = await planFor(app);
    expect(app.reviewedContext?.mode).toBe('user-confirmed-ui');
    expect(app.reviewedContext).not.toHaveProperty('employeeKey');
    confirmPlan(app);
    await applyPlan(app, plan);
    expect(app.saves()).toBe(1);
  });

  it('rechecks real visible image resources immediately before Save', async () => {
    let ui: ReturnType<typeof installUiContextFixture>;
    const app = fixture({ contextReader: makeUiContextReader(document, () => attendanceUrl), onInput: () => { ui.accountImage.src = ui.attendanceImage.src = markerUrl('avatar', avatarB); } });
    ui = installUiContextFixture(document);
    const plan = await planFor(app);
    confirmPlan(app);
    await expect(applyPlan(app, plan)).rejects.toThrow('seit der Vorschau geändert');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
});

describe('final draft integrity after asynchronous context hashing', () => {
  it.each(['time', 'note', 'validation', 'disabled-save', 'empty-card'] as const)('rejects %s changed while the final context check awaits', async change => {
    let reached!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let paused = false;
    const contextReader = async (): Promise<AttendanceContextEvidence> => {
      const panels = [...document.querySelectorAll('.entry-panel')];
      const filled = panels.length === 3 && panels.every(panel => [...panel.querySelectorAll<HTMLInputElement>('input[type="tel"]')].every(input => input.value));
      const finalCheck = (app.adapter as unknown as { editPhase: string }).editPhase === 'final-check';
      if (filled && finalCheck && !paused) { paused = true; reached(); await gate; }
      return { mode: 'user-confirmed-ui', pageUrl: attendanceUrl, markerFingerprint: 'same-visible-markers' };
    };
    const app = fixture({ contextReader });
    const plan = await planFor(app);
    confirmPlan(app);
    const running = applyPlan(app, plan);
    await held;
    if (change === 'time') {
      const input = app.panel.querySelector<HTMLInputElement>('input[type="tel"]')!;
      input.value = '09';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (change === 'note') {
      app.panel.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Manual note added while comparing account markers';
    } else if (change === 'empty-card') {
      app.panel.querySelector<HTMLButtonElement>('[data-icon-before="clock-add"]')!.click();
    } else if (change === 'validation') {
      const error = document.createElement('div');
      error.setAttribute('role', 'alert'); error.textContent = 'Late validation error';
      app.panel.append(error);
    } else [...app.panel.querySelectorAll('button')].find(button => button.textContent === 'Save')!.disabled = true;
    release();
    await expect(running).rejects.toThrow(change === 'validation' ? 'Late validation error' : change === 'disabled-save' ? 'nicht verfügbar' : 'geprüften Bearbeitungsstand');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
  });
});


describe('semantic draft inventory across native rerenders', () => {
  it('reacquires all cards and logical fields after every input/change/blur and Add', async () => {
    const app = fixture({ reverseTimeControls: true, reorderCards: true, normalizeHours: true });
    const plan = await planFor(app);
    await applyPlan(app, plan);
    expect(app.entries()).toEqual(planned);
    expect(app.saves()).toBe(1);
    expect(app.additions()).toBe(2); // Initial Work is reused; only Break and the second Work are added.
  });
  it('reuses a valid prefilled initial Work and overwrites native time prefills', async () => {
    const app = fixture({ initialPrefill: work('07:45', '11:45'), addedPrefill: work('09:10', '17:10'), reverseTimeControls: true });
    const plan = await planFor(app);
    await applyPlan(app, plan);
    expect(app.entries()).toEqual(planned);
    expect(app.additions()).toBe(2);
    expect(app.saves()).toBe(1);
  });
  it('waits for a delayed, completely rerendered additional card without retrying Add', async () => {
    const app = fixture({ addDelayMs: 10 });
    const plan = await planFor(app);
    await applyPlan(app, plan);
    expect(app.entries()).toEqual(planned);
    expect(app.additions()).toBe(2);
    expect(app.saves()).toBe(1);
  });
  it.each(['none', 'multiple', 'wrong-kind', 'change-existing', 'duplicate', 'extras'] as const)('stops for %s Add results without saving or clicking Add again', async addBehavior => {
    const app = fixture({ addBehavior });
    const plan = await planFor(app);
    await expect(applyPlan(app, plan)).rejects.toThrow('2026-02-02');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
    expect(app.additions()).toBe(1);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('detects a duplicate semantic target even if the requested type matches', async () => {
    const app = fixture({ entries: [work('08:00', '12:00'), work('08:00', '12:00')] });
    const plan = await planFor(app);
    await expect(applyPlan(app, plan)).rejects.toThrow('nicht vollständig bearbeitbar');
    expect(app.saves()).toBe(0);
    expect(app.additions()).toBe(0);
    expect(app.entries()).toEqual([work('08:00', '12:00'), work('08:00', '12:00')]);
  });
  it.each(['input', 'focus', 'focusout', 'delete', 'add'] as const)('honours cancellation immediately after the native %s event', async name => {
    const controller = new AbortController();
    const app = fixture({
      ...(name === 'delete' ? { entries: [work()] } : {}),
      onEditorEvent: event => { if (event === name) controller.abort(); },
      onAdd: () => { if (name === 'add') controller.abort(); },
    });
    const plan = await planFor(app);
    await expect(applyPlan(app, plan, undefined, controller.signal)).rejects.toThrow();
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual(name === 'delete' ? [work()] : []);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
});


describe('unapproved or ambiguous native prefills', () => {
  it('does not silently clear an unexpected note on the initial draft', async () => {
    const app = fixture({ initialPrefill: { ...work('07:45', '11:45'), note: 'Unexpected default note' } });
    await expect(applyPlan(app, await planFor(app))).rejects.toThrow('Zusatzdaten');
    expect(app.saves()).toBe(0);
    expect(app.additions()).toBe(0);
  });
  it('rejects a new Work card identical to an already completed Work card', async () => {
    const app = fixture({ addedPrefill: work('08:00', '12:00') });
    await expect(applyPlan(app, await planFor(app))).rejects.toThrow('eindeutig');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
    expect(app.additions()).toBe(2);
  });
  it('rejects hour/minute controls sharing the same input node', async () => {
    const app = fixture();
    const plan = await planFor(app);
    await expect(applyPlan(app, plan, progress => {
      if (progress.phase === 'apply' && progress.completed === 0) {
        const fields = app.panel.querySelectorAll<HTMLInputElement>('b-timepicker input');
        fields[0].classList.add('btmpckr-input-minutes');
        fields[1].classList.remove('btmpckr-input-minutes');
      }
    })).rejects.toThrow('Zeitfelder');
    expect(app.saves()).toBe(0);
    expect(app.additions()).toBe(0);
  });
});


describe('note staging cancellation after a native rerender', () => {
  it('does not dispatch further events or save after clearing a confirmed old note is cancelled', async () => {
    const controller = new AbortController();
    const original = [{ ...planned[0], note: 'Reviewed old note' }];
    const events: string[] = [];
    const app = fixture({ entries: original, onEditorEvent: name => { events.push(name); }, onNoteInput: () => controller.abort() });
    const plan = await planFor(app);
    await expect(applyPlan(app, plan, undefined, controller.signal)).rejects.toThrow();
    expect(events.at(-1)).toBe('note-input');
    expect(events.filter(name => name === 'note-input')).toHaveLength(1);
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual(original);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
});


describe('transient native editor mounts', () => {
  it('waits through empty card mounts on Add and each native time event without reusing detached controls', async () => {
    const app = fixture({ transientUnmountMs: 3, addDelayMs: 5, reverseTimeControls: true, reorderCards: true });
    await applyPlan(app, await planFor(app));
    expect(app.entries()).toEqual(planned);
    expect(app.saves()).toBe(1);
    expect(app.additions()).toBe(2);
  });
});

describe('native focusout timepicker commit contract', () => {
  it('reproduces the old Break failure when only synthetic input/change/blur are emitted', async () => {
    const app = fixture({ rerenderOnEvent: false });
    const plan = await planFor(app);
    type LegacyTarget = { value: { kind: string; fields: [string, string, string, string]; note: string; reason: string; metadata: string[] } };
    const internal = app.adapter as unknown as {
      fillControl(panel: Element, target: LegacyTarget, field: number | 'note', value: string, signal?: AbortSignal): Promise<void>;
      targetControl(panel: Element, target: LegacyTarget, field: number | 'note'): HTMLInputElement;
      refreshTarget(panel: Element, target: LegacyTarget, signal?: AbortSignal): Promise<void>;
    };
    // Recreate the former event path without changing production source. The
    // fixture's component model commits only real focusout, exactly as HiBob.
    internal.fillControl = async (panel, target, field, value, signal) => {
      const input = internal.targetControl(panel, target, field);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      target.value = { ...target.value, fields: target.value.fields.map((current, index) => index === field ? value : current) as LegacyTarget['value']['fields'] };
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      await internal.refreshTarget(panel, target, signal);
    };
    await expect(applyPlan(app, plan)).rejects.toThrow(/\((Pause|Break)\).*unerwartet verändert/);
    expect(app.additions()).toBe(1);
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
  });
  it('commits the same input model with real focusout before Add rebuilds cards', async () => {
    const app = fixture({ rerenderOnEvent: false });
    await applyPlan(app, await planFor(app));
    expect(app.entries()).toEqual(planned);
    expect(app.saves()).toBe(1);
  });
  it('focuses and commits all fields even when every displayed time already matches', async () => {
    const commits: string[] = [];
    const app = fixture({ entries: planned, rerenderOnEvent: false, onEditorEvent: event => commits.push(event) });
    const plan = await planFor(app);
    commits.length = 0;
    await applyPlan(app, plan);
    expect(commits.filter(event => event === 'focusout')).toHaveLength(12);
    expect(commits.filter(event => event === 'input')).toHaveLength(12);
    expect(app.entries()).toEqual(planned);
    expect(app.saves()).toBe(1);
  });
  it('stops before input if a connected control cannot take focus', async () => {
    let inputs = 0;
    const app = fixture({ focusFailure: true, onInput: () => inputs++ });
    await expect(applyPlan(app, await planFor(app))).rejects.toThrow('fokussieren');
    expect(inputs).toBe(0);
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
  });
  it('honours cancellation while focusout replaces the prospective next control', async () => {
    const controller = new AbortController();
    let focusouts = 0;
    let inputs = 0;
    const app = fixture({ onInput: () => inputs++, onEditorEvent: event => {
      if (event === 'focusout' && ++focusouts === 1) controller.abort();
    } });
    await expect(applyPlan(app, await planFor(app), undefined, controller.signal)).rejects.toThrow('abgebrochen');
    expect(inputs).toBe(1);
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
  });
});

describe('shared writer draft-only checks', () => {
  it('stages all segments, cancels, reopens and proves the original empty day unchanged', async () => {
    const app = fixture({ reverseTimeControls: true, reorderCards: true });
    const plan = await planFor(app);
    const result = await app.adapter.checkDayDraft(plan, undefined, undefined, app.reviewedContext, app.reviewedAuthorization);
    expect(result).toEqual({ date: plan.date, entries: planned.map(entry => ({ ...entry, note: undefined, reason: undefined })), netMinutes: 480, saved: false, unchanged: true });
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('preserves original entries and notes after an overwrite rehearsal', async () => {
    const original = [{ ...work(), note: 'Original reviewed note' }];
    const app = fixture({ entries: original });
    const plan = await planFor(app);
    const result = await app.adapter.checkDayDraft(plan, undefined, undefined, app.reviewedContext, app.reviewedAuthorization);
    expect(result.saved).toBe(false);
    expect(result.unchanged).toBe(true);
    expect(result.entries.map(({ type, start, end }) => ({ type, start, end }))).toEqual(planned);
    expect(app.entries()).toEqual(original);
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
  it('requires the same account confirmation as a real booking', async () => {
    const app = fixture({ contextMode: 'user-confirmed-ui' });
    const plan = await planFor(app);
    await expect(app.adapter.checkDayDraft(plan, undefined, undefined, app.reviewedContext, app.reviewedAuthorization)).rejects.toThrow();
    expect(app.additions()).toBe(0);
    expect(app.saves()).toBe(0);
  });
  it('does not claim unchanged if Cancel leaves different reported hours or entries', async () => {
    const app = fixture({ cancelBehavior: 'changes-persisted' });
    const plan = await planFor(app);
    let error: unknown;
    try { await app.adapter.checkDayDraft(plan, undefined, undefined, app.reviewedContext, app.reviewedAuthorization); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).uncertain).toBe(true);
    expect((error as Error).message).toContain('ursprünglichen Tageszustand');
    expect(app.saves()).toBe(0);
  });
  it('surfaces an unresolved Cancel instead of reporting a successful check', async () => {
    const app = fixture({ cancelBehavior: 'timeout' });
    const plan = await planFor(app);
    await expect(app.adapter.checkDayDraft(plan, undefined, undefined, app.reviewedContext, app.reviewedAuthorization)).rejects.toThrow('geschlossen');
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
  it('cancels a draft-only check before Save and leaves original data untouched', async () => {
    const controller = new AbortController();
    const app = fixture({ onInput: () => controller.abort() });
    const plan = await planFor(app);
    await expect(app.adapter.checkDayDraft(plan, undefined, controller.signal, app.reviewedContext, app.reviewedAuthorization)).rejects.toThrow('abgebrochen');
    expect(app.saves()).toBe(0);
    expect(app.entries()).toEqual([]);
    expect(app.panel.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('draft check cleanup ownership after asynchronous context verification', () => {
  it('does not cancel a different day opened while cleanup awaits account hashing', async () => {
    let reached!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let shouldHold = false;
    let paused = false;
    let cancels = 0;
    const controller = new AbortController();
    let app!: ReturnType<typeof fixture>;
    app = fixture({
      contextReader: async () => {
        if (shouldHold && !paused) { paused = true; reached(); await gate; }
        return app.identity;
      },
      onInput: () => { shouldHold = true; controller.abort(); },
    });
    const plan = await planFor(app);
    const running = app.adapter.checkDayDraft(plan, undefined, controller.signal, app.reviewedContext, app.reviewedAuthorization);
    await held;
    [...app.panel.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.addEventListener('click', () => cancels++);
    app.panel.querySelector('.b-display-3')!.textContent = 'Tue, 03/02/2026';
    release();
    await expect(running).rejects.toThrow('abgebrochen');
    expect(cancels).toBe(0);
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
  it('reports safe localized field names instead of changed note contents', async () => {
    const app = fixture({ addBehavior: 'change-existing' });
    let message = '';
    try { await applyPlan(app, await planFor(app)); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('Nach Hinzufügen eines Eintrags');
    expect(message).toContain('Notiz');
    expect(message).not.toContain('Unexpected old-card mutation');
    expect(message).not.toContain('phase=');
    expect(app.saves()).toBe(0);
  });
});


describe('opening a day after asynchronous account verification', () => {
  it('does not replace a manual form opened while the native open check awaits', async () => {
    let reached!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let opening = false;
    let paused = false;
    let app!: ReturnType<typeof fixture>;
    app = fixture({ contextReader: async () => {
      if (opening && !paused) { paused = true; reached(); await gate; }
      return app.identity;
    } });
    const plan = await planFor(app);
    const internal = app.adapter as unknown as { openDay(day: unknown, signal?: AbortSignal, context?: AttendanceContext): Promise<Element> };
    const original = internal.openDay.bind(app.adapter);
    internal.openDay = async (day, signal, context) => { opening = true; return original(day, signal, context); };
    const beforeOpens = app.opens();
    const running = app.adapter.checkDayDraft(plan, undefined, undefined, app.reviewedContext, app.reviewedAuthorization);
    await held;
    app.panel.innerHTML = '<div class="sticky-header"><p class="b-display-3">Tue, 03/02/2026</p></div><button>Cancel</button>';
    app.panel.setAttribute('aria-hidden', 'false');
    release();
    await expect(running).rejects.toThrow('bereits offen');
    expect(app.opens()).toBe(beforeOpens);
    expect(app.saves()).toBe(0);
    expect(app.panel.getAttribute('aria-hidden')).toBe('false');
  });
});
