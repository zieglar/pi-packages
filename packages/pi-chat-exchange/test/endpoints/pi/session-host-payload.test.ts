/**
 * CE-0002 B3-P4D — focused tests for the host payload-read integration.
 *
 * All tests run against a real file-backed store with the shared fixture
 * (deterministic host secret, deterministic clock seam). Nothing is mocked:
 * every assertion exercises the real authority chain through the adapter's
 * public surface, including the operator opt-in, the fixed exposure limit,
 * and strict UTF-8 decoding.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CeHostRefusal,
  CeSessionHost,
  type CeHostPolicy,
} from "../../../src/endpoints/pi/session-host.js";
import { PI_ADAPTER_KIND } from "../../../src/endpoints/pi/contract.js";
import { sendMessage } from "../../../src/storage/messaging.js";
import { issueCapability } from "../../../src/storage/participant.js";
import {
  cleanupFixtures,
  fixture,
  privileged,
  reader,
  type Fixture,
} from "../../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);

const START = "2026-10-10T00:00:00.000Z";
const AFTER_LEASE = "2026-10-10T01:00:00.000Z";
const ENDPOINT_A = "local/sessionA";
const ENDPOINT_B = "local/sessionB";

interface Rig {
  readonly fx: Fixture;
  readonly host: CeSessionHost;
  readonly policy: CeHostPolicy;
}

function rig(
  label: string,
  options: {
    readonly payloadRead?: unknown;
    readonly leaseTtlSeconds?: number;
    readonly now?: () => string;
  } = {},
): Rig {
  const fx = fixture(label);
  // Only the injected payload-read setting escapes the declared type: every
  // well-typed policy field below stays compiler-checked.
  const injectedPayloadRead = options.payloadRead as CeHostPolicy["payloadRead"];
  const policy: CeHostPolicy = {
    adapter: PI_ADAPTER_KIND,
    exchangeNamespace: "pi-host",
    exchangeIdempotencyKey: "pi-host-exchange",
    allowlist: [
      { piSessionId: "ceA", endpointId: ENDPOINT_A },
      { piSessionId: "ceB", endpointId: ENDPOINT_B },
    ],
    ...(options.leaseTtlSeconds === undefined ? {} : { leaseTtlSeconds: options.leaseTtlSeconds }),
    now: options.now ?? (() => START),
    ...(injectedPayloadRead === undefined ? {} : { payloadRead: injectedPayloadRead }),
  };
  return { fx, host: new CeSessionHost(fx.store, policy), policy };
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

function payloadCapabilityRows(fx: Fixture, participantId?: string): number {
  const view = reader(fx);
  try {
    const sql = participantId === undefined
      ? "SELECT CAST(count(*) AS TEXT) AS n FROM participant_capability WHERE scope='payload_read'"
      : "SELECT CAST(count(*) AS TEXT) AS n FROM participant_capability WHERE scope='payload_read' AND participant_id=?";
    const row = participantId === undefined ? view.prepare(sql).get() : view.prepare(sql).get(participantId);
    return Number(row!.n);
  } finally {
    view.close();
  }
}

/** Storage-plane send into the host Exchange for byte-exact payload control. */
function storageSend(
  fx: Fixture,
  exchangeId: string,
  fromEndpointId: string,
  participantId: string,
  sessionId: string,
  bytes: Uint8Array,
  idempotencyKey: string,
): string {
  const capability = issueCapability(fx.store, { participantId, scope: "send", sessionId }).capability;
  return sendMessage(
    fx.store,
    {
      participantId,
      sessionId,
      fencingToken: 1,
      capability,
      message: {
        exchangeId,
        from: { adapter: PI_ADAPTER_KIND, endpointId: fromEndpointId },
        to: { adapter: PI_ADAPTER_KIND, endpointId: ENDPOINT_A },
        payload: bytes,
        idempotencyKey,
      },
    },
    { now: () => START },
  ).message.messageId;
}

