import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFixtures, fixture, privileged, reader, type Fixture } from "../../storage/support/participant-fixture.js";
import type { CeSessionHost, CeMappingIdentifiers } from "../../../src/endpoints/pi/session-host.js";

const isolated = vi.hoisted(() => ({
  store: undefined as unknown,
  hosts: [] as CeSessionHost[],
}));
// Only the extension's Store-opening seam is replaced. Every authority operation
// runs through the built Host and real SQLite in a disposable fixture.
vi.mock("../../../dist/storage/store.js", () => ({
  openStore: () => isolated.store,
  initializeStore: () => isolated.store,
}));
vi.mock("../../../dist/endpoints/pi/session-host.js", async (original) => {
  const actual = await original<typeof import("../../../src/endpoints/pi/session-host.js")>();
  return {
    ...actual,
    CeSessionHost: class extends actual.CeSessionHost {
      constructor(store: ConstructorParameters<typeof actual.CeSessionHost>[0], policy: ConstructorParameters<typeof actual.CeSessionHost>[1]) {
        super(store, { ...policy, now: () => new Date(Date.now()).toISOString() });
        isolated.hosts.push(this);
      }
    },
  };
});

const MODULE_URL = new URL("../../../pi-extension/index.ts", import.meta.url).href;
type Entry = Record<string, unknown>;
type Context = {
  mode: string; hasUI: boolean; cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getBranch(): Entry[] };
  ui: { notify: ReturnType<typeof vi.fn> };
};
type Handler = (event: { reason: string }, ctx: Context) => void | Promise<void>;
type Tool = { name: string; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: Context): Promise<{ details?: unknown; isError?: boolean }> };
let fx: Fixture;
let entries: Entry[];

async function runtime(sessionId = "piA", branch = entries) {
  const events = new Map<string, Handler>();
  const tools: Tool[] = [];
  const ctx: Context = {
    mode: "tui", hasUI: true, cwd: fx.root,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(fx.root, `${sessionId}.jsonl`), getBranch: () => branch },
    ui: { notify: vi.fn() },
  };
  const { default: factory } = await import(MODULE_URL);
  const appendEntry = vi.fn((customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); });
  factory({
    on: (event: string, handler: Handler) => { events.set(event, handler); },
    registerTool: (tool: Tool) => { tools.push(tool); },
    registerCommand: vi.fn(),
    appendEntry,
  });
  return {
    ctx, tools, appendEntry,
    start: (reason = "startup") => events.get("session_start")!({ reason }, ctx),
    shutdown: (reason = "quit") => events.get("session_shutdown")!({ reason }, ctx),
    invoke: (name = "ce_inbox_list", context = ctx) => tools.find((tool) => tool.name === name)!.execute("test", {}, undefined, undefined, context),
  };
}
function mapping(): CeMappingIdentifiers {
  return entries.findLast((entry) => entry.customType === "ce-mapping")!.data as CeMappingIdentifiers;
}
function durable() {
  const db = reader(fx);
  try {
    return {
      owner: db.prepare("SELECT * FROM participant_ownership WHERE participant_id = ?").get(mapping().participantId),
      session: db.prepare("SELECT * FROM participant_session WHERE participant_id = ? AND session_id = ?").get(mapping().participantId, mapping().sessionId),
      sessions: db.prepare("SELECT count(*) AS count FROM participant_session").get()!.count,
      capabilities: db.prepare("SELECT count(*) AS count FROM participant_capability").get()!.count,
    };
  } finally { db.close(); }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
  fx = fixture("ce-pi-lifecycle-");
  isolated.store = fx.store;
  isolated.hosts.length = 0;
  entries = [];
  const allowlist = join(fx.root, "allowlist.json");
  writeFileSync(allowlist, JSON.stringify({ sessions: { piA: { endpointId: "local/A" }, piB: { endpointId: "local/B" } } }), { mode: 0o600 });
  vi.stubEnv("CE_ALLOWLIST", allowlist);
  vi.stubEnv("CE_STORE_DIR", fx.directory);
  vi.stubEnv("CE_STORE_FILE", fx.filename);
  vi.stubEnv("CE_LEASE_TTL_SECONDS", "");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupFixtures();
});

