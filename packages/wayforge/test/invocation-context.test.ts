import { describe, expect, it } from "vitest";
import {
  budgetExceeded,
  createInvocation,
  type DerivationFailure,
} from "../src/kernel/invocation-context.js";
import { invocationId, taskId } from "../src/types/identity.js";

function root(overrides: Record<string, unknown> = {}) {
  return createInvocation({
    invocationId: invocationId("inv-root"),
    taskId: taskId("task-1"),
    role: "main",
    maxDepth: 2,
    budgetLimit: 100,
    traceMetadata: { source: "test", run: 7 },
    ...overrides,
  });
}

describe("invocation context creation", () => {
  it("creates a root context at depth zero with the given identity", () => {
    const ctx = root();
    expect(ctx.invocationId).toBe("inv-root");
    expect(ctx.taskId).toBe("task-1");
    expect(ctx.role).toBe("main");
    expect(ctx.parentInvocationId).toBeUndefined();
    expect(ctx.depth).toBe(0);
    expect(ctx.maxDepth).toBe(2);
  });

  it("starts with an uncancelled signal and full budget remaining", () => {
    const ctx = root();
    expect(ctx.signal.aborted).toBe(false);
    expect(ctx.budget).toEqual({ limit: 100, consumed: 0, remaining: 100 });
  });

  it("keeps only persist-safe primitive trace metadata", () => {
    const signal = new AbortController().signal;
    const ctx = createInvocation({
      invocationId: invocationId("inv-meta"),
      taskId: taskId("task-meta"),
      role: "main",
      maxDepth: 1,
      budgetLimit: 10,
      traceMetadata: {
        keep: "yes",
        count: 3,
        flag: true,
        nil: null,
        signal: signal as unknown as string,
        secret: undefined as unknown as string,
      },
    });
    expect(ctx.traceMetadata).toEqual({ keep: "yes", count: 3, flag: true, nil: null });
    expect(JSON.parse(JSON.stringify(ctx.traceMetadata))).toEqual(ctx.traceMetadata);
    expect("signal" in ctx.traceMetadata).toBe(false);
  });
});

describe("child derivation", () => {
  it("derives a child with incremented depth and parent identity", () => {
    const parent = root();
    const result = parent.deriveChild({
      invocationId: invocationId("inv-child"),
      role: "worker",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const child = result.context;
    expect(child.invocationId).toBe("inv-child");
    expect(child.taskId).toBe("task-1");
    expect(child.parentInvocationId).toBe("inv-root");
    expect(child.depth).toBe(1);
    expect(child.role).toBe("worker");
  });

  it("monotonically increments depth across the chain", () => {
    const a = root();
    const b = a.deriveChild({ invocationId: invocationId("inv-b"), role: "worker" });
    const c = b.ok
      ? b.context.deriveChild({ invocationId: invocationId("inv-c"), role: "worker" })
      : undefined;
    expect(b.ok && b.context.depth).toBe(1);
    expect(c && c.ok && c.context.depth).toBe(2);
  });

  it("fails closed beyond the maximum depth", () => {
    const a = root(); // maxDepth 2
    const b = a.deriveChild({ invocationId: invocationId("inv-b"), role: "worker" });
    if (!b.ok) throw new Error("expected ok");
    const c = b.context.deriveChild({ invocationId: invocationId("inv-c"), role: "worker" });
    if (!c.ok) throw new Error("expected ok");
    const d = c.context.deriveChild({ invocationId: invocationId("inv-d"), role: "worker" });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected failure");
    const failure: DerivationFailure = d.failure;
    if (failure.kind !== "max_depth_exceeded") throw new Error("expected max_depth_exceeded");
    expect(failure.depth).toBe(3);
    expect(failure.maxDepth).toBe(2);
  });

  it("rejects a child budget larger than the parent limit", () => {
    const parent = root(); // limit 100
    const result = parent.deriveChild({
      invocationId: invocationId("inv-greedy"),
      role: "worker",
      budgetLimit: 150,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("budget_increase_forbidden");
  });

  it("accepts an explicit smaller child budget", () => {
    const result = root().deriveChild({
      invocationId: invocationId("inv-small"),
      role: "worker",
      budgetLimit: 40,
    });
    expect(result.ok && result.context.budget.limit).toBe(40);
  });

  it("clamps the inherited child budget to the parent's unconsumed limit", () => {
    const parent = root(); // limit 100
    parent.spend(30);
    const result = parent.deriveChild({
      invocationId: invocationId("inv-clamped"),
      role: "worker",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Inherited limit stays within the parent cap and remaining reflects spend.
    expect(result.context.budget.limit).toBeLessThanOrEqual(100);
    expect(result.context.budget.remaining).toBe(70);
  });

  it("exposes shared consumed budget across siblings and ancestors", () => {
    const parent = root();
    const a = parent.deriveChild({ invocationId: invocationId("inv-a"), role: "worker" });
    const b = parent.deriveChild({ invocationId: invocationId("inv-b"), role: "worker", budgetLimit: 50 });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    a.context.spend(20);
    expect(parent.budget.consumed).toBe(20);
    expect(b.context.budget.consumed).toBe(20);
    expect(parent.budget.remaining).toBe(80);
    expect(b.context.budget.remaining).toBe(30);
  });

  it("merges child trace metadata over the parent metadata", () => {
    const result = root().deriveChild({
      invocationId: invocationId("inv-meta2"),
      role: "worker",
      traceMetadata: { stage: "derive" },
    });
    expect(result.ok && result.context.traceMetadata).toEqual({
      source: "test",
      run: 7,
      stage: "derive",
    });
  });
});

describe("cancellation", () => {
  it("propagates cancellation downward from parent to child and grandchild", () => {
    const parent = root();
    const child = parent.deriveChild({ invocationId: invocationId("inv-c1"), role: "worker" });
    const grandchild = child.ok
      ? child.context.deriveChild({ invocationId: invocationId("inv-g1"), role: "advisor" })
      : undefined;
    if (!grandchild || !grandchild.ok) throw new Error("expected ok");
    expect(parent.signal.aborted).toBe(false);
    parent.requestCancellation();
    expect(parent.signal.aborted).toBe(true);
    expect(child.ok && child.context.signal.aborted).toBe(true);
    expect(grandchild.context.signal.aborted).toBe(true);
  });

  it("does not propagate cancellation upward from child to parent", () => {
    const parent = root();
    const child = parent.deriveChild({ invocationId: invocationId("inv-c2"), role: "worker" });
    if (!child.ok) throw new Error("expected ok");
    child.context.requestCancellation();
    expect(child.context.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it("aborts children created after the parent was cancelled", () => {
    const parent = root();
    parent.requestCancellation();
    const child = parent.deriveChild({ invocationId: invocationId("inv-c3"), role: "worker" });
    expect(child.ok && child.context.signal.aborted).toBe(true);
  });
});

describe("budget guards", () => {
  it("exposes a persist-safe budget exhaustion check", () => {
    const ctx = root();
    expect(budgetExceeded(ctx)).toBe(false);
    ctx.spend(100);
    expect(budgetExceeded(ctx)).toBe(true);
  });
});
