import type { AuthoritativeTaskState } from "./state.js";
import type { ExecutionResult } from "../types/result.js";
import type { TaskId } from "../types/identity.js";

/**
 * Durable-lite storage contracts. Phase 1A defines interfaces only: no
 * wake/resume engine, scheduling, drift reconciliation job, or completion
 * authority is implemented.
 */

export interface TaskStore {
  load(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState | null>>;
  save(state: AuthoritativeTaskState): Promise<ExecutionResult<AuthoritativeTaskState>>;
}

export interface CheckpointStore {
  save(taskId: TaskId, checkpoint: AuthoritativeTaskState["checkpoint"]): Promise<ExecutionResult<void>>;
  loadLatest(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState["checkpoint"] | null>>;
}

/** Lease over a task; acquisition, renewal, and expiry are store-owned. */
export interface Lease {
  readonly taskId: TaskId;
  readonly holder: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface LeaseStore {
  acquire(taskId: TaskId, holder: string, ttlMs: number): Promise<ExecutionResult<Lease>>;
  release(lease: Lease): Promise<ExecutionResult<void>>;
}

export interface SuspensionRecord {
  readonly taskId: TaskId;
  readonly reason: string;
  readonly resumeAtMs?: number;
}

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

export interface ContinuationStore {
  save(record: ContinuationRecord): Promise<ExecutionResult<void>>;
  loadLatest(taskId: TaskId): Promise<ExecutionResult<ContinuationRecord | null>>;
}

export interface DriftValidator {
  validate(state: AuthoritativeTaskState, checkpoint: AuthoritativeTaskState["checkpoint"]): ExecutionResult<void>;
}

export interface CompletionEvidence {
  readonly taskId: TaskId;
  readonly summary: string;
  readonly recordedAtMs: number;
}

export interface CompletionEvidenceStore {
  record(evidence: CompletionEvidence): Promise<ExecutionResult<void>>;
  load(taskId: TaskId): Promise<ExecutionResult<CompletionEvidence | null>>;
}
