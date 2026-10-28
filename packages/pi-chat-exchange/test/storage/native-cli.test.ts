import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { NATIVE_COMPAT } from "../../src/storage/native-compat.js";
import { nativeTarget } from "../../src/storage/native-artifact.js";

const cli = fileURLToPath(new URL("../../dist/bin/ce-native.js", import.meta.url));
const native = process.env.CE_TEST_NATIVE_MODULE ?? fileURLToPath(new URL("../../native/ce-sqlite/target/release/ce-sqlite.node", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "ce-native-cli-"));
  roots.push(home);
  const manifest = structuredClone(NATIVE_COMPAT);
  const target = nativeTarget();
  const entry = manifest.versions["0.1.0"]!.assets[target]!;
  (entry as { sha256: string }).sha256 = createHash("sha256").update(readFileSync(native)).digest("hex");
  const path = join(home, ".config/pi-chat-exchange/native/ce-sqlite/0.1.0", target, entry.asset);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  copyFileSync(native, path); chmodSync(path, 0o600);
  writeFileSync(join(home, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000,
  });
  return { home, run };
}
it("select persists the verified default version and absolute manifest; status is ready", () => {
  const { home, run } = fixture();
  const selected = run("select", "--driver", "rust-native", "--manifest", "manifest.json");
  expect(selected.status, selected.stderr).toBe(0);
  const saved = JSON.parse(readFileSync(join(home, ".config/pi-chat-exchange/sqlite-driver.json"), "utf8"));
  expect(saved.nativeVersion).toBe("0.1.0");
  expect(saved.manifestFile).toBe(join(home, "manifest.json"));
  const status = run("status");
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ driver: "rust-native", ready: true });
});
it("select refuses a non-runtime cache root before writing selection", () => {
  const { run } = fixture();
  const result = run("select", "--driver", "rust-native", "--root", "/different/cache");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CE_NATIVE_SELECTION_ROOT_INVALID");
});
it.each([null, {}, { versions: null }])("rejects malformed manifest without a TypeError: %j", value => {
  const { home, run } = fixture();
  writeFileSync(join(home, "bad.json"), JSON.stringify(value));
  const result = run("prepare", "--manifest", "bad.json");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("CE_NATIVE_MANIFEST_INVALID");
  expect(result.stderr).not.toContain("TypeError");
});
