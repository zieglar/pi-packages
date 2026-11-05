import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeStore } from "../../../dist/storage/store.js";
import { initializeLivePolicy, readLivePolicy, createLivePolicyRegistration, type LiveSnapshot } from "../../../dist/tunnel/live-session-policy.js";
import { publishMessagingGeneration } from "../../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { parseMcpBindingConfig } from "../../../dist/host/mcp-binding-config.js";
import type { CeMappingIdentifiers } from "../../../dist/endpoints/pi/session-host.js";
import { PiSessionPolicy, isLivePolicy } from "../../../pi-extension/live-session-runtime.js";
import { readLiveSelectedSessionPolicy } from "../../../pi-extension/live-session-profile.js";
import { runtimeHasFailed } from "../../../pi-extension/multi-session-runtime.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture(change: "none" | "sidecar" | "identity" | "store" | "exchange" | "endpoint" | "ceiling" | "limited" = "none") {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-pi-live-runtime-"))); dirs.push(dir); fs.chmodSync(dir, 0o700);
  const root = join(dir, "policy"); fs.mkdirSync(root, { mode: 0o700 });
  const store = { directory: dir, file: "ce.sqlite" }; initializeStore({ directory: dir, filename: store.file }).close();
  const identity = { tunnelId: "tunnel_abcdefgh123456", organizationId: null };
  const exchange = { namespace: "test", idempotencyKey: "test" }; const chatgptEndpoint = { adapter: "chatgpt", endpointId: "chatgpt/main" };
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const, identity, store, exchange, chatgptEndpoint,
    mcp: { payloadRead: change !== "limited", ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, epoch: 1, status: "active" as const }] };
  const ref = initializeLivePolicy({ root, manifest });
  const config = parseMcpBindingConfig({ version: 1, store: change === "store" ? { ...store, file: "other.sqlite" } : store,
    exchange: change === "exchange" ? { ...exchange, namespace: "other" } : exchange,
    endpoint: change === "endpoint" ? { ...chatgptEndpoint, endpointId: "chatgpt/other" } : chatgptEndpoint, recipients: [{ adapter: "pi", endpointId: "pi/A" }],
    payloadRead: { enabled: change !== "ceiling" && change !== "limited" }, ack: { enabled: true }, admissionPolicy: ref, managed: { tunnelId: identity.tunnelId, adapter: "chatgpt" } });
  const credential = join(dir, "credential"); fs.writeFileSync(credential, "synthetic", { mode: 0o600 });
  const profilePath = join(dir, "tunnel.yaml");
  fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const sidecar = { kind: "ce-live-launch-v1", version: 1, ref, ...(change === "sidecar" ? { extra: true } : {}) };
  const pair = publishMessagingGeneration(profilePath, config, sidecar, { credentialFile: credential });
  const profileText = serializeTunnelProfile(buildTunnelProfile({ tunnelId: change === "identity" ? "tunnel_abcdefgh654321" : identity.tunnelId, keyFile: credential,
    healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: pair.bindingPath }) }));
  fs.writeFileSync(profilePath, profileText, { mode: 0o600 });
  const loaded = readLiveSelectedSessionPolicy(profilePath, profileText)!;
  return { dir, root, ref, store, loaded, pair, profilePath, profileText,
    api: createLivePolicyRegistration({ ref, credentialFile: credential }) };
}
it.each(["sidecar", "identity", "store", "exchange", "endpoint", "ceiling"] as const)("refuses digest-valid selected %s mismatch or incomplete ceiling", change => {
  expect(() => fixture(change)).toThrow();
});

it("reads a consistent limited launch for passive status without widening its ceiling", () => {
  const f = fixture("limited");
  const selected = readLiveSelectedSessionPolicy(f.profilePath, f.profileText);
  expect(selected?.manifest.mcp).toEqual({ payloadRead: false, ack: true });
  expect(selected).toEqual(f.loaded);
});

const mapping: CeMappingIdentifiers = { endpointId: "pi/A", participantId: "part-A", sessionId: "session-A", exchangeId: "exchange-A" };
function runtime(loaded: LiveSnapshot, reload = false) { return new PiSessionPolicy(loaded, "native-A", () => "native-A", reload, mapping); }

it("selects only a verified live sidecar and checks global launch identity and ceilings before use", () => {
  const f = fixture(); expect(readLiveSelectedSessionPolicy(f.profilePath, f.profileText)).toEqual(f.loaded);
  for (const sidecar of [{ ...JSON.parse(fs.readFileSync(f.pair.allowlistPath, "utf8")), extra: true }, { ...f.loaded.ref },
    { ...f.loaded.manifest }, { kind: "ce-multi-session-v1" }]) {
    fs.writeFileSync(f.pair.allowlistPath, JSON.stringify(sidecar), { mode: 0o600 });
    expect(() => readLiveSelectedSessionPolicy(f.profilePath, f.profileText)).toThrow();
  }
});

