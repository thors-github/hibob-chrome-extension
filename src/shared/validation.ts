import { t } from '../i18n/index';
import type { BookingPlan } from './types';

export const HIBOB_ORIGIN = 'https://app.hibob.com';
export const HIBOB_ATTENDANCE_PATH = '/attendance/my-attendance';

export function isHiBobAttendance(url?: string): boolean {
  if (!url) return false;
  try { const u = new URL(url); return u.origin === HIBOB_ORIGIN && u.pathname.replace(/\/$/, '') === HIBOB_ATTENDANCE_PATH; } catch { return false; }
}

export function isHiBobOrigin(url?: string): boolean {
  try { return !!url && new URL(url).origin === HIBOB_ORIGIN; } catch { return false; }
}

export function assertWritablePlan(plan: BookingPlan): void {
  if (!plan || !plan.canReview || plan.errors.length || plan.days.some(d => d.action === 'conflict' || d.action === 'blocked') || plan.weeks.some(w => w.errors.length)) throw new Error(t('Die Vorschau enthält noch offene Konflikte oder Fehler.'));
  if (plan.snapshot.source !== 'hibob') throw new Error(t('Testdaten dürfen nicht an HiBob gesendet werden.'));
  if (!plan.days.some(d => d.action === 'create' || d.action === 'overwrite')) throw new Error(t('Es sind keine Änderungen ausgewählt.'));
  const seen = new Set<string>();
  for (const day of plan.days) {
    if (seen.has(day.date) || !day.date.startsWith(`${plan.settings.month}-`)) throw new Error(t('Ungültige Tageszuordnung im Buchungsplan.'));
    seen.add(day.date);
    if ((day.action === 'create' || day.action === 'overwrite') && (!day.eligible || !day.proposed.length)) throw new Error(t('Ein ausgeschlossener oder leerer Tag darf nicht geschrieben werden.'));
    if (day.action === 'overwrite' && plan.choices[day.date] !== 'overwrite') throw new Error(t('Überschreiben wurde nicht bestätigt.'));
  }
}
