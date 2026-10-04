import { Type, TypeGuard, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TaskId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure } from "../types/result.js";

/**
 * Versioned authoritative durable task state. JSON-only, exact-allowlist
 * schema: credentials, transcripts, raw prompts and provider payloads,
 * hidden reasoning, runtime/model objects, live streams, and worker handles
 * are structurally forbidden. Ephemeral runtime state lives in
 * `EphemeralTaskState` and is never serialized.
 */

export const DURABLE_TASK_STATE_VERSION = 2;

/** Structural bounds enforced by the schema and by bounded constructors. */
export const DURABLE_LIMITS = {
  maxObjectiveLength: 1_000,
  maxSummaryLength: 2_000,
  maxReasonLength: 500,
  maxMessageLength: 200,
  maxShortStringLength: 300,
  maxIdentifierLength: 120,
  maxPathLength: 500,
  maxDigestLength: 128,
  maxWorkItems: 50,
  maxRecentAttempts: 10,
  maxEvidenceReferences: 20,
  maxChangedPaths: 500,
  maxFailureMetadataEntries: 20,
  maxFailureMetadataValueLength: 200,
} as const;

const failureKindSchema = Type.Union([
  Type.Literal("authentication"),
  Type.Literal("cancellation"),
  Type.Literal("context_overflow"),
  Type.Literal("rate_limit"),
  Type.Literal("usage_limit"),
  Type.Literal("provider"),
  Type.Literal("network"),
  Type.Literal("validation"),
  Type.Literal("reasoning"),
  Type.Literal("tool"),
  Type.Literal("capability"),
  Type.Literal("unknown"),
]);

const failureScopeSchema = Type.Union([
  Type.Literal("account"),
  Type.Literal("model"),
  Type.Literal("provider"),
  Type.Literal("invocation"),
  Type.Literal("task"),
  Type.Literal("system"),
]);

const failureConfidenceSchema = Type.Union([Type.Literal("certain"), Type.Literal("ambiguous")]);

const failureMetadataValueSchema = Type.Union([
  Type.String({ maxLength: DURABLE_LIMITS.maxFailureMetadataValueLength }),
  Type.Integer(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

/** Sanitized typed failure record safe to persist; metadata is bounded and scalar-only. */
export const durableFailureSchema = Type.Object(
  {
    kind: failureKindSchema,
    scope: failureScopeSchema,
    confidence: failureConfidenceSchema,
    code: Type.String({ maxLength: 100 }),
    message: Type.String({ maxLength: DURABLE_LIMITS.maxMessageLength }),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
    resetAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    metadata: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: failureMetadataValueSchema,
          maxProperties: DURABLE_LIMITS.maxFailureMetadataEntries,
        },
      ),
    ),
  },
  { additionalProperties: false },
);

/** One workspace path entry; only digests and markers, never file contents. */
export const pathFingerprintSchema = Type.Object(
  {
    path: Type.String({ maxLength: DURABLE_LIMITS.maxPathLength }),
    status: Type.Union([
      Type.Literal("added"),
      Type.Literal("modified"),
      Type.Literal("deleted"),
      Type.Literal("renamed"),
      Type.Literal("type_changed"),
      Type.Literal("conflicting"),
    ]),
    indexDigest: Type.Optional(Type.String({ maxLength: DURABLE_LIMITS.maxDigestLength })),
    worktreeDigest: Type.Optional(Type.String({ maxLength: DURABLE_LIMITS.maxDigestLength })),
    symlink: Type.Optional(Type.Boolean()),
    missing: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Workspace checkpoint: repository identity, HEAD, and bounded path fingerprints. */
export const workspaceCheckpointSchema = Type.Object(
  {
    workspaceRoot: Type.String({ minLength: 1, maxLength: DURABLE_LIMITS.maxPathLength }),
    repositoryId: Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    worktreeId: Type.String({ maxLength: DURABLE_LIMITS.maxDigestLength }),
    headCommit: Type.String({ maxLength: DURABLE_LIMITS.maxDigestLength }),
    workingStateDigest: Type.String({ minLength: 1, maxLength: DURABLE_LIMITS.maxDigestLength }),
    taskWriteSet: Type.Array(Type.String({ minLength: 1, maxLength: DURABLE_LIMITS.maxPathLength }), {
      maxItems: DURABLE_LIMITS.maxChangedPaths,
    }),
    changedPaths: Type.Array(pathFingerprintSchema, { maxItems: DURABLE_LIMITS.maxChangedPaths }),
    capturedAtMs: Type.Integer(),
  },
  { additionalProperties: false },
);

/** Structured checkpoint content: bounded work-item lists plus a summary. */
export const durableCheckpointSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    summary: Type.String({ maxLength: DURABLE_LIMITS.maxSummaryLength }),
    completedWork: Type.Array(Type.String({ maxLength: DURABLE_LIMITS.maxShortStringLength }), {
      maxItems: DURABLE_LIMITS.maxWorkItems,
    }),
    remainingWork: Type.Array(Type.String({ maxLength: DURABLE_LIMITS.maxShortStringLength }), {
      maxItems: DURABLE_LIMITS.maxWorkItems,
    }),
  },
  { additionalProperties: false },
);

const attemptOutcomeSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("suspended"),
  Type.Literal("cancelled"),
]);

/** One bounded recent attempt record with an optional sanitized failure. */
export const durableAttemptSchema = Type.Object(
  {
    attempt: Type.Integer({ minimum: 1 }),
    startedAtMs: Type.Integer(),
    endedAtMs: Type.Optional(Type.Integer()),
    outcome: attemptOutcomeSchema,
    failure: Type.Union([durableFailureSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Typed suspension authored only by the RecoveryCoordinator or an operator. */
export const durableSuspensionSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("usage_limit"),
      Type.Literal("rate_limit"),
      Type.Literal("provider_outage"),
    ]),
    reason: Type.String({ maxLength: DURABLE_LIMITS.maxReasonLength }),
    scope: Type.Union([
      Type.Literal("route"),
      Type.Literal("account"),
      Type.Literal("model"),
      Type.Literal("provider"),
    ]),
    scopeKey: Type.String({ minLength: 1, maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    observedAtMs: Type.Integer(),
    resumeNotBeforeMs: Type.Integer(),
    nextCheckAtMs: Type.Integer(),
    strategy: Type.Union([
      Type.Literal("explicit_reset"),
      Type.Literal("retry_after"),
      Type.Literal("known_quota_window"),
      Type.Literal("availability_probe"),
      Type.Literal("bounded_continuation"),
    ]),
    checkCount: Type.Integer({ minimum: 0 }),
    maxChecks: Type.Integer({ minimum: 1 }),
    originatingFailure: durableFailureSchema,
    decidedBy: Type.Union([Type.Literal("recovery_coordinator"), Type.Literal("operator")]),
  },
  { additionalProperties: false },
);

/** Reference to externally stored evidence; summaries only, no payloads. */
export const evidenceReferenceSchema = Type.Object(
  {
    evidenceId: Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    kind: Type.Union([
      Type.Literal("file"),
      Type.Literal("digest"),
      Type.Literal("command"),
      Type.Literal("note"),
    ]),
    summary: Type.String({ maxLength: DURABLE_LIMITS.maxShortStringLength }),
    recordedAtMs: Type.Integer(),
    validAtWorkspaceDigest: Type.Optional(
      Type.String({ minLength: 1, maxLength: DURABLE_LIMITS.maxDigestLength }),
    ),
  },
  { additionalProperties: false },
);

/** Sanitized identity of the invocation that last made progress on the task. */
export const invocationProvenanceSchema = Type.Object(
  {
    invocationId: Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    role: Type.String({ maxLength: 50 }),
    provider: Type.Optional(Type.String({ maxLength: 50 })),
    modelId: Type.String({ maxLength: 100 }),
    accountKey: Type.Optional(Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength })),
    startedAtMs: Type.Integer(),
    endedAtMs: Type.Optional(Type.Integer()),
    outcome: Type.Optional(attemptOutcomeSchema),
  },
  { additionalProperties: false },
);

/** Continuation launch phase; prevents duplicate relaunch across restarts. */
export const continuationPhaseSchema = Type.Union([
  Type.Literal("prepared"),
  Type.Literal("reserved"),
  Type.Literal("launching"),
  Type.Literal("launched"),
  Type.Literal("running"),
  Type.Literal("completed"),
]);

