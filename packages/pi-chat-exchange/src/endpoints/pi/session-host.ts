/**
 * CE-0002 B3-P3B — Pi-type-free host integration seam.
 *
 * This module is the ONLY host-side composition layer the Pi extension talks
 * to. It deliberately imports no Pi SDK types (the package contract forbids
 * `@earendil-works/*` anywhere under `src/`), so the adapter is verified
 * against plain data in and plain data out.
 *
 * Trust boundary:
 * - The operator-controlled allowlist is the only source of Endpoint
 *   eligibility. Model/tool arguments can never register a Participant, issue
 *   a capability, or change ownership: those operations happen only through
 *   host policy (`beginSession`) or validated mapping recovery (`resume`).
 * - Capability plaintext exists only in this process's memory table and is
 *   never returned, logged, persisted, or placed in any mapping payload.
 * - Host-secret access stays inside the trusted storage plane; this adapter
 *   never reads the secret file itself — `issueCapability` enforces the
 *   trust-root contract in its own owned transaction.
 * - P3A authority checks (exact Session-bound capability, ATTACHED Session,
 *   current Owner, monotonic fencing, active lease, membership, immutable
 *   endpoint binding, authority-before-replay) are preserved untouched; this
 *   adapter only delegates and maps refusals to sanitized codes.
 * - No takeover recovery: an expired or superseded lease is refused as
 *   `CE_HOST_AUTHORITY_ABSENT` (CE-TAKEOVER-RECOVERY-CALLER-001 stays
 *   unresolved). Restart never implies ownership recovery.
 */
import { PI_ADAPTER_KIND } from "./contract.js";
import { EXCHANGE_ID_PATTERN, MESSAGE_ID_PATTERN } from "../../protocol/identity.js";
import { CreationDomainError } from "../../storage/creation.js";
import { createExchange } from "../../storage/creation.js";
import { CreationRequestError } from "../../storage/creation-request.js";
import { StoreLifecycleError } from "../../storage/errors.js";
import {
  type AuthorizedMessageCreation,
  type ProtectedMessageMetadata,
  readMessageMetadata,
  sendMessage,
} from "../../storage/messaging.js";
import { discoverInboxMessages } from "../../storage/inbox-discovery.js";
import {
  captureFields,
  isParticipantId,
  isSessionId,
  ParticipantRequestError,
} from "../../storage/participant-identity.js";
import {
  createParticipant,
  ParticipantDomainError,
  issueCapability,
  joinExchange,
  readParticipantByEndpoint,
  type ClockSeam,
} from "../../storage/participant.js";
import {
  acquireOwnership,
  bindSession,
  generateSessionId,
  LEASE_DEFAULT_TTL_SECONDS,
  LEASE_MAX_TTL_SECONDS,
  LEASE_MIN_TTL_SECONDS,
  readCurrentOwnership,
  readLeaseStatus,
  readSessionLifecycle,
} from "../../storage/ownership.js";
import type { DurableStore } from "../../storage/store.js";
import { StorageTransactionError } from "../../storage/transaction.js";

/** One operator-controlled allowlist entry. `piSessionId` is an untrusted
 * lookup label only: it selects which Endpoint this Pi session may operate,
 * and authorizes nothing by itself. */
export interface CeAllowlistEntry {
  /** The Pi session id (`pi --session-id …`) this entry applies to. */
  readonly piSessionId: string;
  /** Stable operator-assigned Endpoint label (the CE `endpointId`). */
  readonly endpointId: string;
}

export interface CeHostPolicy {
  /** Endpoint adapter kind; fixed to the Pi adapter. */
  readonly adapter: typeof PI_ADAPTER_KIND;
  /** Exchange bootstrap identity: deterministic and replay-safe. */
  readonly exchangeNamespace: string;
  readonly exchangeIdempotencyKey: string;
  /** The complete set of Endpoints this host is willing to operate. */
  readonly allowlist: readonly CeAllowlistEntry[];
  /** Ownership lease seconds; clamped to the accepted lease bounds. */
  readonly leaseTtlSeconds?: number;
  /** Test seam for the advisory clock used by lease status reads. */
  readonly now?: () => string;
}

/** Identifiers only — the exact payload that may be persisted in a Pi session
 * entry via `pi.appendEntry`. No credential, token, or secret ever appears
 * here. */
export interface CeMappingIdentifiers {
  readonly endpointId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly exchangeId: string;
}

