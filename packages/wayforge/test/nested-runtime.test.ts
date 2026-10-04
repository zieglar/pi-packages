import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityCatalog } from "../src/kernel/capability-catalog.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import { ModelPolicy, type StaticModelRoute } from "../src/policy/model-policy.js";
import { RolePolicy, type RoleRule } from "../src/policy/role-policy.js";
import { PiCompatibilityAdapter } from "../src/runtime/pi-compatibility-adapter.js";
import { NestedInvoker } from "../src/runtime/nested-invoker.js";
import type { NestedModelRuntimePort } from "../src/runtime/ports.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";
import { failure, success } from "../src/types/result.js";

const rules: readonly RoleRule[] = [
  {
    role: "worker",
    capabilityId: capabilityId("cap-nested"),
    allowNested: false,
    needsStreaming: true,
    needsReasoning: false,
    needsTools: true,
    budgetLimit: 200,
  },
  {
    role: "advisor",
    capabilityId: capabilityId("cap-advisor"),
    allowNested: false,
    needsStreaming: true,
    needsReasoning: true,
    needsTools: false,
    budgetLimit: 50,
  },
];

const routes: readonly StaticModelRoute[] = [
  {
    routeId: routeId("route-fast"),
    provider: "anthropic",
    modelId: "claude-haiku",
    tier: "fast",
    thinking: "minimal",
    capabilityId: capabilityId("cap-nested"),
    budgetLimit: 200,
  },
  {
    routeId: routeId("route-advisor"),
    provider: "openai",
    modelId: "gpt-5",
    tier: "balanced",
    thinking: "medium",
    capabilityId: capabilityId("cap-advisor"),
    budgetLimit: 50,
  },
];

function makeInvoker(runtime: NestedModelRuntimePort) {
  return new NestedInvoker(
    new RolePolicy(rules),
    new ModelPolicy(routes),
    CapabilityCatalog,
    runtime,
  );
}

function parentCtx() {
  return createInvocation({
    invocationId: invocationId("inv-root"),
    taskId: taskId("task-1"),
    role: "main",
    maxDepth: 2,
    budgetLimit: 100,
  });
}

