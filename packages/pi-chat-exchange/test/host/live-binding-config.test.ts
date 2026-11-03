import { expect, it } from "vitest";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";

const binding = () => ({ version: 1, store: { directory: "/var/lib/ce-live" },
  exchange: { namespace: "test", idempotencyKey: "live" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
  recipients: [{ adapter: "pi", endpointId: "pi/A" }],
  admissionPolicy: { kind: "ce-live-session-v1", root: "/var/lib/ce-live/policy", policyId: "policy-test", genesisDigest: "a".repeat(64) } });

it("accepts an explicit immutable live-policy reference without changing the legacy mode", () => {
  expect(parseMcpBindingConfig(binding()).admissionPolicy).toEqual(binding().admissionPolicy);
  expect(parseMcpBindingConfig({ ...binding(), admissionPolicy: { kind: "ce-multi-session-v1", profilePath: "/var/lib/ce/tunnel.yaml" } }).admissionPolicy)
    .toEqual({ kind: "ce-multi-session-v1", profilePath: "/var/lib/ce/tunnel.yaml" });
});

it("refuses unknown fields, unsafe roots and unpinned genesis references", () => {
  for (const change of [{ root: "relative" }, { root: "/var/lib/../escape" }, { genesisDigest: "unknown" }, { extra: true }, { policyId: "cap_" + "a".repeat(64) }]) {
    expect(() => parseMcpBindingConfig({ ...binding(), admissionPolicy: { ...binding().admissionPolicy, ...change } })).toThrow();
  }
});
