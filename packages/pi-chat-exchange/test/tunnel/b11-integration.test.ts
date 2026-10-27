/**
 * HANDOFF-CE-HOST-09 B1.1-INTEGRATION — Keychain authorization integration.
 *
 * Pinned contract (B1.1-KEYCHAIN-GATE evidence + B1.1-INTEGRATION handoff):
 * - two new closed refusal codes distinguish authorization outcomes from
 *   unavailability: CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED (native -25293 class: no
 *   user decision available for this code identity) and
 *   CE_TUNNEL_KEYCHAIN_USER_CANCELED (native -128 class: the user dismissed
 *   the native prompt). An authorization failure is NEVER reported as a
 *   missing credential.
 * - `requestAuthorization()` is the ONLY interactive path: one read with the
 *   explicit `interactive` request flag. Every other operation always runs
 *   noninteractive. The runner refuses the flag for any non-read op.
 * - the helper frame carries the flag as the literal trailing token
 *   `interactive`, after the optional probe keychain length.
 * - unknown/absent helper reason tokens still fail closed to
 *   CE_TUNNEL_KEYCHAIN_UNAVAILABLE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const SENTINEL = "sk-b11-integration-canary-0003";

/**
 * Round 3 (Lane C R2-C3): the DEFAULT compile/spawn transports are exercised
 * against an in-memory child_process stub, so an abort during compilation is
 * proven to kill swiftc and never create the helper process.
 */
const childStub = vi.hoisted(() => ({
  spawnImpl: undefined as undefined | ((command: string, args: readonly string[]) => unknown),
}));
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[]) => {
    if (childStub.spawnImpl === undefined) throw new Error("unexpected spawn: no stub installed");
    return childStub.spawnImpl(command, args);
  },
}));
afterEach(() => {
  childStub.spawnImpl = undefined;
});

type KeychainModule = any;

const MODULE_SPECIFIER = "../../src/tunnel/keychain.js";
const CODES_SPECIFIER = "../../src/tunnel/codes.js";

async function load(): Promise<KeychainModule | undefined> {
  try {
    return (await import(MODULE_SPECIFIER)) as KeychainModule;
  } catch {
    return undefined;
  }
}

async function mod(): Promise<KeychainModule> {
  const loaded = await load();
  expect(loaded, "src/tunnel/keychain.ts module namespace").toBeDefined();
  return loaded as KeychainModule;
}

async function codes(): Promise<KeychainModule> {
  const loaded = (await import(CODES_SPECIFIER)) as KeychainModule;
  expect(typeof loaded.TunnelRefusal, "codes module export").toBe("function");
  return loaded;
}

interface Call {
  request: { op: string; service: string; account: string; interactive?: boolean };
  secret: string | undefined;
}

function runner(responses: string[] | ((call: Call) => string | Promise<string>)): {
  run: ReturnType<typeof vi.fn>;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const run = vi.fn(async (request: Call["request"], secret?: string) => {
    calls.push({ request, secret });
    if (typeof responses === "function") return responses({ request, secret });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error("runner invoked more times than the test authorized");
    return next;
  });
  return { run, calls };
}

