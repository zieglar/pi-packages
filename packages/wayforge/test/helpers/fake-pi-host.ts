import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Minimal in-process Pi host double for exercising the REAL Wayforge
 * extension factory (`createWayforgeExtension`) outside a live Pi binary.
 *
 * Only the surface `wayforgeExtension` actually touches is implemented:
 * tool/command registration, the four lifecycle hooks, the delegation event
 * bus, user-message sending, and an `ExtensionContext` with an observed
 * model, model registry, cwd, and UI notifier. Nothing here replaces
 * Wayforge components — the composition under test is entirely real.
 */

export interface RecordedNotification {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface FakeCommand {
  readonly name: string;
  readonly description: string;
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
  readonly sourceInfo?: { readonly source: string; readonly path: string };
}


export interface ModelShape {
  readonly provider: string;
  readonly id: string;
  readonly reasoning: boolean;
  readonly name: string;
}
type LifecycleHook = (event?: unknown, ctx?: unknown) => void | Promise<void>;

export class FakePiHost {
  readonly tools: ToolDefinition[] = [];
  readonly commands: FakeCommand[] = [];
  readonly notifications: RecordedNotification[] = [];
  readonly userMessages: string[] = [];
  readonly delegationHandlers = new Map<string, Set<(data: unknown) => void>>();
  private readonly lifecycle = new Map<string, LifecycleHook[]>();
  private sequence = 0;

  readonly events = {
    emit: (channel: string, data: unknown): void => {
      for (const handler of this.delegationHandlers.get(channel) ?? []) handler(data);
    },
    on: (channel: string, handler: (data: unknown) => void): (() => void) => {
      const set = this.delegationHandlers.get(channel) ?? new Set();
      set.add(handler);
      this.delegationHandlers.set(channel, set);
      return () => set.delete(handler);
    },
  };

  readonly model: ModelShape = {
    provider: "test-provider",
    id: "test-model",
    reasoning: true,
    name: "Test Model",
  };

  readonly ctx: {
    cwd: string;
    model: ModelShape;
    thinkingLevel: "medium";
    modelRegistry: {
      find: (provider: string, modelId: string) => ModelShape | undefined;
      streamSimple: () => never;
    };
    ui: { notify: (message: string, level: "info" | "warning" | "error") => void };
  };

  constructor(readonly cwd: string) {
    const model = this.model;
    const notifications = this.notifications;
    this.ctx = {
      cwd,
      model,
      thinkingLevel: "medium",
      modelRegistry: {
        find: (provider, modelId) =>
          provider === model.provider && modelId === model.id ? model : undefined,
        streamSimple: () => {
          throw new Error("not used by these tests");
        },
      },
      ui: {
        notify: (message, level) => {
          notifications.push({ level, message });
        },
      },
    };
  }

  registerTool = (tool: ToolDefinition): void => {
    this.tools.push(tool);
  };

  registerCommand = (name: string, command: { description: string; handler: FakeCommand["handler"] }): void => {
    this.commands.push({ name, description: command.description, handler: command.handler });
  };

  on = (event: string, handler: LifecycleHook): void => {
    const list = this.lifecycle.get(event) ?? [];
    list.push(handler);
    this.lifecycle.set(event, list);
  };

  sendUserMessage = (text: string): void => {
    this.userMessages.push(text);
  };

  getAllTools = (): ToolDefinition[] =>
    this.tools.map((tool) => ({
      ...tool,
      sourceInfo: { source: "wayforge", path: `${this.cwd}/dist/extension.js` },
    })) as ToolDefinition[];

  getCommands = (): FakeCommand[] =>
    this.commands.map((command) => ({
      ...command,
      sourceInfo: { source: "wayforge", path: `${this.cwd}/dist/extension.js` },
    }));
  setModel = async (): Promise<boolean> => true;

  nextSessionTag(): string {
    this.sequence += 1;
    return `session-${this.sequence}`;
  }

  async emitLifecycle(event: string, ctx: unknown = this.ctx): Promise<void> {
    for (const handler of this.lifecycle.get(event) ?? []) await handler({}, ctx);
  }

  async runCommand(name: string, args: string): Promise<void> {
    const command = this.commands.find((candidate) => candidate.name === name);
    if (command === undefined) throw new Error(`command not registered: ${name}`);
    await command.handler(args, this.ctx);
  }

  tool(name: string): ToolDefinition {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`tool not registered: ${name}`);
    return tool;
  }
}

/** Temporary agent directory; also the durable store root base for a test. */
export function temporaryAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "wayforge-live-agent-"));
}
