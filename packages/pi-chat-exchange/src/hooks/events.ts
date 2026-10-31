import type { EndpointRef } from "../protocol/entities.js";
import { generateEntityId } from "../protocol/identity.js";
import type { AuthorizedMessageCreation } from "../storage/messaging.js";

export const CE_MESSAGE_COMMITTED_EVENT = "ce.message.committed.v1" as const;

/** Metadata-only local Hook envelope. Payload text and authority never leave
 * the committed send path through this event. */
export interface CeCommittedMessageEvent {
  readonly schemaVersion: 1;
  readonly event: typeof CE_MESSAGE_COMMITTED_EVENT;
  readonly eventId: string;
  readonly eventKey: string;
  readonly messageId: string;
  readonly exchangeId: string;
  readonly sender: EndpointRef;
  readonly recipient: EndpointRef;
  readonly createdAt: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;
}

export function createCommittedMessageEvent(creation: AuthorizedMessageCreation): CeCommittedMessageEvent {
  const message = creation.message;
  return Object.freeze({
    schemaVersion: 1,
    event: CE_MESSAGE_COMMITTED_EVENT,
    eventId: generateEntityId("evt_", Date.parse(message.createdAt)),
    eventKey: `${message.exchangeId}/${creation.auditSequence}`,
    messageId: message.messageId,
    exchangeId: message.exchangeId,
    sender: Object.freeze({ ...message.from }),
    recipient: Object.freeze({ ...message.to }),
    createdAt: message.createdAt,
    payloadDigest: message.payloadDigest,
    payloadLength: message.payloadLength,
  });
}
