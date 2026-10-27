import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  class Refusal extends Error {
    readonly outcome = "ROLLED_BACK";
    constructor(readonly code: string, readonly retryable = false, readonly reason?: string) {
      super("sanitized host refusal");
    }
  }
  return {
    Refusal,
    begin: vi.fn(), resume: vi.fn(), drop: vi.fn(), list: vi.fn(),
    renew: vi.fn(), end: vi.fn(),
    open: vi.fn(), initialize: vi.fn(),
    allowlist: { sessions: { piA: { endpointId: "local/A" }, piB: { endpointId: "local/B" } } },
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
    // The real Host exposes status used to capture identifier-only release
    // proof. Model its registered mapping rather than latching an artificial
    // missing-method lifecycle failure across otherwise unrelated Inbox cases.
    status = (endpointId: string) => ({ registered: true, endpointId, participantId: "prt_test", sessionId: "ses_test", exchangeId: "ho_test" });
    listInbox = fake.list;
  },
}));
vi.mock("../../../dist/storage/store.js", () => ({
  openStore: fake.open, initializeStore: fake.initialize,
}));
vi.mock("../../../dist/endpoints/pi/contract.js", () => ({ PI_ADAPTER_KIND: "pi" }));

interface Result {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}
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
interface Tool {
  name: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, ctx: Context): Promise<Result>;
}

