/**
 * Action/capability contracts (PH-0003). Endpoint peers have no protocol role.
 * These plain contexts are TRUSTED HOST INPUT, not self-issued credentials.
 * The future host authenticates identity and loads grants transactionally.
 * Interface implementation and support advertisement confer no authority.
 */
import { Type } from "@sinclair/typebox";
import { EndpointRefSchema, type EndpointRef } from "./entities.js";
import { EXCHANGE_ID_PATTERN, MESSAGE_ID_PATTERN, ATTEMPT_ID_PATTERN } from "./identity.js";
const ExchangeIdSchema = Type.String({ pattern: EXCHANGE_ID_PATTERN.source });
const MessageIdSchema = Type.String({ pattern: MESSAGE_ID_PATTERN.source });
const AttemptIdSchema = Type.String({ pattern: ATTEMPT_ID_PATTERN.source });

export const CONTROL_OPERATIONS = ["exchange_send", "exchange_get", "exchange_list", "exchange_cancel", "exchange_result"] as const;
export const OPTIONAL_CONTROL_CAPABILITIES = ["exchange_close", "exchange_archive"] as const;
export const ENDPOINT_OPERATIONS = ["message_claim", "dispatch_mark_started", "delivery_report", "activity_report", "settlement_report", "result_publish", "lease_release", "ambiguity_resolve", "cancel_confirm"] as const;
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];
export type OptionalControlCapability = (typeof OPTIONAL_CONTROL_CAPABILITIES)[number];
export type EndpointOperation = (typeof ENDPOINT_OPERATIONS)[number];
export type ExchangeAction = ControlOperation | OptionalControlCapability | EndpointOperation;
export type AttemptAction = Exclude<EndpointOperation, "message_claim">;

/** Declaration only: not a grant and not an implementation of these operations. */
export interface ControlSurfaceDeclaration {
  readonly operations: readonly ControlOperation[];
  readonly optionalCapabilities?: readonly OptionalControlCapability[];
}
export type CollectionScope = { readonly kind: "collection" };
export type ExchangeScope = { readonly kind: "exchange"; readonly exchangeId: string };
export type OwnerScope = { readonly kind: "owner"; readonly exchangeId: string; readonly ownerId: string };
export type MessageScope = { readonly kind: "message"; readonly exchangeId: string; readonly messageId: string };
export type DestinationScope = { readonly kind: "destination"; readonly exchangeId: string; readonly messageId: string; readonly endpoint: EndpointRef };
export type AttemptScope = { readonly kind: "attempt"; readonly exchangeId: string; readonly messageId: string; readonly attemptId: string; readonly endpoint: EndpointRef };
export type ScopeForAction<A extends ExchangeAction> =
  A extends "exchange_list" ? CollectionScope :
  A extends "exchange_close" | "exchange_archive" ? OwnerScope :
  A extends "exchange_cancel" ? MessageScope :
  A extends "message_claim" ? DestinationScope :
  A extends AttemptAction ? AttemptScope : ExchangeScope;
export type AuthorizationScope = ScopeForAction<ExchangeAction>;
export type ActionGrant = { [A in ExchangeAction]: {
  readonly action: A;
  readonly principalId: string;
  readonly scope: ScopeForAction<A>;
} }[ExchangeAction];
export interface AuthorizationContext {
  readonly principalId: string;
  readonly grants: readonly ActionGrant[];
}

const strict = { additionalProperties: false } as const;
const principal = Type.String({ minLength: 1, maxLength: 256 });
const collectionScope = Type.Object({ kind: Type.Literal("collection") }, strict);
const exchangeScope = Type.Object({ kind: Type.Literal("exchange"), exchangeId: ExchangeIdSchema }, strict);
const ownerScope = Type.Object({ kind: Type.Literal("owner"), exchangeId: ExchangeIdSchema, ownerId: principal }, strict);
const messageScope = Type.Object({ kind: Type.Literal("message"), exchangeId: ExchangeIdSchema, messageId: MessageIdSchema }, strict);
const destinationScope = Type.Object({ kind: Type.Literal("destination"), exchangeId: ExchangeIdSchema, messageId: MessageIdSchema, endpoint: EndpointRefSchema }, strict);
const attemptScope = Type.Object({ kind: Type.Literal("attempt"), exchangeId: ExchangeIdSchema, messageId: MessageIdSchema, attemptId: AttemptIdSchema, endpoint: EndpointRefSchema }, strict);
const actions = (names: readonly string[]) => Type.Union(names.map((name) => Type.Literal(name)));
export const ActionGrantSchema = Type.Union([
  Type.Object({ action: actions(["exchange_send", "exchange_get", "exchange_result"]), principalId: principal, scope: exchangeScope }, strict),
  Type.Object({ action: Type.Literal("exchange_list"), principalId: principal, scope: collectionScope }, strict),
  Type.Object({ action: actions(OPTIONAL_CONTROL_CAPABILITIES), principalId: principal, scope: ownerScope }, strict),
  Type.Object({ action: Type.Literal("exchange_cancel"), principalId: principal, scope: messageScope }, strict),
  Type.Object({ action: Type.Literal("message_claim"), principalId: principal, scope: destinationScope }, strict),
  Type.Object({ action: actions(ENDPOINT_OPERATIONS.filter((action) => action !== "message_claim")), principalId: principal, scope: attemptScope }, strict),
]);
export const AuthorizationContextSchema = Type.Object({ principalId: principal, grants: Type.Array(ActionGrantSchema) }, strict);

export function isControlOperation(name: string): name is ControlOperation {
  return (CONTROL_OPERATIONS as readonly string[]).includes(name);
}
export function isEndpointOperation(name: string): name is EndpointOperation {
  return (ENDPOINT_OPERATIONS as readonly string[]).includes(name);
}
/** Catalog separation is a development check, not host authorization. */
export function assertOperationSeparation(): void {
  if ([...CONTROL_OPERATIONS, ...OPTIONAL_CONTROL_CAPABILITIES].some(isEndpointOperation)) {
    throw new Error("control and endpoint action catalogs overlap");
  }
}
