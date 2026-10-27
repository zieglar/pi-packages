/**
 * HANDOFF-853274 — bound endpoint lifecycle tests (admission + heartbeat).
 *
 * The bound endpoint is the only object the MCP server can call: the Endpoint
 * is fixed, `requireUnowned` guards the start, the heartbeat renews, and any
 * uncertain renewal permanently blocks new sends. These tests use a scripted
 * fake host plus a manual timer queue so every transition is deterministic.
 */
import { describe, expect, it } from "vitest";
import { CeHostRefusal, type CeEndpointHost } from "../../src/host/endpoint-host.js";
import { CeBoundEndpoint, type BoundEndpointEvent, type TimerSeams } from "../../src/host/bound-endpoint.js";

type Script = Partial<
  Record<"beginSession" | "renew" | "end" | "send" | "listInbox" | "readPayload", ((...args: never[]) => unknown) | undefined>
>;

function refusal(code: string, retryable = false, reason?: string): CeHostRefusal {
  return new CeHostRefusal(code as never, retryable, reason);
}

function expectThrows(run: () => unknown, shape: Record<string, unknown>): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject(shape);
    return;
  }
  throw new Error("expected a refusal");
}

function fakeHost(script: Script = {}) {
  const calls: Record<string, unknown[][]> = {};
  const host = {
    beginSession: (...args: unknown[]) => {
      (calls.beginSession ??= []).push(args);
      const fn = script.beginSession;
      return fn ? fn(...(args as never[])) : { endpointId: args[0], participantId: "p", sessionId: "s", exchangeId: "e" };
    },
    renew: (...args: unknown[]) => {
      (calls.renew ??= []).push(args);
      const fn = script.renew;
      return fn ? fn(...(args as never[])) : { fencingToken: 1, expiresAt: "soon" };
    },
    end: (...args: unknown[]) => {
      (calls.end ??= []).push(args);
      const fn = script.end;
      return fn ? fn(...(args as never[])) : { released: true, detached: true };
    },
    send: (...args: unknown[]) => {
      (calls.send ??= []).push(args);
      const fn = script.send;
      return fn ? fn(...(args as never[])) : { disposition: "CREATED", messageId: "m1", auditSequence: 1, recipient: "r" };
    },
    listInbox: (...args: unknown[]) => {
      (calls.listInbox ??= []).push(args);
      return { messages: [], continuationAuditSequence: null, scanBudgetExhausted: false };
    },
    readPayload: (...args: unknown[]) => {
      (calls.readPayload ??= []).push(args);
      return { messageId: "m1", payloadText: "hello" };
    },
  };
  return { host: host as unknown as CeEndpointHost, calls };
}

class ManualTimers implements TimerSeams {
  readonly #queue: Array<{ callback: () => void; cleared: boolean }> = [];
  readonly intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];

  setInterval = (callback: () => void, ms: number) => {
    const entry = { callback, ms, cleared: false };
    this.intervals.push(entry);
    this.#queue.push(entry);
    return entry;
  };

  clearInterval = (handle: unknown) => {
    const entry = handle as { cleared: boolean };
    entry.cleared = true;
  };

  get liveCount(): number {
    return this.intervals.filter((entry) => !entry.cleared).length;
  }

  /** Fire every live interval once. */
  tick(): void {
    for (const entry of [...this.#queue]) {
      if (!entry.cleared) entry.callback();
    }
  }
}

function start(script: Script = {}) {
  const { host, calls } = fakeHost(script);
  const timers = new ManualTimers();
  const events: BoundEndpointEvent[] = [];
  const bound = CeBoundEndpoint.start(host, "chatgpt/main", {
    renewIntervalMs: 30_000,
    timers,
    onEvent: (event) => events.push(event),
  });
  return { bound, calls, timers, events };
}

describe("bound endpoint: start", () => {
  it("binds with requireUnowned and starts exactly one heartbeat", () => {
    const { bound, calls, timers } = start();
    expect(calls.beginSession).toEqual([["chatgpt/main", { requireUnowned: true }]]);
    expect(timers.intervals).toHaveLength(1);
    expect(timers.intervals[0]).toMatchObject({ ms: 30_000, cleared: false });
    expect(bound.state).toBe("ACTIVE");
  });

  it("propagates a start refusal without starting a heartbeat", () => {
    const { host, calls } = fakeHost({ beginSession: () => { throw refusal("CE_HOST_AUTHORITY_ABSENT", false, "OWNERSHIP_HELD"); } });
    const timers = new ManualTimers();
    expectThrows(() => CeBoundEndpoint.start(host, "chatgpt/main", { renewIntervalMs: 30_000, timers }), { code: "CE_HOST_AUTHORITY_ABSENT" });
    expect(timers.intervals).toHaveLength(0);
    expect(calls.renew).toBeUndefined();
  });

  it("refuses a non-positive renewal interval", () => {
    const { host } = fakeHost();
    expectThrows(() => CeBoundEndpoint.start(host, "x", { renewIntervalMs: 0 }), { code: "CE_HOST_INVALID_REQUEST" });
  });
});

