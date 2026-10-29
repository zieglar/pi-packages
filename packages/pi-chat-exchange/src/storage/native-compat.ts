/** Native middleware compatibility is versioned independently of the CE npm
 * package. The hashes below are the trust anchor shipped with CE source: a
 * Release Asset and a checksum fetched from the same untrusted location are
 * NOT sufficient by themselves. `null` means unpublished/unpinned and refuses
 * both prepare and runtime loading. Fill only from the verified release gate. */

export interface NativeAsset {
  readonly asset: string;
  readonly sha256: string | null;
}

export interface NativeVersion {
  readonly assets: Readonly<Record<string, NativeAsset>>;
}

export interface NativeCompat {
  readonly abiVersion: number;
  readonly defaultVersion: string;
  readonly repository: string;
  readonly versions: Readonly<Record<string, NativeVersion>>;
}

export const NATIVE_ABI_VERSION = 1;
export const NATIVE_DEFAULT_VERSION = "0.1.0";
export const NATIVE_REPOSITORY = "zieglar/pi-packages";

export function nativeAssetName(version: string, target: string): string {
  return `ce-sqlite-${version}-${target}.node`;
}
/** Validate operator-provided JSON once, before it becomes a trusted manifest. */
export function parseNativeCompat(value: unknown): NativeCompat {
  const invalid = (): never => {
    throw Object.assign(new Error("invalid Native compatibility manifest"), { code: "CE_NATIVE_MANIFEST_INVALID" });
  };
  const object = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry);
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
  if (!object(value) || value.abiVersion !== NATIVE_ABI_VERSION
    || value.repository !== NATIVE_REPOSITORY || typeof value.defaultVersion !== "string"
    || !semver.test(value.defaultVersion) || !object(value.versions)) return invalid();
  const targets = new Set(["aarch64-apple-darwin", "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]);
  for (const [version, entry] of Object.entries(value.versions)) {
    if (!semver.test(version) || !object(entry) || !object(entry.assets)
      || Object.keys(entry.assets).length === 0) return invalid();
    for (const [target, asset] of Object.entries(entry.assets)) {
      if (!targets.has(target) || !object(asset)
        || asset.asset !== nativeAssetName(version, target)
        || !(asset.sha256 === null || (typeof asset.sha256 === "string" && /^[0-9a-f]{64}$/.test(asset.sha256)))) return invalid();
    }
  }
  if (!Object.hasOwn(value.versions, value.defaultVersion)) return invalid();
  // SAFETY: every required nested field and asset has been narrowed above;
  // TypeScript cannot retain that relationship through Object.entries.
  return value as unknown as NativeCompat;
}


// ce-sqlite-v0.1.0 immutable Release 427441708, source a8386aa…; verified by SHA256SUMS
// and all seven attestation subjects bound to that source commit.
const CE_SQLITE_V010_SHA256: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "b3b0102931f4fd50459e435cd0ac3ad68f61f9c00c0c14366eb03ab5f4b71db3",
  "x86_64-apple-darwin": "53f036cca6b43a75f340c192dc67b070919904ad3590f5e63fa56a6d408e180b",
  "x86_64-unknown-linux-gnu": "d93db0cf84621495154ff98f3b293b615593967060050b38d9ceaee6871efaf7",
  "aarch64-unknown-linux-gnu": "6186c334e362d283481182efd1c6e8eaa98702b76bd6c3e5e933d584263c99d2",
};

export const NATIVE_COMPAT: NativeCompat = {
  abiVersion: NATIVE_ABI_VERSION,
  defaultVersion: NATIVE_DEFAULT_VERSION,
  repository: NATIVE_REPOSITORY,
  versions: {
    [NATIVE_DEFAULT_VERSION]: {
      assets: Object.fromEntries([
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
      ].map((target) => [target, { asset: nativeAssetName(NATIVE_DEFAULT_VERSION, target), sha256: CE_SQLITE_V010_SHA256[target]! }])),
    },
  },
};
