import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTaskOwnerRegistryPort, loadTaskOwnershipSidecar } from "../../../src/control/mcp/task-owner-registry.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const MESSAGE_ID = "msg_01M73NE8XRRBED0ER5QA9RF9JV";
const REQUEST_ID = "msg_01M73NE8XRRBED0ER5QA9RF9JW";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-task-owner-"))); roots.push(root); fs.chmodSync(root, 0o700);
  const config = join(root, "binding.json"); fs.writeFileSync(config, "{}", { mode: 0o600 });
  const registry = join(root, "registry"); fs.mkdirSync(registry, { mode: 0o700 });
  const registration = { schemaVersion: 1, exchangeId: "exchange-1", requestMessageId: REQUEST_ID, messageId: MESSAGE_ID,
    from: "pi/session-a", to: "chatgpt/main", projectLabel: "Project A", taskOwner: "pi/session-a",
    ownerStatus: "REGISTERED", probeId: "123e4567-e89b-42d3-a456-426614174000" };
  const write = (value: unknown = registration) => fs.writeFileSync(join(registry, `${MESSAGE_ID}.json`), JSON.stringify(value), { mode: 0o600 });
  return { root, config, registry, registration, write };
}

it("loads only a private closed sidecar with an optional Pi selector", () => {
  const f = fixture();
  expect(loadTaskOwnershipSidecar(f.config)).toBeUndefined();
  const path = `${f.config}.task-ownership.json`;
  fs.writeFileSync(path, JSON.stringify({ schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "pi/session-a" }), { mode: 0o600 });
  expect(loadTaskOwnershipSidecar(f.config)).toEqual({ schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "pi/session-a" });
  for (const invalid of [
    { schemaVersion: 1, registryDirectory: f.registry, extra: true },
    { schemaVersion: 1, registryDirectory: "relative" },
    { schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "chatgpt/main" },
  ]) { fs.writeFileSync(path, JSON.stringify(invalid), { mode: 0o600 }); expect(() => loadTaskOwnershipSidecar(f.config)).toThrow("CE_MCP_TASK_OWNERSHIP_INVALID"); }
  fs.writeFileSync(path, `{"schemaVersion":1,"schemaVersion":1,"registryDirectory":${JSON.stringify(f.registry)}}`, { mode: 0o600 });
  expect(() => loadTaskOwnershipSidecar(f.config)).toThrow("CE_MCP_TASK_OWNERSHIP_INVALID");
  fs.chmodSync(path, 0o644); expect(() => loadTaskOwnershipSidecar(f.config)).toThrow("CE_MCP_TASK_OWNERSHIP_INVALID");
});

it("returns a registration only when every immutable scope field matches", () => {
  const f = fixture(); f.write();
  const port = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" });
  expect(port.lookup(MESSAGE_ID)).toEqual(f.registration);
  for (const scope of [
    { exchangeId: "exchange-2", from: "pi/session-a", to: "chatgpt/main" },
    { exchangeId: "exchange-1", from: "pi/session-b", to: "chatgpt/main" },
    { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/other" },
  ]) expect(createTaskOwnerRegistryPort(f.registry, scope).lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  f.write({ ...f.registration, runtimeId: "runtime-a" });
  expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  f.write({ ...f.registration, taskOwner: "pi/session-b" });
  expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
});

it("fails closed for unsafe files, directories, oversized bytes and reconnect-time replacement", () => {
  const f = fixture(); f.write(); const path = join(f.registry, `${MESSAGE_ID}.json`);
  const port = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" });
  fs.chmodSync(path, 0o644); expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  fs.chmodSync(path, 0o600); fs.writeFileSync(path, "x".repeat(16_385)); expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  fs.rmSync(path); const target = join(f.root, "target.json"); fs.writeFileSync(target, JSON.stringify(f.registration), { mode: 0o600 }); fs.symlinkSync(target, path);
  expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  fs.rmSync(path); f.write(); fs.chmodSync(f.registry, 0o755); expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  fs.chmodSync(f.registry, 0o700); expect(port.lookup(MESSAGE_ID)).toEqual(f.registration);
});
