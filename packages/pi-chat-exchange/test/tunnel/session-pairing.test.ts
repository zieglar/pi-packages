import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  consumePairingReceipt,
  createPairingCapability,
  inspectPairingReceipt,
  redeemPairingCapability,
} from "../../src/tunnel/session-pairing.js";

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ce-pairing-"));
  chmodSync(path, 0o700);
  return realpathSync(path);
}

const identity = {
  runtimeSessionId: "01a1e387-7fb2-7162-a115-6a268a648619",
  exchangeId: "ho_01M5J6YA0EPHAF84QYMKKT7P0B",
  endpointId: "pi/session-test",
};

describe("session pairing capability", () => {
  it("creates a five-minute digest-only capability with an explicit default sender", () => {
    const directory = root();
    const created = createPairingCapability({ directory, identity, now: 1_000, randomBytes: () => Buffer.alloc(24, 7) });
    expect(created).toMatchObject({ from: "chatgpt/main", expiresAt: 301_000 });
    expect(created.command).toBe(`/ce pair ${created.secret} --from chatgpt/main`);
    const persisted = readdirSync(join(directory, "pairing"))
      .map(name => readFileSync(join(directory, "pairing", name), "utf8")).join("\n");
    expect(persisted).not.toContain(created.secret);
    expect(persisted).toContain(created.capabilityDigest);
  });

  it("uses a validated sender override", () => {
    const created = createPairingCapability({ directory: root(), identity, from: "chatgpt/work", randomBytes: () => Buffer.alloc(24, 8) });
    expect(created.command).toBe(`/ce pair ${created.secret} --from chatgpt/work`);
    expect(() => createPairingCapability({ directory: root(), identity, from: "bad sender" })).toThrow();
  });

  it("replaces the outstanding capability for the same Pi Session", () => {
    const directory = root();
    const first = createPairingCapability({ directory, identity, randomBytes: () => Buffer.alloc(24, 1) });
    const second = createPairingCapability({ directory, identity, randomBytes: () => Buffer.alloc(24, 2) });
    expect(redeemPairingCapability({ directory, secret: first.secret, exchangeId: identity.exchangeId })).toEqual({ status: "refused", reason: "PAIRING_NOT_CURRENT" });
    expect(redeemPairingCapability({ directory, secret: second.secret, exchangeId: identity.exchangeId })).toMatchObject({ status: "accepted", from: "chatgpt/main" });
  });

  it("refuses expiry, Exchange mismatch, and replay", () => {
    const directory = root();
    const created = createPairingCapability({ directory, identity, now: 1_000, randomBytes: () => Buffer.alloc(24, 3) });
    expect(redeemPairingCapability({ directory, secret: created.secret, exchangeId: "other", now: 2_000 })).toEqual({ status: "refused", reason: "PAIRING_IDENTITY_MISMATCH" });
    expect(redeemPairingCapability({ directory, secret: created.secret, exchangeId: identity.exchangeId, now: 301_001 })).toEqual({ status: "refused", reason: "PAIRING_EXPIRED" });
    const fresh = createPairingCapability({ directory, identity, now: 4_000, randomBytes: () => Buffer.alloc(24, 4) });
    expect(redeemPairingCapability({ directory, secret: fresh.secret, exchangeId: identity.exchangeId, now: 5_000 })).toMatchObject({ status: "accepted" });
    expect(redeemPairingCapability({ directory, secret: fresh.secret, exchangeId: identity.exchangeId, now: 5_001 })).toEqual({ status: "refused", reason: "PAIRING_ALREADY_REDEEMED" });
  });

  it("exposes and consumes a receipt only for the bound identity", () => {
    const directory = root();
    const created = createPairingCapability({ directory, identity, from: "chatgpt/work", now: 1_000, randomBytes: () => Buffer.alloc(24, 5) });
    redeemPairingCapability({ directory, secret: created.secret, exchangeId: identity.exchangeId, now: 2_000 });
    expect(inspectPairingReceipt({ directory, identity, now: 3_000 })).toMatchObject({ status: "redeemed", receipt: { ...identity, from: "chatgpt/work", capabilityDigest: created.capabilityDigest } });
    expect(inspectPairingReceipt({ directory, identity: { ...identity, runtimeSessionId: "other" }, now: 3_000 })).toEqual({ status: "missing" });
    expect(consumePairingReceipt({ directory, identity, capabilityDigest: created.capabilityDigest })).toBe(true);
    expect(inspectPairingReceipt({ directory, identity, now: 3_000 })).toEqual({ status: "missing" });
  });
});
