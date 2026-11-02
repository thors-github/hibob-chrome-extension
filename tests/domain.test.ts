import { describe, expect, it } from 'vitest';
import { buildMonthPlan, defaultSettings, formatMinutes, GERMAN_STATES, getHolidays, getMonthDates, netMinutes, parseTime, validateSettings } from '../src/domain';
import type { AttendanceEntry, MonthSnapshot, Settings } from '../src/shared/types';
import holidayData from '../src/domain/holidays-de.json';

function snapshot(month: string): MonthSnapshot {
  return {
    month, employeeLabel: 'Testperson', periodLabel: month, scannedAt: '2026-11-01T09:00:00Z', source: 'demo',
    days: getMonthDates(month).map(date => ({ date, entries: [], editable: true, fingerprint: `${date}-empty` })),
  };
}

function work(start: string, end: string): AttendanceEntry { return { type: 'work', start, end }; }

describe('German holiday calendars', () => {
  it('ships German rules only and defaults to the approved five-minute variation', () => {
    expect(Object.keys(holidayData.holidays)).toEqual(['DE']);
    expect(defaultSettings('2026-11').variationMinutes).toBe(5);
  });
  it('provides 16 states and the official Hessian 2026 holiday dates', () => {
    expect(GERMAN_STATES).toHaveLength(16);
    const holidays = getHolidays(defaultSettings('2026-06'));
    expect(Object.keys(holidays).sort()).toEqual([
      '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14',
      '2026-05-25', '2026-06-04', '2026-10-03', '2026-12-25', '2026-12-26',
    ]);
    expect(holidays['2026-12-24']).toBeUndefined();
    expect(holidays['2026-12-31']).toBeUndefined();
    expect(holidays['2026-02-16']).toBeUndefined(); // Carnival is observance.
  });

  it('honours one-off Berlin holidays only in their designated year', () => {
    const settings = { ...defaultSettings('2025-05'), state: 'BE' };
    expect(getHolidays(settings)['2025-05-08']).toBeTruthy();
    expect(getHolidays({ ...settings, month: '2026-05' })['2026-05-08']).toBeUndefined();
    expect(getHolidays({ ...settings, month: '2028-06' })['2028-06-17']).toBeTruthy();
  });

  it('requires explicit municipal choices and distinguishes Bavarian local holidays', () => {
    const settings = { ...defaultSettings('2026-08'), state: 'BY' };
    expect(validateSettings(settings)).toHaveLength(2);
    const neither = { ...settings, localHolidays: { ...settings.localHolidays, augsburg: false, assumption: false } };
    expect(validateSettings(neither)).toEqual([]);
    expect(getHolidays(neither)['2026-08-15']).toBeUndefined();
    expect(getHolidays(neither)['2026-08-08']).toBeUndefined();
    const assumption = { ...neither, localHolidays: { ...neither.localHolidays, assumption: true } };
    expect(getHolidays(assumption)['2026-08-15']).toBeTruthy();
    expect(getHolidays(assumption)['2026-08-08']).toBeUndefined();
    const augsburg = { ...settings, localHolidays: { ...settings.localHolidays, augsburg: true } };
    expect(validateSettings(augsburg)).toEqual([]);
    expect(getHolidays(augsburg)['2026-08-08']).toBeTruthy();
    expect(getHolidays(augsburg)['2026-08-15']).toBeTruthy();
  });

  it.each(['SN', 'TH'])('does not mark all of %s as eligible for Corpus Christi', state => {
    const settings = { ...defaultSettings('2026-06'), state };
    expect(validateSettings(settings).join()).toContain('Fronleichnam');
    expect(getHolidays({ ...settings, localHolidays: { ...settings.localHolidays, corpusChristi: false } })['2026-06-04']).toBeUndefined();
    expect(getHolidays({ ...settings, localHolidays: { ...settings.localHolidays, corpusChristi: true } })['2026-06-04']).toBe('Fronleichnam');
  });

  it('keeps civil dates intact over leap years and DST boundary months', () => {
    expect(getMonthDates('2024-02')).toHaveLength(29);
    expect(getMonthDates('2026-03')).toHaveLength(31);
    expect(getMonthDates('2026-10')[30]).toBe('2026-10-31');
    expect(getMonthDates('2026-13')).toEqual([]);
  });
});

