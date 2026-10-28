import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeIdentity } from "../../src/storage/runtime.js";

const nodeA = process.env.CE_TEST_NODE_A;
const nodeB = process.env.CE_TEST_NODE_B;
const nodeC = process.env.CE_TEST_NODE_C;
const nodeD = process.env.CE_TEST_NODE_D;
const nodeE = process.env.CE_TEST_NODE_E;
const nodeF = process.env.CE_TEST_NODE_F;
// Actual binary versions, never caller-supplied labels.
const runtimes = new Map([["A", nodeA], ["B", nodeB], ["C", nodeC], ["D", nodeD], ["E", nodeE], ["F", nodeF]]
  .filter((entry): entry is [string, string] => entry[1] !== undefined)
  .map(([name, executable]) => {
    const result = spawnSync(executable, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000 });
    const version = result.stdout.trim();
    if (result.status !== 0 || !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`CE_TEST_NODE_${name} is not a runnable Node executable`);
    return [name, { executable, version }] as const;
  }));
const roots: string[] = [];
const children: ChildProcess[] = [];
const loader = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const worker = fileURLToPath(new URL("./support/runtime-cross-version-worker.mjs", import.meta.url));
const env = { PATH: "/usr/bin:/bin", ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }) };
interface Report {
  event: string; identity: RuntimeIdentity; executable: string;
  storeUuid: string; schemaVersion: number; applicationId: number; userVersion: number;
  ledgerHash: string; trustRootHash: string; schemaHash: string;
  integrity: unknown[]; foreignKeys: unknown[]; policy: Record<string, unknown>;
  disposition: string; messageId: string;
  messages: { message_id: string; idempotency_key: string }[];
  audits: { subject_id: string }[]; records: { entity_id: string }[];
  baselineReplayId: string;
  durableRows: { key: string; messageId: string; messageHash: string; auditHash: string; recordHash: string; payloadReadHash: string }[];
}
function args(directory: string, key: string, operation = "write", initialize = false) {
  return ["--import", loader, worker, JSON.stringify({ directory, key, operation, initialize })];
}
function run(node: string, directory: string, key: string, initialize = false) {
  const result = spawnSync(node, args(directory, key, "write", initialize), { env, encoding: "utf8", timeout: 15_000, maxBuffer: 32_768 });
  const reports = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Report);
  return { status: result.status, signal: result.signal, reports };
}
function proof(report: Report) {
  return { storeUuid: report.storeUuid, schemaVersion: report.schemaVersion, applicationId: report.applicationId,
    userVersion: report.userVersion, ledgerHash: report.ledgerHash, trustRootHash: report.trustRootHash, schemaHash: report.schemaHash };
}
function healthy(report: Report, count: number) {
  expect(report.event).toBe("result");
  const expectedDriver = process.env.CE_TEST_EXPECT_DRIVER;
  if (expectedDriver !== undefined) expect(report.identity.driver).toBe(expectedDriver);
  expect(report.integrity).toEqual([{ integrity_check: "ok" }]);
  expect(report.foreignKeys).toEqual([]);
  expect(report.policy).toEqual({ wal: "wal", synchronous: 2, foreignKeys: 1, trustedSchema: 0 });
  expect(report.messages).toHaveLength(count);
  expect(report.audits.map((row) => row.subject_id).sort()).toEqual(report.messages.map((row) => row.message_id).sort());
  expect(report.records.map((row) => row.entity_id).sort()).toEqual(report.messages.map((row) => row.message_id).sort());
}
const BASELINE_BYTES = [1, 2, 3, 4];
const BASELINE_PAYLOAD_HASH = createHash("sha256").update(JSON.stringify(BASELINE_BYTES)).digest("hex");

