import { describe, expect, it } from "vitest";
import { isSensitiveKey, redact, redactTraceMetadata } from "../src/trace/redaction.js";

describe("recursive redaction", () => {
  it("removes credential fields, API keys, tokens, cookies, and authorization headers", () => {
    const input = {
      apiKey: "sk-secret",
      nested: {
        api_key: "sk-nested",
        access_token: "tok",
        refresh_token: "tok2",
        bearer: "Bearer xyz",
        cookie: "session=1",
        set_cookie: ["a=b"],
        authorization: "Bearer abc",
        password: "hunter2",
        secret: "shh",
        credentials: { user: "u", pass: "p" },
      },
    };
    const out = redact(input) as typeof input;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.nested.api_key).toBe("[redacted]");
    expect(out.nested.access_token).toBe("[redacted]");
    expect(out.nested.refresh_token).toBe("[redacted]");
    expect(out.nested.bearer).toBe("[redacted]");
    expect(out.nested.cookie).toBe("[redacted]");
    expect(out.nested.set_cookie).toBe("[redacted]");
    expect(out.nested.authorization).toBe("[redacted]");
    expect(out.nested.password).toBe("[redacted]");
    expect(out.nested.secret).toBe("[redacted]");
    expect(out.nested.credentials).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("sk-secret");
    expect(JSON.stringify(out)).not.toContain("Bearer abc");
  });

  it("removes raw provider bodies and responses", () => {
    const input = {
      body: '{"prompt":"raw"}',
      rawBody: "raw",
      providerBody: { chunk: 1 },
      response: { status: 429, payload: "x" },
      responseBody: "<html>",
      rawResponse: "bytes",
    };
    const out = redact(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key]).toBe("[redacted]");
    }
  });

  it("removes unnecessary account identifiers while keeping route diagnostics", () => {
    const input = {
      accountId: "acc-123",
      account_id: "acc-123",
      routeId: "route-flagship",
      provider: "anthropic",
      modelId: "claude-opus-4",
      latencyMs: 120,
    };
    const out = redact(input) as typeof input;
    expect(out.accountId).toBe("[redacted]");
    expect(out.account_id).toBe("[redacted]");
    expect(out.routeId).toBe("route-flagship");
    expect(out.provider).toBe("anthropic");
    expect(out.modelId).toBe("claude-opus-4");
    expect(out.latencyMs).toBe(120);
  });

  it("recurses into arrays and deeply nested objects", () => {
    const input = {
      events: [{ name: "ok", apiKey: "sk-1" }, [{ token: "t" }]],
      deep: { a: { b: { c: { authorization: "Bearer z" } } } },
    };
    const out = redact(input) as typeof input;
    const first = out.events[0] as { name: string; apiKey: string };
    expect(first.name).toBe("ok");
    expect(first.apiKey).toBe("[redacted]");
    expect(out.events[1]).toEqual([{ token: "[redacted]" }]);
    expect(out.deep.a.b.c.authorization).toBe("[redacted]");
  });

  it("replaces unsupported runtime values with persist-safe sentinels", () => {
    const out = redact({
      fn: () => "secret",
      bigint: 1n,
      missing: undefined,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      fn: "[redacted]",
      bigint: "[redacted]",
      missing: "[redacted]",
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("is deterministic and does not mutate its input", () => {
    const input = { apiKey: "sk-x", keep: "yes" };
    const first = redact(input);
    const second = redact(input);
    expect(first).toEqual(second);
    expect(input.apiKey).toBe("sk-x");
  });

  it("classifies sensitive keys case-insensitively", () => {
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("x-api-key")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("routeId")).toBe(false);
  });
});

describe("trace metadata redaction", () => {
  it("keeps only primitive, safe values", () => {
    const out = redactTraceMetadata({
      stage: "derive",
      attempt: 2,
      ok: false,
      nil: null,
      signal: new AbortController().signal as unknown as string,
      apiKey: "sk-2",
    });
    expect(out).toEqual({
      stage: "derive",
      attempt: 2,
      ok: false,
      nil: null,
      apiKey: "[redacted]",
    });
  });
});