describe('attendance arithmetic and validation', () => {
  it('counts split work / break / work without subtracting the break twice', () => {
    expect(netMinutes([work('08:00', '12:00'), { type: 'break', start: '12:00', end: '12:30' }, work('12:30', '16:30')])).toBe(480);
    expect(netMinutes([work('08:00', '16:30'), { type: 'break', start: '12:00', end: '12:30' }])).toBe(480);
    expect(netMinutes([])).toBe(0);
  });

  it('refuses unknown, incomplete, crossing-midnight or overlapping records', () => {
    expect(netMinutes([work('08:00', '')])).toBeNull();
    expect(netMinutes([work('22:00', '06:00')])).toBeNull();
    expect(netMinutes([work('08:00', '12:00'), work('11:00', '16:00')])).toBeNull();
    expect(netMinutes([{ type: 'break', start: '12:00', end: '12:30' }])).toBeNull();
    expect(netMinutes([{ type: 'other', start: '08:00', end: '16:00' } as unknown as AttendanceEntry])).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('08:60')).toBeNull();
  });

  it('checks chronological pause boundaries and integer variation bounds', () => {
    expect(validateSettings({ ...defaultSettings('2026-11'), breakStart: '07:30' })).not.toEqual([]);
    expect(validateSettings({ ...defaultSettings('2026-11'), variationMinutes: 31 })).not.toEqual([]);
    expect(validateSettings({ ...defaultSettings('2026-11'), variationMinutes: 1.5 })).not.toEqual([]);
    expect(formatMinutes(480)).toBe('8 h 00 min');
    expect(formatMinutes(null)).toBe('Unvollständig');
  });
});

