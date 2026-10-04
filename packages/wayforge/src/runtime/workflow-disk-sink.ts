import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkflowEvent } from "../workflow/events.js";

/**
 * Development-time observability sink for Alpha 0: persists the redacted
 * workflow event stream and sanitized status snapshots to disk so operators
 * never have to copy state out of the TUI by hand.
 *
 * Isolation: everything lands under `<PI_CODING_AGENT_DIR>/wayforge/`, which
 * in the dogfood profile is the git-ignored `.wayforge-dev/agent/wayforge/`.
 * Without the env override it stays inside the user agent dir (`~/.pi/wayforge`).
 *
 * This sink is write-only observability: the in-memory event log remains the
 * authority, nothing is read back, and every write failure is swallowed — a
 * broken disk must never break a running workflow.
 */
export function workflowDiskSinkRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const base = agentDir !== undefined && agentDir.length > 0 ? agentDir : join(homedir(), ".pi");
  return join(base, "wayforge");
}

function safeFileStem(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_") || "task";
}

export class WorkflowDiskSink {
  constructor(private readonly root: string = workflowDiskSinkRoot()) {}

  appendEvent(event: WorkflowEvent): void {
    try {
      mkdirSync(this.root, { recursive: true });
      appendFileSync(
        join(this.root, `${safeFileStem(event.taskId)}.events.jsonl`),
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
    } catch {
      // Observability only: disk failures never propagate into the workflow.
    }
  }

  writeStatus(taskId: string, snapshot: unknown): void {
    try {
      mkdirSync(this.root, { recursive: true });
      const target = join(this.root, `${safeFileStem(taskId)}.status.json`);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      renameSync(tmp, target);
    } catch {
      // Observability only: disk failures never propagate into the workflow.
    }
  }
}
