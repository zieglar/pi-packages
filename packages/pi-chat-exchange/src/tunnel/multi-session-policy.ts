/** Operator configuration only: no Store, CE authority, credentials or process control.
 * The profile command selects one digest-verified immutable binding/manifest pair.
 * Runtime composition MUST apply these deny-only intersections before every operation.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import type { CeRecipientRef } from "../host/endpoint-host.js";
import { TunnelRefusal } from "./codes.js";
import { createBackgroundTunnelManager, parseTunnelProfile, type BackgroundTunnelManager } from "./background-manager.js";
import { parseTunnelMcpCommand, replaceTunnelMcpBindingPath, validateTunnelIdentity } from "./profile.js";
import { buildPiAllowlistDocument, publishMessagingGeneration, readMessagingGeneration, readMessagingPair, readPrivateMessagingFile, validMessagingStore, type MessagingPair, type MessagingPairOptions } from "./messaging-config.js";

const KIND = "ce-multi-session-v1" as const;
const invalid = (): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.multiSession");
const conflict = (): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
export interface SessionRegistration {
  readonly endpointId: string;
  readonly runtimeSessionId: string;
  readonly epoch: number;
  readonly status: "active" | "revoked";
  readonly payloadRead: boolean;
  readonly ack: boolean;
}
export interface MultiSessionManifest {
  readonly kind: typeof KIND;
  readonly version: 1;
  readonly identity: { readonly tunnelId: string; readonly organizationId: string | null };
  readonly store: McpBindingConfig["store"];
  readonly exchange: McpBindingConfig["exchange"];
  readonly chatgptEndpoint: CeRecipientRef;
  readonly mcp: { readonly payloadRead: boolean; readonly ack: boolean };
  readonly registrations: readonly SessionRegistration[];
}
export interface MultiSessionSnapshot {
  readonly profilePath: string;
  readonly revision: string;
  readonly bindingPath: string;
  readonly config: McpBindingConfig;
  readonly manifest: MultiSessionManifest;
}
export type RegistrationInput = Pick<SessionRegistration, "endpointId" | "runtimeSessionId" | "payloadRead" | "ack">;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid();
  if (Reflect.ownKeys(value).length !== keys.length) throw invalid();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !("value" in d) || !d.enumerable) throw invalid();
  }
  return value as Record<string, unknown>;
}
function label(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || /cap_[0-9a-f]{16,}/i.test(value)) throw invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function inputRegistration(raw: unknown): RegistrationInput {
  const r = object(raw, ["endpointId", "runtimeSessionId", "payloadRead", "ack"]);
  return Object.freeze({ endpointId: label(r.endpointId), runtimeSessionId: label(r.runtimeSessionId), payloadRead: bool(r.payloadRead), ack: bool(r.ack) });
}
/** Closed schema, including tombstones. Runtime IDs and stable endpoints are globally unique. */
export function parseMultiSessionManifest(raw: unknown): MultiSessionManifest {
  const r = object(raw, ["kind", "version", "identity", "store", "exchange", "chatgptEndpoint", "mcp", "registrations"]);
  if (r.kind !== KIND || r.version !== 1) throw invalid();
  const identity = object(r.identity, ["tunnelId", "organizationId"]);
  const tunnelId = label(identity.tunnelId);
  const organizationId = identity.organizationId === null ? null : label(identity.organizationId);
  validateTunnelIdentity(tunnelId, organizationId ?? undefined);
  const store = object(r.store, ["directory", "file"]);
  if (!validMessagingStore(store.directory, store.file)) throw invalid();
  const exchange = object(r.exchange, ["namespace", "idempotencyKey"]);
  const endpoint = object(r.chatgptEndpoint, ["adapter", "endpointId"]);
  if (endpoint.adapter !== "chatgpt") throw invalid();
  const endpointId = label(endpoint.endpointId);
  const mcp = object(r.mcp, ["payloadRead", "ack"]);
  if (!Array.isArray(r.registrations) || r.registrations.length === 0 || r.registrations.length > 128) throw invalid();
  const endpoints = new Set<string>([endpointId]); const sessions = new Set<string>();
  const registrations = r.registrations.map((value: unknown) => {
    const entry = object(value, ["endpointId", "runtimeSessionId", "epoch", "status", "payloadRead", "ack"]);
    const registration = inputRegistration({ endpointId: entry.endpointId, runtimeSessionId: entry.runtimeSessionId, payloadRead: entry.payloadRead, ack: entry.ack });
    if (typeof entry.epoch !== "number" || !Number.isSafeInteger(entry.epoch) || entry.epoch < 1 ||
        (entry.status !== "active" && entry.status !== "revoked") || endpoints.has(registration.endpointId) || sessions.has(registration.runtimeSessionId)) throw invalid();
    endpoints.add(registration.endpointId); sessions.add(registration.runtimeSessionId);
    return Object.freeze({ ...registration, epoch: entry.epoch, status: entry.status });
  });
  return Object.freeze({ kind: KIND, version: 1, identity: Object.freeze({ tunnelId, organizationId }),
    store: Object.freeze({ directory: store.directory as string, file: store.file as string }),
    exchange: Object.freeze({ namespace: label(exchange.namespace), idempotencyKey: label(exchange.idempotencyKey) }),
    chatgptEndpoint: Object.freeze({ adapter: "chatgpt", endpointId }),
    mcp: Object.freeze({ payloadRead: bool(mcp.payloadRead), ack: bool(mcp.ack) }), registrations: Object.freeze(registrations) });
}
const revision = (text: string): string => createHash("sha256").update(text).digest("hex");
function absolute(path: string): void { if (!isAbsolute(path) || normalize(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) throw invalid(); }
function privateDirectory(path: string): void {
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o700) throw invalid();
}
function readProfile(profilePath: string) {
  absolute(profilePath);
  const selected = readPrivateMessagingFile(profilePath);
  if (selected === undefined) throw invalid();
  const text = selected.bytes.toString("utf8");
  const facts = parseTunnelProfile(text);
  if (facts.mcpCommand === undefined) throw invalid();
  const bindingPath = parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
  return { text, facts, bindingPath, revision: revision(text) };
}
function checkPair(profilePath: string, pair: MessagingPair, manifest: MultiSessionManifest): void {
  const c = pair.config;
  const recipients = manifest.registrations.filter((r) => r.status === "active").map((r) => ({ adapter: "pi", endpointId: r.endpointId }));
  if (c.admissionPolicy?.kind !== KIND || c.admissionPolicy.profilePath !== profilePath ||
      !isDeepStrictEqual(c.store, manifest.store) || !isDeepStrictEqual(c.exchange, manifest.exchange) ||
      !isDeepStrictEqual(c.endpoint, manifest.chatgptEndpoint) || !isDeepStrictEqual(c.recipients, recipients) ||
      c.payloadRead.enabled !== manifest.mcp.payloadRead || c.ack.enabled !== manifest.mcp.ack) throw invalid();
}
/** READ is the linearization point, conditional on successful verification of
 * THIS selected generation. No second pointer read, cancellation or transaction-
 * atomic revocation is claimed. Capture afresh for EACH admitted operation;
 * never cache/reuse a capture as the current policy for later operations.
 * The closure permits deterministic overlap tests. */
