import { redact, type RedactedTraceValue } from "../trace/redaction.js";
import type { InvocationId, TaskId } from "../types/identity.js";

export type WorkflowEventKind =
  | "task_started"
  | "main_started"
  | "main_ended"
  | "policy_decision"
  | "route_selected"
  | "worker_launched"
  | "worker_finished"
  | "advisor_triggered"
  | "advisor_verdict"
  | "failure_classified"
  | "recovery_decided"
  | "recovery_applied"
  | "budget_changed"
  | "validation"
  | "cancellation"
  | "completion_ready"
  | "advisor_review_diagnostic";

export interface WorkflowEvent {
  readonly sequence: number;
  readonly atMs: number;
  readonly kind: WorkflowEventKind;
  readonly taskId: TaskId;
  readonly invocationId?: InvocationId;
  readonly parentInvocationId?: InvocationId;
  readonly detail: RedactedTraceValue;
}

export interface WorkflowEventInput {
  readonly taskId: TaskId;
  readonly invocationId?: InvocationId;
  readonly parentInvocationId?: InvocationId;
  readonly detail?: unknown;
}

export class WorkflowEventLog {
  private sequence = 0;
  private readonly events: WorkflowEvent[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly onEvent?: (event: WorkflowEvent) => void,
  ) {}

  emit(kind: WorkflowEventKind, input: WorkflowEventInput): WorkflowEvent {
    const event: WorkflowEvent = {
      sequence: ++this.sequence,
      atMs: this.now(),
      kind,
      taskId: input.taskId,
      ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
      ...(input.parentInvocationId !== undefined
        ? { parentInvocationId: input.parentInvocationId }
        : {}),
      detail: redact(input.detail ?? {}) as RedactedTraceValue,
    };
    this.events.push(event);
    if (this.onEvent !== undefined) {
      this.onEvent(event);
    }
    return event;
  }

  snapshot(): readonly WorkflowEvent[] {
    return this.events.map((event) => ({ ...event, detail: redact(event.detail) }));
  }
}
