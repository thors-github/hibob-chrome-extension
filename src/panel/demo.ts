import type { AttendanceEntry, MonthSnapshot, Settings } from '../shared/types';
import { t } from '../i18n/index';

const fingerprint = (date: string, entries: AttendanceEntry[]) => JSON.stringify({ date, entries });

/** An explicitly local fixture. This module never contacts HiBob. */
export function createDemoSnapshot(settings: Settings): MonthSnapshot {
  const [year, month] = settings.month.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekdays: string[] = [];
  const days = Array.from({ length: last }, (_, index) => {
    const date = `${settings.month}-${String(index + 1).padStart(2, '0')}`;
    const weekDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekDay !== 0 && weekDay !== 6) weekdays.push(date);
    return {
      date,
      entries: [] as AttendanceEntry[],
      editable: true,
      nonWorking: weekDay === 0 || weekDay === 6 ? t('Arbeitsfreier Tag') : undefined,
      fingerprint: fingerprint(date, []),
    };
  });
  for (const [index, date] of weekdays.slice(0, 2).entries()) {
    const day = days.find((item) => item.date === date)!;
    day.entries = [
      { type: 'work', start: '08:00', end: '12:00', ...(index === 0 ? { note: t('Beispielnotiz aus der Testoberfläche') } : {}) },
      { type: 'break', start: '12:00', end: '12:30' },
      { type: 'work', start: '12:30', end: '16:30' },
    ];
    day.fingerprint = fingerprint(date, day.entries);
  }
  if (weekdays[4]) Object.assign(days.find((day) => day.date === weekdays[4])!, { absence: t('Urlaub (Testdaten)') });
  return {
    month: settings.month,
    employeeLabel: t('Alex Beispiel · Testkonto'),
    periodLabel: t('{month} · lokale Testdaten', { month: settings.month }),
    scannedAt: new Date().toISOString(),
    source: 'demo',
    days,
  };
}

export function demoFingerprint(date: string, entries: AttendanceEntry[]): string {
  return fingerprint(date, entries);
}
