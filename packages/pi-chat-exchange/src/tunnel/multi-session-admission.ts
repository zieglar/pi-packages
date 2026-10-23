/** Deny-only runtime composition. No CE authority is created here. */
import { isDeepStrictEqual } from "node:util";
import { CeHostRefusal } from "../host/endpoint-host.js";
import type { BoundEndpointAdmission } from "../host/bound-endpoint.js";
import type { McpBindingConfig } from "../host/mcp-binding-config.js";
import { intersectMcpPolicy, readLoadedMultiSessionPolicy, readSelectedMultiSessionPolicy } from "./multi-session-policy.js";

/** Capture only verified actual launch grants. Every invocation takes a fresh
 * selected-pointer snapshot. The shared chatgpt inbox deliberately remains
 * available while any loaded registration survives; it is not partitioned by
 * the sender whose registration was later revoked. */
export function createMcpPolicyAdmission(config: McpBindingConfig, bindingPath: string): BoundEndpointAdmission | undefined {
  if (config.admissionPolicy === undefined) return undefined;
  const profilePath = config.admissionPolicy.profilePath;
  const deny = (): never => { throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, "ADMISSION_POLICY_DENIED"); };
  const loaded = readLoadedMultiSessionPolicy(profilePath, bindingPath);
  if (!isDeepStrictEqual(config, loaded.config)) deny();
  return (operation) => {
    try {
      const effective = intersectMcpPolicy(loaded, readSelectedMultiSessionPolicy(profilePath));
      if (effective.recipients.length === 0 ||
          (operation.kind === "send" && !effective.recipients.some((r) => r.endpointId === operation.to)) ||
          (operation.kind === "readPayload" && !effective.payloadRead) ||
          (operation.kind === "ack" && !effective.ack)) deny();
    } catch { deny(); }
  };
}
