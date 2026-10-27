/**
 * HANDOFF-CE-HOST-09 B1 — operator-owned tunnel profile construction,
 * minimal child environment, and credential source gating.
 *
 * This module writes no file, reads no environment, and never touches a
 * credential value: it returns structures a caller may serialize. The CE MCP
 * binding is NOT produced here — the frozen 9-key binding validator rejects a
 * top-level `tunnel` field, so the two configurations stay in separate files
 * by construction.
 *
 * The admin UI section is emitted as the canonical minimal subset the real
 * `tunnel-client` 0.0.16 accepts: `open_browser` only. The client rejects the
 * nested `allow_remote_ui` key (it is a top-level flag, not an `admin_ui`
 * member) and rejects `log_buffer_events: 0` (it must be > 0); both were
 * removed to match the real schema. Remote UI stays disabled by default, and
 * the profile carries an explicit acknowledgement flag for the operator
 * documentation rather than an unfounded safety claim.
 */
import { isAbsolute, join, normalize } from "node:path";
import { TunnelRefusal } from "./codes.js";
import { APPROVED_NODE_VERSION } from "../storage/runtime.js";

/** Configuration-shaped refusal for profile construction. */
export class TunnelConfigError extends TunnelRefusal {
  constructor(field: string) {
    super("CE_TUNNEL_PROFILE_INVALID", field);
    this.name = "TunnelConfigError";
  }
}

export interface TunnelProfileInput {
  readonly tunnelId: string;
  readonly organizationId?: string;
  /** Absolute path to the credential file referenced as `file:` (never a value). */
  readonly keyFile: string;
  /** Absolute command line launching the CE MCP stdio server. */
  readonly mcpCommand: string;
  readonly healthUrlFile: string;
  readonly controlPlaneBaseUrl?: string;
}

export interface TunnelProfile {
  readonly config_version: 1;
  readonly control_plane: { readonly base_url: string; readonly tunnel_id: string; readonly organization_id?: string; readonly api_key: string };
  readonly health: { readonly listen_addr: string; readonly url_file: string };
  readonly admin_ui: { readonly open_browser: false };
  readonly harpoon: { readonly capture_payloads: false };
  readonly log: { readonly level: "info"; readonly format: "json"; readonly http_raw_unsafe: false };
  readonly mcp: { readonly commands: readonly { readonly channel: "main"; readonly command: string }[] };
  /**
   * Explicit record that loopback `/ui` remains reachable for same-user local
   * processes even with every documented switch disabled.
   */
  readonly localUiExposureAcknowledged: true;
}

const TUNNEL_ID_PATTERN = /^tunnel_[A-Za-z0-9]{8,}$/;
const CREDENTIAL_SHAPED = /(sk-[A-Za-z0-9_-]{8,})|(cap_[0-9a-f]{16,})|(BEGIN [A-Z ]*PRIVATE KEY)/i;

// Exact CE stdio argv, single-space separators, narrow ASCII paths. Space-
// bearing paths use single quotes; expansions, metacharacters and escapes are
// never accepted. This encoding is safe for a shell and for quote-aware argv
// splitters. R5 Lane A F1: a space-bearing path may not contain a segment that
// starts with '-', so even a naive whitespace split cannot forge an option.
// `@` is admitted ONLY as an ordinary absolute-path character so a normally
// scoped npm install (node_modules/@scope/pkg) can express its real runtime
// paths; absolute-path, normalization, quoting and argv rules are unchanged.
const COMMAND_PATH = /^\/[A-Za-z0-9_./@ -]+$/;
function isCommandPath(path: string): boolean {
  if (!COMMAND_PATH.test(path)) return false;
  return !path.includes(" ") || !path.split(" ").some((segment) => segment.startsWith("-"));
}
export function parseTunnelMcpCommand(command: string): { readonly nodePath: string; readonly scriptPath: string; readonly bindingPath: string } {
  const field = "mcp.commands.0.command";
  if (typeof command !== "string" || CREDENTIAL_SHAPED.test(command)) throw new TunnelConfigError(field);
  const tokens = command.match(/'[^']*'|[^ ']+/g) ?? [];
  if (tokens.join(" ") !== command) throw new TunnelConfigError(field);
  // Quoting is permitted only where required to encode a space-bearing path.
  // Keep the pre-existing canonical grammar for flags and ordinary paths.
  if (tokens.some((token, index) => token.startsWith("'") &&
      (![0, 1, 3].includes(index) || !token.includes(" ")))) throw new TunnelConfigError(field);
  const argv = tokens.map((token) => token.startsWith("'") ? token.slice(1, -1) : token);
  if (argv.length !== 4 && argv.length !== 6) throw new TunnelConfigError(field);
  const [executable, script, configFlag, configPath, channelFlag, channel] = argv;
  for (const path of [executable, script, configPath]) {
    if (path === undefined || !isCommandPath(path)) throw new TunnelConfigError(field);
    absolutePath(path, field);
  }
  if (!executable?.endsWith("/node") || !script?.endsWith("/mcp-stdio.js") || configFlag !== "--config") {
    throw new TunnelConfigError(field);
  }
  if (argv.length === 6 && (channelFlag !== "--channel" || channel !== "main")) throw new TunnelConfigError(field);
  return { nodePath: executable!, scriptPath: script!, bindingPath: configPath! };
}

