import { describe, expect, it, vi } from "vitest";
import { PiAdvisorAdapter } from "../src/adapters/pi-advisor-adapter.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import type { NestedInvoker } from "../src/runtime/nested-invoker.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";
import { success } from "../src/types/result.js";

function parent() {
  return createInvocation({ invocationId: invocationId("main"), taskId: taskId("task"), role: "main", maxDepth: 2, budgetLimit: 100 });
}

function fakeInvoker(text: string) {
  const root = parent();
  const child = root.deriveChild({ invocationId: invocationId("advisor"), role: "advisor", budgetLimit: 25 });
  if (!child.ok) throw new Error("expected child");
  const invoke = vi.fn(async () => success({
    child: child.context,
    decision: {
      routeId: routeId("advisor-route"), provider: "sentinel", modelId: "advisor-model", tier: "balanced" as const,
      thinking: "high" as const, capabilityId: capabilityId("advisor-cap"), budget: { limit: 25 },
    },
    output: { text, usage: { inputTokens: 4, outputTokens: 5 } }, trace: [],
  }));
  return { invoker: { invoke } as unknown as NestedInvoker, invoke };
}

const evidence = {
  objective: "review", completionCriteria: "pass", implementationSummary: "done", changedPaths: ["src/a.ts"],
  diffSummary: "diff", validations: [{ name: "test", ok: true, summary: "ok" }], workerFindings: [], unresolved: [],
  workspaceDigest: "digest", extra: {},
};

describe("PiAdvisorAdapter", () => {
  it("uses one nested Advisor invocation and parses a strict verdict", async () => {
    const fake = fakeInvoker(JSON.stringify({
      status: "approve", summary: "ready", findings: [{ code: "ok", severity: "note", summary: "clean" }],
    }));
    const adapter = new PiAdvisorAdapter(fake.invoker);
    const result = await adapter.review({ parent: parent(), invocationId: invocationId("advisor-1"), evidence, budgetLimit: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected advisor success");
    expect(result.value.verdict.status).toBe("approve");
    expect(result.value.decision.modelId).toBe("advisor-model");
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    expect(fake.invoke).toHaveBeenCalledWith(expect.objectContaining({ role: "advisor", budgetLimit: 25 }));
  });

  it("fails closed on malformed or authority-bearing output", async () => {
    const fake = fakeInvoker(JSON.stringify({ status: "approve", summary: "ready", findings: [], setModel: "other" }));
    const result = await new PiAdvisorAdapter(fake.invoker).review({
      parent: parent(), invocationId: invocationId("advisor-2"), evidence, budgetLimit: 25,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("invalid_advisor_verdict");
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  });
});
