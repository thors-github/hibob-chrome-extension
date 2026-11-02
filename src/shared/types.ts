export type LocalDate = string;
export type ConflictChoice = 'overwrite' | 'skip';
export type ConflictChoices = Record<LocalDate, ConflictChoice>;

export interface AttendanceContext {
  documentId: string;
  employeeKey?: string;
  tenantKey?: string;
  verified: boolean;
  reason?: string;
}

export interface PlanEditLease {
  planRevision: number;
  changeId: string;
}

export interface JobState {
  id: string;
  kind: 'scan' | 'apply';
  status: 'running' | 'cancelling' | 'interrupted';
  tabId: number;
  month: string;
  startedAt: string;
  updatedAt: string;
}

export interface AttendanceEntry {
  type: 'work' | 'break';
  start: string;
  end: string;
  note?: string;
  reason?: string;
  metadata?: string[];
}

export interface DaySnapshot {
  date: LocalDate;
  entries: AttendanceEntry[];
  editable: boolean;
  absence?: string;
  nonWorking?: string;
  unsupportedReason?: string;
  fingerprint: string;
  reportedMinutes?: number | null;
}

export interface MonthSnapshot {
  month: string;
  employeeLabel: string;
  periodLabel: string;
  scannedAt: string;
  source: 'hibob' | 'demo';
  context?: AttendanceContext;
  days: DaySnapshot[];
}

export interface Settings {
  month: string;
  state: string;
  start: string;
  end: string;
  useBreak: boolean;
  breakStart: string;
  breakEnd: string;
  variable: boolean;
  variationMinutes: number;
  excludedDates: LocalDate[];
  localHolidays: {
    augsburg: boolean | null;
    assumption: boolean | null;
    corpusChristi: boolean | null;
  };
}

export interface DayPlan {
  date: LocalDate;
  existing: AttendanceEntry[];
  proposed: AttendanceEntry[];
  action: 'create' | 'overwrite' | 'skip' | 'conflict' | 'unchanged' | 'blocked';
  reason?: string;
  holiday?: string;
  netMinutes: number | null;
  existingNetMinutes: number | null;
  fingerprint: string;
  eligible: boolean;
}

export interface WeekPlan {
  week: string;
  dates: LocalDate[];
  targetMinutes: number;
  plannedMinutes: number | null;
  errors: string[];
}

export interface BookingPlan {
  id: string;
  seed: number;
  settings: Settings;
  snapshot: MonthSnapshot;
  choices: ConflictChoices;
  days: DayPlan[];
  weeks: WeekPlan[];
  errors: string[];
  canApply: boolean;
}

export interface DayResult {
  date: LocalDate;
  status: 'pending' | 'running' | 'verified' | 'skipped' | 'failed' | 'uncertain';
  message: string;
}

export interface RunState {
  planId: string;
  status: 'running' | 'complete' | 'stopped' | 'failed';
  results: DayResult[];
  startedAt: string;
  updatedAt: string;
  journalError?: string;
}

export interface AdapterProgress {
  jobId?: string;
  phase: 'scan' | 'apply';
  date?: LocalDate;
  completed: number;
  total: number;
  message: string;
}

export type AdapterCommand =
  | { type: 'SCAN_MONTH'; month: string; jobId: string }
  | { type: 'APPLY_DAY'; day: DayPlan; context?: AttendanceContext; jobId: string }
  | { type: 'CANCEL'; jobId: string }
  | { type: 'PING' };

export type AdapterResponse =
  | { ok: true; snapshot?: MonthSnapshot; day?: DaySnapshot; protocolVersion?: number; activeJob?: { id: string; kind: 'scan' | 'apply' } }
  | { ok: false; error: string; uncertain?: boolean };

export interface SessionState {
  /** Optional on input only, for migration from version 1.1.1 sessions. */
  schemaVersion?: 2;
  revision?: number;
  planRevision?: number;
  editLease?: PlanEditLease;
  job?: JobState;
  tabId?: number;
  snapshot?: MonthSnapshot;
  plan?: BookingPlan;
  run?: RunState;
  progress?: AdapterProgress;
  error?: string;
}
