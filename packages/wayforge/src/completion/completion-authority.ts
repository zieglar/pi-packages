import type { AdvisorReviewOutcome } from "../adapters/pi-advisor-adapter.js";
import type { DurableTaskStore, TaskLease } from "../durable/contracts.js";
import {
  DURABLE_TASK_STATE_VERSION,
  type AuthoritativeTaskState,
  type NegativeReviewEvidence,
} from "../durable/state.js";
import {
  captureWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
} from "../durable/workspace-checkpoint.js";
import { redact, redactInlineSecrets } from "../trace/redaction.js";
import type { TaskId } from "../types/identity.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { failure, success } from "../types/result.js";
import { buildAdvisorEvidence, type AdvisorEvidence } from "../workflow/advisor-evidence.js";
import { evaluateCompletionReadiness } from "./completion-readiness.js";
import {
  buildCompletionCandidate,
  sha256,
  type CompletionRefusalCode,
  type CompletionCandidate,
  type GovernedWorkSnapshot,
} from "./contracts.js";

export interface CompletionAuthorityOptions {
  readonly store: DurableTaskStore;
  readonly workspaceRoot: string;
  readonly taskId: TaskId;
  readonly leaseTtlMs: number;
  readonly now: () => number;
  readonly captureWorkspace?: typeof captureWorkspaceCheckpoint;
}

export interface CompletionRequest {
  readonly pending: () => GovernedWorkSnapshot;
  readonly review: (evidence: AdvisorEvidence) => Promise<ExecutionResult<AdvisorReviewOutcome>>;
}

export interface CompletionSuccess {
  readonly summary: string;
  readonly committedRevision: number;
  readonly idempotent: boolean;
}

function refusal(code: CompletionRefusalCode, message: string): ExecutionResult<never> {
  return failure({ kind: "validation", scope: "task", confidence: "certain", code, message });
}

function leaseRefusal(): ExecutionResult<never> {
  return refusal("lease_conflict", "completion lease was lost, expired, or superseded");
}

function authorityCompletion(state: AuthoritativeTaskState): state is AuthoritativeTaskState & {
  completionEvidence: Extract<AuthoritativeTaskState["completionEvidence"], { authority: string }>;
} {
  return state.status === "completed" &&
    state.completionEvidence !== null &&
    "authority" in state.completionEvidence &&
    state.completionEvidence.authority === "completion_authority_v1";
}

function sanitizedSummary(value: string, limit: number): string {
  const safe = redact(value);
  return (typeof safe === "string" ? safe : "redacted").slice(0, limit);
}

