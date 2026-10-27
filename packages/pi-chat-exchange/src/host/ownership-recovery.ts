/**
 * Explicit operator-only stale ownership recovery.
 *
 * This is the production caller for CE-TAKEOVER-RECOVERY-CALLER-001. It is not
 * reachable from MCP tools or model arguments. The caller must identify the
 * exact durable owner it inspected; only an expired owner may be superseded.
 * Recovery reuses the existing Session/capability/takeover/release/detach
 * primitives and never edits ownership rows directly.
 */
import {
  bindSession,
  detachSession,
  generateSessionId,
  LEASE_DEFAULT_TTL_SECONDS,
  LEASE_MAX_TTL_SECONDS,
  LEASE_MIN_TTL_SECONDS,
  readCurrentOwnership,
  readFencingHighWater,
  readLeaseStatus,
  readSessionLifecycle,
  releaseOwnership,
  SESSION_ID_PATTERN,
  takeoverOwnership,
  type OwnershipRecord,
} from "../storage/ownership.js";
import { issueCapability, readParticipantByEndpoint, type ClockSeam } from "../storage/participant.js";
import type { DurableStore } from "../storage/store.js";

export type CeRecoveryErrorCode =
  | "CE_RECOVERY_INVALID_REQUEST"
  | "CE_RECOVERY_TARGET_MISMATCH"
  | "CE_RECOVERY_OWNER_ABSENT"
  | "CE_RECOVERY_OWNER_MISMATCH"
  | "CE_RECOVERY_OWNER_ACTIVE"
  | "CE_RECOVERY_CLOCK_REGRESSION"
  | "CE_RECOVERY_RACE_LOST"
  | "CE_RECOVERY_BUSY"
  | "CE_RECOVERY_OUTCOME_UNKNOWN"
  | "CE_RECOVERY_FAILED";

const ERROR_DETAIL: Record<CeRecoveryErrorCode, string> = {
  CE_RECOVERY_INVALID_REQUEST: "recovery request rejected",
  CE_RECOVERY_TARGET_MISMATCH: "configured endpoint does not match a durable Participant",
  CE_RECOVERY_OWNER_ABSENT: "target endpoint has no ownership row",
  CE_RECOVERY_OWNER_MISMATCH: "current ownership does not match the operator-confirmed evidence",
  CE_RECOVERY_OWNER_ACTIVE: "current ownership lease is active; recovery refused",
  CE_RECOVERY_CLOCK_REGRESSION: "operation clock precedes the persisted lease term",
  CE_RECOVERY_RACE_LOST: "durable ownership changed during recovery; no retry performed",
  CE_RECOVERY_BUSY: "durable store is contended; recovery rolled back",
  CE_RECOVERY_OUTCOME_UNKNOWN: "recovery outcome is unknown; inspect durable state and do not retry",
  CE_RECOVERY_FAILED: "recovery failed closed",
};

export class CeRecoveryError extends Error {
  readonly retryable = false;
  constructor(readonly code: CeRecoveryErrorCode) {
    super(ERROR_DETAIL[code]);
    this.name = "CeRecoveryError";
  }
}

export interface ExpectedOwnerEvidence {
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly leaseStartedAt: string | null;
  readonly expiresAt: string;
}

export interface RecoverExpiredOwnershipRequest {
  readonly adapter: string;
  readonly endpointId: string;
  readonly expectedOwner: ExpectedOwnerEvidence;
  readonly leaseTtlSeconds?: number;
}

export interface RecoveryReceipt {
  readonly version: 1;
  readonly disposition: "RECOVERED";
  readonly endpoint: { readonly adapter: string; readonly endpointId: string };
  readonly participantId: string;
  readonly supersededOwner: ExpectedOwnerEvidence;
  readonly recoverySessionId: string;
  readonly takeover: {
    readonly fencingToken: number;
    readonly leaseStartedAt: string;
    readonly expiresAt: string;
  };
  readonly releasedAt: string;
  readonly detachedAt: string;
  readonly final: {
    readonly ownership: "UNOWNED";
    readonly fencingHighWater: number;
    readonly recoverySession: "DETACHED";
  };
}

/** Private deterministic/fault seams for isolated tests. Production omits all. */
export interface RecoverySeams extends ClockSeam {
  readonly sessionId?: () => string;
  readonly afterTakeover?: () => void;
}

function invalid(): never {
  throw new CeRecoveryError("CE_RECOVERY_INVALID_REQUEST");
}

function plain(value: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) invalid();
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}

