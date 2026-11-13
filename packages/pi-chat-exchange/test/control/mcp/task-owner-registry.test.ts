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
  const registryRoot = join(root, "registry"); fs.mkdirSync(registryRoot, { mode: 0o700 });
  const registry = join(registryRoot, "metadata"); fs.mkdirSync(registry, { mode: 0o700 });
  const owners = join(registryRoot, "owners"); fs.mkdirSync(owners, { mode: 0o700 });
  const scope = { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" };
  fs.writeFileSync(join(registryRoot, "scope.json"), JSON.stringify(scope), { mode: 0o600 });
  const registration = { schemaVersion: 1, ...scope, requestMessageId: REQUEST_ID, messageId: MESSAGE_ID,
    projectLabel: "Project A", taskOwner: "pi/session-a",
    ownerStatus: "REGISTERED", probeId: "123e4567-e89b-42d3-a456-426614174000" };
  const write = (value: unknown = registration) => fs.writeFileSync(join(registry, `${MESSAGE_ID}.json`), JSON.stringify(value), { mode: 0o600 });
  const writeOwner = (value: unknown = { projectLabel: registration.projectLabel, taskOwner: registration.taskOwner, ownerStatus: "REGISTERED" }) =>
    fs.writeFileSync(join(owners, `${REQUEST_ID}.json`), JSON.stringify(value), { mode: 0o600 });
  writeOwner();
  return { root, config, registryRoot, registry, owners, registration, write, writeOwner };
}

it("loads only a private closed sidecar with an optional Pi selector", () => {
  const f = fixture();
  expect(loadTaskOwnershipSidecar(f.config)).toBeUndefined();
  const path = `${f.config}.task-ownership.json`;
  fs.writeFileSync(path, JSON.stringify({ schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "pi/session-a" }), { mode: 0o600 });
  expect(loadTaskOwnershipSidecar(f.config)).toEqual({ schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "pi/session-a" });
  fs.writeFileSync(path, JSON.stringify({ schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "pi/session-a", ownerProof: "ce-store-v1" }), { mode: 0o600 });
  expect(loadTaskOwnershipSidecar(f.config)?.ownerProof).toBe("ce-store-v1");
  for (const invalid of [
    { schemaVersion: 1, registryDirectory: f.registry, extra: true },
    { schemaVersion: 1, registryDirectory: "relative" },
    { schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "chatgpt/main" },
    { schemaVersion: 1, registryDirectory: f.registry, ownerProof: "ce-store-v1" },
    { schemaVersion: 1, registryDirectory: f.registry, piEndpoint: "pi/session-a", ownerProof: "unknown" },
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

it("returns a registered business owner distinct from the scoped Pi endpoint", () => {
  const f = fixture();
  const projection = { ...f.registration, projectLabel: "synthetic-project", taskOwner: "synthetic-owner" };
  f.write(projection);
  f.writeOwner({ projectLabel: projection.projectLabel, taskOwner: projection.taskOwner, ownerStatus: "REGISTERED" });
  const legacy = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" });
  expect(legacy.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
  const port = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" }, "ce-store-v1");
  expect(port.lookup(MESSAGE_ID)).toEqual(projection);
});

it("denies stale projections after the authoritative owner enters conflict", () => {
  const f = fixture(); f.write();
  const port = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" }, "ce-store-v1");
  expect(port.lookup(MESSAGE_ID)).toEqual(f.registration);
  f.writeOwner({ projectLabel: null, taskOwner: null, ownerStatus: "CONFLICT" });
  expect(port.lookup(MESSAGE_ID)).toEqual({ messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" });
});

it("fails closed when the registry scope or authoritative owner record cannot prove the projection", () => {
  const f = fixture(); f.write();
  const port = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" }, "ce-store-v1");
  const denied = { messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" };
  f.writeOwner({ projectLabel: "wrong", taskOwner: "pi/session-a", ownerStatus: "REGISTERED" });
  expect(port.lookup(MESSAGE_ID)).toEqual(denied);
  f.writeOwner();
  fs.writeFileSync(join(f.registryRoot, "scope.json"), JSON.stringify({ exchangeId: "exchange-2", from: "pi/session-a", to: "chatgpt/main" }));
  expect(port.lookup(MESSAGE_ID)).toEqual(denied);
  fs.writeFileSync(join(f.registryRoot, "scope.json"), JSON.stringify({ exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" }));
  fs.rmSync(join(f.owners, `${REQUEST_ID}.json`));
  expect(port.lookup(MESSAGE_ID)).toEqual(denied);
});

it("rejects unsafe owner and scope files in CE Store proof mode", () => {
  const f = fixture(); f.write();
  const port = createTaskOwnerRegistryPort(f.registry, { exchangeId: "exchange-1", from: "pi/session-a", to: "chatgpt/main" }, "ce-store-v1");
  const denied = { messageId: MESSAGE_ID, ownerStatus: "UNVERIFIED" };
  const owner = join(f.owners, `${REQUEST_ID}.json`);
  fs.chmodSync(owner, 0o644); expect(port.lookup(MESSAGE_ID)).toEqual(denied);
  fs.chmodSync(owner, 0o600);
  fs.writeFileSync(owner, '{"ownerStatus":"REGISTERED","ownerStatus":"REGISTERED","projectLabel":"Project A","taskOwner":"pi/session-a"}');
  expect(port.lookup(MESSAGE_ID)).toEqual(denied);
  fs.rmSync(owner); fs.symlinkSync(join(f.registry, `${MESSAGE_ID}.json`), owner);
  expect(port.lookup(MESSAGE_ID)).toEqual(denied);
  fs.rmSync(owner); f.writeOwner(); fs.chmodSync(f.owners, 0o755);
  expect(port.lookup(MESSAGE_ID)).toEqual(denied);
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
