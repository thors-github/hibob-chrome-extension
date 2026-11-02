import { t } from './i18n/index';
import { buildMonthPlan } from './domain/index';
import { assertWritablePlan } from './shared/validation';
import { sameJsonValue } from './shared/json';
import type { AdapterProgress, BookingPlan, DayPlan, DaySnapshot, MonthSnapshot, RunState, SessionState } from './shared/types';

export interface ControllerBridge {
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  scan(tabId: number, month: string): Promise<MonthSnapshot>;
  applyDay(tabId: number, day: DayPlan): Promise<DaySnapshot>;
  cancel(tabId: number): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns the only write queue. A reviewed plan is bound to one scan and one tab. */
export class BookingController {
  state: SessionState = {};
  private busy = false;
  private cancelRequested = false;
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: ControllerBridge) {}

  async init(): Promise<void> {
    this.state = (await this.bridge.load()) ?? {};
    if (this.state.run?.status === 'running') {
      this.state.run.status = 'stopped';
      for (const result of this.state.run.results) {
        if (result.status === 'running') { result.status = 'uncertain'; result.message = t('Ausführung unterbrochen. Persistierten Zustand erneut einlesen.'); }
      }
      this.invalidateScan();
      this.state.error = t('Der letzte Lauf wurde unterbrochen. Vor weiteren Buchungen den Monat erneut einlesen.');
      await this.persist();
    }
  }

  async bindTab(tabId: number | undefined, error?: string): Promise<void> {
    if (this.busy) throw new Error(t('Ein Vorgang läuft bereits. Bitte zuerst abbrechen.'));
    if (tabId === undefined || this.state.tabId !== tabId) this.state = {};
    if (tabId !== undefined) this.state.tabId = tabId;
    this.state.error = error;
    await this.persist();
  }

  async reportProgress(progress: AdapterProgress): Promise<void> {
    if (!this.busy) return;
    const run = this.state.run;
    this.state.progress = progress.phase === 'apply' && run?.status === 'running'
      ? { ...progress, completed: run.results.filter(r => r.status === 'verified').length, total: run.results.filter(r => r.status !== 'skipped').length }
      : progress;
    await this.persist();
  }

  async scan(month: string): Promise<SessionState> {
    if (this.busy) throw new Error(t('Ein Vorgang läuft bereits.'));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(t('Bitte einen gültigen Monat auswählen.'));
    const tabId = this.requireTab();
    this.busy = true;
    this.cancelRequested = false;
    this.state.error = undefined;
    this.state.snapshot = undefined;
    this.state.plan = undefined;
    this.state.run = undefined;
    this.state.progress = { phase: 'scan', completed: 0, total: 0, message: t('HiBob-Monat wird eingelesen …') };
    try {
      await this.persist();
      const snapshot = await this.bridge.scan(tabId, month);
      if (this.cancelRequested) throw new Error(t('Einlesen abgebrochen.'));
      if (snapshot.month !== month || snapshot.source !== 'hibob') throw new Error(t('HiBob hat einen unerwarteten Monat geliefert.'));
      this.state.snapshot = snapshot;
    } catch (error) {
      this.state.error = errorText(error);
      throw error;
    } finally {
      this.state.progress = undefined;
      this.busy = false;
      await this.persist();
    }
    return clone(this.state);
  }

  async savePlan(input: BookingPlan): Promise<SessionState> {
    if (this.busy) throw new Error(t('Während eines Vorgangs kann die Vorschau nicht geändert werden.'));
    const snapshot = this.state.snapshot;
    if (!snapshot || !sameJsonValue(input.snapshot, snapshot)) throw new Error(t('Die Vorschau gehört nicht zum aktuellen HiBob-Lesestand. Bitte erneut einlesen.'));
    // Proposed segments from the UI are never trusted; recompute from settings and the stored scan.
    this.state.plan = buildMonthPlan(input.settings, snapshot, input.choices, input.seed);
    this.state.error = undefined;
    await this.persist();
    return clone(this.state);
  }

