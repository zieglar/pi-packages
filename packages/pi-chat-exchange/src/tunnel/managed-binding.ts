/**
 * Managed MCP binding configuration.
 *
 * HANDOFF-CE-TUNNEL-INTEGRATION-TUI-01. The Tunnel Setup Wizard no longer asks
 * the operator to type a binding-config file path. A CE-managed binding is
 * derived from the tunnel identity and persisted in a fixed, operator-owned
 * directory beside the tunnel profile.
 *
 * Authority boundary (unchanged):
 * - This module only *proposes and validates* a binding document. It never
 *   creates a Store, endpoint, recipient, or message permission beyond what the
 *   document itself declares, and the default declares none (`recipients: []`,
 *   payloadRead/ack/debug disabled).
 * - The durable Store is still created lazily by the MCP server on first use
 *   (`mcp-stdio.ts openBindingStore` -> `initializeStore`); this module never
 *   opens or initializes it.
 *
 * File safety: names are derived from a fixed grammar, the managed directory is
 * created `0700` with owner/mode/symlink checks, the document is written
 * `O_EXCL|O_NOFOLLOW` `0600` and fsynced with its directory, and a name that
 * already exists but carries a different identity is refused rather than reused.
 */

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { TunnelRefusal } from "./codes.js";
import { TUNNEL_ID_PATTERN as TUNNEL_ID } from "./tunnel-id.js";
import { MCP_BINDING_CONFIG_MAX_BYTES, MCP_BINDING_CONFIG_VERSION, parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import type { CeRecipientRef } from "../host/endpoint-host.js";

/** Fixed managed directory for CE-generated bindings, beside the tunnel profile. */
export const MANAGED_BINDING_DIRNAME = ".ce-bindings";

export interface ManagedBindingIdentity {
  readonly tunnelId: string;
  readonly organizationId: string | undefined;
  readonly adapter: string;
}

export interface ManagedBindingCapabilities {
  /** Explicit messaging opt-ins; absent means disabled (fail closed). */
  readonly payloadRead?: boolean;
  readonly ack?: boolean;
}

export interface ManagedBindingInput extends ManagedBindingIdentity {
  /** Explicit endpoint identity for this tunnel-side MCP host. Absent keeps the
   *  identity-digest default (ce-<digest>) for backward compatibility. */
  readonly endpointId?: string;
  /** Explicit read/ACK opt-ins for this endpoint; default disabled. */
  readonly capabilities?: ManagedBindingCapabilities;
  /** Operator-authorized cross-adapter recipients. Default `[]` grants none. */
  readonly recipients?: readonly CeRecipientRef[];
  /** Current credential file (if any). A managed candidate resolving to it, its
   *  hardlink, or its symlink target is never opened — the boundary that
   *  validateTunnelBindingFile and inspect already enforce. */
  readonly credentialFile?: string;
}

export interface ManagedBindingResult {
  readonly path: string;
  readonly config: McpBindingConfig;
  /** `true` when an existing, identically-owned document was reused. */
  readonly reused: boolean;
  /** fd-verified identity of a file this call created (absent when reused), so
   * the caller can register rollback ownership without a second lstat race. */
  readonly created?: { readonly ino: number; readonly dev: number };
}

const ORG_ID = /^org-[A-Za-z0-9]{1,128}$/;
const ADAPTER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function invalid(field: string): TunnelRefusal {
  return new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field);
}

/** Last 6 identity chars, case-preserved. Never includes any secret. */
function tail6(value: string): string {
  return value.slice(-6);
}

/**
 * Deterministic managed binding file name. Never carries an API key, a
 * credential reference, or a Store secret — only public identity fragments.
 * A same-name file with a different identity is refused (never silently reused);
 * the full identity is the authority, not the file name.
 */
export function managedBindingFileName(identity: ManagedBindingIdentity): string {
  if (!TUNNEL_ID.test(identity.tunnelId)) throw invalid("binding.tunnelId");
  const org = identity.organizationId;
  if (org !== undefined && !ORG_ID.test(org)) throw invalid("binding.organizationId");
  const orgPart = org === undefined ? "none" : tail6(org);
  return `ce-${tail6(identity.tunnelId)}-${orgPart}.yaml`;
}

