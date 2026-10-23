/**
 * HANDOFF-CE-MULTI-SESSION-01 — Task 1 characterization ONLY (before any
 * production edit).
 *
 * These tests pin the CURRENT single-session boundaries of the REAL
 * `CeEndpointHost` over a REAL file-backed `DurableStore` (synthetic temporary
 * Store from the shared storage fixture — no real Pi runtime, no Tunnel, no
 * credentials, no real user Store is opened):
 *
 * 1. Independent endpoints A/B with explicit recipients through one shared
 *    Store, including two separate host handles operating concurrently.
 * 2. Cross-recipient read and ACK denial (storage-plane recipient binding).
 * 3. Owner conflict across DISTINCT CE Sessions on one endpoint, versus
 *    coexistence of owners on distinct endpoints.
 * 4. Same CE Mapping resumed by MULTIPLE handles — records the CURRENT GAP
 *    (resume is Session-scoped only; there is no process-handle exclusivity),
 *    asserted as today's behavior so the planned verified process mutex
 *    (plan Task 3) intentionally flips these cases.
 *
 * Everything here is real Host + real SQLite Store behavior; nothing is mocked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CeEndpointHost, CeHostRefusal, type CeEndpointHostPolicy } from "../../src/host/endpoint-host.js";
import type { DurableStore } from "../../src/storage/store.js";
import { cleanupFixtures, fixture, reader, type Fixture } from "../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);

const NOW = "2026-10-10T00:00:00.000Z";
const ENDPOINT_A = "pi/A";
const ENDPOINT_B = "pi/B";
const CHATGPT = "chatgpt/main";

interface Rig {
  readonly store: DurableStore;
  readonly fx: Fixture;
  readonly piHost: (overrides?: Partial<CeEndpointHostPolicy>) => CeEndpointHost;
  readonly chatgptHost: (overrides?: Partial<CeEndpointHostPolicy>) => CeEndpointHost;
}

function rig(): Rig {
  const fx: Fixture = fixture("ce-multi-host-");
  const piPolicy: CeEndpointHostPolicy = {
    adapter: "pi",
    exchangeNamespace: "ce-mcp",
    exchangeIdempotencyKey: "exchange-1",
    allowlist: [{ endpointId: ENDPOINT_A }, { endpointId: ENDPOINT_B }],
    recipients: [{ adapter: "chatgpt", endpointId: CHATGPT }],
    leaseTtlSeconds: 600,
    payloadRead: { enabled: true },
    ack: { enabled: true },
    now: () => NOW,
  };
  const chatgptPolicy: CeEndpointHostPolicy = {
    adapter: "chatgpt",
    exchangeNamespace: "ce-mcp",
    exchangeIdempotencyKey: "exchange-1",
    allowlist: [{ endpointId: CHATGPT }],
    recipients: [
      { adapter: "pi", endpointId: ENDPOINT_A },
      { adapter: "pi", endpointId: ENDPOINT_B },
    ],
    leaseTtlSeconds: 600,
    payloadRead: { enabled: true },
    ack: { enabled: true },
    now: () => NOW,
  };
  return {
    store: fx.store,
    fx,
    piHost: (next = {}) => new CeEndpointHost(fx.store, { ...piPolicy, ...next }),
    chatgptHost: (next = {}) => new CeEndpointHost(fx.store, { ...chatgptPolicy, ...next }),
  };
}

function expectRefusal(run: () => unknown, code: string, reason?: string): CeHostRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CeHostRefusal);
    expect(error).toMatchObject(reason === undefined ? { code } : { code, reason });
    return error as CeHostRefusal;
  }
  throw new Error(`expected CeHostRefusal ${code}`);
}

const inboxIds = (host: CeEndpointHost, endpointId: string): string[] =>
  host.listInbox(endpointId, {}).messages.map((message) => message.messageId);

describe("characterization: independent endpoints A/B with explicit recipients", () => {
  it("directs each chatgpt/main send to exactly the addressed Pi endpoint", () => {
    const { piHost, chatgptHost } = rig();
    const pi = piHost();
    const chatgpt = chatgptHost();
    pi.beginSession(ENDPOINT_A);
    pi.beginSession(ENDPOINT_B);
    chatgpt.beginSession(CHATGPT);

    const toA = chatgpt.send(CHATGPT, { to: ENDPOINT_A, text: "for A", idempotencyKey: "dir-a-1" });
    const toB = chatgpt.send(CHATGPT, { to: ENDPOINT_B, text: "for B", idempotencyKey: "dir-b-1" });

    expect(inboxIds(pi, ENDPOINT_A)).toEqual([toA.messageId]);
    expect(inboxIds(pi, ENDPOINT_B)).toEqual([toB.messageId]);
    // The sender's own inbox holds nothing it addressed to others.
    expect(inboxIds(chatgpt, CHATGPT)).toEqual([]);
  });

  it("keeps a same-adapter A -> B send out of A's own inbox", () => {
    const { piHost } = rig();
    const pi = piHost();
    pi.beginSession(ENDPOINT_A);
    pi.beginSession(ENDPOINT_B);

    const sent = pi.send(ENDPOINT_A, { to: ENDPOINT_B, text: "A to B", idempotencyKey: "ab-1" });

    expect(inboxIds(pi, ENDPOINT_B)).toEqual([sent.messageId]);
    expect(inboxIds(pi, ENDPOINT_A)).toEqual([]);
    expect(pi.readPayload(ENDPOINT_B, { messageId: sent.messageId }).payloadText).toBe("A to B");
  });

  it("operates A and B from two separate host handles concurrently over one Store", () => {
    const { piHost } = rig();
    const handleA = piHost();
    const handleB = piHost();
    const a = handleA.beginSession(ENDPOINT_A);
    const b = handleB.beginSession(ENDPOINT_B);
    // Distinct participants and distinct CE Sessions; both leases live at once.
    expect(a.participantId).not.toBe(b.participantId);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(handleA.status(ENDPOINT_A)).toMatchObject({ lease: "ACTIVE", fencingToken: 1 });
    expect(handleB.status(ENDPOINT_B)).toMatchObject({ lease: "ACTIVE", fencingToken: 1 });

    const fromA = handleA.send(ENDPOINT_A, { to: ENDPOINT_B, text: "A->B", idempotencyKey: "ha-1" });
    const fromB = handleB.send(ENDPOINT_B, { to: ENDPOINT_A, text: "B->A", idempotencyKey: "hb-1" });
    expect(inboxIds(handleB, ENDPOINT_B)).toContain(fromA.messageId);
    expect(inboxIds(handleA, ENDPOINT_A)).toContain(fromB.messageId);
    expect(inboxIds(handleA, ENDPOINT_A)).not.toContain(fromA.messageId);
  });
});

describe("characterization: cross-recipient read and ACK denial", () => {
  it("refuses A reading metadata or payload of a message addressed to B", () => {
    const { piHost, chatgptHost } = rig();
    const pi = piHost();
    const chatgpt = chatgptHost();
    pi.beginSession(ENDPOINT_A);
    pi.beginSession(ENDPOINT_B);
    chatgpt.beginSession(CHATGPT);

    const toB = chatgpt.send(CHATGPT, { to: ENDPOINT_B, text: "B only", idempotencyKey: "xd-1" });

    // Storage recipient binding: only B's endpoint matches message.to.
    expectRefusal(() => pi.readMetadata(ENDPOINT_A, { messageId: toB.messageId }), "CE_HOST_UNAVAILABLE", "MESSAGE_READ_REJECTED");
    expectRefusal(() => pi.readPayload(ENDPOINT_A, { messageId: toB.messageId }), "CE_HOST_UNAVAILABLE", "MESSAGE_READ_REJECTED");
    // Recipient-scoped discovery: the message never appears in A's inbox.
    expect(inboxIds(pi, ENDPOINT_A)).not.toContain(toB.messageId);
    expect(inboxIds(pi, ENDPOINT_B)).toContain(toB.messageId);
  });

  it("refuses A acking a message addressed to B even with B's exact copied metadata", () => {
    const { piHost, chatgptHost } = rig();
    const pi = piHost();
    const chatgpt = chatgptHost();
    pi.beginSession(ENDPOINT_A);
    pi.beginSession(ENDPOINT_B);
    chatgpt.beginSession(CHATGPT);

    const toB = chatgpt.send(CHATGPT, { to: ENDPOINT_B, text: "B acks only", idempotencyKey: "xa-1" });
    // Test-side observation of B's authorized metadata; A could copy the same
    // four fields from any leak, so the denial below must not depend on them
    // being secret.
    const metadata = pi.readMetadata(ENDPOINT_B, { messageId: toB.messageId });
    const request = {
      messageId: toB.messageId,
      payloadDigest: metadata.payloadDigest,
      payloadLength: metadata.payloadLength,
      messageCreatedAuditSequence: metadata.auditSequence,
    };

    expectRefusal(() => pi.acknowledge(ENDPOINT_A, request), "CE_HOST_UNAVAILABLE", "MESSAGE_READ_REJECTED");
    // The true recipient still ACKs the same message idempotently.
    const first = pi.acknowledge(ENDPOINT_B, request);
    expect(first.disposition).toBe("CREATED");
    expect(pi.acknowledge(ENDPOINT_B, request).disposition).toBe("REPLAYED");
  });
});

describe("characterization: owner conflict across distinct CE Sessions", () => {
  it("refuses a second handle's new CE Session on an owned endpoint and leaves the owner usable", () => {
    const { piHost } = rig();
    const owner = piHost();
    const mapping = owner.beginSession(ENDPOINT_A);

    const intruder = piHost();
    // A brand-new CE Session for the same Participant collides with the live
    // ownership row: OWNERSHIP_HELD maps to authority absence (no takeover).
    expectRefusal(() => intruder.beginSession(ENDPOINT_A), "CE_HOST_AUTHORITY_ABSENT", "OWNERSHIP_HELD");
    // The refused start never disturbed the owner's authority.
    expect(owner.send(ENDPOINT_A, { to: ENDPOINT_B, text: "still owner", idempotencyKey: "oc-1" }))
      .toMatchObject({ disposition: "CREATED" });
    expect(owner.status(ENDPOINT_A)).toMatchObject({ sessionId: mapping.sessionId, lease: "ACTIVE" });
  });

  it("documents the orphan ATTACHED session a plain second begin leaves behind", () => {
    const { fx, piHost } = rig();
    const owner = piHost();
    const mapping = owner.beginSession(ENDPOINT_A);
    expectRefusal(() => piHost().beginSession(ENDPOINT_A), "CE_HOST_AUTHORITY_ABSENT", "OWNERSHIP_HELD");

    const view = reader(fx);
    try {
      const rows = view
        .prepare("SELECT session_id, detached_at FROM participant_session WHERE participant_id = ?")
        .all(mapping.participantId) as { session_id: string; detached_at: string | null }[];
      // CURRENT behavior: the refused acquisition already bound a second
      // ATTACHED CE Session (the reason `requireUnowned` exists). Recorded as
      // the single-instance admission rule the multi-session plan builds on.
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.detached_at === null)).toBe(true);
    } finally {
      view.close();
    }
  });

  it("refuses a requireUnowned second start before ANY durable write", () => {
    const { fx, piHost } = rig();
    const owner = piHost();
    const mapping = owner.beginSession(ENDPOINT_A);

    expectRefusal(() => piHost().beginSession(ENDPOINT_A, { requireUnowned: true }), "CE_HOST_AUTHORITY_ABSENT");

    const view = reader(fx);
    try {
      const count = view
        .prepare("SELECT CAST(count(*) AS TEXT) AS n FROM participant_session WHERE participant_id = ?")
        .get(mapping.participantId)!.n;
      expect(count).toBe("1");
    } finally {
      view.close();
    }
  });

  it("keeps distinct endpoints' owners independent over one Store", () => {
    const { piHost } = rig();
    const handleA = piHost();
    const handleB = piHost();
    const a = handleA.beginSession(ENDPOINT_A);
    const b = handleB.beginSession(ENDPOINT_B);

    expect(handleA.renew(ENDPOINT_A).fencingToken).toBeGreaterThan(0);
    expect(handleB.renew(ENDPOINT_B).fencingToken).toBeGreaterThan(0);
    // Each host answers only for its own registered endpoint.
    expect(handleA.status(ENDPOINT_B)).toMatchObject({ registered: false, lease: "ABSENT" });
    expectRefusal(() => handleA.send(ENDPOINT_B, { to: ENDPOINT_A, text: "x", idempotencyKey: "k" }), "CE_HOST_NOT_REGISTERED");
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("characterization: same CE Mapping resumed by multiple handles (CURRENT GAP)", () => {
  // GAP RECORD (plan authority constraint "wdrt"): Storage Ownership is
  // Session-scoped and does not distinguish process handles, so `resume` today
  // admits a second handle for the SAME durable CE Session. The plan's Task 3
  // adds a verified per-Session/process exclusivity guard; these assertions pin
  // the CURRENT behavior and must be intentionally revisited when it lands.

  it("admits a second handle resuming the same mapping while the first still operates", () => {
    const { piHost } = rig();
    const first = piHost();
    const mapping = first.beginSession(ENDPOINT_A);

    const second = piHost();
    // CURRENT GAP: this succeeds — two handles hold authority for one CE
    // Session simultaneously (no process mutex exists at this seam).
    const resumed = second.resume(ENDPOINT_A, mapping);
    expect(resumed).toEqual(mapping);
    expect(second.status(ENDPOINT_A)).toMatchObject({ sessionId: mapping.sessionId, lease: "ACTIVE" });

    // Ownership was not re-acquired or moved: same Session, same fencing token.
    const before = first.renew(ENDPOINT_A);
    expect(before.fencingToken).toBe(1);
    // Both handles can operate the shared Session concurrently.
    expect(first.send(ENDPOINT_A, { to: ENDPOINT_B, text: "from first", idempotencyKey: "g-1" }).disposition).toBe("CREATED");
    expect(second.send(ENDPOINT_A, { to: ENDPOINT_B, text: "from second", idempotencyKey: "g-2" }).disposition).toBe("CREATED");
  });

  it("resume never adopts a non-owner session of the same participant", () => {
    const { fx, piHost } = rig();
    const owner = piHost();
    const mapping = owner.beginSession(ENDPOINT_A);
    // Produce a second ATTACHED-but-unowned CE Session (refused begin above).
    expectRefusal(() => piHost().beginSession(ENDPOINT_A), "CE_HOST_AUTHORITY_ABSENT", "OWNERSHIP_HELD");

    const view = reader(fx);
    let orphan: string;
    try {
      orphan = String(
        (view
          .prepare("SELECT session_id FROM participant_session WHERE participant_id = ? AND session_id != ?")
          .get(mapping.participantId, mapping.sessionId) as { session_id: string }).session_id,
      );
    } finally {
      view.close();
    }

    // CURRENT invariant (fail closed): only the CURRENT owner session resumes.
    expectRefusal(
      () => piHost().resume(ENDPOINT_A, { ...mapping, sessionId: orphan }),
      "CE_HOST_AUTHORITY_ABSENT",
      "OWNERSHIP_NOT_CURRENT",
    );
  });

  it("invalidates the other handle's authority only at the next storage check after one ends", () => {
    const { piHost } = rig();
    const first = piHost();
    const mapping = first.beginSession(ENDPOINT_A);
    const second = piHost();
    expect(second.resume(ENDPOINT_A, mapping)).toEqual(mapping);

    expect(first.end(ENDPOINT_A)).toMatchObject({ released: true, detached: true });
    // CURRENT behavior: the surviving handle keeps its in-memory authority row
    // but every operation re-validates durable ownership and now fails closed.
    expectRefusal(() => second.send(ENDPOINT_A, { to: ENDPOINT_B, text: "late", idempotencyKey: "g-3" }), "CE_HOST_AUTHORITY_ABSENT", "OWNERSHIP_NOT_CURRENT");
    expectRefusal(() => second.renew(ENDPOINT_A), "CE_HOST_AUTHORITY_ABSENT", "OWNERSHIP_NOT_CURRENT");
    expect(second.status(ENDPOINT_A)).toMatchObject({ registered: true, lease: "ABSENT" });
  });
});
