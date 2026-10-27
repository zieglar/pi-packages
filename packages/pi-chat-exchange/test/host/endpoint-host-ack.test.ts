/**
 * HANDOFF-CE-E2B-01 — shared host ACK surface (clause 2) over a REAL durable
 * Store, reusing the committed E2-A `recordDeliveryAck` persistence untouched.
 *
 * What these tests pin down:
 * - the operator opt-in gates ACK before registration state (fixed
 *   `CE_HOST_ACK_DISABLED`), exactly like the payload-read precedent;
 * - a legal ACK returns CREATED evidence and an equivalent repeat returns
 *   REPLAYED with identical receipt identity (no second receipt, no new state);
 * - authority is evaluated BEFORE any receipt/message idempotency lookup;
 * - the closed four-field input refuses anything else as
 *   `CE_HOST_INVALID_REQUEST` without reaching Storage;
 * - the response projection is the frozen public Receipt only: no ack Session,
 *   fencing token, trust generation, capability, payload text, SQL, or cause;
 * - ACK changes no Message delivery state and touches no cursor/task state;
 * - a validated `resume` re-issues the memory-only ack capability only when the
 *   opt-in is enabled.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CeEndpointHost, CeHostRefusal, type CeEndpointHostPolicy } from "../../src/host/endpoint-host.js";
import { RECEIPT_ID_PATTERN } from "../../src/protocol/identity.js";
import { cleanupFixtures, fixture, privileged, reader, rowCounts, type Fixture } from "../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);

const NOW = "2026-10-10T00:00:00.000Z";
const SENDER = "chatgpt/a";
const RECIPIENT = "chatgpt/b";

interface Rig {
  readonly fx: Fixture;
  readonly host: CeEndpointHost;
  readonly freshHost: (overrides?: Partial<CeEndpointHostPolicy>) => CeEndpointHost;
  readonly clock: { value: string };
}

function rig(overrides: Partial<CeEndpointHostPolicy> = {}): Rig {
  const fx = fixture("ce-host-ack-");
  const clock = { value: NOW };
  const base: CeEndpointHostPolicy = {
    adapter: "chatgpt",
    exchangeNamespace: "ce-mcp",
    exchangeIdempotencyKey: "exchange-1",
    allowlist: [{ endpointId: SENDER }, { endpointId: RECIPIENT }],
    leaseTtlSeconds: 600,
    payloadRead: { enabled: true },
    ack: { enabled: true },
    now: () => clock.value,
    ...overrides,
  };
  return {
    fx,
    clock,
    host: new CeEndpointHost(fx.store, base),
    freshHost: (next = {}) => new CeEndpointHost(fx.store, { ...base, ...next }),
  };
}

interface Delivered {
  readonly messageId: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;
  readonly messageCreatedAuditSequence: number;
}

/** Send one message and copy the metadata an authorized read exposes. */
function delivered(host: CeEndpointHost, key = "ack-1"): Delivered {
  const sent = host.send(SENDER, { to: RECIPIENT, text: "ack me", idempotencyKey: key });
  const read = host.readMetadata(RECIPIENT, { messageId: sent.messageId });
  return {
    messageId: read.messageId,
    payloadDigest: read.payloadDigest,
    payloadLength: read.payloadLength,
    messageCreatedAuditSequence: read.auditSequence,
  };
}

function started(overrides: Partial<CeEndpointHostPolicy> = {}): Rig & { readonly input: Delivered } {
  const active = rig(overrides);
  active.host.beginSession(SENDER);
  active.host.beginSession(RECIPIENT);
  return { ...active, input: delivered(active.host) };
}

function expectRefusal(run: () => unknown, code: string): CeHostRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CeHostRefusal);
    expect(error).toMatchObject({ code });
    return error as CeHostRefusal;
  }
  throw new Error(`expected CeHostRefusal ${code}`);
}

/** Record every SQL text the host causes while `run` executes. */
function tracedSql(fx: Fixture, run: () => void): string[] {
  const database = fx.store.database;
  const original = database.prepare;
  const sql: string[] = [];
  database.prepare = ((text: string) => {
    sql.push(text);
    return original.call(database, text);
  }) as typeof database.prepare;
  try {
    run();
  } finally {
    database.prepare = original;
  }
  return sql;
}

