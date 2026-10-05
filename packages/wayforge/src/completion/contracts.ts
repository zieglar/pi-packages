import { createHash } from "node:crypto";
import type { EvidenceReference } from "../durable/evidence-freshness.js";
import type { AuthoritativeTaskState } from "../durable/state.js";
import type { WorkspaceCheckpoint } from "../durable/workspace-checkpoint.js";
import type { TaskId } from "../types/identity.js";

export interface GovernedWorkSnapshot {
  readonly pendingGovernedWorkCount: number;
  readonly governedWorkEpoch: number;
}

export type CompletionRefusalCode =
  | "validation_required"
  | "validation_stale"
  | "validation_failed"
  | "workspace_changed"
  | "task_suspended"
  | "task_resuming"
  | "task_blocked"
  | "task_cancelled"
  | "pending_work"
  | "unresolved_items"
  | "state_conflict"
  | "lease_conflict"
  | "advisor_changes_requested"
  | "advisor_unable"
  | "advisor_invalid"
  | "completion_authority_unavailable";

export interface CompletionRefusalReason {
  readonly code: CompletionRefusalCode;
  readonly message: string;
}

export interface CompletionCandidate {
  readonly taskId: TaskId;
  readonly taskRevision: number;
  readonly taskStatus: "running";
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly headCommit: string;
  readonly workspaceDigest: string;
  readonly validationEvidenceIds: readonly string[];
  readonly validationEvidenceDigest: string;
  readonly governedWorkEpoch: number;
  readonly candidateDigest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Build the immutable, deterministic input reviewed and later revalidated. */
export function buildCompletionCandidate(input: {
  readonly state: AuthoritativeTaskState;
  readonly workspace: WorkspaceCheckpoint;
  readonly validationEvidence: readonly EvidenceReference[];
  readonly pending: GovernedWorkSnapshot;
}): CompletionCandidate {
  const validationEvidence = [...input.validationEvidence]
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map((entry) => ({
      evidenceId: entry.evidenceId,
      name: entry.validation?.name ?? "",
      ok: entry.validation?.ok ?? false,
      workspaceDigest: entry.validAtWorkspaceDigest ?? "",
    }));
  const fields = {
    taskId: input.state.taskId as TaskId,
    taskRevision: input.state.revision,
    taskStatus: "running" as const,
    repositoryId: input.workspace.repositoryId,
    worktreeId: input.workspace.worktreeId,
    headCommit: input.workspace.headCommit,
    workspaceDigest: input.workspace.workingStateDigest,
    validationEvidenceIds: validationEvidence.map((entry) => entry.evidenceId),
    validationEvidenceDigest: sha256(validationEvidence),
    governedWorkEpoch: input.pending.governedWorkEpoch,
  };
  return Object.freeze({
    ...fields,
    validationEvidenceIds: Object.freeze([...fields.validationEvidenceIds]),
    candidateDigest: sha256(fields),
  });
}
