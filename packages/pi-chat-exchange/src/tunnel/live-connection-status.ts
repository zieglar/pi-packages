/** Read-only composition of transport, exact child, policy and Owner evidence.
 * No Store is opened here; the caller supplies a coherent current Owner view
 * of the fixed MCP endpoint/Store/Exchange, never another Host or acquisition.
 *
 * R1: every awaited step can race a revocation, an Owner release or a child
 * exit. The composition therefore re-validates the selected Profile, the
 * immutable binding, the current policy generation, the coherent Owner and the
 * exact child process tree AFTER each fresh nonce challenge, and it answers
 * with the state observed at that instant only. It is never a promise of
 * immediate future availability, and no stale fact is reused as readiness.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { McpBindingConfig } from "../host/mcp-binding-config.js";
import { parseTunnelProfile, type BackgroundTunnelManager } from "./background-manager.js";
import { parseTunnelMcpCommand } from "./profile.js";
import { readMessagingGeneration, readPrivateMessagingFile } from "./messaging-config.js";
import { readLivePolicy, type LivePolicyRef, type LiveReaderWatermark, type LiveSnapshot } from "./live-session-policy.js";
import type { LiveObservationOwner } from "./live-adoption-observation.js";
import { queryLiveAdoptionProbe } from "./live-adoption-probe.js";
import { verifyManagedMcpChild, type ManagedMcpChildObservationOptions, type VerifiedManagedMcpChild } from "./live-process-observation.js";

export interface LiveConnectionStatus {
  readonly policy: "OBSERVED" | "BLOCKED" | "UNVERIFIED";
  readonly transport: "CONNECTED" | "UNAVAILABLE";
}
export interface LiveConnectionObservationOptions {
  readonly profilePath: string;
  readonly manager: Pick<BackgroundTunnelManager, "observeLiveTransport">;
  readonly targetEndpointId: string;
  /** Current coherent storage status for this exact fixed MCP identity.
   * Return undefined when the caller cannot verify it. No record-supplied
   * participant IDs are trusted to select a different endpoint or Store. */
  readonly readOwner: (config: McpBindingConfig) => LiveObservationOwner | undefined;
  readonly watermark?: LiveReaderWatermark;
  readonly now?: () => string;
  readonly inspect?: ManagedMcpChildObservationOptions["inspect"];
}

type Registration = LiveSnapshot["manifest"]["registrations"][number];

const sameOwner = (a: LiveObservationOwner, b: LiveObservationOwner): boolean =>
  a.endpointId === b.endpointId && a.registered === b.registered && a.participantId === b.participantId &&
  a.sessionId === b.sessionId && a.exchangeId === b.exchangeId && a.fencingToken === b.fencingToken &&
  a.lease === b.lease && a.leaseExpiresAt !== undefined && b.leaseExpiresAt !== undefined &&
  Number.isFinite(Date.parse(a.leaseExpiresAt)) && Number.isFinite(Date.parse(b.leaseExpiresAt)) &&
  Date.parse(b.leaseExpiresAt) >= Date.parse(a.leaseExpiresAt);

const registrationOf = (snapshot: LiveSnapshot, endpointId: string): Registration | undefined =>
  snapshot.manifest.registrations.find((r) => r.endpointId === endpointId);

