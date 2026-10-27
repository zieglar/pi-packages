import { spawn, type ChildProcessByStdio } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
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

const SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 90_000;
const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/inbox-discovery-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const inboxUrl = new URL("../../src/storage/inbox-discovery.ts", import.meta.url).href;
const messagingUrl = new URL("../../src/storage/messaging.ts", import.meta.url).href;
const ownershipUrl = new URL("../../src/storage/ownership.ts", import.meta.url).href;
const participantUrl = new URL("../../src/storage/participant.ts", import.meta.url).href;
const endpoint = Object.freeze({ adapter: "adapter-a", endpointId: "self" });

interface Prepared {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly participantId: string;
  readonly read: string;
  readonly send: string;
  readonly resume: string;
}

interface WorkerReport {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly result: Record<string, unknown>;
}

interface Launched {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly ready: Promise<void>;
  readonly locked: Promise<void>;
  readonly done: Promise<WorkerReport>;
  readonly releasePath: string;
  readonly transactionReleasePath: string;
}
const children: ChildProcessByStdio<Writable, Readable, Readable>[] = [];

function prepared(): Prepared {
  const active = fixture("ce-b3-p3c-inbox-race-");
  const exchangeId = exchange(active);
  const participantId = participant(active, endpoint.endpointId).participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: SESSION, capability: attach }, { now: () => NOW });
  acquireOwnership(active.store, { participantId, sessionId: SESSION, capability: attach }, { now: () => NOW });
  const join = capabilityFor(active, participantId, "join");
  joinExchange(
    active.store,
    { exchangeId, participantId, capability: join, idempotencyKey: "join-self" },
    { now: () => NOW },
  );
  const result = {
    active,
    exchangeId,
    participantId,
    read: capabilityFor(active, participantId, "read", { sessionId: SESSION }),
    send: capabilityFor(active, participantId, "send", { sessionId: SESSION }),
    resume: capabilityFor(active, participantId, "resume", { sessionId: SESSION }),
  };
  active.store.close();
  return result;
}

function listRequest(p: Prepared) {
  return {
    participantId: p.participantId,
    sessionId: SESSION,
    fencingToken: 1,
    capability: p.read,
    exchangeId: p.exchangeId,
  };
}

function sendRequest(p: Prepared) {
  return {
    participantId: p.participantId,
    sessionId: SESSION,
    fencingToken: 1,
    capability: p.send,
    message: {
      exchangeId: p.exchangeId,
      from: endpoint,
      to: endpoint,
      payload: [1, 2, 3],
      idempotencyKey: "concurrent-send",
    },
  };
}
interface LaunchOptions {
  readonly busyTimeoutMs?: number;
  readonly holdTransaction?: boolean;
}


function launch(
  p: Prepared,
  tag: string,
  operation: "list" | "send" | "release" | "revoke",
  request: object,
  options: LaunchOptions = {},
): Launched {
  const readyPath = `${p.active.root}/${tag}.ready`;
  const releasePath = `${p.active.root}/${tag}.release`;
  const transactionReleasePath = `${p.active.root}/${tag}.transaction-release`;
  const config = {
    tag,
    operation,
    request,
    now: "2026-10-10T00:00:10.000Z",
    directory: p.active.directory,
    filename: p.active.filename,
    busyTimeoutMs: options.busyTimeoutMs ?? 5_000,
    waitMs: WAIT_MS,
    readyPath,
    releasePath,
    ...(options.holdTransaction === true ? { transactionReleasePath } : {}),
    storeUrl,
    inboxUrl,
    messagingUrl,
    ownershipUrl,
    participantUrl,
  };
  const child = spawn(process.execPath, ["--import", register, workerScript], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stdin.end(JSON.stringify(config));
  let stdout = "";
  let stderr = "";
  const lines: Record<string, unknown>[] = [];
  let readyResolve: () => void = () => undefined;
  const readySignal = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let lockedResolve: () => void = () => undefined;
  const lockedSignal = new Promise<void>((resolve) => {
    lockedResolve = resolve;
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
        if (parsed.event === "locked") lockedResolve();
      }
    }
  });
  const exited = new Promise<WorkerReport>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        status,
        signal,
        stderr,
        result: lines.filter((line) => line.event === "result").at(-1) ?? {},
      });
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
  const exitedBeforeSignal = exited.then((report) => {
    throw new Error(`worker ${tag} exited before signaling: ${JSON.stringify(report)}`);
  });
  const ready = Promise.race([readySignal, exitedBeforeSignal]);
  const locked = options.holdTransaction === true
    ? Promise.race([lockedSignal, exitedBeforeSignal])
    : Promise.resolve();
  return { child, ready, locked, done, releasePath, transactionReleasePath };
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

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  cleanupFixtures();
});

