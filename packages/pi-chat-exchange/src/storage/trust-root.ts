import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StoreLifecycleError } from "./errors.js";
import { pathStat } from "./filesystem.js";

/**
 * Host Trust Root (CE-0002-B3-P1A). The host secret is a 256-bit random value
 * hex-encoded into a `host-secret` file inside the private store directory,
 * created exclusively with O_NOFOLLOW at mode 0600 under the same filesystem
 * enforcement the database itself passes. Only its SHA-256 digest is ever
 * persisted, in the append-only `host_trust_root` table; the plaintext secret
 * never enters SQLite, results, errors, or logs.
 *
 * Protection equals the documented filesystem trust boundary: an attacker
 * controlling both the database and the secret file can rewrite both
 * consistently, and no protection against that actor is claimed.
 */

export const HOST_SECRET_FILENAME = "host-secret";
export const HOST_SECRET_BYTES = 32;
const HOST_SECRET_HEX_LENGTH = HOST_SECRET_BYTES * 2;
const HOST_SECRET_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function hostSecretPath(databasePath: string): string {
  return join(dirname(databasePath), HOST_SECRET_FILENAME);
}

export function hostSecretDigest(secretHex: string): string {
  return createHash("sha256").update(secretHex, "utf8").digest("hex");
}

function captureSecret(secretBytes: (() => Uint8Array) | undefined): string {
  const generated = secretBytes ?? (() => randomBytes(HOST_SECRET_BYTES));
  const candidate: unknown = generated();
  if (!(candidate instanceof Uint8Array) || candidate.byteLength !== HOST_SECRET_BYTES) {
    throw new StoreLifecycleError(
      "STORAGE_CORRUPT",
      "host secret generator did not return exactly 256 bits",
    );
  }
  return Buffer.from(candidate).toString("hex");
}

/** A preexisting secret is ambiguous evidence (interrupted initialization,
 * interrupted migration, or external placement). It is never overwritten or
 * deleted automatically; explicit operator removal is required first. */
export function assertTrustRootAbsent(databasePath: string): void {
  if (pathStat(hostSecretPath(databasePath)) !== undefined) {
    throw new StoreLifecycleError(
      "STORAGE_TRUST_ROOT_AMBIGUOUS",
      "an existing host secret requires explicit operator removal; refusing to overwrite",
    );
  }
}

/** Creates the secret file and returns its SHA-256 digest. Exclusive creation:
 * a racing or preexisting name fails closed. The caller persists the digest in
 * the same owned transaction as the schema change it accompanies. */
export function createHostSecretFile(
  databasePath: string,
  secretBytes?: () => Uint8Array,
): string {
  const secretHex = captureSecret(secretBytes);
  const path = hostSecretPath(databasePath);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw new StoreLifecycleError(
      "STORAGE_TRUST_ROOT_AMBIGUOUS",
      "an existing host secret requires explicit operator removal; refusing to overwrite",
      { cause: error },
    );
  }
  try {
    writeSync(fd, secretHex);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return hostSecretDigest(secretHex);
}

/** Reads the current host secret through the full artifact policy and returns
 * the plaintext hex, or throws a typed trust-root refusal. The plaintext never
 * leaves this module: only digests derived from it are returned to callers. */
function readValidatedHostSecretHex(databasePath: string): string {
  const path = hostSecretPath(databasePath);
  const stat = pathStat(path);
  if (stat === undefined) {
    throw new StoreLifecycleError("STORAGE_TRUST_ROOT_MISSING", "the host secret file is missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StoreLifecycleError(
      "STORAGE_TRUST_ROOT_INSECURE",
      "the host secret must be a regular file, not a symlink",
    );
  }
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
    throw new StoreLifecycleError(
      "STORAGE_TRUST_ROOT_INSECURE",
      "the host secret ownership cannot be established for the current user",
    );
  }
  if ((Number(stat.mode) & 0o777) !== 0o600) {
    throw new StoreLifecycleError("STORAGE_TRUST_ROOT_INSECURE", "the host secret must have mode 600");
  }
  if (stat.size !== HOST_SECRET_HEX_LENGTH) {
    throw new StoreLifecycleError("STORAGE_TRUST_ROOT_INSECURE", "the host secret has an invalid length");
  }
  let secretHex: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      secretHex = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new StoreLifecycleError("STORAGE_TRUST_ROOT_INSECURE", "the host secret cannot be read safely", {
      cause: error,
    });
  }
  if (!HOST_SECRET_HEX_PATTERN.test(secretHex)) {
    throw new StoreLifecycleError("STORAGE_TRUST_ROOT_INSECURE", "the host secret has an invalid encoding");
  }
  return secretHex;
}

/** Reads the current host secret through the full artifact policy and returns
 * its SHA-256 fingerprint, or throws a typed trust-root refusal. */
export function readHostSecretDigest(databasePath: string): string {
  return hostSecretDigest(readValidatedHostSecretHex(databasePath));
}

/** Capability digest derivation (CE-0002-B3-P1B).
 *
 * A Host Capability is a 256-bit random bearer token. Only an HMAC-SHA256
 * digest keyed by the host secret is persisted, so the stored digest is
 * useless without the host trust root: copying `participant_capability` rows
 * into another store (or keeping them across an operator trust-root recovery)
 * cannot reproduce a verifying digest. The derivation binds the token to the
 * trust generation, the Participant, and the exact scope, so a token is never
 * transferable across generations, Participants, or scopes.
 *
 * The plaintext token and the host secret never enter SQLite, results, errors,
 * or logs. Callers receive only this digest.
 */
export function deriveCapabilityDigest(
  databasePath: string,
  binding: {
    readonly generation: number;
    readonly participantId: string;
    readonly scope: string;
    readonly token: string;
  },
): string {
  const secretHex = readValidatedHostSecretHex(databasePath);
  return createHmac("sha256", secretHex)
    .update(
      [
        "chat-exchange/capability",
        "v1",
        String(binding.generation),
        binding.participantId,
        binding.scope,
        binding.token,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

/** Constant-time comparison of two equal-length hex digests. Length mismatch
 * is rejected without comparing, and never reveals which digest was shorter. */
export function digestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export interface TrustRootRow {
  readonly generation: number;
  readonly secret_digest: string;
}

/** The current trust generation is the highest append-only row. */
export function currentTrustGeneration(db: DatabaseSync): TrustRootRow | undefined {
  return db
    .prepare("SELECT generation, secret_digest FROM host_trust_root ORDER BY generation DESC LIMIT 1")
    .get() as TrustRootRow | undefined;
}

/** Every-open validation for v2 stores: the secret file must exist, pass the
 * artifact policy, and match the persisted fingerprint of the current
 * generation. Any disagreement fails closed with no writes and no repair. */
export function validateTrustRoot(databasePath: string, db: DatabaseSync): void {
  const digest = readHostSecretDigest(databasePath);
  const current = currentTrustGeneration(db);
  if (current === undefined) {
    throw new StoreLifecycleError("STORAGE_CORRUPT", "a v2 store has no host trust root generation");
  }
  if (digest !== current.secret_digest) {
    throw new StoreLifecycleError(
      "STORAGE_TRUST_ROOT_MISMATCH",
      "the host secret does not match the persisted trust-root fingerprint",
    );
  }
}
