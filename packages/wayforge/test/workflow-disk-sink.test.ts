import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEventLog, type WorkflowEvent } from "../src/workflow/events.js";
import { WorkflowDiskSink, workflowDiskSinkRoot } from "../src/runtime/workflow-disk-sink.js";

const tmpDirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "wayforge-sink-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleEvent(sequence: number, taskId: string): WorkflowEvent {
  return {
    sequence,
    atMs: 1000 + sequence,
    kind: "task_started",
    taskId: taskId as never,
    detail: {},
  };
}

describe("WorkflowDiskSink", () => {
  it("appends redacted events as JSONL under the sink root", () => {
    const root = tmpRoot();
    const sink = new WorkflowDiskSink(root);
    sink.appendEvent(sampleEvent(1, "alpha0-1"));
    sink.appendEvent(sampleEvent(2, "alpha0-1"));
    const lines = readFileSync(join(root, "alpha0-1.events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).sequence).toBe(1);
    expect(JSON.parse(lines[1]!).sequence).toBe(2);
  });

  it("writes status snapshots atomically without leaving tmp files", () => {
    const root = tmpRoot();
    const sink = new WorkflowDiskSink(root);
    sink.writeStatus("alpha0-1", { status: "running", taskId: "alpha0-1" });
    sink.writeStatus("alpha0-1", { status: "completed", taskId: "alpha0-1" });
    const files = readdirSync(root);
    expect(files).toEqual(["alpha0-1.status.json"]);
    expect(JSON.parse(readFileSync(join(root, "alpha0-1.status.json"), "utf8")).status).toBe("completed");
  });

  it("sanitizes task ids into safe file stems", () => {
    const root = tmpRoot();
    const sink = new WorkflowDiskSink(root);
    sink.appendEvent(sampleEvent(1, "../escape/attempt"));
    const files = readdirSync(root);
    expect(files).toEqual([".._escape_attempt.events.jsonl"]);
  });

  it("swallows disk failures instead of breaking the workflow", () => {
    const blocker = join(tmpRoot(), "blocker");
    writeFileSync(blocker, "not a directory");
    const sink = new WorkflowDiskSink(blocker);
    expect(() => sink.appendEvent(sampleEvent(1, "alpha0-1"))).not.toThrow();
    expect(() => sink.writeStatus("alpha0-1", { ok: true })).not.toThrow();
  });

  it("receives every event when wired through WorkflowEventLog.onEvent", () => {
    const root = tmpRoot();
    const sink = new WorkflowDiskSink(root);
    const log = new WorkflowEventLog(() => 42, (event) => {
      sink.appendEvent(event);
      sink.writeStatus(event.taskId, { taskId: event.taskId, status: "running" });
    });
    log.emit("task_started", { taskId: "alpha0-1" as never, detail: { secret: "x", ok: 1 } });
    log.emit("main_started", { taskId: "alpha0-1" as never });
    const lines = readFileSync(join(root, "alpha0-1.events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.kind).toBe("task_started");
    expect(first.atMs).toBe(42);
    expect(JSON.parse(readFileSync(join(root, "alpha0-1.status.json"), "utf8")).status).toBe("running");
  });

  it("roots under PI_CODING_AGENT_DIR when set and ~/.pi otherwise", () => {
    const isolated = tmpRoot();
    mkdirSync(join(isolated, "agent"), { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(isolated, "agent");
    try {
      expect(workflowDiskSinkRoot()).toBe(join(isolated, "agent", "wayforge"));
      const sink = new WorkflowDiskSink();
      sink.writeStatus("alpha0-1", { ok: true });
      expect(readdirSync(join(isolated, "agent", "wayforge"))).toEqual(["alpha0-1.status.json"]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
    delete process.env.PI_CODING_AGENT_DIR;
    expect(workflowDiskSinkRoot()).toBe(join(process.env.HOME ?? "", ".pi", "wayforge"));
  });
});
