import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../../src/hooks/events.js";

const fake = vi.hoisted(() => {
  class Refusal extends Error { constructor(readonly code: string) { super(code); } }
  return {
    Refusal,
    begin: vi.fn(), resume: vi.fn(), drop: vi.fn(), list: vi.fn(), send: vi.fn(), renew: vi.fn(), end: vi.fn(),
    open: vi.fn(), initialize: vi.fn(), policies: [] as unknown[], reads: 0,
    allowlist: {} as Record<string, unknown>,
  };
});
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: () => { fake.reads += 1; return JSON.stringify(fake.allowlist); },
}));
vi.mock("../../../dist/endpoints/pi/session-host.js", () => ({
  CeHostRefusal: fake.Refusal,
  CeSessionHost: class {
    constructor(_store: unknown, policy: unknown) { fake.policies.push(policy); }
    beginSession = fake.begin; resume = fake.resume; drop = fake.drop; renew = fake.renew; end = fake.end;
    listInbox = fake.list; send = fake.send;
  },
}));
vi.mock("../../../dist/storage/store.js", () => ({ openStore: fake.open, initializeStore: fake.initialize }));
vi.mock("../../../dist/endpoints/pi/contract.js", () => ({ PI_ADAPTER_KIND: "pi" }));

interface Command { handler(args: string, ctx: Context): Promise<void> | void }
interface Context {
  mode: string; hasUI: boolean; cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): undefined; getBranch(): Array<Record<string, unknown>> };
  ui: { notify: ReturnType<typeof vi.fn> };
}

function rules() {
  return [
    { id: "pi-notify", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "pi", endpointId: "pi/main" }, command: "/opt/node/bin/node", args: ["/opt/hooks/pi.mjs", "--fixed"], timeoutMs: 5000 },
    { id: "disabled-rule", event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/opt/node/bin/node", args: [], enabled: false },
  ];
}

async function harness() {
  const events = new Map<string, (event: { reason: string }, ctx: Context) => Promise<void> | void>();
  const commands = new Map<string, Command>();
  const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
  factory({
    on: (name: string, handler: (event: { reason: string }, ctx: Context) => Promise<void> | void) => events.set(name, handler),
    registerTool: vi.fn(),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    appendEntry: vi.fn(),
  });
  const ctx: Context = {
    mode: "tui", hasUI: true, cwd: "/isolated",
    sessionManager: { getSessionId: () => Object.keys(fake.allowlist.sessions as Record<string, unknown>)[0]!, getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn() },
  };
  return {
    ctx,
    start: () => events.get("session_start")!({ reason: "startup" }, ctx),
    shutdown: () => events.get("session_shutdown")!({ reason: "quit" }, ctx),
    hooks: () => commands.get("ce-hooks")!.handler("", ctx),
    notices: () => ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n"),
  };
}

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/fixtures/operator-allowlist.json");
  vi.useFakeTimers();
  fake.allowlist = {
    sessions: { piA: { endpointId: "pi/main" } },
    recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }],
    store: { directory: "/abs/store", file: "ce-store.sqlite" },
    hooks: rules(),
  };
  fake.reads = 0; fake.policies.length = 0;
  fake.begin.mockReturnValue({ endpointId: "pi/main", participantId: "prt", sessionId: "ses", exchangeId: "ho" });
  fake.end.mockReturnValue({ released: true, detached: true });
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Pi Hook configuration audit", () => {
  it("reports the actually loaded snapshot in startup and /ce-hooks without rereading disk or exposing env values", async () => {
    const h = await harness();
    await h.hooks();
    expect(h.notices()).toContain("active=1 configured=2 source=CE_ALLOWLIST");
    expect(h.notices()).toContain("pi-notify");
    expect(h.notices()).toContain(CE_MESSAGE_COMMITTED_EVENT);
    expect(h.notices()).toContain("recipient=pi/pi/main");
    expect(h.notices()).toContain("command=/opt/node/bin/node");
    expect(h.notices()).toContain("/opt/hooks/pi.mjs");
    expect(h.notices()).toContain("timeout=5000ms");
    expect(h.notices()).toContain("enabled");
    expect(h.notices()).toContain("disabled-rule");
    expect(h.notices()).toContain("disabled");
    expect(h.notices()).not.toContain("/fixtures/operator-allowlist.json");
    const reads = fake.reads;
    fake.allowlist.hooks = [];
    vi.stubEnv("CE_ALLOWLIST", "");
    await h.hooks();
    expect(fake.reads).toBe(reads);
    expect(h.notices()).not.toContain("source=generated profile / package allowlist");
    expect(h.notices()).toContain("pi-notify");

    await h.start();
    expect(h.notices()).toContain("ce-hooks: active=1 configured=2 source=CE_ALLOWLIST");
    expect(fake.policies[0]).toHaveProperty("onMessageCommitted");
    expect(typeof (fake.policies[0] as { onMessageCommitted?: unknown }).onMessageCommitted).toBe("function");
    await h.shutdown();
  });

  it("fails closed to zero active Hooks for an invalid local command without blocking messaging", async () => {
    fake.allowlist.hooks = [{ ...rules()[0], command: "node" }];
    fake.allowlist.sessions = { piB: { endpointId: "pi/main" } };
    const h = await harness();
    await h.hooks();
    expect(h.notices()).toContain("configuration=invalid");
    expect(h.notices()).toContain("active=0 configured=0");
    await h.start();
    expect(fake.begin, h.notices()).toHaveBeenCalled();
    await h.shutdown();
  });
});
