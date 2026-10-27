import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireOwnership,
  bindSession,
  readCurrentOwnership,
  readFencingHighWater,
  reconcileTakeover,
} from "../../src/storage/ownership.js";
import { openStore } from "../../src/storage/store.js";
import {
  capabilityFor,
  cleanupFixtures,
  fixture,
  NOW,
  participant,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2B: real OS-process crash boundaries for durable takeover. Each
 * boundary is reached deterministically (the accepted private hook seam, or
 * worker-local instrumentation of the worker's own raw connection for the
 * after-commit boundary), proven by a sanitized marker file, and terminated by
 * the parent's SIGKILL. No sleep-based progress guessing: correctness evidence
 * is marker + durable forensics + fail-closed reconciliation.
 */

type Child = ChildProcessByStdio<null, Readable, Readable>;

const WORKER_WAIT_MS = 20_000;
const PARENT_TIMEOUT_MS = 30_000;
const BUSY_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 90_000;

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const crashScript = fileURLToPath(new URL("./support/takeover-crash-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const ownershipUrl = new URL("../../src/storage/ownership.ts", import.meta.url).href;

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const children: Child[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  cleanupFixtures();
});

interface World {
  readonly active: Fixture;
  readonly participantId: string;
  readonly takeoverCap: string;
}

/** An expired Owner S1 (token 1, term [0, 30)) and a takeover capability bound
 * to the challenger Session S2, all issued before the parent writer closes. */
function expiredWorld(): World {
  const active = fixture("ce-b3-p2b-crash-");
  const participantId = participant(active, "endpoint-owner").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: S1, capability: attach }, { now: () => at(0) });
  bindSession(active.store, { participantId, sessionId: S2, capability: attach }, { now: () => at(0) });
  acquireOwnership(
    active.store,
    { participantId, sessionId: S1, capability: attach, leaseTtlSeconds: 30 },
    { now: () => at(0) },
  );
  const takeoverCap = capabilityFor(active, participantId, "takeover", { sessionId: S2 });
  active.store.close();
  return { active, participantId, takeoverCap };
}

async function crashAt(w: World, mode: "before-commit" | "after-commit") {
  const markerPath = join(w.active.root, `${mode}.marker`);
  const evidencePath = join(w.active.root, `${mode}.evidence`);
  const config = {
    mode,
    storeUrl,
    ownershipUrl,
    directory: w.active.directory,
    filename: w.active.filename,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    now: at(31),
    participantId: w.participantId,
    request: { participantId: w.participantId, sessionId: S2, capability: w.takeoverCap },
    markerPath,
    evidencePath,
  };
  const child = spawn(process.execPath, ["--import", register, crashScript, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  // Wait for the boundary marker file: exact-mode proof, no timing guesses.
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (!existsSync(markerPath)) {
    if (child.exitCode !== null) break;
    if (Date.now() > deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  expect(existsSync(markerPath), `worker never reached the ${mode} boundary; stdout=${stdout} stderr=${stderr}`).toBe(true);
  child.kill("SIGKILL");
  const status = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("crashed worker did not exit")), PARENT_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  expect(status).toBeNull(); // SIGKILL, not a clean exit
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
  // The marker content is exactly the mode: a stale marker from another mode
  // can never satisfy this boundary.
  expect(readFileSync(markerPath, "utf8")).toBe(mode);
  expect(JSON.stringify(evidence)).not.toContain(w.takeoverCap);
  return evidence;
}

describe("B3-P2B takeover crash boundaries (independent processes)", () => {
  it("crash before commit (after the ownership write) rolls back completely and reconciles NO_TRACE", async () => {
    const w = expiredWorld();
    const evidence = await crashAt(w, "before-commit");
    // The boundary was reached inside the owned transaction, after the
    // ownership UPDATE: the worker observed its own uncommitted token 2.
    expect(evidence).toMatchObject({ mode: "before-commit", transaction: true, ownership: "1", ownerToken: "2" });

    // Durable forensics on a fresh connection: nothing of the takeover exists.
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readCurrentOwnership(reopened, w.participantId)).toMatchObject({
        sessionId: S1,
        fencingToken: 1,
        expiresAt: at(30),
        leaseStartedAt: at(0),
      });
      expect(readFencingHighWater(reopened, w.participantId)).toBe(1);
      expect(
        reconcileTakeover(reopened, {
          participantId: w.participantId,
          sessionId: S2,
          leaseStartedAt: at(31),
          expiresAt: at(151),
        }),
      ).toMatchObject({ disposition: "NO_TRACE" });
    } finally {
      reopened.close();
    }
    expect(rowCounts(w.active)).toMatchObject({ ownership: "1", fencing: "1" });
  }, TEST_TIMEOUT_MS);

  it("crash after commit persists the takeover and reconciles COMMITTED", async () => {
    const w = expiredWorld();
    const evidence = await crashAt(w, "after-commit");
    // The marker was written after a successful COMMIT; the worker observed the
    // durable new Owner before being killed.
    expect(evidence).toMatchObject({ mode: "after-commit", transaction: false, ownership: "1", ownerToken: "2" });

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readCurrentOwnership(reopened, w.participantId)).toMatchObject({
        sessionId: S2,
        fencingToken: 2,
        leaseStartedAt: at(31),
        expiresAt: at(151),
      });
      expect(readFencingHighWater(reopened, w.participantId)).toBe(2);
      expect(
        reconcileTakeover(reopened, {
          participantId: w.participantId,
          sessionId: S2,
          leaseStartedAt: at(31),
          expiresAt: at(151),
          fencingToken: 2,
        }),
      ).toMatchObject({ disposition: "COMMITTED" });
    } finally {
      reopened.close();
    }
  }, TEST_TIMEOUT_MS);
});
