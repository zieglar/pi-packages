import { describe, expect, it } from "vitest";
import {
  boundedTaskState,
  DURABLE_TASK_STATE_VERSION,
  deserializeTaskState,
  type EphemeralTaskState,
  serializeTaskState,
  validTaskState,
} from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";
import {
  durableTaskFixture,
  FIXTURE_SECRET,
  populatedTaskFixture,
  populatedTaskState,
} from "./helpers/durable-task-fixture.js";

const base = durableTaskFixture({ taskId: "task-1", revision: 3, status: "running" });

describe("authoritative durable state schema v2", () => {
  it("round-trips deterministically with stable key ordering", () => {
    const state = validTaskState(base);
    const first = serializeTaskState(state);
    const second = serializeTaskState(validTaskState(base));
    expect(first).toBe(second);
    const parsed = deserializeTaskState(first);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value).toEqual({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION });
    expect(serializeTaskState(parsed.value)).toBe(first);
  });

  it("serializes object keys recursively sorted", () => {
    const state = populatedTaskState();
    const serialized = serializeTaskState(state);
    const walk = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      const keys = Object.keys(value);
      expect(keys).toEqual([...keys].sort((l, r) => l.localeCompare(r)));
      for (const key of keys) walk((value as Record<string, unknown>)[key]);
    };
    walk(JSON.parse(serialized));
  });

  it.each(["pending", "running", "suspended", "resuming", "blocked", "completed", "cancelled"] as const)(
    "accepts status %s",
    (status) => {
      expect(() => validTaskState(durableTaskFixture({ status }))).not.toThrow();
    },
  );

  it("rejects an unknown status", () => {
    const json = JSON.stringify({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION, status: "unknown" });
    const result = deserializeTaskState(json);
    expect(result.ok).toBe(false);
  });

  it("carries lease generation for fencing", () => {
    const state = validTaskState(durableTaskFixture({ leaseGeneration: 7 }));
    expect(state.leaseGeneration).toBe(7);
    const negative = JSON.stringify({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION, leaseGeneration: -1 });
    expect(deserializeTaskState(negative).ok).toBe(false);
    const wrongType = JSON.stringify({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION, leaseGeneration: "7" });
    expect(deserializeTaskState(wrongType).ok).toBe(false);
  });

  it("round-trips structured checkpoint content", () => {
    const state = populatedTaskState();
    expect(state.checkpoint.completedWork).toEqual(["schema v2", "unified contracts"]);
    expect(state.checkpoint.remainingWork).toEqual(["filesystem store"]);
  });

  it("round-trips current phase, unresolved items, last failure, and resume budgets", () => {
    const state = populatedTaskState({
      currentPhase: "validation",
      unresolvedItems: ["re-run changed validation"],
      recoveryCounters: {
        retries: 1,
        fallbacks: 2,
        rotations: 3,
        resumeChecks: 4,
        continuationLaunches: 1,
        recoveryAttempts: 5,
      },
    });
    expect(state.currentPhase).toBe("validation");
    expect(state.unresolvedItems).toEqual(["re-run changed validation"]);
    expect(state.lastFailure).toMatchObject({ kind: "usage_limit", code: "quota_exhausted" });
    expect(state.recoveryCounters).toMatchObject({ resumeChecks: 4, continuationLaunches: 1 });
  });

  it("round-trips a workspace checkpoint with path fingerprints", () => {
    const state = populatedTaskState();
    const workspace = state.workspace;
    expect(workspace).not.toBeNull();
    if (workspace === null) throw new Error("expected workspace");
    expect(workspace.headCommit).toBe("abc123");
    expect(workspace.changedPaths).toHaveLength(3);
    expect(workspace.workspaceRoot).toBe("/tmp/wayforge-fixture");
    expect(workspace.workingStateDigest).toBe("workspace-digest-1");
    expect(workspace.taskWriteSet).toContain("src/durable/state.ts");
    expect(workspace.changedPaths[2]).toMatchObject({ path: "gone.txt", status: "deleted", missing: true });
  });

  it("bounds recent attempts and evidence references", () => {
    const state = populatedTaskState();
    expect(state.recentAttempts).toHaveLength(2);
    expect(state.evidence[0]).toMatchObject({ evidenceId: "ev-1", kind: "file" });
    const tooManyAttempts = populatedTaskFixture({
      recentAttempts: Array.from({ length: 11 }, (_, i) => ({
        attempt: i + 1,
        startedAtMs: i,
        outcome: "failed" as const,
        failure: null,
      })),
    });
    expect(
      deserializeTaskState(JSON.stringify({ ...tooManyAttempts, schemaVersion: DURABLE_TASK_STATE_VERSION })).ok,
    ).toBe(false);
  });

  it("round-trips typed suspension with complete safe resume metadata", () => {
    const state = populatedTaskState();
    expect(state.suspension).toMatchObject({
      kind: "usage_limit",
      scope: "account",
      scopeKey: "account-key-hash",
      observedAtMs: 1_500,
      resumeNotBeforeMs: 5_000,
      nextCheckAtMs: 5_000,
      strategy: "explicit_reset",
      checkCount: 0,
      maxChecks: 5,
      decidedBy: "recovery_coordinator",
      originatingFailure: { kind: "usage_limit", code: "quota_exhausted" },
    });
    const unknownKind = populatedTaskFixture({
      suspension: {
        ...(populatedTaskFixture().suspension as NonNullable<ReturnType<typeof populatedTaskFixture>["suspension"]>),
        kind: "magic" as never,
      },
    });
    expect(
      deserializeTaskState(JSON.stringify({ ...unknownKind, schemaVersion: DURABLE_TASK_STATE_VERSION })).ok,
    ).toBe(false);
  });

  it("round-trips sanitized failure records inside attempts", () => {
    const state = populatedTaskState();
    const firstAttempt = state.recentAttempts[0];
    if (firstAttempt === undefined || firstAttempt.failure === null) throw new Error("expected failure");
    expect(firstAttempt.failure).toMatchObject({ kind: "rate_limit", code: "http_429" });
    const leakyMetadata = populatedTaskFixture({
      recentAttempts: [
        {
          attempt: 1,
          startedAtMs: 1,
          outcome: "failed" as const,
          failure: {
            kind: "provider" as const,
            scope: "provider" as const,
            confidence: "ambiguous" as const,
            code: "http_500",
            message: "boom",
            metadata: { rawBody: { payload: FIXTURE_SECRET } } as never,
          },
        },
      ],
    });
    const result = deserializeTaskState(
      JSON.stringify({ ...leakyMetadata, schemaVersion: DURABLE_TASK_STATE_VERSION }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_SECRET);
  });

  it("round-trips bounded typed validation and discriminated authority completion evidence", () => {
    const completionEvidence = {
      authority: "completion_authority_v1" as const,
      candidateDigest: "candidate-digest",
      authoritativeRevision: 4,
      workspaceDigest: "workspace-digest-1",
      validationEvidenceIds: ["validation:test"],
      validationEvidenceDigest: "validation-digest",
      advisor: {
        invocationId: "advisor-1",
        routeId: "advisor-route",
        status: "approve" as const,
        verdictDigest: "verdict-digest",
        summary: "approved",
      },
      completedAtMs: 2_000,
      leaseGeneration: 2,
      summary: "completed safely",
    };
    const state = populatedTaskState({
      status: "completed",
      evidence: [{
        evidenceId: "validation:test",
        kind: "command",
        summary: "passed",
        recordedAtMs: 1_900,
        validAtWorkspaceDigest: "workspace-digest-1",
        validation: { name: "test", ok: true },
      }],
      completionEvidence,
    });
    expect(state.evidence[0]?.validation).toEqual({ name: "test", ok: true });
    expect(state.completionEvidence).toEqual(completionEvidence);
  });

  it("rejects extra raw or secret-like completion fields", () => {
    const leaky = populatedTaskFixture({
      status: "completed",
      completionEvidence: {
        authority: "completion_authority_v1",
        candidateDigest: "candidate",
        authoritativeRevision: 2,
        workspaceDigest: "workspace",
        validationEvidenceIds: ["validation:test"],
        validationEvidenceDigest: "validation",
        advisor: {
          invocationId: "advisor-1",
          routeId: "route",
          status: "approve",
          verdictDigest: "verdict",
          summary: "approved",
          transcript: "raw transcript",
        },
        completedAtMs: 2_000,
        leaseGeneration: 1,
        summary: "done",
        authorization: "Bearer abcdefghijk",
        reasoning: "hidden",
        rawResponse: "provider payload",
      } as never,
    });
    const result = deserializeTaskState(JSON.stringify({
      ...leaky,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
    }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("abcdefghijk");
  });

  it("round-trips invocation provenance and prepared continuation state", () => {
    const state = populatedTaskState();
    expect(state.invocationProvenance).toMatchObject({ invocationId: "inv-1", modelId: "claude-opus-4" });
    expect(state.continuation).toMatchObject({
      continuationId: "cont-1",
      phase: "prepared",
      continuationOf: "inv-1",
    });
    const unknownPhase = populatedTaskFixture({
      continuation: { continuationId: "c", phase: "halfway" as never, preparedAtMs: 1 },
    });
    expect(
      deserializeTaskState(JSON.stringify({ ...unknownPhase, schemaVersion: DURABLE_TASK_STATE_VERSION })).ok,
    ).toBe(false);
  });

  it("rejects an unsupported schema version, including legacy v1", () => {
    for (const schemaVersion of [999, 1]) {
      const json = JSON.stringify({ ...base, schemaVersion });
      const result = deserializeTaskState(json);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.failure.code).toBe("unsupported_version");
    }
  });

  it("rejects records that fail schema validation", () => {
    const missing = JSON.stringify({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION, objective: undefined });
    expect(deserializeTaskState(missing).ok).toBe(false);
    const badType = JSON.stringify({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION, revision: "three" });
    expect(deserializeTaskState(badType).ok).toBe(false);
  });

  it("rejects oversized strings and arrays", () => {
    const longObjective = JSON.stringify({
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      objective: "x".repeat(1_001),
    });
    expect(deserializeTaskState(longObjective).ok).toBe(false);
    const longSummary = populatedTaskFixture({
      checkpoint: { revision: 0, summary: "y".repeat(2_001), completedWork: [], remainingWork: [] },
    });
    expect(
      deserializeTaskState(JSON.stringify({ ...longSummary, schemaVersion: DURABLE_TASK_STATE_VERSION })).ok,
    ).toBe(false);
    const wideEvidence = populatedTaskFixture({
      evidence: Array.from({ length: 21 }, (_, i) => ({
        evidenceId: `ev-${i}`,
        kind: "note" as const,
        summary: "s",
        recordedAtMs: i,
      })),
    });
    expect(
      deserializeTaskState(JSON.stringify({ ...wideEvidence, schemaVersion: DURABLE_TASK_STATE_VERSION })).ok,
    ).toBe(false);
    const wideWorkspace = populatedTaskFixture({
      workspace: {
        workspaceRoot: "/tmp/wide",
        workingStateDigest: "wide-digest",
        taskWriteSet: [],
        repositoryId: "r",
        worktreeId: "w",
        headCommit: "h",
        changedPaths: Array.from({ length: 501 }, (_, i) => ({
          path: `p${i}.ts`,
          status: "modified" as const,
        })),
        capturedAtMs: 1,
      },
    });
    expect(
      deserializeTaskState(JSON.stringify({ ...wideWorkspace, schemaVersion: DURABLE_TASK_STATE_VERSION })).ok,
    ).toBe(false);
  });

  it("forbids secret-bearing and runtime fields via exact allowlist", () => {
    const leaky = JSON.stringify({
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      apiKey: FIXTURE_SECRET,
      credentials: { token: "x" },
      transcript: "hidden reasoning transcript",
      prompt: "raw prompt used for reconstruction",
      reasoning: "hidden chain of thought",
      model: { runtime: true },
      stream: { handle: 1 },
    });
    const result = deserializeTaskState(leaky);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.code).toBe("forbidden_fields");
    expect(JSON.stringify(result.failure.metadata)).not.toContain(FIXTURE_SECRET);
  });
  it("rejects secret-shaped values even inside allowed string fields", () => {
    const leaky = durableTaskFixture({ objective: `use ${FIXTURE_SECRET} for access` });
    expect(() => validTaskState(leaky)).toThrow(/secret/i);
    const parsed = deserializeTaskState(
      JSON.stringify({ ...leaky, schemaVersion: DURABLE_TASK_STATE_VERSION }),
    );
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(FIXTURE_SECRET);
  });


  it("rejects serialization of records with forbidden keys", () => {
    const leaky = {
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      apiKey: FIXTURE_SECRET,
    } as never;
    expect(() => serializeTaskState(leaky)).toThrow(/forbidden/i);
  });

  it("forbids nested fields outside each authoritative allowlist", () => {
    const leaky = JSON.stringify({
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      policyVersions: { ...base.policyVersions, apiKey: "nested-secret" },
    });
    const result = deserializeTaskState(leaky);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.code).toBe("schema_violation");
    expect(JSON.stringify(result)).not.toContain("nested-secret");
  });

  it("rejects prototype keys anywhere in the record", () => {
    const topLevel = JSON.stringify({
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      ["__proto__"]: { polluted: true },
    });
    const topResult = deserializeTaskState(topLevel);
    expect(topResult.ok).toBe(false);
    if (topResult.ok) throw new Error("expected failure");
    expect(topResult.failure.code).toBe("forbidden_fields");

    const nested = populatedTaskFixture({
      recentAttempts: [
        {
          attempt: 1,
          startedAtMs: 1,
          outcome: "failed" as const,
          failure: {
            kind: "provider" as const,
            scope: "provider" as const,
            confidence: "ambiguous" as const,
            code: "http_500",
            message: "boom",
            metadata: JSON.parse('{ "__proto__": "polluted" }') as never,
          },
        },
      ],
    });
    const nestedResult = deserializeTaskState(
      JSON.stringify({ ...nested, schemaVersion: DURABLE_TASK_STATE_VERSION }),
    );
    expect(nestedResult.ok).toBe(false);

    const constructed = {
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      ["constructor"]: { prototype: { polluted: true } },
    } as never;
    expect(() => serializeTaskState(constructed)).toThrow();
  });
});

