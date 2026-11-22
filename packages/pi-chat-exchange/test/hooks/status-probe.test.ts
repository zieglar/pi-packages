import { describe, expect, it } from "vitest";
import { parseHookRules } from "../../src/hooks/config.js";
import { runHookStatusProbes } from "../../src/hooks/status-probe.js";

const rule = (id: string, source: string, options: { enabled?: boolean; timeoutMs?: number; label?: string } = {}) => parseHookRules([{
  id,
  event: "ce.message.committed.v1",
  recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" },
  command: process.execPath,
  args: [],
  enabled: options.enabled ?? true,
  scope: "session",
  status: {
    label: options.label ?? id,
    command: process.execPath,
    args: ["-e", source],
    timeoutMs: options.timeoutMs ?? 2_000,
  },
}])[0]!;

describe("Hook status probes", () => {
  it("accepts exact READY and DEGRADED results in rule order", async () => {
    const results = await runHookStatusProbes([
      rule("ready", `process.stdout.write(JSON.stringify({state:"READY",code:"PLUGIN_READY"}))`),
      rule("down", `process.stdout.write(JSON.stringify({state:"DEGRADED",code:"PLUGIN_DOWN"}))`),
    ]);
    expect(results).toEqual([
      { hookId: "ready", label: "ready", scope: "session", state: "READY", code: "PLUGIN_READY" },
      { hookId: "down", label: "down", scope: "session", state: "DEGRADED", code: "PLUGIN_DOWN" },
    ]);
  });

  it("ignores disabled rules and rules without a status declaration", async () => {
    const plain = parseHookRules([{ id: "plain", event: "ce.message.committed.v1", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/usr/bin/true", scope: "session" }])[0]!;
    expect(await runHookStatusProbes([plain, rule("disabled", "process.exit(9)", { enabled: false })])).toEqual([]);
  });

  it.each([
    ["malformed output", `process.stdout.write("no")`, "PROBE_OUTPUT_INVALID"],
    ["extra output field", `process.stdout.write(JSON.stringify({state:"READY",code:"OK",extra:true}))`, "PROBE_OUTPUT_INVALID"],
    ["unsafe code", `process.stdout.write(JSON.stringify({state:"READY",code:"not safe"}))`, "PROBE_OUTPUT_INVALID"],
    ["non-zero exit", `process.exit(7)`, "PROBE_EXIT_NONZERO"],
    ["oversized output", `process.stdout.write("x".repeat(5000))`, "PROBE_OUTPUT_LIMIT"],
  ])("normalizes %s to UNKNOWN", async (_label, source, code) => {
    expect(await runHookStatusProbes([rule("bad", source)])).toEqual([
      { hookId: "bad", label: "bad", scope: "session", state: "UNKNOWN", code },
    ]);
  });

  it("times out without preventing another provider result", async () => {
    const results = await runHookStatusProbes([
      rule("slow", `setTimeout(()=>{}, 10000)`, { timeoutMs: 100 }),
      rule("ready", `process.stdout.write(JSON.stringify({state:"READY",code:"PLUGIN_READY"}))`),
    ]);
    expect(results).toEqual([
      { hookId: "slow", label: "slow", scope: "session", state: "UNKNOWN", code: "PROBE_TIMEOUT" },
      { hookId: "ready", label: "ready", scope: "session", state: "READY", code: "PLUGIN_READY" },
    ]);
  });

  it("does not expose the parent environment to providers", async () => {
    process.env.CE_STATUS_PROBE_SECRET_TEST = "secret";
    try {
      const source = `process.stdout.write(JSON.stringify({state:"READY",code:process.env.CE_STATUS_PROBE_SECRET_TEST?"LEAKED":"ENV_CLEAN"}))`;
      expect((await runHookStatusProbes([rule("env", source)]))[0]?.code).toBe("ENV_CLEAN");
    } finally {
      delete process.env.CE_STATUS_PROBE_SECRET_TEST;
    }
  });

  it("passes only the authoritative current Session identity", async () => {
    const source = `process.stdout.write(JSON.stringify({state:"READY",code:process.env.CE_PLUGIN_STATUS_RUNTIME_SESSION_ID==="runtime-A"&&process.env.CE_PLUGIN_STATUS_ENDPOINT_ID==="pi/A"?"IDENTITY_MATCH":"IDENTITY_MISSING"}))`;
    expect((await runHookStatusProbes([rule("identity", source)], { runtimeSessionId: "runtime-A", endpointId: "pi/A" }))[0]?.code).toBe("IDENTITY_MATCH");
  });
});
