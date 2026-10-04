import { describe, expect, it } from "vitest";
import {
  DURABLE_TASK_STATE_VERSION,
  deserializeTaskState,
  type EphemeralTaskState,
  serializeTaskState,
  validTaskState,
} from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";

const base = {
  taskId: "task-1",
  revision: 3,
  status: "running" as const,
  objective: "Implement the Phase 1A kernel",
  completionCriteria: "npm run verify passes",
  policyVersions: { role: "1.0.0", model: "1.0.0" },
  checkpoint: { revision: 3, summary: "task 2 of 6 complete" },
  recoveryCounters: { retries: 1, fallbacks: 0, rotations: 0 },
  suspension: null,
  completionEvidence: null,
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
};

describe("authoritative durable state", () => {
  it("round-trips deterministically with stable key ordering", () => {
    const state = validTaskState(base);
    const first = serializeTaskState(state);
    const second = serializeTaskState(validTaskState(base));
    expect(first).toBe(second);
    const parsed = deserializeTaskState(first);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value).toEqual({ ...base, schemaVersion: DURABLE_TASK_STATE_VERSION });
    expect(serializeTaskState(parsed.value)).toBe(first);
  });

  it("rejects an unsupported schema version", () => {
    const json = JSON.stringify({ ...base, schemaVersion: 999 });
    const result = deserializeTaskState(json);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("validation");
    expect(result.failure.code).toBe("unsupported_version");
  });

  it("rejects records that fail schema validation", () => {
    const missing = JSON.stringify({ ...base, schemaVersion: 1, objective: undefined });
    expect(deserializeTaskState(missing).ok).toBe(false);
    const badType = JSON.stringify({ ...base, schemaVersion: 1, revision: "three" });
    expect(deserializeTaskState(badType).ok).toBe(false);
  });

  it("forbids secret-bearing and runtime fields via exact allowlist", () => {
    const leaky = JSON.stringify({
      ...base,
      schemaVersion: 1,
      apiKey: "sk-secret",
      credentials: { token: "x" },
      transcript: "hidden reasoning transcript",
      model: { runtime: true },
      stream: { handle: 1 },
    });
    const result = deserializeTaskState(leaky);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.code).toBe("forbidden_fields");
    expect(JSON.stringify(result.failure.metadata)).not.toContain("sk-secret");
  });

  it("rejects serialization of records with forbidden keys", () => {
    const leaky = {
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      apiKey: "sk-secret",
    } as never;
    expect(() => serializeTaskState(leaky)).toThrow(/forbidden/i);
  });
});

  it("forbids nested fields outside each authoritative allowlist", () => {
    const leaky = JSON.stringify({
      ...base,
      schemaVersion: DURABLE_TASK_STATE_VERSION,
      policyVersions: { ...base.policyVersions, apiKey: "nested-secret" },
    });
    const result = deserializeTaskState(leaky);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.code).toBe("schema_violation");
    expect(JSON.stringify(result)).not.toContain("nested-secret");
  });

describe("ephemeral state separation", () => {
  it("keeps runtime-only state out of the authoritative schema", () => {
    const ephemeral: EphemeralTaskState = {
      taskId: taskId("task-1"),
      abortController: new AbortController(),
      runtimeHandles: new Map([["model", { id: "claude" }]]),
      liveStreams: new Set([{ pipe: true }]),
    };
    // Ephemeral state is deliberately not JSON-serializable state: pushing it
    // through the authoritative serializer must fail validation.
    expect(() =>
      serializeTaskState(ephemeral as unknown as Parameters<typeof serializeTaskState>[0]),
    ).toThrow();
  });

  it("exposes runtime handles that never round-trip", () => {
    const controller = new AbortController();
    const ephemeral: EphemeralTaskState = {
      taskId: taskId("task-1"),
      abortController: controller,
      runtimeHandles: new Map(),
      liveStreams: new Set(),
    };
    expect(ephemeral.abortController.signal.aborted).toBe(false);
    controller.abort();
    expect(ephemeral.abortController.signal.aborted).toBe(true);
  });
});
