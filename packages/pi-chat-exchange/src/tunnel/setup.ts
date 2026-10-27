/** Real tunnel configuration domain. No UI, Keychain, Store, endpoint, child
 * process, or network operations. Credential bytes are only supplied by the
 * caller for Replace; existing key contents are NEVER opened/read.
 *
 * Each Replace writes a private immutable generation first. The profile rename
 * is the sole commit point. Old generations deliberately remain operator-owned:
 * deleting them could break a client still reading the previous profile.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { MCP_BINDING_CONFIG_MAX_BYTES, parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import { TunnelRefusal } from "./codes.js";
import {
  checkKeyFileMetadata, createBackgroundTunnelManager, parseTunnelProfile, resolveTunnelProfilePath,
  type BackgroundTunnelManager, type TunnelProfileFacts,
} from "./background-manager.js";
import { buildTunnelMcpCommand, buildTunnelProfile, migrateTunnelProfileText, parseTunnelMcpCommand, replaceTunnelMcpBindingPath, serializeTunnelProfile, validateTunnelIdentity } from "./profile.js";
import { resolveApprovedNode } from "../runtime/executables.js";
import { ensureManagedBinding } from "./managed-binding.js";
import { isMessagingBinding, isManagedPiAllowlist, piAllowlistPath, publishMessagingPair, readMessagingPair, readMessagingGeneration } from "./messaging-config.js";

const MAX_PROFILE_BYTES = 65_536;
const invalid = (field: string): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field);

/** Production selection validates filesystem trust and the complete unchanged
 * Store runtime identity. `nodePath` is a constructor dependency seam used by
 * domain tests; production callers configure CE_NODE_PATH instead. */
function resolveSetupNodePath(options: TunnelProfileSetupOptions): string {
  if (options.nodePath !== undefined) return options.nodePath;
  try {
    const resolved = resolveApprovedNode({ env: options.env });
    if (resolved !== undefined) return resolved;
  } catch { /* Refuse without forwarding child output or operator paths. */ }
  throw invalid("mcp.commands.0.command");
}
function absolute(path: string, field: string): void {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path ||
      !/^[\x20\x21\x23-\x5B\x5D-\x7E]+$/.test(path)) throw invalid(field);
}