/**
 * Stable content hash used to disambiguate same-name different-identity files
 * without ever widening message permissions. The full identity (and recipients)
 * participate, so a name collision never resolves to a foreign configuration.
 */
function contentDigest(config: ManagedBindingDocument): string {
  const canonical = JSON.stringify({
    managed: config.managed,
    store: config.store, exchange: config.exchange, endpoint: config.endpoint,
    recipients: config.recipients, lease: config.lease, payloadRead: config.payloadRead,
    ack: config.ack, debugExecutionGuard: config.debugExecutionGuard,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

interface ManagedBindingDocument {
  readonly version: typeof MCP_BINDING_CONFIG_VERSION;
  readonly managed: { readonly tunnelId: string; readonly organizationId: string | undefined; readonly adapter: string };
  readonly store: { readonly directory: string; readonly file: string };
  readonly exchange: { readonly namespace: string; readonly idempotencyKey: string };
  readonly endpoint: CeRecipientRef;
  readonly recipients: readonly CeRecipientRef[];
  readonly lease: { readonly ttlSeconds: number; readonly renewIntervalSeconds: number };
  readonly payloadRead: { readonly enabled: boolean };
  readonly ack: { readonly enabled: boolean };
  readonly debugExecutionGuard: { readonly enabled: boolean };
}

/** Stable full-identity digest for the runtime identity. The 6-char filename
 * tail is display-only; two tunnels whose tails collide must still get distinct
 * exchange namespaces, endpoints, and Stores. */
function identityDigest(identity: ManagedBindingIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.tunnelId, identity.organizationId ?? null, identity.adapter]), "utf8")
    .digest("hex").slice(0, 16);
}

const ENDPOINT_ID_MAX = 256;
const CREDENTIAL_SHAPED_LABEL = /cap_[0-9a-f]{16,}/i;
function endpointIdLabel(value: string): string {
  if (value.length === 0 || value.length > ENDPOINT_ID_MAX || value.includes("\u0000") || CREDENTIAL_SHAPED_LABEL.test(value)) {
    throw invalid("binding.endpointId");
  }
  return value;
}

function buildDocument(dir: string, input: ManagedBindingInput): ManagedBindingDocument {
  if (!ADAPTER.test(input.adapter)) throw invalid("binding.adapter");
  const namespace = `ce-${identityDigest(input)}`;
  const endpointId = input.endpointId === undefined ? namespace : endpointIdLabel(input.endpointId);
  return Object.freeze({
    version: MCP_BINDING_CONFIG_VERSION,
    managed: Object.freeze({ tunnelId: input.tunnelId, organizationId: input.organizationId, adapter: input.adapter }),
    store: Object.freeze({ directory: dir, file: "ce-store.sqlite" }),
    exchange: Object.freeze({ namespace, idempotencyKey: namespace }),
    endpoint: Object.freeze({ adapter: input.adapter, endpointId }),
    recipients: Object.freeze([...(input.recipients ?? [])]),
    lease: Object.freeze({ ttlSeconds: 120, renewIntervalSeconds: 30 }),
    payloadRead: Object.freeze({ enabled: input.capabilities?.payloadRead === true }),
    ack: Object.freeze({ enabled: input.capabilities?.ack === true }),
    debugExecutionGuard: Object.freeze({ enabled: false }),
  });
}

/** Inode identity a candidate must never match: the credential link (lstat)
 * and, for a symlink, its target (stat) — without opening credential contents. */
