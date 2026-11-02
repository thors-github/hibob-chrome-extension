import type { AttendanceEntry, BookingPlan, ConflictChoices, DayPlan, MonthSnapshot, Settings, WeekPlan } from '../shared/types';
import { defaultSettings, GERMAN_STATES, getHolidays, getMonthDates, parseMonth, weekday, weekStart } from './calendar';
import { t } from '../i18n';
import { parseTime, netMinutes } from '../shared/entries';
import { canonicalJson } from '../shared/json';
import { isReviewableContext } from '../shared/context';

export { defaultSettings, GERMAN_STATES, getHolidays, getMonthDates } from './calendar';
export { parseTime, netMinutes } from '../shared/entries';

function timeText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return t('Unvollständig');
  const sign = minutes < 0 ? '−' : '';
  const value = Math.abs(Math.round(minutes));
  return t('{sign}{hours} h {minutes} min', { sign, hours: Math.floor(value / 60), minutes: String(value % 60).padStart(2, '0') });
}

export function validateSettings(settings: Settings): string[] {
  const errors: string[] = [];
  if (!parseMonth(settings.month)) errors.push(t('Bitte einen gültigen Monat zwischen 1900 und 2100 wählen.'));
  if (!GERMAN_STATES.some(state => state.code === settings.state)) errors.push(t('Bitte ein deutsches Bundesland wählen.'));
  const start = parseTime(settings.start);
  const end = parseTime(settings.end);
  if (start === null || end === null || start >= end) errors.push(t('Beginn und Ende müssen gültige Uhrzeiten am selben Tag sein; Ende liegt nach Beginn.'));
  if (settings.useBreak) {
    const breakStart = parseTime(settings.breakStart);
    const breakEnd = parseTime(settings.breakEnd);
    if (breakStart === null || breakEnd === null || start === null || end === null || !(start < breakStart && breakStart < breakEnd && breakEnd < end)) {
      errors.push(t('Die Pause muss vollständig zwischen Arbeitsbeginn und Arbeitsende liegen.'));
    }
  }
  if (!Number.isInteger(settings.variationMinutes) || settings.variationMinutes < 0 || settings.variationMinutes > 30) errors.push(t('Die Zeitvariation muss eine ganze Zahl zwischen 0 und 30 Minuten sein.'));
  if (settings.state === 'BY') {
    if (typeof settings.localHolidays.augsburg !== 'boolean') errors.push(t('Bitte angeben, ob dein Arbeitsort die Stadt Augsburg ist.'));
    if (settings.localHolidays.augsburg !== true && typeof settings.localHolidays.assumption !== 'boolean') errors.push(t('Bitte angeben, ob Mariä Himmelfahrt an deinem Arbeitsort gesetzlicher Feiertag ist.'));
  }
  if ((settings.state === 'SN' || settings.state === 'TH') && typeof settings.localHolidays.corpusChristi !== 'boolean') errors.push(t('Bitte angeben, ob Fronleichnam an deinem Arbeitsort gesetzlicher Feiertag ist.'));
  for (const date of settings.excludedDates) {
    if (!getMonthDates(date.slice(0, 7)).includes(date)) errors.push(t('Ungültiger ausgeschlossener Tag: {date}', { date }));
  }
  return errors;
}

interface Candidate { start: number; end: number; minutes: number }

function entriesFor(settings: Settings, candidate: Candidate): AttendanceEntry[] {
  if (!settings.useBreak) return [{ type: 'work', start: timeText(candidate.start), end: timeText(candidate.end) }];
  // HiBob rejects a break nested inside an overlapping work entry. Use its
  // supported chronological work / break / work representation.
  return [
    { type: 'work', start: timeText(candidate.start), end: settings.breakStart },
    { type: 'break', start: settings.breakStart, end: settings.breakEnd },
    { type: 'work', start: settings.breakEnd, end: timeText(candidate.end) },
  ];
}

function candidatesFor(settings: Settings): Candidate[] {
  const start = parseTime(settings.start)!;
  const end = parseTime(settings.end)!;
  const breakStart = settings.useBreak ? parseTime(settings.breakStart)! : 0;
  const breakEnd = settings.useBreak ? parseTime(settings.breakEnd)! : 0;
  const range = settings.variable ? settings.variationMinutes : 0;
  const candidates: Candidate[] = [];
  for (let begin = Math.max(0, start - range); begin <= Math.min(1439, start + range); begin++) {
    for (let finish = Math.max(0, end - range); finish <= Math.min(1439, end + range); finish++) {
      if (begin >= finish || (settings.useBreak && (begin >= breakStart || finish <= breakEnd))) continue;
      candidates.push({ start: begin, end: finish, minutes: finish - begin - (breakEnd - breakStart) });
    }
  }
  return candidates;
}

