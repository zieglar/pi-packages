import { afterEach, describe, expect, it } from "vitest";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);
const legacyPath = process.env.CE_LEGACY_HOST_PATH;

// Run against a fixed pre-deliveryMode source checkout supplied by the operator.
describe.skipIf(!legacyPath)("legacy CE host compatibility", () => {
  it("reads a new steer request as an ordinary message without changing payload", async () => {
    const legacy = await import(/* @vite-ignore */ legacyPath!);
    const fx = fixture("ce-legacy-delivery-");
    const policy = { adapter: "chatgpt", exchangeNamespace: "ce-mcp", exchangeIdempotencyKey: "legacy-test",
      allowlist: [{ endpointId: "chatgpt/a" }, { endpointId: "chatgpt/b" }], leaseTtlSeconds: 600,
      payloadRead: { enabled: true }, now: () => "2026-10-10T00:00:00.000Z" };
    const current = new CeEndpointHost(fx.store, policy);
    const senderMapping = current.beginSession("chatgpt/a");
    const mapping = current.beginSession("chatgpt/b");
    const sent = current.send("chatgpt/a", { to: "chatgpt/b", text: "unchanged", idempotencyKey: "legacy-steer", deliveryMode: "steer" });
    const old = new legacy.CeEndpointHost(fx.store, policy);
    old.resume("chatgpt/b", mapping);
    expect(old.readMetadata("chatgpt/b", { messageId: sent.messageId })).not.toHaveProperty("deliveryMode");
    expect(old.readPayload("chatgpt/b", { messageId: sent.messageId }).payloadText).toBe("unchanged");
    expect(current.readMetadata("chatgpt/b", { messageId: sent.messageId }).deliveryMode).toBe("steer");
    old.resume("chatgpt/a", senderMapping);
    const oldSent = old.send("chatgpt/a", { to: "chatgpt/b", text: "legacy", idempotencyKey: "legacy-followup" });
    expect(current.readPayload("chatgpt/b", { messageId: oldSent.messageId })).toMatchObject({ deliveryMode: "followUp", payloadText: "legacy" });
  });
});
