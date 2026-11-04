/**
 * HANDOFF-CE-HOOKS-MANAGEMENT-01 — native Hook configuration orchestration.
 *
 * This module is CONFIGURATION ONLY. It never loads a Host, never starts or
 * stops a transport, never reads a credential value and never executes a
 * configured Hook command. It writes two private, operator-owned artifacts:
 *
 * - the versioned live chain (through the existing expected-tip publisher), and
 * - the selected immutable MCP binding pair plus the Profile pointer.
 *
 * Both are separate commit boundaries. A chain publication that cannot be
 * observed afterwards is reported as pending; it is never retried, rebased or
 * rolled back here.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parseHookRules, type CeHookRule } from "../hooks/config.js";
import { parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import { parseTunnelProfile, type BackgroundTunnelManager } from "./background-manager.js";
import { TunnelRefusal } from "./codes.js";
import { parseTunnelMcpCommand, replaceTunnelMcpBindingPath } from "./profile.js";
import { publishMessagingGeneration, readMessagingGeneration, readPrivateMessagingFile, type MessagingPairOptions } from "./messaging-config.js";
import { createLivePolicyRegistration, prepareLivePolicyUpgrade, readLiveHookPublication, readLivePolicy, type LivePolicyRef, type LiveSnapshot, type LivePublication } from "./live-session-policy.js";

const invalid = (field = "hooks.management"): never => { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field); };
const conflict = (): never => { throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "hooks.preview"); };
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const MAX_PROFILE_BYTES = 65_536;

/** The v2 chain API the core policy module publishes. It is optional at
 * runtime so this configuration surface fails closed instead of pretending a
 * Hook grant exists while the v2 reader/writer is unavailable. */
interface LiveHookApi {
  upgrade(input: { readonly expectedDigest: string; readonly actorRuntimeSessionId: string; readonly profileRevision: string; readonly bindingGeneration: string; readonly operationId?: string }): LivePublication;
  setPiHooks(input: { readonly expectedDigest: string; readonly runtimeSessionId: string; readonly endpointId: string; readonly epoch: number; readonly hooks: readonly CeHookRule[]; readonly operationId?: string }): LivePublication;
  setMcpHooks(input: { readonly expectedDigest: string; readonly actorRuntimeSessionId: string; readonly bindingGeneration: string; readonly targets: readonly HookTarget[]; readonly operationId?: string }): LivePublication;
}
export type HookEdit =
  | { readonly kind: "add"; readonly rule: unknown }
  | { readonly kind: "edit"; readonly id: string; readonly rule: unknown }
  | { readonly kind: "enable" | "disable" | "remove"; readonly id: string };

/** Pure candidate edit. The input array is never mutated. */
export function replaceHookRule(rules: readonly CeHookRule[], edit: HookEdit): readonly CeHookRule[] {
  if (edit.kind === "add") return parseHookRules([...rules, edit.rule]);
  if (!rules.some(rule => rule.id === edit.id)) return invalid("hooks.rule.missing");
  if (edit.kind === "remove") return parseHookRules(rules.filter(rule => rule.id !== edit.id));
  return parseHookRules(rules.map(rule => rule.id !== edit.id ? rule
    : edit.kind === "edit" ? edit.rule : { ...rule, enabled: edit.kind === "enable" }));
}