/** Identity of an already-opened file, used to refuse metadata-only aliases. */
type FileIdentity = Readonly<{ dev: number; ino: number }>;
function sameFile(identity: FileIdentity, stat: FileIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

/** Read a bounded, operator-owned ordinary configuration file through a
 * no-follow fd. Only ENOENT may represent an absent profile. */
function readConfiguration(path: string, max: number, field: string, absent: boolean,
  excluded?: readonly FileIdentity[]): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.size > max ||
      excluded?.some((identity) => sameFile(identity, stat))) throw invalid(field);
    const text = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(text, "utf8") > max) throw invalid(field);
    return text;
  } catch (error) {
    if (fd === undefined && absent && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid(field);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Static formal JSON validation only. Does not even stat the configured Store.
 * Returns the selected reference, not endpoint/recipient/lease authority. */
/** Identities a binding read must never resolve to: the credential link itself
 * (lstat) and, for a symlinked credential, its target (stat) — without opening
 * credential contents. ENOENT means no credential exists yet, so no exclusion. */
function credentialExclusion(credentialFile: string | undefined): readonly FileIdentity[] | undefined {
  if (credentialFile === undefined) return undefined;
  try {
    const credentialEntry = fs.lstatSync(credentialFile);
    const credentialTarget = credentialEntry.isSymbolicLink() ? fs.statSync(credentialFile) : credentialEntry;
    return [credentialEntry, credentialTarget];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid("binding");
  }
}

export function validateTunnelBindingFile(path: string, credentialFile?: string): { readonly path: string } {
  absolute(path, "binding.path");
  try {
    const excluded = credentialExclusion(credentialFile);
    if (credentialFile !== undefined) {
      if (path === credentialFile) throw invalid("binding");
      const selected = fs.lstatSync(path);
      if (excluded?.some((identity) => sameFile(identity, selected))) throw invalid("binding");
    }
    // Recheck the opened fd before reading, so a concurrent path swap cannot
    // turn this static config read into a credential-content read.
    const text = readConfiguration(path, MCP_BINDING_CONFIG_MAX_BYTES, "binding", false, excluded)!;
    parseMcpBindingConfig(JSON.parse(text) as unknown);
  } catch { throw invalid("binding"); }
  return Object.freeze({ path });
}

export interface TunnelSetupInspection {
  readonly profilePath: string;
  readonly exists: boolean;
  /** Optimistic concurrency token. null means the profile was absent. */
  readonly revision: string | null;
  readonly tunnelId: string | undefined;
  readonly organizationId: string | undefined;
  readonly mcpCommand: string | undefined;
  readonly bindingPath: string | undefined;
  /** Managed-binding recipients when the current binding is CE-managed for this
   * identity; undefined when absent, invalid, or not CE-managed. Never contents
   * of any credential. */
  readonly bindingRecipients: readonly import("../host/endpoint-host.js").CeRecipientRef[] | undefined;
  readonly credentialConfigured: boolean;
  /** MESSAGING-INTEGRATION-01: current messaging configuration facts (both
   *  sides), when determinable. Configuration only — never runtime state. */
  readonly messaging: TunnelMessagingInspection | undefined;
}
export interface TunnelMessagingInspection {
  /** Tunnel-side (ChatGPT) endpoint identity from the managed binding. */
  readonly chatgptEndpoint: import("../host/endpoint-host.js").CeRecipientRef | undefined;
  /** Binding recipients (send eligibility from the ChatGPT side). */
  readonly recipients: readonly import("../host/endpoint-host.js").CeRecipientRef[];
  readonly payloadRead: boolean;
  readonly ack: boolean;
  readonly piAllowlistPath: string;
  /** Pi-side session mapping from the generated allowlist, when present. */
  readonly piSessionId: string | undefined;
  readonly piEndpointId: string | undefined;
  /** Shared Store/Exchange both sides are configured with. */
  readonly storeDirectory: string | undefined;
  readonly exchangeNamespace: string | undefined;
  readonly storeFile: string | undefined;
  readonly exchangeIdempotencyKey: string | undefined;
  /** True only when the binding and the Pi allowlist agree on a complete
   *  bidirectional ChatGPT↔Pi configuration. Never implies live processes. */
  readonly configured: boolean;
}
export type TunnelSetupCredential = { readonly kind: "keep" } | { readonly kind: "replace"; readonly secret: string };
/** Binding selection. `managed` derives a CE-owned binding from identity; `path`
 * references an operator-selected existing config; `keep` (undefined) reuses the
 * profile's current binding. Managed never widens message permissions. */
export type TunnelSetupBinding =
  | {
      readonly kind: "managed";
      readonly recipients?: readonly import("../host/endpoint-host.js").CeRecipientRef[];
      /** MESSAGING-INTEGRATION-01: explicit endpoint identity + read/ACK opt-ins.
       *  Absent keeps the identity-digest endpoint with all permissions disabled. */
      readonly endpointId?: string;
      readonly capabilities?: { readonly payloadRead?: boolean; readonly ack?: boolean };
    }
  | { readonly kind: "path"; readonly path: string };
/** MESSAGING-INTEGRATION-01: explicit ChatGPT↔Pi messaging authorization for
 * the CURRENT Pi session. The tunnel-side binding models the ChatGPT endpoint;
 * the Pi-side allowlist maps this session to the Pi endpoint. */
export interface TunnelSetupMessaging {
  readonly chatgptEndpointId: string;
  readonly piEndpointId: string;
  /** Current session id from the trusted Pi runtime API — never guessed. */
  readonly piSessionId: string;
  readonly payloadRead: boolean;
  readonly ack: boolean;
  /** Explicit authorization to replace a different existing pi-allowlist.
   *  The wizard surfaces the old→new change before setting this. */
  readonly replaceExisting: boolean;
}
export interface TunnelSetupSaveInput {
  readonly expectedRevision: string | null;
  readonly tunnelId: string;
  /** undefined/empty means Not configured, not preserve-the-old-value. */
  readonly organizationId?: string;
  readonly credential: TunnelSetupCredential;
  /** Binding selection. On edit, omission keeps the old binding. An explicit
   * `{ kind: "path" }` authorizes a change to an operator-selected file after the
   * caller's change review. `{ kind: "managed" }` derives and persists a
   * CE-managed binding from the tunnel identity; with no usable binding at all
   * (first setup) managed is the default and never requires a typed path.
   * Executable/script/channel and unrelated YAML are always preserved. */
  readonly binding?: TunnelSetupBinding;
  /** Explicit messaging authorization. Requires the managed binding selection
   *  above to carry the same endpoint/recipients/capabilities (the domain
   *  refuses a skewed request). Publishes the Pi-side allowlist atomically
   *  under the same ownership lock, with rollback on precommit failure. */
  readonly messaging?: TunnelSetupMessaging;
  readonly signal?: AbortSignal;
}
export type TunnelSetupSaveResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "saved"; readonly profilePath: string; readonly durability: "synced" | "uncertain" };
export type TunnelProfileMigrationResult =
  | { readonly kind: "migrated"; readonly profilePath: string; readonly durability: "synced" | "uncertain" }
  | { readonly kind: "unchanged" };
/** Small filesystem fault-injection boundary; production defaults are Node fs.
 * No read-credential operation exists in the transaction interface. */
export type SetupFileOperations = Pick<typeof fs, "openSync" | "closeSync" | "writeFileSync" | "fsyncSync" | "renameSync" | "unlinkSync" | "linkSync">;
export interface TunnelProfileSetupOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly profilePath?: string;
  readonly manager?: Pick<BackgroundTunnelManager, "withProfileConfigurationLock">;
  readonly nodePath?: string;
  readonly mcpScriptPath?: string;
  readonly io?: Partial<SetupFileOperations>;
  /** Test seam; production creates a dedicated private generation directory. */
  readonly credentialDirectoryGuard?: (path: string) => CredentialDirectoryCleanup;
}
export interface TunnelProfileSetup {
  inspect(): TunnelSetupInspection;
  /** Static UI preflight with the current credential excluded internally. */
  validateBinding(path: string): { readonly path: string };
  save(input: TunnelSetupSaveInput): Promise<TunnelSetupSaveResult>;
  /** REAL-START-FIX-01: repair a saved profile in place (drop the rejected
   *  admin_ui keys and repoint the mcp child node) without touching the
   *  credential reference, tunnel/org identity, binding, store, or recipients.
   *  Atomic (temp + rename) under the SAME ownership lock; refuses when the
   *  daemon is running or its ownership is uncertain. */
  migrate(): Promise<TunnelProfileMigrationResult>;
}

