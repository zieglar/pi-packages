import fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as mutex from "../../src/tunnel/session-process-mutex.js";
import { initializeStore } from "../../src/storage/store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function options() {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-mutex-")); dirs.push(directory);
  initializeStore({ directory, filename: "ce-store.sqlite" }).close();
  return { store: { directory, file: "ce-store.sqlite" }, endpointId: "pi/A", runtimeSessionId: "trusted-runtime-A" };
}
const cleaned = { released: true, detached: true };
it("exports the process mutex", () => { expect(mutex.acquireSessionProcessMutex).toBeTypeOf("function"); });
it("refuses duplicate same-PID handles; permits distinct endpoints and orderly reacquisition", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
  const b = mutex.acquireSessionProcessMutex({ ...o, endpointId: "pi/B", runtimeSessionId: "trusted-B" });
  b.closeAdmission(); await b.drain(); b.release(cleaned);
  expect(() => a.release(cleaned)).toThrow(); // admission still open
  a.closeAdmission(); await a.drain(); a.release(cleaned);
  const replacement = mutex.acquireSessionProcessMutex(o);
  replacement.assertOwnership();
  replacement.closeAdmission(); await replacement.drain(); replacement.release(cleaned);
});
it("only explicitly transfers a closed drained handle, with a fresh handle token", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  expect(() => a.explicitTransfer()).toThrow();
  let finish!: () => void;
  const running = a.run(() => new Promise<void>((resolvePromise) => { finish = resolvePromise; }));
  a.closeAdmission();
  expect(() => a.explicitTransfer()).toThrow();
  let drained = false; const drain = a.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  finish(); await running; await drain;
  const next = a.explicitTransfer();
  expect(next.handleToken).not.toBe(a.handleToken);
  expect(() => a.assertOwnership()).toThrow();
  next.assertOwnership(); next.closeAdmission(); await next.drain(); next.release(cleaned);
});
it("drains PromiseLike operations rather than treating non-native promises as synchronous", async () => {
  const a = mutex.acquireSessionProcessMutex(options());
  let finish!: () => void;
  const pending = new Promise<void>((resolvePromise) => { finish = resolvePromise; });
  const running = a.run(() => ({ then: pending.then.bind(pending) }));
  a.closeAdmission(); let drained = false;
  const drain = a.drain().then(() => { drained = true; });
  await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
  finish(); await running; await drain; a.release(cleaned);
});
it("reload transfer never publishes a release window to a competing handle", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  a.closeAdmission(); await a.drain();
  const rename = fs.renameSync; let contender: mutex.SessionProcessMutex | undefined;
  const seam = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    try { contender = mutex.acquireSessionProcessMutex(o); } catch { /* expected exclusion */ }
  });
  let next: mutex.SessionProcessMutex | undefined;
  try { next = a.explicitTransfer(); } catch { /* asserted below */ } finally { seam.mockRestore(); }
  try { expect(contender).toBeUndefined(); expect(next).toBeDefined(); }
  finally { for (const h of [contender, next]) if (h) { h.closeAdmission(); await h.drain(); h.release(cleaned); } }
});
it.each([undefined, "reused-process-birth"])("fails closed on unknown/replaced self identity %s", (changed) => {
  let birth: string | undefined = "synthetic-original";
  const a = mutex.acquireSessionProcessMutex({ ...options(), inspectSelf: () => birth });
  birth = changed;
  expect(() => a.assertOwnership()).toThrow();
  birth = "synthetic-original";
  expect(() => a.assertOwnership()).toThrow(); // latched
});
it("refuses unknown identity before creating a marker", () => {
  const o = options(); expect(() => mutex.acquireSessionProcessMutex({ ...o, inspectSelf: () => undefined })).toThrow();
});
it("detects exact marker loss and retains a permanent fail-closed latch", () => {
  const a = mutex.acquireSessionProcessMutex(options());
  const bytes = fs.readFileSync(a.markerPath);
  fs.writeFileSync(a.markerPath, "partial");
  expect(() => a.assertOwnership()).toThrow();
  fs.writeFileSync(a.markerPath, bytes);
  expect(() => a.assertOwnership()).toThrow();
  a.closeAdmission(); expect(() => a.release(cleaned)).toThrow();
  expect(fs.existsSync(a.markerPath)).toBe(true);
});
it("detects Store inode replacement and exact-byte owner marker replacement", () => {
  for (const target of ["store", "marker"] as const) {
    const o = options(); const a = mutex.acquireSessionProcessMutex(o);
    const path = target === "store" ? join(o.store.directory, o.store.file) : a.markerPath;
    fs.renameSync(path, `${path}.retained`);
    fs.copyFileSync(`${path}.retained`, path);
    fs.chmodSync(path, 0o600);
    expect(() => a.assertOwnership()).toThrow();
  }
});
it("retains marker on uncertain CE cleanup and blocks acquisition", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  a.closeAdmission(); await a.drain();
  expect(() => a.release({ released: false, detached: false })).toThrow();
  expect(() => a.explicitTransfer()).toThrow();
  expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
  expect(fs.existsSync(a.markerPath)).toBe(true);
});
it("retains an uncertain mutex release without publishing a reusable receipt", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  a.closeAdmission(); await a.drain();
  const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw Error("synthetic uncertain fsync"); });
  try { expect(() => a.release(cleaned)).toThrow(); } finally { sync.mockRestore(); }
  expect(() => a.explicitTransfer()).toThrow();
  expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
  expect(fs.existsSync(a.markerPath)).toBe(true);
});
it("reconciles an exact committed release when rename reports an error after effect", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  a.closeAdmission(); await a.drain();
  const rename = fs.renameSync;
  const seam = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { rename(from, to); throw Error("after effect"); });
  try { a.release(cleaned); } finally { seam.mockRestore(); }
  const b = mutex.acquireSessionProcessMutex(o); b.closeAdmission(); await b.drain(); b.release(cleaned);
});
it("latches an uncommitted release activation failure without deleting the owner", async () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  a.closeAdmission(); await a.drain();
  const seam = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Error("before effect"); });
  try { expect(() => a.release(cleaned)).toThrow(); } finally { seam.mockRestore(); }
  expect(() => a.explicitTransfer()).toThrow(); expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
  expect(fs.existsSync(a.markerPath)).toBe(true);
});
it("rejects symlink and hardlink Store aliases and unsafe parent permissions", () => {
  const o = options(); const alias = `${o.store.directory}-alias`; dirs.push(alias);
  fs.symlinkSync(o.store.directory, alias);
  expect(() => mutex.acquireSessionProcessMutex({ ...o, store: { ...o.store, directory: alias } })).toThrow();
  fs.writeFileSync(join(o.store.directory, o.store.file), "", { mode: 0o600 });
  fs.linkSync(join(o.store.directory, o.store.file), join(o.store.directory, "alias.sqlite"));
  expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
  fs.chmodSync(o.store.directory, 0o777);
  expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
});
it("does not overwrite partial markers or guess dead-owner reclamation", () => {
  const o = options(); const a = mutex.acquireSessionProcessMutex(o);
  fs.writeFileSync(a.markerPath, "{");
  expect(() => mutex.acquireSessionProcessMutex(o)).toThrow();
  expect(fs.readFileSync(a.markerPath, "utf8")).toBe("{");
});

