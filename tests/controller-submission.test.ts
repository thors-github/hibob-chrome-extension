import { describe, expect, it, vi } from 'vitest';
import { BookingController, type ControllerBridge } from '../src/controller';
import { defaultSettings, buildMonthPlan, getMonthDates } from '../src/domain';
import { submissionAccountKey } from '../src/shared/submission';
import type { ApiConnection, SubmissionConsent, SubmissionReview, SubmissionJournal, SessionState } from '../src/shared/types';

const connection = (): ApiConnection => ({ status: 'connected', generation: 'submission-session', employeeId: 'self-fixture', companyId: 'company-fixture', employeeLabel: 'Local employee', companyLabel: 'Local company', transport: 'direct', capabilities: { read: true, write: true, overwrite: true } });
const consent = (state: SessionState): SubmissionConsent => {
  const review = state.submissionReview!;
  return { reviewId: review.id, reviewRevision: state.submissionRevision!, connectionId: review.connectionId, accountKey: review.accountKey, contentFingerprint: review.contentFingerprint, eligibilityFingerprint: review.eligibilityFingerprint, confirmed: true };
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
async function fixture(initial?: SessionState, savedJournal?: SubmissionJournal) {
  let stored = structuredClone(initial); let journal = structuredClone(savedJournal); let writes = 0;
  const key = await submissionAccountKey(connection().employeeId!, connection().companyId!);
  const review: SubmissionReview = { id: 'review-one', month: '2026-11', connectionId: connection().generation, accountKey: key, employeeLabel: 'Local employee', companyLabel: 'Local company', period: { id: 123, start: '2026-11-01', end: '2026-11-30', status: 'WaitingForSubmission', locked: false }, contentFingerprint: 'a'.repeat(64), eligibilityFingerprint: 'b'.repeat(64), netMinutes: 10080, issues: [], canSubmit: true, early: false, checkedAt: '2026-12-01T12:00:00Z' };
  const bridge: ControllerBridge = {
    load: async () => stored,
    save: vi.fn(async state => { stored = structuredClone(state); }),
    loadSubmissionJournal: vi.fn(async accountKey => accountKey === journal?.accountKey ? journal : undefined),
    saveSubmissionJournal: vi.fn(async value => { journal = structuredClone(value); }),
    scan: vi.fn(), applyDay: vi.fn(), preflightDay: vi.fn(), cancel: vi.fn(async () => {}),
    reviewSubmission: vi.fn(async (_connection, month) => ({ ...structuredClone(review), month, period: { ...review.period, start: `${month}-01`, end: getMonthDates(month).at(-1)! } })),
    submitMonth: vi.fn(async (_connection, checked, _consent, hooks) => {
      await hooks.beforeDispatch();
      expect(journal?.status).toBe('dispatching'); expect(stored?.submissionJournal?.status).toBe('dispatching');
      writes++; await hooks.acknowledged();
      return { month: checked.month, status: 'verified' as const, periodStatus: 'Submitted' as const, message: 'Independent fixture readback' };
    }),
    listSubmissionStatuses: vi.fn(async () => ({ accountKey: key, periods: [], checkedAt: '2026-12-01T12:00:00Z' })),
  };
  const controller = new BookingController(bridge); await controller.init();
  if (!initial) await controller.bindConnection(connection());
  const inspect = async (month = '2026-11') => { const state = await controller.reviewSubmission(month); return { state, approval: consent(state) }; };
  const send = (approval: SubmissionConsent) => controller.submitMonth(approval.reviewId, approval.reviewRevision, approval);
  return { controller, bridge, review, inspect, send, writes: () => writes, stored: () => stored, journal: () => journal, key };
}

describe('separate consent and durable month-submission lifecycle', () => {
  it('requires fresh explicit scoped consent and journals before exactly one Submit', async () => {
    const app = await fixture(); const { state, approval } = await app.inspect();
    await expect(app.controller.submitMonth(state.submissionReview!.id, state.submissionRevision!)).rejects.toThrow('bestätigen');
    expect(app.bridge.submitMonth).not.toHaveBeenCalled();
    const done = await app.send(approval);
    expect(app.writes()).toBe(1); expect(done.submissionResult?.status).toBe('verified');
    expect(app.journal()?.status).toBe('verified'); expect(done.submissionReview).toBeUndefined(); expect(done.job).toBeUndefined();
    await expect(app.send(approval)).rejects.toThrow('freigegeben'); expect(app.writes()).toBe(1);
  });
  it.each(['reviewId', 'reviewRevision', 'connectionId', 'accountKey', 'contentFingerprint', 'eligibilityFingerprint', 'confirmed'] as const)('rejects a changed %s scope with zero writes', async field => {
    const app = await fixture(); const { approval } = await app.inspect();
    await expect(app.send({ ...approval, [field]: field === 'reviewRevision' ? approval.reviewRevision - 1 : field === 'confirmed' ? false : 'different' } as SubmissionConsent)).rejects.toThrow();
    expect(app.bridge.submitMonth).not.toHaveBeenCalled(); expect(app.writes()).toBe(0);
  });
  it('rejects modified review state, reopening and fresh scans', async () => {
    const app = await fixture(); let { approval } = await app.inspect();
    app.controller.state.submissionReview!.netMinutes = 1;
    await expect(app.send(approval)).rejects.toThrow('freigegeben');
    ({ approval } = await app.inspect()); await app.controller.dismissSubmission();
    await expect(app.send(approval)).rejects.toThrow('freigegeben');
    ({ approval } = await app.inspect()); await app.controller.invalidatePlan(app.controller.state.planRevision!, 'settings-change');
    await expect(app.send(approval)).rejects.toThrow('freigegeben'); expect(app.writes()).toBe(0);
  });
  it('does not restore consent or a review on worker restart', async () => {
    const app = await fixture(); const { approval } = await app.inspect();
    const next = await fixture(app.stored());
    expect(next.controller.state.submissionReview).toBeUndefined();
    await expect(next.send(approval)).rejects.toThrow('freigegeben'); expect(next.writes()).toBe(0);
  });
  it('keeps the exclusive read lock and discards a review closed before its response', async () => {
    const app = await fixture(); const held = deferred<SubmissionReview>();
    vi.mocked(app.bridge.reviewSubmission!).mockReturnValueOnce(held.promise);
    const pending = app.controller.reviewSubmission('2026-11');
    await vi.waitFor(() => expect(app.bridge.reviewSubmission).toHaveBeenCalled());
    await expect(app.controller.reviewSubmission('2026-11')).rejects.toThrow('läuft bereits');
    await expect(app.controller.bindConnection({ ...connection(), employeeId: 'other' })).rejects.toThrow('läuft bereits');
    await app.controller.dismissSubmission(); held.resolve(app.review);
    await expect(pending).rejects.toThrow('abgebrochen');
    expect(app.controller.state.job).toBeUndefined(); expect(app.controller.state.submissionReview).toBeUndefined(); expect(app.controller.isBusy()).toBe(false);
  });
  it('blocks pending plan edits but allows a terminal month to be inspected', async () => {
    const app = await fixture(); const snapshot = { month: '2026-11', employeeLabel: 'Local employee', periodLabel: 'November', source: 'hibob' as const, scannedAt: '2026-12-01T12:00:00Z', context: { mode: 'api-session' as const, connectionId: connection().generation, employeeKey: connection().employeeId!, tenantKey: connection().companyId! }, days: getMonthDates('2026-11').map(date => ({ date, entries: [], editable: true, reportedMinutes: 0, fingerprint: date })) };
    app.controller.state.plan = buildMonthPlan(defaultSettings('2026-11'), snapshot, {}, 1);
    const { state, approval } = await app.inspect();
    expect(state.submissionReview?.canSubmit).toBe(false); expect(state.submissionReview?.issues.join()).toContain('ungespeicherte');
    await expect(app.send(approval)).rejects.toThrow();
    app.review.period.status = 'Approved'; app.review.canSubmit = false;
    const terminal = await app.inspect(); expect(terminal.state.submissionReview?.period.status).toBe('Approved'); expect(app.writes()).toBe(0);
  });
  it('never dispatches when the durable pre-dispatch journal fails', async () => {
    const app = await fixture(); const { approval } = await app.inspect();
    vi.mocked(app.bridge.saveSubmissionJournal!).mockRejectedValue(new Error('Fixture journal failure'));
    await expect(app.send(approval)).rejects.toThrow('journal failure');
    expect(app.writes()).toBe(0); expect(app.controller.state.submissionResult?.status).toBe('failed'); expect(app.controller.state.job).toBeUndefined();
  });
  it('retains an uncertain sent request on restart and never replays Submit', async () => {
    const app = await fixture(); const { approval } = await app.inspect();
    vi.mocked(app.bridge.submitMonth!).mockImplementationOnce(async (_c, _r, _a, hooks) => { await hooks.beforeDispatch(); throw new Error('Fixture connection lost after send'); });
    await expect(app.send(approval)).rejects.toThrow('lost after send');
    expect(app.controller.state.submissionResult?.status).toBe('uncertain');
    const pending = { ...app.journal()!, status: 'awaiting-verification' as const };
    const next = await fixture(app.stored(), pending);
    expect(next.journal()?.status).toBe('uncertain'); expect(next.controller.state.submissionResult?.status).toBe('uncertain');
    expect(next.bridge.submitMonth).not.toHaveBeenCalled();
    await next.inspect(); expect(next.controller.state.submissionResult?.status).toBe('failed'); expect(next.journal()?.status).toBe('failed');
  });
  it('retains uncertainty for an unrecognized status and ignores a stale dialog dismissal', async () => {
    const app = await fixture(); const journal: SubmissionJournal = { jobId: 'prior', reviewId: 'prior', accountKey: app.key, month: '2026-11', status: 'uncertain', updatedAt: '2026-11-01T12:00:00Z' };
    const next = await fixture({ schemaVersion: 7, connection: connection() }, journal);
    next.review.period.status = 'unknown'; next.review.canSubmit = false;
    await next.inspect(); expect(next.controller.state.submissionResult?.status).toBe('uncertain'); expect(next.journal()?.status).toBe('uncertain');
    next.review.period.status = 'WaitingForSubmission'; next.review.canSubmit = true;
    const first = await next.inspect(); next.review.id = 'new-review'; const second = await next.inspect();
    await next.controller.dismissSubmission(first.approval.reviewId, first.approval.reviewRevision);
    expect(next.controller.state.submissionReview?.id).toBe(second.approval.reviewId);
    await next.controller.dismissSubmission(second.approval.reviewId, second.approval.reviewRevision);
    expect(next.controller.state.submissionReview).toBeUndefined();
  });
  it('revokes a review cancelled while its result is being persisted', async () => {
    const app = await fixture(); const entered = deferred<void>(), release = deferred<void>(); const original = app.bridge.save;
    app.bridge.save = vi.fn(async state => { if (state.submissionReview) { entered.resolve(); await release.promise; } await original(state); });
    const pending = app.controller.reviewSubmission('2026-11'); await entered.promise;
    await app.controller.cancel(app.controller.state.job!.id); release.resolve();
    await expect(pending).rejects.toThrow('abgebrochen'); expect(app.controller.state.submissionReview).toBeUndefined(); expect(app.writes()).toBe(0);
  });
  it('normalizes a durable pending journal loaded only after reconnecting with an empty session', async () => {
    const base = await fixture();
    const pending: SubmissionJournal = { jobId: 'sent-before-browser-restart', reviewId: 'old', accountKey: base.key, month: '2026-10', status: 'dispatching', updatedAt: '2026-11-01T12:00:00Z' };
    const app = await fixture({ schemaVersion: 7 }, pending);
    expect(app.controller.state.submissionResult).toBeUndefined();
    await app.controller.bindConnection(connection());
    expect(app.controller.state.submissionResult?.status).toBe('uncertain'); expect(app.journal()?.status).toBe('uncertain');
    const checked = await app.inspect(); expect(checked.state.submissionReview?.canSubmit).toBe(false);
    await expect(app.send(checked.approval)).rejects.toThrow(); expect(app.writes()).toBe(0);
  });
  it('blocks another month until an uncertain submission is reconciled without losing its journal', async () => {
    const app = await fixture(); const journal: SubmissionJournal = { jobId: 'prior', reviewId: 'prior', accountKey: app.key, month: '2026-10', status: 'uncertain', updatedAt: '2026-11-01T12:00:00Z' };
    const next = await fixture({ schemaVersion: 7, connection: connection() }, journal);
    const { state, approval } = await next.inspect(); expect(state.submissionReview?.issues.join()).toContain('2026-10');
    await expect(next.send(approval)).rejects.toThrow(); expect(next.journal()).toEqual(journal); expect(next.writes()).toBe(0);
  });
  it('accepts an independently observed external submission without fabricating a sent journal', async () => {
    const app = await fixture(); const { approval } = await app.inspect();
    vi.mocked(app.bridge.submitMonth!).mockResolvedValueOnce({ month: '2026-11', status: 'verified', periodStatus: 'Approved', message: 'External auto approval read back' });
    const state = await app.send(approval); expect(state.submissionResult?.status).toBe('verified'); expect(app.writes()).toBe(0); expect(app.journal()).toBeUndefined();
  });
  it('never accepts a verified non-terminal result and preserves verified success if final local storage fails', async () => {
    const app = await fixture(); let { approval } = await app.inspect();
    vi.mocked(app.bridge.submitMonth!).mockResolvedValueOnce({ month: '2026-11', status: 'verified', periodStatus: 'Open', message: 'Invalid fixture' });
    await expect(app.send(approval)).rejects.toThrow('Abschlussergebnis'); expect(app.writes()).toBe(0);
    ({ approval } = await app.inspect());
    const save = app.bridge.saveSubmissionJournal!;
    app.bridge.saveSubmissionJournal = vi.fn(async journal => { if (journal.status === 'verified') throw new Error('Fixture final local journal failure'); await save(journal); });
    await expect(app.send(approval)).rejects.toThrow('final local'); expect(app.controller.state.submissionResult?.status).toBe('verified'); expect(app.writes()).toBe(1);
  });
  it('hides another account’s pending result and restores only the matching scope', async () => {
    const app = await fixture(); const journal: SubmissionJournal = { jobId: 'prior', reviewId: 'prior', accountKey: app.key, month: '2026-11', status: 'dispatching', updatedAt: '2026-11-01T12:00:00Z' };
    const next = await fixture({ schemaVersion: 7, connection: { ...connection(), employeeId: 'different' } }, journal);
    expect(next.controller.state.submissionResult).toBeUndefined(); expect(next.controller.state.submissionJournal).toBeUndefined();
    await next.controller.bindConnection(connection()); expect(next.controller.state.submissionResult?.status).toBe('uncertain');
    expect(next.bridge.submitMonth).not.toHaveBeenCalled();
  });
  it('publishes the passive reminder check as an exclusive read-only job', async () => {
    const app = await fixture(); const held = deferred<{ accountKey: string; periods: []; checkedAt: string }>();
    vi.mocked(app.bridge.listSubmissionStatuses!).mockReturnValueOnce(held.promise);
    const checking = app.controller.listSubmissionStatuses(app.key);
    await vi.waitFor(() => expect(app.bridge.listSubmissionStatuses).toHaveBeenCalled());
    expect(app.controller.state.job?.kind).toBe('reminder-check');
    await expect(app.controller.reviewSubmission('2026-11')).rejects.toThrow('läuft bereits');
    held.resolve({ accountKey: app.key, periods: [], checkedAt: '2026-12-01T12:00:00Z' }); await checking;
    expect(app.controller.state.job).toBeUndefined(); expect(app.bridge.submitMonth).not.toHaveBeenCalled();
  });
  it.each(['Rejected', 'Approved'] as const)('updates an old verified UI result after a fresh %s scan', async status => {
    const app = await fixture();
    app.controller.state.submissionResult = { month: '2026-11', status: 'verified', periodStatus: 'Submitted', message: 'Previous verified result' };
    vi.mocked(app.bridge.scan).mockResolvedValueOnce({ month: '2026-11', employeeLabel: 'Local employee', periodLabel: 'November', source: 'hibob', scannedAt: '2026-12-01T12:00:00Z', context: { mode: 'api-session', connectionId: connection().generation, employeeKey: connection().employeeId!, tenantKey: connection().companyId! }, submission: { id: 123, start: '2026-11-01', end: '2026-11-30', status, locked: false }, days: [] });
    await app.controller.scan('2026-11');
    if (status === 'Rejected') expect(app.controller.state.submissionResult).toBeUndefined();
    else expect(app.controller.state.submissionResult?.periodStatus).toBe('Approved');
    expect(app.bridge.submitMonth).not.toHaveBeenCalled();
  });
  it('migrates schema6 by dropping previews while retaining preferences and completed history', async () => {
    const history = { planId: 'previous', status: 'complete' as const, startedAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z', results: [] };
    const app = await fixture({ schemaVersion: 6, connection: connection(), run: history });
    expect(app.controller.state.schemaVersion).toBe(7); expect(app.controller.state.run).toEqual(history); expect(app.bridge.submitMonth).not.toHaveBeenCalled();
  });
});
