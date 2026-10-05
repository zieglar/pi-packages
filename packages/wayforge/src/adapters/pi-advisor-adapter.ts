import type { InvocationContext } from "../kernel/invocation-context.js";
import type { ModelDecision } from "../policy/model-policy.js";
import type { NestedInvoker } from "../runtime/nested-invoker.js";
import type { NestedResponseObservation } from "../runtime/ports.js";
import { augmentAdvisorFailureDiagnostic, readAdvisorObservation, type AdvisorParserRejection } from "../trace/advisor-diagnostics.js";
import type { InvocationId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure } from "../types/result.js";
import type { AdvisorFinding, StructuredAdvisorVerdict } from "../workflow/contracts.js";
import type { AdvisorEvidence } from "../workflow/advisor-evidence.js";

export interface AdvisorReviewInput {
  readonly parent: InvocationContext;
  readonly invocationId: InvocationId;
  readonly evidence: AdvisorEvidence;
  readonly budgetLimit: number;
}

export interface AdvisorReviewOutcome {
  readonly verdict: StructuredAdvisorVerdict;
  readonly decision: ModelDecision;
  readonly invocationId: InvocationId;
  readonly parentInvocationId: InvocationId;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Response-shape observation for the best-effort diagnostic side channel. */
  readonly observed?: NestedResponseObservation;
}

const VERDICT_KEYS = new Set(["status", "summary", "findings"]);
const FINDING_KEYS = new Set(["code", "severity", "summary", "path"]);
const STATUSES = new Set(["approve", "changes_requested", "unable"]);
const SEVERITIES = new Set(["blocker", "warning", "note"]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseFinding(value: unknown): AdvisorFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, FINDING_KEYS)) return undefined;
  if (typeof record.code !== "string" || typeof record.summary !== "string") return undefined;
  if (typeof record.severity !== "string" || !SEVERITIES.has(record.severity)) return undefined;
  if (record.path !== undefined && typeof record.path !== "string") return undefined;
  return {
    code: record.code.slice(0, 200),
    severity: record.severity as AdvisorFinding["severity"],
    summary: record.summary.slice(0, 2_000),
    ...(typeof record.path === "string" ? { path: record.path.slice(0, 500) } : {}),
  };
}

/** Original strict verdict parser; accept/reject decision is authoritative. */
export function parseVerdict(text: string): StructuredAdvisorVerdict | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, VERDICT_KEYS)) return undefined;
  if (typeof record.status !== "string" || !STATUSES.has(record.status)) return undefined;
  if (typeof record.summary !== "string" || !Array.isArray(record.findings) || record.findings.length > 20) {
    return undefined;
  }
  const findings = record.findings.map(parseFinding);
  if (findings.some((finding) => finding === undefined)) return undefined;
  return {
    status: record.status as StructuredAdvisorVerdict["status"],
    summary: record.summary.slice(0, 4_000),
    findings: findings as AdvisorFinding[],
  };
}

/**
 * Fixed parser rejection categories. Mirrors the original checks in the
 * same order purely to classify an already-rejected input; it records
 * only the category, never the offending field name, value, or error text,
 * and can never change the accept/reject decision.
 */
function classifyVerdictRejection(text: string): AdvisorParserRejection {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "not_json";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not_object";
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, VERDICT_KEYS)) return "forbidden_keys";
  if (typeof record.status !== "string" || !STATUSES.has(record.status)) return "invalid_status";
  if (typeof record.summary !== "string") return "invalid_summary";
  if (!Array.isArray(record.findings) || record.findings.length > 20) return "invalid_findings";
  return "invalid_finding";
}

/**
 * Instrumented parser for diagnostics: the decision always comes from the
 * original `parseVerdict`; a rejection is additionally classified into a
 * fixed category. Equivalence with the original parser is proven by the
 * Advisor response corpus gate.
 */
export function parseVerdictWithRejection(
  text: string,
): { verdict?: StructuredAdvisorVerdict; rejection?: AdvisorParserRejection } {
  const verdict = parseVerdict(text);
  if (verdict !== undefined) return { verdict };
  try {
    return { rejection: classifyVerdictRejection(text) };
  } catch {
    // Classification is diagnostic only; the original rejection is preserved.
    return {};
  }
}
export class PiAdvisorAdapter {
  constructor(private readonly invoker: NestedInvoker) {}

  async review(input: AdvisorReviewInput): Promise<ExecutionResult<AdvisorReviewOutcome>> {
    const prompt = [
      "Review the following sanitized Wayforge evidence.",
      "Return only JSON with exactly: status (approve|changes_requested|unable), summary, findings[].",
      "Each finding has exactly code, severity (blocker|warning|note), summary, and optional path.",
      JSON.stringify(input.evidence),
    ].join("\n");
    const result = await this.invoker.invoke({
      parent: input.parent,
      invocationId: input.invocationId,
      role: "advisor",
      prompt,
      budgetLimit: input.budgetLimit,
      metadata: { evidenceDigest: input.evidence.workspaceDigest },
    });
    if (!result.ok) return result;
    const instrumented = parseVerdictWithRejection(result.value.output.text);
    const verdict = instrumented.verdict;
    if (verdict === undefined) {
      return failure(augmentAdvisorFailureDiagnostic({
        kind: "validation",
        scope: "invocation",
        confidence: "certain",
        code: "invalid_advisor_verdict",
        message: "advisor output did not match the strict verdict schema",
      }, () => ({
        stream: "resolved",
        reasoning: result.value.decision.thinking,
        logicalBudget: result.value.decision.budget.limit,
        sdkMaxTokens: result.value.output.observed?.request?.sdkMaxTokens,
        preparedMaxTokens: result.value.output.observed?.request?.preparedMaxTokens,
        preparedMaxTokensField: result.value.output.observed?.request?.preparedMaxTokensField,
        stopReason: result.value.output.observed?.stopReason,
        // SDK usage has no generic provider provenance; never promote it here.
        blocks: result.value.output.observed?.blocks,
        text: result.value.output.observed?.text,
        parserRejection: instrumented.rejection,
      })));
    }
    const observed = readAdvisorObservation(() => result.value.output.observed);
    return {
      ok: true,
      value: {
        verdict,
        decision: result.value.decision,
        invocationId: result.value.child.invocationId,
        parentInvocationId: input.parent.invocationId,
        usage: result.value.output.usage,
        ...(observed !== undefined ? { observed } : {}),
      },
    };
  }
}