describe("Pi runtime generation lifecycle over an isolated Store", () => {
  it("starts no timer at factory load, then renews every 30s beyond two initial TTLs without changing fencing", async () => {
    const h = await runtime();
    expect(vi.getTimerCount()).toBe(0);
    const interval = vi.spyOn(globalThis, "setInterval");
    await h.start();
    const original = durable().owner!;
    expect(vi.getTimerCount()).toBe(1);
    expect(interval.mock.calls[0]![1]).toBe(30_000);
    expect(interval.mock.results[0]!.value.hasRef()).toBe(false);
    for (let tick = 1; tick <= 9; tick++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const owner = durable().owner!;
      expect(owner.private_revision).toBe(Number(original.private_revision) + tick);
      expect(owner.fencing_token).toBe(original.fencing_token);
      expect(owner.session_id).toBe(original.session_id);
      expect(owner.expires_at).toBe(new Date(Date.now() + 120_000).toISOString());
    }
    expect((await h.invoke()).isError).not.toBe(true);
    await h.shutdown();
  });
  it("honors the configured TTL by renewing at one quarter of its term", async () => {
    vi.stubEnv("CE_LEASE_TTL_SECONDS", "60");
    const h = await runtime();
    await h.start();
    const original = durable().owner!;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(durable().owner!.private_revision).toBe(original.private_revision);
    await vi.advanceTimersByTimeAsync(1);
    expect(durable().owner!.private_revision).toBe(Number(original.private_revision) + 1);
    await h.shutdown();
  });
  it("reload preserves the durable owner/session, drops old capability, and resumes exactly one new heartbeat", async () => {
    const old = await runtime();
    await old.start();
    const previous = mapping();
    const before = durable();
    const oldHost = isolated.hosts[0]!;
    const end = vi.spyOn(oldHost, "end");
    await old.shutdown("reload");
    expect(end).not.toHaveBeenCalled();
    expect(durable()).toEqual(before);
    expect(oldHost.status("local/A").registered).toBe(false);
    expect((await old.invoke()).isError).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const fresh = await runtime();
    await fresh.start("reload");
    expect(mapping()).toEqual(previous);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(durable().owner!.private_revision).toBe(Number(before.owner!.private_revision) + 1);
    expect(durable().owner!.fencing_token).toBe(before.owner!.fencing_token);
    await fresh.shutdown();
  });
  it.each(["quit", "new", "resume", "fork"])("%s releases ownership and detaches the old session once", async (reason) => {
    const h = await runtime();
    await h.start();
    const end = vi.spyOn(isolated.hosts[0]!, "end");
    await Promise.all([h.shutdown(reason), h.shutdown(reason)]);
    expect(end).toHaveBeenCalledExactlyOnceWith("local/A");
    expect(durable().owner).toBeUndefined();
    expect(durable().session!.detached_at).not.toBeNull();
    expect(durable().session!.private_revision).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect((await h.invoke()).isError).toBe(true);
    if (reason !== "quit") {
      const fresh = await runtime("piB", []);
      await fresh.start(reason);
      expect((await fresh.invoke()).isError).not.toBe(true);
      await fresh.shutdown();
    }
  });
  it("stops on lost authority with no renew retry, rebind, or new capability issuance", async () => {
    const h = await runtime();
    await h.start();
    const db = privileged(fx);
    try { db.prepare("DELETE FROM participant_ownership WHERE participant_id = ?").run(mapping().participantId); } finally { db.close(); }
    const before = durable();
    const renew = vi.spyOn(isolated.hosts[0]!, "renew");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_AUTHORITY_ABSENT", retryable: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await h.shutdown("reload");
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).isError).toBe(true);
    expect(durable()).toEqual(before);
  });
  it.each(["uncertain", "unexpected"])("latches %s renewal across reload, sanitizes diagnostics, and never retries cleanup", async (kind) => {
    const h = await runtime();
    await h.start();
    const actual = await vi.importActual<typeof import("../../../src/endpoints/pi/session-host.js")>("../../../dist/endpoints/pi/session-host.js");
    const renew = vi.spyOn(isolated.hosts[0]!, "renew").mockImplementation(() => {
      throw kind === "uncertain" ? new actual.CeHostRefusal("CE_HOST_UNCERTAIN", false, "SQLITE_BUSY_COMMIT") : new Error("secret /private/store TOKEN");
    });
    const end = vi.spyOn(isolated.hosts[0]!, "end");
    await vi.advanceTimersByTimeAsync(30_000);
    const before = durable();
    const expectedCode = kind === "uncertain" ? "CE_HOST_UNCERTAIN" : "CE_HOST_UNAVAILABLE";
    expect((await h.invoke()).details).toMatchObject({ code: expectedCode, retryable: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledTimes(1);
    await h.shutdown("reload");
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: expectedCode, retryable: false });
    expect(durable()).toEqual(before);
    await fresh.shutdown();
    expect(end).not.toHaveBeenCalled();
    const persisted = entries.filter((entry) => entry.customType === "ce-lifecycle-blocked");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.data).toEqual({ piSessionId: "piA", endpointId: "local/A", code: expectedCode });
    expect(JSON.stringify([entries, h.ctx.ui.notify.mock.calls])).not.toContain("secret");
  });
  it("expired reload refuses resume without new binding or capability issuance", async () => {
    const h = await runtime();
    await h.start();
    await h.shutdown("reload");
    vi.setSystemTime(new Date(Date.now() + 120_001));
    const before = durable();
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_AUTHORITY_ABSENT" });
    expect(durable()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });
  // HANDOFF-CE-RELEASE-READINESS-01 C3: a resumed generation adopts the REMAINING
  // durable term, which can be shorter than the configured TTL/4 heartbeat. The
  // first renewal must therefore land inside the adopted term instead of after a
  // deterministic fail-closed expiry.
  it("resuming with less than a quarter TTL left renews inside the remaining adopted term", async () => {
    const h = await runtime();
    await h.start();
    const bound = durable().owner!;
    const adoptedExpiry = new Date(bound.expires_at as string).getTime();
    await h.shutdown("reload");
    // Only 20s of the adopted 120s term remain: shorter than the TTL/4 period.
    vi.setSystemTime(new Date(adoptedExpiry - 20_000));
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).isError).not.toBe(true);
    await vi.advanceTimersByTimeAsync(19_999);
    const renewed = durable().owner!;
    expect(Number(renewed.private_revision)).toBe(Number(bound.private_revision) + 1);
    expect(new Date(renewed.expires_at as string).getTime()).toBeGreaterThan(adoptedExpiry);
    // Renewal only; never a takeover, a new fencing token, or a new Session.
    expect(renewed.fencing_token).toBe(bound.fencing_token);
    expect(renewed.session_id).toBe(bound.session_id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await fresh.invoke()).isError).not.toBe(true);
    expect(entries.filter((entry) => entry.customType === "ce-lifecycle-blocked")).toHaveLength(0);
    await fresh.shutdown();
  });
  // HANDOFF-CE-RELEASE-READINESS-01 C1/C2: the sanitized domain reason is the only
  // operator-visible discriminator between authority-absence causes, and the
  // stale-ownership recovery hint may point only at the two reasons the
  // documented operator-only path actually addresses.
  // `resume` reports the advisory lease evaluation (`EXPIRED`), not the storage
  // domain code `LEASE_EXPIRED`; both belong to the same stale-owner family.
  it("an expired adopted lease still fails closed, names the expiry reason, and offers only operator-only recovery", async () => {
    const h = await runtime();
    await h.start();
    await h.shutdown("reload");
    vi.setSystemTime(new Date(Date.now() + 120_001));
    const before = durable();
    const fresh = await runtime();
    await fresh.start("reload");
    const notices = fresh.ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n");
    expect(notices).toContain("session start failed closed (CE_HOST_AUTHORITY_ABSENT / EXPIRED)");
    expect(notices).toContain("operator-only stale-ownership recovery");
    expect(notices).toContain("no automatic recovery and no takeover");
    // Fail closed: the expired lease is never revived, adopted, or taken over.
    expect(durable()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_AUTHORITY_ABSENT", reason: "EXPIRED" });
  });
  it.each([
    ["EXPIRED", true],
    ["LEASE_EXPIRED", true],
    ["OWNERSHIP_TAKEOVER_REQUIRED", true],
    ["OWNERSHIP_HELD", false],
    ["OWNERSHIP_NOT_CURRENT", false],
    ["CLOCK_REGRESSION", false],
    ["LEASE_CLOCK_REGRESSION", false],
    ["FENCING_STALE", false],
    ["ADMISSION_POLICY_DENIED", false],
  ] as const)("startup reports reason %s and hints stale-ownership recovery only when authorized", async (reason, hinted) => {
    const { CeEndpointHost, CeHostRefusal } = await import("../../../dist/host/endpoint-host.js");
    const begin = vi.spyOn(CeEndpointHost.prototype, "beginSession").mockImplementation(() => {
      throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT", false, reason);
    });
    const h = await runtime();
    await h.start();
    expect(begin).toHaveBeenCalledTimes(1);
    const notices = h.ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n");
    expect(notices).toContain(`session start failed closed (CE_HOST_AUTHORITY_ABSENT / ${reason})`);
    expect(notices.includes("operator-only stale-ownership recovery")).toBe(hinted);
    expect(notices).not.toContain("session-process mutex");
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_AUTHORITY_ABSENT", reason });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("invalidates stale heartbeat and tools before a reentrant shutdown, then waits for renew to finish", async () => {
    const h = await runtime();
    const interval = vi.spyOn(globalThis, "setInterval");
    await h.start();
    const callback = interval.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(callback).toBeTypeOf("function");
    const host = isolated.hosts[0]!;
    const realRenew = host.renew.bind(host);
    const order: string[] = [];
    let shutdown: Promise<void> | void = undefined;
    const end = vi.spyOn(host, "end").mockImplementation((endpoint) => {
      order.push("end");
      return Object.getPrototypeOf(Object.getPrototypeOf(host)).end.call(host, endpoint);
    });
    const renew = vi.spyOn(host, "renew").mockImplementation((endpoint) => {
      order.push("renew-start");
      callback!(); // Reentrant tick must not overlap.
      shutdown = h.shutdown();
      callback!(); // Already queued stale callback must refuse.
      expect(end).not.toHaveBeenCalled();
      const result = realRenew(endpoint);
      order.push("renew-end");
      return result;
    });
    callback!();
    await shutdown;
    callback!();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["renew-start", "renew-end", "end"]);
    expect(durable().owner).toBeUndefined();
    expect(durable().session!.detached_at).not.toBeNull();
  });
  it("persists an unconfirmed end as blocked and never retries it", async () => {
    const h = await runtime();
    await h.start();
    const end = vi.spyOn(isolated.hosts[0]!, "end").mockReturnValue({ released: true, detached: false });
    await h.shutdown();
    await h.shutdown();
    expect(end).toHaveBeenCalledTimes(1);
    const before = durable();
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_UNCERTAIN" });
    expect(durable()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("blocks stale send/read contexts before invoking any Host operation", async () => {
    const h = await runtime();
    await h.start();
    const send = vi.spyOn(isolated.hosts[0]!, "send");
    const read = vi.spyOn(isolated.hosts[0]!, "readMetadata");
    const stale = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "piB" } };
    for (const name of ["ce_send", "ce_read", "ce_inbox_list"]) {
      expect((await h.invoke(name, stale)).details).toMatchObject({ code: "CE_HOST_MAPPING_INVALID" });
    }
    expect(send).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await h.shutdown();
  });
  it("does not re-adopt unknown authority on reload when diagnostic persistence fails", async () => {
    const h = await runtime();
    await h.start();
    vi.spyOn(isolated.hosts[0]!, "renew").mockImplementation(() => { throw new Error("unknown"); });
    h.appendEntry.mockImplementation(() => { throw new Error("disk failed"); });
    await vi.advanceTimersByTimeAsync(30_000);
    const before = durable();
    await h.shutdown("reload");
    vi.resetModules(); // A real reload replaces the extension module, not just its factory.
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_UNAVAILABLE" });
    expect(durable()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not renew or release a distinct MCP Owner sharing the isolated Store", async () => {
    const { CeEndpointHost } = await import("../../../dist/host/endpoint-host.js");
    const mcp = new CeEndpointHost(fx.store, {
      adapter: "mcp", exchangeNamespace: "pi-local", exchangeIdempotencyKey: "pi-local-exchange",
      allowlist: [{ endpointId: "mcp/main" }], now: () => new Date(Date.now()).toISOString(),
    });
    const mcpMapping = mcp.beginSession("mcp/main");
    const snapshot = () => {
      const db = reader(fx);
      try { return db.prepare("SELECT * FROM participant_ownership WHERE participant_id = ?").get(mcpMapping.participantId); }
      finally { db.close(); }
    };
    const owner = snapshot();
    const h = await runtime();
    await h.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshot()).toEqual(owner);
    await h.shutdown();
    expect(snapshot()).toEqual(owner);
    expect(mcp.end("mcp/main")).toEqual({ released: true, detached: true });
  });
  it.each(["reload", "quit"])("an unknown in-flight renew during %s prevents end and later adoption", async (reason) => {
    const h = await runtime();
    const interval = vi.spyOn(globalThis, "setInterval");
    await h.start();
    const host = isolated.hosts[0]!;
    const end = vi.spyOn(host, "end");
    let pending: Promise<void> | void = undefined;
    vi.spyOn(host, "renew").mockImplementation(() => {
      pending = h.shutdown(reason);
      throw new Error("unknown commit");
    });
    (interval.mock.calls[0]![0] as () => void)();
    await pending;
    expect(end).not.toHaveBeenCalled();
    const before = durable();
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_UNAVAILABLE" });
    expect(durable()).toEqual(before);
  });
  it("a committed renew whose result is unknown is not repeated or cleaned up blindly", async () => {
    const h = await runtime();
    await h.start();
    const host = isolated.hosts[0]!;
    const realRenew = host.renew.bind(host);
    const original = durable().owner!;
    const renew = vi.spyOn(host, "renew").mockImplementation((endpoint) => {
      realRenew(endpoint);
      throw new Error("result unavailable after commit");
    });
    const end = vi.spyOn(host, "end");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(durable().owner!.private_revision).toBe(Number(original.private_revision) + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(1);
    await h.shutdown();
    expect(end).not.toHaveBeenCalled();
    expect(durable().session!.detached_at).toBeNull();
  });
  it("a startup mapping persistence failure discards capability and blocks a new generation", async () => {
    const h = await runtime();
    h.appendEntry.mockImplementation(() => { throw new Error("private disk error"); });
    await h.start();
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_UNAVAILABLE" });
    expect(isolated.hosts[0]!.status("local/A").registered).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await h.shutdown("reload");
    const fresh = await runtime();
    await fresh.start("startup");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_UNAVAILABLE" });
    expect(isolated.hosts).toHaveLength(1);
  });
  it("reload without a persisted mapping refuses without provisioning a fresh Session", async () => {
    const h = await runtime();
    await h.start();
    await h.shutdown("reload");
    const before = durable();
    const fresh = await runtime("piA", []);
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_MAPPING_INVALID" });
    expect(durable()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("an unknown end result is latched even when release and detach actually committed", async () => {
    const h = await runtime();
    await h.start();
    const host = isolated.hosts[0]!;
    const realEnd = host.end.bind(host);
    const end = vi.spyOn(host, "end").mockImplementation((endpoint) => {
      realEnd(endpoint);
      throw new Error("unknown result");
    });
    await h.shutdown();
    await h.shutdown();
    expect(end).toHaveBeenCalledTimes(1);
    expect(durable().owner).toBeUndefined();
    expect(durable().session!.detached_at).not.toBeNull();
    const fresh = await runtime();
    await fresh.start("reload");
    expect((await fresh.invoke()).details).toMatchObject({ code: "CE_HOST_UNAVAILABLE" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a reentrant end callback joins shutdown instead of ending twice", async () => {
    const h = await runtime();
    await h.start();
    const host = isolated.hosts[0]!;
    const realEnd = host.end.bind(host);
    let reentrant: Promise<void> | void = undefined;
    const end = vi.spyOn(host, "end").mockImplementationOnce((endpoint) => {
      reentrant = h.shutdown();
      return realEnd(endpoint);
    });
    await h.shutdown();
    await reentrant;
    expect(end).toHaveBeenCalledTimes(1);
    expect(durable().owner).toBeUndefined();
    expect(durable().session!.detached_at).not.toBeNull();
  });
  it("malformed TTL fails closed rather than being coerced to the default", async () => {
    writeFileSync(join(fx.root, "allowlist.json"), JSON.stringify({ sessions: { piA: { endpointId: "local/A" } }, leaseTtlSeconds: null }));
    const h = await runtime();
    await h.start();
    expect((await h.invoke()).details).toMatchObject({ code: "CE_HOST_INVALID_REQUEST" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reload waits for a successful in-flight renew before dropping capability and validated resume", async () => {
    const h = await runtime();
    const interval = vi.spyOn(globalThis, "setInterval");
    await h.start();
    const host = isolated.hosts[0]!;
    const realRenew = host.renew.bind(host);
    const before = durable().owner!;
    const drop = vi.spyOn(host, "drop");
    const end = vi.spyOn(host, "end");
    let pending: Promise<void> | void = undefined;
    vi.spyOn(host, "renew").mockImplementation((endpoint) => {
      pending = h.shutdown("reload");
      expect(drop).not.toHaveBeenCalled();
      return realRenew(endpoint);
    });
    (interval.mock.calls[0]![0] as () => void)();
    await pending;
    expect(drop).toHaveBeenCalledExactlyOnceWith("local/A");
    expect(end).not.toHaveBeenCalled();
    expect(durable().owner!.private_revision).toBe(Number(before.private_revision) + 1);
    expect(durable().owner!.fencing_token).toBe(before.fencing_token);
    expect(durable().session!.detached_at).toBeNull();
    const fresh = await runtime();
    await fresh.start("reload");
    expect(vi.getTimerCount()).toBe(1);
    expect((await fresh.invoke()).isError).not.toBe(true);
    await fresh.shutdown();
  });
});
