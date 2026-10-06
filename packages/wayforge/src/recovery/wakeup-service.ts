import type { ContinuationLauncher, DurableTaskStore, TaskLease } from "../durable/contracts.js";
import type { AuthoritativeTaskState } from "../durable/state.js";
import { classifyWorkspaceDrift, applyDriftToTaskState } from "../durable/drift-validator.js";
import type { WorkspaceCheckpoint } from "../durable/workspace-checkpoint.js";
import { buildContinuationPackage } from "./continuation.js";
import type { HealthRegistry } from "./health-registry.js";
import { evaluateResumeAvailability, type ResumeAvailability } from "./resume-availability.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { success } from "../types/result.js";
import type { TaskId } from "../types/identity.js";

const RESCHEDULE_DELAY_MS = 30_000;


/** Failures on which interruption reconciliation must lose safely. */
const RECONCILE_LOSS_CODES: ReadonlySet<string> = new Set([
  "stale_task_revision",
  "lease_contended",
  "lease_expired",
  "lease_token_mismatch",
  "lease_race",
  "lease_corrupt",
  "lease_missing",
  "task_not_found",
]);
export interface WakeupScanResult {
  readonly scanned: number;
  readonly due: number;
  readonly processed: number;
}

export interface WakeupServiceOptions {
  readonly store: DurableTaskStore;
  readonly launcher: ContinuationLauncher;
  readonly now: () => number;
  readonly leaseTtlMs: number;
  readonly maxContinuationLaunches: number;
  readonly maxRecoveryAttempts: number;
  readonly captureWorkspace: (state: AuthoritativeTaskState) => Promise<WorkspaceCheckpoint>;
  readonly health?: HealthRegistry;
  readonly evaluateAvailability?: (state: AuthoritativeTaskState) => ResumeAvailability;
}

function taskFailure(code: string, message: string): Failure {
  return {
    kind: "capability",
    scope: "task",
    confidence: "certain",
    code,
    message,
  };
}

/**
 * Single-pass deterministic scheduler for persisted suspended tasks. It owns
 * wakeup scheduling only: RecoveryCoordinator owns suspension policy and
 * HealthRegistry remains the only availability/cooldown authority.
 */
export class WakeupService {
  constructor(private readonly options: WakeupServiceOptions) {}

  async scanDueTasks(): Promise<ExecutionResult<WakeupScanResult>> {
    const listed = await this.options.store.list();
    if (!listed.ok) return listed;

    const nowMs = this.options.now();
    const dueStates = listed.value.filter((state) => this.isDue(state, nowMs));
    let processed = 0;
    for (const state of dueStates) {
      const result = await this.process(state.taskId as TaskId);
      if (!result.ok) return result;
      if (result.value) processed += 1;
    }
    return success({ scanned: listed.value.length, due: dueStates.length, processed });
  }

  /**
   * Reconcile durable `running` tasks left by a previous governed
   * execution. Every graceful terminal path persists a terminal status, so
   * a `running` task at a fresh startup scan belongs to an execution that
   * ended without one. Transitions stay inside this service: lease,
   * generation revalidation, revision CAS, fail-closed skip on contention.
   * `isOwnedTask` excludes tasks owned by the current process.
   */
  async reconcileInterruptedRunning(
    isOwnedTask?: (taskId: string) => boolean,
  ): Promise<ExecutionResult<{ readonly reconciled: number }>> {
    const listed = await this.options.store.list();
    if (!listed.ok) return listed;
    const stale = listed.value.filter(
      (state) => state.status === "running" && isOwnedTask?.(String(state.taskId)) !== true,
    );
    let reconciled = 0;
    for (const state of stale) {
      const result = await this.reconcileOne(state.taskId as TaskId);
      if (!result.ok) return result;
      if (result.value) reconciled += 1;
    }
    return success({ reconciled });
  }