function canonical(entries: AttendanceEntry[]): string {
  return JSON.stringify(entries.map(entry => ({
    type: entry.type, start: entry.start, end: entry.end,
    note: entry.note ?? '', reason: entry.reason ?? '', metadata: [...(entry.metadata ?? [])].sort(),
  })).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.type.localeCompare(b.type)));
}

function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

function randomFor(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let step = Math.imul(value ^ (value >>> 15), value | 1);
    step ^= step + Math.imul(step ^ (step >>> 7), step | 61);
    return ((step ^ (step >>> 14)) >>> 0) / 4294967296;
  };
}

function allocateDurations(count: number, target: number, durations: number[], random: () => number): number[] | null {
  if (!count) return target === 0 ? [] : null;
  const min = durations[0];
  const max = durations[durations.length - 1];
  if (target < min * count || target > max * count) return null;
  const allocated: number[] = [];
  let remaining = target;
  for (let index = 0; index < count; index++) {
    const left = count - index - 1;
    const valid = durations.filter(duration => remaining - duration >= min * left && remaining - duration <= max * left);
    if (!valid.length) return null;
    const unused = valid.filter(duration => !allocated.includes(duration));
    const pool = unused.length ? unused : valid;
    const selected = pool[Math.floor(random() * pool.length)];
    allocated.push(selected);
    remaining -= selected;
  }
  // Avoid an accidentally flat week whenever the permitted range allows it.
  if (allocated.length > 1 && new Set(allocated).size === 1) {
    const current = allocated[0];
    if (durations.includes(current - 1) && durations.includes(current + 1)) {
      allocated[0]--;
      allocated[1]++;
    }
  }
  return allocated;
}

