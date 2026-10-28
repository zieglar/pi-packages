/**
 * HANDOFF-CE-HOST-09 B1 — closed refusal vocabulary for the transport layer.
 *
 * Closed set = PHASE-A-DESIGN-v2 §5 baseline PLUS two B1-required codes
 * (CE_TUNNEL_CONFIG_CONFLICT for T17 dual-source drift detection, and
 * CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED for the R11 gate); codes with no B1
 * producer were trimmed in r2 (Lane D finding 3). Any future addition is a
 * design amendment that must be re-reviewed, not an enum append.
 * B1.1-INTEGRATION amendment (re-reviewed by Lane S/C over the frozen result):
 * CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED and CE_TUNNEL_KEYCHAIN_USER_CANCELED separate
 * native macOS authorization outcomes (-25293 / -128 classes, verified in
 * B1.1-KEYCHAIN-GATE) from generic unavailability, so an authorization failure is
 * never misreported as a missing credential.
 *
 * These codes describe ONLY local transport process/configuration outcomes.
 * They are deliberately separate from the frozen `CE_HOST_*` vocabulary: a
 * transport refusal never implies a CE delivery, ACK, ownership, or
 * reconciliation outcome. Like `CeHostRefusal`, a refusal carries a fixed code
 * plus an optional structural field path, and never a configuration value,
 * credential, payload, or underlying cause string.
 */
export const TUNNEL_REFUSAL_CODES = [
  "CE_TUNNEL_PROFILE_INVALID",
  "CE_TUNNEL_DOCTOR_FAILED",
  "CE_TUNNEL_SPAWN_FAILED",
  "CE_TUNNEL_READY_TIMEOUT",
  "CE_TUNNEL_EXTERNAL_INSTANCE",
  "CE_TUNNEL_KEY_MISSING",
  "CE_TUNNEL_KEY_PERMS_INVALID",
  "CE_TUNNEL_KEYCHAIN_UNAVAILABLE",
  "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED",
  "CE_TUNNEL_INPUT_UNAVAILABLE",
  "CE_TUNNEL_AUTOSTART_BLOCKED_COST",
  "CE_TUNNEL_HEALTH_UNAVAILABLE",
  "CE_TUNNEL_STOP_UNCONFIRMED",
  "CE_TUNNEL_CONFIG_CONFLICT",
  "CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED",
  "CE_TUNNEL_KEYCHAIN_USER_CANCELED",
  // LOCAL-BACKGROUND-01 amendment (reviewed with the background manager):
  "CE_TUNNEL_BACKGROUND_UNAUTHORIZED",
  "CE_TUNNEL_MANAGER_BUSY",
  "CE_TUNNEL_STATE_CORRUPT",
] as const;

export type TunnelRefusalCode = (typeof TUNNEL_REFUSAL_CODES)[number];

const MESSAGES: Readonly<Record<TunnelRefusalCode, string>> = Object.freeze({
  CE_TUNNEL_PROFILE_INVALID: "tunnel profile shape rejected; for the MCP Node command, verify trusted absolute CE_NODE_PATH (candidate Node >=24.12.0 within majors 24/25/26 with SQLite >=3.51.3 and proven capabilities)",
  CE_TUNNEL_DOCTOR_FAILED: "tunnel client preflight did not pass",
  CE_TUNNEL_SPAWN_FAILED: "tunnel client could not be started; verify trusted absolute CE_TUNNEL_CLIENT_PATH or a trusted system installation (no project PATH fallback)",
  CE_TUNNEL_READY_TIMEOUT: "tunnel client did not present health evidence in time",
  CE_TUNNEL_EXTERNAL_INSTANCE: "another tunnel client instance is present; this manager will not take it over",
  CE_TUNNEL_KEY_MISSING: "no authorized credential source is configured",
  CE_TUNNEL_KEY_PERMS_INVALID: "credential file ownership or permissions rejected",
  CE_TUNNEL_KEYCHAIN_UNAVAILABLE: "keychain is unavailable",
  CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED: "plaintext credential hand-off to the client is not authorized",
  CE_TUNNEL_INPUT_UNAVAILABLE: "secure input requires an interactive terminal session",
  CE_TUNNEL_AUTOSTART_BLOCKED_COST: "autostart is blocked while the connection cost policy is unresolved",
  CE_TUNNEL_HEALTH_UNAVAILABLE: "tunnel client health evidence is unavailable",
  CE_TUNNEL_STOP_UNCONFIRMED: "tunnel client stop could not be confirmed",
  CE_TUNNEL_CONFIG_CONFLICT: "two configuration sources disagree",
  CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED:
    "reading the credential needs a one-time macOS keychain authorization for this helper build",
  CE_TUNNEL_KEYCHAIN_USER_CANCELED: "the macOS keychain authorization prompt was dismissed",
  CE_TUNNEL_BACKGROUND_UNAUTHORIZED: "real background start requires the explicit CE_TUNNEL_BACKGROUND_ALLOW=1 opt-in",
  CE_TUNNEL_MANAGER_BUSY: "another manager holds this tunnel's ownership lock",
  CE_TUNNEL_STATE_CORRUPT: "the ownership record exists but is unreadable; refusing to guess",
});

/** A sanitized transport refusal: fixed code plus an optional field path. */
export class TunnelRefusal extends Error {
  readonly code: TunnelRefusalCode;
  readonly field: string | undefined;

  constructor(code: TunnelRefusalCode, field?: string) {
    super(field === undefined ? MESSAGES[code] : `${MESSAGES[code]} at ${field}`);
    this.name = "TunnelRefusal";
    this.code = code;
    this.field = field;
  }
}

export function isTunnelRefusalCode(value: unknown): value is TunnelRefusalCode {
  return typeof value === "string" && (TUNNEL_REFUSAL_CODES as readonly string[]).includes(value);
}