describe("bound endpoint: admission", () => {
  it("sends through the fixed endpoint with exactly the admitted fields", () => {
    const { bound, calls } = start();
    bound.send({ to: "pi/main", text: "hi", idempotencyKey: "k1" });
    expect(calls.send).toEqual([["chatgpt/main", { to: "pi/main", text: "hi", idempotencyKey: "k1" }]]);
  });

  it("omits undefined inbox options instead of passing them through", () => {
    const { bound, calls } = start();
    bound.listInbox({ afterAuditSequence: 5 });
    expect(calls.listInbox).toEqual([["chatgpt/main", { afterAuditSequence: 5 }]]);
    bound.listInbox({});
    expect(calls.listInbox![1]).toEqual(["chatgpt/main", {}]);
  });

  it("reads payloads by explicit id only", () => {
    const { bound, calls } = start();
    bound.readPayload({ messageId: "m1" });
    expect(calls.readPayload).toEqual([["chatgpt/main", { messageId: "m1" }]]);
  });
});

describe("bound endpoint: heartbeat", () => {
  it("renews on every tick and observes renewal", () => {
    const { bound, calls, timers, events } = start();
    timers.tick();
    timers.tick();
    expect(calls.renew).toHaveLength(2);
    expect(events.filter((event) => event.kind === "renewed")).toHaveLength(2);
    expect(bound.state).toBe("ACTIVE");
  });

  it("defers on BUSY: stays active, keeps the heartbeat, retries next tick", () => {
    let busy = true;
    const { bound, calls, timers, events } = start({
      renew: () => {
        if (busy) throw refusal("CE_HOST_BUSY", true);
        return { fencingToken: 2, expiresAt: "later" };
      },
    });
    timers.tick();
    expect(bound.state).toBe("ACTIVE");
    expect(events).toEqual([{ kind: "renewal_deferred", code: "CE_HOST_BUSY" }]);
    busy = false;
    timers.tick();
    expect(calls.renew).toHaveLength(2);
    // Sends never stopped during the deferral.
    expect(() => bound.send({ to: "x", text: "t", idempotencyKey: "k" })).not.toThrow();
  });

  it("stops permanently on UNCERTAIN renewal and blocks writes, not reads", () => {
    const { bound, calls, timers, events } = start({
      renew: () => { throw refusal("CE_HOST_UNCERTAIN", false, "SQLITE_BUSY_COMMIT"); },
    });
    timers.tick();
    expect(bound.state).toBe("WRITE_BLOCKED");
    expect(timers.liveCount).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: "renewal_stopped", code: "CE_HOST_UNCERTAIN" });
    expectThrows(() => bound.send({ to: "x", text: "t", idempotencyKey: "k" }), {
      code: "CE_HOST_UNCERTAIN",
      reason: "LEASE_RENEWAL_STOPPED",
      retryable: false,
    });
    expect(() => bound.listInbox({})).not.toThrow();
    expect(() => bound.readPayload({ messageId: "m1" })).not.toThrow();
    timers.tick();
    expect(calls.renew).toHaveLength(1);
  });

  it("treats an unexpected renewal error as fail-closed authority loss", () => {
    const { bound, timers } = start({ renew: () => { throw new Error("sqlite locked: /var/private/secret"); } });
    timers.tick();
    expect(bound.state).toBe("WRITE_BLOCKED");
    expectThrows(() => bound.send({ to: "x", text: "t", idempotencyKey: "k" }), { code: "CE_HOST_AUTHORITY_ABSENT" });
  });

  it("ignores an observer that throws", () => {
    const timers = new ManualTimers();
    const { host } = fakeHost();
    const broken = CeBoundEndpoint.start(host, "chatgpt/main", {
      renewIntervalMs: 30_000,
      timers,
      onEvent: () => { throw new Error("observer exploded"); },
    });
    // The heartbeat actually runs: the observer throws inside #emit and the
    // endpoint must survive it and keep renewing.
    timers.tick();
    timers.tick();
    expect(broken.state).toBe("ACTIVE");
  });
});

describe("bound endpoint: shutdown", () => {
  it("ends exactly once: release and detach, heartbeat cleared, idempotent", async () => {
    const { bound, calls, timers } = start();
    const first = await bound.shutdown();
    expect(first).toEqual({ released: true, detached: true, code: undefined, reason: undefined });
    expect(await bound.shutdown()).toBe(first);
    expect(calls.end).toEqual([["chatgpt/main"]]);
    expect(timers.liveCount).toBe(0);
    expect(bound.state).toBe("CLOSED");
  });

  it("refuses every call after shutdown starts", async () => {
    const { bound } = start();
    const pending = bound.shutdown();
    expectThrows(() => bound.send({ to: "x", text: "t", idempotencyKey: "k" }), { code: "CE_HOST_UNAVAILABLE", reason: "ENDPOINT_CLOSING" });
    expect(() => bound.listInbox({})).toThrow();
    await pending;
  });

  it("reports an unknown release outcome once and never retries it", async () => {
    const { bound, calls } = start({ end: () => { throw refusal("CE_HOST_UNCERTAIN", false, "SQLITE_BUSY"); } });
    const outcome = await bound.shutdown();
    expect(outcome).toMatchObject({ released: false, detached: false, code: "CE_HOST_UNCERTAIN" });
    expect(await bound.shutdown()).toBe(outcome);
    expect(calls.end).toHaveLength(1);
  });
});