/** Inspect durable capability records, not just the ACK policy gate. */
function ackCapabilities(fx: Fixture) {
  const view = reader(fx);
  try {
    return view.prepare("SELECT * FROM participant_capability WHERE scope = 'ack' ORDER BY capability_digest").all();
  } finally {
    view.close();
  }
}

const PROTECTED_LOOKUP = /FROM (?:message|delivery_ack_receipt|audit_event)\b/;

describe("shared host ACK: operator opt-in gate", () => {
  it.each(["payloadRead", "ack"] as const)("fails closed when the %s policy getter throws", (section) => {
    const fx = fixture("ce-host-policy-getter-");
    const policy: CeEndpointHostPolicy = {
      adapter: "chatgpt", exchangeNamespace: "ce-mcp", exchangeIdempotencyKey: "exchange-1",
      allowlist: [{ endpointId: RECIPIENT }],
    };
    Object.defineProperty(policy, section, { enumerable: true, get: () => { throw new Error("PRIVATE_POLICY_GETTER"); } });
    const host = new CeEndpointHost(fx.store, policy);
    expectRefusal(
      () => section === "ack" ? host.acknowledge(RECIPIENT, {}) : host.readPayload(RECIPIENT, {}),
      section === "ack" ? "CE_HOST_ACK_DISABLED" : "CE_HOST_PAYLOAD_DISABLED",
    );
  });

  it("issues no ack capability during disabled provisioning", () => {
    const { host, fx } = rig({ ack: { enabled: false } });
    expect(ackCapabilities(fx)).toEqual([]);
    host.beginSession(SENDER);
    expect(ackCapabilities(fx)).toEqual([]);
    host.beginSession(RECIPIENT);
    expect(ackCapabilities(fx)).toEqual([]);
    expect(host.status(RECIPIENT).registered).toBe(true);
  });

  it("refuses with CE_HOST_ACK_DISABLED before registration state when the opt-in is absent", () => {
    const { host, fx, input } = started({ ack: { enabled: false } });
    const before = rowCounts(fx);
    // Registered recipient: still disabled.
    expectRefusal(() => host.acknowledge(RECIPIENT, input), "CE_HOST_ACK_DISABLED");
    // Unregistered endpoint: the SAME fixed refusal, so a disabled deployment
    // answers identically regardless of registration state.
    expectRefusal(() => host.acknowledge(SENDER, input), "CE_HOST_ACK_DISABLED");
    const disabledHost = rig({ ack: { enabled: false } }).host;
    expectRefusal(() => disabledHost.acknowledge(RECIPIENT, input), "CE_HOST_ACK_DISABLED");
    expect(rowCounts(fx)).toEqual(before);
  });

  it("treats a malformed or truthy-but-not-true opt-in as disabled (fail closed)", () => {
    for (const setting of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }] as unknown[]) {
      const { host, input } = started({ ack: setting as NonNullable<CeEndpointHostPolicy["ack"]> });
      expectRefusal(() => host.acknowledge(RECIPIENT, input), "CE_HOST_ACK_DISABLED");
    }
  });

  it("refuses an unregistered endpoint as CE_HOST_NOT_REGISTERED when ACK is enabled", () => {
    const { host } = rig();
    // With the opt-in enabled the registration gate decides, whatever the
    // request shape is: no ACK is possible without a provisioned session.
    expectRefusal(() => host.acknowledge(RECIPIENT, {}), "CE_HOST_NOT_REGISTERED");
  });
});

