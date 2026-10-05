import { containsSensitiveValue, DURABLE_LIMITS } from "../durable/state.js";
import type { Failure, FailureMetadata } from "../types/result.js";

/**
 * Authoritative Advisor review diagnostics (Phase 1B.3B).
 *
 * One strict-allowlist diagnostic record per dispatched authoritative
 * completion review. The record is an independent, non-authoritative,
 * best-effort side channel: it never participates in readiness, candidate
 * identity, completion verdicts, CAS, recovery, or any authority decision,
 * never adds a task-state revision, and a persistence failure never changes
 * the Advisor or completion result.
 *
 * Privacy boundary: only enum classifications, counts, lengths, observed
 * provider usage, and correlation digests are recorded. Advisor bodies,
 * hidden reasoning, prompts/transcripts, raw provider errors, offending
 * field names or values, and secrets are structurally excluded; anything
 * not observable is recorded as `unavailable`, never guessed.
 */

export const ADVISOR_DIAGNOSTIC_SCHEMA_VERSION = 2;

/** Fixed purpose of the single authoritative completion review reservation. */
export const AUTHORITATIVE_COMPLETION_PURPOSE = "authoritative_completion";

export type AdvisorDiagnosticStream = "resolved" | "rejected" | "unavailable";

/** Allowlisted typed provider stop reasons; unknown values map to `other`. */
export type AdvisorDiagnosticStopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred"
  | "pending"
  | "other"
  | "unavailable";

/** Fixed parser rejection categories; never field names, values, or errors. */
export type AdvisorParserRejection =
  | "not_json"
  | "not_object"
  | "forbidden_keys"
  | "invalid_status"
  | "invalid_summary"
  | "invalid_findings"
  | "invalid_finding";

export interface AdvisorBlockCounts {
  readonly text: number;
  readonly thinking: number;
  readonly toolCall: number;
  readonly other: number;
}

export type AdvisorPreparedMaxTokensField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";

export interface AdvisorPreparedTokenObservation {
  readonly preparedMaxTokens: number;
  readonly preparedMaxTokensField: AdvisorPreparedMaxTokensField;
}

export interface AdvisorRequestObservation {
  readonly sdkMaxTokens: number;
  readonly preparedMaxTokens?: number;
  readonly preparedMaxTokensField?: AdvisorPreparedMaxTokensField;
}

const PREPARED_TOKEN_FIELDS: readonly AdvisorPreparedMaxTokensField[] = [
  "max_tokens", "max_completion_tokens", "max_output_tokens",
];

/** Passive supported-Pi payload observation. Never retains or mutates a payload. */
export function observePreparedTokens(payload: unknown): AdvisorPreparedTokenObservation | undefined {
  try {
    if (typeof payload !== "object" || payload === null) return undefined;
    const record = payload as Record<string, unknown>;
    const present = PREPARED_TOKEN_FIELDS.filter((field) => record[field] !== undefined);
    if (present.length !== 1) return undefined;
    const field = present[0]!;
    const value = record[field];
    return isCount(value) && value > 0 ? { preparedMaxTokens: value, preparedMaxTokensField: field } : undefined;
  } catch {
    return undefined;
  }
}

function preparedTokensOrUndefined(value: unknown): AdvisorPreparedTokenObservation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const field = record.preparedMaxTokensField;
  return isCount(record.preparedMaxTokens) && record.preparedMaxTokens > 0 &&
    PREPARED_TOKEN_FIELDS.includes(field as AdvisorPreparedMaxTokensField)
    ? { preparedMaxTokens: record.preparedMaxTokens, preparedMaxTokensField: field as AdvisorPreparedMaxTokensField }
    : undefined;
}

function requestObservationOrUndefined(value: unknown): AdvisorRequestObservation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!isCount(record.sdkMaxTokens)) return undefined;
  return { sdkMaxTokens: record.sdkMaxTokens, ...preparedTokensOrUndefined(record) };
}

/** Read an existing observation through the allowlist; malformed input is omitted. */
export function readAdvisorObservation(read: () => unknown): import("../runtime/ports.js").NestedResponseObservation | undefined {
  try {
    const value = read();
    if (typeof value !== "object" || value === null) return undefined;
    const observation = value as Record<string, unknown>;
    const blocks = typeof observation.blocks === "object" && observation.blocks !== null
      ? countBlocks(observation.blocks as AdvisorBlockCounts) : undefined;
    const text = textStatsOrUndefined(observation.text);
    if (blocks === undefined || text === undefined) return undefined;
    const request = requestObservationOrUndefined(observation.request);
    return { stopReason: classifyStopReason(observation.stopReason), blocks, text, ...(request !== undefined ? { request } : {}) };
  } catch {
    return undefined;
  }
}

