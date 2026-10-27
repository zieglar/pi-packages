/**
 * HANDOFF-CE-DIAG-06 — development execution guard for tools/call.
 *
 * Real two-context subprocess test: a spawned `mcp-stdio.js --config …` whose
 * binding carries `debugExecutionGuard.enabled = true` must allow initialize
 * and tools/list but block EVERY tools/call at the unified dispatch entry —
 * before any business handler (messaging port, ack gate, or ping) runs. The
 * guard must fail closed for unknown tools and invalid arguments alike, keep
 * stdout pure JSON-RPC, record TOOL_CALL_BLOCKED diagnostics, leave zero
 * business store rows, and exit cleanly. With the flag absent the surface is
 * unchanged (ping still succeeds) — the opt-in is inert by default.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stdioEntry = resolve(packageRoot, "dist", "bin", "mcp-stdio.js");

interface Child {
  readonly process: ChildProcessWithoutNullStreams;
  readonly stderr: string[];
  readonly rawStdout: string[];
  readonly call: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  readonly callWithId: (id: string | number, method: string, params: unknown) => Promise<Record<string, unknown>>;
  readonly notify: (method: string) => void;
  readonly waitExit: () => Promise<number | null>;
}

function writeBinding(root: string, guard: boolean): string {
  const config = {
    version: 1,
    store: { directory: join(root, "store") },
    exchange: { namespace: "ce-guard-it", idempotencyKey: "guard-1" },
    endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [{ adapter: "pi", endpointId: "pi/main" }],
    payloadRead: { enabled: true },
    ack: { enabled: true },
    ...(guard ? { debugExecutionGuard: { enabled: true } } : {}),
  };
  const path = join(root, "binding.json");
  writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`);
  return path;
}

async function launch(configPath: string): Promise<Child> {
  const child = spawn(process.execPath, [stdioEntry, "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  const rawStdout: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number | string, (line: string) => void>();
  let nextId = 0;
  rl.on("line", (line: string) => {
    rawStdout.push(line);
    const message = JSON.parse(line) as { id?: number | string };
    if ((typeof message.id === "number" || typeof message.id === "string") && pending.has(message.id)) {
      pending.get(message.id)!(line);
      pending.delete(message.id);
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolvePromise) => {
      const id = nextId++;
      pending.set(id, (line) => resolvePromise(JSON.parse(line) as Record<string, unknown>));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const callWithId = (id: string | number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolvePromise) => {
      pending.set(id as number | string, (line) => resolvePromise(JSON.parse(line) as Record<string, unknown>));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const exited = new Promise<number | null>((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
  const waitExit = () => exited;
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`server never started; stderr: ${stderr.join(" | ")}`)), 15_000);
    const poll = () => {
      if (stderr.some((line) => line.startsWith("CE_MCP_STARTED"))) {
        clearTimeout(timer);
        resolveReady();
      } else if (pending.size === 0 && !child.stdin.writable) {
        clearTimeout(timer);
        rejectReady(new Error(`server exited; stderr: ${stderr.join(" | ")}`));
      } else setTimeout(poll, 25);
    };
    poll();
  });
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.1" },
  });
  expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("pi-chat-exchange");
  notify("notifications/initialized");
  return { process: child, stderr, rawStdout, call, callWithId, notify, waitExit };
}
const BUSINESS_TABLES = [
  "message",
  "attempt",
  "result",
  "delivery_cursor",
  "delivery_ack_receipt",
  "evidence_envelope",
  "evidence_application",
  "reconciliation",
  "disposition",
] as const;

function businessRowCounts(root: string): { [table: string]: number } {
  const dbPath = join(root, "store", "ce-store.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    const counts: { [table: string]: number } = {};
    for (const table of BUSINESS_TABLES) {
      expect(present.has(table), `business table ${table} must exist in the store schema`).toBe(true);
      counts[table] = (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
    }
    expect(Object.keys(counts)).toHaveLength(BUSINESS_TABLES.length);
    return counts;
  } finally {
    db.close();
  }
}

it("blocks every tools/call at the unified dispatch entry before any handler (guard on), leaving zero business rows", { timeout: 60_000 }, async () => {
  if (!existsSync(stdioEntry)) throw new Error(`built stdio entrypoint missing: ${stdioEntry} — run "pnpm run build" first`);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-guard-on-"));
  try {
    const server = await launch(writeBinding(root, true));

    const list = await server.call("tools/list", {});
    const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools.sort()).toEqual(["ce_ack", "ce_inbox_list", "ce_read_payload", "ce_send", "ping"]);

    // One canary attempt carries a SECRET-SHAPED STRING request id; the guard
    // must block it like any other call and the raw id must never reach
    // stderr or the persistent diagnostics (only type+length projection).
    const CANARY_ID = "canary-ce6-secret-request-id";
    const calls: Array<[string, unknown]> = [
      ["ping", {}],
      ["ce_send", { to: { adapter: "pi", endpointId: "pi/main" }, bodyText: "must never run" }],
      ["ce_inbox_list", {}],
      ["ce_read_payload", { messageId: "00000000-0000-0000-0000-000000000000" }],
      ["ce_ack", { messageId: "00000000-0000-0000-0000-000000000000" }],
      ["no_such_tool", { anything: true }],
      ["ce_send", { completely: "invalid argument shape" }],
    ];
    for (const [name, args] of calls) {
      const response = await server.call("tools/call", { name, arguments: args });
      expect(response.error, `tools/call ${name} must be blocked, got: ${JSON.stringify(response)}`).toBeDefined();
      const error = response.error as { code: number; message: string };
      expect(error.code).toBe(-32603);
      expect(error.message).toContain("execution guard");
    }
    {
      const response = await server.callWithId(CANARY_ID, "tools/call", { name: "ping", arguments: {} });
      const error = response.error as { code: number; message: string };
      expect(error.code).toBe(-32603);
    }

    server.process.stdin.end();
    expect(await server.waitExit()).toBe(0);

    // stdout stayed pure JSON-RPC framing for the ENTIRE captured stream.
    for (const line of server.rawStdout) {
      const frame = JSON.parse(line) as { jsonrpc?: string };
      expect(frame.jsonrpc).toBe("2.0");
    }

    // Diagnostics: exactly one TOOL_CALL_BLOCKED per attempt (numeric ids
    // projected verbatim, the canary string id only as type+length) with the
    // fixed reason — and the canary text never leaks.
    const blocked = server.stderr
      .filter((line) => line.includes("TOOL_CALL_BLOCKED"))
      .map((line) => JSON.parse(line) as { tool: string; requestId?: number; requestIdType?: string; requestIdLength?: number; reason?: string });
    expect(blocked).toHaveLength(calls.length + 1);
    const keyOf = (e: { tool: string; requestId?: number; requestIdType?: string; requestIdLength?: number; reason?: string }) =>
      JSON.stringify({
        tool: e.tool,
        ...(e.requestId !== undefined ? { requestId: e.requestId } : { requestIdType: e.requestIdType, requestIdLength: e.requestIdLength }),
        reason: e.reason,
      });
    // launch() consumed ids 0 (initialize) and 1 (tools/list); the 7 attempts run 2..8.
    const expectedTuples = new Set(
      calls.map((_, i) => JSON.stringify({ tool: calls[i]![0] === "no_such_tool" ? "unknown-tool" : calls[i]![0], requestId: 2 + i, reason: "development execution guard" })),
    );
    expectedTuples.add(JSON.stringify({ tool: "ping", requestIdType: "string", requestIdLength: CANARY_ID.length, reason: "development execution guard" }));
    // Exact coverage: duplicates cannot mask a missing tuple (sorted-array equality).
    expect([...blocked.map(keyOf)].sort()).toEqual([...expectedTuples].sort());
    expect(server.stderr.join("\n")).not.toContain(CANARY_ID);
    // No handler-side lifecycle for the attempted business calls.
    for (const line of server.stderr) {
      expect(line).not.toContain("TOOL_DISPATCH");
      expect(line).not.toContain("CE_MCP_ACK");
    }
    expect(server.stderr.some((line) => line.includes("EXECUTION_GUARD_ARMED") && line.includes("\"scope\":\"tools/call\""))).toBe(true);

    // Store: every business table exists and stayed at zero rows.
    const counts = businessRowCounts(root);
    for (const [table, count] of Object.entries(counts)) {
      expect(count, `business table ${table} must stay empty`).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the surface unchanged when the guard flag is absent (ping succeeds)", { timeout: 30_000 }, async () => {
  if (!existsSync(stdioEntry)) throw new Error(`built stdio entrypoint missing: ${stdioEntry} — run "pnpm run build" first`);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-guard-off-"));
  try {
    const server = await launch(writeBinding(root, false));
    const ping = await server.call("tools/call", { name: "ping", arguments: {} });
    expect((ping.result as { isError?: boolean }).isError).not.toBe(true);
    server.process.stdin.end();
    expect(await server.waitExit()).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