/** Prepared continuation package state; carries no prompts or transcripts. */
export const continuationStateSchema = Type.Object(
  {
    continuationId: Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    phase: continuationPhaseSchema,
    continuationOf: Type.Optional(Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength })),
    preparedAtMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export const taskStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(DURABLE_TASK_STATE_VERSION),
    taskId: Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    revision: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("suspended"),
      Type.Literal("resuming"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
      Type.Literal("cancelled"),
    ]),
    objective: Type.String({ maxLength: DURABLE_LIMITS.maxObjectiveLength }),
    completionCriteria: Type.String({ maxLength: DURABLE_LIMITS.maxObjectiveLength }),
    currentPhase: Type.String({ maxLength: DURABLE_LIMITS.maxIdentifierLength }),
    unresolvedItems: Type.Array(Type.String({ maxLength: DURABLE_LIMITS.maxShortStringLength }), {
      maxItems: DURABLE_LIMITS.maxWorkItems,
    }),
    policyVersions: Type.Object(
      { role: Type.String({ maxLength: 50 }), model: Type.String({ maxLength: 100 }) },
      { additionalProperties: false },
    ),
    checkpoint: durableCheckpointSchema,
    workspace: Type.Union([workspaceCheckpointSchema, Type.Null()]),
    recoveryCounters: Type.Object(
      {
        retries: Type.Integer({ minimum: 0 }),
        fallbacks: Type.Integer({ minimum: 0 }),
        rotations: Type.Integer({ minimum: 0 }),
        resumeChecks: Type.Integer({ minimum: 0 }),
        continuationLaunches: Type.Integer({ minimum: 0 }),
        recoveryAttempts: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    recentAttempts: Type.Array(durableAttemptSchema, { maxItems: DURABLE_LIMITS.maxRecentAttempts }),
    lastFailure: Type.Union([durableFailureSchema, Type.Null()]),
    suspension: Type.Union([durableSuspensionSchema, Type.Null()]),
    leaseGeneration: Type.Integer({ minimum: 0 }),
    evidence: Type.Array(evidenceReferenceSchema, { maxItems: DURABLE_LIMITS.maxEvidenceReferences }),
    completionEvidence: Type.Union([
      Type.Null(),
      Type.Object(
        { summary: Type.String({ maxLength: DURABLE_LIMITS.maxObjectiveLength }), at: Type.Integer() },
        { additionalProperties: false },
      ),
    ]),
    invocationProvenance: Type.Union([invocationProvenanceSchema, Type.Null()]),
    continuation: Type.Union([continuationStateSchema, Type.Null()]),
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

/** Keys that must never be written through any persistence path. */
const FORBIDDEN_PROPERTY_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const SECRET_VALUE_PATTERN = /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._-]{8,}\b/i;
const SECRET_VALUE_REDACTION_PATTERN = /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi;

function redactSensitiveString(value: string): string {
  return value.replace(SECRET_VALUE_REDACTION_PATTERN, (match) =>
    match.toLowerCase().startsWith("bearer ") ? "Bearer [redacted]" : "[redacted-key]",
  );
}

function containsSensitiveValue(value: unknown): boolean {
  if (typeof value === "string") return SECRET_VALUE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsSensitiveValue);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some(containsSensitiveValue);
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_PROPERTY_KEYS.has(key);
}

/** Deep own-key scan for prototype-polluting keys in parsed JSON. */
function containsForbiddenKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isForbiddenKey(key) || containsForbiddenKey(record[key])) return true;
  }
  return false;
}

type StableJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly StableJsonValue[]
  | { readonly [key: string]: StableJsonValue };
type SanitizedSchemaValue =
  | null
  | string
  | number
  | boolean
  | undefined
  | readonly SanitizedSchemaValue[]
  | { readonly [key: string]: SanitizedSchemaValue };

/** Deterministic stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  const sorted = (input: unknown): StableJsonValue => {
    if (Array.isArray(input)) return input.map(sorted);
    if (typeof input === "object" && input !== null) {
      const out: Record<string, StableJsonValue> = {};
      for (const key of Object.keys(input).sort((left, right) => left.localeCompare(right))) {
        if (isForbiddenKey(key)) {
          throw new TypeError(`durable state contains a forbidden property key: ${key}`);
        }
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

/**
 * Walk an input value against the schema, truncating strings to each field's
 * maxLength, clamping arrays to maxItems (keeping the most recent tail),
 * clamping integers to their minimum, dropping keys outside each object's
 * exact allowlist, and stripping prototype-polluting keys. Structurally
 * invalid survivors still fail validation afterwards.
 */
