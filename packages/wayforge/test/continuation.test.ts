import { describe, expect, it } from "vitest";
import { buildContinuationPackage, renderContinuationPrompt } from "../src/recovery/continuation.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";
import type { EphemeralTaskState } from "../src/durable/state.js";
import type { AuthoritativeTaskState } from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";

function stateWithEvidence() {
  return populatedTaskState({
    evidence: [
      {
        evidenceId: "ev-current",
        kind: "command",
        summary: "Worker test suite passed",
        recordedAtMs: 1_700,
        validAtWorkspaceDigest: "workspace-digest-1",
      },
      {
        evidenceId: "ev-stale",
        kind: "note",
        summary: "Advisor reviewed old workspace",
        recordedAtMs: 1_701,
        validAtWorkspaceDigest: "workspace-digest-old",
      },
    ],
  });
}

describe("buildContinuationPackage", () => {
  it("reconstructs a deterministic new-invocation package solely from durable state and revalidated workspace", () => {
    const state = stateWithEvidence();
    const workspace = state.workspace;
    if (workspace === null) throw new Error("fixture must provide workspace");
    const packageA = buildContinuationPackage({ state, workspace, continuationId: "cont-new" });
    const packageB = buildContinuationPackage({ state, workspace, continuationId: "cont-new" });

    expect(packageA).toEqual(packageB);
    expect(packageA).toMatchObject({
      taskId: "task-fixture",
      continuationId: "cont-new",
      checkpointRevision: 4,
      currentInvocationId: "inv-1",
      previousInvocationId: "inv-1",
      continuationOf: "inv-1",
      objective: "Complete the fixture task",
      completionCriteria: "Focused durable tests pass",
      currentPhase: "planning",
      checkpoint: {
        summary: "phase one complete",
        completedWork: ["schema v2", "unified contracts"],
        remainingWork: ["filesystem store"],
      },
      workspace,
      evidence: [{ evidenceId: "ev-current" }],
      staleEvidence: [{ evidenceId: "ev-stale", reason: "workspace_digest_changed" }],
      suspension: { kind: "usage_limit" },
    });
    expect(packageA.policyConstraints).toContain("new_invocation_required");
    expect(packageA.policyConstraints).toContain("no_destructive_workspace_recovery");
    expect(packageA.policyConstraints).toContain("no_advisor_for_infrastructure_recovery");
  });

  it("remains sufficient after all ephemeral runtime state is destroyed", () => {
    const state = stateWithEvidence();
    const workspace = state.workspace;
    if (workspace === null) throw new Error("fixture must provide workspace");
    const ephemeral: EphemeralTaskState = {
      taskId: taskId(String(state.taskId)),
      abortController: new AbortController(),
      runtimeHandles: new Map([["client", { rawProviderBody: "must never leak" }]]),
      liveStreams: new Set([{}]),
    };
    ephemeral.abortController.abort();
    (ephemeral.runtimeHandles as Map<string, unknown>).clear();
    (ephemeral.liveStreams as Set<object>).clear();

    const continuation = buildContinuationPackage({ state, workspace, continuationId: "cont-rebuilt" });
    const prompt = renderContinuationPrompt(continuation);
    expect(continuation.checkpoint.remainingWork).toEqual(["filesystem store"]);
    expect(prompt).toContain("cont-rebuilt");
    expect(prompt).toContain("Complete the fixture task");
    expect(prompt).not.toContain("rawProviderBody");
    expect(prompt).not.toContain("must never leak");
    expect(prompt).not.toMatch(/transcript|hidden reasoning|raw prompt/i);
  });

  it("marks all evidence stale when revalidated workspace drift changes the digest", () => {
    const state = stateWithEvidence();
    const workspace = state.workspace;
    if (workspace === null) throw new Error("fixture must provide workspace");
    const drifted = { ...workspace, workingStateDigest: "workspace-digest-2", capturedAtMs: 9_999 };
    const continuation = buildContinuationPackage({ state, workspace: drifted, continuationId: "cont-drifted" });
    expect(continuation.evidence).toEqual([]);
    expect(continuation.staleEvidence).toEqual([
      { evidenceId: "ev-current", reason: "workspace_digest_changed" },
      { evidenceId: "ev-stale", reason: "workspace_digest_changed" },
    ]);
  });

  it("renders a concise allowlisted prompt without secrets, provider bodies, or runtime reconstruction", () => {
    const safeState = populatedTaskState({
      evidence: [{
        evidenceId: "safe", kind: "note", summary: "safe evidence", recordedAtMs: 1,
        validAtWorkspaceDigest: "workspace-digest-1",
      }],
    });
    const state = {
      ...safeState,
      objective: "Continue with sk-abcdefghijklmnop123456 work",
      evidence: [{ ...safeState.evidence[0], summary: "Bearer abcdefghijklmnop" }],
    } as AuthoritativeTaskState;
    const workspace = state.workspace;
    if (workspace === null) throw new Error("fixture must provide workspace");
    const prompt = renderContinuationPrompt(buildContinuationPackage({ state, workspace, continuationId: "cont-safe" }));
    expect(prompt).not.toContain("sk-abcdefghijklmnop123456");
    expect(prompt).not.toContain("Bearer abcdefghijklmnop");
    expect(prompt).not.toMatch(/api.?key|provider.?body|runtime.?handle/i);
  });
});
