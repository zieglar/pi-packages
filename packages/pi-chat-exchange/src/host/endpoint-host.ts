/**
 * CE-0002 shared Endpoint Host (HANDOFF-853274, extracted from the B3-P3B
 * Pi host seam without changing its authority chain).
 *
 * This module is the ONLY host-side composition layer that endpoint and
 * control integrations reach through. It imports no Pi SDK, no MCP SDK, no
 * control surface, no endpoint integration, and never reads the process
 * environment, so it is verified against plain data in and plain data out.
 *
 * Trust boundary:
 * - The operator-controlled allowlist is the only source of Endpoint
 *   eligibility. Model/tool arguments can never register a Participant, issue
 *   a capability, or change ownership: those operations happen only through
 *   host policy (`beginSession`) or validated mapping recovery (`resume`).
 * - Cross-adapter recipients exist only when the operator lists them
 *   explicitly in `recipients`; a recipient label grants send eligibility
 *   toward that EndpointRef and nothing else (no read, no registration).
 * - Capability plaintext exists only in this process's memory table and is
 *   never returned, logged, persisted, or placed in any mapping payload.
 * - Host-secret access stays inside the trusted storage plane; this adapter
 *   never reads the secret file itself — `issueCapability` enforces the
 *   trust-root contract in its own owned transaction.
 * - P3A authority checks (exact Session-bound capability, ATTACHED Session,
 *   current Owner, monotonic fencing, active lease, membership, immutable
 *   endpoint binding, authority-before-replay) are preserved untouched; this
 *   adapter only delegates and maps refusals to sanitized codes.
 * - Lease lifecycle (`renew`, `end`) is explicit and opt-in: a caller that
 *   never invokes it (the Pi extension) observes the original behavior.
 *   Renewal never revives an expired lease; `end` releases ownership and then
 *   detaches the Session with the Session's own `resume` capability.
 * - This host never performs takeover recovery: an expired or superseded lease
 *   is refused as `CE_HOST_AUTHORITY_ABSENT`. The separate operator-only caller
 *   for CE-TAKEOVER-RECOVERY-CALLER-001 is not reachable through this adapter.
 *   Restart never implies ownership recovery.
 */
import { EXCHANGE_ID_PATTERN, MESSAGE_ID_PATTERN } from "../protocol/identity.js";
import { SHA256_HEX_PATTERN } from "../protocol/entities.js";
import { recordDeliveryAck, type DeliveryAckResult } from "../storage/delivery-ack.js";
import { CreationDomainError } from "../storage/creation.js";
import { createExchange } from "../storage/creation.js";
import { CreationRequestError } from "../storage/creation-request.js";
import { StoreLifecycleError } from "../storage/errors.js";
import {
  type AuthorizedMessageCreation,
  type ProtectedMessageMetadata,
  type ProtectedMessagePayload,
  readMessageMetadata,
  readMessagePayload,
  sendMessage,
} from "../storage/messaging.js";
import { discoverInboxMessages } from "../storage/inbox-discovery.js";
import {
  captureFields,
  isParticipantId,
  isSessionId,
  ParticipantRequestError,
} from "../storage/participant-identity.js";
import {
  createParticipant,
  ParticipantDomainError,
  issueCapability,
  joinExchange,
  readParticipantByEndpoint,
  type ClockSeam,
} from "../storage/participant.js";
import {
  acquireOwnership,
  bindSession,
  detachSession,
  generateSessionId,
  LEASE_DEFAULT_TTL_SECONDS,
  LEASE_MAX_TTL_SECONDS,
  LEASE_MIN_TTL_SECONDS,
  readCurrentOwnership,
  readLeaseStatus,
  readSessionLifecycle,
  releaseOwnership,
  renewLease,
} from "../storage/ownership.js";
import type { DurableStore } from "../storage/store.js";
import { StorageTransactionError } from "../storage/transaction.js";

/** One operator-controlled allowlist entry: an Endpoint this host operates.
 * Integration-specific lookup labels (for example the Pi session id) may be
 * carried alongside and are validated by the integration's own wrapper. */
