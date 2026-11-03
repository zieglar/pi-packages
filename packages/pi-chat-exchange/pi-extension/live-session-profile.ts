import { isDeepStrictEqual } from "node:util";
import { parseTunnelMcpCommand } from "../dist/tunnel/profile.js";
import { parseTunnelProfile } from "../dist/tunnel/background-manager.js";
import { TunnelRefusal } from "../dist/tunnel/codes.js";
import { buildPiAllowlistDocument, readMessagingGeneration } from "../dist/tunnel/messaging-config.js";
import { readLivePolicy, type LiveSnapshot, type LiveReaderWatermark } from "../dist/tunnel/live-session-policy.js";

const credentials = new Map<string, string>();
const refKey = (snapshot: LiveSnapshot): string => JSON.stringify(snapshot.ref);
const invalid = (): never => { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.liveLaunch"); };

/** Runtime reads retain the exact selected credential exclusion and watermark. */
export function readRuntimeLivePolicy(loaded: LiveSnapshot, watermark: LiveReaderWatermark): LiveSnapshot {
  const credentialFile = credentials.get(refKey(loaded));
  if (credentialFile === undefined) return invalid();
  return readLivePolicy(loaded.ref, { watermark, credentialFile });
}

/** Read the actually selected launch generation, not a newer policy pointer. */
export function readLiveSelectedSessionPolicy(profilePath: string, text: string): LiveSnapshot | undefined {
  const facts = parseTunnelProfile(text);
  if (facts.mcpCommand === undefined) return undefined;
  const bindingPath = parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
  const pair = readMessagingGeneration(profilePath, bindingPath, facts.keyFile);
  if (pair?.config.admissionPolicy?.kind !== "ce-live-session-v1") return undefined;
  const ref = pair.config.admissionPolicy;
  const doc = pair.document;
  if (Reflect.ownKeys(doc).length !== 3 || !Object.hasOwn(doc, "kind") || !Object.hasOwn(doc, "version") || !Object.hasOwn(doc, "ref") ||
    doc.kind !== "ce-live-launch-v1" || doc.version !== 1 || !isDeepStrictEqual(doc.ref, ref)) return invalid();
  const snapshot = readLivePolicy(ref, { credentialFile: facts.keyFile });
  const m = snapshot.manifest; const c = pair.config;
  if (m.identity.tunnelId !== facts.tunnelId || m.identity.organizationId !== (facts.organizationId ?? null) ||
    !isDeepStrictEqual(m.store, c.store) || !isDeepStrictEqual(m.exchange, c.exchange) || !isDeepStrictEqual(m.chatgptEndpoint, c.endpoint) ||
    m.mcp.payloadRead !== c.payloadRead.enabled || m.mcp.ack !== c.ack.enabled ||
    c.managed !== undefined && (c.managed.tunnelId !== facts.tunnelId || (c.managed.organizationId ?? null) !== m.identity.organizationId || c.managed.adapter !== "chatgpt")) return invalid();
  credentials.set(refKey(snapshot), facts.keyFile);
  return snapshot;
}

export function projectLivePiRegistration(snapshot: LiveSnapshot, runtimeSessionId: string): Record<string, unknown> {
  const r = snapshot.manifest.registrations.find(r => r.runtimeSessionId === runtimeSessionId && r.status === "active");
  if (r === undefined) throw new Error("CE_HOST_AUTHORITY_ABSENT");
  return { ...buildPiAllowlistDocument({ chatgptEndpoint: snapshot.manifest.chatgptEndpoint,
    piEndpoint: { adapter: "pi", endpointId: r.endpointId }, piSessionId: runtimeSessionId,
    exchangeNamespace: snapshot.manifest.exchange.namespace, exchangeIdempotencyKey: snapshot.manifest.exchange.idempotencyKey,
    store: snapshot.manifest.store, payloadRead: r.payloadRead, ack: r.ack }),
    ...(r.hooks === undefined ? {} : { hooks: r.hooks }) };
}
