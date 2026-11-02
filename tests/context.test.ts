import { describe, expect, it } from 'vitest';
import { assertApplyAuthorization, contextFingerprint, isReviewableContext } from '../src/shared/context';
import type { ApplyAuthorization, AttendanceContext } from '../src/shared/types';

const context: AttendanceContext = {
  mode: 'user-confirmed-ui', documentId: 'document-A',
  pageUrl: 'https://app.hibob.com/attendance/my-attendance', markerFingerprint: 'account-marker-A',
};
const authorize = (): ApplyAuthorization => ({
  planId: 'plan-A', planRevision: 12, contextFingerprint: contextFingerprint(context),
  confirmation: { planId: 'plan-A', planRevision: 12, contextFingerprint: contextFingerprint(context), confirmed: true },
});

describe('account context and per-plan authorization', () => {
  it('permits reviewing the manual context without treating it as an employee identity', () => {
    expect(isReviewableContext(context)).toBe(true);
    expect(context).not.toHaveProperty('employeeKey');
    expect(context).not.toHaveProperty('verified');
    const missingConsent = authorize();
    delete missingConsent.confirmation;
    expect(() => assertApplyAuthorization(context, missingConsent)).toThrow('bestätigen');
    expect(() => assertApplyAuthorization(context, authorize())).not.toThrow();
  });

  it.each(['planId', 'planRevision', 'contextFingerprint', 'confirmed'] as const)('rejects a stale or incomplete %s confirmation', field => {
    const authorization = authorize();
    Object.assign(authorization.confirmation!, { [field]: field === 'planRevision' ? 11 : field === 'confirmed' ? false : 'old-value' });
    expect(() => assertApplyAuthorization(context, authorization)).toThrow('bestätigen');
  });

  it('invalidates approval after a document, route or visible-account change', () => {
    for (const current of [
      { ...context, documentId: 'replacement-document' },
      { ...context, pageUrl: 'https://app.hibob.com/home' },
      { ...context, markerFingerprint: 'other-account' },
    ]) expect(() => assertApplyAuthorization(current, authorize())).toThrow();
  });

  it('does not admit legacy verification flags, missing markers or another attendance URL', () => {
    for (const value of [
      undefined, { documentId: 'old', verified: true, employeeKey: 'old-employee', tenantKey: 'old-tenant' },
      { ...context, markerFingerprint: '' }, { ...context, documentId: '' },
      { ...context, pageUrl: context.pageUrl + '?employee=other' },
      { mode: 'unavailable', documentId: 'doc', reason: 'Missing visible markers' },
    ]) expect(isReviewableContext(value)).toBe(false);
  });

  it('keeps comparison stable across Chrome key ordering, but not actual changes', () => {
    const reordered = JSON.parse(JSON.stringify(context, (_key, value) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(contextFingerprint(reordered)).toBe(contextFingerprint(context));
    expect(contextFingerprint({ ...context, documentId: 'other' })).not.toBe(contextFingerprint(context));
  });

  it('supports a real stable-identity provider without manufacturing manual employee IDs', () => {
    const stable: AttendanceContext = { mode: 'stable-identity', documentId: 'doc', employeeKey: 'employee', tenantKey: 'tenant' };
    const authorization = { planId: 'p', planRevision: 1, contextFingerprint: contextFingerprint(stable) };
    expect(() => assertApplyAuthorization(stable, authorization)).not.toThrow();
    expect(() => assertApplyAuthorization(context, authorization)).toThrow();
  });
});

describe('API session account context', () => {
  const api: AttendanceContext = { mode: 'api-session', connectionId: 'session-A', employeeKey: 'employee-A', tenantKey: 'company-A' };
  const approval = (): ApplyAuthorization => ({ planId: 'plan-A', planRevision: 1, contextFingerprint: contextFingerprint(api), confirmation: { planId: 'plan-A', planRevision: 1, contextFingerprint: contextFingerprint(api), confirmed: true } });
  it('uses observed account/session identity without requiring or manufacturing a browser document', () => {
    expect(isReviewableContext(api)).toBe(true);
    expect(api).not.toHaveProperty('documentId');
    expect(() => assertApplyAuthorization(api, approval())).not.toThrow();
    const missing = approval(); delete missing.confirmation;
    expect(() => assertApplyAuthorization(api, missing)).toThrow('bestätigen');
  });
  it.each(['connectionId', 'employeeKey', 'tenantKey'] as const)('rejects missing or changed %s before authorization', key => {
    expect(isReviewableContext({ ...api, [key]: '' })).toBe(false);
    expect(() => assertApplyAuthorization({ ...api, [key]: 'changed' }, approval())).toThrow();
  });
});
