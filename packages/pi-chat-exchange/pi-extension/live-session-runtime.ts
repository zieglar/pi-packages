import { isDeepStrictEqual } from "node:util";
import type { CeMappingIdentifiers } from "../dist/endpoints/pi/session-host.js";
import type { LiveSnapshot, LiveReaderWatermark } from "../dist/tunnel/live-session-policy.js";
import { readSelectedMultiSessionPolicy, type MultiSessionSnapshot } from "../dist/tunnel/multi-session-policy.js";
import { PiMultiSessionRuntime, liveRegistration, policyDenied, runtimeEnvironment } from "./multi-session-runtime.js";
import { readRuntimeLivePolicy } from "./live-session-profile.js";

export { effectiveLiveRegistration as liveRegistration } from "./multi-session-runtime.js";
export type SelectedSessionPolicy = MultiSessionSnapshot | LiveSnapshot;
export const isLivePolicy = (policy: SelectedSessionPolicy): policy is LiveSnapshot => "ref" in policy;

/** Captured factory grants never advance. Only an official replacement can load
 * newer generations; mutex transfer carries identifiers, never CE capabilities. */
export class PiSessionPolicy {
  readonly loaded: SelectedSessionPolicy;
  readonly #runtimeId: string;
  readonly #currentRuntime: () => string;
  readonly #environment: string;
  readonly #runtime: PiMultiSessionRuntime;
  readonly #watermark: LiveReaderWatermark;
  constructor(loaded: SelectedSessionPolicy, runtimeId: string, currentRuntime: () => string, reload: boolean, mapping: unknown) {
    this.loaded = loaded; this.#runtimeId = runtimeId; this.#currentRuntime = currentRuntime; this.#environment = runtimeEnvironment();
    this.#watermark = isLivePolicy(loaded) ? { sequence: loaded.sequence, digest: loaded.digest, policyId: loaded.ref.policyId } : {};
    this.#runtime = new PiMultiSessionRuntime(loaded, runtimeId, currentRuntime, reload, mapping, () => this.current());
  }
  get store(): MultiSessionSnapshot["manifest"]["store"] { return this.loaded.manifest.store; }
  current(): SelectedSessionPolicy {
    this.assertContext();
    return isLivePolicy(this.loaded) ? readRuntimeLivePolicy(this.loaded, this.#watermark) : readSelectedMultiSessionPolicy(this.loaded.profilePath);
  }
  registration() {
    const r = liveRegistration(this.loaded, this.current(), this.#runtimeId);
    if (!isDeepStrictEqual(r.hooks, this.hooks(this.loaded))) throw policyDenied();
    return r;
  }
  hooks(policy: SelectedSessionPolicy) { return policy.manifest.registrations.find(r => r.runtimeSessionId === this.#runtimeId)?.hooks; }
  run<T>(kind: string, operation: () => T): T { return this.#runtime.run(kind, operation); }
  closeAdmission(): void { this.#runtime.closeAdmission(); }
  drain(): Promise<void> { return this.#runtime.drain(); }
  transfer(mapping: CeMappingIdentifiers): void { this.#runtime.transfer(mapping); }
  release(cleanup: { readonly released: boolean; readonly detached: boolean }): void { this.#runtime.release(cleanup); }
  fail(): void { this.#runtime.fail(); }
  assertContext(): void {
    if (this.#currentRuntime() !== this.#runtimeId || runtimeEnvironment() !== this.#environment) throw policyDenied();
  }
}