/** Removes a credential directory this transaction created, or undefined when the
 * directory already existed and must therefore be left alone. */
type CredentialDirectoryCleanup = (() => void) | undefined;

/** Create a dedicated directory before a secret exists. On Darwin, chmod -N
 * removes inherited ACL entries before the generation is opened; a failed native
 * operation is a refusal, never a best-effort downgrade. */
function ensurePrivateCredentialDirectory(path: string): CredentialDirectoryCleanup {
  let created = false;
  try { fs.mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalid("credential.directory"); }
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path); } catch { throw invalid("credential.directory"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw invalid("credential.directory");
  }
  if (process.platform === "darwin") {
    try { execFileSync("/bin/chmod", ["-N", path], { stdio: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000 }); }
    catch { throw invalid("credential.directory"); }
    try { stat = fs.lstatSync(path); } catch { throw invalid("credential.directory"); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw invalid("credential.directory");
    }
  }
  return created ? () => { fs.rmdirSync(path); } : undefined;
}

/** Record only absent profile-directory entries before the manager can create
 * them. After the profile rename we sync from their known existing parent down,
 * avoiding symlinked system ancestors while making each new entry durable. */
function missingDirectoryLineage(directory: string): readonly string[] {
  const missing: string[] = [];
  for (let current = directory;; current = dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("profile.directory");
      return missing.reverse();
    } catch (error) {
      if (error instanceof TunnelRefusal) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid("profile.directory");
      const parent = dirname(current);
      if (parent === current) throw invalid("profile.directory");
      missing.push(current);
    }
  }
}

function syncCommittedProfileDirectories(profileDirectory: string, missing: readonly string[], io: SetupFileOperations): boolean {
  const directories = missing.length === 0 ? [profileDirectory] : [dirname(missing[0]!), ...missing];
  try {
    for (const directory of directories) {
      const fd = io.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    }
    return true;
  } catch { return false; }
}

/** MESSAGING-INTEGRATION-01: strict, advisory read of the generated Pi-side
 * allowlist. Any malformed shape degrades to "not configured" (fail closed
 * display) — it never throws and never grants anything. */
function readPiAllowlistFacts(profilePath: string, credentialFile: string | undefined, bindingPath?: string): {
  readonly document: Record<string, unknown>;
  readonly piSessionId: string;
  readonly piEndpointId: string;
  readonly chatgptEndpointId: string;
  readonly exchangeNamespace: string;
  readonly exchangeIdempotencyKey: string;
  readonly recipientAdapter: string;
  readonly storeFile: string;
  readonly storeDirectory: string;
  readonly payloadRead: boolean;
  readonly ack: boolean;
} | undefined {
  try {
    if (bindingPath === undefined) return undefined;
    const pair = readMessagingPair(profilePath, bindingPath, credentialFile);
    if (pair === undefined) return undefined;
    const doc = pair.document;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
    if (!isManagedPiAllowlist(profilePath, doc)) return undefined;
    const sessions = doc.sessions;
    if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) return undefined;
    const entries = Object.entries(sessions as Record<string, unknown>);
    if (entries.length !== 1) return undefined;
    const [piSessionId, mapping] = entries[0]!;
    if (typeof piSessionId !== "string" || piSessionId.length === 0) return undefined;
    if (typeof mapping !== "object" || mapping === null) return undefined;
    const piEndpointId = (mapping as Record<string, unknown>).endpointId;
    if (typeof piEndpointId !== "string" || piEndpointId.length === 0) return undefined;
    const recipients = doc.recipients;
    if (!Array.isArray(recipients) || recipients.length !== 1) return undefined;
    const recipient = recipients[0] as Record<string, unknown>;
    if (typeof recipient !== "object" || recipient === null || typeof recipient.endpointId !== "string" || typeof recipient.adapter !== "string") return undefined;
    const exchangeNamespace = doc.exchangeNamespace;
    const exchangeIdempotencyKey = doc.exchangeIdempotencyKey;
    if (typeof exchangeNamespace !== "string" || typeof exchangeIdempotencyKey !== "string") return undefined;
    const store = doc.store as Record<string, unknown> | undefined;
    if (typeof store !== "object" || store === null || typeof store.directory !== "string" || typeof store.file !== "string") return undefined;
    const enabled = (section: unknown): boolean =>
      typeof section === "object" && section !== null &&
      (section as Record<string, unknown>).enabled === true;
    return {
      piSessionId, piEndpointId,
      document: doc,
      chatgptEndpointId: recipient.endpointId,
      exchangeNamespace,
      exchangeIdempotencyKey, recipientAdapter: recipient.adapter, storeFile: store.file,
      storeDirectory: store.directory,
      payloadRead: enabled(doc.payloadRead),
      ack: enabled(doc.ack),
    };
  } catch {
    return undefined;
  }
}

