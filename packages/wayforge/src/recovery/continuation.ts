import { partitionEvidenceByWorkspace, type StaleEvidenceReason } from "../durable/evidence-freshness.js";
import type { AuthoritativeTaskState } from "../durable/state.js";
import type { WorkspaceCheckpoint } from "../durable/workspace-checkpoint.js";

export interface ContinuationEvidence {
  readonly evidenceId: string;
  readonly kind: AuthoritativeTaskState["evidence"][number]["kind"];
  readonly summary: string;
}

export interface StaleContinuationEvidence {
  readonly evidenceId: string;
  readonly reason: StaleEvidenceReason;
}

/**
 * Host-neutral, exact-allowlist reconstruction input for a new invocation.
 * This is intentionally data-only: it contains no SDK session, provider body,
 * transcript, prompt history, runtime handle, stream, credential, or CoT.
 */
export interface ContinuationPackage {
  readonly taskId: string;
  readonly continuationId: string;
  readonly checkpointRevision: number;
  readonly currentInvocationId?: string;
  readonly previousInvocationId?: string;
  readonly continuationOf?: string;
  readonly objective: string;
  readonly completionCriteria: string;
  readonly currentPhase: string;
  readonly checkpoint: {
    readonly summary: string;
    readonly completedWork: readonly string[];
    readonly remainingWork: readonly string[];
  };
  readonly unresolvedItems: readonly string[];
  readonly workspace: WorkspaceCheckpoint;
  readonly evidence: readonly ContinuationEvidence[];
  /** Stale evidence is contextual only and cannot authorize completion. */
  readonly staleEvidence: readonly StaleContinuationEvidence[];
  readonly suspension: AuthoritativeTaskState["suspension"];
  readonly recoveryCounters: AuthoritativeTaskState["recoveryCounters"];
  readonly policyConstraints: readonly string[];
}

export interface ContinuationPackageInput {
  readonly state: AuthoritativeTaskState;
  /** Newly captured/revalidated workspace state, never a runtime cache. */
  readonly workspace: WorkspaceCheckpoint;
  readonly continuationId: string;
}

const POLICY_CONSTRAINTS = [
  "new_invocation_required",
  "no_destructive_workspace_recovery",
  "no_advisor_for_infrastructure_recovery",
  "bounded_resume_checks",
] as const;

interface MutableContinuationProvenance {
  currentInvocationId?: string;
  previousInvocationId?: string;
  continuationOf?: string;
}

const SECRET_PATTERN = /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi;

function safeText(value: string, maxLength: number): string {
  return value.replace(SECRET_PATTERN, "[redacted]").slice(0, maxLength);
}

function maybeText(value: string | undefined, maxLength: number): string | undefined {
  return value === undefined ? undefined : safeText(value, maxLength);
}

/**
 * Rebuild a continuation exclusively from durable data plus a newly verified
 * workspace checkpoint. The resulting continuation always represents a new
 * invocation; it cannot resurrect a previous stream/session attempt.
 */
export function buildContinuationPackage(input: ContinuationPackageInput): ContinuationPackage {
  const { state, workspace } = input;
  const freshness = partitionEvidenceByWorkspace(state.evidence, workspace.workingStateDigest);
  const currentInvocationId = maybeText(state.invocationProvenance?.invocationId, 120);
  const linkedInvocationId = maybeText(state.continuation?.continuationOf, 120) ?? currentInvocationId;
  const evidence = freshness.valid.map((reference) => ({
    evidenceId: safeText(reference.evidenceId, 120),
    kind: reference.kind,
    summary: safeText(reference.summary, 300),
  }));
  const staleEvidence = freshness.stale.map(({ evidence: reference, reason }) => ({
    evidenceId: safeText(reference.evidenceId, 120),
    reason,
  }));

  const provenance: MutableContinuationProvenance = {};
  if (currentInvocationId !== undefined) provenance.currentInvocationId = currentInvocationId;
  if (linkedInvocationId !== undefined) {
    provenance.previousInvocationId = linkedInvocationId;
    provenance.continuationOf = linkedInvocationId;
  }

  return {
    taskId: safeText(state.taskId, 120),
    continuationId: safeText(input.continuationId, 120),
    checkpointRevision: state.checkpoint.revision,
    ...provenance,
    objective: safeText(state.objective, 1_000),
    completionCriteria: safeText(state.completionCriteria, 1_000),
    currentPhase: safeText(state.currentPhase, 120),
    checkpoint: {
      summary: safeText(state.checkpoint.summary, 2_000),
      completedWork: state.checkpoint.completedWork.map((item) => safeText(item, 300)),
      remainingWork: state.checkpoint.remainingWork.map((item) => safeText(item, 300)),
    },
    unresolvedItems: state.unresolvedItems.map((item) => safeText(item, 300)),
    workspace,
    evidence,
    staleEvidence,
    suspension: state.suspension,
    recoveryCounters: state.recoveryCounters,
    policyConstraints: POLICY_CONSTRAINTS,
  };
}

/** Concise deterministic rendering for a host-specific launcher to submit. */
export function renderContinuationPrompt(packageData: ContinuationPackage): string {
  const lines = [
    "Wayforge continuation package (new invocation; do not assume prior session memory).",
    `Task: ${packageData.taskId}`,
    `Continuation: ${packageData.continuationId}`,
    `Checkpoint revision: ${packageData.checkpointRevision}`,
    `Objective: ${packageData.objective}`,
    `Completion criteria: ${packageData.completionCriteria}`,
    `Phase: ${packageData.currentPhase}`,
    `Checkpoint summary: ${packageData.checkpoint.summary}`,
    `Completed work: ${packageData.checkpoint.completedWork.join(" | ") || "none"}`,
    `Remaining work: ${packageData.checkpoint.remainingWork.join(" | ") || "none"}`,
    `Unresolved items: ${packageData.unresolvedItems.join(" | ") || "none"}`,
    `Workspace digest: ${packageData.workspace.workingStateDigest}`,
    `Fresh evidence: ${packageData.evidence.map((entry) => `${entry.evidenceId}: ${entry.summary}`).join(" | ") || "none"}`,
    `Stale evidence IDs: ${packageData.staleEvidence.map((entry) => `${entry.evidenceId} (${entry.reason})`).join(" | ") || "none"}`,
    `Suspension: ${packageData.suspension?.kind ?? "none"}`,
    `Constraints: ${packageData.policyConstraints.join(", ")}`,
  ];
  return lines.join("\n");
}
