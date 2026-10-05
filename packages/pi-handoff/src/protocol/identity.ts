/**
 * Handoff identity (frozen v1 contract).
 *
 * A handoff is identified by `ho_<ULID>`:
 * - opaque: carries no semantics about the prompt or the machine;
 * - unique: 48-bit millisecond timestamp + 80-bit CSPRNG randomness;
 * - immutable: assigned once at creation, never reassigned;
 * - non-secret: safe to persist, log, and display;
 * - independent of prompt contents.
 *
 * Human-friendly shortened display IDs may exist for UI convenience, but they
 * are never authoritative (see {@link displayId}).
 */
import { randomBytes } from "node:crypto";

export const HANDOFF_ID_PREFIX = "ho_" as const;
export const HANDOFF_ID_PATTERN = /^ho_[0-9A-HJKMNP-TV-Z]{26}$/;

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

  // 80-bit randomness, big-endian, 16 chars.
  for (let i = 0; i < 16; i += 1) {
    const byteIndex = Math.floor(i / 2);
    const byte = random[byteIndex];
    if (byte === undefined) {
      throw new Error(`random byte out of range at index ${byteIndex}`);
    }
    const fiveBits = i % 2 === 0 ? byte >> 3 : byte & 31;
    chars[10 + i] = alphabetChar(fiveBits);
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

/** Generate a new handoff id. `now` is injectable for deterministic tests. */
export function generateHandoffId(now: number = Date.now()): HandoffId {
  return assertHandoffId(HANDOFF_ID_PREFIX + encodeUlid(now, randomBytes(RANDOM_BITS / 8)));
}

/**
 * Non-authoritative short label for display. Derived from the immutable id,
 * but must never be used for persistence, correlation, or API identity.
 */
export function displayId(handoffId: HandoffId): string {
  return handoffId.slice(-8);
}
