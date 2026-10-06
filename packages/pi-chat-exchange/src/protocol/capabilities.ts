/**
 * Capability ports (frozen v2).
 *
 * Two narrow, disjoint authorities over an exchange:
 *
 * - the CLIENT port (the requesting side of an exchange, whatever product or
 *   adapter it is reached through) may send, inspect, list, request
 *   cancellation of, and read results of its messages, and — as separate
 *   optional capabilities — normally close or administratively archive;
 * - the AGENT port (the consuming side) alone holds dispatch, lease, runtime
 *   settlement, result publication, ambiguity reconciliation, and
 *   cancellation confirmation.
 *
 * The ports are plain data contracts: authority is a literal discriminant and
 * operations are closed lists. There is deliberately no inheritance
 * framework, no shared base port, and no product name anywhere — the generic
 * future surface is `exchange_send/get/list/cancel/result`, bound per
 * adapter. Explicit close and unresolved archive are distinct optional
 * capabilities; neither is part of the base client surface.
 *
 * These are capability DECLARATIONS only: core rules remain the enforcement
 * authority at runtime, and compile-time checks are a development aid, never
 * an authorization mechanism.
 */
import type { Exchange } from "./entities.js";

export type ExchangeAuthority = "client" | "agent";

/** Authority a port declaration exercises over an {@link Exchange}. */
export type PortAuthority = ExchangeAuthority;

export const CLIENT_OPERATIONS = [
  "exchange_send",
  "exchange_get",
  "exchange_list",
  "exchange_cancel",
  "exchange_result",
] as const;

export type ClientOperation = (typeof CLIENT_OPERATIONS)[number];

/**
 * Normal close and unresolved archive are separate optional owner capabilities.
 * No control API for either is implemented in this phase.
 */
export const OPTIONAL_CLIENT_CAPABILITIES = ["exchange_close", "exchange_archive"] as const;

export type OptionalClientCapability = (typeof OPTIONAL_CLIENT_CAPABILITIES)[number];

export const AGENT_OPERATIONS = [
  "message_claim",
  "dispatch_mark_started",
  "delivery_report",
  "activity_report",
  "settlement_report",
  "result_publish",
  "lease_release",
  "ambiguity_resolve",
  "cancel_confirm",
] as const;

export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

/** Narrow client-side port contract. */
export interface ClientPort {
  readonly authority: "client";
  readonly operations: readonly ClientOperation[];
  readonly optionalCapabilities?: readonly OptionalClientCapability[];
}

/** Narrow agent-side port contract; disjoint from {@link ClientPort}. */
export interface AgentPort {
  readonly authority: "agent";
  readonly operations: readonly AgentOperation[];
}

export function isClientOperation(name: string): name is ClientOperation {
  return (CLIENT_OPERATIONS as readonly string[]).includes(name);
}

export function isAgentOperation(name: string): name is AgentOperation {
  return (AGENT_OPERATIONS as readonly string[]).includes(name);
}

/** Frozen invariant: the two ports share no operation names. */
export function assertPortDisjointness(): void {
  const overlap = CLIENT_OPERATIONS.filter((operation) => isAgentOperation(operation));
  if (overlap.length > 0) {
    throw new Error(`port ownership violation: ${overlap.join(", ")}`);
  }
  const leaked = AGENT_OPERATIONS.filter((operation) => isClientOperation(operation));
  if (leaked.length > 0) {
    throw new Error(`port ownership violation: ${leaked.join(", ")}`);
  }
  if ((OPTIONAL_CLIENT_CAPABILITIES as readonly string[]).some((capability) => isAgentOperation(capability))) {
    throw new Error("optional client capability collides with agent operations");
  }
}