function messagingPairMatches(config: McpBindingConfig | undefined, pi: ReturnType<typeof readPiAllowlistFacts>): boolean {
  return config?.endpoint.adapter === "chatgpt" && pi !== undefined &&
    pi.recipientAdapter === config.endpoint.adapter && pi.chatgptEndpointId === config.endpoint.endpointId &&
    pi.exchangeNamespace === config.exchange.namespace && pi.exchangeIdempotencyKey === config.exchange.idempotencyKey &&
    pi.storeDirectory === config.store.directory && pi.storeFile === config.store.file &&
    config.recipients.length === 1 && config.recipients[0]!.adapter === "pi" && config.recipients[0]!.endpointId === pi.piEndpointId &&
    pi.payloadRead === config.payloadRead.enabled && pi.ack === config.ack.enabled;
}

/** MESSAGING-INTEGRATION-01: cross-check the Tunnel-managed binding and the
 * Pi-side allowlist into one configuration-only projection. `configured` is
 * true only when BOTH sides agree on a complete bidirectional setup — it says
 * nothing about running processes (runtime state is reported separately). */
function inspectMessaging(profilePath: string, managedConfig: McpBindingConfig | undefined, credentialFile: string | undefined, bindingPath?: string): TunnelMessagingInspection {
  const allowlistPath = piAllowlistPath(profilePath, bindingPath !== undefined && isMessagingBinding(bindingPath) ? bindingPath : undefined);
  const pi = readPiAllowlistFacts(profilePath, credentialFile, bindingPath);
  const chatgptEndpoint = managedConfig?.endpoint.adapter === "chatgpt" ? managedConfig.endpoint : undefined;
  const recipients = managedConfig?.recipients ?? Object.freeze([]);
  const payloadRead = managedConfig?.payloadRead.enabled ?? false;
  const ack = managedConfig?.ack.enabled ?? false;
  const piSideMatches = messagingPairMatches(managedConfig, pi);
  return Object.freeze({
    chatgptEndpoint,
    recipients,
    payloadRead,
    ack,
    piAllowlistPath: allowlistPath,
    piSessionId: pi?.piSessionId,
    piEndpointId: pi?.piEndpointId,
    storeDirectory: managedConfig?.store.directory,
    exchangeNamespace: managedConfig?.exchange.namespace,
    storeFile: managedConfig?.store.file,
    exchangeIdempotencyKey: managedConfig?.exchange.idempotencyKey,
    configured: piSideMatches && payloadRead && ack,
  });
}

const revisionOf = (text: string | undefined): string | null => text === undefined ? null : createHash("sha256").update(text, "utf8").digest("hex");
/** Preserve every unrelated byte, notably MCP command/channel/comments. */
function updateProfile(text: string, input: TunnelSetupSaveInput, keyFile: string, mcpCommand?: string): string {
  let next = text.replace(/^  tunnel_id:.*$/m, () => `  tunnel_id: "${input.tunnelId}"`)
    .replace(/^  api_key:.*$/m, () => `  api_key: "file:${keyFile}"`);
  next = next.replace(/^  organization_id:.*\n?/m, "");
  if (input.organizationId) next = next.replace(/^(  tunnel_id:.*)$/m, `$1\n  organization_id: "${input.organizationId}"`);
  if (mcpCommand !== undefined) {
    next = next.replace(/^(      command:[ ]*)"[^"]*"([ ]*)$/m,
      (_line, prefix: string, suffix: string) => `${prefix}"${mcpCommand}"${suffix}`);
  }
  return next;
}

/** Read the generated Pi configuration without ever opening its credential
 * alias. Used by the extension's generated-default loader, not operator paths. */
