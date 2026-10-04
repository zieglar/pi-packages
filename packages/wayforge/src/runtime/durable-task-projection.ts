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

interface ValidationDetail {
  readonly name?: unknown;
  readonly ok?: unknown;
  readonly summary?: unknown;
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
      case "completion_ready": {
        await this.update(event.taskId, {
          status: "completed",
          completionEvidence: { summary: "live workflow reported completion_ready", at: this.now() },
        });
        return;
      }
      case "cancellation": {
        await this.update(event.taskId, { status: "cancelled" });
        return;
      }
      case "validation": {
        const detail = event.detail as ValidationDetail;
        if (typeof detail.name !== "string" || detail.name.length === 0) return;
        const loaded = await this.store.load(event.taskId);
        if (!loaded.ok || loaded.value === null) return;
        const state = loaded.value;
        const entry = {
          evidenceId: `validation:${detail.name.slice(0, 100)}`,
          kind: "command" as const,
          summary: `${detail.name}: ${detail.ok === true ? "pass" : "fail"} — ${String(detail.summary ?? "").slice(0, 200)}`,
          recordedAtMs: this.now(),
        };
        const evidence = [...state.evidence.filter((existing) => existing.evidenceId !== entry.evidenceId), entry];
        await this.update(event.taskId, { evidence: evidence.slice(-20) });
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