export type CeHostRefusalCode =
  | "CE_HOST_ENDPOINT_NOT_ALLOWED"
  | "CE_HOST_NOT_REGISTERED"
  | "CE_HOST_MAPPING_INVALID"
  | "CE_HOST_AUTHORITY_ABSENT"
  | "CE_HOST_RECIPIENT_UNKNOWN"
  | "CE_HOST_INVALID_REQUEST"
  | "CE_HOST_BUSY"
  | "CE_HOST_UNCERTAIN"
  | "CE_HOST_UNAVAILABLE";

const REFUSAL_DETAIL: Record<CeHostRefusalCode, string> = {
  CE_HOST_ENDPOINT_NOT_ALLOWED: "endpoint is not in the host allowlist",
  CE_HOST_NOT_REGISTERED: "endpoint has no provisioned host session; run session startup first",
  CE_HOST_MAPPING_INVALID: "persisted mapping is stale, foreign, or malformed; operator re-bind required",
  CE_HOST_AUTHORITY_ABSENT: "no current ownership authority for this endpoint; reauthorization required",
  CE_HOST_RECIPIENT_UNKNOWN: "recipient endpoint is not in the host allowlist",
  CE_HOST_INVALID_REQUEST: "request shape rejected",
  CE_HOST_BUSY: "durable store is contended; the request rolled back and may be retried as a whole",
  CE_HOST_UNCERTAIN:
    "transaction outcome is unknown; reopen and inspect durable state before any retry",
  CE_HOST_UNAVAILABLE: "host operation failed closed",
};

/** Sanitized refusal. `reason` carries only an already-safe durable code
 * (fixed strings from the storage plane) for observability; the message is a
 * fixed string and never interpolates request data, tokens, or causes. */
export class CeHostRefusal extends Error {
  readonly outcome = "ROLLED_BACK" as const;
  readonly retryable: boolean;
  readonly code: CeHostRefusalCode;
  readonly reason: string | undefined;

  constructor(code: CeHostRefusalCode, retryable = false, reason?: string) {
    super(REFUSAL_DETAIL[code]);
    this.name = "CeHostRefusal";
    this.code = code;
    this.retryable = retryable;
    this.reason = reason;
  }
}

export interface CeSendResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly messageId: string;
  readonly auditSequence: number;
  readonly recipient: string;
}

export interface CeReadResult {
  readonly messageId: string;
  readonly exchangeId: string;
  readonly from: string;
  readonly to: string;
  readonly state: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;
  readonly createdAt: string;
  readonly auditSequence: number;
}

export interface CeInboxResult {
  readonly messages: readonly { readonly messageId: string; readonly auditSequence: number }[];
  readonly continuationAuditSequence: number | null;
  readonly scanBudgetExhausted: boolean;
}

export interface CeStatus {
  readonly endpointId: string;
  readonly registered: boolean;
  readonly participantId: string | undefined;
  readonly sessionId: string | undefined;
  readonly exchangeId: string | undefined;
  readonly lease: "ACTIVE" | "EXPIRED" | "CLOCK_REGRESSION" | "UNOWNED" | "ABSENT";
  readonly fencingToken: number | undefined;
}

/** In-memory authority for one Endpoint. The capability fields are plaintext
 * bearer tokens: they never leave this table except as arguments to the
 * storage-plane operations that consume them. */
interface EndpointAuthority {
  readonly endpointId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly exchangeId: string;
  readonly sendCapability: string;
  readonly readCapability: string;
}

function clampLeaseTtl(policy: CeHostPolicy): number {
  if (policy.leaseTtlSeconds === undefined) return LEASE_DEFAULT_TTL_SECONDS;
  if (
    !Number.isSafeInteger(policy.leaseTtlSeconds) ||
    policy.leaseTtlSeconds < LEASE_MIN_TTL_SECONDS ||
    policy.leaseTtlSeconds > LEASE_MAX_TTL_SECONDS
  ) {
    throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
  }
  return policy.leaseTtlSeconds;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Map any storage-plane failure to a sanitized refusal. Domain codes pass
 * through as `reason` (they are fixed, secret-free strings by contract);
 * messages, causes, and unknown errors never escape. */
function toRefusal(error: unknown): CeHostRefusal {
  if (error instanceof CeHostRefusal) return error;
  if (error instanceof StorageTransactionError) {
    if (error.retryable) return new CeHostRefusal("CE_HOST_BUSY", true, error.code);
    if (error.outcome === "INDETERMINATE") {
      return new CeHostRefusal("CE_HOST_UNCERTAIN", false, error.code);
    }
    return new CeHostRefusal("CE_HOST_UNAVAILABLE", false, error.code);
  }
  if (error instanceof ParticipantDomainError || error instanceof CreationDomainError) {
    // Ownership and lease refusals surface as authority-absence so the caller
    // reauthorizes instead of retrying; every other durable refusal keeps its
    // fixed domain code as the sanitized reason.
    const authorityAbsent =
      error.code === "OWNERSHIP_NOT_CURRENT" ||
      error.code === "OWNERSHIP_HELD" ||
      error.code === "OWNERSHIP_TAKEOVER_REQUIRED" ||
      error.code === "LEASE_EXPIRED" ||
      error.code === "LEASE_CLOCK_REGRESSION" ||
      error.code === "FENCING_STALE";
    if (authorityAbsent) return new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, error.code);
    return new CeHostRefusal("CE_HOST_UNAVAILABLE", false, error.code);
  }
  if (error instanceof ParticipantRequestError || error instanceof CreationRequestError) {
    return new CeHostRefusal("CE_HOST_INVALID_REQUEST");
  }
  if (error instanceof StoreLifecycleError) {
    return new CeHostRefusal("CE_HOST_UNAVAILABLE", false, error.code);
  }
  return new CeHostRefusal("CE_HOST_UNAVAILABLE");
}