export function captureSelectedMultiSessionPolicy(profilePath: string): () => MultiSessionSnapshot {
  const selected = readProfile(profilePath);
  return () => verifyGeneration(profilePath, selected, selected.bindingPath);
}
/** Read the generation paired with the actual launch binding, NOT the latest
 * grants. Composition must compare its parsed launch config to snapshot.config
 * and retain this loaded snapshot until explicit reload. */
export function readLoadedMultiSessionPolicy(profilePath: string, bindingPath: string): MultiSessionSnapshot {
  return verifyGeneration(profilePath, readProfile(profilePath), bindingPath);
}
function verifyGeneration(profilePath: string, selected: ReturnType<typeof readProfile>, bindingPath: string): MultiSessionSnapshot {
  try {
    privateDirectory(join(dirname(profilePath), ".ce-bindings"));
    const pair = readMessagingGeneration(profilePath, bindingPath, selected.facts.keyFile);
    if (pair === undefined) throw invalid();
    const manifest = parseMultiSessionManifest(pair.document);
    if (manifest.identity.tunnelId !== selected.facts.tunnelId || manifest.identity.organizationId !== (selected.facts.organizationId ?? null)) throw invalid();
    checkPair(profilePath, pair, manifest);
    return Object.freeze({ profilePath, revision: selected.revision, bindingPath, config: pair.config, manifest });
  } catch { throw invalid(); }
}
export function readSelectedMultiSessionPolicy(profilePath: string): MultiSessionSnapshot { return captureSelectedMultiSessionPolicy(profilePath)(); }
function sameIdentity(a: MultiSessionSnapshot, b: MultiSessionSnapshot): boolean {
  return a.profilePath === b.profilePath && isDeepStrictEqual(a.manifest.identity, b.manifest.identity) &&
    isDeepStrictEqual(a.manifest.store, b.manifest.store) && isDeepStrictEqual(a.manifest.exchange, b.manifest.exchange) &&
    isDeepStrictEqual(a.manifest.chatgptEndpoint, b.manifest.chatgptEndpoint);
}
/** Only narrows loaded grants. A generation digest change alone never denies unchanged A. */
export function intersectRegistration(loaded: MultiSessionSnapshot, current: MultiSessionSnapshot, runtimeSessionId: string): SessionRegistration {
  if (!sameIdentity(loaded, current)) throw invalid();
  const a = loaded.manifest.registrations.find((r) => r.runtimeSessionId === runtimeSessionId);
  const b = current.manifest.registrations.find((r) => r.runtimeSessionId === runtimeSessionId);
  if (a === undefined || b === undefined || a.status !== "active" || b.status !== "active" || a.endpointId !== b.endpointId || a.epoch !== b.epoch) throw invalid();
  return Object.freeze({ ...a, payloadRead: a.payloadRead && b.payloadRead, ack: a.ack && b.ack });
}
/** Exact loaded MCP recipient allowlist, narrowed by current registration/epoch.
 * Callers must additionally intersect loaded/current global read and ACK opt-ins. */
