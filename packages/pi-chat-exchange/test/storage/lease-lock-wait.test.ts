import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireOwnership,
  bindSession,
  readCurrentOwnership,
  readFencingHighWater,
  takeoverOwnership,
} from "../../src/storage/ownership.js";
import {
  capabilityFor,
  cleanupFixtures,
  fixture,
  participant,
  privileged,
  reader,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2B-R1: transaction-time clock sampling under real SQLite
 * writer-lock contention. Every scenario runs against a real file-backed v3
 * store, a real OS worker process calling the operation under the REAL wall
 * clock (no injected clock seam), and a real writer lock held by an
 * in-process privileged connection. Coordination uses observable events only:
 * the lock is provably held (the blocker's guarded write succeeded), the
 * worker's initiation is provably observed (its marker file carries the real
 * initiation instant), and waits are deadline waits against a known durable
 * expiry — never sleep-only assertions. This is the regression pin for the
 * independently reproduced stale pre-lock clock defect (CE-0002-B3-P2B
 * MAJOR-1): an operation must evaluate authorization and lease state at the
 * serialization instant, after BEGIN IMMEDIATE has acquired the writer lock.
 */

type Child = ChildProcessByStdio<null, Readable, Readable>;

const WORKER_WAIT_MS = 20_000;
const PARENT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/lock-wait-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const ownershipUrl = new URL("../../src/storage/ownership.ts", import.meta.url).href;

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const children: Child[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  cleanupFixtures();
});

interface World {
  readonly active: Fixture;
  readonly participantId: string;
  readonly attach: string;
  readonly resume1: string;
  readonly resume2: string;
  readonly takeover2: string;
}

function world(): World {
  const active = fixture("ce-b3-p2b-r1-lock-");
  const participantId = participant(active, "endpoint-lock").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: S1, capability: attach });
  bindSession(active.store, { participantId, sessionId: S2, capability: attach });
  return {
    active,
    participantId,
    attach,
    resume1: capabilityFor(active, participantId, "resume", { sessionId: S1 }),
    resume2: capabilityFor(active, participantId, "resume", { sessionId: S2 }),
    takeover2: capabilityFor(active, participantId, "takeover", { sessionId: S2 }),
  };
}

