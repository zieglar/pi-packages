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
export const SERVER_VERSION = "0.1.1" as const;

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
  /** HANDOFF-CE-E2B-01: the operator ack opt-in from the validated binding
   * configuration. Absent (or not exactly `true`) means `ce_ack` is neither
   * advertised nor callable; the base four-tool surface is unchanged. */
  readonly ackEnabled?: boolean;
}

export function createExchangeMcpServer(
  hostLabel: string = defaultHostLabel(),
  messaging: MessagingServerBinding | undefined = undefined,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // NOTE: the line below is a pinned check-contract anchor (ping-only by
  // default; messaging tools only through the injected MESSAGING_TOOLS) and
  // must keep its exact shape.
  const tools = messaging === undefined ? [PING_TOOL] : [PING_TOOL, ...MESSAGING_TOOLS];
  // HANDOFF-CE-E2B-01: `ce_ack` is advertised last, and only on the explicit
  // operator ack opt-in carried by the binding.
  const advertised = messaging?.ackEnabled === true ? [...tools, CE_ACK_TOOL] : tools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertised,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
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
        return callMessagingTool(messaging.port, name, args ?? {});
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
    return {
      content: [
        { type: "text", text: JSON.stringify(result) },
      ],
      structuredContent: result,
      isError: false,
    };
  });

  return server;
}

/** Run the smoke server over stdio. Resolves when the transport closes. */
export async function runStdioServer(hostLabel: string = defaultHostLabel()): Promise<void> {
  const server = createExchangeMcpServer(hostLabel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
