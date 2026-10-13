/**
 * HANDOFF-853274 — one host-owned Endpoint bound for a single-instance
 * control surface (the local MCP server).
 *
 * This is the object injected into the MCP server as its messaging port. It
 * carries NO endpoint parameter on any call: the Endpoint is fixed at
 * construction from the trusted launch configuration. All authority still
 * flows through `CeEndpointHost` (and from there through Storage); this class
 * only adds admission gating and the opt-in lease lifecycle:
 *
 * - start: `beginSession({ requireUnowned: true })` — an existing ownership row
 *   (live or expired, e.g. after a crash) refuses before any durable write.
 *   No adoption and no takeover (CE-TAKEOVER-RECOVERY-CALLER-001 unresolved).
 * - heartbeat: `host.renew` on a fixed interval. BUSY rolled back and is
 *   retried only at the next tick; UNCERTAIN or any authority refusal stops
 *   the heartbeat permanently and blocks new sends (no blind retry).
 * - shutdown: stop admitting calls, wait for in-flight calls, stop the
 *   heartbeat, then `host.end` (release, then detach) exactly once. An unknown
 *   outcome is reported, never retried.
 */
import {
  CeHostRefusal,
  type CeEndpointHost,
  type CeInboxResult,
  type CeReadPayloadResult,
  type CeSendResult,
} from "./endpoint-host.js";

export interface TimerSeams {
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export type BoundEndpointEvent =
  | { readonly kind: "renewed" }
  | { readonly kind: "renewal_deferred"; readonly code: string }
  | { readonly kind: "renewal_stopped"; readonly code: string; readonly reason: string | undefined };

export interface BoundEndpointOptions {
  readonly renewIntervalMs: number;
  readonly timers?: TimerSeams;
  /** Code-only lifecycle observations (never identifiers or payload). */
  readonly onEvent?: (event: BoundEndpointEvent) => void;
}

export interface BoundEndpointShutdown {
  readonly released: boolean;
  readonly detached: boolean;
  /** Sanitized refusal code when release did not complete; never retried. */
  readonly code: string | undefined;
  readonly reason: string | undefined;
}

type State = "ACTIVE" | "WRITE_BLOCKED" | "CLOSING" | "CLOSED";

const defaultTimers: TimerSeams = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // A heartbeat alone must never keep the process alive.
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class CeBoundEndpoint {
  readonly #host: CeEndpointHost;
  readonly #endpointId: string;
  readonly #timers: TimerSeams;
  readonly #onEvent: ((event: BoundEndpointEvent) => void) | undefined;
  #state: State = "ACTIVE";
  #blockedReason: string | undefined;
  #heartbeat: unknown;
  #inFlight = 0;
  #shutdown: Promise<BoundEndpointShutdown> | undefined;

  private constructor(host: CeEndpointHost, endpointId: string, options: BoundEndpointOptions) {
    this.#host = host;
    this.#endpointId = endpointId;
    this.#timers = options.timers ?? defaultTimers;
    this.#onEvent = options.onEvent;
  }

  /** Bind the fixed Endpoint (refusing any existing ownership before writes)
   * and start the renewal heartbeat. Throws the sanitized host refusal. */
  static start(host: CeEndpointHost, endpointId: string, options: BoundEndpointOptions): CeBoundEndpoint {
    if (!Number.isSafeInteger(options.renewIntervalMs) || options.renewIntervalMs < 1) {
      throw new CeHostRefusal("CE_HOST_INVALID_REQUEST");
    }
    host.beginSession(endpointId, { requireUnowned: true });
    const bound = new CeBoundEndpoint(host, endpointId, options);
    bound.#heartbeat = bound.#timers.setInterval(() => bound.#renew(), options.renewIntervalMs);
    return bound;
  }

  get state(): State {
    return this.#state;
  }

  #emit(event: BoundEndpointEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Observation must never affect authority or lifecycle.
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      this.#timers.clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  #renew(): void {
    if (this.#state !== "ACTIVE") return;
    try {
      this.#host.renew(this.#endpointId);
      this.#emit({ kind: "renewed" });
    } catch (error) {
      const refusal = error instanceof CeHostRefusal ? error : new CeHostRefusal("CE_HOST_UNAVAILABLE");
      if (refusal.code === "CE_HOST_BUSY") {
        // Rolled back as a whole: the next tick may try again before expiry.
        this.#emit({ kind: "renewal_deferred", code: refusal.code });
        return;
      }
      // UNCERTAIN, authority loss, or any other refusal: never retry blindly.
      this.#stopHeartbeat();
      this.#state = "WRITE_BLOCKED";
      this.#blockedReason = refusal.code;
      this.#emit({ kind: "renewal_stopped", code: refusal.code, reason: refusal.reason });
    }
  }

  #admit(write: boolean): void {
    if (this.#state === "CLOSING" || this.#state === "CLOSED") {
      throw new CeHostRefusal("CE_HOST_UNAVAILABLE", false, "ENDPOINT_CLOSING");
    }
    if (write && this.#state === "WRITE_BLOCKED") {
      throw new CeHostRefusal(
        this.#blockedReason === "CE_HOST_UNCERTAIN" ? "CE_HOST_UNCERTAIN" : "CE_HOST_AUTHORITY_ABSENT",
        false,
        "LEASE_RENEWAL_STOPPED",
      );
    }
  }

  #run<T>(write: boolean, operation: () => T): T {
    this.#admit(write);
    this.#inFlight += 1;
    try {
      return operation();
    } finally {
      this.#inFlight -= 1;
    }
  }

  send(input: { readonly to: string; readonly text: string; readonly idempotencyKey: string }): CeSendResult {
    return this.#run(true, () =>
      this.#host.send(this.#endpointId, { to: input.to, text: input.text, idempotencyKey: input.idempotencyKey }),
    );
  }

  listInbox(input: {
    readonly afterAuditSequence?: number;
    readonly pageSize?: number;
    readonly rawScanLimit?: number;
  }): CeInboxResult {
    const request: Record<string, number> = {};
    if (input.afterAuditSequence !== undefined) request.afterAuditSequence = input.afterAuditSequence;
    if (input.pageSize !== undefined) request.pageSize = input.pageSize;
    if (input.rawScanLimit !== undefined) request.rawScanLimit = input.rawScanLimit;
    return this.#run(false, () => this.#host.listInbox(this.#endpointId, request));
  }

  readPayload(input: { readonly messageId: string }): CeReadPayloadResult {
    return this.#run(false, () => this.#host.readPayload(this.#endpointId, { messageId: input.messageId }));
  }

  /** Graceful, idempotent shutdown. Calls after the first return the first
   * outcome; the release is attempted at most once per process. */
  shutdown(drainTimeoutMs = 5_000): Promise<BoundEndpointShutdown> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#state = "CLOSING";
    this.#shutdown = (async () => {
      const deadline = Date.now() + drainTimeoutMs;
      while (this.#inFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      this.#stopHeartbeat();
      try {
        const ended = this.#host.end(this.#endpointId);
        return Object.freeze({ released: ended.released, detached: ended.detached, code: undefined, reason: undefined });
      } catch (error) {
        const refusal = error instanceof CeHostRefusal ? error : new CeHostRefusal("CE_HOST_UNAVAILABLE");
        return Object.freeze({ released: false, detached: false, code: refusal.code, reason: refusal.reason });
      } finally {
        this.#state = "CLOSED";
      }
    })();
    return this.#shutdown;
  }
}
