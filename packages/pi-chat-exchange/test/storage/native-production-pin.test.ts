import { describe, expect, it } from "vitest";
import { NATIVE_COMPAT, nativeAssetName, parseNativeCompat } from "../../src/storage/native-compat.js";

// These are the independently verified ce-sqlite-v0.1.0 Release pins, not a
// GitHub latest redirect or hashes inferred from a local build.
const RELEASE_SHA256 = {
  "aarch64-apple-darwin": "b3b0102931f4fd50459e435cd0ac3ad68f61f9c00c0c14366eb03ab5f4b71db3",
  "x86_64-apple-darwin": "53f036cca6b43a75f340c192dc67b070919904ad3590f5e63fa56a6d408e180b",
  "x86_64-unknown-linux-gnu": "d93db0cf84621495154ff98f3b293b615593967060050b38d9ceaee6871efaf7",
  "aarch64-unknown-linux-gnu": "6186c334e362d283481182efd1c6e8eaa98702b76bd6c3e5e933d584263c99d2",
} as const;

describe("production ce-sqlite-v0.1.0 trust pins", () => {
  it("pins exactly the attested release, source, ABI and four target hashes", () => {
    expect(NATIVE_COMPAT.abiVersion).toBe(1);
    expect(NATIVE_COMPAT.repository).toBe("zieglar/pi-packages");
    expect(NATIVE_COMPAT.defaultVersion).toBe("0.1.0");
    const assets = NATIVE_COMPAT.versions["0.1.0"]!.assets;
    expect(Object.keys(assets).sort()).toEqual(Object.keys(RELEASE_SHA256).sort());
    for (const [target, sha256] of Object.entries(RELEASE_SHA256)) {
      expect(assets[target]).toEqual({ asset: nativeAssetName("0.1.0", target), sha256 });
    }
  });

  it("accepts the production manifest with the production validator", () => {
    expect(() => parseNativeCompat(NATIVE_COMPAT)).not.toThrow();
  });
});