/** Diagnostic-only reads and classification never cross the runtime boundary. */
export function observeAdvisorResponse(
  read: () => { readonly content: readonly unknown[]; readonly stopReason: unknown; readonly request?: unknown },
): import("../runtime/ports.js").NestedResponseObservation | undefined {
  try {
    const response = read();
    const texts: string[] = [];
    for (const block of response.content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record.type !== "text") continue;
      if (typeof record.text !== "string") return undefined;
      texts.push(record.text);
    }
    const request = requestObservationOrUndefined(response.request);
    return {
      stopReason: classifyStopReason(response.stopReason),
      blocks: classifyContentBlocks(response.content),
      ...(request !== undefined ? { request } : {}),
      text: buildTextStats(texts),
    };
  } catch {
    return undefined;
  }
}

export interface AdvisorTextStats {
  readonly blocks: number;
  readonly totalLength: number;
  readonly empty: boolean;
  readonly containsCodeFence: boolean;
}

export interface AdvisorDiagnosticRecord {
  readonly schemaVersion: number;
  readonly kind: "advisor_review_diagnostic";
  readonly purpose: "authoritative_completion";
  readonly invocationId: string;
  readonly candidateDigest: string;
  readonly candidateRevision: number | "unavailable";
  readonly workspaceDigest: string;
  readonly request: {
    /** Wayforge invocation allowance; independent of provider payload transformations. */
    readonly logicalBudget: number | "unavailable";
    /** Requested SDK reasoning level; not provider-effective reasoning. */
    readonly reasoning: string;
    readonly sdkMaxTokens: number | "unavailable";
    readonly preparedMaxTokens?: number;
    readonly preparedMaxTokensField?: AdvisorPreparedMaxTokensField;
  };
  readonly stream: AdvisorDiagnosticStream;
  readonly stopReason: AdvisorDiagnosticStopReason;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly blocks?: AdvisorBlockCounts;
  readonly text?: AdvisorTextStats;
  readonly parseValid: boolean;
  readonly parserRejection?: AdvisorParserRejection;
}

const UNAVAILABLE = "unavailable";
const STOP_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
  "pending",
]);
const STREAMS: ReadonlySet<string> = new Set(["resolved", "rejected", UNAVAILABLE]);
const PARSER_REJECTIONS: ReadonlySet<string> = new Set([
  "not_json",
  "not_object",
  "forbidden_keys",
  "invalid_status",
  "invalid_summary",
  "invalid_findings",
  "invalid_finding",
]);

/** Map a provider stop reason onto the allowlist without guessing. */
/** Map a provider stop reason onto the allowlist without guessing. Idempotent. */
export function classifyStopReason(value: unknown): AdvisorDiagnosticStopReason {
  if (value === undefined) return UNAVAILABLE;
  if (typeof value !== "string") return "other";
  if (value === "other" || value === UNAVAILABLE) return value;
  return STOP_REASONS.has(value) ? (value as AdvisorDiagnosticStopReason) : "other";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countBlocks(blocks: AdvisorBlockCounts): AdvisorBlockCounts | undefined {
  return isCount(blocks.text) && isCount(blocks.thinking) && isCount(blocks.toolCall) && isCount(blocks.other)
    ? { text: blocks.text, thinking: blocks.thinking, toolCall: blocks.toolCall, other: blocks.other }
    : undefined;
}

/** Count content blocks by fixed type; unknown types bucket into `other`. */
export function classifyContentBlocks(blocks: readonly unknown[]): AdvisorBlockCounts {
  const counts = { text: 0, thinking: 0, toolCall: 0, other: 0 };
  for (const block of blocks) {
    const type = typeof block === "object" && block !== null ? (block as { type?: unknown }).type : undefined;
    if (type === "text") counts.text += 1;
    else if (type === "thinking") counts.thinking += 1;
    else if (type === "toolCall") counts.toolCall += 1;
    else counts.other += 1;
  }
  return counts;
}

/** Observation-only text statistics; never preprocesses or repairs the text. */
export function buildTextStats(blocks: readonly string[]): AdvisorTextStats {
  const totalLength = blocks.reduce((sum, text) => sum + text.length, 0);
  return {
    blocks: blocks.length,
    totalLength,
    empty: totalLength === 0,
    containsCodeFence: blocks.some((text) => text.includes("```")),
  };
}

function reasoningOrUnavailable(value: unknown): string {
  return typeof value === "string" && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value : UNAVAILABLE;
}

function stringOrUnavailable(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : UNAVAILABLE;
}

function revisionOrUnavailable(value: unknown): number | "unavailable" {
  return isCount(value) ? value : UNAVAILABLE;
}

function usageOrUndefined(value: unknown): AdvisorDiagnosticRecord["usage"] {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
  return isCount(usage.inputTokens) && isCount(usage.outputTokens)
    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    : undefined;
}

function textStatsOrUndefined(value: unknown): AdvisorTextStats | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const stats = value as Record<string, unknown>;
  if (!isCount(stats.blocks) || !isCount(stats.totalLength) || typeof stats.empty !== "boolean" || typeof stats.containsCodeFence !== "boolean") {
    return undefined;
  }
  return {
    blocks: stats.blocks,
    totalLength: stats.totalLength,
    empty: stats.empty,
    containsCodeFence: stats.containsCodeFence,
  };
}

