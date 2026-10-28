/**
 * CE-0002 B3-P3B — focused tests for the Pi-type-free host adapter.
 *
 * All tests run against a real file-backed store with the shared B3-P1B
 * fixture (deterministic host secret, deterministic clock seam). Nothing is
 * mocked: every assertion exercises the real P3A authority chain through the
 * adapter's public surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CeHostRefusal,
  CeSessionHost,
  type CeHostPolicy,
} from "../../../src/endpoints/pi/session-host.js";
import { PI_ADAPTER_KIND } from "../../../src/endpoints/pi/contract.js";
import * as ownership from "../../../src/storage/ownership.js";
import { issueCapability } from "../../../src/storage/participant.js";
import type { DurableStore } from "../../../src/storage/store.js";
import {
  cleanupFixtures,
  fixture,
  privileged,
  rowCounts,
  type Fixture,
} from "../../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);
afterEach(() => vi.restoreAllMocks());

const START = "2026-10-10T00:00:00.000Z";
const AFTER_LEASE = "2026-10-10T01:00:00.000Z";
const MISSING_MESSAGE_ID = "msg_7N4S9C2V1K0B3M5P8Q2R6T0J4W";

interface Rig {
  readonly fx: Fixture;
  readonly host: CeSessionHost;
}

function rig(label: string, now: () => string = () => START, leaseTtlSeconds = 600): Rig {
  const fx = fixture(label);
  const policy: CeHostPolicy = {
    adapter: PI_ADAPTER_KIND,
    exchangeNamespace: "pi-host",
    exchangeIdempotencyKey: "pi-host-exchange",
    allowlist: [
      { piSessionId: "ceA", endpointId: "local/sessionA" },
      { piSessionId: "ceB", endpointId: "local/sessionB" },
    ],
    leaseTtlSeconds,
    now,
  };
  return { fx, host: new CeSessionHost(fx.store, policy) };
}

function expectHostRefusal(run: () => unknown, code: string): CeHostRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CeHostRefusal);
    expect(error).toMatchObject({ code });
    return error as CeHostRefusal;
  }
  throw new Error(`expected CeHostRefusal ${code}`);
}


function expectPolicyRefusal(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CeHostRefusal);
    expect(error).toMatchObject({ code: "CE_HOST_INVALID_REQUEST" });
    return;
  }
  throw new Error("expected policy CeHostRefusal CE_HOST_INVALID_REQUEST");
}
describe("host adapter policy gate", () => {
  it("refuses an endpoint that is not in the allowlist", () => {
    const { host } = rig("ce-p3b-policy-");
    expectHostRefusal(() => host.beginSession("local/rogue"), "CE_HOST_ENDPOINT_NOT_ALLOWED");
    expectHostRefusal(() => host.resume("local/rogue", {}), "CE_HOST_ENDPOINT_NOT_ALLOWED");
  });

  it("rejects a policy with duplicate endpoints or wrong adapter", () => {
    const fx = fixture("ce-p3b-policy-dup-");
    expectPolicyRefusal(() =>
      new CeSessionHost(fx.store, {
        adapter: PI_ADAPTER_KIND,
        exchangeNamespace: "n",
        exchangeIdempotencyKey: "k",
        allowlist: [
          { piSessionId: "a", endpointId: "same" },
          { piSessionId: "b", endpointId: "same" },
        ],
      }),
    );
    expectPolicyRefusal(() =>
      new CeSessionHost(fx.store, {
        adapter: "mcp" as never,
        exchangeNamespace: "n",
        exchangeIdempotencyKey: "k",
        allowlist: [{ piSessionId: "a", endpointId: "ok" }],
      }),
    );
    expectPolicyRefusal(() =>
      new CeSessionHost(fx.store, {
        adapter: PI_ADAPTER_KIND,
        exchangeNamespace: "n",
        exchangeIdempotencyKey: "k",
        allowlist: [],
      }),
    );
  });

  it("sends and reads before provisioning refuse as not registered", () => {
    const { host } = rig("ce-p3b-policy-noreg-");
    expectHostRefusal(
      () => host.send("local/sessionA", { to: "local/sessionB", text: "hi", idempotencyKey: "k" }),
      "CE_HOST_NOT_REGISTERED",
    );
    expectHostRefusal(() => host.readMetadata("local/sessionA", { messageId: "msg_invalid" }), "CE_HOST_NOT_REGISTERED");
  });
});

describe("host adapter provisioning and send/read", () => {
  it("provisions two endpoints and completes an authorized send/read round trip", () => {
    const { fx, host } = rig("ce-p3b-flow-");
    const a = host.beginSession("local/sessionA");
    const b = host.beginSession("local/sessionB");

    expect(a.participantId).not.toBe(b.participantId);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId.startsWith("ses_")).toBe(true);
    expect(a.exchangeId).toBe(b.exchangeId);

    const sent = host.send("local/sessionA", {
      to: "local/sessionB",
      text: "hello B",
      idempotencyKey: "msg-1",
    });
    expect(sent.disposition).toBe("CREATED");
    expect(sent.recipient).toBe("local/sessionB");

    const read = host.readMetadata("local/sessionB", { messageId: sent.messageId });
    expect(read.from).toBe("local/sessionA");
    expect(read.to).toBe("local/sessionB");
    expect(read.payloadLength).toBe(7);
    expect(read.auditSequence).toBe(sent.auditSequence);

    // Cursor never moves; exactly one durable message; one audit.
    const counts = rowCounts(fx);
    expect(counts.messages).toBe("1");
    expect(counts.cursor).toBe("0");
  });

  it("replays a duplicate send as REPLAYED without a second durable message", () => {
    const { fx, host } = rig("ce-p3b-replay-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    const first = host.send("local/sessionA", { to: "local/sessionB", text: "again", idempotencyKey: "dup-1" });
    const second = host.send("local/sessionA", { to: "local/sessionB", text: "again", idempotencyKey: "dup-1" });
    expect(first.disposition).toBe("CREATED");
    expect(second.disposition).toBe("REPLAYED");
    expect(second.messageId).toBe(first.messageId);
    expect(rowCounts(fx).messages).toBe("1");
    expect(rowCounts(fx).cursor).toBe("0");
  });

  it("refuses sends to unknown or self recipients", () => {
    const { host } = rig("ce-p3b-recipient-");
    host.beginSession("local/sessionA");
    expectHostRefusal(
      () => host.send("local/sessionA", { to: "local/nobody", text: "x", idempotencyKey: "k" }),
      "CE_HOST_ENDPOINT_NOT_ALLOWED",
    );
    expectHostRefusal(
      () => host.send("local/sessionA", { to: "local/sessionA", text: "x", idempotencyKey: "k" }),
      "CE_HOST_INVALID_REQUEST",
    );
  });

  it("wrong-recipient and missing reads share one opaque refusal", () => {
    const { host } = rig("ce-p3b-isolation-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "secret-ish", idempotencyKey: "iso-1" });

    // The sender reading a message addressed to the recipient is refused with
    // the same opaque code as a missing message: no existence oracle.
    const wrongRecipient = expectHostRefusal(
      () => host.readMetadata("local/sessionA", { messageId: sent.messageId }),
      "CE_HOST_UNAVAILABLE",
    );
    expect(wrongRecipient.reason).toBe("MESSAGE_READ_REJECTED");

    const missing = expectHostRefusal(
      () => host.readMetadata("local/sessionB", { messageId: MISSING_MESSAGE_ID }),
      "CE_HOST_UNAVAILABLE",
    );
    expect(missing.reason).toBe("MESSAGE_READ_REJECTED");
  });
  it("surfaces expired ownership as authority-absent and recovers nothing implicitly", () => {
    let now = START;
    const { host } = rig("ce-p3b-expiry-", () => now, 30);
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    now = AFTER_LEASE;
    const refusal = expectHostRefusal(
      () => host.send("local/sessionA", { to: "local/sessionB", text: "late", idempotencyKey: "late-1" }),
      "CE_HOST_AUTHORITY_ABSENT",
    );
    expect(refusal.retryable).toBe(false);
    expect(host.status("local/sessionA").lease).toBe("EXPIRED");
  });
});

describe("host adapter restart and mapping validation", () => {
  it("resume re-establishes authority from identifiers and replays the send idempotently", () => {
    const { fx, host } = rig("ce-p3b-resume-");
    const mapping = host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "before restart", idempotencyKey: "r-1" });
    host.drop("local/sessionA");

    // A fresh adapter instance models the restarted process.
    const policy: CeHostPolicy = {
      adapter: PI_ADAPTER_KIND,
      exchangeNamespace: "pi-host",
      exchangeIdempotencyKey: "pi-host-exchange",
      allowlist: [
        { piSessionId: "ceA", endpointId: "local/sessionA" },
        { piSessionId: "ceB", endpointId: "local/sessionB" },
      ],
      leaseTtlSeconds: 600,
      now: () => START,
    };
    const revived = new CeSessionHost(fx.store, policy);
    const recovered = revived.resume("local/sessionA", mapping);
    expect(recovered).toEqual(mapping);
    const replayed = revived.send("local/sessionA", { to: "local/sessionB", text: "before restart", idempotencyKey: "r-1" });
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.messageId).toBe(sent.messageId);
    expect(rowCounts(fx).messages).toBe("1");
  });

  it("resume refuses foreign, malformed, or detached mappings", () => {
    const { fx, host } = rig("ce-p3b-mapneg-");
    const a = host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");

    // Foreign: B's identifiers presented under A's endpoint label.
    expectHostRefusal(
      () => host.resume("local/sessionA", {
        endpointId: "local/sessionA",
        participantId: host.status("local/sessionB").participantId,
        sessionId: host.status("local/sessionB").sessionId,
        exchangeId: a.exchangeId,
      }),
      "CE_HOST_MAPPING_INVALID",
    );

    // Malformed: garbage shape and wrong exchange.
    expectHostRefusal(() => host.resume("local/sessionA", { participantId: 42 }), "CE_HOST_MAPPING_INVALID");
    expectHostRefusal(
      () => host.resume("local/sessionA", { ...a, exchangeId: "ho_7N4S9C2V1K0B3M5P8Q2R6T0J" }),
      "CE_HOST_MAPPING_INVALID",
    );

    // Detached: tamper the binding to terminal DETACHED through the privileged
    // fixture connection (and remove the referencing ownership rows so the
    // lifecycle read reports the state instead of refusing corruption), then
    // prove recovery refuses instead of repairing or re-binding.
    const admin = privileged(fx);
    admin.prepare("DELETE FROM participant_ownership WHERE participant_id = ?").run(a.participantId);
    admin.prepare("DELETE FROM participant_fencing_high_water WHERE participant_id = ?").run(a.participantId);
    admin
      .prepare(
        "UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE participant_id = ? AND session_id = ?",
      )
      .run(START, a.participantId, a.sessionId);
    admin.close();
    expectHostRefusal(() => host.resume("local/sessionA", a), "CE_HOST_MAPPING_INVALID");
  });

  it("resume refuses when the lease lapsed during downtime", () => {
    let now = START;
    const { host } = rig("ce-p3b-down-", () => now, 30);
    const mapping = host.beginSession("local/sessionA");
    host.drop("local/sessionA");
    now = AFTER_LEASE;
    const refusal = expectHostRefusal(() => host.resume("local/sessionA", mapping), "CE_HOST_AUTHORITY_ABSENT");
    expect(refusal.reason).toBe("EXPIRED");
  });
});

describe("host adapter transaction-outcome mapping", () => {
  /** Wraps the fixture store so the underlying connection fails on demand:
   * "busy" throws a SQLITE_BUSY-class error at BEGIN; "commit" fails COMMIT
   * and ROLLBACK, which the transaction helper must classify INDETERMINATE.
   * Real connection, real helper — only the fault is injected. */
  function rigWithFaultyStore(label: string): { fx: Fixture; host: CeSessionHost; setFault: (f: "none" | "busy" | "commit") => void } {
    const fx = fixture(label);
    let fault: "none" | "busy" | "commit" = "none";
    let commitFailed = false;
    const real = fx.store;
    const realDb = real.database;
    const flakyDb = new Proxy(realDb, {
      get(target, key) {
        if (key !== "exec") return Reflect.get(target, key);
        return (sql: string): void => {
        // The fencing read uses a deferred "BEGIN"; the write path uses
        // "BEGIN IMMEDIATE" (busy) and "COMMIT" (commit), so the fault only
        // fires on the authorized write transaction.
        if (fault === "busy" && sql.includes("BEGIN IMMEDIATE")) {
          const error = new Error("database is locked (injected)") as Error & { errcode: number };
          error.errcode = 5; // SQLITE_BUSY primary result code
          throw error;
        }
        if (fault === "commit" && sql.includes("COMMIT")) {
          commitFailed = true;
          throw new Error("disk failure (injected)");
        }
        if (fault === "commit" && commitFailed && sql.includes("ROLLBACK")) {
          throw new Error("disk failure during rollback (injected)");
        }
        realDb.exec(sql);
        };
      },
    });
    const flakyStore = new Proxy(real, {
      get(target, key) {
        return key === "database" ? flakyDb : Reflect.get(target, key);
      },
    }) as unknown as DurableStore;
    const host = new CeSessionHost(flakyStore, {
      adapter: PI_ADAPTER_KIND,
      exchangeNamespace: "pi-host",
      exchangeIdempotencyKey: "pi-host-exchange",
      allowlist: [
        { piSessionId: "ceA", endpointId: "local/sessionA" },
        { piSessionId: "ceB", endpointId: "local/sessionB" },
      ],
      leaseTtlSeconds: 600,
      now: () => START,
    });
    return { fx, host, setFault: (f) => (fault = f) };
  }

  it("maps a busy transaction outcome to a retryable CE_HOST_BUSY refusal", () => {
    const { host, setFault } = rigWithFaultyStore("ce-p3b-busy-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    setFault("busy");
    const refusal = expectHostRefusal(
      () => host.send("local/sessionA", { to: "local/sessionB", text: "x", idempotencyKey: "busy-1" }),
      "CE_HOST_BUSY",
    );
    expect(refusal.retryable).toBe(true);
    setFault("none");
    // The rolled-back request is safe to retry as a whole.
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "x", idempotencyKey: "busy-1" });
    expect(sent.disposition).toBe("CREATED");
  });

  it("maps an INDETERMINATE outcome to CE_HOST_UNCERTAIN and never retryable", () => {
    const { host, setFault } = rigWithFaultyStore("ce-p3b-indeterminate-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    setFault("commit");
    const refusal = expectHostRefusal(
      () => host.send("local/sessionA", { to: "local/sessionB", text: "y", idempotencyKey: "unc-1" }),
      "CE_HOST_UNCERTAIN",
    );
    expect(refusal.retryable).toBe(false);
  });
});

