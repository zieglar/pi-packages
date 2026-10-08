import { Value } from "@sinclair/typebox/value";
import { EventSchema, ExchangeSchema, SHA256_HEX_PATTERN, type Exchange } from "../protocol/entities.js";
import { generateEntityId, generateHandoffId, EXCHANGE_ID_PATTERN } from "../protocol/identity.js";
import { canonicalDigest, type IdempotentCreateRecord } from "../protocol/idempotency.js";
import { normalizeCreateExchangeRequest, type NormalizedExchangeRequest } from "./creation-request.js";
import type { DurableStore } from "./store.js";
import {
  ConditionalMutationError, StorageTransactionError, requireSingleRowChange,
  withImmediateTransaction, type TransactionHandle,
} from "./transaction.js";

export interface ExchangeCreation {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly exchange: Exchange;
  readonly record: IdempotentCreateRecord;
}

/** Private synchronous fault boundaries. Hooks receive no capabilities or values.
 * Trusted test/host code owns execution deadlines; these are not a sandbox. */
interface PrivateCreationSeams {
  readonly now?: () => string;
  readonly afterExchangeInsert?: () => void;
  readonly afterIdempotencyInsert?: () => void;
  readonly afterAuditInsert?: () => void;
}

class CreationDomainError extends Error {
  readonly outcome = "ROLLED_BACK";
  readonly retryable = false;
  readonly code: "STORAGE_IDEMPOTENCY_CORRUPT" | "IDEMPOTENCY_KEY_CONFLICT";
  constructor(code: "STORAGE_IDEMPOTENCY_CORRUPT" | "IDEMPOTENCY_KEY_CONFLICT") {
    super(code === "STORAGE_IDEMPOTENCY_CORRUPT"
      ? "stored Exchange creation is inconsistent; operator review required"
      : "creation idempotency key conflicts with a valid stored request");
    this.name = "CreationDomainError";
    this.code = code;
  }
}

function corrupt(): never {
  throw new CreationDomainError("STORAGE_IDEMPOTENCY_CORRUPT");
}

/** Validate durable consistency BEFORE comparing the incoming request digest.
 * Schema v1 has no immutable creation metadata enforcement: coordinated writes
 * by a privileged raw connection are not authenticated by this validation. */
function replay(tx: TransactionHandle, request: NormalizedExchangeRequest): ExchangeCreation | undefined {
  const row = tx.prepare("SELECT * FROM idempotency_record WHERE namespace=? AND idempotency_key=?")
    .get(request.namespace, request.idempotencyKey);
  if (row === undefined) return undefined;
  if (Object.keys(row).length !== 6 || row.namespace !== request.namespace ||
      row.idempotency_key !== request.idempotencyKey || row.private_revision !== 1 ||
      typeof row.request_digest !== "string" || !SHA256_HEX_PATTERN.test(row.request_digest) ||
      typeof row.entity_id !== "string" || !EXCHANGE_ID_PATTERN.test(row.entity_id) ||
      typeof row.created_at !== "string") corrupt();

  const stored = tx.prepare("SELECT * FROM exchange WHERE exchange_id=?").get(row.entity_id);
  if (stored === undefined || Object.keys(stored).length !== 5 || stored.private_revision !== 1 ||
      stored.exchange_id !== row.entity_id || stored.created_at !== row.created_at ||
      !((stored.state === "OPEN" && stored.closed_at === null) ||
        (stored.state === "CLOSED" && typeof stored.closed_at === "string"))) corrupt();

  const candidate = {
    exchangeId: stored.exchange_id,
    state: stored.state,
    createdAt: stored.created_at,
    ...(stored.closed_at === null ? {} : { closedAt: stored.closed_at }),
  };
  if (!Value.Check(ExchangeSchema, candidate)) corrupt();
  // Exchange v1 has no creation-content fields. A different stored digest cannot
  // describe a valid Exchange-create request; it is corruption, not conflict.
  const storedDigest = canonicalDigest({ op: "chat-exchange/exchange.create", v: 1 });
  if (row.request_digest !== storedDigest) corrupt();
  if (row.request_digest !== request.requestDigest) {
    throw new CreationDomainError("IDEMPOTENCY_KEY_CONFLICT");
  }
  return Object.freeze({
    disposition: "REPLAYED",
    exchange: Object.freeze(candidate),
    record: Object.freeze({ entityId: row.entity_id, requestDigest: row.request_digest, createdAt: row.created_at }),
  });
}

function hook(action: (() => void) | undefined): void {
  if (action === undefined) return;
  try {
    // Never inspect unsupported results or arbitrary thrown values.
    if (action() === undefined) return;
  } catch { /* replace caller exceptions before the B1 helper sees them */ }
  throw new Error("private creation hook failed or returned a non-undefined value");
}

