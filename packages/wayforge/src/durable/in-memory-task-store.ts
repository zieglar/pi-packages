import type { TaskStore } from "./contracts.js";
import {
  deserializeTaskState,
  serializeTaskState,
  type AuthoritativeTaskState,
} from "./state.js";
import type { TaskId } from "../types/identity.js";
import type { ExecutionResult } from "../types/result.js";
import { failure, success } from "../types/result.js";

function cloneState(state: AuthoritativeTaskState): AuthoritativeTaskState {
  const parsed = deserializeTaskState(serializeTaskState(state));
  if (!parsed.ok) throw new Error("validated task state failed deterministic clone");
  return parsed.value;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly states = new Map<TaskId, AuthoritativeTaskState>();

  async load(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState | null>> {
    const state = this.states.get(taskId);
    return success(state === undefined ? null : cloneState(state));
  }

  async save(state: AuthoritativeTaskState): Promise<ExecutionResult<AuthoritativeTaskState>> {
    const cloned = cloneState(state);
    const existing = this.states.get(state.taskId as TaskId);
    if (existing !== undefined && cloned.revision <= existing.revision) {
      return failure({
        kind: "validation",
        scope: "task",
        confidence: "certain",
        code: "stale_task_revision",
        message: "task revision must increase on every subsequent save",
      });
    }
    this.states.set(state.taskId as TaskId, cloned);
    return success(cloneState(cloned));
  }
}
