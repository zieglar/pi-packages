import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnership, bindSession, readCurrentOwnership, readFencingHighWater } from "../../src/storage/ownership.js";
import { openStore } from "../../src/storage/store.js";
import { capabilityFor, cleanupFixtures, fixture, NOW, participant, rowCounts, type Fixture } from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2A independent-process acquisition races. Workers are real OS
 * processes sharing only the canonical database path; each performs exactly
 * one acquisition after an explicit barrier. BEGIN IMMEDIATE is attempted
 * once and never retried, so a loser is either OWNERSHIP_HELD (it serialized
 * after the winner) or STORAGE_TRANSACTION_BUSY (it timed out waiting).
 */

type Child = ChildProcessByStdio<null, Readable, Readable>;

const WORKER_WAIT_MS = 20_000;
const PARENT_TIMEOUT_MS = 30_000;
const BUSY_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 90_000;
const WORKERS = 4;

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/ownership-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const ownershipUrl = new URL("../../src/storage/ownership.ts", import.meta.url).href;

const SESSIONS = [
  "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0",
  "ses_01ARZ3NDEKTSV4RRFFQ69G5FA1",
  "ses_01ARZ3NDEKTSV4RRFFQ69G5FA2",
  "ses_01ARZ3NDEKTSV4RRFFQ69G5FA3",
];
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const children: Child[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  cleanupFixtures();
});

interface Report {
  readonly status: number | null;
  readonly stderr: string;
  readonly result: Record<string, unknown>;
}

function launch(active: Fixture, tag: string, request: Record<string, unknown>, now: string) {
  const readyPath = join(active.root, `${tag}.ready`);
  const releasePath = join(active.root, `${tag}.release`);
  const config = {
    tag, storeUrl, ownershipUrl, now, request,
    directory: active.directory, filename: active.filename,
    busyTimeoutMs: BUSY_TIMEOUT_MS, waitMs: WORKER_WAIT_MS, readyPath, releasePath,
  };
  const child = spawn(process.execPath, ["--import", register, workerScript, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  let announce: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { announce = resolve; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("\"event\":\"ready\"")) announce();
  });
  const done = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker ${tag} exceeded the bounded parent timeout`));
    }, PARENT_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      const results = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "result");
      resolve({ status, stderr, result: results[results.length - 1] ?? {} });
    });
  });
  return { ready, done, release: () => writeFileSync(releasePath, "") };
}

function prepared(): { active: Fixture; participantId: string; attach: string } {
  const active = fixture("ce-b3-p2a-race-");
  const participantId = participant(active, "endpoint-race").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  for (const sessionId of SESSIONS) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
  }
  return { active, participantId, attach };
}

async function race(active: Fixture, participantId: string, attach: string, now: string) {
  // The parent writer is closed before any worker opens the store.
  active.store.close();
  const workers = SESSIONS.slice(0, WORKERS).map((sessionId, index) =>
    launch(active, `w${index}`, { participantId, sessionId, capability: attach }, now),
  );
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.release();
  const reports = await Promise.all(workers.map((worker) => worker.done));
  for (const report of reports) {
    expect({ status: report.status, stderr: report.stderr, stage: report.result.stage })
      .toEqual({ status: 0, stderr: "", stage: "acquire" });
    // Sanitized output only.
    expect(JSON.stringify(report.result)).not.toContain(attach);
  }
  return reports.map((report) => report.result);
}

describe("B3-P2A concurrent acquisition (independent processes)", () => {
  it("admits exactly one Owner with the first fencing token", async () => {
    const { active, participantId, attach } = prepared();
    const results = await race(active, participantId, attach, at(0));
    const winners = results.filter((result) => result.disposition === "ACQUIRED");
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ fencingToken: 1, expiresAt: at(120) });
    for (const loser of results.filter((result) => result.disposition !== "ACQUIRED")) {
      expect(["OWNERSHIP_HELD", "STORAGE_TRANSACTION_BUSY"]).toContain(loser.code);
      expect(loser.outcome).toBe("ROLLED_BACK");
    }
    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      expect(readCurrentOwnership(reopened, participantId)).toMatchObject({ sessionId: winners[0]!.sessionId, fencingToken: 1 });
      expect(readFencingHighWater(reopened, participantId)).toBe(1);
    } finally {
      reopened.close();
    }
    expect(rowCounts(active)).toMatchObject({ ownership: "1", fencing: "1" });
  }, TEST_TIMEOUT_MS);

  it("admits exactly one superseding Owner after expiry with exactly the next token", async () => {
    const { active, participantId, attach } = prepared();
    acquireOwnership(active.store, { participantId, sessionId: SESSIONS[0], capability: attach }, { now: () => at(0) });
    const results = await race(active, participantId, attach, at(500));
    const winners = results.filter((result) => result.disposition === "ACQUIRED");
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ fencingToken: 2 });
    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      expect(readFencingHighWater(reopened, participantId)).toBe(2);
      expect(readCurrentOwnership(reopened, participantId)).toMatchObject({ sessionId: winners[0]!.sessionId, fencingToken: 2 });
    } finally {
      reopened.close();
    }
  }, TEST_TIMEOUT_MS);
});
