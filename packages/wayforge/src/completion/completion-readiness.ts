import { latestValidationEvidenceByWorkspace, type EvidenceReference } from "../durable/evidence-freshness.js";
import type { AuthoritativeTaskState } from "../durable/state.js";
import type { WorkspaceCheckpoint } from "../durable/workspace-checkpoint.js";
import type { CompletionRefusalReason, GovernedWorkSnapshot } from "./contracts.js";

export type CompletionReadiness =
  | { readonly ready: true; readonly validationEvidence: readonly EvidenceReference[] }
  | { readonly ready: false; readonly reason: CompletionRefusalReason };

function refused(code: CompletionRefusalReason["code"], message: string): CompletionReadiness {
  return { ready: false, reason: { code, message } };
}

function sameWorkspace(left: WorkspaceCheckpoint, right: WorkspaceCheckpoint): boolean {
  return left.workspaceRoot === right.workspaceRoot &&
    left.repositoryId === right.repositoryId &&
    left.worktreeId === right.worktreeId &&
    left.headCommit === right.headCommit &&
    left.workingStateDigest === right.workingStateDigest;
}

/** Deterministic pre-Advisor readiness. Human summaries never influence policy. */
export function evaluateCompletionReadiness(input: {
  readonly state: AuthoritativeTaskState;
  readonly workspace: WorkspaceCheckpoint;
  readonly pending: GovernedWorkSnapshot;
}): CompletionReadiness {
  if (input.state.status === "completed") return refused("state_conflict", "task is already completed");
  if (input.state.status === "suspended") return refused("task_suspended", "a suspended task cannot complete");
  if (input.state.status === "resuming") return refused("task_resuming", "a resuming task cannot complete");
  if (input.state.status === "blocked") return refused("task_blocked", "a blocked task cannot complete");
  if (input.state.status === "cancelled") return refused("task_cancelled", "a cancelled task cannot complete");
  if (input.state.status !== "running") return refused("state_conflict", "task is not running");
  if (input.state.suspension !== null) return refused("task_suspended", "task has an unresolved suspension");
  if (input.state.unresolvedItems.length > 0) return refused("unresolved_items", "task has unresolved durable items");
  if (input.state.workspace === null || !sameWorkspace(input.state.workspace, input.workspace)) {
    return refused("workspace_changed", "workspace differs from the authoritative task checkpoint");
  }
  if (input.pending.pendingGovernedWorkCount > 0) {
    return refused("pending_work", "governed work is still in flight");
  }
  const typed = input.state.evidence.filter((entry) => entry.validation !== undefined);
  if (typed.length === 0) return refused("validation_required", "durable typed validation evidence is required");
  const freshness = latestValidationEvidenceByWorkspace(input.state.evidence, input.workspace.workingStateDigest);
  if (freshness.valid.length === 0 || freshness.stale.length > 0) {
    return refused("validation_stale", "latest validation evidence is not bound to the current workspace");
  }
  if (freshness.valid.some((entry) => entry.validation?.ok !== true)) {
    return refused("validation_failed", "latest validation evidence includes a failure");
  }
  return { ready: true, validationEvidence: Object.freeze([...freshness.valid]) };
}

export function workspaceMatches(left: WorkspaceCheckpoint, right: WorkspaceCheckpoint): boolean {
  return sameWorkspace(left, right);
}