/**
 * The trusted host adapter. One instance per Pi process; one authority row
 * per allowlisted Endpoint.
 */
export class CeSessionHost {
  readonly #store: DurableStore;
  readonly #policy: CeHostPolicy;
  readonly #leaseTtlSeconds: number;
  readonly #seams: ClockSeam;
  readonly #authorities = new Map<string, EndpointAuthority>();

  constructor(store: DurableStore, policy: CeHostPolicy) {
    if (policy.adapter !== PI_ADAPTER_KIND) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    if (policy.allowlist.length === 0) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    const seen = new Set<string>();
    for (const entry of policy.allowlist) {
      if (typeof entry.piSessionId !== "string" || entry.piSessionId.length === 0) {
        throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
      }
      if (typeof entry.endpointId !== "string" || entry.endpointId.length === 0 || entry.endpointId.length > 256) {
        throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
      }
      if (seen.has(entry.endpointId)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
      seen.add(entry.endpointId);
    }
    this.#store = store;
    this.#policy = policy;
    this.#leaseTtlSeconds = clampLeaseTtl(policy);
    this.#seams = policy.now === undefined ? {} : { now: policy.now };
  }

  /** The durable Exchange this host operates. Creation is idempotent by the
   * deterministic policy identity, so every call converges on one Exchange. */
  #exchangeId(): string {
    return createExchange(
      this.#store,
      { namespace: this.#policy.exchangeNamespace, idempotencyKey: this.#policy.exchangeIdempotencyKey },
      this.#seams,
    ).exchange.exchangeId;
  }

  #allowlisted(endpointId: string): CeAllowlistEntry {
    const entry = this.#policy.allowlist.find((candidate) => candidate.endpointId === endpointId);
    if (entry === undefined) throw new CeHostRefusal("CE_HOST_ENDPOINT_NOT_ALLOWED");
    return entry;
  }

