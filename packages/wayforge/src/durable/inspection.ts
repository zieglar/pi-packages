import type { DurableTaskStore } from "./contracts.js";
import type { AuthoritativeTaskState } from "./state.js";
import type { ExecutionResult } from "../types/result.js";
import { failure } from "../types/result.js";
import type { TaskId } from "../types/identity.js";

/**
 * Read-only sanitized inspection over authoritative durable task state.
 *
 * Pure presentation: it lists and reads through `DurableTaskStore` only,
 * never mutates task state, never reads raw task files, and structurally
 * omits workspace paths, account identifiers, provider payloads,
 * originating failure records, and digest internals. A durable `running`
 * status is never presented as proof of liveness.
 */

const OBJECTIVE_EXCERPT_LIMIT = 200;

export interface DurableSuspensionView {
  readonly reason: string;
  readonly strategy: NonNullable<AuthoritativeTaskState["suspension"]>["strategy"];
  readonly resumeNotBeforeMs: number;
  readonly nextCheckAtMs: number;
}

export interface DurableCompletionView {
  readonly authoritative: boolean;
  readonly completedAtMs?: number;
}

export interface DurableTaskSummary {
  readonly source: "durable";
  readonly taskId: string;
  readonly status: AuthoritativeTaskState["status"];
  readonly objective: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly nextAction: string;
  readonly suspension?: DurableSuspensionView;
  readonly completion?: DurableCompletionView;
}

export interface DurableTaskDetail extends DurableTaskSummary {
  readonly completionCriteria: string;
  readonly currentPhase: string;
  readonly unresolvedCount: number;
  readonly lastFailure?: { readonly kind: string; readonly code: string };
}

function nextActionFor(state: AuthoritativeTaskState): string {
  switch (state.status) {
    case "completed":
      return "no action required";
    case "cancelled":
      return "start a new task if desired";
    case "blocked":
      return "inspect the failure and start a new task after correction";
    case "suspended":
      return "waiting for the existing resume condition";
    case "resuming":
      return "resume is in progress; no operator action is required yet";
    case "pending":
      return "task has not started execution yet";
    case "running":
      return "durable state is running; liveness is not established by this inspection";
  }
}

function suspensionView(state: AuthoritativeTaskState): DurableSuspensionView | undefined {
  if (state.status !== "suspended" || state.suspension === null) return undefined;
  return {
    reason: state.suspension.reason,
    strategy: state.suspension.strategy,
    resumeNotBeforeMs: state.suspension.resumeNotBeforeMs,
    nextCheckAtMs: state.suspension.nextCheckAtMs,
  };
}

function completionView(state: AuthoritativeTaskState): DurableCompletionView | undefined {
  const evidence = state.completionEvidence;
  if (evidence === null) return undefined;
  if ("authority" in evidence && evidence.authority === "completion_authority_v1") {
    return { authoritative: true, completedAtMs: evidence.completedAtMs };
  }
  return { authoritative: false };
}

function summaryOf(state: AuthoritativeTaskState): DurableTaskSummary {
  const suspension = suspensionView(state);
  const completion = completionView(state);
  return {
    source: "durable",
    taskId: state.taskId,
    status: state.status,
    objective: state.objective.slice(0, OBJECTIVE_EXCERPT_LIMIT),
    revision: state.revision,
    createdAtMs: state.createdAtMs,
    updatedAtMs: state.updatedAtMs,
    nextAction: nextActionFor(state),
    ...(suspension !== undefined ? { suspension } : {}),
    ...(completion !== undefined ? { completion } : {}),
  };
}

function detailOf(state: AuthoritativeTaskState): DurableTaskDetail {
  const summary = summaryOf(state);
  const lastFailure = state.lastFailure;
  return {
    ...summary,
    completionCriteria: state.completionCriteria.slice(0, OBJECTIVE_EXCERPT_LIMIT),
    currentPhase: state.currentPhase,
    unresolvedCount: state.unresolvedItems.length,
    ...(lastFailure !== null
      ? { lastFailure: { kind: lastFailure.kind, code: lastFailure.code } }
      : {}),
  };
}

function inspectionUnavailable(underlying: string): ReturnType<typeof failure> {
  return failure({
    kind: "capability",
    scope: "task",
    confidence: "certain",
    code: "durable_inspection_unavailable",
    message: "durable task inspection is unavailable; the authoritative store rejected the read",
    metadata: { storeCode: underlying },
  });
}

/**
 * List all durable tasks, newest activity first: descending `updatedAtMs`,
 * then descending `createdAtMs`, then ascending `taskId`. Corruption and
 * read failures fail closed with a sanitized typed failure; raw store
 * messages are never propagated.
 */
export async function inspectDurableTasks(
  store: DurableTaskStore,
): Promise<ExecutionResult<readonly DurableTaskSummary[]>> {
  const listed = await store.list();
  if (!listed.ok) return inspectionUnavailable(listed.failure.code);
  const summaries = [...listed.value].map(summaryOf);
  summaries.sort((left, right) => {
    if (right.updatedAtMs !== left.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
    if (right.createdAtMs !== left.createdAtMs) return right.createdAtMs - left.createdAtMs;
    return left.taskId.localeCompare(right.taskId);
  });
  return { ok: true, value: summaries };
}

/**
 * Read one durable task's sanitized detail. Read-only; missing tasks and
 * store failures return typed failures without echoing persisted content.
 */
export async function inspectDurableTask(
  store: DurableTaskStore,
  taskId: TaskId,
): Promise<ExecutionResult<DurableTaskDetail>> {
  const loaded = await store.load(taskId);
  if (!loaded.ok) return inspectionUnavailable(loaded.failure.code);
  if (loaded.value === null) {
    return failure({
      kind: "capability",
      scope: "invocation",
      confidence: "certain",
      code: "task_not_found",
      message: "no durable task exists with that identifier",
    });
  }
  return { ok: true, value: detailOf(loaded.value) };
}
