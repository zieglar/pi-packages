import type { DurableTaskStore } from "../durable/contracts.js";
import type { AuthoritativeTaskState } from "../durable/state.js";
import type { ExecutionResult } from "../types/result.js";
import { success } from "../types/result.js";
import { WakeupService } from "./wakeup-service.js";

export interface StartupScanResult {
  readonly discovered: number;
  readonly processed: number;
  readonly reconciled: number;
}

/**
 * One startup pass over authoritative durable state. It has no timer or loop:
 * the caller chooses when to invoke it. Lease ownership and all transitions
 * remain inside WakeupService.
 */
export class StartupRecoveryScanner {
  constructor(
    private readonly store: DurableTaskStore,
    private readonly wakeup: WakeupService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async scan(options?: { readonly isOwnedTask?: (taskId: string) => boolean }): Promise<ExecutionResult<StartupScanResult>> {
    // Reconcile previous-execution running tasks FIRST: wakeup continuations
    // launched later in this same scan must never be self-interrupted.
    const reconciled = await this.wakeup.reconcileInterruptedRunning(options?.isOwnedTask);
    if (!reconciled.ok) return reconciled;
    const listed = await this.store.list();
    if (!listed.ok) return listed;
    const nowMs = this.now();
    const discovered = listed.value.filter((state) => this.isResumableDue(state, nowMs)).length;
    if (discovered === 0) {
      return success({ discovered: 0, processed: 0, reconciled: reconciled.value.reconciled });
    }

    const woke = await this.wakeup.scanDueTasks();
    if (!woke.ok) return woke;
    return success({ discovered, processed: woke.value.processed, reconciled: reconciled.value.reconciled });
  }

  private isResumableDue(state: AuthoritativeTaskState, nowMs: number): boolean {
    if (state.status === "suspended" && state.suspension !== null) {
      return state.suspension.nextCheckAtMs <= nowMs;
    }
    return state.status === "resuming" &&
      (state.continuation === null || state.continuation.phase === "reserved" || state.continuation.phase === "launching");
  }
}
