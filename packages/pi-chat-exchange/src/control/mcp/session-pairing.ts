import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallResult } from "./messaging-tools.js";
import type { PairingRefusal } from "../../tunnel/session-pairing.js";

export const CE_PAIR_TOOL_NAME = "ce_pair" as const;
const closed = { additionalProperties: false } as const;
export const SessionPairingArgsSchema = Type.Object({
  token: Type.String({ pattern: "^ce_pair_[A-Za-z0-9_-]{32}$" }),
  from: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\s\\x00-\\x1f\\x7f-\\x9f]+$" })),
}, closed);
type SessionPairingArgs = Static<typeof SessionPairingArgsSchema>;

export interface SessionPairingPort {
  redeem(token: string, from?: string):
    | { readonly status: "accepted"; readonly from: string; readonly expiresAt: number }
    | { readonly status: "refused"; readonly reason: PairingRefusal };
}

export const CE_PAIR_TOOL: Tool = {
  name: CE_PAIR_TOOL_NAME,
  description: "Redeem a short-lived Pi authorization instruction of the form /ce pair <token> [--from <endpoint>]. The user must provide the instruction from Pi. This creates only a pairing receipt; Pi applies its own Session registration and inbound policy. Never invent, reuse, or log a token.",
  inputSchema: { ...SessionPairingArgsSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export function callSessionPairing(port: SessionPairingPort, args: unknown): ToolCallResult {
  if (!Value.Check(SessionPairingArgsSchema, args)) throw new McpError(ErrorCode.InvalidParams, "invalid pairing instruction");
  const input = args as SessionPairingArgs;
  let result: ReturnType<SessionPairingPort["redeem"]>;
  try { result = port.redeem(input.token, input.from); }
  catch { throw new McpError(ErrorCode.InternalError, "pairing unavailable"); }
  if (result.status === "refused") {
    return { content: [{ type: "text", text: "Pairing code expired or unavailable. Generate a new code in Pi with /ce pair." }], isError: true };
  }
  const output = Object.freeze({ status: "PAIRING_ACCEPTED" as const, from: result.from, expiresAt: result.expiresAt });
  return { content: [{ type: "text", text: "Pairing accepted. Return to Pi and run:\n\n```text\n/ce pair complete\n```" }], structuredContent: output, isError: false };
}