async function store(api: KeychainModule, responses: Parameters<typeof runner>[0]) {
  const r = runner(responses);
  const credentialStore = api.createKeychainCredentialStore({
    runner: { run: r.run },
    scope: api.OFFLINE_SYNTHETIC_SCOPE,
  });
  return { credentialStore, ...r };
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

describe("B1.1-INTEGRATION — closed authorization codes", () => {
  it("adds exactly the two authorization codes to the closed vocabulary", async () => {
    const api = await codes();
    expect(api.TUNNEL_REFUSAL_CODES).toContain("CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED");
    expect(api.TUNNEL_REFUSAL_CODES).toContain("CE_TUNNEL_KEYCHAIN_USER_CANCELED");
    for (const code of ["CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED", "CE_TUNNEL_KEYCHAIN_USER_CANCELED"]) {
      const refusal = new api.TunnelRefusal(code);
      expect(refusal.code).toBe(code);
      expect(refusal.message).not.toMatch(/secret|sk-/i);
    }
  });
});

describe("B1.1-INTEGRATION — store authorization semantics", () => {
  it("maps a noninteractive -25293 class read to CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED, never to KEY_MISSING", async () => {
    const api = await mod();
    const { credentialStore } = await store(api, [
      '{"status":"not_found"}',
      '{"status":"ok"}',
      '{"status":"error","reason":"authorization_required"}',
    ]);
    await credentialStore.store(SENTINEL);
    const error = await credentialStore.read().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED");
  });

  it("requestAuthorization issues exactly one interactive read and returns the secret", async () => {
    const api = await mod();
    const { credentialStore, calls } = await store(api, [
      `{"status":"ok","secretBase64":"${Buffer.from(SENTINEL).toString("base64")}"}`,
    ]);
    const secret = await credentialStore.requestAuthorization();
    expect(secret).toBe(SENTINEL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.op).toBe("read");
    expect(calls[0]?.request.interactive).toBe(true);
    expect(calls[0]?.secret).toBeUndefined();
  });

  it("maps the user-dismissed native prompt to CE_TUNNEL_KEYCHAIN_USER_CANCELED", async () => {
    const api = await mod();
    const { credentialStore } = await store(api, ['{"status":"error","reason":"user_canceled"}']);
    const error = await credentialStore.requestAuthorization().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_USER_CANCELED");
  });

  it("still reports a genuinely missing item as CE_TUNNEL_KEY_MISSING on the interactive path", async () => {
    const api = await mod();
    const { credentialStore } = await store(api, ['{"status":"not_found"}']);
    const error = await credentialStore.requestAuthorization().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe("CE_TUNNEL_KEY_MISSING");
  });

  it("fails closed to CE_TUNNEL_KEYCHAIN_UNAVAILABLE for unknown or absent reason tokens", async () => {
    const api = await mod();
    for (const response of ['{"status":"error","reason":"brand-new-token"}', '{"status":"error"}']) {
      const { credentialStore } = await store(api, [response]);
      const error = await credentialStore.requestAuthorization().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    }
  });

  it("never sets the interactive flag on exists/store/read/remove", async () => {
    const api = await mod();
    const { credentialStore, calls } = await store(api, (call) => {
      if (call.request.op === "exists") return '{"status":"not_found"}';
      return '{"status":"ok"}';
    });
    await credentialStore.store(SENTINEL);
    await credentialStore.read().catch(() => undefined);
    await credentialStore.remove().catch(() => undefined);
    await credentialStore.exists();
    for (const call of calls) {
      expect(call.request.interactive, `${call.request.op} must stay noninteractive`).not.toBe(true);
    }
  });
});

describe("B1.1-INTEGRATION — runner frame and validation", () => {
  function seamRunner(api: KeychainModule, probeKeychainPath?: string) {
    const frames: string[] = [];
    const spawnSeam = async (_target: string, options: { stdin: string }) => {
      frames.push(options.stdin);
      return { stdout: '{"status":"ok"}', code: 0, timedOut: false };
    };
    // Round 3 (Lane S S-R2-04): compile invocations are counted so refusal
    // tests can assert BOTH compile and spawn never ran.
    const compile = vi.fn(async () => ({
      executable: "/synthetic/compiled-helper",
      dispose: async () => undefined,
    }));
    const native = api.createNativeKeychainRunner({ compile, spawnHelper: spawnSeam, probeKeychainPath });
    return { native, frames, compiles: () => compile.mock.calls.length };
  }

  function request(api: KeychainModule, interactive?: boolean) {
    return {
      op: "read",
      service: api.TUNNEL_KEYCHAIN_SERVICE,
      account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE),
      ...(interactive === undefined ? {} : { interactive }),
    };
  }

  it("appends the literal trailing token `interactive` for an interactive read", async () => {
    const api = await mod();
    const { native, frames } = seamRunner(api);
    await native.run(request(api, true));
    const [frame] = frames;
    expect(frame).toBeDefined();
    const header = frame?.split("\n", 1)[0] ?? "";
    expect(header.endsWith(" interactive")).toBe(true);
    expect(header.split(" ")).toEqual(["v1", "read", expect.any(String), "0", "interactive"]);
  });

  it("places the probe keychain length before the interactive token", async () => {
    const api = await mod();
    const { native, frames } = seamRunner(api, "/private/tmp/probe/owned.keychain-db");
    await native.run(request(api, true));
    const header = frames[0]?.split("\n", 1)[0] ?? "";
    const fields = header.split(" ");
    expect(fields).toEqual(["v1", "read", expect.any(String), "0", expect.any(String), "interactive"]);
  });

  it("emits no interactive token for a plain read", async () => {
    const api = await mod();
    const { native, frames } = seamRunner(api);
    await native.run(request(api, false));
    await native.run(request(api));
    for (const frame of frames) {
      expect(frame.split("\n", 1)[0]?.includes("interactive")).toBe(false);
    }
  });

  it.each(["exists", "create", "update", "delete"])("refuses the interactive flag on %s before any spawn", async (op) => {
    // Round 3 (Lane S S-R2-04 / Lane C R2-C4): only create/update may carry a
    // secret. Passing SENTINEL to exists/delete would fail on needsSecret
    // first, hiding an interactive-validation regression behind a different
    // refusal; each op's ONLY illegal condition here is interactive:true.
    const secret = op === "create" || op === "update" ? SENTINEL : undefined;
    const api = await mod();
    const { native, frames, compiles } = seamRunner(api);
    const error = await native
      .run(
        { op, service: api.TUNNEL_KEYCHAIN_SERVICE, account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE), interactive: true },
        secret,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(frames).toHaveLength(0);
    expect(compiles()).toBe(0);
  });

  it("grants the interactive read a user-paced timeout and keeps unattended ops tight", async () => {
    const api = await mod();
    const budgets: number[] = [];
    const spawnSeam = async (_t: string, options: { timeoutMs: number }) => {
      budgets.push(options.timeoutMs);
      return { stdout: '{"status":"ok"}', code: 0, timedOut: false };
    };
    const compile = async () => ({ executable: "/synthetic/compiled-helper", dispose: async () => undefined });
    const native = api.createNativeKeychainRunner({ compile, spawnHelper: spawnSeam });
    await native.run(request(api, true));
    await native.run(request(api, false));
    await native.run({ op: "exists", service: api.TUNNEL_KEYCHAIN_SERVICE, account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE) });
    expect(budgets[0]).toBeGreaterThanOrEqual(300_000);
    expect(budgets[1]).toBe(20_000);
    expect(budgets[2]).toBe(20_000);
  });

  it("refuses before any spawn when its construction signal is already aborted", async () => {
    const api = await mod();
    const controller = new AbortController();
    controller.abort();
    const frames: string[] = [];
    const spawnSeam = async (_t: string, options: { stdin: string }) => {
      frames.push(options.stdin);
      return { stdout: '{"status":"ok"}', code: 0, timedOut: false };
    };
    const compile = async () => ({ executable: "/synthetic/compiled-helper", dispose: async () => undefined });
    const native = api.createNativeKeychainRunner({ compile, spawnHelper: spawnSeam, signal: controller.signal });
    const error = await native.run(request(api)).then(() => undefined, (e: unknown) => e);
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(frames).toHaveLength(0);
  });

  it("aborts a user-paced helper run through the spawn signal and fails closed", async () => {
    const api = await mod();
    const controller = new AbortController();
    const seen: unknown[] = [];
    const spawnSeam = async (_t: string, options: { signal?: AbortSignal }) => {
      seen.push(options.signal);
      return await new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ stdout: "", code: null, timedOut: false }), { once: true });
      });
    };
    const compile = async () => ({ executable: "/synthetic/compiled-helper", dispose: async () => undefined });
    const native = api.createNativeKeychainRunner({ compile, spawnHelper: spawnSeam, signal: controller.signal });
    const pending = native.run(request(api, true));
    setTimeout(() => controller.abort(), 30);
    const error = await pending.then(() => undefined, (e: unknown) => e);
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("refuses a non-boolean interactive value", async () => {
    const api = await mod();
    const { native, frames } = seamRunner(api);
    const error = await native.run({ ...request(api), interactive: "1" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(frames).toHaveLength(0);
  });
});

