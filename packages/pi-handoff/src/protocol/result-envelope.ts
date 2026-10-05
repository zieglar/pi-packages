/**
 * Result envelope contract (frozen v1).
 *
 * The envelope deliberately distinguishes three outcome layers and never
 * collapses them:
 *
 * - transport outcome: did the prompt reach the Pi runtime boundary?
 *   (surfaced by handoff state; mirrored here as `transportOutcome`)
 * - runtime outcome: did the invocation settle, and how?
 *   (`runtimeOutcome`)
 * - application outcome: is the requested task actually done correctly?
 *   pi-handoff does NOT decide this. `applicationEvidence` is opaque,
 *   broker-passthrough data (a future Wayforge integration may publish
 *   taskState/completion evidence digests there; pi-handoff must not
 *   interpret it as semantic correctness).
 */
import { Type, type Static } from "@sinclair/typebox";
import "./formats.js";
import { HandoffIdSchema, SHA256_HEX_PATTERN } from "./handoff.js";
export const RESULT_ID_PATTERN = /^hr_[0-9A-HJKMNP-TV-Z]{26}$/;

export const TransportOutcomeSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("delivery_unknown"),
]);

export const RuntimeOutcomeSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);

export const ResultIdSchema = Type.String({
  pattern: RESULT_ID_PATTERN.source,
  description: "Opaque immutable result identity: hr_ followed by a ULID.",
});

const Sha256Schema = Type.String({ pattern: SHA256_HEX_PATTERN.source });

export const HandoffResultSchema = Type.Object(
  {
    handoffId: HandoffIdSchema,
    resultId: ResultIdSchema,
    attempt: Type.Integer({ minimum: 1 }),
    startedAt: Type.String({ format: "date-time" }),
    settledAt: Type.String({ format: "date-time" }),
    transportOutcome: TransportOutcomeSchema,
    runtimeOutcome: RuntimeOutcomeSchema,
    result: Type.Object(
      {
        summary: Type.String({ maxLength: 4_000 }),
        body: Type.String({ maxLength: 1_000_000 }),
      },
      { additionalProperties: false },
    ),
    source: Type.Object(
      {
        piSessionRef: Type.String({ minLength: 1, maxLength: 1024 }),
        workspace: Type.String({ minLength: 1, maxLength: 1024 }),
      },
      { additionalProperties: false },
    ),
    inputDigest: Sha256Schema,
    resultDigest: Sha256Schema,
    applicationEvidence: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type TransportOutcome = Static<typeof TransportOutcomeSchema>;
export type RuntimeOutcome = Static<typeof RuntimeOutcomeSchema>;
export type HandoffResult = Static<typeof HandoffResultSchema>;
