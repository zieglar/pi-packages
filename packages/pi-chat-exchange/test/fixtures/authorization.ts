/** Test data only. No production grant issuer or authentication is implemented. */
import { CONTROL_OPERATIONS, OPTIONAL_CONTROL_CAPABILITIES, ENDPOINT_OPERATIONS, type ActionGrant, type AuthorizationContext, type AuthorizationScope, type ExchangeAction } from "../../src/protocol/capabilities.js";
import type { EndpointRef } from "../../src/protocol/entities.js";

export function fixtureAuthorization(
  exchangeId: string, messageId: string, attemptId: string, endpoint: EndpointRef,
  principalId = "owner", actions: readonly ExchangeAction[] = [...CONTROL_OPERATIONS, ...OPTIONAL_CONTROL_CAPABILITIES, ...ENDPOINT_OPERATIONS],
): AuthorizationContext {
  return { principalId, grants: actions.map((action): ActionGrant => {
    let scope: AuthorizationScope;
    if (action === "exchange_list") scope = { kind: "collection" };
    else if (action === "exchange_close" || action === "exchange_archive") scope = { kind: "owner", exchangeId, ownerId: principalId };
    else if (action === "exchange_cancel") scope = { kind: "message", exchangeId, messageId };
    else if (action === "message_claim") scope = { kind: "destination", exchangeId, messageId, endpoint };
    else if (action === "exchange_send" || action === "exchange_get" || action === "exchange_result") scope = { kind: "exchange", exchangeId };
    else scope = { kind: "attempt", exchangeId, messageId, attemptId, endpoint };
    return { action, principalId, scope } as ActionGrant;
  }) };
}
