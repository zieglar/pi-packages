/**
 * CE-0002 B3-P4D — extension registration and invocation tests for the
 * explicit `ce_read_payload` tool.
 *
 * The host seam is mocked (mirroring extension-inbox.test.ts): these tests pin
 * registration gating, the guarded Pi Session context, output shape, and the
 * absence of payload leakage — not storage authorization, which the real host
 * suites cover.
 */
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
    begin: vi.fn(), resume: vi.fn(), drop: vi.fn(), list: vi.fn(), send: vi.fn(),
    renew: vi.fn(), end: vi.fn(),
    readPayload: vi.fn(),
    open: vi.fn(), initialize: vi.fn(),
    constructedPolicies: [] as unknown[],
    allowlist: {
      sessions: { piA: { endpointId: "local/A" }, piB: { endpointId: "local/B" } },
    } as Record<string, unknown>,
  };
});
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify(fake.allowlist),
}));
vi.mock("../../../dist/endpoints/pi/session-host.js", () => ({
  CeHostRefusal: fake.Refusal,
  CeSessionHost: class {
    constructor(_store: unknown, policy: unknown) {
      fake.constructedPolicies.push(policy);
    }
    beginSession = fake.begin;
    resume = fake.resume;
    drop = fake.drop;
    renew = fake.renew;
    end = fake.end;
    listInbox = fake.list;
    send = fake.send;
    readPayload = fake.readPayload;
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

const PAYLOAD_TEXT = "PAYLOAD-MARKER-Ø☃-do-not-leak";

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
      const tool = tools.find((candidate) => candidate.name === "ce_read_payload");
      expect(tool, "explicit payload tool must be registered").toBeDefined();
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
  fake.constructedPolicies.length = 0;
  delete fake.allowlist.payloadRead;
  fake.begin.mockImplementation((endpointId: string) => ({ endpointId, participantId: "prt_test", sessionId: "ses_test", exchangeId: "ho_test" }));
  fake.resume.mockImplementation((endpointId: string, mapping: object) => ({ ...mapping, endpointId }));
  fake.readPayload.mockReturnValue({
    messageId: "msg_test",
    exchangeId: "ho_test",
    from: "local/B",
    to: "local/A",
    payloadDigest: "d".repeat(64),
    payloadLength: 25,
    createdAt: "2026-10-12T00:00:00.000Z",
    auditSequence: 9,
    payloadText: PAYLOAD_TEXT,
  });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("explicit Pi payload tool registration", () => {
  it.each([
    ["absent", undefined],
    ["false", { enabled: false }],
    ["string true", { enabled: "true" }],
    ["numeric one", { enabled: 1 }],
  ] as const)("is absent when the operator setting is %s", async (_label, setting) => {
    if (setting !== undefined) fake.allowlist.payloadRead = setting;
    const h = await harness();
    expect(h.tools.filter((tool) => tool.name === "ce_read_payload")).toHaveLength(0);
    // The other tools stay registered exactly once.
    expect(h.tools.filter((tool) => tool.name === "ce_read")).toHaveLength(1);
  });

  it("forwards the allowlist opt-in into the constructed host policy", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const enabled = await harness();
    await enabled.start();
    expect(fake.constructedPolicies.length).toBe(1);
    expect(fake.constructedPolicies[0]).toMatchObject({ payloadRead: { enabled: true } });

    delete fake.allowlist.payloadRead;
    fake.constructedPolicies.length = 0;
    const disabled = await harness();
    await disabled.start();
    expect(fake.constructedPolicies.length).toBe(1);
    expect(fake.constructedPolicies[0]).toMatchObject({ adapter: "pi" });
    expect((fake.constructedPolicies[0] as { payloadRead?: unknown }).payloadRead).toBeUndefined();
  });

  it("rejects unknown authority-bearing parameters before delegating", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    await h.start();
    const result = await h.invoke({ messageId: "msg_test", capability: "PRIVATE_TOKEN" });
    expect(result).toMatchObject({ isError: true, details: { code: "CE_HOST_INVALID_REQUEST" } });
    expect(fake.readPayload).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN");
  });

  it("registers once with the exact bounded input schema when enabled", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    const registered = h.tools.filter((tool) => tool.name === "ce_read_payload");
    expect(registered).toHaveLength(1);
    expect(registered[0]!.parameters).toEqual({
      type: "object",
      properties: {
        messageId: { type: "string", description: expect.any(String) },
      },
      required: ["messageId"],
      additionalProperties: false,
    });
    await h.start();
    await h.shutdown("reload");
    await h.start("reload");
    expect(h.tools.filter((tool) => tool.name === "ce_read_payload")).toHaveLength(1);
  });

  it("reads the guarded Pi Session at invocation and delegates with exact output", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    await h.start();
    h.getSessionId.mockClear();
    const result = await h.invoke({ messageId: "msg_test" });

    expect(h.getSessionId).toHaveBeenCalledTimes(1);
    expect(fake.readPayload).toHaveBeenCalledExactlyOnceWith("local/A", { messageId: "msg_test" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toContain("untrusted");
    expect(result.content[1]!.text).toBe(PAYLOAD_TEXT);
    // Payload text appears exactly once (the successful tool content) and never
    // in details.
    expect(JSON.stringify(result.details)).not.toContain("PAYLOAD-MARKER");
    expect((JSON.stringify(result).match(/PAYLOAD-MARKER/g) ?? []).length).toBe(1);
    expect(h.appendEntry).toHaveBeenCalledTimes(1); // startup mapping only
  });

  it("exposes exact authorized read metadata to a content-only caller for ACK without guessing", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness(); await h.start();
    const result = await h.invoke({ messageId: "msg_test" });
    // Pi forwards content to the model; details is UI/state data, not model input.
    const modelVisible = JSON.parse(JSON.stringify(result.content)) as Result["content"];
    const prefix = "ACK input metadata (reception only): ";
    const line = modelVisible[0]!.text.split("\n").find((entry) => entry.startsWith(prefix));
    expect(line, "authorized read must supply all four ACK parameters in model-facing content").toBeDefined();
    expect(JSON.parse(line!.slice(prefix.length))).toEqual({
      messageId: "msg_test", payloadDigest: "d".repeat(64), payloadLength: 25, messageCreatedAuditSequence: 9,
    });
    expect(modelVisible[1]!.text).toBe(PAYLOAD_TEXT);
    expect(fake.readPayload).toHaveBeenCalledExactlyOnceWith("local/A", { messageId: "msg_test" });
    expect(fake.send).not.toHaveBeenCalled(); expect(fake.list).not.toHaveBeenCalled();
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
  });

  it.each(["piB", "unallowlisted"])("rejects a current Session change to %s", async (id) => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    await h.start();
    h.session(id);
    expect((await h.invoke()).isError).toBe(true);
    expect(fake.readPayload).not.toHaveBeenCalled();
  });

  it("fails closed on a stale guarded execution context", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    await h.start();
    const stale = Object.create(h.ctx) as Context;
    Object.defineProperty(stale, "sessionManager", { get() { throw new Error("PRIVATE_RUNTIME_PATH"); } });
    const result = await h.invoke({}, stale);
    expect(result.details).toMatchObject({ code: "CE_HOST_UNAVAILABLE", retryable: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RUNTIME_PATH");
    expect(JSON.stringify(result)).not.toContain("PAYLOAD-MARKER");
    expect(fake.readPayload).not.toHaveBeenCalled();
  });

  it("refuses before startup and surfaces sanitized host refusals without payload", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_NOT_REGISTERED" });
    expect(fake.readPayload).not.toHaveBeenCalled();

    await h.start();
    fake.readPayload.mockImplementation(() => { throw new fake.Refusal("CE_HOST_PAYLOAD_DISABLED"); });
    const result = await h.invoke({ messageId: "msg_test" });
    expect(result).toMatchObject({ isError: true, details: { code: "CE_HOST_PAYLOAD_DISABLED", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("PAYLOAD-MARKER");
  });

  it("performs no automatic action: one delegation, no send, list, ACK, or injection", async () => {
    fake.allowlist.payloadRead = { enabled: true };
    const h = await harness();
    await h.start();
    await h.invoke({ messageId: "msg_test" });
    await h.invoke({ messageId: "msg_test" });
    expect(fake.readPayload).toHaveBeenCalledTimes(2);
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    expect(h.appendEntry).toHaveBeenCalledTimes(1);
  });
});
