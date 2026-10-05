import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
} from "pi-subagents/delegation";
import { wayforgeExtension } from "../src/extension.js";

// The extension constructs its disk sink at factory time from
// PI_CODING_AGENT_DIR; every test gets an isolated temp agent dir so the
// suite never writes observability artifacts into the real agent directory.
let sinkAgentDir: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  sinkAgentDir = mkdtempSync(join(tmpdir(), "wayforge-ext-runtime-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sinkAgentDir;
  const workspace = join(sinkAgentDir, "workspace");
  mkdirSync(workspace);
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=Wayforge Test", "-c", "user.email=test@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "baseline"], { cwd: workspace });
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (sinkAgentDir !== undefined) rmSync(sinkAgentDir, { recursive: true, force: true });
});
class FakeEventBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void {
    if (channel === SUBAGENT_DELEGATION_REQUEST_EVENT) {
      const request = data as SubagentDelegationRequest;
      queueMicrotask(() => {
        for (const handler of this.handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT) ?? []) {
          handler({
            requestId: request.requestId,
            ownerRunId: request.ownerRunId,
            nodeId: request.nodeId,
            status: "completed",
            model: "p/m",
            result: { kind: "text", text: "worker finished the bounded task" },
            usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1, durationMs: 2 },
          });
        }
      });
    }
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
}

interface RegisteredCommand {
  name: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function makeHarness(externalTools: { name: string; source: string }[] = []) {
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, RegisteredCommand>();
  const listeners = new Map<string, Array<(event: never, ctx: ExtensionContext) => void>>();
  const bus = new FakeEventBus();
  const notify = vi.fn();
  const sendUserMessage = vi.fn();
  const setModel = vi.fn(async () => true);

  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name">) =>
      commands.set(name, { name, handler: options.handler }),
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => undefined;
    },
    getAllTools: () => [
      { name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } },
      { name: "subagent", sourceInfo: { source: "pi-subagents", path: "/pi-subagents/index.js" } },
      ...tools.map((tool) => ({
        name: tool.name,
        sourceInfo: { source: "wayforge", path: "/Users/x/Code/wayforge/dist/extension.js" },
      })),
      ...externalTools.map((tool) => ({
        name: tool.name,
        sourceInfo: { source: tool.source, path: `/pi/extensions/${tool.source}/index.js` },
      })),
    ],
    getCommands: () => [
      { name: "wayforge", sourceInfo: { source: "wayforge", path: "/wayforge/dist/extension.js" } },
      { name: "help", sourceInfo: { source: "builtin", path: "builtin:help" } },
    ],
    sendUserMessage,
    setModel,
    events: bus,
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: join(sinkAgentDir!, "workspace"),
    mode: "tui",
    hasUI: true,
    thinkingLevel: "medium",
    model: { id: "m", provider: "p", reasoning: true },
    modelRegistry: {
      find: vi.fn(() => ({ id: "m", provider: "p" })),
      streamSimple: vi.fn(() => {
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: JSON.stringify({ status: "approve", summary: "ready", findings: [] }) },
          ],
          api: "openai-completions",
          provider: "p",
          model: "m",
          usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: 0,
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      }),
    },
    ui: { notify },
  } as unknown as ExtensionContext;

  const fire = async (event: string) => {
    await Promise.all((listeners.get(event) ?? []).map((handler) => handler(undefined as never, ctx)));
  };
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`tool not registered: ${name}`);
    return found;
  };
  const runTool = async (name: string, params: Record<string, unknown>) =>
    tool(name).execute(`call-${name}`, params as never, undefined, undefined, ctx as never);

  wayforgeExtension(pi);
  return { tools, commands, fire, tool, runTool, notify, sendUserMessage, setModel, ctx };
}

describe("wayforgeExtension runtime", () => {
  it("registers the six tools and /wayforge, and stays open on a clean session", async () => {
    const h = makeHarness();
    expect(h.tools.map((tool) => tool.name).sort()).toEqual([
      "wayforge_advise",
      "wayforge_cancel",
      "wayforge_complete",
      "wayforge_delegate_workers",
      "wayforge_record_validation",
      "wayforge_task_status",
    ]);
    expect(h.commands.has("wayforge")).toBe(true);
    await h.fire("session_start");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("runs an assisted workflow end to end without touching the parent model", async () => {
    const h = makeHarness();
    await h.fire("session_start");
    await h.commands.get("wayforge")?.handler("add a small troubleshooting section", h.ctx);
    expect(h.sendUserMessage).toHaveBeenCalledTimes(1);

    await h.fire("before_agent_start");
    const status = await h.runTool("wayforge_task_status", {});
    expect(status.isError).toBeUndefined();
    expect(JSON.stringify(status.content)).toContain("alpha0-1");
    expect(JSON.stringify(status.content)).toContain("activeMainInvocationId");

    const delegated = await h.runTool("wayforge_delegate_workers", { prompts: ["draft the section"] });
    expect(delegated.isError).toBeUndefined();
    expect(JSON.stringify(delegated.content)).toContain("worker finished the bounded task");
    expect(JSON.stringify(delegated.content)).toContain("p/m");

    const validated = await h.runTool("wayforge_record_validation", {
      name: "npm test",
      ok: true,
      summary: "passed",
    });
    expect(validated.isError).toBeUndefined();

    const completed = await h.runTool("wayforge_complete", {});
    expect(completed.isError).toBeUndefined();
    expect(JSON.stringify(completed.content)).toContain("passing validation");

    // Completion invokes the strict Advisor itself; a repeat is idempotent.
    const repeated = await h.runTool("wayforge_complete", {});
    expect(repeated.isError).toBeUndefined();
    expect(JSON.stringify(repeated.content)).toContain("passing validation");

    await h.fire("agent_end");
    await h.fire("session_shutdown");
    expect(h.setModel).not.toHaveBeenCalled();

    // The extension persisted the redacted event stream and the final status
    // snapshot to disk under the isolated agent dir — no manual copying.
    const sinkRoot = join(sinkAgentDir!, "wayforge");
    const events = readFileSync(join(sinkRoot, "alpha0-1.events.jsonl"), "utf8").trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(JSON.parse(events[0]!).kind).toBe("task_started");
    const finalStatus = JSON.parse(readFileSync(join(sinkRoot, "alpha0-1.status.json"), "utf8"));
    expect(finalStatus.status).toBe("completed");
  });

  it("fails closed when the ownership guard rejects competing sources", async () => {
    const h = makeHarness([{ name: "route_model", source: "pi-multi-account" }]);
    await h.fire("session_start");
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(String(h.notify.mock.calls[0]?.[1])).toBe("error");
    await h.commands.get("wayforge")?.handler("try to start anyway", h.ctx);
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    const blocked = await h.runTool("wayforge_delegate_workers", { prompts: ["x"] });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("ownership_guard_blocked");
  });

  it("returns typed failures before a workflow starts and never throws raw data", async () => {
    const h = makeHarness();
    await h.fire("session_start");
    const early = await h.runTool("wayforge_task_status", {});
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early.content)).toContain("workflow_not_started");
    await h.commands.get("wayforge")?.handler("   ", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Usage: /wayforge <objective>", "warning");
    expect(h.setModel).not.toHaveBeenCalled();
  });
});
