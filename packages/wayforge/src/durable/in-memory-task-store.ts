import { randomBytes } from "node:crypto";
import type { DurableTaskStore, TaskLease } from "./contracts.js";
import {
  deserializeTaskState,
  serializeTaskState,
  type AuthoritativeTaskState,
} from "./state.js";
import type { TaskId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure, success } from "../types/result.js";

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

function validLeaseTtl(ttlMs: number): boolean {
  return Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= MAX_LEASE_TTL_MS;
}

function cloneState(state: AuthoritativeTaskState): AuthoritativeTaskState {
  const parsed = deserializeTaskState(serializeTaskState(state));
  if (!parsed.ok) throw new Error("validated task state failed deterministic clone");
  return parsed.value;
}

function tryCloneState(state: AuthoritativeTaskState): ExecutionResult<AuthoritativeTaskState> {
  try {
    return success(cloneState(state));
  } catch {
    return taskFailure("schema_violation", "state is outside the authoritative allowlist");
  }
}

function taskFailure(code: string, message: string): ExecutionResult<never> {
  return failure({ kind: "validation", scope: "task", confidence: "certain", code, message });
}

export interface InMemoryTaskStoreOptions {
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * In-memory `DurableTaskStore`: clones on read and write, enumerates in
 * ascending `taskId` order, enforces expected-revision updates, and fences
 * leases by random owner token plus authoritative `leaseGeneration`.
 */
export class InMemoryTaskStore implements DurableTaskStore {
  private readonly states = new Map<TaskId, AuthoritativeTaskState>();
  private readonly leases = new Map<TaskId, TaskLease>();
  private readonly now: () => number;

  constructor(options: InMemoryTaskStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async create(state: AuthoritativeTaskState): Promise<ExecutionResult<AuthoritativeTaskState>> {
    if (state.revision !== 0) {
      return taskFailure("invalid_initial_revision", "new durable tasks must start at revision zero");
    }
    if (this.states.has(state.taskId as TaskId)) {
      return taskFailure("task_already_exists", "task already exists in the durable store");
    }
    const cloned = tryCloneState(state);
    if (!cloned.ok) return cloned;
    this.states.set(state.taskId as TaskId, cloned.value);
    return success(cloneState(cloned.value));
  }

  async load(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState | null>> {
    const state = this.states.get(taskId);
    return success(state === undefined ? null : cloneState(state));
  }

  async list(): Promise<ExecutionResult<readonly AuthoritativeTaskState[]>> {
    const ordered = [...this.states.keys()].sort((left, right) => left.localeCompare(right));
    return success(ordered.map((id) => cloneState(this.states.get(id) as AuthoritativeTaskState)));
  }

  async update(
    expectedRevision: number,
    next: AuthoritativeTaskState,
    lease?: TaskLease,
  ): Promise<ExecutionResult<AuthoritativeTaskState>> {
    const existing = this.states.get(next.taskId as TaskId);
    if (existing === undefined) {
      return taskFailure("task_not_found", "task does not exist in the durable store");
    }
    if (lease !== undefined) {
      const ownership = this.validateLease(lease, false);
      if (!ownership.ok) return ownership;
      if (lease.taskId !== next.taskId) {
        return taskFailure("lease_token_mismatch", "lease does not own the task being updated");
      }
    }
    const cloned = tryCloneState(next);
    if (!cloned.ok) return cloned;
    if (expectedRevision !== existing.revision || cloned.value.revision !== existing.revision + 1) {
      return taskFailure(
        "stale_task_revision",
        "expected revision mismatch or task revision does not increment by one",
      );
    }
    this.states.set(next.taskId as TaskId, cloned.value);
    return success(cloneState(cloned.value));
  }

  async acquireLease(taskId: TaskId, ttlMs: number): Promise<ExecutionResult<TaskLease>> {
    if (!validLeaseTtl(ttlMs)) {
      return taskFailure("invalid_lease_ttl", "lease TTL must be a positive bounded integer");
    }
    const state = this.states.get(taskId);
    if (state === undefined) {
      return taskFailure("task_not_found", "task does not exist in the durable store");
    }
    const nowMs = this.now();
    const held = this.leases.get(taskId);
    if (held !== undefined && held.expiresAtMs > nowMs) {
      return taskFailure("lease_contended", "an active lease is held by another claimant");
    }
    const leaseGeneration = state.leaseGeneration + 1;
    this.states.set(taskId, { ...state, leaseGeneration });
    const lease: TaskLease = {
      taskId,
      ownerToken: randomBytes(16).toString("hex"),
      leaseGeneration,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
    this.leases.set(taskId, lease);
    return success({ ...lease });
  }

  async heartbeatLease(lease: TaskLease, ttlMs: number): Promise<ExecutionResult<TaskLease>> {
    if (!validLeaseTtl(ttlMs)) {
      return taskFailure("invalid_lease_ttl", "lease TTL must be a positive bounded integer");
    }
    const ownership = this.validateLease(lease, false);
    if (!ownership.ok) return ownership;
    const held = ownership.value;
    const nowMs = this.now();
    const renewed: TaskLease = { ...held, expiresAtMs: nowMs + ttlMs };
    this.leases.set(lease.taskId, renewed);
    return success({ ...renewed });
  }

  async releaseLease(lease: TaskLease): Promise<ExecutionResult<void>> {
    const ownership = this.validateLease(lease, true);
    if (!ownership.ok) return ownership;
    this.leases.delete(lease.taskId);
    return success(undefined);
  }

  private validateLease(
    lease: TaskLease,
    allowExpired: boolean,
  ): ExecutionResult<TaskLease> {
    const held = this.leases.get(lease.taskId);
    const state = this.states.get(lease.taskId);
    if (
      held === undefined ||
      state === undefined ||
      held.ownerToken !== lease.ownerToken ||
      held.leaseGeneration !== lease.leaseGeneration ||
      state.leaseGeneration !== lease.leaseGeneration
    ) {
      return taskFailure("lease_token_mismatch", "lease token or generation does not match the active lease");
    }
    if (!allowExpired && held.expiresAtMs <= this.now()) {
      return taskFailure("lease_expired", "lease has expired and must be reacquired");
    }
    return success(held);
  }
}