export interface HookTarget {
  readonly ruleId: string;
  readonly endpointId: string;
  readonly runtimeSessionId: string;
  readonly epoch: number;
}
export interface HooksPreview {
  readonly kind: "pi" | "mcp" | "upgrade" | "continuation";
  readonly continuation?: { readonly bindingPath: string; readonly operationId: string; readonly publicationKind: "upgrade" | "set-mcp-hooks"; readonly sequence: number };
  readonly profilePath: string;
  readonly profileRevision: string;
  readonly expectedDigest: string;
  readonly runtimeSessionId: string;
  readonly ref: LivePolicyRef;
  readonly config: McpBindingConfig;
  readonly document: Record<string, unknown>;
  readonly hooks: readonly CeHookRule[];
  readonly targets: readonly HookTarget[];
  readonly bindingGeneration: string;
}
export interface HooksSaveResult {
  /** Configuration was written. */
  readonly configured: boolean;
  /** A live process adopted the new configuration. Never implied by saving. */
  readonly adopted: false;
  /** The configuration is executable under current consent. Never implied. */
  readonly eligible: false;
  /** A Hook command ran. Never implied by saving. */
  readonly executed: false;
  readonly selection: "unchanged" | "selected" | "pending";
  readonly policyDurability: "synced" | "uncertain" | "unknown";
  readonly profileDurability: "synced" | "uncertain" | "not-attempted";
  readonly operationId: string;
  readonly bindingPath?: string;
  readonly detail?: string;
}
export interface HooksManagementOptions {
  readonly profilePath: string;
  /** The real manager: its STOPPED Profile configuration lock is the only authority. */
  readonly manager: Pick<BackgroundTunnelManager, "withProfileConfigurationLock">;
  /** The trusted native Session that owns this configuration surface. */
  readonly runtimeSessionId: string;
  /** Revalidate native Session, environment, cancellation and selected Profile. */
  readonly assertCurrent: () => void;
  readonly io?: MessagingPairOptions["io"] & Partial<Pick<typeof fs, "renameSync">>;
}

/** The immutable pair identity: exactly the bytes the writer will publish. */
function pairGeneration(config: McpBindingConfig, document: Record<string, unknown>): string {
  const binding = `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`;
  const sidecar = `${JSON.stringify(document, null, 2)}\n`;
  return createHash("sha256").update(binding).update("\u0000").update(sidecar).digest("hex");
}

/** Live routing follows active history, including peers registered after launch.
 * Static binding recipients do not enumerate v2 Hook targets. */
function targetsFor(snapshot: LiveSnapshot, hooks: readonly CeHookRule[]): readonly HookTarget[] {
  return Object.freeze(hooks.filter(rule => rule.enabled).map(rule => {
    if (rule.recipient.adapter !== "pi") return invalid("hooks.target.recipient");
    const registration = snapshot.manifest.registrations.find(r => r.status === "active" && r.endpointId === rule.recipient.endpointId);
    if (!registration) return invalid("hooks.target.active");
    return Object.freeze({ ruleId: rule.id, endpointId: registration.endpointId, runtimeSessionId: registration.runtimeSessionId, epoch: registration.epoch });
  }));
}