describe("bounded state construction", () => {
  it("truncates oversized strings before validation", () => {
    const state = boundedTaskState(durableTaskFixture({ objective: "x".repeat(5_000) }));
    expect(state.objective).toHaveLength(1_000);
  });

  it("keeps only the most recent bounded attempts and clamps counts", () => {
    const attempts = Array.from({ length: 25 }, (_, i) => ({
      attempt: i + 1,
      startedAtMs: i,
      outcome: "failed" as const,
      failure: null,
    }));
    const state = boundedTaskState(
      durableTaskFixture({
        recentAttempts: attempts,
        recoveryCounters: {
          retries: -4,
          fallbacks: 2,
          rotations: 1,
          resumeChecks: -1,
          continuationLaunches: 0,
          recoveryAttempts: 3,
        },
      }),
    );
    expect(state.recentAttempts).toHaveLength(10);
    expect(state.recentAttempts[9]?.attempt).toBe(25);
    expect(state.recoveryCounters.retries).toBe(0);
  });

  it("strips allowlist-violating fields instead of persisting them", () => {
    const withSecrets = {
      ...durableTaskFixture(),
      apiKey: FIXTURE_SECRET,
      transcript: "must not persist",
      prompt: "raw prompt",
    } as never;
    const state = boundedTaskState(withSecrets);
    expect("apiKey" in state).toBe(false);
    expect("transcript" in state).toBe(false);
    expect("prompt" in state).toBe(false);
    const serialized = serializeTaskState(state);
    expect(serialized).not.toContain(FIXTURE_SECRET);
    expect(serialized).not.toContain("must not persist");
  });

  it("redacts secret-shaped values from allowed fields during bounded construction", () => {
    const state = boundedTaskState(
      durableTaskFixture({ objective: `complete work with ${FIXTURE_SECRET}` }),
    );
    expect(state.objective).toContain("[redacted-key]");
    expect(serializeTaskState(state)).not.toContain(FIXTURE_SECRET);
  });

  it("strips prototype keys during construction", () => {
    const polluted = JSON.parse(
      `{ "taskId": "task-1", "__proto__": { "polluted": true }, "revision": 0 }`,
    ) as Record<string, unknown>;
    const state = boundedTaskState({ ...durableTaskFixture(), ...polluted } as never);
    expect(Object.keys(state)).not.toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("still rejects structurally invalid input after bounding", () => {
    expect(() => boundedTaskState({ ...durableTaskFixture(), revision: "three" } as never)).toThrow();
    expect(() => boundedTaskState({ ...durableTaskFixture(), status: "invalid" } as never)).toThrow();
  });
});

describe("ephemeral state separation", () => {
  it("keeps runtime-only state out of the authoritative schema", () => {
    const ephemeral: EphemeralTaskState = {
      taskId: taskId("task-1"),
      abortController: new AbortController(),
      runtimeHandles: new Map([["model", { id: "claude" }]]),
      liveStreams: new Set([{ pipe: true }]),
    };
    // Ephemeral state is deliberately not JSON-serializable state: pushing it
    // through the authoritative serializer must fail validation.
    expect(() =>
      serializeTaskState(ephemeral as unknown as Parameters<typeof serializeTaskState>[0]),
    ).toThrow();
  });

  it("exposes runtime handles that never round-trip", () => {
    const controller = new AbortController();
    const ephemeral: EphemeralTaskState = {
      taskId: taskId("task-1"),
      abortController: controller,
      runtimeHandles: new Map(),
      liveStreams: new Set(),
    };
    expect(ephemeral.abortController.signal.aborted).toBe(false);
    controller.abort();
    expect(ephemeral.abortController.signal.aborted).toBe(true);
  });
});
