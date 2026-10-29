import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Inbox advisory behaviour is not Native qualification: keep the Native readiness
// warning out of these notification-count assertions.
vi.mock("../../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
  inspectNativeReadiness: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
}));

const fake = vi.hoisted(() => {
  class Refusal extends Error {
    readonly outcome = "ROLLED_BACK";
    constructor(readonly code: string, readonly retryable = false, readonly reason?: string) {
      super("sanitized host refusal");
    }
  }
  return {
    Refusal,
    begin: vi.fn(),
    resume: vi.fn(),
    drop: vi.fn(),
    renew: vi.fn(), end: vi.fn(),
    list: vi.fn(),
    send: vi.fn(),
    read: vi.fn(),
    readPayload: vi.fn(),
    open: vi.fn(),
    initialize: vi.fn(),
    allowlist: {} as Record<string, unknown>,
  };
});

vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify(fake.allowlist),
}));
vi.mock("../../../dist/endpoints/pi/session-host.js", () => ({
  CeHostRefusal: fake.Refusal,
  CeSessionHost: class {
    beginSession = fake.begin;
    resume = fake.resume;
    drop = fake.drop;
    renew = fake.renew;
    end = fake.end;
    listInbox = fake.list;
    send = fake.send;
    readMetadata = fake.read;
    readPayload = fake.readPayload;
  },
}));
vi.mock("../../../dist/storage/store.js", () => ({
  openStore: fake.open,
  initializeStore: fake.initialize,
}));
vi.mock("../../../dist/endpoints/pi/contract.js", () => ({ PI_ADAPTER_KIND: "pi" }));

type Event = { reason?: string; type?: string };
type Handler = (event: Event, ctx: Context) => Promise<void> | void;

interface Context {
  mode: string;
  hasUI: boolean;
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getBranch(): Array<Record<string, unknown>>;
  };
  ui: { notify: ReturnType<typeof vi.fn> };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface Tool {
  name: string;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: Context,
  ): Promise<ToolResult>;
}

const MODULE_URL = new URL(
  "../../../pi-extension/index.ts",
  import.meta.url,
).href;

function baseAllowlist(): Record<string, unknown> {
  return {
    sessions: {
      piA: { endpointId: "local/A" },
      piB: { endpointId: "local/B" },
    },
  };
}

