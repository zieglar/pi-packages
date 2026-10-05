import { describe, expect, it } from "vitest";
import { WorkflowEventLog } from "../src/workflow/events.js";
import { WorkflowStateStore } from "../src/workflow/workflow-state.js";
import { invocationId, routeId, taskId } from "../src/types/identity.js";

const task = taskId("task-alpha");
const main = invocationId("main-1");

describe("workflow state", () => {
  it("enforces one active Main invocation and retains parent/route provenance", () => {
    const log = new WorkflowEventLog(() => 10);
    const state = new WorkflowStateStore(log).create({
      taskId: task,
      objective: "ship alpha",
      completionCriteria: "tests pass",
      recoveryBudget: { retriesLeft: 1, fallbacksLeft: 2 },
    });
    expect(state.startMain(main, routeId("route-main"))).toEqual({ ok: true, value: undefined });
    const duplicate = state.startMain(invocationId("main-2"), routeId("route-main"));
    expect(duplicate.ok).toBe(false);
    state.recordChild({
      invocationId: invocationId("worker-1"),
      parentInvocationId: main,
      role: "worker",
      routeId: routeId("route-worker"),
      status: "completed",
    });
    state.endMain(main);
    const snapshot = state.snapshot();
    expect(snapshot.activeMainInvocationId).toBeUndefined();
    expect(snapshot.children[0]).toMatchObject({ parentInvocationId: "main-1", routeId: "route-worker" });
    expect(snapshot.routeHistory).toEqual(["route-main", "route-worker"]);
  });

  it("tracks pending governed work with an accurate count and monotonic epoch", () => {
    const state = new WorkflowStateStore(new WorkflowEventLog(() => 10)).create({
      taskId: task,
      objective: "ship alpha",
      completionCriteria: "tests pass",
      recoveryBudget: { retriesLeft: 1, fallbacksLeft: 2 },
    });
    expect(state.governedWorkSnapshot()).toEqual({ pendingGovernedWorkCount: 0, governedWorkEpoch: 0 });
    state.beginGovernedWork();
    state.beginGovernedWork();
    expect(state.governedWorkSnapshot()).toEqual({ pendingGovernedWorkCount: 2, governedWorkEpoch: 2 });
    state.endGovernedWork();
    state.endGovernedWork();
    expect(state.governedWorkSnapshot()).toEqual({ pendingGovernedWorkCount: 0, governedWorkEpoch: 4 });
  });

  it("emits monotonic redacted events", () => {
    const log = new WorkflowEventLog(() => 25);
    log.emit("task_started", { taskId: task, detail: { apiKey: "sk-secret-value", stage: "start" } });
    log.emit("validation", { taskId: task, detail: { ok: true } });
    const events = log.snapshot();
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(JSON.stringify(events)).not.toContain("sk-secret-value");
    expect(events[0]?.detail).toMatchObject({ apiKey: "[redacted]", stage: "start" });
  });
});