export function buildTunnelMcpCommand(input: { readonly nodePath: string; readonly scriptPath: string; readonly bindingPath: string }): string {
  const quote = (path: string): string => {
    if (!isCommandPath(path)) throw new TunnelConfigError("mcp.commands.0.command");
    absolutePath(path, "mcp.commands.0.command");
    return path.includes(" ") ? `'${path}'` : path;
  };
  const command = `${quote(input.nodePath)} ${quote(input.scriptPath)} --config ${quote(input.bindingPath)}`;
  parseTunnelMcpCommand(command);
  return command;
}

/** Change only argv's config-path token. Existing executable/script quoting,
 * config flag and optional --channel main tokens remain byte-identical. */
export function replaceTunnelMcpBindingPath(command: string, bindingPath: string): string {
  const existing = parseTunnelMcpCommand(command);
  const encoded = buildTunnelMcpCommand({ nodePath: existing.nodePath, scriptPath: existing.scriptPath, bindingPath });
  const tokens = command.match(/'[^']*'|[^ ']+/g)!;
  tokens[3] = encoded.match(/'[^']*'|[^ ']+/g)![3]!;
  const next = tokens.join(" ");
  parseTunnelMcpCommand(next);
  return next;
}

/** Change only argv's node-executable token. Script path, binding path, and
 * the optional --channel main token remain byte-identical. */
export function replaceTunnelMcpNodePath(command: string, nodePath: string): string {
  const existing = parseTunnelMcpCommand(command);
  const rebuilt = buildTunnelMcpCommand({ nodePath, scriptPath: existing.scriptPath, bindingPath: existing.bindingPath });
  const tokens = command.match(/'[^']*'|[^ ']+/g)!;
  tokens[0] = rebuilt.match(/'[^']*'|[^ ']+/g)![0]!;
  const next = tokens.join(" ");
  parseTunnelMcpCommand(next);
  return next;
}

/** Pure validation, shared by the wizard adapter and the persistence layer. */
export function validateTunnelIdentity(tunnelId: string, organizationId?: string): void {
  if (typeof tunnelId !== "string" || !TUNNEL_ID_PATTERN.test(tunnelId)) throw new TunnelConfigError("control_plane.tunnel_id");
  if (organizationId !== undefined && organizationId !== "" &&
      (typeof organizationId !== "string" || !/^org-[A-Za-z0-9]{1,128}$/.test(organizationId))) {
    throw new TunnelConfigError("control_plane.organization_id");
  }
}

/** Only canonical, credential-free HTTPS may be serialized into the profile. */
function validateControlPlaneUrl(value: string): void {
  const field = "control_plane.base_url";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TunnelConfigError(field);
  }
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "" ||
    value.includes("?") || value.includes("#") ||
    (value !== url.href && !(value === url.origin && url.href === `${url.origin}/`))) {
    throw new TunnelConfigError(field);
  }
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) throw new TunnelConfigError(field);
  if (CREDENTIAL_SHAPED.test(value)) throw new TunnelConfigError(field);
  if (!isAbsolute(value) || normalize(value) !== value) throw new TunnelConfigError(field);
  return value;
}