async function harness(parsedAllowlist?: unknown) {
  const tools: Tool[] = [];
  const events = new Map<string, Handler>();
  const registrations: string[] = [];
  const appendEntry = vi.fn((customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); });
  const { default: factory } = await import(MODULE_URL);
  const parseSpy = parsedAllowlist === undefined
    ? undefined
    : vi.spyOn(JSON, "parse").mockReturnValueOnce(parsedAllowlist);
  try {
    factory({
      on(name: string, handler: Handler) {
        registrations.push(name);
        events.set(name, handler);
      },
      registerTool(tool: Tool) {
        tools.push(tool);
      },
      registerCommand: vi.fn(),
      appendEntry,
    });
  } finally {
    parseSpy?.mockRestore();
  }

  let sessionId = "piA";
  let branch: Array<Record<string, unknown>> = [];
  const getSessionId = vi.fn(() => sessionId);
  const ctx: Context = {
    mode: "tui",
    hasUI: true,
    cwd: "/isolated-test",
    sessionManager: {
      getSessionId,
      getSessionFile: () => undefined,
      getBranch: () => branch,
    },
    ui: { notify: vi.fn() },
  };

  const event = (name: string): Handler => {
    const handler = events.get(name);
    expect(handler, `${name} handler must be registered`).toBeDefined();
    return handler!;
  };

  return {
    tools,
    events,
    registrations,
    appendEntry,
    ctx,
    getSessionId,
    session(id: string) {
      sessionId = id;
    },
    branch(entries: Array<Record<string, unknown>>) {
      branch = entries;
    },
    advisories() {
      return ctx.ui.notify.mock.calls
        .map(([message]) => message as string)
        .filter((message) => message.startsWith("Chat Exchange:"));
    },
    start(reason = "startup", context = ctx) {
      return event("session_start")({ reason }, context);
    },
    settle(context = ctx) {
      return event("agent_settled")({ type: "agent_settled" }, context);
    },
    shutdown(reason = "quit", context = ctx) {
      return event("session_shutdown")({ reason }, context);
    },
    async invokeInbox(params: unknown = {}, context = ctx) {
      const tool = tools.find((candidate) => candidate.name === "ce_inbox_list");
      expect(tool, "explicit Inbox tool must be registered").toBeDefined();
      return tool!.execute("test-call", params, undefined, undefined, context);
    },
  };
}

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/fixtures/operator-allowlist.json");
  vi.useFakeTimers();
  fake.renew.mockReturnValue({ fencingToken: 1, expiresAt: "2026-10-10T00:02:00.000Z" });
  fake.end.mockReturnValue({ released: true, detached: true });
  vi.clearAllMocks();
  fake.allowlist = baseAllowlist();
  fake.begin.mockImplementation((endpointId: string) => ({
    endpointId,
    participantId: "prt_test",
    sessionId: "ses_test",
    exchangeId: "ho_test",
  }));
  fake.resume.mockImplementation((endpointId: string, mapping: object) => ({
    ...mapping,
    endpointId,
  }));
  fake.list.mockReturnValue({
    messages: [],
    continuationAuditSequence: null,
    scanBudgetExhausted: false,
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("Inbox advisory strict configuration", () => {
  it.each([
    ["missing", undefined],
    ["false", { enabled: false }],
    ["string true", { enabled: "true" }],
    ["numeric true", { enabled: 1 }],
    ["null", null],
    ["array", [{ enabled: true }]],
    ["unknown interval", { enabled: true, intervalMs: 1_000 }],
    ["unknown wake", { enabled: true, wake: true }],
  ])("stays disabled for %s configuration", async (_label, setting) => {
    if (setting !== undefined) fake.allowlist.inboxNotification = setting;
    const h = await harness();
    await h.start();
    await h.settle();
    expect(fake.list).not.toHaveBeenCalled();
    expect(h.advisories()).toEqual([]);
  });

  it("rejects a prototype-bearing configuration object", async () => {
    const setting = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.defineProperty(setting, "enabled", { value: true, enumerable: true });
    const parsed = { ...baseAllowlist(), inboxNotification: setting };
    const h = await harness(parsed);
    await h.start();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it.each([
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1.5 },
    { rawScanLimit: 0 },
    { rawScanLimit: 2_001 },
    { rawScanLimit: 1.5 },
    { pageSize: 20, rawScanLimit: 10 },
  ])("disables malformed bounds %j", async (bounds) => {
    fake.allowlist.inboxNotification = { enabled: true, ...bounds };
    const h = await harness();
    await h.start();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("uses the private default bounds and forwards no authority", async () => {
    fake.allowlist.inboxNotification = { enabled: true };
    const h = await harness();
    await h.start();
    expect(fake.list).toHaveBeenCalledExactlyOnceWith("local/A", {
      afterAuditSequence: 0,
      pageSize: 10,
      rawScanLimit: 100,
    });
  });

  it("accepts bounded custom values", async () => {
    fake.allowlist.inboxNotification = {
      enabled: true,
      pageSize: 25,
      rawScanLimit: 250,
    };
    const h = await harness();
    await h.start();
    expect(fake.list).toHaveBeenCalledExactlyOnceWith("local/A", {
      afterAuditSequence: 0,
      pageSize: 25,
      rawScanLimit: 250,
    });
  });
});

describe("Inbox advisory lifecycle and bounded discovery", () => {
  beforeEach(() => {
    fake.allowlist.inboxNotification = { enabled: true };
  });

  it("registers agent_settled once at module scope and checks startup and settlement once each", async () => {
    const h = await harness();
    fake.list
      .mockReturnValueOnce({ messages: [], continuationAuditSequence: 7, scanBudgetExhausted: false })
      .mockReturnValueOnce({ messages: [], continuationAuditSequence: 9, scanBudgetExhausted: false });
    await h.start();
    await h.settle();
    expect(h.registrations.filter((name) => name === "agent_settled")).toHaveLength(1);
    expect(fake.list).toHaveBeenNthCalledWith(1, "local/A", {
      afterAuditSequence: 0,
      pageSize: 10,
      rawScanLimit: 100,
    });
    expect(fake.list).toHaveBeenNthCalledWith(2, "local/A", {
      afterAuditSequence: 7,
      pageSize: 10,
      rawScanLimit: 100,
    });
  });

  it("checks after a validated resume", async () => {
    const h = await harness();
    const mapping = {
      endpointId: "local/A",
      participantId: "prt_test",
      sessionId: "ses_test",
      exchangeId: "ho_test",
    };
    h.branch([{ type: "custom", customType: "ce-mapping", data: mapping }]);
    await h.start("resume");
    expect(fake.resume).toHaveBeenCalledExactlyOnceWith("local/A", mapping);
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tui", true],
    ["rpc", true],
    ["json", false],
    ["print", false],
  ] as const)("uses ctx.ui.notify only when %s has usable UI", async (mode, hasUI) => {
    const h = await harness();
    h.ctx.mode = mode;
    h.ctx.hasUI = hasUI;
    fake.list.mockReturnValue({
      messages: [{ messageId: "msg_private", auditSequence: 4 }],
      continuationAuditSequence: 4,
      scanBudgetExhausted: false,
    });
    await h.start();
    expect(fake.list).toHaveBeenCalledTimes(hasUI ? 1 : 0);
    expect(h.advisories()).toHaveLength(hasUI ? 1 : 0);
  });

  it("performs one bounded call and never drains an incomplete page", async () => {
    const h = await harness();
    fake.list.mockReturnValue({
      messages: Array.from({ length: 10 }, (_, index) => ({
        messageId: `msg_private_${index}`,
        auditSequence: index + 1,
      })),
      continuationAuditSequence: 10,
      scanBudgetExhausted: true,
    });
    await h.start();
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(h.advisories()).toHaveLength(1);
    expect(h.advisories()[0]).toContain("additional eligible activity may exist");
  });

  it("retains the watermark on null and advances across filtered-empty windows", async () => {
    const h = await harness();
    fake.list
      .mockReturnValueOnce({ messages: [], continuationAuditSequence: 12, scanBudgetExhausted: false })
      .mockReturnValueOnce({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false })
      .mockReturnValueOnce({ messages: [], continuationAuditSequence: 20, scanBudgetExhausted: false });
    await h.start();
    await h.settle();
    await h.settle();
    expect(fake.list.mock.calls.map((call) => call[1])).toEqual([
      { afterAuditSequence: 0, pageSize: 10, rawScanLimit: 100 },
      { afterAuditSequence: 12, pageSize: 10, rawScanLimit: 100 },
      { afterAuditSequence: 12, pageSize: 10, rawScanLimit: 100 },
    ]);
    expect(h.advisories()).toEqual([]);
  });

  it("is explicitly single-flight under a re-entrant lifecycle event", async () => {
    const h = await harness();
    fake.list.mockImplementationOnce(() => {
      void h.settle();
      return { messages: [], continuationAuditSequence: 3, scanBudgetExhausted: false };
    });
    await h.start();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });
});

describe("Inbox advisory publication safety", () => {
  beforeEach(() => {
    fake.allowlist.inboxNotification = { enabled: true };
  });

  it("publishes count-only point-in-time advisory text", async () => {
    const h = await harness();
    fake.list.mockReturnValue({
      messages: [
        { messageId: "msg_private_1", auditSequence: 8 },
        { messageId: "msg_private_2", auditSequence: 9 },
        { messageId: "msg_private_3", auditSequence: 10 },
      ],
      continuationAuditSequence: 10,
      scanBudgetExhausted: false,
    });
    await h.start();
    expect(h.advisories()).toEqual([
      "Chat Exchange: 3 inbox items observed as of this check. Run ce_inbox_list to inspect. Advisory only.",
    ]);
    expect(h.advisories()[0]).not.toMatch(/msg_|audit|sender|recipient|participant|session|store|cap_|digest|payload|unread|delivered|processed/i);
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.readPayload).not.toHaveBeenCalled();
  });

  it("reports an incomplete zero-result scan without claiming an empty Inbox", async () => {
    const h = await harness();
    fake.list.mockReturnValue({
      messages: [],
      continuationAuditSequence: 100,
      scanBudgetExhausted: true,
    });
    await h.start();
    expect(h.advisories()).toEqual([
      "Chat Exchange: bounded inbox check incomplete as of this check; additional eligible activity may exist. Run ce_inbox_list to inspect. Advisory only.",
    ]);
  });

  it("stays silent for a complete zero-result scan", async () => {
    const h = await harness();
    fake.list.mockReturnValue({
      messages: [],
      continuationAuditSequence: 22,
      scanBudgetExhausted: false,
    });
    await h.start();
    expect(h.advisories()).toEqual([]);
  });

  it("drops a Session-switch result before publication without advancing or retrying", async () => {
    const h = await harness();
    fake.list.mockImplementationOnce(() => {
      h.session("piB");
      return {
        messages: [{ messageId: "msg_private", auditSequence: 5 }],
        continuationAuditSequence: 5,
        scanBudgetExhausted: false,
      };
    });
    await h.start();
    await h.settle();
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(h.advisories()).toEqual([]);
  });

  it("drops a runtime-replacement result before publication", async () => {
    const h = await harness();
    fake.list.mockImplementationOnce(() => {
      void h.shutdown("reload");
      return {
        messages: [{ messageId: "msg_private", auditSequence: 5 }],
        continuationAuditSequence: 5,
        scanBudgetExhausted: false,
      };
    });
    await h.start();
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(h.advisories()).toEqual([]);
  });

  it("observes publication failure, keeps the watermark, latches, and leaves the explicit tool usable", async () => {
    const h = await harness();
    fake.list.mockReturnValue({
      messages: [{ messageId: "msg_private", auditSequence: 5 }],
      continuationAuditSequence: 5,
      scanBudgetExhausted: false,
    });
    h.ctx.ui.notify.mockImplementation((message: string) => {
      if (message.startsWith("Chat Exchange:")) throw new Error("PRIVATE_UI_FAILURE");
    });
    await expect(h.start()).resolves.toBeUndefined();
    h.ctx.ui.notify.mockImplementation(() => undefined);
    await h.settle();
    expect(fake.list).toHaveBeenCalledTimes(1);

    const explicit = await h.invokeInbox();
    expect(explicit.isError).toBeUndefined();
    expect(fake.list).toHaveBeenCalledTimes(2);

    await h.shutdown("reload");
    await h.start("new");
    expect(fake.list).toHaveBeenLastCalledWith("local/A", {
      afterAuditSequence: 0,
      pageSize: 10,
      rawScanLimit: 100,
    });
    expect(JSON.stringify(h.ctx.ui.notify.mock.calls)).not.toContain("PRIVATE_UI_FAILURE");
  });

  it.each([
    ["CE_HOST_AUTHORITY_ABSENT", "LEASE_EXPIRED"],
    ["CE_HOST_AUTHORITY_ABSENT", "OWNERSHIP_NOT_CURRENT"],
    ["CE_HOST_UNAVAILABLE", "CAPABILITY_REJECTED"],
    ["CE_HOST_MAPPING_INVALID", "STORE_MISMATCH"],
    ["CE_HOST_UNAVAILABLE", "STORAGE_IDEMPOTENCY_CORRUPT"],
  ] as const)("latches sanitized %s refusal without retry or reason disclosure", async (code, reason) => {
    const h = await harness();
    fake.list.mockImplementationOnce(() => {
      throw new fake.Refusal(code, false, reason);
    });
    await h.start();
    await h.settle();
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(h.advisories()).toEqual([
      `Chat Exchange: inbox advisory disabled for this runtime (${code}).`,
    ]);
    expect(JSON.stringify(h.ctx.ui.notify.mock.calls)).not.toContain(reason);
  });

  it("resets volatile state after shutdown and permits a duplicate in a fresh generation", async () => {
    const h = await harness();
    fake.list.mockReturnValue({
      messages: [{ messageId: "msg_private", auditSequence: 5 }],
      continuationAuditSequence: 5,
      scanBudgetExhausted: false,
    });
    await h.start();
    await h.shutdown("reload");
    await h.start("new");
    expect(fake.list).toHaveBeenNthCalledWith(1, "local/A", {
      afterAuditSequence: 0,
      pageSize: 10,
      rawScanLimit: 100,
    });
    expect(fake.list).toHaveBeenNthCalledWith(2, "local/A", {
      afterAuditSequence: 0,
      pageSize: 10,
      rawScanLimit: 100,
    });
    expect(h.advisories()).toHaveLength(2);
  });
});
