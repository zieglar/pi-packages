import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";

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

export type FakeInputSource = "interactive" | "rpc" | "extension";

export interface FakeInputEvent {
  readonly type: "input";
  readonly text: string;
  readonly source: FakeInputSource;
  readonly streamingBehavior?: "steer" | "followUp";
  readonly images?: InputEvent["images"];
}

export type FakeInputResult =
  | { readonly action: "continue" }
  | { readonly action: "handled" };

type InputHandler = (event: FakeInputEvent, ctx: unknown) => Promise<{ action: string } | void> | { action: string } | void;

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

export interface FakeModelMessage {
  readonly content: readonly { readonly type: string; readonly text?: string; readonly thinking?: string }[];
  readonly usage: { readonly input: number; readonly output: number };
  readonly stopReason?: string;
}
type LifecycleHook = (event?: unknown, ctx?: unknown) => void | Promise<void>;
type StreamSimpleHandler = (prompt: string) => Promise<FakeModelMessage>;

export class FakePiHost {
  readonly tools: ToolDefinition[] = [];
  readonly commands: FakeCommand[] = [];
  readonly notifications: RecordedNotification[] = [];
  readonly userMessages: string[] = [];
  readonly userMessageDeliveries: { content: string | unknown[]; options?: { deliverAs?: "steer" | "followUp" } }[] = [];
  readonly ordinaryExecutions: string[] = [];
  readonly inputErrors: string[] = [];
  readonly lifecycleErrors: unknown[] = [];
  mode: "tui" | "rpc" | "json" | "print" = "tui";
  readonly delegationHandlers = new Map<string, Set<(data: unknown) => void>>();
  private readonly lifecycle = new Map<string, LifecycleHook[]>();
  private readonly inputHandlers: InputHandler[] = [];
  private readonly flagDefinitions = new Map<string, { type: "boolean" | "string"; default?: boolean | string; description?: string }>();
  private readonly flagValues = new Map<string, boolean | string>();
  private sequence = 0;
  private streamSimpleHandler: StreamSimpleHandler = async () => {
    throw new Error("not used by these tests");
  };

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

  modelShape: ModelShape | undefined = {
    provider: "test-provider",
    id: "test-model",
    reasoning: true,
    name: "Test Model",
  };

  readonly ctx: {
    cwd: string;
    model: ModelShape | undefined;
    thinkingLevel: "medium";
    modelRegistry: {
      find: (provider: string, modelId: string) => ModelShape | undefined;
      streamSimple: (
        model: ModelShape,
        context: { messages: readonly { readonly content: string }[] },
      ) => { result(): Promise<FakeModelMessage> };
    };
    ui: { notify: (message: string, level: "info" | "warning" | "error") => void };
    mode: "tui" | "rpc" | "json" | "print";
  };

  constructor(readonly cwd: string) {
    const hostThis = this;
    const notifications = this.notifications;
    this.ctx = {
      cwd,
      get model() {
        return hostThis.modelShape;
      },
      thinkingLevel: "medium",
      modelRegistry: {
        find: (provider, modelId) =>
          hostThis.modelShape !== undefined &&
          provider === hostThis.modelShape.provider && modelId === hostThis.modelShape.id
            ? hostThis.modelShape
            : undefined,
        streamSimple: (_model, context) => ({
          result: () => this.streamSimpleHandler(context.messages[0]?.content ?? ""),
        }),
      },
      ui: {
        notify: (message, level) => {
          notifications.push({ level, message });
        },
      },
      get mode() {
        return hostThis.mode;
      },
    };
  }

  registerTool = (tool: ToolDefinition): void => {
    this.tools.push(tool);
  };

  registerCommand = (
    name: string,
    command: {
      description: string;
      handler: FakeCommand["handler"];
      sourceInfo?: FakeCommand["sourceInfo"];
    },
  ): void => {
    this.commands.push({
      name,
      description: command.description,
      handler: command.handler,
      ...(command.sourceInfo !== undefined ? { sourceInfo: command.sourceInfo } : {}),
    });
  };

  on = (event: string, handler: LifecycleHook): void => {
    if (event === "input") {
      this.inputHandlers.push(handler as InputHandler);
      return;
    }
    const list = this.lifecycle.get(event) ?? [];
    list.push(handler);
    this.lifecycle.set(event, list);
  };

  registerFlag = (
    name: string,
    options: { type: "boolean" | "string"; default?: boolean | string; description?: string },
  ): void => {
    this.flagDefinitions.set(name, options);
    if (options.default !== undefined && !this.flagValues.has(name)) {
      this.flagValues.set(name, options.default);
    }
  };

  getFlag = (name: string): boolean | string | undefined => this.flagValues.get(name);

  /** Test seam: simulate `pi --<flag>` startup values. */
  setFlagValue = (name: string, value: boolean | string): void => {
    this.flagValues.set(name, value);
  };

  /** Pi-parity input reduction: first `handled` wins; handler throws are swallowed to continue. */
  async emitInput(
    text: string, source: FakeInputSource,
    options: Pick<InputEvent, "images" | "streamingBehavior"> = {},
  ): Promise<FakeInputResult> {
    const event: FakeInputEvent = { type: "input", text, source, ...options };
    for (const handler of [...this.inputHandlers]) {
      try {
        const result = await handler(event, this.ctx);
        if (result?.action === "handled") return { action: "handled" };
      } catch (error) {
        this.inputErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { action: "continue" };
  }

  /**
   * Wayforge injection entry. Records the message, then routes it through the
   * input handlers with source "extension" exactly like Pi's prompt() path,
   * so tests can prove reentrancy guards.
   */
  sendUserMessage = (content: string | ({ type: "text"; text: string } | NonNullable<InputEvent["images"]>[number])[], options?: { deliverAs?: "steer" | "followUp" }): void => {
    this.userMessageDeliveries.push({ content, ...(options === undefined ? {} : { options }) });
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
    this.userMessages.push(text);
    void this.emitInput(text, "extension");
  };

  /**
   * Ordinary operator turn: full prompt parity. Returns the disposition and,
   * on continue, records that the ordinary agent executed the original text.
   */
  async submitUserTurn(text: string, source: FakeInputSource = "interactive"): Promise<FakeInputResult> {
    const reduced = await this.emitInput(text, source);
    if (reduced.action === "handled") return { action: "handled" };
    this.ordinaryExecutions.push(text);
    return { action: "continue" };
  };

  getAllTools = (): ToolDefinition[] =>
    this.tools.map((tool) => {
      const existing = (tool as unknown as Record<string, unknown>).sourceInfo;
      return existing === undefined
        ? ({ ...tool, sourceInfo: { source: "wayforge", path: `${this.cwd}/dist/extension.js` } } as ToolDefinition)
        : tool;
    });

  getCommands = (): FakeCommand[] =>
    this.commands.map((command) => ({
      ...command,
      sourceInfo: command.sourceInfo ?? { source: "wayforge", path: `${this.cwd}/dist/extension.js` },
    }));
  setModel = async (): Promise<boolean> => true;

  setStreamSimpleHandler(handler: StreamSimpleHandler): void {
    this.streamSimpleHandler = handler;
  }

  nextSessionTag(): string {
    this.sequence += 1;
    return `session-${this.sequence}`;
  }

  async emitLifecycle(event: string, ctx: unknown = this.ctx, payload: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.lifecycle.get(event) ?? []) {
      try { await handler(payload, ctx); } catch (error) { this.lifecycleErrors.push(error); }
    }
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
