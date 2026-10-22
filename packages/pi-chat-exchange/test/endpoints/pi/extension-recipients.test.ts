/**
 * CE-0002 B3-P3B — extension reply-path wiring tests.
 *
 * The extension must forward the operator's explicit cross-adapter recipients
 * into the host policy verbatim when strictly well-formed, and must omit the
 * field entirely (same-adapter-only sending, the pre-P3B behavior) when the
 * setting is absent, empty, or malformed in any way.
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
    begin: vi.fn(), resume: vi.fn(), drop: vi.fn(), list: vi.fn(),
    renew: vi.fn(), end: vi.fn(),
    open: vi.fn(), initialize: vi.fn(),
    policies: [] as Array<Record<string, unknown>>,
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
    constructor(_store: unknown, policy: Record<string, unknown>) { fake.policies.push(policy); }
    beginSession = fake.begin;
    resume = fake.resume;
    drop = fake.drop;
    renew = fake.renew;
    end = fake.end;
    listInbox = fake.list;
  },
}));
vi.mock("../../../dist/storage/store.js", () => ({
  openStore: fake.open, initializeStore: fake.initialize,
}));
vi.mock("../../../dist/endpoints/pi/contract.js", () => ({ PI_ADAPTER_KIND: "pi" }));

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

async function start() {
  // The extension caches its host at module scope; force a fresh module per
  // start so every case constructs a new host policy from the mutated
  // allowlist.
  vi.resetModules();
  const events = new Map<string, (event: { reason: string }, ctx: Context) => Promise<void> | void>();
  const moduleUrl = new URL("../../../pi-extension/index.ts", import.meta.url).href;
  const { default: factory } = await import(moduleUrl);
  factory({
    on(name: string, handler: (event: { reason: string }, ctx: Context) => Promise<void> | void) { events.set(name, handler); },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
  });
  const ctx: Context = {
    mode: "interactive", hasUI: false, cwd: "/isolated-test",
    sessionManager: { getSessionId: () => "piA", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn() },
  };
  await events.get("session_start")!({ reason: "startup" }, ctx);
}

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/fixtures/operator-allowlist.json");
  vi.useFakeTimers();
  fake.renew.mockReturnValue({ fencingToken: 1, expiresAt: "2026-10-10T00:02:00.000Z" });
  fake.end.mockReturnValue({ released: true, detached: true });
  vi.clearAllMocks();
  fake.policies.length = 0;
  fake.begin.mockImplementation((endpointId: string) => ({ endpointId, participantId: "prt_test", sessionId: "ses_test", exchangeId: "ho_test" }));
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const BASE = {
  sessions: { piA: { endpointId: "local/A" }, piB: { endpointId: "local/B" } },
};

function lastPolicy(): Record<string, unknown> {
  expect(fake.policies.length).toBeGreaterThan(0);
  return fake.policies.at(-1)!;
}

describe("extension cross-adapter recipients wiring", () => {
  it("forwards a strictly well-formed recipients list into the host policy", async () => {
    fake.allowlist = { ...BASE, recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }] };
    await start();
    expect(lastPolicy().recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);
  });

  it("omits the field entirely when the setting is absent or empty", async () => {
    fake.allowlist = { ...BASE };
    await start();
    expect(Object.hasOwn(lastPolicy(), "recipients")).toBe(false);
    fake.policies.length = 0;
    fake.allowlist = { ...BASE, recipients: [] };
    await start();
    expect(Object.hasOwn(lastPolicy(), "recipients")).toBe(false);
  });

  it("disables the whole list on any malformed entry", async () => {
    for (const recipients of [
      [{ adapter: "chatgpt" }],
      [{ adapter: "chatgpt", endpointId: "chatgpt/main", note: "x" }],
      [{ adapter: "pi", endpointId: "chatgpt/main" }],
      [{ adapter: "chatgpt", endpointId: "a/main" }, { adapter: "mcp", endpointId: "a/main" }],
      [{ adapter: "chatgpt", endpointId: "local/A" }],
      "chatgpt/main",
      [{ adapter: "", endpointId: "x" }],
    ]) {
      fake.policies.length = 0;
      fake.allowlist = { ...BASE, recipients };
      await start();
      expect(Object.hasOwn(lastPolicy(), "recipients")).toBe(false);
    }
  });
});