  private async reconcileOne(taskId: TaskId): Promise<ExecutionResult<boolean>> {
    const claimed = await this.options.store.acquireLease(taskId, this.options.leaseTtlMs);
    if (!claimed.ok) {
      // An actively held lease means a live owner or concurrent reconciler:
      // skip safely instead of interrupting.
      if (claimed.failure.code === "lease_contended") return success(false);
      return claimed;
    }
    const lease = claimed.value;
    try {
      const loaded = await this.options.store.load(taskId);
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      if (state === null || state.leaseGeneration !== lease.leaseGeneration || state.status !== "running") {
        return success(false); // legitimately advanced or absent
      }
      const blocked: AuthoritativeTaskState = {
        ...state,
        status: "blocked",
        lastFailure: taskFailure(
          "interrupted_execution",
          "previous governed execution ended before terminal state",
        ),
        revision: state.revision + 1,
        updatedAtMs: this.options.now(),
      };
      const updated = await this.options.store.update(state.revision, blocked, lease);
      if (!updated.ok) {
        // Fencing/CAS conflict: another owner advanced the task; lose safely.
        if (RECONCILE_LOSS_CODES.has(updated.failure.code)) return success(false);
        return updated;
      }
      return success(true);
    } finally {
      await this.options.store.releaseLease(lease);
    }
  }

  private isDue(state: AuthoritativeTaskState, nowMs: number): boolean {
    if (state.status === "suspended" && state.suspension !== null) {
      return state.suspension.nextCheckAtMs <= nowMs;
    }
    // A persisted launch intent can mean the process died after the external
    // side effect. It must be recovered as an immediate fail-closed block, not
    // re-launched after a restart.
    return state.status === "resuming" &&
      (state.continuation === null || state.continuation.phase === "reserved" || state.continuation.phase === "launching");
  }

  private async process(taskId: TaskId): Promise<ExecutionResult<boolean>> {
    const claimed = await this.options.store.acquireLease(taskId, this.options.leaseTtlMs);
    if (!claimed.ok) {
      if (claimed.failure.code === "lease_contended") return success(false);
      return claimed;
    }
    const lease = claimed.value;
    try {
      const loaded = await this.options.store.load(taskId);
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      if (state === null || state.leaseGeneration !== lease.leaseGeneration) {
        return success(false);
      }
      if (state.status === "resuming") {
        if (state.continuation?.phase === "launching") {
          return await this.block(state, lease, "continuation_outcome_ambiguous", "continuation launch outcome is ambiguous after restart");
        }
        if (state.suspension === null) {
          return await this.block(state, lease, "resuming_suspension_missing", "resuming task has no persisted suspension to recover");
        }
        const restored = await this.persist(state, lease, { status: "suspended", continuation: null });
        if (!restored.ok) return restored;
        return await this.resumeOrReschedule(restored.value, lease);
      }
      if (state.status !== "suspended" || state.suspension === null || state.suspension.nextCheckAtMs > this.options.now()) {
        return success(false);
      }
      return await this.resumeOrReschedule(state, lease);
    } finally {
      await this.options.store.releaseLease(lease);
    }
  }

  private availability(state: AuthoritativeTaskState): ResumeAvailability {
    if (this.options.evaluateAvailability !== undefined) return this.options.evaluateAvailability(state);
    if (this.options.health === undefined) return { available: false, reason: "health_unavailable" };
    return evaluateResumeAvailability(state, this.options.health, this.options.now());
  }

