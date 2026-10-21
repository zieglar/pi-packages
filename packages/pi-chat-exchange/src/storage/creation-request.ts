import { createHash } from "node:crypto";
import { types } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { EndpointRefSchema, type EndpointRef } from "../protocol/entities.js";
import { EXCHANGE_ID_PATTERN } from "../protocol/identity.js";
import { canonicalDigest, IDEMPOTENCY_KEY_MAX_LENGTH, NAMESPACE_MAX_LENGTH } from "../protocol/idempotency.js";

/** Private host policy in bytes, not a protocol field or Result character limit. */
export const MAX_CREATION_PAYLOAD_BYTES = 1_048_576;

export interface CreateExchangeRequest {
  readonly namespace: string;
  readonly idempotencyKey: string;
}

export interface CreateMessageRequest {
  readonly exchangeId: string;
  readonly from: EndpointRef;
  readonly to: EndpointRef;
  readonly payload: Uint8Array;
  readonly idempotencyKey: string;
}

export interface NormalizedExchangeRequest {
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export interface NormalizedMessageRequest extends NormalizedExchangeRequest {
  readonly exchangeId: string;
  readonly from: EndpointRef;
  readonly to: EndpointRef;
  readonly fromEndpointJson: string;
  readonly toEndpointJson: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;
}

export class CreationRequestError extends Error {
  readonly code = "STORAGE_CREATE_REQUEST_INVALID";
  readonly retryable = false;

  constructor(detail: string) {
    super(`creation request rejected: ${detail}`);
    this.name = "CreationRequestError";
  }
}

// These intrinsic getters cannot be shadowed by properties on the input view.
// Hostile process-level replacement of intrinsics is not sandboxed.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;

function reject(detail: string): never {
  throw new CreationRequestError(detail);
}

/** Capture enumerable own fields once. Never retain arbitrary accessor failures. */
function capture(input: unknown, allowed: readonly string[], required: readonly string[], path: string): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null) reject(`${path}: expected object`);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) reject(`${path}: expected plain object`);
    const keys = Reflect.ownKeys(input);
    for (const key of keys) {
      if (typeof key !== "string" || !allowed.includes(key)) reject(`${path}: unknown field`);
      if (!Object.getOwnPropertyDescriptor(input, key)?.enumerable) reject(`${path}: non-enumerable field`);
    }
    for (const key of required) {
      if (!keys.includes(key)) reject(`${path}: missing required field`);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) result[key as string] = (input as Record<PropertyKey, unknown>)[key];
    return result;
  } catch {
    // Do not inspect or preserve a caller-thrown error, even if it has our class.
    return reject(`${path}: invalid fields or inaccessible input`);
  }
}

function text(value: unknown, path: string, maximum: number, noNul = false): string {
  // Unicode mode treats a valid surrogate pair as one non-surrogate code point.
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\uD800-\uDFFF]/u.test(value) || (noNul && value.includes("\u0000"))) {
    reject(`${path}: invalid string`);
  }
  return value;
}

function normalizeEndpoint(input: unknown, path: string): EndpointRef {
  const fields = capture(input, ["adapter", "endpointId", "instanceId"], ["adapter", "endpointId"], path);
  const endpoint: EndpointRef = {
    adapter: text(fields.adapter, `${path}.adapter`, 64),
    endpointId: text(fields.endpointId, `${path}.endpointId`, 256),
  };
  if (Object.hasOwn(fields, "instanceId")) {
    endpoint.instanceId = text(fields.instanceId, `${path}.instanceId`, 256);
  }
  if (!Value.Check(EndpointRefSchema, endpoint)) reject(`${path}: invalid endpoint`);
  return Object.freeze(endpoint);
}

function copyPayload(input: unknown): Uint8Array {
  if (!types.isUint8Array(input)) reject("payload: expected Uint8Array or Buffer");
  let copied: Uint8Array;
  try {
    const buffer: unknown = bufferGetter.call(input);
    if (types.isSharedArrayBuffer(buffer)) reject("payload: shared backing is unsupported");
    // Early refusal avoids a needless oversized allocation. Acceptance still
    // checks the actual copy below. A detached zero-length view fails on copy.
    if (byteLengthGetter.call(input) > MAX_CREATION_PAYLOAD_BYTES) reject("payload: byte limit exceeded");
    copied = new Uint8Array(input);
  } catch {
    return reject("payload: detached, shared, oversized, or inaccessible bytes");
  }
  if (copied.byteLength > MAX_CREATION_PAYLOAD_BYTES) reject("payload: byte limit exceeded");
  return copied;
}