/** Build the profile. Every exposure switch is explicit; the key stays a reference. */
export function buildTunnelProfile(input: TunnelProfileInput): TunnelProfile {
  validateTunnelIdentity(input.tunnelId, input.organizationId);
  const keyFile = absolutePath(input.keyFile, "control_plane.api_key");
  const healthUrlFile = absolutePath(input.healthUrlFile, "health.url_file");

  const command = input.mcpCommand;
  parseTunnelMcpCommand(command);

  const baseUrl = input.controlPlaneBaseUrl ?? "https://api.openai.com";
  validateControlPlaneUrl(baseUrl);

  return Object.freeze({
    config_version: 1,
    control_plane: Object.freeze({ base_url: baseUrl, tunnel_id: input.tunnelId,
      ...(input.organizationId ? { organization_id: input.organizationId } : {}), api_key: `file:${keyFile}` }),
    health: Object.freeze({ listen_addr: "127.0.0.1:0", url_file: healthUrlFile }),
    admin_ui: Object.freeze({ open_browser: false as const }),
    harpoon: Object.freeze({ capture_payloads: false as const }),
    log: Object.freeze({ level: "info" as const, format: "json" as const, http_raw_unsafe: false as const }),
    mcp: Object.freeze({ commands: Object.freeze([Object.freeze({ channel: "main" as const, command })]) }),
    localUiExposureAcknowledged: true as const,
  });
}

/** Serialize exactly the strict YAML subset accepted by the manager/client.
 * The acknowledgement is CE metadata, not a tunnel-client configuration key. */
export function serializeTunnelProfile(profile: TunnelProfile): string {
  const scalar = (value: string): string => {
    if (!/^[\x20\x21\x23-\x5B\x5D-\x7E]*$/.test(value)) throw new TunnelConfigError("profile.scalar");
    return `"${value}"`;
  };
  return [
    "config_version: 1", "control_plane:",
    `  base_url: ${scalar(profile.control_plane.base_url)}`,
    `  tunnel_id: ${scalar(profile.control_plane.tunnel_id)}`,
    ...(profile.control_plane.organization_id ? [`  organization_id: ${scalar(profile.control_plane.organization_id)}`] : []),
    `  api_key: ${scalar(profile.control_plane.api_key)}`,
    "health:", `  listen_addr: ${scalar(profile.health.listen_addr)}`, `  url_file: ${scalar(profile.health.url_file)}`,
    "admin_ui:", "  open_browser: false",
    "harpoon:", "  capture_payloads: false", "log:", "  level: info", "  format: json", "  http_raw_unsafe: false",
    "mcp:", "  commands:", "    - channel: main", `      command: ${scalar(profile.mcp.commands[0]!.command)}`, "",
  ].join("\n");
}

/**
 * r2 (Lane A finding 5 / Lane B NOTE 2): an explicit ALLOWLIST, not a denylist.
 * Only variables the official client actually needs to locate its binaries
 * and temp directory are passed through; every other inherited variable —
 * including any `*_TOKEN`/`*_KEY` never enumerated here — is dropped.
 * This function never adds a credential: the key reaches the client only via
 * the profile's `file:` reference.
 */
const ALLOWED_ENV_PATTERN = /^(PATH|HOME|TMPDIR|LANG|LC_[A-Z_]+|TZ|TERM|SSL_CERT_FILE|SSL_CERT_DIR)$/;

export function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (ALLOWED_ENV_PATTERN.test(name)) env[name] = value;
  }
  return env;
}

export interface CredentialSituation {
  readonly keychainAvailable: boolean;
  readonly keyFileExists: boolean;
  /** R11 is not authorized by default; only an explicit operator opt-in enables it. */
  /**
   * R11 opt-in. Strictly the boolean `true` (r2, Lane B NOTE 1): malformed
   * inputs such as the string "false" must NOT enable a plaintext hand-off.
   */
  readonly allowPlaintextTempFile: boolean;
}

