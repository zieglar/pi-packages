import type { InvocationContext } from "../kernel/invocation-context.js";
import type { ModelDecision } from "../policy/model-policy.js";
import type { NestedInvoker } from "../runtime/nested-invoker.js";
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

function parseVerdict(text: string): StructuredAdvisorVerdict | undefined {
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
    const verdict = parseVerdict(result.value.output.text);
    if (verdict === undefined) {
      return failure({
        kind: "validation",
        scope: "invocation",
        confidence: "certain",
        code: "invalid_advisor_verdict",
        message: "advisor output did not match the strict verdict schema",
      });
    }
    return {
      ok: true,
      value: {
        verdict,
        decision: result.value.decision,
        invocationId: result.value.child.invocationId,
        parentInvocationId: input.parent.invocationId,
      },
    };
  }
}
