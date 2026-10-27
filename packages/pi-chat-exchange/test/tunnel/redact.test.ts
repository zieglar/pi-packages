/**
 * HANDOFF-CE-HOST-09 B1 — redaction filter tests.
 *
 * Historical secret cases retained. B1-FIX deliberately removes diagnostic
 * passthrough, prefix retention and regex rule IDs: all nonempty raw records
 * are suppressed, including ordinary diagnostics. This is a safety downgrade
 * of observability, not a claim of universal secret-pattern recognition.
 */
import { describe, expect, it } from "vitest";
import { redactChildOutput } from "../../src/tunnel/redact.js";

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly rule: string;
  readonly input: string;
  /** Substrings that must NOT appear in the sanitized text. */
  readonly mustNotContain: readonly string[];
  /** Optional exact-match expectation for the sanitized text. */
  readonly expected?: string;
}> = Object.freeze([
  {
    name: "authorization header is suppressed wholesale",
    rule: "authorization-header",
    input: "Authorization: Bearer abcdefgh1234",
    mustNotContain: ["Bearer abcdefgh1234"],
  },
  {
    name: "bearer token line is replaced wholesale",
    rule: "bearer-token",
    input: "bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    mustNotContain: ["eyJhbGciOiJIUzI1NiJ9.payload.signature"],
  },
  {
    name: "sk- prefixed token — whole token replaced, even if it contains the word authorization",
    rule: "sk-prefixed",
    // Lane A finding 1: r1 preserved this token via content branching.
    input: "rejected sk-authorizationabcdefgh",
    mustNotContain: ["sk-authorizationabcdefgh", "authorizationabcdefgh"],
  },
  {
    name: "jwt triple is replaced",
    rule: "jwt",
    input: "session eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart ok",
    mustNotContain: ["eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart"],
  },
  {
    name: "cap_ capability token is replaced",
    rule: "cap-prefixed",
    input: "capability cap_0123456789abcdef0123 rejected",
    mustNotContain: ["cap_0123456789abcdef0123"],
  },
  {
    name: "tunnel id is suppressed without retaining a prefix",
    rule: "tunnel-id",
    input: "tunnel_6ad49f0123456789abcdef0123456789 connected",
    mustNotContain: ["tunnel_6ad49f0123456789abcdef0123456789"],
  },
  {
    name: "long opaque secret is replaced",
    rule: "long-opaque",
    input: `runtime key ${"A".repeat(48)} invalid`,
    mustNotContain: ["A".repeat(48)],
  },
]);

describe("redactChildOutput — fixed suppression of historical cases", () => {
  for (const c of CASES) {
    it(`${c.name} [${c.rule}]`, () => {
      const out = redactChildOutput(c.input);
      expect(out.appliedRules).toEqual(["raw-output-suppressed"]);
      expect(out.text).toBe("[child output suppressed]");
      for (const forbidden of c.mustNotContain) {
        expect(out.text).not.toContain(forbidden);
      }
      if (c.expected !== undefined) expect(out.text).toBe(c.expected);
    });
  }

  it("suppresses ordinary diagnostics too (intentional safety contract)", () => {
    const out = redactChildOutput("tunnel-client started; readyz ok; poll interval 30s");
    expect(out.text).toBe("[child output suppressed]");
    expect(out.appliedRules).toEqual(["raw-output-suppressed"]);
  });

  it("Lane A finding 2: a NUL inside a token cannot evade (normalize before match)", () => {
    const out = redactChildOutput("rejected sk-\u0000abcdefgh1234");
    expect(out.text).not.toContain("abcdefgh1234");
    expect(out.appliedRules).toContain("raw-output-suppressed");
  });

  it("zero-width joiners inside a token cannot evade", () => {
    const out = redactChildOutput("rejected sk-a\u200bbcdefgh1234");
    expect(out.text).not.toContain("bcdefgh1234");
  });

  it("bounds the output length", () => {
    // Space-separated words so no redaction rule swallows the filler first.
    const out = redactChildOutput("x ".repeat(5_000));
    expect(out.truncated).toBe(false); // suppression never retains a raw prefix
    expect(out.text.length).toBeLessThanOrEqual(2_100);
  });

  it("is idempotent: re-redacting sanitized text is a no-op", () => {
    const once = redactChildOutput("Authorization: Bearer abcdefgh1234 and sk-abcdefgh1234");
    const twice = redactChildOutput(once.text);
    expect(twice.text).toBe(once.text);
  });

  it("never throws on hostile input and never echoes it back", () => {
    const hostile = "\u0000\uFFFF" + "k".repeat(500);
    expect(() => redactChildOutput(hostile)).not.toThrow();
    const out = redactChildOutput(hostile);
    expect(out.text).not.toContain("k".repeat(40));
  });

  // --- r3 regression: verification-lane attack table (all five FAIL cases) ---

  it("case-variant SK- prefix cannot evade (r3 case bypass)", () => {
    const out = redactChildOutput("rejected SK-AbCdEfGh1234");
    expect(out.text).not.toContain("AbCdEfGh1234");
  });

  it("a multiline Authorization header cannot leave the wrapped token behind", () => {
    const out = redactChildOutput("Authorization: Bearer\nAbCdEfGh1234");
    expect(out.text).not.toContain("AbCdEfGh1234");
  });

  it("URL query credentials and parameter names are suppressed", () => {
    const out = redactChildOutput("https://x.test/?token=AbCdEfGh1234");
    expect(out.text).not.toContain("AbCdEfGh1234");
    expect(out.text).toBe("[child output suppressed]");
  });

  it("URL userinfo credentials are redacted", () => {
    const out = redactChildOutput("https://user:secret@example.test/mcp");
    expect(out.text).not.toContain("secret");
    expect(out.text).toBe("[child output suppressed]");
  });

  it("invisible separators (U+2063 word joiner) inside a token cannot evade", () => {
    const out = redactChildOutput("rejected sk-AbCd\u2063EfGh1234");
    expect(out.text).not.toContain("EfGh1234");
  });

  it("single-line 'Authorization: Bearer <token>' leaves NO token behind (order conflict)", () => {
    const out = redactChildOutput("Authorization: Bearer AbCdEfGh1234");
    expect(out.text).not.toContain("AbCdEfGh1234");
  });
});