/** The private snapshot never escapes. S0/S1 exposes no persistence operation.
 * Hash and length are derived only from this independent copy. This guarantees
 * consistency with these bytes, not an atomic snapshot of external mutation. */
class CapturedMessage implements NormalizedMessageRequest {
  readonly #payload: Uint8Array;
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly exchangeId: string;
  readonly from: EndpointRef;
  readonly to: EndpointRef;
  readonly fromEndpointJson: string;
  readonly toEndpointJson: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;

  constructor(exchangeId: string, idempotencyKey: string, from: EndpointRef, to: EndpointRef, copiedBytes: Uint8Array) {
    this.#payload = copiedBytes;
    this.exchangeId = exchangeId;
    this.idempotencyKey = idempotencyKey;
    this.from = from;
    this.to = to;
    this.namespace = JSON.stringify(["message.create", exchangeId]);
    this.fromEndpointJson = JSON.stringify(from);
    this.toEndpointJson = JSON.stringify(to);
    this.payloadLength = this.#payload.byteLength;
    this.payloadDigest = createHash("sha256").update(this.#payload).digest("hex");
    this.requestDigest = canonicalDigest({
      op: "chat-exchange/message.create", v: 1, exchangeId, from, to,
      payloadDigest: this.payloadDigest, payloadLength: this.payloadLength,
    });
    Object.freeze(this);
  }

  /**
   * Private-field access is the runtime provenance brand: plain lookalikes,
   * prototype-forged objects, Proxy wrappers (revoked or not) and foreign
   * classes all fail here without invoking any caller-controlled trap or
   * getter. Only a fresh independent copy leaves this module.
   */
  static copyPayloadForPersistence(value: NormalizedMessageRequest): Uint8Array {
    return new Uint8Array((value as CapturedMessage).#payload);
  }
}

/** Trusted-host, private normalization only: no authentication or SQL writes. */
export function normalizeCreateExchangeRequest(input: unknown): NormalizedExchangeRequest {
  const fields = capture(input, ["namespace", "idempotencyKey"], ["namespace", "idempotencyKey"], "request");
  const namespace = text(fields.namespace, "namespace", NAMESPACE_MAX_LENGTH, true);
  const idempotencyKey = text(fields.idempotencyKey, "idempotencyKey", IDEMPOTENCY_KEY_MAX_LENGTH, true);
  return Object.freeze({
    namespace: JSON.stringify(["exchange.create", namespace]),
    idempotencyKey,
    requestDigest: canonicalDigest({ op: "chat-exchange/exchange.create", v: 1 }),
  });
}

/** Does not retain the original request, EndpointRefs, or caller byte storage. */
export function normalizeCreateMessageRequest(input: unknown): NormalizedMessageRequest {
  const names = ["exchangeId", "from", "to", "payload", "idempotencyKey"];
  const fields = capture(input, names, names, "request");
  const exchangeId = text(fields.exchangeId, "exchangeId", 29);
  if (!EXCHANGE_ID_PATTERN.test(exchangeId)) reject("exchangeId: invalid identity");
  const idempotencyKey = text(fields.idempotencyKey, "idempotencyKey", IDEMPOTENCY_KEY_MAX_LENGTH, true);
  const from = normalizeEndpoint(fields.from, "from");
  const to = normalizeEndpoint(fields.to, "to");
  const copiedBytes = copyPayload(fields.payload);
  return new CapturedMessage(exchangeId, idempotencyKey, from, to, copiedBytes);
}

/**
 * Package-private persistence bridge for the durable storage writer only.
 * Never exported through a public barrel and never given SQLite knowledge.
 * The caller receives a one-use fresh copy; the authoritative snapshot and the
 * original caller bytes are never returned, reread, or otherwise exposed.
 */
export function copyCapturedMessagePayloadForPersistence(normalized: NormalizedMessageRequest): Uint8Array {
  try {
    return CapturedMessage.copyPayloadForPersistence(normalized);
  } catch {
    // Provenance and allocation failures are indistinguishable to the caller.
    return reject("payload: unrecognized normalized request provenance");
  }
}
