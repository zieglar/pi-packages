import { describe, expect, it } from "vitest";
import {
  failure,
  type Failure,
  type FailureKind,
  normalizeError,
  success,
} from "../src/types/result.js";

const ALL_KINDS: readonly FailureKind[] = [
  "authentication",
  "cancellation",
  "context_overflow",
  "rate_limit",
  "usage_limit",
  "provider",
  "network",
  "validation",
  "reasoning",
  "tool",
  "capability",
];

describe("execution result discrimination", () => {
  it("discriminates success and failure values", () => {
    const ok = success(42);
    const bad = failure({
      kind: "provider",
      scope: "provider",
      confidence: "ambiguous",
      code: "boom",
      message: "provider exploded",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe(42);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure.kind).toBe("provider");
  });
});

describe("failure taxonomy", () => {
  it("keeps every required failure kind distinct", () => {
    const kinds = new Set(ALL_KINDS);
    expect(kinds.size).toBe(ALL_KINDS.length);
    for (const kind of ALL_KINDS) {
      const f: Failure = {
        kind,
        scope: "invocation",
        confidence: "certain",
        code: "code",
        message: "m",
      };
      expect(f.kind).toBe(kind);
    }
  });

  it("carries retry and reset timing only when present", () => {
    const withRetry: Failure = {
      kind: "rate_limit",
      scope: "provider",
      confidence: "ambiguous",
      code: "429",
      message: "slow down",
      retryAfterMs: 5_000,
      resetAtMs: 1_760_000_000_000,
    };
    expect(withRetry.retryAfterMs).toBe(5_000);
    expect(withRetry.resetAtMs).toBe(1_760_000_000_000);
  });
});

describe("conservative error normalization", () => {
  it("maps 401/403 to authentication failures scoped to the account", () => {
    const f = normalizeError({ status: 401, message: "unauthorized" });
    expect(f.kind).toBe("authentication");
    expect(f.scope).toBe("account");
    expect(f.confidence).toBe("certain");
  });

  it("maps abort signals to cancellation scoped to the invocation", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const f = normalizeError(err);
    expect(f.kind).toBe("cancellation");
    expect(f.scope).toBe("invocation");
    expect(f.confidence).toBe("certain");
  });

  it("maps oversized-context errors to context overflow", () => {
    const f = normalizeError({
      status: 400,
      message: "prompt is too long: context length exceeded",
    });
    expect(f.kind).toBe("context_overflow");
    expect(f.scope).toBe("model");
  });

  it("treats an unqualified HTTP 429 as rate_limit with ambiguous confidence", () => {
    const f = normalizeError({ status: 429, message: "Too Many Requests" });
    expect(f.kind).toBe("rate_limit");
    expect(f.confidence).toBe("ambiguous");
  });


  it("preserves explicit normalized retry and reset hints without upgrading an ambiguous 429", () => {
    const f = normalizeError({
      status: 429,
      message: "Too Many Requests",
      retryAfterMs: 2_000,
      resetAtMs: 9_000,
    });
    expect(f).toMatchObject({
      kind: "rate_limit",
      confidence: "ambiguous",
      retryAfterMs: 2_000,
      resetAtMs: 9_000,
    });
  });
  it("never upgrades an unqualified 429 to usage_limit", () => {
    const f = normalizeError({ status: 429, message: "Too Many Requests", headers: {} });
    expect(f.kind).not.toBe("usage_limit");
  });

  it("maps explicit usage-exhaustion errors to usage_limit with reset hints", () => {
    const f = normalizeError({
      status: 429,
      message: "usage limit exceeded for this plan",
    });
    expect(f.kind).toBe("usage_limit");
    expect(f.scope).toBe("account");
    expect(f.confidence).toBe("certain");
  });

  it("maps transport errors to network failures", () => {
    const conn = new Error("connect ECONNREFUSED 127.0.0.1:443");
    (conn as NodeJS.ErrnoException).code = "ECONNREFUSED";
    expect(normalizeError(conn).kind).toBe("network");
    expect(normalizeError(new TypeError("fetch failed")).kind).toBe("network");
  });

  it("maps server errors to provider failures", () => {
    const f = normalizeError({ status: 503, message: "upstream unavailable" });
    expect(f.kind).toBe("provider");
    expect(f.scope).toBe("provider");
  });

  it("maps validation, reasoning, and tool failures distinctly", () => {
    const validation = new Error("bad input");
    validation.name = "ValidationError";
    expect(normalizeError(validation).kind).toBe("validation");
    const reasoning = new Error("unsupported thinking budget");
    reasoning.name = "ReasoningError";
    expect(normalizeError(reasoning).kind).toBe("reasoning");
    const tool = new Error("tool crashed");
    tool.name = "ToolError";
    expect(normalizeError(tool).kind).toBe("tool");
  });

  it("normalizes unknown errors without persisting raw bodies or stacks", () => {
    const raw = new Error("weird sk-abcdefghijklmnop123456 failure");
    const f = normalizeError(raw);
    expect(f.kind).toBe("unknown");
    expect(f.confidence).toBe("ambiguous");
    expect(typeof f.message).toBe("string");
    expect(f.message).not.toContain("sk-abcdefghijklmnop123456");
    expect(JSON.stringify(f)).not.toContain("stack");
  });

  it("passes already-typed failures through unchanged", () => {
    const original: Failure = {
      kind: "capability",
      scope: "invocation",
      confidence: "certain",
      code: "not_allowed",
      message: "denied",
    };
    expect(normalizeError(original)).toEqual(original);
  });

  it("sanitizes typed-looking thrown failures and rejects incomplete failure shapes", () => {
    const typed = normalizeError({
      kind: "provider",
      scope: "provider",
      confidence: "ambiguous",
      code: "upstream",
      message: "failed with sk-abcdefghijklmnop123456",
    });
    expect(typed.message).not.toContain("sk-abcdefghijklmnop123456");

    const incomplete = normalizeError({
      kind: "provider",
      code: "upstream",
      message: "failed",
    });
    expect(incomplete.kind).toBe("unknown");
    expect(incomplete.scope).toBe("system");
  });
});
