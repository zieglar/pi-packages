import { expect, it } from "vitest";
import { hostRuntimeRepairMessage } from "../../src/runtime/diagnostics.js";
import { TunnelRefusal } from "../../src/tunnel/codes.js";
it("explains host/child separation with the sanitized current Node", () => {
  const message = hostRuntimeRepairMessage("v25.2.1");
  expect(message).toContain("v25.2.1");
  expect(message).toContain("v24.12.0");
  expect(message).toContain("3.51.3");
  expect(message).toContain("independently");
  expect(message).toContain("restart Pi");
  expect(message).toContain("CE_NODE_PATH");
  expect(message).toContain("child only");
  expect(hostRuntimeRepairMessage("v25\nprivate-secret")).not.toContain("private-secret");
});
it("provides static executable repair steps without configuration values", () => {
  expect(new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED").message).toContain("CE_TUNNEL_CLIENT_PATH");
  expect(new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID").message).toContain("CE_NODE_PATH");
});
