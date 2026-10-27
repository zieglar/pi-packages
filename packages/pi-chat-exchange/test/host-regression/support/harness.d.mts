/** Types for the plain-JS real-host regression harness (see harness.mjs). */

export interface Paths {
  readonly root: string;
  readonly raw: string;
  readonly home: string;
  readonly profile: string;
  readonly bindings: string;
  readonly agent: string;
  readonly sessions: string;
  readonly cwd: string;
  readonly tmp: string;
  readonly trustedClient: string;
  readonly accountHook: string;
  readonly accountLog: string;
  readonly providerState: string;
  readonly extract: string;
  readonly assertions: string;
  readonly "xdg-cache": string;
  readonly "xdg-config": string;
  readonly "xdg-data": string;
  readonly "xdg-state": string;
}

export interface IdentityReport {
  readonly head: string;
  readonly worktreeDirty: string;
  readonly dirtySources: string;
  readonly compared: number;
  readonly tracked: number;
  readonly mismatches: string[];
  readonly missing: string[];
  readonly extra: string[];
}

export interface Built {
  readonly extensionPath: string;
  readonly distRoot: string;
  readonly packageRoot: string;
  readonly reconcileScript: string;
  readonly identity: IdentityReport;
}

export interface Registration {
  readonly endpointId: string;
  readonly runtimeSessionId: string;
  readonly payloadRead: boolean;
  readonly ack: boolean;
  readonly epoch: number;
  readonly status: string;
}

export interface StoreRef {
  readonly directory: string;
  readonly file: string;
}

export interface OwnershipRow {
  readonly participant_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly lease_started_at: string;
  readonly expires_at: string;
  readonly private_revision: number;
}

export interface LeaseRow {
  readonly participant_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly expires_at: string;
  readonly lease_started_at: string;
  readonly now: string;
  readonly lease: "ACTIVE" | "EXPIRED" | "CLOCK_REGRESSION" | "UNOWNED";
  readonly secondsPastExpiry: number;
  readonly secondsRemaining: number;
}

export interface MessageRow {
  readonly message_id: string;
  readonly exchange_id: string;
  readonly sender: string | null;
  readonly recipient: string | null;
  readonly state: string;
  readonly idempotency_key: string | null;
  readonly created_at: string;
}

export interface AuditRow {
  readonly event_id: string;
  readonly exchange_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly subject_id: string;
  readonly outcome: string | null;
  readonly created_at: string;
}

export interface MutexSlot {
  readonly slot: string;
  readonly files: Record<string, { readonly sha256: string; readonly bytes: string; readonly dev: number; readonly ino: number }>;
  readonly dir: { readonly dev: number; readonly ino: number };
  readonly released: boolean;
  readonly receiptEqualsOwner: boolean;
}

export interface PiSessionFile {
  readonly name: string;
  readonly size: number;
  readonly mtime: string;
  readonly entryCount?: number;
  readonly entryTypes?: Record<string, number>;
  readonly ceEntries?: Array<{ readonly customType: string; readonly data: unknown }>;
  readonly hasUserMessage?: boolean;
}

export interface Snapshot {
  readonly label: string;
  readonly capturedAt: string;
  readonly file: string;
  readonly bindings: { readonly entries: ReadonlyArray<{ readonly name: string; readonly registrations?: Registration[] }> };
  readonly store: { readonly path: string; readonly exists: boolean; readonly stat?: { readonly dev: number; readonly ino: number; readonly mode: string; readonly size: number } };
  readonly participants?: ReadonlyArray<Record<string, unknown>>;
  readonly ownership?: ReadonlyArray<OwnershipRow>;
  readonly fencingHighWater?: ReadonlyArray<{ readonly participant_id: string; readonly fencing_token: number }>;
  readonly sessionsBound?: ReadonlyArray<{ readonly participant_id: string; readonly session_id: string; readonly bound_at: string; readonly detached_at: string | null }>;
  readonly messages?: ReadonlyArray<MessageRow>;
  readonly auditEvents?: ReadonlyArray<AuditRow>;
  readonly leaseEvaluation?: ReadonlyArray<LeaseRow>;
  readonly mutex?: { readonly root: string; readonly exists: boolean; readonly scopes: ReadonlyArray<{ readonly scope: string; readonly slots: MutexSlot[] }> };
  readonly piSessions: { readonly dir: string; readonly files: PiSessionFile[] };
}

export interface Publication {
  readonly store: StoreRef;
  readonly registrations: Registration[];
  readonly api: {
    revision(): string;
    revoke(input: { readonly expectedRevision: string; readonly endpointId: string }): Promise<unknown>;
  };
}

