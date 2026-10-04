import {
  validTaskState,
  type AuthoritativeTaskState,
  type TaskStateInput,
} from "../../src/durable/state.js";

/**
 * Shared builders for durable task state fixtures. Secrets, raw prompts, and
 * transcripts appear only as rejection fixtures here; they must never be
 * required to construct valid state.
 */

/** Secret-shaped marker used to prove persistence paths never retain credentials. */
export const FIXTURE_SECRET = "sk-fixturesecret1234567890abcdef";

/** Minimal valid v2 task state input. */
export function durableTaskFixture(overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return {
    taskId: "task-fixture",
    revision: 0,
    status: "pending",
    objective: "Complete the fixture task",
    completionCriteria: "Focused durable tests pass",
    policyVersions: { role: "worker", model: "model-1" },
    checkpoint: { revision: 0, summary: "fixture checkpoint", completedWork: [], remainingWork: [] },
    workspace: null,
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
    currentPhase: "planning",
    unresolvedItems: [],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

/** Fully populated v2 task state input exercising every structured field. */
export function populatedTaskFixture(overrides: Partial<TaskStateInput> = {}): TaskStateInput {
  return durableTaskFixture({
    revision: 4,
    status: "suspended",
    checkpoint: {
      revision: 4,
      summary: "phase one complete",
      completedWork: ["schema v2", "unified contracts"],
      remainingWork: ["filesystem store"],
    },
    workspace: {
      workspaceRoot: "/tmp/wayforge-fixture",
      repositoryId: "repo-fixture",
      worktreeId: "wt-9f2c",
      headCommit: "abc123",
      workingStateDigest: "workspace-digest-1",
      taskWriteSet: ["src/durable/state.ts", "docs/new.md", "gone.txt"],
      changedPaths: [
        {
          path: "src/durable/state.ts",
          status: "modified",
          indexDigest: "d1",
          worktreeDigest: "d1",
        },
        { path: "docs/new.md", status: "added", worktreeDigest: "d2" },
        { path: "gone.txt", status: "deleted", indexDigest: "d3", missing: true },
      ],
      capturedAtMs: 1_500,
    },
    recentAttempts: [
      {
        attempt: 1,
        startedAtMs: 1_100,
        endedAtMs: 1_200,
        outcome: "failed",
        failure: {
          kind: "rate_limit",
          scope: "provider",
          confidence: "ambiguous",
          code: "http_429",
          message: "provider asked to slow down",
        },
      },
      {
        attempt: 2,
        startedAtMs: 1_300,
        outcome: "suspended",
        failure: null,
      },
    ],
    lastFailure: {
      kind: "usage_limit",
      scope: "account",
      confidence: "certain",
      code: "quota_exhausted",
      message: "usage window exhausted",
      resetAtMs: 5_000,
    },
    suspension: {
      kind: "usage_limit",
      reason: "account quota exhausted",
      scope: "account",
      scopeKey: "account-key-hash",
      observedAtMs: 1_500,
      resumeNotBeforeMs: 5_000,
      nextCheckAtMs: 5_000,
      strategy: "explicit_reset",
      checkCount: 0,
      maxChecks: 5,
      originatingFailure: {
        kind: "usage_limit",
        scope: "account",
        confidence: "certain",
        code: "quota_exhausted",
        message: "usage window exhausted",
        resetAtMs: 5_000,
      },
      decidedBy: "recovery_coordinator",
    },
    leaseGeneration: 2,
    evidence: [
      {
        evidenceId: "ev-1",
        kind: "file",
        summary: "src/durable/state.ts digest stable",
        recordedAtMs: 1_600,
      },
    ],
    invocationProvenance: {
      invocationId: "inv-1",
      role: "worker",
      provider: "anthropic",
      modelId: "claude-opus-4",
      accountKey: "account-key-hash",
      startedAtMs: 1_000,
      endedAtMs: 1_500,
    },
    continuation: {
      continuationId: "cont-1",
      phase: "prepared",
      continuationOf: "inv-1",
      preparedAtMs: 1_700,
    },
    ...overrides,
  });
}

/** Validated populated state. */
export function populatedTaskState(overrides: Partial<TaskStateInput> = {}): AuthoritativeTaskState {
  return validTaskState(populatedTaskFixture(overrides));
}
