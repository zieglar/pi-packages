import { describe, expect, it, vi } from "vitest";
import { classifyConnectivity, createConnectivityGuard, type ConnectivityEvidence } from "../../src/tunnel/connectivity-guard.js";

const evidence = (overrides: Partial<ConnectivityEvidence> = {}): ConnectivityEvidence => ({
  tunnelProcess: "RUNNING", tunnelHealth: "HEALTHY", mcpProcess: "RUNNING", sessionBinding: "attached", ...overrides,
});

describe("connectivity classification", () => {
  it.each([
    [evidence(), "CONNECTED", "CE_CONNECTIVITY_OK"],
    [evidence({ mcpProcess: "STOPPED" }), "DEGRADED", "CE_CONNECTIVITY_MCP_STOPPED"],
    [evidence({ sessionBinding: "detached" }), "DEGRADED", "CE_CONNECTIVITY_SESSION_DETACHED"],
    [evidence({ tunnelProcess: "STOPPED", tunnelHealth: "UNKNOWN" }), "DISCONNECTED", "CE_CONNECTIVITY_TUNNEL_STOPPED"],
    [evidence({ tunnelHealth: "UNHEALTHY" }), "DISCONNECTED", "CE_CONNECTIVITY_TUNNEL_UNHEALTHY"],
    [evidence({ tunnelProcess: "UNKNOWN" }), "UNKNOWN", "CE_CONNECTIVITY_TUNNEL_PROCESS_UNKNOWN"],
    [evidence({ mcpProcess: "UNKNOWN" }), "UNKNOWN", "CE_CONNECTIVITY_MCP_UNKNOWN"],
    [evidence({ sessionBinding: "unknown" }), "UNKNOWN", "CE_CONNECTIVITY_SESSION_UNKNOWN"],
  ] as const)("classifies %j as %s", (input, state, reason) => {
    expect(classifyConnectivity(input)).toEqual({ state, reason });
  });
});

describe("connectivity guard state", () => {
  it("notifies only after two consecutive explicit failures and once per incident", async () => {
    let now = 1_000; const notify = vi.fn();
    const guard = createConnectivityGuard({ now: () => now, notify });
    await guard.check(async () => evidence({ tunnelHealth: "UNHEALTHY" }));
    expect(guard.snapshot()).toMatchObject({ state: "DISCONNECTED", consecutiveFailures: 1, lastFailureAt: 1_000 });
    expect(notify).not.toHaveBeenCalled();
    now = 2_000; await guard.check(async () => evidence({ tunnelHealth: "UNHEALTHY" }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "failure", state: "DISCONNECTED", reason: "CE_CONNECTIVITY_TUNNEL_UNHEALTHY" }));
    now = 3_000; await guard.check(async () => evidence({ tunnelHealth: "UNHEALTHY" }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not count UNKNOWN as failure and breaks a consecutive failure run", async () => {
    const notify = vi.fn(); const guard = createConnectivityGuard({ now: () => 1, notify });
    await guard.check(async () => evidence({ mcpProcess: "STOPPED" }));
    await guard.check(async () => evidence({ mcpProcess: "UNKNOWN" }));
    await guard.check(async () => evidence({ mcpProcess: "STOPPED" }));
    expect(guard.snapshot()).toMatchObject({ state: "DEGRADED", consecutiveFailures: 1 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("records success and emits one recovery only for a notified incident", async () => {
    let now = 10; const notify = vi.fn(); const guard = createConnectivityGuard({ now: () => now, notify });
    await guard.check(async () => evidence());
    expect(guard.snapshot()).toMatchObject({ state: "CONNECTED", lastSuccessAt: 10, consecutiveFailures: 0 });
    now = 20; await guard.check(async () => evidence({ mcpProcess: "STOPPED" }));
    now = 30; await guard.check(async () => evidence({ mcpProcess: "STOPPED" }));
    now = 40; await guard.check(async () => evidence());
    expect(notify).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "failure" }));
    expect(notify).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "recovery", lastSuccessAt: 40 }));
    now = 50; await guard.check(async () => evidence());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("joins concurrent event and interval checks into one probe", async () => {
    const guard = createConnectivityGuard({ now: () => 1, notify: vi.fn() });
    let resolve!: (value: ConnectivityEvidence) => void;
    const probe = vi.fn(() => new Promise<ConnectivityEvidence>((done) => { resolve = done; }));
    const interval = guard.check(probe);
    const event = guard.check(probe);
    expect(probe).toHaveBeenCalledTimes(1);
    resolve(evidence());
    await expect(Promise.all([interval, event])).resolves.toEqual([expect.objectContaining({ state: "CONNECTED" }), expect.objectContaining({ state: "CONNECTED" })]);
  });
});
