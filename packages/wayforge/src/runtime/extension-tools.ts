import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { redact } from "../trace/redaction.js";
import type { WorkflowRuntime } from "../workflow/runtime-factory.js";

export interface WayforgeToolDeps {
  readonly getRuntime: () => WorkflowRuntime | undefined;
  readonly getGuardFailures: () => readonly string[] | undefined;
}

interface ToolPayload {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

function jsonText(payload: ToolPayload): string {
  return JSON.stringify(redact(payload), null, 2);
}

function toolResult(payload: ToolPayload) {
  return {
    content: [{ type: "text" as const, text: jsonText(payload) }],
    details: undefined,
    ...(payload.ok ? {} : { isError: true }),
  };
}

function unavailable(deps: WayforgeToolDeps) {
  const failures = deps.getGuardFailures();
  if (failures !== undefined) {
    return toolResult({
      ok: false,
      error: "ownership_guard_blocked",
      message: "the Wayforge ownership guard failed closed in this session",
      failures,
    });
  }
  if (deps.getRuntime() === undefined) {
    return toolResult({
      ok: false,
      error: "workflow_not_started",
      message: "start a workflow with /wayforge <objective> first",
    });
  }
  return undefined;
}

/**
 * The narrow Wayforge tool surface exposed to Main. Every tool returns a
 * sanitized JSON result and never throws raw provider data; controller
 * failures surface as typed, redacted error payloads.
 */
export function createWayforgeTools(deps: WayforgeToolDeps): ToolDefinition[] {
  const runtime = (): WorkflowRuntime | undefined => deps.getRuntime();

  return [
    defineTool({
      name: "wayforge_task_status",
      label: "Wayforge status",
      description:
        "Show the sanitized Wayforge workflow snapshot: status, active Main invocation, children, budget, validations, advisor verdicts, unresolved items.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const blocked = unavailable(deps);
        if (blocked !== undefined) return blocked;
        const current = runtime();
        if (current === undefined) return toolResult({ ok: false, error: "workflow_not_started" });
        return toolResult({ ok: true, status: current.controller.status() });
      },
    }),
    defineTool({
      name: "wayforge_delegate_workers",
      label: "Wayforge delegate workers",
      description:
        "Delegate one to four fully bounded Worker subagent tasks through pi-subagents. Worker prose is data only; failures return an explicit recovery plan for Main to act on.",
      parameters: Type.Object(
        { prompts: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const blocked = unavailable(deps);
        if (blocked !== undefined) return blocked;
        const current = runtime();
        if (current === undefined) return toolResult({ ok: false, error: "workflow_not_started" });
        const delegated = await current.controller.delegateWorkers({ prompts: params.prompts });
        if (!delegated.ok) return toolResult({ ok: false, failure: delegated.failure });
        return toolResult({
          ok: true,
          outcomes: delegated.value.outcomes.map((outcome) => ({
            invocationId: outcome.invocationId,
            status: outcome.status,
            route: `${outcome.selectedRoute.provider}/${outcome.selectedRoute.modelId}`,
            ...(outcome.observedModel !== undefined ? { observedModel: outcome.observedModel } : {}),
            ...(outcome.text !== undefined ? { text: outcome.text } : {}),
            ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
            remainingBudget: outcome.remainingBudget,
          })),
          ...(delegated.value.recovery !== undefined
            ? {
                recovery: {
                  action: delegated.value.recovery.decision.action,
                  reason: delegated.value.recovery.decision.reason,
                  budgetAfter: delegated.value.recovery.budgetAfter,
                },
              }
            : {}),
        });
      },
    }),
    defineTool({
      name: "wayforge_advise",
      label: "Wayforge advisor review",
      description:
        "Request non-authoritative advice where available. In governed tasks Advisor capacity is reserved for CompletionAuthority: this tool refuses without a provider call; use wayforge_complete when validated and ready.",
      parameters: Type.Object(
        {
          manual: Type.Optional(Type.Boolean()),
          beforeDone: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const blocked = unavailable(deps);
        if (blocked !== undefined) return blocked;
        const current = runtime();
        if (current === undefined) return toolResult({ ok: false, error: "workflow_not_started" });
        const advised = await current.controller.advise({
          ...(params.manual ? { manual: true } : {}),
          ...(params.beforeDone ? { beforeDone: true } : {}),
        });
        if (!advised.ok) return toolResult({ ok: false, failure: advised.failure });
        return toolResult({ ok: true, verdict: advised.value.verdict });
      },
    }),
    defineTool({
      name: "wayforge_record_validation",
      label: "Wayforge record validation",
      description:
        "Record one named validation result (command name, pass/fail, bounded summary). Completion requires at least one passing validation and no failing latest result per name.",
      parameters: Type.Object(
        {
          name: Type.String({ maxLength: 200 }),
          ok: Type.Boolean(),
          summary: Type.String({ maxLength: 1000 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const blocked = unavailable(deps);
        if (blocked !== undefined) return blocked;
        const current = runtime();
        if (current === undefined) return toolResult({ ok: false, error: "workflow_not_started" });
        const recorded = await current.controller.recordValidation({
          name: params.name,
          ok: params.ok,
          summary: params.summary,
        });
        if (!recorded.ok) return toolResult({ ok: false, failure: recorded.failure });
        return toolResult({ ok: true, recorded: params.name });
      },
    }),
    defineTool({
      name: "wayforge_complete",
      label: "Wayforge complete",
      description:
        "Attempt assisted completion. Fails closed until validations pass and (in this workflow) the advisor has approved.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const blocked = unavailable(deps);
        if (blocked !== undefined) return blocked;
        const current = runtime();
        if (current === undefined) return toolResult({ ok: false, error: "workflow_not_started" });
        const completed = await current.controller.complete();
        if (!completed.ok) return toolResult({ ok: false, failure: completed.failure });
        return toolResult({ ok: true, summary: completed.value.summary });
      },
    }),
    defineTool({
      name: "wayforge_cancel",
      label: "Wayforge cancel",
      description: "Cancel the active Wayforge workflow, aborting its invocation subtree. Terminal for this task.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const blocked = unavailable(deps);
        if (blocked !== undefined) return blocked;
        const current = runtime();
        if (current === undefined) return toolResult({ ok: false, error: "workflow_not_started" });
        current.controller.cancel();
        return toolResult({ ok: true, cancelled: true });
      },
    }),
  ];
}
