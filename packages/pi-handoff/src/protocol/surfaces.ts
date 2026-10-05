/**
 * Surface ownership boundaries (frozen v1).
 *
 * The ChatGPT-facing MCP surface and the internal Pi consumer protocol are
 * disjoint by contract:
 *
 * - ChatGPT may create, inspect, list, cancel, and read results.
 * - ChatGPT may NEVER authoritatively mutate execution state: no result
 *   submission, no completion marking, no delivery acknowledgement. Those
 *   operations exist only on the internal consumer surface, reachable solely
 *   from the local Pi-side consumer.
 *
 * This module is the single source of truth for both surfaces; the contract
 * check script and tests assert the disjointness invariant.
 */

export const CHATGPT_TOOLS = [
  "handoff_create",
  "handoff_get",
  "handoff_list",
  "handoff_cancel",
  "handoff_result",
] as const;

export type ChatgptTool = (typeof CHATGPT_TOOLS)[number];

export const CONSUMER_OPERATIONS = [
  "claim_next",
  "acknowledge",
  "heartbeat",
  "report_activity",
  "settle",
  "publish_result",
  "release",
] as const;

export type ConsumerOperation = (typeof CONSUMER_OPERATIONS)[number];

/**
 * Authoritative Pi-side mutations that must never appear as ChatGPT-facing
 * MCP tools. Listed explicitly so the boundary check has a concrete, frozen
 * deny-list in addition to the disjointness assertion.
 */
export const FORBIDDEN_CHATGPT_MUTATIONS = [
  "submit_result",
  "mark_completed",
  "acknowledge_delivery",
] as const;

export function isChatgptTool(name: string): name is ChatgptTool {
  return (CHATGPT_TOOLS as readonly string[]).includes(name);
}

export function isConsumerOperation(name: string): name is ConsumerOperation {
  return (CONSUMER_OPERATIONS as readonly string[]).includes(name);
}

/** Frozen invariant: the two surfaces share no operation names. */
export function assertSurfaceDisjointness(): void {
  const overlap = CHATGPT_TOOLS.filter((tool) => isConsumerOperation(tool));
  if (overlap.length > 0) {
    throw new Error(`surface ownership violation: ${overlap.join(", ")}`);
  }
  const forbidden = CHATGPT_TOOLS.filter((tool) =>
    (FORBIDDEN_CHATGPT_MUTATIONS as readonly string[]).includes(tool),
  );
  if (forbidden.length > 0) {
    throw new Error(`ChatGPT surface exposes forbidden mutation: ${forbidden.join(", ")}`);
  }
}
