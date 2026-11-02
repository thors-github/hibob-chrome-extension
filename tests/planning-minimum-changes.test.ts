import { describe, expect, it } from 'vitest';
import { buildMonthPlan, defaultSettings, getMonthDates, netMinutes } from '../src/domain';
import { assertWritablePlan } from '../src/shared/validation';
import type { AttendanceEntry, ConflictChoices, MonthSnapshot, Settings } from '../src/shared/types';

const text = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const segments = (duration = 480, note?: string): AttendanceEntry[] => {
  const difference = duration - 480;
  const start = difference === 2 ? 479 : difference === -2 ? 481 : 480;
  const end = start + duration + 30;
  return [
    { type: 'work', start: text(start), end: '12:00', ...(note ? { note } : {}) },
    { type: 'break', start: '12:00', end: '12:30' },
    { type: 'work', start: '12:30', end: text(end) },
  ];
};
function snapshot(): MonthSnapshot {
  return {
    month: '2026-11', source: 'hibob', employeeLabel: 'Fixture', periodLabel: '2026-11', scannedAt: '2026-11-01T00:00:00Z',
    context: { mode: 'api-session', connectionId: 'fixture-session', employeeKey: 'fixture-user', tenantKey: 'fixture-company' },
    days: getMonthDates('2026-11').map(date => {
      const working = ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
      return { date, entries: working ? segments() : [], editable: true, fingerprint: `${date}-original`, reportedMinutes: working ? 480 : 0 };
    }),
  };
}
function set(source: MonthSnapshot, date: string, entries: AttendanceEntry[]): void {
  Object.assign(source.days.find(day => day.date === date)!, { entries, reportedMinutes: netMinutes(entries), fingerprint: `${date}-${JSON.stringify(entries)}` });
}
const settings = (variationMinutes = 15): Settings => ({ ...defaultSettings('2026-11'), variable: true, variationMinutes });
const repairs = (plan: ReturnType<typeof buildMonthPlan>) => plan.days.filter(day => ['create', 'overwrite', 'conflict'].includes(day.action));
const week = (plan: ReturnType<typeof buildMonthPlan>) => plan.days.filter(day => day.date >= '2026-11-02' && day.date <= '2026-11-06');

