import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTaskOwnerComposition } from "../../../src/bin/task-owner-composition.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(options: { sidecar?: boolean; selector?: string; recipients?: string[] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-owner-composition-"))); roots.push(root); fs.chmodSync(root, 0o700);
  const configPath = join(root, "binding.json"); fs.writeFileSync(configPath, "{}", { mode: 0o600 });
  const registry = join(root, "registry"); fs.mkdirSync(registry, { mode: 0o700 });
  if (options.sidecar !== false) fs.writeFileSync(`${configPath}.task-ownership.json`, JSON.stringify({ schemaVersion: 1, registryDirectory: registry,
    ...(options.selector === undefined ? {} : { piEndpoint: options.selector }) }), { mode: 0o600 });
  let state = "ACTIVE"; let lease = "ACTIVE"; let active = options.recipients ?? ["pi/session-a"];
  const admission = vi.fn();
  const live = { admission, recipients: { snapshot: () => ({ recipients: active.map(endpointId => ({ adapter: "pi", endpointId })), viewDigest: "a".repeat(64), presence: [] }) },
    snapshot: () => ({ manifest: { registrations: active.map(endpointId => ({ endpointId, runtimeSessionId: `runtime-${endpointId}`, status: "active", epoch: 1 })) } }) };
  const host = { status: () => ({ endpointId: "chatgpt/main", registered: true, participantId: "p", sessionId: "s", exchangeId: "exchange-1", lease, leaseExpiresAt: "2099-01-01T00:00:00.000Z", fencingToken: 1 }) };
  const bound = { operationalStatus: () => ({ state, renewal: "RUNNING" }) };
  const config = { endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: active.map(endpointId => ({ adapter: "pi", endpointId })) };
  return { configPath, registry, config, live, host, bound, admission, setState: (value: string) => { state = value; },
    setLease: (value: string) => { lease = value; }, setActive: (value: string[]) => { active = value; } };
}

it("stays absent without a sidecar and rejects an ambiguous owner selector", () => {
  const absent = fixture({ sidecar: false });
  expect(createTaskOwnerComposition(absent.configPath, absent.config as never, absent.live as never, absent.host as never, absent.bound as never)).toBeUndefined();
  const ambiguous = fixture({ recipients: ["pi/session-a", "pi/session-b"] });
  expect(() => createTaskOwnerComposition(ambiguous.configPath, ambiguous.config as never, ambiguous.live as never, ambiguous.host as never, ambiguous.bound as never)).toThrow("CE_MCP_TASK_OWNERSHIP_INVALID");
});

it("binds registry scope to the live exchange and unique Pi owner", () => {
  const f = fixture({ selector: "pi/session-a", recipients: ["pi/session-a", "pi/session-b"] });
  const composed = createTaskOwnerComposition(f.configPath, f.config as never, f.live as never, f.host as never, f.bound as never)!;
  const messageId = "msg_01M73NE8XRRBED0ER5QA9RF9JV";
  const registration = { schemaVersion: 1, exchangeId: "exchange-1", requestMessageId: "msg_01M73NE8XRRBED0ER5QA9RF9JW", messageId,
    from: "pi/session-a", to: "chatgpt/main", projectLabel: "Project A", taskOwner: "pi/session-a", ownerStatus: "REGISTERED",
    probeId: "123e4567-e89b-42d3-a456-426614174000" };
  fs.writeFileSync(join(f.registry, `${messageId}.json`), JSON.stringify(registration), { mode: 0o600 });
  composed.taskOwnerAdmission();
  expect(composed.taskOwner.lookup(messageId)).toEqual(registration);
  expect(f.admission).toHaveBeenCalledWith({ kind: "inbox" }, expect.objectContaining({ recipients: expect.any(Array) }));
});

it("rechecks bound, lease and live owner identity on every call", () => {
  const f = fixture(); const composed = createTaskOwnerComposition(f.configPath, f.config as never, f.live as never, f.host as never, f.bound as never)!;
  composed.taskOwnerAdmission();
  f.setState("WRITE_BLOCKED"); expect(() => composed.taskOwnerAdmission()).toThrow("CE_MCP_TASK_OWNERSHIP_DENIED");
  f.setState("ACTIVE"); f.setLease("EXPIRED"); expect(() => composed.taskOwnerAdmission()).toThrow("CE_MCP_TASK_OWNERSHIP_DENIED");
  f.setLease("ACTIVE"); f.setActive([]); expect(() => composed.taskOwnerAdmission()).toThrow("CE_MCP_TASK_OWNERSHIP_DENIED");
});
