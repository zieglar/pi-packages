import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { sendMessage } from "../../src/storage/messaging.js";
import { acquireOwnership, bindSession } from "../../src/storage/ownership.js";
import { joinExchange } from "../../src/storage/participant.js";
import { openStore } from "../../src/storage/store.js";
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
const SEND_AT = "2026-10-10T00:00:10.000Z";
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/message-send-crash-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const messagingUrl = new URL("../../src/storage/messaging.ts", import.meta.url).href;

interface Prepared {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly participantId: string;
  readonly capability: string;
}

interface CrashWorker {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly lines: Record<string, unknown>[];
  readonly ready: Promise<void>;
  readonly done: Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  readonly releasePath: string;
  readonly markerPath: string;
  readonly evidencePath: string;
}

const children: ChildProcessByStdio<null, Readable, Readable>[] = [];

function prepared(): Prepared {
  const active = fixture("ce-b3-p3a-crash-");
  const exchangeId = exchange(active);
  const participantId = participant(active, "sender").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: SESSION, capability: attach }, { now: () => NOW });
  acquireOwnership(active.store, { participantId, sessionId: SESSION, capability: attach }, { now: () => NOW });
  const join = capabilityFor(active, participantId, "join");
  joinExchange(
    active.store,
    { exchangeId, participantId, capability: join, idempotencyKey: "join-sender" },
    { now: () => NOW },
  );
  const capability = capabilityFor(active, participantId, "send", { sessionId: SESSION });
  active.store.close();
  return { active, exchangeId, participantId, capability };
}

function serializedRequest(p: Prepared) {
  return {
    participantId: p.participantId,
    sessionId: SESSION,
    fencingToken: 1,
    capability: p.capability,
    message: {
      exchangeId: p.exchangeId,
      from: { adapter: "adapter-a", endpointId: "sender" },
      to: { adapter: "adapter-a", endpointId: "recipient" },
      payload: [7, 8, 9],
      idempotencyKey: "crash-key",
    },
  };
}

function liveRequest(p: Prepared) {
  const request = serializedRequest(p);
  return { ...request, message: { ...request.message, payload: Uint8Array.from(request.message.payload) } };
}

function launch(p: Prepared, mode: string): CrashWorker {
  const readyPath = `${p.active.root}/${mode}.ready`;
  const releasePath = `${p.active.root}/${mode}.release`;
  const markerPath = `${p.active.root}/${mode}.marker`;
  const evidencePath = `${p.active.root}/${mode}.evidence`;
  const config = {
    mode,
    exchangeId: p.exchangeId,
    request: serializedRequest(p),
    now: SEND_AT,
    directory: p.active.directory,
    filename: p.active.filename,
    busyTimeoutMs: 5_000,
    waitMs: WAIT_MS,
    readyPath,
    releasePath,
    markerPath,
    evidencePath,
    storeUrl,
    messagingUrl,
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
  const done = new Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stderr }));
  });
  return { child, lines, ready, done, releasePath, markerPath, evidencePath };
}

async function waitForMarker(worker: CrashWorker, mode: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(worker.markerPath)) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error("crash worker exited early");
    if (Date.now() >= deadline) throw new Error("crash marker timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(readFileSync(worker.markerPath, "utf8")).toBe(mode);
}

function counts(p: Prepared) {
  const view = reader(p.active);
  try {
    return {
      messages: String(view.prepare("SELECT count(*) AS n FROM message WHERE exchange_id=?").get(p.exchangeId)!.n),
      records: String(
        view
          .prepare("SELECT count(*) AS n FROM idempotency_record WHERE namespace=?")
          .get(JSON.stringify(["message.create", p.exchangeId]))!.n,
      ),
      created: String(
        view
          .prepare("SELECT count(*) AS n FROM audit_event WHERE exchange_id=? AND kind='message_created'")
          .get(p.exchangeId)!.n,
      ),
      cursor: String(view.prepare("SELECT count(*) AS n FROM delivery_cursor").get()!.n),
      integrity: view.prepare("PRAGMA integrity_check").get(),
      foreignKeys: view.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    view.close();
  }
}

function retry(p: Prepared) {
  const store = openStore({ directory: p.active.directory, filename: p.active.filename });
  try {
    return sendMessage(store, liveRequest(p), { now: () => SEND_AT });
  } finally {
    store.close();
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  cleanupFixtures();
});

const MODES = [
  ["after-begin", { transaction: true, messages: "0", records: "0", created: "0" }],
  ["after-message-insert", { transaction: true, messages: "1", records: "0", created: "0" }],
  ["after-idempotency-insert", { transaction: true, messages: "1", records: "1", created: "0" }],
  ["after-audit-insert", { transaction: true, messages: "1", records: "1", created: "1" }],
  ["after-commit", { transaction: false, messages: "1", records: "1", created: "1" }],
] as const;

for (const [mode, expectedEvidence] of MODES) {
  it(`real SIGKILL at ${mode} leaves only a complete authorized-send transaction`, async () => {
    const p = prepared();
    const worker = launch(p, mode);
    await worker.ready;
    writeFileSync(worker.releasePath, "", { flag: "wx", mode: 0o600 });
    await waitForMarker(worker, mode);
    expect(JSON.parse(readFileSync(worker.evidencePath, "utf8"))).toEqual({
      mode,
      ...expectedEvidence,
      cursor: "0",
    });
    expect(worker.lines).toEqual([{ event: "ready", tag: mode, mode }]);
    expect(worker.child.kill("SIGKILL")).toBe(true);
    const report = await worker.done;
    expect(report).toEqual({ status: null, signal: "SIGKILL", stderr: "" });
    expect(worker.lines.filter((line) => line.event === "result")).toEqual([]);
    expect(JSON.stringify(worker.lines)).not.toContain(p.capability);

    if (mode === "after-commit") {
      expect(counts(p)).toMatchObject({ messages: "1", records: "1", created: "1", cursor: "0" });
      expect(retry(p).disposition).toBe("REPLAYED");
    } else {
      expect(counts(p)).toMatchObject({ messages: "0", records: "0", created: "0", cursor: "0" });
      expect(retry(p).disposition).toBe("CREATED");
      expect(retry(p).disposition).toBe("REPLAYED");
    }
    expect(counts(p)).toMatchObject({
      messages: "1",
      records: "1",
      created: "1",
      cursor: "0",
      integrity: { integrity_check: "ok" },
      foreignKeys: [],
    });
  }, TEST_TIMEOUT_MS);
}