describe("nested invoker", () => {
  it("derives a child, resolves policy, and makes exactly one runtime attempt", async () => {
    const stream = vi.fn(async () =>
      success({ text: "done", usage: { inputTokens: 5, outputTokens: 7 } }),
    );
    const invoker = makeInvoker({ stream });
    const result = await invoker.invoke({
      parent: parentCtx(),
      invocationId: invocationId("inv-child"),
      role: "worker",
      prompt: "summarize",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.child.depth).toBe(1);
    expect(result.value.child.parentInvocationId).toBe("inv-root");
    expect(result.value.decision.modelId).toBe("claude-haiku");
    expect(result.value.output.text).toBe("done");
    expect(stream).toHaveBeenCalledTimes(1);
    const firstCall = stream.mock.calls[0] as unknown as
      | [{ modelId: string; provider: string }]
      | undefined;
    expect(firstCall?.[0]?.modelId).toBe("claude-haiku");
    expect(firstCall?.[0]?.provider).toBe("anthropic");
  });

  it("never retries a failed runtime attempt", async () => {
    const stream = vi.fn(async () =>
      failure({
        kind: "provider",
        scope: "provider",
        confidence: "ambiguous",
        code: "503",
        message: "upstream unavailable",
      }),
    );
    const invoker = makeInvoker({ stream });
    const result = await invoker.invoke({
      parent: parentCtx(),
      invocationId: invocationId("inv-child"),
      role: "worker",
      prompt: "retry me",
    });
    expect(result.ok).toBe(false);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("rejects the main role for nested work", async () => {
    const stream = vi.fn();
    const invoker = makeInvoker({ stream });
    const result = await invoker.invoke({
      parent: parentCtx(),
      invocationId: invocationId("inv-main"),
      role: "main",
      prompt: "no",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("capability");
    expect(result.failure.code).toBe("main_role_not_nested");
    expect(stream).not.toHaveBeenCalled();
  });

  it("fails closed when the derivation tree is at maximum depth", async () => {
    const stream = vi.fn();
    const invoker = makeInvoker({ stream });
    const root = createInvocation({
      invocationId: invocationId("inv-root2"),
      taskId: taskId("task-2"),
      role: "main",
      maxDepth: 0,
      budgetLimit: 10,
    });
    const result = await invoker.invoke({
      parent: root,
      invocationId: invocationId("inv-too-deep"),
      role: "worker",
      prompt: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("capability");
    expect(result.failure.code).toBe("max_depth_exceeded");
    expect(stream).not.toHaveBeenCalled();
  });

  it("does not call the runtime when the parent was already cancelled", async () => {
    const stream = vi.fn();
    const invoker = makeInvoker({ stream });
    const parent = parentCtx();
    parent.requestCancellation();
    const result = await invoker.invoke({
      parent,
      invocationId: invocationId("inv-cancelled"),
      role: "worker",
      prompt: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("cancellation");
    expect(stream).not.toHaveBeenCalled();
  });

  it("clamps the runtime budget to the derived child budget and sanitizes trace events", async () => {
    const stream = vi.fn(async () =>
      success({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }),
    );
    const invoker = makeInvoker({ stream });
    const result = await invoker.invoke({
      parent: parentCtx(),
      invocationId: invocationId("inv-budget"),
      role: "worker",
      prompt: "work",
      budgetLimit: 25,
      metadata: { apiKey: "sk-leaky", stage: "nested" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.child.budget.limit).toBe(25);
    expect(result.value.decision.budget.limit).toBe(25);
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ budgetLimit: 25 }));
    const kinds = result.value.trace.map((e) => e.kind).sort();
    expect(kinds).toEqual(["invocation", "nesting", "policy_decision", "route_selection"]);
    const nesting = result.value.trace.find((e) => e.kind === "nesting");
    expect(nesting?.detail).toMatchObject({ stage: "nested" });
    expect(JSON.stringify(nesting?.detail)).not.toContain("sk-leaky");
    expect(JSON.stringify(nesting?.detail)).not.toContain("signal");
  });

  it("fails closed without calling the runtime when the child budget is exhausted", async () => {
    const stream = vi.fn();
    const invoker = makeInvoker({ stream });
    const parent = parentCtx();
    parent.spend(100);
    const result = await invoker.invoke({
      parent,
      invocationId: invocationId("inv-no-budget"),
      role: "worker",
      prompt: "work",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.code).toBe("budget_exhausted");
    expect(stream).not.toHaveBeenCalled();
  });

  it("debits successful nested token usage from the shared budget ledger", async () => {
    const invoker = makeInvoker({
      stream: async () => success({ text: "ok", usage: { inputTokens: 5, outputTokens: 7 } }),
    });
    const parent = parentCtx();
    const result = await invoker.invoke({
      parent,
      invocationId: invocationId("inv-charge-budget"),
      role: "worker",
      prompt: "work",
    });
    expect(result.ok).toBe(true);
    expect(parent.budget.consumed).toBe(12);
  });
});

describe("pi compatibility adapter (sentinel nested runtime path)", () => {
  const fakeModel = { id: "claude-haiku", api: "anthropic" } as never;

  function makeRegistry(result: unknown = { content: [{ type: "text", text: "hello" }], usage: { input: 3, output: 4 } }) {
    const streamResult = {
      result: () => Promise.resolve(result),
    };
    const streamSimple = vi.fn(() => streamResult);
    const ctx = {
      modelRegistry: {
        find: vi.fn(() => fakeModel),
        streamSimple,
      },
    };
    return { ctx: ctx as unknown as ExtensionContext, streamSimple, pi: {} as ExtensionAPI };
  }

  it("streams through ctx.modelRegistry.streamSimple with resolved model, reasoning, and signal", async () => {
    const { ctx, streamSimple, pi } = makeRegistry();
    const adapter = new PiCompatibilityAdapter(pi, ctx);
    const controller = new AbortController();
    const result = await adapter.stream({
      provider: "anthropic",
      modelId: "claude-haiku",
      thinking: "low",
      prompt: "say hi",
      signal: controller.signal,
      budgetLimit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.text).toBe("hello");
    expect(result.value.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(streamSimple).toHaveBeenCalledTimes(1);
    const [model, context, options] = streamSimple.mock.calls[0] as unknown as [
      unknown,
      { messages: { role: string; content: string }[] },
      { reasoning?: string; signal?: AbortSignal },
    ];
    expect(model).toBe(fakeModel);
    expect(context.messages[0]?.role).toBe("user");
    expect(context.messages[0]?.content).toBe("say hi");
    expect(options?.reasoning).toBe("low");
    expect(options?.signal).toBe(controller.signal);
  });

  it("maps a missing model to a typed provider failure", async () => {
    const streamSimple = vi.fn();
    const ctx = {
      modelRegistry: { find: vi.fn(() => undefined), streamSimple },
    };
    const adapter = new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext);
    const result = await adapter.stream({
      provider: "anthropic",
      modelId: "missing",
      thinking: "low",
      prompt: "x",
      budgetLimit: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.code).toBe("model_not_found");
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("normalizes a thrown stream error into a typed failure", async () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    const { ctx, pi } = makeRegistry(Promise.reject(aborted));
    const adapter = new PiCompatibilityAdapter(pi, ctx);
    const result = await adapter.stream({
      provider: "anthropic",
      modelId: "claude-haiku",
      thinking: "low",
      prompt: "x",
      budgetLimit: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("cancellation");
  });
});
