/** Pi composition only. Deny-only policy + local process exclusion, never CE authority. */
import { isDeepStrictEqual } from "node:util";
import { CeHostRefusal, type CeMappingIdentifiers } from "../dist/endpoints/pi/session-host.js";
import { intersectRegistration, readSelectedMultiSessionPolicy, type MultiSessionSnapshot } from "../dist/tunnel/multi-session-policy.js";
import { acquireSessionProcessMutex, type SessionProcessMutex } from "../dist/tunnel/session-process-mutex.js";

interface Transfer {
  readonly loaded: MultiSessionSnapshot;
  readonly mapping: CeMappingIdentifiers;
  readonly mutex: SessionProcessMutex;
}
// Pi /reload may replace both the factory and module instance. Only an explicit
// closed+drained transfer deposits an object here; matching PIDs never grant it.
const KEY = Symbol.for("ce-chat-exchange.pi-multi-session-handoff-v1");
const state = ((globalThis as typeof globalThis & { [KEY]?: { transfers: Map<string, Transfer>; failed: Set<string> } })[KEY] ??= {
  transfers: new Map(), failed: new Set(),
});
export const policyDenied = (): CeHostRefusal => new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, "ADMISSION_POLICY_DENIED");
export function runtimeEnvironment(): string {
  return JSON.stringify([process.env.CE_ALLOWLIST, process.env.CE_STORE_DIR, process.env.CE_STORE_FILE,
    process.env.CE_LEASE_TTL_SECONDS, process.env.CE_TUNNEL_PROFILE]);
}
export class PiMultiSessionRuntime {
  readonly #loaded: MultiSessionSnapshot;
  readonly #runtimeId: string;
  readonly #currentRuntime: () => string;
  readonly #environment: string;
  readonly #key: string;
  readonly #mutex: SessionProcessMutex;
  constructor(loaded: MultiSessionSnapshot, runtimeId: string, currentRuntime: () => string, reload: boolean, mapping: unknown) {
    this.#loaded = loaded; this.#runtimeId = runtimeId; this.#currentRuntime = currentRuntime; this.#environment = runtimeEnvironment();
    const r = intersectRegistration(loaded, readSelectedMultiSessionPolicy(loaded.profilePath), runtimeId);
    this.#key = JSON.stringify([loaded.manifest.store, r.endpointId, runtimeId]);
    if (state.failed.has(this.#key)) throw policyDenied();
    const pending = state.transfers.get(this.#key);
    if (pending !== undefined) {
      if (!reload || !isDeepStrictEqual(mapping, pending.mapping)) throw policyDenied();
      // Exact Store/Exchange/Tunnel + registration epoch, not generation digest:
      // adding an unrelated B cannot disable A's valid transfer.
      intersectRegistration(pending.loaded, loaded, runtimeId);
      pending.mutex.assertOwnership();
      this.#mutex = pending.mutex;
      state.transfers.delete(this.#key); // one consumer, no second handle
    } else {
      this.#mutex = acquireSessionProcessMutex({ store: loaded.manifest.store, endpointId: r.endpointId, runtimeSessionId: runtimeId });
    }
  }
  run<T>(kind: string, operation: () => T): T {
    return this.#mutex.run(() => {
      try {
        if (runtimeEnvironment() !== this.#environment || this.#currentRuntime() !== this.#runtimeId) throw policyDenied();
        const r = intersectRegistration(this.#loaded, readSelectedMultiSessionPolicy(this.#loaded.profilePath), this.#runtimeId);
        if ((kind === "payload" && !r.payloadRead) || (kind === "ack" && !r.ack)) throw policyDenied();
      } catch { throw policyDenied(); }
      return operation();
    });
  }
  closeAdmission(): void { this.#mutex.closeAdmission(); }
  drain(): Promise<void> { return this.#mutex.drain(); }
  transfer(mapping: CeMappingIdentifiers): void {
    try {
      this.runPolicyForTransfer();
      if (state.transfers.has(this.#key)) throw policyDenied();
      state.transfers.set(this.#key, { loaded: this.#loaded, mapping: Object.freeze({ ...mapping }), mutex: this.#mutex.explicitTransfer() });
    } catch (error) { this.fail(); throw error; }
  }
  private runPolicyForTransfer(): void {
    if (this.#currentRuntime() !== this.#runtimeId || runtimeEnvironment() !== this.#environment) throw policyDenied();
    intersectRegistration(this.#loaded, readSelectedMultiSessionPolicy(this.#loaded.profilePath), this.#runtimeId);
  }
  release(cleanup: { readonly released: boolean; readonly detached: boolean }): void {
    try { this.#mutex.release(cleanup); } catch (error) { this.fail(); throw error; }
  }
  fail(): void { state.failed.add(this.#key); }
}