function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) invalid();
  return value;
}

function instant(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid();
  return value;
}

function normalizeRequest(input: unknown): Required<RecoverExpiredOwnershipRequest> {
  const fields = plain(input, ["adapter", "endpointId", "expectedOwner", "leaseTtlSeconds"], ["adapter", "endpointId", "expectedOwner"]);
  const owner = plain(
    fields.expectedOwner,
    ["sessionId", "fencingToken", "leaseStartedAt", "expiresAt"],
    ["sessionId", "fencingToken", "leaseStartedAt", "expiresAt"],
  );
  if (typeof owner.sessionId !== "string" || !SESSION_ID_PATTERN.test(owner.sessionId)) invalid();
  if (typeof owner.fencingToken !== "number" || !Number.isSafeInteger(owner.fencingToken) || owner.fencingToken < 1) invalid();
  const ttl = fields.leaseTtlSeconds === undefined ? LEASE_DEFAULT_TTL_SECONDS : fields.leaseTtlSeconds;
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < LEASE_MIN_TTL_SECONDS ||
    ttl > LEASE_MAX_TTL_SECONDS
  ) invalid();
  return Object.freeze({
    adapter: label(fields.adapter, 64),
    endpointId: label(fields.endpointId, 256),
    expectedOwner: Object.freeze({
      sessionId: owner.sessionId,
      fencingToken: owner.fencingToken,
      leaseStartedAt: instant(owner.leaseStartedAt, true),
      expiresAt: instant(owner.expiresAt) as string,
    }),
    leaseTtlSeconds: ttl,
  });
}

function exactOwner(actual: OwnershipRecord, expected: ExpectedOwnerEvidence): boolean {
  return actual.sessionId === expected.sessionId &&
    actual.fencingToken === expected.fencingToken &&
    actual.leaseStartedAt === expected.leaseStartedAt &&
    actual.expiresAt === expected.expiresAt;
}

function property(error: unknown, name: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return Object.getOwnPropertyDescriptor(error, name)?.value;
}

/** Classification valid ONLY before the takeover commits: every outcome here is
 * either a refusal or a proven rollback. */
function mapPreWriteError(error: unknown): CeRecoveryError {
  if (error instanceof CeRecoveryError) return error;
  if (property(error, "outcome") === "INDETERMINATE") return new CeRecoveryError("CE_RECOVERY_OUTCOME_UNKNOWN");
  const code = property(error, "code");
  if (code === "OWNERSHIP_HELD" || code === "OWNERSHIP_TAKEOVER_INELIGIBLE" || code === "OWNERSHIP_TAKEOVER_REQUIRED") {
    return new CeRecoveryError("CE_RECOVERY_RACE_LOST");
  }
  if (property(error, "retryable") === true && property(error, "outcome") === "ROLLED_BACK") {
    return new CeRecoveryError("CE_RECOVERY_BUSY");
  }
  return new CeRecoveryError("CE_RECOVERY_FAILED");
}

function cleanupKnownOrphan(
  store: DurableStore,
  participantId: string,
  sessionId: string,
  resumeCapability: string,
  seams: ClockSeam,
): void {
  try {
    detachSession(store, { participantId, sessionId, capability: resumeCapability }, seams);
  } catch {
    // Best effort only: the primary refusal stays authoritative, exactly as the
    // shared host seam does for a refused start's orphan Session.
  }
}

/**
 * Recover one exact expired owner and leave the Participant UNOWNED so its normal
 * host can acquire a fresh, strictly greater fencing token. The structured
 * receipt is operator evidence only; it contains identifiers and term evidence,
 * never capability plaintext or the host secret.
 */
