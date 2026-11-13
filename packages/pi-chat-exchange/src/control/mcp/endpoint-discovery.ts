/** Optional caller-bound, read-only discovery. Composition owns visibility filtering
 * before observation and computes the digest from only this visible projection. */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallResult } from "./messaging-tools.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeRuntimeGroup, RUNTIME_GROUP_PATTERN } from "../../runtime/runtime-group.js";

export const CE_ENDPOINTS_TOOL_NAME = "ce_endpoints" as const;
const closed = { additionalProperties: false } as const;
const identity = {
  adapter: Type.String({ minLength: 1, maxLength: 64 }),
  endpointId: Type.String({ minLength: 1, maxLength: 256 }),
};
const state = Type.Union([Type.Literal("true"), Type.Literal("false"), Type.Literal("unknown")]);
const previousEndpoint = Type.String({ minLength: 1, maxLength: 256 });
export const SessionSwitchResultSchema = Type.Union([
  Type.Object({ status: Type.Literal("unknown"), previousEndpointId: previousEndpoint }, closed),
  Type.Object({ status: Type.Literal("verified"), previousEndpointId: previousEndpoint, successorEndpointId: previousEndpoint,
    source: Type.Literal("pi.new.lifecycle"), observedAt: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" }) }, closed),
]);
export type SessionSwitchResult = Static<typeof SessionSwitchResultSchema>;
const runtimeId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const timestamp = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$" });
export const CurrentBindingResultSchema = Type.Union([
  Type.Object({ status: Type.Union([Type.Literal("unknown"), Type.Literal("ambiguous")]), runtimeId }, closed),
  Type.Object({ status: Type.Literal("verified"), runtimeId, endpointId: previousEndpoint,
    source: Type.Literal("pi.runtime.lifecycle"), observedAt: timestamp, expiresAt: timestamp }, closed),
]);
export type CurrentBindingResult = Static<typeof CurrentBindingResultSchema>;
const selectionFields = { scope: Type.Literal("ce-endpoint"), group: Type.Optional(Type.String({ pattern: RUNTIME_GROUP_PATTERN })) };
const RuntimeSelectionSchema = Type.Union([
  Type.Object({ ...selectionFields, status: Type.Literal("unavailable") }, closed),
  Type.Object({ ...selectionFields, status: Type.Literal("unbound"), revision: Type.String({ pattern: "^(unbound|[a-f0-9]{64})$" }) }, closed),
  Type.Object({ ...selectionFields, status: Type.Literal("bound"), revision: Type.String({ pattern: "^[a-f0-9]{64}$" }), runtimeId }, closed),
]);
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
  sessionSwitch: Type.Optional(SessionSwitchResultSchema),
  runtimes: Type.Optional(Type.Array(Type.Object({ runtimeId }, closed), { maxItems: 128 })),
  currentBinding: Type.Optional(CurrentBindingResultSchema),
  runtimeSelection: Type.Optional(RuntimeSelectionSchema),
  observedAt: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" }),
  viewDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, closed);
export type EndpointDiscoveryResult = Static<typeof EndpointDiscoveryResultSchema>;
export interface EndpointDiscoveryPort {
  /** No model inputs. Returns only self and currently send-authorized targets.
   * Runtime validation still checks the composition boundary. */
  discover(previousEndpointId?: string, runtimeId?: string, useRuntimeBinding?: true, group?: string): EndpointDiscoveryResult;
}
const legacyArgs = Type.Object({ previousEndpointId: Type.Optional(previousEndpoint), runtimeId: Type.Optional(runtimeId) }, closed);
const boundArgs = Type.Object({ useRuntimeBinding: Type.Literal(true) }, closed);
const groupArgs = Type.Object({ group: Type.String({ minLength: 1, maxLength: 256 }) }, closed);
const argsSchema = Type.Union([legacyArgs, boundArgs, groupArgs]);
export const CE_ENDPOINTS_TOOL: Tool = {
  name: CE_ENDPOINTS_TOOL_NAME,
  description: "Read this caller's authorized targets. Use group:<name> to explicitly resolve a local operator's named Runtime group to its independently authorized current Session. Alternatively use runtimeId or useRuntimeBinding:true; do not combine selectors. Groups and unnamed bindings are CE Endpoint scoped. No permissions, receipt or task ownership are inferred; ce_send still requires an exact Endpoint and rechecks authority.",
  inputSchema: { ...Type.Object({ ...legacyArgs.properties, useRuntimeBinding: Type.Optional(Type.Literal(true)), group: Type.Optional(groupArgs.properties.group) }, closed),
    oneOf: [legacyArgs, boundArgs, groupArgs] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function callEndpointDiscovery(port: EndpointDiscoveryPort, args: unknown): ToolCallResult {
  if (!Value.Check(argsSchema, args)) {
    throw new McpError(ErrorCode.InvalidParams, "invalid endpoint discovery query");
  }
  let group: string | undefined;
  if ("group" in args) {
    try { group = normalizeRuntimeGroup(args.group); }
    catch { throw new McpError(ErrorCode.InvalidParams, "invalid runtime group"); }
  }
  try {
    // Snapshot once into plain JSON, then validate the exact bytes to be exposed.
    // This also prevents custom serialization from bypassing the closed schema.
    const text = JSON.stringify("group" in args ? port.discover(undefined, undefined, undefined, group!)
      : "useRuntimeBinding" in args ? port.discover(undefined, undefined, true)
      : args.runtimeId !== undefined ? port.discover(args.previousEndpointId, args.runtimeId)
      : args.previousEndpointId === undefined ? port.discover() : port.discover(args.previousEndpointId));
    const result: unknown = JSON.parse(text);
    if (!Value.Check(EndpointDiscoveryResultSchema, result)) throw new Error();
    const time = new Date(result.observedAt);
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== result.observedAt) throw new Error();
    return { content: [{ type: "text", text }], structuredContent: result, isError: false };
  } catch {
    throw new McpError(ErrorCode.InternalError, "endpoint discovery unavailable");
  }
}
