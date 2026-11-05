import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectNativeReadiness, runNativeCommand, runNativeCommandOutcome } from "../../src/runtime/native-readiness.js";
import { NATIVE_COMPAT } from "../../src/storage/native-compat.js";
import { readDriverSelection, writeDriverSelection } from "../../src/storage/sqlite-driver-selection.js";

const homes: string[] = [];
function options() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "ce-native-outcome-")); homes.push(home);
  vi.stubEnv("HOME", home);
  return { root: join(home, "native"), selectionFile: join(home, "selection.json"),
    fetchImpl: vi.fn(async (): Promise<Response> => { throw new Error("private network failure\n    at hidden-stack"); }) };
}
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it.each(["", "status", "verify"])("classifies %j as ok with unchanged JSON", async command => {
  const opts = options();
  const outcome = await runNativeCommandOutcome(command, opts);
  expect(outcome).toEqual({ kind: "ok", message: JSON.stringify(inspectNativeReadiness(opts), null, 2) });
  expect(JSON.parse(outcome.message)).toMatchObject({ state: "MISSING" });
  expect(await runNativeCommand(command, opts)).toBe(outcome.message);
  expect(opts.fetchImpl).not.toHaveBeenCalled();
});
it.each(["unknown", "repair"])("classifies %j as usage without fetching", async command => {
  const opts = options();
  expect(await runNativeCommandOutcome(command, opts)).toEqual({ kind: "usage", message: "Usage: /ce-native [status|install|verify|repair confirm|check-updates]. Repair requires explicit repair confirm." });
  expect(opts.fetchImpl).not.toHaveBeenCalled();
});
it("classifies successful release discovery as ok", async () => {
  const opts = options();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: `ce-sqlite-v${NATIVE_COMPAT.defaultVersion}` })));
  expect(await runNativeCommandOutcome("check-updates", { ...opts, fetchImpl })).toEqual({ kind: "ok", message: `Current trusted Native version: ${NATIVE_COMPAT.defaultVersion}. Release discovery matches the trusted version. No driver was installed or selected.` });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("classifies discovery exceptions as failed without exposing exception text or stack", async () => {
  const opts = options();
  const outcome = await runNativeCommandOutcome("check-updates", opts);
  expect(outcome).toEqual({ kind: "failed", message: "Native command failed (CE_NATIVE_INITIALIZATION_FAILED). Current selection was not changed." });
  expect(outcome.message).not.toMatch(/private network failure|hidden-stack|\n/);
  expect(opts.fetchImpl).toHaveBeenCalledTimes(1);
});
it.each(["install", "repair confirm"])("classifies %s artifact preparation failure and preserves selection", async command => {
  const opts = options();
  writeDriverSelection({ driver: "node-sqlite" }, opts.selectionFile);
  const fetchImpl = vi.fn(async () => new Response("bad bytes"));
  expect(await runNativeCommandOutcome(command, { ...opts, fetchImpl })).toEqual({ kind: "failed", message: "Native command failed (CE_NATIVE_HASH_MISMATCH). Current selection was not changed." });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(readDriverSelection(opts.selectionFile)).toEqual({ driver: "node-sqlite" });
});