export interface DeathEvidence {
  readonly pid: number;
  readonly at: string;
  readonly label: string;
  readonly psStatus: number;
  readonly psStdout: string;
  readonly psStderr: string;
  readonly definitive: boolean;
}

export interface ReconcileRecord {
  readonly argv: string[];
  readonly cwd: string;
  readonly at: string;
  readonly status: number;
  readonly signal: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReapedLaunch {
  readonly name: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly reaped: true;
  readonly exit: number;
  readonly generation: string;
  readonly anchorPid: number;
  readonly pgid: number;
  readonly guardianPid: number;
  readonly confirmed: true;
  readonly groupDead: true;
  readonly anchorReaped: true;
  readonly driverLost: false;
  readonly events: readonly string[];
  readonly members: ReadonlyArray<{ pid: number; dead: boolean; reaped: false }>;
}

export interface LaunchMeta {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly pid: number;
  readonly actions: unknown[];
  readonly exit: number | null;
  readonly cleanup?: ReapedLaunch;
}

export interface Driver {
  readonly child: unknown;
  readonly guardian: unknown;
  stderr(): string;
  launch(name: string, argv: string[], environment: Record<string, string>, cwd: string, waitSeconds?: number): { readonly pid: number };
  send(text: string, waitSeconds?: number): void;
  snapshot(): { readonly pid: number; readonly exit: number | null; readonly tail: string; readonly at: number };
  kill(): { readonly pid: number; readonly exit: number };
  awaitExit(timeoutMs?: number): ReapedLaunch;
  requireOffline(): ReapedLaunch;
  stop(): Promise<void>;
  waitFor(name: string, predicate: (text: string) => string | undefined | false, timeoutMs: number, note?: string): Promise<{ readonly text: string; readonly matched: string }>;
}

export interface AccountingSummary {
  readonly total: number;
  readonly unsupportedEscapes: number;
  readonly distinctCommands: ReadonlyArray<[string, number]>;
  readonly tunnelClientExecutions: number;
  readonly tunnelClientRecords: ReadonlyArray<Record<string, unknown>>;
}

export interface Prerequisites {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly driverPath: string;
}

export const packageRoot: string;
export const repoRoot: string;
export const cliPath: string;
export const driverPath: string;
export const nodePath: string;
export const LEASE_TTL_SECONDS: number;
export const RUNTIME_SESSION: string;
export const ENDPOINT_ID: string;

export function assertPrerequisites(): Prerequisites;
export function prepareRoot(): Paths;
export function buildFixedHead(paths: Paths): Built;
export function startProvider(paths: Paths): Promise<{ readonly server: { closeAllConnections(): void }; readonly port: number; close(): Promise<void> }>;
export function setProviderDirective(paths: Paths, directive: { mode: string; tool?: string; args?: Record<string, unknown> }): void;
export function piEnvironment(paths: Paths, overrides?: Record<string, string>): Record<string, string>;
export function piArgv(paths: Paths, built: Built, options?: { sessionId?: string; resume?: string }): string[];
export function publishConfiguration(paths: Paths, built: Built): Promise<Publication>;
export function revokeRegistration(publication: Publication): Promise<unknown>;
export function restoreRegistration(publication: Publication): Promise<unknown>;
export function captureAuthority(paths: Paths, label: string): Snapshot;
export function ownershipRow(snapshot: Snapshot): OwnershipRow | undefined;
export function slotCount(snapshot: Snapshot): number;
export function unreleasedSlots(snapshot: Snapshot): MutexSlot[];
export function deathEvidence(paths: Paths, pid: number, label: string): DeathEvidence;
export function deriveReconcileArguments(snapshot: Snapshot, store: StoreRef, death: string): string[];
export function runReconcile(paths: Paths, built: Built, argv: string[], label: string, driver: Driver): ReconcileRecord & { offlineBefore: ReapedLaunch; offlineAfter: ReapedLaunch };
export function startDriver(paths: Paths): Driver;
export function finishRun(paths: Paths | undefined, driver: Pick<Driver, "stop"> | undefined,
  provider: { close(): Promise<void>; server?: { closeAllConnections?(): void } } | undefined,
  options: { successful: boolean; keep?: boolean }): Promise<{ retained: boolean }>;
export function terminalText(paths: Paths, name: string): string;
export function launchMeta(paths: Paths, name: string): LaunchMeta;
export function accounting(paths: Paths): AccountingSummary;
export function recordAssertion(paths: Paths, id: string, status: string, detail: string, evidence: string): void;
export function sleep(ms: number): Promise<void>;
export function waitForLease(paths: Paths, predicate: (lease: LeaseRow) => boolean, timeoutMs: number, note?: string): Promise<{ readonly snapshot: Snapshot; readonly lease: LeaseRow }>;