describe("shared host ACK: durable evidence", () => {
  it("records a first ACK as CREATED with the frozen public receipt projection", () => {
    const { host, input } = started();
    const result = host.acknowledge(RECIPIENT, input);

    expect(result.disposition).toBe("CREATED");
    expect(Object.keys(result)).toEqual(["disposition", "receipt", "receiptAuditSequence"]);
    expect(Object.keys(result.receipt)).toEqual([
      "receiptId",
      "exchangeId",
      "messageId",
      "endpoint",
      "kind",
      "createdAt",
    ]);
    expect(result.receipt.receiptId).toMatch(RECEIPT_ID_PATTERN);
    expect(result.receipt.messageId).toBe(input.messageId);
    expect(result.receipt.kind).toBe("delivery_ack");
    expect(result.receipt.endpoint).toEqual({ adapter: "chatgpt", endpointId: RECIPIENT });
    expect(result.receipt.createdAt).toBe(NOW);
    // The receipt audit is distinct from (and later than) message creation.
    expect(result.receiptAuditSequence).toBeGreaterThan(input.messageCreatedAuditSequence);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.endpoint)).toBe(true);
  });

  it("never exposes ack session, fencing, trust generation, capability, or payload text", () => {
    const { host, input } = started();
    const serialized = JSON.stringify(host.acknowledge(RECIPIENT, input));
    for (const forbidden of ["ses_", "cap_", "fencing", "trust", "ack me", "SELECT", "sqlite", "/Users/"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("replays an equivalent ACK as REPLAYED with identical receipt identity and zero new writes", () => {
    const { host, fx, input } = started();
    const first = host.acknowledge(RECIPIENT, input);
    const after = rowCounts(fx);

    const replay = host.acknowledge(RECIPIENT, input);
    expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.receiptAuditSequence).toBe(first.receiptAuditSequence);
    expect(rowCounts(fx)).toEqual(after);
  });

  it("refuses a metadata mismatch with zero writes and a fixed sanitized reason", () => {
    const { host, fx, input } = started();
    const before = rowCounts(fx);
    const refusal = expectRefusal(
      () => host.acknowledge(RECIPIENT, { ...input, payloadDigest: "a".repeat(64) }),
      "CE_HOST_UNAVAILABLE",
    );
    expect(refusal.reason).toBe("MESSAGE_READ_REJECTED");
    expect(refusal.message).not.toContain("SELECT");
    expect(refusal.message).not.toContain("cap_");
    expect(refusal.message).not.toContain("/Users/");
    expect(refusal.message).not.toContain("ack me");
    expect((refusal as Error & { cause?: unknown }).cause).toBeUndefined();
    expectRefusal(
      () => host.acknowledge(RECIPIENT, { ...input, payloadLength: input.payloadLength + 1 }),
      "CE_HOST_UNAVAILABLE",
    );
    expectRefusal(
      () => host.acknowledge(RECIPIENT, { ...input, messageCreatedAuditSequence: input.messageCreatedAuditSequence + 1 }),
      "CE_HOST_UNAVAILABLE",
    );
    expect(rowCounts(fx)).toEqual(before);
  });

  it("refuses an ACK from a participant that is not the stable recipient", () => {
    const { host, fx, input } = started();
    const before = rowCounts(fx);
    // The sender holds its own authority but is not the Message recipient.
    const refusal = expectRefusal(() => host.acknowledge(SENDER, input), "CE_HOST_UNAVAILABLE");
    expect(refusal.reason).toBe("MESSAGE_READ_REJECTED");
    expect(rowCounts(fx)).toEqual(before);
  });
});

describe("shared host ACK: transaction refusal policy", () => {
  it.each(["begin", "commit"] as const)("preserves %s BUSY rollback evidence without authorizing retry", (stage) => {
    const { host, fx, input } = started();
    const before = rowCounts(fx);
    const database = fx.store.database;
    const exec = database.exec;
    const blocker = stage === "begin" ? privileged(fx) : undefined;
    let commits = 0;
    if (blocker) blocker.exec("BEGIN IMMEDIATE");
    if (stage === "commit") {
      database.exec = ((sql: string) => {
        if (sql === "COMMIT") {
          commits++;
          throw Object.assign(new Error("PRIVATE_ACK_BUSY_SENTINEL"), { errcode: 5 });
        }
        exec.call(database, sql);
      }) as typeof exec;
    }
    let refusal: CeHostRefusal;
    try {
      refusal = expectRefusal(() => host.acknowledge(RECIPIENT, input), "CE_HOST_BUSY");
    } finally {
      database.exec = exec;
      if (blocker) {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
    }
    expect(commits).toBe(stage === "commit" ? 1 : 0);
    expect(rowCounts(fx)).toEqual(before);
    const view = reader(fx);
    try {
      expect(view.prepare("SELECT * FROM delivery_ack_receipt").all()).toEqual([]);
    } finally {
      view.close();
    }
    expect(refusal).toMatchObject({
      reason: "STORAGE_TRANSACTION_BUSY",
      outcome: "ROLLED_BACK",
      retryable: false,
    });
    expect(refusal.message).toContain("rolled back");
    expect(refusal.message).toContain("does not authorize retry");
    expect(refusal.message).toContain("explicit operator or upper-layer approval");
    expect(refusal.message).not.toMatch(/safe to retry|may be retried|PRIVATE_ACK_BUSY_SENTINEL/);
    expect((refusal as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("withholds success and retry permission when the ACK COMMIT outcome is uncertain", () => {
    const { host, fx, input } = started();
    const database = fx.store.database;
    const exec = database.exec;
    let commits = 0;
    database.exec = ((sql: string) => {
      exec.call(database, sql);
      if (sql === "COMMIT") {
        commits++;
        throw new Error("PRIVATE_ACK_UNCERTAIN_SENTINEL");
      }
    }) as typeof exec;
    let refusal: CeHostRefusal;
    try {
      refusal = expectRefusal(() => host.acknowledge(RECIPIENT, input), "CE_HOST_UNCERTAIN");
    } finally {
      database.exec = exec;
    }
    expect(commits).toBe(1);
    expect(refusal).toMatchObject({ reason: "STORAGE_TRANSACTION_FAILED", retryable: false });
    expect(refusal.message).toContain("outcome is unknown");
    expect(refusal.message).not.toContain("PRIVATE_ACK_UNCERTAIN_SENTINEL");
    expect((refusal as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("shared host ACK: authority before idempotency", () => {
  it("refuses an expired lease before any receipt or message lookup, even with a committed receipt", () => {
    const { host, fx, clock, input } = started();
    const created = host.acknowledge(RECIPIENT, input);
    expect(created.disposition).toBe("CREATED");
    const before = rowCounts(fx);

    // The lease (600s) is long gone; authority must be decided first.
    clock.value = "2026-10-10T02:00:00.000Z";
    let refusal: CeHostRefusal | undefined;
    const sql = tracedSql(fx, () => {
      refusal = expectRefusal(() => host.acknowledge(RECIPIENT, input), "CE_HOST_AUTHORITY_ABSENT");
    });
    // The host's existing lease-status reason vocabulary, unchanged by ACK.
    expect(refusal?.reason).toBe("EXPIRED");
    expect(sql.filter((text) => PROTECTED_LOOKUP.test(text))).toEqual([]);
    expect(rowCounts(fx)).toEqual(before);
  });
});

describe("shared host ACK: closed input validation", () => {
  const cases: [string, unknown][] = [
    ["unknown field", { extra: true }],
    ["authority-bearing capability", { capability: "cap_0123456789abcdef" }],
    ["authority-bearing sessionId", { sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["authority-bearing participantId", { participantId: "par_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["authority-bearing fencingToken", { fencingToken: 1 }],
    ["authority-bearing exchangeId", { exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["uppercase digest", { payloadDigest: "A".repeat(64) }],
    ["short digest", { payloadDigest: "a".repeat(63) }],
    ["non-hex digest", { payloadDigest: "z".repeat(64) }],
    ["numeric digest", { payloadDigest: 1 }],
    ["negative length", { payloadLength: -1 }],
    ["fractional length", { payloadLength: 1.5 }],
    ["string length", { payloadLength: "4" }],
    ["zero sequence", { messageCreatedAuditSequence: 0 }],
    ["negative sequence", { messageCreatedAuditSequence: -3 }],
    ["fractional sequence", { messageCreatedAuditSequence: 2.5 }],
    ["unsafe sequence", { messageCreatedAuditSequence: Number.MAX_SAFE_INTEGER + 2 }],
    ["malformed messageId", { messageId: "not-a-message-id" }],
    ["numeric messageId", { messageId: 7 }],
  ];

  for (const [label, mutation] of cases) {
    it(`refuses ${label} as CE_HOST_INVALID_REQUEST without reaching storage`, () => {
      const { host, fx, input } = started();
      const before = rowCounts(fx);
      const sql = tracedSql(fx, () => {
        expectRefusal(() => host.acknowledge(RECIPIENT, { ...input, ...(mutation as object) }), "CE_HOST_INVALID_REQUEST");
      });
      expect(sql.filter((text) => PROTECTED_LOOKUP.test(text))).toEqual([]);
      expect(rowCounts(fx)).toEqual(before);
    });
  }

  it("refuses a missing field, a non-object request, and a prototype-polluted request", () => {
    const { host, input } = started();
    const { messageId, payloadDigest, payloadLength, messageCreatedAuditSequence } = input;
    expectRefusal(() => host.acknowledge(RECIPIENT, { payloadDigest, payloadLength, messageCreatedAuditSequence }), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, { messageId, payloadLength, messageCreatedAuditSequence }), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, { messageId, payloadDigest, messageCreatedAuditSequence }), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, { messageId, payloadDigest, payloadLength }), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, undefined), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, "msg"), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, [input]), "CE_HOST_INVALID_REQUEST");
    expectRefusal(() => host.acknowledge(RECIPIENT, Object.create({ ...input })), "CE_HOST_INVALID_REQUEST");
  });
});

describe("shared host ACK: isolation from delivery, cursor, and task state", () => {
  it("leaves Message delivery state, cursor state, and inbox visibility unchanged", () => {
    const { host, fx, input } = started();
    const before = host.readMetadata(RECIPIENT, { messageId: input.messageId });
    const inboxBefore = host.listInbox(RECIPIENT, {}).messages.map((message) => message.messageId);
    const countsBefore = rowCounts(fx);

    const result = host.acknowledge(RECIPIENT, input);
    expect(result.disposition).toBe("CREATED");

    const after = host.readMetadata(RECIPIENT, { messageId: input.messageId });
    expect(after).toEqual(before);
    expect(after.state).toBe(before.state);
    const countsAfter = rowCounts(fx);
    // Only the receipt audit is added: no cursor, message, ownership, or
    // membership change, and the Message stays visible in the inbox.
    expect(countsAfter.cursor).toBe(countsBefore.cursor);
    expect(countsAfter.messages).toBe(countsBefore.messages);
    expect(countsAfter.ownership).toBe(countsBefore.ownership);
    expect(countsAfter.membership).toBe(countsBefore.membership);
    expect(Number(countsAfter.audits)).toBe(Number(countsBefore.audits) + 1);
    expect(host.listInbox(RECIPIENT, {}).messages.map((message) => message.messageId)).toEqual(inboxBefore);
  });
});

describe("shared host ACK: resume", () => {
  it("re-issues memory-only ack authority on a validated resume when enabled", () => {
    const { host, freshHost, input } = started();
    const mapping = host.status(RECIPIENT);
    const resumed = freshHost();
    resumed.resume(RECIPIENT, {
      participantId: mapping.participantId,
      sessionId: mapping.sessionId,
      exchangeId: mapping.exchangeId,
    });
    const result = resumed.acknowledge(RECIPIENT, input);
    expect(result.disposition).toBe("CREATED");
    // The original host replays the same receipt: one natural key, one receipt.
    expect(host.acknowledge(RECIPIENT, input)).toEqual({ ...result, disposition: "REPLAYED" });
  });

  it("issues no ack capability on resume when the opt-in is disabled", () => {
    const { host, fx, freshHost, input } = started();
    const mapping = host.status(RECIPIENT);
    const before = ackCapabilities(fx);
    expect(before).toHaveLength(2);
    expect(before).toContainEqual(expect.objectContaining({
      participant_id: mapping.participantId,
      session_id: mapping.sessionId,
      scope: "ack",
    }));
    const resumed = freshHost({ ack: { enabled: false } });
    resumed.resume(RECIPIENT, {
      participantId: mapping.participantId,
      sessionId: mapping.sessionId,
      exchangeId: mapping.exchangeId,
    });
    expectRefusal(() => resumed.acknowledge(RECIPIENT, input), "CE_HOST_ACK_DISABLED");
    expect(ackCapabilities(fx)).toEqual(before);
  });
});
