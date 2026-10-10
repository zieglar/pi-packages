import { randomBytes } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { CAPABILITY_PATTERN, HOST_CAPABILITY_BYTES } from "./participant-identity.js";
import { deriveCapabilityDigest, digestsMatch, readHostSecretDigest } from "./trust-root.js";

/** Minimal read capability: satisfied by the accepted owned-transaction
 * handle and by a privileged read connection, so authorization can be
 * evaluated inside a mutation's transaction and by the host-local status read
 * without taking a write lock. */
export interface ReadableHandle {
  prepare(sql: string): { get(...parameters: SQLInputValue[]): unknown };
}

/**
 * Host Capability authorization plane (CE-0002-B3-P1B).
 *
 * A Host Capability is a 256-bit CSPRNG bearer token issued by the trusted
 * host. Only an HMAC digest keyed by the host secret is persisted
 * (`participant_capability.capability_digest`), so:
 *
 * - a Session ID or Participant ID alone never grants authorization — only
 *   presenting the token does;
 * - the stored digest cannot be replayed into another store, because the host
 *   secret keys the derivation;
 * - a token is bound to one trust generation, one Participant, and one exact
 *   scope, so it cannot be widened or transferred;
 * - an operator trust-root recovery invalidates every outstanding token twice
 *   over: by revocation (P1A) and by generation binding.
 *
 * Only the P1 scopes are operational in P1B. The remaining scopes exist in the
 * accepted schema vocabulary for later phases and are refused here.
 *
 * Verification always happens inside the caller's owned transaction, against
 * the same consistent snapshot as the mutation it authorizes. Refusals are a
 * single sanitized classification: the capability plane is never an oracle
 * that distinguishes "unknown" from "revoked", "expired", or "wrong scope".
 */

export const P1_CAPABILITY_SCOPES = ["create", "bind", "join"] as const;
export type P1CapabilityScope = (typeof P1_CAPABILITY_SCOPES)[number];

export function isP1CapabilityScope(value: unknown): value is P1CapabilityScope {
  return typeof value === "string" && (P1_CAPABILITY_SCOPES as readonly string[]).includes(value);
}

/** Host-local verification detail for the internal status read only. It is
 * never attached to an error, result, or audit row, so no caller-visible
 * surface can distinguish these cases. */
export type CapabilityStatus =
  | "VALID"
  | "UNKNOWN"
  | "SCOPE_MISMATCH"
  | "PARTICIPANT_MISMATCH"
  | "WRONG_GENERATION"
  | "REVOKED"
  | "EXPIRED"
  | "MALFORMED";

export interface CapabilityRow {
  readonly capability_digest: string;
  readonly participant_id: string;
  readonly scope: string;
  readonly trust_generation: number;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

/** Cryptographically random bearer token: `cap_` + 256 bits of hex. */
export function generateCapability(tokenBytes?: () => Uint8Array): string {
  const generated = (tokenBytes ?? (() => randomBytes(HOST_CAPABILITY_BYTES)))();
  if (!(generated instanceof Uint8Array) || generated.byteLength !== HOST_CAPABILITY_BYTES) {
    throw new Error("capability generator did not return exactly 256 bits");
  }
  return `cap_${Buffer.from(generated).toString("hex")}`;
}

function tokenBody(capability: unknown): string | undefined {
  if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) return undefined;
  return capability.slice("cap_".length);
}

export interface TrustGenerationRow {
  readonly generation: number;
  readonly secret_digest: string;
}

/** Current trust generation inside an owned transaction, with the same
 * append-only maximum rule the open path uses. Returns undefined when the
 * durable generation row is missing or structurally invalid; callers decide
 * whether that is corruption or a refusal. */
export function currentGenerationInTransaction(tx: ReadableHandle): TrustGenerationRow | undefined {
  const row = tx
    .prepare("SELECT generation, secret_digest FROM host_trust_root ORDER BY generation DESC LIMIT 1")
    .get() as { generation?: unknown; secret_digest?: unknown } | undefined;
  if (row === undefined) return undefined;
  if (
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    typeof row.secret_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.secret_digest)
  ) {
    return undefined;
  }
  return { generation: row.generation, secret_digest: row.secret_digest };
}

export function capabilityRow(tx: ReadableHandle, digest: string): CapabilityRow | undefined {
  const row = tx
    .prepare(
      "SELECT capability_digest, participant_id, scope, trust_generation, created_at, expires_at, revoked_at FROM participant_capability WHERE capability_digest = ?",
    )
    .get(digest) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (
    typeof row.capability_digest !== "string" ||
    typeof row.participant_id !== "string" ||
    typeof row.scope !== "string" ||
    typeof row.trust_generation !== "number" ||
    typeof row.created_at !== "string" ||
    !(row.expires_at === null || typeof row.expires_at === "string") ||
    !(row.revoked_at === null || typeof row.revoked_at === "string")
  ) {
    return undefined;
  }
  return row as unknown as CapabilityRow;
}

function instantOf(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface CapabilityPresentation {
  readonly capability: unknown;
  readonly participantId: string;
  readonly scope: P1CapabilityScope;
  /** Evaluation instant for expiry, supplied by the operation's clock. */
  readonly now: string;
}

/**
 * Classifies one presented capability inside an owned transaction.
 *
 * The host trust root is re-validated per authorization: the live secret file
 * must still pass the artifact policy and still match the persisted
 * fingerprint of the current generation. A trust-root failure propagates as a
 * typed trust-root refusal (fail closed), never as a capability rejection.
 */
export function classifyCapability(
  tx: ReadableHandle,
  databasePath: string,
  presentation: CapabilityPresentation,
): CapabilityStatus {
  const token = tokenBody(presentation.capability);
  if (token === undefined || !isP1CapabilityScope(presentation.scope)) return "MALFORMED";
  const now = instantOf(presentation.now);
  if (now === undefined) return "MALFORMED";

  const generation = currentGenerationInTransaction(tx);
  if (generation === undefined) return "UNKNOWN";
  // Host-secret trust validation: artifact policy plus fingerprint agreement.
  if (!digestsMatch(readHostSecretDigest(databasePath), generation.secret_digest)) {
    return "UNKNOWN";
  }

  const digest = deriveCapabilityDigest(databasePath, {
    generation: generation.generation,
    participantId: presentation.participantId,
    scope: presentation.scope,
    token,
  });
  const row = capabilityRow(tx, digest);
  if (row === undefined) {
    // Either the token is forged, or it was derived under another generation,
    // Participant, or scope. All are indistinguishable by construction.
    return "UNKNOWN";
  }
  if (row.participant_id !== presentation.participantId) return "PARTICIPANT_MISMATCH";
  if (row.scope !== presentation.scope) return "SCOPE_MISMATCH";
  if (row.trust_generation !== generation.generation) return "WRONG_GENERATION";
  if (row.revoked_at !== null) return "REVOKED";
  if (row.expires_at !== null) {
    const expiry = instantOf(row.expires_at);
    if (expiry === undefined) return "MALFORMED";
    if (expiry <= now) return "EXPIRED";
  }
  return "VALID";
}
