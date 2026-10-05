import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  HandoffCreateRequestSchema,
  HandoffSchema,
  SHA256_HEX_PATTERN,
} from "../../src/protocol/handoff.js";
import { HandoffResultSchema } from "../../src/protocol/result-envelope.js";
import { generateHandoffId } from "../../src/protocol/identity.js";
import { canonicalDigest } from "../../src/protocol/idempotency.js";

const DIGEST = "a".repeat(64);

describe("frozen protocol schemas", () => {
  it("HandoffCreateRequestSchema is strict", () => {
    expect(Value.Check(HandoffCreateRequestSchema, { prompt: "hello" })).toBe(true);
    expect(Value.Check(HandoffCreateRequestSchema, { prompt: "" })).toBe(false);
    expect(Value.Check(HandoffCreateRequestSchema, { prompt: "x".repeat(100_001) })).toBe(false);
    expect(Value.Check(HandoffCreateRequestSchema, { prompt: "hi", idempotencyKey: "" })).toBe(false);
    expect(
      Value.Check(HandoffCreateRequestSchema, { prompt: "hi", idempotencyKey: "k", extra: 1 }),
    ).toBe(false);
    expect(Value.Check(HandoffCreateRequestSchema, {})).toBe(false);
  });

  it("HandoffSchema validates a well-formed entity and rejects malformed digests", () => {
    const entity = {
      handoffId: generateHandoffId(),
      state: "QUEUED",
      idempotencyKey: "key-1",
      promptDigest: canonicalDigest({ prompt: "hello" }),
      promptLength: 5,
      workspace: "/tmp/work",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:01.000Z",
    };
    expect(Value.Check(HandoffSchema, entity)).toBe(true);
    expect(Value.Check(HandoffSchema, { ...entity, promptDigest: "zzz" })).toBe(false);
    expect(Value.Check(HandoffSchema, { ...entity, state: "NOT_A_STATE" })).toBe(false);
    expect(Value.Check(HandoffSchema, { ...entity, handoffId: "nope" })).toBe(false);
  });

  it("HandoffResultSchema distinguishes transport, runtime, and application layers", () => {
    const envelope = {
      handoffId: generateHandoffId(),
      resultId: "hr_01JTEST0000000000000000001",
      attempt: 1,
      startedAt: "2026-10-05T00:00:02.000Z",
      settledAt: "2026-10-05T00:01:00.000Z",
      transportOutcome: "delivered",
      runtimeOutcome: "succeeded",
      result: { summary: "done", body: "full result text" },
      source: { piSessionRef: "/sessions/abc.jsonl", workspace: "/repo" },
      inputDigest: DIGEST,
      resultDigest: "b".repeat(64),
      applicationEvidence: { taskState: "complete", completionEvidenceDigest: "c".repeat(64) },
    };
    expect(Value.Check(HandoffResultSchema, envelope)).toBe(true);
    // Unknown runtime outcomes are rejected:
    expect(Value.Check(HandoffResultSchema, { ...envelope, runtimeOutcome: "perfect" })).toBe(false);
    // ...and collapsing layers is rejected:
    expect(
      Value.Check(HandoffResultSchema, { ...envelope, transportOutcome: "succeeded" }),
    ).toBe(false);
    // Bad digests and wrong id kind rejected:
    expect(Value.Check(HandoffResultSchema, { ...envelope, inputDigest: "short" })).toBe(false);
    expect(
      Value.Check(HandoffResultSchema, { ...envelope, resultId: "ho_01JTEST0000000000000000001" }),
    ).toBe(false);
    // applicationEvidence is optional and opaque:
    const { applicationEvidence: _omit, ...withoutEvidence } = envelope;
    expect(Value.Check(HandoffResultSchema, withoutEvidence)).toBe(true);
  });

  it("digest constants hold across the protocol", () => {
    expect(canonicalDigest({ x: 1 })).toMatch(SHA256_HEX_PATTERN);
  });
});
