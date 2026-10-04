import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TaskId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure } from "../types/result.js";

/**
 * Versioned authoritative durable task state. JSON-only, exact-allowlist
 * schema: credentials, transcripts, raw provider payloads, runtime/model
 * objects, live streams, and worker handles are structurally forbidden.
 * Ephemeral runtime state lives in `EphemeralTaskState` and is never
 * serialized.
 */

export const DURABLE_TASK_STATE_VERSION = 1;

export const taskStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(DURABLE_TASK_STATE_VERSION),
    taskId: Type.String(),
    revision: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("suspended"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
    ]),
    objective: Type.String(),
    completionCriteria: Type.String(),
    policyVersions: Type.Object(
      { role: Type.String(), model: Type.String() },
      { additionalProperties: false },
    ),
    checkpoint: Type.Object(
      { revision: Type.Integer(), summary: Type.String() },
      { additionalProperties: false },
    ),
    recoveryCounters: Type.Object(
      {
        retries: Type.Integer(),
        fallbacks: Type.Integer(),
        rotations: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    suspension: Type.Union([
      Type.Null(),
      Type.Object(
        { reason: Type.String(), resumeAtMs: Type.Optional(Type.Integer()) },
        { additionalProperties: false },
      ),
    ]),
    completionEvidence: Type.Union([
      Type.Null(),
      Type.Object(
        { summary: Type.String(), at: Type.Integer() },
        { additionalProperties: false },
      ),
    ]),
    createdAtMs: Type.Integer(),
    updatedAtMs: Type.Integer(),
  },
  { additionalProperties: false },
);

/** Authoritative persisted task state. */
export type AuthoritativeTaskState = Static<typeof taskStateSchema>;

export type TaskStateInput = Omit<AuthoritativeTaskState, "schemaVersion">;

/**
 * Runtime-only, never-serialized state for one task: abort signals, runtime
 * objects, live streams, and handles. Deliberately non-serializable.
 */
export interface EphemeralTaskState {
  readonly taskId: TaskId;
  readonly abortController: AbortController;
  readonly runtimeHandles: ReadonlyMap<string, unknown>;
  readonly liveStreams: ReadonlySet<object>;
}

const SCHEMA_KEYS = new Set(Object.keys(taskStateSchema.properties));

type StableJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly StableJsonValue[]
  | { readonly [key: string]: StableJsonValue };
/** Deterministic stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  const sorted = (input: unknown): StableJsonValue => {
    if (Array.isArray(input)) return input.map(sorted);
    if (typeof input === "object" && input !== null) {
      const out: Record<string, StableJsonValue> = {};
      for (const key of Object.keys(input).sort((left, right) => left.localeCompare(right))) {
        out[key] = sorted((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "number" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    throw new TypeError("durable state contains a non-JSON value");
  };
  return JSON.stringify(sorted(value));
}

/** Build and validate an authoritative state value; throws on violation. */
export function validTaskState(input: TaskStateInput): AuthoritativeTaskState {
  const state = { ...input, schemaVersion: DURABLE_TASK_STATE_VERSION } as AuthoritativeTaskState;
  if (!Value.Check(taskStateSchema, state)) {
    throw new Error("task state failed schema validation (forbidden fields or wrong types)");
  }
  return state;
}

/** Serialize deterministically; rejects anything outside the allowlist. */
export function serializeTaskState(state: AuthoritativeTaskState): string {
  if (!Value.Check(taskStateSchema, state)) {
    throw new Error("task state failed schema validation (forbidden fields or wrong types)");
  }
  return stableStringify(state);
}

/** Parse and validate a serialized state; typed failure on any violation. */
export function deserializeTaskState(json: string): ExecutionResult<AuthoritativeTaskState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "invalid_json",
      message: "serialized task state is not valid JSON",
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "schema_violation",
      message: "serialized task state must be an object",
    });
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== DURABLE_TASK_STATE_VERSION) {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "unsupported_version",
      message: `unsupported task state schema version: ${String(record.schemaVersion)}`,
    });
  }
  const extra = Object.keys(record).filter((key) => !SCHEMA_KEYS.has(key));
  if (extra.length > 0) {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "forbidden_fields",
      message: "task state contains fields outside the authoritative allowlist",
      metadata: { forbiddenKeyCount: extra.length, firstForbiddenKey: extra[0] ?? "" },
    });
  }
  if (!Value.Check(taskStateSchema, parsed)) {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "schema_violation",
      message: "task state failed schema validation",
    });
  }
  return { ok: true, value: parsed as AuthoritativeTaskState };
}
