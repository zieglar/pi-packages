import type { NativeInboundToolContext } from "./native-inbound.js";

type ReadName = "ce_read" | "ce_read_payload";
type ReadResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

/** Exact, invocation-local CE protocol data, independent of model-facing presentation.
 * Registered tools and all SDK call/result hooks still run. Refusals are never restored.
 */
export function createNativeReadProtocol() {
  const scopes = new Map<string, { messageId: string; results: Map<string, { name: ReadName; result: ReadResult }> }>();
  return {
    capture<T extends ReadResult>(toolCallId: string, name: ReadName, messageId: string, result: T): T {
      // Pi owns nested identities: <parent toolCallId>/<ordinal>. Ordinary model reads
      // have no active native receive scope and must never retain a private payload copy.
      const separator = toolCallId.lastIndexOf("/");
      const scope = scopes.get(toolCallId.slice(0, separator));
      if (separator > 0 && scope?.messageId === messageId && /^[1-9]\d*$/.test(toolCallId.slice(separator + 1))) {
        scope.results.set(toolCallId, { name, result: structuredClone(result) });
      }
      return result;
    },
    async run<T>(parentId: string, messageId: string, ctx: NativeInboundToolContext, receive: (ctx: NativeInboundToolContext) => Promise<T>): Promise<T> {
      if (scopes.has(parentId)) throw Error("INBOUND_PROTOCOL_SCOPE_ACTIVE");
      const scope = { messageId, results: new Map<string, { name: ReadName; result: ReadResult }>() };
      scopes.set(parentId, scope);
      try {
        return await receive({
          executeTool: async (name, args, options) => {
            const outcome = await ctx.executeTool(name, args, options);
            const exact = scope.results.get(outcome.toolCall.id);
            scope.results.delete(outcome.toolCall.id);
            if (outcome.isError || exact?.name !== name) return outcome;
            // Only the native consumer receives the original owned protocol result.
            // ce_receive_task's final response still goes through normal presentation hooks.
            return { ...outcome, result: exact.result };
          },
        });
      } finally {
        scope.results.clear();
        scopes.delete(parentId);
      }
    },
  };
}
