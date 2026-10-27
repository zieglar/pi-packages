/**
 * pi-chat-exchange MCP server (Phase 1 smoke + CE-0002 B3-P3B messaging).
 *
 * Phase 1 exposed exactly one harmless read-only tool, `ping`. When the
 * composition root injects a messaging port (built from trusted launch
 * configuration), the server additionally lists the chat-exchange messaging
 * tools (`ce_send`, `ce_inbox_list`, `ce_read_payload`) over that pre-bound
 * port. Without an injected port the surface is exactly the Phase 1 surface.
 *
 * Implemented on the low-level MCP `Server` so tool I/O is validated with the
 * workspace-standard TypeBox schemas rather than a second schema system, and
 * so malformed requests fail closed with JSON-RPC invalid-params errors.
 *
 * stdio discipline: nothing may ever write to stdout except protocol frames.
 * Diagnostics go to stderr only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Value } from "@sinclair/typebox/value";
import { argumentShape, debugEvent, errorSummary } from "../debug-log.js";
import { observeTransport } from "./debug-transport.js";
import { PING_TOOL_NAME, PingArgsSchema, PingResultSchema, defaultHostLabel, ping } from "./ping.js";
import {
  callMessagingTool,
  CE_ACK_TOOL,
  isAckToolName,
  isMessagingToolName,
  MESSAGING_TOOLS,
  type ExchangeMessagingPort,
} from "./messaging-tools.js";

export const SERVER_NAME = "pi-chat-exchange" as const;
export const SERVER_VERSION = "0.2.0" as const;

const PING_TOOL = {
  name: PING_TOOL_NAME,
  description:
    "Read-only liveness probe for the pi-chat-exchange service. " +
    "Use this to verify the client-to-local pi-chat-exchange MCP path is reachable. " +
    "Takes no arguments and changes no state.",
  inputSchema: { ...PingArgsSchema },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

/** An endpoint-bound messaging port plus everything the surface needs from the
 * composition root. The port fixes the sender Endpoint; tool arguments never
 * carry sender/endpoint/session/capability fields. */
export interface MessagingServerBinding {
  readonly port: ExchangeMessagingPort;
  /** Optional trusted, synchronous deny-only composition check. Runs freshly
   * before discovery and every tool dispatch, including ping/unknown names.
   * No authority inputs come from model arguments. */
  readonly admission?: () => void;
  /** HANDOFF-CE-E2B-01: the operator ack opt-in from the validated binding
   * configuration. Absent (or not exactly `true`) means `ce_ack` is neither
   * advertised nor callable; the base four-tool surface is unchanged. */
  readonly ackEnabled?: boolean;
  /** HANDOFF-CE-DIAG-06: development-only execution guard. When exactly
   * `true`, EVERY `tools/call` is refused at the unified dispatch entry
   * below — before the ack gate, the messaging port, or ping can run. The
   * refusal is a fixed JSON-RPC error carrying no tool arguments; the
   * diagnostic records only the tool name and request id. */
  readonly executionGuard?: { readonly enabled: boolean };
}

