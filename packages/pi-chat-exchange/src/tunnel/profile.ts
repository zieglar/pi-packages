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
 * Mandatory client-exposure switches (design S1–S4) are emitted
 * unconditionally. Disabling them does not prove the local admin UI is
 * unreachable: the client serves `/ui` on loopback by default (measured), so
 * the profile carries an explicit acknowledgement flag for the operator
 * documentation rather than an unfounded safety claim.
 */
import { isAbsolute, normalize } from "node:path";
import { TunnelRefusal } from "./codes.js";

/** Configuration-shaped refusal for profile construction. */
export class TunnelConfigError extends TunnelRefusal {
  constructor(field: string) {
    super("CE_TUNNEL_PROFILE_INVALID", field);
    this.name = "TunnelConfigError";
  }
}

export interface TunnelProfileInput {
  readonly tunnelId: string;
  /** Absolute path to the credential file referenced as `file:` (never a value). */
  readonly keyFile: string;
  /** Absolute command line launching the CE MCP stdio server. */
  readonly mcpCommand: string;
  readonly healthUrlFile: string;
  readonly controlPlaneBaseUrl?: string;
}

export interface TunnelProfile {
  readonly config_version: 1;
  readonly control_plane: { readonly base_url: string; readonly tunnel_id: string; readonly api_key: string };
  readonly health: { readonly listen_addr: string; readonly url_file: string };
  readonly admin_ui: { readonly open_browser: false; readonly allow_remote_ui: false; readonly log_buffer_events: 0 };
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

// Legacy serialization is NOT a shell language. Only exact CE stdio argv,
// single-space separators and narrow ASCII paths: no expansions or quoting.
const COMMAND_PATH = /^\/[A-Za-z0-9_./-]+$/;
function validateMcpCommand(command: string): void {
  const field = "mcp.commands.0.command";
  if (typeof command !== "string" || CREDENTIAL_SHAPED.test(command)) throw new TunnelConfigError(field);
  const argv = command.split(" ");
  if (argv.length !== 4 && argv.length !== 6) throw new TunnelConfigError(field);
  const [executable, script, configFlag, configPath, channelFlag, channel] = argv;
  for (const path of [executable, script, configPath]) {
    if (path === undefined || !COMMAND_PATH.test(path)) throw new TunnelConfigError(field);
    absolutePath(path, field);
  }
  if (!executable?.endsWith("/node") || !script?.endsWith("/mcp-stdio.js") || configFlag !== "--config") {
    throw new TunnelConfigError(field);
  }
  if (argv.length === 6 && (channelFlag !== "--channel" || channel !== "main")) throw new TunnelConfigError(field);
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
  if (typeof input.tunnelId !== "string" || !TUNNEL_ID_PATTERN.test(input.tunnelId)) {
    throw new TunnelConfigError("control_plane.tunnel_id");
  }
  const keyFile = absolutePath(input.keyFile, "control_plane.api_key");
  const healthUrlFile = absolutePath(input.healthUrlFile, "health.url_file");

  const command = input.mcpCommand;
  validateMcpCommand(command);

  const baseUrl = input.controlPlaneBaseUrl ?? "https://api.openai.com";
  validateControlPlaneUrl(baseUrl);

  return Object.freeze({
    config_version: 1,
    control_plane: Object.freeze({ base_url: baseUrl, tunnel_id: input.tunnelId, api_key: `file:${keyFile}` }),
    health: Object.freeze({ listen_addr: "127.0.0.1:0", url_file: healthUrlFile }),
    admin_ui: Object.freeze({ open_browser: false as const, allow_remote_ui: false as const, log_buffer_events: 0 as const }),
    harpoon: Object.freeze({ capture_payloads: false as const }),
    log: Object.freeze({ level: "info" as const, format: "json" as const, http_raw_unsafe: false as const }),
    mcp: Object.freeze({ commands: Object.freeze([Object.freeze({ channel: "main" as const, command })]) }),
    localUiExposureAcknowledged: true as const,
  });
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
