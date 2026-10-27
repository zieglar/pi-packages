/**
 * HANDOFF-CE-HOST-09 B1.1 Task 3 — bundled OFFLINE FAKE tunnel client.
 *
 * This process is a simulator, not a transport. It opens no socket, performs no
 * network or control-plane call, reads no credential, and never receives one:
 * the manager starts it without any secret at all. Every emitted record is
 * explicitly labelled `simulated: true`, so no status derived from it may be
 * read as a real connection, delivery, ACK, or completion.
 *
 * Protocol (fixed, newline-delimited JSON on stdout only):
 *   {"event":"ready",   "runId":…,"pid":…,"simulated":true}
 *   {"event":"health",  "runId":…,"pid":…,"sequence":n,"simulated":true,
 *    "payload":{ … the measured healthy health-probe shape, simulated … }}
 *   {"event":"activity","runId":…,"pid":…,"kind":"simulated-request",
 *    "simulated":true}
 *
 * `runId` and `pid` exist so the manager can correlate every record with the
 * run it actually owns; records that do not match are discarded by the manager.
 * SIGTERM/SIGINT stop the simulator with exit code 0.
 */
import { fileURLToPath } from "node:url";

export interface OfflineClientOptions {
  readonly runId: string;
  readonly healthIntervalMs: number;
  readonly simulateActivity: boolean;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Fixed argv parsing: only the flags this simulator defines are accepted. */
export function parseOfflineClientArgs(argv: readonly string[]): OfflineClientOptions | undefined {
  let runId: string | undefined;
  let healthIntervalMs = 500;
  let simulateActivity = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--run-id") {
      runId = argv[index + 1];
      index += 1;
      continue;
    }
    if (flag === "--health-interval-ms") {
      healthIntervalMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (flag === "--simulate-activity") {
      simulateActivity = true;
      continue;
    }
    return undefined;
  }
  if (runId === undefined || !RUN_ID_PATTERN.test(runId)) return undefined;
  if (!Number.isSafeInteger(healthIntervalMs) || healthIntervalMs < 10 || healthIntervalMs > 60_000) return undefined;
  return Object.freeze({ runId, healthIntervalMs, simulateActivity });
}

/** The simulated health document. Mirrors the measured healthy shape. */
export function simulatedHealthPayload(sequence: number): Record<string, unknown> {
  return {
    simulated: true,
    result: "ok",
    healthz: { ok: true, status: 200, body: "live" },
    readyz: { ok: true, status: 200, body: "ready" },
    process: { running: true },
    request_count: sequence,
  };
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function runOfflineClient(options: OfflineClientOptions): void {
  const pid = process.pid;
  const base = { runId: options.runId, pid, simulated: true as const };
  emit({ event: "ready", ...base });
  let sequence = 0;
  const timer = setInterval(() => {
    sequence += 1;
    emit({ event: "health", ...base, sequence, payload: simulatedHealthPayload(sequence) });
    if (options.simulateActivity) emit({ event: "activity", ...base, kind: "simulated-request" });
  }, options.healthIntervalMs);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const options = parseOfflineClientArgs(process.argv.slice(2));
  if (options === undefined) {
    // Fixed, content-free refusal: this simulator accepts only its own flags.
    process.stdout.write(`${JSON.stringify({ event: "refused", simulated: true })}\n`);
    process.exit(2);
  }
  runOfflineClient(options);
}
