export type LocalDate = string;
export type ConflictChoice = 'overwrite' | 'skip';
export type ConflictChoices = Record<LocalDate, ConflictChoice>;

export type AttendanceContext =
  | { mode: 'api-session'; connectionId: string; employeeKey: string; tenantKey: string }
  | { mode: 'stable-identity'; documentId: string; employeeKey: string; tenantKey: string }
  | { mode: 'user-confirmed-ui'; documentId: string; pageUrl: string; markerFingerprint: string }
  | { mode: 'unavailable'; documentId: string; reason: string };

export interface ApiConnection {
  status: 'disconnected' | 'connected' | 'expired' | 'unsupported';
  generation: string;
  employeeId?: string;
  companyId?: string;
  employeeLabel?: string;
  companyLabel?: string;
  transport?: 'direct' | 'temporary-tab';
  capabilities?: { read: boolean; write: boolean; overwrite: boolean };
  reason?: string;
}

/** Read-only preflight. It does not claim that a server accepted unsaved entries. */
export interface PreflightResult {
  date: LocalDate;
  checked: true;
  saved: false;
  serverValidated: false;
  netMinutes: number;
}

/** Explicit consent to one immutable plan, never a preference or reusable identity. */
export interface AccountConfirmation {
  planId: string;
  planRevision: number;
  contextFingerprint: string;
  confirmed: true;
  /** Fresh, public scope marker for one paused checkpoint; never reusable consent. */
  checkpointId?: string;
}

/** Produced by the controller after checking the current reviewed plan and consent. */
export interface ApplyAuthorization {
  planId: string;
  planRevision: number;
  contextFingerprint: string;
  confirmation?: AccountConfirmation;
}

export interface PlanEditLease {
  planRevision: number;
  changeId: string;
}

export interface JobState {
  id: string;
  kind: 'scan' | 'apply';
  status: 'running' | 'cancelling' | 'paused' | 'interrupted';
  connectionId?: string;
  checkpointId?: string;
  /** Legacy migration input only. New jobs bind to connectionId. */
  tabId?: number;
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

/** Transient evidence from staging, cancelling and rereading one unchanged day. */
export interface DraftCheckResult {
  date: LocalDate;
  entries: AttendanceEntry[];
  netMinutes: number;
  saved: false;
  unchanged: true;
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
  canReview: boolean;
}

export interface DayResult {
  date: LocalDate;
  status: 'pending' | 'running' | 'verified' | 'skipped' | 'failed' | 'uncertain';
  message: string;
}

export interface RunState {
  runId?: string;
  planId: string;
  status: 'running' | 'paused' | 'complete' | 'stopped' | 'failed';
  checkpointDate?: LocalDate;
  results: DayResult[];
  startedAt: string;
  updatedAt: string;
  journalError?: string;
}

/** Execution boundaries leave the reviewed monthly allocation unchanged. */
export interface RunOptions {
  checkpointDates?: LocalDate[];
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
  | { type: 'APPLY_DAY'; day: DayPlan; context?: AttendanceContext; authorization: ApplyAuthorization; jobId: string }
  | { type: 'CHECK_DAY_DRAFT'; day: DayPlan; context?: AttendanceContext; authorization: ApplyAuthorization; jobId: string }
  | { type: 'CANCEL'; jobId: string }
  | { type: 'PING' };

export type AdapterResponse =
  | { ok: true; snapshot?: MonthSnapshot; day?: DaySnapshot; draftCheck?: DraftCheckResult; protocolVersion?: number; extensionVersion?: string; activeJob?: { id: string; kind: 'scan' | 'apply' } }
  | { ok: false; error: string; uncertain?: boolean };

export interface UpdateStatus {
  installedVersion: string;
  pendingVersion?: string;
}

export interface SessionState {
  /** Optional on input only, for migration from older sessions. */
  schemaVersion?: 2 | 3 | 4 | 5;
  connection?: ApiConnection;
  revision?: number;
  planRevision?: number;
  editLease?: PlanEditLease;
  job?: JobState;
  tabId?: number;
  snapshot?: MonthSnapshot;
  plan?: BookingPlan;
  run?: RunState;
  progress?: AdapterProgress;
  update?: UpdateStatus;
  updateApplying?: boolean;
  error?: string;
}
