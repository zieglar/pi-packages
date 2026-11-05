import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { initializeStore } from "../../../dist/storage/store.js";
import { initializeLivePolicy, prepareLivePolicyUpgrade, createLivePolicyRegistration, readLivePolicy } from "../../../dist/tunnel/live-session-policy.js";
import { parseMcpBindingConfig } from "../../../dist/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { parseHookRules } from "../../../dist/hooks/config.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

it.each([false, true])("actual Pi extension keeps outbound messaging through Hook ABA and reload; changed incarnation=%s", { timeout: 20_000 }, async changedIncarnation => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-extension-hooks-v2-"))); fs.chmodSync(dir, 0o700);
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  sessionManager.appendMessage({ role: "user", content: "Synthetic Hook persistence fixture", timestamp: Date.now() });
  const nativeId = sessionManager.getSessionId();
  const root = join(dir, "policy"); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml"); const keyFile = join(dir, "credential"); fs.writeFileSync(keyFile, "synthetic", { mode: 0o600 });
  const store = initializeStore({ directory: dir, filename: "ce.sqlite" });
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: dir, file: "ce.sqlite" }, exchange: { namespace: "hooks-v2-pi", idempotencyKey: "test" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: nativeId, epoch: 1, status: "active" as const, payloadRead: true, ack: true }] };
  const v1 = initializeLivePolicy({ root, manifest }); const ref = prepareLivePolicyUpgrade(v1, profilePath); const api = createLivePolicyRegistration({ ref });
  const config = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint, recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true }, admissionPolicy: ref });
  const pair = publishMessagingGeneration(profilePath, config, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: keyFile });
  api.upgrade({ expectedDigest: readLivePolicy(v1).digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: manifest.identity.tunnelId, keyFile, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(process.cwd(), "dist/bin/mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  const output = join(dir, "fixture-events.jsonl"); const script = join(dir, "fixture.cjs");
  fs.writeFileSync(script, 'let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",()=>require("node:fs").appendFileSync(process.argv[2],data+"\\n"));', { mode: 0o600 });
  const hooks = parseHookRules([{ id: "fixture", event: "ce.message.committed.v1", recipient: manifest.chatgptEndpoint, command: process.execPath, args: [script, output], timeoutMs: 2000, enabled: true }]);
  const setHooks = (enabled: boolean) => api.setPiHooks({ expectedDigest: readLivePolicy(ref).digest, runtimeSessionId: nativeId, endpointId: "pi/A", epoch: 1, hooks: enabled ? hooks : [] });
  setHooks(true);
  vi.stubEnv("CE_ALLOWLIST", ""); vi.stubEnv("CE_TUNNEL_PROFILE", profilePath); vi.stubEnv("CE_STORE_DIR", ""); vi.stubEnv("CE_STORE_FILE", "");
  const entries = () => sessionManager.getEntries().filter(entry => entry.type === "custom");
  const ctx = { mode: "tui", hasUI: true, cwd: dir, sessionManager, ui: { notify: vi.fn() } };
  const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
  function extension() {
    const events = new Map<string, (event: { reason: string }, context: typeof ctx) => Promise<void>>();
    const tools = new Map<string, { execute(...args: any[]): Promise<{ isError?: boolean; structuredContent?: unknown }> }>();
    factory({ on: (name: string, handler: any) => events.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: vi.fn(), appendEntry: (customType: string, data: unknown) => sessionManager.appendCustomEntry(customType, data) });
    return { start: (reason: string) => events.get("session_start")!({ reason }, ctx), stop: (reason: string) => events.get("session_shutdown")!({ reason }, ctx), send: (key: string) => tools.get("ce_send")!.execute(key, { to: "chatgpt/main", text: "PRIVATE_FIXTURE_PAYLOAD", idempotencyKey: key }, undefined, undefined, ctx) };
  }
  const rows = () => fs.existsSync(join(dir, "ce-hooks/executions.jsonl")) ? fs.readFileSync(join(dir, "ce-hooks/executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { messageId: string; status: string }).filter(row => row.status !== "STARTED") : [];
  const ownership = () => store.database.prepare("SELECT participant_id, session_id, fencing_token FROM participant_ownership").all();
  const durableSessions = () => store.database.prepare("SELECT * FROM participant_session").all();
  let current = extension();
  try {
    await current.start("startup");
    const mapping = entries().findLast(entry => entry.customType === "ce-mapping")?.data; expect(mapping).toBeDefined();
    const originalOwner = ownership(); expect(originalOwner).toHaveLength(1); const originalSessions = durableSessions();
    async function send(key: string, status: string) {
      const before = rows().length;
      const result = await current.send(key); expect(result.isError).not.toBe(true);
      await vi.waitFor(() => { expect(rows()).toHaveLength(before + 1); expect(rows().at(-1)?.status).toBe(status); }, { timeout: 5000 });
      return result;
    }
    await send("initial", "SUCCEEDED");
    setHooks(false); const beforeDisabled = rows().length; await send("disabled", "SKIPPED_POLICY_DENIED"); expect(rows().length).toBeGreaterThan(beforeDisabled);
    setHooks(true); const beforeAba = rows().length; await send("aba", "SKIPPED_POLICY_DENIED"); expect(rows().length).toBeGreaterThan(beforeAba);
    expect(fs.readFileSync(output, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(output, "utf8")).not.toContain("PRIVATE_FIXTURE_PAYLOAD");
    await current.stop("reload"); expect(ownership()).toEqual(originalOwner); expect(durableSessions()).toEqual(originalSessions);
    expect((await current.send("old-generation")).isError).toBe(true);
    if (changedIncarnation) {
      api.revoke({ expectedDigest: readLivePolicy(ref).digest, endpointId: "pi/A" });
      api.reauthorize({ expectedDigest: readLivePolicy(ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: nativeId, payloadRead: true, ack: true, presenceDisclosure: false } });
    }
    current = extension(); await current.start("reload");
    if (changedIncarnation) {
      expect((await current.send("refused-reload")).isError).toBe(true);
      expect(entries().filter(entry => entry.customType === "ce-mapping")).toHaveLength(1);
      expect(ctx.ui.notify.mock.calls.some(([message]) => String(message).includes("failed closed"))).toBe(true);
    } else {
      await send("reloaded", "SUCCEEDED");
      expect(entries().findLast(entry => entry.customType === "ce-mapping")?.data).toEqual(mapping);
      expect(fs.readFileSync(output, "utf8").trim().split("\n")).toHaveLength(2);
    }
    expect(ownership()).toEqual(originalOwner); expect(durableSessions()).toEqual(originalSessions);
  } finally { await current.stop("quit"); vi.unstubAllEnvs(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
