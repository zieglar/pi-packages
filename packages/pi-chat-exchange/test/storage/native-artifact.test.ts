import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadVerifiedNativeArtifact, nativeTarget, prepareNativeArtifact } from "../../src/storage/native-artifact.js";
import { nativeAssetName, parseNativeCompat, type NativeCompat } from "../../src/storage/native-compat.js";
import { readDriverSelection, writeDriverSelection } from "../../src/storage/sqlite-driver-selection.js";

const nativePath = process.env.CE_TEST_NATIVE_MODULE ?? fileURLToPath(new URL("../../native/ce-sqlite/target/release/ce-sqlite.node", import.meta.url));
const nativeBytes = readFileSync(nativePath);
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "ce-native-artifact-"));
  roots.push(path);
  return path;
}
function manifestFor(bytes: Uint8Array, version = "0.1.0", abiVersion = 1): NativeCompat {
  const target = nativeTarget();
  return {
    abiVersion,
    defaultVersion: version,
    repository: "zieglar/pi-packages",
    versions: {
      [version]: {
        assets: {
          [target]: { asset: nativeAssetName(version, target), sha256: createHash("sha256").update(bytes).digest("hex") },
        },
      },
    },
  };
}
async function fixture(bytes: Uint8Array): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength });
    res.end(bytes);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

