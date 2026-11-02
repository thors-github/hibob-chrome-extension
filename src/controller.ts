import { t } from './i18n/index';
import { buildMonthPlan } from './domain/index';
import { assertWritablePlan } from './shared/validation';
import { sameJsonValue } from './shared/json';
import type { AdapterProgress, AttendanceContext, BookingPlan, DayPlan, DaySnapshot, JobState, MonthSnapshot, PlanEditLease, RunState, SessionState } from './shared/types';

export interface ControllerBridge {
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  scan(tabId: number, month: string, jobId: string): Promise<MonthSnapshot>;
  applyDay(tabId: number, day: DayPlan, context: AttendanceContext | undefined, jobId: string): Promise<DaySnapshot>;
  cancel(tabId: number, jobId: string): Promise<void>;
  recover?(tabId: number, jobId: string): Promise<void>;
}
const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const counter = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stalePlan = () => new Error(t('Die Vorschau wurde geändert. Bitte zuerst die aktuelle Vorschau prüfen.'));
const safeCounter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
function validateStoredState(state: SessionState): void {
  const invalid = () => { throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.')); };
  if (state.revision !== undefined && !safeCounter(state.revision) || state.planRevision !== undefined && !safeCounter(state.planRevision)) invalid();
  if (state.tabId !== undefined && (!Number.isSafeInteger(state.tabId) || state.tabId < 0)) invalid();
  if (state.error !== undefined && typeof state.error !== 'string') invalid();
  if (state.run && (!object(state.run) || !['running', 'complete', 'stopped', 'failed'].includes(state.run.status) || !Array.isArray(state.run.results) || !state.run.results.every(result => object(result) && typeof result.date === 'string' && ['pending', 'running', 'verified', 'skipped', 'failed', 'uncertain'].includes(result.status) && typeof result.message === 'string'))) invalid();
  if (state.progress && (!object(state.progress) || !['scan', 'apply'].includes(state.progress.phase) || !safeCounter(state.progress.completed) || !safeCounter(state.progress.total) || state.progress.completed > state.progress.total || typeof state.progress.message !== 'string')) invalid();
  if (state.job && (!object(state.job) || typeof state.job.id !== 'string' || !state.job.id || !['scan', 'apply'].includes(state.job.kind) || !['running', 'cancelling', 'interrupted'].includes(state.job.status) || !Number.isSafeInteger(state.job.tabId) || state.job.tabId < 0 || typeof state.job.month !== 'string' || (state.job.month !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(state.job.month)) || typeof state.job.startedAt !== 'string' || typeof state.job.updatedAt !== 'string')) invalid();
  if (state.editLease && (!object(state.editLease) || !safeCounter(state.editLease.planRevision) || typeof state.editLease.changeId !== 'string' || !state.editLease.changeId)) invalid();
}

/** Owns the only write queue and the global lease for reviewed configuration. */
export class BookingController {
  state: SessionState = { schemaVersion: 2, revision: 0, planRevision: 0 };
  private busy = false;
  private cancelRequested = false;
  private persistence: Promise<void> = Promise.resolve();
  private revision = 0;
  private planRevision = 0;
  private durableLease?: string;
  private approvedPlanRevision?: number;
  private leaseCandidate?: BookingPlan;
  constructor(private readonly bridge: ControllerBridge) {}

  async init(): Promise<void> {
    const loaded: unknown = await this.bridge.load();
    if (loaded !== undefined && !object(loaded)) throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.'));
    if (object(loaded) && loaded.schemaVersion !== undefined && loaded.schemaVersion !== 2) throw new Error(t('Diese Sitzungsversion wird nicht unterstützt. Bitte die Erweiterung neu laden.'));
    const restored = clone((loaded ?? {}) as SessionState);
    validateStoredState(restored);
    if (restored.run && (!Array.isArray(restored.run.results) || !restored.run.results.every(result => object(result) && typeof result.date === 'string' && typeof result.status === 'string'))) throw new Error(t('Der gespeicherte Buchungsverlauf ist ungültig. Vor weiteren Buchungen den HiBob-Zustand prüfen.'));
    if (restored.snapshot && (!object(restored.snapshot) || !Array.isArray(restored.snapshot.days))) throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.'));
    if (restored.plan && (!object(restored.plan) || !Array.isArray(restored.plan.days) || !object(restored.plan.settings))) throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.'));
    this.revision = Math.max(this.revision, counter(restored.revision));
    this.planRevision = Math.max(this.planRevision, counter(restored.planRevision));
    this.state = { ...restored, schemaVersion: 2, revision: this.revision, planRevision: this.planRevision };
    this.durableLease = undefined; this.approvedPlanRevision = undefined; this.leaseCandidate = undefined;
    const legacy = object(loaded) && loaded.schemaVersion !== 2;
    const interrupted = restored.job?.status === 'running' || restored.job?.status === 'cancelling' || restored.run?.status === 'running' || !!restored.progress;
    if (interrupted) {
      const kind = restored.job?.kind ?? (restored.run?.status === 'running' ? 'apply' : 'scan');
      const now = new Date().toISOString();
      const interruptedTab = restored.tabId ?? restored.job?.tabId;
      this.state.job = interruptedTab === undefined ? undefined : { id: restored.job?.id || `legacy-${crypto.randomUUID()}`, kind, status: 'interrupted', tabId: interruptedTab, month: restored.job?.month || restored.snapshot?.month || restored.plan?.settings.month || '', startedAt: restored.job?.startedAt || now, updatedAt: now };
      if (this.state.run?.status === 'running') {
        this.state.run.status = 'stopped';
        for (const result of this.state.run.results) if (result.status === 'running') { result.status = 'uncertain'; result.message = t('Ausführung unterbrochen. Persistierten Zustand erneut einlesen.'); }
      }
      this.state.progress = undefined; this.invalidateScan();
      this.state.error = t('Der letzte Vorgang wurde unterbrochen. Vor weiteren Buchungen den Monat erneut einlesen.');
    } else if (legacy && (restored.snapshot || restored.plan)) {
      this.invalidateScan(); this.state.plan = undefined;
      this.state.error = t('Die Sitzung wurde aktualisiert. Bitte den Monat erneut einlesen.');
    } else if (this.state.editLease && this.state.editLease.planRevision === this.planRevision && typeof this.state.editLease.changeId === 'string') {
      this.durableLease = this.state.editLease.changeId;
      if (this.state.snapshot && this.state.plan) {
        const canonical = buildMonthPlan(this.state.plan.settings, this.state.snapshot, this.state.plan.choices, this.state.plan.seed);
        if (sameJsonValue(this.state.plan.snapshot, this.state.snapshot) && sameJsonValue(this.state.plan, canonical)) {
          this.leaseCandidate = clone(canonical); this.approvedPlanRevision = this.planRevision;
        } else { this.state.plan.canApply = false; this.state.error = t('Die Vorschau wurde geändert. Bitte zuerst die aktuelle Vorschau prüfen.'); }
      }
    } else {
      this.state.editLease = undefined;
      if (this.state.plan) this.state.plan.canApply = false;
    }
    if (legacy || interrupted) await this.persist();
  }

  async bindTab(tabId: number | undefined, error?: string): Promise<void> {
    if (this.busy) {
      // Reopening this tab's panel is not a binding change and must preserve the
      // canonical job/progress without manufacturing an operation error.
      if (tabId !== undefined && tabId === this.state.tabId && !error) return;
      throw new Error(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    }
    if (tabId === undefined || this.state.tabId !== tabId) { this.state = { schemaVersion: 2, revision: this.revision, planRevision: this.planRevision }; this.invalidateScan(); }
    if (tabId !== undefined) this.state.tabId = tabId;
    this.state.error = error; await this.persist();
  }

  async invalidatePlan(expectedPlanRevision: number, changeId: string): Promise<SessionState> {
    if (this.busy) throw new Error(t('Während eines Vorgangs kann die Vorschau nicht geändert werden.'));
    if (typeof changeId !== 'string' || !changeId || changeId.length > 200) throw stalePlan();
    if (this.state.editLease?.changeId !== changeId) {
      if (expectedPlanRevision !== this.planRevision) throw stalePlan();
      this.advancePlanRevision(); this.state.editLease = { planRevision: this.planRevision, changeId }; this.state.plan = undefined;
    }
    const lease = clone(this.state.editLease!);
    if (this.durableLease !== changeId) {
      await this.persist(); if (!this.currentLease(lease)) throw stalePlan(); this.durableLease = changeId;
    }
    return clone(this.state);
  }

  async reportProgress(progress: AdapterProgress): Promise<void> {
    const job = this.state.job;
    if (!this.busy || !job || progress.jobId !== job.id || job.status === 'interrupted' || progress.phase !== job.kind) return;
    const run = this.state.run;
    this.state.progress = progress.phase === 'apply' && run?.status === 'running' ? { ...progress, completed: run.results.filter(r => r.status === 'verified').length, total: run.results.filter(r => r.status !== 'skipped').length } : progress;
    job.updatedAt = new Date().toISOString(); await this.persist();
  }

  async scan(month: string): Promise<SessionState> {
    if (this.busy) throw new Error(t('Ein Vorgang läuft bereits.'));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(t('Bitte einen gültigen Monat auswählen.'));
    const tabId = this.requireTab(); this.busy = true; this.cancelRequested = false;
    const interrupted = this.state.job?.status === 'interrupted' ? clone(this.state.job) : undefined;
    let job: JobState | undefined; let failure: unknown; let recovered = !interrupted;
    try {
      this.state.error = undefined; this.invalidateScan(); this.state.plan = undefined; this.state.run = undefined;
      job = this.newJob('scan', tabId, month); this.state.job = job;
      this.state.progress = { jobId: job.id, phase: 'scan', completed: 0, total: 0, message: t('HiBob-Monat wird eingelesen …') };
      await this.persist();
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      if (interrupted) await this.bridge.recover?.(tabId, interrupted.id);
      recovered = true;
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      const snapshot = await this.bridge.scan(tabId, month, job.id);
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      if (snapshot.month !== month || snapshot.source !== 'hibob') throw new Error(t('HiBob hat einen unerwarteten Monat geliefert.'));
      this.state.snapshot = snapshot;
    } catch (error) { failure = error; this.state.error = errorText(error); }
    finally {
      if (job && this.state.job?.id === job.id) this.state.job = recovered ? undefined : interrupted;
      this.state.progress = undefined; this.busy = false;
      try { await this.persist(); } catch (error) { this.state.error ||= errorText(error); failure ??= error; this.touch(); }
    }
    if (failure) throw new Error(this.state.error || errorText(failure)); return clone(this.state);
  }

  async savePlan(input: BookingPlan, lease: PlanEditLease): Promise<SessionState> {
    if (this.busy) throw new Error(t('Während eines Vorgangs kann die Vorschau nicht geändert werden.'));
    if (!this.currentLease(lease) || this.durableLease !== lease.changeId) throw stalePlan();
    const snapshot = this.state.snapshot;
    if (!snapshot || !sameJsonValue(input.snapshot, snapshot)) throw new Error(t('Die Vorschau gehört nicht zum aktuellen HiBob-Lesestand. Bitte erneut einlesen.'));
    const candidate = buildMonthPlan(input.settings, snapshot, input.choices, input.seed);
    if (this.leaseCandidate && !sameJsonValue(this.leaseCandidate, candidate)) throw stalePlan();
    this.leaseCandidate = clone(candidate); this.state.plan = candidate; this.approvedPlanRevision = undefined; this.state.error = undefined;
    try { await this.persist(); if (!this.currentLease(lease)) throw stalePlan(); this.approvedPlanRevision = lease.planRevision; }
    catch (error) {
      if (this.currentLease(lease) && this.approvedPlanRevision !== lease.planRevision && this.state.plan === candidate) {
        this.state.plan.canApply = false;
        this.state.error = errorText(error);
        // The failed acknowledgement changes the public in-memory state too.
        // Give it a newer revision than any earlier candidate storage event.
        this.touch();
      }
      throw error;
    }
    return clone(this.state);
  }

  async apply(input: BookingPlan, expectedPlanRevision: number): Promise<SessionState> {
    if (this.busy) throw new Error(t('Ein Vorgang läuft bereits.'));
    const plan = this.state.plan;
    if (expectedPlanRevision !== this.planRevision || this.approvedPlanRevision !== this.planRevision || !plan || !this.state.snapshot || input.id !== plan.id || !sameJsonValue(input, plan)) throw stalePlan();
    assertWritablePlan(plan);
    if (!plan.snapshot.context?.verified || !plan.snapshot.context.employeeKey || !plan.snapshot.context.tenantKey || !plan.snapshot.context.documentId) throw new Error(t('Die Kontozuordnung ist nicht sicher bestätigt. Buchungen bleiben gesperrt; bitte den Monat erneut einlesen.'));
    const tabId = this.requireTab(); this.busy = true; this.cancelRequested = false; this.state.error = undefined;
    const job = this.newJob('apply', tabId, plan.settings.month); this.state.job = job;
    const changes = plan.days.filter(day => day.action === 'create' || day.action === 'overwrite');
    const run: RunState = { planId: plan.id, status: 'running', startedAt: job.startedAt, updatedAt: job.startedAt, results: plan.days.map(day => ({ date: day.date, status: day.action === 'create' || day.action === 'overwrite' ? 'pending' : 'skipped', message: day.reason ?? t('Keine Änderung.') })) };
    this.state.run = run; let failure: unknown;
    try {
      await this.persist();
      for (let i = 0; i < changes.length; i++) {
        if (this.cancelRequested) break;
        const day = changes[i]; const result = run.results.find(item => item.date === day.date)!;
        result.status = 'running'; result.message = t('Tageszustand prüfen und Buchung speichern …'); run.updatedAt = new Date().toISOString();
        this.state.progress = { jobId: job.id, phase: 'apply', completed: i, total: changes.length, date: day.date, message: result.message };
        try { await this.persist(); } catch (error) { result.status = 'pending'; result.message = t('Nicht geschrieben: Das lokale Journal konnte nicht gespeichert werden.'); this.journalFailure(run, error); break; }
        if (this.cancelRequested) { result.status = 'pending'; result.message = t('Vor dem Schreiben abgebrochen.'); break; }
        // Local journaling errors must not overwrite an already verified remote outcome.
        try {
          const saved = await this.bridge.applyDay(tabId, day, plan.snapshot.context, job.id);
          if (saved.date !== day.date) throw Object.assign(new Error(t('HiBob hat nach dem Speichern einen anderen Tag geliefert.')), { uncertain: true });
          result.status = 'verified'; result.message = t('Gespeichert und erneut aus HiBob gelesen.'); this.state.progress.completed = i + 1;
        } catch (error) {
          result.status = object(error) && error.uncertain ? 'uncertain' : 'failed'; result.message = errorText(error); run.status = this.cancelRequested ? 'stopped' : 'failed';
          this.state.error = t('{date}: {message} Der Lauf wurde gestoppt; das Wochenziel ist möglicherweise noch nicht erreicht.', { date: day.date, message: result.message }); break;
        }
        try { await this.persist(); } catch (error) { this.journalFailure(run, error); break; }
      }
      if (run.status === 'running') run.status = this.cancelRequested ? 'stopped' : 'complete';
      if (run.status === 'stopped') this.state.error = t('Lauf abgebrochen. Bereits bestätigte Buchungen bleiben erhalten. Vor dem Fortsetzen erneut einlesen.');
    } catch (error) { failure = error; this.journalFailure(run, error); }
    finally {
      run.updatedAt = new Date().toISOString(); this.state.progress = undefined; this.busy = false;
      if (this.state.job?.id === job.id) this.state.job = undefined;
      this.invalidateScan();
      try { await this.persist(); } catch (error) { this.journalFailure(run, error); failure ??= error; this.touch(); }
    }
    if (failure) throw new Error(this.state.error || errorText(failure)); return clone(this.state);
  }

  async cancel(jobId?: string): Promise<void> {
    const job = this.state.job;
    if (!this.busy || !job) return;
    if (jobId !== undefined && jobId !== job.id) throw new Error(t('Der laufende Vorgang wurde geändert. Bitte den aktuellen Status prüfen.'));
    this.cancelRequested = true; job.status = 'cancelling'; job.updatedAt = new Date().toISOString();
    this.touch();
    await this.bridge.cancel(job.tabId, job.id).catch(() => {});
  }
  private journalFailure(run: RunState, error: unknown): void {
    run.status = 'failed'; run.journalError = errorText(error);
    const message = t('Das lokale Buchungsjournal konnte nicht gespeichert werden: {error}. Bereits verifizierte Tage bleiben gespeichert. Vor weiteren Buchungen erneut einlesen.', { error: run.journalError });
    this.state.error = this.state.error ? `${this.state.error} ${message}` : message;
  }
  private newJob(kind: JobState['kind'], tabId: number, month: string): JobState { const now = new Date().toISOString(); return { id: crypto.randomUUID(), kind, status: 'running', tabId, month, startedAt: now, updatedAt: now }; }
  private currentLease(lease: PlanEditLease | undefined): lease is PlanEditLease { return !!lease && lease.planRevision === this.planRevision && this.state.editLease?.planRevision === lease.planRevision && this.state.editLease.changeId === lease.changeId; }
  private advancePlanRevision(): void { this.state.planRevision = ++this.planRevision; this.approvedPlanRevision = undefined; this.durableLease = undefined; this.leaseCandidate = undefined; }
  private invalidateScan(): void { this.state.snapshot = undefined; if (this.state.plan) this.state.plan.canApply = false; this.state.editLease = undefined; this.advancePlanRevision(); }
  private requireTab(): number { if (this.state.tabId === undefined) throw new Error(t('HiBob öffnen und dort auf das Extension-Symbol klicken.')); return this.state.tabId; }
  private touch(): void { this.state.schemaVersion = 2; this.state.revision = ++this.revision; this.state.planRevision = this.planRevision; }
  private async persist(): Promise<void> { this.touch(); const state = clone(this.state); const operation = this.persistence.then(() => this.bridge.save(state)); this.persistence = operation.catch(() => {}); await operation; }
}