export function createExchangeMcpServer(
  hostLabel: string = defaultHostLabel(),
  messaging: MessagingServerBinding | undefined = undefined,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  debugEvent("server", "SERVER_CREATED");

  // NOTE: the line below is a pinned check-contract anchor (ping-only by
  // default; messaging tools only through the injected MESSAGING_TOOLS) and
  // must keep its exact shape.
  const tools = messaging === undefined ? [PING_TOOL] : [PING_TOOL, ...MESSAGING_TOOLS];
  // HANDOFF-CE-E2B-01: `ce_ack` is advertised last, and only on the explicit
  // operator ack opt-in carried by the binding.
  const advertised = messaging?.ackEnabled === true ? [...tools, CE_ACK_TOOL] : tools;
  for (const tool of advertised) debugEvent("tool", "TOOL_REGISTERED", { tool: tool.name });

  const admit = (): void => {
    try { messaging?.admission?.(); }
    catch { throw new McpError(ErrorCode.InternalError, "runtime admission denied"); }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    admit();
    debugEvent("mcp", "MCP_TOOLS_LIST", { count: advertised.length });
    return { tools: advertised };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = isMessagingToolName(name) || isAckToolName(name) || name === PING_TOOL_NAME ? name : "unknown-tool";
    const started = Date.now();
    // HANDOFF-CE-DIAG-06: the single unified dispatch entry. When the
    // development execution guard is armed, refuse BEFORE any business
    // handler — ack gate, messaging port, argument validation, even ping.
    // Fail closed for every tool name and every argument shape; the fixed
    // error text never echoes tool arguments.
    if (messaging?.executionGuard?.enabled === true) {
      // Privacy: mirror the transport projection — numeric ids are safe to
      // log verbatim, string ids only as type+length (never raw client text).
      const requestId = extra.requestId;
      debugEvent("tool", "TOOL_CALL_BLOCKED", {
        tool,
        ...(typeof requestId === "number" ? { requestId } : typeof requestId === "string" ? { requestIdType: "string", requestIdLength: requestId.length } : {}),
        reason: "development execution guard",
      });
      throw new McpError(ErrorCode.InternalError, "tools/call blocked by development execution guard");
    }
    admit();
    debugEvent("tool", "TOOL_CALL_STARTED", { tool, args: argumentShape(args) });
    try {
    // HANDOFF-CE-E2B-01: `ce_ack` exists only behind the explicit opt-in; a
    // call without it fails closed exactly like an unadvertised tool.
    if (isAckToolName(name)) {
      if (messaging === undefined || messaging.ackEnabled !== true) {
        // Never advertised in this mode, but fail closed all the same.
        throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${String(name)}`);
      }
    }
    if (isMessagingToolName(name) || isAckToolName(name)) {
      if (messaging === undefined) {
        // Never advertised in this mode, but fail closed all the same.
        throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${String(name)}`);
      }
      try {
        debugEvent("tool", "TOOL_DISPATCH", { tool, stage: "bound-port" });
        const result = callMessagingTool(messaging.port, name, args ?? {});
        debugEvent("tool", "TOOL_CALL_COMPLETED", { tool, isError: result.isError, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === "MessagingArgsError") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "arguments rejected by the closed input schema; sender/endpoint/session/capability fields are never accepted",
          );
        }
        // The messaging layer reports refusals as isError results; anything
        // thrown here is unexpected and must not leak error text.
        throw new McpError(ErrorCode.InternalError, "messaging tool failed closed");
      }
    }
    if (name !== PING_TOOL_NAME) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${String(name)}`);
    }
    if (!Value.Check(PingArgsSchema, args ?? {})) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "ping takes no arguments; unexpected argument shape rejected",
      );
    }
    const result = ping(hostLabel);
    if (!Value.Check(PingResultSchema, result)) {
      // Defensive: the result is constructed in-process, but never serve a
      // payload that violates the frozen schema.
      throw new McpError(ErrorCode.InternalError, "ping result failed schema validation");
    }
    debugEvent("tool", "TOOL_CALL_COMPLETED", { tool, isError: false, durationMs: Date.now() - started });
    return {
      content: [
        { type: "text", text: JSON.stringify(result) },
      ],
      structuredContent: result,
      isError: false,
    };
    } catch (error) {
      debugEvent("tool", "TOOL_CALL_FAILED", { tool, ...errorSummary(error), durationMs: Date.now() - started });
      throw error;
    }
  });

  return server;
}

/** Run the smoke server over stdio. Resolves when the transport closes. */
export async function runStdioServer(hostLabel: string = defaultHostLabel()): Promise<void> {
  const server = createExchangeMcpServer(hostLabel);
  const transport = observeTransport(new StdioServerTransport());
  debugEvent("server", "TRANSPORT_CREATED");
  await server.connect(transport);
  debugEvent("server", "TRANSPORT_CONNECTED");
  debugEvent("server", "SERVER_READY", { mode: "ping-only" });
}
