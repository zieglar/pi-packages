import type { AuthoritativeTaskState } from "./state.js";
import type { ExecutionResult } from "../types/result.js";
import type { TaskId } from "../types/identity.js";
import type { ContinuationPackage } from "../recovery/continuation.js";
import type { InvocationId } from "../types/identity.js";

/**
 * Durable storage contracts. `DurableTaskStore` is the single production
 * storage authority: versioned per-task snapshots plus fenced local leases.
 * The narrower legacy interfaces below remain only as deprecated structural
 * aliases for existing adapter tests; nothing else may implement them as a
 * second production authority.
 */

/** Authoritative task status; terminal states are `completed` and `cancelled`. */
export type DurableTaskStatus = AuthoritativeTaskState["status"];

/**
 * Fenced lease over one task. `ownerToken` and `leaseGeneration` must match
 * the store's authoritative generation for heartbeat and release; PID is
 * diagnostic only and never part of fencing.
 */
export interface TaskLease {
  readonly taskId: TaskId;
  readonly ownerToken: string;
  readonly leaseGeneration: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Unified durable task store contract. `create` inserts at revision 0,
 * `update` is conditional on `expectedRevision`, and `list` enumerates all
 * snapshots deterministically (ascending `taskId`). Lease acquisition
 * reclaims expired claims and increments the persisted `leaseGeneration`.
 */
export interface DurableTaskStore {
  create(state: AuthoritativeTaskState): Promise<ExecutionResult<AuthoritativeTaskState>>;
  load(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState | null>>;
  list(): Promise<ExecutionResult<readonly AuthoritativeTaskState[]>>;
  update(
    expectedRevision: number,
    next: AuthoritativeTaskState,
    lease?: TaskLease,
  ): Promise<ExecutionResult<AuthoritativeTaskState>>;
  acquireLease(taskId: TaskId, ttlMs: number): Promise<ExecutionResult<TaskLease>>;
  heartbeatLease(lease: TaskLease, ttlMs: number): Promise<ExecutionResult<TaskLease>>;
  releaseLease(lease: TaskLease): Promise<ExecutionResult<void>>;
}

/** Host-neutral continuation launch boundary; Pi implementation comes later. */
export interface ContinuationLauncher {
  launch(
    packageData: ContinuationPackage,
    preallocatedContinuationId: string,
  ): Promise<ExecutionResult<ContinuationLaunchResult>>;
}

export interface ContinuationLaunchResult {
  readonly invocationId: InvocationId;
  readonly sessionId?: string;
  readonly progressSummary?: string;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests. The
 * unified `DurableTaskStore` is the sole production contract.
 */
export interface TaskStore {
  load(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState | null>>;
  save(state: AuthoritativeTaskState): Promise<ExecutionResult<AuthoritativeTaskState>>;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests. The
 * unified `DurableTaskStore` is the sole production contract.
 */
export interface CheckpointStore {
  save(taskId: TaskId, checkpoint: AuthoritativeTaskState["checkpoint"]): Promise<ExecutionResult<void>>;
  loadLatest(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState["checkpoint"] | null>>;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests. Fenced
 * leases live on `DurableTaskStore` (`acquireLease`/`heartbeatLease`/`releaseLease`).
 */
export interface Lease {
  readonly taskId: TaskId;
  readonly holder: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests. The
 * unified `DurableTaskStore` is the sole production contract.
 */
export interface LeaseStore {
  acquire(taskId: TaskId, holder: string, ttlMs: number): Promise<ExecutionResult<Lease>>;
  release(lease: Lease): Promise<ExecutionResult<void>>;
}

export interface SuspensionRecord {
  readonly taskId: TaskId;
  readonly reason: string;
  readonly resumeAtMs?: number;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests. Typed
 * suspension is persisted inside `AuthoritativeTaskState.suspension`.
 */
export interface SuspensionStore {
  suspend(record: SuspensionRecord): Promise<ExecutionResult<void>>;
  resume(taskId: TaskId): Promise<ExecutionResult<SuspensionRecord | null>>;
}

export interface ContinuationRecord {
  readonly taskId: TaskId;
  readonly requestedBy: string;
  readonly reason: string;
  readonly requestedAtMs: number;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests.
 * Continuation launch state is persisted inside `AuthoritativeTaskState.continuation`.
 */
export interface ContinuationStore {
  save(record: ContinuationRecord): Promise<ExecutionResult<void>>;
  loadLatest(taskId: TaskId): Promise<ExecutionResult<ContinuationRecord | null>>;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests. Drift
 * validation is implemented by the dedicated drift validator module.
 */
export interface DriftValidator {
  validate(state: AuthoritativeTaskState, checkpoint: AuthoritativeTaskState["checkpoint"]): ExecutionResult<void>;
}

export interface CompletionEvidence {
  readonly taskId: TaskId;
  readonly summary: string;
  readonly recordedAtMs: number;
}

/**
 * @deprecated Structural alias retained for Phase 1A adapter tests.
 * Completion evidence references live in `AuthoritativeTaskState.evidence`.
 */
export interface CompletionEvidenceStore {
  record(evidence: CompletionEvidence): Promise<ExecutionResult<void>>;
  load(taskId: TaskId): Promise<ExecutionResult<CompletionEvidence | null>>;
}