export function readGeneratedPiAllowlist(profilePath: string): Record<string, unknown> | undefined {
  try {
    const profile = readConfiguration(profilePath, MAX_PROFILE_BYTES, "profile", true);
    if (profile === undefined) return undefined;
    const facts = parseTunnelProfile(profile);
    const path = facts.mcpCommand === undefined ? undefined : parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
    if (path === undefined || !isMessagingBinding(path)) return undefined;
    if (path === facts.keyFile) throw invalid("messaging.binding");
    const excluded = credentialExclusion(facts.keyFile);
    const selected = fs.lstatSync(path);
    if (excluded?.some((identity) => sameFile(identity, selected))) throw invalid("messaging.binding");
    const binding = parseMcpBindingConfig(JSON.parse(readConfiguration(path, MCP_BINDING_CONFIG_MAX_BYTES, "binding", false, excluded)!));
    if (binding.managed?.tunnelId !== facts.tunnelId || (binding.managed?.organizationId ?? undefined) !== (facts.organizationId ?? undefined)) throw invalid("messaging.binding");
    const pi = readPiAllowlistFacts(profilePath, facts.keyFile, path);
    if (!messagingPairMatches(binding, pi)) throw invalid("messaging.configuration");
    return pi!.document;
  } catch (error) {
    if (error instanceof TunnelRefusal) throw error;
    throw invalid("messaging.configuration"); // no raw filesystem/parser cause escapes
  }
}

