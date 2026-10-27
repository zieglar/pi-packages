import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { debugEvent, errorSummary, type DebugMetadata } from "../debug-log.js";

const METHODS = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping", "notifications/cancelled"]);
function frameMetadata(frame: JSONRPCMessage): DebugMetadata {
  const id = "id" in frame ? frame.id : undefined;
  return {
    ...("method" in frame ? { method: METHODS.has(frame.method) ? frame.method : "other" } : {}),
    ...(typeof id === "number" ? { requestId: id } : typeof id === "string" ? { requestIdType: "string", requestIdLength: id.length } : {}),
    ...("error" in frame ? { code: frame.error.code } : {}),
  };
}
/** Observe the existing stdio transport without parsing/rewriting wire data.
 * SDK connect installs callbacks before start. Preserve frame/extra/options,
 * this binding, return/rejection semantics, and existing close/error callbacks.
 */
export function observeTransport(transport: Transport, log = debugEvent): Transport {
  const start = transport.start.bind(transport);
  const send = transport.send.bind(transport);
  transport.start = async () => {
    const receive = transport.onmessage;
    const close = transport.onclose;
    const error = transport.onerror;
    transport.onmessage = (frame, extra) => {
      log("mcp", "MCP_REQUEST_RECEIVED", frameMetadata(frame));
      if ("method" in frame) {
        const aliases = new Map([["initialize", "MCP_INITIALIZE"], ["notifications/initialized", "MCP_INITIALIZED"], ["tools/list", "MCP_TOOLS_LIST"], ["tools/call", "MCP_TOOLS_CALL"]]);
        const event = aliases.get(frame.method);
        if (event !== undefined) log("mcp", event, frameMetadata(frame));
      }
      receive?.call(transport, frame, extra);
    };
    transport.onclose = () => { log("mcp", "SERVER_STOPPED"); close?.call(transport); };
    transport.onerror = (e) => { log("mcp", "MCP_ERROR", errorSummary(e)); error?.call(transport, e); };
    return start();
  };
  transport.send = async (frame, options) => {
    try {
      await send(frame, options);
      log("mcp", "error" in frame ? "MCP_ERROR" : "MCP_RESPONSE_SENT", frameMetadata(frame));
    } catch (error) {
      log("mcp", "MCP_ERROR", errorSummary(error));
      throw error;
    }
  };
  return transport;
}