describe("Native artifact manager (local fixture, not GitHub Releases)", () => {
  it("prepares a pinned asset and loads it offline after the server stops", async () => {
    const baseUrl = await fixture(nativeBytes);
    const cache = root();
    const manifest = manifestFor(nativeBytes);
    const prepared = await prepareNativeArtifact({ root: cache, manifest, baseUrl });
    expect(prepared.info.middlewareVersion).toBe("0.1.0");
    expect(prepared.info.abiVersion).toBe(1);
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    const loaded = loadVerifiedNativeArtifact({ root: cache, manifest });
    expect(loaded.info.sqliteVersion).toBe("3.54.1");
    expect(loaded.info.target).toBe(nativeTarget());
  });

  it("rejects a tampered download without leaving a loadable artifact", async () => {
    const baseUrl = await fixture(Buffer.from("tampered-not-a-native-module"));
    const cache = root();
    const manifest = manifestFor(nativeBytes);
    await expect(prepareNativeArtifact({ root: cache, manifest, baseUrl })).rejects.toMatchObject({ code: "CE_NATIVE_HASH_MISMATCH" });
    expect(existsSync(join(cache, "ce-sqlite", "0.1.0", nativeTarget(), nativeAssetName("0.1.0", nativeTarget())))).toBe(false);
  });

  it("rejects a non-fixed asset path before any network or cache write", async () => {
    const manifest = manifestFor(nativeBytes);
    (manifest.versions["0.1.0"]!.assets[nativeTarget()]! as { asset: string }).asset = "../escape.node";
    await expect(prepareNativeArtifact({ root: root(), manifest, baseUrl: "http://127.0.0.1:1" })).rejects.toMatchObject({ code: "CE_NATIVE_ASSET_INVALID" });
  });

  it("fails clearly for missing cache, hash changes, ABI and unsupported versions", async () => {
    const cache = root();
    const manifest = manifestFor(nativeBytes);
    expect(() => loadVerifiedNativeArtifact({ root: cache, manifest })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_CACHE_MISSING" }));
    await prepareNativeArtifact({ root: cache, manifest, baseUrl: await fixture(nativeBytes) });
    const targetPath = join(cache, "ce-sqlite", "0.1.0", nativeTarget(), nativeAssetName("0.1.0", nativeTarget()));
    writeFileSync(targetPath, Buffer.from("changed"));
    chmodSync(targetPath, 0o600);
    expect(() => loadVerifiedNativeArtifact({ root: cache, manifest })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_HASH_MISMATCH" }));
    expect(() => loadVerifiedNativeArtifact({ root: cache, manifest: manifestFor(nativeBytes, "0.1.0", 2) })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_HASH_MISMATCH" }));
    expect(() => loadVerifiedNativeArtifact({ root: cache, manifest, version: "9.9.9" })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_VERSION_UNSUPPORTED" }));
  });

  it("keeps two versions side by side and does not auto-upgrade", async () => {
    const cache = root();
    const first = manifestFor(nativeBytes, "0.1.0");
    const second = manifestFor(nativeBytes, "0.2.0");
    await prepareNativeArtifact({ root: cache, manifest: first, baseUrl: await fixture(nativeBytes) });
    await expect(prepareNativeArtifact({ root: cache, manifest: second, baseUrl: await fixture(nativeBytes) })).rejects.toMatchObject({ code: "CE_NATIVE_IDENTITY_MISMATCH" });
    expect(existsSync(join(cache, "ce-sqlite", "0.1.0", nativeTarget(), nativeAssetName("0.1.0", nativeTarget())))).toBe(true);
    expect(existsSync(join(cache, "ce-sqlite", "0.2.0", nativeTarget(), nativeAssetName("0.2.0", nativeTarget())))).toBe(true);
    // 0.2.0 is a cache entry only; the module still self-reports 0.1.0 and is rejected.
    expect(() => loadVerifiedNativeArtifact({ root: cache, manifest: second })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_IDENTITY_MISMATCH" }));
    expect(loadVerifiedNativeArtifact({ root: cache, manifest: first }).info.middlewareVersion).toBe("0.1.0");
  });

  it("handles concurrent preparation without corrupting the cache", async () => {
    const baseUrl = await fixture(nativeBytes);
    const cache = root();
    const manifest = manifestFor(nativeBytes);
    const [a, b] = await Promise.all([
      prepareNativeArtifact({ root: cache, manifest, baseUrl }),
      prepareNativeArtifact({ root: cache, manifest, baseUrl }),
    ]);
    expect(a.path).toBe(b.path);
    expect(loadVerifiedNativeArtifact({ root: cache, manifest }).info.middlewareVersion).toBe("0.1.0");
  });
  it("refuses writable or symlink cache ancestors before runtime loading", async () => {
    const cache = root();
    const manifest = manifestFor(nativeBytes);
    await prepareNativeArtifact({ root: cache, manifest, baseUrl: await fixture(nativeBytes) });
    chmodSync(cache, 0o777);
    expect(() => loadVerifiedNativeArtifact({ root: cache, manifest })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_CACHE_UNSAFE" }));
    chmodSync(cache, 0o700);
    const link = join(root(), "cache-link");
    symlinkSync(cache, link);
    expect(() => loadVerifiedNativeArtifact({ root: link, manifest })).toThrowError(expect.objectContaining({ code: "CE_NATIVE_CACHE_UNSAFE" }));
  });
  it.each([null, {}, { versions: null }, { abiVersion: "1" }])("rejects malformed manifest JSON at the boundary: %j", (value) => {
    expect(() => parseNativeCompat(value)).toThrowError(expect.objectContaining({ code: "CE_NATIVE_MANIFEST_INVALID" }));
  });
});

describe("SQLite driver selection file", () => {
  it("defaults to Node, round-trips selection and rejects malformed values", () => {
    const file = join(root(), "sqlite-driver.json");
    expect(readDriverSelection(file)).toEqual({ driver: "node-sqlite" });
    writeDriverSelection({ driver: "rust-native", nativeVersion: "0.1.0" }, file);
    expect(readDriverSelection(file)).toEqual({ driver: "rust-native", nativeVersion: "0.1.0" });
    writeDriverSelection({ driver: "node-sqlite" }, file);
    expect(readDriverSelection(file)).toEqual({ driver: "node-sqlite" });
    writeFileSync(file, JSON.stringify({ version: 1, driver: "rust-native" }));
    expect(() => readDriverSelection(file)).toThrowError(expect.objectContaining({ code: "CE_SQLITE_DRIVER_SELECTION_INVALID" }));
  });
});
