import { describe, expect, it } from "vitest";
import { evaluateCompletionReadiness } from "../src/completion/completion-readiness.js";
import { buildCompletionCandidate } from "../src/completion/contracts.js";
import type { AuthoritativeTaskState } from "../src/durable/state.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

function readyState(overrides: Partial<AuthoritativeTaskState> = {}): AuthoritativeTaskState {
  const base = populatedTaskState({
    status: "running",
    suspension: null,
    unresolvedItems: [],
    evidence: [],
    completionEvidence: null,
    ...overrides,
  });
  if (base.workspace === null) throw new Error("fixture workspace missing");
  return {
    ...base,
    evidence: [{
      evidenceId: "validation:test",
      kind: "command",
      summary: "passed",
      recordedAtMs: 10,
      validAtWorkspaceDigest: base.workspace.workingStateDigest,
      validation: { name: "test", ok: true },
    }],
    ...overrides,
  };
}

const pending = { pendingGovernedWorkCount: 0, governedWorkEpoch: 4 };

describe("completion readiness and candidate", () => {
  it.each([
    ["suspended", "task_suspended"],
    ["resuming", "task_resuming"],
    ["blocked", "task_blocked"],
    ["cancelled", "task_cancelled"],
  ] as const)("returns an exact refusal for %s", (status, code) => {
    const state = readyState({ status });
    if (state.workspace === null) throw new Error("workspace missing");
    expect(evaluateCompletionReadiness({ state, workspace: state.workspace, pending })).toMatchObject({
      ready: false,
      reason: { code },
    });
  });

  it("distinguishes missing, stale, failing, unresolved, pending, and changed workspace", () => {
    const state = readyState();
    if (state.workspace === null) throw new Error("workspace missing");
    const evaluate = (candidate: AuthoritativeTaskState, workspace = state.workspace!) =>
      evaluateCompletionReadiness({ state: candidate, workspace, pending });
    expect(evaluate({ ...state, evidence: [] })).toMatchObject({ reason: { code: "validation_required" } });
    expect(evaluate({
      ...state,
      evidence: state.evidence.map((entry) => ({ ...entry, validAtWorkspaceDigest: "old" })),
    })).toMatchObject({ reason: { code: "validation_stale" } });
    expect(evaluate({
      ...state,
      evidence: state.evidence.map((entry) => ({ ...entry, validation: { name: "test", ok: false } })),
    })).toMatchObject({ reason: { code: "validation_failed" } });
    expect(evaluate({ ...state, unresolvedItems: ["open"] })).toMatchObject({ reason: { code: "unresolved_items" } });
    expect(evaluateCompletionReadiness({
      state,
      workspace: state.workspace,
      pending: { ...pending, pendingGovernedWorkCount: 1 },
    })).toMatchObject({ reason: { code: "pending_work" } });
    expect(evaluate(state, { ...state.workspace, workingStateDigest: "changed" })).toMatchObject({
      reason: { code: "workspace_changed" },
    });
  });

  it("returns fresh typed evidence and builds a frozen deterministic SHA-256 candidate", () => {
    const state = readyState();
    if (state.workspace === null) throw new Error("workspace missing");
    const readiness = evaluateCompletionReadiness({ state, workspace: state.workspace, pending });
    expect(readiness.ready).toBe(true);
    if (!readiness.ready) throw new Error(readiness.reason.code);
    const first = buildCompletionCandidate({
      state,
      workspace: state.workspace,
      validationEvidence: readiness.validationEvidence,
      pending,
    });
    const second = buildCompletionCandidate({
      state,
      workspace: state.workspace,
      validationEvidence: [...readiness.validationEvidence].reverse(),
      pending,
    });
    expect(first).toEqual(second);
    expect(first.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.validationEvidenceIds)).toBe(true);
  });
});
