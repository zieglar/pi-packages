import { createHash } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../src/hooks/events.js";
import { parseHookRules } from "../../src/hooks/config.js";
import { CeHookRunner } from "../../src/hooks/runner.js";
import { initializeStore } from "../../src/storage/store.js";
import { ensureManagedBinding } from "../../src/tunnel/managed-binding.js";
import { publishMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";
import * as policy from "../../src/tunnel/multi-session-policy.js";

const PI = "pi/A";
const CHATGPT = "chatgpt/main";
const NOW = "2026-10-10T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup() {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-multi-hook-integration-"));
  fs.chmodSync(dir, 0o700);
  const profilePath = join(dir, "tunnel.yaml");
  const script = join(dir, "notify.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs';
const event = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.argv[2], JSON.stringify(event) + '\\n');
if (process.argv[3]) {
  while (!fs.existsSync(process.argv[3])) await new Promise(r => setTimeout(r, 10));
}
`, { mode: 0o600 });
  const fail = join(dir, "fail.mjs");
  fs.writeFileSync(fail, "process.exit(9)", { mode: 0o600 });
  const outputPi = join(dir, "pi.jsonl");
  const outputChatgpt = join(dir, "chatgpt.jsonl");
  const release = join(dir, "release");
  const rule = (id: string, adapter: string, endpointId: string, args: string[]) => ({ id, event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter, endpointId }, command: process.execPath, args });
  const piRules = parseHookRules([rule("pi-notify", "chatgpt", CHATGPT, [script, outputChatgpt])]);
  const mcpRules = parseHookRules([
    rule("mcp-notify", "pi", PI, [script, outputPi, release]),
    rule("mcp-fail", "pi", PI, [fail]),
  ]);
  const binding = ensureManagedBinding(profilePath, { tunnelId: "tunnel_abcdefgh123456", organizationId: undefined, adapter: "chatgpt", endpointId: CHATGPT, recipients: [{ adapter: "pi", endpointId: PI }], capabilities: { payloadRead: true, ack: true } });
  const config = { ...binding.config, store: { directory: join(dir, "store"), file: "store.sqlite" }, hooks: mcpRules, admissionPolicy: { kind: "ce-multi-session-v1" as const, profilePath } };
  const manifest: policy.MultiSessionManifest = {
    kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
    store: config.store, exchange: config.exchange, chatgptEndpoint: config.endpoint,
    mcp: { payloadRead: true, ack: true },
    registrations: [{ endpointId: PI, runtimeSessionId: "real-A", epoch: 1, status: "active", payloadRead: true, ack: true, hooks: piRules }],
  };
  function select(nextConfig = config, nextManifest = manifest) {
    const pair = publishMessagingGeneration(profilePath, nextConfig, { ...nextManifest });
    fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: join(dir, "NEVER-READ-CREDENTIAL"), healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(dir, "mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
    return policy.readSelectedMultiSessionPolicy(profilePath);
  }
  const loaded = select();
  const current = () => policy.readSelectedMultiSessionPolicy(profilePath);
  const store = initializeStore({ directory: config.store.directory, filename: config.store.file, now: () => NOW });
  const runners: CeHookRunner[] = [];
  cleanups.push(async () => {
    fs.writeFileSync(release, "release");
    await Promise.all(runners.map(r => r.close()));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const piRunner = new CeHookRunner({ directory: dir, rules: policy.effectivePiHookRules(loaded, loaded, "real-A"), admit: rule => policy.effectivePiHookRules(loaded, current(), "real-A").includes(rule) });
  const mcpRunner = new CeHookRunner({ directory: dir, rules: policy.effectiveMcpHookRules(loaded, loaded), admit: rule => policy.effectiveMcpHookRules(loaded, current()).includes(rule) });
  runners.push(piRunner, mcpRunner);
  const common = { exchangeNamespace: config.exchange.namespace, exchangeIdempotencyKey: config.exchange.idempotencyKey, payloadRead: { enabled: true }, ack: { enabled: true }, now: () => NOW };
  const chatgpt = new CeEndpointHost(store, { ...common, adapter: "chatgpt", allowlist: [{ endpointId: CHATGPT }], recipients: config.recipients, onMessageCommitted: event => mcpRunner.publish(event) });
  const pi = new CeEndpointHost(store, { ...common, adapter: "pi", allowlist: [{ endpointId: PI }], recipients: [config.endpoint], onMessageCommitted: event => piRunner.publish(event) });
  chatgpt.beginSession(CHATGPT); pi.beginSession(PI);
  const rows = (path: string): Array<Record<string, unknown>> => fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const log = () => rows(join(dir, "ce-hooks", "executions.jsonl"));
  return { dir, profilePath, loaded, current, select, config, manifest, store, chatgpt, pi, piRunner, mcpRunner, runners, release, outputPi, outputChatgpt, rows, log };
}

it("uses a selected immutable multi-session pair for real bidirectional notifications, payload and ACK despite a failing hook", async () => {
  const f = setup();
  expect(fs.statSync(f.dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(f.profilePath).mode & 0o777).toBe(0o600);
  expect(fs.statSync(f.loaded.bindingPath).mode & 0o777).toBe(0o600);
  expect(policy.projectPiRegistration(f.loaded, "real-A")).toHaveProperty("hooks", f.manifest.registrations[0]!.hooks);
  fs.writeFileSync(f.release, "go");
  const payload = "# 双向 🚀\r\n  indented\ntrailing  \n";
  const sent = f.chatgpt.send(CHATGPT, { to: PI, text: payload, idempotencyKey: "outbound" });
  const reply = f.pi.send(PI, { to: CHATGPT, text: "Pi → ChatGPT ✓", idempotencyKey: "reply" });
  await vi.waitFor(() => {
    expect(f.rows(f.outputPi)).toHaveLength(1);
    expect(f.rows(f.outputChatgpt)).toHaveLength(1);
    expect(f.log()).toContainEqual(expect.objectContaining({ hookId: "mcp-fail", status: "FAILED", exitCode: 9 }));
  });
  expect(f.rows(f.outputPi)[0]).toMatchObject({ messageId: sent.messageId, sender: { adapter: "chatgpt", endpointId: CHATGPT }, recipient: { adapter: "pi", endpointId: PI } });
  expect(f.rows(f.outputChatgpt)[0]).toMatchObject({ messageId: reply.messageId, sender: { adapter: "pi", endpointId: PI }, recipient: { adapter: "chatgpt", endpointId: CHATGPT } });
  const read = f.pi.readPayload(PI, { messageId: sent.messageId });
  expect(read.payloadText).toBe(payload);
  expect(read.payloadDigest).toBe(createHash("sha256").update(payload).digest("hex"));
  expect(read.payloadLength).toBe(Buffer.byteLength(payload));
  const raw = f.store.database.prepare("SELECT payload_body FROM message WHERE message_id=?").get(sent.messageId)!.payload_body;
  expect(Buffer.from(raw as Uint8Array)).toEqual(Buffer.from(payload));
  expect(f.pi.acknowledge(PI, { messageId: sent.messageId, payloadDigest: read.payloadDigest, payloadLength: read.payloadLength, messageCreatedAuditSequence: read.auditSequence }).disposition).toBe("CREATED");
  expect(f.chatgpt.send(CHATGPT, { to: PI, text: payload, idempotencyKey: "outbound" }).disposition).toBe("REPLAYED");
  await Promise.all(f.runners.map(r => r.close()));
  expect(f.rows(f.outputPi)).toHaveLength(1);
  expect(JSON.stringify(f.rows(f.outputPi))).not.toContain("双向");
});

it("rechecks selected current policy before queued spawn and fails closed after revoke or unknown runtime", async () => {
  const f = setup();
  const first = f.chatgpt.send(CHATGPT, { to: PI, text: "first", idempotencyKey: "first" });
  await vi.waitFor(() => expect(f.rows(f.outputPi)).toHaveLength(1));
  const queued = f.chatgpt.send(CHATGPT, { to: PI, text: "queued", idempotencyKey: "queued" });
  const revoked = { ...f.manifest, registrations: f.manifest.registrations.map(r => ({ ...r, status: "revoked" as const })) };
  f.select({ ...f.config, recipients: [], hooks: [] }, revoked);
  expect(f.mcpRunner.snapshot().active).toBe(0);
  expect(f.piRunner.snapshot().active).toBe(0);
  expect(() => policy.effectivePiHookRules(f.loaded, f.current(), "unknown-runtime")).toThrow();
  expect(() => f.pi.send("pi/unknown", { to: CHATGPT, text: "unknown", idempotencyKey: "unknown" })).toThrow();
  fs.writeFileSync(f.release, "go");
  await vi.waitFor(() => expect(f.log()).toContainEqual(expect.objectContaining({ messageId: queued.messageId, hookId: "mcp-notify", status: "SKIPPED_POLICY_DENIED" })));
  // A throwing current-policy lookup is contained by Runner, after a real Store commit.
  f.pi.send(PI, { to: CHATGPT, text: "revoked hook only", idempotencyKey: "revoked" });
  await vi.waitFor(() => expect(f.log()).toContainEqual(expect.objectContaining({ hookId: "pi-notify", status: "SKIPPED_POLICY_DENIED" })));
  await Promise.all(f.runners.map(r => r.close()));
  expect(f.rows(f.outputPi).map(row => row.messageId)).toEqual([first.messageId]);
  expect(f.rows(f.outputChatgpt)).toEqual([]);
  expect(f.pi.readPayload(PI, { messageId: queued.messageId }).payloadText).toBe("queued");
});

it("current additions cannot widen loaded rules and changing a static command narrows both directions", async () => {
  const f = setup();
  const addedPi = { ...f.manifest.registrations[0]!.hooks![0]!, id: "new-pi" };
  const addedMcp = { ...f.config.hooks[0]!, id: "new-mcp" };
  const wider = f.select({ ...f.config, hooks: [...f.config.hooks, addedMcp] }, { ...f.manifest, registrations: f.manifest.registrations.map(r => ({ ...r, hooks: [...r.hooks!, addedPi] })) });
  expect(policy.effectivePiHookRules(f.loaded, wider, "real-A").map(r => r.id)).toEqual(["pi-notify"]);
  expect(policy.effectiveMcpHookRules(f.loaded, wider).map(r => r.id)).toEqual(["mcp-notify", "mcp-fail"]);
  const changed = f.select({ ...f.config, hooks: f.config.hooks.map(r => ({ ...r, args: [...r.args, "changed"] })) }, { ...f.manifest, registrations: f.manifest.registrations.map(r => ({ ...r, hooks: r.hooks!.map(h => ({ ...h, args: [...h.args, "changed"] })) })) });
  expect(policy.effectivePiHookRules(f.loaded, changed, "real-A")).toEqual([]);
  expect(policy.effectiveMcpHookRules(f.loaded, changed)).toEqual([]);
  f.chatgpt.send(CHATGPT, { to: PI, text: "no scripts", idempotencyKey: "narrowed-mcp" });
  f.pi.send(PI, { to: CHATGPT, text: "no scripts", idempotencyKey: "narrowed-pi" });
  await vi.waitFor(() => expect(f.log().filter(row => row.status === "SKIPPED_POLICY_DENIED")).toHaveLength(3));
  expect(f.rows(f.outputPi)).toEqual([]);
  expect(f.rows(f.outputChatgpt)).toEqual([]);
});
