import type { AttendanceEntry } from './types';

export function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

/** Net work minutes, including breaks that overlap a continuous work interval. */
export function netMinutes(entries: AttendanceEntry[]): number | null {
  if (!entries.length) return 0;
  const work: Array<[number, number]> = [];
  const breaks: Array<[number, number]> = [];
  for (const entry of entries) {
    if (entry.type !== 'work' && entry.type !== 'break') return null;
    const start = parseTime(entry.start);
    const end = parseTime(entry.end);
    if (start === null || end === null || start >= end) return null;
    (entry.type === 'work' ? work : breaks).push([start, end]);
  }
  if (!work.length) return null;
  for (const intervals of [work, breaks]) {
    intervals.sort((a, b) => a[0] - b[0]);
    if (intervals.some((interval, index) => index > 0 && interval[0] < intervals[index - 1][1])) return null;
  }
  if (breaks.some(([start, end]) => start < work[0][0] || end > work[work.length - 1][1])) return null;
  const gross = work.reduce((total, [start, end]) => total + end - start, 0);
  const overlap = work.reduce((total, [workStart, workEnd]) => total + breaks.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(workEnd, end) - Math.max(workStart, start)), 0), 0);
  return gross - overlap;
}
