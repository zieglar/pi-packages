import fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "../../storage/support/participant-fixture.js";
import { initializeLivePolicy, readLivePolicy, createLivePolicyRegistration } from "../../../src/tunnel/live-session-policy.js";
import { createCurrentRuntimeObserver } from "../../../src/tunnel/current-runtime-binding.js";
import { createEndpointRuntimeBinding } from "../../../src/tunnel/endpoint-runtime-binding.js";
import { parseMcpBindingConfig } from "../../../src/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../../src/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../src/tunnel/profile.js";
import { runRuntimeBindingCommand } from "../../../pi-extension/runtime-binding-command.js";

afterEach(cleanupFixtures);
function setup() {
  const f = fixture("bind-command-");
  const root = join(f.directory, "policy"); fs.mkdirSync(root, {mode: 0o700});
  const profilePath = join(f.directory, "profile.yaml"), keyFile = join(f.directory, "synthetic-key");
  fs.writeFileSync(keyFile, "not-live", {mode: 0o600});
  const manifest = {kind: "ce-multi-session-v1" as const, version: 1 as const, identity: {tunnelId: "tunnel_abcdefgh123456", organizationId: null},
    store: {directory: f.directory, file: f.filename}, exchange: {namespace: "bind-command", idempotencyKey: "test"},
    chatgptEndpoint: {adapter: "chatgpt", endpointId: "chatgpt/fixture"}, mcp: {payloadRead: true, ack: false},
    registrations: [{runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, status: "active" as const, payloadRead: false, ack: false}]};
  const ref = initializeLivePolicy({root, manifest}), api = createLivePolicyRegistration({ref});
  const grant = (session: string, endpoint: string) => api.register({expectedDigest: readLivePolicy(ref).digest,
    registration: {runtimeSessionId: session, endpointId: endpoint, payloadRead: false, ack: false, presenceDisclosure: true}});
  grant("A", "pi/A"); grant("B", "pi/B");
  const config = parseMcpBindingConfig({version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint,
    recipients: [{adapter: "pi", endpointId: "pi/A"}], payloadRead: {enabled: true}, ack: {enabled: false}, admissionPolicy: ref});
  fs.mkdirSync(join(f.directory, ".ce-bindings"), {mode: 0o700});
  const pair = publishMessagingGeneration(profilePath, config, {kind: "ce-live-launch-v1", version: 1, ref}, {credentialFile: keyFile});
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({tunnelId: manifest.identity.tunnelId, keyFile,
    healthUrlFile: join(f.directory, "health"), mcpCommand: buildTunnelMcpCommand({nodePath: process.execPath, scriptPath: join(f.directory, "mcp-stdio.js"), bindingPath: pair.bindingPath})})), {mode: 0o600});
  const binding = createEndpointRuntimeBinding(pair.bindingPath, config);
  const a = createCurrentRuntimeObserver(ref, "runtime-a"), b = createCurrentRuntimeObserver(ref, "runtime-b"); a.observe("A"); b.observe("B");
  let sessionId = "A", runtimeId = "runtime-a", current = true;
  const notices: string[] = [], prompts: string[] = [];
  const ctx = {hasUI: false, sessionManager: {getSessionId: () => sessionId}, ui: {
    notify: (message: string) => {notices.push(message);}, confirm: async (_title: string, text: string) => {prompts.push(text); return true;}}};
  const profileText = fs.readFileSync(profilePath, "utf8");
  const run = (args: string) => runRuntimeBindingCommand(args, ctx, {profilePath, profileText, ref, runtimeId, isCurrent: () => current});
  const revision = () => {const value = binding.read(); if (value.status === "unavailable") throw Error("unavailable"); return value.revision;};
  const explicit = (action: string, rev = revision()) => run(`${action} --expected-revision ${rev} --accept-endpoint-scope`);
  return {...f, profilePath, pair, ref, config, keyFile, binding, grant, a, b, ctx, notices, prompts, run, explicit, revision,
    setSession: (s: string) => {sessionId = s;}, setRuntime: (r: string) => {runtimeId = r;}, invalidate: () => {current = false;}};
}
it("shows scope, binds only this runtime, explicitly rebinds and revokes with CAS", async () => {
  const f = setup(), before = readLivePolicy(f.ref);
  await f.run(""); expect(f.notices.at(-1)).toContain("CE Endpoint"); expect(f.notices.at(-1)).toContain("unbound");
  await f.explicit("bind"); expect(f.binding.read()).toMatchObject({status: "bound", runtimeId: "runtime-a"});
  await f.run("status"); expect(f.notices.at(-1)).toContain("pi/A"); expect(f.notices.at(-1)).toContain("revision=");
  f.setSession("B"); f.setRuntime("runtime-b"); await f.explicit("bind"); expect(f.notices.at(-1)).toContain("USE_REBIND");
  await f.explicit("rebind"); expect(f.binding.read()).toMatchObject({status: "bound", runtimeId: "runtime-b"});
  await f.explicit("revoke"); expect(f.binding.read().status).toBe("unbound"); expect(f.revision()).not.toBe("unbound");
  expect(readLivePolicy(f.ref)).toEqual(before);
});
it("rejects stale revision without retrying or overwriting", async () => {
  const f = setup(); await f.explicit("bind"); const before = f.binding.read();
  await f.explicit("revoke", "unbound"); expect(f.notices.at(-1)).toContain("CONFLICT"); expect(f.binding.read()).toEqual(before);
});
it("requires explicit scope consent and cancels without writes", async () => {
  const f = setup(); await f.run("bind"); expect(f.notices.at(-1)).toContain("CONFIRMATION_REQUIRED");
  await f.run("bind --accept-endpoint-scope"); expect(f.notices.at(-1)).toContain("INVALID");
  f.ctx.hasUI = true; f.ctx.ui.confirm = async (_title, text) => {f.prompts.push(text); return false;};
  await f.run("bind"); expect(f.binding.read().status).toBe("unbound"); expect(f.prompts[0]).toContain("shared");
  expect(f.prompts[0]).toContain("chatgpt/fixture");
});
it("does not commit after Session or loaded context changes during confirmation", async () => {
  const f = setup(); f.ctx.hasUI = true; f.ctx.ui.confirm = async () => {f.setSession("B"); return true;};
  await f.run("bind"); expect(f.notices.at(-1)).toContain("CONTEXT_CHANGED"); expect(f.binding.read().status).toBe("unbound");
  f.setSession("A"); f.ctx.ui.confirm = async () => {f.invalidate(); return true;};
  await f.run("bind"); expect(f.notices.at(-1)).toContain("CONTEXT_CHANGED"); expect(f.binding.read().status).toBe("unbound");
});
it("uses the revision shown before confirmation even if another operator writes", async () => {
  const f = setup(); f.ctx.hasUI = true;
  f.ctx.ui.confirm = async () => {f.binding.update({runtimeId: "runtime-b", expectedRevision: "unbound", acceptEndpointScope: true}); return true;};
  await f.run("bind"); expect(f.notices.at(-1)).toContain("CONFLICT"); expect(f.binding.read()).toMatchObject({runtimeId: "runtime-b"});
});
it("refuses unknown or ambiguous current runtime and unknown caller scope", async () => {
  const f = setup(); f.a.stop(); await f.explicit("bind"); expect(f.notices.at(-1)).toContain("RUNTIME_UNAVAILABLE");
  f.a.observe("A"); const rival = createCurrentRuntimeObserver(f.ref, "runtime-a"); rival.observe("B");
  await f.explicit("bind"); expect(f.notices.at(-1)).toContain("RUNTIME_UNAVAILABLE"); rival.stop();
  await runRuntimeBindingCommand("status", f.ctx, {runtimeId: "runtime-a", isCurrent: () => true});
  expect(f.notices.at(-1)).toContain("SCOPE_UNAVAILABLE");
  await runRuntimeBindingCommand("bind --expected-revision unbound --accept-endpoint-scope", f.ctx,
    {runtimeId: "runtime-a", profilePath: f.profilePath, ref: {...f.ref, policyId: "unknown"}, isCurrent: () => true});
  expect(f.notices.at(-1)).toContain("SCOPE_UNAVAILABLE"); expect(f.binding.read().status).toBe("unbound");
});
it("keeps runtime selection across a new Session while requiring its own grant", async () => {
  const f = setup(); await f.explicit("bind"); const before = f.binding.read();
  f.setSession("new"); f.a.observe("new"); await f.run("status"); expect(f.notices.at(-1)).toContain("unknown");
  await f.explicit("rebind"); expect(f.notices.at(-1)).toContain("RUNTIME_UNAVAILABLE"); expect(f.binding.read()).toEqual(before);
  f.grant("new", "pi/new"); f.a.observe("new"); await f.run("status"); expect(f.notices.at(-1)).toContain("pi/new");
  expect(f.binding.read()).toEqual(before);
});
it("refuses an ambiguous profile launch instead of choosing the first command", async () => {
  const f = setup(), profile = fs.readFileSync(f.profilePath, "utf8");
  const command = profile.split("\n").find(line => line.startsWith("      command:"));
  expect(command).toBeDefined();
  fs.appendFileSync(f.profilePath, `\n    - channel: other\n${command}\n`);
  await runRuntimeBindingCommand("bind --expected-revision unbound --accept-endpoint-scope", f.ctx,
    {profilePath: f.profilePath, profileText: fs.readFileSync(f.profilePath, "utf8"), ref: f.ref, runtimeId: "runtime-a", isCurrent: () => true});
  expect(f.notices.at(-1)).toContain("SCOPE_UNAVAILABLE");
  expect(fs.existsSync(f.pair.bindingPath + ".runtime-binding.json")).toBe(false);
});
it("refuses a valid different launch generation selected before command invocation", async () => {
  const f = setup(), originalProfile = fs.readFileSync(f.profilePath, "utf8");
  const next = publishMessagingGeneration(f.profilePath, {...f.config, recipients: [{adapter: "pi", endpointId: "pi/B"}]},
    {kind: "ce-live-launch-v1", version: 1, ref: f.ref}, {credentialFile: f.keyFile});
  expect(next.bindingPath).not.toBe(f.pair.bindingPath);
  fs.writeFileSync(f.profilePath, originalProfile.replace(f.pair.bindingPath, next.bindingPath));
  await f.explicit("bind"); expect(f.notices.at(-1)).toContain("CONTEXT_CHANGED");
  expect(fs.existsSync(next.bindingPath + ".runtime-binding.json")).toBe(false);
  expect(fs.existsSync(f.pair.bindingPath + ".runtime-binding.json")).toBe(false);
});
it("refuses command-supplied endpoint/runtime/path and changed profile during confirmation", async () => {
  const f = setup(); await f.run("bind --endpoint chatgpt/other --accept-endpoint-scope --expected-revision unbound");
  expect(f.notices.at(-1)).toContain("INVALID"); f.ctx.hasUI = true;
  f.ctx.ui.confirm = async () => {fs.appendFileSync(f.profilePath, "\n# changed\n"); return true;};
  await f.run("bind"); expect(f.notices.at(-1)).toContain("CONTEXT_CHANGED"); expect(f.binding.read().status).toBe("unbound");
});
it("manages named groups from two explicitly selected runtimes and lists their current targets", async () => {
  const f = setup();
  await f.explicit("bind Work");expect(f.binding.readGroup("work")).toMatchObject({runtimeId: "runtime-a"});
  f.setSession("B");f.setRuntime("runtime-b");
  await f.explicit("bind review");expect(f.binding.readGroup("review")).toMatchObject({runtimeId: "runtime-b"});
  await f.run("status");expect(f.notices.at(-1)).toContain("group=work");expect(f.notices.at(-1)).toContain("group=review");
  await f.run("status work");expect(f.notices.at(-1)).toContain("pi/A");
  await f.explicit("bind work");expect(f.notices.at(-1)).toContain("USE_REBIND");
  await f.explicit("rename work REVIEW");expect(f.notices.at(-1)).toContain("GROUP_EXISTS");
  const stale = f.revision();await f.explicit("rename work build");
  expect(f.binding.readGroup("work").status).toBe("unbound");expect(f.binding.readGroup("build")).toMatchObject({runtimeId: "runtime-a"});
  await f.explicit("revoke review", stale);expect(f.notices.at(-1)).toContain("CONFLICT");
  f.ctx.hasUI = true;await f.run("rebind build");expect(f.prompts.at(-1)).toContain("group=build");
  expect(f.binding.readGroup("build")).toMatchObject({runtimeId: "runtime-b"});
  await f.explicit("revoke review");expect(f.binding.readGroup("review").status).toBe("unbound");
  expect(f.binding.read().status).toBe("unbound");
});
it("named changes reject stale consent and startup generation drift", async () => {
  const f = setup();await f.explicit("bind work");f.ctx.hasUI = true;
  f.ctx.ui.confirm = async () => {await f.explicit("bind review");return true;};
  await f.run("rename work build");expect(f.notices.at(-1)).toContain("CONFLICT");
  expect(f.binding.readGroup("work").status).toBe("bound");
  f.ctx.ui.confirm = async () => {fs.appendFileSync(f.profilePath, "\n# changed\n");return true;};
  await f.run("rebind work");expect(f.notices.at(-1)).toContain("CONTEXT_CHANGED");
});