describe("host payload-read policy gate", () => {
  it.each([
    ["absent", undefined],
    ["false", { enabled: false }],
    ["string true", { enabled: "true" }],
    ["numeric one", { enabled: 1 }],
    ["null", { enabled: null }],
    ["malformed section", "yes"],
    ["inherited true", Object.create({ enabled: true })],
    ["array with true property", Object.assign([], { enabled: true })],
  ] as const)("fails closed and issues nothing when the setting is %s", (_label, setting) => {
    const { fx, host, policy } = rig("ce-p4d-disabled-", { payloadRead: setting });
    host.beginSession(ENDPOINT_A);
    const mappingB = host.beginSession(ENDPOINT_B);
    expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), "CE_HOST_PAYLOAD_DISABLED");
    // Resume is gated by the same immutable decision: still zero issuance.
    host.drop(ENDPOINT_B);
    new CeSessionHost(fx.store, policy).resume(ENDPOINT_B, mappingB);
    expect(payloadCapabilityRows(fx)).toBe(0);
  });

  it("keeps the policy decision immutable for the lifetime of the host", () => {
    const enabled = rig("ce-p4d-immutable-on-", { payloadRead: { enabled: true } });
    enabled.host.beginSession(ENDPOINT_A);
    enabled.host.beginSession(ENDPOINT_B);
    const sent = enabled.host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "immutable-marker", idempotencyKey: "k1" });
    (enabled.policy.payloadRead as { enabled: boolean }).enabled = false;
    expect(enabled.host.readPayload(ENDPOINT_A, { messageId: sent.messageId }).payloadText).toBe("immutable-marker");

    const disabled = rig("ce-p4d-immutable-off-");
    disabled.host.beginSession(ENDPOINT_A);
    const mutable = disabled.policy as { payloadRead?: { enabled?: boolean } };
    mutable.payloadRead = { enabled: true };
    expectHostRefusal(() => disabled.host.readPayload(ENDPOINT_A, { messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), "CE_HOST_PAYLOAD_DISABLED");
  });

  it("requires registration before a payload read", () => {
    const { host } = rig("ce-p4d-noreg-", { payloadRead: { enabled: true } });
    expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" }), "CE_HOST_NOT_REGISTERED");
  });

  it("rejects malformed payload-read requests", () => {
    const { host } = rig("ce-p4d-shape-", { payloadRead: { enabled: true } });
    host.beginSession(ENDPOINT_A);
    expectHostRefusal(() => host.readPayload(ENDPOINT_A, {}), "CE_HOST_INVALID_REQUEST");
    expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: "not-a-message-id" }), "CE_HOST_INVALID_REQUEST");
    expectHostRefusal(() => host.readPayload(ENDPOINT_A, null), "CE_HOST_INVALID_REQUEST");
    expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", capability: "PRIVATE_TOKEN" }), "CE_HOST_INVALID_REQUEST");
  });
});

