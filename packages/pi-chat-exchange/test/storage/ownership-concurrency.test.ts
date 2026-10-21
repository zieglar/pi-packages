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
 * CE-0002-B3-P2A/R1 independent-process ownership races. Workers are real OS
 * processes sharing only the canonical database path; each performs exactly
 * one operation after an explicit barrier. BEGIN IMMEDIATE is attempted once
 * and never retried, so a loser is either a typed refusal (it serialized after
 * the winner) or STORAGE_TRANSACTION_BUSY (it timed out waiting).
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

function launch(active: Fixture, tag: string, request: Record<string, unknown>, now: string, op: "acquire" | "renew" | "takeover" = "acquire") {
  const readyPath = join(active.root, `${tag}.ready`);
  const releasePath = join(active.root, `${tag}.release`);
  const config = {
    tag, storeUrl, ownershipUrl, now, request, op,
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

function prepared(): { active: Fixture; participantId: string; attach: string; resume1: string } {
  const active = fixture("ce-b3-p2a-race-");
  const participantId = participant(active, "endpoint-race").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  for (const sessionId of SESSIONS) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
  }
  // R1: resume authority is Session-bound; the renewal worker presents a
  // capability durably bound to the current Owner's Session.
  const resume1 = capabilityFor(active, participantId, "resume", { sessionId: SESSIONS[0]! });
  return { active, participantId, attach, resume1 };
}

async function race(active: Fixture, participantId: string, attach: string, now: string) {
  // The parent writer is closed before any worker opens the store.
  active.store.close();
  const workers = SESSIONS.slice(0, WORKERS).map((sessionId, index) =>
    launch(active, `w${index}`, { participantId, sessionId, capability: attach }, now, "acquire"),
  );
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.release();
  const reports = await Promise.all(workers.map((worker) => worker.done));
  for (const report of reports) {
    expect({ status: report.status, stderr: report.stderr, stage: report.result.stage })
      .toEqual({ status: 0, stderr: "", stage: "op" });
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

  it("serializes a renewal against an acquisition near expiry: the live Owner stands, takeover stays inactive", async () => {
    const { active, participantId, attach, resume1 } = prepared();
    const lease = acquireOwnership(active.store, { participantId, sessionId: SESSIONS[0], capability: attach }, { now: () => at(0) });
    expect(lease).toMatchObject({ fencingToken: 1, expiresAt: at(120), leaseStartedAt: at(0) });
    // Race: the Owner renews at t=60 (within its term) while a challenger tries
    // to acquire at t=500 (past expiry). R1: an existing ownership row — even an
    // expired one — is never replaced through attach; whichever serializes
    // first, the acquisition is refused and exactly one mutation lands.
    active.store.close();
    const go1 = launch(active, "renew", { participantId, sessionId: SESSIONS[0], fencingToken: 1, capability: resume1 }, at(60), "renew");
    const go2 = launch(active, "acquire", { participantId, sessionId: SESSIONS[1], capability: attach }, at(500), "acquire");
    const workers = [go1, go2];
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.release();
    const reports = await Promise.all(workers.map((worker) => worker.done));
    for (const report of reports) {
      expect({ status: report.status, stderr: report.stderr, stage: report.result.stage })
        .toEqual({ status: 0, stderr: "", stage: "op" });
      expect(JSON.stringify(report.result)).not.toContain(resume1);
    }
    const [renewed, acquisition] = reports.map((report) => report.result);
    expect(renewed).toMatchObject({ disposition: "RENEWED", fencingToken: 1, expiresAt: at(180) });
    // The challenger loses either way: BUSY while the winner holds the lock, or
    // a typed refusal once serialized. An expired row requires takeover.
    expect(["OWNERSHIP_TAKEOVER_REQUIRED", "OWNERSHIP_HELD", "STORAGE_TRANSACTION_BUSY"]).toContain(acquisition?.code);
    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      // Fencing never advanced: the refused acquisition allocated nothing.
      expect(readFencingHighWater(reopened, participantId)).toBe(1);
      expect(readCurrentOwnership(reopened, participantId)).toMatchObject({
        sessionId: SESSIONS[0],
        fencingToken: 1,
        expiresAt: at(180),
        leaseStartedAt: at(60),
      });
    } finally {
      reopened.close();
    }
    expect(rowCounts(active)).toMatchObject({ ownership: "1", fencing: "1" });
  }, TEST_TIMEOUT_MS);
});

