import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callMessagingTool, type ExchangeMessagingPort } from "../../../src/control/mcp/messaging-tools.js";
import { CeEndpointHost } from "../../../src/host/endpoint-host.js";
import { createNativeInbound } from "../../../pi-extension/native-inbound.js";
import { cleanupFixtures, fixture } from "../../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);
const sdkPath = process.env.CE_PI_SDK_152;
const now = "2026-10-10T00:00:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Set CE_PI_SDK_152 to the installed Pi 1.5.2 dist/index.js. The test uses
// only an in-memory session, synthetic provider and synthetic tools.
describe.skipIf(!sdkPath)("delivery mode through CE and Pi 1.5.2 AgentSession", () => {
  it.each(["followUp", "steer"] as const)("delivers %s across a busy tool boundary", async mode => {
    const sdk = await import(/* @vite-ignore */ sdkPath!);
    const fx = fixture("ce-delivery-sdk-");
    const host = new CeEndpointHost(fx.store, { adapter: "chatgpt", exchangeNamespace: "ce-mcp", exchangeIdempotencyKey: "sdk-test",
      allowlist: [{ endpointId: "chatgpt/a" }, { endpointId: "chatgpt/b" }], leaseTtlSeconds: 600,
      payloadRead: { enabled: true }, now: () => now });
    host.beginSession("chatgpt/a");
    const recipient = host.beginSession("chatgpt/b");
    const model = { id: "fixture", name: "fixture", api: "synthetic", provider: "synthetic-fixture", baseUrl: "", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
    const runtime = await sdk.ModelRuntime.create({ authPath: join(fx.root, "auth.json"), modelsPath: join(fx.root, "models.json") });
    runtime.registerProvider(model.provider, { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only", models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] });
    await runtime.setRuntimeApiKey(model.provider, "fixture-only");
    const loader = { getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "fixture", getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} };
    const log: string[] = [], entries: Array<Record<string, unknown>> = [];
    let session: any, messageId = "", received = false, extra = false;
    const parameters = { type: "object", properties: {}, additionalProperties: false };
    const result = (text: string) => ({ content: [{ type: "text", text }], details: {} });
    const port = { send: (input: unknown) => host.send("chatgpt/a", input) } as ExchangeMessagingPort;
    const policyPath = join(fx.root, "inbound.json");
    let controller: ReturnType<typeof createNativeInbound>;
    const tools = [
      { name: "busy", label: "busy", description: "fixture", parameters, execute: async () => {
        log.push("busy:start");
        const sent = callMessagingTool(port, "ce_send", { to: "chatgpt/b", text: "synthetic task", idempotencyKey: `sdk-${mode}`, deliveryMode: mode });
        expect(sent.isError).toBe(false);
        messageId = (sent.structuredContent as { messageId: string }).messageId;
        controller.poll();
        await pause(10);
        log.push("busy:end");
        return result("done");
      } },
      { name: "extra", label: "extra", description: "fixture", parameters, execute: async () => { log.push("extra"); extra = true; return result("done"); } },
      { name: "ce_receive_task", label: "receive", description: "fixture", parameters, execute: async () => {
        const out = await controller.receive(messageId, { executeTool: (async (name: string) => {
          if (name === "ce_read") return { isError: false, result: { details: host.readMetadata("chatgpt/b", { messageId }), content: [] } };
          const read = host.readPayload("chatgpt/b", { messageId });
          return { isError: false, result: { details: read, content: [{ type: "text", text: "untrusted" }, { type: "text", text: read.payloadText }] } };
        }) as any });
        expect(out).toMatchObject({ text: "synthetic task" });
        log.push("receive"); received = true; return result("received");
      } },
    ];
    ({ session } = await sdk.createAgentSession({ cwd: fx.root, agentDir: fx.root, model, modelRuntime: runtime,
      sessionManager: sdk.SessionManager.inMemory(fx.root), settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }),
      resourceLoader: loader, tools: tools.map(t => t.name), customTools: tools }));
    const sessionId = session.sessionManager.getSessionId();
    writeFileSync(policyPath, JSON.stringify({ version: 1, enabled: true, runtimeSessionId: sessionId, endpointId: "chatgpt/b", exchangeId: recipient.exchangeId,
      from: "chatgpt/a", activatedAt: now, afterAuditSequence: 0, maxAgeSeconds: 300 }), { mode: 0o600 });
    controller = createNativeInbound({ policyPath, runtimeSessionId: sessionId, endpointId: "chatgpt/b", getSessionId: () => sessionId,
      getEntries: () => entries, append: (customType, data) => { entries.push({ type: "custom", customType, data }); },
      listInbox: input => host.listInbox("chatgpt/b", input), readMetadata: input => host.readMetadata("chatgpt/b", input),
      canReceiveTask: id => host.verifyTaskTarget("chatgpt/b", id), now: () => Date.parse(now) + 1000,
      wake: input => { log.push(`wake:${input.deliveryMode}`); void session.sendCustomMessage({ customType: "fixture-wake", content: "fixture-wake", display: true }, { triggerTurn: true, deliverAs: input.deliveryMode }); } });
    let turn = 0;
    const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
    session.agent.streamFunction = async (_model: unknown, context: any) => {
      turn++;
      const seen = JSON.stringify(context.messages).includes("fixture-wake");
      const content = turn === 1 ? [call("busy", "busy")] : seen && !received ? [call("receive", "ce_receive_task")] : !extra ? [call("extra", "extra")] : [{ type: "text", text: "done" }];
      const message = { role: "assistant", content, api: "synthetic", provider: model.provider, model: model.id, usage, stopReason: content[0]!.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    try {
      await session.prompt("initial", { expandPromptTemplates: false });
      await session.waitForIdle();
      expect(log).toContain(`wake:${mode}`);
      expect(log.indexOf("busy:end")).toBeLessThan(log.indexOf("receive"));
      if (mode === "steer") expect(log.indexOf("receive")).toBeLessThan(log.indexOf("extra"));
      else expect(log.indexOf("extra")).toBeLessThan(log.indexOf("receive"));
      expect(entries.filter(e => e.customType === "ce-inbound-receive")).toHaveLength(2);
    } finally { session.dispose(); }
  });
});