export interface CredentialPlan {
  readonly source: "keychain" | "file" | "none";
  readonly clientHandoff: "temp-file" | "file" | "blocked";
  readonly blockedCode: import("./codes.js").TunnelRefusalCode | undefined;
  readonly warning: string | undefined;
}

/**
 * Decide where a credential comes from and whether it may legally reach the
 * official client. The client accepts only `file:`/`env:` references, so a
 * keychain-held secret requires a plaintext hand-off; that hand-off stays
 * BLOCKED unless the operator explicitly authorizes it.
 */
export function resolveCredentialPlan(situation: CredentialSituation): CredentialPlan {
  if (situation.keychainAvailable) {
    return Object.freeze({
      source: "keychain" as const,
      clientHandoff: situation.allowPlaintextTempFile === true ? ("temp-file" as const) : ("blocked" as const),
      blockedCode: situation.allowPlaintextTempFile === true ? undefined : "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED",
      warning: situation.allowPlaintextTempFile === true
        ? "temporary 0600 plaintext file exists between write and client read; residue is possible after SIGKILL"
        : undefined,
    });
  }
  if (situation.keyFileExists) {
    return Object.freeze({
      source: "file" as const,
      clientHandoff: "file" as const,
      blockedCode: undefined,
      warning: "credential is plaintext at rest in an operator-owned 0600 file",
    });
  }
  return Object.freeze({
    source: "none" as const,
    clientHandoff: "blocked" as const,
    blockedCode: "CE_TUNNEL_KEY_MISSING",
    warning: undefined,
  });
}

// ---------------------------------------------------------------------------
// T14 / T17 (Lane C required coverage): key-file metadata gate and dual-source
// configuration drift detection. Both are pure functions over stat-style
// inputs so B1 can pin them offline without any real secret material.
// ---------------------------------------------------------------------------

export interface KeyFileStat {
  /** Full st_mode including file-type bits, not permissions alone. */
  readonly mode: number;
  /** st_uid of the file. */
  readonly uid: number;
  /** The operator's own uid (process.geteuid()). */
  readonly ownerUid: number;
  readonly isSymbolicLink: boolean;
  readonly size: number;
}

export type KeyFileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CE_TUNNEL_KEY_PERMS_INVALID"; readonly reason: string };

/**
 * T14: a key file must be a NON-empty, REGULAR (non-symlink) file, owned by
 * the current operator, with owner-only permissions (0600 exactly).
 */
export function checkKeyFileRequirements(stat: KeyFileStat): KeyFileCheck {
  if (stat.isSymbolicLink) return { ok: false, code: "CE_TUNNEL_KEY_PERMS_INVALID", reason: "symbolic-link" };
  if (stat.uid !== stat.ownerUid) return { ok: false, code: "CE_TUNNEL_KEY_PERMS_INVALID", reason: "foreign-owner" };
  if (!Number.isSafeInteger(stat.mode) || stat.mode < 0 || (stat.mode & 0o170000) !== 0o100000) {
    return { ok: false, code: "CE_TUNNEL_KEY_PERMS_INVALID", reason: "not-regular-file" };
  }
  if (stat.mode !== 0o100600) return { ok: false, code: "CE_TUNNEL_KEY_PERMS_INVALID", reason: "not-exact-0600" };
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0) return { ok: false, code: "CE_TUNNEL_KEY_PERMS_INVALID", reason: "empty-or-invalid-size" };
  return { ok: true };
}

export interface ConfigDriftInput {
  readonly profileTunnelId: string;
  /** e.g. CONTROL_PLANE_TUNNEL_ID from the ambient environment. */
  readonly envTunnelId: string | undefined;
}

export type ConfigDriftCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CE_TUNNEL_CONFIG_CONFLICT"; readonly reason: string };

/**
 * T17: the two configuration sources must agree. An absent env override is
 * clean (the profile is the single source of truth); a disagreement is a hard
 * refusal because the operator could be about to connect the WRONG tunnel.
 */