describe("B1.1-INTEGRATION round 3 — cancellation across the compile window", () => {
  interface FakeChild {
    readonly child: Record<string, unknown>;
    readonly kills: string[];
    readonly stdinWrites: string[];
  }

  function fakeChild(): FakeChild {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    const child: Record<string, unknown> = {
      on: (event: string, cb: (value?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        return child;
      },
      kill: (signal: string) => {
        kills.push(signal);
      },
    };
    const stdoutListeners = new Map<string, Array<(value?: unknown) => void>>();
    child.stdout = {
      on: (event: string, cb: (value?: unknown) => void) => {
        stdoutListeners.set(event, [...(stdoutListeners.get(event) ?? []), cb]);
        return child.stdout;
      },
    };
    child.stderr = { resume: () => undefined };
    const stdinWrites: string[] = [];
    const kills: string[] = [];
    child.stdin = {
      on: () => child.stdin,
      end: (payload: string) => {
        stdinWrites.push(payload);
      },
    };
    return { child, kills, stdinWrites };
  }

  async function waitFor(condition: () => boolean, budgetMs = 500): Promise<void> {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > budgetMs) throw new Error("condition never became true");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function readRequest(api: KeychainModule) {
    return {
      op: "read",
      service: api.TUNNEL_KEYCHAIN_SERVICE,
      account: api.keychainAccountFor(api.OFFLINE_SYNTHETIC_SCOPE),
    };
  }

  it("aborting compilation kills swiftc, removes its directory, and never creates the helper", async () => {
    const api = await mod();
    const swiftc = fakeChild();
    const commands: string[] = [];
    let directory: string | undefined;
    childStub.spawnImpl = (command: string, args: readonly string[]) => {
      commands.push(command);
      directory = (args[args.indexOf("-o") + 1] ?? "").replace(/\/tunnel-keychain$/, "");
      return command === "/usr/bin/swiftc" ? swiftc.child : fakeChild().child;
    };
    const controller = new AbortController();
    const native = api.createNativeKeychainRunner({ swiftcPath: "/usr/bin/swiftc", signal: controller.signal });
    const outcome = native.run(readRequest(api)).then(
      () => "ok",
      (e: unknown) => codeOf(e),
    );
    await waitFor(() => swiftc.stdinWrites.length > 0);
    controller.abort();
    expect(await outcome).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(swiftc.kills).toContain("SIGKILL");
    expect(commands).toEqual(["/usr/bin/swiftc"]);
    const { access } = await import("node:fs/promises");
    expect(directory).toBeDefined();
    await expect(access(directory!)).rejects.toMatchObject({ code: "ENOENT" });
    await native.dispose();
  });

  it("re-checks cancellation after a custom compile await and refuses before any spawn", async () => {
    const api = await mod();
    const controller = new AbortController();
    const disposeArtifact = vi.fn(async () => undefined);
    let releaseCompile: (() => void) | undefined;
    const compile = () =>
      new Promise<{ executable: string; dispose(): Promise<void> }>((resolve) => {
        releaseCompile = () => resolve({ executable: "/synthetic/compiled-helper", dispose: disposeArtifact });
      });
    const frames: string[] = [];
    const spawnSeam = async (_target: string, options: { stdin: string }) => {
      frames.push(options.stdin);
      return { stdout: '{"status":"ok"}', code: 0, timedOut: false };
    };
    const native = api.createNativeKeychainRunner({ compile, spawnHelper: spawnSeam, signal: controller.signal });
    const outcome = native.run(readRequest(api)).then(
      () => "ok",
      (e: unknown) => codeOf(e),
    );
    await waitFor(() => releaseCompile !== undefined);
    controller.abort();
    releaseCompile?.();
    expect(await outcome).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(frames).toHaveLength(0);
    expect(disposeArtifact).toHaveBeenCalledTimes(1);
    await native.dispose();
    expect(disposeArtifact).toHaveBeenCalledTimes(1);
  });

  it("removes the private compiler directory even when the compile transport throws", async () => {
    const api = await mod();
    const { access } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    let directory: string | undefined;
    const native = api.createNativeKeychainRunner({
      spawnHelper: async (_command: string, options: { args: readonly string[] }) => {
        directory = dirname(options.args[options.args.indexOf("-o") + 1]!);
        throw new Error("synthetic compiler transport error");
      },
    });
    const error = await native.run(readRequest(api)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(directory).toBeDefined();
    await expect(access(directory!)).rejects.toMatchObject({ code: "ENOENT" });
    await native.dispose();
  });

  it("refuses subsequent runs after cancellation without creating another child", async () => {
    const api = await mod();
    const commands: string[] = [];
    childStub.spawnImpl = (command: string) => {
      commands.push(command);
      return fakeChild().child;
    };
    const controller = new AbortController();
    const native = api.createNativeKeychainRunner({ swiftcPath: "/usr/bin/swiftc", signal: controller.signal });
    const outcome = native.run(readRequest(api)).then(
      () => "ok",
      (e: unknown) => codeOf(e),
    );
    await waitFor(() => commands.length === 1);
    controller.abort();
    // A SECOND run after the abort must refuse at the entry check.
    const second = await native.run(readRequest(api)).then(
      () => "ok",
      (e: unknown) => codeOf(e),
    );
    expect(second).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
    expect(commands).toEqual(["/usr/bin/swiftc"]);
    expect(await outcome).toBe("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
  });
});
