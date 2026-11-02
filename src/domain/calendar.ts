import Holidays from 'date-holidays-parser';
import germanHolidayData from './holidays-de.json';
import type { Settings } from '../shared/types';
import { language, t } from '../i18n';

export const GERMAN_STATES = [
  { code: 'BW', name: 'Baden-Württemberg' },
  { code: 'BY', name: 'Bayern' },
  { code: 'BE', name: 'Berlin' },
  { code: 'BB', name: 'Brandenburg' },
  { code: 'HB', name: 'Bremen' },
  { code: 'HH', name: 'Hamburg' },
  { code: 'HE', name: 'Hessen' },
  { code: 'MV', name: 'Mecklenburg-Vorpommern' },
  { code: 'NI', name: 'Niedersachsen' },
  { code: 'NW', name: 'Nordrhein-Westfalen' },
  { code: 'RP', name: 'Rheinland-Pfalz' },
  { code: 'SL', name: 'Saarland' },
  { code: 'SN', name: 'Sachsen' },
  { code: 'ST', name: 'Sachsen-Anhalt' },
  { code: 'SH', name: 'Schleswig-Holstein' },
  { code: 'TH', name: 'Thüringen' },
] as const;

export function parseMonth(month: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  return year >= 1900 && year <= 2100 && monthNumber >= 1 && monthNumber <= 12
    ? { year, month: monthNumber }
    : null;
}

function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// UTC is used only as an arithmetic calendar, never to convert attendance times.
export function getMonthDates(month: string): string[] {
  const parsed = parseMonth(month);
  if (!parsed) return [];
  const lastDay = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  return Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function weekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekStart(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  calendar.setUTCDate(calendar.getUTCDate() - ((calendar.getUTCDay() + 6) % 7));
  return dateKey(calendar);
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export function getHolidays(settings: Settings): Record<string, string> {
  const parsed = parseMonth(settings.month);
  if (!parsed || !GERMAN_STATES.some(state => state.code === settings.state)) return {};
  const local = settings.localHolidays;
  const region = settings.state === 'BY'
    ? local.augsburg === true ? 'A' : local.assumption === true ? 'KATH' : 'EVANG'
    : undefined;
  const calendar = region ? new Holidays(germanHolidayData, 'DE', settings.state, region) : new Holidays(germanHolidayData, 'DE', settings.state);
  calendar.setLanguages(language());
  calendar.setTimezone('Europe/Berlin');
  const dates: Record<string, string> = {};
  for (const holiday of calendar.getHolidays(parsed.year)) {
    if (holiday.type === 'public') dates[holiday.date.slice(0, 10)] = holiday.name;
  }
  // County-level library regions include only selected municipalities. Ask the
  // user explicitly instead of treating the entire county as a holiday region.
  if ((settings.state === 'SN' || settings.state === 'TH') && local.corpusChristi === true) {
    const corpusChristi = easterSunday(parsed.year);
    corpusChristi.setUTCDate(corpusChristi.getUTCDate() + 60);
    dates[dateKey(corpusChristi)] = t('Fronleichnam');
  }
  return dates;
}

export function defaultSettings(month?: string): Settings {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const currentMonth = `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
  return {
    month: month ?? currentMonth,
    state: 'HE', start: '08:00', end: '16:30',
    useBreak: true, breakStart: '12:00', breakEnd: '12:30',
    variable: false, variationMinutes: 5, excludedDates: [],
    localHolidays: { augsburg: null, assumption: null, corpusChristi: null },
  };
}