function credentialIdentity(credentialFile: string | undefined): readonly { dev: number; ino: number }[] | undefined {
  if (credentialFile === undefined) return undefined;
  try {
    const entry = fs.lstatSync(credentialFile);
    const target = entry.isSymbolicLink() ? fs.statSync(credentialFile) : entry;
    return [{ dev: entry.dev, ino: entry.ino }, { dev: target.dev, ino: target.ino }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid("binding.read");
  }
}

function readExisting(path: string, excluded?: readonly { dev: number; ino: number }[], credentialPath?: string): ManagedBindingDocument | undefined {
  // B-R4#1: exclude the credential BEFORE opening, mirroring the explicit-path
  // branch: exact path, and lstat identity (hardlink / symlink target), so the
  // credential file is never opened at all. The post-open fstat check below
  // remains as the race-proof recheck.
  if (credentialPath !== undefined) {
    if (path === credentialPath) throw invalid("binding.credential");
    if (excluded !== undefined) {
      let selected: fs.Stats;
      try {
        selected = fs.lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw invalid("binding.read");
      }
      if (excluded.some((id) => id.dev === selected.dev && id.ino === selected.ino)) throw invalid("binding.credential");
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid("binding.read");
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    // A-R1#3: a reused document must still be operator-owned and private; a
    // foreign or world-readable candidate is never trusted as a binding.
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600) throw invalid("binding.permissions");
    if (stat.size > MCP_BINDING_CONFIG_MAX_BYTES) throw invalid("binding.size");
    // A-R2#1: never read a candidate that is (or links to) the credential.
    if (excluded?.some((id) => id.dev === stat.dev && id.ino === stat.ino)) throw invalid("binding.credential");
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("binding.parse");
  }
  return parsed as ManagedBindingDocument;
}

/** The managed document must satisfy the SAME trusted-binding validator the MCP
 *  composition root uses, and carry an exact identity match. */
function validateManaged(document: ManagedBindingDocument, identity: ManagedBindingIdentity): McpBindingConfig {
  if (typeof document !== "object" || document === null) throw invalid("binding.managed");
  const managed = (document as { managed?: unknown }).managed;
  if (typeof managed !== "object" || managed === null) throw invalid("binding.managed");
  const m = managed as Record<string, unknown>;
  if (m.tunnelId !== identity.tunnelId || m.adapter !== identity.adapter) throw invalid("binding.managed");
  if ((m.organizationId ?? undefined) !== identity.organizationId) throw invalid("binding.managed");
  // Full content authority: the trusted parser revalidates every field.
  return parseMcpBindingConfig(document);
}

function ensureManagedDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw invalid("binding.directory");
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw invalid("binding.directory");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("binding.directory");
  if (stat.uid !== process.geteuid?.()) throw invalid("binding.directory");
  // A-R1#3: never adopt a pre-existing directory with looser permissions;
  // only a directory we created (or an already-private one) is acceptable.
  if ((stat.mode & 0o777) !== 0o700) throw invalid("binding.directory");
}

/** Write a new binding document O_EXCL and make it durable. Never overwrites. */
/** Durably sync a directory's entries; failure is a closed refusal. */
function syncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch {
    throw invalid("binding.durability");
  }
  try { fs.fsyncSync(fd); } catch { throw invalid("binding.durability"); } finally { fs.closeSync(fd); }
}

