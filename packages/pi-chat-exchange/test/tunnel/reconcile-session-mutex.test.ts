import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireSessionProcessMutex } from "../../src/tunnel/session-process-mutex.js";

/** Fixed script output contract: the offline banner, one fixed success
 *  outcome line, and refusal lines from a closed reason set — nothing else. */
const BANNER = "All Pi/CE processes capable of opening this Store or acquiring this scope, including heartbeat, background launchers, auto-restart and recovery jobs, are stopped and inhibited for the entire inspection, reconciliation, durability check and reinspection window. No business operation, CE read/ACK, detach, takeover or recovery is authorized by this script. Do not resume until a separate authority decision.";
const OUTCOME = "local mutex receipt reconciled; no CE authority or business resumption authorized";
const REFUSAL_LINE = /^session mutex reconciliation refused: [^\n]+; hard stop, no automatic retry or cleanup\n?$/;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture(live = false) {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-reconcile-")); fs.chmodSync(directory, 0o700); dirs.push(directory);
  // Synthetic empty Store file: reconciliation only stats this file, never opens SQLite.
  fs.writeFileSync(join(directory, "store.sqlite"), "", { mode: 0o600 });
  const options = { store: { directory, file: "store.sqlite" }, endpointId: "pi/A", runtimeSessionId: "synthetic-A" };
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireSessionProcessMutex } from ${JSON.stringify(new URL("../../dist/tunnel/session-process-mutex.js", import.meta.url).href)}; const h = acquireSessionProcessMutex(JSON.parse(process.argv[1])); console.log(h.markerPath); process.stdin.resume();`, JSON.stringify(options)], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(r => child.once("exit", () => r()));
  let marker: string | undefined;
  try {
    marker = await new Promise<string>((r, reject) => { child.stdout.once("data", b => r(String(b).trim())); child.once("error", reject); child.once("exit", () => reject(Error("owner exited before ready"))); });
  } finally {
    // A failed readiness handshake must never leak the live owner child.
    if (marker === undefined) { child.kill("SIGKILL"); await exited; }
  }
  if (!live) { child.kill("SIGKILL"); await exited; }
  const bytes = fs.readFileSync(marker!); const owner = JSON.parse(bytes.toString()); const slot = marker!.slice(0, -"/owner.json".length);
  const values: Record<string, string> = {
    "store-dir": directory, "store-file": "store.sqlite", endpoint: options.endpointId, "runtime-session": options.runtimeSessionId, slot: "1",
    "owner-version": String(owner.version), "owner-scope": owner.scope, "owner-pid": String(owner.pid), "owner-birth": owner.birth,
    "owner-process-token": owner.processToken, "owner-handle-token": owner.handleToken, "owner-sha256": createHash("sha256").update(bytes).digest("hex"),
  };
  for (const [name, path] of [["store", join(directory, "store.sqlite")], ["slot", slot], ["owner", marker!]]) {
    const stat = fs.lstatSync(path!); values[`${name}-dev`] = String(stat.dev); values[`${name}-ino`] = String(stat.ino);
  }
  const argsFor = (override: Record<string, string> = {}, extra: string[] = []) => [
    resolve("scripts/reconcile-session-process-mutex.mjs"),
    ...Object.entries({ ...values, ...override }).flatMap(([key, value]) => [`--expect-${key}`, value]),
    "--offline-window-confirmed",
    "--owner-death-evidence",
    "synthetic parent SIGKILL and reap",
    ...extra,
  ];
  const run = (override: Record<string, string> = {}, extra: string[] = []) =>
    spawnSync(process.execPath, argsFor(override, extra), { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  return { directory, options, marker: marker!, slot, bytes, values, argsFor, run, stop: async () => { child.kill("SIGKILL"); await exited; } };
}
it("reconciles killed owner with exact bytes and permits slot 2", async () => {
  const f = await fixture(); const result = f.run(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  // stdout is a closed set: exactly the fixed banner plus the fixed outcome line.
  expect(result.stdout).toBe(`${BANNER}\n${OUTCOME}\n`);
  expect(fs.readFileSync(join(f.slot, "released.json"))).toEqual(f.bytes);
  const next = acquireSessionProcessMutex(f.options); expect(next.markerPath).toContain("/2/owner.json");
  next.closeAdmission(); await next.drain(); next.release({ released: true, detached: true });
});
it("refuses any live PID and leaves slot untouched", async () => {
  const f = await fixture(true); try { const r = f.run(); expect(r.status).toBe(1); expect(r.stderr).toContain("owner PID is live"); expect(fs.readdirSync(f.slot)).toEqual(["owner.json"]); } finally { await f.stop(); }
});
it("refuses each single wrong expectation without filesystem writes", async () => {
  const f = await fixture(); const before = fs.readdirSync(f.directory, { recursive: true });
  for (const [key, value] of Object.entries(f.values)) {
    // Use well-formed but wrong numbers/hashes, not just parse failures.
    const wrong = /^[0-9]+$/.test(value) ? String(Number(value) + 1) : /^[a-f0-9]{64}$/.test(value) ? (value[0] === "a" ? "b" : "a") + value.slice(1) : `${value}-wrong`;
    const r = f.run({ [key]: wrong }); expect(r.status, key).toBe(1);
    // Refusals must be the fixed reason line, never raw errors or derived paths.
    expect(r.stderr, key).toMatch(REFUSAL_LINE); expect(r.stderr, key).not.toContain(f.directory);
    expect(fs.readdirSync(f.directory, { recursive: true }), key).toEqual(before); expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  }
});
it.each(["extra", "released.json", "release-pending.json"])("refuses target inventory containing %s", async name => {
  const f = await fixture(); fs.writeFileSync(join(f.slot, name), f.bytes, { mode: 0o600 }); const r = f.run(); expect(r.status).toBe(1); expect(r.stderr).toContain("slot inventory"); expect(r.stderr).toMatch(REFUSAL_LINE); expect(fs.readdirSync(f.slot).sort()).toEqual(["owner.json", name].sort());
});
it.each(["unknown flag", "duplicate flag", "missing offline window", "missing death evidence", "removed audit flag"])("refuses %s and always prints offline wording", async scenario => {
  const f = await fixture();
  const args = Object.entries(f.values).flatMap(([key, value]) => [`--expect-${key}`, value]);
  if (scenario !== "missing offline window") args.push("--offline-window-confirmed");
  if (scenario !== "missing death evidence") args.push("--owner-death-evidence", "independent synthetic reference");
  if (scenario === "unknown flag") args.push("--unknown");
  if (scenario === "duplicate flag") args.push("--expect-slot", "1");
  if (scenario === "removed audit flag") args.push("--audit-log", join(f.directory, "audit.jsonl"));
  const r = spawnSync(process.execPath, [resolve("scripts/reconcile-session-process-mutex.mjs"), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  expect(r.status).toBe(1); expect(r.stdout).toContain("All Pi/CE processes capable of opening this Store"); expect(r.stderr).toMatch(REFUSAL_LINE); expect(fs.readdirSync(f.slot)).toEqual(["owner.json"]);
});
it("writes no audit artifact under any flag combination", async () => {
  const f = await fixture(); const audit = join(f.directory, "audit.jsonl");
  const r = f.run({}, ["--audit-log", audit]);
  expect(r.status).toBe(1); expect(r.stderr).toContain("invalid or duplicate argument"); expect(r.stderr).toMatch(REFUSAL_LINE);
  expect(fs.existsSync(audit)).toBe(false); expect(fs.readdirSync(f.slot)).toEqual(["owner.json"]);
});
it.each(["symlink owner", "hardlink owner", "public owner", "noncanonical owner", "scope gap", "unknown scope entry"])("refuses unsafe %s without receipt", async scenario => {
  const f = await fixture();
  let flags: Record<string, string> = {};
  if (scenario === "symlink owner") { fs.renameSync(f.marker, join(f.directory, "retained")); fs.symlinkSync(join(f.directory, "retained"), f.marker); }
  if (scenario === "hardlink owner") fs.linkSync(f.marker, join(f.directory, "retained"));
  if (scenario === "public owner") fs.chmodSync(f.marker, 0o644);
  if (scenario === "noncanonical owner") { const bytes = Buffer.concat([f.bytes, Buffer.from("\n")]); fs.writeFileSync(f.marker, bytes); flags = { "owner-sha256": createHash("sha256").update(bytes).digest("hex") }; }
  if (scenario === "scope gap") fs.mkdirSync(join(f.slot, "..", "3"), { mode: 0o700 });
  if (scenario === "unknown scope entry") fs.writeFileSync(join(f.slot, "..", "unknown"), "", { mode: 0o600 });
  expect(f.run(flags).status).toBe(1); expect(fs.existsSync(join(f.slot, "released.json"))).toBe(false);
});
it("validates contiguous canonical historical owner and identical receipt pairs", async () => {
  const f = await fixture(); const nextSlot = join(f.slot, "..", "2"); fs.mkdirSync(nextSlot, { mode: 0o700 });
  fs.writeFileSync(join(f.slot, "released.json"), f.bytes, { mode: 0o600 });
  fs.writeFileSync(join(nextSlot, "owner.json"), f.bytes, { mode: 0o600 });
  const s = fs.statSync(nextSlot); const o = fs.statSync(join(nextSlot, "owner.json"));
  const flags = { slot: "2", "slot-dev": String(s.dev), "slot-ino": String(s.ino), "owner-dev": String(o.dev), "owner-ino": String(o.ino) };
  fs.writeFileSync(join(f.slot, "released.json"), "bad"); expect(f.run(flags).status).toBe(1); expect(fs.readdirSync(nextSlot)).toEqual(["owner.json"]);
  fs.writeFileSync(join(f.slot, "released.json"), f.bytes);
  const r = f.run(flags); expect(r.stderr).toBe(""); expect(r.status).toBe(0); expect(r.stdout).toBe(`${BANNER}\n${OUTCOME}\n`); expect(fs.readFileSync(join(nextSlot, "released.json"))).toEqual(f.bytes);
});
it("concurrent reconciliation of the same dead owner publishes exactly one receipt", async () => {
  const f = await fixture();
  const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  const children = [0, 1].map(() => spawn(process.execPath, f.argsFor(), { env, stdio: ["ignore", "pipe", "pipe"] }));
  const results = await Promise.all(children.map(child => new Promise<{ status: number; stderr: string }>(resolve => {
    let stderr = ""; child.stderr?.on("data", chunk => { stderr += chunk; }); child.once("exit", code => resolve({ status: code ?? -1, stderr }));
  })));
  expect(results.map(r => r.status).sort()).toEqual([0, 1]);
  for (const r of results) if (r.status !== 0) {
    // The losing run must still print only its fixed refusal line.
    expect(r.stderr).toMatch(REFUSAL_LINE); expect(r.stderr).not.toContain(f.directory);
  }
  expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  expect(fs.readdirSync(f.slot).filter(name => name === "released.json")).toHaveLength(1);
  expect(fs.readFileSync(join(f.slot, "released.json"))).toEqual(f.bytes);
  // A leftover pending artifact (loser wrote after the winner's rename) must
  // still carry exactly the original owner bytes.
  const pending = join(f.slot, "release-pending.json");
  if (fs.existsSync(pending)) expect(fs.readFileSync(pending)).toEqual(f.bytes);
});
/** Round-2 deterministic failure injection: the script exports its publication
 *  step with injectable fs operations (defaults = the real fs; there is no
 *  environmental fault variable), so pre-rename failures and rename outcomes
 *  can be forced without any change to the CLI behavior. */
const PUBLICATION_UNCERTAIN = "publication uncertain; manual review required; no retry";
type PublicationScript = {
  deriveReconciliationTarget(args: Map<string, string>): unknown;
  validateReconciliationTarget(target: unknown, expectedInventory: string[]): unknown;
  publishReleaseReceipt(target: unknown, first: unknown, fsOperations?: Record<string, unknown>): void;
};
async function publicationFixture() {
  const f = await fixture();
  const script = await import(new URL("../../scripts/reconcile-session-process-mutex.mjs", import.meta.url).href) as PublicationScript;
  const args = new Map(Object.entries(f.values).map(([name, value]) => [`--expect-${name}`, value]));
  const target = script.deriveReconciliationTarget(args);
  const first = script.validateReconciliationTarget(target, ["owner.json"]);
  return { f, script, target, first };
}
it("injected pre-rename fsync failure retains the exact pending artifact and refuses as publication uncertain", async () => {
  const { f, script, target, first } = await publicationFixture();
  const pending = join(f.slot, "release-pending.json");
  const receipt = join(f.slot, "released.json");
  let error: Error | undefined;
  try { script.publishReleaseReceipt(target, first, { fsync: () => { throw new Error("injected pre-rename fsync failure"); } }); }
  catch (e) { error = e as Error; }
  expect(error?.message).toBe(PUBLICATION_UNCERTAIN);
  // The pending artifact is retained with the EXACT original owner bytes.
  expect(fs.readFileSync(pending)).toEqual(f.bytes);
  expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  expect(fs.existsSync(receipt)).toBe(false);
  // Nothing was published: acquisition of the scope must still refuse.
  expect(() => acquireSessionProcessMutex(f.options)).toThrow("CE_SESSION_PROCESS_MUTEX_REFUSED");
  // A second reconciliation run refuses on the retained pending (unsafe
  // target inventory) and never cleans it up.
  const second = f.run();
  expect(second.status).toBe(1);
  expect(second.stderr).toContain("slot inventory");
  expect(second.stderr).toMatch(REFUSAL_LINE);
  expect(fs.readdirSync(f.slot).sort()).toEqual(["owner.json", "release-pending.json"]);
});
it("injected rename throw with the exact committed receipt is committed-success", async () => {
  const { f, script, target, first } = await publicationFixture();
  const pending = join(f.slot, "release-pending.json");
  const receipt = join(f.slot, "released.json");
  const renameCommittedButThrows = (from: string, to: string) => {
    fs.renameSync(from, to); // the rename commits the exact prepared inode...
    throw new Error("injected rename failure"); // ...but reports failure
  };
  expect(() => script.publishReleaseReceipt(target, first, { rename: renameCommittedButThrows })).not.toThrow();
  expect(fs.readFileSync(receipt)).toEqual(f.bytes);
  expect(fs.existsSync(pending)).toBe(false);
  expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  // Committed success is reusable: the next acquisition takes slot 2.
  const next = acquireSessionProcessMutex(f.options);
  expect(next.markerPath).toContain("/2/owner.json");
  next.closeAdmission(); await next.drain(); next.release({ released: true, detached: true });
});
it("injected rename throw with non-matching committed bytes hard-stops as publication uncertain", async () => {
  const { f, script, target, first } = await publicationFixture();
  const receipt = join(f.slot, "released.json");
  const renameTampered = (from: string, to: string) => {
    fs.renameSync(from, to);
    fs.writeFileSync(to, "non-matching committed bytes", { mode: 0o600 });
    throw new Error("injected rename failure");
  };
  let error: Error | undefined;
  try { script.publishReleaseReceipt(target, first, { rename: renameTampered }); }
  catch (e) { error = e as Error; }
  expect(error?.message).toBe(PUBLICATION_UNCERTAIN);
  // The unverified receipt stays in place for manual review — no retry, no
  // cleanup — and must not unlock acquisition.
  expect(fs.readFileSync(receipt).toString()).toBe("non-matching committed bytes");
  expect(() => acquireSessionProcessMutex(f.options)).toThrow("CE_SESSION_PROCESS_MUTEX_REFUSED");
});
it("refuses without artifacts when the slot directory becomes unwritable", async () => {
  // Mode 0500 fails the PRE-publication privateDir() validation (a slot must
  // be exactly 0700), so this refusal happens before the publication step
  // starts and covers only the no-artifact pre-publication path.
  // Publication-phase retention (pending kept with exact bytes, fixed
  // publication-uncertain refusal, no retry) is covered by the injected-
  // failure tests above.
  const f = await fixture();
  fs.chmodSync(f.slot, 0o500);
  try {
    const r = f.run();
    expect(r.status).toBe(1); expect(r.stderr).toMatch(REFUSAL_LINE); expect(r.stderr).not.toContain(f.directory);
    expect(fs.readdirSync(f.slot)).toEqual(["owner.json"]);
    expect(fs.existsSync(join(f.slot, "released.json"))).toBe(false);
    expect(fs.existsSync(join(f.slot, "release-pending.json"))).toBe(false);
  } finally {
    fs.chmodSync(f.slot, 0o700); // restore private permissions for recursive cleanup
  }
});