it("captures read and ACK generations independently through true false true and reloads the same mutex", async () => {
  const f = fixture(); const original = runtime(f.loaded); let calls = 0;
  expect(original.run("payload", () => ++calls)).toBe(1); expect(original.run("ack", () => ++calls)).toBe(2);
  const next = (payloadRead: boolean, ack: boolean) => f.api.register({ expectedDigest: readLivePolicy(f.ref).digest,
    registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead, ack, presenceDisclosure: false } }).snapshot;
  next(false, true); next(true, true);
  expect(() => original.run("payload", () => ++calls)).toThrow(); expect(original.run("ack", () => ++calls)).toBe(3);
  next(false, false); next(true, true);
  for (const kind of ["payload", "ack"]) expect(() => original.run(kind, () => ++calls)).toThrow();
  expect(original.loaded).toBe(f.loaded); expect(original.registration()).toMatchObject({ payloadRead: false, ack: false });
  original.closeAdmission(); await original.drain(); original.transfer(mapping);
  const current = original.current(); if (!isLivePolicy(current)) throw Error("expected live"); const reloaded = runtime(current, true);
  expect(reloaded.loaded).toBe(current); expect(reloaded.registration()).toMatchObject({ payloadRead: true, ack: true });
  expect(reloaded.run("payload", () => ++calls)).toBe(4); expect(reloaded.run("ack", () => ++calls)).toBe(5);
  expect(() => original.run("metadata", () => ++calls)).toThrow();
  reloaded.closeAdmission(); await reloaded.drain(); reloaded.release({ released: true, detached: true });
}, 30_000);

it("explicit reauthorization increments epoch and never revives an old runtime", async () => {
  const f = fixture(); const original = runtime(f.loaded);
  f.api.revoke({ expectedDigest: readLivePolicy(f.ref).digest, endpointId: "pi/A" });
  f.api.reauthorize({ expectedDigest: readLivePolicy(f.ref).digest, registration: {
    endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: false } });
  const current = original.current(); if (!isLivePolicy(current)) throw Error("expected live");
  expect(current.manifest.registrations[0]?.epoch).toBe(2);
  for (const kind of ["metadata", "payload", "ack"]) expect(() => original.run(kind, () => 42)).toThrow();
  original.closeAdmission(); await original.drain(); original.release({ released: true, detached: true });
  const fresh = runtime(current); expect(fresh.run("payload", () => 42)).toBe(42);
  fresh.closeAdmission(); await fresh.drain(); fresh.release({ released: true, detached: true });
});
it("excludes the selected credential identity on every current read", async () => {
  const f = fixture(); const original = runtime(f.loaded);
  const credential = join(f.dir, "credential");
  fs.unlinkSync(credential); fs.renameSync(join(f.root, "000000.json"), credential);
  fs.linkSync(credential, join(f.root, "000000.json"));
  expect(() => original.current()).toThrow();
  original.closeAdmission(); await original.drain(); original.release({ released: true, detached: true });
});

it("uses one credential-aware reader watermark and refuses an observed suffix regression", async () => {
  const f = fixture(); const original = runtime(f.loaded);
  f.api.register({ expectedDigest: readLivePolicy(f.ref).digest,
    registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: false, ack: false, presenceDisclosure: false } });
  expect(original.current()).toMatchObject({ sequence: 1 });
  fs.unlinkSync(join(f.root, "000001.json"));
  expect(() => original.current()).toThrow(); expect(() => original.run("metadata", () => undefined)).toThrow();
  original.closeAdmission(); await original.drain(); original.release({ released: true, detached: true });
});

it("reads a native Session failure across Store and Endpoint scopes without clearing it", async () => {
  const first = fixture(), second = fixture();
  const failed = runtime(first.loaded);
  failed.fail();
  const otherEndpoint = { ...second.loaded, manifest: { ...second.loaded.manifest,
    registrations: second.loaded.manifest.registrations.map(r => ({ ...r, endpointId: "pi/B" })) } };
  try {
    expect(runtimeHasFailed(first.loaded, "native-A")).toBe(true);
    expect(runtimeHasFailed(second.loaded, "native-A")).toBe(false);
    expect(runtimeHasFailed(second.loaded, "native-A", true)).toBe(true);
    expect(runtimeHasFailed(otherEndpoint, "native-A", true)).toBe(true);
    expect(runtimeHasFailed(second.loaded, "unrelated-native", true)).toBe(false);
    expect(runtimeHasFailed(first.loaded, "native-A")).toBe(true);
  } finally {
    failed.closeAdmission(); await failed.drain(); failed.release({ released: true, detached: true });
  }
});
