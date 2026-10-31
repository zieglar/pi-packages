import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { matchesHookRule, type CeHookRule } from "./config.js";
import type { CeCommittedMessageEvent } from "./events.js";

const MAX_PENDING = 32;

type ExecutionStatus = "STARTED" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "SPAWN_FAILED" | "SKIPPED_QUEUE_FULL" | "SKIPPED_SHUTDOWN";

interface ExecutionRecord {
  readonly hookId: string;
  readonly eventKey: string;
  readonly messageId: string;
  readonly status: ExecutionStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly timeout?: boolean;
}

interface QueueItem {
  readonly rule: CeHookRule;
  readonly event: CeCommittedMessageEvent;
}

export interface CeHookRunnerOptions {
  readonly directory: string;
  readonly rules: readonly CeHookRule[];
}

export interface CeHookAuditSnapshot {
  readonly configured: number;
  readonly active: number;
  readonly rules: readonly CeHookRule[];
}

/** Best-effort local Hook execution. No Store queue, exactly-once claim, startup
 * scan, retry, Payload exposure, or inherited child stdout/stderr. */
export class CeHookRunner {
  readonly #directory: string;
  readonly #rules: readonly CeHookRule[];
  readonly #queue: QueueItem[] = [];
  #draining: Promise<void> | undefined;
  #closed = false;

  constructor(options: CeHookRunnerOptions) {
    this.#directory = options.directory;
    this.#rules = Object.freeze([...options.rules]);
  }

  snapshot(): CeHookAuditSnapshot {
    return Object.freeze({
      configured: this.#rules.length,
      active: this.#rules.filter(rule => rule.enabled).length,
      rules: Object.freeze(this.#rules.map(rule => Object.freeze({ ...rule, recipient: Object.freeze({ ...rule.recipient }), args: Object.freeze([...rule.args]) }))),
    });
  }

  publish(input: CeCommittedMessageEvent): void {
    try {
      const event = Object.freeze({
        schemaVersion: 1 as const,
        event: input.event,
        eventId: input.eventId,
        eventKey: input.eventKey,
        messageId: input.messageId,
        exchangeId: input.exchangeId,
        sender: Object.freeze({ ...input.sender }),
        recipient: Object.freeze({ ...input.recipient }),
        createdAt: input.createdAt,
        payloadDigest: input.payloadDigest,
        payloadLength: input.payloadLength,
      });
      for (const rule of this.#rules) {
        if (!matchesHookRule(rule, event)) continue;
        if (this.#closed) {
          this.#record(rule, event, "SKIPPED_SHUTDOWN", null, new Date().toISOString());
        } else if (this.#queue.length >= MAX_PENDING) {
          this.#record(rule, event, "SKIPPED_QUEUE_FULL", null, new Date().toISOString());
        } else {
          this.#queue.push(Object.freeze({ rule, event }));
        }
      }
      if (this.#queue.length > 0 && this.#draining === undefined) this.#startDrain();
    } catch {
      // A local Hook is never allowed to change committed CE evidence.
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const finishedAt = new Date().toISOString();
    for (const item of this.#queue.splice(0)) this.#record(item.rule, item.event, "SKIPPED_SHUTDOWN", null, finishedAt);
    await this.#draining;
  }

  #startDrain(): void {
    const task = this.#drain().finally(() => {
      if (this.#draining === task) this.#draining = undefined;
      if (!this.#closed && this.#queue.length > 0) this.#startDrain();
    });
    this.#draining = task;
  }


  async #drain(): Promise<void> {
    try {
      while (!this.#closed) {
        const item = this.#queue.shift();
        if (item === undefined) break;
        await this.#execute(item.rule, item.event);
      }
    } catch {
      // Execution and recording failures are isolated by design.
    }
  }

  async #execute(rule: CeHookRule, event: CeCommittedMessageEvent): Promise<void> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    this.#record(rule, event, "STARTED", startedAt, null);
    let child: ChildProcess;
    try {
      child = spawn(rule.command, [...rule.args], {
        shell: false,
        cwd: this.#directory,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          LANG: process.env.LANG ?? "",
        },
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      this.#record(rule, event, "SPAWN_FAILED", startedAt, new Date().toISOString(), Date.now() - startedMs, null);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* close still owns the result */ }
      }, rule.timeoutMs);
      const finish = (status: ExecutionStatus, exitCode: number | null, signal: string | null = null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#record(rule, event, status, startedAt, new Date().toISOString(), Date.now() - startedMs, exitCode, signal, timedOut);
        resolve();
      };
      child.once("error", () => finish("SPAWN_FAILED", null));
      child.once("close", (code, signal) => finish(timedOut ? "TIMEOUT" : code === 0 ? "SUCCEEDED" : "FAILED", code, signal));
      try {
        child.stdin?.on("error", () => { /* process close owns the outcome */ });
        child.stdin?.end(JSON.stringify(event));
      } catch {
        try { child.kill("SIGKILL"); } catch { /* process close owns the outcome */ }
      }
    });
  }

  #record(
    rule: CeHookRule,
    event: CeCommittedMessageEvent,
    status: ExecutionStatus,
    startedAt: string | null,
    finishedAt: string | null,
    durationMs?: number,
    exitCode?: number | null,
    signal?: string | null,
    timeout?: boolean,
  ): void {
    try {
      const record: ExecutionRecord = {
        hookId: rule.id,
        eventKey: event.eventKey,
        messageId: event.messageId,
        status,
        startedAt,
        finishedAt,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeout }),
      };
      const directory = join(this.#directory, "ce-hooks");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return;
      const fd = openSync(join(directory, "executions.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid())) return;
        appendFileSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Execution records are local evidence only, never CE message state.
    }
  }
}
