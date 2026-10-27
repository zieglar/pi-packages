/**
 * HANDOFF-CE-HOST-09 B1.1-INTEGRATION — /ce-tunnel authorize command tests.
 *
 * Pinned contract:
 * - `authorize` is the ONLY user-triggered native macOS authorization path.
 *   Non-TUI modes fail closed with CE_TUNNEL_INPUT_UNAVAILABLE and never
 *   construct a store or runner.
 * - Before any keychain access the operator is told that a native prompt will
 *   appear, what Allow vs Always Allow means, and that Deny/Cancel is safe.
 * - A successful authorization is followed by exactly one NONINTERACTIVE read
 *   to report whether the user's decision persists for this helper build.
 * - The credential value never appears in any notification; only closed codes.
 * - USER_CANCELED, KEY_MISSING and AUTH_REQUIRED are surfaced as themselves,
 *   never reinterpreted as a missing credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TunnelRefusal } from "../../../../packages/pi-chat-exchange/dist/tunnel/codes.js";

const MODULE_URL = new URL("../../pi-extension/index.ts", import.meta.url).href;

const requestAuthorization = vi.fn();
const plainRead = vi.fn();
const store = vi.fn();
const dispose = vi.fn();
const createdRunner = vi.fn();
const captureTunnelSecret = vi.fn();

vi.mock("../../../../packages/pi-chat-exchange/dist/tunnel/keychain.js", () => ({
  createKeychainCredentialStore: () => ({
    account: "v1:synthetic",
    exists: async () => true,
    store: (...args: unknown[]) => store(...args),
    read: (...args: unknown[]) => plainRead(...args),
    requestAuthorization: (...args: unknown[]) => requestAuthorization(...args),
    remove: async () => undefined,
  }),
  createNativeKeychainRunner: (options?: { signal?: AbortSignal }) => {
    createdRunner(options?.signal);
    return { run: async () => "", dispose };
  },
  OFFLINE_SYNTHETIC_SCOPE: Object.freeze({ origin: "https://offline-b11.invalid", tunnelId: "tunnel_b11offline" }),
  keychainAccountFor: () => "v1:synthetic",
  TUNNEL_KEYCHAIN_SERVICE: "pi-chat-exchange-tunnel",
}));

vi.mock("../../../../packages/pi-chat-exchange/dist/tunnel/secure-input.js", () => ({
  captureTunnelSecret: (...args: unknown[]) => captureTunnelSecret(...args),
}));

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  // Synthetic Keychain authorization is an explicit offline harness only.
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
  requestAuthorization.mockReset();
  plainRead.mockReset();
  store.mockReset().mockResolvedValue(undefined);
  dispose.mockReset().mockResolvedValue(undefined);
  createdRunner.mockReset();
  captureTunnelSecret.mockReset().mockResolvedValue({ status: "stored" });
});
afterEach(() => vi.unstubAllEnvs());

interface Ctx {
  mode: string;
  hasUI: boolean;
  cwd: string;
  sessionManager: unknown;
  ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn> };
}

type CommandHandler = (args: string, ctx: Ctx) => Promise<void> | void;

function context(mode = "tui"): { ctx: Ctx; notifications: string[] } {
  const notifications: string[] = [];
  const ctx: Ctx = {
    mode,
    hasUI: true,
    cwd: "/synthetic",
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn((m: string) => notifications.push(m)), setStatus: vi.fn(), custom: vi.fn() },
  };
  return { ctx, notifications };
}

async function ceTunnel(): Promise<CommandHandler & { events: Map<string, (event: unknown, ctx: Ctx) => unknown> }> {
  const commands: Array<{ name: string; handler: CommandHandler }> = [];
  const { default: factory } = (await import(MODULE_URL)) as { default: (pi: unknown) => void };
  const events = new Map<string, (event: never, ctx: Ctx) => unknown>();
  factory({
    on: (name: string, handler: (event: never, ctx: Ctx) => unknown) => events.set(name, handler),
    registerTool: () => undefined,
    registerCommand: (name: string, options: { handler: CommandHandler }) => commands.push({ name, handler: options.handler }),
    appendEntry: () => undefined,
  });
  const command = commands.find((c) => c.name === "ce-tunnel");
  expect(command, "/ce-tunnel registration").toBeDefined();
  (command!.handler as unknown as { events?: unknown }).events = events;
  return command!.handler as CommandHandler & { events: Map<string, (event: unknown, ctx: Ctx) => unknown> };
}

const SECRET = "sk-authorize-canary-0007";

describe("B1.1-INTEGRATION /ce-tunnel authorize", () => {
  it("real profile mode never authorizes or reads the synthetic Keychain scope", async () => {
    vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "");
    requestAuthorization.mockResolvedValue(SECRET);
    plainRead.mockResolvedValue(SECRET);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    expect(createdRunner).not.toHaveBeenCalled();
    expect(requestAuthorization).not.toHaveBeenCalled();
    expect(plainRead).not.toHaveBeenCalled();
    expect(notifications.join("\n")).not.toContain(SECRET);
  });

  it("lists authorize in the completions and the help text", async () => {
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("help", ctx);
    expect(notifications.join("\n")).toContain("authorize");
  });

  it.each(["print", "rpc", "json"])("fails closed in %s mode before any keychain access", async (mode) => {
    const handler = await ceTunnel();
    const { ctx, notifications } = context(mode);
    await handler("authorize", ctx);
    expect(notifications.join("\n")).toContain("CE_TUNNEL_INPUT_UNAVAILABLE");
    expect(createdRunner).not.toHaveBeenCalled();
    expect(requestAuthorization).not.toHaveBeenCalled();
  });

  it("explains the native prompt BEFORE touching the keychain, by observed order", async () => {
    requestAuthorization.mockResolvedValue(SECRET);
    plainRead.mockResolvedValue(SECRET);
    const handler = await ceTunnel();
    const order: string[] = [];
    const { ctx } = context();
    const originalNotify = ctx.ui.notify;
    ctx.ui.notify = vi.fn((m: string) => {
      order.push(String(m).includes("will show ONE") ? "explain" : "notify");
      return (originalNotify as (m: string) => void)(m);
    });
    // createdRunner is called inside createNativeKeychainRunner (mocked): hook ordering
    createdRunner.mockImplementation(() => {
      order.push("runner");
      return { run: async () => "", dispose };
    });
    const pending = handler("authorize", ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order.indexOf("explain")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("runner")).toBeGreaterThan(order.indexOf("explain"));
    await pending;
  });

  it("session_shutdown aborts a pending authorize: no follow-up read, no stale notify", async () => {
    let release: ((value: string) => void) | undefined;
    requestAuthorization.mockImplementation(
      () => new Promise<string>((resolve) => {
        release = (v: string) => resolve(v);
      }),
    );
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    const shutdown = (handler as unknown as { events: Map<string, (e: unknown, c: Ctx) => unknown> }).events.get("session_shutdown");
    expect(shutdown).toBeDefined();
    const pending = handler("authorize", ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = notifications.length;
    const teardown = shutdown!({ reason: "clear" } as never, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.(SECRET);
    await pending;
    await teardown;
    expect(plainRead).not.toHaveBeenCalled();
    expect(notifications.length).toBe(before);
  });

  it("explains the native prompt BEFORE touching the keychain", async () => {
    requestAuthorization.mockResolvedValue(SECRET);
    plainRead.mockResolvedValue(SECRET);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    const joined = notifications.join("\n");
    expect(joined).toMatch(/macOS .*authorization prompt/i);
    expect(joined).toMatch(/Always Allow/i);
    expect(joined).toMatch(/Allow/i);
    // The explanation must precede the first store interaction.
    expect(createdRunner.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("reports a persisted authorization when the follow-up noninteractive read succeeds", async () => {
    requestAuthorization.mockResolvedValue(SECRET);
    plainRead.mockResolvedValue(SECRET);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    const joined = notifications.join("\n");
    expect(joined).toMatch(/unattended reads now work|always allowed/i);
    expect(joined).not.toContain(SECRET);
    expect(dispose).toHaveBeenCalled();
  });

  it("reports the allow-once state when only the interactive read succeeded", async () => {
    requestAuthorization.mockResolvedValue(SECRET);
    const refusal = new TunnelRefusal("CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED");
    plainRead.mockRejectedValue(refusal);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    const joined = notifications.join("\n");
    expect(joined).toMatch(/this read only/i);
    expect(joined).not.toContain(SECRET);
  });

  it("surfaces a dismissed native prompt as CE_TUNNEL_KEYCHAIN_USER_CANCELED", async () => {
    requestAuthorization.mockRejectedValue(new TunnelRefusal("CE_TUNNEL_KEYCHAIN_USER_CANCELED"));
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    const joined = notifications.join("\n");
    expect(joined).toContain("CE_TUNNEL_KEYCHAIN_USER_CANCELED");
    expect(plainRead).not.toHaveBeenCalled();
  });

  it("suggests setup when no credential is stored yet", async () => {
    requestAuthorization.mockRejectedValue(new TunnelRefusal("CE_TUNNEL_KEY_MISSING"));
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    const joined = notifications.join("\n");
    expect(joined).toContain("CE_TUNNEL_KEY_MISSING");
    expect(joined).toMatch(/setup/i);
  });

  it("never leaks the credential value into notifications", async () => {
    requestAuthorization.mockResolvedValue(SECRET);
    plainRead.mockResolvedValue(SECRET);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await handler("authorize", ctx);
    for (const message of notifications) expect(message).not.toContain(SECRET);
  });
});

describe("B1.1-INTEGRATION round 3 — authorize lifecycle under teardown", () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function shutdownOf(handler: Awaited<ReturnType<typeof ceTunnel>>) {
    const shutdown = handler.events.get("session_shutdown");
    expect(shutdown).toBeDefined();
    return shutdown!;
  }

  it("keeps teardown-driven cancellation refusals silent", async () => {
    const authorization = deferred<string>();
    requestAuthorization.mockReturnValue(authorization.promise);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    const pending = handler("authorize", ctx);
    const before = notifications.length;
    const teardown = shutdownOf(handler)({ reason: "clear" }, ctx);
    expect((createdRunner.mock.calls[0]?.[0] as AbortSignal)?.aborted).toBe(true);
    authorization.reject(new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE"));
    await Promise.all([teardown, pending]);
    expect(notifications.length).toBe(before);
    expect(plainRead).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "AUTH_REQUIRED", "UNAVAILABLE"])("silences follow-up read %s after teardown", async (outcome) => {
    requestAuthorization.mockResolvedValue(SECRET);
    const read = deferred<string>();
    plainRead.mockReturnValue(read.promise);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    const pending = handler("authorize", ctx);
    await tick();
    expect(plainRead).toHaveBeenCalledTimes(1);
    const before = notifications.length;
    const teardown = shutdownOf(handler)({ reason: "clear" }, ctx);
    if (outcome === "success") read.resolve(SECRET);
    else read.reject(new TunnelRefusal(outcome === "AUTH_REQUIRED" ? "CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED" : "CE_TUNNEL_KEYCHAIN_UNAVAILABLE"));
    await Promise.all([teardown, pending]);
    expect(notifications.length).toBe(before);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses overlap, but permits another authorize after complete cleanup", async () => {
    const authorization = deferred<string>();
    requestAuthorization.mockReturnValue(authorization.promise);
    plainRead.mockResolvedValue(SECRET);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    const first = handler("authorize", ctx);
    await handler("authorize", ctx);
    expect(notifications.join("\n")).toMatch(/still in flight/);
    expect(requestAuthorization).toHaveBeenCalledTimes(1);
    expect(createdRunner).toHaveBeenCalledTimes(1);
    authorization.resolve(SECRET);
    await first;
    await handler("authorize", ctx);
    expect(requestAuthorization).toHaveBeenCalledTimes(2);
  });

  it("concurrent teardowns both await runner disposal and refuse overlap during disposal", async () => {
    const authorization = deferred<string>();
    const disposal = deferred<void>();
    requestAuthorization.mockReturnValue(authorization.promise);
    dispose.mockReturnValue(disposal.promise);
    const handler = await ceTunnel();
    const shutdown = shutdownOf(handler);
    const { ctx } = context();
    const pending = handler("authorize", ctx);
    const settled: string[] = [];
    const first = Promise.resolve(shutdown({ reason: "clear" }, ctx)).then(() => settled.push("first"));
    const second = Promise.resolve(shutdown({ reason: "reload" }, ctx)).then(() => settled.push("second"));
    authorization.reject(new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE"));
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([]);
    await handler("authorize", ctx);
    expect(createdRunner).toHaveBeenCalledTimes(1);
    disposal.resolve();
    await Promise.all([first, second, pending]);
    expect(settled.sort()).toEqual(["first", "second"]);
  });

  it("caps cleanup at two seconds (fake timers) without dropping the still-pending task's ownership", async () => {
    vi.useFakeTimers();
    try {
      const authorization = deferred<string>();
      requestAuthorization.mockReturnValue(authorization.promise);
      const handler = await ceTunnel();
      const shutdown = shutdownOf(handler);
      const { ctx, notifications } = context();
      const pending = handler("authorize", ctx);
      await vi.advanceTimersByTimeAsync(0); // task started; authorization pending
      const teardown = Promise.resolve(shutdown({ reason: "clear" }, ctx));
      let teardownSettled = false;
      const settled = teardown.then(() => {
        teardownSettled = true;
      });
      // Mutation-sensitive: a cap mutated to anything < 2000 ms must leave the
      // teardown still pending here (early-return regression).
      await vi.advanceTimersByTimeAsync(1999);
      expect(teardownSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(teardownSettled).toBe(true); // settles exactly at the 2 s cap
      // Ownership: the ORIGINAL authorize task still owns the registration until
      // it settles — a new authorize is refused and constructs no second runner.
      const before = notifications.length;
      await handler("authorize", ctx);
      expect(createdRunner).toHaveBeenCalledTimes(1);
      expect(notifications.slice(before).join("\n")).toMatch(/still in flight/);
      const afterBusy = notifications.length;
      authorization.reject(new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE"));
      await pending;
      expect(notifications.length).toBe(afterBusy); // stale-context silence
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins the original cleanup deadline for an overlapping teardown after the cap", async () => {
    vi.useFakeTimers();
    try {
      const authorization = deferred<string>();
      requestAuthorization.mockReturnValue(authorization.promise);
      const handler = await ceTunnel();
      const shutdown = shutdownOf(handler);
      const { ctx } = context();
      const pending = handler("authorize", ctx);
      const settled: string[] = [];
      const first = Promise.resolve(shutdown({ reason: "clear" }, ctx)).then(() => settled.push("first"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toEqual(["first"]);
      const second = Promise.resolve(shutdown({ reason: "reload" }, ctx)).then(() => settled.push("second"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toEqual(["first", "second"]);
      authorization.reject(new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE"));
      await Promise.all([first, second, pending]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers setup, aborts pending capture, waits for disposal, and silences stale notification", async () => {
    const capture = deferred<{ status: "cancelled"; reason: "aborted" }>();
    const disposal = deferred<void>();
    captureTunnelSecret.mockReturnValue(capture.promise);
    dispose.mockReturnValue(disposal.promise);
    const handler = await ceTunnel();
    const shutdown = shutdownOf(handler);
    const { ctx, notifications } = context();
    const pending = handler("setup", ctx);
    await tick();
    expect(captureTunnelSecret).toHaveBeenCalledTimes(1);
    const signal = createdRunner.mock.calls[0]?.[0] as AbortSignal | undefined;
    const before = notifications.length;
    let teardownSettled = false;
    const teardown = Promise.resolve(shutdown({ reason: "clear" }, ctx)).then(() => { teardownSettled = true; });
    expect(signal?.aborted).toBe(true);
    capture.resolve({ status: "cancelled", reason: "aborted" });
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(teardownSettled).toBe(false);
    expect(notifications.length).toBe(before);
    disposal.resolve();
    await Promise.all([pending, teardown]);
    expect(notifications.length).toBe(before);
  });

  it("keeps a teardown-driven setup failure silent and fail closed", async () => {
    const capture = deferred<never>();
    captureTunnelSecret.mockReturnValue(capture.promise);
    const handler = await ceTunnel();
    const shutdown = shutdownOf(handler);
    const { ctx, notifications } = context();
    const pending = handler("setup", ctx);
    await tick();
    const before = notifications.length;
    const teardown = shutdown({ reason: "clear" }, ctx);
    capture.reject(new Error(`writer failed while handling ${SECRET}`));
    await Promise.all([pending, teardown]);
    expect(notifications.length).toBe(before);
    expect(notifications.join("\n")).not.toContain(SECRET);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses overlapping setup and permits another setup only after complete cleanup", async () => {
    const capture = deferred<{ status: "cancelled"; reason: "user" }>();
    captureTunnelSecret.mockReturnValue(capture.promise);
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    const first = handler("setup", ctx);
    await tick();
    const before = notifications.length;
    await handler("setup", ctx);
    expect(captureTunnelSecret).toHaveBeenCalledTimes(1);
    expect(createdRunner).toHaveBeenCalledTimes(1);
    expect(notifications.slice(before).join("\n")).toMatch(/still in flight/);
    capture.resolve({ status: "cancelled", reason: "user" });
    await first;
    await handler("setup", ctx);
    expect(captureTunnelSecret).toHaveBeenCalledTimes(2);
    expect(createdRunner).toHaveBeenCalledTimes(2);
  });

  it("treats writer.store entry as the setup commit point and waits for completion without stale success", async () => {
    const storeStarted = deferred<void>();
    const finishStore = deferred<void>();
    const disposal = deferred<void>();
    store.mockImplementation(() => { storeStarted.resolve(); return finishStore.promise; });
    captureTunnelSecret.mockImplementation(async (_ctx: unknown, writer: { store(secret: string): Promise<void> }) => {
      await writer.store(SECRET);
      return { status: "stored" };
    });
    dispose.mockReturnValue(disposal.promise);
    const handler = await ceTunnel();
    const shutdown = shutdownOf(handler);
    const { ctx, notifications } = context();
    const pending = handler("setup", ctx);
    await storeStarted.promise;
    const signal = createdRunner.mock.calls[0]?.[0] as AbortSignal | undefined;
    const before = notifications.length;
    let teardownSettled = false;
    const teardown = Promise.resolve(shutdown({ reason: "clear" }, ctx)).then(() => { teardownSettled = true; });
    expect(signal?.aborted).toBe(true);
    await tick();
    expect(teardownSettled, "writer.store already entered; teardown must wait for the completion barrier").toBe(false);
    finishStore.resolve();
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(teardownSettled).toBe(false);
    disposal.resolve();
    await Promise.all([pending, teardown]);
    expect(store).toHaveBeenCalledTimes(1);
    expect(notifications.length).toBe(before);
  });

  it("does not abort a completed setup and permits a later setup after teardown", async () => {
    captureTunnelSecret.mockResolvedValue({ status: "cancelled", reason: "user" });
    const handler = await ceTunnel();
    const shutdown = shutdownOf(handler);
    const { ctx, notifications } = context();
    await handler("setup", ctx);
    expect(notifications.join("\n")).toMatch(/cancelled/);
    const signal = createdRunner.mock.calls[0]?.[0] as AbortSignal | undefined;
    const before = notifications.length;
    await shutdown({ reason: "clear" }, ctx);
    expect(signal?.aborted).toBe(false);
    expect(notifications.length).toBe(before);
    await handler("setup", ctx);
    expect(captureTunnelSecret).toHaveBeenCalledTimes(2);
  });

  it("shares the setup cleanup deadline for an overlapping teardown after the cap", async () => {
    vi.useFakeTimers();
    try {
      const capture = deferred<{ status: "cancelled"; reason: "aborted" }>();
      captureTunnelSecret.mockReturnValue(capture.promise);
      const handler = await ceTunnel();
      const shutdown = shutdownOf(handler);
      const { ctx } = context();
      const pending = handler("setup", ctx);
      const settled: string[] = [];
      const first = Promise.resolve(shutdown({ reason: "clear" }, ctx)).then(() => settled.push("first"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toEqual(["first"]);
      const second = Promise.resolve(shutdown({ reason: "reload" }, ctx)).then(() => settled.push("second"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toEqual(["first", "second"]);
      capture.resolve({ status: "cancelled", reason: "aborted" });
      await Promise.all([first, second, pending]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("FC-1 (R5): a runner-construction refusal does not leak authorizeCapture nor reject the handler", async () => {
    createdRunner.mockImplementation(() => {
      throw new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    });
    const handler = await ceTunnel();
    const { ctx, notifications } = context();
    await expect(handler("authorize", ctx)).resolves.toBeUndefined();
    expect(notifications.join("\n")).toMatch(/authorize refused CE_TUNNEL_KEYCHAIN_UNAVAILABLE/);
    // No leak: authorizeCapture must be released, so a later authorize runs normally.
    createdRunner.mockImplementation(() => ({ run: async () => "", dispose }));
    requestAuthorization.mockResolvedValue(SECRET);
    plainRead.mockResolvedValue(SECRET);
    await handler("authorize", ctx);
    expect(createdRunner).toHaveBeenCalledTimes(2);
    expect(notifications.join("\n")).not.toMatch(/still in flight/);
  });

  it("FC-2 (S2-04, D-1): the real runner refuses b11-probe accounts — the probe grammar is gone", async () => {
    const real = await vi.importActual<typeof import("../../../../packages/pi-chat-exchange/dist/tunnel/keychain.js")>(
      "../../../../packages/pi-chat-exchange/dist/tunnel/keychain.js",
    );
    const compileSeam = vi.fn(() => {
      throw new Error("must-not-compile");
    });
    const spawnSeam = vi.fn(() => {
      throw new Error("must-not-spawn");
    });
    const runner = real.createNativeKeychainRunner({ compile: compileSeam as never, spawnHelper: spawnSeam as never });
    await expect(
      runner.run({ op: "read", service: real.TUNNEL_KEYCHAIN_SERVICE, account: "b11-probe:v1:01234567-89ab-cdef-0123-456789abcdef:A" } as never),
    ).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    expect(compileSeam).not.toHaveBeenCalled();
    expect(spawnSeam).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it("FC-3 (D-5): real-clock ceiling only — an authorize teardown settles well inside a generous wall-clock budget", async () => {
    const authorization = deferred<string>();
    requestAuthorization.mockReturnValue(authorization.promise);
    const handler = await ceTunnel();
    const shutdown = shutdownOf(handler);
    const { ctx, notifications } = context();
    const pending = handler("authorize", ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = notifications.length;
    const started = Date.now();
    await shutdown({ reason: "clear" }, ctx);
    const waited = Date.now() - started;
    expect(waited).toBeLessThan(10_000); // ceiling only — no lower bound, no exact-cap claim
    expect(notifications.length).toBe(before);
    authorization.reject(new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE"));
    await pending;
  });

});