export function recoverExpiredOwnership(
  store: DurableStore,
  input: unknown,
  seams: RecoverySeams = {},
): RecoveryReceipt {
  const request = normalizeRequest(input);
  // Preflight reads stay inside the typed surface: a contended or corrupt store
  // must not escape as a raw storage error with a misleading CLI diagnosis.
  let participant;
  let previous;
  let status;
  try {
    participant = readParticipantByEndpoint(store, request.adapter, request.endpointId);
    if (participant === undefined) throw new CeRecoveryError("CE_RECOVERY_TARGET_MISMATCH");
    previous = readCurrentOwnership(store, participant.participantId);
    status = previous === undefined
      ? undefined
      : readLeaseStatus(store, { participantId: participant.participantId }, seams);
  } catch (error) {
    throw mapPreWriteError(error);
  }
  if (previous === undefined) throw new CeRecoveryError("CE_RECOVERY_OWNER_ABSENT");
  if (!exactOwner(previous, request.expectedOwner)) throw new CeRecoveryError("CE_RECOVERY_OWNER_MISMATCH");
  if (status === "ACTIVE") throw new CeRecoveryError("CE_RECOVERY_OWNER_ACTIVE");
  if (status === "CLOCK_REGRESSION") throw new CeRecoveryError("CE_RECOVERY_CLOCK_REGRESSION");
  if (status !== "EXPIRED") throw new CeRecoveryError("CE_RECOVERY_OWNER_ABSENT");

  const recoverySessionId = (seams.sessionId ?? generateSessionId)();
  if (!SESSION_ID_PATTERN.test(recoverySessionId)) invalid();

  let resumeCapability: string | undefined;
  try {
    const attachCapability = issueCapability(store, { participantId: participant.participantId, scope: "attach" }, seams).capability;
    bindSession(store, { participantId: participant.participantId, sessionId: recoverySessionId, capability: attachCapability }, seams);
    resumeCapability = issueCapability(
      store,
      { participantId: participant.participantId, scope: "resume", sessionId: recoverySessionId },
      seams,
    ).capability;
    const takeoverCapability = issueCapability(
      store,
      { participantId: participant.participantId, scope: "takeover", sessionId: recoverySessionId },
      seams,
    ).capability;

    let takeover;
    try {
      takeover = takeoverOwnership(
        store,
        {
          participantId: participant.participantId,
          sessionId: recoverySessionId,
          capability: takeoverCapability,
          leaseTtlSeconds: request.leaseTtlSeconds,
        },
        seams,
      );
    } catch (error) {
      const mapped = mapPreWriteError(error);
      if (mapped.code !== "CE_RECOVERY_OUTCOME_UNKNOWN") {
        cleanupKnownOrphan(store, participant.participantId, recoverySessionId, resumeCapability, seams);
      }
      throw mapped;
    }

    // The takeover has committed. From here no failure is a proven rollback, so
    // every later problem is an unknown outcome requiring operator inspection:
    // reporting "rolled back" or "failed closed" would be untrue.
    let released;
    let detached;
    let highWater;
    try {
      seams.afterTakeover?.();
      released = releaseOwnership(
        store,
        {
          participantId: participant.participantId,
          sessionId: recoverySessionId,
          fencingToken: takeover.fencingToken,
          capability: resumeCapability,
        },
        seams,
      );
      detached = detachSession(
        store,
        { participantId: participant.participantId, sessionId: recoverySessionId, capability: resumeCapability },
        seams,
      );
      const finalOwner = readCurrentOwnership(store, participant.participantId);
      const lifecycle = readSessionLifecycle(store, { participantId: participant.participantId, sessionId: recoverySessionId });
      highWater = readFencingHighWater(store, participant.participantId);
      if (
        finalOwner !== undefined ||
        lifecycle.state !== "DETACHED" ||
        lifecycle.detachedAt === undefined ||
        highWater !== takeover.fencingToken
      ) {
        throw new CeRecoveryError("CE_RECOVERY_OUTCOME_UNKNOWN");
      }
    } catch {
      throw new CeRecoveryError("CE_RECOVERY_OUTCOME_UNKNOWN");
    }

    return Object.freeze({
      version: 1 as const,
      disposition: "RECOVERED" as const,
      endpoint: Object.freeze({ adapter: request.adapter, endpointId: request.endpointId }),
      participantId: participant.participantId,
      supersededOwner: request.expectedOwner,
      recoverySessionId,
      takeover: Object.freeze({
        fencingToken: takeover.fencingToken,
        leaseStartedAt: takeover.leaseStartedAt,
        expiresAt: takeover.expiresAt,
      }),
      releasedAt: released.releasedAt,
      detachedAt: detached.detachedAt,
      final: Object.freeze({
        ownership: "UNOWNED" as const,
        fencingHighWater: highWater,
        recoverySession: "DETACHED" as const,
      }),
    });
  } catch (error) {
    if (error instanceof CeRecoveryError) throw error;
    if (resumeCapability !== undefined) {
      try {
        const current = readCurrentOwnership(store, participant.participantId);
        if (current === undefined || current.sessionId !== recoverySessionId) {
          cleanupKnownOrphan(store, participant.participantId, recoverySessionId, resumeCapability, seams);
        }
      } catch {
        // Best effort only: the original failure stays authoritative.
      }
    }
    throw mapPreWriteError(error);
  }
}