  private async resumeOrReschedule(
    state: AuthoritativeTaskState,
    lease: TaskLease,
  ): Promise<ExecutionResult<boolean>> {
    const availability = this.availability(state);
    if (!availability.available) return this.reschedule(state, lease);

    if (state.recoveryCounters.recoveryAttempts >= this.options.maxRecoveryAttempts) {
      return this.block(state, lease, "recovery_attempt_budget_exhausted", "bounded recovery attempt budget is exhausted");
    }

    if (state.recoveryCounters.continuationLaunches >= this.options.maxContinuationLaunches) {
      return this.block(state, lease, "continuation_launch_budget_exhausted", "bounded continuation launch budget is exhausted");
    }

    const resuming = await this.persist(state, lease, { status: "resuming" });
    if (!resuming.ok) return resuming;

    let currentWorkspace: WorkspaceCheckpoint;
    try {
      currentWorkspace = await this.options.captureWorkspace(resuming.value);
    } catch {
      return this.block(resuming.value, lease, "workspace_capture_failed", "workspace capture failed before continuation launch");
    }
    if (resuming.value.workspace === null) {
      return this.block(resuming.value, lease, "workspace_checkpoint_missing", "suspended task has no authoritative workspace checkpoint");
    }

    const drift = classifyWorkspaceDrift(resuming.value.workspace, currentWorkspace);
    if (drift.classification === "CONFLICTING_DRIFT") {
      const blocked = applyDriftToTaskState(resuming.value, drift, this.options.now());
      const stored = await this.options.store.update(resuming.value.revision, blocked, lease);
      if (!stored.ok) return stored;
      return success(true);
    }

    const revalidated = await this.persist(resuming.value, lease, { workspace: currentWorkspace });
    if (!revalidated.ok) return revalidated;

    const continuationId = `${revalidated.value.taskId}:resume-${revalidated.value.recoveryCounters.continuationLaunches + 1}`;
    const reserved = await this.persist(revalidated.value, lease, {
      continuation: {
        continuationId,
        phase: "reserved",
        ...(revalidated.value.invocationProvenance?.invocationId !== undefined
          ? { continuationOf: revalidated.value.invocationProvenance.invocationId }
          : {}),
        preparedAtMs: this.options.now(),
      },
    });
    if (!reserved.ok) return reserved;

    const packageData = buildContinuationPackage({
      state: reserved.value,
      workspace: currentWorkspace,
      continuationId,
    });
    const reservedContinuation = reserved.value.continuation;
    if (reservedContinuation === null) {
      return this.block(reserved.value, lease, "continuation_reservation_missing", "continuation reservation was not persisted");
    }
    const launching = await this.persist(reserved.value, lease, {
      continuation: { ...reservedContinuation, phase: "launching" },
    });
    if (!launching.ok) return launching;

    let launched: Awaited<ReturnType<ContinuationLauncher["launch"]>>;
    try {
      launched = await this.options.launcher.launch(packageData, continuationId);
    } catch {
      return this.block(launching.value, lease, "continuation_outcome_ambiguous", "continuation launch threw after durable launch intent");
    }
    if (!launched.ok) {
      return this.block(launching.value, lease, "continuation_outcome_ambiguous", "continuation launch did not produce an authoritative result");
    }

    const current = launching.value;
    if (current.continuation === null) {
      return this.block(current, lease, "continuation_launch_record_missing", "continuation launch record was not persisted");
    }
    const running = await this.persist(current, lease, {
      status: "running",
      suspension: null,
      continuation: { ...current.continuation, phase: "launched" },
      invocationProvenance: {
        invocationId: launched.value.invocationId,
        role: "continuation",
        modelId: current.invocationProvenance?.modelId ?? "continuation",
        startedAtMs: this.options.now(),
      },
      recoveryCounters: {
        ...current.recoveryCounters,
        continuationLaunches: current.recoveryCounters.continuationLaunches + 1,
        recoveryAttempts: current.recoveryCounters.recoveryAttempts + 1,
      },
    });
    if (!running.ok) return running;
    return success(true);
  }

  private async reschedule(state: AuthoritativeTaskState, lease: TaskLease): Promise<ExecutionResult<boolean>> {
    const suspension = state.suspension;
    if (suspension === null) return success(false);
    const checkCount = suspension.checkCount + 1;
    if (checkCount >= suspension.maxChecks) {
      return this.block(state, lease, "resume_check_budget_exhausted", "bounded wakeup checks are exhausted while availability remains unavailable");
    }
    const updated = await this.persist(state, lease, {
      suspension: {
        ...suspension,
        checkCount,
        nextCheckAtMs: this.options.now() + RESCHEDULE_DELAY_MS,
      },
      recoveryCounters: {
        ...state.recoveryCounters,
        resumeChecks: state.recoveryCounters.resumeChecks + 1,
      },
    });
    if (!updated.ok) return updated;
    return success(true);
  }

  private async block(
    state: AuthoritativeTaskState,
    lease: TaskLease,
    code: string,
    message: string,
  ): Promise<ExecutionResult<boolean>> {
    const blocked = await this.persist(state, lease, {
      status: "blocked",
      lastFailure: taskFailure(code, message),
    });
    if (!blocked.ok) return blocked;
    return success(true);
  }

  private async persist(
    state: AuthoritativeTaskState,
    lease: TaskLease,
    patch: Partial<AuthoritativeTaskState>,
  ): Promise<ExecutionResult<AuthoritativeTaskState>> {
    const next: AuthoritativeTaskState = {
      ...state,
      ...patch,
      revision: state.revision + 1,
      updatedAtMs: this.options.now(),
    };
    return this.options.store.update(state.revision, next, lease);
  }
}