const NEGATIVE_REVIEW_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const NEGATIVE_REVIEW_ABSOLUTE_PATHS =
  /(?:~\/|[A-Za-z]:\\|\/(?:Users|home|private|var|tmp|etc|opt|srv|mnt|media)\/)[^\s"'`]+/g;

/**
 * Stricter bound for durable negative-review summaries: they outlive the
 * conversation, so absolute/home/workspace paths, control characters, and
 * inline secret material are all removed before persistence.
 */
function sanitizedNegativeReviewSummary(value: string, workspaceRoot: string): string {
  const withoutControl = value.replace(NEGATIVE_REVIEW_CONTROL_CHARACTERS, " ");
  const withoutWorkspace = workspaceRoot.length > 0
    ? withoutControl.split(workspaceRoot).join("[workspace]")
    : withoutControl;
  return redactInlineSecrets(withoutWorkspace.replace(NEGATIVE_REVIEW_ABSOLUTE_PATHS, "[path]")).slice(0, 1_000);
}

export interface CompletionAuthorityPort {
  recordValidation(input: {
    readonly name: string;
    readonly ok: boolean;
    readonly summary: string;
  }): Promise<ExecutionResult<{ readonly evidenceId: string; readonly workspaceDigest: string }>>;
  requestCompletion(request: CompletionRequest): Promise<ExecutionResult<CompletionSuccess>>;
}

/** The sole owner of governed validation persistence and transition to completed. */
export class CompletionAuthority implements CompletionAuthorityPort {
  private readonly captureWorkspace: typeof captureWorkspaceCheckpoint;

  constructor(private readonly options: CompletionAuthorityOptions) {
    this.captureWorkspace = options.captureWorkspace ?? captureWorkspaceCheckpoint;
  }

  async recordValidation(input: {
    readonly name: string;
    readonly ok: boolean;
    readonly summary: string;
  }): Promise<ExecutionResult<{ readonly evidenceId: string; readonly workspaceDigest: string }>> {
    const acquired = await this.options.store.acquireLease(this.options.taskId, this.options.leaseTtlMs);
    if (!acquired.ok) return leaseRefusal();
    let lease = acquired.value;
    try {
      const loaded = await this.options.store.load(this.options.taskId);
      if (!loaded.ok) return loaded;
      if (loaded.value === null) return refusal("state_conflict", "durable task is missing");
      const state = loaded.value;
      if (state.status === "completed") {
        return refusal("state_conflict", "a completed task cannot record validation");
      }
      if (state.status === "cancelled") {
        return refusal("task_cancelled", "a cancelled task cannot record validation");
      }
      if (state.workspace === null) return refusal("workspace_changed", "workspace checkpoint is missing");
      const captured = await this.captureWorkspace({
        workspaceRoot: this.options.workspaceRoot,
        taskWriteSet: state.workspace.taskWriteSet,
        capturedAtMs: this.options.now(),
      });
      if (!captured.ok) return captured;
      const name = input.name.slice(0, 300);
      const evidenceId = `validation:${sha256(name).slice(0, 48)}`;
      const entry: AuthoritativeTaskState["evidence"][number] = {
        evidenceId,
        kind: "command",
        summary: sanitizedSummary(input.summary, 300),
        recordedAtMs: this.options.now(),
        validAtWorkspaceDigest: captured.value.workingStateDigest,
        validation: { name, ok: input.ok },
      };
      const evidence = [
        ...state.evidence.filter((existing) => existing.validation?.name !== name),
        entry,
      ].slice(-20);
      // Bind the authoritative checkpoint to the workspace the validation ran
      // against, so readiness after legitimate task work compares current vs
      // current. Mutation after validation still fails: the typed evidence
      // digest no longer matches, and the post-Advisor candidate recheck still
      // rejects any workspace drift.
      const next: AuthoritativeTaskState = {
        ...state,
        revision: state.revision + 1,
        leaseGeneration: lease.leaseGeneration,
        workspace: captured.value,
        evidence,
        updatedAtMs: this.options.now(),
      };
      const updated = await this.options.store.update(state.revision, next, lease);
      if (!updated.ok) return this.mapStoreConflict(updated.failure);
      return success({ evidenceId, workspaceDigest: captured.value.workingStateDigest });
    } finally {
      await this.options.store.releaseLease(lease).catch(() => undefined);
    }
  }

  async requestCompletion(request: CompletionRequest): Promise<ExecutionResult<CompletionSuccess>> {
    const initial = await this.options.store.load(this.options.taskId);
    if (!initial.ok) return initial;
    if (initial.value === null) return refusal("state_conflict", "durable task is missing");
    if (authorityCompletion(initial.value)) {
      return success({
        summary: initial.value.completionEvidence.summary,
        committedRevision: initial.value.revision,
        idempotent: true,
      });
    }

    const acquired = await this.options.store.acquireLease(this.options.taskId, this.options.leaseTtlMs);
    if (!acquired.ok) return leaseRefusal();
    let lease: TaskLease = acquired.value;
    try {
      const loaded = await this.options.store.load(this.options.taskId);
      if (!loaded.ok) return loaded;
      if (loaded.value === null) return refusal("state_conflict", "durable task is missing");
      if (authorityCompletion(loaded.value)) {
        return success({
          summary: loaded.value.completionEvidence.summary,
          committedRevision: loaded.value.revision,
          idempotent: true,
        });
      }
      const state = loaded.value;
      if (state.workspace === null) return refusal("workspace_changed", "workspace checkpoint is missing");
      const captured = await this.capture(state.workspace);
      if (!captured.ok) return captured;
      const pending = request.pending();
      const readiness = evaluateCompletionReadiness({ state, workspace: captured.value, pending });
      if (!readiness.ready) return refusal(readiness.reason.code, readiness.reason.message);
      const candidate = buildCompletionCandidate({
        state,
        workspace: captured.value,
        validationEvidence: readiness.validationEvidence,
        pending,
      });
      const advisorEvidence = buildAdvisorEvidence({
        objective: state.objective,
        completionCriteria: state.completionCriteria,
        implementationSummary: state.checkpoint.summary,
        changedPaths: captured.value.changedPaths.map((entry) => entry.path),
        diffSummary: `${captured.value.changedPaths.length} workspace path(s) differ from HEAD`,
        validations: readiness.validationEvidence.map((entry) => ({
          name: entry.validation?.name ?? "",
          ok: entry.validation?.ok ?? false,
          summary: entry.summary,
        })),
        workerFindings: [],
        unresolved: state.unresolvedItems,
        workspaceDigest: captured.value.workingStateDigest,
        extra: {
          candidateDigest: candidate.candidateDigest,
          taskRevision: candidate.taskRevision,
          validationEvidenceDigest: candidate.validationEvidenceDigest,
          governedWorkEpoch: candidate.governedWorkEpoch,
        },
      });
      const reviewed = await request.review(advisorEvidence);
      if (!reviewed.ok) {
        return reviewed.failure.code === "invalid_advisor_verdict"
          ? refusal("advisor_invalid", "Advisor returned an invalid strict verdict")
          : reviewed;
      }
      if (reviewed.value.verdict.status === "changes_requested") {
        return await this.recordNegativeReview(candidate, reviewed.value, lease);
      }
      if (reviewed.value.verdict.status === "unable") {
        return refusal("advisor_unable", "Advisor was unable to decide");
      }

      const heartbeat = await this.options.store.heartbeatLease(lease, this.options.leaseTtlMs);
      if (!heartbeat.ok) return leaseRefusal();
      lease = heartbeat.value;
      const reloaded = await this.options.store.load(this.options.taskId);
      if (!reloaded.ok) return reloaded;
      if (reloaded.value === null) return refusal("state_conflict", "durable task disappeared after review");
      if (
        reloaded.value.revision !== candidate.taskRevision ||
        reloaded.value.status !== "running" ||
        reloaded.value.leaseGeneration !== lease.leaseGeneration
      ) {
        return refusal("state_conflict", "durable task changed after Advisor review");
      }
      if (reloaded.value.workspace === null) return refusal("workspace_changed", "workspace checkpoint disappeared");
      const recaptured = await this.capture(reloaded.value.workspace);
      if (!recaptured.ok) return recaptured;
      const pendingAfter = request.pending();
      const readinessAfter = evaluateCompletionReadiness({
        state: reloaded.value,
        workspace: recaptured.value,
        pending: pendingAfter,
      });
      if (!readinessAfter.ready) return refusal(readinessAfter.reason.code, readinessAfter.reason.message);
      const candidateAfter = buildCompletionCandidate({
        state: reloaded.value,
        workspace: recaptured.value,
        validationEvidence: readinessAfter.validationEvidence,
        pending: pendingAfter,
      });
      if (candidateAfter.candidateDigest !== candidate.candidateDigest) {
        return candidateAfter.workspaceDigest !== candidate.workspaceDigest
          ? refusal("workspace_changed", "workspace changed after Advisor review")
          : refusal("state_conflict", "completion candidate changed after Advisor review");
      }

      const verdictDigest = sha256(reviewed.value.verdict);
      const summary = sanitizedSummary(reviewed.value.verdict.summary, 1_000);
      const completionEvidence: NonNullable<AuthoritativeTaskState["completionEvidence"]> = {
        authority: "completion_authority_v1",
        candidateDigest: candidate.candidateDigest,
        authoritativeRevision: candidate.taskRevision + 1,
        workspaceDigest: candidate.workspaceDigest,
        validationEvidenceIds: [...candidate.validationEvidenceIds],
        validationEvidenceDigest: candidate.validationEvidenceDigest,
        advisor: {
          invocationId: reviewed.value.invocationId,
          routeId: reviewed.value.decision.routeId,
          status: "approve",
          verdictDigest,
          summary,
        },
        completedAtMs: this.options.now(),
        leaseGeneration: lease.leaseGeneration,
        summary: sanitizedSummary(
          `completed with ${candidate.validationEvidenceIds.length} passing validation(s): ${summary}`,
          1_000,
        ),
      };
      const next: AuthoritativeTaskState = {
        ...reloaded.value,
        revision: candidate.taskRevision + 1,
        status: "completed",
        completionEvidence,
        updatedAtMs: this.options.now(),
      };
      const committed = await this.options.store.update(candidate.taskRevision, next, lease);
      if (!committed.ok) return this.mapStoreConflict(committed.failure);
      return success({
        summary: completionEvidence.summary,
        committedRevision: committed.value.revision,
        idempotent: false,
      });
    } finally {
      await this.options.store.releaseLease(lease).catch(() => undefined);
    }
  }

  /**
   * Durable, non-authorizing record of one settled `changes_requested`
   * review. Write-once, candidate-bound, fenced by revision CAS + lease;
   * never overwrites an existing fact and never upgrades legacy records
   * except through this otherwise valid authoritative write.
   */
  private async recordNegativeReview(
    candidate: CompletionCandidate,
    reviewed: AdvisorReviewOutcome,
    lease: TaskLease,
  ): Promise<ExecutionResult<never>> {
    const heartbeat = await this.options.store.heartbeatLease(lease, this.options.leaseTtlMs);
    if (!heartbeat.ok) return leaseRefusal();
    const reloaded = await this.options.store.load(this.options.taskId);
    if (!reloaded.ok) return reloaded;
    if (reloaded.value === null) return refusal("state_conflict", "durable task disappeared after review");
    const state = reloaded.value;
    if (
      state.revision !== candidate.taskRevision ||
      state.status !== "running" ||
      state.leaseGeneration !== lease.leaseGeneration
    ) {
      return refusal("state_conflict", "durable task changed after Advisor review");
    }
    if (authorityCompletion(state)) {
      return refusal("state_conflict", "durable task completed after Advisor review");
    }
    const existing = "negativeReview" in state ? state.negativeReview : undefined;
    if (existing !== undefined && existing !== null) {
      // Write-once: an earlier settled negative review is never overwritten.
      return refusal("advisor_changes_requested", "Advisor requested changes");
    }
    const record: NegativeReviewEvidence = {
      outcome: "changes_requested",
      candidateDigest: candidate.candidateDigest,
      recordedAtMs: this.options.now(),
      summary: sanitizedNegativeReviewSummary(reviewed.verdict.summary, this.options.workspaceRoot),
    };
    const next: AuthoritativeTaskState = {
      ...state,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      revision: candidate.taskRevision + 1,
      negativeReview: record,
      updatedAtMs: this.options.now(),
    };
    const committed = await this.options.store.update(candidate.taskRevision, next, lease);
    if (!committed.ok) return this.mapStoreConflict(committed.failure);
    return refusal(
      "advisor_changes_requested",
      "Advisor requested changes; correct the work and start a new governed task",
    );
  }

  private capture(workspace: WorkspaceCheckpoint) {
    return this.captureWorkspace({
      workspaceRoot: this.options.workspaceRoot,
      taskWriteSet: workspace.taskWriteSet,
      capturedAtMs: this.options.now(),
    });
  }

  private mapStoreConflict(storeFailure: Failure): ExecutionResult<never> {
    if (storeFailure.code.startsWith("lease_") || storeFailure.code === "lease_token_mismatch") {
      return leaseRefusal();
    }
    if (storeFailure.code === "stale_task_revision") {
      return refusal("state_conflict", "durable task revision changed before commit");
    }
    return failure(storeFailure);
  }
}
