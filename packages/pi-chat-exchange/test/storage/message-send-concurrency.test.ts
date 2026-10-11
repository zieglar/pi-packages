import { spawn, type ChildProcessByStdio } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireOwnership, bindSession } from "../../src/storage/ownership.js";
import { joinExchange } from "../../src/storage/participant.js";
import {
  capabilityFor,
  cleanupFixtures,
  exchange,
  fixture,
  NOW,
  participant,
  reader,
  type Fixture,
} from "./support/participant-fixture.js";

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 90_000;
const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/message-send-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const messagingUrl = new URL("../../src/storage/messaging.ts", import.meta.url).href;
const ownershipUrl = new URL("../../src/storage/ownership.ts", import.meta.url).href;

interface Prepared {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly participantId: string;
  readonly send: string;
  readonly resume: string;
  readonly takeover: string;
}

interface WorkerReport {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly lines: readonly Record<string, unknown>[];
  readonly result: Record<string, unknown>;
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly ready: Promise<void>;
  readonly done: Promise<WorkerReport>;
  readonly releasePath: string;
}

const children: ChildProcessByStdio<null, Readable, Readable>[] = [];

function at(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString();
}

function prepared(): Prepared {
  const active = fixture("ce-b3-p3a-concurrency-");
  const exchangeId = exchange(active);
  const participantId = participant(active, "sender").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  for (const sessionId of [S1, S2]) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
  }
  acquireOwnership(
    active.store,
    { participantId, sessionId: S1, capability: attach, leaseTtlSeconds: 30 },
    { now: () => NOW },
  );
  const join = capabilityFor(active, participantId, "join");
  joinExchange(
    active.store,
    { exchangeId, participantId, capability: join, idempotencyKey: "join-sender" },
    { now: () => NOW },
  );
  const result = {
    active,
    exchangeId,
    participantId,
    send: capabilityFor(active, participantId, "send", { sessionId: S1 }),
    resume: capabilityFor(active, participantId, "resume", { sessionId: S1 }),
    takeover: capabilityFor(active, participantId, "takeover", { sessionId: S2 }),
  };
  active.store.close();
  return result;
}

function sendRequest(p: Prepared, key = "shared") {
  return {
    participantId: p.participantId,
    sessionId: S1,
    fencingToken: 1,
    capability: p.send,
    message: {
      exchangeId: p.exchangeId,
      from: { adapter: "adapter-a", endpointId: "sender" },
      to: { adapter: "adapter-a", endpointId: "recipient" },
      payload: [1, 2, 3],
      idempotencyKey: key,
    },
  };
}

function launch(p: Prepared, tag: string, operation: "send" | "release" | "takeover", request: object, now: string): Launched {
  const readyPath = `${p.active.root}/${tag}.ready`;
  const releasePath = `${p.active.root}/${tag}.release`;
  const config = {
    tag,
    operation,
    request,
    now,
    directory: p.active.directory,
    filename: p.active.filename,
    busyTimeoutMs: 5_000,
    waitMs: WAIT_MS,
    readyPath,
    releasePath,
    storeUrl,
    messagingUrl,
    ownershipUrl,
  };
  const child = spawn(process.execPath, ["--import", register, workerScript, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  const lines: Record<string, unknown>[] = [];
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const index = stdout.indexOf("\n");
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (line !== "") {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        lines.push(parsed);
        if (parsed.event === "ready") readyResolve();
      }
    }
  });
  const exited = new Promise<WorkerReport>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const results = lines.filter((line) => line.event === "result");
      resolve({ status, signal, stderr, lines, result: results.at(-1) ?? {} });
    });
  });
  const done = Promise.race([
    exited,
    new Promise<WorkerReport>((_resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`worker ${tag} timed out`));
      }, 30_000);
      void exited.finally(() => clearTimeout(timer));
    }),
  ]);
  return { child, ready, done, releasePath };
}

async function race(workers: readonly Launched[]): Promise<WorkerReport[]> {
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) writeFileSync(worker.releasePath, "", { flag: "wx", mode: 0o600 });
  const reports = await Promise.all(workers.map((worker) => worker.done));
  for (const report of reports) {
    expect({ status: report.status, signal: report.signal, stderr: report.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: "",
    });
  }
  return reports;
}