export interface CeEndpointAllowlistEntry {
  /** Stable operator-assigned Endpoint label (the CE `endpointId`). */
  readonly endpointId: string;
}

/** An operator-authorized cross-adapter recipient. Send eligibility only. */
export interface CeRecipientRef {
  readonly adapter: string;
  readonly endpointId: string;
}

export interface CeEndpointHostPolicy {
  /** Endpoint adapter kind of every allowlisted Endpoint this host operates. */
  readonly adapter: string;
  /** Exchange bootstrap identity: deterministic and replay-safe. */
  readonly exchangeNamespace: string;
  readonly exchangeIdempotencyKey: string;
  /** The complete set of Endpoints this host is willing to operate. */
  readonly allowlist: readonly CeEndpointAllowlistEntry[];
  /** Explicit cross-adapter recipients. Absent means same-adapter allowlisted
   * recipients only (the original behavior). Labels must be unique across the
   * allowlist and this list; a same-adapter entry here is refused. */
  readonly recipients?: readonly CeRecipientRef[];
  /** Ownership lease seconds; clamped to the accepted lease bounds. */
  readonly leaseTtlSeconds?: number;
  /** CE-0002-B3-P4D operator payload-read opt-in. Only the exact boolean
   * `true` enables payload exposure; a missing, false, or malformed setting
   * stays disabled (fail closed). The decision is fixed for the Host
   * instance's lifetime and never re-read from the policy object. */
  readonly payloadRead?: { readonly enabled?: boolean };
  /** HANDOFF-CE-E2B-01 operator ACK opt-in. Only the exact boolean `true`
   * enables the ACK surface; a missing, false, or malformed setting stays
   * disabled (fail closed). Fixed for the Host instance's lifetime and never
   * re-read from the policy object. */
  readonly ack?: { readonly enabled?: boolean };
  /** Test seam for the advisory clock used by lease status reads. */
  readonly now?: () => string;
}

/** Options for `beginSession`. */
export interface CeBeginSessionOptions {
  /** Refuse before ANY durable write when the Endpoint's Participant already
   * has an ownership row (live or expired). Used by single-instance hosts so a
   * refused start never leaves an orphan ATTACHED Session. */
  readonly requireUnowned?: boolean;
}

