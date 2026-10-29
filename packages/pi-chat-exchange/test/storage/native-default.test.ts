import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadVerifiedNativeArtifact, nativeTarget, prepareNativeArtifact } from "../../src/storage/native-artifact.js";
import { NATIVE_COMPAT, nativeAssetName, parseNativeCompat, type NativeCompat } from "../../src/storage/native-compat.js";
import { readDriverSelection, resolveSqliteDriver, writeDriverSelection } from "../../src/storage/sqlite-driver-selection.js";

const child = fileURLToPath(new URL("./support/native-default-child.mjs", import.meta.url));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "ce-native-default-"));
  roots.push(path);
  return path;
}
function run(directory: string, options: object, error?: string, mode?: string) {
  const log = join(directory, "sqlite-access.log");
  const result = spawnSync(process.execPath, [child, JSON.stringify({ home: directory, log, options, error, mode })], {
    cwd: directory, env: { ...process.env, HOME: directory, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("native-default child passed");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}
async function prepared(directory: string) {
  // Qualification must name the published release bytes explicitly; never silently
  // substitute an unqualified local Rust build or change the production trust pins.
  const path = process.env.CE_TEST_NATIVE_MODULE;
  if (!path) throw new Error("CE_TEST_NATIVE_MODULE must point to the published Native .node artifact");
  const bytes = readFileSync(path);
  const manifest = structuredClone(NATIVE_COMPAT);
  const target = nativeTarget();
  const entry = manifest.versions["0.1.0"]!.assets[target]!;
  (entry as { sha256: string | null }).sha256 = createHash("sha256").update(bytes).digest("hex");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
    response.end(bytes);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  const root = join(directory, "cache");
  const verified = await prepareNativeArtifact({ root, manifest, baseUrl: `http://127.0.0.1:${address.port}` });
  await new Promise<void>(resolve => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  return { root, manifest, verified, selectionFile: join(directory, "absent-selection.json") };
}

describe("real Native default without node:sqlite access (built dist required)", () => {
  it("proves each access guard and the explicit Node compatibility selection reach the denial", () => {
    expect(run(home(), {}, undefined, "controls").sort()).toEqual(["builtin", "cjs", "esm"]);
    const directory = home();
    const selectionFile = join(directory, "selection.json");
    writeDriverSelection({ driver: "node-sqlite" }, selectionFile);
    expect(run(directory, { selectionFile }, "CE_TEST_SQLITE_DENIED")).toEqual(["builtin"]);
  });

  it("refuses an explicitly unpinned fixture with no fallback before any persistent database or builtin access", () => {
    const directory = home();
    const manifest = parseNativeCompat({ ...NATIVE_COMPAT, versions: { "0.1.0": { assets: { [nativeTarget()]: { asset: nativeAssetName("0.1.0", nativeTarget()), sha256: null } } } } });
    const options = { root: join(directory, "empty-cache"), selectionFile: join(directory, "absent.json"), manifest };
    expect(readDriverSelection(options.selectionFile)).toEqual({ driver: "rust-native", nativeVersion: "0.1.0" });
    expect(() => resolveSqliteDriver(options)).toThrowError(expect.objectContaining({ code: "CE_NATIVE_ARTIFACT_UNPINNED" }));
    expect(run(directory, options, "CE_NATIVE_ARTIFACT_UNPINNED")).toEqual([]);
    expect(existsSync(options.root)).toBe(false);
  });

});

// These tests run only when the caller supplies the actual published .node artifact.
// Skipping is visible in test output; the native CI lane supplies it explicitly.
describe.skipIf(!process.env.CE_TEST_NATIVE_MODULE)("published Native default artifact", () => {
  it("uses the real pinned Native ABI offline with no selection, private cache and real SQL", async () => {
    const directory = home();
    const { root, manifest, verified, selectionFile } = await prepared(directory);
    expect(readDriverSelection(selectionFile)).toEqual({ driver: "rust-native", nativeVersion: "0.1.0" });
    expect(loadVerifiedNativeArtifact({ root, manifest }).info).toMatchObject({ abiVersion: 1, middlewareVersion: "0.1.0", target: nativeTarget() });
    expect(statSync(dirname(verified.path)).mode & 0o777).toBe(0o700);
    expect(statSync(verified.path).mode & 0o777).toBe(0o600);
    const record = join(dirname(verified.path), "artifact.json");
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
      version: "0.1.0", target: nativeTarget(), source: "fixture",
      sha256: manifest.versions["0.1.0"]!.assets[nativeTarget()]!.sha256,
    });
    expect(run(directory, { root, manifest, selectionFile })).toEqual([]);
    expect(existsSync(selectionFile)).toBe(false);
  });

  it.each([
    ["missing", "CE_NATIVE_CACHE_MISSING"],
    ["corrupt", "CE_NATIVE_HASH_MISMATCH"],
    ["wrong-pin", "CE_NATIVE_HASH_MISMATCH"],
    ["invalid-abi", "CE_NATIVE_ABI_MISMATCH"],
    ["unsafe-file", "CE_NATIVE_CACHE_UNSAFE"],
    ["unsafe-ancestor", "CE_NATIVE_CACHE_UNSAFE"],
  ] as const)("refuses %s before persistent storage, without accessing node:sqlite", async (failure, code) => {
    const directory = home();
    const { root, manifest, verified, selectionFile } = await prepared(directory);
    if (failure === "missing") rmSync(verified.path);
    if (failure === "corrupt") writeFileSync(verified.path, "not the published module");
    if (failure === "wrong-pin") (manifest.versions["0.1.0"]!.assets[nativeTarget()]! as { sha256: string }).sha256 = "0".repeat(64);
    if (failure === "invalid-abi") (manifest as { abiVersion: number }).abiVersion = 2;
    if (failure === "unsafe-file") chmodSync(verified.path, 0o644);
    if (failure === "unsafe-ancestor") chmodSync(root, 0o777);
    expect(run(directory, { root, manifest: manifest as NativeCompat, selectionFile }, code)).toEqual([]);
  });
});
