/**
 * pi-chat-exchange MCP smoke server (Phase 1).
 *
 * Exposes exactly one harmless read-only tool, `ping`, proving the path:
 *
 *   client product -> local plugin/MCP -> pi-chat-exchange smoke server
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

export const SERVER_NAME = "pi-chat-exchange" as const;
export const SERVER_VERSION = "0.1.0" as const;

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

export function createExchangeMcpServer(hostLabel: string = defaultHostLabel()): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [PING_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
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