it("serializes concurrent send/list into a complete before-or-after Inbox snapshot", async () => {
  const p = prepared();
  const reports = await race([
    launch(p, "list", "list", listRequest(p)),
    launch(p, "send", "send", sendRequest(p)),
  ]);
  const listed = reports.find((report) => report.result.stage === "list")!.result;
  const sent = reports.find((report) => report.result.stage === "send")!.result;
  expect(sent.status).toBe("CREATED");
  expect([[], [sent.messageId]]).toContainEqual(listed.messageIds);
  const db = reader(p.active);
  try {
    expect(db.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM delivery_cursor").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
}, TEST_TIMEOUT_MS);


it("proves an overlapping sender cannot enter while Inbox discovery holds its transaction", async () => {
  const p = prepared();
  const listing = launch(p, "held-list", "list", listRequest(p), { holdTransaction: true });
  await listing.ready;
  writeFileSync(listing.releasePath, "", { flag: "wx", mode: 0o600 });
  await listing.locked;

  const sender = launch(p, "blocked-send", "send", sendRequest(p), { busyTimeoutMs: 25 });
  await sender.ready;
  writeFileSync(sender.releasePath, "", { flag: "wx", mode: 0o600 });
  const sendReport = await sender.done;
  expect({ status: sendReport.status, signal: sendReport.signal, stderr: sendReport.stderr }).toEqual({
    status: 0,
    signal: null,
    stderr: "",
  });
  expect(sendReport.result).toMatchObject({
    stage: "blocked-send",
    code: "STORAGE_TRANSACTION_BUSY",
    outcome: "ROLLED_BACK",
    retryable: true,
  });

  writeFileSync(listing.transactionReleasePath, "", { flag: "wx", mode: 0o600 });
  const listReport = await listing.done;
  expect({ status: listReport.status, signal: listReport.signal, stderr: listReport.stderr }).toEqual({
    status: 0,
    signal: null,
    stderr: "",
  });
  expect(listReport.result).toMatchObject({ stage: "held-list", status: "LISTED", messageIds: [] });
}, TEST_TIMEOUT_MS);
it("serializes concurrent revocation/list so listing either wins first or refuses opaquely", async () => {
  const p = prepared();
  const reports = await race([
    launch(p, "list", "list", listRequest(p)),
    launch(p, "revoke", "revoke", {
      participantId: p.participantId,
      scope: "read",
      capability: p.read,
      sessionId: SESSION,
    }),
  ]);
  const listed = reports.find((report) => report.result.stage === "list")!.result;
  const revoked = reports.find((report) => report.result.stage === "revoke")!.result;
  expect(revoked.status).toBe("REVOKED");
  expect(["LISTED", "CAPABILITY_REJECTED"]).toContain(listed.status ?? listed.code);
}, TEST_TIMEOUT_MS);

it("serializes concurrent release/list so listing either wins first or loses current ownership", async () => {
  const p = prepared();
  const reports = await race([
    launch(p, "list", "list", listRequest(p)),
    launch(p, "release", "release", {
      participantId: p.participantId,
      sessionId: SESSION,
      fencingToken: 1,
      capability: p.resume,
    }),
  ]);
  const listed = reports.find((report) => report.result.stage === "list")!.result;
  const released = reports.find((report) => report.result.stage === "release")!.result;
  expect(released.status).toBe("RELEASED");
  expect(["LISTED", "OWNERSHIP_NOT_CURRENT"]).toContain(listed.status ?? listed.code);
  const db = reader(p.active);
  try {
    expect(db.prepare("SELECT count(*) AS n FROM participant_ownership").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
}, TEST_TIMEOUT_MS);
