import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityCatalog } from "../src/kernel/capability-catalog.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import { ModelPolicy, type StaticModelRoute } from "../src/policy/model-policy.js";
import { RolePolicy, type RoleRule } from "../src/policy/role-policy.js";
import { NestedInvoker } from "../src/runtime/nested-invoker.js";
import { PiCompatibilityAdapter } from "../src/runtime/pi-compatibility-adapter.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";

const SENTINEL_PROVIDER = "wayforge-sentinel";
const SENTINEL_MODEL = "sentinel-advisor";
const SENTINEL_TEXT = "WAYFORGE_COMPOSITION_SENTINEL";

describe("runtime-composed advisor sentinel", () => {
  it("proves NestedInvoker -> ModelRegistry.streamSimple -> composed provider", async () => {
    const observed: string[] = [];
    const runtime = await ModelRuntime.create({
      authPath: join(mkdtempSync(join(tmpdir(), "wayforge-sentinel-")), "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider(SENTINEL_PROVIDER, {
      name: "Wayforge Sentinel",
      baseUrl: "http://127.0.0.1:9/wayforge-sentinel-never-contacted",
      apiKey: "wayforge-sentinel-local-test-key",
      api: "openai-completions",
      models: [
        {
          id: SENTINEL_MODEL,
          name: "Sentinel Advisor",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: true,
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
      streamSimple: (model, _context, options) => {
        observed.push(`${model.provider}/${model.id}:${options?.reasoning ?? "none"}`);
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: SENTINEL_TEXT }],
          api: "openai-completions" as const,
          provider: SENTINEL_PROVIDER,
          model: model.id,
          usage: {
            input: 3,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 7,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: 0,
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    });
    const registry = new ModelRegistry(runtime);
    expect(registry.find(SENTINEL_PROVIDER, SENTINEL_MODEL)).toBeDefined();

    const adapter = new PiCompatibilityAdapter(
      {} as ExtensionAPI,
      { modelRegistry: registry } as unknown as ExtensionContext,
    );

    const rules: readonly RoleRule[] = [
      {
        role: "advisor",
        capabilityId: capabilityId("cap-advisor"),
        allowNested: false,
        needsStreaming: true,
        needsReasoning: true,
        needsTools: false,
        budgetLimit: 50,
      },
    ];
    const routes: readonly StaticModelRoute[] = [
      {
        routeId: routeId("route-sentinel-advisor"),
        provider: SENTINEL_PROVIDER,
        modelId: SENTINEL_MODEL,
        tier: "balanced",
        thinking: "high",
        capabilityId: capabilityId("cap-advisor"),
        budgetLimit: 50,
      },
    ];
    const invoker = new NestedInvoker(
      new RolePolicy(rules),
      new ModelPolicy(routes),
      CapabilityCatalog,
      adapter,
    );

    const parent = createInvocation({
      invocationId: invocationId("main"),
      taskId: taskId("sentinel-task"),
      role: "main",
      maxDepth: 2,
      budgetLimit: 100,
    });
    const result = await invoker.invoke({
      parent,
      invocationId: invocationId("advisor-sentinel"),
      role: "advisor",
      prompt: "verify composition",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected sentinel composition success");
    expect(result.value.output.text).toBe(SENTINEL_TEXT);
    expect(result.value.decision.provider).toBe(SENTINEL_PROVIDER);
    expect(observed).toEqual([`${SENTINEL_PROVIDER}/${SENTINEL_MODEL}:high`]);
    expect(parent.budget.consumed).toBe(7);
  });
});
