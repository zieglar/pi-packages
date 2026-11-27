import { afterEach, expect, it } from "vitest";
import { readMessageMetadata, sendMessage } from "../../src/storage/messaging.js";
import { acquireOwnership, bindSession, releaseOwnership } from "../../src/storage/ownership.js";
import { joinExchange } from "../../src/storage/participant.js";
import { capabilityFor, cleanupFixtures, exchange, expectRefusal, fixture, NOW, participant } from "./support/participant-fixture.js";

afterEach(cleanupFixtures);

function setup() {
  const active = fixture("ce-reply-chain-");
  const exchangeId = exchange(active);
  const actors = ["sender", "recipient", "outsider"].map((endpointId, index) => {
    const endpoint = { adapter: index === 0 ? "chatgpt" : "pi", endpointId };
    const participantId = participant(active, endpointId, `create-${endpointId}`, endpoint.adapter).participant.participantId;
    const sessionId = `ses_01ARZ3NDEKTSV4RRFFQ69G5FA${index}`;
    const attach = capabilityFor(active, participantId, "attach");
    bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
    acquireOwnership(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
    joinExchange(active.store, { exchangeId, participantId, capability: capabilityFor(active, participantId, "join"), idempotencyKey: `join-${index}` }, { now: () => NOW });
    return {
      endpoint,
      authority: { participantId, sessionId, fencingToken: 1 },
      sendCapability: capabilityFor(active, participantId, "send", { sessionId }),
      readCapability: capabilityFor(active, participantId, "read", { sessionId }),
    };
  });
  const [sender, recipient, outsider] = actors as [typeof actors[number], typeof actors[number], typeof actors[number]];
  const send = (from: typeof sender, to: typeof sender, key: string, replyTo?: string, deliveryMode?: "followUp" | "steer") => sendMessage(active.store, {
    ...from.authority, capability: from.sendCapability,
    message: { exchangeId, from: from.endpoint, to: to.endpoint, payload: new TextEncoder().encode(key), idempotencyKey: key, ...(deliveryMode === undefined ? {} : { deliveryMode }) },
    ...(replyTo === undefined ? {} : { association: { requestMessageId: replyTo } }),
  }, { now: () => "2026-10-10T00:00:10.000Z" });
  const read = (actor: typeof sender, messageId: string) => readMessageMetadata(active.store, {
    ...actor.authority, capability: actor.readCapability, exchangeId, messageId,
  }, { now: () => "2026-10-10T00:00:10.000Z" });
  return { active, sender, recipient, outsider, send, read };
}

it("accepts an authorized confirmation replying to a received reply and preserves its immediate parent", () => {
  const f = setup();
  const request = f.send(f.sender, f.recipient, "request");
  f.read(f.recipient, request.message.messageId);
  const reply = f.send(f.recipient, f.sender, "reply", request.message.messageId);
  f.read(f.sender, reply.message.messageId);
  const confirmation = f.send(f.sender, f.recipient, "confirmation", reply.message.messageId);
  expect(confirmation.disposition).toBe("CREATED");
  const view = f.active.store.database.prepare("SELECT request_message_id FROM message_association WHERE message_id=?").get(confirmation.message.messageId);
  expect(view).toEqual({ request_message_id: reply.message.messageId });
  expect(f.send(f.sender, f.recipient, "confirmation", reply.message.messageId)).toMatchObject({ disposition: "REPLAYED", message: { messageId: confirmation.message.messageId } });
});

it("preserves reply association and recipient authority for steer", () => {
  const f = setup();
  const request = f.send(f.sender, f.recipient, "request");
  const reply = f.send(f.recipient, f.sender, "reply", request.message.messageId, "steer");
  expect(f.read(f.sender, reply.message.messageId).deliveryMode).toBe("steer");
  expectRefusal(() => f.read(f.outsider, reply.message.messageId), "MESSAGE_READ_REJECTED");
  expect(f.active.store.database.prepare("SELECT request_message_id FROM message_association WHERE message_id=?").get(reply.message.messageId))
    .toEqual({ request_message_id: request.message.messageId });
  expect(f.send(f.recipient, f.sender, "reply", request.message.messageId, "steer").disposition).toBe("REPLAYED");
  expect(() => f.send(f.recipient, f.sender, "reply", request.message.messageId, "followUp")).toThrow();
});

it("keeps sender read denial and cross-endpoint reply rejection for every chain link", () => {
  const f = setup();
  const request = f.send(f.sender, f.recipient, "request");
  expectRefusal(() => f.read(f.sender, request.message.messageId), "MESSAGE_READ_REJECTED");
  const reply = f.send(f.recipient, f.sender, "reply", request.message.messageId);
  expectRefusal(() => f.send(f.outsider, f.recipient, "outsider", reply.message.messageId), "MESSAGE_READ_REJECTED");
  expectRefusal(() => f.send(f.recipient, f.sender, "own-outgoing", reply.message.messageId), "MESSAGE_READ_REJECTED");
  expectRefusal(() => f.send(f.sender, f.outsider, "wrong-target", reply.message.messageId), "MESSAGE_READ_REJECTED");
});

it("rejects a reply after its original recipient Owner fencing changes", () => {
  const f = setup();
  const request = f.send(f.sender, f.recipient, "request");
  const reply = f.send(f.recipient, f.sender, "reply", request.message.messageId);
  const { participantId, sessionId } = f.sender.authority;
  releaseOwnership(f.active.store, { ...f.sender.authority, capability: capabilityFor(f.active, participantId, "resume", { sessionId }) }, { now: () => "2026-10-10T00:00:11.000Z" });
  const owner = acquireOwnership(f.active.store, { participantId, sessionId, capability: capabilityFor(f.active, participantId, "attach") }, { now: () => "2026-10-10T00:00:12.000Z" });
  expectRefusal(() => sendMessage(f.active.store, {
    ...f.sender.authority, fencingToken: owner.fencingToken, capability: f.sender.sendCapability,
    message: { exchangeId: request.message.exchangeId, from: f.sender.endpoint, to: f.recipient.endpoint, payload: new Uint8Array([1]), idempotencyKey: "new-owner-confirmation" },
    association: { requestMessageId: reply.message.messageId },
  }, { now: () => "2026-10-10T00:00:13.000Z" }), "MESSAGE_READ_REJECTED");
});
