import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("../../src/storage/store.js", () => ({
  openStore: () => { throw state.error; },
  initializeStore: () => { throw state.error; },
}));

const dirs: string[] = [];
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(makeError: (ErrorClass: typeof import("../../src/storage/errors.js").StoreLifecycleError) => unknown) {
  vi.resetModules();
  const { StoreLifecycleError } = await import("../../src/storage/errors.js");
  state.error = makeError(StoreLifecycleError);
  const dir = mkdtempSync(join(tmpdir(), "ce-mcp-schema-notice-"));
  dirs.push(dir);
  const configPath = join(dir, "binding.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1, store: { directory: dir, file: "store.sqlite" },
    exchange: { namespace: "test", idempotencyKey: "test-key" },
    endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [{ adapter: "pi", endpointId: "pi/A" }],
    lease: { ttlSeconds: 120, renewIntervalSeconds: 30 },
    payloadRead: { enabled: true }, ack: { enabled: true },
    debugExecutionGuard: { enabled: false },
  }));
  process.argv = [process.execPath, "mcp-stdio", "--config", configPath];
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("intercepted exit"); });
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  await import("../../src/bin/mcp-stdio.js");
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  on.mockRestore();
  return log.mock.calls.map(call => call.join(" "));
}

it("reports schema versions from numeric fields on a real lifecycle refusal", async () => {
  const output = await launch(ErrorClass => Object.assign(
    new ErrorClass("STORAGE_SCHEMA_TOO_NEW", "private path and arbitrary text"),
    { observedSchemaVersion: 12, supportedSchemaVersion: 9 },
  ));
  expect(output).toContain("STORAGE_SCHEMA_TOO_NEW observedSchemaVersion=12 supportedSchemaVersion=9");
});

it("reports only the fixed code when structured versions are absent", async () => {
  const output = await launch(ErrorClass => new ErrorClass("STORAGE_SCHEMA_TOO_NEW", "store schema 42 private secret"));
  expect(output).toContain("STORAGE_SCHEMA_TOO_NEW");
});

it("reports only the fixed code when versions are unsafe", async () => {
  const output = await launch(ErrorClass => Object.assign(
    new ErrorClass("STORAGE_SCHEMA_TOO_NEW", "store schema 42 private secret"),
    { observedSchemaVersion: "42\u001b[31m", supportedSchemaVersion: Infinity },
  ));
  expect(output).toContain("STORAGE_SCHEMA_TOO_NEW");
});

it("reports a single available safe version", async () => {
  const output = await launch(ErrorClass => Object.assign(
    new ErrorClass("STORAGE_SCHEMA_TOO_NEW", "private"),
    { observedSchemaVersion: 12, supportedSchemaVersion: -1 },
  ));
  expect(output).toContain("STORAGE_SCHEMA_TOO_NEW observedSchemaVersion=12");
});

it.each([
  ["corrupt", (ErrorClass: typeof import("../../src/storage/errors.js").StoreLifecycleError) => new ErrorClass("STORAGE_CORRUPT", "private")],
  ["permission", () => Object.assign(new Error("private"), { code: "EACCES" })],
  ["unknown", () => new Error("private")],
  ["spoofed code", () => Object.assign(new Error("private"), { code: "STORAGE_SCHEMA_TOO_NEW" })],
])("keeps generic startup handling for %s", async (_name, makeError) => {
  const output = await launch(makeError);
  expect(output.at(-1)).toBe("CE_MCP_START_FAILED");
});
