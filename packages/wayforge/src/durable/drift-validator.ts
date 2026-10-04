import type { AuthoritativeTaskState } from "./state.js";
import type { WorkspaceCheckpoint } from "./workspace-checkpoint.js";

export type DriftClassification =
  | "NO_DRIFT"
  | "MINOR_DRIFT"
  | "RECONCILABLE_DRIFT"
  | "CONFLICTING_DRIFT";

export interface DriftValidationResult {
  readonly classification: DriftClassification;
  readonly requiresRevalidation: boolean;
  readonly changedPaths: readonly string[];
  readonly conflictingPaths: readonly string[];
  readonly reason: string;
}

function canonicalFingerprint(entry: WorkspaceCheckpoint["changedPaths"][number]): string {
  return JSON.stringify([
    entry.path,
    entry.status,
    entry.indexDigest ?? null,
    entry.worktreeDigest ?? null,
    entry.symlink ?? null,
    entry.missing ?? null,
  ]);
}

function fingerprintMap(checkpoint: WorkspaceCheckpoint): ReadonlyMap<string, string> {
  return new Map(checkpoint.changedPaths.map((entry) => [entry.path, canonicalFingerprint(entry)]));
}

function changedPathSet(baseline: WorkspaceCheckpoint, current: WorkspaceCheckpoint): readonly string[] {
  const before = fingerprintMap(baseline);
  const after = fingerprintMap(current);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort((left, right) => left.localeCompare(right));
}

export function classifyWorkspaceDrift(
  baseline: WorkspaceCheckpoint,
  current: WorkspaceCheckpoint,
): DriftValidationResult {
  const changedPaths = changedPathSet(baseline, current);
  const writeSetStable = JSON.stringify([...baseline.taskWriteSet].sort((left, right) => left.localeCompare(right))) === JSON.stringify([...current.taskWriteSet].sort((left, right) => left.localeCompare(right)));
  const identityStable =
    baseline.workspaceRoot === current.workspaceRoot &&
    baseline.repositoryId === current.repositoryId &&
    baseline.worktreeId === current.worktreeId;
  if (!identityStable || !writeSetStable) {
    return {
      classification: "CONFLICTING_DRIFT",
      requiresRevalidation: true,
      changedPaths,
      conflictingPaths: [...baseline.taskWriteSet].sort((left, right) => left.localeCompare(right)),
      reason: identityStable ? "task write set changed" : "repository or worktree identity changed",
    };
  }

  const owned = new Set(baseline.taskWriteSet);
  const conflictingPaths = changedPaths.filter((path) => owned.has(path));
  if (conflictingPaths.length > 0) {
    return {
      classification: "CONFLICTING_DRIFT",
      requiresRevalidation: true,
      changedPaths,
      conflictingPaths,
      reason: "task-owned workspace fingerprints changed",
    };
  }
  if (
    baseline.headCommit === current.headCommit &&
    baseline.workingStateDigest === current.workingStateDigest
  ) {
    return {
      classification: "NO_DRIFT",
      requiresRevalidation: false,
      changedPaths: [],
      conflictingPaths: [],
      reason: "workspace checkpoint matches",
    };
  }
  if (baseline.headCommit === current.headCommit) {
    return {
      classification: "MINOR_DRIFT",
      requiresRevalidation: true,
      changedPaths,
      conflictingPaths: [],
      reason: "only paths outside the task write set changed",
    };
  }
  return {
    classification: "RECONCILABLE_DRIFT",
    requiresRevalidation: true,
    changedPaths,
    conflictingPaths: [],
    reason: "repository identity and task-owned fingerprints match but HEAD changed",
  };
}

export function applyDriftToTaskState(
  state: AuthoritativeTaskState,
  drift: DriftValidationResult,
  nowMs: number,
): AuthoritativeTaskState {
  if (drift.classification !== "CONFLICTING_DRIFT") return state;
  return {
    ...state,
    revision: state.revision + 1,
    status: "blocked",
    updatedAtMs: nowMs,
    lastFailure: {
      kind: "capability",
      scope: "task",
      confidence: "certain",
      code: "workspace_drift_conflict",
      message: drift.reason.slice(0, 200),
      metadata: { conflictingPathCount: drift.conflictingPaths.length },
    },
  };
}