describe("host payload-read integration", () => {
  it("issues one exact Session-bound payload capability per endpoint and reads authorized text", () => {
    const { fx, host } = rig("ce-p4d-read-", { payloadRead: { enabled: true } });
    host.beginSession(ENDPOINT_A);
    host.beginSession(ENDPOINT_B);
    expect(payloadCapabilityRows(fx)).toBe(2);

    const text = "secret-marker-Ø☃-ünïcode";
    const sent = host.send(ENDPOINT_B, { to: ENDPOINT_A, text, idempotencyKey: "k1" });
    const result = host.readPayload(ENDPOINT_A, { messageId: sent.messageId });
    expect(result.payloadText).toBe(text);
    expect(result).toMatchObject({
      messageId: sent.messageId,
      from: ENDPOINT_B,
      to: ENDPOINT_A,
      payloadLength: new TextEncoder().encode(text).byteLength,
    });
    expect(JSON.stringify(result)).not.toContain("cap_");

    // The sender is not the recipient: opaque refusal, no payload.
    const refusal = expectHostRefusal(() => host.readPayload(ENDPOINT_B, { messageId: sent.messageId }), "CE_HOST_UNAVAILABLE");
    expect(refusal.reason).toBe("MESSAGE_READ_REJECTED");
    expect(JSON.stringify(refusal)).not.toContain("secret-marker");
  });

  it("reads an empty stored payload as empty text", () => {
    const { fx, host } = rig("ce-p4d-empty-", { payloadRead: { enabled: true } });
    const mappingA = host.beginSession(ENDPOINT_A);
    host.beginSession(ENDPOINT_B);
    const messageId = storageSend(fx, mappingA.exchangeId, ENDPOINT_B, participantOf(host, ENDPOINT_B), sessionIdOf(host, ENDPOINT_B), new Uint8Array(0), "empty-1");
    expect(host.readPayload(ENDPOINT_A, { messageId }).payloadText).toBe("");
  });

  it("resumes fresh memory-only authority within an active lease", () => {
    const { fx, host, policy } = rig("ce-p4d-resume-", { payloadRead: { enabled: true } });
    const mappingA = host.beginSession(ENDPOINT_A);
    host.beginSession(ENDPOINT_B);
    const sent = host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "resume-marker", idempotencyKey: "k1" });
    host.drop(ENDPOINT_A);

    const restarted = new CeSessionHost(fx.store, policy);
    const resumed = restarted.resume(ENDPOINT_A, mappingA);
    expect(resumed.sessionId).toBe(mappingA.sessionId);
    expect(restarted.readPayload(ENDPOINT_A, { messageId: sent.messageId }).payloadText).toBe("resume-marker");
    expect(payloadCapabilityRows(fx, mappingA.participantId)).toBe(2); // begin + fresh resume issuance
  });

  it("refuses after lease expiry or capability revocation without takeover", () => {
    let clock = START;
    const expiredRig = rig("ce-p4d-lease-", { payloadRead: { enabled: true }, now: () => clock });
    expiredRig.host.beginSession(ENDPOINT_A);
    expiredRig.host.beginSession(ENDPOINT_B);
    const sent = expiredRig.host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "lease-marker", idempotencyKey: "k1" });
    clock = AFTER_LEASE;
    expectHostRefusal(() => expiredRig.host.readPayload(ENDPOINT_A, { messageId: sent.messageId }), "CE_HOST_AUTHORITY_ABSENT");

    const revokedRig = rig("ce-p4d-revoke-", { payloadRead: { enabled: true } });
    const mappingA = revokedRig.host.beginSession(ENDPOINT_A);
    revokedRig.host.beginSession(ENDPOINT_B);
    const sent2 = revokedRig.host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "revoke-marker", idempotencyKey: "k1" });
    const db = privileged(revokedRig.fx);
    try {
      db.prepare("UPDATE participant_capability SET revoked_at=? WHERE participant_id=? AND scope='payload_read'")
        .run(START, mappingA.participantId);
    } finally {
      db.close();
    }
    const refusal = expectHostRefusal(() => revokedRig.host.readPayload(ENDPOINT_A, { messageId: sent2.messageId }), "CE_HOST_UNAVAILABLE");
    expect(refusal.reason).toBe("CAPABILITY_REJECTED");
    expect(JSON.stringify(refusal)).not.toContain("revoke-marker");
  });

  it("enforces the fixed 65,536 encoded-byte exposure limit", () => {
    const { host } = rig("ce-p4d-limit-", { payloadRead: { enabled: true } });
    host.beginSession(ENDPOINT_A);
    host.beginSession(ENDPOINT_B);
    const exact = host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "x".repeat(65_536), idempotencyKey: "exact" });
    expect(host.readPayload(ENDPOINT_A, { messageId: exact.messageId }).payloadText.length).toBe(65_536);

    const over = host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "x".repeat(65_537), idempotencyKey: "over" });
    const refusal = expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: over.messageId }), "CE_HOST_PAYLOAD_TOO_LARGE");
    expect(refusal.retryable).toBe(false);
    expect(JSON.stringify(refusal)).not.toMatch(/x{32}/);
  });

  it("decodes complete UTF-8 only and never returns partial payload", () => {
    const { fx, host } = rig("ce-p4d-utf8-", { payloadRead: { enabled: true } });
    const mappingA = host.beginSession(ENDPOINT_A);
    host.beginSession(ENDPOINT_B);
    const sender = participantOf(host, ENDPOINT_B);
    const senderSession = sessionIdOf(host, ENDPOINT_B);

    const valid = storageSend(fx, mappingA.exchangeId, ENDPOINT_B, sender, senderSession, new TextEncoder().encode("héllo ☃ — ünïcode ✓"), "utf8-valid");
    expect(host.readPayload(ENDPOINT_A, { messageId: valid }).payloadText).toBe("héllo ☃ — ünïcode ✓");

    const withBom = storageSend(fx, mappingA.exchangeId, ENDPOINT_B, sender, senderSession, new TextEncoder().encode("\uFEFFexact BOM text"), "utf8-bom");
    expect(host.readPayload(ENDPOINT_A, { messageId: withBom }).payloadText).toBe("\uFEFFexact BOM text");

    const invalid = storageSend(fx, mappingA.exchangeId, ENDPOINT_B, sender, senderSession, Uint8Array.from([0xff, 0xfe, 0x28]), "utf8-invalid");
    const refusal = expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: invalid }), "CE_HOST_PAYLOAD_INVALID_UTF8");
    expect(refusal.retryable).toBe(false);
    expect(JSON.stringify(refusal)).not.toContain("\u0028");
    expect(JSON.stringify(refusal)).not.toMatch(/[\u00ff\ufeff]/);
  });

  it.each([["busy", "CE_HOST_BUSY"] as const, ["commit", "CE_HOST_UNCERTAIN"] as const])(
    "maps a %s transaction outcome for readPayload without payload exposure or retry",
    (fault, code) => {
      const fx = fixture("ce-p4d-fault-");
      let mode: "none" | "busy" | "commit" = "none";
      let attempts = 0;
      const original = fx.store.database.exec.bind(fx.store.database);
      let commitFailed = false;
      fx.store.database.exec = (sql: string) => {
        if (mode === "busy" && sql.includes("BEGIN IMMEDIATE")) {
          attempts += 1;
          const error = new Error("database is locked (injected)") as Error & { errcode: number };
          error.errcode = 5; // SQLITE_BUSY primary result code
          throw error;
        }
        if (mode === "commit" && sql.includes("COMMIT")) {
          attempts += 1;
          commitFailed = true;
          throw new Error("PRIVATE_COMMIT");
        }
        if (mode === "commit" && commitFailed && sql.includes("ROLLBACK")) {
          throw new Error("PRIVATE_ROLLBACK");
        }
        return original(sql);
      };
      const host = new CeSessionHost(fx.store, {
        adapter: PI_ADAPTER_KIND,
        exchangeNamespace: "pi-host",
        exchangeIdempotencyKey: "pi-host-exchange",
        allowlist: [
          { piSessionId: "ceA", endpointId: ENDPOINT_A },
          { piSessionId: "ceB", endpointId: ENDPOINT_B },
        ],
        now: () => START,
        payloadRead: { enabled: true },
      });
      host.beginSession(ENDPOINT_A);
      host.beginSession(ENDPOINT_B);
      const sent = host.send(ENDPOINT_B, { to: ENDPOINT_A, text: "fault-marker", idempotencyKey: "k1" });

      mode = fault;
      const refusal = expectHostRefusal(() => host.readPayload(ENDPOINT_A, { messageId: sent.messageId }), code);
      expect(refusal.retryable).toBe(fault === "busy");
      expect(attempts).toBe(1); // exactly one attempt; never an automatic retry
      expect(JSON.stringify(refusal)).not.toContain("fault-marker");
      expect(JSON.stringify(refusal)).not.toContain("PRIVATE_");
    },
  );
});

function participantOf(host: CeSessionHost, endpointId: string): string {
  const status = host.status(endpointId);
  if (status.participantId === undefined) throw new Error("endpoint not registered");
  return status.participantId;
}

function sessionIdOf(host: CeSessionHost, endpointId: string): string {
  const status = host.status(endpointId);
  if (status.sessionId === undefined) throw new Error("endpoint not registered");
  return status.sessionId;
}
