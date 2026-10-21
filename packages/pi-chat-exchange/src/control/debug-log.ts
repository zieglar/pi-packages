/** DIAG-01 development diagnostics: always on, best effort, never stdout.
 * Only explicitly projected metadata is accepted; never pass raw args/results/errors.
 * The built module's ../../.debug-logs is inside the independent debug artifact.
 */
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

export type DebugMetadata = Readonly<Record<string, unknown>>;
const FIELDS = new Set(["stage", "method", "requestId", "requestIdType", "requestIdLength", "tool", "args", "errorType", "stackFrames", "code", "isError", "durationMs", "count", "released", "detached", "signal", "exitCode", "version", "fencing", "owned", "mode", "origin", "reason", "scope"]);
export function createDebugLog(directory: string) {
  return (component: string, event: string, metadata: DebugMetadata = {}): void => {
    // Include serialization in the guard: even hostile getters/cycles cannot
    // turn diagnostics into a business/protocol failure.
    try {
      const context = Object.fromEntries(Object.entries(metadata).filter(([key]) => FIELDS.has(key)));
      const line = `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, component, event, ...context })}\n`;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("unsafe log directory");
        const fd = openSync(join(directory, `ce-debug-${process.pid}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error("unsafe log file");
          appendFileSync(fd, line);
        } finally { closeSync(fd); }
      } catch { /* diagnostics file unavailable: stderr mirror remains best effort */ }
      try { writeSync(2, line); } catch { /* closed stderr must not alter behavior */ }
    } catch { /* diagnostics must never escape */ }
  };
}
export const debugEvent = createDebugLog(resolve(import.meta.dirname, "../../.debug-logs"));

const ARG_FIELDS = new Set(["to", "text", "idempotencyKey", "afterAuditSequence", "pageSize", "rawScanLimit", "messageId", "payloadDigest", "payloadLength", "messageCreatedAuditSequence"]);
export function argumentShape(args: unknown): Array<{ field: string; type: string; length?: number }> {
  try {
    if (args === null || typeof args !== "object") return [];
    return Object.entries(args).slice(0, 32).map(([key, value]) => ({
      field: ARG_FIELDS.has(key) ? key : "unknown-field",
      type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      ...(typeof value === "string" ? { length: value.length } : {}),
    }));
  } catch { return []; }
}
export function errorSummary(error: unknown): DebugMetadata {
  try {
    // Error messages and first stack line can contain payloads/credentials.
    // Retain source basenames/line:column only, never function names or paths.
    const stackFrames = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 9)
      .flatMap((line) => line.match(/[/\\]([A-Za-z0-9_.-]+\.[cm]?[jt]s:\d+:\d+)\)?$/)?.[1] ?? []) : [];
    return { errorType: error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : typeof error, stackFrames };
  } catch { return { errorType: "unknown" }; }
}