describe("host adapter secrecy and privacy", () => {
  it("never returns capability tokens through any public surface", () => {
    const { host } = rig("ce-p3b-secrecy-");
    const mapping = host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    host.send("local/sessionA", { to: "local/sessionB", text: "quiet", idempotencyKey: "s-1" });

    const publicValues: unknown[] = [
      mapping,
      host.status("local/sessionA"),
      host.send("local/sessionA", { to: "local/sessionB", text: "more", idempotencyKey: "s-2" }),
      host.readMetadata("local/sessionB", {
        messageId: host.send("local/sessionA", { to: "local/sessionB", text: "third", idempotencyKey: "s-3" }).messageId,
      }),
    ];
    const serialized = JSON.stringify(publicValues);
    expect(serialized).not.toMatch(/cap_[0-9a-f]{64}/);
    // Timestamps in message metadata are public frozen protocol fields; the
    // secret surface is what must stay clean.
    // Mapping payload carries identifiers only.
    expect(Object.keys(mapping as object).sort()).toEqual(["endpointId", "exchangeId", "participantId", "sessionId"]);
  });

  it("sanitized refusals carry no request data, causes, or durable secrets", () => {
    const { host } = rig("ce-p3b-sanitize-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    const attempts: Array<[string, () => unknown]> = [
      ["bad-shape", () => host.send("local/sessionA", { to: 7, text: "", idempotencyKey: "x".repeat(300) })],
      ["wrong-recipient", () =>
        host.readMetadata("local/sessionA", { messageId: "msg_7N4S9C2V1K0B3M5P8Q2R6T0J" })],
      ["unregistered", () => host.readMetadata("local/sessionC" as never, { messageId: "msg_7N4S9C2V1K0B3M5P8Q2R6T0J" })],
    ];
    for (const [label, run] of attempts) {
      try {
        run();
        throw new Error(`${label}: expected refusal`);
      } catch (error) {
        const refusal = error as CeHostRefusal & { cause?: unknown };
        expect(refusal).toBeInstanceOf(CeHostRefusal);
        expect(String(refusal.message)).not.toContain("cap_");
        expect(String(refusal.stack ?? "")).not.toMatch(/cap_[0-9a-f]{64}/);
        expect(refusal.cause).toBeUndefined();
      }
    }
  });

  it("never mutates the delivery cursor across any adapter operation", () => {
    const { fx, host } = rig("ce-p3b-cursor-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    host.send("local/sessionA", { to: "local/sessionB", text: "one", idempotencyKey: "c-1" });
    host.send("local/sessionA", { to: "local/sessionB", text: "one", idempotencyKey: "c-1" });
    host.readMetadata("local/sessionB", {
      messageId: host.send("local/sessionA", { to: "local/sessionB", text: "two", idempotencyKey: "c-2" }).messageId,
    });
    host.drop("local/sessionA");
    host.drop("local/sessionB");
    expect(rowCounts(fx).cursor).toBe("0");
  });
});

describe("explicit Inbox Session Host adapter", () => {
  it("discovers unknown IDs with minimum metadata and no consumption or cursor writes", () => {
    const { fx, host } = rig("ce-p3d-list-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "PRIVATE_BODY", idempotencyKey: "list-1" });
    const before = rowCounts(fx);
    const result = host.listInbox("local/sessionB", {});
    expect(result).toEqual({ messages: [{ messageId: sent.messageId, auditSequence: sent.auditSequence }], continuationAuditSequence: sent.auditSequence, scanBudgetExhausted: false });
    expect(host.listInbox("local/sessionB", {})).toEqual(result);
    expect(rowCounts(fx)).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|cap_|payload|digest|idempotency|sessionId|participantId/);
    expect(host.readMetadata("local/sessionB", { messageId: result.messages[0]!.messageId }).messageId).toBe(sent.messageId);
  });

  it("returns a successful empty list and filters other recipients", () => {
    const { host } = rig("ce-p3d-empty-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    host.send("local/sessionA", { to: "local/sessionB", text: "for B", idempotencyKey: "recipient-only" });
    expect(host.listInbox("local/sessionA", {}).messages).toEqual([]);
  });

  it("respects the membership boundary when B joins after a send", () => {
    const { host } = rig("ce-p3d-boundary-");
    host.beginSession("local/sessionA");
    host.send("local/sessionA", { to: "local/sessionB", text: "before join", idempotencyKey: "historical" });
    host.beginSession("local/sessionB");
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "after join", idempotencyKey: "current" });
    expect(host.listInbox("local/sessionB", {}).messages).toEqual([{ messageId: sent.messageId, auditSequence: sent.auditSequence }]);
  });

  it("preserves page and raw-scan continuation semantics without draining", () => {
    const { host } = rig("ce-p3d-pages-");
    host.beginSession("local/sessionA");
    host.beginSession("local/sessionB");
    const first = host.send("local/sessionA", { to: "local/sessionB", text: "one", idempotencyKey: "page-1" });
    const second = host.send("local/sessionA", { to: "local/sessionB", text: "two", idempotencyKey: "page-2" });
    const page = host.listInbox("local/sessionB", { pageSize: 1, rawScanLimit: 1 });
    expect(page).toEqual({ messages: [{ messageId: first.messageId, auditSequence: first.auditSequence }], continuationAuditSequence: first.auditSequence, scanBudgetExhausted: true });
    expect(host.listInbox("local/sessionB", { afterAuditSequence: page.continuationAuditSequence, pageSize: 1, rawScanLimit: 2 }).messages).toEqual([{ messageId: second.messageId, auditSequence: second.auditSequence }]);
    expect(host.listInbox("local/sessionB", { afterAuditSequence: second.auditSequence })).toEqual({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false });
    const filtered = host.listInbox("local/sessionA", { afterAuditSequence: first.auditSequence, pageSize: 1, rawScanLimit: 1 });
    expect(filtered).toEqual({ messages: [], continuationAuditSequence: second.auditSequence, scanBudgetExhausted: true });
  });

  it.each([
    { afterAuditSequence: -1 }, { afterAuditSequence: 0.5 }, { afterAuditSequence: Number.MAX_SAFE_INTEGER + 1 },
    { pageSize: 0 }, { pageSize: 51 }, { pageSize: 1.5 },
    { rawScanLimit: 0 }, { rawScanLimit: 2001 }, { rawScanLimit: 1.5 },
    { rawScanLimit: 1 }, { pageSize: 2, rawScanLimit: 1 },
    { endpoint: "local/sessionA" }, { participantId: "foreign" }, { exchangeId: "foreign" },
    { sessionId: "foreign" }, { fencingToken: 1 }, { capability: "cap_forged" },
  ])("rejects invalid or authority-bearing input %j", (input) => {
    const { host } = rig("ce-p3d-invalid-");
    host.beginSession("local/sessionB");
    expectHostRefusal(() => host.listInbox("local/sessionB", input), "CE_HOST_INVALID_REQUEST");
  });

  it("refuses missing startup and expired authority without recovering it", () => {
    let now = START;
    const { host } = rig("ce-p3d-expired-", () => now, 30);
    expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_NOT_REGISTERED");
    host.beginSession("local/sessionB");
    now = AFTER_LEASE;
    expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_AUTHORITY_ABSENT");
  });

  it("refuses revoked read capability without reissuing it", () => {
    const { fx, host } = rig("ce-p3d-revoke-");
    const b = host.beginSession("local/sessionB");
    const admin = privileged(fx);
    try {
      admin.prepare("UPDATE participant_capability SET revoked_at=? WHERE participant_id=? AND scope='read'").run(START, b.participantId);
    } finally { admin.close(); }
    const refusal = expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_UNAVAILABLE");
    expect(refusal.reason).toBe("CAPABILITY_REJECTED");
  });

  it("fails closed without a partial list for an orphan Audit after a valid message", () => {
    const { fx, host } = rig("ce-p3d-corrupt-");
    host.beginSession("local/sessionA");
    const b = host.beginSession("local/sessionB");
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "valid", idempotencyKey: "valid-before-orphan" });
    const admin = privileged(fx);
    try {
      admin.prepare("INSERT INTO audit_event(event_id,exchange_id,sequence,kind,subject_id,created_at,digest,length,outcome,private_revision) VALUES (?,?,?,'message_created',?,?,?,1,NULL,1)").run(
        "evt_01ARZ3NDEKTSV4RRFFQ69G5FZZ", b.exchangeId, sent.auditSequence + 1,
        "msg_01ARZ3NDEKTSV4RRFFQ69G5FZZ", START, "a".repeat(64),
      );
    } finally { admin.close(); }
    const refusal = expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_UNAVAILABLE");
    expect(refusal.reason).toBe("STORAGE_IDEMPOTENCY_CORRUPT");
    expect(refusal).not.toHaveProperty("messages");
  });

  it("resumes listing after restart from identifiers only", () => {
    const { fx, host } = rig("ce-p3d-resume-");
    host.beginSession("local/sessionA");
    const mapping = host.beginSession("local/sessionB");
    const sent = host.send("local/sessionA", { to: "local/sessionB", text: "restart", idempotencyKey: "restart-list" });
    host.drop("local/sessionB");
    const resumed = new CeSessionHost(fx.store, { adapter: PI_ADAPTER_KIND, exchangeNamespace: "pi-host", exchangeIdempotencyKey: "pi-host-exchange", allowlist: [{ piSessionId: "ceB", endpointId: "local/sessionB" }], leaseTtlSeconds: 600, now: () => START });
    resumed.resume("local/sessionB", mapping);
    expect(resumed.listInbox("local/sessionB", {}).messages).toEqual([{ messageId: sent.messageId, auditSequence: sent.auditSequence }]);
  });

  it.each(["busy", "indeterminate"] as const)("maps %s once without automatically retrying", (fault) => {
    const { fx, host } = rig("ce-p3d-transaction-");
    host.beginSession("local/sessionB");
    const original = fx.store.database.exec.bind(fx.store.database);
    let attempts = 0;
    fx.store.database.exec = (sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        attempts += 1;
        if (fault === "busy") throw Object.assign(new Error("PRIVATE_SQL"), { errcode: 5 });
      }
      const result = original(sql);
      if (fault === "indeterminate" && sql === "COMMIT") throw new Error("PRIVATE_COMMIT");
      return result;
    };
    const refusal = expectHostRefusal(() => host.listInbox("local/sessionB", {}), fault === "busy" ? "CE_HOST_BUSY" : "CE_HOST_UNCERTAIN");
    expect(refusal.retryable).toBe(fault === "busy");
    expect(attempts).toBe(1); // exactly one Inbox transaction; never retry an uncertain result
    expect(JSON.stringify(refusal)).not.toContain("PRIVATE_");
  });

  it("isolates a real foreign Exchange message even when addressed to B", () => {
    const { fx, host } = rig("ce-p3d-cross-exchange-");
    host.beginSession("local/sessionB");
    const otherHost = new CeSessionHost(fx.store, { adapter: PI_ADAPTER_KIND, exchangeNamespace: "other", exchangeIdempotencyKey: "other", allowlist: [{ piSessionId: "ceC", endpointId: "local/sessionC" }, { piSessionId: "ceB", endpointId: "local/sessionB" }], now: () => START });
    otherHost.beginSession("local/sessionC");
    const foreign = otherHost.send("local/sessionC", { to: "local/sessionB", text: "foreign", idempotencyKey: "foreign" });
    expect(host.listInbox("local/sessionB", {}).messages).toEqual([]);
    expect(JSON.stringify(host.listInbox("local/sessionB", {}))).not.toContain(foreign.messageId);
  });

  it("refuses missing membership rather than provisioning it during discovery", () => {
    const { fx, host } = rig("ce-p3d-missing-membership-");
    const mapping = host.beginSession("local/sessionB");
    const admin = privileged(fx);
    try {
      admin.exec("DROP TRIGGER exchange_membership_nodelete");
      admin.prepare("DELETE FROM exchange_membership WHERE participant_id=?").run(mapping.participantId);
    } finally { admin.close(); }
    const before = rowCounts(fx);
    expect(expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_UNAVAILABLE").reason).toBe("PARTICIPANT_NOT_MEMBER");
    expect(rowCounts(fx)).toEqual(before);
  });

  it("refuses a terminally detached CE Session without rebinding", () => {
    const { fx, host } = rig("ce-p3d-detached-");
    const mapping = host.beginSession("local/sessionB");
    const capability = issueCapability(fx.store, { participantId: mapping.participantId, scope: "resume", sessionId: mapping.sessionId }, { now: () => START }).capability;
    ownership.releaseOwnership(fx.store, { participantId: mapping.participantId, sessionId: mapping.sessionId, fencingToken: 1, capability }, { now: () => START });
    ownership.detachSession(fx.store, { participantId: mapping.participantId, sessionId: mapping.sessionId, capability }, { now: () => START });
    const before = rowCounts(fx);
    expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_AUTHORITY_ABSENT");
    expectHostRefusal(() => host.resume("local/sessionB", mapping), "CE_HOST_MAPPING_INVALID");
    expect(rowCounts(fx)).toEqual(before);
  });

  it("Storage rejects a stale fencing presentation despite Host preflight", () => {
    const { host } = rig("ce-p3d-stale-fence-");
    host.beginSession("local/sessionB");
    const actual = ownership.readCurrentOwnership;
    vi.spyOn(ownership, "readCurrentOwnership").mockImplementation((store, participantId) => {
      const row = actual(store, participantId);
      return row === undefined ? undefined : { ...row, fencingToken: row.fencingToken + 1 };
    });
    const refusal = expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_AUTHORITY_ABSENT");
    expect(refusal.reason).toBe("FENCING_STALE");
  });

  it("revalidates lease expiry at the Storage transaction boundary", () => {
    let checking = false;
    let samples = 0;
    const { host } = rig("ce-p3d-expire-between-", () => checking && ++samples > 1 ? AFTER_LEASE : START, 30);
    host.beginSession("local/sessionB");
    checking = true;
    const refusal = expectHostRefusal(() => host.listInbox("local/sessionB", {}), "CE_HOST_AUTHORITY_ABSENT");
    expect(refusal.reason).toBe("LEASE_EXPIRED");
  });
});
