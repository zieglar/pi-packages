import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectNativeReadiness, nativeTargetName, runNativeCommand } from "../../src/runtime/native-readiness.js";
import { readDriverSelection, writeDriverSelection } from "../../src/storage/sqlite-driver-selection.js";
import { nativeTarget } from "../../src/storage/native-artifact.js";
import { NATIVE_COMPAT, nativeAssetName, parseNativeCompat } from "../../src/storage/native-compat.js";

const roots: string[] = [];
function options() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "ce-readiness-")); roots.push(home);
  vi.stubEnv("HOME", home);
  return { root: join(home, "native"), selectionFile: join(home, "selection.json") };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("inspects missing cache offline and reports explicit node selection as incompatible without fallback", () => {
  const opts = options(); const network = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", network);
  expect(inspectNativeReadiness(opts)).toMatchObject({ state: "MISSING", code: "CE_NATIVE_CACHE_MISSING", driver: "rust-native", version: "0.1.0" });
  writeDriverSelection({ driver: "node-sqlite" }, opts.selectionFile);
  expect(inspectNativeReadiness(opts)).toMatchObject({ state: "INCOMPATIBLE", driver: "node-sqlite" });
  expect(network).not.toHaveBeenCalled();
});
it("classifies unsupported platform and malformed selection without leaking content", () => {
  const opts = options();
  expect(inspectNativeReadiness({ ...opts, platform: "win32", arch: "x64" }).state).toBe("UNSUPPORTED_PLATFORM");
  writeFileSync(opts.selectionFile, "secret-token");
  const result = inspectNativeReadiness(opts);
  expect(result.state).toBe("INCOMPATIBLE"); expect(JSON.stringify(result)).not.toContain("secret-token");
});
it("maps only published targets and refuses Windows native", () => {
  expect(nativeTargetName("darwin", "arm64")).toBe("aarch64-apple-darwin");
  expect(nativeTargetName("darwin", "x64")).toBe("x86_64-apple-darwin");
  expect(nativeTargetName("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
  expect(nativeTargetName("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
  expect(nativeTargetName("win32", "x64")).toBeNull();
  expect(nativeTargetName("win32", "arm64")).toBeNull();
  const opts = options();
  const windows = inspectNativeReadiness({ ...opts, platform: "win32", arch: "x64" });
  expect(windows).toMatchObject({ state: "UNSUPPORTED_PLATFORM", code: "CE_NATIVE_TARGET_UNSUPPORTED" });
});
it("refuses arbitrary args and repair without confirmation without downloading", async () => {
  const opts = options(); const network = vi.fn(); vi.stubGlobal("fetch", network);
  for (const command of ["", "status", "verify", "repair", "install 9.0.0", "repair confirm extra"]) await runNativeCommand(command, opts);
  expect(network).not.toHaveBeenCalled();
});
it("latest is discovery only and never changes selection", async () => {
  const opts = options(); writeDriverSelection({ driver: "node-sqlite" }, opts.selectionFile);
  const network = vi.fn(async () => new Response(JSON.stringify({ tag_name: "ce-sqlite-v9.0.0", secret: "hidden" })));
  const text = await runNativeCommand("check-updates", { ...opts, fetchImpl: network });
  expect(text).toContain("0.1.0"); expect(text).toContain("differs"); expect(text).not.toContain("hidden");
  expect(network.mock.calls).toHaveLength(1); expect(readDriverSelection(opts.selectionFile).driver).toBe("node-sqlite");
});
it("wrong hash install preserves existing selection", async () => {
  const opts = options(); writeDriverSelection({ driver: "node-sqlite" }, opts.selectionFile);
  const text = await runNativeCommand("install", { ...opts, fetchImpl: async () => new Response("bad bytes") });
  expect(text).toContain("CE_NATIVE_HASH_MISMATCH"); expect(readDriverSelection(opts.selectionFile).driver).toBe("node-sqlite");
});
it("reports untrusted pins, incompatible versions, and loader initialization failures", () => {
  const opts = options(); const target = nativeTarget();
  const manifest = parseNativeCompat({ ...NATIVE_COMPAT, versions: { "0.1.0": { assets: { [target]: { asset: nativeAssetName("0.1.0", target), sha256: null } } } } });
  expect(inspectNativeReadiness({ ...opts, manifest }).state).toBe("UNTRUSTED");
  writeDriverSelection({ driver: "rust-native", nativeVersion: "9.0.0" }, opts.selectionFile);
  expect(inspectNativeReadiness(opts).state).toBe("INCOMPATIBLE");
  writeDriverSelection({ driver: "rust-native", nativeVersion: "0.1.0" }, opts.selectionFile);
  const bytes = Buffer.from("invalid dlopen payload secret-token");
  const directory = join(opts.root, "ce-sqlite", "0.1.0", target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, nativeAssetName("0.1.0", target)), bytes, { mode: 0o600 });
  const invalidBinaryManifest = parseNativeCompat({ ...manifest, versions: { "0.1.0": { assets: { [target]: { asset: nativeAssetName("0.1.0", target), sha256: createHash("sha256").update(bytes).digest("hex") } } } } });
  const result = inspectNativeReadiness({ ...opts, manifest: invalidBinaryManifest });
  expect(result.state).toBe("INITIALIZATION_FAILED"); expect(JSON.stringify(result)).not.toContain("secret-token");
  expect(inspectNativeReadiness(opts).state).toBe("UNTRUSTED");
});
const fixture = process.env.CE_TEST_NATIVE_MODULE;
it.skipIf(!fixture)("installs the real pinned local fixture before selecting and verifies offline", async () => {
  const opts = options(); const bytes = readFileSync(fixture!);
  const text = await runNativeCommand("install", { ...opts, fetchImpl: async () => new Response(bytes) });
  expect(text).toContain("Restart Pi"); expect(readDriverSelection(opts.selectionFile)).toEqual({ driver: "rust-native", nativeVersion: NATIVE_COMPAT.defaultVersion });
  expect(inspectNativeReadiness(opts)).toMatchObject({ state: "READY", abiVersion: 1, sqliteVersion: expect.any(String) });
  const network = vi.fn(() => { throw new Error("offline"); });
  expect(await runNativeCommand("repair confirm", { ...opts, fetchImpl: network })).toContain("Restart Pi");
  expect(network).not.toHaveBeenCalled();
});
it.skipIf(!fixture)("repairs a corrupted cache only after a verified download and preserves it on failure", async () => {
  const opts = options(); const bytes = readFileSync(fixture!);
  const directory = join(opts.root, "ce-sqlite", "0.1.0", nativeTarget());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, nativeAssetName("0.1.0", nativeTarget()));
  writeFileSync(path, "corrupt", { mode: 0o600 });
  writeDriverSelection({ driver: "node-sqlite" }, opts.selectionFile);
  expect(await runNativeCommand("repair confirm", { ...opts, fetchImpl: async () => new Response("bad") })).toContain("CE_NATIVE_HASH_MISMATCH");
  expect(readFileSync(path, "utf8")).toBe("corrupt");
  expect(readDriverSelection(opts.selectionFile).driver).toBe("node-sqlite");
  expect(await runNativeCommand("repair confirm", { ...opts, fetchImpl: async () => new Response(bytes) })).toContain("Restart Pi");
  expect(readFileSync(path)).toEqual(bytes);
  expect(inspectNativeReadiness(opts).state).toBe("READY");
});
