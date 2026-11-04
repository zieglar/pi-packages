import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initializeStore } from "../../src/storage/store.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { initializeLivePolicy, prepareLivePolicyUpgrade, createLivePolicyRegistration, readLivePolicy } from "../../src/tunnel/live-session-policy.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it.each(["A", "B"])("real MCP process adopts sender consent once, denies ABA, and serves target %s with a static A launch", { timeout: 60_000 }, async target => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-hook-stdio-v2-"))); dirs.push(dir); fs.chmodSync(dir, 0o700);
  const root = join(dir, "policy"); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml"); const keyFile = join(dir, "credential"); fs.writeFileSync(keyFile, "synthetic", { mode: 0o600 });
  const store = initializeStore({ directory: dir, filename: "ce.sqlite" });
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: dir, file: "ce.sqlite" }, exchange: { namespace: "hooks-v2", idempotencyKey: "test" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1, status: "active" as const, payloadRead: true, ack: true }] };
  const v1 = initializeLivePolicy({ root, manifest }); const ref = prepareLivePolicyUpgrade(v1, profilePath); const api = createLivePolicyRegistration({ ref });
  const marker = join(dir, "fixture-events.jsonl");
  const targetEndpoint = `pi/${target}`;
  const fixturePath = join(dir, "fixture.cjs"); fs.writeFileSync(fixturePath, 'let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",()=>require("node:fs").appendFileSync(process.argv[2],data+"\\n"));', { mode: 0o600 });
  const config = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint, recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true }, admissionPolicy: ref,
    hooks: [{ id: "fixture", event: "ce.message.committed.v1", recipient: { adapter: "pi", endpointId: targetEndpoint }, command: process.execPath, args: [fixturePath, marker], timeoutMs: 2000, enabled: true }] });
  const pair = publishMessagingGeneration(profilePath, config, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: keyFile });
  const bindingGeneration = basename(pair.bindingPath).slice(10, -5);
  api.upgrade({ expectedDigest: readLivePolicy(v1).digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration });
  if (target === "B") api.register({ expectedDigest: readLivePolicy(ref).digest, registration: { endpointId: targetEndpoint, runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: false } });
  expect(config.recipients).toEqual([{ adapter: "pi", endpointId: "pi/A" }]);
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: manifest.identity.tunnelId, keyFile, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(process.cwd(), "dist/bin/mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  const targets = [{ ruleId: "fixture", endpointId: targetEndpoint, runtimeSessionId: `native-${target}`, epoch: 1 }];
  const consent = (enabled: boolean) => api.setMcpHooks({ expectedDigest: readLivePolicy(ref).digest, actorRuntimeSessionId: "operator", bindingGeneration, targets: enabled ? targets : [] });
  const host = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: targetEndpoint }], recipients: [manifest.chatgptEndpoint], exchangeNamespace: manifest.exchange.namespace, exchangeIdempotencyKey: manifest.exchange.idempotencyKey, payloadRead: { enabled: true } });
  host.beginSession(targetEndpoint);
  const records = () => fs.existsSync(join(dir, "ce-hooks/executions.jsonl")) ? fs.readFileSync(join(dir, "ce-hooks/executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { messageId: string; status: string }) : [];
  async function connect() {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/bin/mcp-stdio.js"), "--config", pair.bindingPath], env: { PATH: "/usr/bin:/bin", ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }) }, stderr: "pipe" });
    let diagnostics = ""; transport.stderr?.on("data", data => { diagnostics += String(data); });
    const client = new Client({ name: "hooks-v2-local-fixture", version: "1" }); await client.connect(transport);
    return { client, async close() { await client.close(); await transport.close(); await vi.waitFor(() => expect(diagnostics).toContain("CE_MCP_STOPPED released=true detached=true"), { timeout: 5000 }); } };
  }
  async function send(client: Client, key: string, status: string) {
    const result = await client.callTool({ name: "ce_send", arguments: { to: targetEndpoint, idempotencyKey: key, text: "synthetic-private-payload" } });
    expect(result.isError).not.toBe(true); const { messageId } = result.structuredContent as { messageId: string };
    expect(host.readPayload(targetEndpoint, { messageId }).payloadText).toBe("synthetic-private-payload");
    await vi.waitFor(() => expect(records()).toContainEqual(expect.objectContaining({ messageId, status })), { timeout: 5000 });
  }
  try {
    const unapproved = await connect();
    try { await send(unapproved.client, "before-consent", "SKIPPED_POLICY_DENIED"); consent(true); await send(unapproved.client, "after-consent-same-process", "SKIPPED_POLICY_DENIED"); }
    finally { await unapproved.close(); }
    const approved = await connect();
    try {
      await send(approved.client, "fresh-approved", "SUCCEEDED");
      const metadata = fs.readFileSync(marker, "utf8"); expect(metadata).not.toContain("synthetic-private-payload");
      expect(Object.keys(JSON.parse(metadata.trim()))).toEqual(["schemaVersion", "event", "eventId", "eventKey", "messageId", "exchangeId", "sender", "recipient", "createdAt", "payloadDigest", "payloadLength"]);
      consent(false); await send(approved.client, "disabled", "SKIPPED_POLICY_DENIED");
      consent(true); await send(approved.client, "restored-old-process", "SKIPPED_POLICY_DENIED");
    } finally { await approved.close(); }
    const fresh = await connect(); try { await send(fresh.client, "restored-new-process", "SUCCEEDED"); } finally { await fresh.close(); }
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(2);
  } finally { host.end(targetEndpoint); store.close(); }
});