export function createTunnelProfileSetup(options: TunnelProfileSetupOptions): TunnelProfileSetup {
  const profilePath = resolveTunnelProfilePath(options);
  absolute(profilePath, "profile");
  const manager = options.manager ?? createBackgroundTunnelManager({ env: options.env, profilePath });
  const io: SetupFileOperations = {
    openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, linkSync: fs.linkSync, ...options.io,
  };
  const credentialDirectoryGuard = options.credentialDirectoryGuard ?? ensurePrivateCredentialDirectory;
  const read = (): { text: string | undefined; facts: TunnelProfileFacts | undefined } => {
    const text = readConfiguration(profilePath, MAX_PROFILE_BYTES, "profile", true);
    return { text, facts: text === undefined ? undefined : parseTunnelProfile(text) };
  };
  const inspect = (): TunnelSetupInspection => {
    const { text, facts } = read();
    const bindingPath = facts?.mcpCommand === undefined ? undefined : parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
    let credentialConfigured = false;
    if (facts !== undefined) {
      try { checkKeyFileMetadata(facts.keyFile); credentialConfigured = true; } catch { /* Replace remains possible. */ }
    }
    // Wizard prefill: read the referenced binding only through the trusted parser,
    // and expose recipients only for a CE-managed document whose provenance matches
    // this profile's identity. Any failure degrades to an unknown (kept) binding.
    let bindingRecipients: TunnelSetupInspection["bindingRecipients"];
    let managedConfig: McpBindingConfig | undefined;
    if (facts !== undefined && bindingPath !== undefined) {
      try {
        // Same exclusion boundary as validateTunnelBindingFile: a binding path
        // resolving to the credential (or its link target) is never opened.
        if (bindingPath === facts.keyFile) throw invalid("binding");
        const excluded = credentialExclusion(facts.keyFile);
        const selected = fs.lstatSync(bindingPath);
        if (excluded?.some((identity) => sameFile(identity, selected))) throw invalid("binding");
        const parsed = parseMcpBindingConfig(JSON.parse(readConfiguration(bindingPath, MCP_BINDING_CONFIG_MAX_BYTES, "binding", false, excluded)!));
        if (parsed.managed !== undefined && parsed.managed.tunnelId === facts.tunnelId
            && (parsed.managed.organizationId ?? undefined) === (facts.organizationId ?? undefined)) {
          bindingRecipients = parsed.recipients;
          managedConfig = parsed;
        }
      } catch { /* An unreadable/foreign binding stays untouched: keep. */ }
    }
    const messaging = inspectMessaging(profilePath, managedConfig, facts?.keyFile, bindingPath);
    return Object.freeze({ profilePath, exists: text !== undefined, revision: revisionOf(text),
      tunnelId: facts?.tunnelId, organizationId: facts?.organizationId, mcpCommand: facts?.mcpCommand,
      bindingPath, bindingRecipients, credentialConfigured, messaging });
  };
  const save = async (input: TunnelSetupSaveInput): Promise<TunnelSetupSaveResult> => {
    if (input.signal?.aborted) return { kind: "cancelled" };
    validateTunnelIdentity(input.tunnelId, input.organizationId);
    if (input.credential.kind !== "keep" && input.credential.kind !== "replace") throw invalid("credential");
    if (input.credential.kind === "replace" && (typeof input.credential.secret !== "string" ||
      !/^[\x20-\x7E]{1,4096}$/.test(input.credential.secret))) throw invalid("credential");
    const missingProfileDirectories = missingDirectoryLineage(dirname(profilePath));
    return manager.withProfileConfigurationLock((guard): TunnelSetupSaveResult => {
      if (input.signal?.aborted) return { kind: "cancelled" };
      if (guard.profilePath !== profilePath) throw invalid("setup.lock-profile");
      const { text, facts } = read();
      if (revisionOf(text) !== input.expectedRevision) throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
      // The single-session wizard has no projection capable of preserving multi
      // registrations. Refuse every save in this mode, including credential-only
      // edits, rather than flattening or silently converting it back to legacy.
      if (facts?.mcpCommand !== undefined) {
        const selectedPath = parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
        if (isMessagingBinding(selectedPath)) {
          const selectedPair = readMessagingGeneration(profilePath, selectedPath, facts.keyFile);
          if (selectedPair?.config.admissionPolicy !== undefined || selectedPair?.document.kind === "ce-multi-session-v1") throw invalid("messaging.multiSession");
        }
      }
      if (input.credential.kind === "keep") {
        if (facts === undefined) throw new TunnelRefusal("CE_TUNNEL_KEY_MISSING");
        checkKeyFileMetadata(facts.keyFile);
      }
      const existingBinding = facts?.mcpCommand === undefined ? undefined : parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
      if (facts !== undefined && existingBinding === undefined) throw invalid("mcp.commands");
      // Binding selection. An explicit operator path is validated as before.
      // `managed` (or first-setup default) derives a CE-owned binding from the
      // tunnel identity; it never widens message permissions and never requires
      // a typed path. Omission keeps the profile's existing binding.
      // `owned` and the transaction state are declared before any binding write,
      // and the cleanup try/finally opens immediately after, so a newly created
      // managed generation is registered for rollback and ANY later precommit
      // refusal (including profile.size) removes it. A reused/historical file is
      // never owned by this transaction.
      const owned: { path: string; ino: number; dev: number }[] = [];
      let committed = false;
      let directoryFd: number | undefined;
      let cleanupCredentialDirectory: CredentialDirectoryCleanup;
      // Immutable messaging candidates are retained if profile commit refuses.
      // They carry no active pointer/authority; no final config is deleted.
      const create = (path: string, data: string): void => {
        const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fs.fstatSync(fd);
          owned.push({ path, ino: stat.ino, dev: stat.dev });
          if (stat.mode !== 0o100600 || stat.uid !== process.geteuid?.()) throw invalid("setup.permissions");
          io.writeFileSync(fd, data, "utf8");
          io.fsyncSync(fd);
        } finally { io.closeSync(fd); }
      };
      let bindingPath: string;
      try {
      // MESSAGING-INTEGRATION-01: refuse a skewed messaging request BEFORE any
      // write. The managed binding selection must carry exactly the authorized
      // ChatGPT endpoint, the single Pi recipient, and the same capabilities.
      const messaging = input.messaging;
      if (messaging === undefined && existingBinding !== undefined && isMessagingBinding(existingBinding) &&
          (input.tunnelId !== facts?.tunnelId || (input.organizationId || undefined) !== (facts?.organizationId || undefined) ||
           input.binding?.kind === "managed" || (input.binding?.kind === "path" && input.binding.path !== existingBinding))) {
        throw invalid("messaging.reauthorization");
      }
      if (messaging !== undefined) {
        if (input.binding?.kind !== "managed") throw invalid("messaging");
        if (input.binding.endpointId !== messaging.chatgptEndpointId) throw invalid("messaging.endpoint");
        const authorized = input.binding.recipients ?? [];
        if (authorized.length !== 1 || authorized[0]!.adapter !== "pi" || authorized[0]!.endpointId !== messaging.piEndpointId) {
          throw invalid("messaging.recipients");
        }
        if ((input.binding.capabilities?.payloadRead === true) !== messaging.payloadRead) throw invalid("messaging.payloadRead");
        if ((input.binding.capabilities?.ack === true) !== messaging.ack) throw invalid("messaging.ack");
        const previous = existingBinding === undefined ? undefined : readPiAllowlistFacts(profilePath, facts?.keyFile, existingBinding);
        if (previous !== undefined && previous.piSessionId !== messaging.piSessionId && !messaging.replaceExisting) {
          throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "messaging.session");
        }
      }
      if (input.binding?.kind === "path") {
        bindingPath = input.binding.path;
        validateTunnelBindingFile(bindingPath, facts?.keyFile);
      } else if (input.binding?.kind === "managed" || existingBinding === undefined) {
        // Managed binding: identity-derived, operator-owned, minimal permissions.
        // First setup (no existing binding) defaults here; the wizard never asks
        // for a binding file path. With messaging authorized, the endpoint is
        // modelled as the ChatGPT-side identity (adapter "chatgpt"), never `pi`.
        const managedInput: Parameters<typeof ensureManagedBinding>[1] = {
          tunnelId: input.tunnelId, organizationId: input.organizationId || undefined,
          adapter: messaging === undefined ? "pi" : "chatgpt",
          ...(facts?.keyFile !== undefined ? { credentialFile: facts.keyFile } : {}),
          ...(input.binding?.kind === "managed" && input.binding.endpointId !== undefined ? { endpointId: input.binding.endpointId } : {}),
          ...(input.binding?.kind === "managed" && input.binding.capabilities !== undefined ? { capabilities: input.binding.capabilities } : {}),
          ...(input.binding?.kind === "managed" && input.binding.recipients !== undefined
            ? { recipients: input.binding.recipients } : {}),
        };
        const managed = ensureManagedBinding(profilePath, managedInput);
        bindingPath = managed.path;
        if (messaging !== undefined) {
          // Both immutable files are selected only by the final profile rename.
          const pair = publishMessagingPair(profilePath, managed.config, {
            chatgptEndpoint: { adapter: "chatgpt", endpointId: messaging.chatgptEndpointId },
            piEndpoint: { adapter: "pi", endpointId: messaging.piEndpointId },
            piSessionId: messaging.piSessionId,
            exchangeNamespace: managed.config.exchange.namespace,
            exchangeIdempotencyKey: managed.config.exchange.idempotencyKey,
            store: managed.config.store,
            payloadRead: messaging.payloadRead,
            ack: messaging.ack,
          }, { io, ...(facts?.keyFile === undefined ? {} : { credentialFile: facts.keyFile }) });
          if (pair.durability !== "synced") throw invalid("messaging.generation.durability");
          bindingPath = pair.bindingPath;
        }
        // C-R1: register a NEWLY created managed generation immediately so any
        // later precommit refusal (e.g. profile.size) removes it; a reused/
        // historical file is never owned by this transaction.
        // A-R8: a published managed candidate is a VALID, atomically-committed
        // generation (validated staging -> linkSync). It is NOT registered for
        // rollback: deleting a shared-pathname binding on a precommit refusal could
        // remove a concurrent replacement or a binding another config already
        // references. Retaining it is safe and idempotent — a retry reuses it.
      } else {
        // Keep: reuse the profile's current binding, validated as before.
        // C-R2: when the identity changes but the current binding is CE-managed
        // (provenance matching the OLD identity), regenerate it for the new
        // identity carrying the operator's existing recipients, so the profile
        // and its binding never disagree about tunnel identity. A legacy/
        // non-managed binding keeps the existing keep rule unchanged.
        const identityChanged = facts !== undefined && (input.tunnelId !== facts.tunnelId ||
          (input.organizationId || undefined) !== (facts.organizationId ?? undefined));
        let existingManagedRecipients: readonly import("../host/endpoint-host.js").CeRecipientRef[] | undefined;
        if (identityChanged && facts !== undefined) {
          try {
            if (existingBinding === facts.keyFile) throw invalid("binding");
            const excluded = credentialExclusion(facts.keyFile);
            const selected = fs.lstatSync(existingBinding);
            if (excluded?.some((identity) => sameFile(identity, selected))) throw invalid("binding");
            const parsed = parseMcpBindingConfig(JSON.parse(readConfiguration(existingBinding, MCP_BINDING_CONFIG_MAX_BYTES, "binding", false, excluded)!));
            if (parsed.managed !== undefined && parsed.managed.tunnelId === facts.tunnelId &&
                (parsed.managed.organizationId ?? undefined) === (facts.organizationId ?? undefined)) {
              existingManagedRecipients = parsed.recipients;
            }
          } catch { /* Unreadable/foreign binding: fall through to plain keep. */ }
        }
        if (identityChanged && existingManagedRecipients !== undefined) {
          const managed = ensureManagedBinding(profilePath, {
            tunnelId: input.tunnelId, organizationId: input.organizationId || undefined, adapter: "pi",
            ...(facts?.keyFile !== undefined ? { credentialFile: facts.keyFile } : {}),
            recipients: existingManagedRecipients,
          });
          bindingPath = managed.path;
          // See above: a published managed candidate is retained, never rolled back.
        } else {
          bindingPath = existingBinding;
          validateTunnelBindingFile(bindingPath, facts?.keyFile);
        }
      }
      const changedCommand = facts?.mcpCommand !== undefined && bindingPath !== existingBinding
        ? replaceTunnelMcpBindingPath(facts.mcpCommand, bindingPath) : undefined;
      const credentialDirectory = join(dirname(profilePath), ".credentials");
      const keyFile = input.credential.kind === "keep" ? facts!.keyFile : join(credentialDirectory, `credential-${randomUUID()}`);
      const nextText = text === undefined ? serializeTunnelProfile(buildTunnelProfile({
        tunnelId: input.tunnelId, ...(input.organizationId ? { organizationId: input.organizationId } : {}), keyFile,
        healthUrlFile: join(dirname(profilePath), "health.url"),
        mcpCommand: buildTunnelMcpCommand({ nodePath: resolveSetupNodePath(options),
          scriptPath: options.mcpScriptPath ?? fileURLToPath(new URL("../bin/mcp-stdio.js", import.meta.url)), bindingPath }),
      })) : updateProfile(text, input, keyFile, changedCommand);
      parseTunnelProfile(nextText); // Same decoder as real start, before any write.
      if (Buffer.byteLength(nextText, "utf8") > MAX_PROFILE_BYTES) throw invalid("profile.size");
      const temporaryProfile = `${profilePath}.${randomUUID()}.tmp`;
      guard.assertIntact();
        if (input.signal?.aborted) return { kind: "cancelled" };
        if (input.credential.kind === "replace") cleanupCredentialDirectory = credentialDirectoryGuard(credentialDirectory);
        directoryFd = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        if (input.credential.kind === "replace") create(keyFile, input.credential.secret);
        create(temporaryProfile, nextText);
        // A directory fsync persists only that directory's own entries. The new
        // generation's name lives in .credentials, so both the profile directory
        // and .credentials must be synced before the profile can reference it.
        // Failure here is still precommit and refuses without any rollback claim.
        if (input.credential.kind === "replace") {
          const credentialDirectoryFd = io.openSync(credentialDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try { io.fsyncSync(credentialDirectoryFd); } finally { io.closeSync(credentialDirectoryFd); }
        }
        io.fsyncSync(directoryFd);
        guard.assertIntact();
        if (input.signal?.aborted) return { kind: "cancelled" };
        if (revisionOf(read().text) !== input.expectedRevision) throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
        checkKeyFileMetadata(keyFile);
        io.renameSync(temporaryProfile, profilePath); // SOLE COMMIT POINT
        committed = true;
        // A post-rename error cannot honestly be reported as an uncommitted
        // failure. Never delete/roll back an already referenced generation.
        const durability = syncCommittedProfileDirectories(dirname(profilePath), missingProfileDirectories, io) ? "synced" as const : "uncertain" as const;
        return { kind: "saved", profilePath, durability };
      } catch (error) {
        if (error instanceof TunnelRefusal) throw error;
        throw invalid("setup.transaction"); // Never forward fs messages/causes.
      } finally {
        let cleanupFailed = false;
        if (directoryFd !== undefined) { try { io.closeSync(directoryFd); } catch { /* no postcommit rollback */ } }
        if (!committed) {
          for (const file of owned.reverse()) {
            try {
              const stat = fs.lstatSync(file.path);
              if (stat.ino === file.ino && stat.dev === file.dev) io.unlinkSync(file.path);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true; }
          }
          if (cleanupCredentialDirectory !== undefined) {
            try { cleanupCredentialDirectory(); } catch { cleanupFailed = true; }
          }
          // Completed immutable config generations are intentionally retained.
          // The unchanged profile still selects its original complete pair.
        }
        if (cleanupFailed) throw invalid("setup.cleanup");
      }
    });
  };
  const migrate = async (): Promise<TunnelProfileMigrationResult> => {
    const missingProfileDirectories = missingDirectoryLineage(dirname(profilePath));
    return manager.withProfileConfigurationLock((guard): TunnelProfileMigrationResult => {
      if (guard.profilePath !== profilePath) throw invalid("setup.lock-profile");
      // Read the RAW text directly: a stale profile still carries the rejected
      // admin_ui keys, so the strict decoder (read().facts) would refuse it
      // before migration could run. Migration is exactly for that shape.
      const text = readConfiguration(profilePath, MAX_PROFILE_BYTES, "profile", true);
      if (text === undefined) return { kind: "unchanged" };
      const nodePath = resolveSetupNodePath(options);
      const { text: nextText, changed } = migrateTunnelProfileText(text, { nodePath });
      if (!changed) return { kind: "unchanged" };
      parseTunnelProfile(nextText); // Same decoder as real start, before any write.
      if (Buffer.byteLength(nextText, "utf8") > MAX_PROFILE_BYTES) throw invalid("profile.size");
      const temporaryProfile = `${profilePath}.${randomUUID()}.tmp`;
      guard.assertIntact();
      let directoryFd: number | undefined;
      let committed = false;
      let tempIno = 0;
      let tempDev = 0;
      try {
        directoryFd = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const fd = io.openSync(temporaryProfile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fs.fstatSync(fd);
          if (stat.mode !== 0o100600 || stat.uid !== process.geteuid?.()) throw invalid("setup.permissions");
          tempIno = stat.ino;
          tempDev = stat.dev;
          io.writeFileSync(fd, nextText, "utf8");
          io.fsyncSync(fd);
        } finally { io.closeSync(fd); }
        io.fsyncSync(directoryFd);
        guard.assertIntact();
        // No credential is involved, but the profile must still be the same
        // generation we read — a concurrent save would be clobbered otherwise.
        if (revisionOf(readConfiguration(profilePath, MAX_PROFILE_BYTES, "profile", true)) !== revisionOf(text)) throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
        io.renameSync(temporaryProfile, profilePath); // SOLE COMMIT POINT
        committed = true;
        const durability = syncCommittedProfileDirectories(dirname(profilePath), missingProfileDirectories, io) ? "synced" as const : "uncertain" as const;
        return { kind: "migrated", profilePath, durability };
      } catch (error) {
        if (error instanceof TunnelRefusal) throw error;
        throw invalid("setup.transaction"); // Never forward fs messages/causes.
      } finally {
        if (directoryFd !== undefined) { try { io.closeSync(directoryFd); } catch { /* no postcommit rollback */ } }
        if (!committed) {
          try {
            const stat = fs.lstatSync(temporaryProfile);
            if (stat.ino === tempIno && stat.dev === tempDev) io.unlinkSync(temporaryProfile);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { /* best effort */ } }
        }
      }
    });
  };
  return { inspect, validateBinding: (path) => validateTunnelBindingFile(path, read().facts?.keyFile), save, migrate };
}
