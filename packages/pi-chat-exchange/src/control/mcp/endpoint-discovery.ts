/** Optional caller-bound, read-only discovery. Composition owns visibility filtering
 * before observation and computes the digest from only this visible projection. */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallResult } from "./messaging-tools.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const CE_ENDPOINTS_TOOL_NAME = "ce_endpoints" as const;
const closed = { additionalProperties: false } as const;
const identity = {
  adapter: Type.String({ minLength: 1, maxLength: 64 }),
  endpointId: Type.String({ minLength: 1, maxLength: 256 }),
};
const state = Type.Union([Type.Literal("true"), Type.Literal("false"), Type.Literal("unknown")]);
export const EndpointDiscoveryResultSchema = Type.Object({
  self: Type.Object({
    ...identity,
    ownCapabilities: Type.Object({ send: Type.Boolean(), inbox: Type.Boolean(), payloadRead: Type.Boolean(), ack: Type.Boolean() }, closed),
  }, closed),
  targets: Type.Array(Type.Object({
    ...identity,
    registered: Type.Literal(true),
    authorized: Type.Object({ send: Type.Literal(true) }, closed),
    active: state,
    reachable: state,
    reason: Type.Union([
      Type.Literal("AVAILABLE"), Type.Literal("NOT_JOINED"), Type.Literal("INACTIVE"),
      Type.Literal("PRESENCE_WITHHELD"), Type.Literal("OBSERVATION_UNKNOWN"),
      Type.Literal("MCP_OPERATION_BLOCKED"),
    ]),
  }, closed), { maxItems: 128 }),
  observedAt: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" }),
  viewDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, closed);
export type EndpointDiscoveryResult = Static<typeof EndpointDiscoveryResultSchema>;
export interface EndpointDiscoveryPort {
  /** No model inputs. Returns only self and currently send-authorized targets.
   * Runtime validation still checks the composition boundary. */
  discover(): EndpointDiscoveryResult;
}
const argsSchema = Type.Object({}, closed);
export const CE_ENDPOINTS_TOOL: Tool = {
  name: CE_ENDPOINTS_TOOL_NAME,
  description: "Read this caller's own identity and authorized exact targets. Advisory observations only; sends recheck authority. Ambiguous targets require explicit user selection.",
  inputSchema: { ...argsSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function callEndpointDiscovery(port: EndpointDiscoveryPort, args: unknown): ToolCallResult {
  if (!Value.Check(argsSchema, args)) {
    throw new McpError(ErrorCode.InvalidParams, "endpoint discovery takes no arguments");
  }
  try {
    // Snapshot once into plain JSON, then validate the exact bytes to be exposed.
    // This also prevents custom serialization from bypassing the closed schema.
    const text = JSON.stringify(port.discover());
    const result: unknown = JSON.parse(text);
    if (!Value.Check(EndpointDiscoveryResultSchema, result)) throw new Error();
    const time = new Date(result.observedAt);
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== result.observedAt) throw new Error();
    return { content: [{ type: "text", text }], structuredContent: result, isError: false };
  } catch {
    throw new McpError(ErrorCode.InternalError, "endpoint discovery unavailable");
  }
}