function sanitizeAgainstSchema(schema: TSchema, value: unknown): SanitizedSchemaValue {
  if (value === null || value === undefined) return value;
  if (TypeGuard.IsUnion(schema)) {
    const matching = schema.anyOf.find((member) => Value.Check(member, value));
    if (matching !== undefined) return sanitizeAgainstSchema(matching, value);
    const matchingShape = schema.anyOf.find((member) => {
      if (Array.isArray(value)) return TypeGuard.IsArray(member);
      if (typeof value === "object" && value !== null) {
        return TypeGuard.IsObject(member) || TypeGuard.IsRecord(member);
      }
      return false;
    });
    return matchingShape === undefined ? undefined : sanitizeAgainstSchema(matchingShape, value);
  }
  if (TypeGuard.IsObject(schema) && typeof value === "object" && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    const out: Record<string, SanitizedSchemaValue> = {};
    for (const key of Object.keys(input)) {
      if (isForbiddenKey(key)) continue;
      const property = (schema.properties as Record<string, TSchema>)[key];
      if (property === undefined) continue; // exact allowlist: strip unknown keys
      out[key] = sanitizeAgainstSchema(property, input[key]);
    }
    return out;
  }
  if (TypeGuard.IsRecord(schema) && typeof value === "object" && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    const valueSchema = Object.values(schema.patternProperties as Record<string, TSchema>)[0];
    const out: Record<string, SanitizedSchemaValue> = {};
    const keys = Object.keys(input)
      .filter((key) => !isForbiddenKey(key))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, DURABLE_LIMITS.maxFailureMetadataEntries);
    for (const key of keys) {
      out[key] = valueSchema === undefined ? undefined : sanitizeAgainstSchema(valueSchema, input[key]);
    }
    return out;
  }
  if (TypeGuard.IsArray(schema) && Array.isArray(value)) {
    const limit = typeof schema.maxItems === "number" ? schema.maxItems : value.length;
    const kept = value.length > limit ? value.slice(value.length - limit) : value;
    return kept.map((entry) => sanitizeAgainstSchema(schema.items as TSchema, entry));
  }
  if (TypeGuard.IsString(schema) && typeof value === "string") {
    const redacted = redactSensitiveString(value);
    return typeof schema.maxLength === "number" && redacted.length > schema.maxLength
      ? redacted.slice(0, schema.maxLength)
      : redacted;
  }
  if (
    (TypeGuard.IsInteger(schema) || TypeGuard.IsNumber(schema)) &&
    typeof value === "number" &&
    typeof schema.minimum === "number" &&
    value < schema.minimum
  ) {
    return schema.minimum;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

/** Build and validate an authoritative state value; throws on violation. */
export function validTaskState(input: TaskStateInput): AuthoritativeTaskState {
  const state = { ...input, schemaVersion: DURABLE_TASK_STATE_VERSION } as AuthoritativeTaskState;
  if (containsSensitiveValue(state)) {
    throw new Error("task state contains forbidden secret-shaped content");
  }
  if (!Value.Check(taskStateSchema, state)) {
    throw new Error("task state failed schema validation (forbidden fields or wrong types)");
  }
  return state;
}

/**
 * Bounded constructor: truncates counts and string lengths, clamps arrays,
 * and strips allowlist-violating or prototype-polluting keys before
 * validation. Use for host-supplied state; deserialization remains strict.
 */
export function boundedTaskState(input: TaskStateInput): AuthoritativeTaskState {
  const sanitized = sanitizeAgainstSchema(
    taskStateSchema,
    input,
  ) as Omit<AuthoritativeTaskState, "schemaVersion">;
  return validTaskState(sanitized);
}

/** Serialize deterministically; rejects anything outside the allowlist. */
export function serializeTaskState(state: AuthoritativeTaskState): string {
  if (containsSensitiveValue(state)) {
    throw new Error("task state contains forbidden secret-shaped content");
  }
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
  if (containsForbiddenKey(parsed)) {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "schema_violation",
      message: "task state contains a forbidden prototype-polluting key",
    });
  }
  if (containsSensitiveValue(parsed)) {
    return failure({
      kind: "validation",
      scope: "task",
      confidence: "certain",
      code: "forbidden_fields",
      message: "task state contains secret-shaped content",
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