async function harness() {
  const tools: Tool[] = [];
  const events = new Map<string, (event: { reason: string }, ctx: Context) => Promise<void> | void>();
  const appendEntry = vi.fn((customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); });
  const moduleUrl = new URL("../../../pi-extension/index.ts", import.meta.url).href;
  const { default: factory } = await import(moduleUrl);
  factory({
    on(name: string, handler: (event: { reason: string }, ctx: Context) => Promise<void> | void) { events.set(name, handler); },
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand: vi.fn(), appendEntry,
  });
  let sessionId = "piA";
  let branch: Array<Record<string, unknown>> = [];
  const getSessionId = vi.fn(() => sessionId);
  const ctx: Context = {
    mode: "interactive", hasUI: false, cwd: "/isolated-test",
    sessionManager: { getSessionId, getSessionFile: () => undefined, getBranch: () => branch },
    ui: { notify: vi.fn() },
  };
  return {
    tools, ctx, appendEntry, getSessionId,
    session(id: string) { sessionId = id; },
    branch(entries: Array<Record<string, unknown>>) { branch = entries; },
    async start(reason = "startup") { await events.get("session_start")!({ reason }, ctx); },
    async shutdown(reason = "quit") { await events.get("session_shutdown")!({ reason }, ctx); },
    async invoke(params: unknown = {}, context = ctx) {
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
  fake.begin.mockImplementation((endpointId: string) => ({ endpointId, participantId: "prt_test", sessionId: "ses_test", exchangeId: "ho_test" }));
  fake.resume.mockImplementation((endpointId: string, mapping: object) => ({ ...mapping, endpointId }));
  fake.list.mockReturnValue({ messages: [{ messageId: "msg_test", auditSequence: 9 }], continuationAuditSequence: 9, scanBudgetExhausted: false });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("explicit Pi Inbox tool", () => {
  it("registers once with the exact bounded input schema", async () => {
    const h = await harness();
    expect(h.tools.filter((tool) => tool.name === "ce_inbox_list")).toHaveLength(1);
    expect(h.tools.find((tool) => tool.name === "ce_inbox_list")!.parameters).toEqual({
      type: "object",
      properties: {
        afterAuditSequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
        rawScanLimit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    });
    await h.start();
    await h.shutdown("reload");
    await h.start("reload");
    expect(h.tools.filter((tool) => tool.name === "ce_inbox_list")).toHaveLength(1);
  });

  it("looks up the current Pi Session at invocation and returns minimum metadata", async () => {
    const h = await harness();
    await h.start();
    h.getSessionId.mockClear();
    const result = await h.invoke({ pageSize: 1, rawScanLimit: 2, afterAuditSequence: 5 });
    expect(h.getSessionId).toHaveBeenCalledTimes(1);
    expect(fake.list).toHaveBeenCalledExactlyOnceWith("local/A", { pageSize: 1, rawScanLimit: 2, afterAuditSequence: 5 });
    expect(result.details).toEqual(fake.list.mock.results[0]!.value);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/cap_|payloadDigest|payloadLength|stack|\/isolated-test/);
    expect(h.appendEntry).toHaveBeenCalledTimes(1); // startup mapping only; never a cursor
  });

  it("renders an empty bounded window truthfully without claiming global integrity", async () => {
    const h = await harness();
    await h.start();
    fake.list.mockReturnValue({ messages: [], continuationAuditSequence: 12, scanBudgetExhausted: true });
    const result = await h.invoke();
    expect(result.details).toEqual({ messages: [], continuationAuditSequence: 12, scanBudgetExhausted: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("12");
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("refuses missing startup authority", async () => {
    const h = await harness();
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_NOT_REGISTERED" });
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.open).not.toHaveBeenCalled();
  });

  it.each(["piB", "unallowlisted"])("rejects current Session change to %s", async (id) => {
    const h = await harness();
    await h.start();
    h.session(id);
    expect((await h.invoke()).isError).toBe(true);
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("fails closed on a stale guarded execution context", async () => {
    const h = await harness();
    await h.start();
    const stale = Object.create(h.ctx) as Context;
    Object.defineProperty(stale, "sessionManager", { get() { throw new Error("PRIVATE_RUNTIME_PATH"); } });
    const result = await h.invoke({}, stale);
    expect(result.details).toMatchObject({ code: "CE_HOST_UNAVAILABLE", retryable: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RUNTIME_PATH");
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("does not expose old authority after shutdown or failed startup", async () => {
    const h = await harness();
    await h.start();
    await h.shutdown("new");
    expect(fake.drop).toHaveBeenCalledExactlyOnceWith("local/A");
    expect((await h.invoke()).isError).toBe(true);
    fake.begin.mockImplementation(() => { throw new fake.Refusal("CE_HOST_AUTHORITY_ABSENT", false, "LEASE_EXPIRED"); });
    await h.start("new");
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_AUTHORITY_ABSENT", reason: "LEASE_EXPIRED" });
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("resumes identifiers on reload but ignores inherited mapping on fork", async () => {
    const h = await harness();
    const mapping = { endpointId: "local/A", participantId: "prt_test", sessionId: "ses_test", exchangeId: "ho_test" };
    h.branch([{ type: "custom", customType: "ce-mapping", data: mapping }]);
    await h.start("reload");
    expect(fake.resume).toHaveBeenCalledExactlyOnceWith("local/A", mapping);
    expect((await h.invoke()).isError).toBeUndefined();
    await h.shutdown("fork");
    await h.start("fork");
    expect(fake.begin).toHaveBeenCalledExactlyOnceWith("local/A");
  });

  it.each([
    ["CE_HOST_BUSY", true, "STORAGE_TRANSACTION_BUSY"],
    ["CE_HOST_UNCERTAIN", false, "STORAGE_TRANSACTION_FAILED"],
    ["CE_HOST_UNAVAILABLE", false, "STORAGE_IDEMPOTENCY_CORRUPT"],
  ] as const)("maps %s without automatic retry or exposing outcome", async (code, retryable, reason) => {
    const h = await harness();
    await h.start();
    fake.list.mockImplementation(() => { throw new fake.Refusal(code, retryable, reason); });
    const result = await h.invoke();
    expect(result).toMatchObject({ isError: true, details: { code, retryable, reason } });
    expect(result.details).not.toHaveProperty("outcome");
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.begin).toHaveBeenCalledTimes(1);
    expect(fake.resume).not.toHaveBeenCalled();
  });
});
