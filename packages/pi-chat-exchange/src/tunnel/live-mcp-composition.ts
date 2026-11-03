import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CeHostRefusal, type CeEndpointHost, type CeEndpointDiscovery, type CeLiveRecipientSnapshot } from "../host/endpoint-host.js";
import type { CeBoundEndpoint, BoundEndpointAdmission } from "../host/bound-endpoint.js";
import type { McpBindingConfig } from "../host/mcp-binding-config.js";
import type { EndpointDiscoveryResult } from "../control/mcp/endpoint-discovery.js";
import { readLivePolicy, type LivePolicyRef, type LiveReaderWatermark, type LiveSnapshot } from "./live-session-policy.js";

import type { DurableStore } from "../storage/store.js";
import { readOwnershipObservation } from "../storage/ownership.js";
import type { LiveObservationOwner } from "./live-adoption-observation.js";

const denied = (): never => { throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, "ADMISSION_POLICY_DENIED"); };

/** Launch bytes fix Store/Exchange/ChatGPT and the global ceilings. Every
 * operation consumes one typed snapshot, prepared by the Host/bound port. */
export function createLiveMcpComposition(config: McpBindingConfig, reader?: (ref: LivePolicyRef) => LiveSnapshot) {
  if (config.admissionPolicy?.kind !== "ce-live-session-v1") return denied();
  const ref = config.admissionPolicy;
  const watermark: LiveReaderWatermark = {};
  const read = reader ?? (selected => readLivePolicy(selected, { watermark }));
  const snapshot = (): LiveSnapshot => {
    let current: LiveSnapshot;
    try { current = read(ref); } catch { return denied(); }
    const m = current.manifest;
    if (!isDeepStrictEqual(m.store, config.store) || !isDeepStrictEqual(m.exchange, config.exchange) ||
      !isDeepStrictEqual(m.chatgptEndpoint, config.endpoint) || !isDeepStrictEqual(current.ref, ref) ||
      m.mcp.payloadRead !== config.payloadRead.enabled || m.mcp.ack !== config.ack.enabled ||
      config.managed !== undefined && (config.managed.tunnelId !== m.identity.tunnelId || (config.managed.organizationId ?? null) !== m.identity.organizationId)) return denied();
    return current;
  };
  const loaded = snapshot();
  const recipients = Object.freeze({ snapshot: (): CeLiveRecipientSnapshot => {
    const current = snapshot();
    const active = current.manifest.registrations.filter(r => r.status === "active");
    return Object.freeze({ recipients: Object.freeze(active.map(r => Object.freeze({ adapter: "pi", endpointId: r.endpointId }))),
      viewDigest: current.digest, presence: Object.freeze(active.map(r => Object.freeze({ endpointId: r.endpointId, disclose: r.presenceDisclosure }))) });
  } });
  const admission: BoundEndpointAdmission = (operation, prepared) => {
    // A caller without a prepared Host snapshot cannot silently reread a policy
    // and authorize a different operation. Begin/renew also use this boundary.
    if (prepared === undefined) return denied();
    // No surviving registration means no addressable recipient: every business
    // operation fails closed. Cleanup never passes through this boundary.
    if (prepared.recipients.length === 0) return denied();
    if (operation.kind === "send" && !prepared.recipients.some(r => r.endpointId === operation.to)) return denied();
    if (operation.kind === "readPayload" && !config.payloadRead.enabled || operation.kind === "ack" && !config.ack.enabled) return denied();
  };
  const hookAllowed = (rule: NonNullable<McpBindingConfig["hooks"]>[number]): boolean => {
    const current = snapshot();
    const original = loaded.manifest.registrations.find(r => r.endpointId === rule.recipient.endpointId);
    return original !== undefined && original.status === "active" && current.manifest.registrations.some(r =>
      r.endpointId === original.endpointId && r.runtimeSessionId === original.runtimeSessionId && r.status === "active" && r.epoch === original.epoch) &&
      (config.hooks ?? []).some(candidate => candidate.enabled && isDeepStrictEqual(candidate, rule));
  };
  return Object.freeze({ ref, loaded, snapshot, recipients, admission, hookAllowed });
}

/** Synchronous observation only; never renews or changes bound admission. */
export function observeLiveMcpRuntime(
  live: ReturnType<typeof createLiveMcpComposition>, host: CeEndpointHost,
  bound: CeBoundEndpoint, store: DurableStore, endpointId: string,
) {
  const snapshot = live.snapshot();
  const mapping = host.status(endpointId);
  let owner: LiveObservationOwner = { ...mapping, lease: "ABSENT", leaseExpiresAt: undefined };
  if (mapping.participantId !== undefined) {
    const observed = readOwnershipObservation(store, mapping.participantId);
    if (observed.ownership !== undefined && observed.ownership.sessionId === mapping.sessionId &&
      observed.ownership.fencingToken === mapping.fencingToken) {
      owner = { ...mapping, lease: observed.lease, leaseExpiresAt: observed.ownership.expiresAt };
    }
  }
  return { snapshot, owner, bound: bound.operationalStatus() };
}

/** Only the visible projection is hashed. Internal sequence, IDs and policy
 * digests never cross this adapter; real operational readiness remains advisory. */
export function projectEndpointDiscovery(discovery: CeEndpointDiscovery): EndpointDiscoveryResult {
  const observedAt = discovery.observedAt;
  if (!Number.isFinite(Date.parse(observedAt))) return denied();
  const state = (value: "TRUE" | "FALSE" | "UNKNOWN"): "true" | "false" | "unknown" => value === "TRUE" ? "true" : value === "FALSE" ? "false" : "unknown";
  const self = { adapter: discovery.self.adapter, endpointId: discovery.self.endpointId,
    ownCapabilities: { send: discovery.self.effective.send, inbox: true, payloadRead: discovery.self.effective.readPayload, ack: discovery.self.effective.ack } };
  const targets = discovery.targets.map(target => ({ adapter: target.adapter, endpointId: target.endpointId,
    registered: true as const, authorized: { send: true as const }, active: state(target.active),
    // Membership proves addressing only. Without exact child/run adoption and
    // remote health evidence, composition cannot claim operational reachability.
    reachable: target.reason === "PORT_BLOCKED" ? "false" as const : "unknown" as const,
    reason: target.reason === "PRESENCE_WITHHELD" ? "PRESENCE_WITHHELD" as const
      : target.reason === "PORT_BLOCKED" ? "MCP_OPERATION_BLOCKED" as const : "OBSERVATION_UNKNOWN" as const }));
  const projection = { self, targets };
  return { ...projection, observedAt, viewDigest: createHash("sha256").update(JSON.stringify(projection)).digest("hex") };
}
