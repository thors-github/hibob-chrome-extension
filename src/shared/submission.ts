import { canonicalJson } from './json';
import type { TimesheetStatus } from './types';

export const TIMESHEET_STATUSES: readonly TimesheetStatus[] = ['Open', 'WaitingForSubmission', 'Rejected', 'Submitted', 'PendingProjectApproval', 'Approved', 'Locked', 'unknown'];
export function isSubmittedStatus(status: TimesheetStatus): boolean { return ['Submitted', 'PendingProjectApproval', 'Approved'].includes(status); }
export async function submissionHash(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value) ?? 'null');
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Stable local scope without persisting clear account identifiers or credentials. */
export function submissionAccountKey(identity: { employeeId: string; companyId: string }): Promise<string>;
export function submissionAccountKey(employeeId: string, companyId: string): Promise<string>;
export function submissionAccountKey(value: string | { employeeId: string; companyId: string }, companyId?: string): Promise<string> {
  const identity = typeof value === 'string' ? { employeeId: value, companyId: companyId! } : value;
  return submissionHash({ employeeId: identity.employeeId, companyId: identity.companyId });
}
