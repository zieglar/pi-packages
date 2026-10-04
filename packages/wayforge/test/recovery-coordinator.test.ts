import { describe, expect, it } from "vitest";
import { RecoveryCoordinator, type RecoveryInput, type RouteRef } from "../src/recovery/recovery-coordinator.js";
import type { Failure } from "../src/types/result.js";

const currentRoute: RouteRef = {
  routeId: "route-a",
  provider: "anthropic",
  modelId: "claude-opus-4",
  accountId: "acc-1",
};

const altAccount: RouteRef = { routeId: "route-b", provider: "anthropic", modelId: "claude-opus-4", accountId: "acc-2" };
const altModel: RouteRef = { routeId: "route-c", provider: "anthropic", modelId: "claude-haiku", accountId: "acc-1" };
const altProvider: RouteRef = { routeId: "route-d", provider: "openai", modelId: "gpt-5", accountId: "acc-3" };

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    failure: {
      kind: "provider",
      scope: "provider",
      confidence: "ambiguous",
      code: "http_503",
      message: "upstream unavailable",
      retryAfterMs: 2_000,
    },
    currentRoute,
    alternatives: [altAccount, altModel, altProvider],
    budget: { retriesLeft: 2, fallbacksLeft: 2 },
    health: {},
    ...overrides,
  };
}

describe("recovery coordinator precedence", () => {
  const coordinator = new RecoveryCoordinator();

  it("stops immediately on cancellation", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "cancellation",
          scope: "invocation",
          confidence: "certain",
          code: "aborted",
          message: "cancelled",
        },
      }),
    );
    expect(decision.action).toBe("stop");
  });

  it("blocks when both retry and fallback budgets are exhausted", () => {
    const decision = coordinator.plan(input({ budget: { retriesLeft: 0, fallbacksLeft: 0 } }));
    expect(decision.action).toBe("block");
  });

  it("retries the current route for temporary transient failures within bounds", () => {
    const decision = coordinator.plan(input());
    expect(decision.action).toBe("retry_same_route");
    expect(decision.retryAfterMs).toBe(2_000);
    expect(decision.route).toBeUndefined();
  });

  it("does not retry when retries are exhausted but falls back instead", () => {
    const decision = coordinator.plan(
      input({
        budget: { retriesLeft: 0, fallbacksLeft: 1 },
        failure: {
          kind: "provider",
          scope: "provider",
          confidence: "ambiguous",
          code: "http_503",
          message: "upstream unavailable",
          retryAfterMs: 2_000,
        },
      }),
    );
    expect(decision.action).not.toBe("retry_same_route");
    expect(decision.action).toBe("fallback_provider");
  });

  it("rotates the account for account-scoped failures", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "authentication",
          scope: "account",
          confidence: "certain",
          code: "http_401",
          message: "invalid api key",
        },
        budget: { retriesLeft: 1, fallbacksLeft: 1 },
      }),
    );
    expect(decision.action).toBe("rotate_account");
    expect(decision.route?.routeId).toBe("route-b");
  });

  it("falls back to another model for model-scoped failures", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "context_overflow",
          scope: "model",
          confidence: "certain",
          code: "context_overflow",
          message: "prompt too long",
        },
      }),
    );
    expect(decision.action).toBe("fallback_model");
    expect(decision.route?.modelId).toBe("claude-haiku");
  });

  it("falls back to another provider for provider-scoped failures when retries are exhausted", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "provider",
          scope: "provider",
          confidence: "ambiguous",
          code: "http_503",
          message: "upstream unavailable",
          retryAfterMs: 2_000,
        },
        budget: { retriesLeft: 0, fallbacksLeft: 2 },
      }),
    );
    expect(decision.action).toBe("fallback_provider");
    expect(decision.route?.provider).toBe("openai");
  });

  it("prefers account rotation over model fallback for account failures", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "usage_limit",
          scope: "account",
          confidence: "certain",
          code: "usage_exhausted",
          message: "plan exhausted",
          resetAtMs: 1_760_000_000_000,
        },
      }),
    );
    expect(decision.action).toBe("rotate_account");
  });

  it("suspends when no alternative exists for a reset-bearing limit", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "usage_limit",
          scope: "account",
          confidence: "certain",
          code: "usage_exhausted",
          message: "plan exhausted",
          resetAtMs: 1_760_000_000_000,
        },
        alternatives: [],
        budget: { retriesLeft: 1, fallbacksLeft: 1 },
      }),
    );
    expect(decision.action).toBe("suspend");
    expect(decision.resumeAtMs).toBe(1_760_000_000_000);
  });

  it("blocks when nothing in the precedence chain applies", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "validation",
          scope: "invocation",
          confidence: "certain",
          code: "bad_request",
          message: "invalid payload",
        },
        alternatives: [],
      }),
    );
    expect(decision.action).toBe("block");
  });

  it("skips unhealthy alternatives deterministically", () => {
    const decision = coordinator.plan(
      input({
        failure: {
          kind: "context_overflow",
          scope: "model",
          confidence: "certain",
          code: "context_overflow",
          message: "too long",
        },
        alternatives: [altModel, altProvider],
        health: { "route-c": { available: false } },
      }),
    );
    // The only same-provider model alternative is unhealthy, so no fallback
    // target exists and the planner blocks rather than picking a bad route.
    expect(decision.action).toBe("block");
    expect(decision.route).toBeUndefined();
  });

  it("never emits advisor semantics for infrastructure failures", () => {
    const infraKinds = ["provider", "network", "rate_limit"] as const;
    for (const kind of infraKinds) {
      const f: Failure = {
        kind,
        scope: "provider",
        confidence: "ambiguous",
        code: "x",
        message: "infra failure",
      };
      const decision = coordinator.plan(
        input({ failure: f, budget: { retriesLeft: 0, fallbacksLeft: 0 }, alternatives: [] }),
      );
      expect(decision.action).not.toBe("consult_advisor");
      expect("advisor" in decision).toBe(false);
    }
  });

  it("is pure: identical inputs produce identical decisions", () => {
    const a = coordinator.plan(input());
    const b = coordinator.plan(input());
    expect(a).toEqual(b);
  });
});
