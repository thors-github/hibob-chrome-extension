import { t } from '../i18n';
import { canonicalJson } from './json';
import type { ApplyAuthorization, AttendanceContext } from './types';

const OWN_ATTENDANCE_URL = 'https://app.hibob.com/attendance/my-attendance';
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** A comparison value, not a credential or a claim of immutable employee identity. */
export function contextFingerprint(context: AttendanceContext | undefined): string {
  return canonicalJson(context ?? null)!;
}

export function isReviewableContext(value: unknown): value is AttendanceContext & { mode: 'api-session' | 'stable-identity' | 'user-confirmed-ui' } {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  if (context.mode === 'api-session') return nonempty(context.connectionId) && nonempty(context.employeeKey) && nonempty(context.tenantKey);
  if (!nonempty(context.documentId)) return false;
  if (context.mode === 'stable-identity') return nonempty(context.employeeKey) && nonempty(context.tenantKey);
  return context.mode === 'user-confirmed-ui' && context.pageUrl === OWN_ATTENDANCE_URL && nonempty(context.markerFingerprint);
}

/** Every writer validates the same context and the manual consent supplied by the controller. */
export function assertApplyAuthorization(context: AttendanceContext | undefined, authorization: ApplyAuthorization | undefined): void {
  if (!isReviewableContext(context)) throw new Error(t('Der HiBob-Seitenkontext ist nicht zuverlässig lesbar. Bitte den Monat erneut einlesen.'));
  if (!authorization || !nonempty(authorization.planId) || !Number.isSafeInteger(authorization.planRevision) || authorization.planRevision < 0 || authorization.contextFingerprint !== contextFingerprint(context)) {
    throw new Error(t('Die Buchungsfreigabe gehört nicht zur aktuellen Vorschau oder Browserseite. Bitte erneut prüfen.'));
  }
  const confirmation = authorization.confirmation;
  if (context.mode === 'api-session' || context.mode === 'user-confirmed-ui' || confirmation !== undefined) {
    if (!confirmation || confirmation.confirmed !== true || confirmation.planId !== authorization.planId || confirmation.planRevision !== authorization.planRevision || confirmation.contextFingerprint !== authorization.contextFingerprint) {
      throw new Error(t('Bitte das eigene HiBob-Konto für diese Vorschau ausdrücklich bestätigen.'));
    }
  }
}