  #authority(endpointId: string): EndpointAuthority {
    const authority = this.#authorities.get(endpointId);
    if (authority === undefined) throw new CeHostRefusal("CE_HOST_NOT_REGISTERED");
    return authority;
  }

  /** Current fencing token plus lease validation for a registered Endpoint.
   * Refuses when ownership is absent, expired, or held by another Session;
   * never adopts or repairs authority. */
  #currentFencing(authority: EndpointAuthority): number {
    const ownership = readCurrentOwnership(this.#store, authority.participantId);
    if (ownership === undefined || ownership.sessionId !== authority.sessionId) {
      throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, "OWNERSHIP_NOT_CURRENT");
    }
    const lease = readLeaseStatus(this.#store, { participantId: authority.participantId }, this.#seams);
    if (lease !== "ACTIVE") {
      throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, lease);
    }
    return ownership.fencingToken;
  }

  /** Provision a brand-new CE Session for an allowlisted Endpoint: reuse or
   * create the Participant, ensure membership, bind a fresh CE Session,
   * acquire ownership, and issue Session-bound send/read capabilities.
   * Idempotent registrations/joins replay; ownership refusal fails closed. */
  beginSession(endpointId: string): CeMappingIdentifiers {
    this.#allowlisted(endpointId);
    const adapter = this.#policy.adapter;

    let exchangeId: string;
    let participantId: string;
    try {
      exchangeId = this.#exchangeId();
      const existing = readParticipantByEndpoint(this.#store, adapter, endpointId);
      if (existing !== undefined) {
        participantId = existing.participantId;
      } else {
        participantId = createParticipant(
          this.#store,
          {
            endpoint: { adapter, endpointId },
            idempotencyKey: `ce-host:register:${adapter}:${endpointId}`,
          },
          this.#seams,
        ).participant.participantId;
      }
    } catch (error) {
      throw toRefusal(error);
    }

    try {
      const joinCapability = issueCapability(this.#store, { participantId, scope: "join" }, this.#seams).capability;
      joinExchange(
        this.#store,
        { exchangeId, participantId, capability: joinCapability, idempotencyKey: `ce-host:join:${exchangeId}:${participantId}` },
        this.#seams,
      );
    } catch (error) {
      throw toRefusal(error);
    }

    const sessionId = generateSessionId();
    try {
      const attachCapability = issueCapability(this.#store, { participantId, scope: "attach" }, this.#seams).capability;
      bindSession(this.#store, { participantId, sessionId, capability: attachCapability }, this.#seams);
      acquireOwnership(
        this.#store,
        { participantId, sessionId, capability: attachCapability, leaseTtlSeconds: this.#leaseTtlSeconds },
        this.#seams,
      );
      const sendCapability = issueCapability(
        this.#store,
        { participantId, scope: "send", sessionId },
        this.#seams,
      ).capability;
      const readCapability = issueCapability(
        this.#store,
        { participantId, scope: "read", sessionId },
        this.#seams,
      ).capability;
      this.#authorities.set(endpointId, {
        endpointId,
        participantId,
        sessionId,
        exchangeId,
        sendCapability,
        readCapability,
      });
    } catch (error) {
      throw toRefusal(error);
    }

    return Object.freeze({ endpointId, participantId, sessionId, exchangeId });
  }

  /** Recover authority after a restart from persisted mapping identifiers.
   * Validates the durable bindings before re-issuing capabilities; refuses
   * stale, foreign, detached, or unowned mappings. Performs no binding, no
   * ownership change, and no takeover. */
  resume(endpointId: string, mapping: unknown): CeMappingIdentifiers {
    this.#allowlisted(endpointId);
    if (!isPlainObject(mapping)) throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
    const { participantId, sessionId, exchangeId } = mapping;
    if (typeof participantId !== "string" || !isParticipantId(participantId)) {
      throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
    }
    if (typeof sessionId !== "string" || !isSessionId(sessionId)) {
      throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
    }
    if (typeof exchangeId !== "string" || !EXCHANGE_ID_PATTERN.test(exchangeId)) {
      throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
    }

    try {
      if (exchangeId !== this.#exchangeId()) throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
      const participant = readParticipantByEndpoint(this.#store, this.#policy.adapter, endpointId);
      if (participant === undefined || participant.participantId !== participantId) {
        throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
      }
      const lifecycle = readSessionLifecycle(this.#store, { participantId, sessionId });
      if (lifecycle.state !== "ATTACHED") throw new CeHostRefusal("CE_HOST_MAPPING_INVALID");
      const ownership = readCurrentOwnership(this.#store, participantId);
      if (ownership === undefined || ownership.sessionId !== sessionId) {
        throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, "OWNERSHIP_NOT_CURRENT");
      }
      const lease = readLeaseStatus(this.#store, { participantId }, this.#seams);
      if (lease !== "ACTIVE") {
        throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, lease);
      }
      const sendCapability = issueCapability(
        this.#store,
        { participantId, scope: "send", sessionId },
        this.#seams,
      ).capability;
      const readCapability = issueCapability(
        this.#store,
        { participantId, scope: "read", sessionId },
        this.#seams,
      ).capability;
      this.#authorities.set(endpointId, {
        endpointId,
        participantId,
        sessionId,
        exchangeId,
        sendCapability,
        readCapability,
      });
    } catch (error) {
      throw toRefusal(error);
    }

    return Object.freeze({ endpointId, participantId, sessionId, exchangeId });
  }

  /** Session lifecycle cleanup: drop the in-memory authority row (including
   * the plaintext capabilities). Durable ownership is left to lease expiry;
   * this adapter never releases or transfers ownership implicitly. */
  drop(endpointId: string): void {
    this.#authorities.delete(endpointId);
  }

  /** Session-authorized durable send. All authority comes from host memory;
   * the model supplies only the recipient label, the text, and an idempotency
   * key. */
  send(endpointId: string, input: unknown): CeSendResult {
    const authority = this.#authority(endpointId);
    if (!isPlainObject(input)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    const { to, text, idempotencyKey } = input;
    if (typeof to !== "string" || to.length === 0 || to.length > 256) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    this.#allowlisted(to);
    if (typeof text !== "string" || text.length === 0) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    if (to === endpointId) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");

    const adapter = this.#policy.adapter;
    let creation: AuthorizedMessageCreation;
    try {
      const fencingToken = this.#currentFencing(authority);
      creation = sendMessage(
        this.#store,
        {
          participantId: authority.participantId,
          sessionId: authority.sessionId,
          fencingToken,
          capability: authority.sendCapability,
          message: {
            exchangeId: authority.exchangeId,
            from: { adapter, endpointId },
            to: { adapter, endpointId: to },
            payload: new TextEncoder().encode(text),
            idempotencyKey,
          },
        },
        this.#seams,
      );
    } catch (error) {
      throw toRefusal(error);
    }
    return Object.freeze({
      disposition: creation.disposition,
      messageId: creation.message.messageId,
      auditSequence: creation.auditSequence,
      recipient: to,
    });
  }

  /** Repeatable recipient-only protected metadata read. Payload bytes never
   * leave the storage plane. */
  readMetadata(endpointId: string, input: unknown): CeReadResult {
    const authority = this.#authority(endpointId);
    if (!isPlainObject(input)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    const { messageId } = input;
    if (typeof messageId !== "string" || !MESSAGE_ID_PATTERN.test(messageId)) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    let metadata: ProtectedMessageMetadata;
    try {
      const fencingToken = this.#currentFencing(authority);
      metadata = readMessageMetadata(
        this.#store,
        {
          participantId: authority.participantId,
          sessionId: authority.sessionId,
          fencingToken,
          capability: authority.readCapability,
          exchangeId: authority.exchangeId,
          messageId,
        },
        this.#seams,
      );
    } catch (error) {
      throw toRefusal(error);
    }
    const message = metadata.message;
    return Object.freeze({
      messageId: message.messageId,
      exchangeId: message.exchangeId,
      from: message.from.endpointId,
      to: message.to.endpointId,
      state: message.state,
      payloadDigest: message.payloadDigest,
      payloadLength: message.payloadLength,
      createdAt: message.createdAt,
      auditSequence: metadata.auditSequence,
    });
  }

  /** Explicit, bounded metadata discovery. Pagination grants no authority and
   * never advances ACK or delivery state. All CE authorization remains in Storage. */
  listInbox(endpointId: string, input: unknown): CeInboxResult {
    const authority = this.#authority(endpointId);
    try {
      const pagination = captureFields(input, ["afterAuditSequence", "pageSize", "rawScanLimit"], [], "request");
      const fencingToken = this.#currentFencing(authority);
      const result = discoverInboxMessages(this.#store, {
        ...pagination,
        participantId: authority.participantId,
        sessionId: authority.sessionId,
        exchangeId: authority.exchangeId,
        capability: authority.readCapability,
        fencingToken,
      }, this.#seams);
      return Object.freeze({
        messages: Object.freeze(result.messages.map(({ message, auditSequence }) => Object.freeze({
          messageId: message.messageId,
          auditSequence,
        }))),
        continuationAuditSequence: result.continuationAuditSequence,
        scanBudgetExhausted: result.scanBudgetExhausted,
      });
    } catch (error) {
      throw toRefusal(error);
    }
  }

  /** Advisory status for the operator command. Authorizes nothing. */
  status(endpointId: string): CeStatus {
    const authority = this.#authorities.get(endpointId);
    if (authority === undefined) {
      return Object.freeze({
        endpointId,
        registered: false,
        participantId: undefined,
        sessionId: undefined,
        exchangeId: undefined,
        lease: "ABSENT",
        fencingToken: undefined,
      });
    }
    try {
      const ownership = readCurrentOwnership(this.#store, authority.participantId);
      const lease =
        ownership === undefined || ownership.sessionId !== authority.sessionId
          ? "ABSENT"
          : readLeaseStatus(this.#store, { participantId: authority.participantId }, this.#seams);
      return Object.freeze({
        endpointId,
        registered: true,
        participantId: authority.participantId,
        sessionId: authority.sessionId,
        exchangeId: authority.exchangeId,
        lease,
        fencingToken: ownership?.fencingToken,
      });
    } catch {
      // Advisory only: on any read failure report absence rather than throw.
      return Object.freeze({
        endpointId,
        registered: true,
        participantId: authority.participantId,
        sessionId: authority.sessionId,
        exchangeId: authority.exchangeId,
        lease: "ABSENT",
        fencingToken: undefined,
      });
    }
  }
}