export function buildMonthPlan(settings: Settings, snapshot: MonthSnapshot, choices: ConflictChoices = {}, seed = 73129): BookingPlan {
  const safeSettings: Settings = { ...settings, excludedDates: [...settings.excludedDates], localHolidays: { ...settings.localHolidays } };
  const errors = validateSettings(settings);
  if (snapshot.source === 'hibob' && !isReviewableContext(snapshot.context)) {
    errors.push(snapshot.context?.mode === 'unavailable' ? snapshot.context.reason : t('Der HiBob-Seitenkontext ist nicht zuverlässig lesbar. Bitte den Monat erneut einlesen.'));
  }
  if (snapshot.month !== settings.month) errors.push(t('Der gelesene HiBob-Monat stimmt nicht mit dem ausgewählten Monat überein. Bitte neu einlesen.'));
  const dates = getMonthDates(settings.month);
  const byDate = new Map(snapshot.days.map(day => [day.date, day]));
  if (byDate.size !== snapshot.days.length) errors.push(t('Die HiBob-Daten enthalten doppelte Tagesdatensätze. Bitte neu einlesen.'));
  const holidays = getHolidays(settings);
  const excluded = new Set(settings.excludedDates);
  const settingsValid = validateSettings(settings).length === 0;
  const candidates = settingsValid ? candidatesFor(settings) : [];
  const baseCandidate = settingsValid ? { start: parseTime(settings.start)!, end: parseTime(settings.end)!, minutes: parseTime(settings.end)! - parseTime(settings.start)! - (settings.useBreak ? parseTime(settings.breakEnd)! - parseTime(settings.breakStart)! : 0) } : null;
  const random = randomFor(seed);
  const days: DayPlan[] = dates.map(date => {
    const existingDay = byDate.get(date);
    const existing = existingDay?.entries ?? [];
    const existingNetMinutes = netMinutes(existing);
    const result: DayPlan = { date, existing, proposed: [], action: 'skip', netMinutes: 0, existingNetMinutes, fingerprint: existingDay?.fingerprint ?? '', eligible: false };
    let reason: string | undefined;
    if (weekday(date) === 0 || weekday(date) === 6) reason = t('Wochenende');
    else if (holidays[date]) { reason = t('Feiertag: {name}', { name: holidays[date] }); result.holiday = holidays[date]; }
    else if (excluded.has(date)) reason = t('Manuell ausgeschlossen');
    else if (!existingDay) {
      reason = t('Keine zuverlässig gelesenen HiBob-Daten');
      result.eligible = true;
      result.action = 'blocked';
      result.netMinutes = null;
      errors.push(t('{date}: {reason}.', { date, reason }));
    }
    else if (existingDay.absence) reason = t('Abwesenheit: {name}', { name: existingDay.absence });
    else if (existingDay.nonWorking) reason = existingDay.nonWorking;
    if (reason) { result.reason = reason; return result; }
    if (!existingDay) return result;
    // An unreadable selected day is a blocking issue. It must not silently
    // remove eight hours from a variable week's target.
    const reported = existingDay.reportedMinutes;
    const hoursIssue = snapshot.source === 'hibob' && (typeof reported !== 'number' || !Number.isInteger(reported) || reported < 0 || reported !== existingNetMinutes)
      ? t('Die gemeldeten HiBob-Stunden stimmen nicht mit den vollständigen Einträgen überein.') : undefined;
    const issue = existingDay.unsupportedReason || hoursIssue;
    if (issue) {
      result.eligible = true;
      result.action = 'blocked';
      result.netMinutes = null;
      result.existingNetMinutes = null;
      result.reason = issue;
      errors.push(t('{date}: {reason}. Bitte den Tag prüfen oder ausdrücklich ausschließen.', { date, reason: issue }));
      return result;
    }
    if (!existingDay.editable) { result.reason = t('HiBob-Zeitraum oder Tag ist nicht bearbeitbar'); return result; }
    result.eligible = true;
    result.proposed = baseCandidate ? entriesFor(settings, baseCandidate) : [];
    result.netMinutes = baseCandidate?.minutes ?? null;
    if (existing.length) {
      const choice = choices[date];
      result.action = choice === 'skip' ? 'skip' : choice === 'overwrite' ? 'overwrite' : 'conflict';
      if (choice === 'skip') {
        result.reason = t('Vorhandene Buchung beibehalten');
        result.netMinutes = existingNetMinutes;
      }
    } else result.action = 'create';
    return result;
  });

  const weeks: WeekPlan[] = [...new Set(dates.map(weekStart))].map(week => {
    const weekDays = days.filter(day => weekStart(day.date) === week);
    const eligible = weekDays.filter(day => day.eligible);
    const targetMinutes = eligible.length * (settings.variable ? 480 : baseCandidate?.minutes ?? 0);
    const weekErrors: string[] = [];
    if (settings.variable && settingsValid) {
      const retained = eligible.filter(day => day.action === 'skip');
      const editable = eligible.filter(day => day.action !== 'skip' && day.action !== 'blocked');
      if (eligible.some(day => day.action === 'blocked') || retained.some(day => day.existingNetMinutes === null)) {
        weekErrors.push(t('Beibehaltene unvollständige Buchungen verhindern eine verlässliche 40-Stunden-Berechnung.'));
      } else {
        const retainedMinutes = retained.reduce((sum, day) => sum + (day.existingNetMinutes ?? 0), 0);
        const durations = [...new Set(candidates.map(candidate => candidate.minutes))].sort((a, b) => a - b);
        const assigned = durations.length ? allocateDurations(editable.length, targetMinutes - retainedMinutes, durations, random) : null;
        if (!assigned) weekErrors.push(t('Das Ziel von {target} ist mit diesen Zeitgrenzen und beibehaltenen Buchungen nicht erreichbar.', { target: formatMinutes(targetMinutes) }));
        else editable.forEach((day, index) => {
          const matching = candidates.filter(candidate => candidate.minutes === assigned[index]);
          const candidate = matching[Math.floor(random() * matching.length)];
          day.proposed = entriesFor(settings, candidate);
          day.netMinutes = candidate.minutes;
        });
      }
    }
    for (const day of eligible) {
      if (day.action === 'overwrite' && canonical(day.existing) === canonical(day.proposed)) {
        day.action = 'unchanged';
        day.reason = t('Vorhandene Buchung entspricht bereits den vorgesehenen Zeiten');
      }
    }
    const plannedMinutes = eligible.some(day => day.netMinutes === null) ? null : eligible.reduce((total, day) => total + (day.netMinutes ?? 0), 0);
    for (const error of weekErrors) errors.push(t('Woche ab {week}: {error}', { week, error }));
    return { week, dates: weekDays.map(day => day.date), targetMinutes, plannedMinutes, errors: weekErrors };
  });
  if (days.some(day => day.action === 'conflict')) errors.push(t('Bitte für alle vorhandenen Buchungen Überschreiben oder Überspringen wählen.'));
  if (!days.some(day => day.eligible)) errors.push(t('In diesem Monat stehen keine bearbeitbaren Arbeitstage zur Verfügung.'));
  const uniqueErrors = [...new Set(errors)];
  const id = `plan-${hash(canonicalJson({ settings: safeSettings, context: snapshot.context ?? null, fingerprints: days.map(day => [day.date, day.fingerprint]), choices, seed })!)}`;
  return { id, seed, settings: safeSettings, snapshot, choices: { ...choices }, days, weeks, errors: uniqueErrors, canReview: uniqueErrors.length === 0 && days.some(day => day.action === 'create' || day.action === 'overwrite') };
}
