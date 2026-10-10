import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindSession,
  detachSession,
  readSessionLifecycle,
  reconcileDetach,
} from "../../src/storage/ownership.js";
import { openStore } from "../../src/storage/store.js";
import {
  capabilityFor,
  cleanupFixtures,
  expectRefusal,
  fixture,
  NOW,
  participant,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2C-B: real OS-process crash boundaries for the authorized
 * detach. Each boundary is reached deterministically (the accepted private
 * hook seam, or worker-local instrumentation of the worker's own raw
 * connection for the after-commit boundary), proven by a sanitized marker
 * file, and terminated by the parent's SIGKILL. No sleep-based progress
 * guessing: correctness evidence is marker + durable forensics + fail-closed
 * reconciliation. A committed detach is terminal; an uncommitted one leaves
 * no trace, and only a fresh, fully re-authorized attempt may retry.
 */

type Child = ChildProcessByStdio<null, Readable, Readable>;

const WORKER_WAIT_MS = 20_000;
const PARENT_TIMEOUT_MS = 30_000;
const BUSY_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 90_000;

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const crashScript = fileURLToPath(new URL("./support/detach-crash-worker.mjs", import.meta.url));
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
  readonly resume1: string;
}

/** A store with S1 (the detach target) and S2 bound, and S1's resume
 * capability pre-issued, all before the parent writer closes. */
function world(): World {
  const active = fixture("ce-b3-p2c-b-crash-");
  const participantId = participant(active, "endpoint-detach").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: S1, capability: attach }, { now: () => at(0) });
  bindSession(active.store, { participantId, sessionId: S2, capability: attach }, { now: () => at(0) });
  const resume1 = capabilityFor(active, participantId, "resume", { sessionId: S1 });
  active.store.close();
  return { active, participantId, resume1 };
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
    request: { participantId: w.participantId, sessionId: S1, capability: w.resume1 },
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
  expect(JSON.stringify(evidence)).not.toContain(w.resume1);
  return evidence;
}

describe("B3-P2C-B detach crash boundaries (independent processes)", () => {
  it("crash before commit (after the guarded session update) rolls back completely and reconciles NO_TRACE", async () => {
    const w = world();
    const evidence = await crashAt(w, "before-commit");
    // The boundary was reached inside the owned transaction, after the
    // guarded ATTACHED → DETACHED update: the worker observed its own
    // uncommitted detached row.
    expect(evidence).toMatchObject({ mode: "before-commit", transaction: true, sessions: "2", detached: "1" });

    // Durable forensics on a fresh connection: nothing of the detach exists.
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readSessionLifecycle(reopened, { participantId: w.participantId, sessionId: S1 })).toEqual({
        state: "ATTACHED",
        boundAt: at(0),
      });
      expect(
        reconcileDetach(reopened, { participantId: w.participantId, sessionId: S1, detachedAt: at(31) }),
      ).toMatchObject({ disposition: "NO_TRACE" });
      // The durable effect is absent, so a fresh, fully re-authorized attempt
      // is safe and succeeds — this is the no-blind-retry discipline: the
      // fresh attempt is a new authorization, not a replay.
      detachSession(reopened, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, { now: () => at(40) });
      expect(readSessionLifecycle(reopened, { participantId: w.participantId, sessionId: S1 })).toMatchObject({
        state: "DETACHED",
        detachedAt: at(40),
      });
    } finally {
      reopened.close();
    }
    expect(rowCounts(w.active).session).toBe("2");
  }, TEST_TIMEOUT_MS);

  it("crash after commit persists the terminal detach and reconciles COMMITTED; a retry refuses", async () => {
    const w = world();
    const evidence = await crashAt(w, "after-commit");
    // The marker was written after a successful COMMIT; the worker observed
    // the durable detached row before being killed.
    expect(evidence).toMatchObject({ mode: "after-commit", transaction: false, sessions: "2", detached: "1" });

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readSessionLifecycle(reopened, { participantId: w.participantId, sessionId: S1 })).toEqual({
        state: "DETACHED",
        boundAt: at(0),
        detachedAt: at(31),
      });
      expect(
        reconcileDetach(reopened, { participantId: w.participantId, sessionId: S1, detachedAt: at(31) }),
      ).toMatchObject({ disposition: "COMMITTED" });
      // Terminal: the retry of the same call is NOT an idempotent API
      // response — the capability is lifecycle-dead, so it refuses.
      expectRefusal(
        () => detachSession(reopened, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, { now: () => at(40) }),
        "CAPABILITY_REJECTED",
      );
      expect(readSessionLifecycle(reopened, { participantId: w.participantId, sessionId: S1 })).toMatchObject({
        detachedAt: at(31),
      });
    } finally {
      reopened.close();
    }
  }, TEST_TIMEOUT_MS);
});