function tamper(active: Fixture, sql: string, ...values: (string | number | null)[]): void {
  const db = privileged(active);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

/** Acquires under the real wall clock (minimum TTL 30 s), then overrides only
 * the expiry to a near real instant: a structurally valid short lease whose
 * term start is the real acquisition instant. Returns the durable expiry. */
function acquireShortLease(w: World, ttlMs = 8_000): string {
  acquireOwnership(w.active.store, {
    participantId: w.participantId,
    sessionId: S1,
    capability: w.attach,
    leaseTtlSeconds: 30,
  });
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  tamper(w.active, "UPDATE participant_ownership SET expires_at = ?", expiresAt);
  return expiresAt;
}

/** Durable fingerprint of ownership and fencing: zero-write is proven. */
function durableState(active: Fixture): string {
  const view = reader(active);
  try {
    return JSON.stringify({
      counts: rowCounts(active),
      ownership: view.prepare("SELECT * FROM participant_ownership ORDER BY participant_id").all(),
      fencing: view
        .prepare(
          "SELECT participant_id, CAST(fencing_token AS TEXT) AS token, private_revision FROM participant_fencing_high_water ORDER BY participant_id",
        )
        .all(),
    });
  } finally {
    view.close();
  }
}

/** Holds the real SQLite writer lock. Acquisition is observable: the guarded
 * no-op write only succeeds while this connection holds the lock. */
function holdWriteLock(active: Fixture, participantId: string) {
  const blocker = privileged(active);
  blocker.exec("BEGIN IMMEDIATE");
  blocker
    .prepare("UPDATE participant_fencing_high_water SET private_revision = private_revision WHERE participant_id = ?")
    .run(participantId);
  return blocker;
}

/** Deadline wait against a known instant — never an unconditional sleep. */
async function until(epochMs: number): Promise<void> {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

interface RunningWorker {
  readonly done: Promise<Record<string, unknown>>;
  /** Real initiation instant observed from the worker's marker file. */
  readonly initiatedAt: string;
}

async function runWorker(
  w: World,
  tag: string,
  op: "renew" | "takeover" | "detach",
  request: Record<string, unknown>,
): Promise<RunningWorker> {
  const startedPath = join(w.active.root, `${tag}.started`);
  const config = {
    tag,
    storeUrl,
    ownershipUrl,
    op,
    request,
    directory: w.active.directory,
    filename: w.active.filename,
    busyTimeoutMs: 5_000,
    startedPath,
  };
  const child = spawn(process.execPath, ["--import", register, workerScript, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker ${tag} exceeded the bounded parent timeout; stderr=${stderr}`));
    }, PARENT_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      const results = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "result");
      const result = results[results.length - 1] ?? {};
      expect({ status, stderr, stage: result.stage }).toEqual({ status: 0, stderr: "", stage: "op" });
      resolve(result);
    });
  });
  // Bounded wait for observable initiation.
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (!existsSync(startedPath)) {
    if (child.exitCode !== null || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(startedPath), `worker ${tag} never initiated; stderr=${stderr}`).toBe(true);
  // The marker is published by rename (atomic), so a read can never observe
  // a partially written file; this assertion pins that contract.
  const initiatedAt = readFileSync(startedPath, "utf8");
  expect(Number.isFinite(Date.parse(initiatedAt)), `worker ${tag} published an incomplete marker; content=${JSON.stringify(initiatedAt)}`).toBe(true);
  return { done, initiatedAt };
}

describe("B3-P2B-R1 transaction-time clock under real lock contention", () => {
  it("A: a renewal initiated before expiry but serialized after expiry refuses LEASE_EXPIRED", async () => {
    const w = world();
    const expiry = acquireShortLease(w);
    const expiresAtMs = Date.parse(expiry);
    const before = durableState(w.active);
    const blocker = holdWriteLock(w.active, w.participantId);
    try {
      await until(expiresAtMs - 2_500);
      const worker = await runWorker(w, "a", "renew", {
        participantId: w.participantId,
        sessionId: S1,
        fencingToken: 1,
        capability: w.resume1,
        leaseTtlSeconds: 30,
      });
      // Observable: initiation preceded the durable expiry; the operation then
      // serialized after it because the writer lock was held across the boundary.
      expect(Date.parse(worker.initiatedAt)).toBeLessThan(expiresAtMs);
      await until(expiresAtMs + 750);
      blocker.exec("ROLLBACK");
      const result = await worker.done;
      expect(result).toMatchObject({ code: "LEASE_EXPIRED", outcome: "ROLLED_BACK", retryable: false });
      expect(JSON.stringify(result)).not.toContain(w.resume1);
    } finally {
      blocker.close();
    }
    // H + I: zero durable writes; the fencing high-water never moved.
    expect(durableState(w.active)).toBe(before);
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
    // The lease genuinely expired: a takeover at real time is now eligible.
    const lease = takeoverOwnership(w.active.store, {
      participantId: w.participantId,
      sessionId: S2,
      capability: w.takeover2,
    });
    expect(lease).toMatchObject({ sessionId: S2, fencingToken: 2 });
  }, TEST_TIMEOUT_MS);

  it("B: a renewal serialized before expiry succeeds, with the new term derived from the serialization instant", async () => {
    const w = world();
    const expiry = acquireShortLease(w);
    const expiresAtMs = Date.parse(expiry);
    const originalStart = readCurrentOwnership(w.active.store, w.participantId)!.leaseStartedAt!;
    const blocker = holdWriteLock(w.active, w.participantId);
    let result: Record<string, unknown>;
    try {
      await until(expiresAtMs - 3_000);
      const worker = await runWorker(w, "b", "renew", {
        participantId: w.participantId,
        sessionId: S1,
        fencingToken: 1,
        capability: w.resume1,
        leaseTtlSeconds: 30,
      });
      expect(Date.parse(worker.initiatedAt)).toBeLessThan(expiresAtMs);
      // Release while the lease is still live: serialization precedes expiry.
      await until(expiresAtMs - 1_000);
      blocker.exec("ROLLBACK");
      result = await worker.done;
      expect(result).toMatchObject({ disposition: "RENEWED", sessionId: S1, fencingToken: 1 });
      // The persisted term start is the post-lock serialization instant: at or
      // after the observed initiation, never the stale pre-lock sample and
      // never the original acquisition start.
      expect(Date.parse(result.leaseStartedAt as string)).toBeGreaterThanOrEqual(Date.parse(worker.initiatedAt));
      expect(Date.parse(result.leaseStartedAt as string)).toBeGreaterThan(Date.parse(originalStart));
      expect(Date.parse(result.expiresAt as string) - Date.parse(result.leaseStartedAt as string)).toBe(30_000);
      expect(JSON.stringify(result)).not.toContain(w.resume1);
    } finally {
      blocker.close();
    }
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      sessionId: S1,
      fencingToken: 1,
      leaseStartedAt: result!.leaseStartedAt,
    });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("C: a takeover initiated before expiry but serialized after expiry succeeds with the next fencing token", async () => {
    const w = world();
    const expiry = acquireShortLease(w);
    const expiresAtMs = Date.parse(expiry);
    const blocker = holdWriteLock(w.active, w.participantId);
    let result: Record<string, unknown>;
    try {
      await until(expiresAtMs - 2_500);
      const worker = await runWorker(w, "c", "takeover", {
        participantId: w.participantId,
        sessionId: S2,
        capability: w.takeover2,
      });
      expect(Date.parse(worker.initiatedAt)).toBeLessThan(expiresAtMs);
      await until(expiresAtMs + 750);
      blocker.exec("ROLLBACK");
      result = await worker.done;
      // Eligibility is evaluated at the serialization instant: the lease is
      // expired there, so exactly one replacement lands with exactly high-water + 1.
      expect(result).toMatchObject({ disposition: "TAKEN_OVER", sessionId: S2, fencingToken: 2 });
      expect(Date.parse(result.leaseStartedAt as string)).toBeGreaterThanOrEqual(expiresAtMs - 50);
      expect(JSON.stringify(result)).not.toContain(w.takeover2);
    } finally {
      blocker.close();
    }
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      sessionId: S2,
      fencingToken: 2,
      leaseStartedAt: result!.leaseStartedAt,
    });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
    expect(rowCounts(w.active)).toMatchObject({ ownership: "1", fencing: "1" });
  }, TEST_TIMEOUT_MS);

  it("D: a takeover serialized before expiry cannot displace the still-live Owner", async () => {
    const w = world();
    const expiry = acquireShortLease(w);
    const expiresAtMs = Date.parse(expiry);
    const before = durableState(w.active);
    const blocker = holdWriteLock(w.active, w.participantId);
    try {
      await until(expiresAtMs - 2_500);
      const worker = await runWorker(w, "d", "takeover", {
        participantId: w.participantId,
        sessionId: S2,
        capability: w.takeover2,
      });
      expect(Date.parse(worker.initiatedAt)).toBeLessThan(expiresAtMs);
      await until(expiresAtMs - 1_000);
      blocker.exec("ROLLBACK");
      const result = await worker.done;
      expect(result).toMatchObject({ code: "OWNERSHIP_HELD", outcome: "ROLLED_BACK" });
      expect(JSON.stringify(result)).not.toContain(w.takeover2);
    } finally {
      blocker.close();
    }
    // H + I: zero durable writes; the live Owner and the high-water stand.
    expect(durableState(w.active)).toBe(before);
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("E: a takeover capability that expires during the lock wait refuses CAPABILITY_REJECTED", async () => {
    const w = world();
    acquireOwnership(w.active.store, {
      participantId: w.participantId,
      sessionId: S1,
      capability: w.attach,
      leaseTtlSeconds: 30,
    });
    // A legacy (NULL-start) row is takeover-eligible at every instant, so this
    // scenario needs no lease wait: only the capability clock is exercised.
    tamper(w.active, "UPDATE participant_ownership SET lease_started_at = NULL");
    const capabilityExpiry = new Date(Date.now() + 6_000).toISOString();
    const capabilityExpiryMs = Date.parse(capabilityExpiry);
    const shortCap = capabilityFor(w.active, w.participantId, "takeover", {
      sessionId: S2,
      expiresAt: capabilityExpiry,
    });
    const before = durableState(w.active);
    const blocker = holdWriteLock(w.active, w.participantId);
    try {
      await until(capabilityExpiryMs - 2_500);
      const worker = await runWorker(w, "e", "takeover", {
        participantId: w.participantId,
        sessionId: S2,
        capability: shortCap,
      });
      // Observable: the capability was still valid at initiation...
      expect(Date.parse(worker.initiatedAt)).toBeLessThan(capabilityExpiryMs);
      // ...and expired while the operation waited for the writer lock.
      await until(capabilityExpiryMs + 1_000);
      blocker.exec("ROLLBACK");
      const result = await worker.done;
      expect(result).toMatchObject({ code: "CAPABILITY_REJECTED", outcome: "ROLLED_BACK", retryable: false });
      expect(JSON.stringify(result)).not.toContain(shortCap);
    } finally {
      blocker.close();
    }
    // H + I: zero durable writes; the legacy row and the high-water stand.
    expect(durableState(w.active)).toBe(before);
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
    // Control: the refusal was the expired capability, not eligibility — a
    // valid takeover capability takes over the same legacy row immediately.
    const lease = takeoverOwnership(w.active.store, {
      participantId: w.participantId,
      sessionId: S2,
      capability: w.takeover2,
    });
    expect(lease).toMatchObject({ sessionId: S2, fencingToken: 2 });
  }, TEST_TIMEOUT_MS);

  it("F: a detach initiated before lease expiry but serialized after it still refuses SESSION_IS_CURRENT_OWNER", async () => {
    const w = world();
    const expiry = acquireShortLease(w);
    const expiresAtMs = Date.parse(expiry);
    const before = durableState(w.active);
    const blocker = holdWriteLock(w.active, w.participantId);
    try {
      await until(expiresAtMs - 2_500);
      const worker = await runWorker(w, "f", "detach", {
        participantId: w.participantId,
        sessionId: S1,
        capability: w.resume1,
      });
      expect(Date.parse(worker.initiatedAt)).toBeLessThan(expiresAtMs);
      await until(expiresAtMs + 750);
      blocker.exec("ROLLBACK");
      const result = await worker.done;
      // The current Owner is not detachable in ANY lease state (Q5): even
      // serialized after expiry, the refusal stands and nothing is written.
      expect(result).toMatchObject({ code: "SESSION_IS_CURRENT_OWNER", outcome: "ROLLED_BACK", retryable: false });
      expect(JSON.stringify(result)).not.toContain(w.resume1);
    } finally {
      blocker.close();
    }
    // Zero durable writes; the expired Owner row and high-water stand.
    expect(durableState(w.active)).toBe(before);
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("G: a detach of a non-Owner Session serialized after the lock wait commits at the serialization instant", async () => {
    const w = world();
    acquireShortLease(w); // S1 owns; S2 is a plain bound non-Owner Session.
    const blocker = holdWriteLock(w.active, w.participantId);
    let result: Record<string, unknown>;
    try {
      const worker = await runWorker(w, "g", "detach", {
        participantId: w.participantId,
        sessionId: S2,
        capability: w.resume2,
      });
      blocker.exec("ROLLBACK");
      result = await worker.done;
      expect(result).toMatchObject({ disposition: "DETACHED", sessionId: S2 });
      // The persisted detach instant is the post-lock serialization instant:
      // at or after the observed initiation, never a stale pre-lock sample.
      expect(Date.parse(result.detachedAt as string)).toBeGreaterThanOrEqual(Date.parse(worker.initiatedAt));
      expect(JSON.stringify(result)).not.toContain(w.resume2);
    } finally {
      blocker.close();
    }
    // Ownership and fencing are untouched by the detach; the Session row is
    // DETACHED and never deleted.
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
    expect(rowCounts(w.active)).toMatchObject({ ownership: "1", fencing: "1", session: "2" });
    expect(
      reader(w.active)
        .prepare("SELECT detached_at IS NOT NULL AND private_revision = 2 AS d FROM participant_session WHERE session_id = ?")
        .get(S2),
    ).toEqual({ d: 1 });
  }, TEST_TIMEOUT_MS);
});