function writeNew(path: string, dir: string, document: ManagedBindingDocument): { readonly ino: number; readonly dev: number } {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  // C-R1: never persist a document the formal reader cannot read back.
  if (Buffer.byteLength(text, "utf8") > MCP_BINDING_CONFIG_MAX_BYTES) throw invalid("binding.size");
  // Validate before writing so a failed write never leaves a poisoned file the
  // next call would trip over in readExisting. A document we just built must
  // always validate; any failure is our own defect, surfaced as a closed code.
  try { parseMcpBindingConfig(JSON.parse(text)); } catch { throw invalid("binding.build"); }
  // A-R7#2: write to a unique unpublished STAGING generation first. Failure paths
  // only ever unlink this private random name — never the shared candidate
  // pathname — so cleanup cannot race a concurrent writer replacing the candidate.
  const staging = join(dir, `.staging-${randomUUID()}.yaml`);
  let fd: number;
  try {
    fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch {
    throw invalid("binding.write");
  }
  let stagingIno: number | undefined;
  let stagingDev: number | undefined;
  try {
    const stat = fs.fstatSync(fd);
    stagingIno = stat.ino; stagingDev = stat.dev;
    if (stat.mode !== 0o100600 || stat.uid !== process.geteuid?.()) throw invalid("binding.permissions");
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closing */ }
    // Remove only the private staging generation (identity-verified).
    try {
      const st = fs.lstatSync(staging);
      if (stagingIno !== undefined && st.ino === stagingIno && st.dev === stagingDev) fs.unlinkSync(staging);
    } catch { /* best effort */ }
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch { /* close after success is best-effort */ }
  // Post-write verification on the STAGING file before it is published, so a
  // failed verification never touches the shared candidate pathname.
  try {
    const back = fs.readFileSync(staging, "utf8");
    parseMcpBindingConfig(JSON.parse(back));
  } catch {
    try {
      const st = fs.lstatSync(staging);
      if (st.ino === stagingIno && st.dev === stagingDev) fs.unlinkSync(staging);
    } catch { /* best effort */ }
    throw invalid("binding.build");
  }
  // Publish atomically WITHOUT overwrite: a hard link to the candidate name fails
  // with EEXIST if a candidate already exists (atomic O_EXCL), so no existsSync
  // race and rename's overwrite semantics are never relied upon.
  try {
    fs.linkSync(staging, path);
  } catch {
    try { fs.unlinkSync(staging); } catch { /* best effort */ }
    throw invalid("binding.write");
  }
  // The candidate now shares the staging inode; remove the private staging name.
  try { fs.unlinkSync(staging); } catch { /* best effort */ }
  try {
    syncDirectory(dir);
  } catch {
    // A-R6: the file's content is complete and file-fsynced; only the directory
    // entry's durability is uncertain. Do NOT unlink by pathname — a concurrent
    // replacement could be deleted. Retain the candidate and refuse; a retry
    // re-syncs the directory on reuse (C-R7#1), so the refusal is idempotent.
    throw invalid("binding.durability");
  }
  // C-R8: return the STAGING generation's fd-captured identity (linkSync shares
  // the inode, so it IS the published file's identity) — never a fresh lstat of
  // the shared candidate pathname, which could adopt a concurrent replacement.
  return { ino: stagingIno!, dev: stagingDev! };
}

/** Exact identity match between a managed document's provenance and the request. */
function sameIdentity(document: ManagedBindingDocument, identity: ManagedBindingIdentity): boolean {
  const m = document.managed;
  return typeof m === "object" && m !== null && m.tunnelId === identity.tunnelId
    && m.adapter === identity.adapter && (m.organizationId ?? undefined) === identity.organizationId;
}

/**
 * Resolve or create the CE-managed binding for a tunnel identity.
 *
 * Candidate order: the identity-derived base name, then a stable content-hash
 * suffix. A candidate is reused only when its full managed identity matches AND
 * its content digest matches (same identity, unchanged recipients). A base file
 * carrying a different identity is never reused; the hash suffix disambiguates.
 * A changed recipient set produces a new generation file (like credentials):
 * the in-use file is never mutated, and old files remain operator-owned residue.
 */
export function ensureManagedBinding(profilePath: string, input: ManagedBindingInput): ManagedBindingResult {
  if (!isAbsolute(profilePath) || normalize(profilePath) !== profilePath) throw invalid("profile.path");
  const dir = join(dirname(profilePath), MANAGED_BINDING_DIRNAME);
  const base = managedBindingFileName(input);
  if (base.includes("/") || base.includes("\\") || base.includes("..")) throw invalid("binding.name");
  const document = buildDocument(dir, input);
  // C-R1: enforce the read size cap before creating anything, so an oversized
  // recipient set leaves no directory residue.
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, "utf8") > MCP_BINDING_CONFIG_MAX_BYTES) throw invalid("binding.size");
  // C-R5#2: formal-parse the serialized document BEFORE creating the directory,
  // so invalid input refuses with zero filesystem residue.
  try { parseMcpBindingConfig(JSON.parse(JSON.stringify(document, null, 2))); } catch { throw invalid("binding.build"); }
  const digest = contentDigest(document);
  const stem = base.slice(0, -".yaml".length);
  const candidates = [base, `${stem}-${digest.slice(0, 8)}.yaml`];

  ensureManagedDir(dir);
  const excluded = credentialIdentity(input.credentialFile);
  const credentialPath = input.credentialFile;
  for (const [index, name] of candidates.entries()) {
    const path = join(dir, name);
    const existing = readExisting(path, excluded, credentialPath);
    if (existing === undefined) {
      const created = writeNew(path, dir, document);
      // A-R8: the candidate was published from a pre-validated staging generation
      // via atomic linkSync, so its content is already valid. If this redundant
      // re-read somehow fails, RETAIN the candidate — never unlink the shared
      // pathname (a concurrent replacement could be deleted). A refusal is
      // idempotent: a retry reuses the retained valid file.
      const config = validateManaged(readExisting(path, excluded, credentialPath)!, input);
      return Object.freeze({ path, config, reused: false, created });
    }
    if (!sameIdentity(existing, input)) {
      // Same name, different identity: never reuse. Try the hash-suffixed
      // candidate; a mismatch there too is a hard refusal, never an overwrite.
      if (index === 0) continue;
      throw invalid("binding.collision");
    }
    const config = validateManaged(existing, input);
    if (contentDigest(existing) === digest) {
      // C-R7#1: a reused candidate may be a RETAINED file whose directory entry
      // was never durably synced (a prior writeNew dir-fsync failure). Re-sync the
      // directory before returning reuse, so a commit never references a binding
      // whose directory entry is still volatile.
      syncDirectory(dir);
      return Object.freeze({ path, config, reused: true });
    }
    // Same identity, changed content (e.g. recipients): the base stays untouched;
    // the digest candidate names the new generation. Never mutate the base file.
    if (index === 0) continue;
    throw invalid("binding.collision");
  }
  throw invalid("binding.collision");
}

