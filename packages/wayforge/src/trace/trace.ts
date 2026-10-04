import type { InvocationId, TaskId } from "../types/identity.js";
import { redact } from "./redaction.js";

/**
 * Structured, discriminated trace events for invocation, policy decisions,
 * route selection, recovery decisions, suspension, and nesting. Details are
 * redacted before emission; events are safe to persist.
 */

export type TraceEventKind =
  | "invocation"
  | "policy_decision"
  | "route_selection"
  | "recovery_decision"
  | "suspension"
  | "nesting";

export interface TraceEvent {
  readonly kind: TraceEventKind;
  readonly invocationId: InvocationId;
  readonly taskId: TaskId;
  readonly at: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface TraceEventInput {
  readonly invocationId: InvocationId;
  readonly taskId: TaskId;
  /** Monotonic clock in milliseconds; injectable for deterministic tests. */
  readonly at?: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Create a trace event with recursively redacted detail. */
export function createTraceEvent(kind: TraceEventKind, input: TraceEventInput): TraceEvent {
  return {
    kind,
    invocationId: input.invocationId,
    taskId: input.taskId,
    at: input.at ?? 0,
    detail: redact({ ...input.detail }),
  };
}