function durable(p: Prepared) {
  const view = reader(p.active);
  try {
    return {
      messages: Number(view.prepare("SELECT count(*) AS n FROM message WHERE exchange_id=?").get(p.exchangeId)!.n),
      created: Number(view.prepare("SELECT count(*) AS n FROM audit_event WHERE exchange_id=? AND kind='message_created'").get(p.exchangeId)!.n),
      cursor: Number(view.prepare("SELECT count(*) AS n FROM delivery_cursor").get()!.n),
      ownership: view
        .prepare("SELECT session_id, fencing_token FROM participant_ownership WHERE participant_id=?")
        .get(p.participantId),
      integrity: view.prepare("PRAGMA integrity_check").get(),
      foreignKeys: view.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    view.close();
  }
}

function assertNoSecrets(reports: readonly WorkerReport[], p: Prepared): void {
  const output = JSON.stringify(reports.flatMap((report) => report.lines)) + reports.map((report) => report.stderr).join("");
  for (const secret of [p.send, p.resume, p.takeover, "sender", "recipient", "payload_body", "SELECT", "INSERT"]) {
    expect(output).not.toContain(secret);
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  cleanupFixtures();
});

it("serializes two independent-process authorized sends with one durable same-key Message", async () => {
  const p = prepared();
  const reports = await race([
    launch(p, "send-a", "send", sendRequest(p), at(10)),
    launch(p, "send-b", "send", sendRequest(p), at(10)),
  ]);
  const outcomes = reports.map((report) => report.result.disposition ?? report.result.code).sort();
  expect([["CREATED", "REPLAYED"], ["CREATED", "STORAGE_TRANSACTION_BUSY"]]).toContainEqual(outcomes);
  const state = durable(p);
  expect(state).toMatchObject({ messages: 1, created: 1, cursor: 0, integrity: { integrity_check: "ok" }, foreignKeys: [] });
  assertNoSecrets(reports, p);
}, TEST_TIMEOUT_MS);

it("serializes authorized send against release so no send commits after authority is lost", async () => {
  const p = prepared();
  const reports = await race([
    launch(p, "send", "send", sendRequest(p, "release-race"), at(10)),
    launch(
      p,
      "release-owner",
      "release",
      { participantId: p.participantId, sessionId: S1, fencingToken: 1, capability: p.resume },
      at(10),
    ),
  ]);
  const send = reports.find((report) => report.result.stage === "send")!.result;
  const release = reports.find((report) => report.result.stage === "release-owner")!.result;
  expect(release).toMatchObject({ released: true, fencingToken: 1 });
  expect(["CREATED", "OWNERSHIP_NOT_CURRENT"]).toContain(send.disposition ?? send.code);
  const state = durable(p);
  expect(state.ownership).toBeUndefined();
  expect(state.messages).toBe(send.disposition === "CREATED" ? 1 : 0);
  expect(state.cursor).toBe(0);
  assertNoSecrets(reports, p);
}, TEST_TIMEOUT_MS);

it("serializes near-expiry send against takeover and rejects any stale former Owner", async () => {
  const p = prepared();
  const reports = await race([
    launch(p, "send", "send", sendRequest(p, "takeover-race"), at(29)),
    launch(
      p,
      "takeover",
      "takeover",
      { participantId: p.participantId, sessionId: S2, capability: p.takeover },
      at(31),
    ),
  ]);
  const send = reports.find((report) => report.result.stage === "send")!.result;
  const takeover = reports.find((report) => report.result.stage === "takeover")!.result;
  expect(takeover).toMatchObject({ sessionId: S2, fencingToken: 2 });
  expect(["CREATED", "OWNERSHIP_NOT_CURRENT"]).toContain(send.disposition ?? send.code);
  const state = durable(p);
  expect(state.ownership).toEqual({ session_id: S2, fencing_token: 2 });
  expect(state.messages).toBe(send.disposition === "CREATED" ? 1 : 0);
  expect(state.cursor).toBe(0);
  assertNoSecrets(reports, p);
}, TEST_TIMEOUT_MS);
