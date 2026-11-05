import { isDeepStrictEqual } from "node:util";
import { CeHostRefusal, type CeMappingIdentifiers } from "../dist/endpoints/pi/session-host.js";
import { intersectRegistration, readSelectedMultiSessionPolicy, type MultiSessionSnapshot } from "../dist/tunnel/multi-session-policy.js";
import { type LiveSnapshot, type LiveReaderWatermark } from "../dist/tunnel/live-session-policy.js";

import { readRuntimeLivePolicy } from "./live-session-profile.js";
import { acquireSessionProcessMutex, type SessionProcessMutex } from "../dist/tunnel/session-process-mutex.js";

export type RuntimePolicy = MultiSessionSnapshot | LiveSnapshot;
const live = (policy: RuntimePolicy): policy is LiveSnapshot => "ref" in policy;
interface Transfer {
  readonly loaded: RuntimePolicy;
  readonly mapping: CeMappingIdentifiers;
  readonly mutex: SessionProcessMutex;
}
// Pi /reload may replace both the factory and module instance. Only an explicit
// closed+drained transfer deposits an object here; matching PIDs never grant it.
const KEY = Symbol.for("ce-chat-exchange.pi-multi-session-handoff-v1");
const state = ((globalThis as typeof globalThis & { [KEY]?: { transfers: Map<string, Transfer>; failed: Set<string> } })[KEY] ??= {
  transfers: new Map(), failed: new Set(),
});
/** Read-only refusal probe; recovery must never clear or bypass this cache. */
export function runtimeHasFailed(loaded: RuntimePolicy, runtimeId: string, allScopes = false): boolean {
  if (allScopes) {
    for (const key of state.failed) {
      try {
        const scope: unknown = JSON.parse(key);
        if (!Array.isArray(scope) || scope.length !== 3 || typeof scope[2] !== "string") return true;
        if (scope[2] === runtimeId) return true;
      } catch { return true; }
    }
    return false;
  }
  const registration = loaded.manifest.registrations.find(r => r.runtimeSessionId === runtimeId);
  return registration !== undefined && state.failed.has(JSON.stringify([loaded.manifest.store, registration.endpointId, runtimeId]));
}
export const policyDenied = (): CeHostRefusal => new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, "ADMISSION_POLICY_DENIED");
export function runtimeEnvironment(): string {
  return JSON.stringify([process.env.CE_ALLOWLIST, process.env.CE_STORE_DIR, process.env.CE_STORE_FILE,
    process.env.CE_LEASE_TTL_SECONDS, process.env.CE_TUNNEL_PROFILE]);
}
export class PiMultiSessionRuntime {
  readonly #loaded: RuntimePolicy;
  readonly #runtimeId: string;
  readonly #currentRuntime: () => string;
  readonly #environment: string;
  readonly #key: string;
  readonly #mutex: SessionProcessMutex;
  readonly #currentPolicy: () => RuntimePolicy;
  constructor(loaded: RuntimePolicy, runtimeId: string, currentRuntime: () => string, reload: boolean, mapping: unknown, currentPolicy?: () => RuntimePolicy) {
    this.#loaded = loaded; this.#runtimeId = runtimeId; this.#currentRuntime = currentRuntime; this.#environment = runtimeEnvironment();
    const watermark: LiveReaderWatermark = live(loaded) ? { sequence: loaded.sequence, digest: loaded.digest, policyId: loaded.ref.policyId } : {};
    this.#currentPolicy = currentPolicy ?? (() => live(loaded) ? readRuntimeLivePolicy(loaded, watermark) : readSelectedMultiSessionPolicy(loaded.profilePath));
    const r = liveRegistration(loaded, this.#currentPolicy(), runtimeId);
    this.#key = JSON.stringify([loaded.manifest.store, r.endpointId, runtimeId]);
    if (state.failed.has(this.#key)) throw policyDenied();
    const pending = state.transfers.get(this.#key);
    if (pending !== undefined) {
      if (!reload || !isDeepStrictEqual(mapping, pending.mapping) || live(pending.loaded) !== live(loaded)) throw policyDenied();
      // Identity/epoch continuity; permission generations are checked again on each call.
      if (live(pending.loaded) && live(loaded)) assertLiveRegistrationContinuity(pending.loaded, loaded, runtimeId);
      else if (!live(pending.loaded) && !live(loaded)) intersectRegistration(pending.loaded, loaded, runtimeId);
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
        const r = liveRegistration(this.#loaded, this.#currentPolicy(), this.#runtimeId);
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
    continuity(this.#loaded, this.#currentPolicy(), this.#runtimeId);
  }
  release(cleanup: { readonly released: boolean; readonly detached: boolean }): void {
    try { this.#mutex.release(cleanup); } catch (error) { this.fail(); throw error; }
  }
  fail(): void { state.failed.add(this.#key); }
}

/** Generic policy entry point used by callers without the PiSessionPolicy facade. */
export function liveRegistration(loaded: RuntimePolicy, current: RuntimePolicy, runtimeId: string) {
  if (live(loaded) && live(current)) return effectiveLiveRegistration(loaded, current, runtimeId);
  if (!live(loaded) && !live(current)) return intersectRegistration(loaded, current, runtimeId);
  throw policyDenied();
}
function continuity(loaded: RuntimePolicy, current: RuntimePolicy, runtimeId: string) {
  if (live(loaded) && live(current)) return assertLiveRegistrationContinuity(loaded, current, runtimeId);
  if (!live(loaded) && !live(current)) return intersectRegistration(loaded, current, runtimeId);
  throw policyDenied();
}

/** Reload may capture newer permission/Hook generations; identity and epoch stay fixed. */
export function assertLiveRegistrationContinuity(loaded: LiveSnapshot, current: LiveSnapshot, runtimeId: string) {
  if (!isDeepStrictEqual(loaded.ref, current.ref) || !isDeepStrictEqual(loaded.manifest.identity, current.manifest.identity) ||
    !isDeepStrictEqual(loaded.manifest.store, current.manifest.store) || !isDeepStrictEqual(loaded.manifest.exchange, current.manifest.exchange) ||
    !isDeepStrictEqual(loaded.manifest.chatgptEndpoint, current.manifest.chatgptEndpoint)) throw policyDenied();
  const a = loaded.manifest.registrations.find(r => r.runtimeSessionId === runtimeId);
  const b = current.manifest.registrations.find(r => r.runtimeSessionId === runtimeId);
  if (a === undefined || b === undefined || a.status !== "active" || b.status !== "active" || a.endpointId !== b.endpointId ||
    a.epoch !== b.epoch || (loaded.ref.kind !== "ce-live-session-v2" && !isDeepStrictEqual(a.hooks, b.hooks)) || b.payloadReadGeneration < a.payloadReadGeneration || b.ackGeneration < a.ackGeneration) throw policyDenied();
  return b;
}
export function effectiveLiveRegistration(loaded: LiveSnapshot, current: LiveSnapshot, runtimeId: string) {
  const b = assertLiveRegistrationContinuity(loaded, current, runtimeId);
  const a = loaded.manifest.registrations.find(r => r.runtimeSessionId === runtimeId)!;
  return Object.freeze({ ...b, payloadRead: b.payloadRead && a.payloadRead && b.payloadReadGeneration === a.payloadReadGeneration,
    ack: b.ack && a.ack && b.ackGeneration === a.ackGeneration });
}