const RECIPIENT_ADAPTER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Capability plaintext never belongs in a recipient label. */
const CREDENTIAL_SHAPED = /cap_[0-9a-f]{16,}/i;

/**
 * Parse the wizard's recipient list: comma-separated `adapter:endpointId`.
 * Empty input means no extra recipients — never a wildcard. Self-references,
 * duplicates, credential-shaped labels, and malformed entries are refused with
 * a closed code; nothing here grants send eligibility by itself (the binding's
 * `recipients` array remains the only source).
 */
export function parseRecipientList(text: string, self: CeRecipientRef): readonly CeRecipientRef[] {
  const trimmed = text.trim();
  if (trimmed === "") return Object.freeze([]);
  const seen = new Set<string>();
  const out: CeRecipientRef[] = [];
  for (const entry of trimmed.split(",")) {
    const pair = entry.trim();
    const separator = pair.indexOf(":");
    if (separator <= 0 || separator === pair.length - 1) throw invalid("binding.recipients");
    const adapter = pair.slice(0, separator);
    const endpointId = pair.slice(separator + 1);
    if (!RECIPIENT_ADAPTER.test(adapter) || endpointId.length > 256 || endpointId.includes("\u0000")) throw invalid("binding.recipients");
    if (CREDENTIAL_SHAPED.test(adapter) || CREDENTIAL_SHAPED.test(endpointId)) throw invalid("binding.recipients");
    if (adapter === self.adapter || endpointId === self.endpointId || seen.has(endpointId)) throw invalid("binding.recipients");
    seen.add(endpointId);
    out.push(Object.freeze({ adapter, endpointId }));
  }
  return Object.freeze(out);
}

/** Format recipients for the wizard's edit prefill. */
export function formatRecipientList(recipients: readonly CeRecipientRef[]): string {
  return recipients.map((r) => `${r.adapter}:${r.endpointId}`).join(", ");
}
