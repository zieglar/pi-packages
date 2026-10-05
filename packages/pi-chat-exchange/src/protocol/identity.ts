/**
 * Exchange entity identity (frozen v2 contract; encoder frozen since v1).
 *
 * Identity prefixes (opaque, unique, immutable, non-secret, safe to log):
 *
 * - `ho_<ULID>` — Exchange. Legacy prefix retained from protocol v1 for
 *   documented compatibility: the v1 "handoff" entity becomes the Exchange
 *   aggregate root and no existing id is migrated.
 * - `hr_<ULID>` — Result (unchanged from v1).
 * - `msg_`, `att_`, `rcpt_`, `evt_` — additive Message, DeliveryAttempt,
 *   Receipt, and Event identities introduced by protocol v2.
 *
 * Every id is a Crockford Base32 ULID: 48-bit millisecond timestamp + 80-bit
 * CSPRNG randomness, encoded losslessly by {@link encodeUlid}.
 *
 * Human-friendly shortened display IDs may exist for UI convenience, but they
 * are never authoritative (see {@link displayId}).
 */
import { randomBytes } from "node:crypto";

/** Legacy v1 name retained: handoff ids are Exchange ids (`ho_`). */
export const HANDOFF_ID_PREFIX = "ho_" as const;
export const HANDOFF_ID_PATTERN = /^ho_[0-9A-HJKMNP-TV-Z]{26}$/;

export const EXCHANGE_ID_PREFIX = HANDOFF_ID_PREFIX;
export const EXCHANGE_ID_PATTERN = HANDOFF_ID_PATTERN;

export const MESSAGE_ID_PREFIX = "msg_" as const;
export const MESSAGE_ID_PATTERN = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;

export const ATTEMPT_ID_PREFIX = "att_" as const;
export const ATTEMPT_ID_PATTERN = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;

export const RESULT_ID_PREFIX = "hr_" as const;
export const RESULT_ID_PATTERN = /^hr_[0-9A-HJKMNP-TV-Z]{26}$/;

export const RECEIPT_ID_PREFIX = "rcpt_" as const;
export const RECEIPT_ID_PATTERN = /^rcpt_[0-9A-HJKMNP-TV-Z]{26}$/;

export const EVENT_ID_PREFIX = "evt_" as const;
export const EVENT_ID_PATTERN = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

export const ENTITY_ID_PREFIXES = [
  EXCHANGE_ID_PREFIX,
  MESSAGE_ID_PREFIX,
  ATTEMPT_ID_PREFIX,
  RESULT_ID_PREFIX,
  RECEIPT_ID_PREFIX,
  EVENT_ID_PREFIX,
] as const;

export type EntityIdPrefix = (typeof ENTITY_ID_PREFIXES)[number];

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_BITS = 48;
const RANDOM_BITS = 80;
const ENCODED_LENGTH = 26;

export type HandoffId = string & { readonly __brand: "HandoffId" };

export function isHandoffId(value: unknown): value is HandoffId {
  return typeof value === "string" && HANDOFF_ID_PATTERN.test(value);
}

export function assertHandoffId(value: unknown): HandoffId {
  if (!isHandoffId(value)) {
    throw new Error(`invalid handoff id: expected ${HANDOFF_ID_PATTERN}`);
  }
  return value;
}

/**
 * Encode a ULID from a millisecond timestamp and 10 random bytes, per the
 * ULID specification (Crockford Base32, big-endian, first char 0-7).
 */
export function encodeUlid(timestampMs: number, random: Uint8Array): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs >= 2 ** TIME_BITS) {
    throw new Error(`timestamp out of range for ULID: ${timestampMs}`);
  }
  if (random.length !== RANDOM_BITS / 8) {
    throw new Error(`ULID requires ${RANDOM_BITS / 8} random bytes, got ${random.length}`);
  }

  const chars: string[] = new Array<string>(ENCODED_LENGTH);
  // 48-bit time, 5 bits per char: chars 0..9 (char 0 masked to 3 bits below).
  let remainder = timestampMs;
  for (let i = 9; i >= 1; i -= 1) {
    chars[i] = alphabetChar(remainder & 31);
    remainder = Math.floor(remainder / 32);
  }
  // After nine divisions the top 3 bits remain for the masked first char.
  chars[0] = alphabetChar(remainder & 7);

  // Consume all ten bytes as one 80-bit big-endian value, then emit sixteen
  // disjoint five-bit groups. Pairing two chars per byte overlaps bits and
  // silently discards the final two bytes.
  let entropy = 0n;
  for (const byte of random) entropy = (entropy << 8n) | BigInt(byte);
  for (let i = 25; i >= 10; i -= 1) {
    chars[i] = alphabetChar(Number(entropy & 31n));
    entropy >>= 5n;
  }
  return chars.join("");
}

function alphabetChar(index: number): string {
  const char = CROCKFORD_ALPHABET[index];
  if (char === undefined) {
    throw new Error(`Crockford alphabet index out of range: ${index}`);
  }
  return char;
}

/** Generate a new exchange id (`ho_`). `now` is injectable for deterministic tests. */
export function generateHandoffId(now: number = Date.now()): HandoffId {
  return assertHandoffId(HANDOFF_ID_PREFIX + encodeUlid(now, randomBytes(RANDOM_BITS / 8)));
}

/** Generate a new entity id for any declared prefix. Additive v2 ids use this. */
export function generateEntityId(prefix: EntityIdPrefix, now: number = Date.now()): string {
  return prefix + encodeUlid(now, randomBytes(RANDOM_BITS / 8));
}

/** Structural check for any declared entity id prefix. */
export function isEntityId(prefix: EntityIdPrefix, value: unknown): value is string {
  return typeof value === "string" && entityIdPattern(prefix).test(value);
}

export function entityIdPattern(prefix: EntityIdPrefix): RegExp {
  switch (prefix) {
    case "ho_":
      return EXCHANGE_ID_PATTERN;
    case "msg_":
      return MESSAGE_ID_PATTERN;
    case "att_":
      return ATTEMPT_ID_PATTERN;
    case "hr_":
      return RESULT_ID_PATTERN;
    case "rcpt_":
      return RECEIPT_ID_PATTERN;
    case "evt_":
      return EVENT_ID_PATTERN;
  }
}

/**
 * Non-authoritative short label for display. Derived from the immutable id,
 * but must never be used for persistence, correlation, or API identity.
 */
export function displayId(handoffId: HandoffId): string {
  return handoffId.slice(-8);
}
