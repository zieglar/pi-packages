import fs from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach, expect, it} from "vitest";
import {fixture, cleanupFixtures} from "../storage/support/participant-fixture.js";
import {initializeLivePolicy, readLivePolicy, createLivePolicyRegistration} from "../../src/tunnel/live-session-policy.js";
import {createCurrentRuntimeObserver, discoverCurrentRuntimes, CURRENT_RUNTIME_TTL_MS} from "../../src/tunnel/current-runtime-binding.js";

afterEach(cleanupFixtures);
it("normal stops leave no observer records and expired history cannot hide live conflicts", () => {
  const f = fixture("current-history-"); const root = join(f.directory, "policy"); fs.mkdirSync(root, {mode: 0o700});
  const ref = initializeLivePolicy({root, manifest: {kind: "ce-multi-session-v1", version: 1, identity: {tunnelId: "tunnel_abcdefgh123456", organizationId: null}, store: {directory: f.directory, file: f.filename}, exchange: {namespace: "history", idempotencyKey: "test"}, chatgptEndpoint: {adapter: "chatgpt", endpointId: "chatgpt/main"}, mcp: {payloadRead: true, ack: true}, registrations: [{runtimeSessionId: "seed", endpointId: "pi/seed", epoch: 1, status: "revoked", payloadRead: false, ack: false}]}});
  const api = createLivePolicyRegistration({ref});api.register({expectedDigest: readLivePolicy(ref).digest, registration: {runtimeSessionId: "A", endpointId: "pi/A", presenceDisclosure: true, payloadRead: false, ack: false}});
  const now = Date.now(), directory = join(root, "current-runtimes");
  const a = createCurrentRuntimeObserver(ref, "main", () => now);a.observe("A");
  const template = JSON.parse(fs.readFileSync(join(directory, fs.readdirSync(directory)[0]!), "utf8"));
  a.stop();expect(fs.readdirSync(directory)).toEqual([]);
  for (let i = 0; i < 300; i++) {
    const observerId = randomUUID(); const value = {...template, observerId, observedAt: now - CURRENT_RUNTIME_TTL_MS - 10, expiresAt: now - 10, state: i % 2 ? "current" : "stopped"};
    fs.writeFileSync(join(directory, observerId + ".json"), JSON.stringify(value), {mode: 0o600});
  }
  a.observe("A");const query = () => discoverCurrentRuntimes(readLivePolicy(ref), ["pi/A"], "main", now);
  expect(query().currentBinding).toMatchObject({status: "verified", endpointId: "pi/A"});
  const b = createCurrentRuntimeObserver(ref, "main", () => now);b.observe("A");
  expect(query().currentBinding).toEqual({status: "ambiguous", runtimeId: "main"});
  b.stop();expect(query().currentBinding).toMatchObject({status: "verified", endpointId: "pi/A"});
  a.stop();expect(query().currentBinding?.status).toBe("unknown");
  expect(fs.readdirSync(directory)).toHaveLength(300);
});