function unchangedBaseline(initial: Report, later: Report) {
  const baseline = initial.durableRows.find((row) => row.key === "baseline");
  expect(baseline).toBeDefined();
  expect(baseline!.payloadReadHash).toBe(BASELINE_PAYLOAD_HASH);
  expect(later.durableRows.find((row) => row.key === "baseline")).toEqual(baseline);
  expect(later.baselineReplayId).toBe(baseline!.messageId);
}
async function boundary(node: string, directory: string, operation: string) {
  const child = spawn(node, args(directory, "boundary", operation), { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("qualification boundary timeout")), 10_000);
    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      try {
        const event = JSON.parse(stdout.split("\n")[0]!);
        expect(event).toEqual({ event: "boundary", transaction: operation === "crash-write" });
        resolve();
      } catch (error) { reject(error); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("qualification worker exited before boundary")); });
  });
  return { child, done };
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await done;
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Explicit binary paths are qualification inputs, never production runtime overrides.
describe.skipIf(runtimes.size < 2)("real multi-runtime CE Store persistence matrix", () => {
  const names = [...runtimes.keys()];
  const pairs = names.flatMap((left) => names.map((right) => [left, right] as const));
  for (const [left, right] of pairs) {
    const node = (name: string) => runtimes.get(name)!.executable;
    const version = (name: string) => runtimes.get(name)!.version;
    it(`${left}→${right}: close/reopen, writes and stable identity/ledger/trust root`, () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-runtime-pair-")); roots.push(root);
      const directory = join(root, "store");
      const first = run(node(left), directory, "baseline", true);
      expect(first.status).toBe(0);
      const initial = first.reports[0]!; healthy(initial, 1);
      expect(initial.identity.nodeVersion).toBe(version(left));
      const second = run(node(right), directory, "peer"); expect(second.status).toBe(0);
      const peer = second.reports[0]!; healthy(peer, 2);
      expect(peer.identity.nodeVersion).toBe(version(right));
      expect(proof(peer)).toEqual(proof(initial));
      unchangedBaseline(initial, peer);
      const reopened = run(node(left), directory, "peer"); expect(reopened.status).toBe(0);
      healthy(reopened.reports[0]!, 2);
      expect(reopened.reports[0]!.disposition).toBe("REPLAYED");
      expect(reopened.reports[0]!.messageId).toBe(peer.messageId);
      expect(proof(reopened.reports[0]!)).toEqual(proof(initial));
      unchangedBaseline(initial, reopened.reports[0]!);
      for (const field of ["messageHash", "auditHash", "recordHash", "payloadReadHash"] as const) {
        const changed = structuredClone(peer);
        changed.durableRows.find((row) => row.key === "baseline")![field] = "mutated-evidence";
        expect(() => unchangedBaseline(initial, changed)).toThrow();
      }
    });
    for (const operation of ["crash-write", "commit-write"]) {
      it(`${left}→${right}: ${operation} SIGKILL, lock release and fresh-handle reconciliation`, { timeout: 30_000 }, async () => {
        const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-runtime-crash-")); roots.push(root);
        const directory = join(root, "store");
        const first = run(node(left), directory, "baseline", true); expect(first.status).toBe(0);
        const held = await boundary(node(left), directory, operation);
        if (operation === "crash-write") {
          const blocked = run(node(right), directory, "contender");
          expect(blocked.status).toBe(1);
          expect(blocked.reports[0]).toMatchObject({ event: "error", outcome: "ROLLED_BACK" });
        }
        expect(held.child.kill("SIGKILL")).toBe(true);
        expect(await held.done).toEqual({ code: null, signal: "SIGKILL" });
        const recovered = run(node(right), directory, "boundary"); expect(recovered.status).toBe(0);
        const report = recovered.reports[0]!; healthy(report, 2);
        expect(report.disposition).toBe(operation === "crash-write" ? "CREATED" : "REPLAYED");
        expect(proof(report)).toEqual(proof(first.reports[0]!));
        unchangedBaseline(first.reports[0]!, report);
        const replay = run(node(left), directory, "boundary"); expect(replay.status).toBe(0);
        healthy(replay.reports[0]!, 2);
        expect(replay.reports[0]!.messageId).toBe(report.messageId);
        expect(replay.reports[0]!.disposition).toBe("REPLAYED");
        unchangedBaseline(first.reports[0]!, replay.reports[0]!);
      });
    }
  }
});