export function createHooksManagement(options: HooksManagementOptions) {
  const { profilePath, runtimeSessionId } = options;
  // A preview is a local one-shot handle. No JSON, model or MCP input is a grant.
  const previews = new WeakMap<HooksPreview, { fingerprint: string; text: string; credentialFile: string }>();
  const io = { openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, ...options.io };

  function inspect() {
    options.assertCurrent();
    const bytes = readPrivateMessagingFile(profilePath)?.bytes ?? invalid("hooks.profile");
    const text = bytes.toString("utf8");
    const facts = parseTunnelProfile(text);
    if (!facts.mcpCommand) return invalid("hooks.profile.command");
    const bindingPath = parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
    const pair = readMessagingGeneration(profilePath, bindingPath, facts.keyFile) ?? invalid("hooks.binding");
    const ref = pair.config.admissionPolicy;
    if (!ref || (ref.kind !== "ce-live-session-v1" && ref.kind !== "ce-live-session-v2")) return invalid("hooks.live.required");
    if (Reflect.ownKeys(pair.document).length !== 3 || !isDeepStrictEqual(pair.document.ref, ref) || pair.document.version !== 1 || pair.document.kind !== (ref.kind === "ce-live-session-v1" ? "ce-live-launch-v1" : "ce-live-launch-v2")) return invalid("hooks.launch");
    if (ref.kind === "ce-live-session-v2" && ref.profilePath !== profilePath) return invalid("hooks.profile.selection");
    const snapshot = readLivePolicy(ref, { credentialFile: facts.keyFile });
    const m = snapshot.manifest;
    const c = pair.config;
    if (m.identity.tunnelId !== facts.tunnelId || m.identity.organizationId !== (facts.organizationId ?? null) ||
      !isDeepStrictEqual(m.store, c.store) || !isDeepStrictEqual(m.exchange, c.exchange) ||
      !isDeepStrictEqual(m.chatgptEndpoint, c.endpoint) || m.mcp.payloadRead !== c.payloadRead.enabled || m.mcp.ack !== c.ack.enabled) return invalid("hooks.identity");
    if (c.managed !== undefined && (c.managed.tunnelId !== facts.tunnelId || (c.managed.organizationId ?? null) !== m.identity.organizationId || c.managed.adapter !== "chatgpt")) return invalid("hooks.identity");
    const own = snapshot.manifest.registrations.find(r => r.status === "active" && r.runtimeSessionId === runtimeSessionId);
    return { text, revision: hash(bytes), facts, pair, snapshot, bindingPath, piHooks: own?.hooks ?? [], mcpHooks: pair.config.hooks ?? [] };
  }

  function capture(kind: "pi" | "mcp" | "upgrade", raw?: unknown): HooksPreview {
    const selected = inspect();
    const { snapshot } = selected;
    if (kind === "upgrade" ? snapshot.ref.kind !== "ce-live-session-v1" : snapshot.ref.kind !== "ce-live-session-v2") return invalid("hooks.explicitUpgradeRequired");
    const hooks = kind === "upgrade" ? selected.mcpHooks : parseHookRules(raw);
    if (kind === "pi") {
      if (!snapshot.manifest.registrations.some(r => r.status === "active" && r.runtimeSessionId === runtimeSessionId)) return invalid("hooks.currentSession");
      // Outbound Hooks address the ChatGPT peer of THIS registration only.
      if (hooks.some(rule => !isDeepStrictEqual(rule.recipient, snapshot.manifest.chatgptEndpoint))) return invalid("hooks.pi.recipient");
    }
    const ref = kind === "upgrade" && snapshot.ref.kind === "ce-live-session-v1" ? prepareLivePolicyUpgrade(snapshot.ref, profilePath) : snapshot.ref;
    const config = parseMcpBindingConfig({ version: 1, ...selected.pair.config, admissionPolicy: ref, ...(kind === "mcp" ? { hooks } : {}) });
    const document = { kind: ref.kind === "ce-live-session-v2" ? "ce-live-launch-v2" : "ce-live-launch-v1", version: 1, ref };
    const targets = kind === "mcp" ? targetsFor(snapshot, hooks) : Object.freeze([]);
    const candidate: HooksPreview = Object.freeze({ kind, profilePath, profileRevision: selected.revision, expectedDigest: snapshot.digest, runtimeSessionId, ref, config, document, hooks, targets, bindingGeneration: pairGeneration(config, document) });
    previews.set(candidate, { fingerprint: JSON.stringify(candidate), text: selected.text, credentialFile: selected.facts.keyFile });
    return candidate;
  }

  function previewContinuation(input: { readonly bindingPath: string; readonly operationId: string }): HooksPreview {
    options.assertCurrent();
    const bytes = readPrivateMessagingFile(profilePath)?.bytes ?? invalid("hooks.profile");
    const text = bytes.toString("utf8"); const revision = hash(bytes);
    const facts = parseTunnelProfile(text);
    if (!facts.mcpCommand) return invalid("hooks.profile.command");
    const selectedPath = parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
    const selected = readMessagingGeneration(profilePath, selectedPath, facts.keyFile) ?? invalid("hooks.binding");
    const pair = readMessagingGeneration(profilePath, input.bindingPath, facts.keyFile) ?? invalid("hooks.continuation.pair");
    const ref = pair.config.admissionPolicy; const priorRef = selected.config.admissionPolicy;
    if (ref?.kind !== "ce-live-session-v2" || ref.profilePath !== profilePath || !priorRef || priorRef.kind === "ce-multi-session-v1") return invalid("hooks.continuation.ref");
    for (const [document, r] of [[pair.document, ref], [selected.document, priorRef]] as const) {
      if (Reflect.ownKeys(document).length !== 3 || document.version !== 1 || !isDeepStrictEqual(document.ref, r) || document.kind !== (r.kind === "ce-live-session-v2" ? "ce-live-launch-v2" : "ce-live-launch-v1")) return invalid("hooks.launch");
    }
    if (priorRef.root !== ref.root || priorRef.policyId !== ref.policyId || priorRef.genesisDigest !== ref.genesisDigest || priorRef.kind === "ce-live-session-v2" && !isDeepStrictEqual(priorRef, ref)) return invalid("hooks.continuation.history");
    const bindingGeneration = basename(input.bindingPath).match(/^messaging-([a-f0-9]{64})\.yaml$/)?.[1] ?? invalid("hooks.continuation.generation");
    const evidence = readLiveHookPublication({ ref, runtimeSessionId, operationId: input.operationId, credentialFile: facts.keyFile });
    if (evidence.intent.bindingGeneration !== bindingGeneration) return invalid("hooks.continuation.operation");
    const snapshot = readLivePolicy(ref, { credentialFile: facts.keyFile });
    const m = snapshot.manifest;
    // Only Hooks and the explicit format reference may differ from the selected
    // binding. Sender identity, routing and global ceilings are immutable here.
    const { hooks: _candidateHooks, admissionPolicy: _candidateRef, ...candidateFixed } = pair.config;
    const { hooks: _selectedHooks, admissionPolicy: _selectedRef, ...selectedFixed } = selected.config;
    if (!isDeepStrictEqual(candidateFixed, selectedFixed) || !isDeepStrictEqual(m.store, pair.config.store) || !isDeepStrictEqual(m.exchange, pair.config.exchange) || !isDeepStrictEqual(m.chatgptEndpoint, pair.config.endpoint) || m.mcp.payloadRead !== pair.config.payloadRead.enabled || m.mcp.ack !== pair.config.ack.enabled || m.identity.tunnelId !== facts.tunnelId || m.identity.organizationId !== (facts.organizationId ?? null)) return invalid("hooks.continuation.identity");
    if (pair.config.managed && (pair.config.managed.adapter !== "chatgpt" || pair.config.managed.tunnelId !== facts.tunnelId || (pair.config.managed.organizationId ?? null) !== m.identity.organizationId)) return invalid("hooks.continuation.identity");
    const hooks = pair.config.hooks ?? [];
    let targets: readonly HookTarget[] = [];
    if (evidence.intent.kind === "upgrade") {
      if (evidence.sequence !== ref.upgradeSequence || priorRef.kind === "ce-live-session-v1" && evidence.intent.profileRevision !== revision) return invalid("hooks.continuation.upgrade");
      if (selectedPath !== input.bindingPath && priorRef.kind !== "ce-live-session-v1") return invalid("hooks.continuation.upgradeSelection");
      if (!isDeepStrictEqual(selected.config.hooks, pair.config.hooks)) return invalid("hooks.continuation.upgradeHooks");
      if (snapshot.manifest.mcpHookConsent?.generation !== evidence.sequence || snapshot.manifest.mcpHookConsent.bindingGeneration !== null) return invalid("hooks.continuation.superseded");
    } else {
      if (priorRef.kind !== "ce-live-session-v2") return invalid("hooks.continuation.senderRef");
      targets = targetsFor(snapshot, hooks);
      const consent = m.mcpHookConsent;
      if (!consent || consent.generation !== evidence.sequence || consent.bindingGeneration !== bindingGeneration || !isDeepStrictEqual(consent.targets, evidence.intent.targets) || !isDeepStrictEqual(targets, evidence.intent.targets)) return invalid("hooks.continuation.scope");
    }
    const candidate: HooksPreview = Object.freeze({ kind: "continuation", profilePath, profileRevision: revision, expectedDigest: snapshot.digest, runtimeSessionId, ref, config: pair.config, document: pair.document, hooks, targets,
      bindingGeneration, continuation: Object.freeze({ bindingPath: input.bindingPath, operationId: input.operationId, publicationKind: evidence.intent.kind, sequence: evidence.sequence }) });
    previews.set(candidate, { fingerprint: JSON.stringify(candidate), text, credentialFile: facts.keyFile });
    return candidate;
  }

  function hookApi(ref: LivePolicyRef, credentialFile: string): LiveHookApi {
    const api = createLivePolicyRegistration({ ref, credentialFile, ...(options.io === undefined ? {} : { io: options.io }) });
    if (typeof api.upgrade !== "function" || typeof api.setPiHooks !== "function" || typeof api.setMcpHooks !== "function") return invalid("hooks.v2Unavailable");
    return api;
  }

  async function save(candidate: HooksPreview, confirmed: boolean, signal?: AbortSignal): Promise<HooksSaveResult> {
    const assertCurrent = (): void => {
      if (signal?.aborted) return invalid("hooks.cancelled");
      options.assertCurrent();
    };
    const captured = previews.get(candidate);
    if (confirmed !== true || !captured || captured.fingerprint !== JSON.stringify(candidate)) return invalid("hooks.nativeConfirmation");
    previews.delete(candidate);
    assertCurrent();
    const operationId = candidate.continuation?.operationId ?? randomUUID();
    const base = { adopted: false, eligible: false, executed: false, operationId } as const;

    const perform = (guard?: { readonly profilePath: string; assertIntact(): void }): HooksSaveResult => {
      assertCurrent();
      if (captured.fingerprint !== JSON.stringify(candidate)) return conflict();
      if (candidate.kind === "continuation") {
        if (!guard || guard.profilePath !== profilePath || !candidate.continuation) return invalid("hooks.continuation.lock");
        const verify = (): void => {
          assertCurrent(); guard.assertIntact();
          const checked = previewContinuation(candidate.continuation!);
          if (JSON.stringify(checked) !== captured.fingerprint || readPrivateMessagingFile(profilePath)?.bytes.toString("utf8") !== captured.text) return conflict();
        };
        verify();
        const bindingPath = candidate.continuation.bindingPath;
        const result = { ...base, configured: true, policyDurability: "synced" as const, bindingPath };
        const facts = parseTunnelProfile(captured.text);
        const command = facts.mcpCommand ?? invalid("hooks.profile.command");
        if (parseTunnelMcpCommand(command).bindingPath === bindingPath) return { ...result, selection: "unchanged", policyDurability: "unknown", profileDurability: "not-attempted", detail: "exact selected bytes observed; historical durability is not inferred" };
        // Publication staged file data was synced before the exclusive link.
        // Re-establish the directory durability boundary after a lost result;
        // this never links a slot, issues an intent or rewrites history.
        try {
          const policyDirectory = io.openSync(candidate.ref.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try { io.fsyncSync(policyDirectory); } finally { io.closeSync(policyDirectory); }
        } catch { return { ...result, selection: "pending", policyDurability: "uncertain", profileDurability: "not-attempted", detail: "published policy directory durability uncertain" }; }
        verify();
        const quoted = `"${command}"`;
        if (captured.text.split(quoted).length !== 2) return invalid("hooks.profile.command");
        const next = captured.text.replace(quoted, `"${replaceTunnelMcpBindingPath(command, bindingPath)}"`);
        if (Buffer.byteLength(next) > MAX_PROFILE_BYTES) return invalid("hooks.profile.size");
        parseTunnelProfile(next);
        try {
          const temporary = `${profilePath}.${randomUUID()}.tmp`;
          const fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          try { io.writeFileSync(fd, next, "utf8"); io.fsyncSync(fd); } finally { io.closeSync(fd); }
          const directory = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try {
            io.fsyncSync(directory); verify();
            try { io.renameSync(temporary, profilePath); }
            catch { return { ...result, selection: "pending", profileDurability: "uncertain", detail: "continuation rename outcome unknown; reconcile explicitly" }; }
            try { io.fsyncSync(directory); }
            catch { return { ...result, selection: "pending", profileDurability: "uncertain" }; }
            return { ...result, selection: "selected", profileDurability: "synced" };
          } finally { try { io.closeSync(directory); } catch { /* no rollback */ } }
        } catch (error) {
          if (error instanceof TunnelRefusal && error.code === "CE_TUNNEL_CONFIG_CONFLICT") throw error;
          return { ...result, selection: "pending", profileDurability: "not-attempted", detail: "published configuration retained; continuation refused before rename" };
        }
      }
      const current = inspect();
      // The candidate is bound to the exact Profile bytes and chain tip it showed.
      if (current.text !== captured.text || current.revision !== candidate.profileRevision || current.snapshot.digest !== candidate.expectedDigest) return conflict();
      if (guard && guard.profilePath !== profilePath) return invalid("hooks.profile.lock");
      guard?.assertIntact();
      if (candidate.kind === "mcp" && !isDeepStrictEqual(targetsFor(current.snapshot, candidate.hooks), candidate.targets)) return conflict();
      const api = hookApi(candidate.ref, captured.credentialFile);

      // Stage the exact immutable candidate pair BEFORE any consent publication.
      let bindingPath: string | undefined;
      if (candidate.kind !== "pi") {
        const staged = publishMessagingGeneration(profilePath, candidate.config, candidate.document, { credentialFile: captured.credentialFile, ...(options.io === undefined ? {} : { io: options.io }) });
        bindingPath = staged.bindingPath;
        if (basename(bindingPath) !== `messaging-${candidate.bindingGeneration}.yaml`) return invalid("hooks.candidate.bytes");
        const verified = readMessagingGeneration(profilePath, bindingPath, captured.credentialFile);
        if (!verified || !isDeepStrictEqual(verified.config, candidate.config) || !isDeepStrictEqual(verified.document, candidate.document)) return invalid("hooks.candidate.bytes");
        if (staged.durability !== "synced") return { ...base, configured: false, selection: "pending", policyDurability: "unknown", profileDurability: "not-attempted", bindingPath, detail: "candidate pair durability uncertain; no consent published" };
      }

      assertCurrent();
      guard?.assertIntact();
      if (captured.fingerprint !== JSON.stringify(candidate) || readPrivateMessagingFile(profilePath)?.bytes.toString("utf8") !== captured.text) return conflict();

      let publication: LivePublication;
      try {
        if (candidate.kind === "upgrade") {
          const legacy = createLivePolicyRegistration({ ref: current.snapshot.ref, credentialFile: captured.credentialFile });
          // Tombstones remain in the manifest, so every legacy actor namespace
          // can be reconciled before publishing the marker.
          const actors = new Set([runtimeSessionId, ...current.snapshot.manifest.registrations.map(r => r.runtimeSessionId)]);
          for (const actor of actors) {
            const pending = legacy.reconcile({ runtimeSessionId: actor });
            if (pending.some(r => r.outcome === "NOT_OBSERVED" || r.outcome === "UNKNOWN")) return invalid("hooks.upgrade.unresolved");
          }
          publication = api.upgrade({ expectedDigest: candidate.expectedDigest, actorRuntimeSessionId: runtimeSessionId, profileRevision: candidate.profileRevision, bindingGeneration: candidate.bindingGeneration, operationId });
        } else if (candidate.kind === "mcp") {
          publication = api.setMcpHooks({ expectedDigest: candidate.expectedDigest, actorRuntimeSessionId: runtimeSessionId, bindingGeneration: candidate.bindingGeneration, targets: candidate.targets, operationId });
        } else {
          const own = current.snapshot.manifest.registrations.find(r => r.status === "active" && r.runtimeSessionId === runtimeSessionId) ?? invalid("hooks.currentSession");
          publication = api.setPiHooks({ expectedDigest: candidate.expectedDigest, runtimeSessionId, endpointId: own.endpointId, epoch: own.epoch, hooks: candidate.hooks, operationId });
        }
      } catch (error) {
        if (error instanceof TunnelRefusal && error.code === "CE_TUNNEL_CONFIG_CONFLICT") throw error;
        // The exclusive slot may already carry this operation. Keep the exact
        // operation and candidate for read-only reconciliation; never retry.
        return { ...base, configured: false, selection: "pending", policyDurability: "unknown", profileDurability: "not-attempted", ...(bindingPath === undefined ? {} : { bindingPath }), detail: "policy publication outcome unknown; reconcile the exact operation" };
      }

      const result = { ...base, configured: true, policyDurability: publication.durability, profileDurability: "not-attempted" as const };
      if (candidate.kind === "pi") return { ...result, selection: publication.durability === "synced" ? "unchanged" : "pending" };
      if (publication.durability !== "synced") return { ...result, selection: "pending", bindingPath: bindingPath! };

      try {
        const verify = (): void => {
          assertCurrent();
          guard!.assertIntact();
          if (readPrivateMessagingFile(profilePath)?.bytes.toString("utf8") !== captured.text) return conflict();
          const latest = readLivePolicy(candidate.ref, { credentialFile: captured.credentialFile });
          if (candidate.kind === "mcp") {
            if (!isDeepStrictEqual(targetsFor(latest, candidate.hooks), candidate.targets)) return conflict();
            if (latest.manifest.mcpHookConsent?.bindingGeneration !== candidate.bindingGeneration || latest.manifest.mcpHookConsent.generation !== publication.snapshot.sequence) return conflict();
          }
          if (!readMessagingGeneration(profilePath, bindingPath!, captured.credentialFile)) return invalid("hooks.candidate.missing");
        };
        verify();
        const command = current.facts.mcpCommand!;
        const quoted = `"${command}"`;
        if (captured.text.split(quoted).length !== 2) return invalid("hooks.profile.command");
        const next = captured.text.replace(quoted, `"${replaceTunnelMcpBindingPath(command, bindingPath!)}"`);
        if (Buffer.byteLength(next) > MAX_PROFILE_BYTES) return invalid("hooks.profile.size");
        parseTunnelProfile(next);
        const temporary = `${profilePath}.${randomUUID()}.tmp`;
        const fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { io.writeFileSync(fd, next, "utf8"); io.fsyncSync(fd); } finally { io.closeSync(fd); }
        const directory = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          io.fsyncSync(directory);
          verify();
          try { io.renameSync(temporary, profilePath); }
          catch { return { ...result, selection: "pending", profileDurability: "uncertain", bindingPath: bindingPath!, detail: "Profile rename outcome unknown; no retry and no rollback" }; }
          try { io.fsyncSync(directory); }
          catch { return { ...result, selection: "pending", profileDurability: "uncertain", bindingPath: bindingPath! }; }
          return { ...result, selection: "selected", profileDurability: "synced", bindingPath: bindingPath! };
        } finally { try { io.closeSync(directory); } catch { /* a post-commit close cannot roll back */ } }
      } catch {
        return { ...result, selection: "pending", bindingPath: bindingPath!, detail: "policy published; Profile activation pending; explicit reconciliation required" };
      }
    };

    // Only the operations that change the selected binding take the real lock.
    return candidate.kind === "pi" ? perform() : options.manager.withProfileConfigurationLock(guard => perform(guard));
  }

  return { inspect, preview: (kind: "pi" | "mcp", hooks: unknown) => capture(kind, hooks), previewUpgrade: () => capture("upgrade"), previewContinuation, save };
}

