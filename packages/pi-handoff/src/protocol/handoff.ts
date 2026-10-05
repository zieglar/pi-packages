/**
 * Handoff entity and ChatGPT-facing request contracts (frozen v1 schemas).
 *
 * Prompt bodies and result bodies are expected payload data and may be
 * persisted by this application, but they are sensitive: use restrictive
 * filesystem permissions, keep them out of diagnostic logs, and correlate via
 * digests in logs instead. Never persist credentials or environment secrets.
 */
import { Type, type Static } from "@sinclair/typebox";
import "./formats.js";
import { HANDOFF_ID_PATTERN } from "./identity.js";
import { HANDOFF_STATES } from "./lifecycle.js";
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const HandoffIdSchema = Type.String({
  pattern: HANDOFF_ID_PATTERN.source,
  description: "Opaque immutable handoff identity: ho_ followed by a ULID.",
});

export const PromptDigestSchema = Type.String({
  pattern: SHA256_HEX_PATTERN.source,
  description: "SHA-256 hex digest of the canonical prompt payload. Correlate via digest, never log the body.",
});

export const HandoffCreateRequestSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    idempotencyKey: Type.Optional(
      Type.String({ minLength: 1, maxLength: 256 }),
    ),
    workspace: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const HandoffSchema = Type.Object(
  {
    handoffId: HandoffIdSchema,
    state: Type.Union(HANDOFF_STATES.map((state) => Type.Literal(state))),
    idempotencyKey: Type.Optional(Type.String({ maxLength: 256 })),
    promptDigest: PromptDigestSchema,
    promptLength: Type.Integer({ minimum: 0 }),
    workspace: Type.Optional(Type.String({ maxLength: 1024 })),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type HandoffCreateRequest = Static<typeof HandoffCreateRequestSchema>;
export type Handoff = Static<typeof HandoffSchema>;