describe("B3-P2B concurrent takeover (independent processes)", () => {
  it("admits exactly one takeover winner over an expired Owner, with the next fencing token", async () => {
    const { active, participantId, attach } = prepared();
    acquireOwnership(
      active.store,
      { participantId, sessionId: SESSIONS[0], capability: attach, leaseTtlSeconds: 30 },
      { now: () => at(0) },
    ); // S0, token 1, term [0, 30) — expired by race time
    // Each challenger holds a takeover capability durably bound to its own
    // Session, issued before the parent writer closes.
    const takeoverCaps = SESSIONS.slice(0, WORKERS).map(
      (sessionId) => capabilityFor(active, participantId, "takeover", { sessionId }),
    );
    active.store.close();
    const workers = SESSIONS.slice(0, WORKERS).map((sessionId, index) =>
      launch(active, `t${index}`, { participantId, sessionId, capability: takeoverCaps[index] }, at(200), "takeover"),
    );
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.release();
    const reports = await Promise.all(workers.map((worker) => worker.done));
    for (const report of reports) {
      expect({ status: report.status, stderr: report.stderr, stage: report.result.stage })
        .toEqual({ status: 0, stderr: "", stage: "op" });
      for (const cap of takeoverCaps) expect(JSON.stringify(report.result)).not.toContain(cap);
    }
    const results = reports.map((report) => report.result);
    const winners = results.filter((result) => result.disposition === "TAKEN_OVER");
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ fencingToken: 2, expiresAt: at(320) });
    for (const loser of results.filter((result) => result.disposition !== "TAKEN_OVER")) {
      // The winner's fresh lease is live, so a serialized loser faces a live
      // Owner; a contender that never got the lock is BUSY.
      expect(["OWNERSHIP_HELD", "STORAGE_TRANSACTION_BUSY"]).toContain(loser.code);
      expect(loser.outcome).toBe("ROLLED_BACK");
    }
    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      // Exactly one replacement, exactly one fencing allocation.
      expect(readCurrentOwnership(reopened, participantId)).toMatchObject({
        sessionId: winners[0]!.sessionId,
        fencingToken: 2,
        leaseStartedAt: at(200),
      });
      expect(readFencingHighWater(reopened, participantId)).toBe(2);
    } finally {
      reopened.close();
    }
    expect(rowCounts(active)).toMatchObject({ ownership: "1", fencing: "1" });
  }, TEST_TIMEOUT_MS);

  it("a takeover never wins a race against a live lease: renewal stands, takeover refuses", async () => {
    const { active, participantId, attach, resume1 } = prepared();
    acquireOwnership(active.store, { participantId, sessionId: SESSIONS[0], capability: attach }, { now: () => at(0) });
    // Live Owner S0 (term [0, 120)). Race at t=60: renewal extends the live
    // lease; the takeover must refuse at ANY serialization, because the lease
    // is live at every instant of the race.
    const takeoverCap = capabilityFor(active, participantId, "takeover", { sessionId: SESSIONS[1]! });
    active.store.close();
    const renewal = launch(active, "renew", { participantId, sessionId: SESSIONS[0], fencingToken: 1, capability: resume1 }, at(60), "renew");
    const challenger = launch(active, "take", { participantId, sessionId: SESSIONS[1], capability: takeoverCap }, at(60), "takeover");
    const workers = [renewal, challenger];
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.release();
    const reports = await Promise.all(workers.map((worker) => worker.done));
    for (const report of reports) {
      expect({ status: report.status, stderr: report.stderr, stage: report.result.stage })
        .toEqual({ status: 0, stderr: "", stage: "op" });
      expect(JSON.stringify(report.result)).not.toContain(takeoverCap);
      expect(JSON.stringify(report.result)).not.toContain(resume1);
    }
    const [renewed, takeover] = reports.map((report) => report.result);
    // The takeover NEVER displaces a live Owner.
    expect(takeover?.disposition).not.toBe("TAKEN_OVER");
    expect(takeover?.code).toBe("OWNERSHIP_HELD");
    // The renewal either lands (serialized first) or times out BUSY.
    expect(["RENEWED", undefined]).toContain(renewed?.disposition);
    if (renewed?.disposition === undefined) expect(renewed?.code).toBe("STORAGE_TRANSACTION_BUSY");
    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      const expectedExpiry = renewed?.disposition === "RENEWED" ? at(180) : at(120);
      expect(readCurrentOwnership(reopened, participantId)).toMatchObject({
        sessionId: SESSIONS[0],
        fencingToken: 1,
        expiresAt: expectedExpiry,
      });
      expect(readFencingHighWater(reopened, participantId)).toBe(1);
    } finally {
      reopened.close();
    }
    expect(rowCounts(active)).toMatchObject({ ownership: "1", fencing: "1" });
  }, TEST_TIMEOUT_MS);
});