export function intersectMcpRecipients(loaded: MultiSessionSnapshot, current: MultiSessionSnapshot): readonly CeRecipientRef[] {
  if (!sameIdentity(loaded, current)) throw invalid();
  return Object.freeze(loaded.config.recipients.filter((ref) => {
    const registration = loaded.manifest.registrations.find((r) => r.endpointId === ref.endpointId);
    if (registration === undefined) return false;
    try { intersectRegistration(loaded, current, registration.runtimeSessionId); return true; } catch { return false; }
  }));
}
/** Complete MCP global grant intersection, still not CE authority. */
export function intersectMcpPolicy(loaded: MultiSessionSnapshot, current: MultiSessionSnapshot): {
  readonly recipients: readonly CeRecipientRef[]; readonly payloadRead: boolean; readonly ack: boolean;
} {
  return Object.freeze({ recipients: intersectMcpRecipients(loaded, current),
    payloadRead: loaded.config.payloadRead.enabled && current.config.payloadRead.enabled,
    ack: loaded.config.ack.enabled && current.config.ack.enabled });
}
/** New-mode per-Pi projection: NEVER feed the complete registration set to one Host. */
export function projectPiRegistration(snapshot: MultiSessionSnapshot, runtimeSessionId: string): Record<string, unknown> {
  const r = intersectRegistration(snapshot, snapshot, runtimeSessionId);
  return buildPiAllowlistDocument({ chatgptEndpoint: snapshot.manifest.chatgptEndpoint, piEndpoint: { adapter: "pi", endpointId: r.endpointId },
    piSessionId: r.runtimeSessionId, exchangeNamespace: snapshot.manifest.exchange.namespace, exchangeIdempotencyKey: snapshot.manifest.exchange.idempotencyKey,
    store: snapshot.manifest.store, payloadRead: r.payloadRead, ack: r.ack });
}
export interface MultiSessionRegistrationOptions {
  readonly profilePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly manager?: Pick<BackgroundTunnelManager, "withProfileConfigurationLock">;
  readonly io?: MessagingPairOptions["io"] & Partial<Pick<typeof fs, "renameSync">>;
}
export interface PublicationResult { readonly kind: "saved"; readonly revision: string; readonly durability: "synced" | "uncertain"; readonly bindingPath: string; }
/** Every conversion/register/revoke publication uses the existing STOPPED-only
 * transport lock. It never starts/stops transport and never reads credentials. */
