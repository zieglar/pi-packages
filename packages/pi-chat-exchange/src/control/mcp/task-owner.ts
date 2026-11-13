import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";

export const CE_TASK_OWNER_TOOL_NAME = "ce_task_owner" as const;

const MessageIdSchema = Type.String({ pattern: "^msg_[0-9A-HJKMNP-TV-Z]{26}$" });
const LabelSchema = Type.String({ minLength: 1, maxLength: 4096 });
const closed = { additionalProperties: false } as const;
const TaskOwnerArgsSchema = Type.Object({ messageId: MessageIdSchema }, closed);
const RegisteredTaskOwnerSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  exchangeId: LabelSchema,
  requestMessageId: MessageIdSchema,
  messageId: MessageIdSchema,
  from: LabelSchema,
  to: LabelSchema,
  projectLabel: LabelSchema,
  taskOwner: LabelSchema,
  ownerStatus: Type.Literal("REGISTERED"),
  probeId: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" }),
}, closed);

export type RegisteredTaskOwner = Static<typeof RegisteredTaskOwnerSchema>;
export type TaskOwnerResult = RegisteredTaskOwner | { readonly messageId: string; readonly ownerStatus: "UNVERIFIED" };

export interface TaskOwnerPort {
  lookup(messageId: string): unknown;
}

export const CE_TASK_OWNER_TOOL: Tool = {
  name: CE_TASK_OWNER_TOOL_NAME,
  description: "Read registered task ownership metadata for one exact message ID. UNVERIFIED means no matching verified registration is available.",
  inputSchema: { ...TaskOwnerArgsSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const;

export function validMessageId(value: unknown): value is string {
  return Value.Check(MessageIdSchema, value);
}

export function validRegisteredTaskOwner(value: unknown): value is RegisteredTaskOwner {
  return Value.Check(RegisteredTaskOwnerSchema, value);
}

export function callTaskOwner(port: TaskOwnerPort, args: unknown) {
  if (!Value.Check(TaskOwnerArgsSchema, args)) {
    throw new McpError(ErrorCode.InvalidParams, "exact messageId required; other arguments are rejected");
  }
  const messageId = args.messageId;
  let result: TaskOwnerResult = { messageId, ownerStatus: "UNVERIFIED" };
  try {
    const candidate: unknown = JSON.parse(JSON.stringify(port.lookup(messageId)));
    if (validRegisteredTaskOwner(candidate) && candidate.messageId === messageId) result = candidate;
  } catch {
    // A registry failure never grants ownership and never exposes its details.
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: false };
}