export async function observeLiveConnection(options: LiveConnectionObservationOptions): Promise<LiveConnectionStatus> {
  let transport: LiveConnectionStatus["transport"] = "UNAVAILABLE";
  try {
    const observeRun = async () => {
      const observed = await options.manager.observeLiveTransport();
      transport = observed.kind === "CONNECTED" ? "CONNECTED" : "UNAVAILABLE";
      return observed.kind === "CONNECTED" ? observed : undefined;
    };
    const run = await observeRun();
    if (!run) return { policy: "UNVERIFIED", transport };
    const profile = readPrivateMessagingFile(options.profilePath);
    if (!profile) return { policy: "UNVERIFIED", transport };
    const facts = parseTunnelProfile(profile.bytes.toString("utf8"));
    if (!facts.mcpCommand) return { policy: "UNVERIFIED", transport };
    const command = parseTunnelMcpCommand(facts.mcpCommand);
    const pair = readMessagingGeneration(options.profilePath, command.bindingPath, facts.keyFile);
    if (!pair || pair.config.admissionPolicy?.kind !== "ce-live-session-v1") return { policy: "UNVERIFIED", transport };
    const ref: LivePolicyRef = pair.config.admissionPolicy;
    if (!isDeepStrictEqual(pair.document, { kind: "ce-live-launch-v1", version: 1, ref })) return { policy: "UNVERIFIED", transport };
    const watermark: LiveReaderWatermark = options.watermark ?? {};
    const current = readLivePolicy(ref, { credentialFile: facts.keyFile, watermark });
    const m = current.manifest;
    const c = pair.config;
    if (m.identity.tunnelId !== facts.tunnelId || m.identity.organizationId !== (facts.organizationId ?? null) ||
      !isDeepStrictEqual(m.store, c.store) || !isDeepStrictEqual(m.exchange, c.exchange) || !isDeepStrictEqual(m.chatgptEndpoint, c.endpoint) ||
      m.mcp.payloadRead !== c.payloadRead.enabled || m.mcp.ack !== c.ack.enabled) return { policy: "UNVERIFIED", transport };
    const target = registrationOf(current, options.targetEndpointId);
    if (!target) return { policy: "UNVERIFIED", transport };
    const child = await verifyManagedMcpChild({ run, ...command, recheckRun: observeRun, ...(options.inspect ? { inspect: options.inspect } : {}) });
    if (!child) return { policy: "UNVERIFIED", transport };
    const binding = readPrivateMessagingFile(command.bindingPath, facts.keyFile);
    const selected = readPrivateMessagingFile(options.profilePath, facts.keyFile);
    if (!binding || !selected?.bytes.equals(profile.bytes)) return { policy: "UNVERIFIED", transport };
    const launchDigest = createHash("sha256").update(binding.bytes).digest("hex");
    const owner = options.readOwner(c);
    if (!owner || owner.endpointId !== c.endpoint.endpointId) return { policy: "UNVERIFIED", transport };

    const challenge = async (snapshot: LiveSnapshot, currentOwner: LiveObservationOwner) => await queryLiveAdoptionProbe({
      ref, current: snapshot, identity: { pid: child.pid, startedKey: child.startedKey },
      // Digest is over the exact immutable binding bytes, matching the launch
      // identity. The recorder must use the same bytes, not reserialized config.
      launchDigest, targetEndpointId: options.targetEndpointId, owner: currentOwner,
      ...(options.now ? { now: options.now } : {}) });

    /** Re-prove every fact after an awaited challenge. Any change is unknown. */
    const revalidate = async (): Promise<{ readonly snapshot: LiveSnapshot; readonly owner: LiveObservationOwner } | undefined> => {
      const profile2 = readPrivateMessagingFile(options.profilePath, facts.keyFile);
      const binding2 = readPrivateMessagingFile(command.bindingPath, facts.keyFile);
      if (!profile2?.bytes.equals(profile.bytes) || !binding2?.bytes.equals(binding.bytes)) return undefined;
      let snapshot: LiveSnapshot;
      try { snapshot = readLivePolicy(ref, { credentialFile: facts.keyFile, watermark }); } catch { return undefined; }
      const target2 = registrationOf(snapshot, options.targetEndpointId);
      if (!target2 || !isDeepStrictEqual(target2, target)) return undefined;
      const owner2 = options.readOwner(c);
      if (!owner2 || owner2.endpointId !== c.endpoint.endpointId) return undefined;
      if (!sameOwner(owner, owner2)) return undefined;
      const child2 = await verifyManagedMcpChild({ run, ...command, recheckRun: observeRun, ...(options.inspect ? { inspect: options.inspect } : {}) });
      if (!child2 || !sameChild(child, child2)) return undefined;
      const latest = await observeRun();
      if (!latest || latest.runId !== run.runId || latest.managedPid !== run.managedPid) return undefined;
      return { snapshot, owner: owner2 };
    };

    const first = await challenge(current, owner);
    const afterFirst = await revalidate();
    if (!afterFirst) return { policy: "UNVERIFIED", transport };
    const second = await challenge(afterFirst.snapshot, afterFirst.owner);
    const afterSecond = await revalidate();
    if (!afterSecond) return { policy: "UNVERIFIED", transport };
    if (second.kind === "UNVERIFIED" || first.kind === "UNVERIFIED") return { policy: "UNVERIFIED", transport };
    if (second.kind === "BLOCKED" || first.kind === "BLOCKED") return { policy: "BLOCKED", transport };
    const now = options.now?.() ?? new Date().toISOString();
    const lease = afterSecond.owner.lease;
    if (lease !== "ACTIVE" || !afterSecond.owner.leaseExpiresAt || Date.parse(afterSecond.owner.leaseExpiresAt) <= Date.parse(now)) {
      return { policy: "BLOCKED", transport };
    }
    return { policy: "OBSERVED", transport };
  } catch { return { policy: "UNVERIFIED", transport }; }
}

function sameChild(a: VerifiedManagedMcpChild, b: VerifiedManagedMcpChild): boolean {
  return a.pid === b.pid && a.startedKey === b.startedKey && a.command === b.command && a.runId === b.runId;
}
