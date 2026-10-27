/**
 * In-memory REFERENCE implementation of the idempotency contract.
 * This demonstrates namespace/key scoping and immutable replay, not durability.
 * A durable host must preserve these semantics transactionally.
 */
import {
  type IdempotentCreateRecord,
  type IdempotencyStore,
  IdempotencyKeyConflictError,
} from "../protocol/idempotency.js";

function scopedKey(namespace: string, key: string): string {
  return JSON.stringify([namespace, key]);
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotentCreateRecord>();

  get(namespace: string, key: string): IdempotentCreateRecord | undefined {
    return this.#records.get(scopedKey(namespace, key));
  }

  record(namespace: string, key: string, record: IdempotentCreateRecord): IdempotentCreateRecord {
    const scoped = scopedKey(namespace, key);
    const existing = this.#records.get(scoped);
    if (existing) {
      if (existing.requestDigest !== record.requestDigest) {
        throw new IdempotencyKeyConflictError(namespace, key);
      }
      return existing;
    }
    const frozen = Object.freeze({ ...record });
    this.#records.set(scoped, frozen);
    return frozen;
  }

  get size(): number {
    return this.#records.size;
  }
}