export function createMultiSessionRegistration(options: MultiSessionRegistrationOptions) {
  const { profilePath } = options; absolute(profilePath);
  const manager = options.manager ?? createBackgroundTunnelManager({ env: options.env ?? {}, profilePath });
  const io = { openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync,
    linkSync: fs.linkSync, renameSync: fs.renameSync, ...options.io };
  const publish = (expectedRevision: string, transform: (selected: ReturnType<typeof readProfile>) => { manifest: MultiSessionManifest; config: McpBindingConfig }): Promise<PublicationResult> => manager.withProfileConfigurationLock((guard) => {
    try {
      if (guard.profilePath !== profilePath) throw invalid();
      const selected = readProfile(profilePath);
      if (selected.revision !== expectedRevision) throw conflict();
      const next = transform(selected);
      const manifest = parseMultiSessionManifest(next.manifest);
      const config = parseMcpBindingConfig({ version: 1, ...next.config, admissionPolicy: { kind: KIND, profilePath },
        recipients: manifest.registrations.filter((r) => r.status === "active").map((r) => ({ adapter: "pi", endpointId: r.endpointId })) });
      const pair = publishMessagingGeneration(profilePath, config, { ...manifest }, { io, credentialFile: selected.facts.keyFile });
      checkPair(profilePath, pair, manifest);
      if (pair.durability !== "synced") throw invalid(); // candidates retained, pointer unchanged
      const command = replaceTunnelMcpBindingPath(selected.facts.mcpCommand!, pair.bindingPath);
      const text = selected.text.replace(/^(      command:[ ]*)"[^"]*"([ ]*)$/m, (_line, prefix: string, suffix: string) => `${prefix}"${command}"${suffix}`);
      if (text === selected.text) {
        guard.assertIntact();
        if (readProfile(profilePath).revision !== expectedRevision) throw conflict();
        return { kind: "saved", revision: selected.revision, bindingPath: pair.bindingPath, durability: "synced" };
      }
      if (Buffer.byteLength(text) > 65_536) throw invalid();
      const facts = parseTunnelProfile(text);
      if (facts.mcpCommand !== command) throw invalid();
      const temporary = `${profilePath}.${randomUUID()}.tmp`;
      const fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o600) throw invalid();
        io.writeFileSync(fd, text, "utf8"); io.fsyncSync(fd);
      } finally { io.closeSync(fd); }
      const directory = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        io.fsyncSync(directory);
        guard.assertIntact();
        if (readProfile(profilePath).revision !== expectedRevision) throw conflict();
        // A throwing rename may have taken effect. Never describe this as a
        // rollback or retry automatically; retain both generations for reconciliation.
        try { io.renameSync(temporary, profilePath); } // sole activation commit
        catch { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.multiSession.commitUncertain"); }
        let durability: "synced" | "uncertain" = "synced";
        try { io.fsyncSync(directory); } catch { durability = "uncertain"; }
        return { kind: "saved", revision: revision(text), bindingPath: pair.bindingPath, durability };
      } finally { try { io.closeSync(directory); } catch { /* no postcommit rollback */ } }
    } catch (error) { if (error instanceof TunnelRefusal) throw error; throw invalid(); }
  });
  return {
    revision: (): string => readProfile(profilePath).revision,
    convert: (input: { readonly expectedRevision: string; readonly confirm: true }): Promise<PublicationResult> => publish(input.expectedRevision, (selected) => {
      if (input.confirm !== true) throw invalid();
      const pair = readMessagingPair(profilePath, selected.bindingPath, selected.facts.keyFile);
      if (pair === undefined || pair.config.admissionPolicy !== undefined) throw invalid();
      const doc = object(pair.document, ["exchangeNamespace", "exchangeIdempotencyKey", "leaseTtlSeconds", "payloadRead", "ack", "store", "recipients", "sessions", "managedBy"]);
      const sessions = doc.sessions;
      if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions) || Object.keys(sessions).length !== 1) throw invalid();
      const [runtimeSessionId, value] = Object.entries(sessions)[0]!;
      const mapping = object(value, ["endpointId"]);
      const registration = inputRegistration({ endpointId: mapping.endpointId, runtimeSessionId, payloadRead: pair.config.payloadRead.enabled, ack: pair.config.ack.enabled });
      const expected = { ...buildPiAllowlistDocument({ chatgptEndpoint: pair.config.endpoint, piEndpoint: { adapter: "pi", endpointId: registration.endpointId },
        piSessionId: runtimeSessionId, store: pair.config.store, exchangeNamespace: pair.config.exchange.namespace, exchangeIdempotencyKey: pair.config.exchange.idempotencyKey,
        payloadRead: registration.payloadRead, ack: registration.ack }), managedBy: { kind: "ce-tunnel-messaging-v1", profilePath } };
      if (!isDeepStrictEqual(expected, doc) || pair.config.recipients.length !== 1 || pair.config.recipients[0]!.adapter !== "pi" || pair.config.recipients[0]!.endpointId !== registration.endpointId) throw invalid();
      return { config: pair.config, manifest: { kind: KIND, version: 1, identity: { tunnelId: selected.facts.tunnelId, organizationId: selected.facts.organizationId ?? null },
        store: pair.config.store, exchange: pair.config.exchange, chatgptEndpoint: pair.config.endpoint,
        mcp: { payloadRead: pair.config.payloadRead.enabled, ack: pair.config.ack.enabled }, registrations: [{ ...registration, epoch: 1, status: "active" }] } };
    }),
    register: (input: { readonly expectedRevision: string; readonly registration: RegistrationInput }): Promise<PublicationResult> => publish(input.expectedRevision, () => {
      const current = readSelectedMultiSessionPolicy(profilePath);
      const r = inputRegistration(input.registration);
      const old = current.manifest.registrations.find((entry) => entry.endpointId === r.endpointId);
      if (current.manifest.registrations.some((entry) => entry.runtimeSessionId === r.runtimeSessionId && entry.endpointId !== r.endpointId) || (old !== undefined && old.runtimeSessionId !== r.runtimeSessionId)) throw invalid();
      const registration: SessionRegistration = { ...r, epoch: old === undefined ? 1 : old.status === "revoked" ? old.epoch + 1 : old.epoch, status: "active" };
      const registrations = old === undefined ? [...current.manifest.registrations, registration] : current.manifest.registrations.map((entry) => entry === old ? registration : entry);
      return { config: current.config, manifest: { ...current.manifest, registrations } };
    }),
    revoke: (input: { readonly expectedRevision: string; readonly endpointId: string }): Promise<PublicationResult> => publish(input.expectedRevision, () => {
      const current = readSelectedMultiSessionPolicy(profilePath);
      const old = current.manifest.registrations.find((r) => r.endpointId === input.endpointId);
      if (old === undefined || old.status !== "active") throw invalid();
      return { config: current.config, manifest: { ...current.manifest, registrations: current.manifest.registrations.map((r) => r === old ? { ...r, status: "revoked" } : r) } };
    }),
  };
}
