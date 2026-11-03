import { expect, it, vi } from "vitest";
vi.mock("../../../dist/tunnel/live-session-policy.js", () => ({ readLivePolicy: vi.fn() }));
import { projectLivePiRegistration } from "../../../pi-extension/live-session-profile.js";
import { buildPiAllowlistDocument } from "../../../src/tunnel/messaging-config.js";

it("projects exactly the existing Pi allowlist shape for one native Session", () => {
  const store = { directory: "/var/lib/ce", file: "ce-store.sqlite" };
  const peer = { adapter: "chatgpt", endpointId: "chatgpt/main" };
  const own = { endpointId: "pi/A", runtimeSessionId: "native-A", status: "active", payloadRead: true, ack: true };
  const snapshot = { manifest: { store, exchange: { namespace: "test", idempotencyKey: "test" }, chatgptEndpoint: peer,
    registrations: [own, { ...own, endpointId: "pi/B", runtimeSessionId: "native-B" }] } };
  expect(projectLivePiRegistration(snapshot as never, "native-A")).toEqual(buildPiAllowlistDocument({
    chatgptEndpoint: peer, piEndpoint: { adapter: "pi", endpointId: "pi/A" }, piSessionId: "native-A", store,
    exchangeNamespace: "test", exchangeIdempotencyKey: "test", payloadRead: true, ack: true,
  }));
  expect(() => projectLivePiRegistration(snapshot as never, "unregistered")).toThrow();
});
