import { afterEach, describe, expect, it, vi } from 'vitest';
import { language, locale, t } from '../src/i18n';
import { buildMonthPlan, defaultSettings, formatMinutes, getHolidays, getMonthDates, validateSettings } from '../src/domain';
import type { MonthSnapshot } from '../src/shared/types';

function browserLanguage(tag: string, navigatorLanguage = tag): void {
  vi.stubGlobal('chrome', { i18n: { getUILanguage: () => tag } });
  vi.stubGlobal('navigator', { language: navigatorLanguage, languages: [navigatorLanguage] });
}

function snapshot(month: string): MonthSnapshot {
  return {
    month, employeeLabel: 'Testperson – nicht übersetzen', periodLabel: month,
    scannedAt: '2026-11-01T08:00:00Z', source: 'demo',
    days: getMonthDates(month).map(date => ({ date, entries: [], editable: true, fingerprint: `${date}:empty` })),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser language selection', () => {
  it.each(['de-DE', 'de-AT', 'de-CH', 'de'])('uses German and de-DE formatting for %s', tag => {
    browserLanguage(tag, 'en-US');
    expect(language()).toBe('de');
    expect(locale()).toBe('de-DE');
    expect(formatMinutes(null)).toBe('Unvollständig');
  });

  it.each(['en-US', 'en-GB', 'en', 'fr-FR'])('uses English and en-GB formatting for %s', tag => {
    browserLanguage(tag, 'de-DE');
    expect(language()).toBe('en');
    expect(locale()).toBe('en-GB');
    expect(formatMinutes(null)).toBe('Incomplete');
  });

  it('uses navigator.language in the browser preview when Chrome APIs are unavailable', () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('navigator', { language: 'de-AT', languages: ['de-AT'] });
    expect(language()).toBe('de');
    vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR'] });
    expect(language()).toBe('en');
  });

  it('falls back to English if browser language information is missing', () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('navigator', undefined);
    expect(language()).toBe('en');
    expect(locale()).toBe('en-GB');
  });
});

describe('localized presentation with unchanged attendance data', () => {
  it('formats month and day labels with the selected locale without shifting civil dates', () => {
    const civilDate = new Date(Date.UTC(2026, 2, 29, 12));
    browserLanguage('de-DE');
    expect(new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(civilDate)).toBe('März 2026');
    expect(new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(civilDate)).toContain('Sonntag');
    const germanDates = getMonthDates('2026-03');
    browserLanguage('en-US');
    expect(new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(civilDate)).toBe('March 2026');
    expect(new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(civilDate)).toContain('Sunday');
    expect(getMonthDates('2026-03')).toEqual(germanDates);
    expect(germanDates[28]).toBe('2026-03-29');
    expect(formatMinutes(485)).toBe('8 h 05 min');
    expect(formatMinutes(-5)).toBe('−0 h 05 min');
  });

  it('translates holiday names and regional Corpus Christi while preserving date keys', () => {
    const settings = defaultSettings('2026-12');
    browserLanguage('de-DE');
    const german = getHolidays(settings);
    expect(german['2026-12-25']).toBe('1. Weihnachtstag');
    browserLanguage('en-GB');
    const english = getHolidays(settings);
    expect(english['2026-12-25']).toBe('Christmas Day');
    expect(Object.keys(english)).toEqual(Object.keys(german));
    const regional = { ...settings, state: 'SN', localHolidays: { ...settings.localHolidays, corpusChristi: true } };
    expect(getHolidays(regional)['2026-06-04']).toBe('Corpus Christi');
    browserLanguage('de-CH');
    expect(getHolidays(regional)['2026-06-04']).toBe('Fronleichnam');
  });

  it('translates federal-state display names without changing state codes', () => {
    browserLanguage('en-GB');
    expect(t('Bayern')).toBe('Bavaria');
    expect(t('Hessen')).toBe('Hesse');
    expect(t('Nordrhein-Westfalen')).toBe('North Rhine-Westphalia');
    expect(defaultSettings('2026-11').state).toBe('HE');
    browserLanguage('de-AT');
    expect(t('Hessen')).toBe('Hessen');
    expect(defaultSettings('2026-11').state).toBe('HE');
  });

  it('localizes validation, day reasons and week errors including interpolation', () => {
    browserLanguage('en-GB');
    const settings = { ...defaultSettings('2026-11'), state: '', excludedDates: ['bad-date'] };
    const errors = validateSettings(settings);
    expect(errors).toContain(t('Bitte ein deutsches Bundesland wählen.'));
    expect(errors.join(' ')).not.toContain('Bitte');
    expect(errors.join(' ')).not.toContain('Ungültiger');
    expect(errors.join(' ')).toContain('bad-date');
    expect(errors.join(' ')).not.toContain('{date}');

    const fixed = defaultSettings('2026-11');
    const source = snapshot(fixed.month);
    source.days.find(day => day.date === '2026-11-03')!.absence = 'Urlaub der Testperson';
    const plan = buildMonthPlan(fixed, source);
    expect(plan.days.find(day => day.date === '2026-11-01')!.reason).toBe('Weekend');
    expect(plan.days.find(day => day.date === '2026-11-03')!.reason).toContain('Urlaub der Testperson');
    expect(plan.days.find(day => day.date === '2026-11-03')!.reason).not.toContain('Abwesenheit');
    const impossible = buildMonthPlan({ ...fixed, variable: true, end: '15:30', variationMinutes: 0 }, source);
    expect(impossible.canReview).toBe(false);
    expect(impossible.errors.join(' ')).not.toContain('Woche ab');
    expect(impossible.errors.join(' ')).not.toContain('Das Ziel');
    expect(impossible.errors.join(' ')).not.toMatch(/\{(?:week|error|target)\}/);
    expect(impossible.errors.join(' ')).toContain('2026-11-02');
  });

  it('keeps seeds, plan ids, fingerprints, user notes and weekly numeric totals language independent', () => {
    const settings = { ...defaultSettings('2026-11'), variable: true, variationMinutes: 5 };
    const source = snapshot(settings.month);
    source.days.find(day => day.date === '2026-11-02')!.entries = [{ type: 'work', start: '08:00', end: '16:00', note: 'Mein eigener Vermerk' }];
    const choices = { '2026-11-02': 'skip' as const };
    const before = JSON.stringify(source);
    browserLanguage('de-DE');
    const german = buildMonthPlan(settings, source, choices, 1729);
    browserLanguage('en-US');
    const english = buildMonthPlan(settings, source, choices, 1729);
    expect(english.id).toBe(german.id);
    expect(english.seed).toBe(german.seed);
    expect(english.settings).toEqual(german.settings);
    expect(english.days.map(day => [day.date, day.fingerprint, day.proposed, day.netMinutes])).toEqual(german.days.map(day => [day.date, day.fingerprint, day.proposed, day.netMinutes]));
    expect(english.weeks.map(week => [week.week, week.targetMinutes, week.plannedMinutes])).toEqual(german.weeks.map(week => [week.week, week.targetMinutes, week.plannedMinutes]));
    expect(english.weeks.every(week => week.targetMinutes === week.plannedMinutes)).toBe(true);
    expect(english.days.find(day => day.date === '2026-11-02')!.existing[0].note).toBe('Mein eigener Vermerk');
    expect(JSON.stringify(source)).toBe(before);
    expect(english.snapshot.employeeLabel).toBe('Testperson – nicht übersetzen');
  });
});
