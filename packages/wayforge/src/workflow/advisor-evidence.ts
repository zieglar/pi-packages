import { isSensitiveKey, redact, type RedactedTraceValue } from "../trace/redaction.js";
import type { ValidationResult } from "./contracts.js";

export interface AdvisorEvidenceInput {
  readonly objective: string;
  readonly completionCriteria: string;
  readonly implementationSummary: string;
  readonly changedPaths: readonly string[];
  readonly diffSummary: string;
  readonly validations: readonly ValidationResult[];
  readonly workerFindings: readonly string[];
  readonly unresolved: readonly string[];
  readonly workspaceDigest: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface AdvisorEvidence {
  readonly objective: string;
  readonly completionCriteria: string;
  readonly implementationSummary: string;
  readonly changedPaths: readonly string[];
  readonly diffSummary: string;
  readonly validations: readonly ValidationResult[];
  readonly workerFindings: readonly string[];
  readonly unresolved: readonly string[];
  readonly workspaceDigest: string;
  readonly extra: Readonly<Record<string, RedactedTraceValue>>;
}

const OMITTED_KEYS = new Set(["transcript", "messages", "reasoning", "thinking", "hiddenreasoning"]);
const bounded = (value: string, limit = 4_000): string => value.slice(0, limit);

function filterExtra(input: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (OMITTED_KEYS.has(normalized)) continue;
    output[key] = isSensitiveKey(key) ? "[redacted]" : value;
  }
  return output;
}

export function buildAdvisorEvidence(input: AdvisorEvidenceInput): AdvisorEvidence {
  const redactedExtra = redact(filterExtra(input.extra)) as Record<string, RedactedTraceValue>;
  return {
    objective: bounded(input.objective),
    completionCriteria: bounded(input.completionCriteria),
    implementationSummary: bounded(input.implementationSummary),
    changedPaths: input.changedPaths.slice(0, 100).map((path) => bounded(path, 500)),
    diffSummary: bounded(input.diffSummary, 12_000),
    validations: input.validations.slice(0, 100).map((entry) => ({
      name: bounded(entry.name, 200),
      ok: entry.ok,
      summary: bounded(entry.summary, 1_000),
    })),
    workerFindings: input.workerFindings.slice(0, 100).map((entry) => bounded(entry, 1_000)),
    unresolved: input.unresolved.slice(0, 100).map((entry) => bounded(entry, 1_000)),
    workspaceDigest: bounded(input.workspaceDigest, 500),
    extra: redactedExtra,
  };
}
