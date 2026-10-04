import type { RecoveryBudget } from "../recovery/recovery-coordinator.js";
import type { InvocationId, RouteId, TaskId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure, success } from "../types/result.js";
import type { StructuredAdvisorVerdict, ValidationResult, WorkerStatus } from "./contracts.js";
import type { WorkflowEvent } from "./events.js";
import { WorkflowEventLog } from "./events.js";

export interface WorkflowChildRecord {
  readonly invocationId: InvocationId;
  readonly parentInvocationId: InvocationId;
  readonly role: "worker" | "advisor";
  readonly routeId: RouteId;
  readonly status: WorkerStatus | "approve" | "changes_requested" | "unable";
}

export interface WorkflowSnapshot {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly completionCriteria: string;
  readonly status: "running" | "blocked" | "cancelled" | "completed";
  readonly activeMainInvocationId?: InvocationId;
  readonly children: readonly WorkflowChildRecord[];
  readonly routeHistory: readonly RouteId[];
  readonly recoveryBudget: RecoveryBudget;
  readonly validations: readonly ValidationResult[];
  readonly advisorVerdicts: readonly StructuredAdvisorVerdict[];
  readonly unresolved: readonly string[];
  readonly events: readonly WorkflowEvent[];
}

export interface WorkflowInit {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly completionCriteria: string;
  readonly recoveryBudget: RecoveryBudget;
}

export class WorkflowTaskState {
  private status: WorkflowSnapshot["status"] = "running";
  private activeMainInvocationId: InvocationId | undefined;
  private readonly children: WorkflowChildRecord[] = [];
  private readonly routeHistory: RouteId[] = [];
  private recoveryBudget: RecoveryBudget;
  private readonly validations: ValidationResult[] = [];
  private readonly advisorVerdicts: StructuredAdvisorVerdict[] = [];
  private readonly unresolved: string[] = [];

  constructor(private readonly init: WorkflowInit, private readonly events: WorkflowEventLog) {
    this.recoveryBudget = { ...init.recoveryBudget };
    events.emit("task_started", {
      taskId: init.taskId,
      detail: { objective: init.objective, completionCriteria: init.completionCriteria },
    });
  }

  startMain(invocationId: InvocationId, routeId: RouteId): ExecutionResult<void> {
    if (this.activeMainInvocationId !== undefined) {
      return failure({
        kind: "validation",
        scope: "task",
        confidence: "certain",
        code: "main_already_active",
        message: "a Main invocation is already active for this task",
      });
    }
    this.activeMainInvocationId = invocationId;
    this.routeHistory.push(routeId);
    this.events.emit("main_started", {
      taskId: this.init.taskId,
      invocationId,
      detail: { routeId },
    });
    return success(undefined);
  }

  endMain(invocationId: InvocationId): ExecutionResult<void> {
    if (this.activeMainInvocationId !== invocationId) {
      return failure({
        kind: "validation",
        scope: "task",
        confidence: "certain",
        code: "main_not_active",
        message: "the requested Main invocation is not active",
      });
    }
    this.activeMainInvocationId = undefined;
    this.events.emit("main_ended", { taskId: this.init.taskId, invocationId, detail: {} });
    return success(undefined);
  }

  recordChild(child: WorkflowChildRecord): void {
    this.children.push({ ...child });
    this.routeHistory.push(child.routeId);
  }

  setRecoveryBudget(budget: RecoveryBudget): void {
    this.recoveryBudget = { ...budget };
    this.events.emit("budget_changed", { taskId: this.init.taskId, detail: budget });
  }

  recordValidation(result: ValidationResult): void {
    this.validations.push({ ...result });
    this.events.emit("validation", { taskId: this.init.taskId, detail: result });
  }

  recordAdvisorVerdict(verdict: StructuredAdvisorVerdict): void {
    this.advisorVerdicts.push({ ...verdict, findings: verdict.findings.map((finding) => ({ ...finding })) });
    this.events.emit("advisor_verdict", { taskId: this.init.taskId, detail: verdict });
  }

  addUnresolved(summary: string): void {
    this.unresolved.push(summary.slice(0, 500));
  }

  setStatus(status: WorkflowSnapshot["status"]): void {
    this.status = status;
  }

  snapshot(): WorkflowSnapshot {
    return {
      taskId: this.init.taskId,
      objective: this.init.objective,
      completionCriteria: this.init.completionCriteria,
      status: this.status,
      ...(this.activeMainInvocationId !== undefined
        ? { activeMainInvocationId: this.activeMainInvocationId }
        : {}),
      children: this.children.map((child) => ({ ...child })),
      routeHistory: [...this.routeHistory],
      recoveryBudget: { ...this.recoveryBudget },
      validations: this.validations.map((result) => ({ ...result })),
      advisorVerdicts: this.advisorVerdicts.map((verdict) => ({
        ...verdict,
        findings: verdict.findings.map((finding) => ({ ...finding })),
      })),
      unresolved: [...this.unresolved],
      events: this.events.snapshot(),
    };
  }
}

export class WorkflowStateStore {
  private readonly tasks = new Map<TaskId, WorkflowTaskState>();

  constructor(private readonly events: WorkflowEventLog) {}

  create(init: WorkflowInit): WorkflowTaskState {
    if (this.tasks.has(init.taskId)) throw new Error(`workflow task already exists: ${init.taskId}`);
    const state = new WorkflowTaskState(init, this.events);
    this.tasks.set(init.taskId, state);
    return state;
  }

  get(taskId: TaskId): WorkflowTaskState | undefined {
    return this.tasks.get(taskId);
  }
}