describe('month planning and conflicts', () => {
  it('skips weekends, public holidays, absences, frozen days and manual exclusions', () => {
    const settings = { ...defaultSettings('2026-06'), excludedDates: ['2026-06-05'] };
    const source = snapshot(settings.month);
    source.days.find(day => day.date === '2026-06-08')!.absence = 'Urlaub';
    source.days.find(day => day.date === '2026-06-09')!.editable = false;
    source.days.find(day => day.date === '2026-06-10')!.nonWorking = 'Betrieblicher freier Tag';
    const plan = buildMonthPlan(settings, source);
    for (const date of ['2026-06-04', '2026-06-05', '2026-06-06', '2026-06-08', '2026-06-09', '2026-06-10']) {
      expect(plan.days.find(day => day.date === date)).toMatchObject({ action: 'skip', eligible: false });
    }
    expect(plan.canReview).toBe(true);
    expect(plan.days.find(day => day.date === '2026-06-01')!.proposed).toEqual([
      work('08:00', '12:00'), { type: 'break', start: '12:00', end: '12:30' }, work('12:30', '16:30'),
    ]);
  });

  it('requires a per-day decision for every existing record and preserves actual retained hours', () => {
    const settings = defaultSettings('2026-11');
    const source = snapshot(settings.month);
    source.days.find(day => day.date === '2026-11-02')!.entries = [work('08:00', '15:00')];
    const unresolved = buildMonthPlan(settings, source);
    expect(unresolved.days.find(day => day.date === '2026-11-02')!.action).toBe('conflict');
    expect(unresolved.canReview).toBe(false);
    const skipped = buildMonthPlan(settings, source, { '2026-11-02': 'skip' });
    expect(skipped.days.find(day => day.date === '2026-11-02')).toMatchObject({ action: 'skip', netMinutes: 420, existingNetMinutes: 420 });
    const overwritten = buildMonthPlan(settings, source, { '2026-11-02': 'overwrite' });
    expect(overwritten.days.find(day => day.date === '2026-11-02')).toMatchObject({ action: 'overwrite', netMinutes: 480 });
  });

  it('marks an identical entry unchanged only after an explicit overwrite choice', () => {
    const settings = defaultSettings('2026-11');
    const source = snapshot(settings.month);
    const entries = buildMonthPlan(settings, source).days.find(day => day.date === '2026-11-02')!.proposed;
    source.days.find(day => day.date === '2026-11-02')!.entries = entries;
    expect(buildMonthPlan(settings, source).days.find(day => day.date === '2026-11-02')!.action).toBe('conflict');
    expect(buildMonthPlan(settings, source, { '2026-11-02': 'overwrite' }).days.find(day => day.date === '2026-11-02')!.action).toBe('unchanged');
    source.days.find(day => day.date === '2026-11-02')!.entries = entries.map((entry, i) => i === 0 ? { ...entry, note: 'Important retained note' } : entry);
    expect(buildMonthPlan(settings, source, { '2026-11-02': 'overwrite' }).days.find(day => day.date === '2026-11-02')!.action).toBe('overwrite');
  });

  it('blocks unsupported selected days in both modes without reducing weekly targets', () => {
    const settings = defaultSettings('2026-11');
    const source = snapshot(settings.month);
    source.days = source.days.filter(day => day.date !== '2026-11-03');
    expect(buildMonthPlan(settings, source).canReview).toBe(false);
    const complete = snapshot(settings.month);
    complete.days.find(day => day.date === '2026-11-03')!.unsupportedReason = 'Unbekannte Eingabeform';
    const plan = buildMonthPlan(settings, complete);
    expect(plan.days.find(day => day.date === '2026-11-03')).toMatchObject({ eligible: true, action: 'blocked', netMinutes: null });
    expect(plan.canReview).toBe(false);
    const variable = buildMonthPlan({ ...settings, variable: true }, complete);
    expect(variable.canReview).toBe(false);
    expect(variable.weeks.find(week => week.week === '2026-11-02')).toMatchObject({ targetMinutes: 2400, plannedMinutes: null });
    const excluded = buildMonthPlan({ ...settings, variable: true, excludedDates: ['2026-11-03'] }, complete);
    expect(excluded.canReview).toBe(true);
    expect(excluded.weeks.find(week => week.week === '2026-11-02')).toMatchObject({ targetMinutes: 1920, plannedMinutes: 1920 });
  });

  it('requires a readable account context and distinguishes manual review from stable identity', () => {
    const settings = defaultSettings('2026-11');
    const source = snapshot(settings.month);
    source.source = 'hibob';
    source.days.forEach(day => { day.reportedMinutes = 0; });
    const unknown = buildMonthPlan(settings, source);
    expect(unknown.canReview).toBe(false);
    expect(unknown.days.filter(day => day.action === 'create')).toHaveLength(21);
    expect(unknown.weeks.find(week => week.week === '2026-11-02')!.plannedMinutes).toBe(2400);
    source.context = { documentId: 'doc-1', tenantKey: 'tenant-1', employeeKey: 'employee-1', mode: 'stable-identity' };
    expect(buildMonthPlan(settings, source).canReview).toBe(true);
    source.context = { mode: 'user-confirmed-ui', documentId: 'doc-1', pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'observed-marker' };
    const manual = buildMonthPlan(settings, source);
    expect(manual.canReview).toBe(true);
    expect(manual.snapshot.context?.mode).toBe('user-confirmed-ui');
    expect(manual.snapshot.context).not.toHaveProperty('employeeKey');
    source.context.pageUrl = 'https://app.hibob.com/home';
    expect(buildMonthPlan(settings, source).canReview).toBe(false);
    source.context = { mode: 'unavailable', documentId: 'doc-1', reason: 'Missing account context' };
    expect(buildMonthPlan(settings, source).canReview).toBe(false);
  });

  it.each([null, undefined, 240, 480.5])('blocks unrecognised or inconsistent reported minutes: %s', reportedMinutes => {
    const settings = { ...defaultSettings('2026-11'), variable: true };
    const source = snapshot(settings.month);
    source.source = 'hibob';
    source.context = { documentId: 'doc-1', tenantKey: 'tenant-1', employeeKey: 'employee-1', mode: 'stable-identity' };
    source.days.forEach(day => { day.reportedMinutes = 0; });
    const day = source.days.find(day => day.date === '2026-11-03')!;
    day.entries = [work('08:00', '16:00')];
    day.reportedMinutes = reportedMinutes;
    const plan = buildMonthPlan(settings, source, { [day.date]: 'overwrite' });
    expect(plan.canReview).toBe(false);
    expect(plan.days.find(item => item.date === day.date)).toMatchObject({ action: 'blocked', eligible: true, netMinutes: null });
    expect(plan.weeks.find(week => week.week === '2026-11-02')!.targetMinutes).toBe(2400);
    day.reportedMinutes = 480;
    expect(buildMonthPlan(settings, source, { [day.date]: 'overwrite' }).canReview).toBe(true);
  });

  it('blocks unknown markers even when the adapter cannot mark the day editable', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true };
    const source = snapshot(settings.month);
    const day = source.days.find(day => day.date === '2026-11-03')!;
    day.editable = false;
    day.unsupportedReason = 'Unknown time-off marker';
    const plan = buildMonthPlan(settings, source);
    expect(plan.canReview).toBe(false);
    expect(plan.days.find(item => item.date === day.date)).toMatchObject({ action: 'blocked', eligible: true });
    expect(plan.weeks.find(week => week.week === '2026-11-02')!.targetMinutes).toBe(2400);
  });

  it('does not mutate settings, snapshots or conflict choices', () => {
    const settings = defaultSettings('2026-11');
    const source = snapshot(settings.month);
    const before = JSON.stringify({ settings, source });
    buildMonthPlan(settings, source);
    expect(JSON.stringify({ settings, source })).toBe(before);
  });

  it('keeps the plan identity stable when Chrome reorders nested object keys', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true };
    const source = snapshot(settings.month);
    source.context = { documentId: 'doc', employeeKey: 'employee', tenantKey: 'tenant', mode: 'stable-identity' };
    source.days.find(day => day.date === '2026-11-02')!.entries = [work('08:00', '16:00')];
    source.days.find(day => day.date === '2026-11-03')!.entries = [work('08:00', '16:00')];
    const choices = { '2026-11-03': 'overwrite' as const, '2026-11-02': 'skip' as const };
    const reorder = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, current) => current && typeof current === 'object' && !Array.isArray(current) ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current));
    const original = buildMonthPlan(settings, source, choices, 9182);
    const stored = buildMonthPlan(reorder(settings), reorder(source), reorder(choices), 9182);
    expect(stored.id).toBe(original.id);
    expect(stored.days).toEqual(original.days);
    expect(stored.weeks).toEqual(original.weeks);
  });

  it('uses the entered schedule in fixed mode without forcing a 40-hour week', () => {
    const settings = { ...defaultSettings('2026-11'), start: '09:00', end: '16:30' };
    const plan = buildMonthPlan(settings, snapshot(settings.month));
    expect(plan.weeks.find(week => week.week === '2026-11-02')).toMatchObject({ targetMinutes: 2100, plannedMinutes: 2100 });
    expect(plan.days.filter(day => day.eligible).every(day => day.netMinutes === 420)).toBe(true);
    expect(plan.canReview).toBe(true);
  });
});