  async apply(input: BookingPlan): Promise<SessionState> {
    if (this.busy) throw new Error(t('Ein Vorgang läuft bereits.'));
    const plan = this.state.plan;
    if (!plan || !this.state.snapshot || input.id !== plan.id || !sameJsonValue(input, plan)) throw new Error(t('Die Vorschau wurde geändert. Bitte zuerst die aktuelle Vorschau prüfen.'));
    assertWritablePlan(plan);
    const tabId = this.requireTab();
    this.busy = true;
    this.cancelRequested = false;
    this.state.error = undefined;
    const changes = plan.days.filter(d => d.action === 'create' || d.action === 'overwrite');
    const run: RunState = {
      planId: plan.id, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      results: plan.days.map(day => ({ date: day.date, status: (day.action === 'create' || day.action === 'overwrite') ? 'pending' : 'skipped', message: day.reason ?? t('Keine Änderung.') })),
    };
    this.state.run = run;
    try {
      await this.persist();
      for (let i = 0; i < changes.length; i++) {
        if (this.cancelRequested) break;
        const day = changes[i];
        const result = run.results.find(r => r.date === day.date)!;
        result.status = 'running';
        result.message = t('Tageszustand prüfen und Buchung speichern …');
        run.updatedAt = new Date().toISOString();
        this.state.progress = { phase: 'apply', completed: i, total: changes.length, date: day.date, message: result.message };
        // Journal BEFORE writing, so an interrupted worker cannot silently retry a possibly saved day.
        await this.persist();
        if (this.cancelRequested) {
          result.status = 'pending';
          result.message = t('Vor dem Schreiben abgebrochen.');
          break;
        }
        try {
          const saved = await this.bridge.applyDay(tabId, day);
          if (saved.date !== day.date) throw new Error(t('HiBob hat nach dem Speichern einen anderen Tag geliefert.'));
          result.status = 'verified';
          result.message = t('Gespeichert und erneut aus HiBob gelesen.');
          this.state.progress.completed = i + 1;
          await this.persist();
        } catch (error) {
          result.status = typeof error === 'object' && error !== null && 'uncertain' in error && error.uncertain ? 'uncertain' : 'failed';
          result.message = errorText(error);
          run.status = this.cancelRequested ? 'stopped' : 'failed';
          this.state.error = t('{date}: {message} Der Lauf wurde gestoppt; das Wochenziel ist möglicherweise noch nicht erreicht.', { date: day.date, message: result.message });
          break;
        }
      }
      if (run.status === 'running') run.status = this.cancelRequested ? 'stopped' : 'complete';
      if (run.status === 'stopped') this.state.error = t('Lauf abgebrochen. Bereits bestätigte Buchungen bleiben erhalten. Vor dem Fortsetzen erneut einlesen.');
    } catch (error) {
      run.status = 'failed';
      this.state.error = t('Buchungslauf gestoppt: {error} Vor weiteren Buchungen erneut einlesen.', { error: errorText(error) });
      throw error;
    } finally {
      run.updatedAt = new Date().toISOString();
      this.state.progress = undefined;
      this.busy = false;
      this.invalidateScan();
      await this.persist();
    }
    return clone(this.state);
  }

  async cancel(): Promise<void> {
    if (!this.busy) return;
    this.cancelRequested = true;
    if (this.state.tabId !== undefined) await this.bridge.cancel(this.state.tabId).catch(() => {});
  }

  private invalidateScan(): void {
    this.state.snapshot = undefined;
    if (this.state.plan) this.state.plan.canApply = false;
  }

  private requireTab(): number {
    if (this.state.tabId === undefined) throw new Error(t('HiBob öffnen und dort auf das Extension-Symbol klicken.'));
    return this.state.tabId;
  }

  private async persist(): Promise<void> {
    const state = clone(this.state);
    const operation = this.persistence.then(() => this.bridge.save(state));
    this.persistence = operation.catch(() => {});
    await operation;
  }
}
