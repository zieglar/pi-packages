import type { DurableTaskStore } from "../durable/contracts.js";
import { validTaskState, type AuthoritativeTaskState } from "../durable/state.js";
import { captureWorkspaceCheckpoint } from "../durable/workspace-checkpoint.js";
import type { DurableSuspension } from "../recovery/suspension.js";
import type { Failure } from "../types/result.js";
import type { ExecutionResult } from "../types/result.js";
import type { TaskId } from "../types/identity.js";
import type { WorkflowEvent } from "../workflow/events.js";

/**
 * Narrow one-way projection from the live Alpha 0 workflow into authoritative
 * durable state. The in-memory `WorkflowTaskState` remains the ephemeral
 * workflow-progress owner; this projection copies only the already-approved
 * durable-lite facts (creation checkpoint, terminal outcomes, real
 * RecoveryCoordinator suspensions, validation evidence) into the
 * `AuthoritativeTaskState` store. It never reads back, never decides policy,
 * and never persists live Pi objects — everything passes through the strict
 * durable schema on write.
 */

export interface DurableTaskStart {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly completionCriteria: string;
  readonly workspaceRoot: string;
  readonly policyVersions: { readonly role: string; readonly model: string };
}

export interface LiveDurableProjectionOptions {
  readonly now?: () => number;
}

interface RecoveryAppliedDetail {
  readonly action?: unknown;
  readonly terminal?: unknown;
  readonly suspension?: unknown;
}

function isSuspension(value: unknown): value is DurableSuspension {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DurableSuspension>;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.strategy === "string" &&
    typeof candidate.resumeNotBeforeMs === "number" &&
    typeof candidate.originatingFailure === "object" &&
    candidate.originatingFailure !== null
  );
}

export class LiveDurableProjection {
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private lastFailure: Failure | null = null;

  constructor(
    private readonly store: DurableTaskStore,
    options: LiveDurableProjectionOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Most recent typed projection failure; sanitized and never thrown. */
  projectionFailure(): Failure | null {
    return this.lastFailure;
  }

  /**
   * Create the authoritative durable task for a governed workflow: capture the
   * workspace checkpoint and adopt the current change set as the task-owned
   * write set, so later external edits to those paths classify as conflicting
   * drift instead of silently passing.
   */
  async startDurableTask(input: DurableTaskStart): Promise<ExecutionResult<AuthoritativeTaskState>> {
    const captured = await captureWorkspaceCheckpoint({
      workspaceRoot: input.workspaceRoot,
      taskWriteSet: [],
      capturedAtMs: this.now(),
    });
    if (!captured.ok) return captured;
    const timestamp = this.now();
    const state = validTaskState({
      taskId: input.taskId,
      revision: 0,
      status: "running",
      objective: input.objective,
      completionCriteria: input.completionCriteria,
      currentPhase: "assisted-execution",
      unresolvedItems: [],
      policyVersions: input.policyVersions,
      checkpoint: {
        revision: 0,
        summary: `started: ${input.objective}`,
        completedWork: [],
        remainingWork: [],
      },
      workspace: { ...captured.value, taskWriteSet: captured.value.changedPaths.map((entry) => entry.path) },
      recoveryCounters: {
        retries: 0,
        fallbacks: 0,
        rotations: 0,
        resumeChecks: 0,
        continuationLaunches: 0,
        recoveryAttempts: 0,
      },
      recentAttempts: [],
      lastFailure: null,
      suspension: null,
      leaseGeneration: 0,
      evidence: [],
      completionEvidence: null,
      invocationProvenance: null,
      continuation: null,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
    return this.store.create(state);
  }

  /**
   * Authoritatively append unresolved worker-failure summaries to the
   * durable task (revision CAS; sanitized 300-char items, bounded 50).
   * Never mutates status; missing task or CAS conflict fails closed.
   */
  async recordUnresolved(input: {
    readonly taskId: TaskId;
    readonly items: readonly string[];
  }): Promise<ExecutionResult<void>> {
    const bounded = input.items
      .map((item) => item.slice(0, 300))
      .filter((item) => item.length > 0);
    if (bounded.length === 0) return { ok: true, value: undefined };
    const loaded = await this.store.load(input.taskId);
    if (!loaded.ok) return loaded;
    if (loaded.value === null) {
      const missing: Failure = {
        kind: "capability",
        scope: "task",
        confidence: "certain",
        code: "state_conflict",
        message: "durable task is missing; unresolved state cannot be bound",
      };
      this.lastFailure = missing;
      return { ok: false, failure: missing };
    }
    const state = loaded.value;
    const merged = [...state.unresolvedItems];
    for (const item of bounded) {
      if (!merged.includes(item)) merged.push(item);
    }
    const next: AuthoritativeTaskState = {
      ...state,
      unresolvedItems: merged.slice(-50),
      revision: state.revision + 1,
      updatedAtMs: this.now(),
    };
    const updated = await this.store.update(state.revision, next);
    if (!updated.ok) {
      this.lastFailure = updated.failure;
      return updated;
    }
    return { ok: true, value: undefined };
  }

  /** Feed one live workflow event into the durable projection (ordered, non-throwing). */
  project(event: WorkflowEvent): void {
    this.chain = this.chain.then(
      () => this.apply(event),
      () => this.apply(event),
    );
  }

  /** Await all queued projections (deterministic tests and shutdown). */
  async settle(): Promise<void> {
    await this.chain;
  }

  private async apply(event: WorkflowEvent): Promise<void> {
    if (event.taskId === undefined) return;
    switch (event.kind) {
      case "recovery_applied": {
        const detail = event.detail as RecoveryAppliedDetail;
        if (detail.action !== "suspend" || detail.terminal !== true || !isSuspension(detail.suspension)) return;
        const suspension = detail.suspension;
        await this.update(event.taskId, {
          status: "suspended",
          suspension,
          lastFailure: suspension.originatingFailure,
        });
        return;
      }
      case "cancellation": {
        await this.update(event.taskId, { status: "cancelled" });
        return;
      }
      default:
        return;
    }
  }

  private async update(taskId: TaskId, patch: Partial<AuthoritativeTaskState>): Promise<void> {
    const loaded = await this.store.load(taskId);
    if (!loaded.ok) {
      this.lastFailure = loaded.failure;
      return;
    }
    if (loaded.value === null) return; // not a durably governed task
    const state = loaded.value;
    const next: AuthoritativeTaskState = {
      ...state,
      ...patch,
      revision: state.revision + 1,
      updatedAtMs: this.now(),
    };
    const updated = await this.store.update(state.revision, next);
    if (!updated.ok) this.lastFailure = updated.failure;
  }
}