describe('minimum-change month planning', () => {
  it('treats a complete suitable month as a no-op and preserves known notes', () => {
    const source = snapshot();
    set(source, '2026-11-02', segments(480, 'Keep this known note'));
    const before = structuredClone(source);
    const plan = buildMonthPlan(settings(), source, {}, 843);
    expect(plan.errors).toEqual([]);
    expect(plan.canReview).toBe(false);
    expect(repairs(plan)).toHaveLength(0);
    expect(plan.days.filter(day => day.action === 'unchanged')).toHaveLength(21);
    expect(plan.weeks.every(item => item.targetMinutes === item.plannedMinutes)).toBe(true);
    expect(plan.days.find(day => day.date === '2026-11-02')!.proposed).toEqual(before.days.find(day => day.date === '2026-11-02')!.entries);
    expect(source).toEqual(before);
    expect(() => assertWritablePlan(plan)).toThrow('keine Änderungen');
  });

  it('preserves an already varied week regardless of a different seed', () => {
    const source = snapshot();
    [478, 479, 480, 481, 482].forEach((duration, index) => set(source, `2026-11-0${index + 2}`, segments(duration)));
    const first = buildMonthPlan(settings(1), source, {}, 20);
    const second = buildMonthPlan(settings(1), source, {}, 70);
    expect(repairs(first)).toHaveLength(0);
    expect(second.days).toEqual(first.days);
    expect(first.weeks.find(item => item.week === '2026-11-02')).toMatchObject({ plannedMinutes: 2400, targetMinutes: 2400 });
  });

  it('repairs a partial rerun by changing exactly one date and requires overwrite consent', () => {
    const source = snapshot();
    for (let index = 2; index <= 6; index++) set(source, `2026-11-0${index}`, segments(index === 2 ? 479 : 480, 'Preserved until reviewed'));
    const initial = buildMonthPlan(settings(), source, {}, 12);
    const changed = repairs(initial);
    expect(changed).toHaveLength(1);
    expect(changed[0].action).toBe('conflict');
    expect(initial.canReview).toBe(false);
    expect(changed[0].existing[0].note).toBe('Preserved until reviewed');
    expect(changed[0].proposed.every(entry => !entry.note)).toBe(true);
    const approved = buildMonthPlan(settings(), source, { [changed[0].date]: 'overwrite' }, 12);
    expect(repairs(approved)).toHaveLength(1);
    expect(repairs(approved)[0]).toMatchObject({ date: changed[0].date, action: 'overwrite', proposed: changed[0].proposed });
    expect(approved.weeks.every(item => item.plannedMinutes === item.targetMinutes)).toBe(true);
    expect(approved.canReview).toBe(true);
    expect(() => assertWritablePlan(approved)).not.toThrow();
  });

  it('fills missing dates without rewriting compatible existing dates', () => {
    const source = snapshot();
    set(source, '2026-11-03', []);
    const plan = buildMonthPlan(settings(), source, {}, 123);
    expect(repairs(plan)).toHaveLength(1);
    expect(repairs(plan)[0]).toMatchObject({ date: '2026-11-03', action: 'create', netMinutes: 480 });
    expect(plan.days.filter(day => day.action === 'unchanged')).toHaveLength(20);
    expect(plan.canReview).toBe(true);
  });

  it('still varies new durations when minimum-change allocation permits it', () => {
    const source = snapshot();
    set(source, '2026-11-05', []); set(source, '2026-11-06', []);
    for (let seed = 0; seed < 20; seed++) {
      const plan = buildMonthPlan(settings(1), source, {}, seed);
      expect(repairs(plan)).toHaveLength(2);
      expect(new Set(week(plan).map(day => day.netMinutes)).size).toBeGreaterThan(1);
      expect(plan.weeks.find(item => item.week === '2026-11-02')!.plannedMinutes).toBe(2400);
      expect(buildMonthPlan(settings(1), source, {}, seed)).toEqual(plan);
    }
  });

  it('respects explicit skips, exclusions and absences while repairing other dates', () => {
    const source = snapshot();
    set(source, '2026-11-02', segments(470));
    set(source, '2026-11-03', [{ ...segments()[0], metadata: ['unsupported'] }, ...segments().slice(1)]);
    source.days.find(day => day.date === '2026-11-04')!.absence = 'Partial day away';
    const config = { ...settings(), excludedDates: ['2026-11-03'] };
    const plan = buildMonthPlan(config, source, { '2026-11-02': 'skip' }, 9);
    expect(plan.days.find(day => day.date === '2026-11-02')).toMatchObject({ action: 'skip', existingNetMinutes: 470, netMinutes: 470 });
    expect(plan.days.find(day => day.date === '2026-11-03')).toMatchObject({ action: 'skip', eligible: false });
    expect(plan.days.find(day => day.date === '2026-11-04')).toMatchObject({ action: 'skip', eligible: false });
    expect(repairs(plan)).toHaveLength(1);
    expect(plan.weeks.find(item => item.week === '2026-11-02')).toMatchObject({ targetMinutes: 1440, plannedMinutes: 1440 });
  });

  it('blocks unreachable skipped-hour targets and unknown metadata', () => {
    const source = snapshot();
    set(source, '2026-11-02', segments(420));
    const impossible = buildMonthPlan(settings(1), source, { '2026-11-02': 'skip' });
    expect(impossible.canReview).toBe(false);
    expect(impossible.errors.join()).toContain('nicht erreichbar');
    set(source, '2026-11-02', [{ ...segments()[0], reason: 'Unknown reason', metadata: ['project'] }, ...segments().slice(1)]);
    const blocked = buildMonthPlan(settings(), source, { '2026-11-02': 'overwrite' });
    expect(blocked.days.find(day => day.date === '2026-11-02')).toMatchObject({ action: 'blocked', eligible: true, netMinutes: null });
    expect(blocked.canReview).toBe(false);
    expect(blocked.errors.join()).toContain('Zusatzdaten');
  });

  it('does not retain a wrong break or malformed segment shape just because net hours match', () => {
    const source = snapshot();
    set(source, '2026-11-02', [
      { type: 'work', start: '08:00', end: '11:30' },
      { type: 'break', start: '11:30', end: '12:00' },
      { type: 'work', start: '12:00', end: '16:30' },
    ]);
    const plan = buildMonthPlan(settings(), source);
    expect(repairs(plan)).toHaveLength(1);
    expect(repairs(plan)[0]).toMatchObject({ date: '2026-11-02', action: 'conflict' });
  });

  it('binds explicit full redistribution to the plan and keeps it reproducible', () => {
    const source = snapshot(), config = settings();
    const retained = buildMonthPlan(config, source, {}, 34);
    const choices: ConflictChoices = Object.fromEntries(source.days.filter(day => day.entries.length).map(day => [day.date, 'overwrite']));
    const redistributed = buildMonthPlan(config, source, choices, 34, { redistributeAll: true });
    expect(retained).not.toHaveProperty('redistributeAll');
    expect(redistributed.redistributeAll).toBe(true);
    expect(redistributed.id).not.toBe(buildMonthPlan(config, source, choices, 34).id);
    expect(repairs(redistributed).length).toBeGreaterThan(0);
    expect(redistributed.canReview).toBe(true);
    expect(new Set(week(redistributed).map(day => day.netMinutes)).size).toBeGreaterThan(1);
    expect(buildMonthPlan(config, source, choices, 34, { redistributeAll: true })).toEqual(redistributed);
  });

  it('matches an independent brute-force minimum for every three-day small-range week', () => {
    const config = { ...settings(1), excludedDates: ['2026-11-05', '2026-11-06'] };
    const allowed = [478, 479, 480, 481, 482];
    for (const a of [477, 478, 479, 480, 481, 482, 483]) for (const b of [477, 478, 479, 480, 481, 482, 483]) for (const c of [477, 478, 479, 480, 481, 482, 483]) {
      const current = [a, b, c], source = snapshot();
      current.forEach((duration, index) => set(source, `2026-11-0${index + 2}`, segments(duration)));
      let minimum = Infinity;
      for (const x of allowed) for (const y of allowed) for (const z of allowed) {
        if (x + y + z !== 1440) continue;
        minimum = Math.min(minimum, [x, y, z].reduce((cost, duration, index) => cost + (allowed.includes(current[index]) && duration === current[index] ? 0 : 1), 0));
      }
      const plan = buildMonthPlan(config, source, {}, 772);
      expect(repairs(plan), `durations ${current.join(',')}`).toHaveLength(minimum);
      expect(plan.weeks.find(item => item.week === '2026-11-02')!.plannedMinutes).toBe(1440);
    }
  });
});
