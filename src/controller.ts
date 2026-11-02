import { t } from './i18n/index';
import { buildMonthPlan } from './domain/index';
import { assertWritablePlan } from './shared/validation';
import { sameJsonValue } from './shared/json';
import { netMinutes } from './shared/entries';
import { assertApplyAuthorization, contextFingerprint } from './shared/context';
import { isExtensionVersion, isNewerExtensionVersion } from './shared/updates';
import type { AccountConfirmation, AdapterProgress, ApiConnection, ApplyAuthorization, AttendanceContext, BookingPlan, DayPlan, DaySnapshot, PreflightResult, JobState, MonthSnapshot, PlanEditLease, RunOptions, RunState, SessionState } from './shared/types';

export interface ControllerBridge {
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  connect?(): Promise<ApiConnection>;
  disconnect?(): Promise<void>;
  scan(connection: ApiConnection, month: string, jobId: string): Promise<MonthSnapshot>;
  applyDay(connection: ApiConnection, day: DayPlan, context: AttendanceContext | undefined, jobId: string, authorization: ApplyAuthorization): Promise<DaySnapshot>;
  preflightDay(connection: ApiConnection, day: DayPlan, context: AttendanceContext | undefined, jobId: string, authorization: ApplyAuthorization): Promise<PreflightResult>;
  cancel(connection: ApiConnection, jobId: string): Promise<void>;
  recover?(connection: ApiConnection, jobId: string): Promise<void>;
  checkUpdateIdle?(connection: ApiConnection | undefined): Promise<void>;
  reload?(): void;
}
const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const counter = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stalePlan = () => new Error(t('Die Vorschau wurde geändert. Bitte zuerst die aktuelle Vorschau prüfen.'));
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1000;
function validConnection(value: unknown): value is ApiConnection {
  if (!object(value) || !['disconnected', 'connected', 'expired', 'unsupported'].includes(String(value.status)) || !nonempty(value.generation)) return false;
  if (['employeeId', 'companyId', 'employeeLabel', 'companyLabel', 'reason'].some(key => value[key] !== undefined && !nonempty(value[key]))) return false;
  if (value.transport !== undefined && !['direct', 'temporary-tab'].includes(String(value.transport))) return false;
  const capabilities = value.capabilities;
  if (capabilities !== undefined && (!object(capabilities) || ['read', 'write', 'overwrite'].some(key => typeof capabilities[key] !== 'boolean'))) return false;
  return value.status !== 'connected' || nonempty(value.employeeId) && nonempty(value.companyId) && !!value.capabilities;
}
function connectionValue(value: ApiConnection): ApiConnection {
  if (!validConnection(value)) throw new Error(t('Die HiBob-Verbindung ist ungültig. Bitte erneut anmelden.'));
  return { status: value.status, generation: value.generation, ...(value.employeeId ? { employeeId: value.employeeId } : {}), ...(value.companyId ? { companyId: value.companyId } : {}), ...(value.employeeLabel ? { employeeLabel: value.employeeLabel } : {}), ...(value.companyLabel ? { companyLabel: value.companyLabel } : {}), ...(value.transport ? { transport: value.transport } : {}), ...(value.capabilities ? { capabilities: { read: value.capabilities.read, write: value.capabilities.write, overwrite: value.capabilities.overwrite } } : {}), ...(value.reason ? { reason: value.reason } : {}) };
}
const safeCounter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
interface RunCheckpoint {
  plan: BookingPlan;
  planRevision: number;
  connection: ApiConnection;
  job: JobState;
  run: RunState;
  dates: string[];
}
function validateStoredState(state: SessionState): void {
  const invalid = () => { throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.')); };
  if (state.revision !== undefined && !safeCounter(state.revision) || state.planRevision !== undefined && !safeCounter(state.planRevision)) invalid();
  if (state.tabId !== undefined && (!Number.isSafeInteger(state.tabId) || state.tabId < 0)) invalid();
  if (state.connection !== undefined && !validConnection(state.connection)) invalid();
  if (state.error !== undefined && typeof state.error !== 'string') invalid();
  if (state.run && (!object(state.run) || !['running', 'paused', 'complete', 'stopped', 'failed'].includes(state.run.status) || !Array.isArray(state.run.results) || !state.run.results.every(result => object(result) && typeof result.date === 'string' && ['pending', 'running', 'verified', 'skipped', 'failed', 'uncertain'].includes(result.status) && typeof result.message === 'string'))) invalid();
  if (state.run?.runId !== undefined && !nonempty(state.run.runId) || state.run?.checkpointDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(state.run.checkpointDate)) invalid();
  if (state.progress && (!object(state.progress) || !['scan', 'apply'].includes(state.progress.phase) || !safeCounter(state.progress.completed) || !safeCounter(state.progress.total) || state.progress.completed > state.progress.total || typeof state.progress.message !== 'string')) invalid();
  if (state.job && (!object(state.job) || typeof state.job.id !== 'string' || !state.job.id || !['scan', 'apply'].includes(state.job.kind) || !['running', 'cancelling', 'paused', 'interrupted'].includes(state.job.status) || !(nonempty(state.job.connectionId) || Number.isSafeInteger(state.job.tabId) && Number(state.job.tabId) >= 0) || typeof state.job.month !== 'string' || (state.job.month !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(state.job.month)) || typeof state.job.startedAt !== 'string' || typeof state.job.updatedAt !== 'string')) invalid();
  if (state.job?.checkpointId !== undefined && !nonempty(state.job.checkpointId)) invalid();
  if (state.editLease && (!object(state.editLease) || !safeCounter(state.editLease.planRevision) || typeof state.editLease.changeId !== 'string' || !state.editLease.changeId)) invalid();
  if (state.update && (!object(state.update) || !isExtensionVersion(state.update.installedVersion) || state.update.pendingVersion !== undefined && !isExtensionVersion(state.update.pendingVersion))) invalid();
  if (state.updateApplying !== undefined && typeof state.updateApplying !== 'boolean') invalid();
}

/** Owns the only write queue and the global lease for reviewed configuration. */
export class BookingController {
  state: SessionState = { schemaVersion: 5, revision: 0, planRevision: 0 };
  private busy = false;
  private cancelRequested = false;
  private persistence: Promise<void> = Promise.resolve();
  private revision = 0;
  private planRevision = 0;
  private durableLease?: string;
  private approvedPlanRevision?: number;
  private leaseCandidate?: BookingPlan;
  private checkpoint?: RunCheckpoint;
  constructor(private readonly bridge: ControllerBridge) {}

  async init(): Promise<void> {
    const loaded: unknown = await this.bridge.load();
    if (loaded !== undefined && !object(loaded)) throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.'));
    if (object(loaded) && loaded.schemaVersion !== undefined && loaded.schemaVersion !== 2 && loaded.schemaVersion !== 3 && loaded.schemaVersion !== 4 && loaded.schemaVersion !== 5) throw new Error(t('Diese Sitzungsversion wird nicht unterstützt. Bitte die Erweiterung neu laden.'));
    const restored = clone((loaded ?? {}) as SessionState);
    validateStoredState(restored);
    // Consent is deliberately ephemeral, including when loading unknown extra fields.
    for (const item of [restored, restored.plan, restored.snapshot, restored.run, restored.job]) if (object(item)) {
      delete item.confirmation; delete item.accountConfirmation; delete item.authorization; delete item.draftCheck; delete item.preflight;
    }
    if (restored.run && (!Array.isArray(restored.run.results) || !restored.run.results.every(result => object(result) && typeof result.date === 'string' && typeof result.status === 'string'))) throw new Error(t('Der gespeicherte Buchungsverlauf ist ungültig. Vor weiteren Buchungen den HiBob-Zustand prüfen.'));
    if (restored.snapshot && (!object(restored.snapshot) || !Array.isArray(restored.snapshot.days))) throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.'));
    if (restored.plan && (!object(restored.plan) || !Array.isArray(restored.plan.days) || !object(restored.plan.settings))) throw new Error(t('Der gespeicherte Sitzungszustand ist ungültig. Bitte die Erweiterung neu laden.'));
    this.revision = Math.max(this.revision, counter(restored.revision));
    this.planRevision = Math.max(this.planRevision, counter(restored.planRevision));
    this.state = { ...restored, schemaVersion: 5, revision: this.revision, planRevision: this.planRevision };
    this.durableLease = undefined; this.approvedPlanRevision = undefined; this.leaseCandidate = undefined; this.checkpoint = undefined;
    const legacy = object(loaded) && loaded.schemaVersion !== 5;
    const legacyConnection = object(loaded) && loaded.schemaVersion !== 4 && loaded.schemaVersion !== 5;
    delete this.state.tabId;
    if (legacyConnection) { this.state.connection = undefined; this.state.job = undefined; }
    else if (this.state.connection) this.state.connection = connectionValue(this.state.connection);
    if (this.state.job) { delete this.state.job.tabId; if (!this.state.job.connectionId) this.state.job = undefined; }
    const interruptedUpdate = restored.updateApplying === true;
    this.state.updateApplying = false;
    const interrupted = restored.job?.status === 'running' || restored.job?.status === 'cancelling' || restored.job?.status === 'paused' || restored.run?.status === 'paused' || restored.run?.status === 'running' || !!restored.progress;
    if (interrupted) {
      const kind = restored.job?.kind ?? (restored.run?.status === 'running' || restored.run?.status === 'paused' ? 'apply' : 'scan');
      const now = new Date().toISOString();
      const connectionId = !legacyConnection ? restored.job?.connectionId ?? restored.connection?.generation : undefined;
      this.state.job = connectionId === undefined ? undefined : { id: restored.job?.id || `interrupted-${crypto.randomUUID()}`, kind, status: 'interrupted', connectionId, month: restored.job?.month || restored.snapshot?.month || restored.plan?.settings.month || '', startedAt: restored.job?.startedAt || now, updatedAt: now };
      if (this.state.run?.status === 'running' || this.state.run?.status === 'paused') {
        this.state.run.status = 'stopped';
        for (const result of this.state.run.results) if (result.status === 'running') { result.status = 'uncertain'; result.message = t('Ausführung unterbrochen. Persistierten Zustand erneut einlesen.'); }
      }
      this.state.progress = undefined; this.invalidateScan();
      if (legacy) this.state.plan = undefined;
      this.state.error = t('Der letzte Vorgang wurde unterbrochen. Vor weiteren Buchungen den Monat erneut einlesen.');
    } else if ((legacy || interruptedUpdate) && (restored.snapshot || restored.plan)) {
      this.invalidateScan(); this.state.plan = undefined;
      this.state.error = t('Die Sitzung wurde aktualisiert. Bitte den Monat erneut einlesen.');
    } else if (this.state.editLease && this.state.editLease.planRevision === this.planRevision && typeof this.state.editLease.changeId === 'string') {
      this.durableLease = this.state.editLease.changeId;
      if (this.state.snapshot && this.state.plan) {
        const canonical = buildMonthPlan(this.state.plan.settings, this.state.snapshot, this.state.plan.choices, this.state.plan.seed);
        if (sameJsonValue(this.state.plan.snapshot, this.state.snapshot) && sameJsonValue(this.state.plan, canonical)) {
          this.leaseCandidate = clone(canonical); this.approvedPlanRevision = this.planRevision;
        } else { this.state.plan.canReview = false; this.state.error = t('Die Vorschau wurde geändert. Bitte zuerst die aktuelle Vorschau prüfen.'); }
      }
    } else {
      this.state.editLease = undefined;
      if (this.state.plan) this.state.plan.canReview = false;
    }
    if (legacy || interrupted || interruptedUpdate) await this.persist();
  }

  /** Called from the native Chrome event only; no network polling is involved. */
  async configureUpdates(installedVersion: string, announcedVersion?: string): Promise<void> {
    if (!isExtensionVersion(installedVersion)) throw new Error('Invalid installed extension version.');
    const previous = this.state.update;
    const changedVersion = previous && previous.installedVersion !== installedVersion;
    if (changedVersion && this.isPaused()) throw new Error(t('Das Update kann erst nach Abschluss des laufenden Vorgangs aktiviert werden.'));
    const candidates = [changedVersion ? undefined : previous?.pendingVersion, announcedVersion]
      .filter((version): version is string => isNewerExtensionVersion(version, installedVersion));
    let pendingVersion: string | undefined;
    for (const version of candidates) if (!pendingVersion || isNewerExtensionVersion(version, pendingVersion)) pendingVersion = version;
    const update = { installedVersion, ...(pendingVersion ? { pendingVersion } : {}) };
    if (changedVersion) {
      this.invalidateScan(); this.state.plan = undefined;
      this.state.error = t('Die Erweiterung wurde aktualisiert. Bitte die HiBob-Verbindung prüfen und den Monat erneut einlesen.');
    }
    if (sameJsonValue(previous, update) && !changedVersion) return;
    this.state.update = update;
    await this.persist();
  }

  async activateUpdate(): Promise<SessionState> {
    if (this.busy || this.state.job || this.state.run?.status === 'running' || this.state.updateApplying) throw new Error(t('Das Update kann erst nach Abschluss des laufenden Vorgangs aktiviert werden.'));
    if (!this.state.update?.pendingVersion) throw new Error(t('Chrome hat noch kein Update zur Aktivierung bereitgestellt.'));
    if (!this.bridge.reload) throw new Error(t('Das Update kann hier nicht aktiviert werden. Bitte Chrome neu starten.'));
    // Acquire the same synchronous lock as scan/apply before probing the tab or
    // writing the invalidation. Another panel cannot enter the queue meanwhile.
    this.busy = true; this.state.updateApplying = true;
    try {
      await this.bridge.checkUpdateIdle?.(this.state.connection);
      this.invalidateScan(); this.state.plan = undefined; this.state.progress = undefined;
      this.state.error = t('Die Erweiterung wird aktualisiert. Danach die HiBob-Verbindung prüfen und den Monat erneut einlesen.');
      await this.persist();
      this.bridge.reload();
      // reload() replaces this context. Keep it locked if an embedding/test
      // environment lets the old context continue after returning.
      return clone(this.state);
    } catch (error) {
      this.busy = false; this.state.updateApplying = false; this.state.error = errorText(error);
      this.touch();
      throw error;
    }
  }

  async connect(): Promise<SessionState> {
    if (this.isLocked()) throw new Error(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    if (!this.bridge.connect) throw new Error(t('Die HiBob-Anmeldung ist hier nicht verfügbar.'));
    this.busy = true;
    this.invalidateScan(); this.state.plan = undefined;
    try {
      // Authentication is performed by HiBob. No credentials enter controller state.
      this.state.connection = undefined;
      await this.persist();
      this.state.connection = connectionValue(await this.bridge.connect());
      this.state.error = this.state.connection.status === 'connected' ? undefined : this.state.connection.reason;
      await this.persist();
      return clone(this.state);
    } catch (error) { this.connectionFailure(error); this.state.error = errorText(error); this.touch(); throw error; }
    finally { this.busy = false; }
  }

  async disconnect(): Promise<SessionState> {
    if (this.isLocked()) throw new Error(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    this.busy = true;
    // Revoke the local write context before awaiting transport cleanup.
    this.invalidateScan(); this.state.plan = undefined;
    this.state.connection = { status: 'disconnected', generation: crypto.randomUUID() };
    this.state.error = undefined;
    try { await this.persist(); await this.bridge.disconnect?.(); return clone(this.state); }
    catch (error) { this.connectionFailure(error); this.state.error = errorText(error); this.touch(); throw error; }
    finally { this.busy = false; }
  }

  async bindConnection(connection: ApiConnection | undefined, error?: string): Promise<void> {
    const next = connection ? connectionValue(connection) : undefined;
    if (this.isLocked()) {
      if (!this.isPaused() && sameJsonValue(next, this.state.connection) && !error) return;
      throw new Error(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    }
    if (!next || !sameJsonValue(next, this.state.connection)) {
      this.state.connection = next;
      this.invalidateScan(); this.state.plan = undefined;
    }
    delete this.state.tabId;
    this.state.error = error; await this.persist();
  }

  async invalidatePlan(expectedPlanRevision: number, changeId: string): Promise<SessionState> {
    if (this.isLocked()) throw new Error(t('Während eines Vorgangs kann die Vorschau nicht geändert werden.'));
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
    if (this.isLocked()) throw new Error(t('Ein Vorgang läuft bereits.'));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(t('Bitte einen gültigen Monat auswählen.'));
    const connection = this.requireConnection(); this.busy = true; this.cancelRequested = false;
    const interrupted = this.state.job?.status === 'interrupted' ? clone(this.state.job) : undefined;
    let job: JobState | undefined; let failure: unknown; let recovered = !interrupted;
    try {
      this.state.error = undefined; this.invalidateScan(); this.state.plan = undefined;
      job = this.newJob('scan', connection, month); this.state.job = job;
      this.state.progress = { jobId: job.id, phase: 'scan', completed: 0, total: 0, message: t('HiBob-Monat wird eingelesen …') };
      await this.persist();
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      if (interrupted) await this.bridge.recover?.(connection, interrupted.id);
      recovered = true;
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      const snapshot = await this.bridge.scan(connection, month, job.id);
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      if (snapshot.month !== month || snapshot.source !== 'hibob') throw new Error(t('HiBob hat einen unerwarteten Monat geliefert.'));
      this.assertConnectionContext(snapshot.context, connection);
      this.state.snapshot = snapshot;
    } catch (error) { this.connectionFailure(error); failure = error; this.state.error = errorText(error); }
    finally {
      if (job && this.state.job?.id === job.id) this.state.job = recovered ? undefined : interrupted;
      this.state.progress = undefined;
      try { await this.persist(); } catch (error) { this.state.error ||= errorText(error); failure ??= error; this.touch(); }
      finally { this.busy = false; }
    }
    if (failure) throw new Error(this.state.error || errorText(failure)); return clone(this.state);
  }

  async savePlan(input: BookingPlan, lease: PlanEditLease): Promise<SessionState> {
    if (this.isLocked()) throw new Error(t('Während eines Vorgangs kann die Vorschau nicht geändert werden.'));
    if (!this.currentLease(lease) || this.durableLease !== lease.changeId) throw stalePlan();
    const snapshot = this.state.snapshot;
    if (!snapshot || !sameJsonValue(input.snapshot, snapshot)) throw new Error(t('Die Vorschau gehört nicht zum aktuellen HiBob-Lesestand. Bitte erneut einlesen.'));
    const candidate = buildMonthPlan(input.settings, snapshot, input.choices, input.seed);
    if (this.leaseCandidate && !sameJsonValue(this.leaseCandidate, candidate)) throw stalePlan();
    this.leaseCandidate = clone(candidate); this.state.plan = candidate; this.approvedPlanRevision = undefined; this.state.error = undefined;
    try { await this.persist(); if (!this.currentLease(lease)) throw stalePlan(); this.approvedPlanRevision = lease.planRevision; }
    catch (error) {
      if (this.currentLease(lease) && this.approvedPlanRevision !== lease.planRevision && this.state.plan === candidate) {
        this.state.plan.canReview = false;
        this.state.error = errorText(error);
        // The failed acknowledgement changes the public in-memory state too.
        // Give it a newer revision than any earlier candidate storage event.
        this.touch();
      }
      throw error;
    }
    return clone(this.state);
  }

  async apply(input: BookingPlan, expectedPlanRevision: number, confirmation?: AccountConfirmation, options?: RunOptions): Promise<SessionState> {
    if (this.isLocked()) throw new Error(t('Ein Vorgang läuft bereits.'));
    const { plan, authorization } = this.authorizePlan(input, expectedPlanRevision, confirmation);
    const dates = this.checkpointDates(options, plan);
    const connection = this.requireConnection(); this.busy = true; this.cancelRequested = false; this.state.error = undefined;
    const job = this.newJob('apply', connection, plan.settings.month); this.state.job = job;
    const run: RunState = { runId: job.id, planId: plan.id, status: 'running', startedAt: job.startedAt, updatedAt: job.startedAt, results: plan.days.map(day => ({ date: day.date, status: day.action === 'create' || day.action === 'overwrite' ? 'pending' : 'skipped', message: day.reason ?? t('Keine Änderung.') })) };
    this.state.run = run;
    return this.executeRun(clone(plan), connection, authorization, job, run, dates);
  }

  /** Continue only the same in-memory frozen plan, with new consent and a complete read-only reconciliation. */
  async continueRun(jobId: string, planId: string, expectedPlanRevision: number, confirmation?: AccountConfirmation): Promise<SessionState> {
    if (this.busy) throw new Error(t('Ein Vorgang läuft bereits.'));
    const checkpoint = this.checkpoint;
    if (!checkpoint || this.state.job?.status !== 'paused' || this.state.run?.status !== 'paused'
      || checkpoint.job.id !== jobId || checkpoint.plan.id !== planId || checkpoint.planRevision !== expectedPlanRevision
      || !sameJsonValue(this.state.job, checkpoint.job) || !sameJsonValue(this.state.run, checkpoint.run)
      || !sameJsonValue(this.state.plan, checkpoint.plan) || !sameJsonValue(this.state.connection, checkpoint.connection)) throw stalePlan();
    if (!confirmation || !nonempty(checkpoint.job.checkpointId) || confirmation.checkpointId !== checkpoint.job.checkpointId) throw new Error(t('Bitte das eigene HiBob-Konto für diesen Kontrollpunkt erneut bestätigen.'));
    const { authorization } = this.authorizePlan(checkpoint.plan, expectedPlanRevision, confirmation);
    const job = this.state.job, run = this.state.run;
    this.busy = true; this.cancelRequested = false; this.state.error = undefined;
    job.status = 'running'; delete job.checkpointId; run.status = 'running'; delete run.checkpointDate;
    this.state.progress = { jobId: job.id, phase: 'apply', completed: run.results.filter(result => result.status === 'verified').length, total: run.results.filter(result => result.status !== 'skipped').length, message: t('Monatszustand vor der Fortsetzung prüfen …') };
    try {
      await this.persist();
      if (this.cancelRequested) throw new Error(t('Vorgang abgebrochen.'));
      const snapshot = await this.bridge.scan(checkpoint.connection, checkpoint.plan.settings.month, job.id);
      if (this.cancelRequested) throw new Error(t('Vorgang abgebrochen.'));
      this.reconcileCheckpoint(checkpoint, snapshot);
    } catch (error) {
      this.connectionFailure(error); run.status = this.cancelRequested ? 'stopped' : 'failed';
      this.state.error = errorText(error); this.state.progress = undefined; this.state.job = undefined; this.checkpoint = undefined;
      this.invalidateScan();
      try { await this.persist(); } catch (journalError) { this.journalFailure(run, journalError); this.touch(); }
      finally { this.busy = false; }
      throw new Error(this.state.error || errorText(error));
    }
    this.checkpoint = undefined;
    return this.executeRun(checkpoint.plan, checkpoint.connection, authorization, job, run, checkpoint.dates);
  }

  private checkpointDates(options: RunOptions | undefined, plan: BookingPlan): string[] {
    if (options === undefined) return [];
    if (!object(options) || Object.keys(options).some(key => key !== 'checkpointDates') || options.checkpointDates !== undefined && (!Array.isArray(options.checkpointDates) || options.checkpointDates.some(date => typeof date !== 'string'))) throw new Error(t('Die Kontrollpunkte gehören nicht zu den freigegebenen Buchungstagen.'));
    const dates = options.checkpointDates ?? [];
    if (new Set(dates).size !== dates.length || dates.some(date => !plan.days.some(day => day.date === date && (day.action === 'create' || day.action === 'overwrite')))) throw new Error(t('Die Kontrollpunkte gehören nicht zu den freigegebenen Buchungstagen.'));
    return [...dates].sort();
  }

  private reconcileCheckpoint(checkpoint: RunCheckpoint, snapshot: MonthSnapshot): void {
    const plan = checkpoint.plan;
    this.assertConnectionContext(snapshot.context, checkpoint.connection);
    const byDate = new Map(snapshot.days.map(day => [day.date, day]));
    if (snapshot.source !== 'hibob' || snapshot.month !== plan.settings.month || contextFingerprint(snapshot.context) !== contextFingerprint(plan.snapshot.context)
      || byDate.size !== snapshot.days.length || byDate.size !== plan.snapshot.days.length || plan.snapshot.days.some(day => !byDate.has(day.date))) throw new Error(t('Der Monatsstand hat sich seit dem Kontrollpunkt geändert. Bitte erneut einlesen und prüfen.'));
    const entries = (values: DaySnapshot['entries']) => values.map(entry => ({ type: entry.type, start: entry.start, end: entry.end, note: entry.note ?? '', reason: entry.reason ?? '', metadata: [...(entry.metadata ?? [])].sort() })).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.type.localeCompare(b.type));
    for (const result of checkpoint.run.results) {
      const planned = plan.days.find(day => day.date === result.date)!;
      const actual = byDate.get(result.date);
      if (result.status === 'verified') {
        if (!actual || actual.absence || actual.nonWorking || actual.unsupportedReason || actual.reportedMinutes !== planned.netMinutes || netMinutes(actual.entries) !== planned.netMinutes || !sameJsonValue(entries(actual.entries), entries(planned.proposed))) throw new Error(t('{date}: Die bereits verifizierte Buchung hat sich geändert. Der Lauf bleibt gestoppt.', { date: result.date }));
      } else if (result.status === 'pending') {
        if (!actual || !actual.editable || actual.absence || actual.nonWorking || actual.unsupportedReason || actual.fingerprint !== planned.fingerprint) throw new Error(t('{date}: Ein verbleibender Buchungstag hat sich geändert. Bitte erneut einlesen und prüfen.', { date: result.date }));
      } else if (result.status === 'skipped' && planned.eligible && planned.existing.length) {
        // Retained entries (including already-matching entries) contribute to
        // the frozen weekly target just as verified writes do.
        if (!actual || actual.absence || actual.nonWorking || actual.unsupportedReason || actual.fingerprint !== planned.fingerprint || actual.reportedMinutes !== planned.existingNetMinutes || netMinutes(actual.entries) !== planned.existingNetMinutes || !sameJsonValue(entries(actual.entries), entries(planned.existing))) throw new Error(t('{date}: Eine beibehaltene Buchung hat sich geändert. Bitte erneut einlesen und prüfen.', { date: result.date }));
      } else if (result.status !== 'skipped') throw stalePlan();
    }
  }

  private async executeRun(plan: BookingPlan, connection: ApiConnection, authorization: ApplyAuthorization, job: JobState, run: RunState, dates: string[]): Promise<SessionState> {
    const changes = plan.days.filter(day => day.action === 'create' || day.action === 'overwrite');
    let failure: unknown; let paused = false;
    try {
      await this.persist();
      for (let i = 0; i < changes.length; i++) {
        if (this.cancelRequested) break;
        const day = changes[i]; const result = run.results.find(item => item.date === day.date)!;
        if (result.status === 'verified') continue;
        if (result.status !== 'pending') throw stalePlan();
        result.status = 'running'; result.message = t('Tageszustand prüfen und Buchung speichern …'); run.updatedAt = new Date().toISOString();
        this.state.progress = { jobId: job.id, phase: 'apply', completed: i, total: changes.length, date: day.date, message: result.message };
        try { await this.persist(); } catch (error) { result.status = 'pending'; result.message = t('Nicht geschrieben: Das lokale Journal konnte nicht gespeichert werden.'); this.journalFailure(run, error); break; }
        if (this.cancelRequested) { result.status = 'pending'; result.message = t('Vor dem Schreiben abgebrochen.'); break; }
        // Local journaling errors must not overwrite an already verified remote outcome.
        try {
          const saved = await this.bridge.applyDay(connection, day, plan.snapshot.context, job.id, authorization);
          if (saved.date !== day.date) throw Object.assign(new Error(t('HiBob hat nach dem Speichern einen anderen Tag geliefert.')), { uncertain: true });
          result.status = 'verified'; result.message = t('Gespeichert und erneut aus HiBob gelesen.'); this.state.progress.completed = i + 1;
        } catch (error) {
          this.connectionFailure(error);
          result.status = object(error) && error.uncertain ? 'uncertain' : 'failed'; result.message = errorText(error); run.status = this.cancelRequested ? 'stopped' : 'failed';
          this.state.error = t('{date}: {message} Der Lauf wurde gestoppt; das Wochenziel ist möglicherweise noch nicht erreicht.', { date: day.date, message: result.message }); break;
        }
        try { await this.persist(); } catch (error) { this.journalFailure(run, error); break; }
        if (!this.cancelRequested && dates.includes(day.date) && run.results.some(item => item.status === 'pending')) {
          run.status = 'paused'; run.checkpointDate = day.date; job.status = 'paused'; job.checkpointId = crypto.randomUUID(); job.updatedAt = run.updatedAt = new Date().toISOString();
          this.state.progress = undefined;
          try { await this.persist(); } catch (error) { this.journalFailure(run, error); break; }
          if (!this.cancelRequested) {
            this.checkpoint = { plan: clone(plan), planRevision: this.planRevision, connection: clone(connection), job: clone(job), run: clone(run), dates: [...dates] };
            paused = true;
            break;
          }
          run.status = 'stopped';
        }
      }
      if (run.status === 'running') run.status = this.cancelRequested ? 'stopped' : 'complete';
      if (run.status === 'stopped') this.state.error = t('Lauf abgebrochen. Bereits bestätigte Buchungen bleiben erhalten. Vor dem Fortsetzen erneut einlesen.');
    } catch (error) { this.connectionFailure(error); failure = error; this.journalFailure(run, error); }
    finally {
      this.state.progress = undefined;
      if (!paused) {
        this.checkpoint = undefined; run.updatedAt = new Date().toISOString();
        if (this.state.job?.id === job.id) this.state.job = undefined;
        this.invalidateScan();
        try { await this.persist(); } catch (error) { this.journalFailure(run, error); failure ??= error; this.touch(); }
      }
      this.busy = false;
    }
    if (failure) throw new Error(this.state.error || errorText(failure)); return clone(this.state);
  }

  /** Read-only preflight never stages, creates or deletes attendance entries. */
  async preflight(input: BookingPlan, expectedPlanRevision: number, date: string, confirmation?: AccountConfirmation): Promise<{ state: SessionState; preflight: PreflightResult }> {
    if (this.isLocked()) throw new Error(t('Ein Vorgang läuft bereits.'));
    const { plan, authorization } = this.authorizePlan(input, expectedPlanRevision, confirmation, false);
    const day = plan.days.find(item => item.date === date);
    if (!day?.eligible || !['create', 'overwrite'].includes(day.action) || !day.proposed.length) throw new Error(t('Dieser Tag ist nicht zum Schreiben freigegeben.'));
    const connection = this.requireConnection(); this.busy = true; this.cancelRequested = false; this.state.error = undefined;
    const job = this.newJob('apply', connection, plan.settings.month); this.state.job = job;
    this.state.progress = { jobId: job.id, phase: 'apply', completed: 0, total: 1, date, message: t('Buchungsplan wird ohne Speichern geprüft …') };
    let result: PreflightResult | undefined; let failure: unknown;
    try {
      await this.persist();
      if (this.cancelRequested) throw new Error(t('Vorgang abgebrochen.'));
      const checked = await this.bridge.preflightDay(connection, day, plan.snapshot.context, job.id, authorization);
      if (this.cancelRequested) throw new Error(t('Vorgang abgebrochen.'));
      this.assertPreflight(day, checked);
      result = { date: checked.date, checked: true, saved: false, serverValidated: false, netMinutes: checked.netMinutes };
    } catch (error) { this.connectionFailure(error); failure = error; this.state.error = errorText(error); }
    finally {
      this.state.progress = undefined;
      if (this.state.job?.id === job.id) this.state.job = undefined;
      this.invalidateScan();
      try { await this.persist(); }
      catch (error) { this.state.error ||= errorText(error); failure ??= error; this.touch(); }
      finally { this.busy = false; }
    }
    if (failure) throw new Error(this.state.error || errorText(failure));
    return { state: clone(this.state), preflight: result! };
  }

  private authorizePlan(input: BookingPlan, expectedPlanRevision: number, confirmation?: AccountConfirmation, writing = true): { plan: BookingPlan; authorization: ApplyAuthorization } {
    const plan = this.state.plan;
    if (expectedPlanRevision !== this.planRevision || this.approvedPlanRevision !== this.planRevision || !plan || !this.state.snapshot || input.id !== plan.id || !sameJsonValue(input, plan)) throw stalePlan();
    assertWritablePlan(plan);
    const connection = this.requireConnection(writing);
    this.assertConnectionContext(plan.snapshot.context, connection);
    if (writing && !connection.capabilities?.overwrite && plan.days.some(day => day.action === 'overwrite')) throw new Error(t('Das Überschreiben ist über diese HiBob-Verbindung nicht freigegeben.'));
    const authorization: ApplyAuthorization = { planId: plan.id, planRevision: expectedPlanRevision, contextFingerprint: contextFingerprint(plan.snapshot.context), ...(confirmation ? { confirmation: clone(confirmation) } : {}) };
    assertApplyAuthorization(plan.snapshot.context, authorization);
    return { plan, authorization };
  }

  private assertPreflight(day: DayPlan, result: PreflightResult): void {
    if (!object(result) || result.date !== day.date || result.checked !== true || result.saved !== false || result.serverValidated !== false || !Number.isSafeInteger(result.netMinutes) || result.netMinutes !== day.netMinutes || netMinutes(day.proposed) !== day.netMinutes) {
      throw new Error(t('Die API-Vorprüfung hat kein eindeutiges Ergebnis ohne Speicherung geliefert. Bitte den Monat erneut einlesen.'));
    }
  }

  async cancel(jobId?: string): Promise<void> {
    const job = this.state.job;
    if (!this.busy && this.isPaused() && job) {
      if (jobId !== undefined && jobId !== job.id) throw new Error(t('Der laufende Vorgang wurde geändert. Bitte den aktuellen Status prüfen.'));
      this.busy = true;
      this.checkpoint = undefined; this.cancelRequested = true;
      if (this.state.run) { this.state.run.status = 'stopped'; this.state.run.updatedAt = new Date().toISOString(); }
      this.state.job = undefined; this.state.progress = undefined; this.invalidateScan();
      this.state.error = t('Lauf abgebrochen. Bereits bestätigte Buchungen bleiben erhalten. Vor dem Fortsetzen erneut einlesen.');
      try { await this.persist(); }
      catch (error) { if (this.state.run) this.journalFailure(this.state.run, error); this.touch(); throw error; }
      finally { this.busy = false; }
      return;
    }
    if (!this.busy || !job) return;
    if (jobId !== undefined && jobId !== job.id) throw new Error(t('Der laufende Vorgang wurde geändert. Bitte den aktuellen Status prüfen.'));
    this.cancelRequested = true; job.status = 'cancelling'; job.updatedAt = new Date().toISOString();
    this.touch();
    const connection = this.state.connection;
    if (connection && connection.generation === job.connectionId) await this.bridge.cancel(clone(connection), job.id).catch(() => {});
  }
  private journalFailure(run: RunState, error: unknown): void {
    run.status = 'failed'; run.journalError = errorText(error);
    const message = t('Das lokale Buchungsjournal konnte nicht gespeichert werden: {error}. Bereits verifizierte Tage bleiben gespeichert. Vor weiteren Buchungen erneut einlesen.', { error: run.journalError });
    this.state.error = this.state.error ? `${this.state.error} ${message}` : message;
  }
  private newJob(kind: JobState['kind'], connection: ApiConnection, month: string): JobState { const now = new Date().toISOString(); return { id: crypto.randomUUID(), kind, status: 'running', connectionId: connection.generation, month, startedAt: now, updatedAt: now }; }
  private isPaused(): boolean { return this.state.job?.status === 'paused' || this.state.run?.status === 'paused'; }
  private isLocked(): boolean { return this.busy || this.isPaused(); }
  private currentLease(lease: PlanEditLease | undefined): lease is PlanEditLease { return !!lease && lease.planRevision === this.planRevision && this.state.editLease?.planRevision === lease.planRevision && this.state.editLease.changeId === lease.changeId; }
  private advancePlanRevision(): void { this.state.planRevision = ++this.planRevision; this.approvedPlanRevision = undefined; this.durableLease = undefined; this.leaseCandidate = undefined; }
  private invalidateScan(): void { this.state.snapshot = undefined; if (this.state.plan) this.state.plan.canReview = false; this.state.editLease = undefined; this.advancePlanRevision(); }
  /** Only a tagged adapter failure can revoke authentication; display text is not an auth signal. */
  private connectionFailure(error: unknown): void {
    if (!object(error) || error.connectionStatus !== 'expired' && error.connectionStatus !== 'unsupported') return;
    const status = error.connectionStatus;
    this.state.connection = {
      ...this.state.connection,
      status,
      generation: crypto.randomUUID(),
      capabilities: { read: false, write: false, overwrite: false },
      reason: status === 'expired' ? t('Bitte zuerst bei HiBob anmelden und die Verbindung prüfen.') : t('Die HiBob-Kontozuordnung ist nicht unterstützt.'),
    };
    this.invalidateScan();
  }
  private requireConnection(writing = false): ApiConnection {
    const connection = this.state.connection;
    if (!validConnection(connection) || connection.status !== 'connected' || !connection.capabilities?.read) throw new Error(t('Bitte zuerst bei HiBob anmelden und die Verbindung prüfen.'));
    if (writing && !connection.capabilities.write) throw new Error(t('Das Speichern ist über diese HiBob-Verbindung noch nicht freigegeben. Die Vorprüfung bleibt verfügbar.'));
    return connectionValue(connection);
  }
  private assertConnectionContext(context: AttendanceContext | undefined, connection: ApiConnection): void {
    if (context?.mode !== 'api-session' || context.connectionId !== connection.generation || context.employeeKey !== connection.employeeId || context.tenantKey !== connection.companyId) throw new Error(t('Das HiBob-Konto oder die Sitzung hat sich geändert. Bitte erneut verbinden und den Monat einlesen.'));
  }
  private touch(): void { this.state.schemaVersion = 5; this.state.revision = ++this.revision; this.state.planRevision = this.planRevision; }
  private async persist(): Promise<void> { this.touch(); const state = clone(this.state); const operation = this.persistence.then(() => this.bridge.save(state)); this.persistence = operation.catch(() => {}); await operation; }
}
