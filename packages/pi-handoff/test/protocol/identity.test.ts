import { describe, expect, it } from "vitest";
import {
  HANDOFF_ID_PATTERN,
  displayId,
  encodeUlid,
  generateHandoffId,
  isHandoffId,
} from "../../src/protocol/identity.js";

function decodeTimestamp(ulid: string): number {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = 0;
  for (let i = 0; i < 10; i += 1) {
    const index = alphabet.indexOf(ulid[i] ?? "");
    expect(index).toBeGreaterThanOrEqual(0);
    // Every char carries 5 bits; the encoder masks char 0 to the top 3 bits.
    value = value * 32 + index;
  }
  return value;
}

describe("handoff identity (frozen v1)", () => {
  it("generates ids matching the ho_<ULID> contract", () => {
    for (let i = 0; i < 200; i += 1) {
      const id = generateHandoffId();
      expect(id).toMatch(HANDOFF_ID_PATTERN);
      expect(isHandoffId(id)).toBe(true);
    }
  });

  it("encodes the millisecond timestamp losslessly (round-trip)", () => {
    const samples = [0, 1, 1_000, 1_700_000_000_000, 2 ** 48 - 1];
    for (const now of samples) {
      const random = new Uint8Array(10).fill(0xff);
      const encoded = encodeUlid(now, random);
      expect(encoded).toHaveLength(26);
      expect(decodeTimestamp(encoded)).toBe(now);
    }
  });

  it("matches the fixed all-zero ULID vector", () => {
    expect(encodeUlid(0, new Uint8Array(10))).toBe("0".repeat(26));
  });

  it("produces unique ids across calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateHandoffId()));
    expect(ids.size).toBe(1000);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "ho_", "ho_0000000000000000000000000", "xx_01ARZ3NDEKTSV4RRFFQ69G5FAV", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAU", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAIL"]) {
      expect(isHandoffId(bad)).toBe(false);
    }
  });

  it("displayId is a non-authoritative suffix, never a valid identity", () => {
    const id = generateHandoffId();
    const short = displayId(id);
    expect(short).toHaveLength(8);
    expect(id.endsWith(short)).toBe(true);
    expect(isHandoffId(short)).toBe(false);
  });

  it("encodeUlid rejects out-of-range timestamps and wrong randomness size", () => {
    expect(() => encodeUlid(-1, new Uint8Array(10))).toThrow();
    expect(() => encodeUlid(2 ** 48, new Uint8Array(10))).toThrow();
    expect(() => encodeUlid(0, new Uint8Array(9))).toThrow();
  });
});