describe('variable exact-week planner', () => {
  it('produces reproducible, minute-accurate, bounded varied weeks across seeds', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true, variationMinutes: 30 };
    const source = snapshot(settings.month);
    for (let seed = 0; seed < 100; seed++) {
      const plan = buildMonthPlan(settings, source, {}, seed);
      expect(plan.errors).toEqual([]);
      expect(plan.weeks.every(week => week.plannedMinutes === week.targetMinutes)).toBe(true);
      expect(plan.weeks.find(week => week.week === '2026-11-02')!.targetMinutes).toBe(2400);
      expect(plan.weeks.find(week => week.week === '2026-11-30')!.targetMinutes).toBe(480);
      for (const day of plan.days.filter(day => day.eligible)) {
        const first = day.proposed[0];
        const last = day.proposed.at(-1)!;
        expect(Math.abs(parseTime(first.start)! - 480)).toBeLessThanOrEqual(30);
        expect(Math.abs(parseTime(last.end)! - 990)).toBeLessThanOrEqual(30);
        expect(day.proposed[1]).toEqual({ type: 'break', start: '12:00', end: '12:30' });
        expect(netMinutes(day.proposed)).toBe(day.netMinutes);
      }
      const fullWeek = plan.days.filter(day => day.date >= '2026-11-02' && day.date <= '2026-11-06');
      expect(new Set(fullWeek.map(day => day.netMinutes)).size).toBeGreaterThan(1);
      expect(buildMonthPlan(settings, source, {}, seed)).toEqual(plan);
    }
    expect(buildMonthPlan(settings, source, {}, 1).days).not.toEqual(buildMonthPlan(settings, source, {}, 2).days);
  });

  it('reduces targets for holidays/exclusions instead of distributing their hours', () => {
    const settings = { ...defaultSettings('2026-06'), variable: true, excludedDates: ['2026-06-05'] };
    const plan = buildMonthPlan(settings, snapshot(settings.month));
    expect(plan.weeks.find(week => week.week === '2026-06-01')).toMatchObject({ targetMinutes: 1440, plannedMinutes: 1440 });
  });

  it('excludes noneditable days from variable targets and leaves their entries alone', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true };
    const source = snapshot(settings.month);
    source.days.find(day => day.date === '2026-11-02')!.editable = false;
    source.days.find(day => day.date === '2026-11-02')!.entries = [work('08:00', '17:00')];
    const plan = buildMonthPlan(settings, source);
    expect(plan.days.find(day => day.date === '2026-11-02')).toMatchObject({ eligible: false, action: 'skip', proposed: [] });
    expect(plan.weeks.find(week => week.week === '2026-11-02')).toMatchObject({ targetMinutes: 1920, plannedMinutes: 1920 });
    expect(plan.canReview).toBe(true);
  });

  it('uses retained complete hours when balancing remaining days', () => {
    const settings: Settings = { ...defaultSettings('2026-11'), variable: true, variationMinutes: 30 };
    const source = snapshot(settings.month);
    source.days.find(day => day.date === '2026-11-02')!.entries = [work('08:00', '15:00')];
    const plan = buildMonthPlan(settings, source, { '2026-11-02': 'skip' });
    const week = plan.weeks.find(item => item.week === '2026-11-02')!;
    expect(week.plannedMinutes).toBe(2400);
    const otherDays = plan.days.filter(day => day.date >= '2026-11-03' && day.date <= '2026-11-06');
    expect(otherDays.reduce((sum, day) => sum + day.netMinutes!, 0)).toBe(1980);
  });

  it('blocks infeasible ranges and retained incomplete entries instead of silently changing targets', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true, end: '15:30', variationMinutes: 0 };
    const plan = buildMonthPlan(settings, snapshot(settings.month));
    expect(plan.canReview).toBe(false);
    expect(plan.errors.join()).toContain('nicht erreichbar');
    const complete = defaultSettings('2026-11');
    const source = snapshot(complete.month);
    source.days.find(day => day.date === '2026-11-02')!.entries = [work('08:00', '')];
    const incomplete = buildMonthPlan({ ...complete, variable: true }, source, { '2026-11-02': 'skip' });
    expect(incomplete.canReview).toBe(false);
    expect(incomplete.errors.join()).toContain('unvollständige Buchungen');
    expect(buildMonthPlan({ ...complete, variable: true }, source, { '2026-11-02': 'overwrite' }).canReview).toBe(true);
  });

  it('supports a schedule with no pause and variations around a different baseline', () => {
    const settings = { ...defaultSettings('2026-11'), useBreak: false, start: '09:00', end: '17:00', variable: true };
    const plan = buildMonthPlan(settings, snapshot(settings.month));
    expect(plan.canReview).toBe(true);
    expect(plan.days.filter(day => day.eligible).every(day => day.proposed.length === 1)).toBe(true);
    expect(plan.weeks.every(week => week.targetMinutes === week.plannedMinutes)).toBe(true);
  });
});
