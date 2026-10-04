import { homedir } from "node:os";
import { join } from "node:path";
import { durableTaskStoreRoot, FilesystemDurableTaskStore } from "../durable/filesystem-task-store.js";
import type { AuthoritativeTaskState } from "../durable/state.js";
import { captureWorkspaceCheckpoint } from "../durable/workspace-checkpoint.js";
import type { HealthRegistry } from "../recovery/health-registry.js";
import { evaluateResumeAvailability, type ResumeAvailability } from "../recovery/resume-availability.js";
import { StartupRecoveryScanner } from "../recovery/startup-recovery-scan.js";
import { WakeupService } from "../recovery/wakeup-service.js";
import { PiContinuationLauncher, PiSdkContinuationSessionFactory } from "./pi-continuation-launcher.js";
import { workflowDiskSinkRoot } from "./workflow-disk-sink.js";
import type { ContinuationLauncher } from "../durable/contracts.js";

/**
 * The single live durable composition root. Everything the extension needs
 * from the Phase 1B.2 durable stack is constructed here and nowhere else in
 * production source: the authoritative filesystem task store (with fenced
 * leases), the wakeup scheduler, the startup recovery scanner, and the Pi
 * continuation launcher. The store lives under the Wayforge subtree of the
 * active Pi agent directory (`<agent>/wayforge/tasks`), and continuation
 * sessions always use an isolated agent directory below the same subtree —
 * never production Pi configuration.
 */

export interface DurableCompositionOptions {
  /** Session workspace used as the continuation working directory. */
  readonly cwd: string;
  /** Overrides the durable store root (tests and isolated profiles). */
  readonly storeRoot?: string;
  /** Overrides the continuation agent directory (tests and isolated profiles). */
  readonly agentDir?: string;
  readonly now?: () => number;
  /** Replaces the continuation launcher boundary (deterministic tests). */
  readonly launcher?: ContinuationLauncher;
  readonly leaseTtlMs?: number;
  readonly maxContinuationLaunches?: number;
  readonly maxRecoveryAttempts?: number;
  /** Live health registry of a running workflow; enables probe strategies. */
  readonly health?: HealthRegistry;
}

export interface DurableExecution {
  readonly store: FilesystemDurableTaskStore;
  readonly wakeup: WakeupService;
  readonly scanner: StartupRecoveryScanner;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_CONTINUATION_LAUNCHES = 3;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 5;

function timeBasedAvailability(now: () => number): (state: AuthoritativeTaskState) => ResumeAvailability {
  return (state) => {
    const suspension = state.suspension;
    if (state.status !== "suspended" || suspension === null) {
      return { available: false, reason: "not_suspended" };
    }
    if (now() < suspension.resumeNotBeforeMs) {
      return { available: false, reason: "resume_not_before" };
    }
    if (suspension.strategy === "explicit_reset") return { available: true, reason: "explicit_reset_elapsed" };
    if (suspension.strategy === "retry_after") return { available: true, reason: "retry_after_elapsed" };
    if (suspension.strategy === "known_quota_window") {
      return { available: true, reason: "known_quota_window_elapsed" };
    }
    // Probe-based strategies need a live workflow health registry; without one
    // the wakeup scheduler reschedules instead of resuming optimistically.
    return { available: false, reason: "health_unavailable" };
  };
}

export function createDurableExecution(options: DurableCompositionOptions): DurableExecution {
  const now = options.now ?? (() => Date.now());
  const wayforgeRoot = workflowDiskSinkRoot();
  const store = new FilesystemDurableTaskStore(
    options.storeRoot ?? durableTaskStoreRoot(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi")),
    { now },
  );
  const launcher: ContinuationLauncher =
    options.launcher ??
    new PiContinuationLauncher({
      factory: new PiSdkContinuationSessionFactory({
        cwd: options.cwd,
        agentDir: options.agentDir ?? `${wayforgeRoot}/agent`,
      }),
    });

  const health = options.health;
  const wakeup = new WakeupService({
    store,
    launcher,
    now,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    maxContinuationLaunches: options.maxContinuationLaunches ?? DEFAULT_MAX_CONTINUATION_LAUNCHES,
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS,
    captureWorkspace: async (state) => {
      if (state.workspace === null) throw new Error("workspace checkpoint missing");
      const captured = await captureWorkspaceCheckpoint({
        workspaceRoot: state.workspace.workspaceRoot,
        taskWriteSet: state.workspace.taskWriteSet,
        capturedAtMs: now(),
      });
      if (!captured.ok) throw new Error(captured.failure.code);
      return captured.value;
    },
    ...(health !== undefined
      ? { evaluateAvailability: (state: AuthoritativeTaskState) => evaluateResumeAvailability(state, health, now()) }
      : { evaluateAvailability: timeBasedAvailability(now) }),
  });

  const scanner = new StartupRecoveryScanner(store, wakeup, now);
  return { store, wakeup, scanner };
}