/**
 * The safe test runs ONE fixed benign fixture with a fixed argv and an empty
 * environment. It never accepts a configured rule, a Profile, or a command
 * from configuration, so it can never run a personal script.
 */
export function runSafeHookFixture(): Promise<{ executed: true; configuredCommandsExecuted: false; metadataOnly: true; exitCode: number }> {
  // Both the executable program and its synthetic metadata are package-owned.
  // No rule, message, Profile or personal script can supply either one.
  const fixture = { schemaVersion: 1, event: "ce.message.committed.v1", eventId: "fixture-event", eventKey: "fixture/1",
    messageId: "fixture-message", exchangeId: "fixture-exchange", sender: { adapter: "pi", endpointId: "fixture/pi" },
    recipient: { adapter: "chatgpt", endpointId: "fixture/chatgpt" }, createdAt: "2000-01-01T00:00:00.000Z",
    payloadDigest: "0".repeat(64), payloadLength: 0 };
  const program = 'let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",()=>{try{const e=JSON.parse(data);if(e.event!=="ce.message.committed.v1"||e.payloadLength!==0||Object.keys(e).length!==11||"payloadText" in e||"payload" in e)process.exitCode=1;else process.stdout.write("CE_HOOK_FIXTURE_OK");}catch{process.exitCode=1;}});';
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--input-type=commonjs", "-e", program], { timeout: 5000, maxBuffer: 1024, env: {}, windowsHide: true }, (error, stdout) => {
      if (error || stdout !== "CE_HOOK_FIXTURE_OK") reject(new Error("CE_HOOK_FIXTURE_FAILED"));
      else resolve({ executed: true, configuredCommandsExecuted: false, metadataOnly: true, exitCode: 0 });
    });
    child.stdin?.on("error", () => { /* the bounded child outcome owns failure */ });
    child.stdin?.end(JSON.stringify(fixture));
  });
}