/** Private, trusted-host operation. No authentication, dispatch, Message writes,
 * automatic retries, resolution API, or public control binding is provided.
 * Results escape only after the accepted helper confirms COMMITTED. */
export function createExchange(store: DurableStore, input: unknown, privateSeams: PrivateCreationSeams = {}): ExchangeCreation {
  const request = normalizeCreateExchangeRequest(input);
  let exchange: Exchange;
  let eventId: string;
  let hooks: {
    afterExchangeInsert: (() => void) | undefined;
    afterIdempotencyInsert: (() => void) | undefined;
    afterAuditInsert: (() => void) | undefined;
  };
  try {
    // Capture seam accessors before entering the transaction. A caller-created
    // domain-error instance must not be mistaken for an internal SQL/domain error.
    hooks = {
      afterExchangeInsert: privateSeams.afterExchangeInsert,
      afterIdempotencyInsert: privateSeams.afterIdempotencyInsert,
      afterAuditInsert: privateSeams.afterAuditInsert,
    };
    if (Object.values(hooks).some((value) => value !== undefined && typeof value !== "function")) {
      throw new Error("invalid private hook");
    }
    const createdAt = (privateSeams.now ?? (() => new Date().toISOString()))();
    if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
        !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new Error("invalid private clock");
    }
    const time = Date.parse(createdAt);
    exchange = Object.freeze({ exchangeId: generateHandoffId(time), state: "OPEN", createdAt });
    eventId = generateEntityId("evt_", time);
  } catch {
    throw new StorageTransactionError("creation candidate generation failed", "begin", { outcome: "ROLLED_BACK" });
  }

  let captured: ExchangeCreation | undefined;
  let domainFailure: CreationDomainError | ConditionalMutationError | undefined;
  try {
    withImmediateTransaction(store.database, (tx) => {
      try {
        const existing = replay(tx, request);
        if (existing !== undefined) {
          captured = existing;
          return; // Exactly undefined, including replay.
        }
        const event = {
          eventId, exchangeId: exchange.exchangeId, sequence: 1, kind: "exchange_opened",
          subjectId: exchange.exchangeId, createdAt: exchange.createdAt,
        };
        if (!Value.Check(ExchangeSchema, exchange) || !Value.Check(EventSchema, event)) {
          throw new Error("creation candidate failed frozen schema validation");
        }
        requireSingleRowChange(tx.prepare(
          "INSERT INTO exchange(exchange_id, state, created_at, closed_at, private_revision) VALUES (?, 'OPEN', ?, NULL, 1)",
        ).run(exchange.exchangeId, exchange.createdAt), "Exchange insert");
        hook(hooks.afterExchangeInsert);
        requireSingleRowChange(tx.prepare(
          "INSERT INTO idempotency_record(namespace, idempotency_key, request_digest, entity_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
        ).run(request.namespace, request.idempotencyKey, request.requestDigest, exchange.exchangeId, exchange.createdAt), "idempotency insert");
        hook(hooks.afterIdempotencyInsert);
        requireSingleRowChange(tx.prepare(
          "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision) VALUES (?, ?, 1, 'exchange_opened', ?, ?, 1)",
        ).run(eventId, exchange.exchangeId, exchange.exchangeId, exchange.createdAt), "audit insert");
        hook(hooks.afterAuditInsert);
        captured = Object.freeze({
          disposition: "CREATED", exchange,
          record: Object.freeze({ entityId: exchange.exchangeId, requestDigest: request.requestDigest, createdAt: exchange.createdAt }),
        });
        // No return value: B1 runtime enforces exactly undefined.
      } catch (error) {
        if (error instanceof CreationDomainError || error instanceof ConditionalMutationError) {
          domainFailure = error;
          throw error;
        }
        // SQLite messages, hook failures and arbitrary objects are not retained.
        throw new Error("Exchange creation callback failed");
      }
    });
  } catch (error) {
    if (error instanceof ConditionalMutationError && error === domainFailure) throw error;
    if (error instanceof StorageTransactionError) {
      if (error.outcome === "ROLLED_BACK" && domainFailure !== undefined && error.cause === domainFailure) {
        throw domainFailure;
      }
      // INDETERMINATE always wins over nested domain failures. B1 alone owns
      // rollback classification, connection invalidation and retry eligibility.
      throw new StorageTransactionError("Exchange creation transaction failed", error.stage, {
        outcome: error.outcome, busy: error.retryable,
      });
    }
    throw new StorageTransactionError("Exchange creation transaction outcome is unknown", "callback");
  }
  // Both callback paths assign captured; never construct results with reads
  // after commit, nor publish a candidate on any helper failure.
  return captured!;
}