export function detectConfigDrift(input: ConfigDriftInput): ConfigDriftCheck {
  if (input.envTunnelId !== undefined && input.envTunnelId !== input.profileTunnelId) {
    return { ok: false, code: "CE_TUNNEL_CONFIG_CONFLICT", reason: "env-profile-tunnel-id-mismatch" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// REAL-START-FIX-01 — MCP child Node resolution and profile migration.
// The durable Store refuses any Node whose exact version, bundled SQLite
// version, and SQLite source id do not match the approved runtime (see
// storage/runtime.ts), so the mcp child must resolve to the approved Node —
// never blindly to the Pi process's own runtime when that differs.
// ---------------------------------------------------------------------------

/** @deprecated Default version for the legacy pure location hint, not eligibility.
 * Actual host/child qualification uses storage/runtime.ts exact tuple registry. */
export const REQUIRED_MCP_NODE_VERSION: string = APPROVED_NODE_VERSION.replace(/^v/, "");

export interface ResolveMcpNodePathInput {
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly execVersion: string;
  readonly homeDir: string;
  readonly requiredVersion: string;
  readonly exists: (path: string) => boolean;
}

/** @deprecated Legacy pure location hint only, NOT executable admission or runtime
 * qualification. Retained for compatibility; production setup uses
 * runtime/executables.resolveApprovedNode and fails closed after full checks. */
export function resolveMcpNodePath(input: ResolveMcpNodePathInput): string | undefined {
  if (input.execVersion === `v${input.requiredVersion}` && input.execPath.length > 0) return input.execPath;
  const dataDir = input.env.MISE_DATA_DIR !== undefined && input.env.MISE_DATA_DIR !== ""
    ? input.env.MISE_DATA_DIR
    : join(input.homeDir, ".local", "share", "mise");
  const candidate = join(dataDir, "installs", "node", input.requiredVersion, "bin", "node");
  return input.exists(candidate) ? candidate : undefined;
}

export interface TunnelProfileMigration {
  readonly text: string;
  readonly changed: boolean;
}

// The two admin_ui keys the real tunnel-client 0.0.16 rejects: `allow_remote_ui`
// (a top-level flag, not an admin_ui member) and `log_buffer_events: 0` (must
// be > 0). They are emitted with a fixed two-space indent by our generator.
const ADMIN_UI_ALLOW_REMOTE_LINE = /^  allow_remote_ui:[^\n]*\n?/m;
const ADMIN_UI_LOG_BUFFER_LINE = /^  log_buffer_events:[^\n]*\n?/m;
const MCP_COMMAND_LINE = /^      command: "([^"]*)"$/m;

/** True when a saved profile still carries a key the real client rejects. */
export function needsTunnelProfileMigration(text: string): boolean {
  return ADMIN_UI_ALLOW_REMOTE_LINE.test(text) || ADMIN_UI_LOG_BUFFER_LINE.test(text);
}

/** Rewrite a saved profile in place: drop the two rejected admin_ui keys and,
 *  when a node path is supplied, repoint the mcp command's node executable
 *  while preserving the script path, binding path, and --channel main token
 *  byte-for-byte. Never touches tunnel_id, organization_id, api_key, or any
 *  other line. */
export function migrateTunnelProfileText(text: string, opts: { readonly nodePath?: string } = {}): TunnelProfileMigration {
  let next = text;
  let changed = false;
  if (ADMIN_UI_ALLOW_REMOTE_LINE.test(next)) { next = next.replace(ADMIN_UI_ALLOW_REMOTE_LINE, ""); changed = true; }
  if (ADMIN_UI_LOG_BUFFER_LINE.test(next)) { next = next.replace(ADMIN_UI_LOG_BUFFER_LINE, ""); changed = true; }
  if (opts.nodePath !== undefined) {
    const match = MCP_COMMAND_LINE.exec(next);
    if (match !== null) {
      const rebuilt = replaceTunnelMcpNodePath(match[1]!, opts.nodePath);
      if (rebuilt !== match[1]) {
        next = next.replace(MCP_COMMAND_LINE, () => `      command: "${rebuilt}"`);
        changed = true;
      }
    }
  }
  return { text: next, changed };
}