export interface CeRenewResult {
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface CeEndResult {
  readonly released: true;
  readonly detached: boolean;
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
  | "CE_HOST_UNAVAILABLE"
  | "CE_HOST_ACK_DISABLED"
  | "CE_HOST_PAYLOAD_DISABLED"
  | "CE_HOST_PAYLOAD_TOO_LARGE"
  | "CE_HOST_PAYLOAD_INVALID_UTF8";

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
  CE_HOST_ACK_DISABLED: "acknowledgement recording is disabled by operator policy",
  CE_HOST_PAYLOAD_DISABLED: "payload reading is disabled by operator policy",
  CE_HOST_PAYLOAD_TOO_LARGE: "payload exceeds the fixed operator exposure limit",
  CE_HOST_PAYLOAD_INVALID_UTF8: "payload is not valid UTF-8 text",
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

/** CE-0002-B3-P4D authorized payload read result. `payloadText` is the exact
 * fatal-UTF-8 decoding of the authorized bytes; it must appear only in the
 * caller's explicit successful output and never in logs, mappings, or
 * failure details. */
export interface CeReadPayloadResult {
  readonly messageId: string;
  readonly exchangeId: string;
  readonly from: string;
  readonly to: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;
  readonly createdAt: string;
  readonly auditSequence: number;
  readonly payloadText: string;
}

/** HANDOFF-CE-E2B-01 ACK evidence. This is the frozen public Receipt
  * projection and nothing else: the acknowledging Session, fencing token,
  * trust generation, capability, and payload bytes stay private to Storage. */
export interface CeAckReceipt {
  readonly receiptId: string;
  readonly exchangeId: string;
  readonly messageId: string;
  readonly endpoint: CeRecipientRef;
  readonly kind: "delivery_ack";
  readonly createdAt: string;
}

export interface CeAckResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly receipt: CeAckReceipt;
  readonly receiptAuditSequence: number;
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
  /** HANDOFF-CE-RELEASE-READINESS-01: the persisted expiry of the CURRENT term
   * of this Endpoint's own lease, read live with the status (never a cached
   * adoption-time value); `undefined` when no current lease was observed. It is
   * advisory like the rest of this record and authorizes nothing: a caller may
   * only use it to schedule its own renewal earlier, never to extend a term. */
  readonly leaseExpiresAt: string | undefined;
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
  /** CE-0002-B3-P4D: undefined unless the operator payload-read opt-in was
   * enabled when this authority was provisioned — a disabled policy issues
   * no payload capability at all. */
  readonly payloadReadCapability: string | undefined;
  /** HANDOFF-CE-E2B-01: undefined unless the operator ACK opt-in was enabled
   * when this authority was provisioned or resumed — a disabled policy issues
   * no ack capability at all. Memory-only, like every other capability here. */
  readonly ackCapability: string | undefined;
  /** Session-bound `resume` capability, issued lazily and only by the
   * explicit lifecycle operations (`renew`, `end`); memory-only like the rest. */
  resumeCapability: string | undefined;
}

/** CE-0002-B3-P4D fixed maximum encoded payload bytes the host will ever
 * decode and expose. Checked on the authorized byte length before decoding;
 * an oversized payload is refused whole, never partially returned. */
const PAYLOAD_EXPOSURE_LIMIT_BYTES = 65_536;

/** HANDOFF-CE-E2B-01 closed ACK request: exactly the Message metadata a caller
  * must copy from an authorized read. No authority field is accepted here. */
const ACK_REQUEST_FIELDS = ["messageId", "payloadDigest", "payloadLength", "messageCreatedAuditSequence"] as const;

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Only the exact boolean `true` enables payload exposure. A missing, false,
 * or malformed setting (wrong type, truthy string, number, null, or a
 * non-object section) fails closed to disabled. */
function optInEnabled(setting: unknown): boolean {
  try {
    if (!isPlainObject(setting) || Array.isArray(setting)) return false;
    const enabled = Object.getOwnPropertyDescriptor(setting, "enabled");
    return enabled?.enumerable === true && "value" in enabled && enabled.value === true;
  } catch {
    return false;
  }
}

function payloadReadEnabled(policy: CeEndpointHostPolicy): boolean {
  try { return optInEnabled(policy.payloadRead); } catch { return false; }
}

/** HANDOFF-CE-E2B-01: the ACK opt-in uses the identical exact-`true` rule. */
function ackEnabled(policy: CeEndpointHostPolicy): boolean {
  try { return optInEnabled(policy.ack); } catch { return false; }
}

function clampLeaseTtl(policy: CeEndpointHostPolicy): number {
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

const ADAPTER_MAX_LENGTH = 64;
const ENDPOINT_ID_MAX_LENGTH = 256;

function isEndpointLabel(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Strictly validate and freeze the operator's explicit cross-adapter
 * recipients. Anything malformed refuses construction (fail closed): a
 * non-array, a non-plain entry, an unknown or accessor-backed field, a bad
 * label, a duplicate, a same-adapter entry, or a label colliding with an
 * allowlisted Endpoint label. */
function validatedRecipients(policy: CeEndpointHostPolicy, allowlistLabels: ReadonlySet<string>): readonly CeRecipientRef[] {
  const raw: unknown = policy.recipients;
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
  const labels = new Set<string>();
  const recipients: CeRecipientRef[] = [];
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    const keys = Reflect.ownKeys(entry);
    if (keys.length !== 2 || !keys.includes("adapter") || !keys.includes("endpointId")) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    const adapterField = Object.getOwnPropertyDescriptor(entry, "adapter");
    const endpointField = Object.getOwnPropertyDescriptor(entry, "endpointId");
    if (adapterField === undefined || !("value" in adapterField) || endpointField === undefined || !("value" in endpointField)) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    const adapter: unknown = adapterField.value;
    const endpointId: unknown = endpointField.value;
    if (!isEndpointLabel(adapter, ADAPTER_MAX_LENGTH) || !isEndpointLabel(endpointId, ENDPOINT_ID_MAX_LENGTH)) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    if (adapter === policy.adapter) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    if (labels.has(endpointId) || allowlistLabels.has(endpointId)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    labels.add(endpointId);
    recipients.push(Object.freeze({ adapter, endpointId }));
  }
  return Object.freeze(recipients);
}

/**
 * The trusted host adapter. One instance per host process; one authority row
 * per allowlisted Endpoint.
 */
export class CeEndpointHost {
  readonly #store: DurableStore;
  readonly #policy: CeEndpointHostPolicy;
  readonly #leaseTtlSeconds: number;
  /** CE-0002-B3-P4D operator payload-read decision, fixed for the Host
   * lifetime: computed once from the policy so later mutation of the policy
   * object can never enable or disable payload exposure mid-flight. */
  readonly #payloadReadEnabled: boolean;
  /** HANDOFF-CE-E2B-01 operator ACK decision, fixed for the Host lifetime by
   * the same rule, so later mutation of the policy object cannot enable or
   * disable the ACK surface mid-flight. */
  readonly #ackEnabled: boolean;
  /** Explicit cross-adapter recipients, validated and frozen at construction. */
  readonly #recipients: readonly CeRecipientRef[];
  readonly #seams: ClockSeam;
  readonly #authorities = new Map<string, EndpointAuthority>();

  constructor(store: DurableStore, policy: CeEndpointHostPolicy) {
    if (!isEndpointLabel(policy.adapter, ADAPTER_MAX_LENGTH)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    if (policy.allowlist.length === 0) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    const seen = new Set<string>();
    for (const entry of policy.allowlist) {
      if (typeof entry.endpointId !== "string" || entry.endpointId.length === 0 || entry.endpointId.length > ENDPOINT_ID_MAX_LENGTH) {
        throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
      }
      if (seen.has(entry.endpointId)) throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
      seen.add(entry.endpointId);
    }
    this.#recipients = validatedRecipients(policy, seen);
    this.#store = store;
    this.#policy = policy;
    this.#leaseTtlSeconds = clampLeaseTtl(policy);
    this.#payloadReadEnabled = payloadReadEnabled(policy);
    this.#ackEnabled = ackEnabled(policy);
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

  #allowlisted(endpointId: string): CeEndpointAllowlistEntry {
    const entry = this.#policy.allowlist.find((candidate) => candidate.endpointId === endpointId);
    if (entry === undefined) throw new CeHostRefusal("CE_HOST_ENDPOINT_NOT_ALLOWED");
    return entry;
  }

  /** Resolve a recipient label: an allowlisted same-adapter Endpoint first,
   * otherwise an explicitly configured cross-adapter recipient. Any other
   * label is refused exactly like before (`CE_HOST_ENDPOINT_NOT_ALLOWED`). */
  #recipient(label: string): CeRecipientRef {
    if (this.#policy.allowlist.some((candidate) => candidate.endpointId === label)) {
      return { adapter: this.#policy.adapter, endpointId: label };
    }
    const external = this.#recipients.find((candidate) => candidate.endpointId === label);
    if (external === undefined) throw new CeHostRefusal("CE_HOST_ENDPOINT_NOT_ALLOWED");
    return external;
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

  /** Lazily issue (once per authority) the Session-bound `resume` capability
   * used only by the explicit lifecycle operations. Memory-only. */
  #resumeCapability(authority: EndpointAuthority): string {
    if (authority.resumeCapability === undefined) {
      authority.resumeCapability = issueCapability(
        this.#store,
        { participantId: authority.participantId, scope: "resume", sessionId: authority.sessionId },
        this.#seams,
      ).capability;
    }
    return authority.resumeCapability;
  }

  /** `requireUnowned` guard: pure reads, evaluated before ANY durable write.
   * An existing ownership row (live, expired, or clock-regressed) refuses the
   * start; there is no adoption and no takeover. */
  #refuseIfOwned(endpointId: string): void {
    try {
      const existing = readParticipantByEndpoint(this.#store, this.#policy.adapter, endpointId);
      if (existing === undefined) return;
      if (readCurrentOwnership(this.#store, existing.participantId) === undefined) return;
      const lease = readLeaseStatus(this.#store, { participantId: existing.participantId }, this.#seams);
      const reason = lease === "ACTIVE"
        ? "OWNERSHIP_HELD"
        : lease === "CLOCK_REGRESSION" ? "LEASE_CLOCK_REGRESSION" : "OWNERSHIP_TAKEOVER_REQUIRED";
      throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, reason);
    } catch (error) {
      throw toRefusal(error);
    }
  }

  /** Best-effort self-detach of a Session this host just bound but could not
   * make Owner (a lost race after the `requireUnowned` pre-check). Uses the
   * Session's own `resume` capability; never touches ownership. A failure
   * leaves the refused start's original refusal authoritative. */
  #detachOrphan(participantId: string, sessionId: string): void {
    try {
      const capability = issueCapability(this.#store, { participantId, scope: "resume", sessionId }, this.#seams).capability;
      detachSession(this.#store, { participantId, sessionId, capability }, this.#seams);
    } catch {
      // The acquisition refusal is reported; the orphan carries no ownership.
    }
  }

  /** Provision a brand-new CE Session for an allowlisted Endpoint: reuse or
   * create the Participant, ensure membership, bind a fresh CE Session,
   * acquire ownership, and issue Session-bound send/read capabilities.
   * Idempotent registrations/joins replay; ownership refusal fails closed.
   * With `requireUnowned`, an existing ownership row refuses before any write. */
  beginSession(endpointId: string, options: CeBeginSessionOptions = {}): CeMappingIdentifiers {
    this.#allowlisted(endpointId);
    const adapter = this.#policy.adapter;
    const requireUnowned = options.requireUnowned === true;
    if (requireUnowned) this.#refuseIfOwned(endpointId);

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
      try {
        acquireOwnership(
          this.#store,
          { participantId, sessionId, capability: attachCapability, leaseTtlSeconds: this.#leaseTtlSeconds },
          this.#seams,
        );
      } catch (error) {
        if (requireUnowned) this.#detachOrphan(participantId, sessionId);
        throw error;
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
      // CE-0002-B3-P4D: issued only after ownership acquisition succeeded and
      // only when the operator opt-in is enabled; exact Session binding and
      // the current trust generation come from the storage issuance itself.
      const payloadReadCapability = this.#payloadReadEnabled
        ? issueCapability(this.#store, { participantId, scope: "payload_read", sessionId }, this.#seams).capability
        : undefined;
      // HANDOFF-CE-E2B-01: the independent Session-bound `ack` scope, issued
      // only under the operator opt-in and never persisted or returned.
      const ackCapability = this.#ackEnabled
        ? issueCapability(this.#store, { participantId, scope: "ack", sessionId }, this.#seams).capability
        : undefined;
      this.#authorities.set(endpointId, {
        endpointId,
        participantId,
        sessionId,
        exchangeId,
        sendCapability,
        readCapability,
        payloadReadCapability,
        ackCapability,
        resumeCapability: undefined,
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
      // CE-0002-B3-P4D: a validated restart within the active lease re-issues
      // fresh memory-only payload authority under the same immutable policy.
      const payloadReadCapability = this.#payloadReadEnabled
        ? issueCapability(this.#store, { participantId, scope: "payload_read", sessionId }, this.#seams).capability
        : undefined;
      // HANDOFF-CE-E2B-01: a validated restart within the active lease also
      // re-issues fresh memory-only ack authority under the same policy.
      const ackCapability = this.#ackEnabled
        ? issueCapability(this.#store, { participantId, scope: "ack", sessionId }, this.#seams).capability
        : undefined;
      this.#authorities.set(endpointId, {
        endpointId,
        participantId,
        sessionId,
        exchangeId,
        sendCapability,
        readCapability,
        payloadReadCapability,
        ackCapability,
        resumeCapability: undefined,
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

  /** Explicit lease renewal by the current Owner (opt-in lifecycle). Storage
   * evaluates the persisted term at the serialization instant: an expired or
   * clock-regressed lease is refused and never revived; the fencing token is
   * unchanged. No retry, takeover, or re-acquisition happens here. */
  renew(endpointId: string): CeRenewResult {
    const authority = this.#authority(endpointId);
    try {
      const fencingToken = this.#currentFencing(authority);
      const capability = this.#resumeCapability(authority);
      const lease = renewLease(
        this.#store,
        {
          participantId: authority.participantId,
          sessionId: authority.sessionId,
          fencingToken,
          capability,
          leaseTtlSeconds: this.#leaseTtlSeconds,
        },
        this.#seams,
      );
      return Object.freeze({ fencingToken: lease.fencingToken, expiresAt: lease.expiresAt });
    } catch (error) {
      throw toRefusal(error);
    }
  }

  /** Explicit graceful end (opt-in lifecycle): release ownership as the
   * current Owner, then detach the Session with its own `resume` capability.
   * The in-memory authority is dropped first, whatever the outcome, so an
   * unknown outcome is never retried through this host instance. A release
   * refusal (expired lease, not current, uncertain) is surfaced; ownership is
   * then left to the durable state and later starts fail closed. */
  end(endpointId: string): CeEndResult {
    const authority = this.#authority(endpointId);
    this.#authorities.delete(endpointId);
    let capability: string;
    try {
      const fencingToken = this.#currentFencing(authority);
      capability = this.#resumeCapability(authority);
      releaseOwnership(
        this.#store,
        { participantId: authority.participantId, sessionId: authority.sessionId, fencingToken, capability },
        this.#seams,
      );
    } catch (error) {
      throw toRefusal(error);
    }
    try {
      detachSession(
        this.#store,
        { participantId: authority.participantId, sessionId: authority.sessionId, capability },
        this.#seams,
      );
      return Object.freeze({ released: true, detached: true });
    } catch {
      // Ownership is already released; an unconfirmed detach leaves an
      // unowned ATTACHED Session that authorizes nothing without capabilities.
      return Object.freeze({ released: true, detached: false });
    }
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
    const recipient = this.#recipient(to);
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
            to: { adapter: recipient.adapter, endpointId: recipient.endpointId },
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

  /** CE-0002-B3-P4D authorized payload read. The fixed sanitized policy gate
   * comes first, so a disabled deployment answers identically regardless of
   * registration state; then the plaintext capability never leaves this
   * boundary and Storage alone makes the final authorization decision. The
   * exposure limit is checked on the authorized byte length before any
   * decoding, and decoding is strict UTF-8 — no truncation, replacement
   * characters, base64 fallback, or partial payload ever escapes. */
  readPayload(endpointId: string, input: unknown): CeReadPayloadResult {
    if (!this.#payloadReadEnabled) throw new CeHostRefusal("CE_HOST_PAYLOAD_DISABLED");
    const authority = this.#authority(endpointId);
    let messageId: unknown;
    try {
      ({ messageId } = captureFields(input, ["messageId"], ["messageId"], "request"));
    } catch {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    if (typeof messageId !== "string" || !MESSAGE_ID_PATTERN.test(messageId)) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    if (authority.payloadReadCapability === undefined) {
      throw new CeHostRefusal("CE_HOST_PAYLOAD_DISABLED");
    }

    let authorized: ProtectedMessagePayload;
    try {
      const fencingToken = this.#currentFencing(authority);
      authorized = readMessagePayload(
        this.#store,
        {
          participantId: authority.participantId,
          sessionId: authority.sessionId,
          fencingToken,
          capability: authority.payloadReadCapability,
          exchangeId: authority.exchangeId,
          messageId,
        },
        this.#seams,
      );
    } catch (error) {
      throw toRefusal(error);
    }
    // Fixed exposure limit, checked before decoding; refuse whole.
    if (authorized.payload.byteLength > PAYLOAD_EXPOSURE_LIMIT_BYTES) {
      throw new CeHostRefusal("CE_HOST_PAYLOAD_TOO_LARGE");
    }
    let payloadText: string;
    try {
      // Preserve a leading U+FEFF as data rather than silently stripping it.
      payloadText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(authorized.payload);
    } catch {
      throw new CeHostRefusal("CE_HOST_PAYLOAD_INVALID_UTF8");
    }
    const message = authorized.message;
    return Object.freeze({
      messageId: message.messageId,
      exchangeId: message.exchangeId,
      from: message.from.endpointId,
      to: message.to.endpointId,
      payloadDigest: message.payloadDigest,
      payloadLength: message.payloadLength,
      createdAt: message.createdAt,
      auditSequence: authorized.auditSequence,
      payloadText,
    });
  }

  /** HANDOFF-CE-E2B-01 Session-authorized delivery ACK over the committed
   * E2-A storage path. The fixed sanitized policy gate comes first, so a
   * disabled deployment answers identically regardless of registration state;
   * then the closed four-field request is validated, and Storage alone decides
   * authority, eligibility, and natural-key idempotency inside one owned
   * transaction. The caller supplies NO authority field: Participant, Session,
   * fencing token, capability, Exchange, and trusted clock all come from host
   * memory. Recording an ACK changes no Message delivery state, no cursor, and
   * no task state, and it is not proof of reading, processing, or completion. */
  acknowledge(endpointId: string, input: unknown): CeAckResult {
    if (!this.#ackEnabled) throw new CeHostRefusal("CE_HOST_ACK_DISABLED");
    const authority = this.#authority(endpointId);
    let request: Record<string, unknown>;
    try {
      request = captureFields(input, ACK_REQUEST_FIELDS, ACK_REQUEST_FIELDS, "request");
    } catch {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    const { messageId, payloadDigest, payloadLength, messageCreatedAuditSequence } = request;
    if (
      typeof messageId !== "string" ||
      !MESSAGE_ID_PATTERN.test(messageId) ||
      typeof payloadDigest !== "string" ||
      !SHA256_HEX_PATTERN.test(payloadDigest) ||
      !isSafeIntegerAtLeast(payloadLength, 0) ||
      !isSafeIntegerAtLeast(messageCreatedAuditSequence, 1)
    ) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    if (authority.ackCapability === undefined) throw new CeHostRefusal("CE_HOST_ACK_DISABLED");

    let recorded: DeliveryAckResult;
    try {
      const fencingToken = this.#currentFencing(authority);
      recorded = recordDeliveryAck(
        this.#store,
        {
          participantId: authority.participantId,
          sessionId: authority.sessionId,
          fencingToken,
          capability: authority.ackCapability,
          exchangeId: authority.exchangeId,
          messageId,
          payloadDigest,
          payloadLength,
          messageCreatedAuditSequence,
        },
        this.#seams,
      );
    } catch (error) {
      const refusal = toRefusal(error);
      if (refusal.code === "CE_HOST_BUSY") {
        // Proven ACK rollback is a transaction fact, not retry authorization.
        const ackRefusal = new CeHostRefusal("CE_HOST_BUSY", false, refusal.reason);
        ackRefusal.message = "durable store is contended; the ACK request rolled back; rollback does not authorize retry; retry requires explicit operator or upper-layer approval";
        throw ackRefusal;
      }
      throw refusal;
    }
    const receipt = recorded.receipt;
    // Defensive: an ACK receipt is `delivery_ack` by the storage contract.
    // Never publish evidence that disagrees with the frozen projection.
    if (receipt.kind !== "delivery_ack") throw new CeHostRefusal("CE_HOST_UNAVAILABLE");
    return Object.freeze({
      disposition: recorded.disposition,
      receipt: Object.freeze({
        receiptId: receipt.receiptId,
        exchangeId: receipt.exchangeId,
        messageId: receipt.messageId,
        endpoint: Object.freeze({ adapter: receipt.endpoint.adapter, endpointId: receipt.endpoint.endpointId }),
        kind: receipt.kind,
        createdAt: receipt.createdAt,
      }),
      receiptAuditSequence: recorded.receiptAuditSequence,
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
        leaseExpiresAt: undefined,
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
        leaseExpiresAt:
          ownership !== undefined && ownership.sessionId === authority.sessionId ? ownership.expiresAt : undefined,
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
        leaseExpiresAt: undefined,
        fencingToken: undefined,
      });
    }
  }
}
