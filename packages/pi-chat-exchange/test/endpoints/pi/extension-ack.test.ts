/**
 * HANDOFF-CE-TUNNEL-MESSAGING-INTEGRATION-01 — Pi extension ACK + generated
 * allowlist integration. The host seam is mocked (mirroring
 * extension-payload.test.ts): these tests pin registration gating, closed
 * argument validation, session isolation, receipt-only output, allowlist store
 * routing, and the tunnel-generated allowlist path precedence.
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
    renew: vi.fn(), end: vi.fn(), acknowledge: vi.fn(),
    open: vi.fn(), initialize: vi.fn(), storeExists: true,
    readPaths: [] as string[],
    constructedPolicies: [] as unknown[],
    allowlist: {
      sessions: { piA: { endpointId: "local/A" }, piB: { endpointId: "local/B" } },
    } as Record<string, unknown>,
  };
});
vi.mock("node:fs", () => ({
  existsSync: () => fake.storeExists,
  readFileSync: (path: unknown) => { fake.readPaths.push(String(path)); return JSON.stringify(fake.allowlist); },
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
    acknowledge = fake.acknowledge;
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

const RECEIPT = {
  disposition: "CREATED",
  receipt: {
    receiptId: "rcpt_test",
    exchangeId: "ho_test",
    messageId: "msg_0123456789ABCDEFGHJKMNPQRS",
    endpoint: { adapter: "pi", endpointId: "local/A" },
    kind: "delivery_ack",
    createdAt: "2026-10-10T00:00:00.000Z",
  },
  receiptAuditSequence: 42,
};

async function harness() {
  const tools: Tool[] = [];
  const events = new Map<string, (event: { reason: string }, ctx: Context) => Promise<void> | void>();
  let branch: Array<Record<string, unknown>> = [];
  const appendEntry = vi.fn((customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); });
  const moduleUrl = new URL("../../../pi-extension/index.ts", import.meta.url).href;
  const { default: factory } = await import(moduleUrl);
  factory({
    on(name: string, handler: (event: { reason: string }, ctx: Context) => Promise<void> | void) { events.set(name, handler); },
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand: vi.fn(), appendEntry,
  });
  let sessionId = "piA";
  const getSessionId = vi.fn(() => sessionId);
  const ctx: Context = {
    mode: "interactive", hasUI: false, cwd: "/isolated-test",
    sessionManager: { getSessionId, getSessionFile: () => undefined, getBranch: () => branch },
    ui: { notify: vi.fn() },
  };
  return {
    tools, ctx, getSessionId,
    session(id: string) { sessionId = id; },
    async start(reason = "startup") { await events.get("session_start")!({ reason }, ctx); },
    async invoke(name: string, params: unknown = {}, context = ctx) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `${name} must be registered`).toBeDefined();
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
  fake.storeExists = true;
  fake.readPaths.length = 0;
  fake.constructedPolicies.length = 0;
  fake.allowlist = { sessions: { piA: { endpointId: "local/A" }, piB: { endpointId: "local/B" } } };
  fake.begin.mockImplementation((endpointId: string) => ({ endpointId, participantId: "prt_test", sessionId: "ses_test", exchangeId: "ho_test" }));
  fake.resume.mockImplementation((endpointId: string, mapping: object) => ({ ...mapping, endpointId }));
  fake.acknowledge.mockReturnValue(RECEIPT);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const ACK_ARGS = {
  messageId: "msg_0123456789ABCDEFGHJKMNPQRS",
  payloadDigest: "d".repeat(64),
  payloadLength: 25,
  messageCreatedAuditSequence: 7,
};

describe("MESSAGING-INTEGRATION-01 — Pi extension ce_ack", () => {
  it("is not registered without the exact ack opt-in, and no ack policy reaches the host", async () => {
    const h = await harness();
    await h.start();
    expect(h.tools.map((tool) => tool.name)).not.toContain("ce_ack");
    expect(JSON.stringify(fake.constructedPolicies)).not.toContain('"ack"');
    await h.invoke("ce_inbox_list");
  });

  it.each([
    ["absent", undefined],
    ["false", { enabled: false }],
    ["truthy string", { enabled: "true" }],
    ["accessor-free empty", {}],
  ])("stays unregistered for malformed opt-in: %s", async (_label, setting) => {
    if (setting !== undefined) fake.allowlist.ack = setting;
    const h = await harness();
    await h.start();
    expect(h.tools.map((tool) => tool.name)).not.toContain("ce_ack");
  });

  it("registers with exact ack.enabled === true, forwards the opt-in to the host policy, and returns receipt-only evidence", async () => {
    fake.allowlist.ack = { enabled: true };
    const h = await harness();
    await h.start();
    expect(h.tools.map((tool) => tool.name)).toContain("ce_ack");
    const policy = fake.constructedPolicies[0] as Record<string, unknown>;
    expect(policy.ack).toEqual({ enabled: true });
    const result = await h.invoke("ce_ack", ACK_ARGS);
    expect(result.isError).not.toBe(true);
    expect(fake.acknowledge).toHaveBeenCalledWith("local/A", ACK_ARGS);
    const details = result.details as Record<string, unknown>;
    expect(details.disposition).toBe("CREATED");
    expect(details.receiptAuditSequence).toBe(42);
    expect((details.receipt as Record<string, unknown>).kind).toBe("delivery_ack");
    // No Session, fencing token, capability, or payload in the result.
    expect(JSON.stringify(details)).not.toMatch(/fencing|capability|payload|session/i);
    expect(result.content[0]!.text).toMatch(/reception only|not proof of (delivery|processing|completion)/i);
  });

  it("propagates a disabled host ACK as a closed refusal, never a fabricated receipt", async () => {
    fake.allowlist.ack = { enabled: true };
    fake.acknowledge.mockImplementation(() => { throw new fake.Refusal("CE_HOST_ACK_DISABLED"); });
    const h = await harness();
    await h.start();
    const result = await h.invoke("ce_ack", ACK_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.details)).toContain("CE_HOST_ACK_DISABLED");
  });

  it.each([
    ["extra field", { ...ACK_ARGS, sessionId: "ses_evil" }],
    ["missing digest", { messageId: ACK_ARGS.messageId, payloadLength: 25, messageCreatedAuditSequence: 7 }],
    ["bad digest shape", { ...ACK_ARGS, payloadDigest: "xyz" }],
    ["zero audit sequence", { ...ACK_ARGS, messageCreatedAuditSequence: 0 }],
    ["negative length", { ...ACK_ARGS, payloadLength: -1 }],
  ])("closed schema rejects before the host is called: %s", async (_label, params) => {
    fake.allowlist.ack = { enabled: true };
    const h = await harness();
    await h.start();
    const result = await h.invoke("ce_ack", params);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.details)).toContain("CE_HOST_INVALID_REQUEST");
    expect(fake.acknowledge).not.toHaveBeenCalled();
  });

  it("refuses a session that is not allowlisted — no cross-session ACK", async () => {
    fake.allowlist.ack = { enabled: true };
    const h = await harness();
    await h.start();
    h.session("rogue");
    const result = await h.invoke("ce_ack", ACK_ARGS);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.details)).toContain("CE_HOST_ENDPOINT_NOT_ALLOWED");
    expect(fake.acknowledge).not.toHaveBeenCalled();
  });

  it("replay disposition surfaces as REPLAYED with the original receipt", async () => {
    fake.allowlist.ack = { enabled: true };
    fake.acknowledge.mockReturnValue({ ...RECEIPT, disposition: "REPLAYED" });
    const h = await harness();
    await h.start();
    const result = await h.invoke("ce_ack", ACK_ARGS);
    expect((result.details as Record<string, unknown>).disposition).toBe("REPLAYED");
  });
});

describe("MESSAGING-INTEGRATION-01 — generated allowlist routing", () => {
  it("uses the allowlist store location when CE_STORE_DIR is not set", async () => {
    fake.allowlist.store = { directory: "/abs/tunnel-store", file: "ce-store.sqlite" };
    const h = await harness();
    await h.start();
    expect(fake.open.mock.calls.some(([options]) => (options as { directory: string }).directory === "/abs/tunnel-store")).toBe(true);
  });

  it.each([
    ["CE_STORE_DIR", "/abs/env-store"], ["CE_STORE_DIR", "/abs/tunnel-store/"],
    ["CE_STORE_DIR", "/abs/../tunnel-store"], ["CE_STORE_DIR", "relative"],
    ["CE_STORE_DIR", " "], ["CE_STORE_DIR", "/abs/tunnel-store\n"],
    ["CE_STORE_FILE", "other.sqlite"], ["CE_STORE_FILE", "../ce-store.sqlite"],
    ["CE_STORE_FILE", "ce-store.sqlite\n"], ["CE_STORE_FILE", " "],
  ])("explicit Store refuses conflicting or malformed %s=%j before any Store/session call", async (name, value) => {
    fake.allowlist.store = { directory: "/abs/tunnel-store", file: "ce-store.sqlite" };
    vi.stubEnv(name, value);
    const h = await harness(); await h.start();
    expect(fake.open).not.toHaveBeenCalled();
    expect(fake.initialize).not.toHaveBeenCalled();
    expect(fake.begin).not.toHaveBeenCalled();
    expect(fake.constructedPolicies).toHaveLength(0);
  });

  it.each([true, false])("accepts exact Store env equality (Store exists=%s)", async (storeExists) => {
    fake.storeExists = storeExists;
    fake.allowlist.store = { directory: "/abs/tunnel-store", file: "ce-store.sqlite" };
    vi.stubEnv("CE_STORE_DIR", "/abs/tunnel-store");
    vi.stubEnv("CE_STORE_FILE", "ce-store.sqlite");
    const h = await harness(); await h.start();
    expect(storeExists ? fake.open : fake.initialize).toHaveBeenCalledWith({ directory: "/abs/tunnel-store", filename: "ce-store.sqlite", busyTimeoutMs: 5000 });
    expect(fake.begin).toHaveBeenCalled();
  });

  it("preserves env routing when the legacy allowlist has no Store", async () => {
    vi.stubEnv("CE_STORE_DIR", "/abs/legacy-store"); vi.stubEnv("CE_STORE_FILE", "legacy.sqlite");
    const h = await harness(); await h.start();
    expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({ directory: "/abs/legacy-store", filename: "legacy.sqlite" }));
    expect(fake.begin).toHaveBeenCalled();
  });

  it.each([null, {}, { directory: "relative/store", file: "ce-store.sqlite" },
    { directory: "/abs/../other", file: "ce-store.sqlite" }, { directory: "/abs/store", file: "../outside" }])(
    "a malformed explicit Store refuses host activation, never fallback: %j", async (store) => {
      fake.allowlist.store = store; fake.allowlist.ack = { enabled: true };
      const h = await harness(); await h.start();
      expect(fake.open).not.toHaveBeenCalled();
      expect(fake.initialize).not.toHaveBeenCalled();
      expect(fake.begin).not.toHaveBeenCalled();
      expect(fake.constructedPolicies).toHaveLength(0);
      const result = await h.invoke("ce_ack", ACK_ARGS);
      expect(result.isError).toBe(true);
      expect(fake.acknowledge).not.toHaveBeenCalled();
    });
  it("a valid normalized directory containing '..' as a filename substring is shared, not rejected", async () => {
    fake.allowlist.store = { directory: "/abs/work..tree/.ce-bindings", file: "ce-store.sqlite" };
    const h = await harness(); await h.start();
    expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({ directory: "/abs/work..tree/.ce-bindings" }));
    expect(fake.begin).toHaveBeenCalled();
  });

  it("an unreadable/corrupt generated default never activates an alternative Store or session", async () => {
    vi.stubEnv("CE_ALLOWLIST", "");
    fake.allowlist.ack = { enabled: true };
    // This fs stub exposes no valid Tunnel profile/secure generated document.
    const h = await harness(); await h.start();
    expect(h.tools.map((tool) => tool.name)).not.toContain("ce_ack");
    expect(fake.open).not.toHaveBeenCalled();
    expect(fake.begin).not.toHaveBeenCalled();
  });

  it("CE_ALLOWLIST env wins over the generated path (explicit operator override)", async () => {
    vi.stubEnv("CE_ALLOWLIST", "/abs/operator-allowlist.json");
    const h = await harness();
    await h.start();
    expect(fake.readPaths).toContain("/abs/operator-allowlist.json");
    expect(fake.readPaths.some((path) => path.endsWith("pi-allowlist.json"))).toBe(false);
  });
});