function worker(o: ReturnType<typeof options>) {
  const child = spawn(process.execPath, [resolve("test/tunnel/support/session-process-mutex-worker.mjs"), JSON.stringify(o)], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = "";
  child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
  const exited = new Promise<number | null>((resolvePromise) => child.once("exit", resolvePromise));
  const ready = async () => {
    for (let i = 0; i < 500; i++) { if (out.includes("ACQUIRED") || out.includes("REFUSED")) return out.trim(); if (child.exitCode !== null) throw Error(err); await new Promise((r) => setTimeout(r, 10)); }
    throw Error("worker timeout");
  };
  return { child, ready, exited };
}
it("actual separate Node processes with Store/Host exclude same Session but allow independent B", { timeout: 20_000 }, async () => {
  const o = options(); const a = worker(o); let b: ReturnType<typeof worker> | undefined; let duplicate: ReturnType<typeof worker> | undefined;
  try {
    expect(await a.ready()).toBe("ACQUIRED");
    duplicate = worker(o); expect(await duplicate.ready()).toBe("REFUSED"); expect(await duplicate.exited).toBe(2);
    b = worker({ ...o, endpointId: "pi/B", runtimeSessionId: "trusted-B" }); expect(await b.ready()).toBe("ACQUIRED");
    a.child.stdin.end(); b.child.stdin.end(); expect(await a.exited).toBe(0); expect(await b.exited).toBe(0);
    const next = worker(o); try { expect(await next.ready()).toBe("ACQUIRED"); next.child.stdin.end(); expect(await next.exited).toBe(0); } finally { next.child.kill("SIGKILL"); }
  } finally { a.child.kill("SIGKILL"); b?.child.kill("SIGKILL"); duplicate?.child.kill("SIGKILL"); }
});
it("actual crashed process marker is conservatively retained, never age-reclaimed", { timeout: 20_000 }, async () => {
  const o = options(); const a = worker(o);
  try {
    expect(await a.ready()).toBe("ACQUIRED"); a.child.kill("SIGKILL"); await a.exited;
    const next = worker(o); try { expect(await next.ready()).toBe("REFUSED"); expect(await next.exited).toBe(2); } finally { next.child.kill("SIGKILL"); }
  } finally { a.child.kill("SIGKILL"); }
});
