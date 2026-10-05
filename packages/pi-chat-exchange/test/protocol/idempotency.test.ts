import { describe, expect, it } from "vitest";
import {
  DigestInputError,
  IdempotencyKeyConflictError,
  canonicalDigest,
  type IdempotentCreateRecord,
} from "../../src/protocol/idempotency.js";
import { InMemoryIdempotencyStore } from "../../src/core/reference.js";

function record(entityId: string, digest: string): IdempotentCreateRecord {
  return { entityId, requestDigest: digest, createdAt: "2026-10-06T00:00:00.000Z" };
}

describe("idempotency contract (protocol v2)", () => {
  it("equivalent repeated creation returns the same entity id, never a second one", () => {
    const store = new InMemoryIdempotencyStore();
    const digest = canonicalDigest({ prompt: "do the thing" });

    const first = store.record("ns", "key-A", record("msg_01JTEST0000000000000000001", digest));
    const second = store.record("ns", "key-A", record("msg_01JTEST0000000000000000002", digest));

    expect(second.entityId).toBe(first.entityId);
    expect(second).toBe(first); // identical record returned
    expect(store.size).toBe(1);
  });

  it("same key with a different payload digest fails closed with a conflict", () => {
    const store = new InMemoryIdempotencyStore();
    store.record("ns", "key-A", record("msg_01JTEST0000000000000000001", canonicalDigest({ a: 1 })));

    expect(() =>
      store.record("ns", "key-A", record("msg_01JTEST0000000000000000009", canonicalDigest({ a: 2 }))),
    ).toThrowError(IdempotencyKeyConflictError);
    let caught: unknown;
    try {
      store.record("ns", "key-A", record("msg_01JTEST0000000000000000009", canonicalDigest({ a: 2 })));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdempotencyKeyConflictError);
    expect((caught as IdempotencyKeyConflictError).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(store.size).toBe(1);
  });

  it("scopes keys to an explicit namespace", () => {
    const store = new InMemoryIdempotencyStore();
    const digest = canonicalDigest({ prompt: "x" });
    const a = store.record("client-a", "key-A", record("msg_01JTEST0000000000000000001", digest));
    const b = store.record("client-b", "key-A", record("msg_01JTEST0000000000000000002", digest));
    expect(a.entityId).not.toBe(b.entityId);
    expect(store.size).toBe(2);
    expect(store.get("client-a", "key-A")?.entityId).toBe(a.entityId);
    expect(store.get("client-b", "key-A")?.entityId).toBe(b.entityId);
    expect(store.get("client-c", "key-A")).toBeUndefined();
  });

  it("returns immutable snapshot records that cannot drift after recording", () => {
    const store = new InMemoryIdempotencyStore();
    const input = record("msg_01JTEST0000000000000000001", canonicalDigest({ a: 1 }));
    store.record("ns", "key-A", input);
    const stored = store.get("ns", "key-A")!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { entityId?: string }).entityId = "msg_01JTEST0000000000000000009";
    }).toThrow();
    // Mutating the caller's object after recording must not corrupt the store.
    (input as { entityId?: string }).entityId = "msg_01JTEST0000000000000000009";
    expect(store.get("ns", "key-A")?.entityId).toBe("msg_01JTEST0000000000000000001");
  });

  it("distinct keys create distinct records", () => {
    const store = new InMemoryIdempotencyStore();
    const digest = canonicalDigest({ prompt: "x" });
    const a = store.record("ns", "key-A", record("msg_01JTEST0000000000000000001", digest));
    const b = store.record("ns", "key-B", record("msg_01JTEST0000000000000000002", digest));
    expect(a.entityId).not.toBe(b.entityId);
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
    expect(canonicalDigest(null)).toBe(canonicalDigest(null));
  });

  it("canonicalDigest is a 64-char lowercase hex sha256", () => {
    expect(canonicalDigest({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalDigest rejects unsupported and cyclic inputs with a typed error", () => {
    expect(() => canonicalDigest(undefined)).toThrowError(DigestInputError);
    expect(() => canonicalDigest(() => 1)).toThrowError(DigestInputError);
    expect(() => canonicalDigest(Symbol("x"))).toThrowError(DigestInputError);
    expect(() => canonicalDigest(1n)).toThrowError(DigestInputError);
    expect(() => canonicalDigest(Number.NaN)).toThrowError(DigestInputError);
    expect(() => canonicalDigest({ a: undefined })).toThrowError(DigestInputError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalDigest(cyclic)).toThrowError(DigestInputError);
    const shared: unknown[] = [];
    const indirect = { shared };
    shared.push(indirect);
    expect(() => canonicalDigest(indirect)).toThrowError(DigestInputError);
  });
});
