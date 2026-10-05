import { describe, expect, it } from "vitest";
import {
  IdempotencyKeyConflictError,
  InMemoryIdempotencyStore,
  canonicalDigest,
  type IdempotentCreateRecord,
} from "../../src/protocol/idempotency.js";

function record(handoffId: string, digest: string): IdempotentCreateRecord {
  return { handoffId, requestDigest: digest, createdAt: "2026-10-05T00:00:00.000Z" };
}

describe("idempotency contract (frozen v1)", () => {
  it("equivalent repeated creation returns the same handoff id, never a second one", () => {
    const store = new InMemoryIdempotencyStore();
    const digest = canonicalDigest({ prompt: "do the thing" });

    const first = store.record("key-A", record("ho_01JTEST0000000000000000001", digest));
    const second = store.record("key-A", record("ho_01JTEST0000000000000000002", digest));

    expect(second.handoffId).toBe(first.handoffId);
    expect(second).toBe(first); // identical record returned
    expect(store.size).toBe(1);
  });

  it("same key with a different payload digest fails closed with a conflict", () => {
    const store = new InMemoryIdempotencyStore();
    store.record("key-A", record("ho_01JTEST0000000000000000001", canonicalDigest({ a: 1 })));

    expect(() =>
      store.record("key-A", record("ho_01JTEST0000000000000000009", canonicalDigest({ a: 2 }))),
    ).toThrowError(IdempotencyKeyConflictError);
    let caught: unknown;
    try {
      store.record("key-A", record("ho_01JTEST0000000000000000009", canonicalDigest({ a: 2 })));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdempotencyKeyConflictError);
    expect((caught as IdempotencyKeyConflictError).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(store.size).toBe(1);
  });

  it("distinct keys create distinct records", () => {
    const store = new InMemoryIdempotencyStore();
    const digest = canonicalDigest({ prompt: "x" });
    const a = store.record("key-A", record("ho_01JTEST0000000000000000001", digest));
    const b = store.record("key-B", record("ho_01JTEST0000000000000000002", digest));
    expect(a.handoffId).not.toBe(b.handoffId);
    expect(store.size).toBe(2);
  });

  it("canonicalDigest is order-insensitive and shape-sensitive", () => {
    expect(canonicalDigest({ a: 1, b: { c: [2, 3], d: "x" } })).toBe(
      canonicalDigest({ b: { d: "x", c: [2, 3] }, a: 1 }),
    );
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: "1" }));
    expect(canonicalDigest({ a: 1, b: 2 })).not.toBe(canonicalDigest({ a: 1 }));
    expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
  });

  it("canonicalDigest is a 64-char lowercase hex sha256", () => {
    expect(canonicalDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
