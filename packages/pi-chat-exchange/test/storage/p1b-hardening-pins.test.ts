import type { SqliteConnection } from "../../src/storage/sqlite-driver.js";
import { rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StoreLifecycleError } from "../../src/storage/errors.js";
import { acquireOwnership, bindSession, renewLease, verifyOwnership } from "../../src/storage/ownership.js";
import {
  bindEndpointRef,
  createParticipant,
  joinExchange,
  revokeCapability,
} from "../../src/storage/participant.js";
import { classifyRecoveryFailure, recoverTrustRoot } from "../../src/storage/recovery.js";
import { StorageTransactionError } from "../../src/storage/transaction.js";
import { hostSecretPath } from "../../src/storage/trust-root.js";
import {
  capabilityFor,
  cleanupFixtures,
  exchange,
  expectRefusal,
  fixture,
  LATER,
  NOW,
  participant,
  privileged,
  reader,
  rowCounts,
  SECRET_HEX,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2A pins for the four MINOR regression gaps left open by the
 * CE-0002-B3-P1B-R1 final gate:
 *
 * A. a missing trust generation during capability verification is the typed
 *    STORAGE_CORRUPT refusal, never an opaque capability rejection;
 * B. an authorized replay keeps corruption-before-conflict ordering;
 * C. each recoverTrustRoot unwrap guard (ROLLED_BACK, non-retryable, typed
 *    lifecycle cause) is pinned;
 * D. the sponsored replay path refuses the full negative authorization matrix.
 *
 * Real file-backed v2 stores and real SQLite throughout.
 */

afterEach(cleanupFixtures);

const FORGED = `cap_${"cd".repeat(32)}`;
const SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function snapshot(active: Fixture): string {
  const view = reader(active);
  try {
    return JSON.stringify({
      counts: rowCounts(active),
      trust: view.prepare("SELECT * FROM host_trust_root ORDER BY generation").all(),
      records: view.prepare("SELECT * FROM idempotency_record ORDER BY namespace, idempotency_key").all(),
      capabilities: view.prepare("SELECT * FROM participant_capability ORDER BY capability_digest").all(),
    });
  } finally {
    view.close();
  }
}

/** Privileged test authority: lift the accepted append-only/immutability
 * triggers on one table for a single tampering statement, then restore them
 * byte-identically so the schema manifest still validates. */
function tamper(active: Fixture, table: string, sql: string, ...values: string[]): void {
  const db: Pick<DatabaseSync | SqliteConnection, "prepare" | "exec" | "close"> = privileged(active);
  try {
    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
      .all(table) as { name: string; sql: string }[];
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare(sql).run(...values);
    for (const trigger of triggers) db.exec(trigger.sql);
  } finally {
    db.close();
  }
}

function disclosure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    parts.push(current.message, String(current.stack ?? ""));
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

describe("P1B pin A: missing trust generation during capability verification", () => {
  it("refuses every authorizing operation with STORAGE_CORRUPT, fail-closed and zero-write", () => {
    const active = fixture();
    const exchangeId = exchange(active);
    const created = participant(active, "endpoint-1").participant;
    const join = capabilityFor(active, created.participantId, "join");
    const bind = capabilityFor(active, created.participantId, "bind");
    const create = capabilityFor(active, created.participantId, "create");
    const attach = capabilityFor(active, created.participantId, "attach");
    // R1 (pin P): ownership operations authorize through the same plane, so a
    // missing trust generation must refuse them all, fail-closed.
    bindSession(active.store, { participantId: created.participantId, sessionId: SESSION, capability: attach }, { now: () => LATER });
    const resume = capabilityFor(active, created.participantId, "resume", { sessionId: SESSION });
    const ownerRequest = { participantId: created.participantId, sessionId: SESSION, fencingToken: 1, capability: resume };
    tamper(active, "host_trust_root", "DELETE FROM host_trust_root");
    const before = snapshot(active);

    const attempts: [string, () => unknown, string][] = [
      ["join", () => joinExchange(active.store, { exchangeId, participantId: created.participantId, capability: join, idempotencyKey: "j" }, { now: () => LATER }), join],
      ["bind", () => bindEndpointRef(active.store, { participantId: created.participantId, endpoint: { adapter: created.adapter, endpointId: created.endpointId }, capability: bind }, { now: () => LATER }), bind],
      ["sponsored create", () => createParticipant(active.store, { endpoint: { adapter: "adapter-a", endpointId: "endpoint-2" }, idempotencyKey: "s", sponsor: { participantId: created.participantId, capability: create } }, { now: () => LATER }), create],
      ["session attach", () => bindSession(active.store, { participantId: created.participantId, sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FB0", capability: attach }, { now: () => LATER }), attach],
      ["ownership acquire", () => acquireOwnership(active.store, { participantId: created.participantId, sessionId: SESSION, capability: attach }, { now: () => LATER }), attach],
      ["lease renew", () => renewLease(active.store, ownerRequest, { now: () => LATER }), resume],
      ["ownership verify", () => verifyOwnership(active.store, ownerRequest, { now: () => LATER }), resume],
    ];
    for (const [label, run, token] of attempts) {
      const error = expectRefusal(run, "STORAGE_CORRUPT");
      expect(error, label).toBeInstanceOf(StoreLifecycleError);
      const text = disclosure(error);
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.slice(4));
      expect(text).not.toContain(SECRET_HEX);
      expect(snapshot(active), `${label} wrote durable state`).toBe(before);
    }
  });
});

describe("P1B pin B: authorized replay keeps corruption-before-conflict", () => {
  it("join: a corrupted record is corruption for both the replay and a conflicting request", () => {
    const active = fixture();
    const exchangeId = exchange(active);
    const first = participant(active, "endpoint-1").participant.participantId;
    const second = participant(active, "endpoint-2").participant.participantId;
    const firstJoin = capabilityFor(active, first, "join");
    const secondJoin = capabilityFor(active, second, "join");
    joinExchange(active.store, { exchangeId, participantId: first, capability: firstJoin, idempotencyKey: "k" }, { now: () => LATER });
    tamper(active, "idempotency_record", "UPDATE idempotency_record SET request_digest = ? WHERE idempotency_key = 'k'", "0".repeat(64));
    const before = snapshot(active);

    // Authorized replay of the same request.
    expectRefusal(
      () => joinExchange(active.store, { exchangeId, participantId: first, capability: firstJoin, idempotencyKey: "k" }, { now: () => LATER }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
    // Authorized conflicting request on the same key: still corruption first.
    expectRefusal(
      () => joinExchange(active.store, { exchangeId, participantId: second, capability: secondJoin, idempotencyKey: "k" }, { now: () => LATER }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
    // Unauthorized: authorization still outranks corruption (no oracle).
    expectRefusal(
      () => joinExchange(active.store, { exchangeId, participantId: first, capability: FORGED, idempotencyKey: "k" }, { now: () => LATER }),
      "CAPABILITY_REJECTED",
    );
    expect(snapshot(active)).toBe(before);
  });

  it("sponsored create: a corrupted record is corruption for both the replay and a conflicting request", () => {
    const active = fixture();
    const sponsor = participant(active, "endpoint-sponsor").participant.participantId;
    const create = capabilityFor(active, sponsor, "create");
    const request = (endpointId: string, capability: unknown = create) => ({
      endpoint: { adapter: "adapter-a", endpointId },
      idempotencyKey: "sponsored",
      sponsor: { participantId: sponsor, capability },
    });
    createParticipant(active.store, request("endpoint-new"), { now: () => NOW });
    tamper(active, "idempotency_record", "UPDATE idempotency_record SET request_digest = ? WHERE idempotency_key = 'sponsored'", "0".repeat(64));
    const before = snapshot(active);

    expectRefusal(() => createParticipant(active.store, request("endpoint-new"), { now: () => LATER }), "STORAGE_IDEMPOTENCY_CORRUPT");
    expectRefusal(() => createParticipant(active.store, request("endpoint-other"), { now: () => LATER }), "STORAGE_IDEMPOTENCY_CORRUPT");
    expectRefusal(() => createParticipant(active.store, request("endpoint-new", FORGED), { now: () => LATER }), "CAPABILITY_REJECTED");
    expect(snapshot(active)).toBe(before);
  });
});

describe("P1B pin C: recoverTrustRoot unwrap guards", () => {
  const lifecycle = () => new StoreLifecycleError("STORAGE_CORRUPT", "a v2 store has no host trust root generation");

  // Classifier unit pins. These construct the accepted error classes directly;
  // they do not claim end-to-end INDETERMINATE or retryable-lifecycle
  // injection, which recovery's seams cannot produce.
  it("unwraps only a proven, non-retryable rollback with a typed lifecycle cause", () => {
    const proven = new StorageTransactionError("callback failed", "callback", { cause: lifecycle(), outcome: "ROLLED_BACK" });
    const unwrapped = classifyRecoveryFailure(proven);
    expect(unwrapped).toBeInstanceOf(StoreLifecycleError);
    expect(unwrapped).toMatchObject({ code: "STORAGE_CORRUPT", cause: proven });
  });

  it("keeps INDETERMINATE even when its cause is a typed lifecycle refusal", () => {
    const indeterminate = new StorageTransactionError("ended unexpectedly", "callback", { cause: lifecycle(), outcome: "INDETERMINATE" });
    expect(classifyRecoveryFailure(indeterminate)).toBe(indeterminate);
  });

  it("keeps a retryable BUSY rollback even when its cause is a typed lifecycle refusal", () => {
    const busy = new StorageTransactionError("busy", "begin", { cause: lifecycle(), outcome: "ROLLED_BACK", busy: true });
    expect(busy.retryable).toBe(true);
    expect(classifyRecoveryFailure(busy)).toBe(busy);
  });

  it("keeps unclassified rollbacks and non-transaction errors unchanged", () => {
    const plain = new StorageTransactionError("failed", "callback", { cause: new Error("x"), outcome: "ROLLED_BACK" });
    const foreign = new Error("not a transaction error");
    const bareLifecycle = lifecycle();
    expect(classifyRecoveryFailure(plain)).toBe(plain);
    expect(classifyRecoveryFailure(foreign)).toBe(foreign);
    expect(classifyRecoveryFailure(bareLifecycle)).toBe(bareLifecycle);
  });

  function recoverable(): Fixture {
    const active = fixture();
    participant(active, "endpoint-1");
    active.store.close();
    rmSync(hostSecretPath(active.databasePath));
    return active;
  }

  it("end to end: BUSY propagates unchanged, retryable, with no trust-root write", () => {
    const active = recoverable();
    const before = snapshot(active);
    const holder = privileged(active);
    holder.exec("BEGIN IMMEDIATE");
    let caught: unknown;
    try {
      recoverTrustRoot({ directory: active.directory, filename: active.filename, busyTimeoutMs: 1, now: () => LATER, secretBytes: () => new Uint8Array(32).fill(0x41) });
    } catch (error) {
      caught = error;
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(caught).toBeInstanceOf(StorageTransactionError);
    expect(caught).toMatchObject({ code: "STORAGE_TRANSACTION_BUSY", outcome: "ROLLED_BACK", retryable: true });
    expect(snapshot(active)).toBe(before);
  });

  it("end to end: an unclassified rollback propagates unchanged; a typed one is unwrapped with its cause", () => {
    const plainCase = recoverable();
    const before = snapshot(plainCase);
    let plain: unknown;
    try {
      recoverTrustRoot({
        directory: plainCase.directory, filename: plainCase.filename, now: () => LATER,
        secretBytes: () => new Uint8Array(32).fill(0x42),
        beforeCommit: () => { throw new Error("injected"); },
      });
    } catch (error) {
      plain = error;
    }
    expect(plain).toBeInstanceOf(StorageTransactionError);
    expect(plain).toMatchObject({ code: "STORAGE_TRANSACTION_FAILED", outcome: "ROLLED_BACK", retryable: false });
    expect(snapshot(plainCase)).toBe(before);

    const typedCase = recoverable();
    const typedBefore = snapshot(typedCase);
    let typed: unknown;
    try {
      recoverTrustRoot({
        directory: typedCase.directory, filename: typedCase.filename, now: () => LATER,
        secretBytes: () => new Uint8Array(32).fill(0x43),
        beforeCommit: () => { throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "injected lifecycle refusal"); },
      });
    } catch (error) {
      typed = error;
    }
    expect(typed).toBeInstanceOf(StoreLifecycleError);
    expect(typed).toMatchObject({ code: "STORAGE_INCOMPATIBLE" });
    expect((typed as Error).cause).toMatchObject({ code: "STORAGE_TRANSACTION_FAILED", outcome: "ROLLED_BACK", retryable: false });
    expect(snapshot(typedCase)).toBe(typedBefore);
  });
});

describe("P1B pin D: sponsored replay negative authorization matrix", () => {
  it("refuses every non-current sponsor credential on replay with zero writes", () => {
    const active = fixture();
    const sponsor = participant(active, "endpoint-sponsor").participant.participantId;
    const other = participant(active, "endpoint-other").participant.participantId;
    const create = capabilityFor(active, sponsor, "create", { expiresAt: "2026-10-10T02:00:00.000Z" });
    const revoked = capabilityFor(active, sponsor, "create");
    const request = (capability: unknown, sponsorId = sponsor) => ({
      endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
      idempotencyKey: "sponsored",
      sponsor: { participantId: sponsorId, capability },
    });
    expect(createParticipant(active.store, request(create), { now: () => NOW }).disposition).toBe("CREATED");
    revokeCapability(active.store, { participantId: sponsor, scope: "create", capability: revoked }, { now: () => NOW });

    const matrix: [string, unknown, string, string][] = [
      ["forged", FORGED, sponsor, LATER],
      ["revoked", revoked, sponsor, LATER],
      ["expired", create, sponsor, "2026-10-10T02:00:00.000Z"],
      ["wrong scope: bind", capabilityFor(active, sponsor, "bind"), sponsor, LATER],
      ["wrong scope: join", capabilityFor(active, sponsor, "join"), sponsor, LATER],
      ["wrong scope: attach", capabilityFor(active, sponsor, "attach"), sponsor, LATER],
      ["wrong Participant's token", capabilityFor(active, other, "create"), sponsor, LATER],
      ["token presented for another sponsor", create, other, LATER],
      ["Session ID", SESSION, sponsor, LATER],
      ["Participant ID", sponsor, sponsor, LATER],
      ["missing", undefined, sponsor, LATER],
    ];
    const before = snapshot(active);
    for (const [label, capability, sponsorId, now] of matrix) {
      const error = expectRefusal(() => createParticipant(active.store, request(capability, sponsorId), { now: () => now }), "CAPABILITY_REJECTED");
      expect(disclosure(error), label).not.toContain("endpoint-sponsored");
      expect(snapshot(active), `${label} wrote durable state`).toBe(before);
    }
    // The authorized replay still works and is zero-write.
    expect(createParticipant(active.store, request(create), { now: () => LATER }).disposition).toBe("REPLAYED");
    expect(snapshot(active)).toBe(before);
  });

  it("refuses a superseded-generation sponsor capability after operator recovery", () => {
    const active = fixture();
    const sponsor = participant(active, "endpoint-sponsor").participant.participantId;
    const create = capabilityFor(active, sponsor, "create");
    const request = {
      endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
      idempotencyKey: "sponsored",
      sponsor: { participantId: sponsor, capability: create },
    };
    createParticipant(active.store, request, { now: () => NOW });
    active.store.close();
    rmSync(hostSecretPath(active.databasePath));
    const recovered = recoverTrustRoot({ directory: active.directory, filename: active.filename, now: () => LATER, secretBytes: () => new Uint8Array(32).fill(0x44) });
    try {
      expectRefusal(() => createParticipant(recovered, request, { now: () => LATER }), "CAPABILITY_REJECTED");
    } finally {
      recovered.close();
    }
  });
});
