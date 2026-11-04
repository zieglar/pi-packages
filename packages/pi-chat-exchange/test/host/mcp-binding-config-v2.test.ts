import { expect, it } from "vitest";
import { parseMcpBindingConfig } from "../../dist/host/mcp-binding-config.js";
const ref = { kind: "ce-live-session-v2", root: "/private/policy", policyId: "policy-test", genesisDigest: "a".repeat(64), profilePath: "/private/tunnel.yaml", upgradeSequence: 3 };
const config = { version: 1, store: { directory: "/private/store", file: "ce.sqlite" }, exchange: { namespace: "test", idempotencyKey: "test" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: [{ adapter: "pi", endpointId: "pi/A" }], admissionPolicy: ref };
it("accepts only the explicit pinned v2 reference shape", () => {
  expect(parseMcpBindingConfig(config).admissionPolicy).toEqual(ref);
});
it.each([{ upgradeSequence: 0 }, { upgradeSequence: 65537 }, { upgradeSequence: 1.5 }, { profilePath: "relative" }, { profilePath: "/private/../other" }, { extra: true }])("refuses malformed v2 reference %j", change => {
  expect(() => parseMcpBindingConfig({ ...config, admissionPolicy: { ...ref, ...change } })).toThrow();
});
it("does not admit successor reference fields into the original v1 kind", () => {
  expect(() => parseMcpBindingConfig({ ...config, admissionPolicy: { ...ref, kind: "ce-live-session-v1" } })).toThrow();
});