function parserRejectionOrUndefined(value: unknown): AdvisorParserRejection | undefined {
  return typeof value === "string" && PARSER_REJECTIONS.has(value)
    ? (value as AdvisorParserRejection)
    : undefined;
}

export interface AdvisorDiagnosticInput {
  readonly invocationId: unknown;
  readonly candidateDigest: unknown;
  readonly candidateRevision: unknown;
  readonly workspaceDigest: unknown;
  readonly reasoning: unknown;
  readonly logicalBudget: unknown;
  readonly sdkMaxTokens?: unknown;
  readonly preparedMaxTokens?: unknown;
  readonly preparedMaxTokensField?: unknown;
  readonly stream: unknown;
  readonly stopReason?: unknown;
  readonly usage?: unknown;
  readonly blocks?: unknown;
  readonly text?: unknown;
  readonly parseValid: boolean;
  readonly parserRejection?: unknown;
}

/**
 * Build the allowlist diagnostic record. Unknown or non-conforming values
 * degrade to `unavailable`/`other` or are dropped; raw values are never
 * echoed and the builder never throws.
 */
export function buildAdvisorDiagnosticRecord(input: AdvisorDiagnosticInput): AdvisorDiagnosticRecord {
  const blocks =
    typeof input.blocks === "object" && input.blocks !== null ? countBlocks(input.blocks as AdvisorBlockCounts) : undefined;
  const usage = usageOrUndefined(input.usage);
  const text = textStatsOrUndefined(input.text);
  const prepared = preparedTokensOrUndefined(input);
  const parserRejection = parserRejectionOrUndefined(input.parserRejection);
  const stream = typeof input.stream === "string" && STREAMS.has(input.stream)
    ? (input.stream as AdvisorDiagnosticStream)
    : UNAVAILABLE;
  return {
    schemaVersion: ADVISOR_DIAGNOSTIC_SCHEMA_VERSION,
    kind: "advisor_review_diagnostic",
    purpose: AUTHORITATIVE_COMPLETION_PURPOSE,
    invocationId: stringOrUnavailable(input.invocationId),
    candidateDigest: stringOrUnavailable(input.candidateDigest),
    candidateRevision: revisionOrUnavailable(input.candidateRevision),
    workspaceDigest: stringOrUnavailable(input.workspaceDigest),
    request: {
      reasoning: reasoningOrUnavailable(input.reasoning),
      logicalBudget: revisionOrUnavailable(input.logicalBudget),
      sdkMaxTokens: revisionOrUnavailable(input.sdkMaxTokens),
      ...(prepared !== undefined ? prepared : {}),
    },
    stream,
    stopReason: stream === "resolved" ? classifyStopReason(input.stopReason) : UNAVAILABLE,
    ...(usage !== undefined ? { usage } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(text !== undefined ? { text } : {}),
    parseValid: input.parseValid === true,
    ...(parserRejection !== undefined ? { parserRejection } : {}),
  };
}

/**
 * Defense in depth: reuse the durable secret-rejection check so a diagnostic
 * record can never persist secret-shaped content on any path.
 */
export function advisorDiagnosticRecordIsSafe(record: AdvisorDiagnosticRecord): boolean {
  try {
    return !containsSensitiveValue(record);
  } catch {
    return false;
  }
}

/** Flat failure-metadata projection shared by the runtime and Advisor adapters. */
export interface AdvisorFailureDiagnosticParts {
  readonly stream: AdvisorDiagnosticStream;
  readonly reasoning: unknown;
  readonly logicalBudget: unknown;
  readonly sdkMaxTokens?: unknown;
  readonly preparedMaxTokens?: unknown;
  readonly preparedMaxTokensField?: unknown;
  readonly stopReason?: unknown;
  readonly blocks?: AdvisorBlockCounts | undefined;
  readonly text?: AdvisorTextStats | undefined;
  readonly parserRejection?: AdvisorParserRejection | undefined;
}


/** Project the diagnostic parts onto bounded scalar failure metadata. */
export function advisorFailureDiagnosticMetadata(parts: AdvisorFailureDiagnosticParts): FailureMetadata {
  const metadata: Record<string, string | number | boolean | null> = {
    diagStream: parts.stream,
    diagReasoning: reasoningOrUnavailable(parts.reasoning),
    diagLogicalBudget: revisionOrUnavailable(parts.logicalBudget),
    diagSdkMaxTokens: revisionOrUnavailable(parts.sdkMaxTokens),
  };
  const prepared = preparedTokensOrUndefined(parts);
  if (prepared !== undefined) {
    metadata.diagPreparedMaxTokens = prepared.preparedMaxTokens;
    metadata.diagPreparedMaxTokensField = prepared.preparedMaxTokensField;
  }
  if (parts.stopReason !== undefined) metadata.diagStopReason = classifyStopReason(parts.stopReason);
  if (parts.blocks !== undefined) {
    const blocks = countBlocks(parts.blocks);
    if (blocks !== undefined) metadata.diagBlocks = JSON.stringify(blocks);
  }
  if (parts.text !== undefined) {
    const text = textStatsOrUndefined(parts.text);
    if (text !== undefined) {
      metadata.diagTextBlocks = text.blocks;
      metadata.diagTextLength = text.totalLength;
      metadata.diagTextEmpty = text.empty;
      metadata.diagCodeFence = text.containsCodeFence;
    }
  }
  if (parts.parserRejection !== undefined) {
    const rejection = parserRejectionOrUndefined(parts.parserRejection);
    if (rejection !== undefined) metadata.diagParseRejection = rejection;
  }
  return metadata;
}

/** Invocation-local diagnostic identity, never serialized or inferred from metadata.
 * Only the runtime/Advisor augmentation path registers its newly returned failure.
 * Clones, provider failures, and metadata collisions cannot carry this identity. */
const failureDiagnosticObservations = new WeakMap<Failure, FailureMetadata>();

/** Add only observational keys. Existing failure information always wins. */
export function augmentAdvisorFailureDiagnostic(
  original: Failure,
  parts: () => AdvisorFailureDiagnosticParts,
): Failure {
  try {
    const diagnostic = advisorFailureDiagnosticMetadata(parts());
    const metadata = { ...diagnostic, ...original.metadata };
    // Do not displace semantic keys in the existing bounded durable projection.
    if (Object.keys(metadata).length > DURABLE_LIMITS.maxFailureMetadataEntries) return original;
    const augmented = { ...original, metadata };
    // Keep only this invocation's sanitized projection, not the merged metadata.
    failureDiagnosticObservations.set(augmented, Object.freeze(diagnostic));
    return augmented;
  } catch {
    return original;
  }
}

/** Read only the private current-invocation projection. Semantic metadata is never an observation. */
export function readAdvisorFailureDiagnostic(failure: Failure): AdvisorFailureDiagnosticParts {
  let metadata: Record<string, unknown>;
  try {
    metadata = (failureDiagnosticObservations.get(failure) ?? {}) as Record<string, unknown>;
  } catch {
    // Provenance lookup is diagnostic-only; absent/malformed carriers degrade.
    metadata = {};
  }
  const stream = typeof metadata.diagStream === "string" && STREAMS.has(metadata.diagStream)
    ? (metadata.diagStream as AdvisorDiagnosticStream)
    : UNAVAILABLE;
  let blocks: AdvisorBlockCounts | undefined;
  if (typeof metadata.diagBlocks === "string") {
    try {
      const parsed = countBlocks(JSON.parse(metadata.diagBlocks) as AdvisorBlockCounts);
      blocks = parsed;
    } catch {
      blocks = undefined;
    }
  }
  const text =
    metadata.diagTextBlocks !== undefined && metadata.diagTextLength !== undefined
      ? textStatsOrUndefined({
          blocks: metadata.diagTextBlocks,
          totalLength: metadata.diagTextLength,
          empty: metadata.diagTextEmpty === true,
          containsCodeFence: metadata.diagCodeFence === true,
        })
      : undefined;
  const rejection = parserRejectionOrUndefined(metadata.diagParseRejection);
  return {
    stream,
    reasoning: metadata.diagReasoning,
    logicalBudget: metadata.diagLogicalBudget,
    sdkMaxTokens: metadata.diagSdkMaxTokens,
    ...preparedTokensOrUndefined({ preparedMaxTokens: metadata.diagPreparedMaxTokens, preparedMaxTokensField: metadata.diagPreparedMaxTokensField }),
    ...(metadata.diagStopReason !== undefined ? { stopReason: metadata.diagStopReason } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(rejection !== undefined ? { parserRejection: rejection } : {}),
  };
}
